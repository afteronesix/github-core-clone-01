// The forge's HTTP surface: one server, four protocols over one store.
//
// Routing:
//   GET  /healthz                                  (no auth — the env's boot check)
//   GET  /:owner/:repo.git/info/refs?service=...   git advertisements (v0/v2)
//   POST /:owner/:repo.git/git-upload-pack         ls-refs / fetch (v2 + v0)
//   POST /:owner/:repo.git/git-receive-pack        push
//   /api/v3/*                                      REST v3 (repos, issues, pulls, ...)
//   POST /api/graphql                             GraphQL v4
//   POST /mcp                                     MCP (JSON-RPC over Streamable HTTP)
//
// Auth: every route except /healthz requires `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN` (auth first, then routing — an unauthenticated unknown
// route is a 401). When the token is unset, auth is disabled. Every reply
// carries a non-empty X-GitHub-Request-Id. A handler throw answers 500 JSON
// and never kills the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createAuthGate } from './src/http/auth.ts';
import {
  errorReply,
  HttpError,
  jsonReply,
  notFound,
  parseJsonBody,
  readBody,
  sendReply,
  unauthorized,
  type Reply,
} from './src/http/server.ts';
import { ForgeStore, type RepoRecord } from './src/store/store.ts';
import { advertisementReceivePack, handleReceivePack } from './src/git/receive-pack.ts';
import { advertisementV0, advertisementV2, handleUploadPack } from './src/git/upload-pack.ts';
import { PktLineError } from './src/git/pktline.ts';
import { createRepo, createGitRef, deleteRepo, getBranch, getGitRef, getMeta, getRepo, getRoot, getUser, listBranches, listCommits, listUserRepos, patchRepo } from './src/rest/repos.ts';
import { deleteContents, getContents, putContents } from './src/rest/contents.ts';
import { createComment, createIssue, createLabel, getIssue, listComments, listIssues, patchIssue } from './src/rest/issues.ts';
import { createPull, getPull, listPullFiles, listPulls, mergePull } from './src/rest/pulls.ts';
import { handleGraphQL } from './src/graphql/executor.ts';
import { handleMcp, handleMcpDelete } from './src/mcp/server.ts';

/**
 * Split a request target into path + query without `new URL` (the fast path
 * for the clean relative targets the client always sends). Dot segments,
 * backslashes, and absolute-form targets need real URL resolution, so those
 * fall back to `new URL` — the routing result is identical either way.
 */
function splitRequestTarget(req: IncomingMessage): { path: string; query: string } {
  const raw = req.url ?? '/';
  const qIndex = raw.indexOf('?');
  const path = qIndex < 0 ? raw : raw.slice(0, qIndex);
  if (
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    path.includes('\\') ||
    path.includes('/./') ||
    path.includes('/../') ||
    path.endsWith('/.') ||
    path.endsWith('/..')
  ) {
    try {
      const url = new URL(raw, 'http://entry');
      return { path: url.pathname, query: url.search.slice(1) };
    } catch {
      return { path: '/', query: '' };
    }
  }
  return { path, query: qIndex < 0 ? '' : raw.slice(qIndex + 1) };
}

/** The request's origin (scheme + host) for absolute pagination URLs. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'entry';
  return `http://${host}`;
}

/** `version=2` in the Git-Protocol header selects protocol v2; anything else is v0. */
function gitProtocolVersion(req: IncomingMessage): 2 | 0 {
  const header = req.headers['git-protocol'];
  return header === 'version=2' ? 2 : 0;
}

/** Decode one URL path segment (or a slash-separated path, piece by piece). */
function decodePath(value: string): string {
  // No '%' anywhere: decodeURIComponent would return every piece unchanged.
  if (!value.includes('%')) return value;
  return value
    .split('/')
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    })
    .join('/');
}

/** Parse an all-digit segment as a number (`null` when it is not one). */
function parseUint(value: string): number | null {
  if (value.length === 0) return null;
  let n = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return null;
    n = n * 10 + (code - 48);
    if (n > Number.MAX_SAFE_INTEGER) return null;
  }
  return n;
}

export function createApp(): Server {
  const store = new ForgeStore();
  const auth = createAuthGate(process.env.MAKEFUN_SHOP_TOKEN);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = store.nextRequest();
    try {
      const reply = await dispatch(req, store, auth);
      sendReply(res, reply, requestId);
    } catch (err) {
      if (err instanceof HttpError) {
        sendReply(res, errorReply(err.status, err.message), requestId);
        return;
      }
      if (err instanceof PktLineError) {
        sendReply(res, errorReply(400, err.message), requestId);
        return;
      }
      // A handler throw must answer 500 JSON, never kill the process.
      process.stderr.write(`[forge] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      sendReply(res, errorReply(500, 'Internal Server Error'), requestId);
    }
  };

  return createServer((req, res) => {
    void handler(req, res);
  });
}

async function dispatch(
  req: IncomingMessage,
  store: ForgeStore,
  auth: ReturnType<typeof createAuthGate>,
): Promise<Reply> {
  const { path, query } = splitRequestTarget(req);
  const method = req.method ?? 'GET';
  // Query params are parsed lazily — only the list endpoints and info/refs
  // read them, and most hot-path requests never touch the query at all.
  let params: URLSearchParams | null = null;
  const searchParams = (): URLSearchParams => (params ??= new URLSearchParams(query));

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') return jsonReply(200, { ok: true });

  // Auth first, then routing.
  if (!auth.isAuthorized(req)) throw unauthorized();

  // --- git smart HTTP: /:owner/:repo.git/... --------------------------------
  // Manual parse (no regex): the last '.git/' wins, owner/repo are slash-free
  // and non-empty, the service is exactly one of the three — the same match
  // set as the old `^/([^/]+)/([^/]+)\.git/(info/refs|...)$` regex.
  const gitIdx = path.lastIndexOf('.git/');
  if (gitIdx > 1) {
    const slash1 = path.indexOf('/', 1);
    if (slash1 > 1 && gitIdx > slash1 + 1 && path.indexOf('/', slash1 + 1) === gitIdx + 4) {
      const service = path.slice(gitIdx + 5);
      if (service === 'info/refs' || service === 'git-upload-pack' || service === 'git-receive-pack') {
        const owner = path.slice(1, slash1);
        const repoName = path.slice(slash1 + 1, gitIdx);
        const repo = store.getRepo(owner, repoName);
        if (!repo) throw notFound('Not Found');
        if (service === 'info/refs') {
          if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
          const serviceParam = searchParams().get('service');
          if (serviceParam === 'git-upload-pack') {
            return gitProtocolVersion(req) === 2 ? advertisementV2() : advertisementV0(repo);
          }
          if (serviceParam === 'git-receive-pack') return advertisementReceivePack(repo);
          throw notFound('Not Found');
        }
        if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
        const body = await readBody(req);
        if (service === 'git-upload-pack') return handleUploadPack(repo, body, gitProtocolVersion(req));
        return handleReceivePack(repo, body);
      }
    }
  }

  // --- REST v3 ---------------------------------------------------------------
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return getRoot();
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return getMeta();
  }
  if (path === '/api/v3/user') {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return getUser(store);
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') return createRepo(store, parseJsonBody(await readBody(req)));
    if (method === 'GET') return listUserRepos(store, searchParams(), originOf(req));
    throw new HttpError(405, 'Method Not Allowed');
  }
  // Manual parse (no regex): /api/v3/repos/{owner}/{repo} or /{owner}/{repo}/{rest...}.
  // Owner/repo are slash-free and non-empty; rest is 1+ chars — the same match
  // set as the old repoMatch/repoSubMatch regexes.
  if (path.startsWith('/api/v3/repos/')) {
    const afterPrefix = path.slice('/api/v3/repos/'.length);
    const slashA = afterPrefix.indexOf('/');
    if (slashA > 0) {
      const decodedOwner = decodePath(afterPrefix.slice(0, slashA));
      const afterOwner = afterPrefix.slice(slashA + 1);
      const slashB = afterOwner.indexOf('/');
      if (slashB < 0) {
        if (afterOwner.length > 0) {
          const decodedRepo = decodePath(afterOwner);
          if (method === 'GET') return getRepo(store, decodedOwner, decodedRepo);
          if (method === 'PATCH') return patchRepo(store, decodedOwner, decodedRepo, parseJsonBody(await readBody(req)));
          if (method === 'DELETE') return deleteRepo(store, decodedOwner, decodedRepo);
          throw new HttpError(405, 'Method Not Allowed');
        }
      } else if (slashB > 0 && afterOwner.length > slashB + 1) {
        const decodedRepo = decodePath(afterOwner.slice(0, slashB));
        const rest = afterOwner.slice(slashB + 1);
        const repo = store.getRepo(decodedOwner, decodedRepo);
        if (!repo) throw notFound('Not Found');
        return dispatchRepoSub(req, store, method, decodedOwner, decodedRepo, repo, rest, searchParams(), originOf(req));
      }
    }
  }

  // --- GraphQL v4 ------------------------------------------------------------
  if (path === '/api/graphql') {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    return handleGraphQL(store, parseJsonBody(await readBody(req)));
  }

  // --- MCP (JSON-RPC over Streamable HTTP) -----------------------------------
  if (path === '/mcp') {
    if (method === 'DELETE') return handleMcpDelete();
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    // handleMcp parses the raw body itself: a non-JSON body must answer
    // HTTP 400 with JSON-RPC -32700, not the REST 400 shape.
    return handleMcp(store, await readBody(req));
  }

  // Everything else, every method: GitHub's 404 body.
  throw notFound('Not Found');
}

/**
 * Dispatch /api/v3/repos/{owner}/{repo}/{rest...}; the repo is known to exist.
 * The numeric sub-routes parse `rest` once (split + digit check) instead of
 * running a regex per route — same match set, same 404/405 outcomes.
 */
async function dispatchRepoSub(
  req: IncomingMessage,
  store: ForgeStore,
  method: string,
  owner: string,
  repoName: string,
  repo: RepoRecord,
  rest: string,
  searchParams: URLSearchParams,
  origin: string,
): Promise<Reply> {
  if (rest === 'branches') {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return listBranches(store, owner, repoName);
  }
  if (rest.startsWith('branches/')) {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return getBranch(store, owner, repoName, decodePath(rest.slice('branches/'.length)));
  }
  if (rest === 'commits') {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return listCommits(store, owner, repoName, searchParams);
  }
  if (rest === 'git/refs') {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    return createGitRef(store, owner, repoName, parseJsonBody(await readBody(req)));
  }
  if (rest.startsWith('git/refs/')) {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
    return getGitRef(store, owner, repoName, decodePath(rest.slice('git/refs/'.length)));
  }
  if (rest === 'contents' || rest.startsWith('contents/')) {
    const filePath = rest === 'contents' ? '' : decodePath(rest.slice('contents/'.length));
    if (method === 'GET') return getContents(repo, filePath, searchParams);
    if (method === 'PUT') return putContents(store, repo, filePath, parseJsonBody(await readBody(req)));
    if (method === 'DELETE') return deleteContents(store, repo, filePath, parseJsonBody(await readBody(req)));
    throw new HttpError(405, 'Method Not Allowed');
  }
  if (rest === 'labels') {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    return createLabel(store, owner, repoName, parseJsonBody(await readBody(req)));
  }
  if (rest === 'issues') {
    if (method === 'GET') return listIssues(store, owner, repoName, searchParams, origin);
    if (method === 'POST') return createIssue(store, owner, repoName, parseJsonBody(await readBody(req)));
    throw new HttpError(405, 'Method Not Allowed');
  }
  if (rest === 'pulls') {
    if (method === 'GET') return listPulls(store, owner, repoName, searchParams, origin);
    if (method === 'POST') return createPull(store, owner, repoName, parseJsonBody(await readBody(req)));
    throw new HttpError(405, 'Method Not Allowed');
  }
  // Numeric sub-routes: issues/N, issues/N/comments, pulls/N, pulls/N/files,
  // pulls/N/merge. One split + one digit check replaces five regexes.
  const parts = rest.split('/');
  if (parts.length === 2 || parts.length === 3) {
    const number = parseUint(parts[1] as string);
    if (number !== null) {
      if (parts[0] === 'issues' && parts.length === 2) {
        if (method === 'GET') return getIssue(store, owner, repoName, number);
        if (method === 'PATCH') {
          return patchIssue(store, owner, repoName, number, parseJsonBody(await readBody(req)));
        }
        throw new HttpError(405, 'Method Not Allowed');
      }
      if (parts[0] === 'issues' && parts.length === 3 && parts[2] === 'comments') {
        if (method === 'GET') return listComments(store, owner, repoName, number);
        if (method === 'POST') {
          return createComment(store, owner, repoName, number, parseJsonBody(await readBody(req)));
        }
        throw new HttpError(405, 'Method Not Allowed');
      }
      if (parts[0] === 'pulls' && parts.length === 2) {
        if (method === 'GET') return getPull(store, owner, repoName, number);
        throw new HttpError(405, 'Method Not Allowed');
      }
      if (parts[0] === 'pulls' && parts.length === 3 && parts[2] === 'files') {
        if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
        return listPullFiles(store, owner, repoName, number);
      }
      if (parts[0] === 'pulls' && parts.length === 3 && parts[2] === 'merge') {
        if (method !== 'PUT') throw new HttpError(405, 'Method Not Allowed');
        return mergePull(store, owner, repoName, number, parseJsonBody(await readBody(req)));
      }
    }
  }
  throw notFound('Not Found');
}

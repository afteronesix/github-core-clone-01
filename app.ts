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
import { ForgeStore } from './src/store/store.ts';
import { advertisementReceivePack, handleReceivePack } from './src/git/receive-pack.ts';
import { advertisementV0, advertisementV2, handleUploadPack } from './src/git/upload-pack.ts';
import { PktLineError } from './src/git/pktline.ts';
import { createRepo, createGitRef, deleteRepo, getBranch, getGitRef, getMeta, getRepo, getRoot, getUser, listBranches, listCommits, listUserRepos, patchRepo } from './src/rest/repos.ts';
import { deleteContents, getContents, putContents } from './src/rest/contents.ts';

/** The path + query of a request URL, or '/' when it does not parse (never a throw). */
function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('http://entry/');
  }
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
  const url = urlOf(req);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') return jsonReply(200, { ok: true });

  // Auth first, then routing.
  if (!auth.isAuthorized(req)) throw unauthorized();

  // --- git smart HTTP: /:owner/:repo.git/... --------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const [, owner, repoName, service] = gitMatch as unknown as [string, string, string, string];
    const repo = store.getRepo(owner, repoName);
    if (!repo) throw notFound('Not Found');
    if (service === 'info/refs') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      const serviceParam = url.searchParams.get('service');
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
    if (method === 'GET') return listUserRepos(store, url.searchParams, originOf(req));
    throw new HttpError(405, 'Method Not Allowed');
  }
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(path);
  if (repoMatch) {
    const [, owner, repoName] = repoMatch as unknown as [string, string, string];
    const decodedOwner = decodePath(owner);
    const decodedRepo = decodePath(repoName);
    if (method === 'GET') return getRepo(store, decodedOwner, decodedRepo);
    if (method === 'PATCH') return patchRepo(store, decodedOwner, decodedRepo, parseJsonBody(await readBody(req)));
    if (method === 'DELETE') return deleteRepo(store, decodedOwner, decodedRepo);
    throw new HttpError(405, 'Method Not Allowed');
  }
  const repoSubMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
  if (repoSubMatch) {
    const [, owner, repoName, rest] = repoSubMatch as unknown as [string, string, string, string];
    const decodedOwner = decodePath(owner);
    const decodedRepo = decodePath(repoName);
    const repo = store.getRepo(decodedOwner, decodedRepo);
    if (!repo) throw notFound('Not Found');
    if (rest === 'branches') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return listBranches(store, decodedOwner, decodedRepo);
    }
    if (rest.startsWith('branches/')) {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return getBranch(store, decodedOwner, decodedRepo, decodePath(rest.slice('branches/'.length)));
    }
    if (rest === 'commits') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return listCommits(store, decodedOwner, decodedRepo, url.searchParams);
    }
    if (rest === 'git/refs') {
      if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
      return createGitRef(store, decodedOwner, decodedRepo, parseJsonBody(await readBody(req)));
    }
    if (rest.startsWith('git/refs/')) {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return getGitRef(store, decodedOwner, decodedRepo, decodePath(rest.slice('git/refs/'.length)));
    }
    if (rest === 'contents' || rest.startsWith('contents/')) {
      const filePath = rest === 'contents' ? '' : decodePath(rest.slice('contents/'.length));
      if (method === 'GET') return getContents(repo, filePath, url.searchParams);
      if (method === 'PUT') return putContents(store, repo, filePath, parseJsonBody(await readBody(req)));
      if (method === 'DELETE') return deleteContents(store, repo, filePath, parseJsonBody(await readBody(req)));
      throw new HttpError(405, 'Method Not Allowed');
    }
    throw notFound('Not Found');
  }

  // --- GraphQL v4 / MCP: later phases; unknown until then --------------------
  if (path === '/api/graphql' || path === '/mcp') {
    // Read (and discard) the body so the connection stays clean, then 404.
    await readBody(req).catch(() => Buffer.alloc(0));
    throw notFound('Not Found');
  }

  // Everything else, every method: GitHub's 404 body.
  throw notFound('Not Found');
}

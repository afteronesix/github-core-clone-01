// REST v3: the API root, meta, the token user, and repository CRUD.
// (Branches, commits, git/refs and contents live in their own modules;
// this file owns the repo object shape every surface returns.)

import type { ForgeStore, RepoRecord } from '../store/store.ts';
import { isObjectId } from '../git/objects.ts';
import { listBranches as listBranchesOf, resolveRefOrSha } from '../git/refs.ts';
import { commitView, listCommitOids } from '../git/commits.ts';
import { emptyReply, errorReply, isJsonObject, jsonReply, notFound, unprocessable, type Reply } from '../http/server.ts';
import { buildLinkHeader, paginate, parsePageParams } from './pagination.ts';

/** The serialized repository object (GitHub's shape, the fields the suite reads). */
export function repoView(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

/** GET /api/v3/ — the API root, with the token's scopes. */
export function getRoot(): Reply {
  return jsonReply(
    200,
    { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

/** GET /api/v3/meta — the installed version (any non-empty string). */
export function getMeta(): Reply {
  return jsonReply(200, { installed_version: 'ghforge/1.0' });
}

/** GET /api/v3/user — the token user (the computed scenario viewer). */
export function getUser(store: ForgeStore): Reply {
  const viewer = store.viewer;
  return jsonReply(200, {
    login: viewer.login,
    id: viewer.id,
    name: viewer.name,
    email: viewer.email,
    type: 'User',
  });
}

/** A valid repo name: GitHub allows letters, digits, `.`, `-`, `_`; non-empty, ≤ 100 chars. */
function isValidRepoName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/** POST /api/v3/user/repos — create under the viewer login. 201, or 422 on a duplicate/invalid name. */
export function createRepo(store: ForgeStore, body: unknown): Reply {
  if (!isJsonObject(body)) return errorReply(422, 'Validation Failed: body must be an object');
  if (!isValidRepoName(body.name)) return errorReply(422, 'Validation Failed: name is required');
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  const repo = store.createRepo(body.name, { description, private: isPrivate });
  if (!repo) return errorReply(422, `Validation Failed: a repository named ${body.name} already exists`);
  return jsonReply(201, repoView(repo));
}

/** GET /api/v3/user/repos — the viewer's repos, creation order, paginated. */
export function listUserRepos(store: ForgeStore, query: URLSearchParams, origin: string): Reply {
  const params = parsePageParams(query);
  const repos = store.listViewerRepos();
  const page = paginate(repos, params);
  const link = buildLinkHeader(`${origin}/api/v3/user/repos`, params, page.total);
  const headers: Record<string, string> = {};
  if (link) headers.link = link;
  return jsonReply(200, page.items.map(repoView), headers);
}

/** Resolve a repo from the path, or throw a 404. Ownership is part of the key. */
export function requireRepo(store: ForgeStore, owner: string, name: string): RepoRecord {
  const repo = store.getRepo(owner, name);
  if (!repo) throw notFound('Not Found');
  return repo;
}

/** GET /api/v3/repos/{o}/{r}. */
export function getRepo(store: ForgeStore, owner: string, name: string): Reply {
  return jsonReply(200, repoView(requireRepo(store, owner, name)));
}

/** PATCH /api/v3/repos/{o}/{r} — updates description (and private, when given). */
export function patchRepo(store: ForgeStore, owner: string, name: string, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  repo.updatedAt = store.now().iso;
  return jsonReply(200, repoView(repo));
}

/** DELETE /api/v3/repos/{o}/{r} — 204, empty body; a later GET is 404. */
export function deleteRepo(store: ForgeStore, owner: string, name: string): Reply {
  const deleted = store.deleteRepo(owner, name);
  if (!deleted) throw notFound('Not Found');
  return emptyReply(204);
}

// ---------------------------------------------------------------------------------------------
// branches, commits, git/refs
// ---------------------------------------------------------------------------------------------

/** GET /api/v3/repos/{o}/{r}/branches — every branch with its tip sha, sorted by name. */
export function listBranches(store: ForgeStore, owner: string, name: string): Reply {
  const repo = requireRepo(store, owner, name);
  const branches = listBranchesOf(repo).map((branch) => ({
    name: branch,
    commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string },
  }));
  return jsonReply(200, branches);
}

/** GET /api/v3/repos/{o}/{r}/branches/{branch} — one branch, 404 when absent. */
export function getBranch(store: ForgeStore, owner: string, name: string, branch: string): Reply {
  const repo = requireRepo(store, owner, name);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) throw notFound('Not Found');
  return jsonReply(200, { name: branch, commit: { sha: tip } });
}

/**
 * GET /api/v3/repos/{o}/{r}/commits?sha=<ref> — the history newest-first,
 * walking parents from the ref tip (a branch name, a full ref, or a commit
 * sha; default: the default branch tip). An unborn repo answers [].
 */
export function listCommits(store: ForgeStore, owner: string, name: string, query: URLSearchParams): Reply {
  const repo = requireRepo(store, owner, name);
  const shaParam = query.get('sha');
  const tip = shaParam
    ? resolveRefOrSha(repo, shaParam)
    : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? undefined);
  if (!tip) return jsonReply(200, []);
  const params = parsePageParams(query);
  const oids = listCommitOids(repo, tip);
  const page = paginate(oids, params);
  const views: Record<string, unknown>[] = [];
  for (const oid of page.items) {
    const view = commitView(repo, oid);
    if (view) views.push(view);
  }
  return jsonReply(200, views);
}

/**
 * POST /api/v3/repos/{o}/{r}/git/refs — create a ref at a commit sha.
 * 201 `{ref, object: {sha}}`; 422 when the ref exists or the sha is unknown.
 */
export function createGitRef(store: ForgeStore, owner: string, name: string, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  const ref = body.ref;
  const sha = body.sha;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
    throw unprocessable('Validation Failed: ref must start with refs/');
  }
  if (typeof sha !== 'string' || !isObjectId(sha)) throw unprocessable('Validation Failed: sha is required');
  const object = repo.objects.get(sha);
  if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
    throw unprocessable('Validation Failed: sha does not name a commit');
  }
  if (repo.refs.has(ref)) throw unprocessable(`Validation Failed: ${ref} already exists`);
  repo.refs.set(ref, sha);
  return jsonReply(201, { ref, object: { sha } });
}

/**
 * GET /api/v3/repos/{o}/{r}/git/refs/{ref...} — one ref (e.g. heads/main).
 * Answers `{ref, object: {sha}, sha}` (all three shapes, for every reader).
 * 404 when the ref is absent.
 */
export function getGitRef(store: ForgeStore, owner: string, name: string, refPath: string): Reply {
  const repo = requireRepo(store, owner, name);
  const ref = `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (!sha) throw notFound('Not Found');
  return jsonReply(200, { ref, object: { sha }, sha });
}

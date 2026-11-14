// REST v3 contents: PUT/GET/DELETE `/repos/{o}/{r}/contents/{path}`.
// Every write is a REAL git commit (new blob + rebuilt trees + commit object
// with the branch tip as parent), so a file created here is visible to a
// later git clone, and a pushed file is readable here.

import { GitObjectError, hashObject, parseCommit } from '../git/objects.ts';
import { branchTip, resolveRefOrSha } from '../git/refs.ts';
import { createCommitObject } from '../git/commits.ts';
import { emptyTreeOid, findPathEntry, listDirEntries, splitPath, updateTree } from '../git/trees.ts';
import type { ForgeStore, RepoRecord } from '../store/store.ts';
import { conflict, isJsonObject, jsonReply, notFound, unprocessable, type Reply } from '../http/server.ts';

/** The branch a write targets: the body's `branch`, or the default branch. */
function targetBranch(repo: RepoRecord, body: Record<string, unknown>): string {
  return typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
}

/**
 * The tip a write builds on: the target branch's tip, or — when the branch
 * does not exist yet — the default branch's tip (the branch is created from
 * it). Undefined when the repo is unborn.
 */
function writeBaseTip(repo: RepoRecord, branch: string): string | undefined {
  return branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
}

/** The tree a write builds on: the base tip's tree, or null on an unborn repo. */
function writeBaseTree(repo: RepoRecord, tip: string | undefined): string | null {
  if (!tip) return null;
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The blob oid at `path` on the base tip, or null when the path is not a file there. */
function currentBlobOid(repo: RepoRecord, tip: string | undefined, path: string): string | null {
  if (!tip) return null;
  const tree = writeBaseTree(repo, tip);
  if (!tree) return null;
  const entry = findPathEntry(repo, tree, path);
  if (!entry || entry.mode === '40000') return null;
  return entry.oid;
}

function fileView(repo: RepoRecord, path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    content: data.toString('base64'),
    sha: blobOid,
    size: data.length,
    name,
    path,
  };
}

/**
 * PUT /contents/{path}: create or update a file with a commit.
 * 201 when the file is new, 200 when it replaces one. A `sha` that does not
 * match the current blob is a 409.
 */
export function putContents(
  store: ForgeStore,
  repo: RepoRecord,
  path: string,
  body: unknown,
): Reply {
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.message !== 'string' || body.message === '') {
    throw unprocessable('Validation Failed: message is required');
  }
  if (typeof body.content !== 'string') throw unprocessable('Validation Failed: content is required');
  let segments: string[];
  try {
    segments = splitPath(path);
  } catch {
    throw unprocessable(`Validation Failed: bad path ${JSON.stringify(path)}`);
  }
  const cleanPath = segments.join('/');
  const branch = targetBranch(repo, body);
  const tip = writeBaseTip(repo, branch);
  const current = currentBlobOid(repo, tip, cleanPath);
  if (typeof body.sha === 'string') {
    if (current === null || body.sha.toLowerCase() !== current.toLowerCase()) {
      throw conflict('The blob sha does not match the current file');
    }
  }
  // A directory at the path cannot be overwritten by a file.
  if (tip) {
    const tree = writeBaseTree(repo, tip);
    const entry = tree ? findPathEntry(repo, tree, cleanPath) : null;
    if (entry && entry.mode === '40000') throw unprocessable(`Validation Failed: ${cleanPath} is a directory`);
  }
  const data = Buffer.from(body.content, 'base64');
  const blobOid = hashObject('blob', data);
  if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data });
  let newTree: string | null;
  try {
    newTree = updateTree(repo, writeBaseTree(repo, tip), cleanPath, blobOid);
  } catch (err) {
    if (err instanceof GitObjectError) throw unprocessable(`Validation Failed: ${err.message}`);
    throw err;
  }
  if (newTree === null) newTree = emptyTreeOid(repo);
  const commitOid = createCommitObject(store, repo, {
    tree: newTree,
    parents: tip ? [tip] : [],
    message: body.message,
  });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  const isCreate = current === null;
  return jsonReply(isCreate ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      sha: blobOid,
      size: data.length,
      name: cleanPath.split('/').pop() ?? cleanPath,
      path: cleanPath,
    },
    commit: { sha: commitOid, message: body.message },
  });
}

/**
 * GET /contents/{path}: a file object for a file, an array of entries for a
 * directory, 404 for anything else. `?ref=` selects the branch/commit
 * (default: the default branch tip).
 */
export function getContents(repo: RepoRecord, path: string, query: URLSearchParams): Reply {
  const ref = query.get('ref');
  const tip = ref ? resolveRefOrSha(repo, ref) : branchTip(repo, repo.defaultBranch);
  if (!tip) throw notFound('Not Found');
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') throw notFound('Not Found');
  const treeOid = parseCommit(object.data).tree;
  const cleanPath = path === '' ? '' : path.replace(/^\/+/, '').replace(/\/+$/, '');

  if (cleanPath === '') {
    const entries = listDirEntries(repo, treeOid, '') ?? [];
    return jsonReply(200, entries.map((entry) => dirEntryView(entry, '')));
  }
  let entry;
  try {
    entry = findPathEntry(repo, treeOid, cleanPath);
  } catch {
    throw notFound('Not Found');
  }
  if (!entry) throw notFound('Not Found');
  if (entry.mode === '40000') {
    const entries = listDirEntries(repo, treeOid, cleanPath) ?? [];
    return jsonReply(200, entries.map((child) => dirEntryView(child, cleanPath)));
  }
  const blob = repo.objects.get(entry.oid);
  if (!blob || blob.type !== 'blob') throw notFound('Not Found');
  return jsonReply(200, fileView(repo, cleanPath, entry.oid, blob.data));
}

function dirEntryView(entry: { mode: string; name: string; oid: string }, dir: string): Record<string, unknown> {
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: dir === '' ? entry.name : `${dir}/${entry.name}`,
    sha: entry.oid,
    size: 0,
  };
}

/**
 * DELETE /contents/{path}: remove a file with a commit. 200 `{commit:{sha}}`.
 * A `sha` that does not match the current blob is a 409; a missing file is 404.
 */
export function deleteContents(
  store: ForgeStore,
  repo: RepoRecord,
  path: string,
  body: unknown,
): Reply {
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.message !== 'string' || body.message === '') {
    throw unprocessable('Validation Failed: message is required');
  }
  let segments: string[];
  try {
    segments = splitPath(path);
  } catch {
    throw notFound('Not Found');
  }
  const cleanPath = segments.join('/');
  const branch = targetBranch(repo, body);
  const tip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
  if (!tip) throw notFound('Not Found');
  const current = currentBlobOid(repo, tip, cleanPath);
  if (current === null) throw notFound('Not Found');
  if (typeof body.sha === 'string' && body.sha.toLowerCase() !== current.toLowerCase()) {
    throw conflict('The blob sha does not match the current file');
  }
  let newTree: string | null;
  try {
    newTree = updateTree(repo, writeBaseTree(repo, tip), cleanPath, null);
  } catch (err) {
    if (err instanceof GitObjectError) throw unprocessable(`Validation Failed: ${err.message}`);
    throw err;
  }
  if (newTree === null) newTree = emptyTreeOid(repo);
  const commitOid = createCommitObject(store, repo, {
    tree: newTree,
    parents: [tip],
    message: body.message,
  });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return jsonReply(200, { commit: { sha: commitOid, message: body.message } });
}

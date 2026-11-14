// Tree surgery: read a path out of a tree, list a directory, and rebuild a
// tree with one path set or removed. The contents API and the merge engine
// both build on these — every write creates real git objects, so a REST
// commit is visible to a later git clone byte-for-byte.

import { buildTree, GitObjectError, hashObject, parseTree, type TreeEntry } from './objects.ts';
import type { RepoRecord } from '../store/store.ts';

/** Split a repo-relative path into segments; rejects empty, absolute and `..` paths. */
export function splitPath(path: string): string[] {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') throw new GitObjectError('empty path', 'tree-path');
  const segments = clean.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new GitObjectError(`bad path segment ${JSON.stringify(segment)} in ${JSON.stringify(path)}`, 'tree-path');
    }
  }
  return segments;
}

/** The tree object for an oid, parsed — or null when the oid is not a tree. */
function readTree(repo: RepoRecord, oid: string): TreeEntry[] | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** Store a tree object built from entries; returns its oid. */
function storeTree(repo: RepoRecord, entries: readonly TreeEntry[]): string {
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/**
 * Walk `segments` from `rootTreeOid`: returns the entry the path names
 * (a blob or a subtree), or null when any segment is missing.
 */
export function findPathEntry(repo: RepoRecord, rootTreeOid: string, path: string): TreeEntry | null {
  const segments = splitPath(path);
  let treeOid = rootTreeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const entries = readTree(repo, treeOid);
    if (!entries) return null;
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/** The entries of the directory at `path` ('' = the root), or null when it is not a directory. */
export function listDirEntries(repo: RepoRecord, rootTreeOid: string, path: string): TreeEntry[] | null {
  if (path === '' || path === '/') return readTree(repo, rootTreeOid);
  const entry = findPathEntry(repo, rootTreeOid, path);
  if (!entry || entry.mode !== '40000') return null;
  return readTree(repo, entry.oid);
}

/**
 * Rebuild the tree with `path` set to `blobOid` (or removed when null).
 * Intermediate directories are created as needed; directories emptied by a
 * removal are pruned. Returns the new root tree oid, or null when the whole
 * tree is emptied (the caller then stores the empty tree instead).
 * Throws GitObjectError when an intermediate segment is a file, not a dir.
 */
export function updateTree(
  repo: RepoRecord,
  rootTreeOid: string | null,
  path: string,
  blobOid: string | null,
): string | null {
  const segments = splitPath(path);

  const update = (treeOid: string | null, depth: number): string | null => {
    const entries = treeOid === null ? [] : (readTree(repo, treeOid) ?? []);
    const name = segments[depth] as string;
    const isLeaf = depth === segments.length - 1;
    const existingIndex = entries.findIndex((entry) => entry.name === name);
    const next = [...entries];
    if (isLeaf) {
      if (blobOid === null) {
        if (existingIndex >= 0) next.splice(existingIndex, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (existingIndex >= 0) next[existingIndex] = entry;
        else next.push(entry);
      }
    } else {
      const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
      if (existing && existing.mode !== '40000') {
        throw new GitObjectError(`path ${JSON.stringify(path)} crosses file ${JSON.stringify(name)}`, 'tree-path-conflict');
      }
      const childOid = update(existing?.oid ?? null, depth + 1);
      if (childOid === null) {
        if (existingIndex >= 0) next.splice(existingIndex, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name, oid: childOid };
        if (existingIndex >= 0) next[existingIndex] = entry;
        else next.push(entry);
      }
    }
    if (next.length === 0) return null;
    return storeTree(repo, next);
  };

  return update(rootTreeOid, 0);
}

/** The empty tree's oid (the well-known `4b825dc...`), stored in the repo. */
export function emptyTreeOid(repo: RepoRecord): string {
  return storeTree(repo, []);
}

/** Flatten a tree into path → entry (files only, gitlinks skipped). */
export function flattenTree(repo: RepoRecord, rootTreeOid: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (treeOid: string, prefix: string): void => {
    const entries = readTree(repo, treeOid);
    if (!entries) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, entry);
    }
  };
  walk(rootTreeOid, '');
  return out;
}

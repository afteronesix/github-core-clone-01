// Three-way diffs: merge-base, tree diffs with line counts, conflict
// detection, and the squash-merge tree builder. REST pull files, REST merge
// and the GraphQL `mergeable`/`files` fields all share this module.

import { parseCommit } from './objects.ts';
import { flattenTree } from './trees.ts';
import { buildTree, hashObject, type TreeEntry } from './objects.ts';
import type { RepoRecord } from '../store/store.ts';

/**
 * The merge-base of two commits: the nearest common ancestor. BFS from `a`
 * marks every ancestor with its distance; BFS from `b` returns the first
 * marked commit (nearest to `b`). Linear histories have exactly one.
 */
export function mergeBase(repo: RepoRecord, aOid: string, bOid: string): string | null {
  const ancestors = new Map<string, number>();
  const queueA: Array<[string, number]> = [[aOid, 0]];
  while (queueA.length) {
    const [oid, depth] = queueA.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.set(oid, depth);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
  }
  const queueB: Array<[string, number]> = [[bOid, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestDepth = Infinity;
  while (queueB.length) {
    const [oid, depth] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthA = ancestors.get(oid);
    if (depthA !== undefined && depthA + depth < bestDepth) {
      best = oid;
      bestDepth = depthA + depth;
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
  }
  return best;
}

/** The tree oid of a commit, or null when the oid is not a commit. */
export function commitTreeOid(repo: RepoRecord, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------------------------------------
// line diffs
// ---------------------------------------------------------------------------------------------

/** Split content into lines the way git counts them (a trailing newline ends the last line). */
export function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line additions/deletions between two blobs, via LCS dynamic programming.
 * Files here are small (scenario content, ~1 KiB pushes), so the O(n·m)
 * table is cheap and the counts are exact.
 */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1] as number);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[m] as number;
  return { additions: m - lcs, deletions: n - lcs };
}

// ---------------------------------------------------------------------------------------------
// tree diffs
// ---------------------------------------------------------------------------------------------

export type FileStatus = 'added' | 'modified' | 'removed';

export interface ChangedFile {
  readonly filename: string;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/**
 * The files changed between two trees (base → head), sorted by filename.
 * `status` is added/modified/removed; `changes` = additions + deletions.
 */
export function diffTrees(repo: RepoRecord, baseTreeOid: string, headTreeOid: string): ChangedFile[] {
  const baseFiles = flattenTree(repo, baseTreeOid);
  const headFiles = flattenTree(repo, headTreeOid);
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: ChangedFile[] = [];
  for (const name of names) {
    const baseEntry = baseFiles.get(name);
    const headEntry = headFiles.get(name);
    if (baseEntry && headEntry && baseEntry.oid === headEntry.oid) continue;
    const baseData = baseEntry ? (repo.objects.get(baseEntry.oid)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const headData = headEntry ? (repo.objects.get(headEntry.oid)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const counts = lineDiff(baseData, headData);
    const status: FileStatus = !baseEntry ? 'added' : !headEntry ? 'removed' : 'modified';
    out.push({
      filename: name,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------------------------
// three-way merge
// ---------------------------------------------------------------------------------------------

/**
 * True when merging `headOid` into `baseTipOid` (with `baseOid` as their
 * merge-base) conflicts: a path the head changed whose base-side blob also
 * changed to something different (including delete-vs-modify).
 */
export function hasMergeConflict(
  repo: RepoRecord,
  baseTipOid: string,
  headOid: string,
  baseOid: string,
): boolean {
  const baseTipTree = commitTreeOid(repo, baseTipOid);
  const headTree = commitTreeOid(repo, headOid);
  const baseTree = commitTreeOid(repo, baseOid);
  if (!baseTipTree || !headTree || !baseTree) return true;
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const tipFiles = flattenTree(repo, baseTipTree);
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const name of names) {
    const baseEntry = baseFiles.get(name);
    const headEntry = headFiles.get(name);
    const headChanged = (baseEntry?.oid ?? null) !== (headEntry?.oid ?? null);
    if (!headChanged) continue;
    const tipEntry = tipFiles.get(name);
    const tipChanged = (baseEntry?.oid ?? null) !== (tipEntry?.oid ?? null);
    if (!tipChanged) continue;
    // Both sides changed it: a conflict unless they changed it the same way.
    if ((headEntry?.oid ?? null) !== (tipEntry?.oid ?? null)) return true;
  }
  return false;
}

/** Build a tree from a flat path → entry map, storing every tree object. */
export function buildTreeFromFiles(repo: RepoRecord, files: ReadonlyMap<string, TreeEntry>): string {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/**
 * The squash-merge tree: the base tip's tree with every head-vs-merge-base
 * change applied. (Callers check hasMergeConflict first.)
 */
export function squashMergeTree(
  repo: RepoRecord,
  baseTipOid: string,
  headOid: string,
  baseOid: string,
): string {
  const baseTipTree = commitTreeOid(repo, baseTipOid) as string;
  const headTree = commitTreeOid(repo, headOid) as string;
  const baseTree = commitTreeOid(repo, baseOid) as string;
  const merged = new Map(flattenTree(repo, baseTipTree));
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const name of names) {
    const baseEntry = baseFiles.get(name);
    const headEntry = headFiles.get(name);
    if ((baseEntry?.oid ?? null) === (headEntry?.oid ?? null)) continue;
    if (headEntry) merged.set(name, headEntry);
    else merged.delete(name);
  }
  return buildTreeFromFiles(repo, merged);
}

// Ref helpers: listing, HEAD resolution, tag peeling, and the fast-forward
// rule a push is judged by. All ref state lives in the repo record's refs map.

import { isAncestor, isObjectId, parseTag, peelToCommit, ZERO_OID, type GitObject } from './objects.ts';
import type { RepoRecord } from '../store/store.ts';

export interface ListedRef {
  readonly name: string;
  readonly oid: string;
}

/** HEAD's target: always the default branch (`refs/heads/main`). */
export function headTarget(repo: RepoRecord): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** HEAD's oid: the default branch's tip, or ZERO_OID when the repo is unborn. */
export function headOid(repo: RepoRecord): string {
  return repo.refs.get(headTarget(repo)) ?? ZERO_OID;
}

/** Every ref, sorted lexicographically by name (git's advertisement order). */
export function listRefs(repo: RepoRecord): ListedRef[] {
  const refs: ListedRef[] = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/**
 * The ref set as a cache-key string (`name=oid;` pairs, Map order). Two repos
 * with the same key have the same refs, so any response derived only from the
 * ref set (advertisements, ls-refs) is identical for them. A different
 * insertion order only costs a cache miss, never a wrong hit.
 */
export function refSetKey(repo: RepoRecord): string {
  let key = '';
  for (const [name, oid] of repo.refs) key += `${name}=${oid};`;
  return key;
}

export function getRef(repo: RepoRecord, name: string): string | undefined {
  return repo.refs.get(name);
}

export function setRef(repo: RepoRecord, name: string, oid: string): void {
  repo.refs.set(name, oid);
}

export function deleteRef(repo: RepoRecord, name: string): boolean {
  return repo.refs.delete(name);
}

/**
 * Peel an annotated tag to the commit it points at (through tag chains).
 * Returns null when the oid is not a tag, or the chain does not end at a commit.
 */
export function peelTag(repo: RepoRecord, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(oid, (id) => repo.objects.get(id));
}

/** Resolve a branch name, full ref, or commit sha to an oid, or undefined. */
export function resolveRefOrSha(repo: RepoRecord, value: string): string | undefined {
  if (isObjectId(value)) {
    const object = repo.objects.get(value);
    if (object && (object.type === 'commit' || object.type === 'tag')) {
      return object.type === 'tag' ? (peelToCommit(value, (id) => repo.objects.get(id)) ?? value) : value;
    }
    return undefined;
  }
  if (value.startsWith('refs/')) return repo.refs.get(value);
  if (value === 'HEAD') {
    const oid = headOid(repo);
    return oid === ZERO_OID ? undefined : oid;
  }
  return repo.refs.get(`refs/heads/${value}`);
}

/** The tip of a branch name, or undefined when the branch does not exist. */
export function branchTip(repo: RepoRecord, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Branch names, sorted (for GET /branches). */
export function listBranches(repo: RepoRecord): string[] {
  const names: string[] = [];
  for (const name of repo.refs.keys()) {
    if (name.startsWith('refs/heads/')) names.push(name.slice('refs/heads/'.length));
  }
  names.sort();
  return names;
}

export type FastForwardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The fast-forward rule for one push command. `current` is the ref's tip
 * before the push (ZERO_OID when the ref does not exist):
 * - create (old ZERO, ref absent): allowed.
 * - delete (new ZERO): allowed when old matches the current tip.
 * - update: allowed iff old matches the current tip AND new descends from old
 *   (or old is ZERO on an absent ref — the create case above).
 * A stale old (the client raced another push) and a non-descendant new are
 * both reported as `non-fast-forward`: the suite asserts that exact reason.
 */
export function checkFastForward(
  repo: RepoRecord,
  ref: string,
  oldOid: string,
  newOid: string,
): FastForwardVerdict {
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (newOid === ZERO_OID) return { ok: true }; // delete
  if (oldOid === ZERO_OID) return { ok: true }; // create
  if (newOid === oldOid) return { ok: true }; // a no-op update
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // A tag ref's new value is a tag object: peel it for the ancestry check.
  const newCommit = peelToCommit(newOid, lookup) ?? newOid;
  const oldCommit = peelToCommit(oldOid, lookup) ?? oldOid;
  if (isAncestor(oldCommit, newCommit, lookup)) return { ok: true };
  return { ok: false, reason: 'non-fast-forward' };
}

/** True when the oid names a commit or tag (a legal ref target). */
export function isRefTarget(repo: RepoRecord, oid: string): boolean {
  const object = repo.objects.get(oid);
  return Boolean(object && (object.type === 'commit' || object.type === 'tag'));
}

/** Parse a tag object view, or null when the oid is not a tag. */
export function tagTarget(repo: RepoRecord, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

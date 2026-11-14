// Commits the server creates itself (contents PUT/DELETE, squash merges):
// build the object with the viewer's identity and a deterministic timestamp,
// list a history newest-first, and render the REST commit view.

import { buildCommit, hashObject, parseCommit } from './objects.ts';
import type { ForgeStore, RepoRecord } from '../store/store.ts';

/** The identity server-created commits carry: the scenario viewer. */
export function serverIdentity(store: ForgeStore): string {
  return `${store.viewer.name} <${store.viewer.email}>`;
}

/**
 * Build and store a commit object. The message is stored verbatim (no added
 * newline), so GET /commits echoes exactly what the caller submitted.
 * Returns the commit oid.
 */
export function createCommitObject(
  store: ForgeStore,
  repo: RepoRecord,
  fields: { tree: string; parents: readonly string[]; message: string },
): string {
  const stamp = store.now();
  const identity = serverIdentity(store);
  const data = buildCommit({
    tree: fields.tree,
    parents: fields.parents,
    message: fields.message,
    author: identity,
    committer: identity,
    timestamp: stamp.epochSec,
  });
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** A history newest-first: depth-first from the tip, parents in order, deduplicated. */
export function listCommitOids(repo: RepoRecord, tipOid: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index] as string);
  }
  return out;
}

interface IdentityView {
  readonly name: string;
  readonly email: string;
  readonly date: string;
}

/** Parse `Name <email> ts +0000` into its parts; falls back to the raw line. */
export function parseIdentity(line: string): IdentityView {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  const [, name, email, ts] = match as unknown as [string, string, string, string];
  const date = new Date(Number(ts) * 1000).toISOString();
  return { name, email, date };
}

/** The REST view of one commit, or null when the oid is not a commit. */
export function commitView(repo: RepoRecord, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: parseIdentity(commit.author),
      committer: parseIdentity(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

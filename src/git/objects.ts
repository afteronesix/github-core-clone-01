// The git object model: hashing, tree/commit/tag parse and build, reachability,
// and the fetch planner (what a fetch sends, and which commits are shallow).
//
// Objects are stored verbatim: the bytes that arrive in a pack are the bytes a
// clone returns, so a SHA-1 recomputed over them always matches the id. Every
// builder here mirrors the kit client's (git-client.ts) byte for byte — the
// suite compares pushed bytes against cloned bytes, so there is no room for a
// second opinion about the commit format.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** A git object: its type and its exact byte content (no header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** The all-zero object id: "no object", used for creates, deletes and unborn refs. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Thrown when an object is malformed, missing, or fails a size/hash check. */
export class GitObjectError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'GitObjectError';
    this.code = code;
  }
}

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id (the only id form the suite accepts). */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** The loose-object header `<type> <size>\0` that prefixes the hashed bytes. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  // Feed the header as a string: identical bytes, one less Buffer allocation.
  hash.update(`${type} ${body.length}\u0000`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, `160000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitObjectError('tree entry has no mode separator', 'tree-parse');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitObjectError('tree entry has no name terminator', 'tree-parse');
    if (nul + 21 > buffer.length) throw new GitObjectError('tree entry has a truncated object id', 'tree-parse');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitObjectError(`tree entry mode ${JSON.stringify(mode)} is not octal`, 'tree-parse');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new GitObjectError(`tree entry ${entry.name} has a bad object id`, 'tree-build');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Any headers before the blank line that are not modelled (`gpgsig`, `encoding`, ...). */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/**
 * A commit's parent ids, scanned straight from the raw bytes without a full
 * parse (no header string, no split, no message decode, no `extra` array).
 * Behavior matches `parseCommit` exactly for the fields it touches: a bad
 * parent id or a missing/invalid tree throws the same GitObjectError with
 * the same code. The push workload's fast-forward check walks one parent
 * per push through this instead of a full parse.
 */
export function commitParents(data: Uint8Array): string[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const parents: string[] = [];
  let tree = '';
  let offset = 0;
  while (offset < headerEnd) {
    const nl = buffer.indexOf(0x0a, offset);
    const lineEnd = nl < 0 || nl > headerEnd ? headerEnd : nl;
    if (lineEnd - offset > 0) {
      const space = buffer.indexOf(0x20, offset);
      const keyEnd = space < 0 || space > lineEnd ? lineEnd : space;
      const key = buffer.subarray(offset, keyEnd).toString('ascii');
      if (key === 'parent') {
        const value = keyEnd < lineEnd ? buffer.subarray(keyEnd + 1, lineEnd).toString('ascii') : '';
        if (!isObjectId(value)) throw new GitObjectError('commit has a bad parent id', 'commit-parse');
        parents.push(value);
      } else if (key === 'tree') {
        tree = keyEnd < lineEnd ? buffer.subarray(keyEnd + 1, lineEnd).toString('ascii') : '';
      }
    }
    offset = lineEnd + 1;
  }
  if (!isObjectId(tree)) throw new GitObjectError('commit has no valid tree header', 'commit-parse');
  return parents;
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'committer') committer = value;
    else if (key === 'author') author = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new GitObjectError('commit has no valid tree header', 'commit-parse');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new GitObjectError('commit has a bad parent id', 'commit-parse');
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitObjectError(`tag header ${JSON.stringify(line)} has no value`, 'tag-parse');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new GitObjectError('tag has no valid object header', 'tag-parse');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitObjectError(`tag has bad type ${JSON.stringify(type)}`, 'tag-parse');
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** The committer timestamp of a commit object (seconds), or null when unparseable. */
export function commitTimestamp(data: Uint8Array): number | null {
  try {
    const committer = parseCommit(data).committer;
    const match = / (\d+) [+-]\d{4}$/.exec(committer);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** Fields for a deterministic commit object. */
export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  /** Unix seconds. Callers pass a fixed constant, never Date.now(). */
  readonly timestamp?: number;
  /** `+0000` by default, so two runs produce the same bytes. */
  readonly timezone?: string;
}

/** The default identity every generated commit and tag carries, so bytes are reproducible. */
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new GitObjectError('buildCommit needs a valid tree id', 'commit-build');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new GitObjectError('buildCommit needs valid parent ids', 'commit-build');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  if (!isObjectId(fields.object)) throw new GitObjectError('buildTag needs a valid object id', 'tag-build');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** A lookup from object id to object; a plain Map is the common case. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries
 * (gitlinks skipped), tag → its target, blob → nothing. Throws on a missing
 * object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new GitObjectError(`object ${oid} is missing from the store`, 'missing-object');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * What a client holding `roots` already has. Like collectReachable, except a
 * commit in `clientShallow` contributes itself and its tree but NOT its
 * parents: a shallow clone holds its boundary commit without the history
 * behind it, so reachable-from-a-have must not swallow a deepen fetch's
 * parents. Missing objects are skipped (a have may name an object this
 * store never saw).
 */
export function collectHeld(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  clientShallow: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!clientShallow.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of commitParents(object.data)) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Follow a tag chain to its target commit (or the object itself when it is not a tag). */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// the fetch planner
// ---------------------------------------------------------------------------------------------

export interface FetchPlanInput {
  /** Object ids the client wants. */
  readonly wants: readonly string[];
  /** Object ids the client already holds. */
  readonly haves?: readonly string[];
  /** The client's current shallow boundary (required when deepening). */
  readonly clientShallow?: readonly string[];
  /** Depth limit in commit generations from the wants (1 = the tips only). */
  readonly depth?: number;
  /** Include only commits at or after this unix timestamp. */
  readonly deepenSince?: number;
  /** Exclude commits reachable from these refs or object ids. */
  readonly deepenNot?: readonly string[];
  /** Resolves a deepen-not ref name to an object id, when the value is not an oid. */
  readonly resolveRef?: (ref: string) => string | undefined;
}

export interface FetchPlan {
  /** Object ids to pack: reachable from the wants, within the depth, minus the haves. */
  readonly objects: Set<string>;
  /** Boundary commits: included, but their parents are not (the client must treat them as shallow). */
  readonly shallow: string[];
  /** Former shallow boundaries whose parents this fetch delivers. */
  readonly unshallow: string[];
}

/**
 * Decide what a fetch sends. The traversal is generation-based from the wants:
 * a commit at generation `g` is included when `g < depth` (or always, with no
 * depth), and a commit whose parents fall outside the depth is a shallow
 * boundary. Haves do NOT stop the traversal — a deepen fetch wants the parents
 * of a commit the client already holds — they are subtracted at the end.
 * Throws GitObjectError when a want is missing from the store.
 */
export function planFetch(lookup: ObjectLookup, input: FetchPlanInput): FetchPlan {
  const haves = new Set(input.haves ?? []);
  const clientShallow = new Set(input.clientShallow ?? []);
  // The have-set stops at the client's shallow boundaries: a shallow clone
  // holds its boundary commit but not its parents (see collectHeld).
  const haveSet = collectHeld(haves, lookup, clientShallow);

  // Commits excluded by deepen-not: never traversed, and a child of one is a boundary.
  const excluded = new Set<string>();
  if (input.deepenNot?.length) {
    const roots: string[] = [];
    for (const value of input.deepenNot) {
      if (isObjectId(value)) roots.push(value);
      else {
        const resolved = input.resolveRef?.(value);
        if (resolved) roots.push(resolved);
      }
    }
    for (const oid of collectReachable(roots, lookup, { allowMissing: true })) excluded.add(oid);
  }

  const since = input.deepenSince;
  const depth = input.depth;
  const included = new Set<string>();
  const boundary = new Set<string>();
  const visitedCommits = new Set<string>();
  // The parents each included commit still needs, for the unshallow computation.
  const parentsOf = new Map<string, string[]>();

  const addTreeClosure = (treeOid: string): void => {
    for (const oid of collectReachable([treeOid], lookup)) included.add(oid);
  };

  // Queue entries are [commit oid, generation]. Tags resolve to their target commit
  // at the same generation; the tag object itself is always included.
  const queue: Array<[string, number]> = [];
  const enqueueObject = (oid: string, generation: number): void => {
    const object = lookup(oid);
    if (!object) throw new GitObjectError(`fetch wants ${oid}, which the store does not hold`, 'fetch-want-missing');
    if (object.type === 'commit') {
      queue.push([oid, generation]);
    } else if (object.type === 'tag') {
      included.add(oid);
      enqueueObject(parseTag(object.data).object, generation);
    } else if (object.type === 'tree') {
      addTreeClosure(oid);
    } else {
      included.add(oid);
    }
  };
  for (const want of input.wants) enqueueObject(want, 0);

  while (queue.length) {
    const [oid, generation] = queue.pop()!;
    if (visitedCommits.has(oid)) continue;
    visitedCommits.add(oid);
    if (excluded.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    const commit = parseCommit(object.data);
    parentsOf.set(oid, commit.parents);
    addTreeClosure(commit.tree);
    let isBoundary = false;
    for (const parent of commit.parents) {
      if (excluded.has(parent)) {
        isBoundary = true;
        continue;
      }
      if (depth != null && generation + 1 >= depth) {
        isBoundary = true;
        continue;
      }
      if (since != null) {
        const parentObject = lookup(parent);
        const stamp = parentObject?.type === 'commit' ? commitTimestamp(parentObject.data) : null;
        if (stamp == null || stamp < since) {
          isBoundary = true;
          continue;
        }
      }
      queue.push([parent, generation + 1]);
    }
    if (isBoundary) boundary.add(oid);
  }

  const objects = new Set<string>();
  for (const oid of included) if (!haveSet.has(oid)) objects.add(oid);

  // A boundary is reported shallow when the client receives it now, or already
  // holds it as shallow. A boundary the client holds with full history is NOT
  // re-listed — that would wrongly shallow a complete history.
  const shallow: string[] = [];
  for (const oid of boundary) {
    if (objects.has(oid) || clientShallow.has(oid)) shallow.push(oid);
  }
  shallow.sort();

  // A former boundary is unshallowed when this fetch delivers at least one of its
  // parents and every parent is now on the client (sent or already held).
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const parents = parentsOf.get(oid);
    if (!parents || parents.length === 0) continue;
    let deliveredParent = false;
    let allPresent = true;
    for (const parent of parents) {
      if (objects.has(parent)) deliveredParent = true;
      if (!objects.has(parent) && !haveSet.has(parent)) allPresent = false;
    }
    if (deliveredParent && allPresent) unshallow.push(oid);
  }
  unshallow.sort();

  return { objects, shallow, unshallow };
}

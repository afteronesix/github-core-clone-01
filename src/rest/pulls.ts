// REST v3 pull requests: create, list, get, files, squash merge.
// A PR freezes its head/base shas at creation; the merge is a three-way
// squash onto the CURRENT base tip (conflict → 405).

import type { ForgeStore, PullRecord, RepoRecord } from '../store/store.ts';
import { branchTip } from '../git/refs.ts';
import { createCommitObject } from '../git/commits.ts';
import { diffTrees, hasMergeConflict, mergeBase, squashMergeTree, commitTreeOid } from '../git/diff.ts';
import { isJsonObject, jsonReply, methodNotAllowed, notFound, unprocessable, type Reply } from '../http/server.ts';
import { buildLinkHeader, paginate, parsePageParams } from './pagination.ts';
import { requireRepo } from './repos.ts';

/** The serialized pull request object (GitHub's shape, the fields the suite reads). */
export function pullView(store: ForgeStore, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/**
 * Insert a pull request record (shared by REST and GraphQL). Freezes the
 * head/base shas at creation. Throws 422 on an unknown head/base branch or
 * a duplicate open PR for the same head+base.
 */
export function insertPull(
  store: ForgeStore,
  repo: RepoRecord,
  input: { title: string; body?: string; head: string; base: string },
): PullRecord {
  if (input.head === '') throw unprocessable('Validation Failed: head is required');
  const headSha = branchTip(repo, input.head);
  if (!headSha) throw unprocessable(`Validation Failed: head branch ${JSON.stringify(input.head)} does not exist`);
  const baseSha = branchTip(repo, input.base);
  if (!baseSha) throw unprocessable(`Validation Failed: base branch ${JSON.stringify(input.base)} does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      throw unprocessable(`Validation Failed: an open pull request already exists for ${input.head} into ${input.base}`);
    }
  }
  const stamp = store.now();
  const seq = store.nextSequence();
  const pull: PullRecord = {
    id: store.nextIssueRecordId(),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    headSha,
    baseRef: input.base,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: seq,
    updatedSeq: seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/**
 * Squash-merge a pull request onto the CURRENT base tip (shared by REST and
 * GraphQL). Returns the merge commit sha. Throws 405 when already merged or
 * closed, or when the merge conflicts.
 */
export function squashMergePull(store: ForgeStore, repo: RepoRecord, pull: PullRecord): string {
  if (pull.merged || pull.state !== 'open') {
    throw methodNotAllowed('Pull request is already merged or closed');
  }
  const baseTip = branchTip(repo, pull.baseRef);
  if (!baseTip) throw unprocessable(`Validation Failed: base branch ${JSON.stringify(pull.baseRef)} does not exist`);
  const base = mergeBase(repo, baseTip, pull.headSha);
  if (!base) throw methodNotAllowed('Pull request has no merge base');
  if (hasMergeConflict(repo, baseTip, pull.headSha, base)) {
    throw methodNotAllowed('Merge conflict: the pull request cannot be merged cleanly');
  }
  const tree = squashMergeTree(repo, baseTip, pull.headSha, base);
  const mergeSha = createCommitObject(store, repo, {
    tree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${pull.headRef}`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  const stamp = store.now();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp.iso;
  pull.mergeCommitSha = mergeSha;
  pull.updatedSeq = store.nextSequence();
  pull.updatedAt = stamp.iso;
  return mergeSha;
}

/** POST /api/v3/repos/{o}/{r}/pulls — open a PR. 201; unknown head/base or a duplicate open PR is 422. */
export function createPull(store: ForgeStore, owner: string, name: string, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.title !== 'string' || body.title === '') {
    throw unprocessable('Validation Failed: title is required');
  }
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  const pull = insertPull(store, repo, {
    title: body.title,
    body: typeof body.body === 'string' ? body.body : '',
    head,
    base,
  });
  return jsonReply(201, pullView(store, repo, pull));
}

/** GET /api/v3/repos/{o}/{r}/pulls — filter by state (default open), newest first, paginated. */
export function listPulls(
  store: ForgeStore,
  owner: string,
  name: string,
  query: URLSearchParams,
  origin: string,
): Reply {
  const repo = requireRepo(store, owner, name);
  const state = query.get('state') ?? 'open';
  const params = parsePageParams(query);
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const page = paginate(pulls, params);
  const link = buildLinkHeader(`${origin}/api/v3/repos/${owner}/${name}/pulls`, params, page.total, {
    ...(state !== 'open' ? { state } : {}),
  });
  const headers: Record<string, string> = {};
  if (link) headers.link = link;
  return jsonReply(200, page.items.map((pull) => pullView(store, repo, pull)), headers);
}

/** GET /api/v3/repos/{o}/{r}/pulls/{n} — one PR, 404 when absent. */
export function getPull(store: ForgeStore, owner: string, name: string, number: number): Reply {
  const repo = requireRepo(store, owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound('Not Found');
  return jsonReply(200, pullView(store, repo, pull));
}

/**
 * GET /api/v3/repos/{o}/{r}/pulls/{n}/files — the three-way diff
 * (merge-base of the current base tip and the frozen head sha → head).
 */
export function listPullFiles(store: ForgeStore, owner: string, name: string, number: number): Reply {
  const repo = requireRepo(store, owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound('Not Found');
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, baseTip, pull.headSha);
  const baseTree = base ? commitTreeOid(repo, base) : null;
  const headTree = commitTreeOid(repo, pull.headSha);
  if (!baseTree || !headTree) return jsonReply(200, []);
  return jsonReply(200, diffTrees(repo, baseTree, headTree));
}

/**
 * PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge — squash merge onto the current
 * base tip. 200 `{sha, merged: true, message}`; unknown PR 404; conflicted
 * or already-merged 405.
 */
export function mergePull(store: ForgeStore, owner: string, name: string, number: number, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) throw notFound('Not Found');
  const mergeSha = squashMergePull(store, repo, pull);
  return jsonReply(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

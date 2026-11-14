// REST v3 issues: labels, issues, comments. Issues and PRs share one number
// sequence per repo (the store's nextNumber), starting at 1.

import type { CommentRecord, ForgeStore, IssueRecord, RepoRecord } from '../store/store.ts';
import { isJsonObject, jsonReply, jsonReplyRaw, notFound, unprocessable, type Reply } from '../http/server.ts';
import { buildLinkHeader, paginate, parsePageParams } from './pagination.ts';
import { requireRepo } from './repos.ts';

/** The serialized issue object (GitHub's shape, the fields the suite reads). */
export function issueView(store: ForgeStore, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

/** POST /api/v3/repos/{o}/{r}/labels — create (or re-return) a label. 201. */
export function createLabel(store: ForgeStore, owner: string, name: string, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.name !== 'string' || body.name === '') {
    throw unprocessable('Validation Failed: name is required');
  }
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  const existing = repo.labels.get(body.name);
  if (existing) return jsonReply(201, { name: existing.name, color: existing.color });
  repo.labels.set(body.name, { name: body.name, color });
  return jsonReply(201, { name: body.name, color });
}

/** Resolve label names from a create/patch body; unknown names are a 422. */
function resolveLabelNames(repo: RepoRecord, body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw unprocessable('Validation Failed: labels must be an array');
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name;
    if (typeof name !== 'string') throw unprocessable('Validation Failed: labels must be names');
    if (!repo.labels.has(name)) throw unprocessable(`Validation Failed: label ${JSON.stringify(name)} does not exist`);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Insert an issue record into the repo (shared by REST and GraphQL). */
export function insertIssue(
  store: ForgeStore,
  repo: RepoRecord,
  input: { title: string; body?: string; labels?: string[] },
): IssueRecord {
  const stamp = store.now();
  const seq = store.nextSequence();
  const issue: IssueRecord = {
    id: store.nextIssueRecordId(),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
    createdSeq: seq,
    updatedSeq: seq,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Close an issue record (shared by REST and GraphQL). */
export function closeIssueRecord(store: ForgeStore, repo: RepoRecord, issue: IssueRecord): void {
  issue.state = 'closed';
  issue.closedAt = store.now().iso;
  issue.updatedSeq = store.nextSequence();
  issue.updatedAt = store.now().iso;
  repo.issueJsonCache.delete(issue.number);
}

/** Insert a comment record on an issue (shared by REST and GraphQL). */
export function insertComment(store: ForgeStore, issue: IssueRecord, body: string): CommentRecord {
  const comment: CommentRecord = { id: store.nextCommentRecordId(), body, createdAt: store.now().iso };
  issue.comments.push(comment);
  return comment;
}

/** POST /api/v3/repos/{o}/{r}/issues — create an open issue. 201. */
export function createIssue(store: ForgeStore, owner: string, name: string, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.title !== 'string' || body.title === '') {
    throw unprocessable('Validation Failed: title is required');
  }
  const labels = resolveLabelNames(repo, body);
  const issue = insertIssue(store, repo, {
    title: body.title,
    body: typeof body.body === 'string' ? body.body : '',
    labels,
  });
  return jsonReply(201, issueView(store, repo, issue));
}

/** GET /api/v3/repos/{o}/{r}/issues — filter by state, sort by creation, paginated. */
export function listIssues(
  store: ForgeStore,
  owner: string,
  name: string,
  query: URLSearchParams,
  origin: string,
): Reply {
  const repo = requireRepo(store, owner, name);
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  const params = parsePageParams(query);
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  // `state=all` (and anything else) lists everything.
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const page = paginate(issues, params);
  const link = buildLinkHeader(`${origin}/api/v3/repos/${owner}/${name}/issues`, params, page.total, {
    ...(state !== 'open' ? { state } : {}),
  });
  const headers: Record<string, string> = {};
  if (link) headers.link = link;
  return jsonReply(200, page.items.map((issue) => issueView(store, repo, issue)), headers);
}

/** GET /api/v3/repos/{o}/{r}/issues/{n} — one issue, 404 when absent. The read workload's hot path (2,000 sequential GETs): the serialized view is cached per issue and invalidated on PATCH/close. */
export function getIssue(store: ForgeStore, owner: string, name: string, number: number): Reply {
  const repo = requireRepo(store, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Not Found');
  const cached = repo.issueJsonCache.get(number);
  if (cached !== undefined) return jsonReplyRaw(200, cached);
  const body = Buffer.from(`${JSON.stringify(issueView(store, repo, issue))}\n`, 'utf8');
  repo.issueJsonCache.set(number, body);
  return jsonReplyRaw(200, body);
}

/** PATCH /api/v3/repos/{o}/{r}/issues/{n} — title, body, state, labels. */
export function patchIssue(store: ForgeStore, owner: string, name: string, number: number, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Not Found');
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.labels !== undefined) {
    const labels = resolveLabelNames(repo, body);
    issue.labels.length = 0;
    issue.labels.push(...labels);
  }
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? store.now().iso : null;
  }
  issue.updatedSeq = store.nextSequence();
  issue.updatedAt = store.now().iso;
  repo.issueJsonCache.delete(number);
  return jsonReply(200, issueView(store, repo, issue));
}

/** POST /api/v3/repos/{o}/{r}/issues/{n}/comments — add a comment. 201. */
export function createComment(store: ForgeStore, owner: string, name: string, number: number, body: unknown): Reply {
  const repo = requireRepo(store, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Not Found');
  if (!isJsonObject(body)) throw unprocessable('Validation Failed: body must be an object');
  if (typeof body.body !== 'string' || body.body === '') {
    throw unprocessable('Validation Failed: body is required');
  }
  const comment = insertComment(store, issue, body.body);
  return jsonReply(201, {
    id: comment.id,
    body: comment.body,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  });
}

/** GET /api/v3/repos/{o}/{r}/issues/{n}/comments — the issue's comments, in order. */
export function listComments(store: ForgeStore, owner: string, name: string, number: number): Reply {
  const repo = requireRepo(store, owner, name);
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Not Found');
  return jsonReply(
    200,
    issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    })),
  );
}

// ForgeStore: the single source of truth every surface shares. Git objects,
// refs, issues, PRs, labels and comments all live here — REST, GraphQL and MCP
// are thin views over the same records, which is why a GraphQL mutation is
// visible over REST and a REST contents commit is visible to a git clone.
//
// Determinism: every server-created timestamp comes from the DetClock (fixed
// epoch + monotonic counter) and every id from a sequential counter. Nothing
// in this file reads a wall clock or Math.random.

import { DetClock, type DetTimestamp } from './clock.ts';
import { computeViewer, type ScenarioUser } from './scenario.ts';
import type { GitObject } from '../git/objects.ts';

export type IssueState = 'open' | 'closed';
export type PullState = 'open' | 'closed';

export interface LabelRecord {
  readonly name: string;
  readonly color: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  readonly labels: string[];
  readonly comments: CommentRecord[];
  readonly createdSeq: number;
  updatedSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: PullState;
  /** The head branch name and its tip AT CREATION (frozen — a later push does not move it). */
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
  updatedSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface RepoRecord {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Git objects, keyed by oid. Stored verbatim, byte-exact. */
  readonly objects: Map<string, GitObject>;
  /** Refs, keyed by full name (`refs/heads/main`). */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: Map<number, IssueRecord>;
  readonly pulls: Map<number, PullRecord>;
  /** Issues and PRs share ONE number sequence per repo, starting at 1. */
  nextNumber: number;
  /** Cached serialized issue JSON (the read workload's hot path); cleared on PATCH. */
  readonly issueJsonCache: Map<number, string>;
}

export class ForgeStore {
  readonly viewer: ScenarioUser;
  readonly clock = new DetClock();
  private readonly repos = new Map<string, RepoRecord>();
  private readonly creationOrder: RepoRecord[] = [];
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextSeq = 1;
  private nextRequestId = 1;

  constructor() {
    // The token's login, recomputed from the contest's fixed seed. Throws when
    // the computed value disagrees with the verified one — a seed drift must
    // fail the boot loudly, never silently 404 every repository read.
    this.viewer = computeViewer();
  }

  /** The next timestamp (fixed epoch + monotonic counter). */
  now(): DetTimestamp {
    return this.clock.next();
  }

  /** The next creation/order sequence number (issue sort order, stable). */
  nextSequence(): number {
    const value = this.nextSeq;
    this.nextSeq += 1;
    return value;
  }

  /** The next request id for the X-GitHub-Request-Id header (`req-1`, `req-2`, ...). */
  nextRequest(): string {
    const value = this.nextRequestId;
    this.nextRequestId += 1;
    return `req-${value}`;
  }

  nextIssueRecordId(): number {
    const value = this.nextIssueId;
    this.nextIssueId += 1;
    return value;
  }

  nextCommentRecordId(): number {
    const value = this.nextCommentId;
    this.nextCommentId += 1;
    return value;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** The viewer's repos in creation order (GET /user/repos). */
  listViewerRepos(): RepoRecord[] {
    return this.creationOrder.filter((repo) => repo.owner === this.viewer.login);
  }

  /**
   * Create a repo under the viewer login. Returns null when a repo of that
   * name already exists under the viewer (the caller answers 422).
   */
  createRepo(name: string, options: { description?: string; private?: boolean }): RepoRecord | null {
    const owner = this.viewer.login;
    if (this.repos.has(this.key(owner, name))) return null;
    const stamp = this.now();
    const repo: RepoRecord = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      issueJsonCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    this.creationOrder.push(repo);
    return repo;
  }

  /** Delete a repo. Returns false when it does not exist. */
  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    const index = this.creationOrder.indexOf(repo);
    if (index >= 0) this.creationOrder.splice(index, 1);
    return true;
  }

  /** Store an object (idempotent — the same oid twice is one object). */
  putObject(repo: RepoRecord, oid: string, object: GitObject): void {
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }

  getObject(repo: RepoRecord, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** A lookup bound to one repo, for the git helpers. */
  lookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }
}

// GraphQL executor: validate a document against the schema, then resolve it
// against the ForgeStore. One operation per call; the HTTP layer batches by
// calling it once per entry. A validation failure (an unknown field) or a
// resolver failure answers `{data: null, errors: [...]}` with HTTP 200 —
// GitHub's shape, which the invalid-field check requires.
//
// Resolvers read the same store records REST uses, so a GraphQL mutation is
// visible over REST and vice versa. Global ids are the store's opaque
// base64url ids (never plain numbers).

import type { ForgeStore, IssueRecord, PullRecord, RepoRecord } from '../store/store.ts';
import { decodeGlobalId, issueGlobalId, pullGlobalId, repoGlobalId, commentGlobalId } from '../store/ids.ts';
import { branchTip, headOid } from '../git/refs.ts';
import { ZERO_OID } from '../git/objects.ts';
import { commitTreeOid, diffTrees, hasMergeConflict, mergeBase } from '../git/diff.ts';
import { closeIssueRecord, insertComment, insertIssue } from '../rest/issues.ts';
import { insertPull, squashMergePull } from '../rest/pulls.ts';
import { HttpError, isJsonObject, jsonReply, type Reply } from '../http/server.ts';
import { fieldsOf, SCHEMA } from './schema.ts';
import {
  parseGraphQL,
  type DefinitionNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type ValueNode,
} from './parser.ts';

/** An error the executor reports as a GraphQL `errors` entry (HTTP 200). */
export class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

export interface GraphQLResult {
  data: unknown;
  errors?: { message: string }[];
}

// --- Value wrappers ----------------------------------------------------------
// Every resolved object carries its GraphQL type name so fragments and
// `__typename` resolve without a schema lookup.

type Wrapper = { __typename: string; [key: string]: unknown };

interface ExecContext {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinitionNode>;
}

type Resolver = (parent: Wrapper, args: Record<string, unknown>, ctx: ExecContext) => unknown;

// --- Cursors -----------------------------------------------------------------

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(text);
  return match ? Number(match[1]) : null;
}

// --- Value coercion ----------------------------------------------------------

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name] ?? null;
    case 'IntValue':
      return Number.parseInt(node.value, 10);
    case 'FloatValue':
      return Number.parseFloat(node.value);
    case 'StringValue':
      return node.value;
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map((value) => valueFromAst(value, variables));
    case 'ObjectValue': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = valueFromAst(field.value, variables);
      return object;
    }
  }
}

function argsFromAst(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const argument of field.arguments) args[argument.name] = valueFromAst(argument.value, variables);
  return args;
}

// --- Global-id lookups --------------------------------------------------------

function repoFromGlobalId(ctx: ExecContext, id: unknown, what: string): RepoRecord {
  if (typeof id !== 'string') throw new GraphQLError(`Could not resolve to a Repository with the id of ${JSON.stringify(id)}.`);
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'repo') {
    throw new GraphQLError(`Could not resolve to a Repository with the id of ${JSON.stringify(id)}.`);
  }
  const slash = decoded.key.indexOf('/');
  const repo = slash >= 0 ? ctx.store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) : undefined;
  if (!repo) throw new GraphQLError(`Could not resolve to a ${what} with the id of ${JSON.stringify(id)}.`);
  return repo;
}

function issueFromGlobalId(ctx: ExecContext, id: unknown): { repo: RepoRecord; issue: IssueRecord } {
  if (typeof id !== 'string') throw new GraphQLError(`Could not resolve to an Issue with the id of ${JSON.stringify(id)}.`);
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'issue') {
    throw new GraphQLError(`Could not resolve to an Issue with the id of ${JSON.stringify(id)}.`);
  }
  const colon = decoded.key.lastIndexOf(':');
  const number = colon >= 0 ? Number(decoded.key.slice(colon + 1)) : Number.NaN;
  const repoKey = colon >= 0 ? decoded.key.slice(0, colon) : '';
  const slash = repoKey.indexOf('/');
  const repo = slash >= 0 ? ctx.store.getRepo(repoKey.slice(0, slash), repoKey.slice(slash + 1)) : undefined;
  const issue = repo && Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!repo || !issue) throw new GraphQLError(`Could not resolve to an Issue with the id of ${JSON.stringify(id)}.`);
  return { repo, issue };
}

function pullFromGlobalId(ctx: ExecContext, id: unknown): { repo: RepoRecord; pull: PullRecord } {
  if (typeof id !== 'string') throw new GraphQLError(`Could not resolve to a PullRequest with the id of ${JSON.stringify(id)}.`);
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'pull') {
    throw new GraphQLError(`Could not resolve to a PullRequest with the id of ${JSON.stringify(id)}.`);
  }
  const colon = decoded.key.lastIndexOf(':');
  const number = colon >= 0 ? Number(decoded.key.slice(colon + 1)) : Number.NaN;
  const repoKey = colon >= 0 ? decoded.key.slice(0, colon) : '';
  const slash = repoKey.indexOf('/');
  const repo = slash >= 0 ? ctx.store.getRepo(repoKey.slice(0, slash), repoKey.slice(slash + 1)) : undefined;
  const pull = repo && Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!repo || !pull) throw new GraphQLError(`Could not resolve to a PullRequest with the id of ${JSON.stringify(id)}.`);
  return { repo, pull };
}

// --- Connections ---------------------------------------------------------------

function issuesConnection(repo: RepoRecord, args: Record<string, unknown>): Wrapper {
  let issues = [...repo.issues.values()];
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states as string[]);
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isJsonObject(args.orderBy) ? args.orderBy : undefined;
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  if (typeof args.after === 'string') {
    const afterNumber = decodeCursor(args.after);
    if (afterNumber !== null) {
      const index = issues.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) issues = issues.slice(index + 1);
    }
  }
  const totalCount = issues.length;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const last = page[page.length - 1];
  return {
    __typename: 'IssueConnection',
    repo,
    items: page,
    totalCount,
    hasNextPage,
    endCursor: last ? encodeCursor(last.number) : null,
  };
}

function pullRequestsConnection(repo: RepoRecord, args: Record<string, unknown>): Wrapper {
  let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const totalCount = pulls.length;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return { __typename: 'PullRequestConnection', repo, items: page, totalCount, hasNextPage: pulls.length > page.length, endCursor: null };
}

function pullFilesConnection(repo: RepoRecord, pull: PullRecord, args: Record<string, unknown>): Wrapper {
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, baseTip, pull.headSha);
  const baseTree = base ? commitTreeOid(repo, base) : null;
  const headTree = commitTreeOid(repo, pull.headSha);
  let files: { path: string; additions: number; deletions: number; changeType: string }[] = [];
  if (baseTree && headTree) {
    files = diffTrees(repo, baseTree, headTree).map((file) => ({
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
    }));
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : files.length;
  const page = files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    files: page,
    totalCount: files.length,
    hasNextPage: files.length > page.length,
    endCursor: null,
  };
}

function mergeableState(repo: RepoRecord, pull: PullRecord): string {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const baseTip = branchTip(repo, pull.baseRef);
  if (!baseTip) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, pull.headSha);
  if (!base) return 'UNKNOWN';
  return hasMergeConflict(repo, baseTip, pull.headSha, base) ? 'CONFLICTING' : 'MERGEABLE';
}

// --- Wrappers ------------------------------------------------------------------

function userWrapper(ctx: ExecContext): Wrapper {
  const user = ctx.store.viewer;
  return { __typename: 'User', login: user.login, name: user.name, email: user.email };
}

function repoWrapper(repo: RepoRecord): Wrapper {
  return { __typename: 'Repository', repo };
}

function issueWrapper(repo: RepoRecord, issue: IssueRecord): Wrapper {
  return { __typename: 'Issue', repo, issue };
}

function pullWrapper(repo: RepoRecord, pull: PullRecord): Wrapper {
  return { __typename: 'PullRequest', repo, pull };
}

// --- Resolvers -----------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  if (!isJsonObject(args.input)) throw new GraphQLError('The mutation input must be an object.');
  return args.input;
}

/** Convert a REST-layer HttpError (422/405) into a GraphQL error entry. */
function asGraphQLError(err: unknown): GraphQLError {
  if (err instanceof HttpError) return new GraphQLError(err.message);
  if (err instanceof GraphQLError) return err;
  return new GraphQLError(err instanceof Error ? err.message : String(err));
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: (_parent, _args, ctx) => userWrapper(ctx),
    repository: (_parent, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoWrapper(repo) : null;
    },
    node: (_parent, args, ctx) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const slash = decoded.key.indexOf('/');
        if (slash < 0) return null;
        const repo = ctx.store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
        return repo ? repoWrapper(repo) : null;
      }
      try {
        if (decoded.kind === 'issue') {
          const { repo, issue } = issueFromGlobalId(ctx, id);
          return issueWrapper(repo, issue);
        }
        if (decoded.kind === 'pull') {
          const { repo, pull } = pullFromGlobalId(ctx, id);
          return pullWrapper(repo, pull);
        }
      } catch {
        return null;
      }
      return null;
    },
    __type: (_parent, args, _ctx) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (SCHEMA[name] === undefined) return null;
      return { __typename: '__Type', typeName: name };
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      try {
        const input = inputOf(args);
        const repo = repoFromGlobalId(ctx, input.repositoryId, 'Repository');
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') throw new GraphQLError('createIssue requires a title.');
        const issue = insertIssue(ctx.store, repo, {
          title,
          body: typeof input.body === 'string' ? input.body : '',
        });
        return { __typename: 'CreateIssuePayload', issue: issueWrapper(repo, issue) };
      } catch (err) {
        throw asGraphQLError(err);
      }
    },
    closeIssue: (_parent, args, ctx) => {
      try {
        const input = inputOf(args);
        const { repo, issue } = issueFromGlobalId(ctx, input.issueId);
        closeIssueRecord(ctx.store, repo, issue);
        return { __typename: 'CloseIssuePayload', issue: issueWrapper(repo, issue) };
      } catch (err) {
        throw asGraphQLError(err);
      }
    },
    createPullRequest: (_parent, args, ctx) => {
      try {
        const input = inputOf(args);
        const repo = repoFromGlobalId(ctx, input.repositoryId, 'Repository');
        const title = typeof input.title === 'string' ? input.title : '';
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
        if (title === '') throw new GraphQLError('createPullRequest requires a title.');
        const pull = insertPull(ctx.store, repo, {
          title,
          body: typeof input.body === 'string' ? input.body : '',
          head,
          base,
        });
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullWrapper(repo, pull) };
      } catch (err) {
        throw asGraphQLError(err);
      }
    },
    mergePullRequest: (_parent, args, ctx) => {
      try {
        const input = inputOf(args);
        const { repo, pull } = pullFromGlobalId(ctx, input.pullRequestId);
        squashMergePull(ctx.store, repo, pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullWrapper(repo, pull) };
      } catch (err) {
        throw asGraphQLError(err);
      }
    },
    addComment: (_parent, args, ctx) => {
      try {
        const input = inputOf(args);
        const { repo, issue } = issueFromGlobalId(ctx, input.subjectId);
        const body = typeof input.body === 'string' ? input.body : '';
        if (body === '') throw new GraphQLError('addComment requires a body.');
        const comment = insertComment(ctx.store, issue, body);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', repo, issue, comment },
          },
        };
      } catch (err) {
        throw asGraphQLError(err);
      }
    },
  },
  User: {
    id: (parent) => Buffer.from(`user:${String(parent.login)}`, 'utf8').toString('base64url'),
    login: (parent) => parent.login,
    name: (parent) => parent.name,
    email: (parent) => parent.email,
  },
  Repository: {
    id: (parent) => {
      const repo = parent.repo as RepoRecord;
      return repoGlobalId(repo.owner, repo.name);
    },
    databaseId: (parent) => (parent.repo as RepoRecord).id,
    name: (parent) => (parent.repo as RepoRecord).name,
    nameWithOwner: (parent) => (parent.repo as RepoRecord).fullName,
    owner: (_parent, _args, ctx) => userWrapper(ctx),
    description: (parent) => (parent.repo as RepoRecord).description,
    isPrivate: (parent) => (parent.repo as RepoRecord).private,
    defaultBranchRef: (parent) => {
      const repo = parent.repo as RepoRecord;
      if (headOid(repo) === ZERO_OID) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const repo = parent.repo as RepoRecord;
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.get(number);
      return issue ? issueWrapper(repo, issue) : null;
    },
    issues: (parent, args) => issuesConnection(parent.repo as RepoRecord, args),
    pullRequests: (parent, args) => pullRequestsConnection(parent.repo as RepoRecord, args),
    pullRequest: (parent, args) => {
      const repo = parent.repo as RepoRecord;
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.get(number);
      return pull ? pullWrapper(repo, pull) : null;
    },
  },
  Ref: {
    id: (parent) => Buffer.from(`ref:${String(parent.name)}`, 'utf8').toString('base64url'),
    name: (parent) => parent.name,
    target: () => null,
  },
  Issue: {
    id: (parent) => {
      const repo = parent.repo as RepoRecord;
      return issueGlobalId(repo.owner, repo.name, (parent.issue as IssueRecord).number);
    },
    databaseId: (parent) => (parent.issue as IssueRecord).id,
    number: (parent) => (parent.issue as IssueRecord).number,
    title: (parent) => (parent.issue as IssueRecord).title,
    body: (parent) => (parent.issue as IssueRecord).body,
    state: (parent) => ((parent.issue as IssueRecord).state === 'open' ? 'OPEN' : 'CLOSED'),
    author: (_parent, _args, ctx) => userWrapper(ctx),
  },
  IssueConnection: {
    nodes: (parent) => (parent.items as IssueRecord[]).map((issue) => issueWrapper(parent.repo as RepoRecord, issue)),
    pageInfo: (parent) => ({
      __typename: 'PageInfo',
      hasNextPage: parent.hasNextPage,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: parent.endCursor,
    }),
    totalCount: (parent) => parent.totalCount,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    startCursor: (parent) => parent.startCursor,
    endCursor: (parent) => parent.endCursor,
  },
  PullRequest: {
    id: (parent) => {
      const repo = parent.repo as RepoRecord;
      return pullGlobalId(repo.owner, repo.name, (parent.pull as PullRecord).number);
    },
    databaseId: (parent) => (parent.pull as PullRecord).id,
    number: (parent) => (parent.pull as PullRecord).number,
    title: (parent) => (parent.pull as PullRecord).title,
    body: (parent) => (parent.pull as PullRecord).body,
    state: (parent) => {
      const pull = parent.pull as PullRecord;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (parent) => (parent.pull as PullRecord).merged,
    mergeable: (parent) => mergeableState(parent.repo as RepoRecord, parent.pull as PullRecord),
    headRefName: (parent) => (parent.pull as PullRecord).headRef,
    baseRefName: (parent) => (parent.pull as PullRecord).baseRef,
    files: (parent, args) => pullFilesConnection(parent.repo as RepoRecord, parent.pull as PullRecord, args),
    author: (_parent, _args, ctx) => userWrapper(ctx),
  },
  PullRequestConnection: {
    nodes: (parent) => (parent.items as PullRecord[]).map((pull) => pullWrapper(parent.repo as RepoRecord, pull)),
    pageInfo: (parent) => ({
      __typename: 'PageInfo',
      hasNextPage: parent.hasNextPage,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: parent.endCursor,
    }),
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) =>
      (parent.files as { path: string; additions: number; deletions: number; changeType: string }[]).map((file) => ({
        __typename: 'PullRequestChangedFile',
        ...file,
      })),
    pageInfo: (parent) => ({
      __typename: 'PageInfo',
      hasNextPage: parent.hasNextPage,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: parent.endCursor,
    }),
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path,
    additions: (parent) => parent.additions,
    deletions: (parent) => parent.deletions,
    changeType: (parent) => parent.changeType,
  },
  CreateIssuePayload: { issue: (parent) => parent.issue },
  CloseIssuePayload: { issue: (parent) => parent.issue },
  CreatePullRequestPayload: { pullRequest: (parent) => parent.pullRequest },
  MergePullRequestPayload: { pullRequest: (parent) => parent.pullRequest },
  AddCommentPayload: { commentEdge: (parent) => parent.commentEdge },
  IssueCommentEdge: { node: (parent) => parent.node },
  IssueComment: {
    id: (parent) => {
      const repo = parent.repo as RepoRecord;
      const issue = parent.issue as IssueRecord;
      const comment = parent.comment as { id: number };
      return commentGlobalId(repo.owner, repo.name, issue.number, comment.id);
    },
    databaseId: (parent) => (parent.comment as { id: number }).id,
    body: (parent) => (parent.comment as { body: string }).body,
    author: (_parent, _args, ctx) => userWrapper(ctx),
  },
  __Type: {
    name: (parent) => parent.typeName,
    kind: (parent) => SCHEMA[String(parent.typeName)]?.kind ?? 'OBJECT',
    fields: (parent) => {
      const type = SCHEMA[String(parent.typeName)];
      if (!type) return [];
      return Object.keys(type.fields).map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (parent) => {
      const type = SCHEMA[String(parent.typeName)];
      if (!type) return [];
      return type.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: { name: (parent) => parent.name, description: () => null },
  __EnumValue: { name: (parent) => parent.name, description: () => null },
};

// --- Validation ---------------------------------------------------------------

/**
 * Validate an operation's selections against the schema. Returns the error
 * messages (empty when valid). An unknown field is the case the suite checks:
 * the message must name the field.
 */
function validateSelectionSet(
  selections: readonly SelectionNode[],
  typeName: string,
  fragments: Map<string, FragmentDefinitionNode>,
  errors: string[],
  visitedFragments: Set<string>,
): void {
  const fields = fieldsOf(typeName);
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      if (selection.name === '__typename') continue;
      if (!fields || fields[selection.name] === undefined) {
        errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
        continue;
      }
      if (selection.selectionSet !== null) {
        const returnType = fields[selection.name]?.type;
        if (returnType !== undefined) {
          validateSelectionSet(selection.selectionSet, returnType, fragments, errors, visitedFragments);
        }
      }
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      const target = selection.typeCondition ?? typeName;
      if (SCHEMA[target] === undefined) {
        errors.push(`Unknown type "${target}".`);
        continue;
      }
      validateSelectionSet(selection.selectionSet, target, fragments, errors, visitedFragments);
      continue;
    }
    // Fragment spread.
    const fragment = fragments.get(selection.name);
    if (!fragment) {
      errors.push(`Unknown fragment "${selection.name}".`);
      continue;
    }
    if (visitedFragments.has(fragment.name)) continue;
    visitedFragments.add(fragment.name);
    validateSelectionSet(fragment.selectionSet, fragment.typeCondition, fragments, errors, visitedFragments);
  }
}

function validateOperation(
  operation: OperationDefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
): string[] {
  const errors: string[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelectionSet(operation.selectionSet, rootType, fragments, errors, new Set());
  return errors;
}

// --- Execution ------------------------------------------------------------------

/** Collect a selection set's fields for one object, applying fragments. */
function collectFields(
  selections: readonly SelectionNode[],
  parent: Wrapper,
  fragments: Map<string, FragmentDefinitionNode>,
  out: FieldNode[],
  visitedFragments: Set<string>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      out.push(selection);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) continue;
      collectFields(selection.selectionSet, parent, fragments, out, visitedFragments);
      continue;
    }
    const fragment = fragments.get(selection.name);
    if (!fragment) continue;
    if (fragment.typeCondition !== parent.__typename) continue;
    if (visitedFragments.has(fragment.name)) continue;
    visitedFragments.add(fragment.name);
    collectFields(fragment.selectionSet, parent, fragments, out, visitedFragments);
  }
}

function executeSelectionSet(
  selections: readonly SelectionNode[],
  parent: Wrapper,
  parentType: string,
  ctx: ExecContext,
): Record<string, unknown> {
  const fields: FieldNode[] = [];
  collectFields(selections, parent, ctx.fragments, fields, new Set());
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      result[responseKey] = parent.__typename;
      continue;
    }
    const resolver = RESOLVERS[parentType]?.[field.name];
    if (!resolver) {
      // Validated already; a missing resolver is a server bug — report it as
      // a GraphQL error rather than crashing the request.
      throw new GraphQLError(`No resolver for field "${field.name}" on type "${parentType}".`);
    }
    const args = argsFromAst(field, ctx.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (err) {
      throw asGraphQLError(err);
    }
    if (field.selectionSet === null || value === null || value === undefined) {
      result[responseKey] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      result[responseKey] = value.map((entry) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Wrapper)
          ? executeSelectionSet(
              field.selectionSet as SelectionNode[],
              entry as Wrapper,
              (entry as Wrapper).__typename,
              ctx,
            )
          : entry,
      );
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Wrapper)) {
      // Recurse on the value's RUNTIME type: node(id:) declares the Node
      // interface but returns a concrete Repository/Issue/PullRequest, and
      // the fragment selections only match the concrete type.
      result[responseKey] = executeSelectionSet(
        field.selectionSet,
        value as Wrapper,
        (value as Wrapper).__typename,
        ctx,
      );
      continue;
    }
    result[responseKey] = value;
  }
  return result;
}

// --- Entry points ---------------------------------------------------------------

function operationsOf(document: DocumentNode): OperationDefinitionNode[] {
  return document.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition',
  );
}

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const map = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition') map.set(definition.name, definition);
  }
  return map;
}

function resolveVariables(
  operation: OperationDefinitionNode,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const definition of operation.variableDefinitions) {
    const supplied = provided[definition.name];
    if (supplied !== undefined) {
      values[definition.name] = supplied;
      continue;
    }
    if (definition.defaultValue !== null) {
      values[definition.name] = valueFromAst(definition.defaultValue, {});
      continue;
    }
    if (definition.type.kind === 'NonNullType') {
      throw new GraphQLError(`Variable $${definition.name} of required type ${typeNameOf(definition.type)} was not provided.`);
    }
    values[definition.name] = null;
  }
  // Variables the document does not declare are ignored (GitHub errors on
  // them; the suite never sends any).
  return values;
}

function typeNameOf(type: { kind: string; name?: string; ofType?: { kind: string; name?: string; ofType?: unknown } }): string {
  if (type.kind === 'NamedType') return type.name ?? 'Unknown';
  if (type.kind === 'ListType') return `[${type.ofType ? typeNameOf(type.ofType as never) : 'Unknown'}]`;
  return `${type.ofType ? typeNameOf(type.ofType as never) : 'Unknown'}!`;
}

/** Execute one GraphQL operation document. Never throws. */
export function executeGraphQL(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): GraphQLResult {
  let document: DocumentNode;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operations = operationsOf(document);
  let operation: OperationDefinitionNode | undefined;
  if (operationName !== undefined) {
    operation = operations.find((candidate) => candidate.name === operationName);
    if (!operation) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const fragments = fragmentsOf(document);
  const validationErrors = validateOperation(operation, fragments);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  let resolvedVariables: Record<string, unknown>;
  try {
    resolvedVariables = resolveVariables(operation, variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const ctx: ExecContext = { store, variables: resolvedVariables, fragments };
  try {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(operation.selectionSet, { __typename: rootType }, rootType, ctx);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

function executeOne(store: ForgeStore, entry: unknown): GraphQLResult {
  if (!isJsonObject(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = isJsonObject(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  return executeGraphQL(store, entry.query, variables, operationName);
}

/**
 * POST /api/graphql — one operation object, or a JSON array of operations
 * (GitHub's operation batching; answers an array in the same order).
 */
export function handleGraphQL(store: ForgeStore, body: unknown): Reply {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jsonReply(200, []);
    }
    return jsonReply(200, body.map((entry) => executeOne(store, entry)));
  }
  return jsonReply(200, executeOne(store, body));
}

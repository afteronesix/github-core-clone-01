// The forge's GraphQL schema, as a table: the field list of every object type
// and the values of every enum. Two consumers read it — the executor's
// validator (an unknown field is a 200 with an `errors` array naming it) and
// the `__type` introspection resolver (gh's feature probes read these lists).
//
// The field lists are GitHub's real shapes, trimmed to what this forge
// implements — but every field the suite reads or probes MUST be present:
// Issue ⊇ id, number, title, state, body; PullRequest ⊇ id, number,
// headRefName, baseRefName, mergeable, state, merged, files; Repository ⊇ id,
// databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission,
// hasIssuesEnabled, issue, issues, pullRequests, pullRequest; SearchType ∋
// ISSUE.

export interface SchemaField {
  /** The field's return type name (for validation and fragment narrowing). */
  type: string;
}

export interface SchemaType {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields: Readonly<Record<string, SchemaField>>;
  enumValues: readonly string[];
}

function objectType(fields: Readonly<Record<string, string>>): SchemaType {
  const table: Record<string, SchemaField> = {};
  for (const [name, type] of Object.entries(fields)) table[name] = { type };
  return { kind: 'OBJECT', fields: table, enumValues: [] };
}

function enumType(values: readonly string[]): SchemaType {
  return { kind: 'ENUM', fields: {}, enumValues: values };
}

function inputType(fields: Readonly<Record<string, string>>): SchemaType {
  const table: Record<string, SchemaField> = {};
  for (const [name, type] of Object.entries(fields)) table[name] = { type };
  return { kind: 'INPUT_OBJECT', fields: table, enumValues: [] };
}

export const SCHEMA: Readonly<Record<string, SchemaType>> = Object.freeze({
  Query: objectType({
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
  }),
  Mutation: objectType({
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  }),
  Node: {
    kind: 'INTERFACE',
    fields: { id: { type: 'ID' } },
    enumValues: [],
  },
  User: objectType({
    id: 'ID',
    login: 'String',
    name: 'String',
    email: 'String',
  }),
  Repository: objectType({
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    description: 'String',
    isPrivate: 'Boolean',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  }),
  Ref: objectType({
    id: 'ID',
    name: 'String',
    target: 'GitObject',
  }),
  GitObject: objectType({
    id: 'ID',
    oid: 'String',
  }),
  Issue: objectType({
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'IssueState',
    author: 'User',
  }),
  IssueConnection: objectType({
    nodes: 'Issue',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  }),
  PageInfo: objectType({
    hasNextPage: 'Boolean',
    hasPreviousPage: 'Boolean',
    startCursor: 'String',
    endCursor: 'String',
  }),
  PullRequest: objectType({
    id: 'ID',
    databaseId: 'Int',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    mergeable: 'MergeableState',
    headRefName: 'String',
    baseRefName: 'String',
    files: 'PullRequestChangedFileConnection',
    author: 'User',
  }),
  PullRequestConnection: objectType({
    nodes: 'PullRequest',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  }),
  PullRequestChangedFileConnection: objectType({
    nodes: 'PullRequestChangedFile',
    pageInfo: 'PageInfo',
    totalCount: 'Int',
  }),
  PullRequestChangedFile: objectType({
    path: 'String',
    additions: 'Int',
    deletions: 'Int',
    changeType: 'String',
  }),
  CreateIssuePayload: objectType({ issue: 'Issue' }),
  CloseIssuePayload: objectType({ issue: 'Issue' }),
  CreatePullRequestPayload: objectType({ pullRequest: 'PullRequest' }),
  MergePullRequestPayload: objectType({ pullRequest: 'PullRequest' }),
  AddCommentPayload: objectType({ commentEdge: 'IssueCommentEdge' }),
  IssueCommentEdge: objectType({ node: 'IssueComment' }),
  IssueComment: objectType({
    id: 'ID',
    databaseId: 'Int',
    body: 'String',
    author: 'User',
  }),
  __Type: objectType({
    name: 'String',
    kind: 'String',
    fields: '__Field',
    enumValues: '__EnumValue',
  }),
  __Field: objectType({
    name: 'String',
    description: 'String',
  }),
  __EnumValue: objectType({
    name: 'String',
    description: 'String',
  }),
  IssueState: enumType(['OPEN', 'CLOSED']),
  PullRequestState: enumType(['OPEN', 'CLOSED', 'MERGED']),
  MergeableState: enumType(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  RepositoryPermission: enumType(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  SearchType: enumType(['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE']),
  IssueOrderField: enumType(['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
  OrderDirection: enumType(['ASC', 'DESC']),
  CreateIssueInput: inputType({ repositoryId: 'ID', title: 'String', body: 'String' }),
  CloseIssueInput: inputType({ issueId: 'ID' }),
  CreatePullRequestInput: inputType({
    repositoryId: 'ID',
    baseRefName: 'String',
    headRefName: 'String',
    title: 'String',
    body: 'String',
  }),
  MergePullRequestInput: inputType({ pullRequestId: 'ID', mergeMethod: 'String' }),
  AddCommentInput: inputType({ subjectId: 'ID', body: 'String' }),
  IssueOrder: inputType({ field: 'IssueOrderField', direction: 'OrderDirection' }),
});

/** The fields of a type, or undefined when the type is unknown. */
export function fieldsOf(typeName: string): Readonly<Record<string, SchemaField>> | undefined {
  return SCHEMA[typeName]?.fields;
}

/** Whether `typeName` is an object type the executor can resolve fields on. */
export function isObjectLike(typeName: string): boolean {
  const type = SCHEMA[typeName];
  return type !== undefined && (type.kind === 'OBJECT' || type.kind === 'INTERFACE');
}

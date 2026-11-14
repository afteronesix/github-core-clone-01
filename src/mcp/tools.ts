// MCP tools: the six github-mcp-server tools the suite requires, over the
// shared ForgeStore. The tool list is a FROZEN constant built once at module
// load — two tools/list answers must be byte-identical.
//
// Argument contract (the rules' documented shapes; `required` holds ONLY
// properties the suite can fill — a required property it cannot fill fails
// the check with the property named):
//   create_repo         {name, description?, private?}
//   get_repo            {owner, repo}
//   create_issue        {owner, repo, title, body?}
//   list_issues         {owner, repo, state?}
//   create_pull_request {owner, repo, title, head, base, body?}
//   merge_pull_request  {owner, repo, pull_number}
//
// A tool answers {content: [{type: "text", text: <JSON string>}],
// structuredContent: <object>} — the checks read the title/number from either.
// Domain failures (unknown repo, duplicate, conflict) are tool execution
// errors (isError: true); missing/invalid arguments are JSON-RPC -32602,
// raised by the dispatcher before the tool runs.

import type { ForgeStore, RepoRecord } from '../store/store.ts';
import { issueView, insertIssue } from '../rest/issues.ts';
import { pullView, insertPull, squashMergePull } from '../rest/pulls.ts';
import { repoView } from '../rest/repos.ts';
import { HttpError } from '../http/server.ts';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
  isError?: boolean;
}

function stringProperty(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

const OWNER_PROPERTY = stringProperty('The repository owner (the token user login).');
const REPO_PROPERTY = stringProperty('The repository name.');

/** The six tools, frozen: tools/list serializes this exact array every time. */
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository under the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: stringProperty('The repository name.'),
        description: stringProperty('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ owner: OWNER_PROPERTY, repo: REPO_PROPERTY }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: OWNER_PROPERTY,
        repo: REPO_PROPERTY,
        title: stringProperty('The issue title.'),
        body: stringProperty('The issue body.'),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: OWNER_PROPERTY,
        repo: REPO_PROPERTY,
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: OWNER_PROPERTY,
        repo: REPO_PROPERTY,
        title: stringProperty('The pull request title.'),
        head: stringProperty('The head branch name.'),
        base: stringProperty('The base branch name.'),
        body: stringProperty('The pull request body.'),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: OWNER_PROPERTY,
        repo: REPO_PROPERTY,
        pull_number: { type: 'integer', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** The tool definition by name, or undefined. */
export function mcpToolNamed(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

function toolResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new McpInvalidParams(`Missing required argument: ${key}`);
  }
  return value;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new McpInvalidParams(`Missing or invalid required argument: ${key}`);
}

/** A tools/call argument failure: the dispatcher answers JSON-RPC -32602. */
export class McpInvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpInvalidParams';
  }
}

function requireRepo(store: ForgeStore, owner: string, repo: string): RepoRecord | McpToolResult {
  const record = store.getRepo(owner, repo);
  if (!record) return toolError(`Not Found: repository ${owner}/${repo} does not exist`);
  return record;
}

function isToolError(value: RepoRecord | McpToolResult): value is McpToolResult {
  return 'content' in value;
}

/** Run one tool by name. Throws McpInvalidParams on missing/invalid arguments. */
export function callMcpTool(store: ForgeStore, name: string, args: Record<string, unknown>): McpToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = store.createRepo(repoName, { description, private: isPrivate });
      if (!repo) return toolError(`Validation Failed: repository ${repoName} already exists`);
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const repo = requireRepo(store, owner, repoName);
      if (isToolError(repo)) return repo;
      return toolResult(repoView(repo));
    }
    case 'create_issue': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const title = requireString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      const repo = requireRepo(store, owner, repoName);
      if (isToolError(repo)) return repo;
      const issue = insertIssue(store, repo, { title, body });
      return toolResult(issueView(store, repo, issue));
    }
    case 'list_issues': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const repo = requireRepo(store, owner, repoName);
      if (isToolError(repo)) return repo;
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      const views = issues.map((issue) => issueView(store, repo, issue));
      return { content: [{ type: 'text', text: JSON.stringify(views) }], structuredContent: { issues: views } };
    }
    case 'create_pull_request': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      const body = typeof args.body === 'string' ? args.body : '';
      const repo = requireRepo(store, owner, repoName);
      if (isToolError(repo)) return repo;
      try {
        const pull = insertPull(store, repo, { title, body, head, base });
        return toolResult(pullView(store, repo, pull));
      } catch (err) {
        if (err instanceof HttpError) return toolError(err.message);
        throw err;
      }
    }
    case 'merge_pull_request': {
      const owner = requireString(args, 'owner');
      const repoName = requireString(args, 'repo');
      const pullNumber = requireNumber(args, 'pull_number');
      const repo = requireRepo(store, owner, repoName);
      if (isToolError(repo)) return repo;
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return toolError(`Not Found: pull request #${pullNumber} does not exist`);
      try {
        const mergeSha = squashMergePull(store, repo, pull);
        return toolResult({ ...pullView(store, repo, pull), sha: mergeSha });
      } catch (err) {
        if (err instanceof HttpError) return toolError(err.message);
        throw err;
      }
    }
    default:
      throw new McpInvalidParams(`Unknown tool: ${name}`);
  }
}

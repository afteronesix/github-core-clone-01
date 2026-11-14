# github-core-clone-01 — a standalone GitHub-compatible git forge

One process, one repository, no dependencies: a git forge serving **git smart HTTP**
(upload-pack v2 + v0, receive-pack v0), **REST v3** (`/api/v3`), **GraphQL v4**
(`/api/graphql`) and **MCP** (`/mcp`) from a single in-memory store. Written for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node main.ts            # Node 22.18+ (type stripping is built in)
```

`MAKEFUN_ENV_URL` names the env to register with; `MAKEFUN_SHOP_TOKEN` is the bearer
token every API call must present (when unset, auth is disabled — the local-dev mode).
The server binds an ephemeral port, registers it with the env, and exits 0 when the env
says the trial is done. `/healthz` answers `200 {"ok":true}` without auth.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — `createApp()`: wires the HTTP server, the store and the four surfaces.
- `src/store/` — the single source of truth: repos, git objects, refs, issues, PRs,
  labels, comments, sequential ids, the deterministic clock, and the scenario viewer
  login recomputed from the contest's fixed seed.
- `src/git/` — pkt-line codec, packfile read/write (OFS/REF delta resolution), object
  model (SHA-1, commit/tree/tag builders), ref store + fast-forward rules, upload-pack
  (v2 ls-refs/fetch with shallow/deepen, v0 fallback), receive-pack (unpack + report-status),
  and the three-way diff/merge engine shared by REST, GraphQL and MCP.
- `src/rest/` — the REST v3 router: repos, branches, commits, git/refs, contents
  (real git commits), issues, comments, labels, pull requests, files, squash merge.
- `src/graphql/` — a hand-rolled GraphQL lexer/parser/executor for the fixed schema
  surface: viewer, repository, issue/pull-request connections with cursor pagination,
  `node(id:)`, `__type` introspection, and the five mutations.
- `src/mcp/` — JSON-RPC 2.0 over Streamable HTTP: `server/discover` (2026-07-28),
  legacy `initialize`, `tools/list` and `tools/call` for the six github-mcp-server tools.
- `src/http/` — server wiring: body reading with a size cap, JSON parse errors,
  the request-id header, and the bearer-token gate.

## Design notes

- **Objects are stored verbatim.** Pushed objects round-trip byte-exactly; the server
  never re-serializes an object it holds.
- **One store, four views.** A commit made over REST contents is visible to git clone,
  a GraphQL mutation is visible over REST, and an MCP-created issue is the same object
  over REST — because every surface reads and writes the same `ForgeStore`.
- **Deterministic.** All server-created timestamps come from a fixed epoch plus a
  monotonic counter; all ids are sequential counters; no `Date.now()` or `Math.random()`
  anywhere in a response path. Two runs over the same requests produce the same bytes.
- **Stdlib only.** `node:http`, `node:crypto` (SHA-1), `node:zlib` (deflate/inflate),
  global `fetch`. No package manager, no git binary, nothing vendored.

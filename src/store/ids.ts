// Global (Relay) ids for GraphQL: opaque, stable, decodable. The scheme is
// base64url("<kind>:<stable key>") — never the plain database id or number, which
// the global-id-stability check forbids.

/** Encode an opaque global id from a kind and a stable key. */
export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id into its kind and key, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id === '' || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const kind = text.slice(0, colon);
  const key = text.slice(colon + 1);
  if (key === '') return null;
  if (kind !== 'repo' && kind !== 'issue' && kind !== 'pull' && kind !== 'comment') return null;
  // Re-encoding must reproduce the id exactly (guards against lax base64url padding).
  if (encodeGlobalId(kind, key) !== id) return null;
  return { kind, key };
}

/** A repository's global id: `repo:<owner>/<name>`. */
export function repoGlobalId(owner: string, name: string): string {
  return encodeGlobalId('repo', `${owner}/${name}`);
}

/** An issue's global id: `issue:<owner>/<repo>:<number>`. */
export function issueGlobalId(owner: string, name: string, number: number): string {
  return encodeGlobalId('issue', `${owner}/${name}:${number}`);
}

/** A pull request's global id: `pull:<owner>/<repo>:<number>`. */
export function pullGlobalId(owner: string, name: string, number: number): string {
  return encodeGlobalId('pull', `${owner}/${name}:${number}`);
}

/** A comment's global id: `comment:<owner>/<repo>:<issueNumber>:<commentId>`. */
export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return encodeGlobalId('comment', `${owner}/${name}:${issueNumber}:${commentId}`);
}

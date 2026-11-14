// The bearer-token gate. The suite presents MAKEFUN_SHOP_TOKEN on every
// request (git, REST, GraphQL, MCP); a missing or wrong token is a 401 on
// every route except /healthz. When the env var is unset or empty, auth is
// disabled — that mirrors the env's own logic (`env[TOKEN_ENV] ?? ''`).

export interface AuthGate {
  /** True when the request's Authorization header names the shop token. */
  readonly isAuthorized: (req: { headers: { authorization?: string | string[] } }) => boolean;
  /** True when auth is disabled (no token configured). */
  readonly disabled: boolean;
}

export function createAuthGate(token: string | undefined): AuthGate {
  const expected = (token ?? '').trim();
  const disabled = expected === '';
  return {
    disabled,
    isAuthorized(req) {
      if (disabled) return true;
      const header = req.headers.authorization;
      if (typeof header !== 'string') return false;
      return header === `Bearer ${expected}`;
    },
  };
}

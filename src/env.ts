// Worker bindings. Secrets are set with `wrangler secret put`, never committed.
export interface Env {
  STORE: KVNamespace;

  // Which app manifest this deployment serves.
  APP: string;
  // Canonical resource URI of this MCP server (RFC 8707), no trailing slash.
  RESOURCE: string;
  FIREBASE_PROJECT_ID: string;

  // Google OAuth web client used to identify the user upstream.
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // Firebase Web API key, used against identitytoolkit and securetoken.
  FIREBASE_API_KEY: string;
  // HS256 key this server signs its own access tokens with.
  TOKEN_SIGNING_KEY: string;
}

// The issuer this server uses for its own tokens and metadata: the origin the
// request arrived on, so a preview deployment stays self-consistent.
export function issuerOf(request: Request): string {
  return new URL(request.url).origin;
}

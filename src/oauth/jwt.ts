// Access tokens this server issues for itself. HS256 because the resource
// server and the authorization server are the same Worker, so there is no
// second party that needs a public key.
import { b64url, b64urlDecode, timingSafeEqual } from '../util.js';

export interface AccessClaims {
  iss: string;
  sub: string; // Firebase uid
  aud: string; // canonical resource URI (RFC 8707)
  scope: string;
  client_id: string;
  gid: string; // grant id, the KV key holding the upstream Firebase session
  exp: number;
  iat: number;
  jti: string;
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signAccessToken(
  claims: AccessClaims,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'at+jwt' })));
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const body = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body));
  return `${body}.${b64url(sig)}`;
}

// Returns the claims, or null for any token this server did not issue, that
// has expired, or that names a different audience.
export async function verifyAccessToken(
  token: string,
  secret: string,
  expected: { issuer: string; audience: string; now?: number },
): Promise<AccessClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expectedSig = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!timingSafeEqual(sig, b64url(expectedSig))) return null;

  let claims: AccessClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== expected.issuer) return null;
  // Audience binding: a token minted for another MCP server is not accepted
  // here, which is what stops a confused-deputy token replay.
  if (claims.aud !== expected.audience) return null;
  if (!claims.exp || claims.exp <= now) return null;
  return claims;
}

export function hasScope(claims: AccessClaims, scope: string): boolean {
  return claims.scope.split(' ').includes(scope);
}

import { describe, expect, it } from 'vitest';
import { hasScope, signAccessToken, verifyAccessToken, type AccessClaims } from '../src/oauth/jwt.js';

const SECRET = 'test-signing-key';
const ISSUER = 'https://mcp.example.com';
const AUDIENCE = 'https://mcp.example.com/mcp';

function claims(overrides: Partial<AccessClaims> = {}): AccessClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: 'uid-1',
    aud: AUDIENCE,
    scope: 'spectrum:read',
    client_id: 'client-1',
    gid: 'grant-1',
    iat: now,
    exp: now + 3600,
    jti: 'jti-1',
    ...overrides,
  };
}

describe('access tokens', () => {
  it('round-trips a token this server signed', async () => {
    const token = await signAccessToken(claims(), SECRET);
    const verified = await verifyAccessToken(token, SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(verified?.sub).toBe('uid-1');
  });

  it('rejects a token signed with another key', async () => {
    const token = await signAccessToken(claims(), 'someone-elses-key');
    expect(
      await verifyAccessToken(token, SECRET, { issuer: ISSUER, audience: AUDIENCE }),
    ).toBeNull();
  });

  it('rejects a token minted for a different MCP server', async () => {
    const token = await signAccessToken(claims({ aud: 'https://other.example.com/mcp' }), SECRET);
    expect(
      await verifyAccessToken(token, SECRET, { issuer: ISSUER, audience: AUDIENCE }),
    ).toBeNull();
  });

  it('rejects a token from a different issuer', async () => {
    const token = await signAccessToken(claims({ iss: 'https://evil.example.com' }), SECRET);
    expect(
      await verifyAccessToken(token, SECRET, { issuer: ISSUER, audience: AUDIENCE }),
    ).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signAccessToken(claims({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
    expect(
      await verifyAccessToken(token, SECRET, { issuer: ISSUER, audience: AUDIENCE }),
    ).toBeNull();
  });

  it('reads scopes out of the space-delimited claim', () => {
    const value = claims({ scope: 'spectrum:read spectrum:write' });
    expect(hasScope(value, 'spectrum:write')).toBe(true);
    expect(hasScope(value, 'spectrum:admin')).toBe(false);
  });
});

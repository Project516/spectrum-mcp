import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserHash, browserMatches, pkceMatches, sameResource } from '../src/oauth/authorize.js';
import { isMetadataDocumentClientId, redirectUriAllowed, resolveClient } from '../src/oauth/clients.js';
import { wwwAuthenticate } from '../src/oauth/metadata.js';
import type { ClientRecord, Store } from '../src/oauth/store.js';
import { browserCookieName, readCookie } from '../src/util.js';

describe('PKCE', () => {
  it('accepts the verifier its challenge was derived from', async () => {
    // S256 pair from RFC 7636 appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await pkceMatches(verifier, challenge)).toBe(true);
    expect(await pkceMatches('wrong-verifier', challenge)).toBe(false);
  });
});

describe('resource indicators', () => {
  it('treats a trailing slash and host case as the same resource', () => {
    expect(sameResource('https://MCP.example.com/mcp/', 'https://mcp.example.com/mcp')).toBe(true);
  });

  it('does not treat another server as the same resource', () => {
    expect(sameResource('https://other.example.com/mcp', 'https://mcp.example.com/mcp')).toBe(false);
  });
});

describe('client id metadata documents', () => {
  it('accepts an https URL with a path', () => {
    expect(isMetadataDocumentClientId('https://app.example.com/client.json')).toBe(true);
  });

  it('rejects a bare origin, a non-https URL, and a plain identifier', () => {
    expect(isMetadataDocumentClientId('https://app.example.com')).toBe(false);
    expect(isMetadataDocumentClientId('http://app.example.com/client.json')).toBe(false);
    expect(isMetadataDocumentClientId('spectrum-abc123')).toBe(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches with redirect: manual, not error', async () => {
    // workerd only implements "follow" and "manual"; "error" throws a
    // TypeError at request time on every call (caught only by an actual
    // Workers runtime, not Node's fetch, which is why this needs asserting
    // directly rather than trusting a passing test suite).
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await resolveClient('https://app.example.com/client.json', {} as Store);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.example.com/client.json',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('refuses a client id metadata document fetch that redirects', async () => {
    // A followed-manually redirect comes back opaque: ok false, status 0,
    // no readable body. `!res.ok` alone has to be enough to refuse it.
    const opaqueRedirect = { ok: false, status: 0 } as Response;
    vi.stubGlobal('fetch', vi.fn(async () => opaqueRedirect));
    expect(await resolveClient('https://app.example.com/client.json', {} as Store)).toBeNull();
  });
});

describe('challenge header', () => {
  it('points at the path-qualified protected resource metadata', () => {
    const header = wwwAuthenticate('https://mcp.example.com');
    expect(header).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(header).toContain('scope="spectrum:read"');
  });

  it('names the missing scope on a step-up challenge', () => {
    const header = wwwAuthenticate('https://mcp.example.com', {
      error: 'insufficient_scope',
      scope: 'spectrum:read spectrum:write',
    });
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="spectrum:read spectrum:write"');
  });
});

describe('browser binding', () => {
  const stateKey = 'abc123';
  const withCookie = (cookie: string) =>
    new Request('https://mcp.example.com/authorize/consent', { headers: { cookie } });

  it('accepts the browser that started the request', async () => {
    const secret = 'browser-secret';
    const pending = { browser_hash: await browserHash(secret) };
    const request = withCookie(`${browserCookieName(stateKey)}=${secret}`);
    expect(await browserMatches(request, stateKey, pending)).toBe(true);
  });

  it('refuses a browser that never started it, even knowing the state key', async () => {
    const pending = { browser_hash: await browserHash('browser-secret') };
    const noCookie = new Request('https://mcp.example.com/authorize/consent');
    expect(await browserMatches(noCookie, stateKey, pending)).toBe(false);
    const wrong = withCookie(`${browserCookieName(stateKey)}=someone-elses-secret`);
    expect(await browserMatches(wrong, stateKey, pending)).toBe(false);
  });

  it('keeps concurrent flows in one browser apart', async () => {
    const pending = { browser_hash: await browserHash('secret-for-first-flow') };
    const other = withCookie(`${browserCookieName('other-state')}=secret-for-first-flow`);
    expect(await browserMatches(other, stateKey, pending)).toBe(false);
  });
});

describe('redirect_uri matching', () => {
  const client: ClientRecord = {
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
  };

  it('allows a loopback redirect_uri whose port differs from the registered one', () => {
    // RFC 8252 SS7.3: a native client cannot know its listener's port until it
    // binds, so the port is excluded from the comparison for loopback hosts.
    // Claude Code's CIMD registers "http://localhost/callback" and actually
    // redirects to "http://localhost:3118/callback".
    expect(redirectUriAllowed(client, 'http://localhost:3118/callback')).toBe(true);
    expect(redirectUriAllowed(client, 'http://127.0.0.1:54321/callback')).toBe(true);
  });

  it('still requires an exact match on host, path, and scheme', () => {
    expect(redirectUriAllowed(client, 'http://localhost:3118/other')).toBe(false);
    expect(redirectUriAllowed(client, 'https://localhost:3118/callback')).toBe(false);
    expect(redirectUriAllowed(client, 'http://evil.example.com:3118/callback')).toBe(false);
  });

  it('rejects a non-loopback redirect_uri outright', () => {
    const hosted: ClientRecord = { ...client, redirect_uris: ['https://app.example.com/callback'] };
    expect(redirectUriAllowed(hosted, 'https://app.example.com:8443/callback')).toBe(false);
  });
});

describe('cookie parsing', () => {
  it('reads one cookie out of several, ignoring surrounding space', () => {
    const request = new Request('https://mcp.example.com/', {
      headers: { cookie: 'a=1; smcp_xyz=value-here ; b=2' },
    });
    expect(readCookie(request, 'smcp_xyz')).toBe('value-here');
    expect(readCookie(request, 'smcp_missing')).toBe(null);
  });
});

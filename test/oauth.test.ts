import { describe, expect, it } from 'vitest';
import { pkceMatches, sameResource } from '../src/oauth/authorize.js';
import { isMetadataDocumentClientId } from '../src/oauth/clients.js';
import { wwwAuthenticate } from '../src/oauth/metadata.js';

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

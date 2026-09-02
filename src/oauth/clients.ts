// Client resolution. Two mechanisms, in the priority the 2026-07-28 spec sets:
// an HTTPS Client ID Metadata Document (preferred), or a client registered
// through the deprecated RFC 7591 endpoint and kept in KV.
import type { ClientRecord, Store } from './store.js';

const MAX_METADATA_BYTES = 32 * 1024;

export function isMetadataDocumentClientId(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  // The draft requires the https scheme and a path component, which is what
  // separates a document URL from a bare origin.
  return url.protocol === 'https:' && url.pathname !== '/' && url.pathname !== '';
}

async function fetchMetadataDocument(clientId: string): Promise<ClientRecord | null> {
  const res = await fetch(clientId, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return null;
  const body = await res.text();
  if (body.length > MAX_METADATA_BYTES) return null;

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  // The document must claim exactly the URL it was fetched from, otherwise a
  // client could point at someone else's document and borrow its identity.
  if (doc.client_id !== clientId) return null;
  if (typeof doc.client_name !== 'string') return null;
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return null;
  if (!redirectUris.every((uri) => typeof uri === 'string')) return null;

  return {
    client_id: clientId,
    client_name: doc.client_name,
    redirect_uris: redirectUris as string[],
    // A self-hosted document carries no secret this server ever learns.
    token_endpoint_auth_method: 'none',
    grant_types: (doc.grant_types as string[]) ?? ['authorization_code', 'refresh_token'],
    scope: typeof doc.scope === 'string' ? doc.scope : undefined,
  };
}

export async function resolveClient(
  clientId: string,
  store: Store,
): Promise<ClientRecord | null> {
  if (isMetadataDocumentClientId(clientId)) return fetchMetadataDocument(clientId);
  return store.getClient(clientId);
}

export function redirectUriAllowed(client: ClientRecord, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

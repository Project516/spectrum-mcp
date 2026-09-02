// POST /register -- RFC 7591 dynamic client registration. Deprecated by the
// 2026-07-28 spec in favour of Client ID Metadata Documents, and kept only so
// clients that predate that still work.
import { json, oauthError, randomToken } from '../util.js';
import type { ClientRecord, Store } from './store.js';

export async function handleRegister(request: Request, store: Store): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthError('invalid_client_metadata', 'body must be JSON');
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError('invalid_redirect_uri', 'redirect_uris is required');
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAllowedRedirect(uri)) {
      return oauthError(
        'invalid_redirect_uri',
        'redirect URIs must be https, or http on a loopback address',
      );
    }
  }

  // Public clients only: a registration nobody authenticated cannot be trusted
  // with a secret, and PKCE is what actually protects the code.
  const record: ClientRecord = {
    client_id: `spectrum-${randomToken(12)}`,
    client_name: typeof body.client_name === 'string' ? body.client_name : 'Unnamed MCP client',
    redirect_uris: redirectUris as string[],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  };
  await store.putClient(record);
  return json({ ...record, client_id_issued_at: Math.floor(Date.now() / 1000) }, { status: 201 });
}

function isAllowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost')
  );
}

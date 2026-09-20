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
        'redirect URIs must be https, http on a loopback address, or a ' +
          'private-use scheme naming a domain the app controls',
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

// RFC 8252 gives a native app two ways home, and an iPhone can only use one
// of them. SS7.3's loopback listener is a desktop pattern; SS7.1's private-use
// scheme is what an app registers with the OS and hands to
// ASWebAuthenticationSession. Allowing only the first locked every iOS client
// out of registration (SpectrumStrategy#1642).
//
// The scheme has to be reverse-DNS, so it names a domain its owner controls
// and the OS can arbitrate who claims it. A single-label scheme like "myapp:"
// is what SS7.1 warns against, because anything can claim it.
export function isAllowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    return (
      url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
    );
  }
  return isPrivateUseScheme(url.protocol);
}

// A reverse-DNS scheme: two or more DNS labels, each non-empty and neither
// starting nor ending with a hyphen, the first starting with a letter because
// RFC 3986 bounds a scheme to ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
//
// Checking only for a dot is not enough: `org..spectrum` and `org.spectrum-`
// both contain one and neither names a domain anyone can own, so neither is
// something the OS can arbitrate a claim over.
const REVERSE_DNS_SCHEME = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// `protocol` arrives with its trailing colon.
function isPrivateUseScheme(protocol: string): boolean {
  return REVERSE_DNS_SCHEME.test(protocol.slice(0, -1));
}

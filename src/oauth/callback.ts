// GET /callback -- Google is done with the user. Trade its code for an ID
// token, trade that for a Firebase session, and hand the MCP client an
// authorization code of this server's own.
import type { Env } from '../env.js';
import { signInWithGoogle } from '../firebase.js';
import { oauthError, randomToken } from '../util.js';
import { browserMatches, expireBrowserCookie, googleRedirectUri } from './authorize.js';
import type { Store } from './store.js';

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export async function handleCallback(
  request: Request,
  env: Env,
  store: Store,
  issuer: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const stateKey = params.get('state');
  if (!stateKey) return oauthError('invalid_request', 'missing state');

  const pending = await store.takePendingAuth(stateKey);
  if (!pending) return oauthError('invalid_request', 'this authorization request expired');
  // Same browser as the one that consented, or nothing is minted.
  if (!(await browserMatches(request, stateKey, pending))) {
    return oauthError('invalid_request', 'this authorization request was started elsewhere');
  }

  const redirect = (extra: Record<string, string>) => {
    const url = new URL(pending.redirect_uri);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    // RFC 9207: the client compares this against the issuer it discovered,
    // which is what stops an authorization response from another server being
    // replayed into this flow.
    url.searchParams.set('iss', issuer);
    if (pending.state) url.searchParams.set('state', pending.state);
    return new Response(null, {
      status: 302,
      headers: {
        location: url.toString(),
        'set-cookie': expireBrowserCookie(stateKey, issuer),
      },
    });
  };

  const googleError = params.get('error');
  if (googleError) {
    return redirect({ error: 'access_denied', error_description: googleError });
  }
  const googleCode = params.get('code');
  if (!googleCode) return redirect({ error: 'invalid_request', error_description: 'no code' });

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: googleCode,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(issuer),
      grant_type: 'authorization_code',
    }),
  });
  const tokenBody = (await tokenRes.json()) as { id_token?: string };
  if (!tokenRes.ok || !tokenBody.id_token) {
    return redirect({ error: 'server_error', error_description: 'Google rejected the code' });
  }

  let session;
  try {
    session = await signInWithGoogle(env, tokenBody.id_token, issuer);
  } catch {
    return redirect({
      error: 'access_denied',
      error_description: 'this Google account has no Firebase identity for this app',
    });
  }

  const code = randomToken();
  await store.putAuthCode(code, {
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    scope: pending.scope,
    resource: pending.resource,
    uid: session.uid,
    email: session.email ?? undefined,
    firebase_refresh_token: session.refreshToken,
    expires_at: Date.now() + 10 * 60 * 1000,
  });
  return redirect({ code });
}

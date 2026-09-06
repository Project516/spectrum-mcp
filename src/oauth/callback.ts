// GET /callback -- Google is done with the user. Trade its code for an ID
// token, trade that for a Firebase session, and hand the MCP client an
// authorization code of this server's own.
import { handleManageCallback } from '../apikeys.js';
import type { Env } from '../env.js';
import { signInWithGoogle } from '../firebase.js';
import { oauthError, randomToken } from '../util.js';
import { browserMatches, expireBrowserCookie } from './authorize.js';
import { exchangeGoogleCode } from './google.js';
import type { Store } from './store.js';

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
  if (!pending) {
    // The same callback serves the API key management sign-in, which has no
    // OAuth client and no redirect to send a code back to.
    const manage = await store.takePendingManage(stateKey);
    if (manage) return handleManageCallback(request, env, store, issuer, stateKey, manage);
    return oauthError('invalid_request', 'this authorization request expired');
  }
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

  const idToken = await exchangeGoogleCode(env, issuer, googleCode);
  if (!idToken) {
    return redirect({ error: 'server_error', error_description: 'Google rejected the code' });
  }

  let session;
  try {
    session = await signInWithGoogle(env, idToken, issuer);
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

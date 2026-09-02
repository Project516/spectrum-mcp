// GET /authorize -- validate the client, then hand the user to Google to prove
// who they are. This server never sees a password; it only learns the Google
// ID token Google hands back, which it trades for a Firebase session.
import type { Env } from '../env.js';
import {
  b64url,
  browserCookieName,
  oauthError,
  randomToken,
  readCookie,
  sha256,
  timingSafeEqual,
} from '../util.js';
import { redirectUriAllowed, resolveClient } from './clients.js';
import { DEFAULT_SCOPES, SCOPES } from './metadata.js';
import type { Store } from './store.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

export function googleRedirectUri(issuer: string): string {
  return `${issuer}/callback`;
}

export async function handleAuthorize(
  request: Request,
  env: Env,
  store: Store,
  issuer: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  if (!clientId || !redirectUri) {
    return oauthError('invalid_request', 'client_id and redirect_uri are required');
  }

  const client = await resolveClient(clientId, store);
  if (!client) return oauthError('invalid_client', 'unknown client_id', 401);
  // Until the redirect URI is known good, an error must not be redirected
  // anywhere: that is the open-redirect rule.
  if (!redirectUriAllowed(client, redirectUri)) {
    return oauthError('invalid_request', 'redirect_uri is not registered for this client');
  }

  const fail = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    url.searchParams.set('iss', issuer);
    const state = params.get('state');
    if (state) url.searchParams.set('state', state);
    return Response.redirect(url.toString(), 302);
  };

  if (params.get('response_type') !== 'code') {
    return fail('unsupported_response_type', 'only the authorization code flow is supported');
  }
  const codeChallenge = params.get('code_challenge');
  if (!codeChallenge || params.get('code_challenge_method') !== 'S256') {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  // RFC 8707: the token must be bound to this server and no other, so a
  // resource naming something else is refused rather than quietly ignored.
  const resource = params.get('resource');
  if (resource && !sameResource(resource, env.RESOURCE)) {
    return fail('invalid_target', `this server only issues tokens for ${env.RESOURCE}`);
  }

  const requested = (params.get('scope') ?? DEFAULT_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  const unknown = requested.filter((s) => !SCOPES.includes(s as (typeof SCOPES)[number]));
  if (unknown.length > 0) return fail('invalid_scope', `unknown scope: ${unknown.join(' ')}`);

  const stateKey = randomToken();
  // The browser that starts the flow is the only one allowed to finish it.
  // Without this, an attacker who calls /authorize with their own PKCE
  // challenge could send a victim the resulting consent link and receive a
  // code minted for the victim's account: PKCE does not defend against that,
  // because the attacker holds the verifier.
  const browserSecret = randomToken();
  await store.putPendingAuth(stateKey, {
    client_id: clientId,
    redirect_uri: redirectUri,
    state: params.get('state') ?? undefined,
    code_challenge: codeChallenge,
    scope: requested.join(' '),
    resource: env.RESOURCE,
    browser_hash: await browserHash(browserSecret),
  });

  const page = consentPage(client.client_name ?? clientId, clientId, requested, stateKey, env);
  page.headers.append('set-cookie', browserCookie(stateKey, browserSecret, issuer));
  return page;
}

export async function browserHash(secret: string): Promise<string> {
  return b64url(await sha256(secret));
}

// SameSite=Lax so the cookie still rides the top-level GET Google redirects
// back to, but no cross-site POST can drive the consent step.
function browserCookie(stateKey: string, secret: string, issuer: string): string {
  const secure = issuer.startsWith('https:') ? '; Secure' : '';
  return `${browserCookieName(stateKey)}=${secret}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secure}`;
}

export function expireBrowserCookie(stateKey: string, issuer: string): string {
  const secure = issuer.startsWith('https:') ? '; Secure' : '';
  return `${browserCookieName(stateKey)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

// Every leg after /authorize proves it is the same browser.
export async function browserMatches(
  request: Request,
  stateKey: string,
  pending: { browser_hash: string },
): Promise<boolean> {
  const presented = readCookie(request, browserCookieName(stateKey));
  if (!presented) return false;
  return timingSafeEqual(await browserHash(presented), pending.browser_hash);
}

// The confused-deputy mitigation: this server is an OAuth client of Google, so
// a user with a live Google session could be walked through the whole flow
// without ever seeing which MCP client was asking. The interstitial names the
// client and the scopes before anything is forwarded upstream.
function consentPage(
  clientName: string,
  clientId: string,
  scopes: string[],
  stateKey: string,
  env: Env,
): Response {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escape(clientName)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; }
  code { background: #f2f2f5; padding: 0.1rem 0.3rem; border-radius: 4px; word-break: break-all; }
  ul { padding-left: 1.2rem; }
  button { font: inherit; padding: 0.6rem 1.2rem; border-radius: 4px; border: 0; background: #3C0060; color: #fff; cursor: pointer; }
</style></head><body>
<h1>Authorize ${escape(clientName)}</h1>
<p><code>${escape(clientId)}</code> is asking to use the <strong>${escape(env.APP)}</strong> database as you.
It will be able to do exactly what your account can do in the app, and nothing more.</p>
<p>Requested access:</p>
<ul>${scopes.map((s) => `<li><code>${escape(s)}</code></li>`).join('')}</ul>
<p>Continue to sign in with Google. If you did not start this, close this page.</p>
<form method="post" action="/authorize/consent">
  <input type="hidden" name="request" value="${escape(stateKey)}">
  <button type="submit">Continue with Google</button>
</form>
</body></html>`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// POST /authorize/consent -- the user said yes, so forward to Google.
export async function handleConsent(
  request: Request,
  env: Env,
  store: Store,
  issuer: string,
): Promise<Response> {
  const form = await request.formData();
  const stateKey = String(form.get('request') ?? '');
  // Read without consuming: the callback still needs this record.
  const pending = stateKey ? await store.getPendingAuth(stateKey) : null;
  if (!pending) {
    return oauthError('invalid_request', 'this authorization request expired, start again');
  }
  if (!(await browserMatches(request, stateKey, pending))) {
    await store.takePendingAuth(stateKey);
    return oauthError(
      'invalid_request',
      'this authorization request was started in a different browser, start again',
    );
  }

  const google = new URL(GOOGLE_AUTH);
  google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  google.searchParams.set('redirect_uri', googleRedirectUri(issuer));
  google.searchParams.set('response_type', 'code');
  google.searchParams.set('scope', 'openid email profile');
  google.searchParams.set('state', stateKey);
  // Always show the account chooser: a strategy laptop is a shared machine and
  // silently reusing whoever signed in last would hand an agent the wrong
  // person's permissions.
  google.searchParams.set('prompt', 'select_account');
  return Response.redirect(google.toString(), 302);
}

// Compare the resource indicator without letting a trailing slash or a
// different case in the host defeat the check.
export function sameResource(a: string, b: string): boolean {
  const normalize = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`.toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  };
  return normalize(a) === normalize(b);
}

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  return b64url(await sha256(verifier)) === challenge;
}

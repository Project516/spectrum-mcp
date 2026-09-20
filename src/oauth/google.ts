// This server's own client relationship with Google. Both sign-in legs use it:
// the OAuth authorization flow in authorize.ts/callback.ts, and the API key
// management sign-in in apikeys.ts. It lives apart from either so neither has
// to import the other.
import type { Env } from '../env.js';

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

export function googleRedirectUri(issuer: string): string {
  return `${issuer}/callback`;
}

// Where to send a browser to prove who it is. `prompt=select_account` is
// deliberate: a strategy laptop is a shared machine, and silently reusing
// whoever signed in last would hand out the wrong person's permissions.
export function googleAuthUrl(env: Env, issuer: string, stateKey: string): URL {
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', googleRedirectUri(issuer));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', stateKey);
  url.searchParams.set('prompt', 'select_account');
  return url;
}

// Trade Google's authorization code for the ID token that identifies the user.
// Returns null for anything Google refuses; the caller decides how to report
// it, since the OAuth leg redirects the error and the key page renders it.
export async function exchangeGoogleCode(
  env: Env,
  issuer: string,
  code: string,
): Promise<string | null> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(issuer),
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json()) as { id_token?: string };
  return res.ok && body.id_token ? body.id_token : null;
}

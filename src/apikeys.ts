// API keys: a headless caller's way in, for the scripts and dashboards that
// cannot run an interactive OAuth flow (SpectrumStrategy #1499).
//
// A key is not a second authorization model. It is a handle on exactly the
// same thing an OAuth grant holds -- one person's Firebase refresh token --
// so every request a key makes carries that person's ID token and
// `firestore.rules` answers it exactly as it answers the app. Issuing one
// therefore requires signing in with Google first: a key can never hold access
// its owner did not already have.
import type { Env } from './env.js';
import { Firestore, FirestoreDenied, freshIdToken, signInWithGoogle } from './firebase.js';
import { fieldsToJson } from './firestore-values.js';
import {
  browserCookie,
  browserHash,
  browserMatches,
  expireBrowserCookie,
} from './oauth/authorize.js';
import { exchangeGoogleCode, googleAuthUrl } from './oauth/google.js';
import { SCOPES } from './oauth/metadata.js';
import type { ApiKeyIndexEntry, ApiKeyRecord, PendingManage, Store } from './oauth/store.js';
import { b64url, escapeHtml, randomToken, readCookie, sha256, timingSafeEqual } from './util.js';

// Marks a bearer token as an API key rather than one of this server's JWTs, so
// the two never have to be told apart by trying to parse one as the other.
export const API_KEY_PREFIX = 'ssk_';
const SESSION_COOKIE = 'smcp_keys';
const SESSION_TTL = 1800;
const MAX_KEYS_PER_USER = 20;

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

// Only the hash is ever stored, so a dump of the KV namespace hands out no
// working credential and a lost key can be replaced but never recovered.
export async function hashApiKey(key: string): Promise<string> {
  return b64url(await sha256(key));
}

// `app` is the deployment answering the request. A key minted for the other
// one is refused even if both deployments were pointed at a single KV
// namespace, which is what keeps the two apps' data apart.
export async function resolveApiKey(
  store: Store,
  presented: string,
  app: string,
): Promise<ApiKeyRecord | null> {
  if (!looksLikeApiKey(presented)) return null;
  const record = await store.getApiKey(await hashApiKey(presented));
  return record && record.app === app ? record : null;
}

function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(body, { ...init, headers });
}

function seeOther(location: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('location', location);
  return new Response(null, { ...init, status: 303, headers });
}

function sessionCookie(sid: string, issuer: string): string {
  const secure = issuer.startsWith('https:') ? '; Secure' : '';
  // SameSite=Strict, so no cross-site request carries it and the create and
  // revoke posts cannot be driven from another page. Path is the management
  // page alone: this cookie has no business riding a /mcp or /v1 request.
  return `${SESSION_COOKIE}=${sid}; Path=/keys; Max-Age=${SESSION_TTL}; HttpOnly; SameSite=Strict${secure}`;
}

function expireSessionCookie(issuer: string): string {
  const secure = issuer.startsWith('https:') ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/keys; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
}

// Send the user to Google to prove who they are. No consent interstitial here,
// unlike /authorize: there is no third-party client to name. The person is on
// this server's own page asking for their own key.
async function startSignIn(env: Env, store: Store, issuer: string): Promise<Response> {
  const stateKey = randomToken();
  const browserSecret = randomToken();
  await store.putPendingManage(stateKey, { browser_hash: await browserHash(browserSecret) });

  const response = seeOther(googleAuthUrl(env, issuer, stateKey).toString());
  response.headers.append('set-cookie', browserCookie(stateKey, browserSecret, issuer));
  return response;
}

// GET /callback where the state names a management sign-in rather than an
// OAuth authorization. Called from handleCallback once it finds no pending
// OAuth record for the state.
export async function handleManageCallback(
  request: Request,
  env: Env,
  store: Store,
  issuer: string,
  stateKey: string,
  pending: PendingManage,
): Promise<Response> {
  if (!(await browserMatches(request, stateKey, pending))) {
    return html(page('This sign-in was started in a different browser. Start again.', null));
  }
  const params = new URL(request.url).searchParams;
  if (params.get('error') || !params.get('code')) {
    return html(page('Google did not complete the sign-in. Start again.', null));
  }

  const idToken = await exchangeGoogleCode(env, issuer, params.get('code')!);
  if (!idToken) return html(page('Google rejected the sign-in. Start again.', null));

  let session;
  try {
    session = await signInWithGoogle(env, idToken, issuer);
  } catch {
    return html(page('This Google account has no access to this app.', null));
  }

  const sid = randomToken();
  await store.putKeySession(sid, {
    uid: session.uid,
    email: session.email,
    firebase_refresh_token: session.refreshToken,
  });

  const response = seeOther('/keys');
  response.headers.append('set-cookie', expireBrowserCookie(stateKey, issuer));
  response.headers.append('set-cookie', sessionCookie(sid, issuer));
  return response;
}

interface Signed {
  sid: string;
  uid: string;
  email?: string;
  firebase_refresh_token: string;
}

// What the page says about the account before it offers to mint a key
// (SpectrumStrategy#1602). A key acts as its owner, so an owner the app does
// not know produces a key that is refused on every call, and the only place
// that is cheap to notice is here.
//
// This is display, never a decision: the page reports what it found and still
// mints whatever is asked for. Gating on roles would put a second copy of the
// authorization model in this repo, which is the thing this server exists not
// to do.
export interface ProfileStatus {
  kind: 'member' | 'no-roles' | 'no-profile' | 'unreadable';
  roles: string[];
}

export type ProfileLookup = (env: Env, session: Signed) => Promise<ProfileStatus>;

// Reads the caller's own profile as the caller. Rules let somebody read their
// own `userProfiles` document, so this needs no privilege the key would not
// already have.
const lookUpProfile: ProfileLookup = async (env, session) => {
  let idToken: string;
  try {
    idToken = await freshIdToken(env, session.firebase_refresh_token);
  } catch {
    // The session itself is gone, which says nothing about whether a profile
    // exists, so it must not be reported as a missing one.
    return { kind: 'unreadable', roles: [] };
  }

  let doc: { fields?: Record<string, Record<string, unknown>> };
  try {
    doc = (await new Firestore(env.FIREBASE_PROJECT_ID, idToken).getDocument(
      'userProfiles',
      session.uid,
    )) as { fields?: Record<string, Record<string, unknown>> };
  } catch (err) {
    // A 403 is the rules refusing the read; anything else is a missing
    // document, which is the case worth naming because it is exactly what
    // signing in with the wrong Google account looks like.
    return { kind: err instanceof FirestoreDenied ? 'unreadable' : 'no-profile', roles: [] };
  }
  const raw = fieldsToJson(doc.fields ?? {}).roles;
  const roles = Array.isArray(raw) ? raw.map(String) : [];
  return { kind: roles.length > 0 ? 'member' : 'no-roles', roles };
};

async function currentSession(request: Request, store: Store): Promise<Signed | null> {
  const sid = readCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const record = await store.getKeySession(sid);
  return record ? { sid, ...record } : null;
}

// GET /keys, POST /keys/create, POST /keys/revoke, POST /keys/signout.
export async function handleKeys(
  request: Request,
  env: Env,
  store: Store,
  issuer: string,
  lookup: ProfileLookup = lookUpProfile,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const session = await currentSession(request, store);

  if (request.method === 'GET') {
    if (path !== '/keys') return new Response('Not found', { status: 404 });
    if (!session) return startSignIn(env, store, issuer);
    return html(
      page(null, {
        app: env.APP,
        session,
        keys: await store.listApiKeys(session.uid),
        profile: await lookup(env, session),
      }),
    );
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }
  if (!session) return seeOther('/keys');

  const form = await request.formData();
  // Belt and braces with SameSite=Strict: the form echoes the session id, so a
  // post that did not come from a page this server rendered is refused.
  if (!timingSafeEqual(String(form.get('sid') ?? ''), session.sid)) {
    return seeOther('/keys');
  }

  if (path === '/keys/signout') {
    await store.deleteKeySession(session.sid);
    return seeOther('/keys', { headers: { 'set-cookie': expireSessionCookie(issuer) } });
  }

  if (path === '/keys/revoke') {
    const hash = String(form.get('hash') ?? '');
    // Scoped to this owner's index, so a hash belonging to somebody else
    // names nothing to delete.
    const owned = await store.listApiKeys(session.uid);
    if (owned.some((k) => k.hash === hash)) await store.deleteApiKey(session.uid, hash);
    return seeOther('/keys');
  }

  if (path === '/keys/create') {
    const keys = await store.listApiKeys(session.uid);
    if (keys.length >= MAX_KEYS_PER_USER) {
      return html(
        page(`You already have ${MAX_KEYS_PER_USER} keys. Revoke one before making another.`, {
          app: env.APP,
          session,
          keys,
          profile: await lookup(env, session),
        }),
      );
    }
    const name = String(form.get('name') ?? '').trim().slice(0, 60) || 'Unnamed key';
    // Exactly the checkbox's value, so anything else posted to this endpoint
    // gets the read-only default rather than a write key by accident.
    const scope = form.get('write') === '1' ? SCOPES.join(' ') : 'spectrum:read';
    const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
    await store.putApiKey(await hashApiKey(secret), {
      uid: session.uid,
      email: session.email,
      name,
      scope,
      app: env.APP,
      firebase_refresh_token: session.firebase_refresh_token,
      created_at: Date.now(),
    });
    return html(
      page(null, {
        app: env.APP,
        session,
        keys: await store.listApiKeys(session.uid),
        issued: secret,
        profile: await lookup(env, session),
      }),
    );
  }

  return new Response('Not found', { status: 404 });
}

const STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.5; }
  code, pre { background: #f2f2f5; border-radius: 4px; }
  code { padding: 0.1rem 0.3rem; word-break: break-all; }
  pre { padding: 0.8rem; overflow-x: auto; }
  button { font: inherit; padding: 0.5rem 1rem; border-radius: 4px; border: 0; background: #3C0060; color: #fff; cursor: pointer; }
  button.secondary { background: #e6e6ea; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #e0e0e5; vertical-align: middle; }
  .issued { border: 2px solid #3C0060; border-radius: 4px; padding: 1rem; margin: 1rem 0; }
  .note { color: #55555f; font-size: 0.9rem; }
  .warn { border: 2px solid #8a6d00; background: #fdf6e0; border-radius: 4px; padding: 0.6rem 1rem; margin: 1rem 0; }
  .warn p { margin: 0.4rem 0; }
  label { display: block; margin: 0.5rem 0; }
`;

// The banner an account gets before it is offered a key. Only 'member' says
// nothing: the other three all end in a key that gets refused.
function profileNotice(app: string, email: string, profile: ProfileStatus): string {
  const who = `<code>${escapeHtml(email)}</code>`;
  switch (profile.kind) {
    case 'member':
      return '';
    case 'no-profile':
      return `<div class="warn"><p><strong>This Google account has no profile in ${escapeHtml(app)}.</strong>
A key minted here acts as ${who}, so it would be refused on every request.</p>
<p>Sign out below and sign in with the account you use in the app, or ask an admin to add this one. People often have a second Google account signed in and pick the wrong one here.</p></div>`;
    case 'no-roles':
      return `<div class="warn"><p><strong>${who} has a profile but no roles yet.</strong>
A key minted here will be refused until an admin grants a role.</p></div>`;
    case 'unreadable':
      return `<div class="warn"><p><strong>Could not read the profile for ${who}.</strong>
A key minted here may be refused. Check that this is the account you use in the app.</p></div>`;
  }
}

function page(
  message: string | null,
  state: {
    app: string;
    session: Signed;
    keys: ApiKeyIndexEntry[];
    issued?: string;
    profile: ProfileStatus;
  } | null,
): string {
  const head = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spectrum API keys</title><style>${STYLE}</style></head><body>
<h1>API keys</h1>`;
  const tail = '</body></html>';

  if (!state) {
    return `${head}<p>${escapeHtml(message ?? 'Not signed in.')}</p>
<p><a href="/keys">Try again</a></p>${tail}`;
  }

  const { app, session, keys, issued, profile } = state;
  const sid = escapeHtml(session.sid);

  const banner = message ? `<p class="note">${escapeHtml(message)}</p>` : '';
  const issuedBlock = issued
    ? `<div class="issued">
<p><strong>Copy this key now.</strong> It is stored only as a hash, so this is the one time it can be shown.</p>
<pre>${escapeHtml(issued)}</pre>
<p class="note">Send it as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
</div>`
    : '';

  const rows = keys
    .map(
      (k) => `<tr>
<td>${escapeHtml(k.name)}</td>
<td><code>${escapeHtml(k.scope)}</code></td>
<td class="note">${new Date(k.created_at).toISOString().slice(0, 10)}</td>
<td><form method="post" action="/keys/revoke"><input type="hidden" name="sid" value="${sid}"><input type="hidden" name="hash" value="${escapeHtml(k.hash)}"><button class="secondary" type="submit">Revoke</button></form></td>
</tr>`,
    )
    .join('');
  const table = keys.length
    ? `<table><thead><tr><th>Name</th><th>Access</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="note">You have no keys yet.</p>';

  return `${head}
<p>Signed in as <strong>${escapeHtml(session.email ?? session.uid)}</strong>.
A key acts as you: it can do exactly what your account can do in the app, and nothing more.</p>
<p class="note">Account <code>${escapeHtml(session.uid)}</code>, roles
${profile.roles.length ? profile.roles.map((r) => `<code>${escapeHtml(r)}</code>`).join(' ') : '<em>none</em>'}.</p>
${profileNotice(app, session.email ?? session.uid, profile)}
${banner}
${issuedBlock}
${table}
<h2>New key</h2>
<form method="post" action="/keys/create">
  <input type="hidden" name="sid" value="${sid}">
  <label>Name <input type="text" name="name" maxlength="60" placeholder="scoreboard on the pit TV"></label>
  <label><input type="checkbox" name="write" value="1"> Allow writes as well as reads</label>
  <button type="submit">Create key</button>
</form>
<p class="note">Revoking a key takes effect on its next request.
<form method="post" action="/keys/signout" style="display:inline"><input type="hidden" name="sid" value="${sid}"><button class="secondary" type="submit">Sign out</button></form></p>
${tail}`;
}

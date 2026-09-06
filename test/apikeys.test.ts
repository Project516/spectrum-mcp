import { describe, expect, it } from 'vitest';
import { handleKeys, hashApiKey, looksLikeApiKey, resolveApiKey } from '../src/apikeys.js';
import type { Env } from '../src/env.js';
import { Store } from '../src/oauth/store.js';

// Enough of KV for the store: get as json, put, delete, and prefix list.
function fakeKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      const raw = data.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function storeWithKv() {
  const kv = fakeKv();
  return { kv, store: new Store(kv as unknown as KVNamespace) };
}

const RECORD = {
  uid: 'uid-1',
  email: 'scout@example.com',
  name: 'pit TV',
  scope: 'spectrum:read',
  firebase_refresh_token: 'refresh-1',
  created_at: 1_700_000_000_000,
};

describe('api key format', () => {
  it('only treats the prefixed form as a key, so a JWT is never hashed as one', () => {
    expect(looksLikeApiKey('ssk_abc')).toBe(true);
    expect(looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.e30.sig')).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
  });

  it('hashes deterministically, and differently per key', async () => {
    expect(await hashApiKey('ssk_one')).toBe(await hashApiKey('ssk_one'));
    expect(await hashApiKey('ssk_one')).not.toBe(await hashApiKey('ssk_two'));
  });
});

describe('api key storage', () => {
  it('never writes the secret itself, only its hash', async () => {
    const { kv, store } = storeWithKv();
    const secret = 'ssk_super-secret-value';
    await store.putApiKey(await hashApiKey(secret), RECORD);
    const written = [...kv.data.keys()].join('\n') + [...kv.data.values()].join('\n');
    expect(written).not.toContain('super-secret-value');
  });

  it('resolves a stored key back to its owner and refresh token', async () => {
    const { store } = storeWithKv();
    const secret = 'ssk_live';
    await store.putApiKey(await hashApiKey(secret), RECORD);
    const resolved = await resolveApiKey(store, secret);
    expect(resolved?.uid).toBe('uid-1');
    expect(resolved?.firebase_refresh_token).toBe('refresh-1');
    expect(resolved?.scope).toBe('spectrum:read');
  });

  it('resolves nothing for an unknown key or a token that is not a key', async () => {
    const { store } = storeWithKv();
    expect(await resolveApiKey(store, 'ssk_never-issued')).toBeNull();
    expect(await resolveApiKey(store, 'not-a-key')).toBeNull();
  });

  it('lists a user\'s keys oldest first, and not another user\'s', async () => {
    const { store } = storeWithKv();
    await store.putApiKey('h2', { ...RECORD, name: 'second', created_at: 2 });
    await store.putApiKey('h1', { ...RECORD, name: 'first', created_at: 1 });
    await store.putApiKey('h3', { ...RECORD, uid: 'uid-2', name: 'theirs', created_at: 3 });

    const mine = await store.listApiKeys('uid-1');
    expect(mine.map((k) => k.name)).toEqual(['first', 'second']);
    expect(await store.listApiKeys('uid-2')).toHaveLength(1);
  });

  it('revoking removes both the lookup record and the listing entry', async () => {
    const { store } = storeWithKv();
    const secret = 'ssk_doomed';
    const hash = await hashApiKey(secret);
    await store.putApiKey(hash, RECORD);

    await store.deleteApiKey('uid-1', hash);

    expect(await resolveApiKey(store, secret)).toBeNull();
    expect(await store.listApiKeys('uid-1')).toEqual([]);
  });

  it('keeps an api key with no expiry, unlike a grant', async () => {
    // A key that stopped working after a quiet month would read as an outage.
    const { kv, store } = storeWithKv();
    const put = kv.put;
    const ttls: unknown[] = [];
    kv.put = async (key: string, value: string, opts?: unknown) => {
      ttls.push(opts);
      return put.call(kv, key, value);
    };
    await store.putApiKey('h', RECORD);
    expect(ttls).toEqual([undefined, undefined]);
  });
});

const ENV = { GOOGLE_CLIENT_ID: 'google-client', APP: 'strategy' } as unknown as Env;
const ISSUER = 'https://mcp.example.com';

function post(path: string, form: Record<string, string>, cookie?: string): Request {
  const body = new URLSearchParams(form);
  return new Request(`${ISSUER}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie: `smcp_keys=${cookie}` } : {}),
    },
    body,
  });
}

async function signedIn(store: Store, uid = 'uid-1') {
  const sid = 'session-1';
  await store.putKeySession(sid, { uid, email: `${uid}@example.com`, firebase_refresh_token: 'refresh-1' });
  return sid;
}

describe('key management page', () => {
  it('sends a signed-out visitor to Google, remembering the browser it started in', async () => {
    const { kv, store } = storeWithKv();
    const res = await handleKeys(new Request(`${ISSUER}/keys`), ENV, store, ISSUER);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('accounts.google.com');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    expect([...kv.data.keys()].some((k) => k.startsWith('pendingmanage:'))).toBe(true);
  });

  it('creates a read-only key by default and a writable one only when asked', async () => {
    const { store } = storeWithKv();
    const sid = await signedIn(store);

    await handleKeys(post('/keys/create', { sid, name: 'pit TV' }, sid), ENV, store, ISSUER);
    await handleKeys(post('/keys/create', { sid, name: 'importer', write: '1' }, sid), ENV, store, ISSUER);

    const keys = await store.listApiKeys('uid-1');
    expect(keys.map((k) => k.scope)).toEqual(['spectrum:read', 'spectrum:read spectrum:write']);
  });

  it('only the checkbox\'s own value grants write, so a stray value stays read-only', async () => {
    const { store } = storeWithKv();
    const sid = await signedIn(store);

    await handleKeys(post('/keys/create', { sid, name: 'a', write: '0' }, sid), ENV, store, ISSUER);
    await handleKeys(post('/keys/create', { sid, name: 'b', write: 'false' }, sid), ENV, store, ISSUER);

    const keys = await store.listApiKeys('uid-1');
    expect(keys.map((k) => k.scope)).toEqual(['spectrum:read', 'spectrum:read']);
  });

  it('shows a new key exactly once, and stores only its hash', async () => {
    const { kv, store } = storeWithKv();
    const sid = await signedIn(store);
    const res = await handleKeys(post('/keys/create', { sid, name: 'k' }, sid), ENV, store, ISSUER);

    const shown = (await res.text()).match(/ssk_[A-Za-z0-9_-]+/)?.[0];
    expect(shown).toBeTruthy();
    expect([...kv.data.values()].join('\n')).not.toContain(shown!);
    expect(await resolveApiKey(store, shown!)).not.toBeNull();
  });

  it('mints the key against the signed-in user\'s own Firebase session', async () => {
    // This is what makes a key incapable of exceeding its owner: it carries
    // their refresh token, so firestore.rules sees them and nobody else.
    const { store } = storeWithKv();
    const sid = await signedIn(store);
    const res = await handleKeys(post('/keys/create', { sid, name: 'k' }, sid), ENV, store, ISSUER);
    const shown = (await res.text()).match(/ssk_[A-Za-z0-9_-]+/)![0];

    const record = await resolveApiKey(store, shown);
    expect(record).toMatchObject({ uid: 'uid-1', firebase_refresh_token: 'refresh-1' });
  });

  it('does nothing for a post with no session', async () => {
    const { store } = storeWithKv();
    const res = await handleKeys(post('/keys/create', { sid: 'session-1', name: 'k' }), ENV, store, ISSUER);
    expect(res.status).toBe(303);
    expect(await store.listApiKeys('uid-1')).toEqual([]);
  });

  it('does nothing for a post whose form does not echo the session id', async () => {
    const { store } = storeWithKv();
    const sid = await signedIn(store);
    const res = await handleKeys(post('/keys/create', { sid: 'guessed', name: 'k' }, sid), ENV, store, ISSUER);
    expect(res.status).toBe(303);
    expect(await store.listApiKeys('uid-1')).toEqual([]);
  });

  it('refuses to revoke a key belonging to somebody else', async () => {
    const { store } = storeWithKv();
    await store.putApiKey('their-hash', { ...RECORD, uid: 'uid-2', name: 'theirs' });
    const sid = await signedIn(store, 'uid-1');

    await handleKeys(post('/keys/revoke', { sid, hash: 'their-hash' }, sid), ENV, store, ISSUER);

    expect(await store.listApiKeys('uid-2')).toHaveLength(1);
    expect(await store.getApiKey('their-hash')).not.toBeNull();
  });

  it('revokes a key the signed-in user owns', async () => {
    const { store } = storeWithKv();
    await store.putApiKey('my-hash', RECORD);
    const sid = await signedIn(store);

    await handleKeys(post('/keys/revoke', { sid, hash: 'my-hash' }, sid), ENV, store, ISSUER);

    expect(await store.listApiKeys('uid-1')).toEqual([]);
  });

  it('drops the session on sign out, so a stolen cookie stops working', async () => {
    const { store } = storeWithKv();
    const sid = await signedIn(store);
    const res = await handleKeys(post('/keys/signout', { sid }, sid), ENV, store, ISSUER);

    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await store.getKeySession(sid)).toBeNull();
  });

  it('escapes a key name into the page rather than rendering it as markup', async () => {
    const { store } = storeWithKv();
    const sid = await signedIn(store);
    await handleKeys(post('/keys/create', { sid, name: '<img src=x onerror=alert(1)>' }, sid), ENV, store, ISSUER);
    const page = await (await handleKeys(
      new Request(`${ISSUER}/keys`, { headers: { cookie: `smcp_keys=${sid}` } }),
      ENV,
      store,
      ISSUER,
    )).text();

    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x');
  });
});

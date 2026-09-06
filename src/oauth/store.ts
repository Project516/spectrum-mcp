// Every piece of OAuth state lives in one KV namespace under a prefix, with a
// TTL chosen so nothing needs a sweeper.
import type { Env } from '../env.js';

export interface ClientRecord {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  grant_types: string[];
  scope?: string;
}

export interface AuthCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  uid: string;
  email?: string;
  firebase_refresh_token: string;
  expires_at: number;
}

// The upstream half of a grant: the Firebase session this server acts through.
// Kept separate from the access token so a token can be re-minted on refresh
// without the client ever seeing a Firebase credential.
export interface GrantRecord {
  uid: string;
  email?: string;
  client_id: string;
  scope: string;
  resource: string;
  firebase_refresh_token: string;
}

// An API key's half of the same thing a GrantRecord holds: the Firebase
// session this server acts through for a headless caller. Kept under its own
// key so it does not inherit the grant TTL -- an API key is revoked by hand,
// not by expiry, and one that stopped working after a quiet month would look
// like an outage.
export interface ApiKeyRecord {
  uid: string;
  email?: string;
  name: string;
  scope: string;
  firebase_refresh_token: string;
  created_at: number;
}

// What the management page lists. The secret itself is never stored, only its
// hash, so this is the only record that can name a key after it is issued.
export interface ApiKeyIndexEntry {
  hash: string;
  name: string;
  scope: string;
  created_at: number;
}

// A signed-in browser session on the key management page. Short lived, and
// separate from every OAuth record: it authorizes managing keys, never data.
export interface KeySessionRecord {
  uid: string;
  email?: string;
  firebase_refresh_token: string;
}

// The manage-page equivalent of PendingAuth. Its own record rather than a mode
// flag on PendingAuth, so the OAuth legs keep exactly the fields they require.
export interface PendingManage {
  browser_hash: string;
}

// State carried across the redirect to Google and back.
export interface PendingAuth {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  scope: string;
  resource: string;
  // SHA-256 of the cookie set when this request started. Every later leg of
  // the flow must present the matching cookie, so knowing the state key is not
  // enough to drive someone else's browser through it.
  browser_hash: string;
}

const TEN_MINUTES = 600;
const THIRTY_MINUTES = 1800;
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export class Store {
  constructor(private readonly kv: KVNamespace) {}

  static from(env: Env): Store {
    return new Store(env.STORE);
  }

  private get<T>(key: string): Promise<T | null> {
    return this.kv.get(key, 'json') as Promise<T | null>;
  }

  private put(key: string, value: unknown, ttl: number): Promise<void> {
    return this.kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  }

  putClient(record: ClientRecord): Promise<void> {
    return this.put(`client:${record.client_id}`, record, THIRTY_DAYS * 12);
  }
  getClient(clientId: string): Promise<ClientRecord | null> {
    return this.get(`client:${clientId}`);
  }

  putPendingAuth(key: string, value: PendingAuth): Promise<void> {
    return this.put(`pending:${key}`, value, TEN_MINUTES);
  }
  getPendingAuth(key: string): Promise<PendingAuth | null> {
    return this.get(`pending:${key}`);
  }
  async takePendingAuth(key: string): Promise<PendingAuth | null> {
    const record = await this.get<PendingAuth>(`pending:${key}`);
    if (record) await this.kv.delete(`pending:${key}`);
    return record;
  }

  putAuthCode(code: string, value: AuthCodeRecord): Promise<void> {
    return this.put(`code:${code}`, value, TEN_MINUTES);
  }
  // Authorization codes are single use: the record is deleted as it is read, so
  // a replayed code finds nothing. KV has no compare-and-swap, so two requests
  // landing inside the same read window can both see it; the code is bound to
  // one client, one redirect URI and one PKCE challenge, so winning that race
  // still requires already holding the verifier.
  async takeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const record = await this.get<AuthCodeRecord>(`code:${code}`);
    if (record) await this.kv.delete(`code:${code}`);
    return record;
  }

  putGrant(gid: string, value: GrantRecord): Promise<void> {
    return this.put(`grant:${gid}`, value, THIRTY_DAYS);
  }
  getGrant(gid: string): Promise<GrantRecord | null> {
    return this.get(`grant:${gid}`);
  }
  deleteGrant(gid: string): Promise<void> {
    return this.kv.delete(`grant:${gid}`);
  }

  putPendingManage(key: string, value: PendingManage): Promise<void> {
    return this.put(`pendingmanage:${key}`, value, TEN_MINUTES);
  }
  async takePendingManage(key: string): Promise<PendingManage | null> {
    const record = await this.get<PendingManage>(`pendingmanage:${key}`);
    if (record) await this.kv.delete(`pendingmanage:${key}`);
    return record;
  }

  putKeySession(sid: string, value: KeySessionRecord): Promise<void> {
    return this.put(`keysession:${sid}`, value, THIRTY_MINUTES);
  }
  getKeySession(sid: string): Promise<KeySessionRecord | null> {
    return this.get(`keysession:${sid}`);
  }
  deleteKeySession(sid: string): Promise<void> {
    return this.kv.delete(`keysession:${sid}`);
  }

  // An API key is stored twice: once under the hash of the secret, which is
  // what a request lookup needs, and once under its owner, which is what the
  // management page needs. Neither copy holds the secret.
  async putApiKey(hash: string, record: ApiKeyRecord): Promise<void> {
    await this.kv.put(`apikey:${hash}`, JSON.stringify(record));
    await this.kv.put(
      `keyof:${record.uid}:${hash}`,
      JSON.stringify({
        hash,
        name: record.name,
        scope: record.scope,
        created_at: record.created_at,
      } satisfies ApiKeyIndexEntry),
    );
  }
  getApiKey(hash: string): Promise<ApiKeyRecord | null> {
    return this.get(`apikey:${hash}`);
  }
  async deleteApiKey(uid: string, hash: string): Promise<void> {
    await this.kv.delete(`apikey:${hash}`);
    await this.kv.delete(`keyof:${uid}:${hash}`);
  }
  async listApiKeys(uid: string): Promise<ApiKeyIndexEntry[]> {
    const listed = await this.kv.list({ prefix: `keyof:${uid}:` });
    const entries = await Promise.all(
      listed.keys.map((k) => this.get<ApiKeyIndexEntry>(k.name)),
    );
    return entries
      .filter((e): e is ApiKeyIndexEntry => e !== null)
      .sort((a, b) => a.created_at - b.created_at);
  }

  putRefreshToken(token: string, gid: string): Promise<void> {
    return this.put(`refresh:${token}`, { gid }, THIRTY_DAYS);
  }
  async takeRefreshToken(token: string): Promise<string | null> {
    const record = await this.get<{ gid: string }>(`refresh:${token}`);
    if (record) await this.kv.delete(`refresh:${token}`);
    return record?.gid ?? null;
  }
}

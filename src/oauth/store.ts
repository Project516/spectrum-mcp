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
  firebase_refresh_token: string;
  expires_at: number;
}

// The upstream half of a grant: the Firebase session this server acts through.
// Kept separate from the access token so a token can be re-minted on refresh
// without the client ever seeing a Firebase credential.
export interface GrantRecord {
  uid: string;
  client_id: string;
  scope: string;
  resource: string;
  firebase_refresh_token: string;
}

// State carried across the redirect to Google and back.
export interface PendingAuth {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  scope: string;
  resource: string;
}

const TEN_MINUTES = 600;
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
  // Authorization codes are single use: read and delete in one step so a
  // replayed code finds nothing.
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

  putRefreshToken(token: string, gid: string): Promise<void> {
    return this.put(`refresh:${token}`, { gid }, THIRTY_DAYS);
  }
  async takeRefreshToken(token: string): Promise<string | null> {
    const record = await this.get<{ gid: string }>(`refresh:${token}`);
    if (record) await this.kv.delete(`refresh:${token}`);
    return record?.gid ?? null;
  }
}

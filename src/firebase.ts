// Firebase access, always as the signed-in user. This server holds no service
// account: every Firestore call carries that user's ID token, so
// `firestore.rules` decides what the agent can see and change, exactly as it
// does for the app. There is no second copy of the role model here.
import type { Env } from './env.js';

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const SECURETOKEN = 'https://securetoken.googleapis.com/v1';

export interface FirebaseSession {
  uid: string;
  email?: string;
  displayName?: string;
  idToken: string;
  refreshToken: string;
}

// Trade a Google ID token for a Firebase session on this project. The user
// exists in the same Firebase project the app signs in to, so their uid, their
// userProfiles document and their existing scout entries all match.
export async function signInWithGoogle(
  env: Env,
  googleIdToken: string,
  requestUri: string,
): Promise<FirebaseSession> {
  const res = await fetch(`${IDENTITY}/accounts:signInWithIdp?key=${env.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
      requestUri,
      returnSecureToken: true,
      returnIdpCredential: false,
    }),
  });
  const body = (await res.json()) as Record<string, string>;
  if (!res.ok) throw new Error(`firebase sign-in failed: ${body.error ?? res.status}`);
  return {
    uid: body.localId!,
    email: body.email,
    displayName: body.displayName,
    idToken: body.idToken!,
    refreshToken: body.refreshToken!,
  };
}

// Firebase ID tokens last an hour; a grant outlives that, so mint a fresh one
// per request from the stored refresh token.
export async function freshIdToken(env: Env, refreshToken: string): Promise<string> {
  const res = await fetch(`${SECURETOKEN}/token?key=${env.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const body = (await res.json()) as Record<string, string>;
  if (!res.ok) throw new Error(`firebase token refresh failed: ${body.error ?? res.status}`);
  return body.id_token!;
}

export class FirestoreDenied extends Error {}

// A document that is not there. Distinct from a transport or server failure,
// because "it does not exist" is an answer and "the call did not work" is not,
// and a caller that conflates them tells the user the wrong thing.
export class FirestoreNotFound extends Error {}

export class Firestore {
  private readonly base: string;

  constructor(
    projectId: string,
    private readonly idToken: string,
  ) {
    this.base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${this.idToken}`,
        'content-type': 'application/json',
      },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 401) {
      // The rules said no. Surface it as itself rather than as a server error:
      // it is the answer, not a failure.
      throw new FirestoreDenied(
        'Firestore security rules refused this operation for your account.',
      );
    }
    if (res.status === 404) {
      throw new FirestoreNotFound('No such document.');
    }
    if (!res.ok) {
      const message =
        (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
      throw new Error(message);
    }
    return body;
  }

  getDocument(collection: string, id: string): Promise<unknown> {
    return this.call(`/${collection}/${encodeURIComponent(id)}`);
  }

  listDocuments(collection: string, pageSize: number): Promise<unknown> {
    return this.call(`/${collection}?pageSize=${pageSize}`);
  }

  runQuery(body: unknown): Promise<unknown> {
    return this.call(':runQuery', { method: 'POST', body: JSON.stringify(body) });
  }

  createDocument(collection: string, id: string, fields: unknown): Promise<unknown> {
    return this.call(`/${collection}?documentId=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });
  }

  // Firestore's REST patch replaces only the named fields, which keeps an
  // update from silently clearing everything the caller did not send.
  patchDocument(collection: string, id: string, fields: Record<string, unknown>): Promise<unknown> {
    const mask = Object.keys(fields)
      .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
      .join('&');
    return this.call(`/${collection}/${encodeURIComponent(id)}?${mask}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    });
  }

  deleteDocument(collection: string, id: string): Promise<unknown> {
    return this.call(`/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

// POST /token -- authorization_code and refresh_token grants.
import type { Env } from '../env.js';
import { json, oauthError, randomToken } from '../util.js';
import { pkceMatches, sameResource } from './authorize.js';
import { resolveClient } from './clients.js';
import { signAccessToken } from './jwt.js';
import type { Store } from './store.js';

const ACCESS_TOKEN_TTL = 3600;

export async function handleToken(
  request: Request,
  env: Env,
  store: Store,
  issuer: string,
): Promise<Response> {
  const form = await request.formData();
  const grantType = String(form.get('grant_type') ?? '');
  const clientId = String(form.get('client_id') ?? '');
  if (!clientId) return oauthError('invalid_client', 'client_id is required', 401);

  const client = await resolveClient(clientId, store);
  if (!client) return oauthError('invalid_client', 'unknown client_id', 401);

  const resource = form.get('resource');
  if (resource && !sameResource(String(resource), env.RESOURCE)) {
    return oauthError('invalid_target', `this server only issues tokens for ${env.RESOURCE}`);
  }

  if (grantType === 'authorization_code') {
    const code = String(form.get('code') ?? '');
    const verifier = String(form.get('code_verifier') ?? '');
    const record = await store.takeAuthCode(code);
    if (!record || record.expires_at < Date.now()) {
      return oauthError('invalid_grant', 'authorization code is unknown or expired');
    }
    if (record.client_id !== clientId) {
      return oauthError('invalid_grant', 'this code was issued to a different client');
    }
    if (record.redirect_uri !== String(form.get('redirect_uri') ?? '')) {
      return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (!verifier || !(await pkceMatches(verifier, record.code_challenge))) {
      return oauthError('invalid_grant', 'PKCE verification failed');
    }

    const gid = randomToken();
    await store.putGrant(gid, {
      uid: record.uid,
      email: record.email,
      client_id: clientId,
      scope: record.scope,
      resource: record.resource,
      firebase_refresh_token: record.firebase_refresh_token,
    });
    return issue(env, store, issuer, gid, record.uid, clientId, record.scope, record.resource);
  }

  if (grantType === 'refresh_token') {
    const presented = String(form.get('refresh_token') ?? '');
    // Refresh tokens rotate: the presented one is consumed here, so a stolen
    // copy is useful at most once and the theft shows up as a failed refresh.
    const gid = await store.takeRefreshToken(presented);
    if (!gid) return oauthError('invalid_grant', 'refresh token is unknown or already used');
    const grant = await store.getGrant(gid);
    if (!grant) return oauthError('invalid_grant', 'this grant has been revoked');
    if (grant.client_id !== clientId) {
      return oauthError('invalid_grant', 'this grant belongs to a different client');
    }
    // A refresh may narrow the scope set but never widen it.
    const asked = String(form.get('scope') ?? grant.scope).split(/\s+/).filter(Boolean);
    const granted = grant.scope.split(' ');
    if (!asked.every((s) => granted.includes(s))) {
      return oauthError('invalid_scope', 'a refresh cannot add scopes; re-authorize instead');
    }
    return issue(env, store, issuer, gid, grant.uid, clientId, asked.join(' '), grant.resource);
  }

  return oauthError('unsupported_grant_type', `unsupported grant_type: ${grantType}`);
}

async function issue(
  env: Env,
  store: Store,
  issuer: string,
  gid: string,
  uid: string,
  clientId: string,
  scope: string,
  resource: string,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signAccessToken(
    {
      iss: issuer,
      sub: uid,
      aud: resource,
      scope,
      client_id: clientId,
      gid,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL,
      jti: randomToken(16),
    },
    env.TOKEN_SIGNING_KEY,
  );
  const refreshToken = randomToken();
  await store.putRefreshToken(refreshToken, gid);
  return json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

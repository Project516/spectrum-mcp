// Router. Everything under /mcp is the MCP resource server; everything else is
// the OAuth authorization server this Worker also plays.
import { manifestFor } from './apps/index.js';
import { issuerOf, type Env } from './env.js';
import { Firestore, freshIdToken } from './firebase.js';
import {
  handleRpc,
  InsufficientScope,
  isSupportedVersion,
  negotiateVersion,
  PROTOCOL_VERSION,
} from './mcp/server.js';
import { handleAuthorize, handleConsent } from './oauth/authorize.js';
import { handleCallback } from './oauth/callback.js';
import { verifyAccessToken } from './oauth/jwt.js';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticate,
} from './oauth/metadata.js';
import { handleRegister } from './oauth/register.js';
import { Store } from './oauth/store.js';
import { handleToken } from './oauth/token.js';
import { json } from './util.js';

function unauthorized(issuer: string, description?: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': wwwAuthenticate(issuer, { error: 'invalid_token', description }),
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
      'access-control-expose-headers': 'www-authenticate, mcp-protocol-version',
      'access-control-max-age': '86400',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const issuer = issuerOf(request);
    const store = Store.from(env);

    if (request.method === 'OPTIONS') return corsPreflight();

    switch (`${request.method} ${url.pathname}`) {
      case 'GET /.well-known/oauth-protected-resource':
      case 'GET /.well-known/oauth-protected-resource/mcp':
        return protectedResourceMetadata(env, issuer);
      case 'GET /.well-known/oauth-authorization-server':
      case 'GET /.well-known/openid-configuration':
        return authorizationServerMetadata(issuer);
      case 'GET /authorize':
        return handleAuthorize(request, env, store, issuer);
      case 'POST /authorize/consent':
        return handleConsent(request, env, store, issuer);
      case 'GET /callback':
        return handleCallback(request, env, store, issuer);
      case 'POST /token':
        return handleToken(request, env, store, issuer);
      case 'POST /register':
        return handleRegister(request, store);
      case 'GET /':
        return json({
          name: `spectrum-mcp-${env.APP}`,
          mcp_endpoint: env.RESOURCE,
          protocol_version: PROTOCOL_VERSION,
        });
    }

    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    // No server-initiated messages means no stream to open.
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
    }

    const version = request.headers.get('mcp-protocol-version');
    if (version && !isSupportedVersion(version)) {
      return json(
        { error: `unsupported MCP protocol version: ${version}` },
        { status: 400 },
      );
    }

    const auth = request.headers.get('authorization') ?? '';
    if (!auth.toLowerCase().startsWith('bearer ')) {
      return unauthorized(issuer, 'a bearer token is required');
    }
    const claims = await verifyAccessToken(auth.slice(7).trim(), env.TOKEN_SIGNING_KEY, {
      issuer,
      audience: env.RESOURCE,
    });
    if (!claims) return unauthorized(issuer, 'token is invalid, expired, or for another server');

    const grant = await store.getGrant(claims.gid);
    if (!grant) return unauthorized(issuer, 'this grant has been revoked');

    let message: { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
    try {
      message = await request.json();
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    const ctx = {
      manifest: manifestFor(env.APP),
      firestore: new Firestore(
        env.FIREBASE_PROJECT_ID,
        await freshIdToken(env, grant.firebase_refresh_token),
      ),
      uid: claims.sub,
      email: grant.email,
      scopes: claims.scope.split(' '),
    };

    // The initialize call negotiates from the body, since there is no prior
    // request to have carried the header; every later call on the same
    // session already carries the negotiated version in the header the
    // isSupportedVersion check above accepted. Echoing that back, rather
    // than this server's own newest version, is what a client whose SDK
    // negotiated down to an older revision expects to see.
    const negotiated =
      message.method === 'initialize'
        ? negotiateVersion(message.params?.protocolVersion as string | undefined)
        : negotiateVersion(version ?? undefined);

    try {
      const response = await handleRpc(message, ctx);
      // A notification gets no body, only an acknowledgement.
      if (!response) return new Response(null, { status: 202 });
      return json(response, { headers: { 'mcp-protocol-version': negotiated } });
    } catch (err) {
      if (err instanceof InsufficientScope) {
        // Step-up: name every scope the operation needs so the client
        // re-authorizes once rather than round-tripping per missing scope.
        return new Response(JSON.stringify({ error: 'insufficient_scope' }), {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': wwwAuthenticate(issuer, {
              error: 'insufficient_scope',
              scope: [...new Set([...ctx.scopes, err.required])].join(' '),
              description: err.message,
            }),
          },
        });
      }
      return json({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32603, message: (err as Error).message },
      });
    }
  },
};

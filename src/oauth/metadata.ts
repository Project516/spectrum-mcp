// RFC 9728 protected resource metadata and RFC 8414 authorization server
// metadata. This Worker is both roles, so both documents point at itself.
import type { Env } from '../env.js';
import { json } from '../util.js';

export const SCOPES = ['spectrum:read', 'spectrum:write'] as const;
export type Scope = (typeof SCOPES)[number];

// scopes_supported is the minimal set for basic functionality; write is asked
// for through a step-up challenge when a write tool is called.
export const DEFAULT_SCOPES: Scope[] = ['spectrum:read'];

export function protectedResourceMetadata(env: Env, issuer: string): Response {
  return json({
    resource: env.RESOURCE,
    authorization_servers: [issuer],
    scopes_supported: DEFAULT_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: `Spectrum ${env.APP} MCP server`,
    resource_documentation: 'https://github.com/Project516/spectrum-mcp',
  });
}

export function authorizationServerMetadata(issuer: string): Response {
  return json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    service_documentation: 'https://github.com/Project516/spectrum-mcp',
  });
}

// RFC 9728 locates the document by inserting the resource's path after the
// well-known segment, so a server at /mcp advertises .../oauth-protected-resource/mcp.
export function resourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

// The challenge a client follows to discover where to authorize (RFC 6750).
export function wwwAuthenticate(
  issuer: string,
  options: { error?: string; scope?: string; description?: string } = {},
): string {
  const parts = ['Bearer'];
  const params: string[] = [];
  if (options.error) params.push(`error="${options.error}"`);
  if (options.description) params.push(`error_description="${options.description}"`);
  params.push(`resource_metadata="${resourceMetadataUrl(issuer)}"`);
  params.push(`scope="${options.scope ?? DEFAULT_SCOPES.join(' ')}"`);
  return `${parts[0]} ${params.join(', ')}`;
}

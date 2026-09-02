// MCP over Streamable HTTP, JSON responses only. This server has no
// server-initiated messages, so it never opens an SSE stream: a POST carries
// one JSON-RPC message and the response carries its result.
import type { AppManifest } from '../apps/index.js';
import { FirestoreDenied } from '../firebase.js';
import { findTool, TOOLS, ToolError, type ToolContext } from './registry.js';

export const PROTOCOL_VERSION = '2026-07-28';
// Revisions this server can still speak if an older client asks for one.
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-06-18', '2025-03-26'];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export class InsufficientScope extends Error {
  constructor(readonly required: string) {
    super(`This operation needs the ${required} scope.`);
  }
}

function result(id: JsonRpcRequest['id'], value: unknown) {
  return { jsonrpc: '2.0' as const, id, result: value };
}

function error(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

export function negotiateVersion(requested: string | undefined): string {
  if (requested && SUPPORTED_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSION;
}

export function isSupportedVersion(version: string): boolean {
  return SUPPORTED_VERSIONS.includes(version);
}

function toolDescriptor(manifest: AppManifest) {
  return TOOLS.filter((tool) => tool.visible?.(manifest) ?? true).map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: tool.readOnlyHint,
      destructiveHint: tool.name === 'delete_document',
      openWorldHint: false,
      title: tool.title,
    },
    _meta: { 'spectrum/scope': tool.scope, 'spectrum/app': manifest.key },
  }));
}

// Returns the JSON-RPC response object, or null for a notification.
export async function handleRpc(
  message: JsonRpcRequest,
  ctx: ToolContext,
): Promise<object | null> {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: negotiateVersion(params?.protocolVersion as string | undefined),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `spectrum-mcp-${ctx.manifest.key}`, version: '0.1.0' },
        instructions: ctx.manifest.instructions,
      });

    case 'notifications/initialized':
      return null;

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: toolDescriptor(ctx.manifest) });

    case 'tools/call': {
      const name = String(params?.name ?? '');
      const tool = findTool(name);
      if (!tool) return error(id, -32602, `Unknown tool: ${name}`);
      // Scope is checked before the call so the client gets a step-up
      // challenge instead of a tool error it cannot act on.
      if (!ctx.scopes.includes(tool.scope)) throw new InsufficientScope(tool.scope);
      try {
        const value = await tool.run((params?.arguments as Record<string, unknown>) ?? {}, ctx);
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        // A rules refusal or a bad argument is an answer for the model to read
        // and adjust to, not a transport failure.
        if (err instanceof FirestoreDenied || err instanceof ToolError) {
          return result(id, {
            content: [{ type: 'text', text: (err as Error).message }],
            isError: true,
          });
        }
        throw err;
      }
    }

    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

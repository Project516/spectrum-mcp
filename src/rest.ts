// A plain HTTP surface over the same tools the MCP endpoint serves
// (SpectrumStrategy #1499). It exists for callers that speak HTTP and nothing
// else: a CI script, a webhook, a scoreboard on a pit TV.
//
// Every route resolves to a tool and calls it, rather than reaching for
// Firestore itself. That is the point: the collection guard, the scout-config
// guard and the scope check are the tools', so REST and MCP cannot answer the
// same question two different ways.
import { FirestoreDenied } from './firebase.js';
import { findTool, TOOLS, ToolError, type ToolContext } from './mcp/registry.js';
import { json } from './util.js';

// Route segments that name an endpoint rather than a collection. Checked
// before the collection routes, so a manifest may never use one as a
// collection name.
const RESERVED = new Set(['whoami', 'collections', 'tools']);

function fail(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function requiredArgs(schema: Record<string, unknown>): string[] {
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.map(String) : [];
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ToolError('Request body must be a JSON object.');
  }
}

async function call(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Response> {
  const tool = findTool(name);
  if (!tool) return fail(404, `Unknown tool: ${name}`);
  if (!ctx.scopes.includes(tool.scope)) {
    return fail(403, `This key does not have the ${tool.scope} scope.`);
  }
  // A tool's inputSchema is descriptive; nothing validates against it. The
  // resource routes always supply the required arguments from the path, but
  // POST /v1/tools/{name} forwards whatever the caller sent, and a missing id
  // would otherwise reach Firestore as the literal string "undefined".
  const missing = requiredArgs(tool.inputSchema).filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return fail(400, `${name} requires: ${missing.join(', ')}.`);
  }
  try {
    return json(await tool.run(args, ctx));
  } catch (err) {
    // A rules refusal is the answer, not a server fault, so it gets a 403 with
    // the refusal text rather than a 500.
    if (err instanceof FirestoreDenied) return fail(403, (err as Error).message);
    if (err instanceof ToolError) return fail(400, (err as Error).message);
    return fail(502, (err as Error).message);
  }
}

// `path` is the request path with the `/v1` prefix removed, so `/scoutEntries/e1`
// for `/v1/scoutEntries/e1` and the empty string for `/v1` itself.
export async function handleRest(
  request: Request,
  ctx: ToolContext,
  path: string,
): Promise<Response> {
  try {
    return await route(request, ctx, path);
  } catch (err) {
    // A malformed body is reported by the parser, which runs before the tool
    // call that would otherwise have caught it.
    if (err instanceof ToolError) return fail(400, (err as Error).message);
    throw err;
  }
}

async function route(
  request: Request,
  ctx: ToolContext,
  path: string,
): Promise<Response> {
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method;

  if (segments.length === 0) {
    return json({
      app: ctx.manifest.key,
      endpoints: ['/v1/whoami', '/v1/collections', '/v1/tools', '/v1/{collection}'],
      documentation: 'https://github.com/Project516/spectrum-mcp',
    });
  }

  const [first, second] = segments as [string, string | undefined];

  if (RESERVED.has(first)) {
    if (first === 'whoami' && method === 'GET') return call('whoami', {}, ctx);
    if (first === 'collections' && method === 'GET') return call('list_collections', {}, ctx);
    if (first === 'tools' && segments.length === 1 && method === 'GET') {
      return json({
        tools: TOOLS.filter((t) => t.visible?.(ctx.manifest) ?? true).map((t) => ({
          name: t.name,
          description: t.description,
          scope: t.scope,
          inputSchema: t.inputSchema,
        })),
      });
    }
    // The escape hatch: anything the resource routes below do not cover,
    // including the scout-config and FRC lookup tools.
    if (first === 'tools' && segments.length === 2 && method === 'POST') {
      return call(second!, await body(request), ctx);
    }
    return fail(405, `${method} is not supported on /v1/${segments.join('/')}`);
  }

  const collection = first;

  if (segments.length === 1) {
    if (method === 'GET') {
      const params = new URL(request.url).searchParams;
      const args: Record<string, unknown> = { collection };
      if (params.has('limit')) {
        const limit = Number(params.get('limit'));
        // Number('abc') is NaN, which Firestore rejects with an error that
        // reads like a server fault. Bad input is the caller's, so say so.
        if (!Number.isInteger(limit) || limit < 1) {
          return fail(400, 'limit must be a positive integer.');
        }
        args.limit = limit;
      }
      if (params.has('orderBy')) args.orderBy = params.get('orderBy');
      if (params.has('descending')) args.descending = params.get('descending') === 'true';
      return call('query_collection', args, ctx);
    }
    if (method === 'POST') {
      // The body is the document, exactly as PATCH's body is the fields to
      // change. An explicit id goes in the query string rather than the body,
      // so a document may itself have a field called `id`.
      const id = new URL(request.url).searchParams.get('id');
      const args: Record<string, unknown> = { collection, data: await body(request) };
      if (id) args.id = id;
      return call('create_document', args, ctx);
    }
    return fail(405, `${method} is not supported on /v1/${collection}`);
  }

  // POST /v1/{collection}/query is the filtered read. It cannot shadow a
  // document: the single-document routes are GET, PATCH and DELETE, and a
  // create posts to the collection with the id in the body.
  if (segments.length === 2 && second === 'query' && method === 'POST') {
    return call('query_collection', { collection, ...(await body(request)) }, ctx);
  }

  if (segments.length === 2) {
    const id = second!;
    if (method === 'GET') return call('get_document', { collection, id }, ctx);
    if (method === 'PATCH') return call('update_document', { collection, id, data: await body(request) }, ctx);
    if (method === 'DELETE') return call('delete_document', { collection, id }, ctx);
    return fail(405, `${method} is not supported on /v1/${collection}/${id}`);
  }

  return fail(404, `No endpoint at /v1/${segments.join('/')}`);
}

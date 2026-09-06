import { describe, expect, it, vi } from 'vitest';
import { pitManifest } from '../src/apps/pit.js';
import { strategyManifest } from '../src/apps/strategy.js';
import { FirestoreDenied } from '../src/firebase.js';
import { toFields } from '../src/firestore-values.js';
import type { ToolContext } from '../src/mcp/tools.js';
import { handleRest } from '../src/rest.js';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    manifest: strategyManifest,
    uid: 'uid-1',
    email: 'scout@example.com',
    scopes: ['spectrum:read', 'spectrum:write'],
    firestore: {} as ToolContext['firestore'],
    ...overrides,
  };
}

// Slice the path exactly as the router does, so these exercise the real input.
async function send(
  method: string,
  path: string,
  ctx: ToolContext,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const request = new Request(`https://mcp.example.com/v1${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const response = await handleRest(request, ctx, new URL(request.url).pathname.slice(3));
  return { status: response.status, body: await response.json() };
}

const DOC = { name: 'projects/p/databases/(default)/documents/scoutEntries/e1', fields: toFields({ team: 3847 }) };

describe('document routes', () => {
  it('GET /v1/{collection}/{id} reads one document', async () => {
    const getDocument = vi.fn(async () => DOC);
    const res = await send('GET', '/scoutEntries/e1', context({
      firestore: { getDocument } as unknown as ToolContext['firestore'],
    }));
    expect(getDocument).toHaveBeenCalledWith('scoutEntries', 'e1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'e1', data: { team: 3847 } });
  });

  it('GET /v1/{collection} queries with the limit from the query string', async () => {
    const runQuery = vi.fn(async (_body: unknown) => [{ document: DOC }]);
    const res = await send('GET', '/scoutEntries?limit=5', context({
      firestore: { runQuery } as unknown as ToolContext['firestore'],
    }));
    expect(runQuery.mock.calls[0]![0]).toMatchObject({ structuredQuery: { limit: 5 } });
    expect(res.body.count).toBe(1);
  });

  it('POST /v1/{collection}/query takes filters in the body', async () => {
    const runQuery = vi.fn(async (_body: unknown) => []);
    await send('POST', '/scoutEntries/query', context({
      firestore: { runQuery } as unknown as ToolContext['firestore'],
    }), { filters: [{ field: 'team', op: '==', value: 3847 }], limit: 10 });
    const query = (runQuery.mock.calls[0]![0] as any).structuredQuery;
    expect(query.limit).toBe(10);
    expect(query.where.compositeFilter.filters[0].fieldFilter.field.fieldPath).toBe('team');
  });

  it('POST /v1/{collection} creates, PATCH updates, DELETE removes', async () => {
    const firestore = {
      createDocument: vi.fn(async () => DOC),
      patchDocument: vi.fn(async () => DOC),
      deleteDocument: vi.fn(async () => ({})),
    } as unknown as ToolContext['firestore'];

    await send('POST', '/scoutEntries?id=e1', context({ firestore }), { team: 3847 });
    await send('PATCH', '/scoutEntries/e1', context({ firestore }), { team: 254 });
    const removed = await send('DELETE', '/scoutEntries/e1', context({ firestore }));

    expect((firestore.createDocument as any).mock.calls[0].slice(0, 2)).toEqual(['scoutEntries', 'e1']);
    // The body is the document, matching PATCH, rather than a wrapper around it.
    expect((firestore.createDocument as any).mock.calls[0][2]).toEqual(toFields({ team: 3847 }));
    // PATCH sends the body as the field set, so only the named fields move.
    expect((firestore.patchDocument as any).mock.calls[0][2]).toEqual(toFields({ team: 254 }));
    expect((firestore.deleteDocument as any)).toHaveBeenCalledWith('scoutEntries', 'e1');
    expect(removed.body).toMatchObject({ deleted: true });
  });
});

describe('authorization', () => {
  it('refuses a write with a read-only key, naming the scope it needs', async () => {
    const res = await send('POST', '/scoutEntries', context({ scopes: ['spectrum:read'] }), {
      team: 3847,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('spectrum:write');
  });

  it('reports a rules refusal as the answer, not a server fault', async () => {
    const firestore = {
      getDocument: vi.fn(async () => {
        throw new FirestoreDenied('Firestore security rules refused this operation.');
      }),
    } as unknown as ToolContext['firestore'];
    const res = await send('GET', '/scoutEntries/e1', context({ firestore }));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('rules refused');
  });

  it('keeps the manifest bound: an unlisted collection is refused', async () => {
    const res = await send('GET', '/userSecrets/x', context());
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown collection');
  });
});

describe('discovery and the tool escape hatch', () => {
  it('no manifest names a collection the reserved routes would shadow', async () => {
    // /v1/{collection} routing checks the reserved words first, so a manifest
    // that used one would make that collection unreachable.
    for (const manifest of [strategyManifest, pitManifest]) {
      for (const c of manifest.collections) {
        expect(['whoami', 'collections', 'tools']).not.toContain(c.name);
      }
    }
  });

  it('GET /v1/whoami and /v1/collections do not need a Firestore round trip to route', async () => {
    const collections = await send('GET', '/collections', context());
    expect(collections.body.collections.length).toBeGreaterThan(0);
  });

  it('GET /v1/tools lists every tool this deployment offers, with its scope', async () => {
    const res = await send('GET', '/tools', context());
    const names = res.body.tools.map((t: any) => t.name);
    expect(names).toContain('get_document');
    expect(names).toContain('get_scout_config');
    expect(res.body.tools.find((t: any) => t.name === 'delete_document').scope).toBe(
      'spectrum:write',
    );
  });

  it('POST /v1/tools/{name} reaches a tool the resource routes do not cover', async () => {
    const getDocument = vi.fn(async () => ({ name: 'x/userProfiles/uid-1', fields: toFields({ roles: ['scouter'] }) }));
    const res = await send('POST', '/tools/whoami', context({
      firestore: { getDocument } as unknown as ToolContext['firestore'],
    }), {});
    expect(res.body).toMatchObject({ uid: 'uid-1', roles: ['scouter'] });
  });

  it('404s an unknown tool name rather than falling through to a collection', async () => {
    const res = await send('POST', '/tools/no_such_tool', context(), {});
    expect(res.status).toBe(404);
  });
});

describe('request shape', () => {
  it('generates an id when the query string does not name one', async () => {
    const createDocument = vi.fn(async (_c: string, _id: string, _f: unknown) => DOC);
    await send('POST', '/scoutEntries', context({
      firestore: { createDocument } as unknown as ToolContext['firestore'],
    }), { team: 3847 });
    // A uuid, not the literal "undefined".
    expect(createDocument.mock.calls[0]![1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a non-numeric limit as caller error, not as an upstream fault', async () => {
    const res = await send('GET', '/scoutEntries?limit=abc', context());
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('positive integer');
  });

  it('rejects a tool call missing a required argument instead of querying "undefined"', async () => {
    // Reachable through the escape hatch, where nothing supplies the path
    // arguments the resource routes always carry.
    const getDocument = vi.fn(async () => DOC);
    const res = await send('POST', '/tools/get_document', context({
      firestore: { getDocument } as unknown as ToolContext['firestore'],
    }), { collection: 'scoutEntries' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id');
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('rejects a malformed body with a 400, not a 500', async () => {
    const res = await send('POST', '/scoutEntries', context(), '{not json');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('JSON object');
  });

  it('405s a method a route does not offer', async () => {
    const res = await send('DELETE', '/scoutEntries', context());
    expect(res.status).toBe(405);
  });

  it('does not treat a reserved segment as a collection name', async () => {
    // /v1/collections must stay the endpoint even though the router reaches
    // collection routing for every other first segment.
    const res = await send('DELETE', '/collections', context());
    expect(res.status).toBe(405);
    expect(res.body.error).not.toContain('Unknown collection');
  });
});

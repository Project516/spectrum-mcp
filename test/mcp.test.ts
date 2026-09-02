import { describe, expect, it } from 'vitest';
import { pitManifest } from '../src/apps/pit.js';
import { strategyManifest } from '../src/apps/strategy.js';
import { FirestoreDenied } from '../src/firebase.js';
import { toFields } from '../src/firestore-values.js';
import { handleRpc, InsufficientScope, negotiateVersion, PROTOCOL_VERSION } from '../src/mcp/server.js';
import type { ToolContext } from '../src/mcp/tools.js';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    manifest: strategyManifest,
    uid: 'uid-1',
    scopes: ['spectrum:read'],
    firestore: {} as ToolContext['firestore'],
    ...overrides,
  };
}

describe('protocol negotiation', () => {
  it('echoes a revision it speaks and falls back otherwise', () => {
    expect(negotiateVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateVersion('1999-01-01')).toBe(PROTOCOL_VERSION);
    expect(negotiateVersion(undefined)).toBe(PROTOCOL_VERSION);
  });
});

describe('handleRpc', () => {
  it('initializes with the app manifest instructions', async () => {
    const response = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } },
      context(),
    )) as { result: { instructions: string; protocolVersion: string } };
    expect(response.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.result.instructions).toContain('signed-in user');
  });

  it('acknowledges a notification without a response body', async () => {
    expect(
      await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, context()),
    ).toBeNull();
  });

  it('lists every tool with its required scope', async () => {
    const response = (await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context())) as {
      result: { tools: { name: string; _meta: Record<string, string> }[] };
    };
    const names = response.result.tools.map((t) => t.name);
    expect(names).toContain('whoami');
    expect(names).toContain('query_collection');
    const write = response.result.tools.find((t) => t.name === 'delete_document');
    expect(write?._meta['spectrum/scope']).toBe('spectrum:write');
  });

  it('demands a step-up before a write tool runs', async () => {
    await expect(
      handleRpc(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'create_document', arguments: { collection: 'pickLists', data: {} } },
        },
        context(),
      ),
    ).rejects.toBeInstanceOf(InsufficientScope);
  });

  it('refuses a collection the manifest does not expose', async () => {
    const response = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_document', arguments: { collection: 'telemetry', id: 'x' } },
      },
      context(),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('Unknown collection');
  });

  it('refuses a write to a read-only collection', async () => {
    const response = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'update_document',
          arguments: { collection: 'userProfiles', id: 'uid-2', data: { roles: ['admin'] } },
        },
      },
      context({ scopes: ['spectrum:read', 'spectrum:write'] }),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('read-only');
  });

  it('reports a rules refusal as a tool result, not a transport failure', async () => {
    const firestore = {
      getDocument: async () => {
        throw new FirestoreDenied('Firestore security rules refused this operation for your account.');
      },
    } as unknown as ToolContext['firestore'];
    const response = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'get_document', arguments: { collection: 'scoutEntries', id: 'e1' } },
      },
      context({ firestore }),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('security rules');
  });

  it('reports no roles when the profile is unreadable', async () => {
    const firestore = {
      getDocument: async () => {
        throw new FirestoreDenied('denied');
      },
    } as unknown as ToolContext['firestore'];
    const response = (await handleRpc(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      context({ firestore }),
    )) as { result: { structuredContent: { roles: unknown[]; uid: string } } };
    expect(response.result.structuredContent.roles).toEqual([]);
    expect(response.result.structuredContent.uid).toBe('uid-1');
  });
});

describe('scout config tools', () => {
  it('lists get_scout_config/update_scout_config only for the strategy deployment', async () => {
    const strategyResponse = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      context(),
    )) as { result: { tools: { name: string }[] } };
    expect(strategyResponse.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_scout_config', 'update_scout_config']),
    );

    const pitResponse = (await handleRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      context({ manifest: pitManifest }),
    )) as { result: { tools: { name: string }[] } };
    expect(pitResponse.result.tools.map((t) => t.name)).not.toEqual(
      expect.arrayContaining(['get_scout_config', 'update_scout_config']),
    );
  });

  it('reads the current config for a form', async () => {
    const stored = {
      title: 'Match',
      delimiter: '\t',
      sections: [{ name: 'Auton', fields: [{ code: 'notes', title: 'Notes', type: 'text' }] }],
      revision: 2,
    };
    const firestore = {
      getDocument: async () => ({ name: 'x/scoutConfig', fields: toFields(stored) }),
    } as unknown as ToolContext['firestore'];
    const response = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_scout_config', arguments: { form: 'scoutConfig' } },
      },
      context({ firestore }),
    )) as { result: { structuredContent: { form: string; config: unknown } } };
    expect(response.result.structuredContent.form).toBe('scoutConfig');
    expect(response.result.structuredContent.config).toMatchObject({ title: 'Match', revision: 2 });
  });

  it('refuses an unknown form', async () => {
    const response = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_scout_config', arguments: { form: 'notAForm' } },
      },
      context(),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('Unknown form');
  });

  it('rejects an invalid config before writing anything', async () => {
    let patched = false;
    const firestore = {
      getDocument: async () => ({ name: 'x/scoutConfig', fields: {} }),
      patchDocument: async () => {
        patched = true;
        return {};
      },
    } as unknown as ToolContext['firestore'];
    const response = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'update_scout_config',
          arguments: { form: 'scoutConfig', config: { title: 'Match', sections: [] } },
        },
      },
      context({ scopes: ['spectrum:read', 'spectrum:write'], firestore }),
    )) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('no sections');
    expect(patched).toBe(false);
  });

  it('retires a dropped choice and stamps the revision above the live copy', async () => {
    const existing = {
      title: 'Match',
      delimiter: '\t',
      revision: 5,
      sections: [
        {
          name: 'Auton',
          fields: [
            {
              code: 'startPos',
              title: 'Start',
              type: 'select',
              choices: { left: 'Left', right: 'Right' },
            },
          ],
        },
      ],
    };
    let written: Record<string, unknown> | undefined;
    const firestore = {
      getDocument: async () => ({ name: 'x/scoutConfig', fields: toFields(existing) }),
      patchDocument: async (_collection: string, _id: string, fields: Record<string, unknown>) => {
        written = fields;
        return { name: 'x/scoutConfig', fields };
      },
    } as unknown as ToolContext['firestore'];
    const incoming = {
      title: 'Match',
      sections: [
        {
          name: 'Auton',
          fields: [{ code: 'startPos', title: 'Start', type: 'select', choices: { left: 'Left' } }],
        },
      ],
    };
    const response = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'update_scout_config', arguments: { form: 'scoutConfig', config: incoming } },
      },
      context({ scopes: ['spectrum:read', 'spectrum:write'], firestore }),
    )) as {
      result: { isError?: boolean; structuredContent: { config: { revision: number; sections: unknown[] } } };
    };
    expect(response.result.isError).toBeFalsy();
    expect(response.result.structuredContent.config.revision).toBe(6);
    expect(written).toBeDefined();
    const field = (
      response.result.structuredContent.config.sections as { fields: Record<string, unknown>[] }[]
    )[0]!.fields[0]!;
    expect(field.choices).toEqual({ left: 'Left', right: 'Right' });
    expect(field.retiredChoiceKeys).toEqual(['right']);
  });
});

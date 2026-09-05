import { afterEach, describe, expect, it, vi } from 'vitest';
import { pitManifest } from '../src/apps/pit.js';
import { strategyManifest } from '../src/apps/strategy.js';
import { toFields } from '../src/firestore-values.js';
import { handleRpc, PROTOCOL_VERSION } from '../src/mcp/server.js';
import { FRC_TOOLS } from '../src/mcp/frc-tools.js';
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

function pitContext(): ToolContext {
  return context({ manifest: pitManifest });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return (await handleRpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ctx,
  )) as { result: { isError?: boolean; content: { text: string }[]; structuredContent?: unknown } };
}

const firestoreWithTbaKey = {
  getDocument: async () => ({ name: 'x/apiKeys', fields: toFields({ tba: 'test-tba-key' }) }),
} as unknown as ToolContext['firestore'];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tools/list gating', () => {
  it('lists the FRC tools for strategy and hides them for pit', async () => {
    const strategyResponse = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      context(),
    )) as { result: { tools: { name: string }[] } };
    expect(strategyResponse.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_team_epa', 'get_event_teams', 'get_event_matches']),
    );

    const pitResponse = (await handleRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      context({ manifest: pitManifest }),
    )) as { result: { tools: { name: string }[] } };
    expect(pitResponse.result.tools.map((t) => t.name)).not.toEqual(
      expect.arrayContaining(['get_team_epa']),
    );
  });
});

describe('argument validation', () => {
  it('rejects a non-integer team number', async () => {
    const response = await callTool('get_team_epa', { team: '3847' }, context());
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('positive integer');
  });

  it('rejects a negative team number', async () => {
    const response = await callTool('get_team_epa', { team: -5 }, context());
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('positive integer');
  });

  it('rejects a malformed event key', async () => {
    const response = await callTool('get_event_teams', { eventKey: 'not an event key!' }, context());
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('event key');
  });
});

describe('statbotics trimming', () => {
  it('trims a realistic team payload down to the promised fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        team: 3847,
        name: 'Spectrum   -△◅',
        country: 'USA',
        state: 'TX',
        district: 'fit',
        rookie_year: 2011,
        active: true,
        record: { wins: 488, losses: 227, ties: 6, count: 721, winrate: 0.681 },
        norm_epa: { current: 1679.0, recent: 1713.0, mean: 1648.0, max: 1821.0 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await callTool('get_team_epa', { team: 3847 }, context());
    expect(response.result.isError).toBeFalsy();
    expect(response.result.structuredContent).toEqual({
      team: 3847,
      name: 'Spectrum   -△◅',
      epa: 1679.0,
      epaRecent: 1713.0,
      epaMax: 1821.0,
      record: { wins: 488, losses: 227, ties: 6 },
    });
    // Only the promised fields survive: no country/state/district/rookie_year.
    expect(response.result.structuredContent).not.toHaveProperty('rookie_year');
    expect(fetchMock).toHaveBeenCalledWith('https://api.statbotics.io/v3/team/3847');
  });

  it('trims an event team roster', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          {
            team: 118,
            year: 2025,
            event: '2025txhou',
            team_name: 'Robonauts',
            country: 'USA',
            epa: { total_points: 86.01, norm: 1896.0 },
            record: {
              qual: { wins: 12, losses: 0, ties: 0, rank: 1, num_teams: 31 },
              total: { wins: 17, losses: 0, ties: 0, count: 17, winrate: 1.0 },
            },
          },
        ]),
      ),
    );

    const response = await callTool('get_event_teams', { eventKey: '2025txhou' }, context());
    expect(response.result.isError).toBeFalsy();
    expect(response.result.structuredContent).toEqual({
      eventKey: '2025txhou',
      teams: [{ team: 118, name: 'Robonauts', epa: 1896.0, rank: 1, record: { wins: 17, losses: 0, ties: 0 } }],
    });
  });

  it('reports a Statbotics non-200 as a named upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    const response = await callTool('get_team_epa', { team: 3847 }, context());
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('Statbotics');
    expect(response.result.content[0]!.text).toContain('503');
  });
});

describe('TBA key resolution', () => {
  it('refuses with a clear error when appConfig/apiKeys has no tba field', async () => {
    const firestore = {
      getDocument: async () => ({ name: 'x/apiKeys', fields: toFields({}) }),
    } as unknown as ToolContext['firestore'];

    const response = await callTool(
      'get_event_matches',
      { eventKey: '2026txhou' },
      context({ firestore }),
    );
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('not reachable');
  });

  it('refuses with a clear error when the key document is unreadable', async () => {
    const firestore = {
      getDocument: async () => {
        throw new Error('denied');
      },
    } as unknown as ToolContext['firestore'];

    const response = await callTool(
      'get_event_rankings',
      { eventKey: '2026txhou' },
      context({ firestore }),
    );
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('not reachable');
  });
});

describe('TBA trimming and upstream failure', () => {
  it('trims a realistic match payload and sends the key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          key: '2026txhou_qm12',
          comp_level: 'qm',
          match_number: 12,
          set_number: 1,
          winning_alliance: 'red',
          alliances: {
            red: { team_keys: ['frc3847', 'frc118', 'frc254'], score: 90 },
            blue: { team_keys: ['frc1', 'frc2', 'frc3'], score: 60 },
          },
        },
        {
          key: '2026txhou_sf1m1',
          comp_level: 'sf',
          match_number: 1,
          set_number: 1,
          winning_alliance: '',
          alliances: {
            red: { team_keys: ['frc3847'], score: -1 },
            blue: { team_keys: ['frc1'], score: -1 },
          },
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await callTool(
      'get_event_matches',
      { eventKey: '2026txhou' },
      context({ firestore: firestoreWithTbaKey }),
    );
    expect(response.result.isError).toBeFalsy();
    expect(response.result.structuredContent).toEqual({
      eventKey: '2026txhou',
      matches: [
        {
          key: '2026txhou_qm12',
          level: 'qm',
          matchNumber: 12,
          setNumber: 1,
          redTeams: ['frc3847', 'frc118', 'frc254'],
          blueTeams: ['frc1', 'frc2', 'frc3'],
          redScore: 90,
          blueScore: 60,
          winner: 'red',
        },
        {
          key: '2026txhou_sf1m1',
          level: 'sf',
          matchNumber: 1,
          setNumber: 1,
          redTeams: ['frc3847'],
          blueTeams: ['frc1'],
          redScore: -1,
          blueScore: -1,
          winner: null,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.thebluealliance.com/api/v3/event/2026txhou/matches/simple',
      { headers: { 'X-TBA-Auth-Key': 'test-tba-key' } },
    );
  });

  it('filters to qualification matches only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          { key: 'a', comp_level: 'qm', match_number: 1, set_number: 1, alliances: {} },
          { key: 'b', comp_level: 'sf', match_number: 1, set_number: 1, alliances: {} },
        ]),
      ),
    );

    const response = await callTool(
      'get_event_matches',
      { eventKey: '2026txhou', level: 'qual' },
      context({ firestore: firestoreWithTbaKey }),
    );
    const matches = (response.result.structuredContent as { matches: { key: string }[] }).matches;
    expect(matches.map((m) => m.key)).toEqual(['a']);
  });

  it('trims a realistic rankings payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          rankings: [
            {
              rank: 1,
              team_key: 'frc3847',
              matches_played: 12,
              qual_average: 55.5,
              record: { wins: 10, losses: 2, ties: 0 },
              dq: 0,
              extra_stats: [70],
              sort_orders: [1, 2, 3],
            },
          ],
          sort_order_info: [],
          extra_stats_info: [],
        }),
      ),
    );

    const response = await callTool(
      'get_event_rankings',
      { eventKey: '2026txhou' },
      context({ firestore: firestoreWithTbaKey }),
    );
    expect(response.result.structuredContent).toEqual({
      eventKey: '2026txhou',
      rankings: [
        {
          rank: 1,
          teamKey: 'frc3847',
          matchesPlayed: 12,
          qualAverage: 55.5,
          record: { wins: 10, losses: 2, ties: 0 },
        },
      ],
    });
  });

  it('reports a TBA non-200 as a named upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    const response = await callTool(
      'get_event_rankings',
      { eventKey: '2026txhou' },
      context({ firestore: firestoreWithTbaKey }),
    );
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0]!.text).toContain('Blue Alliance');
    expect(response.result.content[0]!.text).toContain('404');
  });

  it('builds the frcNNNN team key itself rather than accepting one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await callTool(
      'get_team_events_tba',
      { team: 3847, year: 2026 },
      context({ firestore: firestoreWithTbaKey }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.thebluealliance.com/api/v3/team/frc3847/events/2026/simple',
      { headers: { 'X-TBA-Auth-Key': 'test-tba-key' } },
    );
  });
});

describe('a deployment without FRC data', () => {
  // `visible` hides these from tools/list, but tools.ts is explicit that
  // discovery is not a refusal, so run() has to say no as well.
  it('refuses every FRC tool called directly', async () => {
    const ctx = pitContext();
    for (const tool of FRC_TOOLS) {
      await expect(tool.run({ team: 3847, eventKey: '2026txhou', year: 2026 }, ctx)).rejects.toThrow(
        /does not expose FRC event and team lookups/,
      );
    }
  });
});

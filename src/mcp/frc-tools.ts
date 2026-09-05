// Read-only lookups against The Blue Alliance and Statbotics: official event
// data and calculated EPA, as opposed to this team's own scouting collections
// (scoutEntries, pickLists, ...). Prefer these tools over the Firestore
// collection tools for anything that is a published schedule, ranking, or
// EPA number; use the Firestore tools for what 3847's own scouts recorded.
//
// Arguments are validated and normalized before any request goes out: a team
// number is a positive integer this file turns into `frcNNNN` itself, and an
// event key must match TBA's own key shape. Neither upstream needs a service
// account (Statbotics needs no key at all); the TBA key is read from this
// app's own `appConfig/apiKeys` document, exactly as the app does, so a user
// whose rules do not let them read that document is refused there and not
// handed a fallback.
import { fieldsToJson } from '../firestore-values.js';
import { ToolError, type ToolContext, type ToolDefinition } from './tools.js';

const STATBOTICS_BASE = 'https://api.statbotics.io/v3';
const TBA_BASE = 'https://www.thebluealliance.com/api/v3';
const TBA_KEY_DOC = 'apiKeys';
const EVENT_KEY_PATTERN = /^\d{4}[a-z0-9]+$/i;

// `visible` keeps these out of tools/list for a deployment with no FRC data,
// but tools.ts is explicit that discovery is not a refusal: a client may call
// any tool name directly. This is the refusal, mirroring
// requireScoutConfigForm.
function requireFrcData(ctx: ToolContext): void {
  if (ctx.manifest.frcData !== true) {
    throw new ToolError(
      `The ${ctx.manifest.title} deployment does not expose FRC event and team lookups.`,
    );
  }
}

function requireTeamNumber(args: Record<string, unknown>): number {
  const team = args.team;
  if (typeof team !== 'number' || !Number.isInteger(team) || team <= 0) {
    throw new ToolError('"team" must be a positive integer team number, e.g. 3847.');
  }
  return team;
}

function requireEventKey(args: Record<string, unknown>): string {
  const key = String(args.eventKey ?? '');
  if (!EVENT_KEY_PATTERN.test(key)) {
    throw new ToolError(
      '"eventKey" must look like a TBA event key: a four-digit year plus an alphanumeric ' +
        'code, e.g. 2026txhou.',
    );
  }
  return key.toLowerCase();
}

function requireYear(args: Record<string, unknown>): number {
  const year = args.year;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 1992 || year > 2100) {
    throw new ToolError('"year" must be a four-digit season year.');
  }
  return year;
}

// Neither upstream is under this team's control, and a Worker request that
// waits on one forever holds a connection nobody can cancel. Every outbound
// request gets the same deadline, and a timeout reads as a refusal rather
// than an unhandled rejection.
const UPSTREAM_TIMEOUT_MS = 15_000;

async function upstreamFetch(url: string, init: RequestInit, upstream: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ToolError(`${upstream} did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new ToolError(`${upstream} could not be reached.`);
  }
}

async function statboticsGet(path: string): Promise<unknown> {
  const res = await upstreamFetch(`${STATBOTICS_BASE}${path}`, {}, 'Statbotics');
  if (!res.ok) {
    throw new ToolError(`Statbotics request failed: HTTP ${res.status}.`);
  }
  return res.json();
}

// Mirrors the app's FirestoreTbaConfig: the team key lives in
// `appConfig/apiKeys`'s `tba` field, readable by any signed-in member and
// writable only by an admin. There is no fallback here -- unlike the app,
// which falls back to a compile-time key for the mobile/desktop build, this
// server has no key of its own to fall back to.
async function tbaKey(ctx: ToolContext): Promise<string> {
  let fields: Record<string, Record<string, unknown>> | undefined;
  try {
    const doc = (await ctx.firestore.getDocument('appConfig', TBA_KEY_DOC)) as {
      fields?: Record<string, Record<string, unknown>>;
    };
    fields = doc.fields;
  } catch {
    // Signed out, offline, rules refusal, or the document does not exist:
    // all read the same way from here, since this tool has nothing to fall
    // back to either way.
  }
  const key = fields ? fieldsToJson(fields).tba : undefined;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ToolError(
      'The Blue Alliance API key is not reachable for your account: appConfig/apiKeys has no ' +
        '"tba" field, or Firestore rules do not let you read it.',
    );
  }
  return key.trim();
}

async function tbaGet(ctx: ToolContext, path: string): Promise<unknown> {
  const key = await tbaKey(ctx);
  const res = await upstreamFetch(
    `${TBA_BASE}${path}`,
    { headers: { 'X-TBA-Auth-Key': key } },
    'The Blue Alliance',
  );
  if (!res.ok) {
    throw new ToolError(`The Blue Alliance request failed: HTTP ${res.status}.`);
  }
  return res.json();
}

interface StatboticsEpa {
  total_points?: number;
  norm?: number;
  breakdown?: { total_points?: number };
}

interface StatboticsRecord {
  wins?: number;
  losses?: number;
  ties?: number;
}

function trimRecord(record: StatboticsRecord | undefined) {
  if (!record) return undefined;
  return { wins: record.wins ?? 0, losses: record.losses ?? 0, ties: record.ties ?? 0 };
}

export const FRC_TOOLS: ToolDefinition[] = [
  {
    name: 'get_team_epa',
    title: 'Get team EPA',
    description:
      'A team\'s Statbotics EPA (expected points added) and win/loss record: the current season by ' +
      'default, or one specific year. Prefer this over the Firestore collection tools for a calculated ' +
      'strength number; use scoutEntries/pickLists for this team\'s own in-person observations.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    visible: (manifest) => manifest.frcData === true,
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'integer', minimum: 1, description: 'FRC team number, e.g. 3847.' },
        year: { type: 'integer', minimum: 1992, maximum: 2100, description: 'Season year. Omit for the team\'s current EPA.' },
      },
      required: ['team'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      requireFrcData(ctx);
      const team = requireTeamNumber(args);
      if (args.year !== undefined) {
        const year = requireYear(args);
        const data = (await statboticsGet(`/team_year/${team}/${year}`)) as {
          team: number;
          year: number;
          name?: string;
          epa?: StatboticsEpa;
          record?: StatboticsRecord;
        };
        return {
          team: data.team,
          year: data.year,
          name: data.name ?? null,
          epa: data.epa?.norm ?? null,
          epaTotalPoints: data.epa?.total_points ?? data.epa?.breakdown?.total_points ?? null,
          record: trimRecord(data.record),
        };
      }
      const data = (await statboticsGet(`/team/${team}`)) as {
        team: number;
        name?: string;
        norm_epa?: { current?: number; recent?: number; mean?: number; max?: number };
        record?: StatboticsRecord;
      };
      return {
        team: data.team,
        name: data.name ?? null,
        epa: data.norm_epa?.current ?? null,
        epaRecent: data.norm_epa?.recent ?? null,
        epaMax: data.norm_epa?.max ?? null,
        record: trimRecord(data.record),
      };
    },
  },
  {
    name: 'get_event_teams',
    title: 'Get event teams by EPA',
    description:
      'Every team at an event with its Statbotics EPA and event record, for ranking the team list at ' +
      'that event. Prefer this over the Firestore collection tools for the official field of teams; ' +
      'use scoutEntries/pickLists for this team\'s own rankings and notes.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    visible: (manifest) => manifest.frcData === true,
    inputSchema: {
      type: 'object',
      properties: {
        eventKey: { type: 'string', description: 'TBA event key, e.g. 2026txhou.' },
      },
      required: ['eventKey'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      requireFrcData(ctx);
      const eventKey = requireEventKey(args);
      const data = (await statboticsGet(`/team_events?event=${eventKey}&limit=200`)) as {
        team: number;
        team_name?: string;
        epa?: StatboticsEpa;
        record?: { qual?: { rank?: number }; total?: StatboticsRecord };
      }[];
      return {
        eventKey,
        teams: data.map((row) => ({
          team: row.team,
          name: row.team_name ?? null,
          epa: row.epa?.norm ?? null,
          rank: row.record?.qual?.rank ?? null,
          record: trimRecord(row.record?.total),
        })),
      };
    },
  },
  {
    name: 'get_team_events',
    title: 'Get team events (Statbotics)',
    description:
      'A team\'s events for one season with per-event EPA, from Statbotics. Prefer this over the ' +
      'Firestore collection tools for the official event/EPA history; use get_team_events_tba instead ' +
      'when only the schedule dates are needed, not EPA.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    visible: (manifest) => manifest.frcData === true,
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'integer', minimum: 1, description: 'FRC team number, e.g. 3847.' },
        year: { type: 'integer', minimum: 1992, maximum: 2100, description: 'Season year.' },
      },
      required: ['team', 'year'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      requireFrcData(ctx);
      const team = requireTeamNumber(args);
      const year = requireYear(args);
      const data = (await statboticsGet(`/team_events?team=${team}&year=${year}&limit=200`)) as {
        event: string;
        event_name?: string;
        week?: number;
        epa?: StatboticsEpa;
        record?: { qual?: { rank?: number }; total?: StatboticsRecord };
      }[];
      return {
        team,
        year,
        events: data.map((row) => ({
          eventKey: row.event,
          name: row.event_name ?? null,
          week: row.week ?? null,
          epa: row.epa?.norm ?? null,
          rank: row.record?.qual?.rank ?? null,
          record: trimRecord(row.record?.total),
        })),
      };
    },
  },
  {
    name: 'get_event_matches',
    title: 'Get event matches',
    description:
      'The Blue Alliance match schedule and results for an event, optionally filtered to qualification ' +
      'or playoff matches. Prefer this over the Firestore collection tools for the official schedule and ' +
      'scores; use scoutEntries for what a scout observed during a match.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    visible: (manifest) => manifest.frcData === true,
    inputSchema: {
      type: 'object',
      properties: {
        eventKey: { type: 'string', description: 'TBA event key, e.g. 2026txhou.' },
        level: {
          type: 'string',
          enum: ['qual', 'playoff'],
          description: 'Restrict to qualification or playoff matches. Omit for every match.',
        },
      },
      required: ['eventKey'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      requireFrcData(ctx);
      const eventKey = requireEventKey(args);
      const level = args.level === undefined ? undefined : String(args.level);
      if (level !== undefined && level !== 'qual' && level !== 'playoff') {
        throw new ToolError('"level" must be "qual" or "playoff".');
      }
      const data = (await tbaGet(ctx, `/event/${eventKey}/matches/simple`)) as {
        key: string;
        comp_level: string;
        match_number: number;
        set_number: number;
        winning_alliance?: string;
        alliances?: {
          red?: { team_keys?: string[]; score?: number };
          blue?: { team_keys?: string[]; score?: number };
        };
      }[];
      const matches = data
        .filter((m) => {
          if (level === 'qual') return m.comp_level === 'qm';
          if (level === 'playoff') return m.comp_level !== 'qm';
          return true;
        })
        .map((m) => ({
          key: m.key,
          level: m.comp_level,
          matchNumber: m.match_number,
          setNumber: m.set_number,
          redTeams: m.alliances?.red?.team_keys ?? [],
          blueTeams: m.alliances?.blue?.team_keys ?? [],
          redScore: m.alliances?.red?.score ?? null,
          blueScore: m.alliances?.blue?.score ?? null,
          winner: m.winning_alliance || null,
        }));
      return { eventKey, matches };
    },
  },
  {
    name: 'get_team_events_tba',
    title: 'Get team events (TBA)',
    description:
      'A team\'s events for one season from The Blue Alliance: names and dates, not EPA. Prefer ' +
      'get_team_events instead when EPA is what is needed.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    visible: (manifest) => manifest.frcData === true,
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'integer', minimum: 1, description: 'FRC team number, e.g. 3847.' },
        year: { type: 'integer', minimum: 1992, maximum: 2100, description: 'Season year.' },
      },
      required: ['team', 'year'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      requireFrcData(ctx);
      const team = requireTeamNumber(args);
      const year = requireYear(args);
      const data = (await tbaGet(ctx, `/team/frc${team}/events/${year}/simple`)) as {
        key: string;
        name: string;
        event_code: string;
        start_date: string;
        end_date: string;
      }[];
      return {
        team,
        year,
        events: data.map((e) => ({
          eventKey: e.key,
          name: e.name,
          code: e.event_code,
          startDate: e.start_date,
          endDate: e.end_date,
        })),
      };
    },
  },
  {
    name: 'get_event_rankings',
    title: 'Get event rankings',
    description:
      'The current ranking table for an event, from The Blue Alliance. Prefer this over the Firestore ' +
      'collection tools for the official standings; use pickLists for this team\'s own alliance-selection ' +
      'ranking.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    visible: (manifest) => manifest.frcData === true,
    inputSchema: {
      type: 'object',
      properties: {
        eventKey: { type: 'string', description: 'TBA event key, e.g. 2026txhou.' },
      },
      required: ['eventKey'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      requireFrcData(ctx);
      const eventKey = requireEventKey(args);
      const data = (await tbaGet(ctx, `/event/${eventKey}/rankings`)) as {
        rankings?: {
          rank: number;
          team_key: string;
          matches_played: number;
          qual_average?: number | null;
          record?: { wins: number; losses: number; ties: number } | null;
        }[];
      } | null;
      return {
        eventKey,
        rankings: (data?.rankings ?? []).map((r) => ({
          rank: r.rank,
          teamKey: r.team_key,
          matchesPlayed: r.matches_played,
          qualAverage: r.qual_average ?? null,
          record: r.record ? trimRecord(r.record) : null,
        })),
      };
    },
  },
];

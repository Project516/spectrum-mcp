import { SCOUT_CONFIG_FORMS } from '../scout-config.js';
import type { AppManifest } from './manifest.js';

// Collections that carry data a strategy lead would ask about. Telemetry,
// bug reports and the accuracy alert queue are deliberately absent: they are
// operational, not strategic, and nothing an agent should be reading.
export const strategyManifest: AppManifest = {
  key: 'strategy',
  title: 'Spectrum Strategy',
  instructions: [
    'This server exposes the Spectrum Strategy scouting database for FRC team 3847.',
    'You act as the signed-in user: you can only read and change what that person',
    'could in the app, and Firestore security rules enforce it. A refusal means',
    'their role does not allow it, not that the call was malformed.',
    'Team numbers are stored as integers and match keys follow The Blue Alliance',
    'format (for example 2026txhou_qm12).',
    'To edit a scouting form (the match, prescout, or pit question set), use',
    'get_scout_config and update_scout_config rather than the generic document',
    'tools: they retire a removed choice instead of deleting it and stamp the',
    'revision a device needs to adopt the edit.',
  ].join(' '),
  scoutConfigForms: SCOUT_CONFIG_FORMS,
  collections: [
    {
      name: 'scoutEntries',
      description:
        'One scout\'s record of one team in one match. The core match-scouting data.',
      writable: true,
    },
    {
      name: 'prescoutEntries',
      description:
        'Pre-event records collected from match film, roughly five per team.',
      writable: true,
    },
    {
      name: 'pitScoutEntries',
      description: 'One pit interview per team: robot capabilities and configuration.',
      writable: true,
    },
    {
      name: 'trexTraitReports',
      description:
        'Free-form scouter write-ups of a single team trait (autonomous, defense, driver skill, fuel scoring, passing/pushing/stealing).',
      writable: true,
    },
    {
      name: 'pickLists',
      description: 'Ranked team orderings for alliance selection.',
      writable: true,
    },
    {
      name: 'traitTables',
      description: 'Per-match strategy tables a lead writes for the coach.',
      writable: true,
    },
    {
      name: 'postMatchReports',
      description: 'Human-authored write-ups of what happened in a match.',
      writable: true,
    },
    {
      name: 'strategyBoards',
      description: 'Saved strategy board drawings and notes, keyed by match.',
      writable: false,
    },
    {
      name: 'scoutAssignments',
      description: 'Which scouter is assigned to which team and match.',
      writable: false,
    },
    {
      name: 'appConfig',
      description:
        'App-wide configuration documents, including activeEvent and the scouting form definitions. Read these to learn the current event key and the shape of a scout entry. Writable for settings like activeEvent; scoutConfig, prescoutConfig and pitScoutConfig are refused through the generic document tools and must go through get_scout_config/update_scout_config instead.',
      writable: true,
    },
    {
      name: 'userProfiles',
      description: 'Team members and their roles. Readable by strategy, admin and developer only.',
      writable: false,
    },
  ],
};

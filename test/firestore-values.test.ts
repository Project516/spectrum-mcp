import { describe, expect, it } from 'vitest';
import { documentId, fieldsToJson, toFields } from '../src/firestore-values.js';

describe('firestore value conversion', () => {
  it('round-trips a scout-entry shaped document', () => {
    const entry = {
      teamNumber: 3847,
      matchKey: '2026txhou_qm12',
      authorUid: 'uid-1',
      accuracy: 0.85,
      flagged: false,
      notes: null,
      tags: ['defense', 'fast'],
      counts: { auton: 3, teleop: 11 },
    };
    expect(fieldsToJson(toFields(entry))).toEqual(entry);
  });

  it('takes the last segment of a document resource path', () => {
    expect(
      documentId('projects/p/databases/(default)/documents/scoutEntries/entry-9'),
    ).toBe('entry-9');
  });
});

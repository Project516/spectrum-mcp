import { describe, expect, it } from 'vitest';
import {
  normalizeDelimiter,
  reconcileScoutConfig,
  validateScoutConfig,
  type ScoutConfigDoc,
} from '../src/scout-config.js';

function baseConfig(overrides: Partial<ScoutConfigDoc> = {}): ScoutConfigDoc {
  return {
    title: 'Match',
    delimiter: '\t',
    sections: [
      {
        name: 'Auton',
        fields: [{ code: 'notes', title: 'Notes', type: 'text' }],
      },
    ],
    revision: 1,
    ...overrides,
  };
}

describe('validateScoutConfig', () => {
  it('accepts a well formed config', () => {
    expect(validateScoutConfig(baseConfig())).toBeNull();
  });

  it('rejects a config with no sections', () => {
    expect(validateScoutConfig(baseConfig({ sections: [] }))).toContain('no sections');
  });

  it('rejects a field with no code', () => {
    const config = baseConfig({
      sections: [{ name: 'Auton', fields: [{ title: 'x', type: 'text' }] }],
    });
    expect(validateScoutConfig(config)).toContain('non-empty "code"');
  });

  it('rejects duplicate field codes', () => {
    const config = baseConfig({
      sections: [
        {
          name: 'Auton',
          fields: [
            { code: 'x', title: 'a', type: 'text' },
            { code: 'x', title: 'b', type: 'text' },
          ],
        },
      ],
    });
    expect(validateScoutConfig(config)).toContain('used more than once');
  });

  it('rejects a select field with duplicate option values', () => {
    const config = baseConfig({
      sections: [
        {
          name: 'Auton',
          fields: [
            {
              code: 'startPos',
              title: 'Start',
              type: 'select',
              choices: { a: 'Left', b: 'Left' },
            },
          ],
        },
      ],
    });
    expect(validateScoutConfig(config)).toContain('duplicate option values');
  });

  it('rejects a comma delimiter with an action tracker', () => {
    const config = baseConfig({
      delimiter: ',',
      sections: [
        {
          name: 'Teleop',
          fields: [{ code: 'scoring', title: 'Scoring', type: 'action-tracker' }],
        },
      ],
    });
    expect(validateScoutConfig(config)).toContain('destroy the other');
  });

  it('rejects a dash delimiter with a hold-mode action tracker', () => {
    const config = baseConfig({
      delimiter: '-',
      sections: [
        {
          name: 'Teleop',
          fields: [{ code: 'scoring', title: 'Scoring', type: 'action-tracker', mode: 'hold' }],
        },
      ],
    });
    expect(validateScoutConfig(config)).toContain('destroy the other');
  });

  it('allows a dash delimiter with a tap-mode action tracker', () => {
    const config = baseConfig({
      delimiter: '-',
      sections: [
        {
          name: 'Teleop',
          fields: [{ code: 'scoring', title: 'Scoring', type: 'action-tracker', mode: 'tap' }],
        },
      ],
    });
    expect(validateScoutConfig(config)).toBeNull();
  });
});

describe('normalizeDelimiter', () => {
  it('falls back to a tab for an empty or overlong value', () => {
    expect(normalizeDelimiter('')).toBe('\t');
    expect(normalizeDelimiter('12345')).toBe('\t');
    expect(normalizeDelimiter(undefined)).toBe('\t');
  });

  it('keeps a short delimiter as-is', () => {
    expect(normalizeDelimiter(',')).toBe(',');
  });
});

describe('reconcileScoutConfig', () => {
  const existing = baseConfig({
    revision: 3,
    sections: [
      {
        name: 'Auton',
        fields: [
          {
            code: 'startPos',
            title: 'Start',
            type: 'select',
            choices: { left: 'Left', center: 'Center', right: 'Right' },
          },
        ],
      },
    ],
  });

  it('retires a choice dropped from the edit instead of erasing it', () => {
    const incoming = baseConfig({
      sections: [
        {
          name: 'Auton',
          fields: [
            {
              code: 'startPos',
              title: 'Start',
              type: 'select',
              choices: { left: 'Left', center: 'Center' },
            },
          ],
        },
      ],
    });
    const result = reconcileScoutConfig(incoming, existing);
    const field = (result.sections as { fields: Record<string, unknown>[] }[])[0]!.fields[0]!;
    expect(field.choices).toEqual({ left: 'Left', center: 'Center', right: 'Right' });
    expect(field.retiredChoiceKeys).toEqual(['right']);
  });

  it('un-retires a choice the edit lists again', () => {
    const alreadyRetired = baseConfig({
      revision: 4,
      sections: [
        {
          name: 'Auton',
          fields: [
            {
              code: 'startPos',
              title: 'Start',
              type: 'select',
              choices: { left: 'Left', center: 'Center', right: 'Right' },
              retiredChoiceKeys: ['right'],
            },
          ],
        },
      ],
    });
    const incoming = baseConfig({
      sections: [
        {
          name: 'Auton',
          fields: [
            {
              code: 'startPos',
              title: 'Start',
              type: 'select',
              choices: { left: 'Left', center: 'Center', right: 'Right' },
            },
          ],
        },
      ],
    });
    const result = reconcileScoutConfig(incoming, alreadyRetired);
    const field = (result.sections as { fields: Record<string, unknown>[] }[])[0]!.fields[0]!;
    expect(field.retiredChoiceKeys).toBeUndefined();
  });

  it('stamps a revision one above whichever side is ahead', () => {
    const incoming = baseConfig({ revision: 0 });
    expect(reconcileScoutConfig(incoming, existing).revision).toBe(4);

    const aheadIncoming = baseConfig({ revision: 9 });
    expect(reconcileScoutConfig(aheadIncoming, existing).revision).toBe(10);
  });

  it('stamps revision 1 when there is no existing config', () => {
    expect(reconcileScoutConfig(baseConfig({ revision: 0 }), null).revision).toBe(1);
  });

  it('normalizes the delimiter on the reconciled result', () => {
    const incoming = baseConfig({ delimiter: '' });
    expect(reconcileScoutConfig(incoming, null).delimiter).toBe('\t');
  });
});

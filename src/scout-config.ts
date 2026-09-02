// A scout form config (`appConfig/scoutConfig`, `prescoutConfig`,
// `pitScoutConfig` in the Spectrum Strategy app) has editing rules the
// generic document tools do not know about: a removed select choice must be
// retired rather than erased (a scout entry already captured against it has
// to keep resolving), and an edit must carry a revision above whatever is
// already live or every device ignores it. This module is the one place
// those rules are reimplemented for the server, mirroring
// `lib/src/scouting/models/scout_config.dart` and
// `lib/src/scouting/state/form_config_controller.dart` in the app.

export const SCOUT_CONFIG_FORMS = ['scoutConfig', 'prescoutConfig', 'pitScoutConfig'] as const;
export type ScoutConfigForm = (typeof SCOUT_CONFIG_FORMS)[number];

export interface ScoutConfigField {
  code?: unknown;
  title?: unknown;
  type?: unknown;
  choices?: unknown;
  retiredChoiceKeys?: unknown;
  mode?: unknown;
  [key: string]: unknown;
}

export interface ScoutConfigSection {
  name?: unknown;
  fields?: unknown;
  [key: string]: unknown;
}

export interface ScoutConfigDoc {
  title?: unknown;
  page_title?: unknown;
  delimiter?: unknown;
  sections?: unknown;
  revision?: unknown;
  [key: string]: unknown;
}

function fieldsOf(doc: ScoutConfigDoc): ScoutConfigField[] {
  const sections = Array.isArray(doc.sections) ? (doc.sections as ScoutConfigSection[]) : [];
  return sections.flatMap((s) => (Array.isArray(s.fields) ? (s.fields as ScoutConfigField[]) : []));
}

// A field's `choices` arrives as a key-to-label object; anything else is not
// a shape this config format uses.
function choiceMap(field: ScoutConfigField): Record<string, string> | null {
  const choices = field.choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return null;
  return choices as Record<string, string>;
}

function stringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map((v) => String(v)));
}

// Same checks as `ScoutConfig.validationError` in the app: a select whose
// options collide on value crashes the form's dropdown, and an action
// tracker's timestamp format collides with two specific delimiters. Returns
// the reason, or null when the config is fine.
export function validateScoutConfig(doc: ScoutConfigDoc): string | null {
  if (typeof doc.title !== 'string' || doc.title.trim() === '') {
    return 'Config must have a non-empty "title".';
  }
  const sections = doc.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    return 'Config has no sections.';
  }
  for (const section of sections as ScoutConfigSection[]) {
    if (!Array.isArray(section.fields)) {
      return `Section "${String(section.name ?? '')}" has no "fields" array.`;
    }
  }
  const fields = fieldsOf(doc);
  const seenCodes = new Set<string>();
  for (const field of fields) {
    const code = field.code;
    if (typeof code !== 'string' || code.trim() === '') {
      return 'Every field needs a non-empty "code".';
    }
    if (seenCodes.has(code)) {
      return `Field code "${code}" is used more than once; codes must be unique.`;
    }
    seenCodes.add(code);
    if (typeof field.type !== 'string' || field.type.trim() === '') {
      return `Field "${code}" has no "type".`;
    }
    if (field.type === 'select') {
      const choices = choiceMap(field);
      if (choices) {
        const values = Object.values(choices);
        if (new Set(values).size !== values.length) {
          return `Select field "${code}" has duplicate option values; each option must map to a unique value.`;
        }
      }
    }
  }
  const delimiter = normalizeDelimiter(doc.delimiter);
  const trackers = fields.filter((f) => f.type === 'action-tracker');
  if (trackers.length > 0) {
    if (delimiter === ',') {
      return 'This config uses "," as its delimiter and has an action tracker, which joins ' +
        'its timestamps with commas. One would destroy the other, so use a tab delimiter or drop the tracker.';
    }
    if (delimiter === '-' && trackers.some((f) => (f.mode ?? 'hold') === 'hold')) {
      return 'This config uses "-" as its delimiter and has a hold-mode action tracker, which ' +
        'writes each span as start-end. One would destroy the other, so use a tab delimiter or ' +
        'switch the tracker to tap mode.';
    }
  }
  return null;
}

// Mirrors `ScoutConfig.fromJson`'s delimiter guard: an empty or overlong
// value is never a valid separator, so it falls back to a tab.
export function normalizeDelimiter(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  return value.length === 0 || value.length > 4 ? '\t' : value;
}

/**
 * Applies choice retirement and revision stamping to an incoming config, the
 * way `FormConfigController.updateConfig` and the in-app choice editor do:
 * a select or checkbox-select choice missing from the incoming field but
 * present on the currently live one is kept in `choices` (so an already
 * captured answer keeps resolving) and moved into `retiredChoiceKeys`
 * instead of disappearing. A choice the incoming edit lists again is treated
 * as un-retired.
 *
 * `existing` is the document currently in Firestore, or null when this form
 * has never been written.
 */
export function reconcileScoutConfig(
  incoming: ScoutConfigDoc,
  existing: ScoutConfigDoc | null,
): ScoutConfigDoc {
  const existingByCode = new Map<string, ScoutConfigField>();
  if (existing) {
    for (const field of fieldsOf(existing)) {
      if (typeof field.code === 'string') existingByCode.set(field.code, field);
    }
  }

  const sections = (incoming.sections as ScoutConfigSection[]).map((section) => ({
    ...section,
    fields: (section.fields as ScoutConfigField[]).map((field) => {
      const priorField = typeof field.code === 'string' ? existingByCode.get(field.code) : undefined;
      const incomingChoices = choiceMap(field);
      const priorChoices = priorField ? choiceMap(priorField) : null;
      if (!incomingChoices && !priorChoices) return field;

      const mergedChoices: Record<string, string> = { ...(incomingChoices ?? {}) };
      const retired = stringSet(field.retiredChoiceKeys);
      for (const k of stringSet(priorField?.retiredChoiceKeys)) retired.add(k);

      if (priorChoices) {
        for (const [key, label] of Object.entries(priorChoices)) {
          if (!(key in mergedChoices)) {
            // Removed from this edit, not erased: keep the label so a
            // captured answer against it still resolves, and retire it so a
            // fresh answer never offers it again.
            mergedChoices[key] = label;
            retired.add(key);
          }
        }
      }
      // An edit that lists a key in `choices` without also retiring it means
      // to bring it back.
      for (const key of Object.keys(incomingChoices ?? {})) retired.delete(key);
      // A retired key that no longer exists in the merged map at all is not
      // worth carrying.
      const finalRetired = Array.from(retired).filter((key) => key in mergedChoices);

      return {
        ...field,
        choices: mergedChoices,
        retiredChoiceKeys: finalRetired.length > 0 ? finalRetired : undefined,
      };
    }),
  }));

  const priorRevision = typeof existing?.revision === 'number' ? existing.revision : 0;
  const incomingRevision = typeof incoming.revision === 'number' ? incoming.revision : 0;

  return {
    ...incoming,
    delimiter: normalizeDelimiter(incoming.delimiter),
    sections,
    revision: Math.max(priorRevision, incomingRevision) + 1,
  };
}

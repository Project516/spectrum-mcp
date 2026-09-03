// Scout form config editing (#1461). Generic over nothing: unlike the rest of
// this file, these two tools know the shape of a scout form config and apply
// the same edit rules the in-app editor does (see src/scout-config.ts),
// which the generic get/create/update_document tools cannot: a raw overwrite
// would erase a retired choice and skip the revision bump every device relies
// on to adopt the edit.
import {
  reconcileScoutConfig,
  SCOUT_CONFIG_FORMS,
  validateScoutConfig,
  type ScoutConfigDoc,
} from '../scout-config.js';
import { fieldsToJson, toFields } from '../firestore-values.js';
import { ToolError, type ToolContext, type ToolDefinition } from './tools.js';

const APP_CONFIG_COLLECTION = 'appConfig';

function requireScoutConfigForm(ctx: ToolContext, args: Record<string, unknown>): string {
  const forms = ctx.manifest.scoutConfigForms ?? [];
  const form = String(args.form ?? '');
  if (!forms.includes(form)) {
    throw new ToolError(
      forms.length === 0
        ? `The ${ctx.manifest.title} deployment has no scout form configs.`
        : `Unknown form "${form}". Expected one of: ${forms.join(', ')}.`,
    );
  }
  return form;
}

async function readScoutConfig(ctx: ToolContext, form: string): Promise<ScoutConfigDoc | null> {
  try {
    const doc = (await ctx.firestore.getDocument(APP_CONFIG_COLLECTION, form)) as {
      fields?: Record<string, Record<string, unknown>>;
    };
    return fieldsToJson(doc.fields ?? {}) as ScoutConfigDoc;
  } catch (err) {
    // Firestore's REST get returns a plain 404 for a document that was never
    // written; every form has an in-app auto-push so this is expected only
    // the first time an edit is made through this server.
    if (err instanceof Error && /not found|NOT_FOUND/i.test(err.message)) return null;
    throw err;
  }
}

const formArg = {
  type: 'string',
  enum: [...SCOUT_CONFIG_FORMS],
  description:
    'Which form: scoutConfig (match scouting), prescoutConfig (pre-event film scouting), or pitScoutConfig (pit interview).',
};

export const SCOUT_CONFIG_TOOLS: ToolDefinition[] = [
  {
    name: 'get_scout_config',
    title: 'Get scout form config',
    description:
      'The current QRScout-compatible config for one scouting form: its sections, fields, and revision.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: { form: formArg },
      required: ['form'],
      additionalProperties: false,
    },
    visible: (manifest) => (manifest.scoutConfigForms?.length ?? 0) > 0,
    async run(args, ctx) {
      const form = requireScoutConfigForm(ctx, args);
      const config = await readScoutConfig(ctx, form);
      return { form, config };
    },
  },
  {
    name: 'update_scout_config',
    title: 'Update scout form config',
    description:
      'Replace one scouting form\'s config with the given sections and fields. Read the current ' +
      'config first with get_scout_config and edit that, rather than building one from scratch: a ' +
      'select choice you drop from `choices` is automatically retired (kept so an already-captured ' +
      'answer still resolves) rather than deleted, and the written revision is stamped one above ' +
      'whatever is currently live so every device adopts the edit.',
    scope: 'spectrum:write',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        form: formArg,
        config: {
          type: 'object',
          description:
            'Full config: {title, page_title?, delimiter?, sections: [{name, fields: [...]}]}. ' +
            'Omit revision; it is computed.',
        },
      },
      required: ['form', 'config'],
      additionalProperties: false,
    },
    visible: (manifest) => (manifest.scoutConfigForms?.length ?? 0) > 0,
    async run(args, ctx) {
      const form = requireScoutConfigForm(ctx, args);
      const incoming = args.config;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new ToolError('"config" must be an object.');
      }
      const invalid = validateScoutConfig(incoming as ScoutConfigDoc);
      if (invalid) throw new ToolError(invalid);

      const existing = await readScoutConfig(ctx, form);
      const reconciled = reconcileScoutConfig(incoming as ScoutConfigDoc, existing);
      await ctx.firestore.patchDocument(APP_CONFIG_COLLECTION, form, toFields(reconciled));
      return { form, config: reconciled };
    },
  },
];

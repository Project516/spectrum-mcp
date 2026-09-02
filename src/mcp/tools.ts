// The tool surface. Tools are generic over the manifest's collections rather
// than one tool per data shape, so a change to a scout entry's fields does not
// change this file, and the SpectrumPit deployment reuses all of it.
import { collectionSpec, type AppManifest } from '../apps/index.js';
import { Firestore } from '../firebase.js';
import { documentId, fieldsToJson, toFields, toValue } from '../firestore-values.js';

export interface ToolContext {
  manifest: AppManifest;
  firestore: Firestore;
  uid: string;
  email?: string;
  scopes: string[];
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  scope: 'spectrum:read' | 'spectrum:write';
  readOnlyHint: boolean;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  // Whether this deployment's manifest offers this tool at all, for
  // tools/list. Absent means every deployment does. A tool bound to
  // something a manifest may omit (the scout-config tools, bound to
  // `scoutConfigForms`) still refuses safely from `run` if called anyway --
  // this only keeps it out of discovery for a deployment that has none.
  visible?(manifest: AppManifest): boolean;
}

class ToolError extends Error {}

function requireCollection(ctx: ToolContext, args: Record<string, unknown>, forWrite: boolean) {
  const name = String(args.collection ?? '');
  const spec = collectionSpec(ctx.manifest, name);
  if (!spec) {
    throw new ToolError(
      `Unknown collection "${name}". Call list_collections to see what this server exposes.`,
    );
  }
  if (forWrite && !spec.writable) {
    throw new ToolError(`The ${name} collection is read-only through this server.`);
  }
  return spec;
}

const OPERATORS: Record<string, string> = {
  '==': 'EQUAL',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  'array-contains': 'ARRAY_CONTAINS',
  in: 'IN',
};

const collectionArg = {
  type: 'string',
  description: 'Collection name, from list_collections.',
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'whoami',
    title: 'Who am I',
    description:
      'The account this server is acting as, and the roles it holds. Call this first when a permission question comes up: the roles decide what every other tool can do.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      let roles: unknown = null;
      try {
        const doc = (await ctx.firestore.getDocument('userProfiles', ctx.uid)) as {
          fields?: Record<string, Record<string, unknown>>;
        };
        roles = fieldsToJson(doc.fields ?? {}).roles ?? [];
      } catch {
        // A missing or unreadable profile means no role has been granted yet.
        roles = [];
      }
      return { uid: ctx.uid, email: ctx.email ?? null, roles, app: ctx.manifest.key };
    },
  },
  {
    name: 'list_collections',
    title: 'List collections',
    description:
      'Every collection this server exposes, what it holds, and whether it can be written.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      return { collections: ctx.manifest.collections };
    },
  },
  {
    name: 'get_document',
    title: 'Get document',
    description: 'One document by collection and id.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: { collection: collectionArg, id: { type: 'string' } },
      required: ['collection', 'id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const spec = requireCollection(ctx, args, false);
      const doc = (await ctx.firestore.getDocument(spec.name, String(args.id))) as {
        name: string;
        fields?: Record<string, Record<string, unknown>>;
      };
      return { id: documentId(doc.name), data: fieldsToJson(doc.fields ?? {}) };
    },
  },
  {
    name: 'query_collection',
    title: 'Query collection',
    description:
      'Documents from one collection, optionally filtered and ordered. Filters are field/operator/value triples combined with AND, matching Firestore query semantics.',
    scope: 'spectrum:read',
    readOnlyHint: true,
    inputSchema: {
      type: 'object',
      properties: {
        collection: collectionArg,
        filters: {
          type: 'array',
          description: 'AND-combined field filters.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: Object.keys(OPERATORS) },
              value: {
                description: 'String, number, boolean, or array for the "in" operator.',
              },
            },
            required: ['field', 'op', 'value'],
            additionalProperties: false,
          },
        },
        orderBy: { type: 'string', description: 'Field to sort on.' },
        descending: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: ['collection'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const spec = requireCollection(ctx, args, false);
      const filters = (args.filters as { field: string; op: string; value: unknown }[]) ?? [];
      const where =
        filters.length === 0
          ? undefined
          : {
              compositeFilter: {
                op: 'AND',
                filters: filters.map((f) => {
                  const op = OPERATORS[f.op];
                  if (!op) throw new ToolError(`Unsupported operator "${f.op}".`);
                  return {
                    fieldFilter: {
                      field: { fieldPath: f.field },
                      op,
                      value: toValue(f.value),
                    },
                  };
                }),
              },
            };
      const result = (await ctx.firestore.runQuery({
        structuredQuery: {
          from: [{ collectionId: spec.name }],
          ...(where ? { where } : {}),
          ...(args.orderBy
            ? {
                orderBy: [
                  {
                    field: { fieldPath: String(args.orderBy) },
                    direction: args.descending ? 'DESCENDING' : 'ASCENDING',
                  },
                ],
              }
            : {}),
          limit: Math.min(Number(args.limit ?? 50), 200),
        },
      })) as { document?: { name: string; fields?: Record<string, Record<string, unknown>> } }[];
      const documents = result
        .filter((row) => row.document)
        .map((row) => ({
          id: documentId(row.document!.name),
          data: fieldsToJson(row.document!.fields ?? {}),
        }));
      return { count: documents.length, documents };
    },
  },
  {
    name: 'create_document',
    title: 'Create document',
    description:
      'Add a document to a writable collection. Most collections require authorUid to equal your own uid; call whoami for it. Read an existing document first to match the field shape.',
    scope: 'spectrum:write',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        collection: collectionArg,
        id: { type: 'string', description: 'Document id. Omit to generate a uuid.' },
        data: { type: 'object', description: 'Full document body as plain JSON.' },
      },
      required: ['collection', 'data'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const spec = requireCollection(ctx, args, true);
      const id = String(args.id ?? crypto.randomUUID());
      const doc = (await ctx.firestore.createDocument(
        spec.name,
        id,
        toFields(args.data as object),
      )) as { name: string; fields?: Record<string, Record<string, unknown>> };
      return { id: documentId(doc.name), data: fieldsToJson(doc.fields ?? {}) };
    },
  },
  {
    name: 'update_document',
    title: 'Update document',
    description:
      'Change named fields on an existing document. Only the fields you send are touched. Rules keep authorUid immutable and require updatedAt to move forward.',
    scope: 'spectrum:write',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: {
        collection: collectionArg,
        id: { type: 'string' },
        data: { type: 'object', description: 'The fields to change, as plain JSON.' },
      },
      required: ['collection', 'id', 'data'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const spec = requireCollection(ctx, args, true);
      const doc = (await ctx.firestore.patchDocument(
        spec.name,
        String(args.id),
        toFields(args.data as object),
      )) as { name: string; fields?: Record<string, Record<string, unknown>> };
      return { id: documentId(doc.name), data: fieldsToJson(doc.fields ?? {}) };
    },
  },
  {
    name: 'delete_document',
    title: 'Delete document',
    description: 'Remove a document. Not reversible; confirm with the user first.',
    scope: 'spectrum:write',
    readOnlyHint: false,
    inputSchema: {
      type: 'object',
      properties: { collection: collectionArg, id: { type: 'string' } },
      required: ['collection', 'id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const spec = requireCollection(ctx, args, true);
      await ctx.firestore.deleteDocument(spec.name, String(args.id));
      return { deleted: true, collection: spec.name, id: args.id };
    },
  },
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export { ToolError };

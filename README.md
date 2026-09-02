# spectrum-mcp

An MCP server that lets an AI agent read and edit the Spectrum app databases as
a specific person, with that person's permissions.

It is a Cloudflare Worker that plays two roles at once: the OAuth 2.1
authorization server an MCP client signs in against, and the MCP resource
server the client then talks to. It targets the Model Context Protocol
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
revision.

One codebase, two deployments: `spectrum-mcp-strategy` serves
[SpectrumStrategy](https://github.com/Spectrum3847/SpectrumStrategy) and
`spectrum-mcp-pit` serves
[SpectrumPit](https://github.com/Spectrum3847/SpectrumPit). The only difference
is the manifest in `src/apps/` and the deployment variables.

## The part that matters

**The server holds no service account.** A user signs in with the same Google
account they use in the app; the server trades that for a Firebase session and
makes every Firestore call carrying that user's ID token. `firestore.rules`
decides what happens next, exactly as it does for the app itself.

So there is no second copy of the role model here, and no credential that could
read the whole team's data. A scouter's agent can read the database and edit
that scouter's own entries. A strategy lead's agent can do what a strategy lead
can do. If the rules say no, the tool returns the refusal as its answer.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `whoami` | `spectrum:read` | The account being acted as, and its roles |
| `list_collections` | `spectrum:read` | What this deployment exposes, and what is writable |
| `get_document` | `spectrum:read` | One document by collection and id |
| `query_collection` | `spectrum:read` | Filtered, ordered, limited reads |
| `create_document` | `spectrum:write` | Add a document to a writable collection |
| `update_document` | `spectrum:write` | Change named fields on a document |
| `delete_document` | `spectrum:write` | Remove a document |

The tools are generic over the manifest rather than one tool per data shape, so
a change to what a scout entry contains does not change this repo, and the pit
deployment reuses all of it.

A client gets `spectrum:read` by default and is challenged for
`spectrum:write` the first time it calls a write tool, so read-only agents
never hold write access.

## Connecting a client

Point any MCP client that speaks OAuth at the server URL:

```
https://spectrum-mcp-strategy.spectrum-3847.workers.dev/mcp
```

In Claude Code: `claude mcp add --transport http spectrum <url>`, then run
`/mcp` and sign in. The browser shows which client is asking and what it wants
before anything reaches Google.

## Setting it up

`docs/setup.md` has the one-time console steps: the Google OAuth client, the
Cloudflare KV namespace, the secrets, and the deploy.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev            # local worker at 127.0.0.1:8787
pnpm deploy         # strategy
pnpm deploy --env pit
```

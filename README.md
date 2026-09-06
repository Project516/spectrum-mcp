# spectrum-mcp

An MCP server that lets an AI agent read and edit the Spectrum app databases as
a specific person, with that person's permissions.

It is a Cloudflare Worker that plays two roles at once: the OAuth 2.1
authorization server an MCP client signs in against, and the MCP resource
server the client then talks to. It targets the Model Context Protocol
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
revision.

One codebase, two deployments: `spectrum-mcp-strategy` serves
[SpectrumStrategy](https://github.com/Spectrum3847/spectrum-strategy) and
`spectrum-mcp-pit` serves
[SpectrumPit](https://github.com/Spectrum3847/spectrum-pit). The only difference
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
| `get_scout_config` | `spectrum:read` | A scouting form's current config (SpectrumStrategy only) |
| `update_scout_config` | `spectrum:write` | Replace a scouting form's config, retiring dropped choices and stamping its revision (SpectrumStrategy only) |

`get_scout_config`/`update_scout_config` exist because the scouting form
configs (`appConfig/scoutConfig`, `prescoutConfig`, `pitScoutConfig`) have
edit rules the generic document tools do not know: a removed select choice
has to be retired rather than deleted, since an already-captured answer still
has to resolve against it, and an edit has to carry a revision above whatever
is already live or no device adopts it. `update_scout_config` applies both
before writing; `create_document`/`update_document` would silently skip
them. They only appear in `tools/list` for a deployment whose manifest names
scout config forms (SpectrumStrategy; SpectrumPit has none).

Most tools are generic over the manifest rather than one tool per data shape,
so a change to what a scout entry contains does not change this repo, and the
pit deployment reuses all of it. `get_scout_config`/`update_scout_config` are
the one exception, earned by the edit rules above.

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

`docs/usage.md` covers the first call, reading and writing, the step-up to
`spectrum:write`, and the scout-config tools in more detail.

## The HTTP API

Not every caller can run an interactive OAuth flow. A CI script, a webhook or
a scoreboard on a pit TV wants a credential it can put in a config file, so
each person can mint API keys for themselves at:

```
https://spectrum-mcp-strategy.spectrum-3847.workers.dev/keys
```

Sign in with Google, name a key, and choose whether it may write. The key is
shown once and stored only as a hash, so a lost one is replaced rather than
recovered. The same page revokes them.

**A key is not a second way in.** It is a handle on exactly what an OAuth
grant holds, one person's Firebase session, so a key does what its owner can
do in the app and nothing more. That is also why minting one requires signing
in first.

Send it as a bearer token, against either endpoint:

```bash
KEY=ssk_...
BASE=https://spectrum-mcp-strategy.spectrum-3847.workers.dev

curl -H "authorization: Bearer $KEY" $BASE/v1/whoami
curl -H "authorization: Bearer $KEY" "$BASE/v1/scoutEntries?limit=5"
curl -H "authorization: Bearer $KEY" $BASE/v1/scoutEntries/entry-id

curl -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"filters":[{"field":"teamNumber","op":"==","value":3847}],"limit":20}' \
  $BASE/v1/scoutEntries/query
```

A create and an update both take the document itself as the body, so the two
read the same way. An explicit id goes in the query string, which leaves the
body free to have a field called `id`:

```bash
curl -X POST -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"teamNumber":3847,"authorUid":"your-uid"}' "$BASE/v1/scoutEntries?id=my-id"

curl -X PATCH -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"teamNumber":254}' $BASE/v1/scoutEntries/my-id
```

| Route | What it does |
|---|---|
| `GET /v1/whoami` | The account the key acts as, and its roles |
| `GET /v1/collections` | What this deployment exposes, and what is writable |
| `GET /v1/{collection}` | Documents, with `limit`, `orderBy` and `descending` |
| `POST /v1/{collection}/query` | Filtered reads, filters in the body |
| `GET /v1/{collection}/{id}` | One document |
| `POST /v1/{collection}` | Create; the body is the document, `?id=` to choose the id |
| `PATCH /v1/{collection}/{id}` | Change only the fields in the body |
| `DELETE /v1/{collection}/{id}` | Remove a document |
| `GET /v1/tools` | Every tool, with its scope and input schema |
| `POST /v1/tools/{name}` | Call any tool directly, arguments in the body |

Every route resolves to the same tool the MCP endpoint calls, so the two
cannot answer the same question differently. `POST /v1/tools/{name}` is how
the scout-config and TBA/Statbotics tools are reached, since they have no
resource route.

A refusal from `firestore.rules` comes back as `403` with the refusal as its
message: that is the answer, not a fault. A key without `spectrum:write` gets
`403` naming the scope it would need.

A key also authenticates the `/mcp` endpoint, for an MCP client that cannot
run the browser flow.

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

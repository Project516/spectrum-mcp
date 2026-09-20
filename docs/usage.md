# Using the server

`docs/setup.md` covers the one-time console work. This is for someone who
already has a deployment running and wants to connect a client and use it.

## Connect

```bash
claude mcp add --transport http spectrum-strategy https://spectrum-mcp-strategy.spectrum-3847.workers.dev/mcp
claude mcp add --transport http spectrum-pit https://spectrum-mcp-pit.spectrum-3847.workers.dev/mcp
```

Then `/mcp`, pick the server, and sign in with the same Google account you
use in the app. The browser shows which client is asking before anything
reaches Google.

Any other MCP client that speaks OAuth 2.1 and Client ID Metadata Documents
works the same way: point it at the `/mcp` URL and let it discover the rest
from `/.well-known/oauth-protected-resource/mcp`.

## When the caller cannot sign in

A CI script, a webhook or a pit-TV scoreboard has no browser to run the flow
in. Mint an API key for yourself at `<url>/keys`, and send it as
`Authorization: Bearer ssk_...` against either `/mcp` or the plain HTTP
routes under `/v1`. The key acts as you and nothing more, which is why the
page makes you sign in before it will issue one.

The README's "The HTTP API" section lists the routes. The same Google OAuth
client and the same `<url>/callback` redirect serve this flow, so there is no
extra console setup.

## First call

Call `whoami` before anything else. It returns your uid, email, and the
roles on your `userProfiles` document:

```json
{ "uid": "…", "email": "you@example.com", "roles": ["strategy"], "app": "strategy" }
```

Empty `roles` means your account has not been promoted past `viewer` in the
app. Every other tool will be refused until an admin promotes it: that is
`firestore.rules` deciding, not this server.

## Reading data

`list_collections` first, so the model knows what this deployment exposes
and which collections are writable before it tries anything. Then
`get_document` for one document by id, or `query_collection` for a filtered,
ordered set:

> "What are 3847's scouting entries for team 254 at 2026txhou?"

becomes roughly:

```json
{
  "collection": "scoutEntries",
  "filters": [
    { "field": "eventKey", "op": "==", "value": "2026txhou" },
    { "field": "teamNumber", "op": "==", "value": 254 }
  ]
}
```

`query_collection` caps at 200 rows and has no cursor yet; a question that
needs more than that needs a narrower filter.

## Writing data

A client gets `spectrum:read` on connect. The first call to a write tool
(`create_document`, `update_document`, `delete_document`) gets a 403 with
`WWW-Authenticate: insufficient_scope`; most clients handle that by
re-running the OAuth flow with `spectrum:write` added and retrying. Approve
that step-up deliberately: it is the moment the agent goes from reading your
data to changing it.

`create_document`/`update_document` write whatever JSON they are given;
`firestore.rules` still applies (an `authorUid` mismatch or an invalid shape
is refused there, not here). `delete_document` is not reversible, so confirm
with whoever is asking before calling it.

## Scout form configs (SpectrumStrategy only)

`scoutConfig`, `prescoutConfig`, and `pitScoutConfig` live in `appConfig` but
have edit rules the generic document tools don't know: a removed select
choice has to be retired rather than deleted (an already-captured answer
still has to resolve against it), and an edit has to carry a revision above
whatever is live or no device adopts it. Use `get_scout_config` and
`update_scout_config` for these three documents; the generic tools refuse
them by name and point back here.

`appConfig`'s other documents, `activeEvent` for example, are plain and go
through `update_document` like anything else.

## Event and team data (SpectrumStrategy only)

Six read-only tools cover official FRC data instead of this team's own
scouting collections: `get_team_epa`, `get_event_teams`, and `get_team_events`
call Statbotics for EPA (no key needed); `get_event_matches`,
`get_team_events_tba`, and `get_event_rankings` call The Blue Alliance for the
schedule and standings. Prefer these over `get_document`/`query_collection`
for anything that is a published number or schedule (EPA, a match score, a
ranking table); use the Firestore tools for what 3847's own scouts recorded.

Each tool validates its arguments before building the outgoing request: a
team number has to be a positive integer (the `frcNNNN` form is built for
you, never accepted as a string), and an event key has to look like
`2026txhou`. There is no argument that lets a caller choose a different host
or path.

The Blue Alliance tools need a key. This server holds none of its own: it
reads the team-shared key out of `appConfig/apiKeys`'s `tba` field as your
signed-in account, the same place the app itself gets it. If your account
cannot read that document, the tool refuses with a message saying so instead
of silently returning nothing -- ask an admin to check the key is set. A
Statbotics or TBA outage comes back the same way, naming which upstream
failed and its HTTP status, not as an empty result.

## Troubleshooting

- **`insufficient_scope` on a read tool**: the token expired or the client
  dropped `spectrum:read` on refresh. Reconnect.
- **A tool call returns a refusal instead of data**: read the message, it is
  `firestore.rules` speaking, not a bug. `whoami`'s roles say what your
  account can do; nothing in this server decides that independently.
- **`Unknown collection`**: call `list_collections`, the manifest differs
  between `strategy` and `pit`.

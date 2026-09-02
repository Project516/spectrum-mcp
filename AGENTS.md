# Agent Guide

This repo is one Cloudflare Worker that exposes the Spectrum app databases over
the Model Context Protocol, targeting the
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
revision. It is deployed twice, once per app, differing only by the manifest in
`src/apps/` and the deployment variables in `wrangler.jsonc`.

## Direction

The point of this server is that an agent gets *a person's* access, never more.
When a tradeoff is unclear, choose the option that keeps authorization in
`firestore.rules` rather than in this code. A feature that needs a service
account, an allowlist of uids, or a role check written in TypeScript is a
feature that has gone wrong: the app's rules already answer that question, and
a second answer here will drift from the first.

## Glossary

- **Manifest**: the per-app list of Firestore collections the tools may touch
  (`src/apps/strategy.ts`, `src/apps/pit.ts`). Bounds the surface and describes
  it to the model. Not a security control.
- **Grant**: the KV record holding the Firebase refresh token this server acts
  through, plus the uid, client and scopes. Keyed by `gid`, which is a claim in
  the access token.
- **Scope**: `spectrum:read` or `spectrum:write`. Coarse on purpose; the fine
  grained decision is the rules'.
- **Step-up**: the 403 + `WWW-Authenticate: insufficient_scope` a read-only
  client gets when it first calls a write tool.
- **CIMD**: Client ID Metadata Document, the preferred client registration
  mechanism in this spec revision. An https URL used as the `client_id`.

## Layout

| Path | What it holds |
|---|---|
| `src/index.ts` | Router: OAuth endpoints, then `/mcp` |
| `src/oauth/` | Authorization server: metadata, authorize, callback, token, register, JWT, KV store |
| `src/mcp/` | JSON-RPC dispatch and the tool definitions |
| `src/mcp/tools.ts` | The generic collection tools (`get_document`, `create_document`, ...) |
| `src/mcp/scout-config-tools.ts` | `get_scout_config`/`update_scout_config`, the one pair of tools that knows a data shape |
| `src/mcp/registry.ts` | Combines the generic and scout-config tool lists; `server.ts` imports from here |
| `src/scout-config.ts` | Scout form config validation and choice-retirement rules, mirroring the app's `ScoutConfig` model |
| `src/firebase.ts` | Google sign-in, token refresh, Firestore REST as the user |
| `src/firestore-values.ts` | The only place Firestore's typed-value shape is translated |
| `src/apps/` | Per-app manifests |
| `test/` | Vitest, no network |

## Working rules

- **Tools are generic over the manifest, except the two that cannot be.**
  `get_scout_config`/`update_scout_config` are the one pair of tools that
  knows a data shape (#1461): a scout form config has edit rules a generic
  document write does not (retire a dropped select choice instead of
  deleting it, stamp a revision above whatever is live) that would need
  reimplementing client-side on every agent otherwise. Reach for a
  shape-specific tool pair only when the same argument applies; a plain
  read/write is still the generic tools' job.
- **Every leg of the authorization flow is cookie-bound to one browser.**
  `/authorize` sets a per-request `HttpOnly` cookie and stores its hash on the
  pending record; consent and callback both check it. Without that, an attacker
  who starts a flow with their own PKCE challenge can hand a victim the consent
  link and collect a code minted for the victim's account, which PKCE does not
  prevent. Do not add a leg that trusts the state key alone.
- **No service account, ever.** Every Firestore call carries the signed-in
  user's ID token. If a change needs privileged access, it does not belong here.
- **No role logic in this repo.** Do not read `userProfiles.roles` to decide
  whether to allow something. `whoami` reports roles so the model can explain
  itself; that is the only reason it reads them.
- Adding a collection is a manifest edit and nothing else. Check the app's
  `firestore.rules` first: a collection with no read rule for members will only
  produce refusals.
- Secrets come from `wrangler secret put`, never from `wrangler.jsonc`. CI
  holds only `CLOUDFLARE_API_TOKEN`; the Worker's own four secrets are set
  once per deployment and CI never sees them.
- `RESOURCE` must equal the deployed URL exactly. It is the token audience, so
  a mismatch rejects every request. The account's workers.dev subdomain is
  `spectrum-3847`.
- Tests must not hit the network. Fake the `Firestore` object, as `test/mcp.test.ts` does.
- Never push to `main`. Everything lands through a PR.
- No emojis anywhere.

## Commands

```bash
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest
pnpm dev
pnpm deploy        # strategy, normally CI's job
pnpm deploy --env pit
```

A push to `main` deploys both Workers through `.github/workflows/deploy.yml`,
after re-running typecheck and tests. Deploy by hand only to recover from a
failed run: a hand deploy from a dirty tree puts something in production that
no commit describes.

## Spec notes worth keeping

- Access tokens are audience-bound to `RESOURCE` (RFC 8707) and rejected
  otherwise. That is what stops a token minted for another MCP server from
  being replayed here.
- The `/authorize` consent page is not decoration: this server is itself an
  OAuth client of Google, so without it a user with a live Google session
  could be walked through the whole flow without ever seeing which MCP client
  was asking.
- Authorization codes and refresh tokens are single use: the store deletes the
  record as it reads it. KV offers no compare-and-swap, so this is a read
  followed by a delete and not an atomic swap. A replay has to land inside that
  window *and* already hold the PKCE verifier or the rotated refresh token, so
  the residual race buys an attacker nothing they did not already have. Moving
  these records to a Durable Object is the fix if that ever stops being true.
- RFC 9728 puts the resource path after the well-known segment, so the metadata
  for a server at `/mcp` lives at
  `/.well-known/oauth-protected-resource/mcp`. Both that and the bare path are
  served.

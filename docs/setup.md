# Setting up a deployment

One-time steps. Everything here needs a console a script cannot reach, so it is
written for a person. Do it once per app (`strategy`, `pit`).

Throughout, `<app>` is `strategy` or `pit`, and `<url>` is the Worker URL, for
example `https://spectrum-mcp-strategy.spectrum-3847.workers.dev`.

## 1. Cloudflare: KV namespace and Worker name

Both namespaces already exist on the account that runs the apps'
`spectrumstrategy-photos` and `spectrumpit-photos` Workers, and their ids are
committed in `wrangler.jsonc` (a KV namespace id is not a secret). Only a new
deployment needs a new one:

```bash
pnpm exec wrangler kv namespace create STORE
```

Put the returned id into `wrangler.jsonc`, in the top-level `kv_namespaces`
for strategy or under `env.pit.kv_namespaces` for pit.

Deploying needs an authenticated wrangler, either `pnpm exec wrangler login`
in a browser or a `CLOUDFLARE_API_TOKEN` in the environment. Deploy once to
claim the URL:

```bash
pnpm deploy              # strategy
pnpm deploy --env pit    # pit
```

Then set `RESOURCE` in `wrangler.jsonc` to `<url>/mcp` if the deployed URL
differs from what is committed, and deploy again. `RESOURCE` must match the
real URL exactly: it is the token audience, and a mismatch rejects every
request.

## 2. Google Cloud: an OAuth web client

This is how the server learns who the user is. In the Google Cloud console for
the app's Firebase project (`frcspectrumstrategy` for strategy, `spectrumpit`
for pit):

1. APIs and Services, Credentials, Create credentials, OAuth client ID.
2. Application type: Web application. Name it `spectrum-mcp-<app>`.
3. Authorized redirect URIs: add `<url>/callback`. Nothing else.
4. Save, and keep the client ID and client secret for step 4.

The OAuth consent screen is already configured for these projects. If the
project is in testing mode, add each user who will connect an agent as a test
user, or publish the consent screen.

## 3. Firebase: confirm the Web API key

The server calls `identitytoolkit` and `securetoken` with the project's Web API
key, the same one the app uses. Firebase console, Project settings, General,
Web API key. It is not a secret in the usual sense (it ships in the app) but it
is set as a Worker secret so it stays out of the repo.

## 4. Worker secrets

```bash
pnpm exec wrangler secret put GOOGLE_CLIENT_ID       # from step 2
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET   # from step 2
pnpm exec wrangler secret put FIREBASE_API_KEY       # from step 3
pnpm exec wrangler secret put TOKEN_SIGNING_KEY      # see below
```

Add `--env pit` to each for the pit deployment; the two have separate secrets.

Generate the signing key with `openssl rand -base64 48`. It signs this server's
own access tokens. Rotating it invalidates every issued token, which is the
revocation lever: everyone reconnects, nobody loses data.

## 5. Check it

```bash
curl <url>/.well-known/oauth-protected-resource/mcp
curl -i <url>/mcp -X POST
```

The first returns the resource metadata naming the Worker as its own
authorization server. The second returns `401` with a `WWW-Authenticate` header
pointing back at that document. That pair is the whole discovery handshake.

Then connect a real client:

```bash
claude mcp add --transport http spectrum-<app> <url>/mcp
```

Run `/mcp`, sign in, and call `whoami`. It should report your uid, your email,
and the roles from your `userProfiles` document. If `roles` comes back empty,
your account has not been promoted past `viewer` in the app, and every other
tool will be refused until an admin promotes it.

## Revoking access

- One person: rotating `TOKEN_SIGNING_KEY` disconnects everyone, which is
  blunt but immediate. For one person, remove their roles in the app's user
  management screen; the rules then refuse everything regardless of the token.
- Everyone: rotate `TOKEN_SIGNING_KEY`.
- One client: there is no per-client revoke yet. Grants expire 30 days after
  their last refresh.

---
name: eden
description: Deploy, update, check, or remove a Vercel Eve agent on the user's own Cloudflare account with the Eden CLI. Use when someone wants to run an Eve project off Vercel, check whether an Eve project is ready for Cloudflare, ship a change to an Eden deployment, upgrade Eve on one, or tear one down.
---

# Eden: run an Eve agent on Cloudflare

Eden (`@moinulmoin/eden`) builds an existing Eve project as-is and runs it in a
Cloudflare Container behind a Worker on the user's own account. It never
rewrites the project; you make any needed changes yourself, guided by
preflight. Where this guide and the notes `eve init` prints disagree (for
example its advice to use Vercel Connect), follow this guide: those notes
target Vercel.

`npx @moinulmoin/eden skill` prints this guide for the installed CLI version.
Docs: https://github.com/moinulmoin/eden (failure and warning codes:
`docs/troubleshooting.md`).

## The loop

1. Check the machine and account (below).
2. Write the env file (below).
3. Run preflight and read the JSON:

   ```sh
   npx @moinulmoin/eden preflight --env-file ~/.config/<agent>/preview.env --json
   ```

   Preflight builds and boots the agent locally and checks Cloudflare access.
   It changes nothing on Cloudflare. Before it builds, it reports every
   setup problem it can see (env file, Eve version, sandbox, Cloudflare
   login, and the warnings) in one run. It prints one JSON object:
   `ok`, `checks[]` (`id`, `status`, `message`, `remediation`) and
   `warnings[]` (`id`, `message`, `remediation`).
4. Fix every failed check, then every warning, using its `remediation`. Re-run
   until `ok` is `true` and no warning applies. A warning does not block a
   deploy, but each one names something that breaks or loses data on
   Cloudflare; only leave one if the user accepts that.
5. A clean preflight means the project can run on Cloudflare. It does not
   check that keys are real: before deploying, make sure the user has replaced
   every placeholder secret in the env file.
6. Deploy, then verify with a real message (below). Confirm with the user
   first for production.

## Machine and account

- macOS or Linux, Node `^24.22.0 || ^26.12.0` (any other
  stops with `EVE_NODE_UNSUPPORTED`)
- Docker or OrbStack running, with linux/amd64 support
- Cloudflare Workers Paid plan (Containers need it), and Cloudflare's `cf`
  CLI signed in: `npx cf@1.0.0-rc.2 auth login` (the user must do this in a
  browser), or `CLOUDFLARE_API_TOKEN` set. `cf` does not read a Wrangler
  login, which Eden 0.14 and earlier used.

## Project setup Cloudflare needs

These are what preflight checks most often. Fix them before the first run to
save a build. For a fresh `eve init` project, run
`npm install just-bash @moinulmoin/eden-world-cloudflare`, then make the
sandbox, channel auth, and durable state edits below.

- **Eve floor.** `preflight` and `deploy` require Eve `>=0.91.0`; older
  projects fail with `EVE_VERSION_UNSUPPORTED`. Existing deployments keep
  running, and `destroy` still works. To redeploy an older project unchanged,
  use `npx @moinulmoin/eden@0.11.5 deploy` with the same `--project`, `--env`,
  `--name`, and `.eden` folder. That CLI is frozen and unmaintained.
  Upgrading Eve instead may strand Postgres-World sessions; see
  [session_stranded](https://github.com/moinulmoin/eden/blob/main/docs/troubleshooting.md#old-sessions-return-session_stranded-after-an-eve-upgrade).
- **One lockfile.** Either a root `package-lock.json`, or an exact
  `"packageManager": "pnpm@x.y.z"` with a root `pnpm-lock.yaml`. Not both, not
  Bun. Dependency install scripts do not run.
- **Sandbox.** Add `just-bash` as a production dependency and select it
  explicitly in `agent/sandbox.ts` (or `agent/sandbox/sandbox.ts` if an
  `agent/sandbox/` folder exists):

  ```ts
  import { defineSandbox } from 'eve/sandbox';
  import { JustBashSandbox } from 'eve/sandbox/just-bash';

  export const environment = JustBashSandbox.environment();
  export default defineSandbox(() => environment.open());
  ```

  Vercel Sandbox, Docker, and other providers do not run on Eden.
- **Channel auth (`EVE_AUTH_SCAFFOLD`).** The `eve init` auth in
  `agent/channels/eve.ts` (`vercelOidc()`, `localDev()`, `placeholderAuth()`)
  rejects every Cloudflare caller with 401. Replace it with a real
  authenticator, for example a bearer token read from the env file. Keep
  `localDev()` so `eve dev` still works locally. Never set `EVE_DEV`,
  `VERCEL`, `VERCEL_ENV`, or `VERCEL_TARGET_ENV` in the deployment env file:
  they switch Eve into development mode and can let unauthenticated callers
  in. Eden rejects these names with `EVE_ENV_RESERVED_VARIABLE`:

  ```ts
  import { localDev, type AuthFn } from "eve/channels/auth";
  import { eveChannel } from "eve/channels/eve";

  const authenticate: AuthFn<Request> = (request) => {
    const expected = process.env.AGENT_AUTH_TOKEN;
    if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
      return null;
    }
    return {
      attributes: {},
      authenticator: "bearer-token",
      principalId: "app-client",
      principalType: "app",
    };
  };

  export default eveChannel({ auth: [authenticate, localDev()] });
  ```

- **Model key (`EVE_AI_GATEWAY_KEY_MISSING`).** A string model such as
  `"openai/gpt-5"` goes through Vercel AI Gateway. On Vercel that
  authenticates automatically; on Cloudflare it needs `AI_GATEWAY_API_KEY` in
  the env file. A direct provider such as `openai("…")` from `@ai-sdk/openai`
  needs that provider's key instead.
- **Vercel Connect (`EVE_VERCEL_CONNECT`).** `connect()` from
  `@vercel/connect/eve` gets credentials using an identity only Vercel
  provides, so those connections fail on Cloudflare. Put the service's own key
  or bot token in the env file and replace `connect(...)` in the connection
  with `auth: { getToken: async () => ({ token: process.env.SERVICE_TOKEN! }) }`.
  For per-user sign-in, use `defineInteractiveAuthorization` from
  `eve/connections` with your own OAuth app. Having `@vercel/connect` in
  `package.json` without importing it is fine.
- **Durable state (`EVE_WORLD_LOCAL`).** The default local Workflow World loses
  sessions and pending approvals on every update. Use one of:
  - `@moinulmoin/eden-world-cloudflare`: no database; sessions also survive Eve
    upgrades. Add it as a production dependency and set in `agent/agent.ts`:

    ```ts
    experimental: { workflow: { world: "@moinulmoin/eden-world-cloudflare" } },
    ```

  - `@workflow/world-postgres` with a direct, unpooled Postgres URL in the env
    file.

## Env file and secrets

- Lives **outside the project**, mode 600, for example
  `~/.config/<agent>/preview.env`. Passed with `--env-file`.
- Exactly `KEY=value` per line: no quotes (they become part of the value), no
  spaces around the name, `#` comment lines allowed.
- Holds the model key and every secret the agent reads (auth token, service
  keys, database URL).
- Never print, log, or commit it, and never pass a secret as a command
  argument. Ask the user to fill in values you do not have.

## Commands

```sh
# deploy to preview; the name is derived from package.json plus a short
# suffix, so keep the exact `name` the result prints
npx @moinulmoin/eden deploy --env-file ~/.config/<agent>/preview.env --json

# ship a change: the same command updates in place, on the same URL
npx @moinulmoin/eden deploy --env-file ~/.config/<agent>/preview.env --json

# production always needs an explicit --name
npx @moinulmoin/eden deploy --env production --name <name> --env-file <file> --json

# remove one target (always needs the exact --name deploy printed;
# add --env production for a production target)
npx @moinulmoin/eden destroy --name <name> --json
```

- `--project <dir>` selects a project other than the current directory.
- A fresh deploy takes a few minutes, mostly building the container. Read
  `ok`, `warnings`, `name`, and `deployment.stableWorkersDevOrigin` (the live
  URL) from the result.
- An `eve init` project's `npm run deploy` script still deploys to Vercel, not
  Eden.
- Eden writes build output and deployment records to `.eden/` in the project.
  Do not commit it (one build was 245 MB in a test, and it records absolute
  local paths): add `.eden` to the project's `.gitignore`. Never delete it.
  Updates and `destroy` need this folder. Run them from the project root
  that holds it, or select that root with `--project`. If it is lost, follow
  "The `.eden/` folder is lost" in
  `docs/troubleshooting.md`.
- Get the user's explicit go-ahead before any `destroy` or production deploy;
  a request that already says to tear the agent down counts. Destroy deletes
  the agent immediately, even mid-conversation, and with the Cloudflare World
  also its stored sessions. An external Postgres database is not touched.
- A successful `destroy` may carry `warnings` with
  [`EVE_REGISTRY_OBJECTS_KEPT`](https://github.com/moinulmoin/eden/blob/main/docs/troubleshooting.md#eve_registry_objects_kept).
  Cloudflare's registry keeps some objects
  after Eden tries to delete everything it lists. `registryObjectsKept` has one
  `{ ref, class }` per object. `refused-snapshot`: a container snapshot,
  which still holds the agent's files; Cloudflare documents that it removes
  one 30 days after it was created or last restored. `refused-singleton-artifact`:
  an artifact Cloudflare makes for each image. `accepted-still-listed`: a
  manifest whose delete Cloudflare's registry accepted and which it still
  listed at least 30 seconds later. Tell the user what is listed and that
  Eden does not know when Cloudflare removes the last two kinds. Destroy
  has finished; do not rerun it for these.
  `deploy` can carry the same warning and field after it removes a
  superseded version. A same-version update deletes the image it
  replaced by its tag; if that cannot be shown, deploy still succeeds with
  the warning `EVE_SUPERSEDED_IMAGE_NOT_DELETED`. Do not redeploy for it:
  a later deploy does not try again; destroy tries to remove the image
  and reports anything Cloudflare keeps. Cleanup needs direct access to `registry.cloudflare.com`;
  Eden's own registry requests never use a proxy. If destroy fails to verify
  registry cleanup, it may already have removed the Worker and Container.

## Verify

Health only proves the server started; it needs no auth:

```sh
curl -s https://<url>/eve/v1/health   # expect "status":"ready"
```

Then prove auth, the model key, and the agent work with a real message, using
the channel's credential (the bearer token from the env file). Load it into
the shell without printing it:

```sh
AGENT_AUTH_TOKEN="$(sed -n 's/^AGENT_AUTH_TOKEN=//p' ~/.config/<agent>/preview.env)"
curl -s -X POST https://<url>/eve/v1/session \
  -H "Authorization: Bearer $AGENT_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Reply with one word: ready"}'
# {"ok":true,"sessionId":"wrun_…"}; then read the reply:
curl -s -N https://<url>/eve/v1/session/<sessionId>/stream \
  -H "Authorization: Bearer $AGENT_AUTH_TOKEN"
```

The stream is one JSON event per line. The answer is the
`content.completed` event whose `data` has `"phase":"reply"`; its `value` is
the text. Reasoning events come first. Stop reading at the `turn.settled`
event: the stream keeps sending heartbeats after it. The first request after
the agent sleeps takes about 10–15 seconds.

## Upgrading Eve

- Bump `eve`, then reinstall so the lockfile matches. Keep
  `@moinulmoin/eden-world-cloudflare` on its latest version.
- Moving an `eve init` project to Eve `1.0` also needs `@vercel/connect`
  `2.7.0` or later; otherwise npm fails with `ERESOLVE`.
- Then deploy as usual. With the current Cloudflare World, existing sessions
  continue on the new version. With the Postgres World or an older Cloudflare
  World they return HTTP 409 `session_stranded` and users start new ones.

## Limits to tell the user

- The sandbox is `just-bash`, a simulated shell: files, grep, sed, jq,
  sqlite3, and curl work; python, git, and npm do not.
- One container per kept version, `workers.dev` URL only, no custom domains yet.
- The container sleeps after 1 hour idle and wakes on the next request.
  Standard 5-field cron schedules still fire while it sleeps; other cron forms
  only fire while it is awake (`EVE_SCHEDULE_UNSUPPORTED`).

## When something fails

- `--json` prints one object even when the command fails. Read `error.code`
  and `error.remediation`, or the first failed check's `remediation`.
  Keep any `deployment` evidence. Resolve the reported cause before retrying;
  a failed run may already have changed remote resources.
- `VAL-CLI-007-TARGET-CONFLICT`: a resource with that name exists that Eden
  cannot prove it owns. For a brand-new agent, pick another `--name`; never
  delete the resource to make room.
- `VAL-CLI-007-CLOUDFLARE-ACCESS`: `cf` is not signed in, its sign-in does
  not show exactly one account, or the account lacks Workers
  Paid/Containers. It is checked before the build. The user has to fix this
  (`npx cf@1.0.0-rc.2 auth login`, then `npx cf@1.0.0-rc.2 auth whoami`),
  or set `CLOUDFLARE_API_TOKEN`.
- `EVE_NODE_UNSUPPORTED`: Node is not 24.22.0 or newer on the 24 line, or
  26.12.0 or newer on the 26 line. Install Node 24 (for example
  `nvm install 24`), then run the command again.
- `EVE_CF_UNAVAILABLE`: the `cf` installed beside Eden is missing or is not
  1.0.0-rc.2. Install `@moinulmoin/eden` again; do not install another `cf`
  over it.
- `VAL-CLI-007-CLOUDFLARE-ACCESS` with `CLOUDFLARE_API_TOKEN` or
  `CLOUDFLARE_ACCOUNT_ID` in its remediation: signing in again does not
  help. Correct or unset the variable it names.
- `VAL-CLI-007-CLOUDFLARE-ACCESS` saying Eden `could not take its login's
  token`, or `EVE_CF_LOGIN_TOKEN_UNAVAILABLE` from destroy: Eden reads
  Cloudflare's API with the token of the `cf` login, which it takes from
  `cf` on `127.0.0.1` for one command. Confirm the login with
  `npx cf@1.0.0-rc.2 auth whoami` and retry, or have the user set
  `CLOUDFLARE_API_TOKEN`, which Eden then uses and asks `cf` for nothing.
- `node: <path>: not found` with exit status 9 and no JSON: the `--env-file`
  path does not exist. `npx` stopped before Eden started. Correct the path.
  With `--` before the package name (`npx -- @moinulmoin/eden preflight
  --env-file <path> --json`), Eden runs and reports `EVE_ENV_FILE_NOT_FOUND`
  in the JSON instead. Under `npx`, a `NODE_OPTIONS` line in the env file is
  also applied to npm's own Node process; one that only works in the
  container stops `npx` with `Cannot find module` unless `--` is used.
- `DEPLOY_INDETERMINATE`: Eden could not prove the result; the old version
  usually keeps serving. Check the URL's health, then retry with the exact
  same `--project`, `--env`, and `--name`. Never switch to a new name to get
  past it, never delete resources by prefix, and never delete the project's
  `.eden/` folder: it is the ownership proof `destroy` needs.
  When the message says Cloudflare has this publish's Worker version but
  its Container application or triggers could not be set up, run
  `eden deploy` again with the same selectors, as the printed remediation
  says. For a target's first deploy the remediation also names
  `eden destroy` as the way to remove it instead. Never delete a Worker
  yourself.
- Look up any other code in `docs/troubleshooting.md`.

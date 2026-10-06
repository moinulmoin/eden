# Deploy an existing Eve project

Eden Deploy takes an existing Eve project directory and runs the real Eve
application on Cloudflare. It does not rewrite the project or replace Eve's
providers, databases, Workflow World, authentication, schedules, channels, or
sandbox.

Start with [installation and account setup](./install.md).

## What Eden deploys

Eden runs the project's own `eve build`, starts the official project-local
`eve start --host 0.0.0.0 --port 8080` supervisor inside one bounded Cloudflare
Container (a `standard-1` instance: 1/2 vCPU, 4 GiB) attached to the Worker's
Durable Object (`scheduling_policy: "durable_object"`), and routes the public
surface through one generic Worker.

Eden owns build orchestration, packaging, publication, deployment identity, and
exact cleanup. Eve remains the application and workflow authority.

## Requirements

Before deploying, confirm:

- `eden --help` starts successfully.
- `npx wrangler@4.147.0 whoami` shows the intended Cloudflare account on the
  Workers Paid plan, which Containers requires.
- Docker or OrbStack is running with Linux/amd64 support.
- The selected Eve root contains `package.json` and `pnpm-lock.yaml`.
- `package.json` has an exact `packageManager: "pnpm@..."` value.
- The matching dependencies are installed and `node_modules/.bin/eve` resolves
  to the project-local Eve package.
- The project declares `just-bash` as a production dependency (Eve `^3.1.0`;
  for example `just-bash: "3.4.2"`). Eve's default sandbox falls back to
  `just-bash` inside Eden's isolated builder, which has no Docker daemon or
  `/dev/kvm`; without the declaration `eve build` fails with
  `Cannot find package 'just-bash'`.
- Every provider, credential, database, external API, and Workflow World
  required by the Eve project is reachable from Cloudflare.

From the Eve project root, these checks should succeed:

```sh
node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).packageManager"
test -f pnpm-lock.yaml
pnpm install --frozen-lockfile
test -x node_modules/.bin/eve
docker version
```

Eden supports pinned pnpm Eve projects in this release. Bun lockfiles and
native Windows are not supported.

## First successful preview deployment

With no flags, `eden deploy` and `eden preflight` use the current directory,
the `preview` environment, and a target name derived deterministically from
the project's `package.json` name. From the Eve project root, `eden deploy`
is sufficient. For an explicit target, use a unique lowercase Worker name and
keep the same selectors for deploy and destroy:

```sh
PROJECT_ROOT="/absolute/path/to/my-eve-project"
ENVIRONMENT="preview"
WORKER_NAME="my-eve-preview-$(date +%s)"
```

Use an absolute project path when following this guide. Eden does not search
parent or sibling directories.

### Optional environment file

If the Eve application needs runtime values, create an owner-readable file
outside the project and outside source control:

```sh
ENV_FILE="$HOME/.config/my-eve-project/preview.env"
mkdir -p "$(dirname "$ENV_FILE")"
chmod 700 "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
```

The file uses `KEY=VALUE` records:

```text
PROJECT_PROVIDER_KEY=replace-with-the-project-owned-value
PROJECT_WORLD_URL=https://example.invalid
```

Use the names required by the Eve project. Do not copy these illustrative names
unless the project actually consumes them.

Eden parses variable names, not secret values. Values flow through the protected
deployment path into the Container environment and Cloudflare secrets. They are
not placed in argv, image layers, generated artifacts, or normal logs.
Reserved host variables such as `HOST`, `PORT`, `NITRO_*`, `NODE_ENV`,
`NODE_EXTRA_CA_CERTS`, and Eden's identity variables are rejected.

### Optional read-only preflight

`deploy` runs every required check inline. Preflight is useful when diagnosing a
project before allowing remote mutation:

```sh
eden preflight \
  --project "$PROJECT_ROOT" \
  --env "$ENVIRONMENT" \
  --name "$WORKER_NAME" \
  --env-file "$ENV_FILE"
```

Omit `--env-file` when the project needs no additional runtime values.
Preflight builds and inspects the candidate but does not publish Cloudflare
resources.

### Deploy

```sh
eden deploy \
  --project "$PROJECT_ROOT" \
  --env "$ENVIRONMENT" \
  --name "$WORKER_NAME" \
  --env-file "$ENV_FILE"
```

Again, omit `--env-file` when it is not needed.

A successful command prints progress lines and a summary ending with the
exact `workers.dev` URL on its own line. Eden promotes the generation only
after the public `/eve/v1/health` route reports the expected ready identity.
Pass `--json` to `preflight`, `deploy`, or `destroy` to print the
machine-readable result object instead, for scripts and CI.

Copy the printed URL:

```sh
DEPLOY_URL="https://replace-with-the-printed-workers-dev-url"
curl --fail --silent "$DEPLOY_URL/eve/v1/health"
```

The response must report `status: "ready"`. Then use the Eve project's normal
public interface to execute one representative request. Health proves startup;
a normal application request proves that the project-owned providers and
services work from the deployed environment.

## Updating an agent

Run `eden deploy` again with the same project, environment, and name. When
Eden's immutable deployment record proves it owns the existing target (same
account, project, and exact Worker and Container names), deploy becomes an
update instead of failing with `VAL-CLI-007-TARGET-CONFLICT`:

1. It builds and boot-checks the new image locally, exactly like a first
   deploy.
2. It pushes the image and republishes the same Worker and Container
   application. Durable Object classes and their migration history are kept
   (new migration tags are only appended), so state stored in the Cloudflare
   World survives.
3. The running Container restarts on the new image. The image is selected at
   container start, so Eden compares the running image against the new
   deployment's and stops the instance itself when it still serves the
   previous image; workspace files do not carry across an update.
4. It health-checks the public URL, promotes the new generation, then deletes
   the previous generation's registry repository (every tag, including
   snapshot tags).

The summary prints `✓ updated <name>` (in `--json`, `deployment.operation` is
`update`). A target that exists but isn't provably Eden's still fails with
`VAL-CLI-007-TARGET-CONFLICT`; production still requires an explicit `--name`.

**In-flight runs resume on the new code.** On Vercel, Workflow pins each run
to the deployment that started it. Off Vercel there's no pinning, so sessions,
pending approvals, and sleeping steps that started before the update continue
on the new code (`EVE_UPDATE_IN_FLIGHT`). Keep step names and input or state
shapes backward-compatible until older runs finish, or let them finish before
a breaking change. Switching Workflow Worlds between deploys is a data
migration: existing state doesn't move with it (`EVE_UPDATE_WORLD_SWITCH`).

With the Postgres World, state lives in your database, so it survives updates
and also `destroy`.

## Exact cleanup

Destroy with the same project, environment, and Worker name:

```sh
eden destroy \
  --project "$PROJECT_ROOT" \
  --env "$ENVIRONMENT" \
  --name "$WORKER_NAME"
```

`destroy` rejects `--env-file`; cleanup does not need application secrets.
Destroy requires Eden's immutable ownership record, checks the current remote
identity, removes only that Worker and Container application, verifies bounded
absence, and only then clears the target's `CURRENT` pointer. It never deletes
by prefix or broad account search.

Destroy also removes the managed-registry image tag
(`eden-eve-<target>-<generation>:candidate` in `registry.cloudflare.com`) for
every generation the ownership records prove this exact target pushed,
including images retained by aborted pushes, then verifies each ref is gone.
Any image left behind is reported in the destroy output with its exact
`repository:tag` ref; remove only the listed refs with
`npx wrangler@4.147.0 containers images delete <repository:tag>` and never
filter by prefix.

After a healthy deployment is promoted, `deploy` also verifies and removes its
exact retained local Docker image and publication tags. The immutable
generation label must match before Eden removes anything. An indeterminate
publication keeps its exact local evidence instead of guessing at cleanup.

Confirm the URL is no longer reachable:

```sh
if curl --fail --silent "$DEPLOY_URL/eve/v1/health"; then
  echo "unexpected: deployment is still reachable" >&2
  exit 1
fi
```

Also compare the Cloudflare Workers list and the Container inventory before and
after the run:

```sh
npx wrangler@4.147.0 containers list
npx wrangler@4.147.0 containers images list
```

Require zero new Worker, Container, or managed-registry image residue
associated with `WORKER_NAME`. An unreachable URL alone is not sufficient
cleanup evidence.

Maintainers validating Eden against the current Eve release should also follow
the [current Eve compatibility runbook](./eve-compatibility.md).

## Preview and production

`--project` defaults to the current directory and `--env` defaults to
`preview`. `--env` accepts `preview` or `production`. `preflight` and
`deploy` derive the target name from `package.json` when `--name` is omitted;
`--env production` and `destroy` always require an explicit `--name`.

Use preview first. Production is a separate explicit target for downstream
users that intentionally operate preview and production deployments. A preview
success does not establish a production SLA.

## Project-owned services and durability

The Eve project's providers, models, credentials, databases, queues, external
APIs, channels, schedules, sandbox, authentication, authorization, and
configured Workflow World remain authoritative. Eden never substitutes a model
provider or service silently.

### Workflow queue routing

Eden returns 404 for public requests to Workflow queue delivery routes
(`/.well-known/workflow/v1/flow` and `/step`). Token-bearing
`webhook/<token>` and `manifest.json` routes remain forwarded to Eve.
The container's own requests to its exact public hostname are intercepted
and delivered back into the same container over the internal port. Other
outbound hosts go directly to the internet without Worker interception.
HTTPS self-origin delivery trusts Cloudflare's runtime-mounted Containers CA.
`WORKFLOW_LOCAL_BASE_URL` remains the public origin, preserving Eve-generated
callback URLs.

A preview deployment that boots Eve's local Workflow World proves health,
startup, and fresh request handling only. Container-local disk now survives
sleep — when the Container has been idle for the sleep window, Eden snapshots
the writable filesystem and stops the instance, and the next request restores
that snapshot — but a restart after an image update starts fresh, so local
World state still reinitializes across an update. Snapshots expire after 30
idle days. Schedules still fire while the Container sleeps (see "Schedules"
below). Durable Object memory always survives sleep and restarts.

Production durability requires a project-configured, Cloudflare-reachable,
durable Eve-compatible Workflow World such as Postgres (for example
`@workflow/world-postgres`). See
[Durable state (Postgres World)](#durable-state-postgres-world) for the exact
tested setup. This release runs one `standard-1` Container instance
(1/2 vCPU, 4 GiB; awake time is billed at 4 GiB, asleep costs nothing) and
does not promise horizontal scaling or custom domains.

## Schedules

Authored Eve schedules (`agent/schedules/*`) keep firing while the Container
sleeps. When `eve build` reports schedules, Eden adds one every-minute
Cloudflare Cron Trigger to the generated Worker. Each minute the Worker
checks whether any schedule's next tick lands within the next four minutes;
when one does it issues an internal wake request to the Container so Eve's
own in-process Nitro scheduler fires the tick itself — each schedule runs
exactly once per cron tick, evaluated in UTC like on Vercel.

Standard 5-field cron expressions (`minute hour day-of-month month
day-of-week`) are supported — the same subset Eve documents and Vercel Cron
evaluates. A schedule using anything else (for example a seconds field or an
`@daily` shortcut) cannot be evaluated ahead of time, so `eden deploy` warns
and that schedule only fires while the Container is already awake.

Because the every-minute trigger exists to wake the Container, a project
with schedules pays one scheduled invocation per minute (~43k/month), which
is well inside the Workers Paid allocation.

For testing sleep behavior, `EDEN_EVE_CONTAINER_SLEEP_AFTER=<duration>`
(for example `90s`) overrides the Container's `sleepAfter` at deploy time.

## Durable state on Cloudflare (no database)

**Experimental.** With Eve `0.68.0`, add `@moinulmoin/eden-world-cloudflare`
to the agent project's production dependencies and select it in `agent.ts`:

```ts
experimental: {
  workflow: { world: "@moinulmoin/eden-world-cloudflare" },
},
```

Eden provisions one SQLite-backed Durable Object on your Cloudflare account.
Workflow state and stream chunks live outside the Container's disposable disk;
queue alarms wake the Container for workflow delivery. No database URL or
external database account is required. Eden supplies `EDEN_WORLD_URL` and
`CBOR_NATIVE_ACCELERATION_DISABLED=true` automatically. The World RPC endpoint
is private to intercepted Container requests; public `/__eden/world/*` requests
return 404.

`eden destroy` permanently deletes this state along with the Worker. It is not
a restart mechanism: preserve the Worker and Durable Object when restarting a
Container. Cloudflare's [Worker deletion contract](https://developers.cloudflare.com/api/typescript/resources/workers/subresources/scripts/methods/delete/)
deletes the Worker's Durable Object namespaces when deleting the whole Worker.

**Updates keep this state.** Running `eden deploy` again on a target Eden owns
updates it in place (see [Updating an agent](#updating-an-agent)): the same
Worker and Durable Object, so stored sessions and pending approvals survive.
Only `eden destroy` deletes them.

**Sleep is snapshot-based.** With this World the container's idle sleep is
driven by a Durable Object alarm: after the sleep window, Eden snapshots the
container's filesystem, stops the instance, and restores the snapshot on the
next request. Memory survives sleep and restarts; the 30-second-sleep live
test left the container running 45 seconds after its last client, so budget
for short awake tails after idle.

## Durable state (Postgres World)

Container-local disk survives sleep via snapshots but not image updates
(an update restarts the container fresh), so Eve's default local Workflow
World still loses pending approvals and in-flight sessions across a
redeploy. Eden has tested the Postgres World
(`@workflow/world-postgres`) end to end: a pending tool approval survived a
full `eden destroy` + `eden deploy` container replacement. This section is
the tested recipe; other durable Worlds are project-owned and untested here.

Any Postgres reachable from Cloudflare works — for example a Neon project or
a Supabase project. Cloudflare itself has no hosted Postgres; the database
is always external.

The connection URL **must be a direct, unpooled connection that supports
`LISTEN`/`NOTIFY`**. The World delivers live session events over Postgres
`LISTEN`/`pg_notify`. Transaction-mode poolers — Neon's `-pooler` host
(PgBouncer) and Supabase's pooler on port 6543 — accept `LISTEN` but never
deliver notifications, so `GET /eve/v1/session/<id>/stream` returns headers
and then hangs forever even though events persist in the database. On Neon
use the `DATABASE_URL_UNPOOLED` value (the host without `-pooler`); on
Supabase use the direct connection on port 5432. Sessions still execute
against a pooled URL — only live streaming silently breaks — so this is
easy to miss; `eden preflight` warns when it sees a pooled URL.

### 1. Add the version-paired dependency

Eve pins and validates its World at `eve build`, so the Postgres World
version must match the `@workflow/world` version your Eve release bundles.
Eve `0.68.0` bundles `@workflow/world` `5.0.0-beta.39` and pairs with:

```sh
pnpm add @workflow/world-postgres@5.0.0-beta.47
```

For other Eve versions, install the `@workflow/world-postgres` release whose
`@workflow/world` dependency matches the one Eve bundles; `eden preflight`
and `eden deploy` fail with an `EVE_WORLD_PAIRING` check when the installed
release would not pair.

### 2. Select the World in `agent.ts`

```ts
export default {
  // …
  experimental: { workflow: { world: "@workflow/world-postgres" } },
};
```

This field is resolved at `eve build`; `WORKFLOW_TARGET_WORLD` is ignored by
the Eve runtime plugin.

### 3. Environment file

Create the `--env-file` **outside the project root** — a file inside the
project is snapshotted into the image and the deploy fails with
`SECRET_EXCLUSION_FAILED`:

```text
WORKFLOW_POSTGRES_URL=postgres://<direct-unpooled-host>/<database>
```

Use the direct URL described above; `WORKFLOW_POSTGRES_URL` falls back to
`DATABASE_URL` when unset. Nothing else is needed: Eden sets
`CBOR_NATIVE_ACCELERATION_DISABLED` in the container image itself, exempts
the optional `cbor-extract` native addon (cbor-x then uses its pure-JS path),
and runs the World's idempotent schema migration (`node_modules/.bin/bootstrap`,
drizzle migrations + graphile-worker schema) inside the disposable deploy
container against the env-file URL before publishing. A migration failure
fails the deploy with `EVE-WORLD_MIGRATION_FAILED`.

### 4. Deploy and verify

```sh
eden deploy --project "$PROJECT_ROOT" --env preview \
  --name "$WORKER_NAME" --env-file "$ENV_FILE"
```

Verify durability, not just health:

```sh
curl --fail --silent "$DEPLOY_URL/eve/v1/health"          # status: "ready"
curl -N "$DEPLOY_URL/eve/v1/session/<id>/stream"          # must emit NDJSON, not just headers
```

Then start a turn that parks on an approval, run `eden destroy` + `eden
deploy`, and confirm the pending approval is still resolvable. If the stream
hangs with headers only, the URL is pooled — fix step 3.

## Common failures

| Symptom | Check |
| --- | --- |
| `eden` is not found | Follow the PATH section in [Install Eden](./install.md). |
| Project or lockfile validation fails | Confirm the selected root, exact pnpm `packageManager`, root lockfile, frozen install, and project-local Eve executable. |
| Docker build cannot start | Start Docker or OrbStack and verify Linux/amd64 support with `docker version`. |
| Cloudflare account or origin resolution fails | Run `npx wrangler@4.147.0 whoami` and confirm the intended account and workers.dev subdomain. |
| Health never reaches ready | Inspect the Eve project's provider, Workflow World, and startup requirements; Eden does not replace them. |
| Destroy refuses cleanup | Preserve the target records and inspect the reported ownership or identity mismatch. Never broaden deletion by prefix. |

Return to the [documentation index](./README.md).

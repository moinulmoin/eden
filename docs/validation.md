# Validation runbook

This is the maintainer runbook. First-time users should start with
[installation](./install.md), then follow the
[Eve deployment guide](./deploy.md).

## Eve compatibility gate

The gate tests two frozen fixtures: `validation/eve-compat/floor/` pins Eve
0.91.0 and `@workflow/world-postgres` 5.0.5; `validation/eve-compat/latest/`
pins Eve 1.0.2 and World 5.2.1. Renovate updates only the latest fixture's
Eve, World, and `just-bash` exact pins, in separate pull requests without
automerge, once a release is one day old; the floor stays frozen.

Start a local Postgres service, then run both fixtures from the repository root:

```sh
docker run --rm -d --name eden-compat-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
WORKFLOW_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm run compat:eve:local
```

Append `floor` or `latest` to run only that fixture, and `postgres` or `eden`
to run only that leg. Wait until Postgres is ready before running the gate. The
database user must have `CREATEDB`: the script creates and deletes fresh
databases for each run.

The gate runs two legs for each fixture.

The Postgres leg tests Eve itself. It performs a frozen install, typecheck,
production build/start, and bootstrap. It checks public health, fail-closed
bearer auth, and keyless session admission. The public Eve eval runner is
optional and runs when a model API key is available.

The Eden leg tests Eden. It needs Docker with linux/amd64 support and a built
workspace (`pnpm run build`), and no Cloudflare account:

1. It copies the fixture, selects `@moinulmoin/eden-world-cloudflare` in
   `agent/agent.ts`, and installs that package from a tarball packed from
   `packages/world-cloudflare`. The tarball is served over local HTTP because
   Eden installs a project from its lockfile inside a Docker build. The
   lockfile is resolved at run time, as a user's `npm install` would.
2. It runs the built `eden preflight --json` in-process with a Cloudflare read
   that reports no access. `VAL-BUILD-001` to `VAL-BUILD-007` and every other
   check must pass; only the two `VAL-CLI-007` Cloudflare checks may not. The
   only warning allowed is the missing model key.
3. It builds Eden's image again through the CLI package's own functions,
   because preflight removes the one it built, and starts it. The World core
   from the installed package serves the World RPC inside the container, from
   `packages/world-cloudflare/test/server.mjs`. This is the same core the
   Durable Object wraps, not the Durable Object itself.
4. It checks health, fail-closed bearer auth, and keyless session admission,
   then removes the container, both images, and the copied project.

CI and publish gates run both legs on both fixtures, with Postgres 16.
See [Current Eve compatibility](./eve-compatibility.md) for compatibility details.

Stop the local service afterward:

```sh
docker stop eden-compat-postgres
```

## Live check on Cloudflare

Run this before a release that changes deploy, update, destroy, runtime, or
World behavior. It uses the real Cloudflare account that Wrangler on this
machine is logged in to, and Docker. It does not run in CI.

```sh
pnpm run check:live -- --env-file ~/.config/eden/eve-compat.env
```

The env file must hold `AI_GATEWAY_API_KEY=<key>`. The script copies only
that value into its own temporary env file and never prints it. A run takes
about 30 minutes.

What it does, in order:

1. Builds the local CLI.
2. Makes a fresh project with `npx eve@<version> init` and the steps from
   `eden skill`: `just-bash`, the sandbox module, a bearer-token authenticator, and
   the Cloudflare World from npm.
3. Runs `eden preflight`, then `eden deploy`, and waits for health.
4. Starts a session whose turn runs bash and writes a file.
5. Deploys again on the same Eve version. The URL must not change. The same
   session must answer and still have its file. A new session must start.
6. Upgrades the project's Eve version and deploys. The same session must
   continue with the same ID, its earlier turns, and its file. A new session
   must report the new Eve version.
7. Sends no requests for longer than the idle window, then sends one. The
   server process must be younger than the wait, and the file must still be
   there.
8. Runs `eden destroy`, then confirms the URL returns 404 and that no Worker,
   secret, Container application, or registry image with the target's name
   is left.

Each step prints `✓` or `✗` with its time. The last output is one JSON
object with `ok`, the target, and every step. The exit code is `0` only when
every step passed.

Defaults and options:

| Option | Default | Effect |
| --- | --- | --- |
| `--eve <version>` | The floor fixture's Eve | Eve version the project starts on |
| `--upgrade-to <version>` | The latest fixture's Eve | Eve version for step 6; the step is skipped when it equals `--eve` |
| `--world <version>` | `latest` | `@moinulmoin/eden-world-cloudflare` version from npm |
| `--model <id>` | The fixtures' model and fallbacks | AI Gateway model |
| `--sleep-after <time>` | `90s` | Idle window for step 7, set with `EDEN_EVE_CONTAINER_SLEEP_AFTER` |
| `--skip-sleep` | off | Skip step 7 and keep the 1 hour default |
| `--keep-work` | off | Keep the temporary project folder; the target is still destroyed |

Safety:

- The target name is generated for each run (`eden-live-<date>-<8 hex>`).
  There is no option to choose it, and the script refuses to run `eden`
  against any other name.
- `eden destroy` runs when a step fails and on Ctrl-C. If destroy itself
  fails, the script prints the retry command and keeps the project folder,
  because destroy needs its `.eden` records.
- Eden rejects `file:` dependencies, so the project installs the Cloudflare
  World from npm. A World change is checked live only after it is published.
- The proof of each bash step is the tool's own output in the session
  stream, not the model's wording. A model that ignores the request gets two
  more tries.

Add a dated entry for each run to
[Eve compatibility history](./eve-compatibility-history.md).

## Provisional limits

- npm projects with one root `package-lock.json` and exact-pinned pnpm projects
  are supported; mixed locks, Bun project lockfiles, and native Windows are not.
- `.npmrc` is excluded from build layers; private registries are unsupported.
- One logical Container instance per deployment; no horizontal scaling or
  custom domains.
- Container-local disk survives sleep via filesystem snapshots but resets on
  image updates. Production durability requires the tested Postgres World setup
  in [deploy.md](deploy.md#durable-state-postgres-world).

## Cleanup

For a deployed validation, remove only the resources created for that exact
`--env`/`--name` target. Verify the deployment URL is unreachable and
resource/secret listings no longer contain the temporary entries. Preserve
shared preview or production resources.

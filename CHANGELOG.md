# Changelog

## 0.4.1 — 2026-10-01

Release of 0.4.0's contents. No code changes. The first publish of the new
`@moinulmoin/eden-world-cloudflare` package was done by hand to bootstrap
npm trusted publishing, and its tarball bytes differ from the CI build, so the
release pipeline correctly refused to publish 0.4.0 of the other packages.
All three packages are published at 0.4.1 by CI with provenance.
`@moinulmoin/eden-world-cloudflare@0.4.0` is the same code without provenance.

## 0.4.0 — 2026-10-01

### Added

- **Experimental: durable state with no database.** New package
  `@moinulmoin/eden-world-cloudflare`, a Workflow World backed by one
  SQLite Durable Object on your own Cloudflare account. Add the package and
  select it in `agent.ts`; Eden provisions the Durable Object and wires
  everything else. Durable Object alarms deliver queued workflow work and
  wake the Container. The World's endpoint is private to the Container;
  public `/__eden/world/*` requests return 404. Passes Workflow's official
  World conformance suite (`@workflow/world-testing`), and on Cloudflare a
  pending approval survived a Container restart and the run completed.
  See [docs/deploy.md](docs/deploy.md#durable-state-on-cloudflare-no-database).
- **Known limitation:** `eden destroy` deletes this state, and updating an
  agent currently requires destroy then deploy. State survives sleep and
  restarts, not code updates. Use the Postgres World if you need state across
  updates.
- **Not yet verified:** automatic Container sleep with this World. In the
  live test the Container stayed awake 45 seconds after the last client
  disconnected (30-second sleep setting); the cause is under investigation.
  Client stream cancellation was checked and stops polling.

## 0.3.0 — 2026-10-01

Real agents on your own Cloudflare: memory survives sleep, and schedules
fire while the Container sleeps.

### Added

- **Durable agent state with the Postgres Workflow World**, in three steps:
  add `@workflow/world-postgres` (the version paired with your Eve), select
  it in `agent.ts`, and put a direct (unpooled) `WORKFLOW_POSTGRES_URL` in
  your env file. Eden handles the rest during deploy: it runs the database
  migration (idempotent, with the URL passed only through the environment),
  disables the `cbor-extract` native addon that can't load in the image, and
  checks the World version against your Eve exactly the way Eve does
  (`EVE_WORLD_PAIRING`). Proven on Cloudflare: a pending approval survived a
  full container replacement and the live stream delivered events.
  See [docs/deploy.md](docs/deploy.md#durable-state-postgres-world).
- **Schedules fire while the Container sleeps.** When `eve build` reports
  schedules, the Worker gets an every-minute Cloudflare Cron Trigger that
  wakes the Container shortly before each tick, so Eve's own scheduler runs
  every tick exactly once. Schedules that can't be evaluated ahead of time
  (seconds fields, `@daily`-style shortcuts) produce `EVE_SCHEDULE_UNSUPPORTED`
  and only run while the Container is awake. See
  [docs/deploy.md](docs/deploy.md#schedules).
- Warnings, in human output and in the `--json` result (`warnings`), never
  failing the run and never including URL content: `EVE_WORLD_LOCAL` (state
  is lost on sleep) and `EVE_WORLD_POSTGRES_POOLED` (transaction-mode
  poolers break live session streaming).

### Changed

- Image installs tolerate pnpm's ignored build script for `cbor-extract`
  only; any other ignored dependency build script still fails with
  `ERR_PNPM_IGNORED_BUILDS`.

### Fixed

- **Linux:** `--env-file` values no longer reach the local boot check through
  `--env-file /dev/stdin`. On Linux, the stdin of a process Node spawns is a
  socket that `/dev/stdin` cannot open, so preflight and deploy failed there
  whenever an env file was used. Eden now passes `--env NAME` (names only)
  with values in the Docker CLI's own environment; values still never reach
  argv, logs, or the image. `PATH`, `HOME`, `DOCKER_HOST`, and
  `DOCKER_CONTEXT` are rejected as env-file names because they would replace
  the local Docker CLI's own settings.

## 0.2.2 — 2026-10-01

### Fixed

- `eden deploy` and `eden preflight` no longer refuse a new target just
  because the Cloudflare account already has other Containers, including
  another Eden agent. The target check now looks only for this target's own
  `<name>-container` application.
- The local boot check during `eden deploy` now receives the `--env-file`
  values, as `eden preflight` already did. Agents that need runtime
  configuration at boot (for example a Postgres Workflow World URL) no longer
  fail deploy with a health error. Values still never reach command
  arguments, image layers, or logs.

## 0.2.1 — 2026-10-01

### Security

- The public Worker now returns 404 for Eve's Workflow queue delivery
  routes (`/.well-known/workflow/v1/flow` and `/step`). They had no
  authentication, and in 0.2.0 they were reachable from the internet. Queue
  deliveries from the container to its own URL are now routed straight back
  into the container, and only that host is intercepted. Webhook callbacks and
  Eve's callback URLs are unchanged. **Upgrade and redeploy existing 0.2.0
  deployments.**

### Changed

- Validated Eve 0.68.0 (was 0.66.3) with a real Cloudflare deploy, a real
  model reply, and a tool call. The compatibility runner now reads the
  installed Eve version and fails if it doesn't match the fixture pin.

## 0.2.0 — 2026-09-30

Eden now has one job: deploy an existing Eve project to your own Cloudflare
account.

### Breaking

- Removed Eden Agent (`eden agent init|build|dev|deploy`) and its packages
  `@moinulmoin/eden-compiler` and `@moinulmoin/eden-definitions`. The CLI now
  has three commands: `eden preflight`, `eden deploy`, and `eden destroy`.

### Added

- Validated Eve 0.66.3 (was 0.47.3). A fresh `eve init` project passes
  `eden preflight`, and a real preview deploy served a model turn with a tool
  call.
- `eden deploy` and `eden preflight` work without flags: the project is the
  current directory, the environment is `preview`, and the name is derived
  from `package.json`. `--env production` and `destroy` still require an
  explicit `--name`.
- Human-readable output by default: progress lines, ✓/✗ checks, and a
  summary with the URL and elapsed time. `--json` prints the previous
  machine-readable result for scripts and CI.

### Changed

- The Cloudflare Container uses the `basic` instance type (1 GiB) instead of
  the 256 MiB default.
- `eden destroy` also deletes the registry image tags recorded for the exact
  target, including images left by aborted pushes, and reports any it could
  not remove.

### Fixed

- Image builds copy the project's `pnpm-workspace.yaml` before frozen
  installs, so pnpm policy behaves the same inside the image as locally.
- The runtime image includes `package.json` and the authored Eve source that
  `eve start` needs, with secret files still excluded.
- Build failures are classified by the step that failed. A failing
  `eve build` reports `EVE_BUILD_FAILED` (with a `just-bash` hint when Eve's
  sandbox fallback is missing), and pnpm failures report pnpm's own error
  code, such as `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` or
  `ERR_PNPM_IGNORED_BUILDS`.
- Fixed a runtime-tree ordering mismatch that raised `SOURCE_RACE` on real
  Eve 0.66.3 builds.
- The Worker no longer overrides the container start command, which crashed
  the container under `wrangler dev` by running `eve start` twice.

## 0.1.5 — 2026-08-31

- Added a pinned Eve 0.47.3 compatibility project and CI gate covering frozen
  install, typecheck, production build/start, public health, fail-closed bearer
  auth, and the public Eve eval runner when a model credential is available.
- Removed the exact retained local runtime image and publication tags after a
  healthy Eve deployment is promoted, with generation-label ownership proof.

## 0.1.4 — 2026-08-29

- Fixed Agent deployment after a prior same-identity build by excluding the
  diagnostic build timestamp from immutable artifact identity comparison.
- Corrected pnpm deployment examples so CLI options reach Eden without a
  literal `--` argument.

## 0.1.3 — 2026-08-27

- Made generated Eden Agent projects install cleanly with pinned pnpm 11 by
  approving only the required `esbuild` and `workerd` dependency builds.
- Added detailed user installation, Deploy, Agent, verification, and cleanup
  documentation under `docs/`.

## 0.1.2 — 2026-08-26

- Replaced public `workspace:*` dependency specifiers with exact `0.1.2`
  versions so every supported installer resolves the published package graph.

## 0.1.1 — 2026-08-26

- Replaced the placeholder npm README with complete installation,
  prerequisites, Deploy, Agent, cleanup, and limitation guidance.
- Relaxed the Node engine declaration to `>=24.17.0`; later Node majors are no
  longer rejected without evidence.
- Removed internal Factory mission and scan scaffolding from the public tree.

## 0.1.0 — 2026-08-26

Initial release.

### Eden Deploy

- Added top-level `eden preflight`, `eden deploy`, and `eden destroy` commands for hosting an existing Eve project on Cloudflare without adapting its source or runtime semantics.
- Added immutable Linux/amd64 packaging, bounded Container hosting, Worker routing, protected runtime injection, generation identity checks, health-gated promotion, and exact owned-resource cleanup.
- Added fail-closed validation for project roots, lockfiles, runtime configuration, host requirements, deployment identity, and destroy ownership.

### Eden Agent

- Placed Eden's agent-authoring framework beneath the explicit `eden agent` namespace: `init`, `build`, `dev`, and `deploy`.
- Added filesystem-first agent and tool discovery, coherent generated artifacts, authenticated local and remote runtimes, SQLite-backed Durable Object sessions, NDJSON journals, and bounded model/tool/final-response turns.

### CLI contract

- Removed the obsolete `eden eve` namespace.
- Removed root aliases for Agent `init`, `build`, and `dev`; root `deploy` now always means Eden Deploy.
- Added command-specific help and explicit target selection through `--project`, `--env`, and `--name`.
- Added the `@moinulmoin/eden` package and `eden` binary with npm, pnpm, and
  Bun installer compatibility; Node remains the runtime.

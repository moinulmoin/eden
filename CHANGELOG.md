# Changelog

## 0.11.2 — 2026-11-07

A security release. Update `@moinulmoin/eden`. Projects on the Cloudflare World
need `@moinulmoin/eden-world-cloudflare` 0.10.0 or later; preflight now refuses
older ones. The first deploy with this release ends sessions on kept versions
that predate World authentication (see below).

### Security

- **A project's `.env` could take over your Cloudflare login.** Wrangler reads
  `.env` and `.env.local` from the folder it runs in, and Eden ran the commands
  that change your account (uploading secrets, deleting the Worker and
  containers) from your current folder, usually the project. A `.env` that set
  `CLOUDFLARE_API_BASE_URL` sent your Wrangler login token and the secret
  values to that address; one that set `CLOUDFLARE_API_TOKEN` or
  `CLOUDFLARE_ACCOUNT_ID` sent your secrets to another account. Every Wrangler
  command now runs in an empty temporary folder Eden creates, and the
  Cloudflare API address is fixed.
- **Old Cloudflare World packages left the World open to the sandbox.** With
  `@moinulmoin/eden-world-cloudflare` older than 0.10.0, code in the agent's
  sandbox could read and change every session's workflow state (the problem
  0.10.0 fixed), and nothing warned about it. Preflight and deploy now fail
  with `EVE_WORLD_PAIRING` for those packages.
- **Kept versions without World authentication are retired.** Versions kept
  running after an Eve upgrade, including ones deployed with Eden 0.9.0 or
  earlier, stayed open to the same sandbox access until their sessions ended,
  which might be never. The next deploy removes them even with live sessions
  and warns with `EVE_UNAUTHENTICATED_VERSIONS_RETIRED`. Their sessions end: a
  message to one fails (Eve may show "Failed to send the session message."),
  and users start a new session.
- **Some env-file names let anyone in.** `EVE_DEV=1`, or `VERCEL` with
  `VERCEL_ENV=development`, switch Eve into development mode, where the
  `localDev()` channel authenticator accepts unauthenticated callers (Eve
  `0.83.0` and earlier check only these variables). Eden now rejects
  `EVE_DEV`, `VERCEL`, `VERCEL_ENV`, and `VERCEL_TARGET_ENV` in the env file
  with `EVE_ENV_RESERVED_VARIABLE`, and the container never passes them to Eve.
- **`destroy` checks the live target.** It trusted the local record alone, so
  a planted or stale record could name a foreign container application, or a
  same-name Worker that something else created later. It now requires the
  exact container name Eden derives, checks that the live Worker carries a
  release ID from Eden's records before deleting it (the deployment ID alone
  is shared by every project on the same Eve version), and stops with
  `EVE_DESTROY_INDETERMINATE` when Cloudflare can't be read instead of
  reporting the target as gone. A target whose Worker is already gone but
  whose containers or images remain is still cleaned up.
- **Preflight's local test container** listened on every network interface
  while holding the env file's values. It now listens on `127.0.0.1` only.
- **More secret files stay out of the image:** `.dev.vars`, `.dev.vars.*`,
  `.netrc`, `.git-credentials`, SSH private keys (`id_rsa`, `id_ecdsa`,
  `id_ed25519`, `id_dsa`), `*.p12`, `*.pfx`, `.aws/credentials`, `*.tfvars`,
  and `secrets.json` join `.env*`, `*.pem`, and `*.key`.
- **Release pipeline:** the installer checks after publishing now run in a
  separate job without npm publishing rights, so a compromised dependency they
  download can't publish a version. GitHub releases wait for those checks.

## 0.11.1 — 2026-11-06

Eve `1.0.0-rc.6`, which `npx eve init` installs today, couldn't start a session
on the Cloudflare World. Update both `@moinulmoin/eden` and the project's
`@moinulmoin/eden-world-cloudflare`.

### Added

- Preflight and deploy fail with `EVE_WORLD_PAIRING` when the project runs Eve
  `1.0.0-rc.6` or later on a Cloudflare World without atomic start hooks
  (`0.11.0` and earlier), instead of deploying an agent whose sessions all
  fail.

### Fixed

- On Eve `1.0.0-rc.6` and later with the Cloudflare World, every new session
  failed with HTTP 500 after a successful deploy and a clean preflight. The
  container log said "The configured Workflow world does not support atomic
  start hooks, which eve needs to start a session." Eve now claims a session's
  channel address in the same step that creates its run, and requires the
  World to do both atomically. The Cloudflare World now does, and declares
  `atomicStartHook`. It passes the 27 applicable cases of `@workflow/world`'s
  atomic start hook conformance suite; the other 5 need a half-finished
  admission, which this World can't produce because it admits a session in one
  transaction. Verified live on `1.0.0-rc.6`: a new session, bash, the new
  `edit_file` tool, an in-place update that kept the session and its files,
  and a fresh session after it. No migration step: the World creates its new
  table on its own, and runs and hooks from 0.11.0 stay as they are.

## 0.11.0 — 2026-11-05

Coding agents can now get an Eve project ready for Cloudflare on their own.
Eden ships a skill they can read, and preflight names two Vercel-only setups
that deploy fine but then fail on Cloudflare.

### Added

- `eden skill` prints the coding-agent skill for the installed CLI version:
  how to get a project ready, deploy, check it works, update, and remove it.
  `npx skills add moinulmoin/eden` installs the same skill.
- Preflight warns with `EVE_VERCEL_CONNECT` when project code imports
  `@vercel/connect`. Vercel Connect needs a Vercel project identity, so those
  connections fail on Cloudflare. The fix shows how to read the service's own
  key from the env file instead.
- Preflight warns with `EVE_AI_GATEWAY_KEY_MISSING` when the model goes
  through Vercel AI Gateway and the env file has no `AI_GATEWAY_API_KEY`.
  Without it, every model call fails on Cloudflare.

### Changed

- `EVE_WORLD_LOCAL` now names both ways to keep sessions across updates: the
  Cloudflare World (no database, one setting in `agent.ts`) or Postgres.

## 0.10.0 — 2026-11-04

Eve upgrades on the Cloudflare World no longer end existing conversations, and
the agent's sandbox can no longer reach the World's internal API. Update both
`@moinulmoin/eden` and the project's `@moinulmoin/eden-world-cloudflare` to get
both.

### Security

- In 0.9.0 and earlier, code run in the agent's bash sandbox could call the
  Cloudflare World's internal API through the container's own URL, and read or
  change any session's workflow state: run inputs and outputs, events, and hook
  tokens, or start workflow steps. The World now requires a secret that Eden
  gives only to Eve's World client at each container start, and refuses
  workflow step requests from inside the container; the sandbox can't read the
  secret, and its requests get HTTP 403. Versions kept running from before the
  update stay exposed until their sessions end.

### Added

- **Sessions survive Eve upgrades.** When `eden deploy` ships a new Eve
  version, the previous version keeps running next to it. An existing
  session's next message moves it to the new version with the same session ID,
  history, and sandbox files. Idle sessions move without a message, and work
  already running finishes on the old version. Verified live across Eve
  `0.83.0` → `0.91.0` → `1.0.0-rc.3`. Deploys that keep the same Eve version
  still update in place, as before.
- A later `eden deploy` removes an old version once all its sessions have
  ended. Until then its container runs only while it has work and sleeps
  otherwise; its image stays in your registry. Eden keeps at most 10 versions
  and refuses to deploy past that, listing the versions still holding
  sessions. `eden destroy` removes all of them. To check old versions, deploy
  rotates a control secret, which creates a Worker version with unchanged
  code, even when the deploy is then refused.
- Targets deployed with 0.9.0 are adopted on update: their existing sessions
  keep working on the old version until they end, but don't move to the new
  one.
- This needs a World that declares `deploymentAffinity` (this release). With
  an older World, `eden deploy` keeps the 0.9.0 behavior and still warns that
  an Eve upgrade ends existing sessions.
- While an old version finishes work that was running during the upgrade, a
  scheduled job can fire on both versions. Eden stops the old version's
  schedules once that work ends.

### Fixed

- On the Cloudflare World, one long tool call no longer holds up every other
  session of the agent. The World delivered queued work in batches and waited
  for the whole batch, so while one session ran a 5-minute bash command, a
  quick message in another session waited about 305 seconds; it now finishes
  in about 5 seconds. Each queued delivery now runs on its own and is not sent
  again while it is still running; if Cloudflare restarts the World's Durable
  Object, unfinished deliveries are retried, as before.
- Long sessions on the Cloudflare World no longer keep one ever-growing
  workflow run. The World now supports Eve's compaction handoff (it declares
  `hookForceClaim` and `hookRetention`): after a compaction, Eve moves the
  session to a fresh run with the same session ID, stream, and channel address.
  World `0.9.0` and earlier logged `session handoff unavailable` instead.
- Cloudflare World hook takeover now follows the Workflow contract: a resume
  sent to a run whose hook was taken over is redirected to the new owner even
  after that run finishes or its data expires under the run's retention.
- Listing the container registry during deploy and destroy may take up to 120
  seconds instead of 30. An account with many container snapshots took 42
  seconds, so cleanup failed.

### Changed

- The Cloudflare World is built on `@workflow/world` `5.1.0` and
  `@workflow/world-local` `5.2.0` (from `5.0.0` betas), the versions Eve
  `1.0.0-rc.3` bundles. It still creates spec 8 runs and rejects spec 9 runs
  instead of storing them.

## 0.9.0 — 2026-11-04

Eden 0.8.0 does not work with a fresh project on Eve `0.83.0` or later,
including `npx eve init` today (Eve `1.0.0-rc.3`): it deploys, but the agent's
sandbox fails to open ("DefaultSandbox has no sandbox provider for this
build"). Upgrade to 0.9.0 and add the sandbox module below.

### Fixed

- `eden deploy` no longer fails with "The protected Eve runtime store returned
  value-bearing metadata." when the env file holds a short value such as
  `WORKFLOW_SPEC_VERSION=8` or `FLAG=1`. Eden masked every env value in its
  output, so a short value matched its own random revision IDs and garbled
  messages. Values shorter than 8 characters are no longer masked; they are
  still delivered only through Cloudflare secrets.
- When `eve build` fails, preflight now shows the error Eve printed (the last
  20 lines, after `Eve reported:`) instead of only "The project-local Eve build
  failed".

### Changed

- Eve `0.83.0` and later include the upstream fix for eve#4440
  (vercel/eve#5132), so Eden no longer patches their just-bash binding.
  Preflight and deploy report `✓ EVE_SANDBOX_RESUME_PATCH — not needed`
  instead of warning that the Eve version is unknown. Eve `0.68.0`–`0.82.0`
  keep the temporary fix. A prerelease of `0.83.0` still counts as unfixed.
- Support Eve `0.83.0`'s explicit `JustBashSandbox` setup. Eden accepts that
  provider, rejects other providers, and fails early with setup instructions
  when a project still selects Eve's production default. Projects
  must install `just-bash` as a production dependency and select it in
  `agent/sandbox.ts`, or in `agent/sandbox/sandbox.ts` when an `agent/sandbox/`
  folder exists (any source extension Eve accepts). Preflight rejects
  `agent/sandbox.ts` next to an `agent/sandbox/` folder: Eve 0.83–0.86 silently
  ignores that module and 0.87 and later fail the build. If the source check
  cannot recognize the module, for example because it imports the environment
  from another file, Eden checks after `eve build` that a just-bash sandbox
  template was prepared instead.
  Older Eve releases retain their existing default-to-`just-bash` behavior.
- Pin the fresh-project instructions to Eve `0.91.0` and document
  microsandbox's removal in Eve `0.83.0`.
- Document that changing the Eve version ends existing sessions. Eve refuses
  to continue a session on a different Eve version unless the World routes
  each run back to the deployment that started it, which Vercel does and
  Eden's Cloudflare World does not (the check is in Eve `0.82.0` and
  `0.83.0`). A live Eve `0.82.0` → `0.83.0` update deployed successfully; the
  old session then returned HTTP 409 `session_stranded` and new sessions ran
  bash. Skill and code updates on the same Eve version keep sessions.
- Live-validated Eve `0.83.0` with explicit JustBash: local World multi-step
  queue execution with two bash tools, and Cloudflare World `0.8.0` sandbox-file
  carry plus a delayed durable queued task completing after a same-version
  skill update. Also live-validated Eve `0.91.0` and `1.0.0-rc.3` with Cloudflare
  World `0.8.0`: deploy, a session, and a bash tool call. Postgres World was not
  checked on these Eve releases.

## 0.8.0 — 2026-10-22

### Added

- Deploy npm Eve projects directly from their root `package-lock.json` with
  frozen `npm ci` installs, without converting to pnpm. Exact-pinned pnpm
  remains supported; mixed package-manager lockfiles are rejected. `.npmrc`
  remains excluded from build layers, and private registries remain unsupported.
- Preflight reports actionable setup guidance for a missing `just-bash`
  production dependency, generated production authentication placeholders, and
  local Workflow World durability. Add the sandbox dependency, configure a real
  authenticator for Cloudflare, and choose durable World storage before relying
  on state across image updates.
- Preflight names npm production dependencies that have install scripts.
  Eden's npm install does not run them, so a package that builds or downloads
  its native addon there (for example `better-sqlite3`) would fail at runtime.
  Use a package without one, or switch to exact-pinned pnpm and list it under
  `allowBuilds`.

## 0.7.4 — 2026-10-22

### Fixed

- A sleeping agent whose disk snapshot no longer exists now wakes. Cloudflare
  deletes a snapshot 30 days after it was created or last restored; before
  this fix, every request to that agent failed with HTTP 500 because Eden kept
  starting the container from the missing snapshot. Eden now forgets the
  missing snapshot, starts from the image, and restores the carried
  conversation files in the same request.
- An update no longer replaces the last good copy of the conversation files
  with a partial one when `tar` fails while copying them. The failed copy is
  discarded and the previous copy is kept.

### Documentation

- New guides: [How Eden works](docs/how-it-works.md),
  [Security](docs/security.md), [FAQ](docs/faq.md),
  [Reference](docs/reference.md), and
  [Troubleshooting](docs/troubleshooting.md).
- Fixed: `docs/deploy.md` said an `--env-file` inside the project fails the
  deploy with `SECRET_EXCLUSION_FAILED`. Eden leaves that file out of the
  image instead; keep it outside the project so it stays out of your
  repository.
- Updates now document that only the variables in the current deploy's
  `--env-file` reach the new container, so pass the same file on every
  deploy.
- `docs/install.md` lists the required `just-bash` production dependency.

## 0.7.3 — 2026-10-21

### Added

- `eden --version` (or `-v`) prints the installed Eden version. It was
  previously rejected as an unknown command.

## 0.7.2 — 2026-10-19

### Fixed

- The `EVE_WORLD_LOCAL` warning no longer says local Workflow World state is
  lost when the container sleeps. Since 0.6.0 the container disk is
  snapshotted on sleep and restored on wake; local World state resets only
  when the agent is updated.

### Changed

- Checked Eve `0.80.1` and `0.81.0` (current latest): a fresh `eve init`
  project passes `eden preflight` — frozen install, Eve build, local boot and
  health — and the temporary eve#4440 fix applies.

## 0.7.1 — 2026-10-15

### Fixed

- Extend the temporary Eve just-bash resume fix (eve#4440) to Eve `0.79.1`.
  The newer prepared artifact carries a `templateKey`, not a
  `templateRootPath`; Eden now resolves the current template before reopening
  or recreating a session and refreshing its skills. Existing recognized
  `0.68.0`–`0.72.1` bindings retain their original replacement; unknown hashes
  are still skipped with a warning.
- Document the complete fresh Eve initializer setup for Eden: converting
  npm output to pinned pnpm, excluding optional native archive dependencies,
  adding `just-bash`, and replacing production placeholder authentication.
- Reload a stale container Durable Object before forwarding requests from a
  newer Worker deployment, so updates roll to the new image before the
  deployment health gate can promote them. Scheduled wakes carry the same
  deployment identity and use the same bounded retry.
- Agents deployed with `0.7.0` or earlier must be recreated with
  `eden destroy` followed by `eden deploy` (or deployed to a fresh target)
  to pick up the reliable-update runtime.
- Allow up to ten minutes for Wrangler's Worker publication step, since
  Cloudflare image preparation can consume the previous two-minute deadline
  before the Worker and Container application are published. Other Wrangler
  operations retain their existing deadlines.

## 0.7.0 — 2026-10-07

### Added

- **Agent files and conversations survive updates too (including skill
  changes).** An `eden deploy` update replaces the running Container's image;
  Eden now carries Eve's sandbox sessions — every conversation's files and
  metadata under `/workspace/.eve/sandbox-cache/just-bash/sessions` — out of
  the old container into the agent's Durable Object storage in ~1 MiB chunks
  (capped at 1 GiB compressed; the previous carry is kept when the cap or an
  exec failure aborts a carry) and restores them into the fresh container
  before it serves any request. Same-image snapshot wakes keep using the
  fast snapshot path. `/workspace` outside Eve's sandbox sessions still
  resets to the new image.
- **Temporary Eve fix for the just-bash resume bug
  ([eve#4440](https://github.com/vercel/eve/issues/4440)).** Upstream Eve's
  just-bash provider permanently refuses to resume a conversation after the
  sandbox template changes (skills, `agent/sandbox/workspace/`, sandbox
  definition) and never falls back. Eden's isolated builder now patches one
  file in the installed Eve copy — only when its sha256 matches a version
  Eden knows (verified for 0.68.0, 0.71.2, and 0.72.1) — so a session
  reopens against the current template, refreshes the authored skills, and
  never touches `/workspace` user data. The patch exists only inside the
  build image and is removed when upstream ships the fix; an unknown Eve
  version still deploys and prints an `EVE_SANDBOX_RESUME_PATCH` warning
  (applied prints `✓ EVE_SANDBOX_RESUME_PATCH`).

### Changed

- Removed undocumented package exports.
- Docs corrected for 0.6.0 sleep/instance behavior.

### Fixed

- Eve sandbox tools (`bash`, `read_file`, `write_file`) now work on deployed
  agents: the prepared sandbox template ships in the image, and runtime
  sandbox selection matches the build.
- **Sleep now snapshots with the default settings.** The 0.6.0 default
  sleep window (24 hours) exceeded Cloudflare's 6-hour limit on how long a
  container may outlive its idle Durable Object, so the inactivity timeout
  was rejected and Cloudflare stopped idle containers without a snapshot —
  files were lost and updates had nothing to carry. The default is now 1
  hour, and `EDEN_EVE_CONTAINER_SLEEP_AFTER` is capped at `345m` (5 h 45 min).
- A container restored from a snapshot is no longer mistaken for a stale
  image (`inspect()` reports an empty image for it); Eden compares the image
  it recorded at start instead.

## 0.6.0 — 2026-10-06

### Changed

- **Containers run on the Durable Object runtime.** The Eve host is now a
  plain Durable Object driving Cloudflare's native `ctx.container`
  (`scheduling_policy: "durable_object"`) instead of the
  `@cloudflare/containers` Container class. The image is selected at
  container start, so an `eden deploy` update no longer races the old image:
  the running container is replaced when `inspect()` shows it still serves the
  previous image, and deploy health promotion proves the served image.
- **Agent files survive sleep.** When the container has been idle for the
  sleep window (default 24 hours, `EDEN_EVE_CONTAINER_SLEEP_AFTER`), Eden
  snapshots the container's writable filesystem and destroys the instance; the
  next wake restores the snapshot in under a second, so `/workspace` —
  including Eve's sandbox cache — survives sleep. Snapshots are bound to the
  image they came from, expire after 30 idle days, and a redeploy that changes
  the image starts fresh (workspace files do not carry across an update).
- **Container size is `standard-1`** (1/2 vCPU, 4 GiB; previously `basic`,
  1 GiB). Awake time is billed at the 4 GiB rate; a sleeping container costs
  nothing.
- **0.6.0 is a clean cutover.** Targets deployed with 0.5.0 should be
  destroyed with 0.5.0 and redeployed.
- **Registry cleanup now removes every tag** in a generation's repository —
  including the `rootfs-snapshot-*`/`rootfs-set-*` tags container snapshots
  create — on updates, destroy, and aborted pushes.
- Wrangler requirement bumped to **4.147.0** (first release that deploys
  `scheduling_policy: "durable_object"`); `@cloudflare/workers-types` to
  `5.20261006.1`. `@cloudflare/containers` is no longer a dependency.
- Durable Object ownership for preflight now reads the container
  application's Durable Object namespace (`wrangler containers info`) and
  matches it against the Worker's `EVE_CONTAINER` binding namespace;
  unreadable provider state still fails closed.

## 0.5.0 — 2026-10-06

### Added

- **Update an agent in place.** Running `eden deploy` again on a target Eden
  owns (proved by its immutable deployment record: same account, project, and
  exact Worker and Container names) now updates it instead of failing with
  `VAL-CLI-007-TARGET-CONFLICT`. Eden republishes the same Worker and
  Container application, keeps Durable Object classes and their migration
  history (new tags are only appended), restarts the running Container on the
  new image, health-checks, promotes, and then deletes the previous
  generation's registry image. State in the Cloudflare World now survives
  updates. Proven on Cloudflare: a pending approval made before an update
  completed afterwards on the new code. The summary prints `✓ updated`, and
  `--json` reports `deployment.operation`.
- Warnings `EVE_UPDATE_IN_FLIGHT` (off Vercel, in-flight runs resume on the
  new code; keep step names and state shapes compatible) and
  `EVE_UPDATE_WORLD_SWITCH` (switching Workflow Worlds doesn't move existing
  state).

### Changed

- A target that exists but isn't provably owned by Eden still fails with
  `VAL-CLI-007-TARGET-CONFLICT`, and production still requires `--name`.

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

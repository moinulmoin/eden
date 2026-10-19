# Current Eve compatibility

This maintainer gate validates Eden Deploy against a real, published Eve
project rather than an Eden mock or Eve's private repository test harness.

The standalone fixture under `validation/eve-compat/minimal/` currently pins:

- Eve `0.68.0`
- AI SDK `7.0.105` (Eve 0.68.0 requires `ai: ^7.0.105`)
- Zod `4.5.4`
- just-bash `3.4.2` (Eve 0.68.0's optional `just-bash: ^3.1.0` peer)
- pnpm `11.21.0`
- Node 24 or newer

Update the fixture, its lockfile, and this document together when advancing the
tested Eve line. Do not replace the exact Eve pin with `latest` in a release
gate.

The Cloudflare launch gate also uses a separate, fresh project created by
`npx eve@0.81.0 init <name> --non-interactive`. Keep the older fixture pin:
it exercises the original prepared-artifact shape, while Eve `0.79.1` and
later use the newer `templateKey` shape. See the
[fresh-project setup](../README.md#starting-from-a-fresh-eve-project) for the
npm-to-pnpm conversion, optional-native-dependency policy, and production
authentication that a new initializer output needs.

The fixture carries its own `pnpm-workspace.yaml`. When the tested Eve release
is younger than pnpm's `minimumReleaseAge` window, the fixture names that exact
pin in `minimumReleaseAgeExclude` there; the runner deliberately does not use
`--ignore-workspace`, so the exception also applies inside Eden's generated
image, which copies `pnpm-workspace.yaml` before both frozen installs.

Eve's default `eve init` scaffold selects the `just-bash` sandbox provider but
does not declare it: a fresh scaffold must add `just-bash` as a production
dependency (the fixture pins `3.4.2`, which Eve 0.68.0's `^3.1.0`
optional peer resolves) or `eve build` inside Eden's isolated builder —
which has no Docker daemon or `/dev/kvm` — fails with
`Cannot find package 'just-bash'`. The fixture's `pnpm-workspace.yaml` also
lists `@mongodb-js/zstd` and `node-liblzma` under
`ignoredOptionalDependencies` so the frozen installs skip just-bash's optional
native archives. This is a scaffold-side project dependency, not an
Eden workaround.

The synthetic compatibility turn uses this ordered AI Gateway model chain:

1. `minimax/minimax-m3-free`
2. `poolside/laguna-s-2.1-free`
3. `alibaba/qwen3.7-flash`

The Gateway tries the next model only when the preceding route fails. The
MiniMax free route is a time-limited promotion, so keep the chain current when
the catalog changes. The fixture declares a 32,000-token logical model window
so Eve plans compaction below Qwen's lowest context-pricing boundary and every
fallback runs against the same test budget.

## Sandbox resume compatibility

Eden's temporary [eve#4440](https://github.com/vercel/eve/issues/4440) patch
recognizes the exact published binding hashes for Eve `0.68.0`, `0.71.2`,
`0.72.1`, and `0.79.1`; Eve `0.80.1` and `0.81.0` ship the same binding as
`0.79.1`. Recognizing a hash is not a claim that every one of those releases
passed the complete live gate.

- `0.68.0`, `0.71.2`, and `0.72.1` expose a prepared `templateRootPath`;
  session creation accepts the prepared artifact.
- `0.79.1` exposes a prepared `templateKey`; session creation accepts the
  template directory resolved with Eve's own `resolveTemplateRootPath`.
  Its original `resume()` still has the upstream generation-mismatch bug.

Both replacements enforce the original sessions-directory containment,
recreate a missing root from the current template, and refresh authored
`$HOME/.agents/skills` on a template-generation change without overwriting
user workspace files. The prepared cache and session directory remain
`.eve/sandbox-cache/just-bash/{templates,sessions}` in Eve `0.79.1`, so no
runtime storage-path migration is necessary. An unknown binding hash remains
unpatched and prints `! EVE_SANDBOX_RESUME_PATCH`; recognized bindings print
`✓ EVE_SANDBOX_RESUME_PATCH`.

## Local production-runtime gate

From the Eden repository root, run:

```sh
pnpm run compat:eve:local
```

The repository-owned runner:

1. performs an isolated frozen install from the fixture lockfile;
2. typechecks the authored agent, channel, tool, and eval;
3. runs the fixture's real `eve build`;
4. starts the real production server with `eve start` on an owned local port;
5. requires the documented `/eve/v1/health` ready response;
6. requires `/eve/v1/info` to reject missing auth and accept the fixture bearer
   against the agent-info `version: 5` contract;
7. terminates the complete owned process tree and verifies cleanup.

When `AI_GATEWAY_API_KEY` is present, the same runner also invokes Eve's public
black-box eval command against the running production server:

```sh
eve eval --strict --url http://127.0.0.1:<owned-port>
```

The eval requires the model to call the fixture's authored
`compatibility_echo` tool exactly once and checks the input and structured
output. Without `AI_GATEWAY_API_KEY`, the runner reports that this model/tool
assertion was skipped; build, production boot, health, auth, and cleanup still
remain required.

This adopts Eve's supported eval surface (`eve/evals` and `eve eval`) rather
than copying its internal tests, generated Nitro symbols, or private workflow
callback payloads.

## Eden packaging preflight

After the local gate passes, run Eden's real read-only preflight with a unique
target name:

```sh
FIXTURE="$PWD/validation/eve-compat/minimal"
WORKER_NAME="eden-eve-compat-$(date +%s)"

eden preflight \
  --project "$FIXTURE" \
  --env preview \
  --name "$WORKER_NAME"
```

Require all of the following evidence:

- immutable fixture snapshot and exact frozen pnpm install;
- the project `pnpm-workspace.yaml` (when present) applied inside the image for
  both frozen installs, so local pnpm policy behaves the same in the build;
- project-local Eve executable and `eve build` output;
- Linux/amd64 runtime image carrying the authored project source (the
  `package.json` manifest plus `agent/`/`agents/`/flat layouts) so `eve start`
  resolves the project context;
- the real `eve start --host 0.0.0.0 --port 8080` process;
- ready health from the booted image;
- exact boot-container and disposable-image cleanup;
- authenticated read-only Cloudflare and target-absence checks.

## Disposable Cloudflare preview

Use a preview only after preflight is green. For a full model/tool proof, put
fresh values in an owner-readable environment file outside the repository:

```text
AI_GATEWAY_API_KEY=<project-owned-key>
EVE_COMPAT_AUTH_TOKEN=<fresh-random-token>
```

Deploy and retain the printed URL:

```sh
eden deploy \
  --project "$FIXTURE" \
  --env preview \
  --name "$WORKER_NAME" \
  --env-file "$ENV_FILE"
```

Require public health, fail-closed unauthenticated info, authenticated info, and
the remote eval:

```sh
curl --fail --silent "$DEPLOY_URL/eve/v1/health"

EVE_EVAL_AUTH_TOKEN="$EVE_COMPAT_AUTH_TOKEN" \
  pnpm --dir "$FIXTURE" exec eve eval \
    --strict --url "$DEPLOY_URL"
```

Finally destroy only that exact target:

```sh
eden destroy \
  --project "$FIXTURE" \
  --env preview \
  --name "$WORKER_NAME"
```

Verify all three cleanup signals:

1. the former health URL returns 404;
2. `wrangler containers list` contains no matching application;
3. querying the exact Worker returns Cloudflare code `10007` or equivalent
   does-not-exist evidence.

## Fresh Eve 0.79.1 launch gate (2026-10-15)

The fresh initializer project used Eve `0.79.1`, AI SDK `7.0.140`,
just-bash `3.6.0`, pnpm `11.21.0`, Node `24.17.0`,
`alibaba/qwen3.7-flash` with a 32,000-token logical model window, and a bearer
authenticator backed by an owner-readable environment file outside the repo.
The full persistence proof uses `@moinulmoin/eden-world-cloudflare@0.7.0`:
the default local World cannot preserve the conversation itself across an
image update.

The published Eden `0.7.0` baseline deployed Eve `0.79.1` but printed
`! EVE_SANDBOX_RESUME_PATCH`. Its real bash call wrote and read `base-1`;
`ls ~/.agents/skills` returned exit code 2 because the untouched scaffold
has no authored skills directory. The local CLI's recognized patch instead
prints `✓ EVE_SANDBOX_RESUME_PATCH`.

An update exposed a separate native-container runtime issue: a resident
Durable Object can keep its old Worker code/environment while its container
monitor remains active. New outer-Worker generation headers alone are not
proof of a new image. The deployment health gate correctly refused promotion
(`DEPLOY_INDETERMINATE`), and even a brand-new conversation still saw the
old skill. The fixed runtime rejects a mismatched deployment before
forwarding, resets the stale object, and retries the bodyless request once.
Body-bearing requests synchronize through the same bodyless health path
before forwarding the original stream exactly once, without cloning it.
The existing image reconciliation, sandbox carry, and
`x-eden-eve-started-deployment` health gate then prove the new image.

The awake update printed `✓ updated`; the original conversation read its
preserved `launch-proof-file` and skill marker `EDEN_LAUNCH_SKILL_V2`
(exit code 0, empty stderr). A new conversation independently read V2.

The next update started with zero Container instances at `09:33:00Z`, and
the read-only inventory still showed zero at `09:34:00Z` during the build.
It also printed `✓ updated`. At `09:36:24Z`, the same conversation read
`launch-proof-file` and `EDEN_LAUNCH_SKILL_V3` with exit code 0 and empty
stderr; a new conversation independently read V3.

The sleep/schedule fixture uses `EDEN_EVE_CONTAINER_SLEEP_AFTER=90s` and
`*/10 * * * *`, not every three minutes: Eden's four-minute wake lead
intentionally keeps a three-minute schedule continuously awake. The first
multi-update attempt observed delayed Cron propagation and no ticks yet;
the original conversation nevertheless read its file and V3 skill again
after sleep at `09:51:33Z` (exit code 0).

A separate fresh initializer project was then deployed once, without further
updates, as `eden-launch-sched-proof`. Deployment completed at
`10:08:58.092Z`; the first Cron invocation was observed at `10:25:46.003Z`
(16 minutes 47.911 seconds later). Only read-only Container inventory was
queried while waiting; there were no external HTTP requests to the agent
between deployment and the final evidence read at `10:41:10Z`.

The persisted schedule records contain exactly one tick at `10:30:00.019Z`
and exactly one at `10:40:00.011Z`. Between them:

- The native host's idle-sleep alarm ran at `10:33:15Z`, 90 seconds after the
  preceding Cron health wake.
- `wrangler containers list --json` showed zero instances at
  `10:33:57.246Z`, `10:34:59.690Z`, and `10:36:02.476Z`.
- The next due Cron wake ran at `10:36:45Z`. At `10:41:14.994Z` the evidence
  tool reported process uptime `266.471219656` seconds, placing the new
  server process start at approximately `10:36:48.523Z`, before the next tick.

The inventory command also reported zero instances during active execution
with `durable_object` scheduling, so its count alone is not a reliable wake
signal. The sleep alarm, restarted-process uptime, and persisted consecutive
tick records provide the additional sleep/wake evidence. The disposable
observer's stricter `instances > 0` wake assertion therefore failed despite
these verified behavior criteria; no runtime change was needed.

This fresh proof also exposed a publication deadline problem: Cloudflare
image preparation consumed almost all of Wrangler's former 120-second
budget, leaving a placeholder Worker. Publication now gets 600 seconds;
other Wrangler operations retain their previous deadlines. Retrying that
partial target failed closed with `VAL-CLI-007-TARGET-CONFLICT`; it was
destroyed before the successful fresh-target proof.

Cloudflare reported an active
[Western Europe Durable Objects incident](https://www.cloudflarestatus.com/incidents/wvzqdm21spz0);
its relation to the observed propagation and image-preparation delays is
unproven.

All five disposable targets (`eden-launch-base`, `eden-launch-latest`,
`eden-launch-proof`, `eden-launch-sched`, and `eden-launch-sched-proof`) were
removed with `eden destroy`, including the incomplete placeholder
publication and both repositories retained by the earlier indeterminate
update. All former origins returned HTTP 404; the final
`wrangler containers list --json` and registry image query filtered by
`eden-launch` both returned `[]`. The final build, typecheck, ESLint with
zero warnings, and all 284 tests passed.

## Fresh Eve 0.81.0 launch run (2026-10-19)

Eve `0.80.1` and `0.81.0` shipped after Eden `0.7.1`. Both releases' just-bash
binding has the same sha256 as `0.79.1`
(`ab8b1ad7398af8f6fd2a1e91eb0d1ff8d2b9b9afe1836234f36ce0e896791c45`), so the
temporary eve#4440 fix applies unchanged. Fresh initializer projects for both
passed `eden preflight` (published `0.7.1` for `0.80.1`, the `0.7.2` build for
`0.81.0`).

The live run used the published `@moinulmoin/eden@0.7.2` on a fresh
`npx eve@0.81.0 init my-eve-agent --non-interactive` project: AI SDK
`7.0.143`, just-bash `3.6.0`, pnpm `11.21.0`, Node `24.17.0`,
`alibaba/qwen3.7-flash` with a 32,000-token logical model window, and a bearer
authenticator backed by an owner-readable environment file outside the repo,
on the default local Workflow World.

- `eden deploy` printed `✓ EVE_SANDBOX_RESUME_PATCH` and
  `✓ deployed my-eve-agent-9e510242 (preview) · eve 0.81.0` in 215 seconds.
- `/eve/v1/health` returned `ready`; unauthenticated `/eve/v1/info` returned
  401.
- `eve remote invoke` with the bearer returned a completed model reply in
  about 6 seconds, and a second turn's `bash` tool call returned
  `launch-day`.
- After adding a sign-off rule to `agent/instructions.md`, the same
  `eden deploy` printed `✓ updated` in 194 seconds on the same URL, and the
  next reply followed the new instruction.
- `eden destroy` removed the Worker, Container application, and registry
  repository in 31 seconds; the origin returned 404 and
  `wrangler containers list` reported no containers.

The run's captured output is the source of the landing-page terminal and
`docs/assets/eden-deploy.gif`.

## What this gate proves

Passing the complete gate proves that the pinned Eve release can be packaged
and hosted through Eden's current Worker + single Container architecture, that
the canonical Eve HTTP/auth surface is preserved, and that one real model/tool
turn crosses the deployed workflow callback path.

It does not prove production durability, horizontal scaling, every Eve authored
slot, or every provider. Eve's local Workflow World remains disposable across
image updates. Container files survive sleep via snapshots, and Eden carries
conversation sandbox files across an update; other container-local files
reset with a new image. Production projects still need a durable World and
representative application-specific tests; see the
[Postgres World](deploy.md#durable-state-postgres-world) and experimental
[Cloudflare World](deploy.md#durable-state-on-cloudflare-no-database) recipes.

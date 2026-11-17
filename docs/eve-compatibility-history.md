# Eve compatibility history

Dated records of live runs and notes about older Eve versions. Each one
describes what was true when it was recorded. For what Eden supports today,
see [Eve compatibility](./eve-compatibility.md).

## Scripted live check, Eve 0.91.0 to 1.0.2 (2026-11-17)

The first run of `pnpm run check:live`, on macOS with Docker, against the
maintainer's Cloudflare account. The CLI was built from main at `7899dc9`.
The project came from `npx eve@0.91.0 init` with `just-bash` `3.6.1` and
`@moinulmoin/eden-world-cloudflare` `0.12.0` from npm. The idle window was
`EDEN_EVE_CONTAINER_SLEEP_AFTER=90s`. The run took 27 minutes, from
`21:50:18Z` to `22:17:13Z`. Other builds were running on the machine, so
the times below are slow ones.

- `eden preflight` passed 14 checks with no warnings in 231 seconds.
- The fresh deploy took 333 seconds. Health was ready on the first request.
  An unauthenticated session request returned HTTP 401.
- Session `wrun_01M7NRCAPX2GMMG5SK2AB3E1ZK` started on Eve `0.91.0`. Bash
  wrote a file and read it back with exit code 0.
- The same-version update took 235 seconds, on the same URL, and printed the
  `EVE_UPDATE_IN_FLIGHT` warning. The same session answered and bash read
  the file back. A new session ran bash.
- After the project moved to Eve `1.0.2`, the deploy took 322 seconds, on
  the same URL. The same session answered with the same ID, its two earlier
  turns were still in its stream, and bash read the file back. A new session
  reported Eve `1.0.2` and ran bash.
- After 165 seconds with no requests, the first health request took 6.4
  seconds. The server process was 7 seconds old when the session asked, so
  the container had stopped and started. Bash read the file back again.
- `eden destroy` took 196 seconds. The URL returned 404. Wrangler showed no
  Worker, no secrets, no Container application, and no registry image for
  the target.

This is the first live run on Eve `1.0.2`, and the first dated run of a
session moving across an Eve upgrade.

A second run started on Eve `1.0.2` with no upgrade: preflight took 126
seconds and the fresh deploy 220 seconds. It was then interrupted with
SIGINT on purpose. The script ran `eden destroy` (61 seconds) and nothing
of that target was left.

Three earlier attempts on the same day stopped before the full run passed:

- `pnpm run` exports `npm_*` settings that pointed the project's
  `npm install` at the Eden repository. The script now removes them.
- The free model was not available (`MODEL_CALL_FAILED`), which ended the
  session. The script now uses the fixtures' fallback models. Destroy ran
  after that failure and left nothing behind.
- Under heavy machine load, preflight's local boot did not become healthy
  in time (`EVE_HEALTH_FAILED`). The next run passed unchanged.

On a second temporary target the `.eden/` folder was moved aside. `eden
destroy` stopped with `EVE_DESTROY_RECORD_UNPROVEN`. The manual steps in
[The `.eden/` folder is lost](./troubleshooting.md#the-eden-folder-is-lost)
then removed the Worker, the Container application, and the registry image.
The URL returned 404 and nothing with the name was left. That target had not
slept, so it had no `rootfs-snapshot-*` tags to delete.

## Eve 1.0.2 checks (2026-11-17)

Run on macOS with Docker, without Cloudflare credentials. No live Cloudflare
run was made for Eve `1.0.2`.

- The compatibility gate passed for both fixtures: Eve `0.91.0` with
  `@workflow/world-postgres` `5.0.5`, and Eve `1.0.2` with `5.2.1`.
- A project from `npx eve@1.0.2 init`, set up with the README's fresh-project
  steps, passed every build and boot check of `eden preflight`
  (`VAL-BUILD-001` to `VAL-BUILD-007`). The two Cloudflare access checks did
  not run.
- Eve `1.0.2` with `@moinulmoin/eden-world-cloudflare` `0.12.0`, against the
  World's core served over RPC on the same machine: a session was admitted
  with HTTP 202 and its first turn ran up to the model call, which had no
  model key.
- Once a session has started, Eve `1.0.2` with the Postgres World takes about
  five seconds to exit after SIGTERM. Eve `1.0.0-rc.6` exited within a second.

## Eve 0.83.0 sandbox selection

Eve `0.83.0` removed microsandbox and changed `DefaultSandbox`: production no
longer falls back to `just-bash`; that fallback is only for development and
evaluation. Eden has no nested Docker daemon, so install `just-bash` as a
production dependency and explicitly select it in `agent/sandbox.ts`, or in
`agent/sandbox/sandbox.ts` when an `agent/sandbox/` folder exists:

```ts
import { defineSandbox } from 'eve/sandbox';
import { JustBashSandbox } from 'eve/sandbox/just-bash';

export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
```

Eden accepts this explicit provider and rejects other providers. With Eve
`0.83.0` and later, leaving the production default selected fails early with
`EVE_SANDBOX_PROVIDER` and setup instructions; do not enable `EVE_DEV` to bypass
production selection. Older Eve releases keep their existing default behavior.

The `0.83.0` sessions directory remains
`/workspace/.eve/sandbox-cache/just-bash/sessions`. Eden carries that same
directory across image updates, but Eve's state protocol changed. Source-level
fallback to fresh sandbox state for incompatible older state is separate from
whether Eve permits the old session to execute; the live upgrade below was
rejected before sandbox access.

## Eve 0.82.0 to 0.83.0 live upgrade (2026-10-23)

A project using Cloudflare World `0.8.0` deployed Eve `0.82.0`; session
`wrun_01M5M1RCHS9F5CPA22J7XRMJG9` ran bash and wrote `upgrade-proof.txt`.
After upgrading to Eve `0.83.0` with an explicit `JustBashSandbox` module,
Eden deployed the update successfully. A POST to the same session returned:

```json
{"code":"session_stranded","error":"This session is no longer available.","ok":false,"eveVersion":"0.82.0"}
```

The response was HTTP 409, before sandbox access. Eve only continues a
session on the Eve version that started it unless its World declares
`deploymentAffinity`. The World in this run did not. Carrying sandbox files
alone did not keep these sessions working. With an older World, start new
sessions after an Eve upgrade.

A new `0.83.0` Cloudflare World session ran bash successfully. A separate live
local World `0.83.0` run passed multi-step queue execution with two bash tools.
The same-version update below separately proved that sandbox files and a
queued task survived. It did not test an Eve upgrade.

## Eve 0.83.0 skill-update carry and queued task (2026-10-23)

With Eve `0.83.0`, explicit `JustBashSandbox`, and Cloudflare World `0.8.0`,
session `wrun_01M5M2HC2S9PDVHRGVD6HGM221` wrote `/workspace/carry-proof.txt`
containing `eden083-carry-marker`. At `09:47:55.770Z` it queued a durable
`delayed_marker` task with a `900000` ms delay. A skill was then added at
`agent/skills/carry-proof/SKILL.md`, and Eden redeployed the same target with
`ok: true`.

After the update, bash in the same session returned exit code 0 at
`10:02:57.283Z` with:

```text
eden083-carry-marker
post-update-bash-ok
```

The delayed task completed at `10:03:00.116Z`, after the update. A subsequent
bash call read `delayed-marker.txt`, returning `eden083-queued-across-update`
with exit code 0. This establishes same-version sandbox-file carry and
continuation of a pending durable queued task across a skill update for this
Cloudflare World setup.

The separate local World `0.83.0` run passed multi-step queue execution with
two bash tools. Postgres was not checked on `0.83.0`; the earlier proof
database expired and its environment file was deleted.

## Eve 0.91.0 and 1.0.0-rc.3 (2026-11-04)

Fresh `eve init` projects on both releases, with `just-bash`, an explicit
`JustBashSandbox` module, a bearer authenticator, and Cloudflare World `0.8.0`,
passed preflight, deployed, and ran a bash tool call in a live session
(`EDEN_RC3_BASH_OK` and `EDEN_091_BASH_OK`, exit code 0, turn completed). The
`0.91.0` env file also held `WORKFLOW_SPEC_VERSION=8` and a one-character value,
which failed deploys before 0.9.0.

Eve `1.0.0-rc.3` creates Workflow spec 9 runs by default, which need a World
capability Eden's Cloudflare World does not declare. That did not break the
live run: Eve creates runs at the World's declared spec version (8). Eve
`0.90.0` and later answer `GET /eve/v1/info` with 403 for non-operator
principals; Eden does not call it. Without a sandbox module, released Eden 0.8.0
deployed a `1.0.0-rc.3` project whose bash call then failed with
`DefaultSandbox has no sandbox provider for this build`.

## Compaction handoff on the Cloudflare World (2026-11-04)

After a compaction, Eve moves a session to a fresh workflow run so a long
session's run history stays bounded. Eve does this only when the World declares
`hookForceClaim` and `hookRetention`; Cloudflare World `0.9.0` and earlier
declare neither, so Eve logs `session handoff unavailable` and keeps one
growing run. Cloudflare World `0.10.0` declares both. It is built on
`@workflow/world` `5.1.0` and still creates spec 8 runs.

Live on Eve `1.0.0-rc.3`, both Worlds deployed, ran bash, compacted (HTTP 202),
and ran bash again (exit code 0):

| World | Owner run after compaction | Container log |
| --- | --- | --- |
| `0.9.0` | Unchanged (`wrun_01M6K7B2J727T8E8WAKFD854K3`) | `session handoff unavailable` |
| `0.10.0` | `wrun_01M6K7K2DTM3WT6JBDGM5M1DRF` → `wrun_01M6K7MAFH9E2274AGBN7F12MP` | No handoff warning |

The session ID (`wrun_01M6K7JEFSB77SZFHTN570S5ZP`), its stream, and its
channel address stayed the same, and the stream kept the earlier history. A
local `eve build` + `eve start` run on Eve `0.91.0` and `1.0.0-rc.3` against the
updated World also ran bash. Eve `0.68.0`–`0.82.0` were not run against it.
This run proved compaction handoff on one Eve version, not a move between
Eve versions. See [session behavior across Eve upgrades](#session-behavior-across-eve-upgrades).

## Eve 1.0.0-rc.6 atomic start Hooks (2026-11-06)

Eve `1.0.0-rc.6` claims a new session's channel address in the same step that
creates its workflow run, and refuses to start a session unless the World
declares `atomicStartHook`. Released Eden `0.11.0` with Cloudflare World
`0.11.0` passed preflight with no warnings and deployed a fresh `rc.6` project,
but `POST /eve/v1/session` returned HTTP 500 and the container logged:

```text
Error: The configured Workflow world does not support atomic start hooks, which eve needs to start a session. Use the local world, Vercel Workflow, or @workflow/world-postgres 5.1.1 or later.
```

The same release with the local World ran a session on `rc.6`: bash, Eve's new
default `edit_file` tool, and a non-zero exit reported to the model as
`[exit code: 7]`. After an in-place update the old session returned HTTP 409
`session_not_active` (the local World resets on update) and a new session ran
bash.

The updated Cloudflare World admits a session's run and its start Hook in one
Durable Object transaction and declares `atomicStartHook`. Through the client
RPC path it passes 27 cases of `@workflow/world` `5.1.0`'s atomic start hook
conformance suite; the 5 orphan-bound cases are skipped because they need a
candidate admitted without its run, which one transaction cannot leave behind.
Live on a fresh `rc.6` project with that World, a new session returned HTTP
202 and ran bash and `edit_file`; after a same-version update the session
continued (HTTP 202, same session ID, file intact) and a new session ran bash.
The container log had no atomic start hook error. Racing first messages to one
channel address were not tested: Eve's HTTP channel only addresses sessions by
ID.

Eve also says sessions from Eve before `0.83.0` can't move to `rc.6`, and
the Postgres World needs `@workflow/world-postgres` `5.1.1` or later.

## Eve 1.0.0-rc.6 with the Postgres World (2026-11-07)

Released Eden `0.11.4` passed preflight on a fresh `rc.6` project with
`@workflow/world-postgres` `5.0.5` and a Neon database, and the deployment
answered health checks, but `POST /eve/v1/session` returned HTTP 500. The
same image run locally logged the atomic start hook error above. Eden now
fails `EVE_WORLD_PAIRING` before deploying when Eve needs atomic start hooks
and the Postgres World is older than `5.1.1`. `5.1.0` declares the capability
but reads `start({ hook })`, while Eve passes `experimental_hook`, which
`5.1.1` reads.

With `5.1.1`, live on Cloudflare: a new session replied and ran bash, which
wrote a file; after a same-version in-place update the same session (same
ID) read the file back; a new session ran after the update; destroy left the
URL returning 404.

## Sandbox resume compatibility

Eden's temporary [eve#4440](https://github.com/vercel/eve/issues/4440) patch
recognizes the exact published binding hashes for Eve `0.68.0`, `0.71.2`,
`0.72.1`, and `0.79.1`; Eve `0.80.1`, `0.81.0`, and `0.82.0` ship the same
binding as `0.79.1`. Recognizing a hash is not a claim that every release
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

Eve `0.83.0` and later stable releases include the upstream fix
(vercel/eve#5132). Eden leaves those bindings unchanged and reports
`✓ EVE_SANDBOX_RESUME_PATCH — not needed`. A prerelease of `0.83.0` still
uses the older checksum-based decision.

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

## Fresh Eve 0.82.0 preflight (2026-10-22)

Eve `0.82.0`'s just-bash binding has the same sha256 as `0.79.1`–`0.81.0`
(`ab8b1ad7398af8f6fd2a1e91eb0d1ff8d2b9b9afe1836234f36ce0e896791c45`), so the
temporary eve#4440 fix applies unchanged. A fresh
`npx eve@0.82.0 init my-agent --non-interactive` project, converted to pnpm
`11.21.0` with `just-bash` `3.6.0` using the setup documented at that time, passed
`eden preflight` with the published `@moinulmoin/eden@0.7.3` in 74 seconds:
frozen install, Eve build, `✓ EVE_SANDBOX_RESUME_PATCH`, linux/amd64 image
boot and health, and read-only Cloudflare access. This pnpm run did not include
a live deploy; the later npm launch run below did.

The upstream fix for eve#4440 (vercel/eve#5132) merged after `0.82.0` and
shipped in Eve `0.83.0`.

## Fresh Eve 0.82.0 npm launch run (2026-10-22)

A fresh `npx eve@0.82.0 init <name> --non-interactive` project retained its
generated v3 `package-lock.json` and no `packageManager` declaration. No
conversion to pnpm was performed.

- Pristine preflight failed after 16 seconds, reporting
  `EVE_JUST_BASH_MISSING`, `EVE_AUTH_SCAFFOLD`, and `EVE_WORLD_LOCAL`, plus the
  missing-`just-bash` build remediation.
- After `npm install just-bash@3.6.0`, bearer authentication, and model
  `alibaba/qwen3.7-flash` with `modelContextWindowTokens: 32000`, preflight
  passed in 74 seconds and deployment completed in 174 seconds.
- The deployed `eden-npm-1022.moinulislammoin2019.workers.dev` returned health
  HTTP 200 and unauthenticated info HTTP 401. An authenticated session returned
  HTTP 202 and streamed a real model reply: `message.completed` containing
  `EDEN_NPM_LIVE_OK`, followed by `turn.completed`.

This run used the default local Workflow World. `eden destroy` completed in
42 seconds and verified deletion of the Worker, Container application, and
registry repository. Independent checks returned HTTP 404 from the former
health URL, `No containers found.` from `wrangler containers list`, and
Cloudflare code `10007` (Worker does not exist) from `wrangler deployments list`.

The unchanged pnpm compatibility fixture (Eve `0.68.0`, pnpm `11.21.0`) also
passed preflight in 65 seconds, including frozen install, Linux/amd64 runtime
boot and health, and read-only Cloudflare target checks.

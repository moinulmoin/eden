# Eve compatibility

## Supported versions

`eden preflight` and `eden deploy` need Eve `0.91.0` or later. Older projects
fail with `EVE_VERSION_UNSUPPORTED` before anything is built. `eden destroy`
works for every deployment, whatever Eve it runs.

Agents already deployed from an older Eve keep running. To redeploy an
unchanged older project, run the previous CLI with the same `--project`,
`--env`, and `--name`, from the folder that holds the project's `.eden/`
records:

```sh
npx @moinulmoin/eden@0.11.5 deploy --project <dir> --env <env> --name <name> --env-file <file>
```

That CLI is frozen and gets no fixes. Moving the project to a supported Eve is
the long-term path; see [session behavior across Eve upgrades](#session-behavior-across-eve-upgrades)
for what happens to running sessions.

| Eve | Postgres World | Cloudflare World | Tested |
| --- | --- | --- | --- |
| `0.91.0`, the oldest supported | `@workflow/world-postgres` `5.0.5` | `@moinulmoin/eden-world-cloudflare` `0.11.2` or later | CI and Publish: the pinned Postgres World and the workspace Cloudflare World |
| `1.5.0`, the latest tested | `@workflow/world-postgres` `5.5.0` | `@moinulmoin/eden-world-cloudflare` `0.11.2` or later | CI and Publish: the pinned Postgres World and the workspace Cloudflare World |

Versions between the two, such as `1.3.0` and `1.4.0`, are still accepted by
`eden preflight` and `eden deploy`, but the gate no longer tests them. A
project on `1.3.0` needs no change to keep deploying. Eve `1.5.0` needs no
change in Eden or in the Cloudflare World. It bundles Workflow `5.8.0`,
including `@workflow/world` `5.4.0`, the version `@workflow/world-postgres`
`5.5.0` pins. With the Postgres World, move to `5.5.0` together with Eve
`1.5.0`. Its migration adds a rate limit table, and Eve's release notes ask
projects to run the World's `bootstrap` before deploying; `eden deploy`
already runs it before it publishes.

Eve `1.5.0` no longer sets `WORKFLOW_SPEC_VERSION=9`, so new runs use the
spec version the World declares. The Postgres World `5.5.0` declares spec 10.
The Cloudflare World declares spec 8 in every release, so its runs do not
change.

Eve `1.3.0` changes one thing for sessions started before Eve `1.0`. Its
release notes say that on a World without deployment affinity, a message
sent to such a session's original address now ends that session and starts
a fresh one, where the session used to stay stuck. Eve skips this check on a
World that declares `deploymentAffinity`. The Cloudflare World declares it,
so sessions there still move to the new version. The Postgres World
declares it only when given a deployment ID, which Eden does not set, so the
change applies there. Eve `1.4.0` adds to it, again only on a World without
deployment affinity: after an upgrade, Eve parks a turn the earlier version
started instead of replaying it, and cancels a connection event subscription
the earlier version started, so the agent must watch those events again. A
message sent to a session's ID over HTTP is not affected: on the Postgres
World, a session started on `0.91.0` answered HTTP 409 `session_stranded`
after an upgrade to `1.2.0`, `1.3.0` and `1.5.0` alike.

From `1.0.0-rc.6`, Eve refuses to start a session unless the World creates the
session's run and its start hook together. Older Worlds fail every new session
with HTTP 500, so preflight stops them with `EVE_WORLD_PAIRING`.

New Eve `1.5.0` projects pin `engines.node` to `26.x`. Eden builds and runs
every project on Node.js `24.17.0`, which Eve still supports, so the pin needs
no change.

The Cloudflare World declares `queueAuthMode: "skip"`, which Workflow SDK 6
will require. It means Eve does not check queue deliveries itself. That is
accurate on Eden: the Worker answers `404` for the workflow queue routes from
the internet, and Eden delivers queued work to the container itself. Eve
`0.91.0` does not read the setting. Cloudflare World `0.12.0` and older
declare nothing, so Eve `1.0.2` and later log there that the World declares no
`queueAuthMode` and that the route should be protected. That log line is
harmless; update the World package to remove it.

## What every project needs

- `just-bash` as a production dependency, selected explicitly in
  `agent/sandbox.ts` (or `agent/sandbox/sandbox.ts` when an `agent/sandbox/`
  folder exists):

  ```ts
  import { defineSandbox } from 'eve/sandbox';
  import { JustBashSandbox } from 'eve/sandbox/just-bash';

  export const environment = JustBashSandbox.environment();
  export default defineSandbox(() => environment.open());
  ```

- A real Eve authenticator; the ones `eve init` generates reject every
  Cloudflare caller.
- A durable World if sessions and pending approvals must survive updates.

The [fresh-project steps](../README.md#starting-from-a-fresh-eve-project) cover
all three.

## How Eden keeps this list true

- **Preflight** checks the Eve version and sandbox before building. After
  packaging, before booting the runtime image, `EVE_WORLD_PAIRING` checks
  the installed World version line, atomic start hooks, and the Cloudflare
  World's RPC auth. None of these checks changes Cloudflare.
- **CI** builds and boots two pinned projects under `validation/eve-compat/`,
  one per row above, and requires a real session to start. It does this twice:
  with `eve start` on the Postgres World, and with `eden preflight` and Eden's
  own image on the Cloudflare World built from this repository. The second run
  uses the World's core over local RPC, not a Durable Object. Both legs run
  on pushes to `main`, on pull requests, and before publishing a release.
  See [validation](./validation.md).
- **Renovate** opens a pull request when a new version of `eve`,
  `@workflow/world-postgres`, or `just-bash`, including release candidates, is
  one day old, so CI runs against it. The wait matches pnpm's one-day release
  age, which the fixture's frozen install enforces.
- **A live check on Cloudflare** runs before any release that changes deploy,
  runtime, or World code. One command, `pnpm run check:live`, deploys a fresh
  project to a temporary target with the Cloudflare World built from this
  repository, runs bash in a session, updates in place, upgrades Eve, lets
  the container sleep and wakes it, then destroys the target. It needs the
  maintainer's `cf` sign-in or `CLOUDFLARE_API_TOKEN`, so it does not run in CI.
  See [validation](./validation.md#live-check-on-cloudflare).

## Session behavior across Eve upgrades

Update both the Eden CLI and the project's Cloudflare World package. The
installed World must declare `deploymentAffinity`; updating the CLI alone
keeps the older behavior and the warning that an Eve upgrade ends sessions.

The same Eve version updates in place. Running work then uses the new code,
so keep code and state backward-compatible. A new Eve version gets a new
container. Existing sessions move on their next message with the same ID,
history, and sandbox files. Idle sessions move without a message. Work
already running finishes on the old version.

Sessions adopted from Eden `0.9.0` stay on the old version until they end;
they do not move to the new version. A session's first run also stays on
its original version until the session ends, so that version is kept even
after the session moves.

Interrupted sandbox transfers can be retried without overwriting active
files. Each container sleeps independently, but not during running work or
file transfers. A scheduled job can fire on both versions until the old
version finishes its work and Eden stops its schedules.

A later deploy removes old versions once their sessions end and their queued
work and transfers finish. Inactive instance records can remain until destroy.
Eden keeps at most 10 versions, including current and legacy. If cleanup
cannot make room, deploy refuses and lists the blocking versions and live
session counts. There is no override. Destroy removes every version,
including sessions still running. See
[Updating an agent](./deploy.md#updating-an-agent).

With the Postgres World or an older Cloudflare World, sessions do not move:
after an Eve upgrade they return HTTP 409 `session_stranded` and users start
new ones.

## History

Dated live runs and notes about older Eve versions are in
[Eve compatibility history](./eve-compatibility-history.md).

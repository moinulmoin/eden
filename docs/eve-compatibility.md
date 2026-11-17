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
| `0.91.0`, the oldest supported | `@workflow/world-postgres` `5.0.5` | `@moinulmoin/eden-world-cloudflare` `0.11.2` or later | CI, every push and release: the Postgres World at this version, and the Cloudflare World at the version being built |
| `1.0.2`, the latest stable | `@workflow/world-postgres` `5.2.1` | `@moinulmoin/eden-world-cloudflare` `0.11.2` or later | CI, every push and release: the Postgres World at this version, and the Cloudflare World at the version being built |

From `1.0.0-rc.6`, Eve refuses to start a session unless the World creates the
session's run and its start hook together. Older Worlds fail every new session
with HTTP 500, so preflight stops them with `EVE_WORLD_PAIRING`.

New Eve `1.0.2` projects pin `engines.node` to `26.x`. Eden builds and runs
every project on Node.js `24.17.0`, which Eve still supports, so the pin needs
no change.

With the Cloudflare World, Eve `1.0.2` logs that the World declares no
`queueAuthMode` and that the workflow route should be protected. Eden's Worker
already answers `404` for that route from the internet. The log line is
harmless.

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

- **Preflight** checks the project before anything is built or changed on
  Cloudflare: `EVE_VERSION_UNSUPPORTED`, `EVE_SANDBOX_PROVIDER`, and
  `EVE_WORLD_PAIRING` (World version line, atomic start hooks, and the
  Cloudflare World's RPC auth).
- **CI** builds and boots two pinned projects under `validation/eve-compat/`,
  one per row above, and requires a real session to start. It does this twice:
  with `eve start` on the Postgres World, and with `eden preflight` and Eden's
  own image on the Cloudflare World built from this repository. The second run
  uses the World's core over local RPC, not a Durable Object. It runs on every
  push and before every release. See [validation](./validation.md).
- **Renovate** opens a pull request when a new version of `eve`,
  `@workflow/world-postgres`, or `just-bash`, including release candidates, is
  one day old, so CI runs against it. The wait matches pnpm's one-day release
  age, which the fixture's frozen install enforces.
- **A live check on Cloudflare** runs by hand before any release that changes
  deploy, runtime, or World code: deploy a fresh project, start a session that
  runs bash, update it in place, send the same session another message, start a
  new session, destroy, and confirm the URL returns 404. When the change
  touches version retirement or session moves, the update also changes the Eve
  version.

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

# Troubleshooting

This page lists the failures and warnings Eden reports, grouped by the stage
where you meet them. Each entry gives the code you see, what it means, and
what to do about it.

Start with [installation and account setup](./install.md) and
[Deploy an existing Eve project](./deploy.md) if you have not deployed yet.

## How Eden reports a problem

Eden prints one line per check, one block per warning, and a final summary
line. A check line carries the code, the message, and a remediation arrow when
the check did not pass:

```text
✗ VAL-CLI-007-TARGET-CONFLICT — The exact Worker or Container target already exists, and the read-only inventory cannot prove Eden owns it.
  → Deploy under a different --name or remove the conflicting Worker/Container yourself; …
```

A failing run ends with the first failing check id:

```text
✗ deploy failed — first failing check: VAL-BUILD-004
```

Warnings do not stop a run. They print with an `!` and a remediation arrow:

```text
! EVE_WORLD_POSTGRES_POOLED — The configured Postgres connection uses a transaction-mode pooler port; …
  → Use the direct, unpooled Postgres URL for WORKFLOW_POSTGRES_URL …
```

When the command itself fails, the error goes to stderr in the form
`CODE [source]: message`, and the process exits with status `1`.

Every command accepts `--json`, which prints the machine-readable result
object instead of the human summary. The object holds `command`, `ok`,
`environment`, `name`, `checks`, `warnings`, `candidate`, and, for a deploy,
`deployment`.

The codes come from three places:

| Prefix | Meaning |
| --- | --- |
| `VAL-*` | Validation gates. Most run before Eden touches anything remote; the `VAL-LIFE-*` ones check cleanup and leftovers afterwards. |
| `EVE_*` | Findings from the CLI, from packaging and publication, and from the deployed runtime. |
| `HOST_*` | Errors raised inside the published Worker when it cannot reach the Container. |

Some packaging codes are renamed when they enter the check list. The names
you will actually see for those are `VAL-CLI-004` (from `ROOT_INVALID`),
`VAL-BUILD-001` (from `UNSUPPORTED_TOOLCHAIN` and `DEPENDENCY_AMBIGUITY`),
`VAL-BUILD-004` (from `EVE_BUILD_FAILED` and `UNSUPPORTED_EVE_OUTPUT`),
`VAL-SEC-003` (from `SECRET_EXCLUSION_FAILED`), `VAL-CROSS-004` (from
`SOURCE_RACE`), and `VAL-BUILD-005` (from `DOCKER_PLATFORM_BLOCKED`).

## Install and CLI startup

### `eden` is not found

The global bin directory is not on `PATH`. Follow the package-manager and
PATH section in [Install Eden](./install.md). Do not install a second copy
with another package manager to hide the problem; ownership of updates and
uninstallation becomes ambiguous.

Open a new shell after changing the installer configuration, then confirm:

```sh
eden --help
```

### The CLI does not start on your Node version

Eden needs Node `>=24.17.0` and has no upper bound on the Node major
version. Check it with:

```sh
node --version
```

Bun can install the package, but Eden always runs on Node. Do not run it with
`bunx --bun`.

### `COMMAND_UNKNOWN`

`Unknown Eden command "…".` You typed a command that does not exist. The
three commands are `preflight`, `deploy`, and `destroy`.

### `EVE_COMMAND_UNKNOWN`

`Unknown Eve command "…".` Same cause, reported by the argument parser.

### `EVE_ARGUMENT_UNKNOWN` and `EVE_OPTION_UNKNOWN`

The command contains an invalid argument or an unknown option, or a
positional argument where none is accepted. Run `eden <command> --help` for
the accepted options.

### `EVE_NAME_REQUIRED`

`An explicit --name is required for destroy and for production targets.`
Preview `preflight` and `deploy` derive a target name from `package.json`,
but `destroy` and `--env production` always need one:

```sh
eden deploy --env production --name my-eve-production
```

### `EVE_NAME_INVALID`

The `--name` value must be a lowercase alphanumeric target name with optional
dashes.

### `EVE_NAME_REPEATED` and `EVE_PROJECT_REPEATED`

`--name` and `--project` may each be supplied only once.

### `EVE_ENV_INVALID` and `EVE_ENV_REPEATED`

`The --env option must be preview or production.`, or
`The --env option may be supplied only once.`

### `EVE_ENV_FILE_UNSUPPORTED`

`The --env-file option is supported only by eden preflight and eden deploy.`
Cleanup does not need application secrets, so `eden destroy` rejects
`--env-file`.

### `EVE_ENV_FILE_REPEATED` and `EVE_ENV_FILE_INVALID`

`The --env-file option may be supplied only once.`, or
`The --env-file option requires a non-empty path.`

### `EVE_PROJECT_ROOT_INVALID`

`The selected Eve project root must be an existing, canonical directory.`
Point `--project` at the real application directory. Eden does not search
parent or sibling directories, and it does not follow a symlinked root.

### `EVE_NAME_DERIVATION_FAILED`

`A target name could not be derived from the project package.json; pass an
explicit --name.` Preview `preflight` and `deploy` derive the name from the
`package.json` name when you omit `--name`.

### `EVE_DEPLOY_BUSY`

`Another Eve deployment owns the exact target; retry after it finishes.`
Eden locks a target for the duration of a deploy. The lock lives at
`<project>/.eden/eve-deploy/locks/<environment>-<name>.lock`. Wait for the
other run to finish. If a run was killed, confirm no `eden` process is still
running before you remove the lock file by hand.

### Managed registry login fails with `-25299`

On macOS, a stale `registry.cloudflare.com` keychain entry makes the managed
registry login fail with `The specified item already exists in the keychain
(-25299)`. Remove the entry and retry:

```sh
security delete-internet-password -s registry.cloudflare.com
npx wrangler@4.147.0 login
```

## Project checks

These run before Eden builds anything. Nothing remote is touched.

### `VAL-CLI-004` — the project root or `package.json` is not usable

Eden reports the exact subject after the code. The usual messages:

| Message fragment | Cause | Fix |
| --- | --- | --- |
| `must contain a regular package.json` | The selected root has no `package.json`. | Select the actual Eve application root instead of an ancestor or a nested directory. |
| `is not valid JSON` | `package.json` does not parse. | Fix `package.json` and retry with the same root. |
| `must contain a JSON object` | `package.json` holds a non-object. | Provide a regular project manifest. |
| `must define a non-empty project identity` | `package.json` has no `name`. | Add a non-empty `package.json` name. |
| `must be an existing canonical directory` | The root does not exist, is a file, or is a symlink. | Pass the real, readable application directory. |
| `is not readable` | The root cannot be read. | Grant read access to the project root and retry. |
| `may not contain devices, sockets, FIFOs, or other special files` | A build input is a special file. | Remove the special file from the project inputs and retry. |

### `VAL-BUILD-001` — the toolchain or lockfile is not usable

This covers the package manager and the lockfile:

| Message fragment | Cause | Fix |
| --- | --- | --- |
| `requires packageManager to pin an exact pnpm version` | `package.json` has no `packageManager` field. | Set `package.json` `packageManager` to an exact value such as `pnpm@11.21.0`. |
| `supports only an exact pnpm@<major>.<minor>.<patch> pin` | The pin is a range, a tag, or another package manager. | Replace ranges, tags, and other package managers with an exact pnpm pin. |
| `must contain exactly one regular root pnpm-lock.yaml` | No root lockfile, or competing nested lockfiles. | Remove competing or nested lockfiles and retry with the matching root lockfile. |
| `A competing package-manager lockfile was found` | Another package manager's lockfile sits at the root. | Keep only the pinned pnpm toolchain and its matching root lockfile. |
| `is malformed or does not match the exact packageManager pin` | The lockfile does not match the declared pnpm version. | Regenerate the lockfile with the declared pnpm version and retry without changing it during packaging. |
| `could not complete without changing or bypassing the lockfile` | The frozen install failed with `ERR_PNPM_OUTDATED_LOCKFILE` or `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`. | Regenerate `pnpm-lock.yaml` with the declared pnpm version and retry without relaxing frozen mode. |
| `refused dependency build scripts that the project pnpm policy neither allows nor ignores` | The frozen install failed with `ERR_PNPM_IGNORED_BUILDS`. | Name the dependency under `allowBuilds` or `ignoredBuiltDependencies` in the project `pnpm-workspace.yaml` and retry. The known-optional `cbor-extract` addon is already exempted by Eden. |
| `The isolated pinned pnpm install failed with ERR_PNPM_…` | Any other pnpm failure inside the isolated builder. | Fix the reported pnpm failure without relaxing the frozen lockfile or the declared pnpm pin, then retry. |

Run these from the Eve project root to check the same things Eden checks:

```sh
node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).packageManager"
test -f pnpm-lock.yaml
pnpm install --frozen-lockfile
test -x node_modules/.bin/eve
```

### `VAL-CROSS-004` — the source changed while Eden was reading it

`An Eve build input changed while it was being observed`, or
`The selected Eve source directory was replaced or escaped while it was being
observed`. Eden builds from one immutable snapshot and refuses to mix
generations. Stop the editor, watcher, or build process that is writing into
the project, then retry.

### `VAL-BUILD-004` — the project-local Eve build failed

Eden runs the project's own `eve build` inside an isolated Linux/amd64
builder. When that build fails, the message is
`The project-local Eve build failed inside the isolated Linux/amd64 builder.`
Fix the project-local Eve build and retry without changing the authored
project during packaging.

The same check also carries the build-output problems, which report as
`UNSUPPORTED_EVE_OUTPUT`:

| Message fragment | Cause | Fix |
| --- | --- | --- |
| `build output is missing or escapes the immutable snapshot` | No usable `.output` directory. | Regenerate `.output` as a regular directory inside the isolated build snapshot. |
| `did not produce a regular Nitro server entrypoint` | `.output/server/index.mjs` is missing. | Fix the project-local Eve build so `.output/server/index.mjs` is generated inside the snapshot. |
| `produced an empty Nitro server entrypoint` | The entrypoint has no content. | Regenerate `.output/server/index.mjs` from the project-local Eve build. |
| `is not valid JavaScript` | The entrypoint does not parse. | Fix the project-local Eve build so `.output/server/index.mjs` passes Node syntax validation. |
| `prepared sandbox template root is missing` | The prepared sandbox template tree was not extracted. | Rebuild the candidate so the isolated builder extracts a regular `.eve/sandbox-cache` directory. |

## The environment file

### `VAL-SEC-001` — the `--env-file` could not be read

The check message carries the runtime-config error code. These are the
codes you will see:

| Code | Meaning | Fix |
| --- | --- | --- |
| `EVE_ENV_FILE_NOT_FOUND` | The explicit environment file does not exist. | Create the file or point `--env-file` at the right path. |
| `EVE_ENV_FILE_INVALID` | The path is empty, or the file could not be read safely. | Pass a real file path and make sure it is readable. |
| `EVE_ENV_FILE_UNREADABLE` | The file could not be inspected safely. | Fix the file permissions on the file and its parent directory. |
| `EVE_ENV_FILE_ENCODING` | The file is not valid UTF-8 text. | Re-save the file as UTF-8. |
| `EVE_ENV_FILE_MALFORMED` | A line is not a valid assignment; the message names the line number. | Fix the malformed line. Use `KEY=VALUE` records only. |
| `EVE_ENV_FILE_DUPLICATE` | The same variable is defined more than once; the message names the variable. | Keep one definition per variable. |
| `EVE_ENV_FILE_RACE` | The file changed while Eden was reading or validating it. | Retry with a quiescent file. |
| `EVE_ENV_RESERVED_VARIABLE` | The file tries to override a reserved host variable; the message names it. | Remove the reserved name. `HOST`, `NITRO_HOST`, `PORT`, `NITRO_PORT`, `NODE_ENV`, `NODE_EXTRA_CA_CERTS`, `WORKFLOW_LOCAL_BASE_URL`, `EDEN_WORLD_URL`, `EDEN_EVE_DEPLOYMENT_ID`, and `EDEN_EVE_GENERATION_ID` belong to the host. `EDEN_EVE_RUNTIME_REVISION` is host-owned too; it passes this check but fails the publish step with `EVE_HOST_CONFIG_INVALID` (the Worker-side check is `HOST_READINESS_UNPROVEN`). |

Keep the file outside source control, with the directory at mode `700` and
the file at mode `600`:

```sh
ENV_FILE="$HOME/.config/my-eve-project/preview.env"
mkdir -p "$(dirname "$ENV_FILE")"
chmod 700 "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
```

An `--env-file` that lives inside the project root is not an error. Eden
excludes that path, and every `.env*` file, from the project snapshot it
builds. The values still reach the Container through the protected
deployment path.

### `VAL-SEC-002` — reserved-name check blocked

A reserved name in the env file fails `VAL-SEC-001` with
`EVE_ENV_RESERVED_VARIABLE` (see the table above). `VAL-SEC-002` then shows
as blocked: `Reserved-name validation was blocked because explicit
environment validation failed.` Fix the `VAL-SEC-001` failure and retry.

### `VAL-SEC-003` and `SECRET_EXCLUSION_FAILED` — the generated runtime closure carries credential material

`SECRET_EXCLUSION_FAILED` fires when the **generated** runtime closure —
`node_modules`, `.output`, or `.eve/sandbox-cache` — contains credential or
environment material, or a symbolic link that escapes the snapshot. It does
not fire for the source tree, which Eden excludes by name. The check id is
`VAL-SEC-003` when the failure comes from the snapshot stage and
`SECRET_EXCLUSION_FAILED` when it comes from the runtime-image stage.

| Message fragment | Cause | Fix |
| --- | --- | --- |
| `contains a credential or environment file` | A dependency or build output ships a `.env*`, `.npmrc`, `.yarnrc*`, `.bunfig.toml`, `credentials.json`, `service-account.json`, `*.pem`, or `*.key` file. | Remove credential material from the project dependency and output closure and retry. |
| `contains an escaping symbolic link` | A dependency links outside the snapshot. | Regenerate dependencies and output without links outside the immutable snapshot. |
| `escaped or changed during secret validation` | The closure changed while it was validated. | Regenerate dependencies and output inside the immutable project snapshot. |

## Cloudflare account and target

### `VAL-CLI-007-CLOUDFLARE-ACCESS` — Cloudflare access is blocked

The check is blocked with
`Authenticated Cloudflare account and Container access could not be verified
without a mutating operation.` Eden reads the account and the Container
inventory through a read-only adapter and never mutates during preflight.

Confirm the account first:

```sh
npx wrangler@4.147.0 whoami
npx wrangler@4.147.0 login
```

The account must be on the Workers Paid plan, which Cloudflare Containers
requires. Review the account that `whoami` returns before you retry; Eden
never selects a different Cloudflare account silently.

When the read-only adapter itself fails, the check reports
`The exact read-only Cloudflare adapter failed without a safe result.` and no
remote mutation was attempted.

### `VAL-CLI-007-TARGET-CONFLICT` — the target exists and Eden cannot prove it owns it

Two different messages can land on this check.

**The target exists and the inventory cannot prove Eden owns it:**

> The exact Worker or Container target already exists, and the read-only
> inventory cannot prove Eden owns it.

The remediation is to deploy under a different `--name`, or to remove the
conflicting Worker and Container yourself. Eden never adopts or replaces
resources it cannot prove it created.

**A local record matches but the remote state does not:**

> The exact Worker or Container target exists, and although a local Eden
> record matches, provider state cannot prove it is the one Eden deployed —
> the target may have been recreated outside Eden.

Inspect the Worker at its `workers.dev` origin and the recorded deployment
history before redeploying. If it is not Eden's, deploy under a different
`--name` or delete it yourself.

**The target is Eden's but its record is incomplete** (updates only):

> The exact target is Eden-owned, but its immutable deployment record does
> not carry a readable Durable Object history.

Re-run the last successful deploy generation, or destroy the exact target.
Updating without the recorded migration history could diverge Durable Object
declarations.

### `VAL-HOST-006` — the public origin could not be proven

`The authenticated Cloudflare read did not prove the exact workers.dev origin
before Eve initialization.` The read must return one account id, one
`workers.dev` subdomain, and the exact Worker-origin binding. Re-authenticate
with `npx wrangler@4.147.0 login` and confirm the account, then retry.

### `EVE_ORIGIN_UNAVAILABLE`

The authenticated account and `workers.dev` subdomain were not returned by
the read-only resolver, or the authenticated origin did not match the exact
Worker target. The same `wrangler whoami` and `wrangler login` check applies.

## Packaging and the `eve build`

### `Cannot find package 'just-bash'` inside the builder

Eve's default sandbox needs `just-bash`, and Eden's isolated builder has no
Docker daemon and no `/dev/kvm`, so Eve cannot install the sandbox package
there. Declare `just-bash` as a production dependency of the Eve project,
regenerate the lockfile, and retry:

```json
{
  "dependencies": {
    "just-bash": "3.4.2"
  }
}
```

Eve `^3.1.0` is the range Eden's build has been exercised with. Then
reinstall so the lockfile matches:

```sh
pnpm install
```

Eden reports this as `VAL-BUILD-004` with
`The project-local Eve build failed inside the isolated Linux/amd64 builder
because Eve's default sandbox needs just-bash where no Docker daemon or
/dev/kvm exists.`

### `VAL-BUILD-005` — the Docker or OrbStack builder could not start

`The isolated Linux/amd64 Eve builder was unavailable or failed before a
verified image was produced.` Start Docker or OrbStack, confirm it can
build Linux/amd64 images, and retry without changing the project inputs:

```sh
docker version
```

### A custom sandbox is not supported

A custom `agent/sandbox.ts` or `agent/sandbox/Dockerfile` is not supported
yet. Eden requires a sandbox that can prewarm without privileged, device, or
host-kernel access. If the project's sandbox reports an unknown requirement,
the deploy fails with `VAL-BUILD-007` and the message
`The selected Eve sandbox has an unknown or unsupported Container host
requirement.`

A sandbox that never prepares a template also leaves the deployed agent
without one. Eden ships the prepared template at `/workspace/.eve/sandbox-cache`,
and without it Eve's sandbox tools fail on the deployed agent.

## Local image boot and health

### `VAL-BUILD-005` — the runtime image was not proven

`The Linux/amd64 Eve runtime image runner failed before returning a verified
result.`, or
`The runtime seam did not return complete proof of Linux/amd64 image
construction, official Eve-start boot, and real health.` Retry with the
pinned Docker or OrbStack runtime and inspect only the owned candidate
identities.

### `VAL-BUILD-006` — the image starts the Eve supervisor

`VAL-BUILD-006` only ever passes. The runtime image must launch the
project-local Eve start supervisor with host `0.0.0.0` and port `8080`, use
`/workspace` as its working directory, and keep the host-owned variables
`HOST`, `NITRO_HOST`, `PORT`, `NITRO_PORT`, and `NODE_ENV`. Eden builds the
image itself; a missing entrypoint, working directory, or host variable is
reported as `UNSUPPORTED_EVE_OUTPUT`.

### `VAL-BUILD-007` — a host requirement is outside the hosting contract

Eden proves Linux/amd64, a supported Workflow World, a supported sandbox,
disposable local storage, and bounded outbound networking. Failures report
the unsupported capability:

| Message fragment | Fix |
| --- | --- |
| `The selected Workflow World has an unknown or unsupported Container host requirement.` | Configure a project-owned Eve-compatible World whose runtime requirements are supported by a disposable Linux/amd64 Container. |
| `The selected Eve sandbox has an unknown or unsupported Container host requirement.` | Use a sandbox that can prewarm without privileged, device, or host-kernel access, or run the project outside Eden Deploy. |
| `requires privileged Container execution outside the hosting contract.` | Remove the privileged requirement. Eden does not adapt or substitute the runtime. |
| `requires a device or unknown device capability outside the hosting contract.` | Remove the device requirement. Eden does not grant devices. |
| `requires an unknown or unsupported host-kernel capability.` | Use only the documented process, network, and disposable-filesystem capabilities of the Linux/amd64 Container. |
| `requires an unknown or unsupported Container network capability.` | Use only bounded outbound networking. Eden does not provide a network adapter. |
| `requires durable local Container filesystem state.` | Configure a project-owned durable Eve-compatible World or external service. Container-local disk is disposable. |

### `EVE_HEALTH_FAILED` — Eve never reported ready locally

`The real Eve health route did not report ready before the bounded deadline
(last status: <status>).` Inspect the project-local `eve start` supervisor,
the Nitro child, the sandbox prewarm, and the Workflow World startup. Eden
does not replace them with a synthetic listener.

If health never reaches ready on a live deployment either, check the Eve
project's provider, Workflow World, and startup requirements. Eden deploys
the project; it does not replace those services.

### `EVE_HEALTH_PORT_UNAVAILABLE`

`No task-owned Eve health port was available in the allowed 4310-4399
range.` Free a local port in that range and retry.

### `EVE_SANDBOX_RESUME_PATCH` — the Eve sandbox file is not a known version

> Eve's just-bash file is not a version Eden knows; conversations may lose
> their sandbox after a skill change (eve#4440)

The deploy still succeeds. Pin Eve to a version Eden knows, or update Eden so
its known Eve versions include yours.

### `CLEANUP_UNVERIFIED` — owned local resources were not proven absent

`Owned runtime-image resources could not be verified absent.` Inspect only the
recorded image and boot-container identities. Eden never runs broad Docker
cleanup; remove only the recorded identity yourself.

### `WORLD_MIGRATION_FAILED` — the Postgres World setup failed

`The Postgres World schema migration or cbor-x codec check failed inside the
disposable Eve container.` Eden runs the World's idempotent setup binary
(drizzle migrations plus the graphile-worker schema) inside the disposable
deploy container before publishing, so the migration runs against the exact
deployed dependencies.

Confirm that `WORKFLOW_POSTGRES_URL` in `--env-file` is the direct, unpooled
database URL reachable from this machine, then retry. The migration is
idempotent, so a retry is safe. The deploy guide refers to this failure as
`EVE-WORLD_MIGRATION_FAILED`.

### `RUNTIME_CLOSURE_INCOMPLETE`

`The candidate records a prepared sandbox template but its tree is missing or
not a regular directory.` Regenerate the candidate so the isolated builder
extracts `.eve/sandbox-cache` into the immutable snapshot.

## Push and publish

These codes come from the image push and the Worker publication, after every
local check has passed.

### `DEPLOY_INDETERMINATE` — the image push could not be proven

Eden pushes the runtime image to the managed Cloudflare registry
(`registry.cloudflare.com`). When the push does not return a terminal
success, or the published image does not match the exact target repository
and digest identity, the deploy ends as indeterminate. See
[Indeterminate outcomes](#indeterminate-outcomes) below.

### `EVE_IMAGE_IDENTITY_MISMATCH`

`The exact Container image reference did not match the verified local image
digest.` The image reference does not belong to the candidate you built.
Retry the deploy so Eden resolves the reference from the verified local image
again.

### `EVE_IMAGE_IDENTITY_UNAVAILABLE`

`The deploy candidate did not resolve an immutable registry image
reference.` The local build did not produce a `sha256` image identity. Rebuild
with the pinned Docker or OrbStack runtime.

### `EVE_RUNTIME_PROTECTED_UPLOAD_FAILED` — the protected runtime store failed

One of three messages appears:

| Message | Meaning | Fix |
| --- | --- | --- |
| `The protected Eve runtime configuration upload failed before publication.` | The upload of the runtime values to the protected store threw. | Retry the deploy. The upload happens before the Worker is published, so nothing was promoted. |
| `The protected Eve runtime store returned an invalid revision handle.` | The store answered with a malformed revision or handle. | Retry the deploy. |
| `The protected Eve runtime store returned value-bearing metadata.` | The store returned runtime values in its metadata. | Retry the deploy and report the code; Eden refuses to publish that response. |

Related codes: `EVE_RUNTIME_PROTECTED_STORE_UNAVAILABLE` (deploy requires a
protected runtime store) and `EVE_RUNTIME_INJECTION_INVALID` (deploy runtime
configuration requires an explicit exact target identity).

### `EVE_HOST_CONFIG_INVALID`

`The exact Eve Worker/Container host configuration was invalid.` The message
names the offending value: an image that is not an immutable `sha256` digest
reference, an unsafe Container application or class name, an unbounded
instance name, an invalid or reserved runtime variable name, a cron
expression the wake trigger cannot express, or Durable Object history and
bindings that are not safely reusable.

## Public health and promotion

These codes come from the deploy run itself: the inline checks, the health
gate on the public URL, and the promotion of the generation.

### `EVE_DEPLOY_CHECKS_FAILED`

`The inline Eve deploy checks failed; no remote mutation was attempted.`
The summary names the first failing check. Fix that check and retry. `eden
preflight` runs the same checks and only reads remote state; it never mutates
it.

### `EVE_PREFLIGHT_FAILED`

`The Eve preflight checks failed; no remote mutation or active-state
promotion was attempted.`

### `EVE_DEPLOY_PROMOTION_FAILED`

`The Eve target pointer did not resolve to the promoted generation.` The
Worker and Container are live, but the local pointer under
`<project>/.eden/eve-deploy/targets/<environment>-<name>/CURRENT` does not
resolve to the generation Eden promoted. Inspect the local record and the
target before retrying.

### `EVE_DEPLOYMENT_FAILED`

`The Eve deployment failed before exact target promotion.` The summary adds
`The deployment failed before promotion; the exact target was not claimed.`
Read the last check and the deployment evidence under
`<project>/.eden/eve-deploy/generations/<generation>/deployment.json`.

### `EVE_RUNTIME_IMAGE_CLEANUP_FAILED`

`The Eve deployment is healthy and promoted, but exact image cleanup failed;
do not retry the deployment.` The deployment is live. Only the local runtime
image or the superseded registry tag was left behind. Remove exactly the
recorded identity; do not redeploy.

### `VAL-CROSS-004` after a healthy deploy

`The remote deployment is healthy, but exact local runtime-image cleanup
could not be verified.` Remove and verify only the task-owned runtime image
and boot container. Never use broad Docker cleanup.

### `VAL-LIFE-007`

`The update is healthy and promoted, but the superseded registry repository
<repository> could not be proven deleted.` Remove only that repository's
tags. Do not retry the deployment and do not run broad registry cleanup.

## Updates

Run `eden deploy` again with the same project, environment, and name to
update a target Eden owns.

### `EVE_UPDATE_RECORD_UNAVAILABLE`

The exact target is provably Eden-owned, but its immutable deployment record
is unreadable or does not carry a readable Durable Object history. Eden
refuses to update rather than emit a divergent migration list. Re-run the
last successful deploy generation, or destroy the exact target.

### `EVE_UPDATE_IN_FLIGHT`

> This update replaces the running Container; durable World runs in flight
> resume on the new code — Cloudflare has no deployment pinning, so keep step
> names and payload shapes backward compatible.

Let pending approvals and long runs settle before updating, or keep step
names, queue names, and serialized payloads compatible across the change.

### `EVE_UPDATE_WORLD_SWITCH`

> The compiled Workflow World changed since the last deploy; existing
> sessions and pending approvals stay in the previous World and do not
> migrate to the new one.

Existing Durable Object data is preserved — classes and bindings are never
removed — but runs started before the update remain where they were created.
Switching Workflow Worlds between deploys is a data migration.

### The update dropped your runtime variables

The Container receives the variable **names** from the `--env-file` of the
current deploy. An update run without `--env-file` publishes an empty list,
so the new Container starts without those variables even though the older
Worker secrets are still in the account. Pass the same `--env-file` on every
deploy, including updates:

```sh
eden deploy \
  --project "$PROJECT_ROOT" \
  --env "$ENVIRONMENT" \
  --name "$WORKER_NAME" \
  --env-file "$ENV_FILE"
```

## After the deployment is live

### The first request is slow, or it never answers

The Worker starts the Container on demand and waits for the real Eve health
route before it forwards anything. A cold start takes longer than a warm one.

When the Worker cannot start or reach the Container, it fails with
`HOST_READINESS_UNPROVEN`. The message names the cause:

| Message fragment | Meaning |
| --- | --- |
| `The Container runtime is unavailable.` | The Container binding is not available to the Durable Object. |
| `The configured Container image is unavailable to this Worker version.` | The Worker version does not configure the image the Container expects. |
| `The Eve health route is reachable but has not reported ready.` | Eve answered, but not with a ready status. |
| `The Eve health route did not return the expected successful status.` | Eve's health route answered with a non-200 status. |
| `The Eve health route did not return the expected JSON contract.` | The health route did not answer with JSON. |
| `The bounded Eve health probe timed out.` | The health probe did not answer in time. |
| `The Eve Container could not be scheduled for start.` | Cloudflare could not schedule the instance. |
| `The Eve Container did not reach its readiness deadline.` | The Container never became ready in time. |
| `The protected runtime contract is missing variable <name>.` | The Worker expects a runtime variable that the account no longer holds. Redeploy with the matching `--env-file`. |
| `The Container sleepAfter override is not a parseable duration.` | `EDEN_EVE_CONTAINER_SLEEP_AFTER` is not a duration. Use a value such as `90s` or `3h`, up to `345m`. |
| `The Container sleepAfter override exceeds 345m (5 h 45 min)` | Cloudflare stops a container within 6 hours of its Durable Object going idle, and Eden must snapshot before then. |

Read the Worker log in Cloudflare for the exact code, then check the
deployment's own providers, World, and startup requirements.

### The session stream hangs with headers only

`GET /eve/v1/session/<id>/stream` returns headers and then never sends a
line. This is the pooled-database case. Transaction-mode poolers — Neon's
`-pooler` host and Supabase's pooler on port `6543` — accept `LISTEN` but
never deliver notifications, so the live stream silently stalls while the
events do persist in the database.

Eden warns about this during preflight:

> `EVE_WORLD_POSTGRES_POOLED` — The configured Postgres connection uses a
> transaction-mode pooler host; transaction-mode poolers accept LISTEN but
> never deliver notifications, so live session streaming hangs.

Use the direct, unpooled URL for `WORKFLOW_POSTGRES_URL`. On Neon that is
the `DATABASE_URL_UNPOOLED` value, the host without `-pooler`; on Supabase
it is the direct connection on port `5432`. Then redeploy with the same
`--env-file`.

Confirm the difference with a stream that must emit NDJSON, not just headers:

```sh
curl -N "$DEPLOY_URL/eve/v1/session/<id>/stream"
```

### A schedule did not fire

Two separate causes.

**The cron expression cannot be evaluated ahead of time.** Standard 5-field
cron expressions (`minute hour day-of-month month day-of-week`) are
supported. Anything else — a seconds field, or an `@daily` shortcut — cannot
be evaluated ahead of time, so Eden warns and that schedule only fires while
the Container is already awake:

> `EVE_SCHEDULE_UNSUPPORTED` — Schedule <names> uses a cron expression
> Cloudflare wake triggers cannot evaluate, so it only fires while the
> Container is already awake.

Rewrite the schedule with a standard 5-field expression for anything that
must fire while the Container sleeps.

**Cloudflare has not started delivering the Cron Trigger yet.** After a
deploy, Cloudflare can take up to ~17 minutes to start delivering the Cron
Trigger. With the default 1-hour sleep the Container stays awake through that
window, so ticks still fire. With a much shorter sleep override, a tick in
that window can be missed.

### The sandbox cannot run `python`, `git`, or `npm`

The agent's sandbox is `just-bash`, a simulated shell, not a real Linux VM.
Files, `grep`, `sed`, `jq`, `sqlite3`, and `curl` work. `python`, `git`, and
`npm` do not.

If every sandbox tool fails with a provider mismatch instead, the Container
selected a different sandbox provider than the one the builder prepared.
Cloudflare's durable-object Containers expose `/dev/kvm`, which makes Eve's
`DefaultSandbox` pick microsandbox at runtime, while Eden's isolated builder
prepared the just-bash template. Eden removes the device before Eve starts so
runtime selection matches the build. That removal is part of the generated
image entrypoint, so a replaced image loses it.

### The sandbox template is missing from the image

`bash`, `read_file`, and `write_file` fail when the prepared sandbox
template is absent. Eden extracts Eve's prepared templates from the
builder's `.eve/sandbox-cache` into the runtime image. A failure to extract
them reports `UNSUPPORTED_EVE_OUTPUT` with `Rebuild the candidate so the
isolated builder extracts a regular .eve/sandbox-cache directory.`

### `EVE_WORLD_LOCAL`

> This project uses Eve's default local Workflow World; workflow state lives
> on the container disk, survives sleep, and resets when you update the
> agent.

Configure a durable Workflow World such as `@workflow/world-postgres`, or
`@moinulmoin/eden-world-cloudflare`, if you need state to survive an update.

### `EVE_WORLD_PAIRING` — the World version does not pair with Eve

> The installed <world> targets <package> <range>, but the project's Eve
> bundles `@workflow/core` <range>; Eve rejects this World at runtime.

Install the `<world>` release whose `@workflow/core` dependency matches the
Eve-bundled line. The pairing is version-specific: for Eve `0.68.0`, which
bundles `@workflow/world` `5.0.0-beta.39`, the tested pair is
`@workflow/world-postgres@5.0.0-beta.47`.

## Destroy and cleanup leftovers

`eden destroy` removes exactly one target. It needs the same project,
environment, and Worker name you deployed with, and it refuses `--env-file`.

Destroy reports one check per step:

| Check | Meaning |
| --- | --- |
| `VAL-LIFE-006-RECORD` | The immutable deployment record matched the exact target selectors. |
| `VAL-LIFE-006-WORKER` | The exact owned Worker was deleted, or it was already absent. |
| `VAL-LIFE-006-CONTAINER` | The exact owned Container application was deleted, or it was already absent. |
| `VAL-LIFE-006-REGISTRY` | Every registry image tag recorded for this exact target was deleted or proven absent. |
| `VAL-LIFE-006` | Exact absence was verified and only this target's `CURRENT` pointer was cleared. |

### `EVE_DESTROY_RECORD_UNPROVEN`

`No immutable deployed record matched the exact target; destroy refuses to
guess or broaden cleanup.` Eden keeps its deployment records under
`<project>/.eden/eve-deploy`. Deploy from this project root, or point
`--project` at the project you deployed, and retry.

### `EVE_DESTROY_RECORD_MISMATCH`

`The immutable deployment record does not match the selected target.` Use the
exact name and environment from the deployment.

### `EVE_DESTROY_OWNERSHIP_UNPROVEN`

`The authenticated account does not own the recorded deployment account.`
Authenticate with the account that owns the deployment:

```sh
npx wrangler@4.147.0 whoami
npx wrangler@4.147.0 login
```

### `EVE_DESTROY_INDETERMINATE`

The Worker or Container deletion did not complete with a terminal result. Eden
attempts no broad cleanup. Inspect the retained deployment record and the
Cloudflare inventory, then retry the exact target.

### `EVE_DESTROY_ABSENCE_UNPROVEN`

`The exact target could not be proven absent after deletion.` The `CURRENT`
pointer is left unchanged. Inspect the exact target inventory and retry
destroy once the provider state settles.

### `EVE_DESTROY_IMAGES_RETAINED`

`The exact Worker and Container are absent, but registry image tag(s) remain
in: <repositories>.` The message lists every repository. Retry `eden destroy`
with the same selectors, or remove only the listed repositories' tags:

```sh
npx wrangler@4.147.0 containers images delete <repository:tag>
```

Never filter by prefix.

### `EVE_DESTROY_POINTER_UNCLEARED`

`The target CURRENT pointer could not be cleared after verified absence.`
The remote resources are already gone; only the local pointer under
`<project>/.eden/eve-deploy/targets/<environment>-<name>/CURRENT` is left.

### `EVE_DEPLOY_LOCK_RELEASE_UNPROVEN`

`The Eve deployment lock could not be released with exact ownership proof;
local residue was retained.` Confirm no `eden` process is still running
against the target, then remove the stale lock file at
`<project>/.eden/eve-deploy/locks/<environment>-<name>.lock`.

### Checking for leftovers yourself

```sh
npx wrangler@4.147.0 containers list
npx wrangler@4.147.0 containers images list
```

Require zero new Worker, Container, or managed-registry image residue
associated with your target name. An unreachable URL alone is not sufficient
cleanup evidence.

## Indeterminate outcomes

Eden distinguishes three deployment outcomes:

| Outcome | Meaning |
| --- | --- |
| `deployed` | The Worker and Container are live, health reported ready, and the generation was promoted. |
| `failed` | The deployment stopped before promotion. The exact target was not claimed. |
| `indeterminate` | Eden could not prove the result. |

An indeterminate outcome means Eden lost certainty, not that the deployment
failed. It happens when the image push does not return a terminal success,
when the published image does not match the exact target repository and
digest, when the Worker publication throws before a terminal result, when
the health check throws or returns an indeterminate result, or when the
ownership of a created resource cannot be proven.

What to do:

1. Read the retained evidence. The deployment record is at
   `<project>/.eden/eve-deploy/generations/<generation>/deployment.json`. When
   an attempt ended indeterminate, the attempt evidence is
   `deployment-attempt.json` in the same generation directory.
2. Inspect the exact target in Cloudflare, and only the exact target:
   `npx wrangler@4.147.0 deployments list --name <name> --json`,
   `npx wrangler@4.147.0 containers list`, and
   `npx wrangler@4.147.0 containers images list`.
3. Retry the same exact target with the same `--project`, `--env`, and
   `--name` once you know what the previous attempt left behind. Eden will
   not adopt or replace a resource it cannot prove it created, so a retry
   against an unproven target stops with `VAL-CLI-007-TARGET-CONFLICT`
   instead of overwriting anything.

What not to do:

- Do not delete resources by prefix, and do not run a broad account-wide
  cleanup. Eden removes only exact, provably owned resources; a broad
  cleanup can take down deployments you did not intend to touch.
- Do not redeploy under a new name to "get past" an indeterminate result.
  That leaves the unproven resources behind.
- Do not delete the local `.eden/eve-deploy` records. They are the ownership
  proof `eden destroy` needs.

## Before you ask for help

Run the read-only checks and keep the output:

```sh
eden preflight --json
eden --version
```

Include in the issue:

- the Eden version (`eden --version`)
- the Eve version of the project
- the exact command you ran, with the flags you used
- the check id or error code, for example `VAL-CLI-007-TARGET-CONFLICT`
- the `eden preflight --json` output with secrets removed
- the relevant Worker log lines

Never paste secrets. Do not include the contents of your `--env-file`, API
keys, database URLs, tokens, or Cloudflare credentials. Variable **names**
are safe to share; their values are not.

Report the issue at https://github.com/moinulmoin/eden/issues.

Return to the [documentation index](./README.md).

# CLI and configuration reference

This page lists every Eden command, flag, default, file format, environment
variable, and resource name. The deployment walkthrough is in
[Deploy an existing Eve project](./deploy.md); installation is in
[Install Eden](./install.md).

## Commands

Eden has three commands and two top-level switches.

| Command | Purpose |
| --- | --- |
| `eden preflight` | Build and inspect a local Eve candidate without remote mutation |
| `eden deploy` | Deploy the selected Eve project to the exact named target |
| `eden destroy` | Remove the exact owned Eve target |

`eden --help` (or `-h`) prints the top-level usage. `eden --version` (or `-v`)
prints the installed version, for example `0.7.4`. Running `eden` with no
arguments prints the same usage. An unknown command fails with
`COMMAND_UNKNOWN`.

`eden <command> --help` prints the options of that command.

Every option that takes a value accepts both `--option value` and
`--option=value`, may be given only once, and takes a value that is neither
empty nor starting with `-`. `--json` and `--help` are switches and take no
value. A repeated option fails with a `..._REPEATED` code, an unknown option
with `EVE_OPTION_UNKNOWN`, and a positional argument with
`EVE_ARGUMENT_UNKNOWN`.

### `eden preflight`

Builds and inspects an immutable local Eve candidate. It snapshots the project,
runs the project's own `eve build` in an isolated Linux/amd64 builder, boots
the project-local `eve start` supervisor in a disposable local container, and
checks the real health route. Preflight also reads your Cloudflare account to
prove access and to read the exact target's state.

Preflight reads the project tree, the optional environment file, the local
deployment records under `.eden/eve-deploy/`, the Docker daemon, and the
Cloudflare account.

Preflight changes nothing in your Cloudflare account: it performs read-only
calls (`wrangler whoami --json`, `wrangler containers list --json`,
`wrangler deployments list --name <target> --json`, the account's
`workers/subdomain` endpoint, and the Worker's script settings) and never
uploads, publishes, or deletes. Locally it writes one generation directory
under `.eden/eve-deploy/generations/` and removes the Docker images it built.

The account is resolved only when the Wrangler login names exactly one
account, so Eden cannot pick between several.

| Flag | Value | Default | Required |
| --- | --- | --- | --- |
| `--project <path>` | Eve project root | current directory | never; must be an existing canonical directory that holds `package.json` |
| `--env <preview\|production>` | environment selector | `preview` | never; `production` also requires `--name` |
| `--name <name>` | exact target name | derived from the project's `package.json` | for `--env production` |
| `--env-file <path>` | runtime environment file | none | never |
| `--json` | print the machine-readable result object | human summary | never |
| `--help`, `-h` | print the command help | — | never |

### `eden deploy`

Deploys the selected Eve project to one exact target after the same checks
`preflight` runs. When the exact target already exists and Eden's immutable
record proves it owns that target, deploy updates the Worker in place and
keeps Durable Object data. A target Eden cannot prove it owns fails the
conflict check instead of being adopted.

Deploy reads the project tree, the optional environment file, the local
deployment records under `.eden/eve-deploy/`, the Docker daemon, and the
Cloudflare account. It changes the Cloudflare account by publishing the
Worker, its Container application, its Durable Object class, its Worker
secrets, and the registry image, and it changes the project directory by
writing a generation directory, the deployment record, and the `CURRENT`
pointer.

| Flag | Value | Default | Required |
| --- | --- | --- | --- |
| `--project <path>` | Eve project root | current directory | never; must be an existing canonical directory that holds `package.json` |
| `--env <preview\|production>` | environment selector | `preview` | never; `production` also requires `--name` |
| `--name <name>` | exact target name | derived from the project's `package.json` | for `--env production` |
| `--env-file <path>` | runtime environment file | none | never |
| `--json` | print the machine-readable result object | human summary | never |
| `--help`, `-h` | print the command help | — | never |

### `eden destroy`

Removes the exact target Eden owns. Destroy verifies the immutable ownership
record, reads the current remote inventory, deletes only that Worker and
Container application and the registry repositories this target pushed, proves
the target is absent, and only then clears the target's `CURRENT` pointer. It
never deletes by prefix or by a broad account search.

Destroy reads the local deployment records and the Cloudflare account, and
changes both: it deletes the Worker, the Container application, and the
registry repositories that the records prove this target pushed, and it
removes the local `CURRENT` pointer. The local deployment records themselves
are kept.

| Flag | Value | Default | Required |
| --- | --- | --- | --- |
| `--name <name>` | exact target name | none | always |
| `--project <path>` | Eve project root | current directory | never |
| `--env <preview\|production>` | environment selector | `preview` | never |
| `--json` | print the machine-readable result object | human summary | never |
| `--help`, `-h` | print the command help | — | never |

`destroy` rejects `--env-file` with `EVE_ENV_FILE_UNSUPPORTED`; cleanup does
not need application secrets.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command finished with its own result: the checks passed, the deployment is live, or the target was destroyed or was already absent |
| `1` | The command failed; the failing code and message are printed on standard error as `CODE [source]: message` |

A failed preflight or deploy exits with `1` even though the human summary was
already printed, so scripts must check the exit code as well as the summary.

## Target selection

### Target name pattern

A target name must match `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`: one to
63 characters of lowercase letters, digits, and dashes, starting and ending
with a letter or a digit. The same pattern is enforced for the Worker name
and the Container application name. A name that does not match fails with
`EVE_NAME_INVALID`.

### Derived default name

`preflight` and `deploy` derive a deterministic name when `--name` is omitted:

1. The raw name is the project's `package.json` `name` when it is a non-empty
   string; otherwise it is the last segment of the project directory path.
2. The slug is the raw name lowercased, with every run of characters outside
   `a-z`, `0-9`, and `-` replaced by a single `-`, repeated dashes collapsed,
   and leading or trailing dashes removed.
3. The digest is the first eight hexadecimal characters of the SHA-256 hash of
   the raw name.
4. The stem is the slug truncated to 54 characters with trailing dashes
   removed.
5. The target name is `<stem>-<digest>`, at most 63 characters.

| `package.json` name | Derived target name |
| --- | --- |
| `my-eve-app` | `my-eve-app-cfd08731` |
| `@acme/my agent` | `acme-my-agent-0d46d416` |

The digest keeps two package names that sanitize to the same slug apart. When
the slug would be empty, the run fails with `EVE_NAME_DERIVATION_FAILED` and
asks for an explicit `--name`.

### Preview and production

`--env` accepts `preview` or `production`; anything else fails with
`EVE_ENV_INVALID`. The environment is part of the local target key
(`.eden/eve-deploy/targets/<environment>-<name>/`) and of the registry
repository name, so the two environments keep separate ownership records.

The Cloudflare Worker name is exactly `--name` in both environments. Use a
different `--name` for production: a production run that reuses a name a
preview already occupies finds a target it cannot prove it owns and fails with
`VAL-CLI-007-TARGET-CONFLICT` instead of adopting it.

### Why destroy requires --name

`destroy` deletes resources, so it never guesses a target. Without `--name`
it fails with `EVE_NAME_REQUIRED`, exactly as `--env production` does for
`preflight` and `deploy`. The name you pass must match the name used for the
deploy, together with the same `--project` and `--env`, because the ownership
record is looked up by that triple.

## Environment file

`--env-file` points at a plain text file of runtime values. Eden parses the
file itself; the file path is resolved against the directory where the command
runs, not against `--project`.

### Format

The grammar is exactly `KEY=VALUE` per line:

```text
PROJECT_PROVIDER_KEY=replace-with-the-project-owned-value
PROJECT_WORLD_URL=https://example.invalid
```

- The file must be valid UTF-8. A byte-order mark is ignored.
- Lines are separated by newlines; a trailing carriage return is accepted.
- A blank line, or a line whose first non-whitespace character is `#`, is a
  comment and is skipped.
- Each other line must contain an `=`. The name is everything before the
  first `=`; the value is everything after it, including any further `=`.
- The name must match `^[A-Za-z_][A-Za-z0-9_]*$`. There is no whitespace
  allowed around the name, so ` KEY=value` and `KEY =value` are malformed.
- The value may be empty and is taken literally. Quotes are not stripped and
  there is no escape processing, so `KEY="value"` sets the value to
  `"value"`, and `KEY=value # note` sets the value to `value # note`.
- A name defined twice fails with `EVE_ENV_FILE_DUPLICATE`.
- A line that does not parse fails with `EVE_ENV_FILE_MALFORMED` and reports
  the line number.

The file must exist and be a regular file; a missing file fails with
`EVE_ENV_FILE_NOT_FOUND` and a symbolic link fails with `EVE_ENV_FILE_INVALID`.
Eden reads the file twice and compares both reads, so a file that changes
during the run fails with `EVE_ENV_FILE_RACE`.

### Location

The file may live anywhere Eden can read, including inside the project root.
When it is inside the selected project root, Eden excludes it from the project
snapshot, and it never reaches the image, the build environment, the generated
manifests, or the logs. Eden excludes the same way any other file whose name
starts with `.env`, and any `credentials.json`, `service-account.json`,
`.npmrc`, `.pnpmrc`, `.pypirc`, `.bunfig.toml`, `.yarnrc`, `.yarnrc.yml`,
`*.pem`, and `*.key` file.

`SECRET_EXCLUSION_FAILED` is a different failure: it is raised when the
generated runtime closure (installed dependencies and the `eve build` output)
contains such a credential or environment file, or contains a symbolic link
that escapes the immutable snapshot. Fix the closure, not the `--env-file`
path.

### Reserved names

These names are reserved for the host and are rejected in an environment file
with `EVE_ENV_RESERVED_VARIABLE`:

`HOST`, `NITRO_HOST`, `PORT`, `NITRO_PORT`, `NODE_ENV`,
`NODE_EXTRA_CA_CERTS`, `WORKFLOW_LOCAL_BASE_URL`, `EDEN_WORLD_URL`,
`EDEN_EVE_DEPLOYMENT_ID`, `EDEN_EVE_GENERATION_ID`.

`EDEN_EVE_RUNTIME_REVISION` passes the environment file parser but is
reserved on the Worker side, so a file that defines it fails the publish step
with `EVE_HOST_CONFIG_INVALID`; the Worker-side check that rejects it is
`HOST_READINESS_UNPROVEN`.

### How values reach the container

`eden preflight` keeps the values local: they are injected into the disposable
boot container only, and nothing is uploaded to Cloudflare.

`eden deploy` moves the values through two steps:

1. Each value is written as a Worker secret with `wrangler secret put`. The
   value is passed on standard input, never in the command line, the image, or
   the logs.
2. When the container starts, the Worker's Durable Object reads the secrets
   and passes them in the container's environment.

Only the variable names of the current run are published to the Worker, as
`EVE_RUNTIME_VARIABLE_NAMES`. Pass the same `--env-file` on every deploy: an
update without `--env-file` publishes an empty name list, so the new container
starts without those variables even though the older Worker secrets are still
in the account.

`eden destroy` never reads an environment file.

## Environment variables

### Variables Eden reads

| Variable | Read by | Effect |
| --- | --- | --- |
| `EDEN_EVE_CONTAINER_SLEEP_AFTER` | `eden deploy` | Sets the container idle sleep window. Format: a number with an optional `ms`, `s`, `m`, `h`, or `d` suffix, where a bare number means seconds (`90s`, `3h`). Default `1h`; the maximum is `345m` (5 h 45 min), because Cloudflare stops a container within six hours of its Durable Object going idle and Eden must snapshot before that. A larger value fails the publish step with `EVE_HOST_CONFIG_INVALID`; the Worker-side check is `HOST_READINESS_UNPROVEN` |
| `CLOUDFLARE_API_TOKEN` | Eden | Used instead of the Wrangler OAuth token for the account and subdomain reads |
| `WRANGLER_HOME` | Eden | Directory that holds the Wrangler OAuth token. Defaults to `~/Library/Preferences/.wrangler` on macOS and `~/.config/.wrangler` elsewhere |
| `DOCKER_HOST`, `DOCKER_CONTEXT` | Eden | Passed to the Docker CLI, so a remote or alternate Docker context can be used |

### Variables Eden sets in the container

The container starts with the project's own runtime values from the
`--env-file` plus these host variables:

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `NITRO_HOST` | `0.0.0.0` |
| `PORT` | `8080` |
| `NITRO_PORT` | `8080` |
| `NODE_ENV` | `production` |
| `WORKFLOW_LOCAL_BASE_URL` | The public `workers.dev` origin |
| `NODE_EXTRA_CA_CERTS` | The path of the Cloudflare Containers CA certificate |
| `EDEN_EVE_DEPLOYMENT_ID` | The deployment identity of this publish |
| `EDEN_EVE_GENERATION_ID` | The generation identity of this publish |
| `EDEN_EVE_RUNTIME_REVISION` | The revision handle of the protected runtime values, when an `--env-file` was supplied |
| `EDEN_WORLD_URL` | `<public origin>/__eden/world/rpc`, only with the Cloudflare Durable Object World |
| `CBOR_NATIVE_ACCELERATION_DISABLED` | `true`; the runtime image sets it for every deployment |

Eve is started as `./node_modules/.bin/eve start --host 0.0.0.0 --port 8080`.

### Worker variables

The published Worker carries these plain-text variables:

| Variable | Value |
| --- | --- |
| `EVE_PUBLIC_ORIGIN` | The stable `workers.dev` origin of this Worker |
| `EVE_CONTAINER_INSTANCE_NAME` | The stable container instance name |
| `EDEN_EVE_DEPLOYMENT_ID` | The deployment identity |
| `EDEN_EVE_GENERATION_ID` | The generation identity |
| `EVE_RUNTIME_VARIABLE_NAMES` | The names of the `--env-file` variables of this run |
| `EDEN_EVE_RUNTIME_REVISION` | The revision handle, when an `--env-file` was supplied |
| `EDEN_EVE_CONTAINER_SLEEP_AFTER` | The sleep override, when `EDEN_EVE_CONTAINER_SLEEP_AFTER` was set |
| `EDEN_EVE_WORLD_CLOUDFLARE` | `true`, only with the Cloudflare Durable Object World |

### Headers the Worker owns

Before a request reaches Eve, the Worker removes the incoming
`forwarded`, `x-real-ip`, `true-client-ip`, `x-original-host`,
`x-original-proto`, `x-envoy-original-host`, `x-envoy-original-proto`,
`x-proxy-host`, `x-host`, `x-eve-public-origin`, and
`x-workflow-local-base-url` headers, and sets `host`, `forwarded`,
`x-forwarded-host`, `x-forwarded-port`, and `x-forwarded-proto` itself.
`x-forwarded-for` is removed with every other incoming `x-forwarded-*`
header, and so are incoming `x-eden-*` and `cf-*` headers. The Worker also
adds `x-eden-eve-*` headers carrying the public origin, deployment identity,
generation identity, and correlation identity.

## What Eden creates

### In your Cloudflare account

| Resource | Name |
| --- | --- |
| Worker | Exactly the target name |
| Container application | `<name>-container`, truncated to 63 characters |
| Container instance | `<name>-instance`, truncated to 63 characters |
| Durable Object class | `EveHostDurableContainer`, plus `EdenWorldDurableObject` when the project selects the Cloudflare Durable Object World |
| Worker secrets | One secret per `--env-file` variable of this run |
| Cron Trigger | `* * * * *`, only when the project's compiled schedules contain at least one cron expression the trigger can evaluate |
| Registry repository | `eden-eve-<environment>-<name>-<target-key-digest>-<generation-id>` in `registry.cloudflare.com`, tagged `candidate` |

The target key digest is the first 24 hexadecimal characters of the SHA-256
hash of the project identity, account identity, environment, and name, so two
projects with the same name in different accounts do not share a repository.
The published image reference is the repository pinned to an immutable
`sha256:` digest.

The Worker is published with `compatibility_date` `2026-04-01`, the
`enable_ctx_exports` compatibility flag, and `workers_dev` enabled. The
Container runs on the `standard-1` instance type (1/2 vCPU, 4 GiB) with the
`durable_object` scheduling policy.

An update republishes the same Worker and the same Container application.
Durable Object classes are append-only: a new migration tag is added for a
new class, and existing classes and their data are kept.

### On disk

Everything Eden writes stays under `<project root>/.eden/eve-deploy/`:

```text
.eden/eve-deploy/
  generations/<generation-id>/
    container/snapshot/          the immutable source snapshot
    container/Dockerfile         the builder definition
    container/runtime.Dockerfile the runtime image definition
    input-manifest.json          the captured project inputs
    runtime-manifest.json        the built runtime metadata
    image-id                     the packaged candidate image identity
    runtime-image-id             the runtime image identity
    worker/worker.ts             the published Worker source
    worker/wrangler.jsonc        the published Wrangler configuration
    worker/eden-eve-host-worker.mjs
    deployment.json              the deployment record (mode 0600)
    deployment-attempt.json      retained evidence of an indeterminate attempt
  targets/<environment>-<name>/
    CURRENT                      a symlink to the promoted generation
  locks/<environment>-<name>.lock
```

The generation id is the name of the generation directory, and the CLI
creates that directory as `preflight-<uuid>`. Every `preflight` and `deploy`
of the same target therefore writes a new generation directory instead of
overwriting an old one; `destroy` writes none.

`CURRENT` is the promoted pointer: after a healthy deployment it is
re-pointed atomically at the new generation directory. It is the record
`destroy` reads to find what to remove and what to clear, and it is the
record the update path reads to carry the Durable Object history forward.

`deployment.json` holds the version, the status (`deployed`, `failed`, or
`indeterminate`), the deployment identity (project, source digest, generation,
deployment id, environment, name, account, subdomain, origin, Worker,
Container application, instance, image reference, runtime variable names, and
revision handle), the published Worker configuration, the Container
configuration, and the Durable Object bindings and migrations. It is the
immutable ownership proof: `destroy` refuses to act without it.

The lock file keeps one deploy or destroy per target at a time; a second run
fails with `EVE_DEPLOY_BUSY`. It is removed when the run ends, and local
residue is kept if its removal cannot be proven.

The generation directories are never deleted by Eden. Destroy keeps them and
says so in its summary.

### Local Docker images

Eden builds one packaged candidate image and one runtime image per run, both
`linux/amd64`; the runtime image is labelled
`eden.eve.generation=<generation-id>`. The boot container is named
`eden-eve-boot-<generation-id>`.

`eden preflight` removes both images before it finishes; a retained preflight
image fails the run. `eden deploy` keeps the runtime image until the
deployment is healthy and promoted, then removes that exact image and its
publication tags. A deployment that fails before promotion keeps its exact
local evidence instead of guessing at cleanup. Eden removes only the recorded
image identity and never runs a broad Docker cleanup.

## Pinned versions and requirements

| Requirement | Value |
| --- | --- |
| Node | `>=24.17.0` |
| Wrangler | `4.147.0`, installed as a direct dependency of the CLI |
| Project package manager | An exact `pnpm@<major>.<minor>.<patch>` pin in `package.json`; a range, a tag, or another package manager fails |
| Project lockfile | One root `pnpm-lock.yaml`. pnpm 9 and newer require `lockfileVersion: '9'`, pnpm 7 and 8 require `lockfileVersion: '6'`, older pnpm requires `lockfileVersion: '5'` |
| `just-bash` | A production dependency of the Eve project. Eve's default sandbox needs it inside Eden's builder, which has no Docker daemon and no `/dev/kvm`; without it the build fails and asks for the declaration |
| Docker | Docker or OrbStack with `linux/amd64` support. Eden selects no other architecture |
| Builder image | `node:24.17.0-bookworm-slim`, built and run as `linux/amd64` |
| Container instance | `standard-1` (1/2 vCPU, 4 GiB) |

## Output

### Progress lines

Human output starts with one header line, `eden <command> — <name>
(<environment>)`, followed by `... ` stage markers.

`eden preflight`:

```text
... validating environment file                     (only with --env-file)
... packaging project — snapshot, frozen install, eve build
... building linux/amd64 runtime image, booting eve, checking health
... checking Cloudflare access and exact target
```

`eden deploy`:

```text
... validating environment file                     (only with --env-file)
... packaging project — snapshot, frozen install, eve build
... checking Cloudflare access and exact target
... building linux/amd64 runtime image, booting eve, checking health
... update: Durable Object data is preserved; the running Container restarts on its next request to serve the new image
... pushing container image to the Cloudflare registry
... registering runtime variables                    (only with --env-file)
... publishing Worker and Container application
... verifying health at <public origin>
... deleting superseded registry repository <repository>   (only on an update)
```

`eden destroy`:

```text
... verifying the immutable ownership record
... reading the exact remote inventory
... deleting Worker <name>
... deleting Container application <name>-container
... deleting 1 registry repository
... deleting <n> registry repositories
... verifying the exact target is absent
```

### Check and summary lines

Every check is printed as `<glyph> <id> — <message>`, where the glyph is `✓`
for a passed check, `-` for a skipped one, and `✗` for a failed or blocked
one. A failed or blocked check adds an indented `  → <remediation>` line.
Warnings are printed as `! <id> — <message>`, followed by an indented
`  → <remediation>` line when the warning carries a remediation.

A successful preflight ends with:

```text
✓ <name> (<environment>) — preflight passed in <elapsed>
```

A successful deploy ends with the origin on its own line:

```text
✓ deployed <name> (<environment>) · eve <version>
<public origin>
done in <elapsed>
```

The `· eve <version>` suffix appears only when the build recorded an Eve
version. An update prints `✓ updated <name> (<environment>)` instead of
`✓ deployed`.

A successful destroy ends with:

```text
✓ destroyed <name> (<environment>) in <elapsed>
  retained: local deployment records under .eden/eve-deploy
```

A target that was already absent prints `✓ <name> (<environment>) is already
absent — nothing removed`, followed by the same `  retained: local deployment
records under .eden/eve-deploy` line.

A failed run prints `✗ <command> failed — first failing check: <id>` and
`stopped after <elapsed>`. A deploy that reached the publish step instead
prints `✗ deploy <status>`, where the status is `deployed`, `failed`, or
`indeterminate`, followed by a `  → ` line that says what is safe to do next.
A failed destroy prints `✗ destroy <name> <status>`, with
`— first failing check: <id>` appended when a check failed.

The elapsed time is printed in seconds with one decimal below ten seconds and
no decimals above it.

### `--json` result objects

`--json` prints one JSON object on a single line and no progress or summary
lines. A command that fails before its result object exists prints the error
on standard error instead and exits with `1`.

`preflight` and `deploy` print the result object:

| Field | Type | Notes |
| --- | --- | --- |
| `command` | `"eve preflight"` or `"eve deploy"` | |
| `ok` | boolean | |
| `environment` | `"preview"` or `"production"` | |
| `name` | string | The exact target name |
| `checks` | array | `id`, `status` (`passed`, `failed`, `blocked`, `skipped`), `message`, and `remediation` when present |
| `warnings` | array | `id`, `message`, and `remediation` when present |
| `candidate` | object or `null` | `generationId`, `sourceDigest`, `outputDigest`, and `imageDigest` when the image was built |
| `deployment` | object, on deploy | `status`, `operation` (`create` or `update`), `targetKey`, `deploymentId`, `workerName`, `containerApplicationName`, `stableContainerInstanceName`, `stableWorkersDevOrigin`, `imageReference`, `supersededGenerationId` and `supersededImageReference` on an update, `runtimeVariableNames`, and `evidenceRetained` |

`destroy` prints the destroy outcome:

| Field | Type | Notes |
| --- | --- | --- |
| `ok` | boolean | |
| `status` | `"destroyed"`, `"absent"`, `"failed"`, or `"indeterminate"` | |
| `environment` | `"preview"` or `"production"` | |
| `name` | string | The exact target name |
| `checks` | array | Same shape as the preflight and deploy checks |

Return to the [documentation index](./README.md).

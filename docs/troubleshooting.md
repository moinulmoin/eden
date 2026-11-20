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

When the command itself fails, human output sends
`CODE [source]: message` and a remediation arrow to stderr and exits with
status `1`.

Problems Eden can see without building are reported together in the first
run, before the build starts: the env file, the Eve version, the sandbox
module, Cloudflare access, and the project setup warnings.

`preflight`, `deploy`, and `destroy` accept `--json`. They print one JSON
object, including on failure. Failed runs include `error.code`,
`error.message`, `error.remediation`, `error.source`, and `error.diagnostics`.
Read `error.remediation` and any failed check's `remediation` before retrying.
Existing result fields, including `checks` and deploy `deployment` evidence,
remain available when the command produced them.

The codes come from three places:

| Prefix | Meaning |
| --- | --- |
| `VAL-*` | Validation gates. Most run before Eden touches anything remote; the `VAL-LIFE-*` ones check cleanup and leftovers afterwards. |
| `EVE_*` | Findings from the CLI, from packaging and publication, and from the deployed runtime. |
| `HOST_*` | Errors from the Worker or Container host, such as an invalid origin or a failed readiness check. |

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

Eden needs Node `^24.22.0 || ^26.12.0`: 24.22.0 or newer on the 24 line, or
26.12.0 or newer on the 26 line. Those are the lines the `cf` CLI that Eden
runs declares. Check it with:

```sh
node --version
```

Bun can install the package, but Eden always runs on Node. Do not run it with
`bunx --bun`.

### `EVE_NODE_UNSUPPORTED`

`Eden needs Node 24.22.0 or newer on the 24 line, or 26.12.0 or newer on the
26 line, and is running on Node <version>.`
`preflight`, `deploy`, and `destroy` stop with this code before they read or
change anything, because the `cf` CLI that Eden runs declares those Node
lines. Node 25, 26.0 to 26.11, and 27 or newer stop here too; Eden was not
run on them. Install Node 24.22.0 or newer on the 24 line, check it, then run
the command again:

```sh
nvm install 24
node --version
```

### `EVE_CF_UNAVAILABLE`

`Eden runs Cloudflare's cf CLI 1.0.0-rc.2, which is installed with Eden, and
could not find it.` or `Eden runs Cloudflare's cf CLI 1.0.0-rc.2 and found cf
<version> installed in its place.` `preflight`, `deploy`, and `destroy` stop
with this code before they read or change anything. Eden runs only the `cf`
version it was tested with. Install `@moinulmoin/eden` again with your
package manager, which installs that `cf` beside it, and do not install
another `cf` version over it. `eden --help` works without `cf`.

### `COMMAND_UNKNOWN`

`Unknown Eden command "…".` You typed a command that does not exist. The
four commands are `preflight`, `deploy`, `destroy`, and `skill`.

### `VERSION_UNAVAILABLE`

The installed Eden package manifest has no version. Reinstall Eden from the
published package with your existing package manager.

### `EVE_EXECUTION_FAILED`

The command failed unexpectedly without a more specific error code. Read
`error.remediation` in JSON output and retain the reported diagnostics when
reporting the failure. Inspect any deployment evidence before retrying.

### `EVE_COMMAND_UNKNOWN`

`Unknown Eve command "…".` Same cause, reported by the argument parser.

### `EVE_ARGUMENT_UNKNOWN` and `EVE_OPTION_UNKNOWN`

The command contains an invalid argument or an unknown option, or a
positional argument where none is accepted. `EVE_OPTION_UNKNOWN` names the
option, for example `Unknown option --bogus.` Run `eden <command> --help`
for the accepted options.

### `EVE_OPTION_VALUE_MISSING`

`The <option> option requires a value.` Supply the value after the option.
Run `eden <command> --help` to see what it accepts.

### `node: <path>: not found`, exit status 9

The `--env-file` path does not exist, and the command was started through
`npx` or `pnpm dlx`. Their own Node process reads `--env-file`
and stops before Eden starts, so there is no Eden code and no JSON object.
Create the file or correct the path. A globally installed `eden` reports the
same mistake as `EVE_ENV_FILE_NOT_FOUND` under
[`VAL-SEC-001`](#val-sec-001--the---env-file-could-not-be-read).

To get Eden's own report through `npx`, put `--` before the package name:
`npx -- @moinulmoin/eden preflight --env-file <path>`. Node then leaves the
flag alone and Eden prints `EVE_ENV_FILE_NOT_FOUND`, in the JSON object too.
`pnpm dlx -- @moinulmoin/eden …` does the same on pnpm `11.21.0` and
`12.22.0`. On pnpm `10.6.1` it fails with a 404 for a package named `--`.
A `--` after the command (`preflight -- --env-file`) fails with
`EVE_OPTION_UNKNOWN`.

That Node process does not load the values in the file, with one exception:
it applies a `NODE_OPTIONS` line to itself. A value that only works inside
the container, such as `NODE_OPTIONS=--require /app/instrument.cjs`, stops
`npx` and `pnpm dlx` with `Cannot find module` before Eden starts. The
`--` placement avoids that as well.

### `EVE_NAME_REQUIRED`

`An explicit --name is required for destroy and for production targets.`
Preview `preflight` and `deploy` derive a target name from `package.json`,
but `destroy` and `--env production` always need one. For `destroy`, use the
exact name the deploy printed:

```sh
eden deploy --env production --name my-eve-production
```

### `EVE_NAME_INVALID`

The `--name` value must be a lowercase alphanumeric target name with optional
dashes.

### `EVE_NAME_CONTAINER_SHARED`

`The name <name> would get the Container application <application>, which is
also the Container application of the name <shorter name>; nothing was read
or changed on Cloudflare.` Eden names a target's Container application
`<name>-container` and cuts it to 63 characters. A name of 62 or 63
characters leaves no room for the suffix, so its application has the
Worker's own name. When a shorter name's application is cut to that same
name, the two targets would share one Container application, and
`preflight` and `deploy` refuse the longer name. This happens only for a
62-character name that ends in `-container`, or a 63-character name that
ends in `-container` or a cut of it from `-c` to `-containe`. Rerun with
another `--name`. A name of 61 characters or fewer always gets a Container
application of its own. `eden destroy` still accepts the name.

Eden `0.15.0` and older accepted these names. If such a version deployed
both the long name and the shorter one, the two targets share one Container
application, and `eden destroy` of one whose Worker is already gone deletes
that application without checking whose it is. Before you destroy either
name, check in the Cloudflare dashboard whether a Worker with the other name
still exists; if it does, it stops working when the application is deleted.

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

### `EVE_PROJECT_INVALID`

`The --project option requires a non-empty path.` Supply the Eve project
root or omit `--project` when running from that root.

### `EVE_PROJECT_ROOT_INVALID`

`The selected Eve project root must be an existing, canonical directory.`
Point `--project` at the real application directory. Eden does not search
parent or sibling directories, and it does not follow a symlinked root.

### `EVE_NAME_DERIVATION_FAILED`

`A target name could not be derived from the project package.json; pass an
explicit --name.` Preview `preflight` and `deploy` derive the name from the
`package.json` name when you omit `--name`.

### `EVE_DEPLOY_BUSY`

`Another eden run in this project folder holds the lock for this name, which
is one Worker in both environments; retry after it finishes.` Eden locks a
name for the duration of a deploy or a destroy. The lock lives at
`<project>/.eden/eve-deploy/locks/<name>.lock` and covers both environments,
because `--env preview` and `--env production` of one name are the same
Worker. Wait for the other run to finish, then rerun the same `eden`
command. If a run was killed, confirm no `eden` process is still running
before you remove the lock file by hand.

### Managed registry login fails with `-25299`

`cf containers push` uses your Docker credential store. When the push fails
this way, the deploy's `DEPLOY_INDETERMINATE` message names the keychain
entry and the command below. Eden shows and keeps nothing else of what the
push printed.

On macOS, a stale `registry.cloudflare.com` keychain entry makes the managed
registry login fail with `The specified item already exists in the keychain
(-25299)`. Remove the entry and retry:

```sh
security delete-internet-password -s registry.cloudflare.com
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
| Missing or unsupported package manager declaration | pnpm has no exact pin, or `packageManager` declares an unsupported manager/version. | For pnpm, use an exact pin such as `pnpm@11.21.0`. For npm, omit `packageManager` to use npm `11.13.0`, or declare an exact npm pin at version 7 or newer, with a root `package-lock.json`. |
| Missing or malformed root lockfile | The selected manager's regular root lockfile is absent or invalid. | Regenerate the matching `package-lock.json` (npm lockfile v2/v3) or `pnpm-lock.yaml` locally, then retry. |
| `A competing package-manager lockfile was found` | Another package manager's lockfile is present. | Keep only the selected manager's root lockfile; do not convert a valid npm project to pnpm. |
| `The root lockfile is malformed or incompatible with the selected package manager or public registry.` | The lockfile cannot be used with the selected package manager or public registry. | Regenerate it with the selected package manager and use public dependencies. |
| `could not complete without changing or bypassing the lockfile` | Frozen dependency installation found an out-of-date or incomplete lockfile. | Regenerate the selected manager's lockfile locally, then retry without relaxing frozen mode (`npm ci` or `pnpm install --frozen-lockfile`). |
| `refused dependency build scripts that the project pnpm policy neither allows nor ignores` | The frozen install failed with `ERR_PNPM_IGNORED_BUILDS`. | Name the dependency under `allowBuilds` or `ignoredBuiltDependencies` in the project `pnpm-workspace.yaml` and retry. The known-optional `cbor-extract` addon is already exempted by Eden. |
| `The isolated pinned pnpm install failed with <code>.` | Any other pnpm failure inside the isolated builder. | Fix the reported pnpm failure without relaxing the frozen lockfile or the declared pnpm pin, then retry. |
| npm dependency installation fails | The lockfile needs private registry configuration, unsupported dependency scripts, or other unavailable install inputs. | Use public registry dependencies that work with `npm ci --ignore-scripts`; `.npmrc` is excluded and private registries are unsupported. |

For npm, run these from the Eve project root:

```sh
test -f package-lock.json
npm ci --ignore-scripts --no-audit --no-fund
test -x node_modules/.bin/eve
```

For pnpm, inspect the exact `packageManager` pin, check for `pnpm-lock.yaml`,
and run `pnpm install --frozen-lockfile` instead.

### `EVE_NPM_INSTALL_SCRIPTS_SKIPPED`

Eden's npm install skips dependency install scripts. The warning lists
production dependencies that may fail at runtime. Use packages that need no
install script, or switch to exact-pinned pnpm and list the required packages
under `allowBuilds` in `pnpm-workspace.yaml`.

### `VAL-CROSS-004` — the source changed while Eden was reading it

`An Eve build input changed while it was being observed`, or
`The selected Eve source directory was replaced or escaped while it was being
observed`. Eden builds from one immutable snapshot and refuses to mix
generations. Stop the editor, watcher, or build process that is writing into
the project, then retry.

### `VAL-BUILD-002` and `VAL-BUILD-003` — frozen install and immutable snapshot

These checks only ever pass. The isolated builder was given the exact
frozen install command and built from one snapshot, with source races checked.

### `VAL-BUILD-004` — the project-local Eve build failed

Eden runs the project's own `eve build` inside an isolated Linux/amd64
builder. When that build fails, the message is
`The project-local Eve build failed inside the isolated Linux/amd64 builder.`
It may add `Eve reported:` and the last lines Eve printed. Fix that error
(running `eve build` locally usually reproduces it) and retry.

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

The check message starts with the runtime-config error code, for example
`EVE_ENV_FILE_NOT_FOUND: The explicit Eve environment file does not exist.`
These are the codes you will see:

| Code | Meaning | Fix |
| --- | --- | --- |
| `EVE_ENV_FILE_NOT_FOUND` | The explicit environment file does not exist. | Create the file or point `--env-file` at the right path. |
| `EVE_ENV_FILE_INVALID` | The path is empty, or the file could not be read safely. | Pass a real file path and make sure it is readable. |
| `EVE_ENV_FILE_UNREADABLE` | The file could not be inspected safely. | Fix the file permissions on the file and its parent directory. |
| `EVE_ENV_FILE_ENCODING` | The file is not valid UTF-8 text. | Re-save the file as UTF-8. |
| `EVE_ENV_FILE_MALFORMED` | A line is not a valid assignment; the message names the line number. | Fix the malformed line. Use `KEY=VALUE` records only. |
| `EVE_ENV_FILE_DUPLICATE` | The same variable is defined more than once; the message names the variable. | Keep one definition per variable. |
| `EVE_ENV_FILE_RACE` | The file changed while Eden was reading or validating it. | Retry with a quiescent file. |
| `EVE_ENV_RESERVED_VARIABLE` | The file tries to override a reserved host variable; the message names it. | Remove the reserved name (see [Reserved names](./reference.md#reserved-names)). Never set `EVE_DEV`, `VERCEL`, `VERCEL_ENV`, or `VERCEL_TARGET_ENV`: they switch Eve into development mode and can let unauthenticated callers in. `EDEN_EVE_RUNTIME_REVISION` is host-owned too; it passes this check but fails the publish step with `EVE_HOST_CONFIG_INVALID` (the Worker-side check is `HOST_READINESS_UNPROVEN`). |

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
| `contains a credential or environment file` | A dependency or build output ships an environment or credential file from the [exclusion list](./security.md#secrets-and-the-env-file). | Remove credential material from the project dependency and output closure and retry. |
| `contains an escaping symbolic link` | A dependency links outside the snapshot. | Regenerate dependencies and output without links outside the immutable snapshot. |
| `escaped or changed during secret validation` | The closure changed while it was validated. | Regenerate dependencies and output inside the immutable project snapshot. |

## Cloudflare account and target

### `VAL-CLI-007-CLOUDFLARE-ACCESS` — Cloudflare access is blocked

The check is blocked with
`Authenticated Cloudflare account and Container access could not be verified
without a mutating operation.` Eden reads the account and the Container
inventory through a read-only adapter and never mutates during preflight.
`preflight` and `deploy` run this check before the build, so a missing login
fails in a few seconds.

When `cf` is not signed in, or its sign-in does not show exactly one
account, the remediation is `Run npx cf@1.0.0-rc.2 auth login --profile default, or
set CLOUDFLARE_API_TOKEN, and confirm with npx cf@1.0.0-rc.2 auth whoami
--profile default that it shows exactly one account. Then retry.`:

```sh
npx cf@1.0.0-rc.2 auth login --profile default
npx cf@1.0.0-rc.2 auth whoami --profile default
```

Eden reads the profile `CLOUDFLARE_AUTH_PROFILE` names, else `default`, and
not the one a folder is bound to with `cf auth activate`. The remediation
prints the commands with `--profile`, so they read the same login.

`cf auth whoami` exits 0 signed in or not, so Eden reads its JSON. The
sign-in counts only when `authenticated` and `tokenValid` are true and it
lists exactly one account. When you set `CLOUDFLARE_ACCOUNT_ID`, it must
name that account. A `CLOUDFLARE_API_TOKEN` that Cloudflare rejects does not
count.

Two cases get their own remediation, because signing in again changes
nothing in either:

- `CLOUDFLARE_API_TOKEN is set, and Cloudflare did not accept it or it can
  see no account.` `cf` uses the variable before any saved login. Correct
  the token or unset the variable.
- `CLOUDFLARE_ACCOUNT_ID names an account this login does not have.` Unset
  the variable or set it to the account `cf auth whoami` shows.

The Container read in this check is Eden's first read of Cloudflare's API.
When `cf` is signed in and does not hand Eden its login's token, the
remediation starts `cf is signed in, but Eden could not take its login's
token, which it needs to read Cloudflare's API.` Confirm the login and
retry. If it fails the same way, set `CLOUDFLARE_API_TOKEN`. See
[How Eden reads Cloudflare's API](./security.md#how-eden-reads-cloudflares-api).

#### Moving from the Wrangler login to cf

Eden 0.14 and earlier used Wrangler and its saved login. Eden now runs
Cloudflare's `cf` CLI, which does not read that login. When `cf` is signed
out and this machine has a Wrangler login file, the remediation says so:
`Eden now uses Cloudflare's cf CLI, which does not read the Wrangler login
this machine has. Run npx cf@1.0.0-rc.2 auth login --profile default once,
or set CLOUDFLARE_API_TOKEN, confirm the account with npx cf@1.0.0-rc.2 auth
whoami --profile default, then retry.` Sign in once; the `.eden/` folder and your deployed
targets need no change. Eden only checks that the Wrangler file exists and
never opens it.

The same check and remediation appear after the build when the login then
names a different account than it did before the build. Eden reads and
writes nothing in the second account. Confirm the account you intend with
`auth whoami`, then run the command again.

When `cf` is signed in but the account's Containers cannot be read, the
remediation says so. The account must be on the Workers Paid plan, which
Cloudflare Containers requires. Review the account that `auth whoami` returns
before you retry, or switch accounts with
`npx cf@1.0.0-rc.2 auth login --profile default`. Name the profile in
`CLOUDFLARE_AUTH_PROFILE` in place of `default` when you set one. Eden never
selects a different Cloudflare account silently.

When the read-only adapter itself fails, the check reports
`The exact read-only Cloudflare adapter failed without a safe result.` and no
remote mutation was attempted.

### `VAL-CLI-007-TARGET-CONFLICT` — the target exists and Eden cannot prove it owns it

The message depends on what Eden could verify.

**The target exists and the inventory cannot prove Eden owns it:**

> The exact Worker or Container target already exists, and the read-only
> inventory cannot prove Eden owns it.

The remediation is to deploy under a different `--name`, or to remove the
conflicting Worker and Container yourself. Eden never adopts or replaces
resources it cannot prove it created.

**A local record matches but the remote state does not:**

> The exact Worker or Container target exists, and although a local Eden
> record matches, provider state cannot prove it is the one Eden deployed —
> the target may have been recreated outside Eden. Unproven: <details>.

Inspect the Worker at its `workers.dev` origin and the recorded deployment
history before redeploying. If it is not Eden's, deploy under a different
`--name` or delete it yourself.

If the message ends with `Worker deployment stamp differs from recorded
identities` and the last successful update warned
`EVE_UNAUTHENTICATED_VERSIONS_RETIRED`, the record may be one that Eden
`0.11.2` through `0.12.0` could not read back; see
[`EVE_DESTROY_RECORD_UNPROVEN`](#eve_destroy_record_unproven).

**The target is Eden's but its record is incomplete** (updates only):

> The exact target is Eden-owned, but its immutable deployment record does
> not carry a readable Durable Object history.

Re-run the last successful deploy generation, or destroy the exact target.
Updating without the recorded migration history could diverge Durable Object
declarations.

### `VAL-HOST-006` — the public origin could not be proven

Deploy could not learn the account's `workers.dev` subdomain, which is part
of the deployment's URL. Eden reads the subdomain from Cloudflare's API
(`GET /accounts/<account id>/workers/subdomain`), before it changes anything
on Cloudflare. The message says which of three things happened:

- `Cloudflare account <account id> has no workers.dev subdomain, which is
  part of the deployment's URL.` The API answered `404` with the one error
  code `10007`, which is the code `cf` `1.0.0-rc.2` reads as "no subdomain
  registered". Register one at
  `https://dash.cloudflare.com/<account id>/workers/onboarding`, then run
  `eden deploy` again. No such account was available to test: the answer is
  known from `cf`'s code, not from a run on Cloudflare.
- `Eden could not read the workers.dev subdomain of Cloudflare account
  <account id> ... Cloudflare's API did not say that the account has none.`
  The read got no answer, an error such as an authentication error, or an
  answer Eden could not use. Confirm the login with
  `npx cf@1.0.0-rc.2 auth whoami --profile default`, or with the profile in
  `CLOUDFLARE_AUTH_PROFILE`, and run `eden deploy` again. The remediation
  prints the command with the profile.
- `The authenticated Cloudflare read did not prove the exact workers.dev
  origin before Eve initialization.` Any other case, such as an account
  that could not be read; the `VAL-CLI-007-CLOUDFLARE-ACCESS` check beside
  it then says why. Confirm the login the same way and run `eden deploy`
  again.

### `EVE_ORIGIN_UNAVAILABLE`

The authenticated account and `workers.dev` subdomain were not returned by
the read-only resolver, or the authenticated origin did not match the exact
Worker target.

Eden reads the subdomain from Cloudflare's API, as
[`VAL-HOST-006`](#val-host-006--the-public-origin-could-not-be-proven)
describes. An account with no Worker yet needs nothing more: the read does
not depend on a Worker.

If the origin resolver rejects the Worker name or account subdomain
(`HOST_ORIGIN_UNAVAILABLE`), the CLI reports its message under this code.

## Packaging and the `eve build`

### `EVE_VERSION_UNSUPPORTED` — Eve is below the supported floor

`eden preflight` and `eden deploy` require Eve `>=0.91.0`. Update the project's
Eve dependency and lockfile, then retry. An Eve upgrade may strand existing
Postgres-World sessions; read
[session_stranded](#old-sessions-return-session_stranded-after-an-eve-upgrade)
before upgrading.

Existing older deployments keep running, and `eden destroy` still works.
To redeploy the older project unchanged, use
`npx @moinulmoin/eden@0.11.5 deploy` with the same `--project`, `--env`, `--name`,
and `.eden` folder. That CLI is frozen and unmaintained.

### `Cannot find package 'just-bash'` inside the builder

Declare `just-bash` as a production dependency of the Eve project and update
the lockfile:

```sh
npm install just-bash
# For a pnpm project: pnpm add just-bash
```

Installing the dependency is not sufficient:
explicitly select `JustBashSandbox` using the
[sandbox setup](./deploy.md#sandbox-setup). The production default has no
provider in Eden's isolated builder and does not fall back to `just-bash`.

For an already-declared dependency with an out-of-date lockfile, reinstall
using the project's package manager:

```sh
npm install # or pnpm install for a pnpm project
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

Eden runs `docker build --load` when Docker Buildx is installed, so a
builder that keeps its result in its own cache, such as one with the
`docker-container` driver, still hands the image to Docker. Without Buildx
Eden runs plain `docker build`. A builder that cannot load a Linux/amd64
image into the Docker that `docker version` reports still fails here. Select
another builder with `docker buildx use <name>` and retry.

### `EVE_SANDBOX_PROVIDER` — select explicit JustBash

Eden supports only `just-bash`, including a project-owned module that explicitly
selects `JustBashSandbox`. Leaving the default selected fails before the
snapshot and build:

```text
Eve <version> requires an explicit JustBash sandbox in <path> on Eden; DefaultSandbox has no provider in Eden's isolated builder because production builds do not fall back to just-bash.
```

Follow the [sandbox setup](./deploy.md#sandbox-setup): install `just-bash` as a
production dependency and define the module in `agent/sandbox.ts`, or in
`agent/sandbox/sandbox.ts` when an `agent/sandbox/` folder exists. Commit the
module, manifest, and updated lockfile, then retry `eden preflight`. Do not set
`EVE_DEV`.

If the message says the module `sits beside the agent/sandbox/ directory`, move
it to `agent/sandbox/sandbox.ts`: supported Eve versions fail the build when
the module sits beside that directory.

If the message says Eve `built no just-bash sandbox template`, the sandbox
module passed the source check but `eve build` did not resolve it to JustBash,
for example because a helper file it imports returns `DefaultSandbox`. Select
`JustBashSandbox` as above.

A module selecting Docker, Vercel Sandbox, or another provider fails with the
same diagnostic and names the selected provider. A sandbox Dockerfile does not
make those providers supported.

An unsupported Container host requirement can also fail with `VAL-BUILD-007`:
`The selected Eve sandbox has an unknown or unsupported Container host requirement.`

A sandbox that never prepares a template also leaves the deployed agent
without one. Eden ships the prepared template at `/workspace/.eve/sandbox-cache`,
and without it Eve's sandbox tools fail on the deployed agent.

### `UNSUPPORTED_HOST_REQUIREMENT`

The project needs a host capability outside Eden's Linux/amd64 Container
contract, or its requirements could not be established. Read the reported
subject. Remove privileged execution, device access, unsupported kernel or
network requirements, or durable local disk requirements. Use a durable World
or external service for persistent state. If those requirements are essential,
run the project on a host that supports them.


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
| `The selected Eve sandbox has an unknown or unsupported Container host requirement.` | Select `JustBashSandbox` using the [sandbox setup](./deploy.md#sandbox-setup), or run the project outside Eden Deploy. Other sandbox providers are unsupported. |
| `requires privileged Container execution outside the hosting contract.` | Remove the privileged requirement. Eden does not adapt or substitute the runtime. |
| `requires a device or unknown device capability outside the hosting contract.` | Remove the device requirement. Eden does not grant devices. |
| `requires an unknown or unsupported host-kernel capability.` | Use only the documented process, network, and disposable-filesystem capabilities of the Linux/amd64 Container. |
| `requires an unknown or unsupported Container network capability.` | Use only bounded outbound networking. Eden does not provide a network adapter. |
| `requires durable local Container filesystem state.` | Configure a project-owned durable Eve-compatible World or external service. Container-local disk is disposable. |

### `DOCKER_PLATFORM_BLOCKED` — the image could not be built or started

`The Linux/amd64 Eve runtime image could not be built or inspected safely`
may end with the underlying error: the last lines Docker
printed, or a local error such as a full disk. Fix that error and retry.
Docker or OrbStack must be able to build and run `linux/amd64` images.

Eden lets Docker pick a free local port for the boot check and removes the
boot container on every failure. Several `eden preflight` or `eden deploy`
runs can share one Docker host.

### `EVE_HEALTH_FAILED` — Eve never reported ready locally

`Eve exited with code <code> before it reported ready.` Eve stopped during the
local boot check. If Eve printed output, the message adds `Its last output:`
and the last lines, with env-file values redacted. Fix that error and retry.
If the project reads a variable at startup, add it to
`--env-file`.

`The real Eve health route did not report ready before the bounded deadline
(last status: <status>).` The local polling budget is 30 seconds; an
individual probe can take up to 5 seconds. Inspect the project-local `eve start`
supervisor, the Nitro child, the sandbox prewarm, and the Workflow World
startup. Eden does not replace them with a synthetic listener.

If health never reaches ready on a live deployment either, check the Eve
project's provider, Workflow World, and startup requirements. Eden deploys
the project; it does not replace those services.

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

The push gets ten minutes. Then Eden stops `cf`, and only `cf`. `cf`
`1.0.0-rc.2` starts `docker push` as a process of its own, in its own
process group, and that process is not stopped: with the pinned `cf` and a
stand-in `docker`, the push went on and finished three seconds after Eden
had returned. The same holds when you stop Eden with Ctrl-C or a kill
during the push. So after such a deploy the Docker push may still be
running and may still finish. The remediation, and a line on standard error
after Ctrl-C, give the command that shows it:

```sh
ps -ax | grep "docker push registry.cloudflare.com/<account id>/<repository>:<tag>"
```

Let it finish, or stop it with `kill <process id>`. Docker's reference says
that killing `docker push` ends the push. Then run `eden deploy` again with
the same `--project`, `--env`, and `--name`.

A push that finished its upload leaves an image in the registry.
`deployment-attempt.json` in the generation folder names
its repository as `imageRepository`. Once a deploy
of the target has succeeded, `eden destroy` also empties the repositories
of its failed attempts. A target that never deployed has no deployment
record, so `eden destroy` answers `EVE_DESTROY_RECORD_UNPROVEN` and deletes
nothing. If you give the target up at that point, list that one repository
as [`EVE_REGISTRY_OBJECTS_KEPT`](#eve_registry_objects_kept) shows and
delete what it lists with
`npx cf@1.0.0-rc.2 containers images delete <repository>:<tag>`.

`cf containers push` signs Docker in to the registry, then runs
`docker tag` and `docker push`. When it fails, the message starts with
`The exact Cloudflare Container image push did not complete:` and says how:

| The message goes on | What happened |
| --- | --- |
| `cf containers push did not finish in Eden's ten minutes (no exit code). Eden stopped cf only. The Docker push that cf started may still be running and may still finish.` | The push took longer than ten minutes, or `cf` was killed. See above. |
| `cf containers push ran past Eden's ten minutes and did not stop when Eden killed it (no exit code). cf may still be running. The Docker push that cf started may still be running and may still finish.` | The system did not deliver Eden's kill of `cf`. Look for `cf` as well as for the Docker push. This case was not run. |
| `Docker's credential store already holds an entry for registry.cloudflare.com (cf exited <code>).` | See [Managed registry login fails with `-25299`](#managed-registry-login-fails-with--25299). |
| `docker login to registry.cloudflare.com failed (cf exited <code>). cf signs Docker in to the registry, and Docker saves that in its credential store.` | `docker login` exited with an error. |
| `Docker signed in to registry.cloudflare.com, and its tag or push command then failed (cf exited <code>).` | `docker tag` or `docker push` exited with an error. |
| `cf containers push exited <code>.` | `cf` failed another way, for example before it reached Docker. |

Eden shows and keeps nothing that `cf` or Docker printed during the push:
`cf` hands Docker the registry password, and Docker's output can repeat it.
The message holds only which of these fixed cases was seen and `cf`'s exit
code. The `cf` messages behind the rows were read from `cf` `1.0.0-rc.2`
run with a stand-in `docker` that failed at each step, not from a failed
push to Cloudflare's registry.

The publish is one `cf deploy --prebuilt`, which Eden never runs twice.
`cf deploy` uploads the Worker version first, then sets up the Container
application, then the `workers.dev` route and the schedule. When it exits
with an error, Eden checks whether the Worker version in service carries
this publish's release ID. Cloudflare can take a while to show a version it
just accepted, so Eden repeats that read for up to two minutes. Eden writes
what `cf` printed for the publish, and for each command it ran to finish it,
to `worker/cf-deploy.log` in the generation folder under
`.eden/eve-deploy/generations/`. When the publish carried runtime values,
the file keeps nothing `cf deploy` printed: only its exit code and, in
Eden's own words, which known `cf` message was seen.

If it does not, the message is `The exact Cloudflare publication did not
return a terminal success result.` Eden makes no further change. The failed
`cf deploy` may already have uploaded a Worker version. See
[Indeterminate outcomes](#indeterminate-outcomes).

If it does, Eden finishes the publish itself: it creates the Container
application when the account has none of the target's name, reads it back,
then deploys the triggers, trying again for up to two minutes while that
fails. Before each try it reads the release in service again, and that read
counts against the same two minutes. The deploy then continues as any other. Eden writes nothing when the
Worker version has no single binding for the Container class, or when a
Container application of that name has another ID, policy or namespace.
When one of those steps fails or one of those answers disagrees, the
message is `Cloudflare has this
publish's Worker version, but its Container application or triggers could
not be set up.` The remediation is `Run eden deploy again with the same
--project, --env, and --name: Cloudflare has this publish's Worker version,
and the next deploy sets up what is missing. Keep the .eden folder.` For a
target this project never promoted it adds `This was the target's first
deploy. To remove it instead, run eden destroy with the same selectors.`
`eden destroy` can remove a Worker that such a first deploy left without its
Container application.

After every publish Eden reads the release in service and the target's one
Container application together, for up to two minutes. When they do not
match, the message is `Cloudflare did not show this release in service
together with its one Container application after publication.` The last
promoted deploy stays current. Run `eden deploy` again with the same
selectors.

The whole publish has one deadline of 15 minutes, from the start of
`cf deploy` to the end of that last read. `cf deploy` itself gets at most
ten of them. Taking the token of the `cf` login counts against the same
deadline. Once the deadline has passed Eden starts no other command, and
the message is `The publish was not finished and checked within its 15
minutes.` Run `eden deploy` again with the same selectors.

### `EVE_IMAGE_IDENTITY_MISMATCH`

`The exact Container image reference did not match the verified local image
digest.` The image reference does not belong to the candidate you built.
Retry the deploy so Eden resolves the reference from the verified local image
again.

`The Container image reference is not
registry.cloudflare.com/<account>/<repository>@sha256:<digest> for the
authenticated account.` Only a programmatic caller can supply an image
reference. Eden accepts that one spelling and nothing else, so that cleanup
never sees two names for one repository. Eden refuses the reference before
it changes anything on the target.

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

### `EVE_HOST_BUNDLE_UNAVAILABLE`

The installed runtime package lacks the vendored Eve host Worker bundle.
Reinstall Eden from the published package with your existing package manager.

## Public health and promotion

These codes come from the deploy run itself: the inline checks, the health
gate on the public URL, and the promotion of the generation.

### `EVE_DEPLOY_CHECKS_FAILED`

`The inline Eve deploy checks failed; nothing was published for this target.`
The summary names the first failing check. Fix that check and retry. `eden
preflight` runs the same checks and only reads remote state; it never mutates
it.

### `EVE_PREFLIGHT_FAILED`

`The Eve preflight checks failed; no remote mutation or active-state
promotion was attempted.` Fix each failed check using its remediation, then
rerun `eden preflight`.

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
do not retry the deployment.` The remediation is:
`The deployment is live; do not redeploy. Remove only the recorded local
runtime image, or what the failed VAL-LIFE-007 check names in the superseded
registry repository.` Read the failed check to tell which cleanup failed.

When the failed check is a pending retirement of old versions, the message
is `The Eve deployment is healthy and promoted, but retiring old versions was
not proven. A later successful deploy retries cleanup for versions still
pending retirement; do not retry the deployment for this.` The remediation
is then the failed checks' own.

### `VAL-CROSS-004` after a healthy deploy

`The remote deployment is healthy, but exact local runtime-image cleanup
could not be verified.` Remove and verify only the task-owned runtime image
and boot container. Never use broad Docker cleanup.

### `VAL-LIFE-007`

The deployment is live. Read the check message to see which cleanup failed:

- `The update is healthy and promoted, but the superseded registry repository
  <repository> could not be proven deleted.` The check says: `Remove only
  what the registry still lists in the recorded repository <repository>,
  tags and sha256: entries; see VAL-LIFE-007 in docs/troubleshooting.md.
  Do not retry or run broad registry cleanup.` Use the
  [complete repository listing](#eve_registry_objects_kept).
- `The deployment is healthy, but resource retirement was not proven:
  <reason> Exact pending retirement records were retained for retry.` The
  check says: `Do not redeploy for this. The deployment is live. A later
  successful deploy retries cleanup for versions still pending retirement.
  Some retired resources may remain.`
  The `EVE_RUNTIME_IMAGE_CLEANUP_FAILED` error carries the same remediation.
  The retirement stays in the deployment record as pending. A later deploy
  you make for your own reasons runs it again after its own health check,
  unless that deploy makes the pending version current again. A failed
  cleanup does not show which of the retired versions' resources are still
  there. A deploy is an ordinary update that builds and publishes a new
  image, so do not make one for this cleanup alone.

A same-version update with deployment affinity deletes only the image it
replaced, by its release tag. When that cannot be shown, the check does not
fail: the deploy succeeds with the warning
[`EVE_SUPERSEDED_IMAGE_NOT_DELETED`](#eve_superseded_image_not_deleted).
The check is `skipped` with `Nothing was deleted: no release tag names the
superseded image.` when the replaced image was
pushed by Eden `0.13.x` or older, under `candidate`. Nothing is needed:
that image stays until `eden destroy` or the retirement of that Eve
version.

Kept objects alone do not fail the check. Deploy reports them in
[`EVE_REGISTRY_OBJECTS_KEPT`](#eve_registry_objects_kept), even when something
else makes the check fail. Eden's own requests to `registry.cloudflare.com`
never use a proxy. Without direct access it cannot verify the registry.

A complete deletion reports `Everything the registry listed in the
superseded generation's registry repository was deleted after promotion.`

Cleanup deletes everything the registry lists in a repository, so Eden
never runs it on a repository that holds a deployed image:

- `The superseded generation's registry repository <repository> also holds
  the promoted image, so nothing in it was deleted.` The check is
  `skipped` and the deploy succeeds. The Eden CLI pushes each generation to
  a repository of its own, so this happens only when a programmatic caller
  supplies an image in the previous generation's repository.
- `Repository <repository> holds an image that is still deployed; nothing
  in it was deleted.` The check fails, and that retirement stays recorded
  as pending. Other retirements in the same deploy still get their cleanup.
  This happens when the image of a version that is still kept is in the
  repository of a version being retired.

## Updates

Run `eden deploy` again with the same project, environment, and name to
update a target Eden owns.

### `EVE_UPDATE_RECORD_UNAVAILABLE`

The exact target is provably Eden-owned, but its immutable deployment record
is unreadable or does not carry a readable Durable Object history. Eden
refuses to update rather than emit a divergent migration list. Re-run the
last successful deploy generation, or destroy the exact target.

### `EVE_AFFINITY_REQUIRED`

This target retains affinity deployments, but the installed World package does
not declare `deploymentAffinity`. Install a World package that declares the
capability before updating the same target.

### `EVE_AFFINITY_CONTROL_ACTIVATION_TIMEOUT`

The rotated deployment-control credential did not activate within 60 seconds.
Eden refused publication. Confirm the current Worker is reachable and retry
with the same target.

### `EVE_AFFINITY_DRAIN_UNPROVEN`

The authenticated World returned missing or invalid deployment drain states.
Eden cannot establish which old deployments are idle. Check the World package
and its deployment-control RPC support before retrying.

### `EVE_AFFINITY_RETIRE_UNPROVEN`

The World did not prove that noncurrent deployments were durably fenced for
retirement. Check the World package's retirement support and retry the same
target. Do not delete retained deployments by hand.

### `EVE_AFFINITY_LIMIT`

At most 10 affinity deployments may be retained. Publication was refused.
The message lists blocking deployments and their live sessions, live runs,
pending messages, and unfinished transfers. Let that work finish before
deploying again.

### `EVE_UNAUTHENTICATED_VERSIONS_RETIRED`

Eden retired kept versions whose World RPC was unauthenticated. Their sessions
ended. Start new sessions on the current deployment. Old sessions may report
`Failed to send the session message.`

### `EVE_DESTROY_FAILED`

The destroy operation failed. Read the failed cleanup check and its
remediation. Keep the project's `.eden` ownership records and retry only the
same exact target after resolving that check.


### `EVE_SUPERSEDED_IMAGE_NOT_DELETED`

A warning on a successful same-version update: `The update is healthy and
promoted, but Eden could not show that the superseded image
<repository>@sha256:<digest> left Cloudflare's registry.` The deploy
succeeded and nothing is needed now. Do not redeploy for this: a later
deploy does not try this image again. The image may or may not still be in
the registry, with or without its tag.

- `eden destroy` tries to delete everything the registry lists for the
  target, and reports what Cloudflare keeps.
- After an Eve upgrade, the retirement of this Eve version does the same
  for this repository.

Eden deletes only the release tag the deployment record names for the
replaced image, and only when the registry resolves it to that image's
digest. It never deletes `candidate`. The same happens when
an update is interrupted after promotion and before the delete: the
replaced image stays until destroy or that retirement.

Eden reads the registry with direct requests to `registry.cloudflare.com`
and never uses a proxy for them. On a machine that cannot reach the registry
that way, every same-version update carries this warning.

### `EVE_UPDATE_IN_FLIGHT`

Same-version updates resume durable World runs on new code. Let pending
approvals and long runs finish first, or keep step names, queue names, and
serialized payloads backward-compatible. Deployment affinity separates Eve
versions, not every code release. Worlds without `deploymentAffinity` also
update in place.

### Old sessions return `session_stranded` after an Eve upgrade

Update both the Eden CLI and the project's World package. The installed
World must declare `deploymentAffinity`; updating the CLI alone is not
enough. Older Worlds still warn that an Eve upgrade can end existing
sessions, even when sandbox files are carried. Start new sessions on that
path. See the [recorded older-World upgrade](./eve-compatibility-history.md#eve-0820-to-0830-live-upgrade-2026-10-23).

With the updated Cloudflare World, running work finishes on the old version.
Existing sessions move to the new version on their next message; idle ones
move without a message. Sessions adopted from Eden `0.9.0` are different:
they stay on the old `eden-cloudflare` version until they end.

### Deploy waits for retirement-control authentication

Deploy rotates the reserved `EDEN_EVE_CONTROL_TOKEN` Worker secret only when
local records contain old versions to query or pending retirement cleanup to
retry. Fresh targets and current-only targets without pending cleanup skip it.
Rotation creates an additional Worker version with unchanged code. Activation
can take seconds. A read-only cleanup query retries HTTP 401 once per second
for up to 60 seconds. Other errors, including authentication failures during
cleanup, stop deploy. The token is not saved locally or written to logs. This
extra Worker version does not mean a container restarted.

### Deploy refuses because 10 versions are kept

The limit includes current and legacy versions. A later deploy removes old
versions once their sessions end and their queued work and transfers finish.
If adding a version would still exceed 10, deploy refuses before image/code
publication and lists the blocking deployment IDs and live session counts.
The cleanup credential rotation may already have created a Worker version
with unchanged code. There is no override flag.

A session's first run stays on its original version until the session ends,
so that version is kept even after the session moves. Let those sessions
end, then deploy again. Do not manually delete their images to make room.
`eden destroy` removes the whole target, including sessions still running;
it cannot remove just one old version.

### Old images or containers remain after a successful deploy

Old versions stay while sessions, queued work, or file transfers need them.
Cleanup happens on a later deploy, not immediately after a session moves.
Cloudflare can keep inactive instance records until destroy removes the
whole Container application.

Each container sleeps independently when idle, but not during running work
or file transfers. After an upgrade, a scheduled job can fire on both
versions until the old version finishes its work. Eden then stops the old
version's schedules. This window has no fixed timeout.

### Deploying a previously kept version fails its readiness check

Eden may need to restart that version to enable schedules, even if its image
has not changed. It waits for running work and file transfers to finish
before restarting. Let that work finish, then retry the same target. Do not
kill running work to force the restart.

Queued work and transfers continue while the public readiness check fails.
The wait has no fixed timeout.

### A session's sandbox transfer was interrupted

Interrupted transfers can be retried without overwriting active files on
the destination. Do not delete the old image while a transfer is unfinished.

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
The Worker can also throw `HOST_ORIGIN_UNAVAILABLE` when its configured
origin or deployment identity is missing or invalid. Check the Worker log
and the exact target's origin. `HOST_REQUEST_ABORTED` means the client
cancelled while the Worker was waiting for Eve to become ready; it is a
Worker exception, not an Eden CLI error or a JSON response code.

### The session stream hangs with headers only

`GET /eve/v1/session/<id>/stream` returns headers and then never sends a
line. This is the pooled-database case. Transaction-mode poolers — Neon's
`-pooler` host and Supabase's pooler on port `6543` — accept `LISTEN` but
never deliver notifications, so the live stream silently stalls while the
events do persist in the database.

Eden warns about this during preflight:

> `EVE_WORLD_POSTGRES_POOLED` — The configured Postgres connection uses
> <pooler reason>; transaction-mode poolers accept LISTEN but
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
In older Eve versions, access to `/dev/kvm` made `DefaultSandbox` choose
microsandbox at runtime while the builder prepared just-bash. Eden removes
that device before Eve starts. Current projects must select JustBash
explicitly.

### The sandbox template is missing from the image

`bash`, `read_file`, and `write_file` fail when the prepared sandbox
template is absent. Eden extracts Eve's prepared templates from the
builder's `.eve/sandbox-cache` into the runtime image. A failure to extract
them reports `UNSUPPORTED_EVE_OUTPUT` with `Rebuild the candidate so the
isolated builder extracts a regular .eve/sandbox-cache directory.`

### Project setup warnings

| Warning | Meaning | Action |
| --- | --- | --- |
| `EVE_JUST_BASH_MISSING` | Eve's default sandbox needs a missing production dependency inside the isolated builder. | Run `npm add just-bash` for npm, or `pnpm add just-bash` for pnpm, and retain the updated matching lockfile. |
| `EVE_AUTH_SCAFFOLD` | The project still uses generated authentication that does not grant production access on Cloudflare. | Replace the generated Vercel/localhost placeholder with your real [Eve authenticator](https://eve.dev/docs/guides/auth-and-route-protection), and supply its secrets through your external env file. |
| `EVE_VERCEL_CONNECT` | Project source imports or requires `@vercel/connect` or a subpath, but Vercel OIDC is unavailable on Cloudflare. | Supply your own API keys or bot tokens through `--env-file` and read them directly instead of calling `connect()`; see below. |
| `EVE_AI_GATEWAY_KEY_MISSING` | The project routes models through Vercel AI Gateway without a nonblank `AI_GATEWAY_API_KEY`. | Supply a gateway key through `--env-file`, or switch to a direct provider with its own API key; see below. |
| `EVE_WORLD_LOCAL` | Default local Workflow World state lives on container disk and resets on image updates. | Configure a durable Workflow World before relying on workflow state across updates; see below. |

### `EVE_VERCEL_CONNECT`

Project source imports or requires `@vercel/connect` or one of its subpaths.
Vercel OIDC is unavailable on Cloudflare, so `connect()` cannot obtain the
project's provider credentials there.

Put each service's own API key or bot token in the `--env-file`, and replace
`connect(...)` in the connection with a token read from the environment:

```ts
auth: { getToken: async () => ({ token: process.env.SERVICE_TOKEN! }) },
```

Connections where each end-user signs in need your own OAuth app through
`defineInteractiveAuthorization` from `eve/connections` instead.

### `EVE_AI_GATEWAY_KEY_MISSING`

The project routes models through Vercel AI Gateway, but its environment
does not supply a nonblank `AI_GATEWAY_API_KEY`.

Create a key at [Vercel AI Gateway API keys](https://vercel.com/dashboard/ai/api-keys)
and supply `AI_GATEWAY_API_KEY` through `--env-file`. Alternatively, switch
to a direct provider: for example, import `openai` from `@ai-sdk/openai`,
use `openai("…")` instead of gateway routing, and supply `OPENAI_API_KEY`
through `--env-file`.

### `EVE_WORLD_LOCAL`

> Local World stores memory on container disk; updates or a lost sleep
> snapshot reset sessions and approvals.

For durable state without a database, add `@moinulmoin/eden-world-cloudflare`
to the project's production dependencies and select it in `agent.ts`:

```ts
experimental: {
  workflow: { world: "@moinulmoin/eden-world-cloudflare" },
},
```

This experimental Cloudflare World stores state in a Durable Object, not on
container disk; sessions survive Eve upgrades with an updated CLI and World
package. See [Durable state on Cloudflare (no database)](./deploy.md#durable-state-on-cloudflare-no-database).

Alternatively, configure `@workflow/world-postgres` with a direct, unpooled
Postgres URL that supports `LISTEN`/`NOTIFY`; see the
[Postgres World setup](./deploy.md#durable-state-postgres-world). A
transaction-mode pooled URL breaks live session streaming.

### `EVE_WORLD_PAIRING` — the World version does not pair with Eve

> The installed <world> targets <package> <range>, but the project's Eve
> bundles `@workflow/core` <range>; Eve rejects this World at runtime.

This check runs after the packaging build and before the runtime boot check.
It checks the two known durable Worlds. Match the World's `@workflow/core`
or `@workflow/world` dependency to Eve's `@workflow/core` major and, if both
declare one, prerelease family. The tested pairs are: for Eve `1.1.0`, which
bundles `@workflow/world` `5.2.2`, the tested pair is
`@workflow/world-postgres@5.3.0`; for Eve `0.91.0`, which bundles
`@workflow/world` `5.0.5`, it is `@workflow/world-postgres@5.0.5`.

The Cloudflare World must also declare `eden.capabilities.worldRpcAuth`.
Without it, the agent's sandbox can read and change every session's workflow
state. Install `@moinulmoin/eden-world-cloudflare@0.11.2` or later.

On Eve `1.0.0-rc.6` and later, the check also fails when the World can't
start sessions the way Eve now requires:

> Eve <version> needs a World with atomic start hooks, and the installed
> <world> <version> does not have them; every new session would fail with
> HTTP 500.

Eve now refuses to start a session on a World without them. Update the
project's World: `@moinulmoin/eden-world-cloudflare` to `0.11.2` or later, or
`@workflow/world-postgres` to `5.1.1` or later.

## Destroy and cleanup leftovers

`eden destroy` removes exactly one target, including its retained instances
and images, except for
[`EVE_REGISTRY_OBJECTS_KEPT`](#eve_registry_objects_kept). It does not wait for
sessions to finish. Use the same project, environment, and Worker name.
Destroy refuses `--env-file`.

Destroy reports one check per step:

| Check | Meaning |
| --- | --- |
| `VAL-LIFE-006-RECORD` | The immutable deployment record matched the exact target selectors. |
| `VAL-LIFE-006-WORKER` | The exact owned Worker was deleted, or it was already absent. |
| `VAL-LIFE-006-CONTAINER` | The exact owned Container application was deleted, or it was already absent. |
| `VAL-LIFE-006-REGISTRY` | Everything the registry listed for this exact target was deleted or proven absent, apart from objects Cloudflare's registry keeps. Those are listed in the `EVE_REGISTRY_OBJECTS_KEPT` warning. |
| `VAL-LIFE-006` | Exact absence was verified and only this target's `CURRENT` pointer was cleared. |

### `EVE_DESTROY_RECORD_UNPROVEN`

`No immutable deployed record matched the exact target; destroy refuses to
guess or broaden cleanup.` Eden keeps its deployment records under
`<project>/.eden/eve-deploy`. Retry destroy from the root that holds those
records, or select that root with `--project`. If the folder no longer
exists anywhere, see [The `.eden/` folder is lost](#the-eden-folder-is-lost).

`The target's deployment record is not inside this project's own .eden
folder: a folder on the way to it is a symlink or could not be checked.`
`.eden`, `.eden/eve-deploy`, its `locks`, `generations`, or target folder,
or the generation `CURRENT` names, is a symlink to somewhere else or cannot
be read. Destroy reads nothing from Cloudflare and writes no lock. A record
file that is itself a symlink is not read either, and destroy then reports
that no record matched. Run `eden destroy` with `--project` set to the
project that deployed the target.

Eden `0.11.2` through `0.12.0` could write a record that they could not read
back. It happened when an update kept the Eve version and retired a kept
version whose World had no RPC authentication; that update warned
`EVE_UNAUTHENTICATED_VERSIONS_RETIRED`. After it, `eden destroy` stops here
and `eden deploy` stops with `VAL-CLI-007-TARGET-CONFLICT`. The record is
intact. Update `@moinulmoin/eden` to a later release and rerun the command.

### `EVE_DESTROY_RECORD_MISMATCH`

`The immutable deployment record does not match the selected target.` Use the
exact name and environment from the deployment.

### `EVE_DESTROY_OWNERSHIP_UNPROVEN`

`The authenticated account does not own the recorded deployment account.`
Sign in to the account that owns the deployment:

```sh
npx cf@1.0.0-rc.2 auth whoami
npx cf@1.0.0-rc.2 auth login
```

`Live provider settings do not match the recorded Worker and Container
identity; nothing was deleted.` Eden reads the bindings of the Worker
version in service. This fails when that version cannot be read, when its
deployment ID or release ID is not one the local records name, or when the
Container application's namespace does not match the Worker's binding. Eden
refuses to delete a same-name replacement.

`The Worker is gone, and the Container application named <name>-container
has the ID <id>, not the ID <id> this deployment's record holds. It is not
the one Eden deployed; nothing was deleted.` The Worker does not exist, and
a Container application of the target's name does, with another ID than the
one the deploy wrote into `deployment.json`: it is not the application
that deploy read back.

`The Worker is gone, and this deployment's record holds no usable ID for
the Container application named <name>-container: the publish ended before
Eden had read it, or the record is damaged. ...` The record's
`identity.containerApplicationId` is `null` or is not one ID. Eden writes
`null` before a publish and writes the ID only after it has read the
release in service and its Container application together. So a first
deploy that ended `DEPLOY_INDETERMINATE` has a record with `null`. While
its Worker exists, `eden destroy` still removes that Worker and its
Container application, proven by the Worker as before. Once the Worker is
gone, Eden cannot tell the application from another of the same name.

In both cases destroy deletes nothing, the registry included, and leaves
the record and `CURRENT` as they are. Look at that application in the
Cloudflare dashboard of the account the message names. If it is yours to
remove, delete it there, then run `eden destroy` again with the same
`--project`, `--env`, and `--name`; it removes the rest and clears
`CURRENT`. If it belongs to something else, leave it and keep the `.eden`
folder.

A record written by Eden `0.15.0` or older has no
`containerApplicationId` field at all. Only for such a record does destroy
still delete the application by its name, until a deploy by a newer Eden
writes one. Going back is not supported: a deploy by Eden `0.15.0` or
older over a target this version deployed promotes a record without the
field, and destroy then treats the target as one of those older records.

A Worker that a first deploy left without its Container application does
not fail here: destroy proves it from the version in service and the failed
attempt's record, and removes it.

A Worker that holds only secrets fails here. Eden 0.14 and earlier set
secrets before the first publish, so a first deploy that failed there left
such a Worker. This version uploads the secrets with the Worker version and
creates no Worker before that upload. Such a Worker carries nothing that
names Eden, so destroy does not delete it; the steps below apply. Its
deployment history is not empty: it holds the secret changes that failed
deploy made.

If the account is right, wait a minute and rerun `eden destroy`. If it keeps
refusing, Eden cannot prove ownership and will not delete the Worker. Only
the person who owns the Cloudflare account can decide to. Open
`<project>/.eden/eve-deploy/generations/<generation>/deployment-intent.json`
and the Cloudflare dashboard, and stop unless every one of these holds:

1. The dashboard is open on the account whose id is `identity.accountId`
   in that file.
2. The Worker's name is `identity.workerName` in that file.
3. The Worker's deployment history in the dashboard is not empty, and every
   deployment in it was made while the failed `eden deploy` ran, by you.
4. No other project or person deploys a Worker with that name.

Then delete that Worker in the dashboard, and rerun `eden destroy` to clear
the rest. Do not run `cf workers delete` from a project folder for this:
`cf` runs the nearest `cloudflare.config.ts` it finds from its folder upward
and reads `.env` files beside it, so a file can choose another account.

### `EVE_CF_LOGIN_TOKEN_UNAVAILABLE`

`Eden could not take the token of cf's login, so it could not read
Cloudflare's API; nothing was deleted.` `cf` is signed in to the recorded
account, `CLOUDFLARE_API_TOKEN` is not set, and `cf` did not hand Eden its
login's token when asked. [How Eden reads Cloudflare's API](./security.md#how-eden-reads-cloudflares-api)
describes that step. Confirm the login and run the command again:

```sh
npx cf@1.0.0-rc.2 auth whoami --profile default
```

If it fails the same way, set `CLOUDFLARE_API_TOKEN` to an API token for the
account. Eden then reads with that token and asks `cf` for nothing.
`preflight` and `deploy` report the same cause in
[`VAL-CLI-007-CLOUDFLARE-ACCESS`](#val-cli-007-cloudflare-access--cloudflare-access-is-blocked).

### `EVE_DESTROY_INDETERMINATE`

The exact remote inventory could not be read completely, or a Worker or
Container deletion did not complete with a terminal result. Eden never treats
an authentication, permission, network, malformed or incomplete inventory
result as absence. Inspect the retained deployment record and Cloudflare
inventory, then retry the exact target.
Eden reads the Worker from Cloudflare's API
(`GET /accounts/<id>/workers/scripts/<name>/deployments`). A whole answer
with status `200` that lists deployments, each with an id, means the Worker
exists. It is absent only on the API's own answer: status `404`, `success`
false, a null `result`, exactly one error with code `10007`, and no
message beside it. The read of the Worker itself
(`GET /accounts/<id>/workers/workers/<name>`) must then give the same
answer, because Cloudflare's two reads can disagree for a while after a
Worker is created or deleted. Any other answer, a redirect, a partial
answer, a body that names a field twice, and no answer are indeterminate.
What `cf` prints decides none of this. When a `cf` delete does not exit 0,
Eden reads the API the same way to learn whether the object is gone, with
code `1609` for a Container application. An unreadable registry listing
is reported separately, as `EVE_DESTROY_IMAGES_RETAINED`. Rerun
`eden destroy` with the same selectors; if it keeps failing, check the
login with `npx cf@1.0.0-rc.2 auth whoami`.
Eden lists Container applications by exact name
(`GET /accounts/<id>/containers/applications?name=<name>`) and follows the
page tokens Cloudflare returns, for at most twenty pages. A count or total
that does not match the entries read is indeterminate.
A full response without pagination metadata or a failed page read is
indeterminate, never proof that the named application is absent.

Destroy also fails with this code after its deletes when `cf` is signed
in to another account by the time destroy verifies. A read of another
account proves nothing about the recorded one, so the `CURRENT` pointer is
left unchanged.

### `EVE_DESTROY_ABSENCE_UNPROVEN`

`The exact target could not be proven absent after deletion.` The `CURRENT`
pointer is left unchanged. Inspect the exact target inventory and retry
destroy once the provider state settles.

### `EVE_DESTROY_IMAGES_RETAINED`

`The exact Worker and Container are absent, but registry objects remain, or
could not be listed, in: <repositories>.` The message lists every
repository. Retry `eden destroy` with the same selectors: it deletes what
the registry still lists, verifies the registry, and clears the target's
`CURRENT` pointer. A retry that finds nothing left reports `absent` and
changes nothing, so a `CURRENT` pointer from the failed run stays. Nothing
more is needed: destroy keeps reporting `absent`, and deploy reads a record
only for a target that exists on Cloudflare.

You can delete a listed tag by hand first:

```sh
npx cf@1.0.0-rc.2 containers images delete <repository:tag>
```

That removes no `sha256:` entry, so run `eden destroy` again afterwards. Never filter by prefix. An object with one
of the three kept answers is not counted here; see
[`EVE_REGISTRY_OBJECTS_KEPT`](#eve_registry_objects_kept). Destroy fails
with this code for anything else the registry still lists, including a tag
that is still listed after `cf` deleted it and an object whose delete
got any other answer, and when it could not read the registry's listing.

Eden reads the listing and sends its own deletes straight to
`registry.cloudflare.com` and never uses a proxy for them. If this machine
reaches the internet only through a proxy, or the registry does not answer,
destroy cannot read the listing. It then deletes the Worker and the
Container application, deletes nothing in the registry, and fails with this
code. It waits at most 60 seconds in total for registry requests that get
no answer. Run `eden destroy` again, with the same selectors and the same
`.eden` folder, from a machine that can reach `registry.cloudflare.com`
directly.

An entry that appears in the listing while destroy runs gets its own
delete. Destroy makes at most three such passes over a repository and fails
with this code if new entries still appear after them.

Destroy reads a listing only in the form Cloudflare's registry sent on
2026-11-18. It treats a listing as unreadable, never as empty, unless every
page:

- answers `200` with exactly `{"name":"<account>/<repository>","tags":[…]}`
  for the account and repository asked, with no other field and neither
  field twice;
- lists only tags and `sha256:` digests, in ascending order, each after the
  last entry of the page before;
- has a `Link` header that is the request's own URL followed by
  `?n=1000&last=<cursor>; rel=next`, where the cursor is the page's last
  entry, and empty only on an empty page.

The listing must end with an empty page within 100 pages. If the registry
changes any of this, cleanup fails with this code until Eden is updated.

Destroy reads the listing once more after its deletes. When that final
listing is unreadable, destroy fails with this code and leaves the
`CURRENT` pointer unchanged, whatever the deletes answered.

### `EVE_REGISTRY_OBJECTS_KEPT`

A warning, not a failure. `eden destroy` still ends with `destroyed` and
exit code `0`:

> Cloudflare's registry still lists <n> object(s) that Eden tried to
> delete: <how many got each answer>. Cloudflare documents that it removes
> a snapshot 30 days after it was created or last restored. Eden does not
> know when Cloudflare removes the other objects, or whether any of them
> counts toward the account's image storage limit.

The text output then lists every kept object on its own
`kept: <ref> (<class>)` line. With `--json`, `registryObjectsKept` lists
each one as `{ "ref", "class" }`. A `ref` is `<repository>:<tag>`, or
`<repository>@sha256:<digest>` for a manifest's own entry.

Cloudflare's registry lists every tag of a repository, and one `sha256:`
entry for every manifest, with or without a tag.
`cf containers images list` shows only the tags. Eden reads the
registry's own listing, asks `cf` to delete each tag, and sends its own
delete for each `sha256:` entry. It does not check which manifests have a
tag. An object is listed here only on the registry's own answer to the
delete of that exact object; its name is never enough. The class says what
the registry answered, not what the object is. All three answers were
observed on 2026-11-18:

| `class` | The registry's answer to the delete | Where it was seen |
| --- | --- | --- |
| `refused-snapshot` | `403` with one error: code `DENIED`, message `snapshot manifests cannot be deleted through this API` | A container snapshot: its tags, seen so far as `rootfs-snapshot-*` and `rootfs-set-*`, and its manifest. A target has them once it has slept or moved to a new Eve version. |
| `refused-singleton-artifact` | `409` with the code `SINGLETON_ARTIFACT_EXISTS`, the artifact type `application/vnd.cloudchamber.btrfs-chain.v1` and two digests | The chain artifact that Cloudflare makes for each pushed image. Eden does not know whether either digest in the answer is the one it asked to delete. |
| `accepted-still-listed` | A delete by digest answered `202` or `204`, and a listing Eden began at least 30 seconds later still has the entry | The earlier image of a repository that got a second push under the same tag, as Eden `0.13.x` and older pushed. It had no tag. |

Each accepted delete gets its own 30 seconds, so cleanup of a repository
can take that long after its last accepted delete.

When the registry answers `cf`'s delete of a tag with `403`, Eden
repeats the delete for that same tag against the registry and reads the
answer. An object still listed without a kept answer, or an unreadable
final listing, fails destroy with
[`EVE_DESTROY_IMAGES_RETAINED`](#eve_destroy_images_retained). Eden's
requests go straight to `registry.cloudflare.com` and never through a
proxy. Where the registry cannot be reached that way, destroy fails with
that code too.

After a successful destroy, the Worker, its secrets and Durable Object data,
and the Container application are gone. Eden reports the registry's answer
to its delete of each of these objects; it does not know whether a later
delete would be answered differently. What is known about the kept objects:

- A kept snapshot still holds the container's disk, including the agent's
  files. Cloudflare documents that it removes a snapshot 30 days after it
  was created or last restored, and nothing restores the snapshots of a
  destroyed target. Eden cannot see when Cloudflare removes one.
- `accepted-still-listed` says that the registry accepted the delete and
  still listed the entry when Eden stopped waiting. It does not say that
  the manifest was deleted, or that Cloudflare keeps it for good, and Eden
  does not check whether the manifest can still be read. An image that
  still had its tag left the listing about 15 seconds after the tag was
  deleted. An untagged one was still listed, and the registry still
  answered a request for it by digest, 18 minutes after its delete was
  accepted.
- An image manifest names the layers that hold the project's built code.
  Cloudflare does not document what a chain artifact holds.
- Eden now gives every pushed image a tag of its own and deletes a
  replaced image by that tag, so a completed update no longer leaves an
  untagged image. Images that Eden `0.13.x` or older left untagged stay, and destroy
  lists them here. The last image such a version pushed keeps `candidate`,
  so destroy can still remove it.
- Not known: when Cloudflare removes chain artifacts and untagged
  manifests, and whether kept objects count toward the 50 GB of image
  storage per account in Cloudflare's Containers limits.

To see what the registry lists for a repository, get a registry credential
(valid for five minutes) and ask the registry with the `account_id` and
`username` the credential command prints. Leave the password out of the
command: curl asks for it, and you paste the `password` value at its
prompt.

```sh
npx cf@1.0.0-rc.2 containers registries credentials generate registry.cloudflare.com --permissions push --permissions pull --expiration-minutes 5
curl --noproxy '*' -u '<username>' 'https://registry.cloudflare.com/v2/<account_id>/<repository>/tags/list?n=1000'
```

One answer holds at most the `n` entries asked for and is not the whole
listing. Ask again with `&last=<the last entry of the answer>` added to the
URL until an answer has no entries.

`eden deploy` reports the same warning and objects when it removes a
superseded version's registry repository.

### `EVE_DESTROY_POINTER_UNCLEARED`

`The target CURRENT pointer could not be cleared after verified absence.`
The remote resources are already gone; only the local pointer under
`<project>/.eden/eve-deploy/targets/<environment>-<name>/CURRENT` is left.

`The target's CURRENT pointer changed while destroy ran, so it was left in
place.` Something outside Eden's lock replaced or created the pointer during
the run, for example another tool or a restore of the folder. Destroy
finished its deletes for the record it read at the start; its checks list
them. `CURRENT` now names another deployment record. Look at where it points
and confirm that deployment is one you mean to remove. Only then rerun
`eden destroy` with the same `--project`, `--env`, and `--name`: it destroys
what that record names.

### `EVE_DEPLOY_LOCK_RELEASE_UNPROVEN`

`The Eve deployment lock could not be released with exact ownership proof;
local residue was retained.` Confirm no `eden` process is still running
against the name, then remove the stale lock file at
`<project>/.eden/eve-deploy/locks/<name>.lock`.

### The `.eden/` folder is lost

Without `<project>/.eden/eve-deploy/` Eden cannot prove it owns a target, so
`eden deploy` stops with `VAL-CLI-007-TARGET-CONFLICT` and `eden destroy`
stops with `EVE_DESTROY_RECORD_UNPROVEN`. The deployment keeps running and
the Container is billed while it is awake. Look for the folder first: on the
machine that deployed, in backups, or in another clone. If it is gone, remove
the deployment by hand. These are the resources Eden creates for a target
(see [What Eden creates](./reference.md#what-eden-creates)) and the `cf`
commands `eden destroy` itself runs. Run them from an empty folder outside
any project: `cf` runs the nearest `cloudflare.config.ts` it finds from its
folder upward and reads `.env` files beside it.

1. Confirm the account and the exact target name the deploy printed. A derived
   preview name uses a sanitized, possibly shortened `package.json` name
   plus a dash and eight hexadecimal characters:

   ```sh
   npx cf@1.0.0-rc.2 auth whoami
   npx cf@1.0.0-rc.2 workers deployments list --worker <name>
   ```

2. Delete the Worker. It is named exactly `<name>`. Its secrets (one per
   env-file variable), its Cron Trigger, and its Durable Object data are part
   of the Worker; with the Cloudflare World that data includes every stored
   session. `cf` asks you to confirm the deletion.

   ```sh
   npx cf@1.0.0-rc.2 workers delete <name>
   ```

3. Delete the Container application. Its whole name is `<name>-container`.
   When that is longer than 63 characters, it is cut to 63 and any hyphens
   left at the end are removed. `<name>-other-container` belongs to another
   target. Find its ID in the list and write the ID down, because step 4
   needs it. Then delete by ID:

   ```sh
   npx cf@1.0.0-rc.2 containers applications list
   npx cf@1.0.0-rc.2 containers applications delete <application-id>
   ```

   If the Container application is already gone, the list cannot give you
   its ID. Use the ID only if you have it from a record made while the
   application existed, such as saved output of `containers applications list`. Without
   it, skip step 4 and leave the registry alone: a repository's name is not
   proof that it belongs to this target.

4. Delete the registry images, but only in repositories you can prove belong
   to this target. A repository of this target is named
   `eden-eve-<environment>-<name>-<24 hexadecimal characters>-<rest>`. Do not
   pick repositories by how their names start: with a target named `foo`,
   `eden-eve-preview-foo-` also starts the repositories of a target named
   `foo-bar`. The digest comes from the original project name, account ID,
   environment, and target name. It helps find candidates, not prove ownership.

   The proof Cloudflare keeps is in a snapshot. Use `cf`'s tag list below
   to find a `rootfs-snapshot-*` tag, not as the full registry inventory.
   The snapshot's configuration names the Container application it came from.
   Get a registry credential (valid
   for five minutes) and read it with the `account_id` and `username` the
   credential command prints. Leave the password out of the commands: curl
   asks for it, and you paste the `password` value at its prompt, so it
   stays out of your shell history and the process list. `--noproxy '*'`
   makes curl connect to the registry directly, as Eden does.

   ```sh
   npx cf@1.0.0-rc.2 containers images list
   npx cf@1.0.0-rc.2 containers registries credentials generate registry.cloudflare.com --permissions push --permissions pull --expiration-minutes 5
   curl --noproxy '*' -u '<username>' -H 'Accept: application/vnd.oci.image.manifest.v1+json' https://registry.cloudflare.com/v2/<account_id>/<repository>/manifests/<rootfs-snapshot-tag>
   curl --noproxy '*' -L -u '<username>' https://registry.cloudflare.com/v2/<account_id>/<repository>/blobs/<config digest>
   ```

   The first curl prints the snapshot's manifest; take the `digest` inside
   its `config`. The second prints the configuration. The repository belongs
   to this target only when its `application_id` is the ID you wrote down in
   step 3 (the same 32 hexadecimal characters, written with hyphens).

   If a repository has no snapshot tag, or the IDs differ, you have no proof.
   Stop there and leave that repository alone; do not delete by name. Nothing
   runs from a repository once the Worker and the Container application are
   gone.

   In each repository you proved, delete every tag, whatever its name.
   `cf` asks you to confirm each deletion.

   ```sh
   npx cf@1.0.0-rc.2 containers images delete <repository>:<tag>
   ```

   Cloudflare's registry refuses to delete a container snapshot (seen so far
   as tags named `rootfs-snapshot-*` and `rootfs-set-*`), and `cf` then
   prints only `403 Forbidden`. That line does not say why: a missing
   permission prints the same. A tag's name does not say why either. Treat
   a refused tag as unresolved. Only repeat the delete when `cf` reports a
   registry `403` for that exact tag. Read the answer using the same
   credential, again without the password in the command:

   ```sh
   curl --noproxy '*' -X DELETE -u '<username>' -w '\nHTTP %{http_code}\n' https://registry.cloudflare.com/v2/<account_id>/<repository>/manifests/<tag>
   ```

   Cloudflare keeps the tag as a snapshot only when curl prints both this
   body and `HTTP 403`:

   ```json
   {"errors":[{"code":"DENIED","message":"snapshot manifests cannot be deleted through this API","detail":null}]}
   ```

   Cloudflare documents that it removes a snapshot 30 days after it was
   created or last restored. HTTP `202` or `204` means the registry accepted
   the delete, not that the entry is gone. Check the listing in step 5.
   Any other answer leaves the tag unresolved if it is still listed.

   `cf` lists and deletes tags only. The registry also lists one
   `sha256:` entry for each manifest; the `tags/list` command under
   [`EVE_REGISTRY_OBJECTS_KEPT`](#eve_registry_objects_kept) prints them. To delete one, send the same `DELETE` with
   `sha256:<digest>` in place of the tag. That entry also names the three
   answers with which Cloudflare keeps an object.

5. Run `npx cf@1.0.0-rc.2 containers applications list` again to check the Container
   application is gone. Read the full
   [`tags/list` listing](#eve_registry_objects_kept) for each repository
   proved in step 4. Check that only refs with one of the three kept
   answers remain; a tag still listed after an accepted delete is unresolved.
   Confirm the Worker is gone too; both commands must fail with
   `[10007] This Worker does not exist on your account.` and `404 Not Found`.
   If they disagree, wait and run both again:

   ```sh
   npx cf@1.0.0-rc.2 workers deployments list --worker <name>
   npx cf@1.0.0-rc.2 workers get <name>
   ```

Match the exact names only. A name that merely starts the same way can
belong to another target. An external Postgres database is not touched by any
of this.

### Checking for leftovers yourself

```sh
npx cf@1.0.0-rc.2 containers applications list
```

Confirm the exact Worker and Container are gone and that the registry lists
nothing the destroy did not report. An unreachable URL alone is not enough.
For a known repository, read the full
[`tags/list` listing](#eve_registry_objects_kept), including `sha256:` entries.

A failed destroy names the repositories it could not verify, and each kept
object's `ref` starts with its repository. The deployment records under
`.eden/eve-deploy/` hold each image reference. `npx cf@1.0.0-rc.2 containers images list`
also shows them, but only for repositories that still have a tag, and it
shows no `sha256:` entry. A failed or incomplete listing is not proof of
cleanup, and a matching name prefix is not proof of ownership.

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
   `npx cf@1.0.0-rc.2 workers deployments list --worker <name>`,
   `npx cf@1.0.0-rc.2 containers applications list`, and a full
   [`tags/list` listing](#eve_registry_objects_kept) for the exact
   repositories the evidence names.
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

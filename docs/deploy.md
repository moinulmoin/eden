# Deploy an existing Eve project

Eden Deploy takes an existing Eve project directory and runs the real Eve
application on Cloudflare. It does not rewrite the project or replace Eve's
providers, databases, Workflow World, authentication, schedules, channels, or
sandbox.

Start with [installation and account setup](./install.md).

## What Eden deploys

Eden runs the project's own `eve build`, starts the official project-local
`eve start --host 0.0.0.0 --port 8080` supervisor inside one bounded Cloudflare
Container (`instance_type: "basic"`, `max_instances: 1`), and routes the
public surface through one generic Worker.

Eden owns build orchestration, packaging, publication, deployment identity, and
exact cleanup. Eve remains the application and workflow authority.

## Requirements

Before deploying, confirm:

- `eden --help` starts successfully.
- `npx wrangler@4.120.0 whoami` shows the intended Cloudflare account on the
  Workers Paid plan, which Containers requires.
- Docker or OrbStack is running with Linux/amd64 support.
- The selected Eve root contains `package.json` and `pnpm-lock.yaml`.
- `package.json` has an exact `packageManager: "pnpm@..."` value.
- The matching dependencies are installed and `node_modules/.bin/eve` resolves
  to the project-local Eve package.
- The project declares `just-bash` as a production dependency (Eve `^3.1.0`;
  for example `just-bash: "3.4.2"`). Eve's default sandbox falls back to
  `just-bash` inside Eden's isolated builder, which has no Docker daemon or
  `/dev/kvm`; without the declaration `eve build` fails with
  `Cannot find package 'just-bash'`.
- Every provider, credential, database, external API, and Workflow World
  required by the Eve project is reachable from Cloudflare.

From the Eve project root, these checks should succeed:

```sh
node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).packageManager"
test -f pnpm-lock.yaml
pnpm install --frozen-lockfile
test -x node_modules/.bin/eve
docker version
```

Eden supports pinned pnpm Eve projects in this release. Bun lockfiles and
native Windows are not supported.

## First successful preview deployment

With no flags, `eden deploy` and `eden preflight` use the current directory,
the `preview` environment, and a target name derived deterministically from
the project's `package.json` name. From the Eve project root, `eden deploy`
is sufficient. For an explicit target, use a unique lowercase Worker name and
keep the same selectors for deploy and destroy:

```sh
PROJECT_ROOT="/absolute/path/to/my-eve-project"
ENVIRONMENT="preview"
WORKER_NAME="my-eve-preview-$(date +%s)"
```

Use an absolute project path when following this guide. Eden does not search
parent or sibling directories.

### Optional environment file

If the Eve application needs runtime values, create an owner-readable file
outside the project and outside source control:

```sh
ENV_FILE="$HOME/.config/my-eve-project/preview.env"
mkdir -p "$(dirname "$ENV_FILE")"
chmod 700 "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
```

The file uses `KEY=VALUE` records:

```text
PROJECT_PROVIDER_KEY=replace-with-the-project-owned-value
PROJECT_WORLD_URL=https://example.invalid
```

Use the names required by the Eve project. Do not copy these illustrative names
unless the project actually consumes them.

Eden parses variable names, not secret values. Values flow through the protected
deployment path into the Container environment and Cloudflare secrets. They are
not placed in argv, image layers, generated artifacts, or normal logs.
Reserved host variables such as `HOST`, `PORT`, `NITRO_*`, `NODE_ENV`, and
Eden's identity variables are rejected.

### Optional read-only preflight

`deploy` runs every required check inline. Preflight is useful when diagnosing a
project before allowing remote mutation:

```sh
eden preflight \
  --project "$PROJECT_ROOT" \
  --env "$ENVIRONMENT" \
  --name "$WORKER_NAME" \
  --env-file "$ENV_FILE"
```

Omit `--env-file` when the project needs no additional runtime values.
Preflight builds and inspects the candidate but does not publish Cloudflare
resources.

### Deploy

```sh
eden deploy \
  --project "$PROJECT_ROOT" \
  --env "$ENVIRONMENT" \
  --name "$WORKER_NAME" \
  --env-file "$ENV_FILE"
```

Again, omit `--env-file` when it is not needed.

A successful command prints progress lines and a summary ending with the
exact `workers.dev` URL on its own line. Eden promotes the generation only
after the public `/eve/v1/health` route reports the expected ready identity.
Pass `--json` to `preflight`, `deploy`, or `destroy` to print the
machine-readable result object instead, for scripts and CI.

Copy the printed URL:

```sh
DEPLOY_URL="https://replace-with-the-printed-workers-dev-url"
curl --fail --silent "$DEPLOY_URL/eve/v1/health"
```

The response must report `status: "ready"`. Then use the Eve project's normal
public interface to execute one representative request. Health proves startup;
a normal application request proves that the project-owned providers and
services work from the deployed environment.

## Exact cleanup

Destroy with the same project, environment, and Worker name:

```sh
eden destroy \
  --project "$PROJECT_ROOT" \
  --env "$ENVIRONMENT" \
  --name "$WORKER_NAME"
```

`destroy` rejects `--env-file`; cleanup does not need application secrets.
Destroy requires Eden's immutable ownership record, checks the current remote
identity, removes only that Worker and Container application, verifies bounded
absence, and only then clears the target's `CURRENT` pointer. It never deletes
by prefix or broad account search.

Destroy also removes the managed-registry image tag
(`eden-eve-<target>-<generation>:candidate` in `registry.cloudflare.com`) for
every generation the ownership records prove this exact target pushed,
including images retained by aborted pushes, then verifies each ref is gone.
Any image left behind is reported in the destroy output with its exact
`repository:tag` ref; remove only the listed refs with
`npx wrangler@4.120.0 containers images delete <repository:tag>` and never
filter by prefix.

After a healthy deployment is promoted, `deploy` also verifies and removes its
exact retained local Docker image and publication tags. The immutable
generation label must match before Eden removes anything. An indeterminate
publication keeps its exact local evidence instead of guessing at cleanup.

Confirm the URL is no longer reachable:

```sh
if curl --fail --silent "$DEPLOY_URL/eve/v1/health"; then
  echo "unexpected: deployment is still reachable" >&2
  exit 1
fi
```

Also compare the Cloudflare Workers list and the Container inventory before and
after the run:

```sh
npx wrangler@4.120.0 containers list
npx wrangler@4.120.0 containers images list
```

Require zero new Worker, Container, or managed-registry image residue
associated with `WORKER_NAME`. An unreachable URL alone is not sufficient
cleanup evidence.

Maintainers validating Eden against the current Eve release should also follow
the [current Eve compatibility runbook](./eve-compatibility.md).

## Preview and production

`--project` defaults to the current directory and `--env` defaults to
`preview`. `--env` accepts `preview` or `production`. `preflight` and
`deploy` derive the target name from `package.json` when `--name` is omitted;
`--env production` and `destroy` always require an explicit `--name`.

Use preview first. Production is a separate explicit target for downstream
users that intentionally operate preview and production deployments. A preview
success does not establish a production SLA.

## Project-owned services and durability

The Eve project's providers, models, credentials, databases, queues, external
APIs, channels, schedules, sandbox, authentication, authorization, and
configured Workflow World remain authoritative. Eden never substitutes a model
provider or service silently.

A preview deployment that boots Eve's local Workflow World proves health,
startup, and fresh request handling only. Container-local disk and process
memory are wiped when the Container sleeps: a sleep or restart reinitializes
local World state, and schedules do not fire while the Container sleeps.

Production durability requires a project-configured, Cloudflare-reachable,
durable Eve-compatible Workflow World such as Postgres (for example
`@workflow/world-postgres`). This release runs one logical Container instance
and does not promise horizontal scaling or custom domains.

## Common failures

| Symptom | Check |
| --- | --- |
| `eden` is not found | Follow the PATH section in [Install Eden](./install.md). |
| Project or lockfile validation fails | Confirm the selected root, exact pnpm `packageManager`, root lockfile, frozen install, and project-local Eve executable. |
| Docker build cannot start | Start Docker or OrbStack and verify Linux/amd64 support with `docker version`. |
| Cloudflare account or origin resolution fails | Run `npx wrangler@4.120.0 whoami` and confirm the intended account and workers.dev subdomain. |
| Health never reaches ready | Inspect the Eve project's provider, Workflow World, and startup requirements; Eden does not replace them. |
| Destroy refuses cleanup | Preserve the target records and inspect the reported ownership or identity mismatch. Never broaden deletion by prefix. |

Return to the [documentation index](./README.md).

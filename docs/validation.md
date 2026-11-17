# Validation runbook

This is the maintainer runbook. First-time users should start with
[installation](./install.md), then follow the
[Eve deployment guide](./deploy.md).

## Eve compatibility gate

The gate tests two frozen fixtures: `validation/eve-compat/floor/` pins Eve
0.91.0 and `@workflow/world-postgres` 5.0.5; `validation/eve-compat/latest/`
pins Eve 1.0.2 and World 5.2.1. Renovate updates only the latest fixture's
Eve, World, and `just-bash` exact pins, in separate pull requests without
automerge, once a release is one day old; the floor stays frozen.

Start a local Postgres service, then run both fixtures from the repository root:

```sh
docker run --rm -d --name eden-compat-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
WORKFLOW_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm run compat:eve:local
```

Append `floor` or `latest` to run only that fixture, and `postgres` or `eden`
to run only that leg. Wait until Postgres is ready before running the gate. The
database user must have `CREATEDB`: the script creates and deletes fresh
databases for each run.

The gate runs two legs for each fixture.

The Postgres leg tests Eve itself. It performs a frozen install, typecheck,
production build/start, and bootstrap. It checks public health, fail-closed
bearer auth, and keyless session admission. The public Eve eval runner is
optional and runs when a model API key is available.

The Eden leg tests Eden. It needs Docker with linux/amd64 support and a built
workspace (`pnpm run build`), and no Cloudflare account:

1. It copies the fixture, selects `@moinulmoin/eden-world-cloudflare` in
   `agent/agent.ts`, and installs that package from a tarball packed from
   `packages/world-cloudflare`. The tarball is served over local HTTP because
   Eden installs a project from its lockfile inside a Docker build. The
   lockfile is resolved at run time, as a user's `npm install` would.
2. It runs the built `eden preflight --json` in-process with a Cloudflare read
   that reports no access. `VAL-BUILD-001` to `VAL-BUILD-007` and every other
   check must pass; only the two `VAL-CLI-007` Cloudflare checks may not. The
   only warning allowed is the missing model key.
3. It builds Eden's image again through the CLI package's own functions,
   because preflight removes the one it built, and starts it. The World core
   from the installed package serves the World RPC inside the container, from
   `packages/world-cloudflare/test/server.mjs`. This is the same core the
   Durable Object wraps, not the Durable Object itself.
4. It checks health, fail-closed bearer auth, and keyless session admission,
   then removes the container, both images, and the copied project.

CI and publish gates run both legs on both fixtures, with Postgres 16. On a
push, CI runs the Postgres leg in the main job and the Eden leg in one parallel
job per fixture. Publish runs the whole gate in one step.
See [Current Eve compatibility](./eve-compatibility.md) for compatibility details.

Stop the local service afterward:

```sh
docker stop eden-compat-postgres
```

## Deployed validation

An authorized remote validation deploys the fixture (or another pinned Eve
project) to a unique temporary target and removes it afterward:

1. Run `eden deploy --project <project> --env preview --name <unique-name>`
   with `--env-file` if the project needs runtime values.
2. Poll the printed `workers.dev` URL until health reports ready, then exercise
   the application's real endpoints.
3. Compare the remote behavior with a local `eve start` run of the same
   project.
4. Remove exactly the deployed target with
   `eden destroy --project <project> --env preview --name <unique-name>` and
   verify the URL is unreachable and no Worker, Container, or secret entries
   for the temporary name remain in the Cloudflare account.

Never use production as an implicit temporary target. Destroy requires Eden's
immutable ownership record and the current remote identity, so cleanup cannot
broaden to similarly named resources.

## Provisional limits

- npm projects with one root `package-lock.json` and exact-pinned pnpm projects
  are supported; mixed locks, Bun project lockfiles, and native Windows are not.
- `.npmrc` is excluded from build layers; private registries are unsupported.
- One logical Container instance per deployment; no horizontal scaling or
  custom domains.
- Container-local disk survives sleep via filesystem snapshots but resets on
  image updates. Production durability requires the tested Postgres World setup
  in [deploy.md](deploy.md#durable-state-postgres-world).

## Cleanup

For a deployed validation, remove only the resources created for that exact
`--env`/`--name` target. Verify the deployment URL is unreachable and
resource/secret listings no longer contain the temporary entries. Preserve
shared preview or production resources.

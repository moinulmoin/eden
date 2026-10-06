# Validation runbook

This is the maintainer runbook. First-time users should start with
[installation](./install.md), then follow the
[Eve deployment guide](./deploy.md).

## Eve compatibility gate

The repository ships a pinned compatibility project under
`validation/eve-compat/minimal/` that installs a real, published Eve version
with a frozen lockfile. Run the local gate from the repository root:

```sh
pnpm run compat:eve:local
```

The gate performs the frozen install, typecheck, and production build/start of
the fixture, checks public health and fail-closed bearer auth, and
runs the public Eve eval runner when a model credential is available. See
[Current Eve compatibility](./eve-compatibility.md) for the pinned versions and
how to advance the tested Eve line.

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

- Pinned pnpm Eve projects only; Bun project lockfiles and native Windows are
  not currently supported.
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

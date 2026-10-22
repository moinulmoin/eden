# Eden documentation

Eden has one workflow: hosting an existing Vercel Eve project on your own
Cloudflare account without rewriting it. Start with
[installation and account setup](./install.md), then follow
[Deploy an existing Eve project](./deploy.md).

## Get started

- [Install Eden](./install.md): Node, npm/pnpm/Bun installation, Cloudflare
  and Wrangler login, Docker or OrbStack, project requirements, updating and
  uninstalling.
- [Deploy an existing Eve project](./deploy.md): the env file, preflight,
  deploy, updates, destroy, preview and production, schedules, and the
  durable Workflow World recipes (Postgres and the experimental Cloudflare
  World).

## Understand Eden

- [How Eden works](./how-it-works.md): the Worker, Durable Object, and
  Container; what each deploy step does; sleep and wake; schedules; updates;
  where your data lives; limits.
- [Security](./security.md): how secrets travel, what is public, the sandbox,
  and what Eden can change in your Cloudflare account.
- [FAQ](./faq.md): plans and cost, project changes, secrets, deploy and wake
  times, and how Eden compares to other setups.

## Look things up

- [Reference](./reference.md): every command and flag, target names, env-file
  rules, environment variables, what Eden creates, output, and exit codes.
- [Troubleshooting](./troubleshooting.md): failure and warning codes by
  stage, with the fix for each.

## Maintainers

- [Validation and cleanup](./validation.md): the pinned Eve compatibility gate
  and deployed cleanup checks. Not needed for a first run.
- [Eve compatibility](./eve-compatibility.md): which published Eve versions
  are tested and how to advance the tested line.

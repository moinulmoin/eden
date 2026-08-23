# Eden Deploy: host an existing Eve project

Eden Deploy takes an existing Eve project directory and runs the real Eve
application on Cloudflare. Eve stays the execution authority: Eden runs the
project's own `eve build`, starts the official project-local
`eve start --host 0.0.0.0 --port 8080` supervisor inside one bounded
Cloudflare Container (`max_instances: 1`), and routes the public surface
through one generic Worker. Eden owns build orchestration, packaging,
publication, deployment identity, and cleanup — nothing else.

```sh
eden deploy  --project <path> --env preview --name <name>
eden destroy --project <path> --env preview --name <name>
```

`deploy` is the primary workflow and runs every required check inline; it does
not require a prior preflight. `destroy` removes only the exact Worker and
Container application recorded for that target, verifies bounded absence, and
only then clears the target's `CURRENT` pointer. Destroy is idempotent when
the exact target is already absent, fails closed without a matching immutable
deployment record, and never broadens cleanup to sibling targets.

The optional read-only diagnostic is:

```sh
eden preflight --project <path> --env preview --name <name>
```

Every Deploy command requires explicit `--project`, `--env` (`preview` or
`production`), and `--name`. `--env-file <path>` is accepted only by
`preflight` and `deploy`; `destroy` rejects it and needs no environment file.
Preview-first evidence makes no production SLA claim.

## Project-owned services and the Workflow World

The Eve project's providers, models, credentials, databases, queues, external
APIs, channels, schedules, sandbox, authentication, authorization, and
configured Workflow World remain authoritative. Eden does not migrate,
replace, translate, or silently drop any of them. Model access stays exactly
what the project declares — Eden never substitutes a provider silently.

A preview deployment that boots Eve's local Workflow World proves health,
startup, and fresh request handling only. Container-local disk and process
memory are disposable: a Container restart reinitializes local World state and
does not demonstrate persistence. Production durability is the project
owner's responsibility through a project-configured, Cloudflare-reachable,
durable Eve-compatible World. The preview deployment runs one logical
Container instance with `max_instances: 1`; Eden makes no horizontal-scaling
or custom-domain promise in this release.

## Environment handling

Runtime values are supplied only through an explicit `--env-file` using a
small opaque `KEY=VALUE` grammar. Eden parses names, not values: the values
flow through a protected seam into the Container environment and Cloudflare
secrets, never into argv, image layers, logs, artifacts, or the journal.
Reserved host variables (`HOST`, `PORT`, `NITRO_*`, `NODE_ENV`, and Eden's own
identity variables) are rejected in that file, and every emitted record is
redacted.

## Deploy, Adapt, and Agent

- **Eden Deploy** (this release) hosts an existing Eve project as-is through
  the top-level `eden preflight`, `eden deploy`, and `eden destroy` commands.
- **Eden Adapt** is a separate, deliberate future concern: per-primitive
  migration of Vercel-specific pieces onto Cloudflare alternatives. Deploy
  never invokes Adapt automatically.
- **Eden Agent** remains the `eden agent init`, `eden agent build`,
  `eden agent dev`, and `eden agent deploy` path documented in
  [`agent-cli.md`](./agent-cli.md).

Deploy performs no source rewriting, no automatic migration, no Workflow World
or sandbox replacement, and never falls back to the Agent runtime when
hosting an Eve project.

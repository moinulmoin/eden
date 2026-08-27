# Eden documentation

Eden has two separate workflows. Choose one before following a guide:

| Goal | Start here |
| --- | --- |
| Host an existing Eve project on Cloudflare without rewriting it | [Deploy an existing Eve project](./deploy.md) |
| Create and run an Eden Agent | [Create and operate an Eden Agent](./agent-cli.md) |

Both workflows begin with [installation and account setup](./install.md).

## Guides

### Installation

[Install Eden](./install.md) covers:

- npm, pnpm, and Bun installation
- the required Node runtime
- Cloudflare and Wrangler authentication
- Docker or OrbStack requirements for Eden Deploy
- updating, uninstalling, and PATH problems

### Eden Deploy

[Deploy an existing Eve project](./deploy.md) covers:

- project and lockfile requirements
- preview and production selectors
- protected environment files
- preflight, deployment, health verification, and exact cleanup
- what Eden preserves from the Eve project
- current durability and scaling limits

### Eden Agent

[Create and operate an Eden Agent](./agent-cli.md) covers:

- initialization in an empty directory
- dependency installation and static compilation
- authenticated local development
- preview deployment and cleanup
- every `eden agent` command
- runtime, session, and security boundaries

### Validation reference

[Validation and cleanup](./validation.md) is the advanced operator runbook. It
documents the full local lifecycle, NDJSON cursor recovery, deployed validation,
and resource cleanup checks. It is not required for a first successful run.

## Supported surface

The public command surface is:

```text
eden preflight
eden deploy
eden destroy
eden agent init
eden agent build
eden agent dev
eden agent deploy
```

Run `eden <command> --help` or `eden agent <command> --help` for exact options.
Commands not listed here are not implied.

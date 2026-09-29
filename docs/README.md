# Eden documentation

Eden has one workflow: hosting an existing Vercel Eve project on your own
Cloudflare account without rewriting it. Start with
[installation and account setup](./install.md), then follow
[Deploy an existing Eve project](./deploy.md).

## Guides

### Installation

[Install Eden](./install.md) covers:

- npm, pnpm, and Bun installation
- the required Node runtime
- Cloudflare and Wrangler authentication
- Docker or OrbStack requirements
- updating, uninstalling, and PATH problems

### Eden Deploy

[Deploy an existing Eve project](./deploy.md) covers:

- project and lockfile requirements
- preview and production selectors
- protected environment files
- preflight, deployment, health verification, and exact cleanup
- what Eden preserves from the Eve project
- current durability and scaling limits

### Validation reference

[Validation and cleanup](./validation.md) is the maintainer runbook. It
documents the pinned Eve compatibility gate and deployed cleanup checks. It is
not required for a first successful run.

### Eve compatibility

[Current Eve compatibility](./eve-compatibility.md) records which published Eve
version the CI gate pins and how to advance the tested line.

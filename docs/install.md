# Install Eden

This guide installs the public Eden CLI and prepares the local tools used by its
two workflows.

## Supported systems

Eden currently supports:

- macOS or Linux
- Node `>=24.17.0`
- a Cloudflare account

Native Windows and Bun as the JavaScript runtime are not supported. Bun may
install the package, but Eden itself always runs on Node.

Check Node before installing:

```sh
node --version
```

The result must be `v24.17.0` or newer. Eden intentionally has no artificial
upper Node major-version bound.

## Install the CLI

Install only `@moinulmoin/eden`. npm resolves the compiler, definitions, and
Cloudflare runtime companion packages automatically.

Choose one installer.

### npm

```sh
npm install --global @moinulmoin/eden@0.1.4
```

### pnpm

```sh
pnpm add --global @moinulmoin/eden@0.1.4
```

### Bun

```sh
bun add --global @moinulmoin/eden@0.1.4
```

Bun is an installer only. Do not run Eden with `bunx --bun`.

Confirm the installed command:

```sh
eden --help
```

The help output must list `preflight`, `deploy`, `destroy`, and `agent`.

## Authenticate with Cloudflare

Both remote workflows use Wrangler `4.120.0`. Authenticate the Cloudflare
account that owns the target Workers:

```sh
npx wrangler@4.120.0 login
```

Confirm the selected account:

```sh
npx wrangler@4.120.0 whoami
```

Review the returned account before deploying. Eden never selects a different
Cloudflare account silently.

## Additional requirements for Eden Deploy

Deploying an existing Eve project also requires Docker or OrbStack with
Linux/amd64 container support.

Check the container engine:

```sh
docker version
```

The Eve project must contain all of the following at its selected root:

- an exact `packageManager: "pnpm@..."` value in `package.json`
- the matching root `pnpm-lock.yaml`
- a project-local Eve executable resolved through `node_modules/.bin/eve`
- the providers, databases, Workflow World, credentials, and external services
  that the Eve application already requires

Eden does not add or replace those project-owned services.

Continue with [Deploy an existing Eve project](./deploy.md).

## Additional requirement for Eden Agent

The generated Agent project pins pnpm `11.21.0`. Enable Corepack once before the
first generated-project install:

```sh
corepack enable
```

After that one-time setup, use `pnpm` directly. Do not prefix every command with
`corepack`.

Continue with [Create and operate an Eden Agent](./agent-cli.md).

## Update Eden

Use the same installer that owns the global command.

### npm

```sh
npm install --global @moinulmoin/eden@latest
```

### pnpm

```sh
pnpm add --global @moinulmoin/eden@latest
```

### Bun

```sh
bun add --global @moinulmoin/eden@latest
```

Then confirm the command still starts:

```sh
eden --help
```

## Uninstall Eden

### npm

```sh
npm uninstall --global @moinulmoin/eden
```

### pnpm

```sh
pnpm remove --global @moinulmoin/eden
```

### Bun

```sh
bun remove --global @moinulmoin/eden
```

Uninstalling the CLI does not delete Cloudflare resources. Remove an Eve
deployment with `eden destroy` first. Remove a temporary Eden Agent Worker and
its secret using the exact cleanup commands in [the Agent guide](./agent-cli.md).

## Package-manager setup and PATH

Eden does not install package managers or modify shell configuration. If the
selected installer is missing or its global commands are not on `PATH`, follow
that tool's official installation guide:

- [npm installation](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/)
- [pnpm installation](https://pnpm.io/installation)
- [Bun installation](https://bun.com/docs/installation)

After configuring the installer, open a new shell and run `eden --help`. Do not
install duplicate Eden copies with multiple package managers to hide a PATH
problem; ownership of updates and uninstallation becomes ambiguous.

## Next step

- Existing Eve project: [Deploy an existing Eve project](./deploy.md)
- New Eden Agent: [Create and operate an Eden Agent](./agent-cli.md)
- All documentation: [Documentation index](./README.md)

# Install Eden

This guide installs the public Eden CLI and prepares the local tools used by
Eden Deploy.

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

Install only `@moinulmoin/eden`. npm resolves the Cloudflare runtime companion
package automatically.

Choose one installer.

### npm

```sh
npm install --global @moinulmoin/eden@0.2.2
```

### pnpm

```sh
pnpm add --global @moinulmoin/eden@0.2.2
```

### Bun

```sh
bun add --global @moinulmoin/eden@0.2.2
```

Bun is an installer only. Do not run Eden with `bunx --bun`.

Confirm the installed command:

```sh
eden --help
```

The help output must list `preflight`, `deploy`, and `destroy`.

## Authenticate with Cloudflare
Deploying to Cloudflare uses Wrangler `4.120.0`. The account must be on the
Workers Paid plan, which Cloudflare Containers requires. Authenticate the
Cloudflare account that owns the target Workers:

```sh
npx wrangler@4.120.0 login
```

Confirm the selected account:

```sh
npx wrangler@4.120.0 whoami
```

Review the returned account before deploying. Eden never selects a different
Cloudflare account silently.

On macOS, a stale `registry.cloudflare.com` keychain entry makes the managed
registry login fail with `The specified item already exists in the keychain
(-25299)`; remove it with
`security delete-internet-password -s registry.cloudflare.com` and retry.

## Additional requirements

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
deployment with `eden destroy` first.

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

- [Deploy an existing Eve project](./deploy.md)
- All documentation: [Documentation index](./README.md)

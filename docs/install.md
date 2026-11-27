# Install Eden

This guide installs the public Eden CLI and prepares the local tools used by
Eden Deploy.

## Supported systems

Eden currently supports:

- macOS or Linux
- Node `^24.22.0 || ^26.12.0`
- a Cloudflare account

Native Windows and Bun as the JavaScript runtime are not supported. Bun may
install the package, but Eden itself always runs on Node.

Check Node before installing:

```sh
node --version
```

The result must be `v24.22.0` or newer on the 24 line, or `v26.12.0` or newer
on the 26 line; the `cf` CLI that Eden runs declares those lines.
On any other Node, `preflight`, `deploy`, and `destroy` stop with
[`EVE_NODE_UNSUPPORTED`](./troubleshooting.md#eve_node_unsupported).

## Install the CLI

Install only `@moinulmoin/eden`. npm resolves the Cloudflare runtime companion
package automatically.

Choose one installer.

### npm

```sh
npm install --global @moinulmoin/eden
```

### pnpm

```sh
pnpm add --global @moinulmoin/eden
```

### Bun

```sh
bun add --global @moinulmoin/eden
```

Bun is an installer only. Do not run Eden with `bunx --bun`.

Confirm the installed command:

```sh
eden --help
```

The help output must list `preflight`, `deploy`, and `destroy`.

## Authenticate with Cloudflare

Deploying to Cloudflare uses Cloudflare's `cf` CLI, version `1.0.0-rc.6`, a
release candidate. It is installed with Eden. The account must be on the
Workers Paid plan, which Cloudflare Containers requires. Sign in to the
Cloudflare account that owns the target Workers:

```sh
npx cf@1.0.0-rc.6 auth login
```

Confirm the selected account:

```sh
npx cf@1.0.0-rc.6 auth whoami
```

Review the returned account before deploying. Eden needs the sign-in to show
exactly one account, and never selects a different Cloudflare account
silently.

Instead of signing in, you can set `CLOUDFLARE_API_TOKEN`. `cf` uses it as
its login, and `npx cf@1.0.0-rc.6 auth whoami` then reports
`"authSource": "CLOUDFLARE_API_TOKEN environment variable"`. On 2026-11-20
a token made from Cloudflare's "Edit Cloudflare Workers" template,
unchanged, ran preflight, a first deploy, an update, and a destroy with no
saved login. A narrower set of permissions was not tested.

### Moving from the Wrangler login

Eden 0.14 and earlier used Wrangler and its saved login. `cf` does not read
that login. After upgrading, run `npx cf@1.0.0-rc.6 auth login` once, or set
`CLOUDFLARE_API_TOKEN`. Until then `preflight` and `deploy` stop with
[`VAL-CLI-007-CLOUDFLARE-ACCESS`](./troubleshooting.md#moving-from-the-wrangler-login-to-cf).
The `.eden/` folder and your deployed targets need no change.

Going back is not supported. On 2026-11-20, Eden 0.14.0 run against a target
that this version had deployed exited 1 with `DEPLOY_INDETERMINATE`. The
live deployment kept answering, and this version deployed and destroyed the
target afterwards.

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

- one root `package-lock.json` for npm, or an exact
  `packageManager: "pnpm@..."` value with the matching root `pnpm-lock.yaml`
- no competing package-manager lockfiles
- Eve `0.91.0` or later
- a project-local Eve executable resolved through `node_modules/.bin/eve`
- `just-bash` as a production dependency (`npm add just-bash` or `pnpm add just-bash`)
- an explicit `JustBashSandbox` selection in
  `agent/sandbox.ts` (`agent/sandbox/sandbox.ts` when an `agent/sandbox/`
  folder exists); follow the
  [complete setup](./deploy.md#sandbox-setup)
- the providers, databases, Workflow World, credentials, and external services
  that the Eve application already requires

Eden does not add or replace those project-owned services.

npm projects default to npm `11.13.0` when `packageManager` is absent, or use
an exact npm pin at version 7 or newer. Frozen `npm ci --ignore-scripts`
installs require a v2/v3 lockfile; dependency lifecycle scripts do not run.
pnpm projects use their exact pin and frozen
lockfile. `.npmrc` is excluded from the build, so private registries and project
`.npmrc`-dependent installs are unsupported.

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

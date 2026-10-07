# Eden

Eden deploys an existing [Vercel Eve](https://github.com/vercel/eve) project to
your own Cloudflare account through one CLI.

![eden deploy: an Eve project live on workers.dev, a real model reply, then eden destroy](./docs/assets/eden-deploy.gif)

Eden installs the project's pinned pnpm lockfile, runs its project-local Eve
executable, packages the real Node/Nitro server into a Cloudflare Container,
and publishes a generic Worker in front of it. Eve remains the application and
workflow authority; Deploy never rewrites the Eve project or silently replaces
its providers and services.

## Install

Use npm:

```sh
npm install --global @moinulmoin/eden@0.7.0
```

Or pnpm:

```sh
pnpm add --global @moinulmoin/eden@0.7.0
```

Or Bun:

```sh
bun add --global @moinulmoin/eden@0.7.0
```

Confirm the installation:

```sh
eden --help
```

Users install only `@moinulmoin/eden`; its companion packages are resolved
automatically. Bun is supported as an installer only. Node `>=24.17.0` remains
the Eden runtime, so do not force the CLI through `bunx --bun`.

## Requirements

- macOS or Linux
- Node `>=24.17.0`
- a Cloudflare account on the Workers Paid plan (required for Containers)
- Wrangler authentication:

  ```sh
  npx wrangler@4.147.0 login
  ```

- Docker or OrbStack with Linux/amd64 container support
- an existing Eve project with an exact `packageManager: "pnpm@..."` entry
- the matching root `pnpm-lock.yaml`
- `just-bash` as a production dependency (`pnpm add just-bash`). Eve's
  default sandbox needs it inside Eden's builder, and `eve init` does not
  add it.
- the providers, credentials, databases, Workflow World, and external services
  already required by the Eve project

Eden Deploy supports pinned pnpm Eve projects in this release. Bun project
lockfiles and native Windows are not currently supported.

## Deploy an existing Eve project

From inside the Eve project:

```sh
npx @moinulmoin/eden deploy
```

With no flags, `deploy` uses the current directory, the `preview` environment,
and a target name derived deterministically from the project's `package.json`
name. Deploy performs all required checks inline. A separate preflight is
optional.

Explicit selectors still work, and `--name` is required for `--env
production` and `destroy`:

```sh
eden deploy \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview
```

A successful deployment prints progress lines followed by a summary with the
target, the Eve version, and the public `workers.dev` URL on its own line. The
authored Eve directory is unchanged. All three commands accept `--json` for
the machine-readable result object.

If the project needs runtime values, provide an explicit environment file
outside source control:

```sh
eden deploy \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview \
  --env-file ~/.config/my-eve-app/preview.env
```

Eden passes values through its protected deployment path. Values are not placed
in command arguments, image layers, generated artifacts, or normal logs.

Run the optional read-only diagnostic when troubleshooting:

```sh
eden preflight \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview
```

Remove the exact deployment when finished:

```sh
eden destroy --name my-eve-preview
```

Destroy always requires an explicit `--name`. It also requires Eden's
immutable ownership record, verifies the current remote identity, and never
broadens cleanup to similarly named resources.

### What Deploy preserves

The Eve project remains responsible for its:

- model providers and credentials
- databases, queues, and external APIs
- channels, schedules, authentication, and authorization
- sandbox and Workflow World

### Limits

- Container disk survives sleep (Eden snapshots the filesystem and restores
  it on wake), and updates carry Eve's sandbox sessions — every
  conversation's files — across the image change through the Durable Object's
  storage (capped at 1 GiB compressed). Local Workflow World state is not
  durable across an update, and Eden warns about it. Durable state takes
  three steps with the Postgres World (any direct, unpooled Postgres); see
  [docs/deploy.md](docs/deploy.md#durable-state-postgres-world).
- Schedules with standard 5-field cron fire while the Container sleeps (a
  Cloudflare Cron Trigger wakes it); others only run while it is awake. See
  [docs/deploy.md](docs/deploy.md#schedules).
- One logical Container instance (`standard-1`: 1/2 vCPU, 4 GiB); no
  horizontal scaling or custom domains in this release.
- The agent's sandbox is `just-bash`, a simulated shell — not a real Linux VM
  like Vercel Sandbox. Files, `grep`/`sed`/`jq`/`sqlite3`, and `curl` work;
  `python`, `git`, `npm`, and other real programs do not, and the sandbox has
  unrestricted internet access.
- A project that picks its own sandbox in `agent/sandbox.ts` (Docker,
  microsandbox, or Vercel Sandbox) or adds `agent/sandbox/Dockerfile` is not
  supported yet: the first three fail at build, and the Dockerfile silently
  falls back to `just-bash`.

## Commands

| Command | Purpose |
| --- | --- |
| `eden preflight` | Inspect an Eve candidate without remote mutation |
| `eden deploy` | Deploy an Eve project to one exact target, or update a target Eden owns in place (state is kept) |
| `eden destroy` | Remove one exact Eden-owned Eve deployment |

Run `eden <command> --help` for command-specific options.

## Develop from source

The repository is a pnpm workspace with TypeScript project references. It works
without Turbo or Turborepo.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
```

After the build, invoke the source-checkout CLI with:

```sh
node packages/cli/dist/index.js --help
```

The landing page at eden.ideaplexa.com lives in `site/` (Astro). Run it with
`pnpm --filter @moinulmoin/eden-site dev`.

## Documentation

- [Documentation index](./docs/README.md): find every guide
- [Installation](./docs/install.md): Node, npm/pnpm/Bun, Cloudflare, containers,
  updates, uninstallation, and PATH problems
- [Eden Deploy](./docs/deploy.md): complete existing-Eve preview deployment,
  verification, exact cleanup, durability, and current limits
- [Validation](./docs/validation.md): maintainer runbook for the Eve
  compatibility gate and deployed cleanup checks

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for the
Cloudflare Containers attribution.

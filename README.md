# Eden

Eden runs AI agents on Cloudflare through one CLI.

Use it in one of two ways:

1. **Deploy an existing Eve project.** Eden installs the project's pinned pnpm
   lockfile, runs its project-local Eve executable, packages the real Node/Nitro
   server into a Cloudflare Container, and publishes a generic Worker in front
   of it. Eve remains the application and workflow authority.
2. **Create an Eden Agent.** Eden compiles an `agent/` directory into a static
   Worker generation backed by a SQLite Durable Object session journal.

The two workflows are intentionally separate. Deploy never rewrites an Eve
project into an Eden Agent or silently replaces its providers and services.

## Install

Use npm:

```sh
npm install --global @moinulmoin/eden@0.1.5
```

Or pnpm:

```sh
pnpm add --global @moinulmoin/eden@0.1.5
```

Or Bun:

```sh
bun add --global @moinulmoin/eden@0.1.5
```

Confirm the installation:

```sh
eden --help
```

Users install only `@moinulmoin/eden`; its companion packages are resolved
automatically. Bun is supported as an installer only. Node `>=24.17.0` remains
the Eden runtime, so do not force the CLI through `bunx --bun`.

## Requirements

For every workflow:

- macOS or Linux
- Node `>=24.17.0`
- a Cloudflare account
- Wrangler authentication:

  ```sh
  npx wrangler@4.120.0 login
  ```

For **Eden Deploy**, also provide:

- Docker or OrbStack with Linux/amd64 container support
- an existing Eve project with an exact `packageManager: "pnpm@..."` entry
- the matching root `pnpm-lock.yaml`
- the providers, credentials, databases, Workflow World, and external services
  already required by the Eve project

Eden Deploy supports pinned pnpm Eve projects in this release. Bun project
lockfiles and native Windows are not currently supported.

For **Eden Agent**, Corepack must be available. The setup below enables the
generated project's pinned pnpm `11.21.0` version once.

## Deploy an existing Eve project

Deploy performs all required checks inline. A separate preflight is optional.

```sh
eden deploy \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview
```

A successful deployment prints the immutable generation and public
`workers.dev` URL. The authored Eve directory is unchanged.

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
eden destroy \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview
```

Destroy requires Eden's immutable ownership record, verifies the current remote
identity, and never broadens cleanup to similarly named resources.

### What Deploy preserves

The Eve project remains responsible for its:

- model providers and credentials
- databases, queues, and external APIs
- channels, schedules, authentication, and authorization
- sandbox and Workflow World

Container-local memory and disk are disposable. A production Eve deployment
needs a project-configured, Cloudflare-reachable durable Workflow World. This
release uses one logical Container instance and does not promise horizontal
scaling or custom domains.

## Create an Eden Agent

Create a project in an empty directory and install its generated dependencies:

```sh
mkdir my-agent
eden agent init --project ./my-agent
cd my-agent
corepack enable
pnpm install
```

The generated authoring tree is intentionally small:

```text
agent/
├── agent.ts
├── instructions.md
└── tools/
    └── greet.ts
```

Build the Worker generation:

```sh
pnpm run build
```

Start the Agent locally:

```sh
export EDEN_BEARER_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
pnpm run dev
```

The local surfaces are:

- Worker: `http://127.0.0.1:8797`
- Wrangler inspector: `http://127.0.0.1:9297`

Leave this terminal running until Eden prints its ready message. Press `Ctrl-C`
to stop local development before continuing to deployment; the bearer value
remains in the current shell.

Deploy to an explicit preview target:

```sh
pnpm run deploy \
  --env preview \
  --name my-agent-preview
```

After testing, remove the exact preview Worker and its secret:

```sh
pnpm exec wrangler secret delete EDEN_BEARER_SECRET \
  --name my-agent-preview \
  --config "$PWD/wrangler.jsonc"
pnpm exec wrangler delete my-agent-preview \
  --env preview \
  --config "$PWD/wrangler.jsonc" \
  --force
unset EDEN_BEARER_SECRET
```

Run these commands only for the explicit preview name you just created.

The Agent runtime uses Workers AI through Cloudflare AI Gateway's `default`
gateway. Cloudflare creates that gateway on the first authenticated request when
it does not already exist.

## Commands

| Command | Purpose |
| --- | --- |
| `eden preflight` | Inspect an Eve candidate without remote mutation |
| `eden deploy` | Deploy an existing Eve project to one exact target |
| `eden destroy` | Remove one exact Eden-owned Eve deployment |
| `eden agent init` | Create an Eden Agent project |
| `eden agent build` | Compile an Agent generation |
| `eden agent dev` | Run an Agent locally |
| `eden agent deploy` | Deploy the Agent runtime |

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
pnpm run conformance:local
```

After the build, invoke the source-checkout CLI with:

```sh
node packages/cli/dist/index.js --help
```

## Documentation

- [Documentation index](./docs/README.md): choose a workflow and find every guide
- [Installation](./docs/install.md): Node, npm/pnpm/Bun, Cloudflare, containers,
  updates, uninstallation, and PATH problems
- [Eden Deploy](./docs/deploy.md): complete existing-Eve preview deployment,
  verification, exact cleanup, durability, and current limits
- [Eden Agent CLI](./docs/agent-cli.md): initialization, local authenticated
  use, preview deployment, cleanup, command reference, and architecture
- [Validation](./docs/validation.md): advanced local and deployed lifecycle,
  cursor recovery, evidence, and cleanup checks

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for the applicable
Eve and Cloudflare attribution.

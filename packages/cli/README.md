# Eden

Eden is a CLI for running AI agents on Cloudflare.

It has two deliberately separate workflows:

- **Eden Deploy** hosts an existing [Vercel Eve](https://github.com/vercel/eve)
  project on Cloudflare without rewriting the project or replacing Eve.
- **Eden Agent** creates and runs a smaller Cloudflare-native durable agent from
  an `agent/` directory.

If you already have an Eve project, start with `eden deploy`. If you want to
create a new Eden-native agent, start with `eden agent init`.

## Install

Use any one of these package managers:

```sh
npm install --global @moinulmoin/eden@0.1.3
```

```sh
pnpm add --global @moinulmoin/eden@0.1.3
```

```sh
bun add --global @moinulmoin/eden@0.1.3
```

Then confirm the CLI is available:

```sh
eden --help
```

Bun can install Eden, but Eden still runs on Node. Do not use `bunx --bun`.

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
- any providers, databases, Workflow World, credentials, and external services
  already required by that Eve project

Eden Deploy supports pinned pnpm Eve projects in this release. Bun lockfiles and
native Windows are not currently supported.

For **Eden Agent**, Corepack must be available. The setup below enables the
generated project's pinned pnpm `11.21.0` version once.

## Deploy an existing Eve project

Deploy is the primary workflow. It performs its checks inline, installs the
project's pinned pnpm lockfile, runs its project-local Eve executable, packages
the real Eve server into one Cloudflare Container, and publishes one Worker in
front of it.

```sh
eden deploy \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview
```

A successful command prints the deployed generation and its `workers.dev` URL.
Eden does not change the source directory.

If the Eve project needs runtime values, put them in a regular owner-readable
environment file outside source control:

```sh
eden deploy \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview \
  --env-file ~/.config/my-eve-app/preview.env
```

`eden preflight` is an optional read-only diagnostic. You do not need to run it
before `deploy`:

```sh
eden preflight \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview
```

Remove exactly that deployment when finished:

```sh
eden destroy \
  --project ./my-eve-app \
  --env preview \
  --name my-eve-preview
```

Destroy verifies Eden's ownership record and the current remote identity before
removing anything. It never deletes by prefix or broad account search.

## Create an Eden Agent

Create a project in an empty directory:

```sh
mkdir my-agent
eden agent init --project ./my-agent
cd my-agent
corepack enable
pnpm install
```

The generated project contains:

```text
agent/
├── agent.ts
├── instructions.md
└── tools/
    └── greet.ts
```

Build the static Worker generation:

```sh
pnpm run build
```

Start it locally with an explicit bearer secret:

```sh
export EDEN_BEARER_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
pnpm run dev
```

The local endpoints are:

- Worker: `http://127.0.0.1:8797`
- Wrangler inspector: `http://127.0.0.1:9297`

Leave this terminal running until Eden prints its ready message. Press `Ctrl-C`
to stop local development before continuing to deployment; the bearer value
remains in the current shell.

Deploy the Agent to an explicit preview target:

```sh
pnpm run deploy -- \
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

## Command map

| Command | Purpose |
| --- | --- |
| `eden preflight` | Build and inspect an Eve candidate without remote mutation |
| `eden deploy` | Deploy an existing Eve project to one exact target |
| `eden destroy` | Remove one exact Eden-owned Eve deployment |
| `eden agent init` | Create an Eden Agent project |
| `eden agent build` | Compile an Agent generation |
| `eden agent dev` | Run the Agent locally |
| `eden agent deploy` | Deploy the Agent runtime |

Run `eden <command> --help` for command-specific options.

## What Eden does not do

- Deploy does not translate Eve into an Eden Agent.
- Deploy does not replace the Eve project's providers, databases, Workflow
  World, authentication, schedules, channels, or sandbox.
- Container-local memory and disk are disposable. Production Eve durability
  requires a project-configured durable Workflow World.
- This release uses one logical Container instance and does not promise
  horizontal scaling or custom domains.
- Bun is an installer only; Node remains the runtime.

## Documentation

- [Documentation index](https://github.com/moinulmoin/eden/blob/main/docs/README.md)
- [Installation](https://github.com/moinulmoin/eden/blob/main/docs/install.md)
- [Deploying Eve projects](https://github.com/moinulmoin/eden/blob/main/docs/deploy.md)
- [Eden Agent CLI](https://github.com/moinulmoin/eden/blob/main/docs/agent-cli.md)
- [Validation and cleanup](https://github.com/moinulmoin/eden/blob/main/docs/validation.md)

## License

Apache-2.0. The package includes `LICENSE` and `NOTICE` with the applicable Eve
and Cloudflare attribution.

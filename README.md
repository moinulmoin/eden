# Eden

Eden is one CLI with two separated surfaces:

1. **Eden Deploy** — host an *existing Eve project* on Cloudflare as-is. Eden
   builds the project with its own pinned Eve toolchain, packages the real
   Node/Nitro server into one bounded Cloudflare Container, and places a
   generic Worker in front of it. The top-level `eden preflight`, `eden deploy`,
   and `eden destroy` commands form the deploy-first product surface.
2. **Eden Agent** — a small, Cloudflare-native durable agent framework:
   filesystem-first authoring, a Node-side compiler, a Worker-safe generated
   bundle, one authenticated Worker host, one SQLite-backed `EdenSession`
   Durable Object, a bounded model/tool/final-response turn, and an NDJSON
   journal stream, driven by `eden agent init`, `eden agent build`,
   `eden agent dev`, and `eden agent deploy`.

Deploy never invokes the Agent framework, rewrites Eve source, lowers Eve into
an Eden Agent, maps Eve application semantics onto Cloudflare primitives, or
uses the Agent runtime as a fallback. The two surfaces stay separate on purpose.

## Install

The public v0.1.0 CLI package is `@moinulmoin/eden`. Package managers install
its three companion packages automatically:

| Package | Version | Purpose |
| --- | --- | --- |
| `@moinulmoin/eden` | `0.1.0` | CLI package; installs the `eden` binary |
| `@moinulmoin/eden-definitions` | `0.1.0` | Eden Agent definitions |
| `@moinulmoin/eden-compiler` | `0.1.0` | Node-side Agent compiler |
| `@moinulmoin/eden-runtime-cloudflare` | `0.1.0` | Cloudflare Worker and Durable Object runtime |

The monorepo root, typed client, and example workspaces are not published.
Users install only `@moinulmoin/eden`.

Install the CLI globally with npm:

```sh
npm install --global @moinulmoin/eden@0.1.0
```

Install the CLI globally with pnpm:

```sh
pnpm add --global @moinulmoin/eden@0.1.0
```

Bun is supported as an installer only:

```sh
bun add --global @moinulmoin/eden@0.1.0
```

Node `>=24.17.0 <25` remains the Eden runtime requirement, including when Bun
installs the package; do not force the CLI through `bunx --bun`. Eden Deploy
v0.1.0 accepts pinned pnpm Eve projects, not Bun lockfiles or project toolchains.

The live Eden Agent model path uses Cloudflare AI Gateway's `default` gateway.
Cloudflare creates that gateway on the first authenticated request when it does
not already exist; Eden does not claim to provision a named gateway. See
[Cloudflare's AI Gateway getting-started guide](https://developers.cloudflare.com/ai-gateway/get-started/).

## Requirements

- Node `>=24.17.0 <25` (the version range represented by `.nvmrc`)
- pnpm `11.21.0` through Corepack for source checkouts
- Wrangler `4.120.0`, installed by the frozen lockfile

## Source checkout

The repository is a pnpm workspace with TypeScript project references. The
local gate is reproducible without Turbo and without a remote deployment.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm exec tsc -b --pretty false
corepack pnpm exec eslint . --max-warnings 0
corepack pnpm exec vitest run --maxWorkers=1
```

After `corepack pnpm run build`, invoke the local CLI entry point with:

```sh
node packages/cli/dist/index.js --help
```

In the examples below, `eden` means that same built entry point:

```sh
eden() {
  node packages/cli/dist/index.js "$@"
}
```

## Quickstart

Host an existing Eve project (preview target, exact named Worker):

```sh
export EDEN_BEARER_SECRET="$(openssl rand -hex 24)"
eden deploy --project ./my-eve-app --env preview --name my-eve-preview-$(date +%s)
```

Author a new agent with the Eden framework:

```sh
export EDEN_BEARER_SECRET="$(openssl rand -hex 24)"
eden agent init --project ./my-agent
eden agent build --project ./my-agent
eden agent dev --project ./my-agent   # http://127.0.0.1:8797 (inspector 127.0.0.1:9297)
```

## Local gate

Run the full serial conformance validator after the frozen install:

```sh
corepack pnpm run conformance:local
```

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/deploy.md`](./docs/deploy.md) | Eve hosting: targets, destroy semantics, Workflow World, env-file handling, Deploy/Adapt/Agent positioning |
| [`docs/agent-cli.md`](./docs/agent-cli.md) | Agent CLI reference, authentication boundaries, architecture, compatibility findings |
| [`docs/validation.md`](./docs/validation.md) | Clean-room walkthrough, deployed validation, provisional limits, out of scope, cleanup |

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for third-party
attribution.

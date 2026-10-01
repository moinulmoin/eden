# Eden

**Deploy your Eve agent to your own Cloudflare. One command. No rewrite.**

Eden is a free, open-source CLI for [Vercel Eve](https://github.com/vercel/eve) developers. It takes the Eve project you already have, builds it exactly the way Eve builds it, and runs it in a Cloudflare Container on your own Cloudflare account. You get a live `workers.dev` URL in about two minutes.

```sh
cd my-eve-agent
npx @moinulmoin/eden deploy
```

---

## Eden in 30 seconds

You built an agent with Eve. Eve's home is Vercel, and that's a great place for it. But maybe your stack, your bill and your team already live on Cloudflare.

Eden lets you run the same agent there. It doesn't port your agent to some other framework, and it doesn't touch your code. It runs your real Eve server inside a Cloudflare Container, puts a Worker in front of it, checks that it's healthy, and hands you the URL.

When you're done, one command removes exactly what Eden created and nothing else.

---

## Who it's for

- **Eve developers whose infrastructure is on Cloudflare** and who want their agents there too.
- **Teams that want the agent on their own account and their own bill**, with their own keys.
- **Anyone who wants a second home for an Eve agent** without maintaining two codebases. The same project still deploys to Vercel.

---

## What you get

### Your real Eve server, not a copy
Eden runs `eve build` and `eve start`, the same commands Eve documents for self-hosting. Your agent runs as a real Node server inside a Cloudflare Container (1 GiB of memory), behind a Worker that serves your `workers.dev` URL.

### One command to deploy
From inside your Eve project:

```sh
npx @moinulmoin/eden deploy
```

With no flags, Eden uses the current folder, a `preview` environment, and a stable name based on your `package.json`. While it works, it tells you what it's doing:

```text
eden deploy — my-eve-agent-9e510242 (preview)
... validating environment file
... packaging project — snapshot, frozen install, eve build
... checking Cloudflare access and exact target
... building linux/amd64 runtime image, booting eve, checking health
... pushing container image to the Cloudflare registry
... registering runtime variables
... publishing Worker and Container application
... verifying health at https://my-eve-agent-9e510242.<your-subdomain>.workers.dev

✓ deployed my-eve-agent-9e510242 (preview) · eve 0.66.3
https://my-eve-agent-9e510242.<your-subdomain>.workers.dev
done in 112s
```

That's real output from a real deploy, with the account subdomain hidden and the per-check lines trimmed. In our tests a full deploy took about 2 minutes (112–133 seconds).

### Only goes live when it's healthy
Eden builds the image, boots Eve inside it, and checks Eve's health route *before* publishing. After publishing, it checks the live URL again. Only a healthy deployment becomes the current one.

### Your secrets stay secret
Runtime values such as model keys go in through a file you choose:

```sh
eden deploy --env-file ~/.config/my-agent/preview.env
```

They are never placed in command arguments, image layers, generated files, or normal logs.

### Clean, exact removal
```sh
eden destroy --name my-eve-agent-9e510242
```

Eden checks its own ownership record, then removes that deployment's Worker, Container application and registry images. It never matches by prefix and never touches look-alike resources. In our tests it took 15–25 seconds.

### Three commands. That's the whole CLI.

| Command | What it does |
|---|---|
| `eden preflight` | Builds and checks your project and your Cloudflare access. Changes nothing on Cloudflare. Optional, since `deploy` runs the same checks |
| `eden deploy` | Builds, publishes and health-checks one exact target |
| `eden destroy --name <name>` | Removes one exact Eden-owned deployment |

Every command accepts `--json` for scripts and CI.

### Safe defaults
- `deploy` and `preflight` default to `preview`.
- Deploying to `production` always requires an explicit `--name`.
- `destroy` always requires an explicit `--name`. Eden never guesses what to delete.

---

## What stays yours

Eden only hosts the app. Everything your agent depends on stays in your Eve project, configured the way you configured it:

- your model providers and keys
- your databases, queues and external APIs
- your channels, schedules and sign-in
- your sandbox and your Workflow storage

Your code is never edited. The same project keeps working with `eve dev` and on Vercel.

---

## Any model provider

Eve works with any AI SDK provider, and so does Eden:

- **Direct providers:** use Eve's `openai()` or `anthropic()` helpers, or any `@ai-sdk/*` provider package, and put that provider's key in your env file.
- **Vercel AI Gateway model IDs** (a model written as text, such as `"openai/gpt-5"`): add `AI_GATEWAY_API_KEY` to your env file. Off Vercel, Gateway models need that key.

---

## What you need

1. **Node 24.17 or newer**, on macOS or Linux.
2. **Docker or OrbStack** that can build `linux/amd64` images.
3. **A Cloudflare account on the Workers Paid plan ($5/month).** Cloudflare Containers aren't available on the free plan.
4. **Wrangler login:** `npx wrangler@4.120.0 login`.
5. **An Eve project using pnpm**, with an exact `packageManager: "pnpm@..."` entry and its `pnpm-lock.yaml`.
6. **`just-bash` as a dependency** (`pnpm add just-bash`). Eve's default sandbox needs it on Cloudflare, and `eve init` doesn't add it.

Plus whatever your agent itself needs: model keys, databases, external services.

---

## Before you deploy: two things to set in your Eve project

**1. Real sign-in.** A fresh `eve init` project only accepts Vercel-issued tokens in production. Off Vercel, that means every request except the health check gets a 401. Pick one of Eve's authenticators in `agent/channels/eve.ts`, for example `jwtHmac()`, `httpBasic()` or `oidc()`, or `none()` for a public demo. Eve's own self-hosting guide says the same.

**2. Durable memory for real agents.** The container's disk is wiped whenever it sleeps, so by default Eve forgets pending approvals and sessions. Three steps fix it: add the Postgres World package, select it in `agent.ts`, and put a direct Postgres URL in your env file. Any Postgres works (Neon, Supabase, Railway, your own server); use the direct address, not a pooled one. Eden runs the database setup for you during deploy. See [Durable state (Postgres World)](docs/deploy.md#durable-state-postgres-world).

---

## What it costs

Eden is free and open source (Apache-2.0). You pay Cloudflare directly, on your own account:

- **Workers Paid:** $5/month, which includes some Container usage.
- **Container time:** billed only while the container runs. At Cloudflare's published rates (checked September 2026), a `basic` container running all month comes to about $12/month including the $5 plan, plus CPU used. Eden lets the container sleep after 24 hours without requests, and it wakes on the next request. Each scheduled run also wakes it, so an agent with daily or more frequent schedules is effectively always on.
- **Your model usage** goes to your model provider, with your key.

---

## Honest limits

- **Container disk is wiped on sleep.** Memory survives only with the Postgres World (three steps, above). Without it, Eden warns you on every deploy.
- **Schedules use standard 5-field cron.** Those fire on time even while the container sleeps. Schedules with a seconds field or shortcuts like `@daily` only run while it's awake, and Eden warns about them.
- **The agent's bash is simulated.** Inside a Cloudflare Container, Eve's default sandbox uses `just-bash`, a simulated shell with a virtual filesystem, not a full Linux VM. Agents that need real tools such as `python` or `git` in their sandbox aren't a fit yet.
- **One container instance per deployment.** No automatic scaling.
- **`workers.dev` URL only.** Eden doesn't set up custom domains.
- **One agent per project.** Eve multi-agent workspaces aren't supported.
- **Vercel-only Eve features don't come along:** Connect channels and connections, Blob-backed memory, Vercel sign-in (`vercelOidc`), Agent Runs, and cost limits reported by the AI Gateway.

---

## Eden on Cloudflare vs Eve on Vercel

| | Eve on Vercel | Eve on Cloudflare with Eden |
|---|---|---|
| Deploy | `eve deploy` or `git push` | `npx @moinulmoin/eden deploy` from your machine |
| Where it runs | Vercel Functions and Workflow | Your real Eve server in a Cloudflare Container on your account |
| Durable storage | Managed by Vercel | Your Postgres, three steps; Eden sets up the database |
| Schedules | Vercel Cron | Cloudflare Cron wakes the container; fires while asleep |
| Sign-in | Vercel sign-in built in | Configure an Eve authenticator |
| Models | AI Gateway built in | Any provider with your key, or Gateway with a key |
| Sandbox | Vercel Sandbox | Simulated bash (`just-bash`) |
| Scaling | Automatic | One instance |
| Price to start | Free Hobby plan | $5/month Workers Paid plus usage |
| Your code | Unchanged | Unchanged, and still deploys to Vercel |

Pick Vercel when you want Eve's full managed platform. Pick Eden when you want your agent on Cloudflare, on your own account.

---

## Tested for real

- A real `eden deploy` to Cloudflare served a real model reply with a tool call, and `eden destroy` then left no Worker, container or image behind.
- Validated with real Cloudflare deploys on **Eve 0.66.3** and **Eve 0.68.0**: build, production boot, health, sign-in, and a real model and tool call.
- **Memory across a container replacement:** with the Postgres World, an approval requested before the container was destroyed and replaced was approved afterwards and the run finished. Without it, the approval was lost.
- **Schedules while asleep:** a schedule every 3 minutes fired exactly once per tick while the container slept between ticks.
- Eden's own release gates run build, typecheck, lint, tests and the Eve compatibility check on every change.

---

## Get started

```sh
npm install --global @moinulmoin/eden
cd my-eve-agent
eden deploy --env-file ~/.config/my-eve-agent/preview.env
```

- Website: https://eden.ideaplexa.com
- GitHub: https://github.com/moinulmoin/eden
- npm: https://www.npmjs.com/package/@moinulmoin/eden
- Deploy guide: [`docs/deploy.md`](./docs/deploy.md)

Built by [Moinul Moin](https://github.com/moinulmoin). Open source under Apache-2.0.

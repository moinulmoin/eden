---
name: eden
description: Deploy, update, or remove a Vercel Eve agent on the user's own Cloudflare account with the Eden CLI. Use when someone wants to run an Eve project off Vercel, host an Eve agent on Cloudflare Workers/Containers, ship a change to an Eden deployment, or tear one down.
---

# Eden: deploy an Eve agent to Cloudflare

Eden (`@moinulmoin/eden`) builds an existing Eve project and runs it in a Cloudflare Container behind a Worker on the user's own account. The Eve source is not rewritten. Docs: https://github.com/moinulmoin/eden

## Before deploying, check

- macOS or Linux, Node `>=24.17.0`
- Docker or OrbStack running, with linux/amd64 support
- Cloudflare Workers Paid plan (Containers need it) and Wrangler logged in: `npx wrangler@4.147.0 login`
- The project uses pnpm: `package.json` has an exact `"packageManager": "pnpm@..."` and a root `pnpm-lock.yaml` exists
- `just-bash` is a production dependency (`pnpm add just-bash`); `eve init` does not add it
- `agent/channels/eve.ts` uses a real authenticator, not the generated Vercel/localhost placeholder, which grants no access on Cloudflare

For a fresh `eve init` project (npm lockfile), follow "Starting from a fresh Eve project" in the README before the first deploy.

## Secrets

Put the model key (for AI Gateway models, `AI_GATEWAY_API_KEY`) and auth secrets in an env file **outside the project**, mode 600. Never print it, commit it, or pass secrets as command arguments. Pass it with `--env-file`.

## Commands

```sh
# optional, read-only: build and check without touching Cloudflare
npx @moinulmoin/eden preflight --env-file ~/.config/<agent>/preview.env

# deploy (preview environment, name derived from package.json)
npx @moinulmoin/eden deploy --env-file ~/.config/<agent>/preview.env

# ship a change: run the same deploy again; it updates in place on the same URL
npx @moinulmoin/eden deploy --env-file ~/.config/<agent>/preview.env

# remove it (always needs the exact --name printed by deploy)
npx @moinulmoin/eden destroy --name <target-name>
```

- `--env production` and `destroy` require an explicit `--name`.
- Add `--json` for a machine-readable result.
- A successful deploy prints the target name, Eve version, and the `workers.dev` URL on its own line. A fresh deploy takes a few minutes, mostly building the container.
- Confirm with the user before `destroy` or any production deploy.

## Verify

```sh
curl -s https://<url>/eve/v1/health   # expect "status":"ready"
```

The first request after the agent sleeps takes about 10–15 seconds while Eve starts.

## Limits to tell the user about

- The agent's sandbox is `just-bash`, a simulated shell: files, grep, sed, jq, sqlite3 and curl work; python, git and npm do not.
- Projects that choose their own sandbox in `agent/sandbox.ts` (Docker, microsandbox, Vercel Sandbox) are not supported yet.
- One container per agent, `workers.dev` URL only, no custom domains yet.
- The container sleeps after 1 hour idle and wakes on the next request. Standard 5-field cron schedules still fire while it sleeps.
- Every conversation's files survive sleep and updates. Local Workflow World state resets on update; use the Postgres World (see docs/deploy.md) to keep in-flight runs.

## When it fails

Eden error codes say what failed and what to do next, and nothing on Cloudflare is changed when checks fail. Read the `→` hint under the failing check and fix that first. `VAL-CLI-007-TARGET-CONFLICT` means a resource with that name exists that Eden does not own: pick another `--name` rather than deleting it.

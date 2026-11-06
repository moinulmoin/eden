# Security

This page covers what Eden does with your secrets, what is public once you
deploy, what Eden can touch in your Cloudflare account, and where the sandbox
stops protecting you. For the overall design see
[How Eden works](./how-it-works.md).

## Secrets and the env file

Runtime values such as model keys and auth secrets go in an env file you pass
with `--env-file`. Keep it outside the project and outside source control,
readable only by you:

```sh
chmod 600 ~/.config/my-agent/preview.env
```

How Eden handles it:

- **Validated before anything else.** The file must be a regular file (no
  symbolic links), UTF-8 `KEY=VALUE` records, and must not set names Eden
  reserves for the host, such as `HOST`, `PORT`, `NITRO_*`, `NODE_ENV`,
  `NODE_EXTRA_CA_CERTS`, or Eden's own identity variables. `EVE_DEV`,
  `VERCEL`, `VERCEL_ENV`, and `VERCEL_TARGET_ENV` are also rejected: they
  switch Eve into development mode, which can let unauthenticated callers
  in. Eden checks that the file does not change while the deploy runs. See
  the [reference](./reference.md) for the exact rules.
- **Never in the image.** Eden copies your project into the builder without
  your env file, without any `.env*` file, and without credential files
  (`.npmrc`, `.pnpmrc`, `.pypirc`, `.yarnrc`, `.yarnrc.yml`, `.bunfig.toml`,
  `.dev.vars`, `.dev.vars.*`, `.netrc`, `.git-credentials`, `id_rsa`,
  `id_ecdsa`, `id_ed25519`, `id_dsa`, `*.p12`, `*.pfx`, `.aws/credentials`,
  `*.tfvars`, `secrets.json`, `credentials.json`, `service-account.json`,
  `*.pem`, `*.key`). Public SSH keys (`*.pub`) are not excluded. If the
  install or `eve build` output still contains one of those files, or a
  symbolic link that points outside the project, the deploy stops with
  `SECRET_EXCLUSION_FAILED`.
- **Not from your shell.** Eden runs Docker with a minimal environment
  (`PATH`, `HOME`, `TMPDIR`, locale, and Docker settings) and starts the local
  boot check with a private environment bound to `127.0.0.1` only, so
  unrelated credentials in your terminal do not reach the build and the
  boot-check port is not exposed to other machines.
- **Uploaded as Worker secrets.** Each value is uploaded with
  `wrangler secret put`, passing the value on standard input rather than as a
  command argument. Values are not written to command arguments, image
  layers, generated artifacts, or normal logs.
- **Given to the container at start.** When the Durable Object starts the
  container, it reads those secrets and passes them in as environment
  variables. Only the names from the current deploy's env file are passed, so
  use the same `--env-file` on every deploy.
- **`destroy` takes no env file.** Cleanup never needs your secrets.

## What is public

Your agent gets a public `https://<name>.<subdomain>.workers.dev` URL. Anyone
who finds it can send requests, so **your Eve authenticator is what protects
the agent.** The authenticators that `eve init` generates for Vercel and
localhost do not grant access on Cloudflare; replace the placeholder in
`agent/channels/eve.ts` with a real
[Eve authenticator](https://eve.dev/docs/guides/auth-and-route-protection)
before you deploy.

What the Worker does for you:

- Returns `404` for Eve's internal workflow queue routes
  (`/.well-known/workflow/v1/flow` and `/step`) and for `/__eden/world/*`.
  Eve's own queue deliveries reach the container through an internal path
  instead, so the public routes are never needed.
- Still forwards token-bearing `webhook/<token>` routes and `manifest.json`,
  which Eve protects itself.
- Removes headers a client could spoof: `forwarded`, `x-real-ip`,
  `true-client-ip`, `x-original-host`, `x-proxy-host` and similar, plus every
  incoming `x-forwarded-*`, `x-eden-*`, and `cf-*` header. It then sets its own
  `host`, `forwarded`, and `x-forwarded-host`/`-port`/`-proto`, so Eve sees the
  real public origin.
- Adds `x-eden-eve-*` response headers with the Worker name, public origin,
  deployment and generation IDs, and container instance name. They identify
  the deployment; they contain no secrets.

For Cloudflare World packages declaring `worldRpcAuth`, the container's World
RPC endpoint requires a per-start secret supplied only to that container's
World client. This protects workflow state across sessions; the RPC endpoint
is not protected by the agent's Eve authenticator. Update both the CLI and
the project's Cloudflare World package to enable it. Older kept versions
without this capability could expose every session's workflow state through
their sandbox. The next deploy now removes their routes and retires them
regardless of live sessions, queued messages, or transfers. This includes
the legacy `eden-cloudflare` version from Eden ≤`0.9.0`. Their sessions end;
users must start new ones. Their next message fails; Eve may return the generic
"Failed to send the session message" error. Authenticated kept versions retain normal drain
behavior. `EDEN_WORLD_TOKEN` is reserved and cannot be supplied through
`--env-file`.

## The sandbox

Eden agents use Eve's `just-bash` sandbox: a simulated shell that runs inside
Eve's own process, not a separate Linux VM like Vercel Sandbox. Treat it as a
convenience for file and text work, not as an isolation boundary between the
agent's commands and the rest of the container.

- The sandbox and the container have unrestricted outbound internet access.
  Eve offers no setting to restrict just-bash networking
  ([eve#2927](https://github.com/vercel/eve/issues/2927)).
- Be careful with tools and skills that let untrusted users steer the agent's
  shell or network calls.

## What Eden can change in your Cloudflare account

Eden acts through your Wrangler login (`npx wrangler@4.147.0 whoami`) and
never switches accounts silently. For each target it creates one Worker, one
Container application, its Durable Objects, registry images, and, only when
your project has schedules, one Cron Trigger. The exact names are listed in
the [reference](./reference.md).
Wrangler runs in a fresh Eden-owned temporary directory outside the project;
project `.env` and `.env.local` files cannot redirect account operations or
secret uploads.

- **Exact ownership.** Eden writes a deployment record under
  `.eden/eve-deploy/` in your project. A deploy only updates a target that
  record proves Eden created; anything else fails with
  `VAL-CLI-007-TARGET-CONFLICT` instead of being overwritten.
- **Exact cleanup.** `destroy` requires the recorded Worker and derived
  Container name and the authenticated account. When the Worker exists, Eden
  compares its authenticated provider settings with the recorded deployment
  and per-publish release IDs and verifies the Container's namespace matches
  its binding.
  If the Worker is already gone, the record, account, and exact names still
  permit cleanup of leftover Containers and images. Failed inventory reads
  are indeterminate, not proof of absence. Eden deletes only that target and
  the registry images its records identify, then verifies they are gone.
  It never deletes by name prefix.
  Deployment and release IDs are public: these checks protect against stale
  records and name reuse, not a malicious project carrying a forged `.eden`
  record with a known account and release ID. Do not trust `.eden` state from
  an untrusted project.
- **Production is explicit.** `--env production` and `destroy` always require
  `--name`.

## What Eden changes in Eve

Nothing in your project. Eve `0.83.0` and later stable releases include the
upstream [eve#4440](https://github.com/vercel/eve/issues/4440) fix; Eden leaves
their just-bash binding unchanged and reports
`✓ EVE_SANDBOX_RESUME_PATCH — not needed`. For older Eve releases, Eden applies
a temporary fix inside the throwaway build container only, and only when the
binding matches a recognized checksum. An unknown older binding is left
unchanged and prints an `EVE_SANDBOX_RESUME_PATCH` warning.

## The Eden packages

`@moinulmoin/eden` and its companion packages are published to npm from
GitHub Actions with npm provenance, so you can check that a release was built
from this repository:

```sh
npm view @moinulmoin/eden dist.attestations
```

## Reporting a problem

Open an issue at <https://github.com/moinulmoin/eden/issues>. Never paste
env-file values, tokens, or full `--json` output that might contain them.

Return to the [documentation index](./README.md).

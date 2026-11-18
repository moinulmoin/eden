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
  your env file, without any `.env*` or `*.env` file, and without credential
  files (`.npmrc`, `.pnpmrc`, `.pypirc`, `.yarnrc`, `.yarnrc.yml`,
  `bunfig.toml`, `.bunfig.toml`, `.dev.vars`, `.dev.vars.*`, `.netrc`,
  `.git-credentials`, `id_rsa`, `id_ecdsa`, `id_ed25519`, `id_dsa`,
  `id_ecdsa_sk`, `id_ed25519_sk`, `id_xmss`, `*.p12`, `*.pfx`,
  `.aws/credentials`, `*.tfvars`, `secrets.json`, `credentials.json`,
  `service-account.json`, `*.pem`, `*.key`). These names match in any letter
  case. Public SSH keys (`*.pub`) are not excluded. If the
  install or `eve build` output still contains one of those files, or a
  symbolic link that points outside the project, the deploy stops with
  `SECRET_EXCLUSION_FAILED`.
- **Not from your shell.** Eden runs Docker, and the `file` tool that checks
  native modules, with a minimal environment
  (`PATH`, `HOME`, `TMPDIR`, locale, and Docker settings) and starts the local
  boot check with a private environment bound to `127.0.0.1` only, so
  unrelated credentials in your terminal do not reach the build and the
  boot-check port is not exposed to other machines. If Eve exits during the
  boot check, the failure shows the last lines Eve printed, with env-file
  values redacted.
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

Any request wakes the container and restarts its idle timer (one hour by
default), even one your authenticator rejects, because only Eve knows who is
allowed in. Someone who finds the URL can therefore keep the container
running, which costs you Container time; it cannot get past your
authenticator.

What the Worker does for you:

- Returns `404` for Eve's internal workflow queue routes
  (`/.well-known/workflow/v1/flow` and `/step`) and for `/__eden/world/*`.
  Eve's own queue deliveries reach the container through an internal path
  instead, so the public routes are never needed. The Cloudflare World
  relies on this: it declares `queueAuthMode: "skip"`, so Eve does not
  authenticate queue deliveries itself.
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

The container's Cloudflare World RPC endpoint always requires a per-start
secret supplied only to that container's World client; requests without it
get `403`. This protects workflow state across sessions; the RPC endpoint is
not protected by the agent's Eve authenticator. Preflight requires a
Cloudflare World package with this capability (0.10.0 or later). Older kept
versions without this capability could expose every session's workflow state through
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
Eden also reads the target's state from Cloudflare's API with requests of
its own. One of its own requests can change something, and it is Eden's
first direct registry mutation: when a Wrangler registry delete fails, Eden
repeats that delete for the same tag against `registry.cloudflare.com` to
read the registry's answer, because Wrangler prints only the status. For
this, Eden asks Wrangler for a registry credential (push and pull on your
account's registry, valid for five minutes), checks that it names the
account in the deployment record, and reuses it for at most four minutes
within one command. The request uses a connection of its own: no proxy,
certificate verification always on, no redirect followed, 30 seconds at
most, and at most 4 KiB of response read. Eden does not store or print the
credential.
Wrangler runs in a fresh, private Eden-owned temporary directory outside the
project, with its configuration file and account cache pinned inside it.
Project `.env` files and configuration or cache files planted in a shared
temporary directory cannot redirect account operations or secret uploads.

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
- **Snapshots outlive destroy.** A snapshot holds the container's whole disk
  from the moment it was taken, including the agent's files and, with the
  default local World, its workflow state. Cloudflare's registry refuses to
  delete one. Cloudflare documents that it removes a snapshot 30 days after
  it was created or last restored; Eden cannot confirm when that happens.
  Until then the tags stay in your account's Cloudflare registry, and a
  registry read with your account's credentials still returns the
  snapshot's manifest. `destroy` lists the exact tags and an estimated date
  in `EVE_SNAPSHOTS_RETAINED`.
- **Production is explicit.** `--env production` and `destroy` always require
  `--name`.

## What Eden changes in Eve

Nothing. Eden builds your project and Eve's own files as they are; it patches
neither.

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

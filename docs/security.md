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
- **Uploaded as Worker secrets.** The values are uploaded together with the
  Worker version (`cf deploy --prebuilt --secrets-file`), so code and values
  change together. Eden writes them to one file, readable only by your user,
  in the private temporary folder that command runs in, and deletes the
  folder when the command ends. `cf` runs with `CLOUDFLARE_ACCOUNT_ID` set to
  the account Eden checked, so the values go to that account or the upload
  fails. Secrets the file does not name stay as they are. On an update Eden
  may also set its own deployment-control token at once with
  `cf workers secrets bulk-edit`, again from a file. Values are not written
  to command arguments, image layers, generated artifacts, or normal logs.
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

Eden acts through your `cf` sign-in (`npx cf@1.0.0-rc.2 auth whoami`), or
through `CLOUDFLARE_API_TOKEN` when you set it, and
never switches accounts silently. For each target it creates one Worker, one
Container application, its Durable Objects, registry images, and, only when
your project has schedules, one Cron Trigger. The exact names are listed in
the [reference](./reference.md).
On an account with no Worker yet, `eden deploy` also deploys and deletes one
temporary Worker named `eden-origin-probe-<8 hex characters>`, which has no
URL and no bindings, to read the account's `workers.dev` subdomain.
Eden reads the target's state through `cf`. Eden sends requests of its own
to one place only: `registry.cloudflare.com`. Those requests can change
something. They name only repositories that the deployment record proves
this target owns. When `eden destroy` or an update cleans up such a
repository, Eden:

- reads the registry's listing of the repository, because `cf` lists
  tags only;
- deletes each `sha256:` entry of the listing by digest, because `cf`
  deletes tags only. The registry lists one such entry for every manifest,
  with or without a tag;
- repeats the delete of a tag when the registry answered `cf`'s delete
  of that tag with `403`, to read the registry's answer, because `cf`
  prints only the status. Eden repeats no tag delete after any other
  `cf` failure.

For these, Eden asks `cf` for a registry credential
(`cf containers registries credentials generate`)
(push and pull on your account's registry, valid for five minutes), checks
that it names the account in the deployment record, and reuses it for that
account only, within one command, until four minutes have passed since it
asked. It drops a
credential the registry answers with `401`. Each request uses a connection
of its own: no proxy, certificate verification always on, no redirect
followed, 30 seconds at most. Eden reads at most 4 KiB of the answer to a
delete and 1 MiB of one page of a listing. Requests that get no answer may
take 60 seconds in total in one command. After that Eden sends no more of
them. `eden destroy` then fails if anything without
one of the registry's kept answers is still in its final listing, or if it
cannot read that listing. `eden deploy` fails `VAL-LIFE-007` when it cannot
prove that everything else in the repository is gone, which includes a
listing it cannot read. The one exception is the image a same-version update
replaced: when its delete cannot be shown, deploy succeeds with the warning
`EVE_SUPERSEDED_IMAGE_NOT_DELETED`. A listing counts as read only when every page is
exactly in the form the registry sent on 2026-11-18: the recorded account
and the repository asked for, entries in ascending order, and a `Link`
header that continues from the page's last entry and is empty only after
an empty page, within 100 pages. An answer that names a field twice is
refused, for a listing and for a refusal alike. Eden cannot tell a stale answer from a
current one when both pass these checks.
Eden does not store or print the credential.

### What Eden can and cannot read

`cf auth login` keeps its OAuth token in the operating system's keychain
when one is available. Eden cannot read it there and reads no OAuth token
from disk. Eden 0.14 and earlier read Wrangler's saved token; this version
only checks whether Wrangler's login file exists, to explain a signed-out
`cf`, and never opens it.

Eden itself never reads or sends `CLOUDFLARE_API_TOKEN`; only `cf` uses it,
as its login. A token made from Cloudflare's "Edit Cloudflare Workers"
template, unchanged, ran preflight, a first deploy, an update, and a destroy
on 2026-11-20. A narrower set of permissions was not tested. `cf` has no
command for the account's `workers.dev` subdomain, so Eden reads it from the
URL of any Worker the account already has (`cf workers list --per-page 1`).
When the account has no Worker yet, `eden deploy` deploys one temporary
Worker with no URL, reads its `workers.dev` URL, and deletes it, as
[`EVE_ORIGIN_UNAVAILABLE`](./troubleshooting.md#eve_origin_unavailable)
describes.

Every `cf` command runs in a fresh, private temporary folder that Eden
creates outside the project and deletes afterwards. The folder holds an
empty `cloudflare.config.ts` and the files that one command needs, nothing
else. `cf` gets a fixed list of your shell's variables (see the
[reference](./reference.md#variables-eden-reads)), and
`CLOUDFLARE_API_BASE_URL` is always `https://api.cloudflare.com/client/v4`.
So a project's `cloudflare.config.ts` or `.env` file cannot choose the
account or the token.

### Which account each command uses

Eden asks `cf auth whoami` which account the login names. That command exits
0 signed in or not, so Eden reads its JSON: `authenticated` and `tokenValid`
must be true, and it must list exactly one account. Eden does not
pin that command; it receives `CLOUDFLARE_ACCOUNT_ID` only when you set it.
`eden preflight` and `eden deploy` ask before the build and again after it.
If the second answer names another account, the command stops at the
[Cloudflare access check](./troubleshooting.md#val-cli-007-cloudflare-access--cloudflare-access-is-blocked)
before it reads or writes anything there. Every other `cf` command runs with
`CLOUDFLARE_ACCOUNT_ID` set to the account Eden checked. For destroy that is
the account in the deployment record, which the login must name:

| `cf` command | When | Account |
| --- | --- | --- |
| `auth whoami` | preflight, deploy, destroy | The login's own; Eden requires exactly one, matching `CLOUDFLARE_ACCOUNT_ID` when you set it |
| `containers applications list --name`, `containers applications get` | preflight, deploy, destroy | The checked account |
| `workers deployments list`, `workers versions get`, `workers versions list` | preflight, deploy, destroy | The checked account |
| `workers list --per-page 1` | preflight, deploy | The checked account |
| `containers push --tag` | deploy | The checked account |
| `workers secrets bulk-edit` | deploy (an update, for Eden's deployment-control token) | The checked account |
| `deploy --prebuilt` | deploy | The checked account, also named as `settings.accountId` in the Build Output's `config.json`, which `cf` reads before the variable |
| `containers applications create`, `workers triggers deploy --prebuilt` | deploy, only to finish a publish that `cf deploy` left half done | The checked account |
| `containers registries credentials generate` | deploy, destroy | The checked account |
| `containers images delete --force` | deploy (superseded images), destroy | The checked account |
| `workers delete --force`, `containers applications delete --force` | destroy | The checked account |

Eden reads and deletes no secret through `cf`. A login that changes
mid-run cannot move one of these commands to another account. If the new
login cannot act on the checked account, the command fails.

- **Exact ownership.** Eden writes a deployment record under
  `.eden/eve-deploy/` in your project. A deploy only updates a target that
  record proves Eden created; anything else fails with
  `VAL-CLI-007-TARGET-CONFLICT` instead of being overwritten.
- **Exact cleanup.** `destroy` requires the recorded Worker and derived
  Container name and the authenticated account. When the Worker exists, Eden
  reads the bindings of the Worker version in service, compares them with
  the recorded deployment and per-publish release IDs, and verifies the
  Container's namespace matches its binding. A Worker whose first publish
  stopped before its Container application existed is proven the same way,
  from that version and the failed attempt's record.
  If the Worker is already gone, the record, account, and exact names still
  permit cleanup of leftover Containers and images. Failed inventory reads
  are indeterminate, not proof of absence. A Worker or a Container application counts
  as absent only on Cloudflare's own single answer, as `cf` prints it: exit
  code 1, nothing on standard output, exactly one error with the expected
  code (`10007` for a Worker, `1609` for a Container application) and
  status `404`, for the exact request path of that account and name.
  For a Worker, both `cf workers deployments list` and `cf workers get`
  must give that answer.
  Anything else is unknown, never absent. `cf` prints an API response's
  messages in the same form as its errors, so Eden cannot tell which of the
  two carried the code. A
  Container application list counts only when `cf` exits 0 and prints a JSON
  list.
  Each read asks `cf` for the account once and runs every other command on
  that account, and destroy reads nothing from an account other than the
  recorded one. `cf` runs destroy's Worker, Container application, and
  image deletes with `CLOUDFLARE_ACCOUNT_ID` set to the recorded account, so
  a login that changes mid-run cannot move a delete to another account. Eden removes only that target and
  checks its registry repositories for anything other than
  [objects Cloudflare keeps](./troubleshooting.md#eve_registry_objects_kept).
  It never deletes by name prefix.
- **Destroy clears only its own pointer.** Destroy refuses a target whose
  record is reached through a symlink that leaves the project's `.eden`
  folder, and reads no record file that is a symlink. It removes `CURRENT` only if the pointer is still the file it read
  before it read Cloudflare. The check and the removal are two steps, so a
  program outside Eden's lock that replaces the pointer between them is not
  stopped. A deploy of the same Worker from another folder or machine is not
  stopped either: destroy proves absence at the time of its last read, not
  afterwards.
  Deployment and release IDs are public: these checks protect against stale
  records and name reuse, not a malicious project carrying a forged `.eden`
  record with a known account and release ID. Do not trust `.eden` state from
  an untrusted project.
- **Registry cleanup covers whole repositories.** It tries to delete every tag and
  manifest the registry lists in a repository that the record proves this
  target owns, including one that appears while it runs. Eden never runs it
  on a repository that holds the image it just promoted or the image of a
  version it still keeps. In that repository a same-version update deletes
  only the image it replaced, after the new deployment is healthy and
  promoted. The deployment record names that image's repository, its
  digest, and its tag: the release ID of the deploy that pushed it
  (`eve-deploy-<uuid>`). Eden deletes that tag, and nothing else, only when the registry
  lists the tag and resolves it to that digest. It sends no delete by
  digest here; it reads the listing until the tag and the image's
  `sha256:` entry have left. `cf`'s delete of a tag carries no digest, so this rests
  on a release tag being unique to one push and never moved: Eden generates
  it and pushes it once. Do not push to or retag a release tag by hand.
  Eden never deletes `candidate` here, the tag Eden `0.13.x` and older
  push, because an older CLI in another checkout can move it. It deletes
  nothing when the repository also holds the image of a kept version, or of
  a version whose retirement the record still names. Eden works with one spelling of an image,
  `registry.cloudflare.com/<account>/<repository>@sha256:<digest>`, and
  refuses any other reference before it changes anything on the target. A recorded image that is
  not in that form cannot be placed in a repository, so it stops every
  sweep of that deploy. `eden deploy` and `eden destroy` take one lock in
  the project's `.eden` folder, which stops two runs from the same folder
  only. It does not stop a copy of the project on another machine, or any
  other push to the registry: an image pushed to an owned repository while
  cleanup runs can be deleted.
- **Some registry objects outlive destroy.** Destroy tries to delete everything
  Cloudflare's registry lists for the target, and Cloudflare keeps three
  kinds of object. `destroy` lists each one, with the registry's answer, in
  `EVE_REGISTRY_OBJECTS_KEPT`.
  - A snapshot holds the container's whole disk from the moment it was
    taken, including the agent's files and, with the default local World,
    its workflow state. Cloudflare's registry refuses to delete one.
    Cloudflare documents that it removes a snapshot 30 days after it was
    created or last restored; Eden cannot confirm when that happens.
  - The registry can accept the delete of a manifest and still list it.
    The one seen was an earlier image with no tag, still listed 18 minutes
    later. An image manifest names the layers of an image. They hold the
    project's built code and no `--env-file` value.
  - Cloudflare makes a chain artifact for each pushed image, and its
    registry refuses to delete it. Cloudflare does not document what it
    holds.

  Until Cloudflare removes them, these objects stay in your account's
  registry, and a registry read with your account's credentials still
  returns them. Not known: when Cloudflare removes chain artifacts and
  untagged manifests, and whether kept objects count toward the 50 GB of
  image storage per account in Cloudflare's Containers limits.
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

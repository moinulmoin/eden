# Security

This page covers what Eden does with your secrets, what is public once you
deploy, what Eden can touch in your Cloudflare account, where the sandbox
stops protecting you, and the anonymous usage event Eden sends. For the overall design see
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
  folder when the command ends, when it times out, and when Eden gets
  Ctrl-C (`SIGINT`) or `SIGTERM`. A killed Eden (`SIGKILL`), a crash, or a
  power loss can leave the folder: it is `eden-cf-<random>` under your
  temporary folder, mode `0700`, with `secrets.json` mode `0600`. Delete it
  by hand if a deploy ended that way. `cf` runs with `CLOUDFLARE_ACCOUNT_ID` set to
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
Eden reads the target's state from Cloudflare's API itself, with `GET`
requests to `api.cloudflare.com` that change nothing; see
[How Eden reads Cloudflare's API](#how-eden-reads-cloudflares-api). Eden
sends requests of its own that can change something to one place only:
`registry.cloudflare.com`. They name only repositories that the deployment record proves
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

`cf auth login` keeps its login in the operating system's keychain when one
is available, and in an encrypted file otherwise. Eden reads neither. Eden
0.14 and earlier read Wrangler's saved token from disk; this version only
checks whether Wrangler's login file exists, to explain a signed-out `cf`,
and never opens it.

### How Eden reads Cloudflare's API

Eden decides that a Worker or a Container application exists, is absent, or
is its own from the answers of Cloudflare's API themselves: the status, the
`success` field, the errors, and the result. `cf` prints those answers as
text and leaves parts of them out, so Eden makes these reads itself. They
are `GET` requests to `https://api.cloudflare.com/client/v4` only, for the
checked account:

- the Worker's deployments, its versions, one version's bindings, and the
  Worker itself;
- the Container applications of the target's name, and one application;
- the account's `workers.dev` subdomain.

Eden changes nothing with them. Every change to a Worker or a Container
application goes through `cf`. The one change Eden sends itself is registry
cleanup: the delete requests to `registry.cloudflare.com` described under
[What Eden can change in your Cloudflare account](#what-eden-can-change-in-your-cloudflare-account).

The reads need a token. When `CLOUDFLARE_API_TOKEN` is set, Eden sends that
token and takes nothing from `cf`. A token made from Cloudflare's "Edit
Cloudflare Workers" template, unchanged, ran preflight, a first deploy, an
update, and a destroy on 2026-11-20, on an earlier build of this version in
which `cf` made the reads. A narrower set of permissions was not tested, and
no API token was run against this build's own reads.

Without the variable, Eden uses the token of your `cf` login.
`cf 1.0.0-rc.2` has no command that prints it, so Eden gets it this way:

1. Eden opens a listener on `127.0.0.1`, on a port the system picks, before
   it starts `cf`.
2. Eden runs `cf auth whoami` with `CLOUDFLARE_API_BASE_URL` set to that
   listener, under a random path that only this `cf` process is given.
   For this one command Eden passes `cf` no proxy variables and turns its
   telemetry off.
3. `cf` asks the listener who it is and sends its login's token, as it would
   to Cloudflare. On 2026-11-20 one `cf auth whoami` sent three such
   requests, for `/accounts`, `/memberships` and `/user`. Eden takes the
   token from the first request that has the random path, is a `GET` of one
   of those three, and names `cf-cli/1.0.0-rc.2` as its user agent.
4. The listener answers every request `401` itself and sends none of them
   anywhere.
5. The listener keeps its port until `cf` has exited, also when Eden stops
   `cf` because its time ran out. Only then does it close. So no other
   program can take the port while `cf` may still send the token to it.
   Only `cf`'s own exit counts. When Eden tells `cf` to stop and `cf` does
   not exit within two seconds, Eden takes no token, keeps the port until
   Eden itself ends, and the command fails as it does when no token arrives.

The token stays in Eden's memory for that one command. Eden does not print
it, write it to disk, or put it in a command line or an environment
variable, and sends it nowhere but `api.cloudflare.com`. A login's token
expires, so when Cloudflare answers `401` for it Eden takes it from `cf`
once more. One command can ask `cf` several times. On 2026-11-20 one such
`cf auth whoami` took about half a second.

`eden preflight` makes these reads too. A `cf` that does not hand over its
token fails there, at the
[Cloudflare access check](./troubleshooting.md#val-cli-007-cloudflare-access--cloudflare-access-is-blocked),
and not in the middle of a deploy. `eden destroy` stops with
[`EVE_CF_LOGIN_TOKEN_UNAVAILABLE`](./troubleshooting.md#eve_cf_login_token_unavailable)
and deletes nothing.

What to know about this way of getting the token:

- It relies on behavior Cloudflare does not document as a contract: that
  `cf` honors `CLOUDFLARE_API_BASE_URL` and sends its login's token to that
  address. Eden runs only the `cf` version it pins, and a `cf` that stops
  doing this makes Eden stop, not guess.
- Setting `CLOUDFLARE_API_TOKEN` avoids it: Eden then asks `cf` for
  nothing.
- Compared with Eden 0.14: that version read Wrangler's OAuth token from a
  plain file in your home folder and sent it to `api.cloudflare.com` for
  the same reads. Any program running as you could read that file at any
  time. This version reads no token file. For the length of one
  `cf auth whoami` the token crosses the loopback interface as an HTTP
  header, not encrypted.
- A program running as you can still get the token, now by running the same
  `cf` command itself. The listener's port and random path are in that one
  `cf` process's environment, not in its command line. Who can read a
  process's environment depends on your system: a program running as you
  usually can, and an administrator can. An administrator can also capture
  loopback traffic. Eden does not protect the token from either.
- The checks on the request (path, method, user agent) decide which request
  Eden takes a token from. They do not prove which program sent it. A
  program that sends the listener a request gets `401` and gives Eden
  nothing it would use as a token unless it knows the random path.

Every `cf` command runs in a fresh, private temporary folder that Eden
creates outside the project and deletes afterwards. The folder holds an
empty `cloudflare.config.ts` and the files that one command needs, nothing
else. `cf` gets a fixed list of your shell's variables (see the
[reference](./reference.md#variables-eden-reads)), and
`CLOUDFLARE_API_BASE_URL` is always `https://api.cloudflare.com/client/v4`.
The one exception is the `cf auth whoami` described above, which gets
Eden's own listener as that address and changes nothing on Cloudflare.
So a project's `cloudflare.config.ts` or `.env` file cannot choose the
account or the token.

Eden names the `cf` login in every command: the profile in
`CLOUDFLARE_AUTH_PROFILE`, else `default`. A folder's `cf auth activate`
binding never chooses another. To check the login Eden reads, add the
profile: `npx cf@1.0.0-rc.2 auth whoami --profile default`. Eden's
remediations print the command with the profile. `CLOUDFLARE_AUTH_USE_KEYRING`
is passed to `cf`, so `cf` looks for the login where you told it to keep it.

When a publish that carried runtime values fails, `worker/cf-deploy.log`
keeps nothing that `cf deploy` printed, because `cf` can print a value
whole, wrapped over two lines, or escaped. It keeps `cf`'s exit code and a
sentence of Eden's own that says which known `cf` message was seen, if any.
What `cf` printed for the commands Eden ran afterwards to finish the
publish is kept; those commands are not given the values. The image
push is not given the values, but `cf` hands Docker a registry password for
it, and Docker's output can repeat what it was given. So Eden shows and
keeps nothing `cf` or Docker printed during the push, as for the publish:
the failure message holds `cf`'s exit code and which of a fixed set of
known `cf` messages was seen.

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
| `auth whoami` against Eden's own listener | preflight, deploy, destroy, when `CLOUDFLARE_API_TOKEN` is not set | The login's own; see [How Eden reads Cloudflare's API](#how-eden-reads-cloudflares-api) |
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
  as absent only on the API's own answer: status `404`, `success` false, a
  null `result`, exactly one error with the expected code (`10007` for a
  Worker, `1609` for a Container application), and no message beside it.
  For a Worker, both the read of its deployments and the read of the Worker
  itself must give that answer. Anything else is unknown, never absent: a
  redirect, a partial answer, a body that names a field twice, a code in
  `messages`, or no answer. A Container application list counts only as a
  whole answer with status `200`, `success` true and no errors, read to its
  last page within twenty pages, with counts that match its entries.
  Each read asks `cf` for the account once and runs every other command on
  that account, and destroy reads nothing from an account other than the
  recorded one. `cf` runs destroy's Worker, Container application, and
  image deletes with `CLOUDFLARE_ACCOUNT_ID` set to the recorded account, so
  a login that changes mid-run cannot move a delete to another account. Eden removes only that target and
  checks its registry repositories for anything other than
  [objects Cloudflare keeps](./troubleshooting.md#eve_registry_objects_kept).
  It never deletes by name prefix.
- **A Container application left without its Worker is deleted only when
  it has the recorded ID.** While the Worker exists, destroy proves the
  Container application by the namespace the Worker binds. Once Cloudflare's
  API says the Worker does not exist, there is nothing on Cloudflare left to
  compare the application with. So a deploy writes the application's ID
  into the deployment record once it has read the release in service and
  its Container application together, and destroy deletes an application
  without its Worker only when Cloudflare lists it under that ID. Another
  application of the same name stops destroy with
  `EVE_DESTROY_OWNERSHIP_UNPROVEN`, and nothing is deleted. A record Eden
  wrote before it had read the ID holds `null`. That, and a field that is
  not one ID, stop destroy the same way: such a record is not treated as
  an old one.
  **Records without the field:** a record written by Eden `0.15.0` or
  older has no `containerApplicationId` at all. For such a target destroy
  still deletes the one application of the recorded name in the recorded
  account, whoever created it, until a deploy by a newer Eden writes the
  ID. A deploy by Eden `0.15.0` or older over a newer target promotes such
  a record again; going back is not supported.
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
  sweep of that deploy. `eden deploy` and `eden destroy` take one lock per
  name in the project's `.eden` folder, the same lock for both
  environments, which stops two runs from the same folder only. It does not stop a copy of the project on another machine, or any
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

## Telemetry

Eden sends one anonymous usage event when `eden preflight`, `eden deploy`,
or `eden destroy` ends. It is on by default. `EDEN_TELEMETRY=0` (or
`false`, or `off`) or `DO_NOT_TRACK=1` turns it off; then Eden sends
nothing and creates no install ID. `DO_NOT_TRACK=1` also reaches `cf`,
which has telemetry of its own.

The event has exactly these fields:

| Field | What it holds |
| --- | --- |
| `schema` | `1`, the version of this event shape |
| `installId` | A random UUID made the first time Eden sends, kept in `$XDG_CONFIG_HOME/eden/telemetry.json` (`~/.config/eden/telemetry.json` when `XDG_CONFIG_HOME` is unset or not an absolute path). It is not derived from anything, but it stays the same, so it links the events from one machine. Delete the file to get a new one |
| `command` | `preflight`, `deploy`, or `destroy` |
| `edenVersion` | The Eden version, such as `0.15.2` |
| `exitCode` | `0` or `1` |
| `failureCode` | One of Eden's own failure codes, such as `EVE_PREFLIGHT_FAILED`, from a fixed list the collector shares; `other` for any other code; `null` when the command succeeded |
| `duration` | One of `<10s`, `10s-1m`, `1m-5m`, `5m-15m`, `15m-1h`, `>1h` |
| `os` | `darwin`, `linux`, `win32`, or `other` |
| `arch` | `arm64`, `x64`, or `other` |
| `nodeMajor` | The major version of Node, such as `24` |
| `eveVersion` | The Eve version the command itself resolved, as the project declares it: from the build for preflight and deploy, from the deployment record for destroy, such as `1.3.0` or `1.0.0-rc.7`. It is sent only when it is a plain release, or a prerelease labeled `alpha`, `beta`, `rc`, `canary`, `next`, or `preview`, with numbers of at most three digits. Any other version, and a command that stopped before resolving one, sends `other` |
| `world` | `cloudflare`, `postgres`, `local`, or `other`: the World the preflight or deploy build selected. `other` for any other World, for destroy, and for a command that stopped before the build |
| `ci` | `true` when one of `CI`, `CONTINUOUS_INTEGRATION`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `CIRCLECI`, `TRAVIS`, `JENKINS_URL`, `TEAMCITY_VERSION`, `TF_BUILD`, `BITBUCKET_BUILD_NUMBER`, or `CODEBUILD_BUILD_ID` is set to anything but an empty value, `0`, or `false`. No value is sent |

Eden never sends project, target, or Worker names, Cloudflare account or
user IDs, emails, URLs, file paths, hostnames, the values of environment
variables, error messages, or anything from the env file or secrets. It does
not hash any of these and send the hash instead: they are not sent at all.

Where it goes: an HTTPS `POST` to
`https://telemetry.eden.ideaplexa.com/v1/events`, or to
`EDEN_TELEMETRY_URL` when you set it. The collector is the Worker in
[`telemetry/`](../telemetry). It answers `4xx` to anything but a JSON
`POST` of this exact shape, serialized exactly as the CLI does, up to 1 KB.
It checks the same version pattern, enums, and list of failure codes as the
CLI. It writes accepted events to the
`eden_telemetry` Workers Analytics Engine dataset on the maintainer's
Cloudflare account, which keeps data for three months. It does not store or
log the IP address, headers, or user agent, and its Workers Logs are off.
Cloudflare receives the request as it does any request to a Cloudflare site.

What a user sees: a three-line notice on stderr the first time Eden sends,
and nothing after that. Only the run that creates the install ID prints it.
Eden never writes telemetry to stdout, and a closed stderr does not change
the exit code. Telemetry reads no project file: the Eve version and World
are what the command already resolved, sent as the project declares them
when they match the pattern above. DNS, the connection, TLS, and the request
end within one second of the command's end; then Eden cancels the DNS query
and closes the socket, so nothing network-related keeps the process running.
A send is tried once, is never queued on disk, and is dropped silently if it
fails. It never changes the exit code.

The only file telemetry reads or writes is `telemetry.json` with the install
ID, and it reads it only when it is a small regular file. Eden creates
it without overwriting anything: it writes a new file next to it and links it
into place, which fails if `telemetry.json` already exists. It never writes
through a symbolic link. When `telemetry.json` or the `eden` folder is a
symbolic link, unreadable, unwritable, or not a valid Eden file, Eden skips
telemetry for that run and changes nothing.

The collector cannot tell an Eden install from anyone else posting the same
shape, so its counts are not authenticated.

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

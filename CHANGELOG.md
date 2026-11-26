# Changelog

## Unreleased

### Added

- Anonymous usage telemetry, on by default. When `eden preflight`,
  `eden deploy`, or `eden destroy` ends, Eden sends one event: the command,
  its exit code and failure code, a duration bucket, the OS, CPU
  architecture, Node major version, Eden version, the project's Eve version
  and World kind, whether it runs in CI, and a random install ID. It never
  sends names, account IDs, paths, URLs, error messages, or secrets. The
  first send prints a notice on stderr. `EDEN_TELEMETRY=0` or
  `DO_NOT_TRACK=1` turns it off; then nothing is sent and no install ID is
  created. A send waits at most one second and never changes the exit code
  or the output. The README's Telemetry section lists every field.

### Changed

- Eve `1.5.0` with `@workflow/world-postgres` `5.5.0` is now the latest
  tested pair. Neither needs a change in Eden or in the Cloudflare World.
  With the Postgres World, move to `5.5.0` together with Eve `1.5.0`: it adds
  a migration, and `eden deploy` runs the World's `bootstrap` before it
  publishes. The gate passed both legs on both fixtures.

## 0.15.2 — 2026-11-23

Three fixes to the runtime on Cloudflare during an update, and Eve `1.3.0`
as the latest tested Eve. Only `@moinulmoin/eden-runtime-cloudflare`
changed. `@moinulmoin/eden` `0.15.2` has the same code as `0.15.1` and
depends on the new runtime; update it. `@moinulmoin/eden-world-cloudflare`
`0.15.2` has the same code as `0.15.1`.

The full live check passed on Cloudflare at the commit this release was cut
from, through the `cf` OAuth login: a fresh deploy with `cf deploy`
interrupted on purpose, a same-version update, an upgrade from Eve `0.91.0`
to `1.3.0`, a sleep and wake, and a destroy. That run does not reach the
three runtime fixes below. The record is in
`docs/eve-compatibility-history.md`.

### Upgrading from 0.15.1

- No action is needed.
- The runtime fixes hold from the second deploy made with `0.15.2`. During
  the first one, the release it replaces still runs the older runtime.

### Changed

- A request that arrives during an update is no longer answered by the
  replaced image. Eden waits 10 seconds for the old container to stop. When
  it was still running after that, Eden served the request from it and
  reported the new release as started. The request now gets `503` with
  `Retry-After: 5`, and the next request asks the container to stop again.
- With the Cloudflare World, a queued step is no longer run on the replaced
  image after a deploy. Cloudflare can run the World object on the new
  release while a Container object is still on the old one. That object ran
  the step on the old image, and stopped a container the new release had
  already started to do it. It now runs nothing, the step stays queued, and
  the World object sends it again. This holds from the second deploy made
  with this version: both objects need it.
- A Container object that wakes on the replaced release no longer stops a
  running container of a version the new release made. It read the missing
  route as a retired version. It now stops nothing on wake; a retired
  container is stopped only when the World object orders its retirement.
- The live Cloudflare check reaches none of these three changes. They are
  shown by tests with stand-ins for Cloudflare.
- Eve `1.3.0` is now the latest tested Eve, with `@workflow/world-postgres`
  `5.4.1` and the Cloudflare World. Eden, the project, and both Worlds need
  no change for Eve `1.2.0` or `1.3.0`. `@workflow/world-postgres` `5.4.1`
  adds no migration and needs no change in Eden; the compatibility gate
  passed with it. Eve `0.91.0` stays the oldest supported version. Eve
  `1.1.0` and `1.2.0` still deploy, but the compatibility gate no longer
  tests them. The full live check passed on Cloudflare with an upgrade
  from Eve `0.91.0` to `1.2.0`, and again to `1.3.0`: the session started
  on `0.91.0` answered on `1.3.0` with its history and files. Eve `1.3.0`'s
  fix for sessions started before Eve `1.0` does not apply on the
  Cloudflare World, which declares deployment affinity. The records are in
  `docs/eve-compatibility-history.md`.

## 0.15.1 — 2026-11-21

Fixes to names, locks, and `eden destroy`, and clearer messages for two
failures. Only `@moinulmoin/eden` changed; update it.
`@moinulmoin/eden-runtime-cloudflare` and
`@moinulmoin/eden-world-cloudflare` `0.15.1` have the same code as
`0.15.0`.

The full live check passed on Cloudflare at the commit this release was cut
from, through the `cf` OAuth login: a fresh deploy with `cf deploy`
interrupted on purpose, a same-version update, an upgrade from Eve `0.91.0`
to `1.1.0`, a sleep and wake, and a destroy. That run does not reach the
new refusals: it runs one command at a time, uses a short name, and
destroys a target whose Worker exists. The record is in
`docs/eve-compatibility-history.md`.

### Upgrading from 0.15.0

- No action is needed.
- A target deployed by `0.15.0` or older keeps name-only cleanup of a
  leftover Container application until its next deploy. That deploy writes
  the application's ID into the record, and from then on `eden destroy`
  deletes a Container application left without its Worker only under that
  ID.

### Changed

- One name is now locked in both environments. `--env preview` and
  `--env production` with the same `--name` are the same Worker, and until
  now two runs from one project folder, one in each environment, could
  publish or delete it at the same time. The second run now stops with
  `EVE_DEPLOY_BUSY` before it reads or changes anything. The lock file moved
  from `.eden/eve-deploy/locks/<environment>-<name>.lock` to
  `.eden/eve-deploy/locks/<name>.lock`; Eden no longer reads a lock file
  with the old name.
- `preflight` and `deploy` now refuse a `--name` whose Container application
  would be the one another name gets, with `EVE_NAME_CONTAINER_SHARED`,
  before anything is read or changed on Cloudflare. Eden cuts
  `<name>-container` to 63 characters, so a 53-character name and the
  63-character name made of it plus `-container` both got the same
  Container application, and `eden destroy` of one could delete the
  other's. Only a 62-character name that ends in `-container`, or a
  63-character name that ends in `-container` or a cut of it from `-c` to
  `-containe`, is refused. A derived default name is never one of these,
  and `eden destroy` still accepts them.
- When Eden finishes a publish that `cf deploy` left half done, the two
  minutes it gives the triggers now also end the read of the release in
  service that comes before each try. Until now only that read's own time
  limit and the publish's 15-minute deadline ended it. No trigger was
  deployed after the two minutes before this change either.
- `VAL-HOST-006` now says what to do. When Cloudflare's API answers that
  the account has no `workers.dev` subdomain, the check names the account
  and the dashboard page where one is registered. When the subdomain could
  not be read, it says so and names the `cf auth whoami` command to run.
  Until now both cases got one message whose remediation told the user to
  "return" an account ID and a subdomain. The no-subdomain answer is the one
  `cf` `1.0.0-rc.2` reads; no account without a subdomain was available to
  test it on Cloudflare.
- A failed image push now says how it failed. The `DEPLOY_INDETERMINATE`
  message tells apart a push Eden stopped after ten minutes, a
  `docker login` that failed, a `docker tag` or `docker push` that failed
  after the login, and any other `cf containers push` failure, with `cf`'s
  exit code. Until now every one of these read `The exact Cloudflare
  Container image push did not complete.` Nothing `cf` or Docker printed
  is shown or kept.
- A push that runs past Eden's ten minutes, or that Ctrl-C interrupts, can
  go on after `eden deploy` has ended: Eden stops `cf`, and `cf`
  `1.0.0-rc.2` runs `docker push` as a process of its own. With the pinned
  `cf` and a stand-in `docker` the push finished three seconds after Eden
  had returned. Eden's behavior is unchanged, and it now says so: the
  message says the Docker push may still be running and may still finish,
  and the remediation gives the `ps` command that shows it and says to run
  `eden deploy` again afterwards. After Ctrl-C the same text is printed on
  standard error. `docs/troubleshooting.md` says what happens to an image
  such a push leaves.
- `eden destroy` no longer deletes a Container application by its name
  alone when the Worker is gone. A deploy now writes the Container
  application's ID into `deployment.json` as
  `identity.containerApplicationId`, once it has read the release in
  service and the application together; before that the field is `null`.
  When Cloudflare says the Worker does not exist and lists a Container
  application of the target's name, destroy deletes it only under the
  recorded ID. With another ID, a `null`, or a field that is not one ID,
  destroy stops with `EVE_DESTROY_OWNERSHIP_UNPROVEN`, deletes nothing, and
  says where to look. Until now it deleted that application and reported
  `destroyed`. Only a record written by `0.15.0` or older, which has no
  such field, keeps the old behavior until a deploy by a newer Eden. A
  first deploy left half published is still destroyed while its Worker
  exists.
- Eve `1.1.0` with `@workflow/world-postgres` `5.4.0` is the latest tested
  pair, in place of `5.3.0`. The compatibility gate passed with it. Eden did
  not change. `5.4.0` adds migration `0032`, one new column on the runs
  table; `eden deploy` runs the World's `bootstrap` before it publishes, so
  a project that moves from `5.3.0` needs only the new version and a
  deploy. No deploy to Cloudflare with the Postgres World was run.

## 0.15.0 — 2026-11-20

Eden now runs Cloudflare's `cf` CLI, pinned to `1.0.0-rc.2`, instead of
Wrangler, and Eve `1.1.0` is the latest tested Eve. A publish that
`cf deploy` leaves half done is finished by Eden, and `eden destroy`
removes a first deploy that was only half published. Update
`@moinulmoin/eden`.

The full live check passed on Cloudflare at the commit this release was cut
from, through the `cf` OAuth login: a fresh deploy with `cf deploy`
interrupted on purpose, a same-version update, an upgrade from Eve `0.91.0`
to `1.1.0`, a sleep and wake, and a destroy. The record is in
`docs/eve-compatibility-history.md`.

### Upgrading from 0.14.0

- Eden needs Node `^24.22.0 || ^26.12.0`: `24.22` or newer in the 24
  line, or `26.12` or newer in the 26 line. On any other Node, `preflight`,
  `deploy`, and `destroy` stop with `EVE_NODE_UNSUPPORTED`.
- `cf` does not read the Wrangler login. Run
  `npx cf@1.0.0-rc.2 auth login` once, unless `CLOUDFLARE_API_TOKEN` is
  set. Until then `preflight` and `deploy` stop with
  `VAL-CLI-007-CLOUDFLARE-ACCESS`.
- No project change is needed, for Eve `1.1.0` or for `cf`. The `.eden/`
  folder and deployed targets need no change.
- Going back is not supported. Eden `0.14.0` run against a target that
  this version deployed exits 1 with `DEPLOY_INDETERMINATE`, and the live
  deployment keeps answering.

### Changed

- **Eden runs Cloudflare's `cf` CLI instead of Wrangler.** `cf`
  `1.0.0-rc.2`, a release candidate, is pinned exactly and installed with
  Eden. Wrangler is no longer a dependency. `cf` does not read the Wrangler
  login, so after upgrading run `npx cf@1.0.0-rc.2 auth login` once, or set
  `CLOUDFLARE_API_TOKEN`. Until then `preflight` and `deploy` stop with
  `VAL-CLI-007-CLOUDFLARE-ACCESS`, and its remediation says so when this
  machine has a Wrangler login. Eden no longer reads any token from
  disk, and `WRANGLER_HOME` is no longer used for credentials. Every `cf`
  command runs in a private temporary folder with a fixed environment and
  the checked account, so a project's `cloudflare.config.ts` or `.env`
  cannot choose the account or the token.
- **Eden needs Node `^24.22.0 || ^26.12.0`**, the lines `cf` declares from
  24 up. On any other Node, `preflight`, `deploy`, and `destroy` stop with
  the new code `EVE_NODE_UNSUPPORTED`. The builder image is unchanged.
- **Eden names the `cf` login profile in every command**
  (`CLOUDFLARE_AUTH_PROFILE`, else `default`), and its remediations print
  `--profile`. `CLOUDFLARE_AUTH_USE_KEYRING` reaches `cf`. Ctrl-C and
  `SIGTERM` remove the temporary folder that holds the secrets file.
- **A missing or different `cf` stops with `EVE_CF_UNAVAILABLE`** and says
  to install Eden again. `eden --help` works without `cf`.
- **`VAL-CLI-007-CLOUDFLARE-ACCESS` tells three cases apart**: a signed-out
  `cf`, a `CLOUDFLARE_API_TOKEN` that Cloudflare does not accept or that
  sees no account, and a `CLOUDFLARE_ACCOUNT_ID` the login does not have.
  For the last two, signing in again changes nothing, and the remediation
  says so.
- **Eden finishes a publish that `cf deploy` left half done.** When
  `cf deploy` exits with an error after Cloudflare has the new Worker
  version, Eden creates the missing Container application and deploys the
  triggers itself, and never runs `cf deploy` a second time. Before, such
  a deploy ended `DEPLOY_INDETERMINATE` and Eden stopped. If Eden cannot
  finish, the deploy still ends `DEPLOY_INDETERMINATE`, and running
  `eden deploy` again sets up what is missing. Cloudflare can take a while
  to show a version it just accepted, so Eden repeats its read for up to
  two minutes. What `cf` printed is kept in `worker/cf-deploy.log` in the
  generation folder; when the publish carried runtime values, only
  `cf deploy`'s exit code and a sentence of Eden's own are kept for it. Eden finishes only the version Cloudflare serves, with
  one binding for the Container class, and only a Container application
  whose ID is the binding's namespace and whose name, policy and namespace
  all match; otherwise it writes nothing more. It reads the release in
  service again right before each write.
- **A publish counts only when the release and its Container application
  agree.** After every publish Eden reads the release in service and the
  target's one Container application together, for up to two minutes. If
  they do not match, the deploy ends `DEPLOY_INDETERMINATE` with
  `Cloudflare did not show this release in service together with its one
  Container application after publication.` and the last promoted deploy
  stays current.
- **A publish has one deadline of 15 minutes.** It runs from the start of
  `cf deploy` to the end of the last read that confirms the publish. Every
  `cf` command, every read, every wait, and taking the token of the `cf`
  login get what is left of it, and Eden starts no command after it. Before, each step had its own limit, and a slow read
  could be followed by another write.
- **`eden destroy` stops when Cloudflare's reads of the Worker disagree.**
  A Worker that one read shows deployed and the next shows with no
  deployment is not proven, and nothing is deleted.
- **Eden reads Cloudflare's API itself, with the token of the `cf` login.**
  Whether a Worker or a Container application exists, is absent, or is
  Eden's own is decided from the API's own answers, as in 0.14, and never
  from what `cf` prints. The reads are `GET` requests to
  `api.cloudflare.com`. With `CLOUDFLARE_API_TOKEN` set Eden sends that
  token. Otherwise it takes the login's token from `cf`: it runs
  `cf auth whoami` against a listener of its own on `127.0.0.1`, keeps
  the token in memory for that command, and writes it nowhere. The
  listener answers every request itself and keeps its port until `cf` has
  exited. This relies
  on `cf` behavior Cloudflare does not document as a contract;
  `docs/security.md` describes it and compares it with 0.14. When `cf`
  hands over no token, `preflight` and `deploy` stop at
  `VAL-CLI-007-CLOUDFLARE-ACCESS` and `destroy` stops with the new code
  `EVE_CF_LOGIN_TOKEN_UNAVAILABLE`.
- **`eden destroy` calls a Worker absent only when two reads agree.**
  Cloudflare's deployments read and its Worker read can disagree for a
  while after a Worker is created or deleted. Both must answer that the
  Worker does not exist. A Container application list with a count or total
  that does not match its entries, a full page that gives no total, or a
  list that runs past twenty pages, is no proof of absence. `eden deploy`
  stops before it publishes when the account has two Container applications
  of the target's name.
- **`eden destroy` removes a first deploy that was only half published.**
  A Worker whose first publish stopped before its Container application
  existed is proven from the Worker version in service and the failed
  attempt's record. The remediation of `EVE_DESTROY_OWNERSHIP_UNPROVEN`
  changed with it.
- **Runtime variables are uploaded with the Worker version.** The values
  from `--env-file` are no longer set one by one before the publish. They
  are uploaded as secrets in the same publish as the code, so both change
  together and a first deploy needs no Worker beforehand. Secrets the file
  does not name stay.
- The `workers.dev` subdomain is read from Cloudflare's API, as in 0.14,
  so a first deploy on an account with no Worker needs nothing more. The
  message of `EVE_DEPLOY_CHECKS_FAILED` now ends `nothing was published for
  this target`.
- The generation folder holds a Build Output
  (`worker/.cloudflare/output/v1/`) instead of `worker/worker.ts` and
  `worker/wrangler.jsonc`.
- `pnpm run check:live` uses `cf`, interrupts its first `cf deploy` on
  purpose to check that Eden finishes it, and no longer records a tail.
- Eve `1.1.0` is now the latest tested Eve, with `@workflow/world-postgres`
  `5.3.0` and the Cloudflare World. Eden, the project, and both Worlds need
  no change for it. Eve `0.91.0` stays the oldest supported version. Eve
  `1.0.2` still deploys, but the compatibility gate no longer tests it. The
  full live check passed on Cloudflare with an upgrade from Eve `0.91.0` to
  `1.1.0`; the record is in `docs/eve-compatibility-history.md`.

## 0.14.0 — 2026-11-20

`eden destroy` now clears a target's record only on Cloudflare's own
unambiguous answer, read from the recorded account, and every Wrangler
command after the access check runs in the checked account. Each pushed image
gets its own tag, so a same-version update no longer leaves an image that the
registry cannot remove. A publish that stops halfway has its own message and
recovery, requests around a deploy's version switch no longer get HTTP 500
from version skew, and image builds work with a `docker-container` builder.
Update `@moinulmoin/eden`. `@moinulmoin/eden-world-cloudflare` `0.14.0` has
the same code as `0.13.0`.

The full live check passed on Cloudflare at the commit this release was cut
from: a fresh deploy, a same-version update, an upgrade from Eve `0.91.0` to
`1.0.2`, a sleep and wake, and a destroy. That run sent no requests while a
deploy switched versions, so it does not test the version-switch fixes.
Those were measured in a separate run on 2026-11-20, on the branch of the
fix. Both records are in `docs/eve-compatibility-history.md`.

### Upgrading from 0.13.0

- No project change is needed, and the deployment record's format did not
  change. A target deployed with `0.13.x` updates and destroys with this
  version.
- The first same-version update of such a target leaves the image it
  replaced in the registry under the tag `candidate`, and `VAL-LIFE-007` is
  `skipped`. `eden destroy`, or the retirement of that Eve version after an
  upgrade, removes it. Images that `0.13.x` had already left without a tag
  stay, and `eden destroy` still reports them as `accepted-still-listed`.
- The first Eve upgrade of such a target can still answer new sessions with
  Eve's `500` ("Failed to create the session") after `eden deploy` reported
  it healthy, until Cloudflare moves the World object. That took 2 minutes
  20 seconds when measured.
- Around a deploy's version switch a request can now get `503` with
  `Retry-After`. A POST, PUT, PATCH or DELETE that got it may have run, so
  check its outcome before sending it again. Cloudflare's own Durable Object
  errors can still return error 1101.
- `eden destroy` now stops with `EVE_DESTROY_INDETERMINATE`,
  `EVE_DESTROY_POINTER_UNCLEARED`, or `EVE_DESTROY_RECORD_UNPROVEN` in
  cases where it used to go on. Each is in `docs/troubleshooting.md`.
- `EDEN_EVE_PREVIOUS_RELEASE_ID` is now a reserved name in an environment
  file.
- Eden's read of the Worker uses a proxy only when `NODE_USE_ENV_PROXY=1`
  is set; with `HTTPS_PROXY` alone it goes direct.

### Fixed

- **`eden destroy` could report success while the Worker kept running.**
  Destroy read the Worker with `wrangler deployments list` and took a failed
  command as "the Worker is gone" whenever its error text contained
  `not found`, `does not exist`, or `10007`. A failure for another reason
  could match: a missing Wrangler configuration file, a proxy's
  `404 Not Found` page, or any API error on an account whose id contains
  `10007`, because Wrangler prints the account id in the error. Destroy then
  deleted the Container application and images, reported `destroyed` or
  `absent`, and left the Worker. Eden now asks Cloudflare's API for the
  Worker and takes only its answer for a missing Worker as absence: status
  `404`, `success` false, a null `result`, and one error with code `10007`.
  It follows no redirect. Any other answer about the Worker stops destroy
  with `EVE_DESTROY_INDETERMINATE` before anything is deleted.
  `eden preflight` and `eden deploy` read the Worker the same way. Eden
  reads a Container application list only from status `200` with `success`
  true, an empty `errors` list, and no field named twice. After a publish,
  each deployment the API lists must have an id. Destroy removes `CURRENT`
  only when it is the symlink that named the record.
- **Destroy could clear a `CURRENT` pointer it had not read.** If something
  outside Eden's lock replaced the pointer while destroy ran, destroy removed
  the replacement. Destroy now removes the pointer only if it is still the
  file it read at the start. Otherwise it leaves it and fails with
  `EVE_DESTROY_POINTER_UNCLEARED`.
- **Destroy followed a symlinked target directory into another project.**
  It then read that project's record and cleared that project's pointer.
  Destroy now stops with `EVE_DESTROY_RECORD_UNPROVEN`, before it reads
  Cloudflare or writes its lock, when a folder on the way to the record, or
  the generation `CURRENT` names, is not inside the project's own `.eden`
  folder. It also reads no record file that is a symlink.
- **Destroy could read the Container application from another account.**
  The Container read asked Wrangler for the account a second time. If the
  login changed in between, destroy missed a Container application in the
  recorded account and could clear the target's `CURRENT` pointer. Each read
  now asks once and sends every request to that account, and destroy reads
  nothing from an account other than the recorded one.
- **Destroy's deletes could run in another account.** Wrangler chose the
  account again for each delete. If the login changed after destroy's reads,
  Wrangler could delete a Worker with the same name in the other account.
  Destroy now gives Wrangler the recorded account for its Worker, Container
  application, and image deletes, so a delete acts on that account or fails.
- **A deploy's secret uploads and image push could run in another account.**
  Wrangler chose the account again for each `wrangler secret put` and for
  `wrangler containers push`. If the login changed after Eden checked the
  account, a runtime value could be written to a Worker in the other
  account, and `eden deploy` could still report success. Eden now gives
  Wrangler the checked account for every command it runs after
  `wrangler whoami`: the secret uploads, the image push, the publish, the
  Container application read, the registry credential request, and
  destroy's deletes. Each acts on that account or fails.
  Deploy also asked `wrangler whoami` twice, before the build and after it,
  and used the second answer. If the two named different accounts, the
  deploy went to the second. It now stops at the Cloudflare access check
  before any write. Both effects were seen with a stand-in for Cloudflare,
  not on a real account.
- **A same-version update no longer leaves an image that Cloudflare's
  registry cannot remove.** With deployment affinity, an update on the same
  Eve version pushes into the repository of the image it replaces. Eden
  pushed every image under the tag `candidate`, so the earlier image lost
  its only tag, and Cloudflare's registry does not remove an image that no
  tag names: `eden destroy` reported one `accepted-still-listed` object per
  such update. Eden now tags each pushed image with the release ID it
  generates for that deploy (`eve-deploy-<uuid>`) and, once the new
  deployment is healthy and promoted, deletes the replaced image by its
  tag. It deletes only that release tag, and only when the registry
  resolves it to the digest the deployment record names for the replaced
  image. If the delete cannot
  be shown, the deploy still succeeds with the new warning
  `EVE_SUPERSEDED_IMAGE_NOT_DELETED`. A later deploy does not try that
  image again; `eden destroy`, or the retirement of that Eve version after
  an upgrade, tries to delete everything in the repository.
  A target deployed with Eden `0.13.x` or older still updates and destroys.
  Eden never deletes `candidate` during an update: the first same-version
  update leaves the image it replaced under that tag (`VAL-LIFE-007` is
  `skipped`), and `eden destroy` or the retirement of that Eve version
  removes it. Images those versions had already left untagged stay in the
  registry, and `eden destroy` reports them as before. The deployment record's format did
  not change.
- `eden deploy` now says when Wrangler uploaded the Worker version and then
  failed at the Container application settings, instead of the general
  `DEPLOY_INDETERMINATE` message. From 2026-11-19 `22:31Z`, five deploys
  ended this way after Cloudflare answered `404` when Wrangler read the
  version it had just uploaded. Eden does not run the publish again by itself. For a
  target's first deploy the remediation names `eden destroy`: on
  2026-11-20 `eden deploy` refused such a target twice, and `eden destroy`
  cleared it on its second run. A deploy after that destroy was not run on
  that target. For a target that was deployed before, the remediation stops
  at inspection.
- `EVE_DESTROY_OWNERSHIP_UNPROVEN` now says what to do when the account is
  right but a failed deploy left a half-published Worker.
- **Requests around a deploy's version switch no longer get HTTP 500 from
  version skew.** Cloudflare does not switch a Worker and its Durable
  Objects to a new version at the same instant. On 2026-11-20 the two ran
  different releases for between half a second and 20 seconds, in either
  order, and the World object once stayed on the old release for more than
  two minutes. Four things went wrong in that window, each reproduced on
  Cloudflare with a request every 250 ms through the deploy:
  - A Worker of the old release reached a Container object already on the
    new one. The object reset itself for every such request, so that
    request, and requests from new Workers in flight, got Cloudflare's
    error 1101 page ("Worker threw exception"). The published Worker now
    names the release it replaces (`EDEN_EVE_PREVIOUS_RELEASE_ID`, read
    from the live Worker), and the object does not reset for a Worker of
    that release. With deployment affinity it serves that Worker as the
    version the Worker names: the same version after a same-version
    update, the kept old version after an Eve upgrade. Without affinity,
    or when that version is no longer routed, the answer is `503` with
    `Retry-After: 1`.
  - A Worker of the new release reached a Container object still on the
    old code. The reset brought the object back on the old code, and the
    one retry failed with error 1101, for up to 20 seconds. The Worker now
    tries again until 30 seconds after the request arrived, then answers
    `503` with `Retry-After: 5`.
  - Requests that arrived together while an update replaced the Container
    each replaced it again, and the others got error 1101 after a few
    seconds. The object now replaces the Container once.
  - After an Eve upgrade the World object could keep the old release's
    list of versions, and Eve answered `500` ("Failed to create the
    session") for the new version although `eden deploy` had reported it
    healthy. The World object now resets for a container of the release
    that replaces its own, and the container waits up to 30 seconds for
    it. The deploy's health check does not test the World object. A World
    object deployed by Eden `0.13.0` or earlier has no reset, so the
    first Eve upgrade made with this version can still show the old
    behavior until Cloudflare moves the object.

  An object now resets only for the release that names it as the one it
  replaced. A Container object answers any other release with `503` and
  `Retry-After: 5`. Eden repeats only a GET, a HEAD, or its own health
  read after a reset. A POST, PUT, PATCH or DELETE whose answer is lost
  in a reset before the response headers gets `503` with
  `Retry-After: 1` instead of error 1101. It may have run, so check its
  outcome before sending it again.
  Cloudflare's own Durable Object errors still return error 1101. The
  measurements are in `docs/eve-compatibility-history.md`. Two earlier
  failures (2026-11-18 and 2026-11-19), at least 20 seconds after a
  switch, had no log. They fit the cases above but are not proven to
  share a cause. `EDEN_EVE_PREVIOUS_RELEASE_ID` is now a reserved name in
  an environment file.
- `eden preflight` and `eden deploy` no longer fail at `VAL-BUILD-005` when
  Docker's selected builder uses the `docker-container` driver. That builder
  keeps a built image in its own cache, so Docker never received it. Eden now
  runs `docker build --load` when Docker Buildx is installed.

### Changed

- Eve `1.0.2` with `@workflow/world-postgres` `5.3.0` is the latest tested
  pair, in place of `5.2.1`. The compatibility gate passed with it. The
  published `5.3.0` package has the same files as `5.2.1` except
  `package.json`, which pins newer `@workflow/errors`, `@workflow/utils`,
  `@workflow/world`, and `@workflow/world-local`. Eden did not change, and a
  project on `5.2.1` needs no change.
- Eden reads the Worker's deployments from Cloudflare's API itself, in
  preflight, deploy, and destroy, instead of running
  `wrangler deployments list`. Like Eden's other API reads, this request
  uses a proxy only when `NODE_USE_ENV_PROXY=1` is set; with
  `HTTPS_PROXY` alone it goes direct.
- After publishing, `eden deploy` still requires the Worker to have a
  deployment. Preflight and destroy now also count a Worker script that has
  none as an existing Worker.

## 0.13.0 — 2026-11-19

Eve `1.0.2` is now a tested version, and Eve `0.91.0` stays the oldest
supported one. `eden destroy` works again on a target whose container has
slept, a first run reports its setup problems together before the build, and
three bugs in released versions are fixed. Update `@moinulmoin/eden`, and
`@moinulmoin/eden-world-cloudflare` if the project uses it.

### Added

- Eve `1.0.2` with `@workflow/world-postgres` `5.2.1` is the latest tested
  pair, in place of `1.0.0-rc.6`. A project made with `npx eve@1.0.2 init`
  and the README's fresh-project steps passed the build and boot checks of
  `eden preflight`.
- The warning `EVE_REGISTRY_OBJECTS_KEPT`, and the `--json` field
  `registryObjectsKept` with one `{ ref, class }` per object. Cloudflare's
  registry keeps three kinds of object after Eden deletes everything it
  lists, and Eden reports each one only on the registry's own answer for
  that object: a container snapshot (`refused-snapshot`, `403`), the chain
  artifact Cloudflare makes for each pushed image
  (`refused-singleton-artifact`, `409` with `SINGLETON_ARTIFACT_EXISTS`), and
  a manifest whose delete the registry accepted with `202` or `204` and
  which it still lists at least 30 seconds later (`accepted-still-listed`).
  A kept snapshot still holds the agent's files until Cloudflare removes it,
  which Cloudflare documents as 30 days after it was created or last
  restored. When Cloudflare removes the other two kinds is not known.
- The Cloudflare World declares `queueAuthMode: "skip"`. With the updated
  World package, Eve `1.0.2` no longer logs that the World declares no
  `queueAuthMode`. Nothing else changes: Eve never checked queue deliveries
  on this World, and Eden's Worker still answers `404` for the workflow
  queue routes.

### Changed

- `eden preflight` and `eden deploy` check the Cloudflare login before the
  build. Without a login they now stop in about 5 seconds instead of after the
  full build (299 seconds in the same test), and the remediation names the
  commands: `npx wrangler@4.147.0 login`, then `npx wrangler@4.147.0 whoami`.
- The first run reports every problem Eden can see without building, together:
  the env file, the Eve version, the sandbox module, Cloudflare access, and
  the `EVE_AUTH_SCAFFOLD`, `EVE_WORLD_LOCAL`, and `EVE_AI_GATEWAY_KEY_MISSING`
  warnings. Before, an untouched `eve init` project showed only
  `EVE_SANDBOX_PROVIDER`, and the warnings appeared after the next full build.
- Every failure now carries a `remediation`, in text and in `--json`,
  including the argument, lock, promotion, image, and destroy codes.
  `EVE_OPTION_UNKNOWN` names the unknown option.
- A failed env-file check starts with its code, for example
  `EVE_ENV_FILE_NOT_FOUND`, and a missing file says to create it or correct
  the path. A failed env file no longer adds four `blocked` filler checks.
- `eden destroy` ends with `destroyed` when the objects Cloudflare's registry
  keeps are all that is left, and adds `EVE_REGISTRY_OBJECTS_KEPT`; with
  `--json` it adds `warnings` and `registryObjectsKept`. Anything else left
  behind, any other answer, and a final listing that cannot be read in full
  still fail with `EVE_DESTROY_IMAGES_RETAINED`. Destroy clears the target's
  `CURRENT` pointer only after a final listing that it read in full.
- `eden deploy` cleans up a superseded version's registry repository the
  same way: `VAL-LIFE-007` passes, and the result adds
  `EVE_REGISTRY_OBJECTS_KEPT` and `registryObjectsKept`. When something
  else is left as well, `VAL-LIFE-007` fails and the result still lists the
  objects the registry kept. Deploy deletes nothing from a repository that
  holds an image that is still deployed: the check is `skipped` when the
  promoted image is in the superseded repository, and a retirement stays
  pending when a kept version's image is in the retiring one.
- Eden's registry requests never use a proxy, and requests that get no
  answer may take 60 seconds in total. Where this machine cannot reach
  `registry.cloudflare.com` directly, destroy cannot read the listing: it
  deletes the Worker and the Container application and fails with
  `EVE_DESTROY_IMAGES_RETAINED`, whose remediation says to rerun from a
  machine that can.
- The remediations of a failed `VAL-LIFE-007` and of
  `EVE_RUNTIME_IMAGE_CLEANUP_FAILED` name what the registry still lists,
  tags and `sha256:` entries, instead of tags only.
- When Eve exits during the local boot check, `EVE_HEALTH_FAILED` says so,
  with Eve's exit code and its last output (env-file values redacted).
  Before, it reported a missed health deadline with no cause, and a crash
  right after start could be reported as `DOCKER_PLATFORM_BLOCKED`.
- `DOCKER_PLATFORM_BLOCKED` now ends with the underlying error, usually
  Docker's own, and its remediation says to fix that error. Before, the
  echoed command line could use up the message and cut the error off.
- The check of native modules runs the system `file` tool with the same
  minimal environment as Docker. Before, `file` received every variable of
  the shell that started Eden. No env-file value was involved.

### Fixed

- **`eden destroy` failed on every retry with `EVE_DESTROY_IMAGES_RETAINED`
  on a target that has container snapshots.** On 2026-11-18 Cloudflare's
  registry was observed refusing to delete snapshot tags, so destroy, in
  `0.12.0` and earlier, removed everything else and then failed. Destroy now
  reports those tags in `EVE_REGISTRY_OBJECTS_KEPT` and succeeds.
- **`eden destroy` left untagged registry entries behind without saying
  so.** The registry lists one entry for each manifest, with or without a
  tag, and `wrangler containers images list` does not show the untagged
  ones. Destroy now reads the registry's own listing, asks Wrangler to
  delete every tag, and deletes every other entry by digest with a request
  of its own. An entry that appears while it runs gets its own delete, for
  at most three passes over a repository. A listing page that is not
  exactly in the form the registry was seen to send is unreadable, never
  empty.
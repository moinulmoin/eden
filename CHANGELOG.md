# Changelog

## Unreleased

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
- Eve `1.2.0` is now the latest tested Eve, with `@workflow/world-postgres`
  `5.4.0` and the Cloudflare World. Eden, the project, and both Worlds need
  no change for it. Eve `0.91.0` stays the oldest supported version. Eve
  `1.1.0` still deploys, but the compatibility gate no longer tests it.

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
- **`eden deploy` and `eden destroy` could not read the deployment record
  after one kind of update, in `0.11.2` through `0.12.0`.** An update that
  kept the Eve version and retired a kept version whose World had no RPC
  authentication gave the new version an id with an extra suffix, and Eden
  could not read its own record back: the next `eden deploy` failed with
  `VAL-CLI-007-TARGET-CONFLICT` and `eden destroy` failed with
  `EVE_DESTROY_RECORD_UNPROVEN`. Records already written that way are read
  as they are, so update Eden and rerun the command.
- **`eden deploy` gave the image push 120 seconds.** It now waits ten
  minutes, as the Worker publication after it already did. On 2026-11-18
  Cloudflare's registry was slow, the push of a new image took longer than
  two minutes, and two deploys in a row ended with `DEPLOY_INDETERMINATE`
  and `The exact Cloudflare Container image push did not complete.`
- **Two Eden builds on one Docker host clashed on local port 4310.** Both
  picked it for the boot check; the second failed with
  `DOCKER_PLATFORM_BLOCKED` and left a boot container in state `Created`.
  Docker now picks a free port, and the boot container is removed on every
  failure.
- The `EVE_DESTROY_IMAGES_RETAINED` remediation said a rerun of
  `eden destroy` "clears the record". A rerun that finds nothing left
  reports `absent` and leaves the `CURRENT` pointer. The remediation and
  `docs/troubleshooting.md` now say so, and that nothing more is needed.
- A deploy whose retirement of old versions was not proven said "Retry
  deploy" in `VAL-LIFE-007` and "do not retry the deployment" in its summary
  and error. The check and the error now say the same: do not redeploy for
  this; a later successful deploy retries cleanup for versions still
  pending retirement.
- `eden destroy --json` includes `"command": "eden destroy"`, like preflight
  and deploy.

### Removed

- `EVE_HEALTH_PORT_UNAVAILABLE`. Eden no longer picks the boot-check port,
  so nothing reports it.

### Docs

- The README's Quick start and fresh-project steps match the skill: start
  from `npx eve@1.0.2 init`, then sandbox, channel auth, Workflow World, env
  file with the model key, then preflight.
- The README, the skill, and `docs/deploy.md` say not to commit `.eden/`, to
  add it to `.gitignore`, and that updates and `destroy` need the `.eden/`
  folder the deploy wrote. `docs/troubleshooting.md` has a new entry, "The
  `.eden/` folder is lost", with the manual removal steps for the Worker,
  Container application, and registry objects.
- `docs/troubleshooting.md` explains `node: <path>: not found` (exit 9): with
  `npx`, a missing `--env-file` path stops npm's own Node process before
  Eden starts. It names the placement that lets Eden report the mistake
  itself, `npx -- @moinulmoin/eden …`, and says that a `NODE_OPTIONS` line in
  the env file is applied to npm's own Node process. That process does not
  load the file's other values.
- `docs/deploy.md` and `docs/troubleshooting.md` name the Postgres World
  release for Eve `1.0.2`. `docs/eve-compatibility.md` explains the Node.js
  `26.x` pin in new Eve projects.
- `PRODUCT.md` is removed. It described Eve `0.66.3`, pnpm-only projects,
  and a 1 GiB container. The README and `docs/` hold the current facts.
- The docs were checked against the code and against each other.
  `packages/cli/README.md`, the npm page, no longer says that only pnpm
  projects are supported or that a sandbox module is not.
  `docs/troubleshooting.md` gains `EVE_OPTION_VALUE_MISSING`,
  `EVE_PROJECT_INVALID`, `VAL-BUILD-002`, `VAL-BUILD-003`,
  `HOST_ORIGIN_UNAVAILABLE`, and `HOST_REQUEST_ABORTED`, and its manual
  cleanup checks read the registry's own listing instead of
  `wrangler containers images list`, which shows tags only.
  `docs/reference.md` lists `command` and `error` in the destroy result and
  `reason` and `evidenceLocation` in a deployment result.

### Maintainers

- The live check on Cloudflare is one command, `pnpm run check:live`. It
  deploys a fresh project to a temporary target, runs bash in a session,
  updates in place, upgrades Eve, lets the container sleep and wakes it,
  requires `404` from the two workflow queue routes, asks the server process
  whether Eve logged the `queueAuthMode` warning, then destroys the target
  and reads the registry's catalog for anything destroy did not report.
  Once a deploy has started, `eden destroy` also runs when a step fails and
  on Ctrl-C; if destroy itself fails, the script prints the retry command.
  The run for this release, on 2026-11-19 from Eve `0.91.0` to `1.0.2`,
  passed all 18 steps; see `docs/eve-compatibility-history.md`.
- The live check installs the Cloudflare World packed from this repository
  by default, through the same local tarball server as the gate's Eden leg,
  so a World change can be checked on Cloudflare before it is published.
  That project uses pnpm, because Eden takes npm packages only from the
  public registry. `--world latest` or an exact version installs the
  published package into an npm project.
- The compatibility gate now tests Eden, not only Eve. For each fixture it
  also installs the Cloudflare World built from this repository, runs the
  built `eden preflight` up to the Cloudflare access checks, and requires a
  session to start in Eden's linux/amd64 image. It needs Docker and no
  Cloudflare account. The World runs as its core over local RPC, not as a
  Durable Object. With the World source from before `0.11.1`, this leg fails
  with the HTTP 500 that release fixed.
- CI runs the gate's Eden leg in one parallel job per fixture. Publish runs
  the whole gate in one step.
- The latest compatibility fixture pins Eve `1.0.2`,
  `@workflow/world-postgres` `5.2.1`, `just-bash` `3.6.1`, and `ai` `7.0.173`
  (Eve `1.0.2` needs `ai` `^7.0.172`).
- The compatibility gate waits for the Eve server to exit. Eve `1.0.2` takes
  about five seconds to stop after a session has started, and the gate
  reported that as a failed cleanup.
- Renovate waits until a release of `eve`, `@workflow/world-postgres`, or
  `just-bash` is one day old before it opens a pull request, so the
  fixture's frozen install passes pnpm's release-age check.
- `buildEveRuntimeImage` and the preflight options no longer take
  `healthPort`.
- The process-cleanup test helper retries a `ps` snapshot that fails once on
  a busy machine, instead of failing the test.

## 0.12.0 — 2026-11-08

Eden now needs Eve `0.91.0` or later, and every failure tells you, or your
coding agent, what to do next. Update `@moinulmoin/eden`.

### Changed

- `eden preflight` and `eden deploy` now require Eve `>=0.91.0` and stop
  older projects with `EVE_VERSION_UNSUPPORTED` before building. Existing
  deployments keep running, and `eden destroy` still works.
- To redeploy an older Eve project unchanged, use
  `npx @moinulmoin/eden@0.11.5 deploy` with the same `--project`, `--env`,
  `--name`, and `.eden` folder. That CLI is frozen and unmaintained.
  Upgrading Eve instead may strand existing Postgres-World sessions; see
  [session_stranded](docs/troubleshooting.md#old-sessions-return-session_stranded-after-an-eve-upgrade).
- With `--json`, every run now prints exactly one JSON object on stdout. A
  failure has `ok: false` and an `error` with `code`,
  `message`, and, where Eden knows the fix, `remediation`. Before, a failure
  after preflight printed only a text line on stderr and nothing on stdout.
- An `indeterminate` deployment now includes the reason and where Eden kept
  its evidence. A deployment that went live but whose cleanup failed is
  reported as live, not as a failed deploy.
- Without `--json`, errors now end with a `→` line naming the next step.
- JSON results now name the command `eden preflight`, `eden deploy`, or
  `eden destroy` instead of `eve preflight`, `eve deploy`, or `eve destroy`.
  Update scripts that match on `command`.

### Removed

- The temporary fix for Eve's just-bash resume bug
  ([eve#4440](https://github.com/vercel/eve/issues/4440)) and every other code
  path that only served Eve versions below `0.91.0`. Eve `0.83.0` and later
  include the upstream fix. Eden no longer changes any Eve file.

### Docs

- `docs/eve-compatibility.md` is now a short page: supported versions, the
  World each one needs, and how Eden checks them. Dated runs moved to
  `docs/eve-compatibility-history.md`.
- `docs/troubleshooting.md` covers 12 more failure codes.
- Install commands no longer pin a version.

### Maintainers

- CI and the release workflow now build and boot two pinned Eve projects
  (`0.91.0` and `1.0.0-rc.6`) on the Postgres World and require a real
  session to start. This catches an Eve and World pairing that would fail
  every session, like the one fixed in 0.11.5.
- Renovate proposes new `eve`, `@workflow/world-postgres`, and `just-bash`
  releases, including release candidates, for the newer pinned project.
- `AGENTS.md` lists what else to update when you change something, and the
  release steps.

## 0.11.5 — 2026-11-08

Update `@moinulmoin/eden`. Projects on the Postgres World with Eve
`1.0.0-rc.6` or later also need `@workflow/world-postgres` `5.1.1` or later.

### Fixed

- **Postgres World on Eve `1.0.0-rc.6` passed preflight, then every new
  session failed with HTTP 500.** Eve now refuses to start a session unless
  the World creates the session's run and its start hook together, which
  `@workflow/world-postgres` does from `5.1.1`. `eden preflight` and
  `eden deploy` now stop with `EVE_WORLD_PAIRING` and name the version to
  install, as they already did for the Cloudflare World.

### Docs

- The Postgres World recipe in `docs/deploy.md` now covers Eve `1.0.0-rc.6`
  (`@workflow/world-postgres@5.1.1`), verified live: a session ran bash,
  kept its file across an in-place update, and new sessions started.
- `docs/faq.md` lists `1.0.0-rc.6` among the tested Eve versions.

## 0.11.4 — 2026-11-07

### Fixed

- **One oversized conversation could jam Eve upgrades on the Cloudflare
  World.** When a session moved to a new Eve version and the conversation
  files went over the 1 GiB carry limit, the move retried forever: both
  versions stayed awake, the old one never retired, and after 10 versions
  deploys were refused. The move now fails once with
  `SANDBOX_EXPORT_FAILED`, the session stays on its current version with its
  files, and everything else carries on.

### Docs

- `docs/security.md` now says plainly that any request, even a rejected one,
  wakes the container and restarts its idle timer.

## 0.11.3 — 2026-11-07

Security hardening from a second review of 0.11.2. Update `@moinulmoin/eden`.

### Security

- **Env-file names that steer Docker are refused.** Values from `--env-file`
  reached the local Docker client's own environment during preflight, so a
  hostile env file could point Docker at another daemon (`DOCKER_CONFIG`) or
  load a library into it (`LD_PRELOAD`). Names starting with `DOCKER_`,
  `BUILDKIT_`, `BUILDX_`, `COMPOSE_`, `LD_`, or `DYLD_` now fail with
  `EVE_ENV_RESERVED_VARIABLE`, and Docker's own settings come only from your
  shell.
- **Wrangler can't be steered from a shared temporary folder.** Wrangler looked
  for a config file and its account cache in the parent folders of Eden's
  temporary folder, which is the shared `/tmp` on Linux. Eden now gives every
  Wrangler command an explicit config file and cache folder inside its own
  private temporary folder.
- **`destroy` no longer misses Containers past the first page.** Wrangler's JSON
  Container list returns one page, so in an account with many Containers the
  target could look absent and `destroy` cleared its record while the Container
  stayed. Eden now asks the Cloudflare API for the exact name, follows every
  page, and treats an incomplete read as indeterminate.
- **More secret files stay out of the image:** `*.env` (such as
  `production.env`), `bunfig.toml`, and the SSH keys `id_ecdsa_sk`,
  `id_ed25519_sk`, and `id_xmss`. Secret file names now match in any letter
  case.
- **The World always requires its token.** The runtime asked for the per-start
  World token only when the deployment declared it; it now requires it for
  every request, so a hand-edited or third-party configuration can't open the
  World to the sandbox.
- **npm publishing is isolated from the build.** The release workflow's build
  and tests now run in a job that cannot obtain npm publishing credentials; a
  separate job publishes the exact checked tarballs.
- **The site sends security headers** (Content-Security-Policy and friends),
  and the repository has a `SECURITY.md` for private vulnerability reports.

### Fixed

- Wrangler now receives your shell's Docker settings (`DOCKER_HOST`,
  `DOCKER_CONTEXT`, `DOCKER_CONFIG`, TLS settings), proxy settings
  (`HTTP(S)_PROXY`, `NO_PROXY`), `NODE_EXTRA_CA_CERTS`, `XDG_CONFIG_HOME`, and
  `CLOUDFLARE_ACCOUNT_ID`. Before, `wrangler containers push` ignored a
  non-default Docker daemon and failed behind a proxy.

## 0.11.2 — 2026-11-07

A security release. Update `@moinulmoin/eden`. Projects on the Cloudflare World
need `@moinulmoin/eden-world-cloudflare` 0.10.0 or later; preflight now refuses
older ones. The first deploy with this release ends sessions on kept versions
that predate World authentication (see below).

### Security

- **A project's `.env` could take over your Cloudflare login.** Wrangler reads
  `.env` and `.env.local` from the folder it runs in, and Eden ran the commands
  that change your account (uploading secrets, deleting the Worker and
  containers) from your current folder, usually the project. A `.env` that set
  `CLOUDFLARE_API_BASE_URL` sent your Wrangler login token and the secret
  values to that address; one that set `CLOUDFLARE_API_TOKEN` or
  `CLOUDFLARE_ACCOUNT_ID` sent your secrets to another account. Every Wrangler
  command now runs in an empty temporary folder Eden creates, and the
  Cloudflare API address is fixed.
- **Old Cloudflare World packages left the World open to the sandbox.** With
  `@moinulmoin/eden-world-cloudflare` older than 0.10.0, code in the agent's
  sandbox could read and change every session's workflow state (the problem
  0.10.0 fixed), and nothing warned about it. Preflight and deploy now fail
  with `EVE_WORLD_PAIRING` for those packages.
- **Kept versions without World authentication are retired.** Versions kept
  running after an Eve upgrade, including ones deployed with Eden 0.9.0 or
  earlier, stayed open to the same sandbox access until their sessions ended,
  which might be never. The next deploy removes them even with live sessions
  and warns with `EVE_UNAUTHENTICATED_VERSIONS_RETIRED`. Their sessions end: a
  message to one fails (Eve may show "Failed to send the session message."),
  and users start a new session.
- **Some env-file names let anyone in.** `EVE_DEV=1`, or `VERCEL` with
  `VERCEL_ENV=development`, switch Eve into development mode, where the
  `localDev()` channel authenticator accepts unauthenticated callers (Eve
  `0.83.0` and earlier check only these variables). Eden now rejects
  `EVE_DEV`, `VERCEL`, `VERCEL_ENV`, and `VERCEL_TARGET_ENV` in the env file
  with `EVE_ENV_RESERVED_VARIABLE`, and the container never passes them to Eve.
- **`destroy` checks the live target.** It trusted the local record alone, so
  a planted or stale record could name a foreign container application, or a
  same-name Worker that something else created later. It now requires the
  exact container name Eden derives, checks that the live Worker carries a
  release ID from Eden's records before deleting it (the deployment ID alone
  is shared by every project on the same Eve version), and stops with
  `EVE_DESTROY_INDETERMINATE` when Cloudflare can't be read instead of
  reporting the target as gone. A target whose Worker is already gone but
  whose containers or images remain is still cleaned up.
- **Preflight's local test container** listened on every network interface
  while holding the env file's values. It now listens on `127.0.0.1` only.
- **More secret files stay out of the image:** `.dev.vars`, `.dev.vars.*`,
  `.netrc`, `.git-credentials`, SSH private keys (`id_rsa`, `id_ecdsa`,
  `id_ed25519`, `id_dsa`), `*.p12`, `*.pfx`, `.aws/credentials`, `*.tfvars`,
  and `secrets.json` join `.env*`, `*.pem`, and `*.key`.
- **Release pipeline:** the installer checks after publishing now run in a
  separate job without npm publishing rights, so a compromised dependency they
  download can't publish a version. GitHub releases wait for those checks.

## 0.11.1 — 2026-11-06

Eve `1.0.0-rc.6`, which `npx eve init` installs today, couldn't start a session
on the Cloudflare World. Update both `@moinulmoin/eden` and the project's
`@moinulmoin/eden-world-cloudflare`.

### Added

- Preflight and deploy fail with `EVE_WORLD_PAIRING` when the project runs Eve
  `1.0.0-rc.6` or later on a Cloudflare World without atomic start hooks
  (`0.11.0` and earlier), instead of deploying an agent whose sessions all
  fail.

### Fixed

- On Eve `1.0.0-rc.6` and later with the Cloudflare World, every new session
  failed with HTTP 500 after a successful deploy and a clean preflight. The
  container log said "The configured Workflow world does not support atomic
  start hooks, which eve needs to start a session." Eve now claims a session's
  channel address in the same step that creates its run, and requires the
  World to do both atomically. The Cloudflare World now does, and declares
  `atomicStartHook`. It passes the 27 applicable cases of `@workflow/world`'s
  atomic start hook conformance suite; the other 5 need a half-finished
  admission, which this World can't produce because it admits a session in one
  transaction. Verified live on `1.0.0-rc.6`: a new session, bash, the new
  `edit_file` tool, an in-place update that kept the session and its files,
  and a fresh session after it. No migration step: the World creates its new
  table on its own, and runs and hooks from 0.11.0 stay as they are.

## 0.11.0 — 2026-11-05

Coding agents can now get an Eve project ready for Cloudflare on their own.
Eden ships a skill they can read, and preflight names two Vercel-only setups
that deploy fine but then fail on Cloudflare.

### Added

- `eden skill` prints the coding-agent skill for the installed CLI version:
  how to get a project ready, deploy, check it works, update, and remove it.
  `npx skills add moinulmoin/eden` installs the same skill.
- Preflight warns with `EVE_VERCEL_CONNECT` when project code imports
  `@vercel/connect`. Vercel Connect needs a Vercel project identity, so those
  connections fail on Cloudflare. The fix shows how to read the service's own
  key from the env file instead.
- Preflight warns with `EVE_AI_GATEWAY_KEY_MISSING` when the model goes
  through Vercel AI Gateway and the env file has no `AI_GATEWAY_API_KEY`.
  Without it, every model call fails on Cloudflare.

### Changed

- `EVE_WORLD_LOCAL` now names both ways to keep sessions across updates: the
  Cloudflare World (no database, one setting in `agent.ts`) or Postgres.

## 0.10.0 — 2026-11-04

Eve upgrades on the Cloudflare World no longer end existing conversations, and
the agent's sandbox can no longer reach the World's internal API. Update both
`@moinulmoin/eden` and the project's `@moinulmoin/eden-world-cloudflare` to get
both.

### Security

- In 0.9.0 and earlier, code run in the agent's bash sandbox could call the
  Cloudflare World's internal API through the container's own URL, and read or
  change any session's workflow state: run inputs and outputs, events, and hook
  tokens, or start workflow steps. The World now requires a secret that Eden
  gives only to Eve's World client at each container start, and refuses
  workflow step requests from inside the container; the sandbox can't read the
  secret, and its requests get HTTP 403. Versions kept running from before the
  update stay exposed until their sessions end.

### Added

- **Sessions survive Eve upgrades.** When `eden deploy` ships a new Eve
  version, the previous version keeps running next to it. An existing
  session's next message moves it to the new version with the same session ID,
  history, and sandbox files. Idle sessions move without a message, and work
  already running finishes on the old version. Verified live across Eve
  `0.83.0` → `0.91.0` → `1.0.0-rc.3`. Deploys that keep the same Eve version
  still update in place, as before.
- A later `eden deploy` removes an old version once all its sessions have
  ended. Until then its container runs only while it has work and sleeps
  otherwise; its image stays in your registry. Eden keeps at most 10 versions
  and refuses to deploy past that, listing the versions still holding
  sessions. `eden destroy` removes all of them. To check old versions, deploy
  rotates a control secret, which creates a Worker version with unchanged
  code, even when the deploy is then refused.
- Targets deployed with 0.9.0 are adopted on update: their existing sessions
  keep working on the old version until they end, but don't move to the new
  one.
- This needs a World that declares `deploymentAffinity` (this release). With
  an older World, `eden deploy` keeps the 0.9.0 behavior and still warns that
  an Eve upgrade ends existing sessions.
- While an old version finishes work that was running during the upgrade, a
  scheduled job can fire on both versions. Eden stops the old version's
  schedules once that work ends.

### Fixed

- On the Cloudflare World, one long tool call no longer holds up every other
  session of the agent. The World delivered queued work in batches and waited
  for the whole batch, so while one session ran a 5-minute bash command, a
  quick message in another session waited about 305 seconds; it now finishes
  in about 5 seconds. Each queued delivery now runs on its own and is not sent
  again while it is still running; if Cloudflare restarts the World's Durable
  Object, unfinished deliveries are retried, as before.
- Long sessions on the Cloudflare World no longer keep one ever-growing
  workflow run. The World now supports Eve's compaction handoff (it declares
  `hookForceClaim` and `hookRetention`): after a compaction, Eve moves the
  session to a fresh run with the same session ID, stream, and channel address.
  World `0.9.0` and earlier logged `session handoff unavailable` instead.
- Cloudflare World hook takeover now follows the Workflow contract: a resume
  sent to a run whose hook was taken over is redirected to the new owner even
  after that run finishes or its data expires under the run's retention.
- Listing the container registry during deploy and destroy may take up to 120
  seconds instead of 30. An account with many container snapshots took 42
  seconds, so cleanup failed.

### Changed

- The Cloudflare World is built on `@workflow/world` `5.1.0` and
  `@workflow/world-local` `5.2.0` (from `5.0.0` betas), the versions Eve
  `1.0.0-rc.3` bundles. It still creates spec 8 runs and rejects spec 9 runs
  instead of storing them.

## 0.9.0 — 2026-11-04

Eden 0.8.0 does not work with a fresh project on Eve `0.83.0` or later,
including `npx eve init` today (Eve `1.0.0-rc.3`): it deploys, but the agent's
sandbox fails to open ("DefaultSandbox has no sandbox provider for this
build"). Upgrade to 0.9.0 and add the sandbox module below.

### Fixed

- `eden deploy` no longer fails with "The protected Eve runtime store returned
  value-bearing metadata." when the env file holds a short value such as
  `WORKFLOW_SPEC_VERSION=8` or `FLAG=1`. Eden masked every env value in its
  output, so a short value matched its own random revision IDs and garbled
  messages. Values shorter than 8 characters are no longer masked; they are
  still delivered only through Cloudflare secrets.
- When `eve build` fails, preflight now shows the error Eve printed (the last
  20 lines, after `Eve reported:`) instead of only "The project-local Eve build
  failed".

### Changed

- Eve `0.83.0` and later include the upstream fix for eve#4440
  (vercel/eve#5132), so Eden no longer patches their just-bash binding.
  Preflight and deploy report `✓ EVE_SANDBOX_RESUME_PATCH — not needed`
  instead of warning that the Eve version is unknown. Eve `0.68.0`–`0.82.0`
  keep the temporary fix. A prerelease of `0.83.0` still counts as unfixed.
- Support Eve `0.83.0`'s explicit `JustBashSandbox` setup. Eden accepts that
  provider, rejects other providers, and fails early with setup instructions
  when a project still selects Eve's production default. Projects
  must install `just-bash` as a production dependency and select it in
  `agent/sandbox.ts`, or in `agent/sandbox/sandbox.ts` when an `agent/sandbox/`
  folder exists (any source extension Eve accepts). Preflight rejects
  `agent/sandbox.ts` next to an `agent/sandbox/` folder: Eve 0.83–0.86 silently
  ignores that module and 0.87 and later fail the build. If the source check
  cannot recognize the module, for example because it imports the environment
  from another file, Eden checks after `eve build` that a just-bash sandbox
  template was prepared instead.
  Older Eve releases retain their existing default-to-`just-bash` behavior.
- Pin the fresh-project instructions to Eve `0.91.0` and document
  microsandbox's removal in Eve `0.83.0`.
- Document that changing the Eve version ends existing sessions. Eve refuses
  to continue a session on a different Eve version unless the World routes
  each run back to the deployment that started it, which Vercel does and
  Eden's Cloudflare World does not (the check is in Eve `0.82.0` and
  `0.83.0`). A live Eve `0.82.0` → `0.83.0` update deployed successfully; the
  old session then returned HTTP 409 `session_stranded` and new sessions ran
  bash. Skill and code updates on the same Eve version keep sessions.
- Live-validated Eve `0.83.0` with explicit JustBash: local World multi-step
  queue execution with two bash tools, and Cloudflare World `0.8.0` sandbox-file
  carry plus a delayed durable queued task completing after a same-version
  skill update. Also live-validated Eve `0.91.0` and `1.0.0-rc.3` with Cloudflare
  World `0.8.0`: deploy, a session, and a bash tool call. Postgres World was not
  checked on these Eve releases.

## 0.8.0 — 2026-10-22

### Added

- Deploy npm Eve projects directly from their root `package-lock.json` with
  frozen `npm ci` installs, without converting to pnpm. Exact-pinned pnpm
  remains supported; mixed package-manager lockfiles are rejected. `.npmrc`
  remains excluded from build layers, and private registries remain unsupported.
- Preflight reports actionable setup guidance for a missing `just-bash`
  production dependency, generated production authentication placeholders, and
  local Workflow World durability. Add the sandbox dependency, configure a real
  authenticator for Cloudflare, and choose durable World storage before relying
  on state across image updates.
- Preflight names npm production dependencies that have install scripts.
  Eden's npm install does not run them, so a package that builds or downloads
  its native addon there (for example `better-sqlite3`) would fail at runtime.
  Use a package without one, or switch to exact-pinned pnpm and list it under
  `allowBuilds`.

## 0.7.4 — 2026-10-22

### Fixed

- A sleeping agent whose disk snapshot no longer exists now wakes. Cloudflare
  deletes a snapshot 30 days after it was created or last restored; before
  this fix, every request to that agent failed with HTTP 500 because Eden kept
  starting the container from the missing snapshot. Eden now forgets the
  missing snapshot, starts from the image, and restores the carried
  conversation files in the same request.
- An update no longer replaces the last good copy of the conversation files
  with a partial one when `tar` fails while copying them. The failed copy is
  discarded and the previous copy is kept.

### Documentation

- New guides: [How Eden works](docs/how-it-works.md),
  [Security](docs/security.md), [FAQ](docs/faq.md),
  [Reference](docs/reference.md), and
  [Troubleshooting](docs/troubleshooting.md).
- Fixed: `docs/deploy.md` said an `--env-file` inside the project fails the
  deploy with `SECRET_EXCLUSION_FAILED`. Eden leaves that file out of the
  image instead; keep it outside the project so it stays out of your
  repository.
- Updates now document that only the variables in the current deploy's
  `--env-file` reach the new container, so pass the same file on every
  deploy.
- `docs/install.md` lists the required `just-bash` production dependency.

## 0.7.3 — 2026-10-21

### Added

- `eden --version` (or `-v`) prints the installed Eden version. It was
  previously rejected as an unknown command.

## 0.7.2 — 2026-10-19

### Fixed

- The `EVE_WORLD_LOCAL` warning no longer says local Workflow World state is
  lost when the container sleeps. Since 0.6.0 the container disk is
  snapshotted on sleep and restored on wake; local World state resets only
  when the agent is updated.

### Changed

- Checked Eve `0.80.1` and `0.81.0` (current latest): a fresh `eve init`
  project passes `eden preflight` — frozen install, Eve build, local boot and
  health — and the temporary eve#4440 fix applies.

## 0.7.1 — 2026-10-15

### Fixed

- Extend the temporary Eve just-bash resume fix (eve#4440) to Eve `0.79.1`.
  The newer prepared artifact carries a `templateKey`, not a
  `templateRootPath`; Eden now resolves the current template before reopening
  or recreating a session and refreshing its skills. Existing recognized
  `0.68.0`–`0.72.1` bindings retain their original replacement; unknown hashes
  are still skipped with a warning.
- Document the complete fresh Eve initializer setup for Eden: converting
  npm output to pinned pnpm, excluding optional native archive dependencies,
  adding `just-bash`, and replacing production placeholder authentication.
- Reload a stale container Durable Object before forwarding requests from a
  newer Worker deployment, so updates roll to the new image before the
  deployment health gate can promote them. Scheduled wakes carry the same
  deployment identity and use the same bounded retry.
- Agents deployed with `0.7.0` or earlier must be recreated with
  `eden destroy` followed by `eden deploy` (or deployed to a fresh target)
  to pick up the reliable-update runtime.
- Allow up to ten minutes for Wrangler's Worker publication step, since
  Cloudflare image preparation can consume the previous two-minute deadline
  before the Worker and Container application are published. Other Wrangler
  operations retain their existing deadlines.

## 0.7.0 — 2026-10-07

### Added

- **Agent files and conversations survive updates too (including skill
  changes).** An `eden deploy` update replaces the running Container's image;
  Eden now carries Eve's sandbox sessions — every conversation's files and
  metadata under `/workspace/.eve/sandbox-cache/just-bash/sessions` — out of
  the old container into the agent's Durable Object storage in ~1 MiB chunks
  (capped at 1 GiB compressed; the previous carry is kept when the cap or an
  exec failure aborts a carry) and restores them into the fresh container
  before it serves any request. Same-image snapshot wakes keep using the
  fast snapshot path. `/workspace` outside Eve's sandbox sessions still
  resets to the new image.
- **Temporary Eve fix for the just-bash resume bug
  ([eve#4440](https://github.com/vercel/eve/issues/4440)).** Upstream Eve's
  just-bash provider permanently refuses to resume a conversation after the
  sandbox template changes (skills, `agent/sandbox/workspace/`, sandbox
  definition) and never falls back. Eden's isolated builder now patches one
  file in the installed Eve copy — only when its sha256 matches a version
  Eden knows (verified for 0.68.0, 0.71.2, and 0.72.1) — so a session
  reopens against the current template, refreshes the authored skills, and
  never touches `/workspace` user data. The patch exists only inside the
  build image and is removed when upstream ships the fix; an unknown Eve
  version still deploys and prints an `EVE_SANDBOX_RESUME_PATCH` warning
  (applied prints `✓ EVE_SANDBOX_RESUME_PATCH`).

### Changed

- Removed undocumented package exports.
- Docs corrected for 0.6.0 sleep/instance behavior.

### Fixed

- Eve sandbox tools (`bash`, `read_file`, `write_file`) now work on deployed
  agents: the prepared sandbox template ships in the image, and runtime
  sandbox selection matches the build.
- **Sleep now snapshots with the default settings.** The 0.6.0 default
  sleep window (24 hours) exceeded Cloudflare's 6-hour limit on how long a
  container may outlive its idle Durable Object, so the inactivity timeout
  was rejected and Cloudflare stopped idle containers without a snapshot —
  files were lost and updates had nothing to carry. The default is now 1
  hour, and `EDEN_EVE_CONTAINER_SLEEP_AFTER` is capped at `345m` (5 h 45 min).
- A container restored from a snapshot is no longer mistaken for a stale
  image (`inspect()` reports an empty image for it); Eden compares the image
  it recorded at start instead.

## 0.6.0 — 2026-10-06

### Changed

- **Containers run on the Durable Object runtime.** The Eve host is now a
  plain Durable Object driving Cloudflare's native `ctx.container`
  (`scheduling_policy: "durable_object"`) instead of the
  `@cloudflare/containers` Container class. The image is selected at
  container start, so an `eden deploy` update no longer races the old image:
  the running container is replaced when `inspect()` shows it still serves the
  previous image, and deploy health promotion proves the served image.
- **Agent files survive sleep.** When the container has been idle for the
  sleep window (default 24 hours, `EDEN_EVE_CONTAINER_SLEEP_AFTER`), Eden
  snapshots the container's writable filesystem and destroys the instance; the
  next wake restores the snapshot in under a second, so `/workspace` —
  including Eve's sandbox cache — survives sleep. Snapshots are bound to the
  image they came from, expire after 30 idle days, and a redeploy that changes
  the image starts fresh (workspace files do not carry across an update).
- **Container size is `standard-1`** (1/2 vCPU, 4 GiB; previously `basic`,
  1 GiB). Awake time is billed at the 4 GiB rate; a sleeping container costs
  nothing.
- **0.6.0 is a clean cutover.** Targets deployed with 0.5.0 should be
  destroyed with 0.5.0 and redeployed.
- **Registry cleanup now removes every tag** in a generation's repository —
  including the `rootfs-snapshot-*`/`rootfs-set-*` tags container snapshots
  create — on updates, destroy, and aborted pushes.
- Wrangler requirement bumped to **4.147.0** (first release that deploys
  `scheduling_policy: "durable_object"`); `@cloudflare/workers-types` to
  `5.20261006.1`. `@cloudflare/containers` is no longer a dependency.
- Durable Object ownership for preflight now reads the container
  application's Durable Object namespace (`wrangler containers info`) and
  matches it against the Worker's `EVE_CONTAINER` binding namespace;
  unreadable provider state still fails closed.

## 0.5.0 — 2026-10-06

### Added

- **Update an agent in place.** Running `eden deploy` again on a target Eden
  owns (proved by its immutable deployment record: same account, project, and
  exact Worker and Container names) now updates it instead of failing with
  `VAL-CLI-007-TARGET-CONFLICT`. Eden republishes the same Worker and
  Container application, keeps Durable Object classes and their migration
  history (new tags are only appended), restarts the running Container on the
  new image, health-checks, promotes, and then deletes the previous
  generation's registry image. State in the Cloudflare World now survives
  updates. Proven on Cloudflare: a pending approval made before an update
  completed afterwards on the new code. The summary prints `✓ updated`, and
  `--json` reports `deployment.operation`.
- Warnings `EVE_UPDATE_IN_FLIGHT` (off Vercel, in-flight runs resume on the
  new code; keep step names and state shapes compatible) and
  `EVE_UPDATE_WORLD_SWITCH` (switching Workflow Worlds doesn't move existing
  state).

### Changed

- A target that exists but isn't provably owned by Eden still fails with
  `VAL-CLI-007-TARGET-CONFLICT`, and production still requires `--name`.

## 0.4.1 — 2026-10-01

Release of 0.4.0's contents. No code changes. The first publish of the new
`@moinulmoin/eden-world-cloudflare` package was done by hand to bootstrap
npm trusted publishing, and its tarball bytes differ from the CI build, so the
release pipeline correctly refused to publish 0.4.0 of the other packages.
All three packages are published at 0.4.1 by CI with provenance.
`@moinulmoin/eden-world-cloudflare@0.4.0` is the same code without provenance.

## 0.4.0 — 2026-10-01

### Added

- **Experimental: durable state with no database.** New package
  `@moinulmoin/eden-world-cloudflare`, a Workflow World backed by one
  SQLite Durable Object on your own Cloudflare account. Add the package and
  select it in `agent.ts`; Eden provisions the Durable Object and wires
  everything else. Durable Object alarms deliver queued workflow work and
  wake the Container. The World's endpoint is private to the Container;
  public `/__eden/world/*` requests return 404. Passes Workflow's official
  World conformance suite (`@workflow/world-testing`), and on Cloudflare a
  pending approval survived a Container restart and the run completed.
  See [docs/deploy.md](docs/deploy.md#durable-state-on-cloudflare-no-database).
- **Known limitation:** `eden destroy` deletes this state, and updating an
  agent currently requires destroy then deploy. State survives sleep and
  restarts, not code updates. Use the Postgres World if you need state across
  updates.
- **Not yet verified:** automatic Container sleep with this World. In the
  live test the Container stayed awake 45 seconds after the last client
  disconnected (30-second sleep setting); the cause is under investigation.
  Client stream cancellation was checked and stops polling.

## 0.3.0 — 2026-10-01

Real agents on your own Cloudflare: memory survives sleep, and schedules
fire while the Container sleeps.

### Added

- **Durable agent state with the Postgres Workflow World**, in three steps:
  add `@workflow/world-postgres` (the version paired with your Eve), select
  it in `agent.ts`, and put a direct (unpooled) `WORKFLOW_POSTGRES_URL` in
  your env file. Eden handles the rest during deploy: it runs the database
  migration (idempotent, with the URL passed only through the environment),
  disables the `cbor-extract` native addon that can't load in the image, and
  checks the World version against your Eve exactly the way Eve does
  (`EVE_WORLD_PAIRING`). Proven on Cloudflare: a pending approval survived a
  full container replacement and the live stream delivered events.
  See [docs/deploy.md](docs/deploy.md#durable-state-postgres-world).
- **Schedules fire while the Container sleeps.** When `eve build` reports
  schedules, the Worker gets an every-minute Cloudflare Cron Trigger that
  wakes the Container shortly before each tick, so Eve's own scheduler runs
  every tick exactly once. Schedules that can't be evaluated ahead of time
  (seconds fields, `@daily`-style shortcuts) produce `EVE_SCHEDULE_UNSUPPORTED`
  and only run while the Container is awake. See
  [docs/deploy.md](docs/deploy.md#schedules).
- Warnings, in human output and in the `--json` result (`warnings`), never
  failing the run and never including URL content: `EVE_WORLD_LOCAL` (state
  is lost on sleep) and `EVE_WORLD_POSTGRES_POOLED` (transaction-mode
  poolers break live session streaming).

### Changed

- Image installs tolerate pnpm's ignored build script for `cbor-extract`
  only; any other ignored dependency build script still fails with
  `ERR_PNPM_IGNORED_BUILDS`.

### Fixed

- **Linux:** `--env-file` values no longer reach the local boot check through
  `--env-file /dev/stdin`. On Linux, the stdin of a process Node spawns is a
  socket that `/dev/stdin` cannot open, so preflight and deploy failed there
  whenever an env file was used. Eden now passes `--env NAME` (names only)
  with values in the Docker CLI's own environment; values still never reach
  argv, logs, or the image. `PATH`, `HOME`, `DOCKER_HOST`, and
  `DOCKER_CONTEXT` are rejected as env-file names because they would replace
  the local Docker CLI's own settings.

## 0.2.2 — 2026-10-01

### Fixed

- `eden deploy` and `eden preflight` no longer refuse a new target just
  because the Cloudflare account already has other Containers, including
  another Eden agent. The target check now looks only for this target's own
  `<name>-container` application.
- The local boot check during `eden deploy` now receives the `--env-file`
  values, as `eden preflight` already did. Agents that need runtime
  configuration at boot (for example a Postgres Workflow World URL) no longer
  fail deploy with a health error. Values still never reach command
  arguments, image layers, or logs.

## 0.2.1 — 2026-10-01

### Security

- The public Worker now returns 404 for Eve's Workflow queue delivery
  routes (`/.well-known/workflow/v1/flow` and `/step`). They had no
  authentication, and in 0.2.0 they were reachable from the internet. Queue
  deliveries from the container to its own URL are now routed straight back
  into the container, and only that host is intercepted. Webhook callbacks and
  Eve's callback URLs are unchanged. **Upgrade and redeploy existing 0.2.0
  deployments.**

### Changed

- Validated Eve 0.68.0 (was 0.66.3) with a real Cloudflare deploy, a real
  model reply, and a tool call. The compatibility runner now reads the
  installed Eve version and fails if it doesn't match the fixture pin.

## 0.2.0 — 2026-09-30

Eden now has one job: deploy an existing Eve project to your own Cloudflare
account.

### Breaking

- Removed Eden Agent (`eden agent init|build|dev|deploy`) and its packages
  `@moinulmoin/eden-compiler` and `@moinulmoin/eden-definitions`. The CLI now
  has three commands: `eden preflight`, `eden deploy`, and `eden destroy`.

### Added

- Validated Eve 0.66.3 (was 0.47.3). A fresh `eve init` project passes
  `eden preflight`, and a real preview deploy served a model turn with a tool
  call.
- `eden deploy` and `eden preflight` work without flags: the project is the
  current directory, the environment is `preview`, and the name is derived
  from `package.json`. `--env production` and `destroy` still require an
  explicit `--name`.
- Human-readable output by default: progress lines, ✓/✗ checks, and a
  summary with the URL and elapsed time. `--json` prints the previous
  machine-readable result for scripts and CI.

### Changed

- The Cloudflare Container uses the `basic` instance type (1 GiB) instead of
  the 256 MiB default.
- `eden destroy` also deletes the registry image tags recorded for the exact
  target, including images left by aborted pushes, and reports any it could
  not remove.

### Fixed

- Image builds copy the project's `pnpm-workspace.yaml` before frozen
  installs, so pnpm policy behaves the same inside the image as locally.
- The runtime image includes `package.json` and the authored Eve source that
  `eve start` needs, with secret files still excluded.
- Build failures are classified by the step that failed. A failing
  `eve build` reports `EVE_BUILD_FAILED` (with a `just-bash` hint when Eve's
  sandbox fallback is missing), and pnpm failures report pnpm's own error
  code, such as `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` or
  `ERR_PNPM_IGNORED_BUILDS`.
- Fixed a runtime-tree ordering mismatch that raised `SOURCE_RACE` on real
  Eve 0.66.3 builds.
- The Worker no longer overrides the container start command, which crashed
  the container under `wrangler dev` by running `eve start` twice.

## 0.1.5 — 2026-08-31

- Added a pinned Eve 0.47.3 compatibility project and CI gate covering frozen
  install, typecheck, production build/start, public health, fail-closed bearer
  auth, and the public Eve eval runner when a model credential is available.
- Removed the exact retained local runtime image and publication tags after a
  healthy Eve deployment is promoted, with generation-label ownership proof.

## 0.1.4 — 2026-08-29

- Fixed Agent deployment after a prior same-identity build by excluding the
  diagnostic build timestamp from immutable artifact identity comparison.
- Corrected pnpm deployment examples so CLI options reach Eden without a
  literal `--` argument.

## 0.1.3 — 2026-08-27

- Made generated Eden Agent projects install cleanly with pinned pnpm 11 by
  approving only the required `esbuild` and `workerd` dependency builds.
- Added detailed user installation, Deploy, Agent, verification, and cleanup
  documentation under `docs/`.

## 0.1.2 — 2026-08-26

- Replaced public `workspace:*` dependency specifiers with exact `0.1.2`
  versions so every supported installer resolves the published package graph.

## 0.1.1 — 2026-08-26

- Replaced the placeholder npm README with complete installation,
  prerequisites, Deploy, Agent, cleanup, and limitation guidance.
- Relaxed the Node engine declaration to `>=24.17.0`; later Node majors are no
  longer rejected without evidence.
- Removed internal Factory mission and scan scaffolding from the public tree.

## 0.1.0 — 2026-08-26

Initial release.

### Eden Deploy

- Added top-level `eden preflight`, `eden deploy`, and `eden destroy` commands for hosting an existing Eve project on Cloudflare without adapting its source or runtime semantics.
- Added immutable Linux/amd64 packaging, bounded Container hosting, Worker routing, protected runtime injection, generation identity checks, health-gated promotion, and exact owned-resource cleanup.
- Added fail-closed validation for project roots, lockfiles, runtime configuration, host requirements, deployment identity, and destroy ownership.

### Eden Agent

- Placed Eden's agent-authoring framework beneath the explicit `eden agent` namespace: `init`, `build`, `dev`, and `deploy`.
- Added filesystem-first agent and tool discovery, coherent generated artifacts, authenticated local and remote runtimes, SQLite-backed Durable Object sessions, NDJSON journals, and bounded model/tool/final-response turns.

### CLI contract

- Removed the obsolete `eden eve` namespace.
- Removed root aliases for Agent `init`, `build`, and `dev`; root `deploy` now always means Eden Deploy.
- Added command-specific help and explicit target selection through `--project`, `--env`, and `--name`.
- Added the `@moinulmoin/eden` package and `eden` binary with npm, pnpm, and
  Bun installer compatibility; Node remains the runtime.

# Eve compatibility history

Dated records of live runs and notes about older Eve versions. Each one
describes what was true when it was recorded. For what Eden supports today,
see [Eve compatibility](./eve-compatibility.md).

## Live check for the destroy evidence change (2026-11-20)

Run on macOS with Docker `29.8.2`, against the maintainer's Cloudflare
account, with Wrangler `4.147.0` and an OAuth login, on the branch of
[#21](https://github.com/moinulmoin/eden/pull/21) at `2773d92`, which is
main at `0dada03` with that change.

Full run of `pnpm run check:live`, target `eden-live-20261120-59142d5b`,
`00:18:50Z` to `00:33:42Z`, Eve `0.91.0` to `1.0.2`, the World packed from
this workspace (version `0.13.0`), a 90-second idle window. All 18 steps
passed.

- `eden preflight` passed 14 checks with no warnings in 78 seconds. The
  fresh deploy took 153 seconds, the same-version update 111 seconds, and
  the deploy on Eve `1.0.2` 196 seconds, all on the same URL. After each
  publish Eden read the Worker's deployments and the Container application
  from Cloudflare's API before it moved `CURRENT`.
- Session `wrun_01M7V5BWTWT1PY6GKN83EV64X2` answered after each deploy and
  after the sleep, with its earlier turns in its stream and its file
  intact. After 165 seconds with no requests the first health request took
  7.3 seconds, and the server process was 7 seconds old.
- An unauthenticated session request got `401`, and the two workflow queue
  routes answered `404`. A session on Eve `1.0.2` asked its server
  process: no `queueAuthMode` line.
- `eden destroy` ended with `destroyed` in 80 seconds and reported 16
  objects in `EVE_REGISTRY_OBJECTS_KEPT`. In the repository of the Eve
  `0.91.0` version: six snapshot tags, three snapshot manifests, two chain
  artifacts, and the first image, which lost its tag to the second push
  (`accepted-still-listed`). In the repository of the Eve `1.0.2` version:
  two snapshot tags, one snapshot manifest, and one chain artifact.
- The check's catalog read found those 16 refs and no others. The URL
  returned 404, and the check found no Worker, no secrets, and no Container
  application.
- Read on the same account without creating anything. The Container
  application list for a name that does not exist answered `200` with
  `{"success":true,"result":[],"errors":[],"messages":[],"result_info":{}}`.
  The deployments list of three Workers answered `200` with `success`
  true, an empty `errors` list, and a string `id` on every deployment. A
  `destroy` whose record named the destroyed Worker and Container
  application, and no image, ended with `absent`. The same `destroy` with a
  login Cloudflare refuses ended with `EVE_DESTROY_INDETERMINATE`.

Earlier runs, 2026-11-19 `21:33Z` to `23:52Z`:

- On the branch at `db3101f`, one run failed one step: after the deploy on
  Eve `1.0.2` reported healthy, the session stream answered `500` with a
  Cloudflare HTML error page. The cause was not investigated.
- On the branch at `01a01aa`, one run passed all 18 steps.
- On the branch at `2773d92`, three runs failed at `eden deploy`, and on
  main at `0dada03`, two runs failed the same way. In each, `wrangler deploy`
  exited with an error after it uploaded the Worker. In three of them
  Wrangler read the new Worker version five times and Cloudflare answered
  `404` each time. One followed a `400`, and in one Wrangler stopped with
  `Cannot read properties of null (reading 'tag')`.
- After those failures `eden destroy` removed four of the five targets,
  two of them only on a second or third run. The fifth kept answering
  `EVE_DESTROY_OWNERSHIP_UNPROVEN`; its Worker was deleted with
  `wrangler delete`.

## Live check for release 0.13.0 (2026-11-19)

Run on macOS with Docker `29.8.2`, against the maintainer's Cloudflare
account, with Wrangler `4.147.0`, on main at `bd8ae1f`. The `0.13.0` release
commit differs from `bd8ae1f` only by version numbers, the lockfile, the
changelog, and docs.

Full run of `pnpm run check:live`, target `eden-live-20261119-235b3b7b`,
`10:24:17Z` to `10:42:01Z`, Eve `0.91.0` to `1.0.2`, the World packed from
this workspace (version `0.12.0`), a 90-second idle window. All 18 steps
passed.

- `eden preflight` passed 14 checks with no warnings in 108 seconds. The
  fresh deploy took 198 seconds, the same-version update 126 seconds, and
  the deploy on Eve `1.0.2` 253 seconds, all on the same URL.
- Session `wrun_01M7SNP1NGQVV0T6SZRR6DHVWE` answered after each deploy and
  after the sleep, with its earlier turns in its stream and its file
  intact. After 165 seconds with no requests the first health request took
  2.8 seconds, and the server process was 4 seconds old.
- A session on Eve `1.0.2` asked its server process: no `queueAuthMode`
  line. An unauthenticated session request got `401`, and the two workflow
  queue routes answered `404`.
- `eden destroy` ended with `destroyed` in 117 seconds and reported 19
  objects in `EVE_REGISTRY_OBJECTS_KEPT`. In the repository of the Eve
  `0.91.0` version: eight snapshot tags, four snapshot manifests, two chain
  artifacts, and the first image, which lost its tag to the second push
  (`accepted-still-listed`). In the repository of the Eve `1.0.2` version:
  two snapshot tags, one snapshot manifest, and one chain artifact.
- The check's catalog read found those 19 refs and no others. The URL
  returned 404, and Wrangler showed no Worker, no secrets, and no Container
  application. `wrangler containers images list` showed the ten snapshot
  tags and nothing else for the target.

## Registry cleanup, run on Cloudflare (2026-11-19)

Run on macOS with Docker, against the maintainer's Cloudflare account, with
Wrangler `4.147.0`, from 2026-11-18 `23:13Z` to 2026-11-19 `01:02Z`. The
CLI and the Cloudflare World were built from the branch of
[#13](https://github.com/moinulmoin/eden/pull/13) at `921b741`, which is
main at `2789345` with this change. The full check ran on the same source
files just before they were committed.

What the registry sends, read with a credential that can only pull:

- `tags/list` on an 18-entry repository, with `n=1000` and with `n=7`,
  and on a repository the registry does not know. Each page's body was
  exactly `{"name":"<account>/<repository>","tags":[…]}`, in ascending
  order. Each `Link` header was the full URL of the request, path and
  query, then `?n=<n>&last=<cursor>; rel=next`. The cursor was the page's
  last entry as listed, and empty only on the empty last page. A request
  whose own cursor was written `sha256%3A…` came back with `%3A` in the
  header. The unknown repository answered `200` with no entries and an
  empty cursor. Eden's page parser accepted every page as it was.
- `GET /v2/_catalog` for the whole account no longer answered: `500`
  after 16 seconds with `tags=true`, no answer in 150 seconds without it,
  and `500` with `tags=true&n=1000`. With `tags=true`, pages of 5 and 25
  entries answered `200`. Pages of 100 answered three times and then
  failed. A page holds `n`
  entries in the order of the registry's storage keys, so one repository
  can span pages. The `Link` header was
  `https://registry.cloudflare.com/v2/_catalog?n=<n>&last=<account>/<account>/<repository>/manifests/<entry>&tags=true; rel=next`.
  A start key past the last repository got no answer in 60 seconds. The
  same request answered `500` and then `200` a few seconds later. The
  catalog's last page was never seen.
- So the live check no longer reads the whole catalog. It starts at the
  key just before the target's repositories, reads pages of 25, tries a
  page up to four times, and stops at the first repository after the
  target's. For sets of repositories that held from 0 to 137 refs it gave
  the same refs as `tags/list` on each repository. One early comparison
  differed, 122 refs against 137, and matched when it was repeated; the
  cause was not found.

Full run of `pnpm run check:live`, target `eden-live-20261119-174c653b`,
`00:10:06Z` to `00:25:56Z`, Eve `0.91.0` to `1.0.2`, the World packed
from this workspace (version `0.12.0`), a 90-second idle window. All 18
steps passed.

- `eden preflight` passed 14 checks with no warnings in 96 seconds. The
  fresh deploy took 175 seconds, the same-version update 117 seconds, and
  the deploy on Eve `1.0.2` 179 seconds, all on the same URL.
- Session `wrun_01M7RJG9XMBDBCK56EWRX301EN` answered after each deploy and
  after the sleep, with its earlier turns in its stream and its file
  intact. After 165 seconds with no requests the first health request took
  5.2 seconds, and the server process was 6 seconds old.
- `eden destroy` ended with `destroyed` in 108 seconds and reported 16
  objects in `EVE_REGISTRY_OBJECTS_KEPT`. In the repository of the Eve
  `0.91.0` version: six snapshot tags, three snapshot manifests, two chain
  artifacts, and the first image, which lost its tag to the second push
  (`accepted-still-listed`). In the repository of the Eve `1.0.2`
  version: two snapshot tags, one snapshot manifest, and one chain
  artifact.
- The check's catalog read found those 16 refs and no others. A separate
  `tags/list` read of both repositories gave the same 16. The URL returned
  404, and Wrangler showed no Worker, no secrets, and no Container
  application.

Two more runs used a copy of the check's script with extra steps. Each kept
a copy of a deployed image in a repository of its own, under a tag, with the
same digest. Each compared what the registry listed with what Eden
reported, entry by entry.

Affinity retirement, target `eden-live-20261119-4aa8f322`, `00:26:58Z` to
`00:49:32Z`, all 28 steps passed.

- The Eve `0.91.0` version slept once, got a second image from a
  same-version update, and stayed alive beside the Eve `1.0.2` version
  until its one session was ended with `POST /eve/v1/session/<id>/end`
  (`202`).
- The script's own deletes in that version's repository: a snapshot tag
  and a snapshot manifest each answered `403`, content type
  `application/json`, body
  `{"errors":[{"code":"DENIED","message":"snapshot manifests cannot be deleted through this API","detail":null}]}`.
  A chain artifact answered `409`, content type `application/json`, body
  `{"code":"SINGLETON_ARTIFACT_EXISTS","subjectDigest":"sha256:…","artifactType":"application/vnd.cloudchamber.btrfs-chain.v1","committedDigest":"sha256:…"}`.
  In it `committedDigest` was the digest in the delete request and
  `subjectDigest` was the image the artifact names as its subject, as for
  two other chain artifacts deleted the evening before. Eden reads neither
  field. The listing was unchanged afterwards.
- The next `eden deploy` retired the version in 265 seconds. `VAL-LIFE-007`
  passed and the result reported 15 kept objects: 12 `refused-snapshot`,
  2 `refused-singleton-artifact`, and the first image as
  `accepted-still-listed`. The repository listed those 15 entries and no
  others, and `HEAD` on each answered `200`. The `candidate` tag and the
  second image were gone.
- The copy of the first image, same digest, in the script's repository was
  still listed, `HEAD` answered `200`, and `docker pull` by digest
  succeeded. The session on Eve `1.0.2` ran bash again.
- `eden destroy` ended with `destroyed` in 150 seconds and reported 24
  kept objects: 18 `refused-snapshot`, 4 `refused-singleton-artifact`,
  and 2 `accepted-still-listed`. The two repositories listed those 24
  entries and no others. Both copies were intact in the same way.

Superseded repository, target `eden-live-20261119-07476f99`, `00:50:45Z`
to `01:01:49Z`, Eve `1.0.2` with Eve's local World in an npm project, all
17 steps passed.

- The first repository listed the `candidate` tag, the image, and its
  chain artifact. The update pushed to a new repository and cleaned up the
  first one: `VAL-LIFE-007` passed and the result reported the chain
  artifact as `refused-singleton-artifact`. The first repository listed
  only that artifact. The image and its tag were gone.
- The copy of that image, same digest, in the script's repository was
  still listed. `HEAD` on the manifest and on each of its 20 blobs
  answered `200`, and `docker pull` by digest succeeded. The target's
  health answered ready.
- `eden destroy` ended with `destroyed` in 38 seconds and reported the two
  chain artifacts, one in each repository. The repositories listed those
  two entries and no others. Both copies were intact in the same way.

The script removed its four copies with
`wrangler containers images delete`. Each repository then listed nothing.

Tags and untagged images, in a repository made for the test:

- Two images under two tags. `wrangler containers images delete` on one
  tag removed the tag and its image from the listing at once, and `HEAD`
  on the digest answered `404`.
- A third image pushed under the other tag left the second image listed
  with no tag. `DELETE` of that image by digest answered `204` with no
  body. It was still listed 35 seconds later and `HEAD` answered `200`.
  After the tag and the third image were deleted, a second `DELETE` of it
  answered `204` again and it stayed.

So in these runs an image went away when its tag was deleted, and stayed
when it had lost its tag to a later push.

Before the full run passed, two runs failed at the fresh deploy with
`DEPLOY_INDETERMINATE` after 223 and 236 seconds: `eden deploy` stopped
waiting for the image push after 120 seconds. The registry was slow that
evening. One new 64 MB layer took 35 seconds to push and its manifest 39
seconds more, on an uplink that measured about 70 Mbit/s. The second
upload finished after Eden stopped waiting: the repository held a
`candidate` tag and its image, with no Worker and no deployment record.
After the first, every layer was already in the registry when the push
was repeated by hand. `eden destroy` answered `EVE_DESTROY_RECORD_UNPROVEN`
both times, and the two images were removed with
`wrangler containers images delete`. The push now gets ten minutes
([#16](https://github.com/moinulmoin/eden/pull/16)).

Left in the account by these runs: the 42 objects that the three destroys
reported, and the one untagged 36-byte image from the tag test.

Not known: the catalog's last page and how the reader ends for a target
whose repositories sort last, when Cloudflare removes chain artifacts and
untagged manifests, whether kept objects count toward the 50 GB of image
storage, and what `subjectDigest` and `committedDigest` mean beyond what
was seen.

## What the registry lists after destroy (2026-11-18)

Read on macOS against the maintainer's Cloudflare account, with a registry
credential from Wrangler `4.147.0`, between `14:33Z` and `15:13Z`. These
observations are why destroy now reads the registry's own listing and
deletes entries by digest.

- `GET /v2/_catalog?tags=true` and `GET /v2/<account>/<repository>/tags/list`
  list each tag and one `sha256:<digest>` entry for each manifest.
  `wrangler containers images list` leaves the `sha256:` entries out: the
  catalog had 142 repositories, Wrangler listed 15. `tags/list` pages with
  `n` and `last`, in sorted order, and a page after the last entry is
  empty. A repository the registry does not know lists as `200` with no
  entries.
- Each `tags/list` page answered `{"name":"<account>/<repository>","tags":[…]}`,
  for an unknown repository too. Each carried a `Link` header that ended in
  `&last=<cursor>; rel=next`. The cursor was the page's last entry, and
  empty on an empty page. The header's URL was the request's URL with
  `?n=<n>&last=<cursor>` appended, even when the request already had a
  query. A 29-entry repository read with `n=7` and with `n=1000` gave the
  same 29 entries as the catalog.
- The two live-check targets destroyed earlier that day each still listed
  twelve entries in the repository of their Eve `0.91.0` version: six
  snapshot tags, three snapshot manifests, two artifacts of type
  `application/vnd.cloudchamber.btrfs-chain.v1`, and one image manifest
  with no tag. The untagged image was the first one pushed to a repository
  that later got a second push.
- `DELETE` of a snapshot manifest by digest answered `403` with
  `{"errors":[{"code":"DENIED","message":"snapshot manifests cannot be deleted through this API","detail":null}]}`,
  as for a snapshot tag.
- `DELETE` of a chain artifact by digest answered `409` with
  `{"code":"SINGLETON_ARTIFACT_EXISTS","subjectDigest":"sha256:…","artifactType":"application/vnd.cloudchamber.btrfs-chain.v1","committedDigest":"sha256:…"}`.
  The answer was the same right after the registry accepted the delete of
  the image the artifact names as its subject.
- `DELETE` of an untagged image manifest by digest answered `204`, and the
  manifest stayed. One was deleted at `14:55:23Z`; at `15:13:19Z` `HEAD` on
  its digest still answered `200` and the listing still had it. A second
  one, deleted at `15:11:56Z`, was still listed at `15:13:19Z`.
  `PUT /v2/gc/layers` afterwards answered `200` with an empty `deleted`
  list. Putting a new tag on such a manifest and deleting that tag with
  `wrangler containers images delete` printed `Deleted` and left the
  manifest listed.
- During the run on target `eden-live-20261118-17bac346`, the image that
  held the `candidate` tag left the listing about 15 seconds after destroy
  deleted the tag.
- Dated from their configs at `14:58Z`, the account's untagged entries were
  34 image manifests (oldest 2026-10-07), 188 chain artifacts (oldest
  2026-10-06), and 99 snapshot manifests (oldest 2026-10-06). 18 of the
  snapshot manifests were created more than 30 days earlier; when a
  snapshot was last restored cannot be read.

Not known: when Cloudflare removes chain artifacts and untagged manifests,
and whether kept objects count toward the 50 GB of image storage per
account in Cloudflare's limits. Cloudflare's image-management and limits
pages do not say.

Destroy with this change ran on Cloudflare the next day; see the entry
above. Before that it was checked with a stand-in for Wrangler and the
registry: each of the three kept answers, an
accepted delete that leaves the listing, any other answer, an entry that
appears during cleanup, entries that keep appearing, a listing in several
pages, a listing that cannot be read at the start or at the end, an answer
for another account or repository, a page whose cursor contradicts it, a
second accepted delete late in the wait, a repository that holds a deployed
image, and an image reference in another spelling.

## Destroy with a bounded wait on the registry (2026-11-18)

Run on macOS with Docker, against the maintainer's Cloudflare account, with
the CLI built from main at `c325eec` plus the follow-up change: Eden's own
registry request follows only a delete that the registry refused Wrangler
with `403`, requests that get no answer share 60 seconds per command, and
only a `403` answer has its body read.

Full run of `pnpm run check:live` with the final code, target
`eden-live-20261118-0150f230`, `14:05:47Z` to `14:23:41Z`, all 18 steps
passed. The project came from `npx eve@0.91.0 init`, converted to pnpm, with
`just-bash` `3.6.1` and the World `0.12.0` packed from
`packages/world-cloudflare`. The idle window was 90 seconds.

- `eden preflight` passed 14 checks with no warnings in 98 seconds. The
  fresh deploy took 189 seconds.
- Session `wrun_01M7QFY71MFQHSSPKZMJPQQ2QA` started on Eve `0.91.0`, and
  bash wrote a file. It answered again after the same-version update (140
  seconds), after the deploy on Eve `1.0.2` (206 seconds), and after the
  sleep, each time with its earlier turns in its stream and the file intact.
  New sessions ran bash after the update and on Eve `1.0.2`.
- After 165 seconds with no requests, the first health request took 5.6
  seconds. The server process was 10 seconds old when the session asked.
- `eden destroy` took 121 seconds and succeeded. Wrangler was asked to
  delete every tag. For each of the eight that the registry refused it,
  Eden's own request got the snapshot refusal. Destroy reported those eight
  tags, six in the repository of the Eve `0.91.0` version and two in the
  repository of the Eve `1.0.2` version, with the estimated removal date
  2026-12-18.
- The last step found no Worker, no secret, no Container application, and
  no registry tag except those eight.

A later commit changed only what a failed deploy reports: it now lists the
snapshot tags it confirmed. A full run on that code, target
`eden-live-20261118-17bac346`, `14:33:34Z` to `14:50:03Z`, passed all 18
steps. Destroy took 109 seconds and reported eight snapshot tags. During
that run `wrangler containers list --json` showed the Container application
with an empty `image`, and `wrangler containers info` showed an empty
`configuration`. The configuration of a snapshot in the target's registry
repository named the application's ID as `application_id`.

Two earlier runs the same day did not pass.

- Target `eden-live-20261118-a43120e3`, `13:27:59Z` to `13:44:58Z`, with
  an earlier draft of the change. The first 17 steps passed. `eden destroy`
  started at about `13:42:52Z` and failed with
  `EVE_DESTROY_IMAGES_RETAINED` for the repository of the Eve `0.91.0`
  version. That repository then held five snapshots. The newest one's
  config says it was created at `13:44:20Z`, during the destroy and about
  90 seconds after the last request, so its two tags appeared after destroy
  had listed the repository. Destroy fails on a tag it did not attempt, as
  designed. `eden destroy` run again with the final code, `13:51:05Z` to
  `13:52:51Z`, succeeded and reported all 12 tags, each one refused by the
  registry itself.
- Target `eden-live-20261118-f567b159`, `13:55:51Z` to `14:05:21Z`, with
  the final code. After the same-version update the old session answered,
  then the request that starts a new session got `HTTP 500` with
  Cloudflare's "Worker threw exception" page, and the run stopped there.
  `eden destroy` took 76 seconds, succeeded, and reported two snapshot
  tags. The same step passed in the run before this one and in the run
  above; the cause was not found.

Not run on Cloudflare: a registry that does not answer, a rejected
credential, and a deploy that retires a version with snapshot tags. Those
were checked with a stand-in for Wrangler and the registry.

Left in the account after these runs: 30 snapshot tags from the four
targets (12, 2, 8, and 8), and no other tag, Worker, secret, or Container
application of theirs.

## Destroy when Cloudflare's registry refuses snapshot tags (2026-11-18)

Run on macOS with Docker, against the maintainer's Cloudflare account, with
the CLI built from main at `47e94c7` plus the change that makes
`eden destroy` report the snapshot tags Cloudflare's registry refuses to
delete.

What the registry did. Checked at `11:15Z` with the registry credentials
Wrangler uses:

- `DELETE` of a `rootfs-set-*` tag answered `403` with
  `{"errors":[{"code":"DENIED","message":"snapshot manifests cannot be
  deleted through this API","detail":null}]}`, as it had since `10:24Z`.
  `OPTIONS` on the same manifest allowed `GET, HEAD, OPTIONS`. The same
  credentials had deleted `candidate` tags.
- The registry has no route that deletes a repository: `DELETE` on the
  repository, with and without a trailing slash, and on `tags/<tag>` and
  `tags/list`, answered `404`.
- Cloudflare's API answered `No route for that URI` for
  `/accounts/<id>/containers/snapshots` and `/containers/images`. Its
  reference lists no snapshot or image method, and Wrangler `4.147.0` has no
  snapshot command. Wrangler prints only `403 Forbidden` for the refused
  delete; its source drops the response body.
- Cloudflare's snapshot guide says the Container binding "does not provide
  methods to list or delete them", and that a snapshot has a 30-day
  time-to-live that each restore refreshes. Its Containers changelog had no
  entry about the refusal; the newest entry was dated 2026-09-30.

The answer names snapshot manifests, it was the same for every snapshot tag
tried over these hours, and the same credentials deleted other tags. That
points to a rule of Cloudflare's registry and not to a missing permission.
Cloudflare has not announced one, and these checks cannot rule out a fault
on its side. The run on 2026-11-17, with an upgrade and a sleep, ended with
no registry tag for its target.

Full run of `pnpm run check:live` with the final code, target
`eden-live-20261118-cde8001a`, `12:49:13Z` to `13:04:54Z`, all 18 steps
passed. The project came from `npx eve@0.91.0 init`, converted to pnpm, with
`just-bash` `3.6.1` and the World `0.12.0` packed from
`packages/world-cloudflare`. The idle window was 90 seconds.

- `eden preflight` passed 14 checks with no warnings in 86 seconds. The
  fresh deploy took 164 seconds.
- Session `wrun_01M7QBGVDP3B7R54W12QR5Y4JE` started on Eve `0.91.0`, and
  bash wrote a file. It answered again after the same-version update (118
  seconds), after the deploy on Eve `1.0.2` (200 seconds), and after the
  sleep, each time with its earlier turns in its stream and the file intact.
  A new session reported Eve `1.0.2` and ran bash.
- After 165 seconds with no requests, the first health request took 2.7
  seconds. The server process was 3 seconds old when the session asked.
- `eden destroy` took 122 seconds and succeeded. Wrangler was asked to
  delete every tag. For each of the ten that it could not delete, Eden's own
  request to the registry got the snapshot refusal. Destroy reported those
  ten tags, eight in the repository of the Eve `0.91.0` version and two in
  the repository of the Eve `1.0.2` version, with the estimated removal date
  2026-12-18.
- The last step found the URL returning 404, no Worker, no secrets, no
  Container application, and no registry tag other than those ten.

Afterwards `wrangler containers list` showed no Container application.
`wrangler containers images list` showed nine `eden-live-20261118-*`
repositories holding 36 `rootfs-snapshot-*` and `rootfs-set-*` tags and no
other tag, from this target and the four earlier ones below.

Checked with a stubbed Wrangler and a stubbed registry, through the destroy
and deploy commands:

- Two repositories, where the registry refused one tag as a snapshot and
  the other repository held a deletable tag named `rootfs-set-custom`:
  every tag was attempted, the deletable tag was deleted, and only the
  refused tag was reported. When that other tag got a different `403`,
  destroy ended `EVE_DESTROY_IMAGES_RETAINED`.
- A tag that appeared after cleanup, named like a snapshot: destroy ended
  `EVE_DESTROY_IMAGES_RETAINED`.
- Only the exact refusal counted. A `403` page containing the message, a
  longer message, another code, a second error, a `401`, a `500`, a `307`,
  a body over 4 KiB, a failed connection, and a credential for another
  account each ended `EVE_DESTROY_IMAGES_RETAINED`.
- 200 refused tags in text output: 200 `kept:` lines, 201 Wrangler deletes,
  200 registry requests, one credential.
- A deploy that removed a superseded repository: `VAL-LIFE-007` passed with
  the warning when the registry refused its snapshot tag, and failed when
  another tag got a different `403`.

A real `wrangler containers images delete` of a snapshot tag took 1.8 to
2.2 seconds (three calls). With process-wide proxy settings and certificate
verification turned off in the environment, a request on the registry
check's own connection still went straight to the registry and still
rejected a self-signed certificate.

Earlier drafts of the change, same day. Each of these runs passed and left
snapshot tags, and its code differed from the final code:

- `eden destroy` on the two targets the runs below had left behind:
  `eden-live-20261118-58beade5` at `11:09Z` (two tags reported) and
  `eden-live-20261118-aea2c928` at `11:23Z` (eight tags reported), both
  exit code 0. That draft took Wrangler's `403 Forbidden` on a tag named
  like a snapshot as enough.
- A full run with that draft, target `eden-live-20261118-09054fc8`,
  `11:25:14Z` to `11:43:15Z`: 18 steps passed, eight tags reported.
- A full run with a draft that stopped asking after the first refusal,
  target `eden-live-20261118-4224c172`, `12:01:36Z` to `12:19:08Z`: 18
  steps passed, eight tags reported. That shortcut was removed: it reported
  tags that were never tried.

Not run live: a deploy that removes a superseded version's registry
repository, in either of its two code paths. The live check has no such
step. The stubbed deploy check above covers the in-place path only.

## Live check with the workspace World (2026-11-18)

Runs of `pnpm run check:live` on macOS with Docker, against the
maintainer's Cloudflare account. The CLI and the Cloudflare World were
built from main at `59d388f` plus the change that makes the World declare
`queueAuthMode: "skip"`. No run ended clean: the checks of Eden's behavior
passed, and `eden destroy` could not remove snapshot tags from Cloudflare's
registry.

Full run, target `eden-live-20261118-aea2c928`, `10:02:35Z` to `10:21:40Z`.
The project came from `npx eve@0.91.0 init`, converted to pnpm `11.21.0`,
with `just-bash` `3.6.1` and the World packed from `packages/world-cloudflare`
(version `0.12.0` plus the change). The idle window was 90 seconds.

- `eden preflight` passed 14 checks with no warnings in 109 seconds.
- The fresh deploy took 310 seconds. An unauthenticated session request
  returned HTTP 401. `POST /.well-known/workflow/v1/flow` and `/step` with
  the bearer token returned HTTP 404.
- Session `wrun_01M7Q24X947WQPK5TV2F5BYFX3` started on Eve `0.91.0`. Bash
  wrote a file and read it back with exit code 0.
- The same-version update took 167 seconds, on the same URL. The same
  session answered and bash read the file back. A new session ran bash.
- After the project moved to Eve `1.0.2`, the deploy took 183 seconds, on
  the same URL. The same session answered with the same ID, its two earlier
  turns were still in its stream, and bash read the file back. A new session
  reported Eve `1.0.2` and ran bash.
- The server process, 39 seconds old, had written no line about
  `queueAuthMode` since 0.7 seconds after its start.
- After 165 seconds with no requests, the first health request took 4.7
  seconds. The server process was 8 seconds old when the session asked. Bash
  read the file back again.
- `eden destroy` removed the Worker and the Container application, then
  failed with `EVE_DESTROY_IMAGES_RETAINED` after 113 seconds.

A second run, target `eden-live-20261118-58beade5`, `10:39:20Z` to
`10:52:18Z`, used the final script and no sleep step. Every step up to
destroy passed again, from Eve `0.91.0` to `1.0.2`. For the `queueAuthMode`
step a new session that reported Eve `1.0.2` asked its server process: it
was 27 seconds old and had written no such line since 1.1 seconds after its
start. `eden destroy` failed the same way after 88 seconds.

A control run on the published World `0.12.0` from npm, started on Eve
`1.0.2` with no upgrade and no sleep step (target
`eden-live-20261118-387497fe`, `09:43:47Z` to `09:55:33Z`), failed the
`queueAuthMode` step as intended. The server process had written
`[workflow-sdk] This World declares no queueAuthMode, …`. So the step sees
the warning on Cloudflare when it is there. `eden destroy` took 67 seconds
and left nothing: the URL returned 404, and Wrangler showed no Worker, no
secrets, no Container application, and no registry image.

What was left behind. Cloudflare's registry answered `403 Forbidden`, with
the message `snapshot manifests cannot be deleted through this API`, to
every delete of a `rootfs-snapshot-*` or `rootfs-set-*` tag, from
`eden destroy`, from a second `eden destroy`, and from
`wrangler containers images delete` with Wrangler `4.147.0` and `4.164.0`,
for 30 minutes after the first run. No `candidate` tag was left. The run
on 2026-11-17 ended with no registry image after an upgrade and a sleep, so
this was not seen then. Three repositories with ten such tags stayed in the
account: two from the first target and one from the second. The second
target had the default one hour idle window; its two tags are in the
repository of its Eve `0.91.0` version. Cloudflare's snapshot guide says
snapshots expire 30 days after their last restore and that the Container
binding has no method to delete them.

Two attempts before these runs stopped at `eden preflight`, before any
deploy:

- With the workspace World in an npm project, `VAL-BUILD-001` rejected the
  lockfile. Eden takes npm packages only from the public registry, so the
  script now makes a pnpm project for the workspace World.
- The pnpm project had no policy for dependency build scripts
  (`ERR_PNPM_IGNORED_BUILDS`). The script now writes the floor fixture's
  `pnpm-workspace.yaml`.

## Scripted live check, Eve 0.91.0 to 1.0.2 (2026-11-17)

The first passing run of `pnpm run check:live`, on macOS with Docker,
against the maintainer's Cloudflare account. Three earlier attempts the same
day failed: a script bug, an unavailable model, and a loaded machine. They
are listed below. The CLI was built from main at `7899dc9`.
The project came from `npx eve@0.91.0 init` with `just-bash` `3.6.1` and
`@moinulmoin/eden-world-cloudflare` `0.12.0` from npm. The idle window was
`EDEN_EVE_CONTAINER_SLEEP_AFTER=90s`. The run took 27 minutes, from
`21:50:18Z` to `22:17:13Z`. Other builds were running on the machine, so
the times below are slow ones.

- `eden preflight` passed 14 checks with no warnings in 231 seconds.
- The fresh deploy took 333 seconds. Health was ready on the first request.
  An unauthenticated session request returned HTTP 401.
- Session `wrun_01M7NRCAPX2GMMG5SK2AB3E1ZK` started on Eve `0.91.0`. Bash
  wrote a file and read it back with exit code 0.
- The same-version update took 235 seconds, on the same URL, and printed the
  `EVE_UPDATE_IN_FLIGHT` warning. The same session answered and bash read
  the file back. A new session ran bash.
- After the project moved to Eve `1.0.2`, the deploy took 322 seconds, on
  the same URL. The same session answered with the same ID, its two earlier
  turns were still in its stream, and bash read the file back. A new session
  reported Eve `1.0.2` and ran bash.
- After 165 seconds with no requests, the first health request took 6.4
  seconds. The server process was 7 seconds old when the session asked, so
  the container had stopped and started. Bash read the file back again.
- `eden destroy` took 196 seconds. The URL returned 404. Wrangler showed no
  Worker, no secrets, no Container application, and no registry image for
  the target.

This is the first passing live run on Eve `1.0.2`, and the first dated run
of a session moving across an Eve upgrade.

A second run started on Eve `1.0.2` with no upgrade: preflight took 126
seconds and the fresh deploy 220 seconds. It was then interrupted with
SIGINT on purpose. The script ran `eden destroy` (61 seconds) and nothing
of that target was left.

The three earlier attempts on the same day failed before the full run
passed:

- `pnpm run` exports `npm_*` settings that pointed the project's
  `npm install` at the Eden repository. The script now removes them.
- The free model was not available (`MODEL_CALL_FAILED`), which ended the
  session. The script now uses the fixtures' fallback models. Destroy ran
  after that failure and left nothing behind.
- Under heavy machine load, preflight's local boot did not become healthy
  in time (`EVE_HEALTH_FAILED`). The next run passed unchanged.

On another temporary target the `.eden/` folder was moved aside. `eden
destroy` stopped with `EVE_DESTROY_RECORD_UNPROVEN`. The manual steps in
[The `.eden/` folder is lost](./troubleshooting.md#the-eden-folder-is-lost)
then removed the Worker, the Container application, and the registry image.
The URL returned 404 and nothing with the name was left. That target had not
slept, so it had no `rootfs-snapshot-*` tags to delete.

## Eve 1.0.2 checks (2026-11-17)

Run on macOS with Docker, without Cloudflare credentials. No live Cloudflare
run was made for Eve `1.0.2`.

- The compatibility gate passed for both fixtures: Eve `0.91.0` with
  `@workflow/world-postgres` `5.0.5`, and Eve `1.0.2` with `5.2.1`.
- A project from `npx eve@1.0.2 init`, set up with the README's fresh-project
  steps, passed every build and boot check of `eden preflight`
  (`VAL-BUILD-001` to `VAL-BUILD-007`). The two Cloudflare access checks did
  not run.
- Eve `1.0.2` with `@moinulmoin/eden-world-cloudflare` `0.12.0`, against the
  World's core served over RPC on the same machine: a session was admitted
  with HTTP 202 and its first turn ran up to the model call, which had no
  model key.
- Once a session has started, Eve `1.0.2` with the Postgres World takes about
  five seconds to exit after SIGTERM. Eve `1.0.0-rc.6` exited within a second.

## Eve 0.83.0 sandbox selection

Eve `0.83.0` removed microsandbox and changed `DefaultSandbox`: production no
longer falls back to `just-bash`; that fallback is only for development and
evaluation. Eden has no nested Docker daemon, so install `just-bash` as a
production dependency and explicitly select it in `agent/sandbox.ts`, or in
`agent/sandbox/sandbox.ts` when an `agent/sandbox/` folder exists:

```ts
import { defineSandbox } from 'eve/sandbox';
import { JustBashSandbox } from 'eve/sandbox/just-bash';

export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
```

Eden accepts this explicit provider and rejects other providers. With Eve
`0.83.0` and later, leaving the production default selected fails early with
`EVE_SANDBOX_PROVIDER` and setup instructions; do not enable `EVE_DEV` to bypass
production selection. Older Eve releases keep their existing default behavior.

The `0.83.0` sessions directory remains
`/workspace/.eve/sandbox-cache/just-bash/sessions`. Eden carries that same
directory across image updates, but Eve's state protocol changed. Source-level
fallback to fresh sandbox state for incompatible older state is separate from
whether Eve permits the old session to execute; the live upgrade below was
rejected before sandbox access.

## Eve 0.82.0 to 0.83.0 live upgrade (2026-10-23)

A project using Cloudflare World `0.8.0` deployed Eve `0.82.0`; session
`wrun_01M5M1RCHS9F5CPA22J7XRMJG9` ran bash and wrote `upgrade-proof.txt`.
After upgrading to Eve `0.83.0` with an explicit `JustBashSandbox` module,
Eden deployed the update successfully. A POST to the same session returned:

```json
{"code":"session_stranded","error":"This session is no longer available.","ok":false,"eveVersion":"0.82.0"}
```

The response was HTTP 409, before sandbox access. Eve only continues a
session on the Eve version that started it unless its World declares
`deploymentAffinity`. The World in this run did not. Carrying sandbox files
alone did not keep these sessions working. With an older World, start new
sessions after an Eve upgrade.

A new `0.83.0` Cloudflare World session ran bash successfully. A separate live
local World `0.83.0` run passed multi-step queue execution with two bash tools.
The same-version update below separately proved that sandbox files and a
queued task survived. It did not test an Eve upgrade.

## Eve 0.83.0 skill-update carry and queued task (2026-10-23)

With Eve `0.83.0`, explicit `JustBashSandbox`, and Cloudflare World `0.8.0`,
session `wrun_01M5M2HC2S9PDVHRGVD6HGM221` wrote `/workspace/carry-proof.txt`
containing `eden083-carry-marker`. At `09:47:55.770Z` it queued a durable
`delayed_marker` task with a `900000` ms delay. A skill was then added at
`agent/skills/carry-proof/SKILL.md`, and Eden redeployed the same target with
`ok: true`.

After the update, bash in the same session returned exit code 0 at
`10:02:57.283Z` with:

```text
eden083-carry-marker
post-update-bash-ok
```

The delayed task completed at `10:03:00.116Z`, after the update. A subsequent
bash call read `delayed-marker.txt`, returning `eden083-queued-across-update`
with exit code 0. This establishes same-version sandbox-file carry and
continuation of a pending durable queued task across a skill update for this
Cloudflare World setup.

The separate local World `0.83.0` run passed multi-step queue execution with
two bash tools. Postgres was not checked on `0.83.0`; the earlier proof
database expired and its environment file was deleted.

## Eve 0.91.0 and 1.0.0-rc.3 (2026-11-04)

Fresh `eve init` projects on both releases, with `just-bash`, an explicit
`JustBashSandbox` module, a bearer authenticator, and Cloudflare World `0.8.0`,
passed preflight, deployed, and ran a bash tool call in a live session
(`EDEN_RC3_BASH_OK` and `EDEN_091_BASH_OK`, exit code 0, turn completed). The
`0.91.0` env file also held `WORKFLOW_SPEC_VERSION=8` and a one-character value,
which failed deploys before 0.9.0.

Eve `1.0.0-rc.3` creates Workflow spec 9 runs by default, which need a World
capability Eden's Cloudflare World does not declare. That did not break the
live run: Eve creates runs at the World's declared spec version (8). Eve
`0.90.0` and later answer `GET /eve/v1/info` with 403 for non-operator
principals; Eden does not call it. Without a sandbox module, released Eden 0.8.0
deployed a `1.0.0-rc.3` project whose bash call then failed with
`DefaultSandbox has no sandbox provider for this build`.

## Compaction handoff on the Cloudflare World (2026-11-04)

After a compaction, Eve moves a session to a fresh workflow run so a long
session's run history stays bounded. Eve does this only when the World declares
`hookForceClaim` and `hookRetention`; Cloudflare World `0.9.0` and earlier
declare neither, so Eve logs `session handoff unavailable` and keeps one
growing run. Cloudflare World `0.10.0` declares both. It is built on
`@workflow/world` `5.1.0` and still creates spec 8 runs.

Live on Eve `1.0.0-rc.3`, both Worlds deployed, ran bash, compacted (HTTP 202),
and ran bash again (exit code 0):

| World | Owner run after compaction | Container log |
| --- | --- | --- |
| `0.9.0` | Unchanged (`wrun_01M6K7B2J727T8E8WAKFD854K3`) | `session handoff unavailable` |
| `0.10.0` | `wrun_01M6K7K2DTM3WT6JBDGM5M1DRF` → `wrun_01M6K7MAFH9E2274AGBN7F12MP` | No handoff warning |

The session ID (`wrun_01M6K7JEFSB77SZFHTN570S5ZP`), its stream, and its
channel address stayed the same, and the stream kept the earlier history. A
local `eve build` + `eve start` run on Eve `0.91.0` and `1.0.0-rc.3` against the
updated World also ran bash. Eve `0.68.0`–`0.82.0` were not run against it.
This run proved compaction handoff on one Eve version, not a move between
Eve versions. See [session behavior across Eve upgrades](#session-behavior-across-eve-upgrades).

## Eve 1.0.0-rc.6 atomic start Hooks (2026-11-06)

Eve `1.0.0-rc.6` claims a new session's channel address in the same step that
creates its workflow run, and refuses to start a session unless the World
declares `atomicStartHook`. Released Eden `0.11.0` with Cloudflare World
`0.11.0` passed preflight with no warnings and deployed a fresh `rc.6` project,
but `POST /eve/v1/session` returned HTTP 500 and the container logged:

```text
Error: The configured Workflow world does not support atomic start hooks, which eve needs to start a session. Use the local world, Vercel Workflow, or @workflow/world-postgres 5.1.1 or later.
```

The same release with the local World ran a session on `rc.6`: bash, Eve's new
default `edit_file` tool, and a non-zero exit reported to the model as
`[exit code: 7]`. After an in-place update the old session returned HTTP 409
`session_not_active` (the local World resets on update) and a new session ran
bash.

The updated Cloudflare World admits a session's run and its start Hook in one
Durable Object transaction and declares `atomicStartHook`. Through the client
RPC path it passes 27 cases of `@workflow/world` `5.1.0`'s atomic start hook
conformance suite; the 5 orphan-bound cases are skipped because they need a
candidate admitted without its run, which one transaction cannot leave behind.
Live on a fresh `rc.6` project with that World, a new session returned HTTP
202 and ran bash and `edit_file`; after a same-version update the session
continued (HTTP 202, same session ID, file intact) and a new session ran bash.
The container log had no atomic start hook error. Racing first messages to one
channel address were not tested: Eve's HTTP channel only addresses sessions by
ID.

Eve also says sessions from Eve before `0.83.0` can't move to `rc.6`, and
the Postgres World needs `@workflow/world-postgres` `5.1.1` or later.

## Eve 1.0.0-rc.6 with the Postgres World (2026-11-07)

Released Eden `0.11.4` passed preflight on a fresh `rc.6` project with
`@workflow/world-postgres` `5.0.5` and a Neon database, and the deployment
answered health checks, but `POST /eve/v1/session` returned HTTP 500. The
same image run locally logged the atomic start hook error above. Eden now
fails `EVE_WORLD_PAIRING` before deploying when Eve needs atomic start hooks
and the Postgres World is older than `5.1.1`. `5.1.0` declares the capability
but reads `start({ hook })`, while Eve passes `experimental_hook`, which
`5.1.1` reads.

With `5.1.1`, live on Cloudflare: a new session replied and ran bash, which
wrote a file; after a same-version in-place update the same session (same
ID) read the file back; a new session ran after the update; destroy left the
URL returning 404.

## Sandbox resume compatibility

Eden's temporary [eve#4440](https://github.com/vercel/eve/issues/4440) patch
recognizes the exact published binding hashes for Eve `0.68.0`, `0.71.2`,
`0.72.1`, and `0.79.1`; Eve `0.80.1`, `0.81.0`, and `0.82.0` ship the same
binding as `0.79.1`. Recognizing a hash is not a claim that every release
passed the complete live gate.

- `0.68.0`, `0.71.2`, and `0.72.1` expose a prepared `templateRootPath`;
  session creation accepts the prepared artifact.
- `0.79.1` exposes a prepared `templateKey`; session creation accepts the
  template directory resolved with Eve's own `resolveTemplateRootPath`.
  Its original `resume()` still has the upstream generation-mismatch bug.

Both replacements enforce the original sessions-directory containment,
recreate a missing root from the current template, and refresh authored
`$HOME/.agents/skills` on a template-generation change without overwriting
user workspace files. The prepared cache and session directory remain
`.eve/sandbox-cache/just-bash/{templates,sessions}` in Eve `0.79.1`, so no
runtime storage-path migration is necessary. An unknown binding hash remains
unpatched and prints `! EVE_SANDBOX_RESUME_PATCH`; recognized bindings print
`✓ EVE_SANDBOX_RESUME_PATCH`.

Eve `0.83.0` and later stable releases include the upstream fix
(vercel/eve#5132). Eden leaves those bindings unchanged and reports
`✓ EVE_SANDBOX_RESUME_PATCH — not needed`. A prerelease of `0.83.0` still
uses the older checksum-based decision.

## Fresh Eve 0.79.1 launch gate (2026-10-15)

The fresh initializer project used Eve `0.79.1`, AI SDK `7.0.140`,
just-bash `3.6.0`, pnpm `11.21.0`, Node `24.17.0`,
`alibaba/qwen3.7-flash` with a 32,000-token logical model window, and a bearer
authenticator backed by an owner-readable environment file outside the repo.
The full persistence proof uses `@moinulmoin/eden-world-cloudflare@0.7.0`:
the default local World cannot preserve the conversation itself across an
image update.

The published Eden `0.7.0` baseline deployed Eve `0.79.1` but printed
`! EVE_SANDBOX_RESUME_PATCH`. Its real bash call wrote and read `base-1`;
`ls ~/.agents/skills` returned exit code 2 because the untouched scaffold
has no authored skills directory. The local CLI's recognized patch instead
prints `✓ EVE_SANDBOX_RESUME_PATCH`.

An update exposed a separate native-container runtime issue: a resident
Durable Object can keep its old Worker code/environment while its container
monitor remains active. New outer-Worker generation headers alone are not
proof of a new image. The deployment health gate correctly refused promotion
(`DEPLOY_INDETERMINATE`), and even a brand-new conversation still saw the
old skill. The fixed runtime rejects a mismatched deployment before
forwarding, resets the stale object, and retries the bodyless request once.
Body-bearing requests synchronize through the same bodyless health path
before forwarding the original stream exactly once, without cloning it.
The existing image reconciliation, sandbox carry, and
`x-eden-eve-started-deployment` health gate then prove the new image.

The awake update printed `✓ updated`; the original conversation read its
preserved `launch-proof-file` and skill marker `EDEN_LAUNCH_SKILL_V2`
(exit code 0, empty stderr). A new conversation independently read V2.

The next update started with zero Container instances at `09:33:00Z`, and
the read-only inventory still showed zero at `09:34:00Z` during the build.
It also printed `✓ updated`. At `09:36:24Z`, the same conversation read
`launch-proof-file` and `EDEN_LAUNCH_SKILL_V3` with exit code 0 and empty
stderr; a new conversation independently read V3.

The sleep/schedule fixture uses `EDEN_EVE_CONTAINER_SLEEP_AFTER=90s` and
`*/10 * * * *`, not every three minutes: Eden's four-minute wake lead
intentionally keeps a three-minute schedule continuously awake. The first
multi-update attempt observed delayed Cron propagation and no ticks yet;
the original conversation nevertheless read its file and V3 skill again
after sleep at `09:51:33Z` (exit code 0).

A separate fresh initializer project was then deployed once, without further
updates, as `eden-launch-sched-proof`. Deployment completed at
`10:08:58.092Z`; the first Cron invocation was observed at `10:25:46.003Z`
(16 minutes 47.911 seconds later). Only read-only Container inventory was
queried while waiting; there were no external HTTP requests to the agent
between deployment and the final evidence read at `10:41:10Z`.

The persisted schedule records contain exactly one tick at `10:30:00.019Z`
and exactly one at `10:40:00.011Z`. Between them:

- The native host's idle-sleep alarm ran at `10:33:15Z`, 90 seconds after the
  preceding Cron health wake.
- `wrangler containers list --json` showed zero instances at
  `10:33:57.246Z`, `10:34:59.690Z`, and `10:36:02.476Z`.
- The next due Cron wake ran at `10:36:45Z`. At `10:41:14.994Z` the evidence
  tool reported process uptime `266.471219656` seconds, placing the new
  server process start at approximately `10:36:48.523Z`, before the next tick.

The inventory command also reported zero instances during active execution
with `durable_object` scheduling, so its count alone is not a reliable wake
signal. The sleep alarm, restarted-process uptime, and persisted consecutive
tick records provide the additional sleep/wake evidence. The disposable
observer's stricter `instances > 0` wake assertion therefore failed despite
these verified behavior criteria; no runtime change was needed.

This fresh proof also exposed a publication deadline problem: Cloudflare
image preparation consumed almost all of Wrangler's former 120-second
budget, leaving a placeholder Worker. Publication now gets 600 seconds;
other Wrangler operations retain their previous deadlines. Retrying that
partial target failed closed with `VAL-CLI-007-TARGET-CONFLICT`; it was
destroyed before the successful fresh-target proof.

Cloudflare reported an active
[Western Europe Durable Objects incident](https://www.cloudflarestatus.com/incidents/wvzqdm21spz0);
its relation to the observed propagation and image-preparation delays is
unproven.

All five disposable targets (`eden-launch-base`, `eden-launch-latest`,
`eden-launch-proof`, `eden-launch-sched`, and `eden-launch-sched-proof`) were
removed with `eden destroy`, including the incomplete placeholder
publication and both repositories retained by the earlier indeterminate
update. All former origins returned HTTP 404; the final
`wrangler containers list --json` and registry image query filtered by
`eden-launch` both returned `[]`. The final build, typecheck, ESLint with
zero warnings, and all 284 tests passed.

## Fresh Eve 0.81.0 launch run (2026-10-19)

Eve `0.80.1` and `0.81.0` shipped after Eden `0.7.1`. Both releases' just-bash
binding has the same sha256 as `0.79.1`
(`ab8b1ad7398af8f6fd2a1e91eb0d1ff8d2b9b9afe1836234f36ce0e896791c45`), so the
temporary eve#4440 fix applies unchanged. Fresh initializer projects for both
passed `eden preflight` (published `0.7.1` for `0.80.1`, the `0.7.2` build for
`0.81.0`).

The live run used the published `@moinulmoin/eden@0.7.2` on a fresh
`npx eve@0.81.0 init my-eve-agent --non-interactive` project: AI SDK
`7.0.143`, just-bash `3.6.0`, pnpm `11.21.0`, Node `24.17.0`,
`alibaba/qwen3.7-flash` with a 32,000-token logical model window, and a bearer
authenticator backed by an owner-readable environment file outside the repo,
on the default local Workflow World.

- `eden deploy` printed `✓ EVE_SANDBOX_RESUME_PATCH` and
  `✓ deployed my-eve-agent-9e510242 (preview) · eve 0.81.0` in 215 seconds.
- `/eve/v1/health` returned `ready`; unauthenticated `/eve/v1/info` returned
  401.
- `eve remote invoke` with the bearer returned a completed model reply in
  about 6 seconds, and a second turn's `bash` tool call returned
  `launch-day`.
- After adding a sign-off rule to `agent/instructions.md`, the same
  `eden deploy` printed `✓ updated` in 194 seconds on the same URL, and the
  next reply followed the new instruction.
- `eden destroy` removed the Worker, Container application, and registry
  repository in 31 seconds; the origin returned 404 and
  `wrangler containers list` reported no containers.

The run's captured output is the source of the landing-page terminal and
`docs/assets/eden-deploy.gif`.

## Fresh Eve 0.82.0 preflight (2026-10-22)

Eve `0.82.0`'s just-bash binding has the same sha256 as `0.79.1`–`0.81.0`
(`ab8b1ad7398af8f6fd2a1e91eb0d1ff8d2b9b9afe1836234f36ce0e896791c45`), so the
temporary eve#4440 fix applies unchanged. A fresh
`npx eve@0.82.0 init my-agent --non-interactive` project, converted to pnpm
`11.21.0` with `just-bash` `3.6.0` using the setup documented at that time, passed
`eden preflight` with the published `@moinulmoin/eden@0.7.3` in 74 seconds:
frozen install, Eve build, `✓ EVE_SANDBOX_RESUME_PATCH`, linux/amd64 image
boot and health, and read-only Cloudflare access. This pnpm run did not include
a live deploy; the later npm launch run below did.

The upstream fix for eve#4440 (vercel/eve#5132) merged after `0.82.0` and
shipped in Eve `0.83.0`.

## Fresh Eve 0.82.0 npm launch run (2026-10-22)

A fresh `npx eve@0.82.0 init <name> --non-interactive` project retained its
generated v3 `package-lock.json` and no `packageManager` declaration. No
conversion to pnpm was performed.

- Pristine preflight failed after 16 seconds, reporting
  `EVE_JUST_BASH_MISSING`, `EVE_AUTH_SCAFFOLD`, and `EVE_WORLD_LOCAL`, plus the
  missing-`just-bash` build remediation.
- After `npm install just-bash@3.6.0`, bearer authentication, and model
  `alibaba/qwen3.7-flash` with `modelContextWindowTokens: 32000`, preflight
  passed in 74 seconds and deployment completed in 174 seconds.
- The deployed `eden-npm-1022.moinulislammoin2019.workers.dev` returned health
  HTTP 200 and unauthenticated info HTTP 401. An authenticated session returned
  HTTP 202 and streamed a real model reply: `message.completed` containing
  `EDEN_NPM_LIVE_OK`, followed by `turn.completed`.

This run used the default local Workflow World. `eden destroy` completed in
42 seconds and verified deletion of the Worker, Container application, and
registry repository. Independent checks returned HTTP 404 from the former
health URL, `No containers found.` from `wrangler containers list`, and
Cloudflare code `10007` (Worker does not exist) from `wrangler deployments list`.

The unchanged pnpm compatibility fixture (Eve `0.68.0`, pnpm `11.21.0`) also
passed preflight in 65 seconds, including frozen install, Linux/amd64 runtime
boot and health, and read-only Cloudflare target checks.

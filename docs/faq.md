# FAQ

Short answers to the questions people ask most. Each links to the page with
the details.

## Plans and cost

### Does it run on the Cloudflare free plan?

No. Cloudflare Containers need the Workers Paid plan ($5/month). That is the
only plan requirement.

### What does it cost to run?

The Workers Paid plan, plus Cloudflare's usage pricing for the container while
it is awake. Eden runs a `standard-1` container (1/2 vCPU, 4 GiB) per
deployment and puts each instance to sleep independently after 1 hour without
requests, never during an in-flight delivery or transfer. A sleeping container
is not billed. Affinity can retain several images and instances until old
sessions end. An agent with schedules also gets one Cron Trigger invocation
per minute (about 43,000 a month), which is well inside the Workers Paid
allocation. See Cloudflare's
[Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
for current rates.

## Your project

### Do I have to change my Eve code?

Not your agent code. The project does need:

- npm with one root `package-lock.json`, or pnpm with an exact
  `packageManager: "pnpm@..."` pin and matching `pnpm-lock.yaml`; no mixed lockfiles
- `just-bash` as a production dependency (`npm add just-bash` or `pnpm add just-bash`); a fresh
  `eve init` project does not include it
- on Eve `0.83.0` and later, an explicit `JustBashSandbox` module; the production
  default has no provider in Eden's builder and does not fall back to `just-bash`
- a real [Eve authenticator](https://eve.dev/docs/guides/auth-and-route-protection);
  the generated Vercel and localhost ones do not grant access on Cloudflare

The README's
[fresh project steps](../README.md#starting-from-a-fresh-eve-project) cover
the setup, including the sandbox module.

### Which Eve versions work?

Eden has been deployed live with Eve `0.68.0`, `0.79.1`, `0.81.0`, `0.82.0`,
`0.83.0`, `0.91.0`, and `1.0.0-rc.3`. The `0.83.0` Cloudflare World run
preserved sandbox files and a queued task across a same-version skill update.
With an updated Cloudflare World declaring `deploymentAffinity`, Eve
upgrades keep existing sessions working. Update both the CLI and the World
package. Older Worlds still warn that upgrades can return `session_stranded`. See
[Eve compatibility](./eve-compatibility.md).

### Are npm, Bun, or Windows supported?

npm projects deploy as-is using frozen `npm ci` installs; no pnpm conversion is
needed. Exact-pinned pnpm projects are also supported. Eden runs on Node
`>=24.17.0` on macOS and Linux; Bun project lockfiles and native Windows are not
supported. Bun can install the Eden CLI, but Eden itself runs on Node.

`.npmrc` is excluded from build layers. Private registries and installs requiring
project `.npmrc` configuration are not supported.

## Secrets and safety

### Are my env-file secrets baked into the image?

No. The image is built without them, and your env file, any `.env*` file, and
credential files such as `.npmrc` and `*.pem` are left out of the project
copy. Each value is uploaded as a Worker secret and handed to the container as
an environment variable when it starts. See [Security](./security.md).

### Who can reach my agent?

Anyone with the `workers.dev` URL can send requests, so your Eve
authenticator is what protects it. Eden blocks Eve's internal queue routes
from the outside. See [What is public](./security.md#what-is-public).

## Running it

### How long does a deploy take?

In the last full live run (Eve `0.81.0`, a fresh project): first deploy 215
seconds, an update 194 seconds, destroy 31 seconds. Most of a deploy is
building the Linux/amd64 image. `eden preflight` on Eve `0.82.0` took 74
seconds.

### How fast does a sleeping agent wake up?

About 10–15 seconds, mostly Eve's server starting. The container itself starts
in about a second. See [Sleep and wake](./how-it-works.md#sleep-and-wake).

### Do schedules run while the agent sleeps?

Yes, for standard 5-field cron expressions: a Cloudflare Cron Trigger wakes
the container in time. During an Eve upgrade, a scheduled job can fire on
both versions until the old version finishes its running work and file
transfers. Eden then stops its schedules. Other expressions only run while
the container is awake. See
[Schedules](./how-it-works.md#schedules).

### Does my data survive sleep and updates?

Files the agent writes survive sleep. Same-version updates carry conversation
sandbox files (up to 1 GiB compressed); Eve's default local Workflow World
resets. With the updated Cloudflare World, sessions keep their ID, history,
and sandbox files across Eve upgrades. Interrupted file transfers can be
retried without overwriting active files. Postgres also provides durable
state across updates.
See [Where your data lives](./how-it-works.md#where-your-data-lives).

### How do I ship a change?

Run the same `eden deploy` again, with the same `--env-file`. The public URL
stays the same. The same Eve version updates in place, so running work uses
the new code. Keep code and state backward-compatible.

With a World declaring `deploymentAffinity`, a new Eve version keeps the old
one running. Existing sessions move on their next message; idle sessions
move without a message. Running work finishes on the old version.

### Why is an old version still kept after a session moves?

A session's first run stays on its original version until the session ends,
so that version is kept. Sessions adopted from Eden `0.9.0` stay on the old
version until they end and do not move to the new one.

A later deploy removes old versions once their sessions end and their
queued work and file transfers finish. Inactive Cloudflare instance records
can remain until destroy. Eden keeps at most 10 versions, including current
and legacy. If cleanup cannot make room, deploy refuses and lists the
blocking versions and live session counts. There is no override flag.

### Can I deploy from CI or another machine?

`--json` gives scripts a machine-readable result, and any machine with Docker,
Node, and Wrangler access can deploy. Updating or destroying an existing
target needs the deployment records Eden wrote under `.eden/eve-deploy/` on
the machine that created it; without them Eden refuses to touch the target
rather than guess.

### How do I remove everything?

```sh
eden destroy --name <target>
```

It deletes exactly the Worker, Container application, **every retained
container instance and image**, and all registry repositories Eden created
for that target, including legacy deployments, then checks they are gone.
Destroy also removes sessions still running. Your Postgres database, if you
use one, is not touched.

## Compared to other setups

### Why no real Linux sandbox with python and git?

Eve prepares its sandbox during `eve build`. Eden's builder has no Docker
daemon, and Eden supports only `just-bash`, a simulated shell. On Eve `0.83.0`
and later, [select it explicitly](./deploy.md#sandbox-setup); the production
default no longer falls back to it.

Older Eve releases could select microsandbox when `/dev/kvm` was visible.
Eden hides that device in its builder to keep their existing `just-bash`
selection. Historical microsandbox preparation inside a Cloudflare container
added about 7 minutes per deploy in testing; that is not an available provider
on Eve `0.83.0`, which removed microsandbox.

### How is this different from running on Vercel?

It is the same Eve app, built by your own `eve build`. The differences:

- the sandbox is `just-bash`, not Vercel Sandbox
- Eve upgrades keep old versions for existing sessions; same-version updates
  still run in-flight work on new code. Older Worlds without
  `deploymentAffinity` do not keep old versions
- a sleeping agent takes 10–15 seconds to wake
- one instance per kept version, up to 10 versions, `workers.dev` URL only,
  no custom domains yet

### Why not just run `eve start` on a server?

You can; Eve supports self-hosting. Eden is the Cloudflare part: building and
publishing the container, sleep and wake with disk snapshots, carrying
conversations across updates, waking for schedules, and exact cleanup.

Return to the [documentation index](./README.md).

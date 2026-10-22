# FAQ

Short answers to the questions people ask most. Each links to the page with
the details.

## Plans and cost

### Does it run on the Cloudflare free plan?

No. Cloudflare Containers need the Workers Paid plan ($5/month). That is the
only plan requirement.

### What does it cost to run?

The Workers Paid plan, plus Cloudflare's usage pricing for the container while
it is awake. Eden runs one `standard-1` container (1/2 vCPU, 4 GiB) per agent
and puts it to sleep after 1 hour without requests; a sleeping container is
not billed. An agent with schedules also gets one Cron Trigger invocation per
minute (about 43,000 a month), which is well inside the Workers Paid
allocation. See Cloudflare's
[Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
for current rates.

## Your project

### Do I have to change my Eve code?

Not your agent code. The project does need:

- pnpm, with an exact `packageManager: "pnpm@..."` pin and a `pnpm-lock.yaml`
- `just-bash` as a production dependency (`pnpm add just-bash`); a fresh
  `eve init` project does not include it
- a real [Eve authenticator](https://eve.dev/docs/guides/auth-and-route-protection);
  the generated Vercel and localhost ones do not grant access on Cloudflare

The README's
[fresh project steps](../README.md#starting-from-a-fresh-eve-project) cover
all three.

### Which Eve versions work?

Eden has been deployed live with Eve `0.68.0`, `0.79.1`, and `0.81.0`, and Eve
`0.82.0` passes `eden preflight`. See
[Eve compatibility](./eve-compatibility.md).

### Are Bun, npm, or Windows supported?

Not yet. Eden needs a pnpm project, runs on Node `>=24.17.0`, and supports
macOS and Linux. Bun can install the Eden CLI, but Eden itself runs on Node.

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
the container in time. Other expressions only run while the container is
awake. See [Schedules](./how-it-works.md#schedules).

### Does my data survive sleep and updates?

Files the agent writes survive sleep. On an update, every conversation's
sandbox files are carried over (up to 1 GiB compressed); Eve's default local
Workflow World resets. For durable sessions and approvals across updates, use
the [Postgres World](./deploy.md#durable-state-postgres-world). The full
picture is in [Where your data lives](./how-it-works.md#where-your-data-lives).

### How do I ship a change?

Run the same `eden deploy` again, with the same `--env-file`. Eden updates the
target in place: same URL, new code.

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

It deletes exactly the Worker, Container application, and registry images
Eden created for that target, then checks they are gone. Your Postgres
database, if you use one, is not touched.

## Compared to other setups

### Why no real Linux sandbox with python and git?

Eve prepares its sandbox during `eve build`. A real Linux sandbox
(microsandbox or Docker) needs KVM or a Docker daemon on the build machine,
and Eden's builder has neither, so agents get Eve's `just-bash`, a simulated
shell. microsandbox does run inside a Cloudflare container, but preparing it
there added about 7 minutes to every deploy in testing, so Eden does not use
it yet.

### How is this different from running on Vercel?

It is the same Eve app, built by your own `eve build`. The differences:

- the sandbox is `just-bash`, not Vercel Sandbox
- runs are not pinned to the deployment that started them, so in-flight runs
  continue on new code after an update
- a sleeping agent takes 10–15 seconds to wake
- one container per agent, `workers.dev` URL only, no custom domains yet

### Why not just run `eve start` on a server?

You can; Eve supports self-hosting. Eden is the Cloudflare part: building and
publishing the container, sleep and wake with disk snapshots, carrying
conversations across updates, waking for schedules, and exact cleanup.

Return to the [documentation index](./README.md).

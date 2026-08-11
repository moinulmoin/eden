# Eden

Eden is a small, Cloudflare-native durable agent framework. This repository contains
the first vertical slice: filesystem-first authoring, a Node-side compiler, a
Worker-safe generated bundle, one authenticated Worker host, one SQLite-backed
`EdenSession` Durable Object, a bounded model/tool/final-response turn, and an
NDJSON journal stream.

The supported command surface is intentionally frozen at four commands:
`eden init`, `eden build`, `eden dev`, and `eden deploy`. The command names below
are the complete CLI surface for this milestone. No other Eden command is implied.

## Setup

The repository is a pnpm workspace with TypeScript project references. The
local gate is reproducible without Turbo and without a remote deployment.

Requirements:

- Node `24.17.0` (the version in `.nvmrc`)
- pnpm `11.21.0` through Corepack
- Wrangler `4.120.0`, installed by the frozen lockfile

From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm exec tsc -b --pretty false
corepack pnpm exec eslint . --max-warnings 0
corepack pnpm exec vitest run --maxWorkers=1
```

The checks above are the milestone gate. They are reproducible without
Turbo and without a remote deployment.

After `corepack pnpm run build`, invoke the local CLI entry point with:

```sh
node packages/cli/dist/index.js --help
```

In the walkthrough below, `eden` means that same built entry point. Run this
from the repository root; the direct path keeps project-root and workspace
dependency resolution stable without installing a global binary:

```sh
eden() {
  node packages/cli/dist/index.js "$@"
}
```

## Supported CLI

### `eden init`

`eden init` creates a minimal project only in an empty selected directory. It
writes:

```text
agent/instructions.md
agent/agent.ts
agent/tools/greet.ts
package.json
wrangler.jsonc
```

Tool identity is derived from the tool path, so the scaffold discovers `greet`
without a registration file. `init` does not create `.env`, `.dev.vars`, or any
secret file, and it never overwrites an existing root.

Use `--project <path>` to select a root explicitly. Without it, Eden uses the
current working directory exactly. It does not search parent or sibling
directories.

### `eden build`

`eden build` discovers and validates the selected project, normalizes the agent
and tools, creates one coherent `.eden/` generation, and runs Wrangler's
compatibility dry-run. A successful build produces inspectable artifacts:

```text
.eden/discovery.json
.eden/diagnostics.json
.eden/manifest.json
.eden/module-map.json
.eden/agent-bundle.mjs
.eden/build-metadata.json
```

The manifest, module map, bundle digest, and build metadata describe one
generation. A failed build is not promoted over the last coherent generation.
The command validates compatibility only; it does not deploy.

### `eden dev`

`eden dev` builds before starting the local Worker and watches the authored
`agent/` tree for coherent rebuilds. It uses only:

- Worker: `http://127.0.0.1:8797`
- Wrangler inspector: `127.0.0.1:9297`

It refuses occupied approved ports and does not use or stop ports `8787` or
`8800`. The CLI tracks only the child process it starts. Stop that owned
process with `Ctrl-C`; do not kill arbitrary listeners by port or process name.

The local runtime fails closed unless `EDEN_BEARER_SECRET` is set in the
invoking environment. Eden passes that value to Wrangler without putting it in
the project, generated artifacts, or normal output. Keep the value outside the
repository and never paste it into a command transcript.

### `eden deploy`

`eden deploy` accepts only `--env preview` and `--env production`. If `--env`
is omitted, the target is `preview`; production must be explicit.
The command builds the selected generation, verifies its artifact identity,
runs an environment-specific Wrangler compatibility dry-run, provisions
`EDEN_BEARER_SECRET` through Wrangler stdin, deploys the generated runtime
wrapper and bundle, waits for edge and Durable Object propagation, and validates
authenticated health, generation metadata, session creation, cursor reconnect,
the live `eden-dev` model/tool/final turn, and the expected lifecycle.

Set `EDEN_BEARER_SECRET` outside the project and pass a unique `--name` for
temporary validation:

```sh
export EDEN_BEARER_SECRET="$(node -e 'process.stdout.write(`eden-gate-${require("crypto").randomBytes(24).toString("hex")}`)')"
eden deploy \
  --project "$PROJECT_ROOT" \
  --env preview \
  --name "eden-gate-preview-$(date +%s)"
```

The secret is never placed in an argument, URL, artifact, or normal output.
Successful deployment output includes the selected generation ID and reachable
Worker URL. A deployment failure is reported separately from compatibility,
propagation, authentication, lifecycle, model, and cleanup failures.

If a validation harness provisions the secret separately instead of using
`eden deploy`, the pinned Wrangler command must remain explicitly scoped to the
same unique Worker:

```sh
printf '%s' "$EDEN_BEARER_SECRET" |
  corepack pnpm exec wrangler secret put EDEN_BEARER_SECRET \
    --name "$WORKER_NAME" --config "$PROJECT_ROOT/wrangler.jsonc"
```

Keep `--env` off these name-scoped secret commands intentionally. In Wrangler
4.120, adding `--env` selects an environment-suffixed Worker rather than the
exact unique Worker named by `--name`.

## Clean-room local validation

The following walkthrough uses only the repository checkout and the approved
local ports. Create a temporary root whose contents are disposable and known
to be validator-generated:

```sh
PROJECT_ROOT="$(mktemp -d)"
eden init --project "$PROJECT_ROOT"
eden build --project "$PROJECT_ROOT"
```

Check that the generated root contains the five scaffold entries and `.eden/`
after the build. There must be no `.env`, `.dev.vars`, bearer value, raw
Durable Object identifier, or secret file.

In one terminal, set `EDEN_BEARER_SECRET` to a local value held outside the
project and start development:

```sh
export EDEN_BEARER_SECRET
eden dev --project "$PROJECT_ROOT"
```

In another terminal, use the same environment value for authenticated requests.
Every route is protected:

```sh
curl --fail --silent \
  -H "Authorization: Bearer ${EDEN_BEARER_SECRET}" \
  http://127.0.0.1:8797/eden/v1/health

curl --fail --silent \
  -H "Authorization: Bearer ${EDEN_BEARER_SECRET}" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{}' \
  http://127.0.0.1:8797/eden/v1/session
```

The session response contains an opaque `sessionId`. Submit one message, then
read the durable stream:

```sh
curl --fail --silent \
  -H "Authorization: Bearer ${EDEN_BEARER_SECRET}" \
  -H "Content-Type: application/json" \
  -X POST \
  -d '{"message":"Say hello to Eden."}' \
  "http://127.0.0.1:8797/eden/v1/session/<session-id>"

curl --fail --silent \
  -H "Authorization: Bearer ${EDEN_BEARER_SECRET}" \
  "http://127.0.0.1:8797/eden/v1/session/<session-id>/stream?startIndex=0&follow=false"
```

Save the greatest committed `streamIndex` from the NDJSON response. To
reconnect, use it as the last accepted cursor:

```sh
curl --fail --silent \
  -H "Authorization: Bearer ${EDEN_BEARER_SECRET}" \
  "http://127.0.0.1:8797/eden/v1/session/<session-id>/stream?startIndex=<last-stream-index>&follow=false"
```

`startIndex=0` replays from the beginning. A positive `startIndex` resumes
strictly after that cursor. A disconnected stream does not cancel an accepted
turn; reconnect from the saved absolute cursor and verify that committed
events are ordered and the session reaches `session.waiting`.

The required successful lifecycle is visible in the journal:

```text
session.started
turn.started
message.received
step.started
actions.requested
action.result
step.completed
step.started
message.completed
step.completed
turn.completed
session.waiting
```

Finish local validation by sending `Ctrl-C` to the `eden dev` process, confirming
that ports `8797` and `9297` are no longer listening, and removing only the
temporary root created by this walkthrough.

For the complete serial local conformance gate, run this repository-owned
validator after the frozen install:

```sh
corepack pnpm run conformance:local
```

It creates and removes its own empty temporary root, runs the documented
`init` → `build` → `dev` → authenticated session flow, disconnects after the
first committed cursor and reconnects through `session.waiting`, then runs the
deterministic Workers-pool fixtures for Durable Object eviction/replay,
completed-effect reuse, invalid tool input, interrupted-step recovery, journal
delivery replay, and typed-client cursor safety. The validator runs serially,
uses only `127.0.0.1:8797` and `127.0.0.1:9297`, keeps its generated bearer
outside the project and captured output, and verifies that its process, ports,
and temporary root are removed.

## Deployed validation

An authorized remote validation uses a unique temporary Worker name and an
isolated environment target. The repository-owned flow is:

1. Build the exact generation that passed local validation.
2. Run `eden deploy --env <environment> --name <unique-worker-name>` with
   `EDEN_BEARER_SECRET` held only in the invoking environment. `eden deploy`
   supplies the secret to Wrangler through stdin.
3. Poll the Worker until unauthenticated health fails closed and authenticated
   health, info, session creation, and the Durable Object namespace are ready.
4. Run authenticated command, NDJSON cursor-reconnect, and live model/tool/final
   response checks through the `eden-dev` AI Gateway path.
5. Compare the remote tool identity, normalized shapes, lifecycle order, safe
   version metadata, and final-message contract with the local run.
6. Delete every validator-owned temporary Worker and secret, then verify that
   the URL is unreachable and the temporary secret/resource entries are absent.

Preview and production use separate Worker and Durable Object namespace targets.
Never use production as an implicit temporary target, and never delete shared
production resources during cleanup. For a temporary Worker named explicitly
with `--name`, Wrangler 4.120 cleanup is:

```sh
corepack pnpm exec wrangler secret delete EDEN_BEARER_SECRET \
  --name "$WORKER_NAME" --config "$PROJECT_ROOT/wrangler.jsonc"
corepack pnpm exec wrangler delete "$WORKER_NAME" \
  --env "$ENVIRONMENT" --config "$PROJECT_ROOT/wrangler.jsonc" --force
```

Run both commands only for resources owned by that validation. Secret deletion
does not accept `--force` in the pinned Wrangler version. When `--name`
selects an explicit Worker, keep the secret commands name-scoped and omit
`--env`; adding an environment there targets a suffixed Worker name.

## Authentication and request boundaries

- Every implemented route requires `Authorization: Bearer ...`.
- Missing, empty, or invalid credentials fail closed before session lookup.
- The server resolves the fixed test principal; callers cannot choose a
  principal, tenant, session owner, or platform locator in the body or headers.
- Session IDs and event IDs are opaque. A session ID is not authorization by
  itself.
- Session creation accepts `{}`. Commands accept only
  `{ "message": string }`.
- Request JSON is bounded to a nesting depth of 32. Create requests are
  limited to 1 KiB, command requests to 32 KiB, and messages to 16 KiB.
- NDJSON uses `application/x-ndjson`; each event has a persisted absolute
  cursor, opaque event ID, type, bounded data, and commit timestamp.

Do not put credentials, bindings, provider clients, full prompts, complete
transcripts, or unbounded model/tool payloads in source, tests, events, logs,
or documentation.

## Architecture boundaries

```text
agent/ source tree
  -> Node-only Eden compiler
  -> .eden manifest and Worker-safe bundle
  -> Cloudflare Worker HTTP host
  -> EdenSession SQLite Durable Object
  -> Workers AI through the eden-dev AI Gateway
```

- The compiler owns filesystem discovery, path-derived tool names,
  normalization, diagnostics, manifest generation, and static bundling. It
  never runs inside the Worker.
- The Worker host owns authentication and routing, not canonical session state.
- `EdenSession` is the sole journal and state-transition authority. SQLite
  commits precede NDJSON delivery, model advancement, and tool-result
  advancement.
- The model adapter keeps Workers AI, AI Gateway, and binding details behind
  Eden-owned contracts.
- The typed client stores only the opaque session ID and last accepted
  absolute cursor. Transport connection state is not durability.
- Durable Object alarms are bounded, at-least-once recovery support, not a
  general scheduler or workflow engine.

The local workerd/runtime filesystem is not a project filesystem or security
sandbox. Source discovery and compilation happen in Node, and the Worker
receives static artifacts only.

## Compatibility findings

Eden uses Eve as a research and selective-derivation reference. The pinned Eve
reference is package `0.31.3` at commit
`0b102bc90e7cf2c3e294f6ca3af86c307d449b1a`. Portable agent-definition,
protocol, reducer, cursor, normalization, and lifecycle concepts were
re-derived into Eden-owned contracts and tested at the Worker boundary.

The unmodified Eve compiler and full model/tool harness do not run unchanged in
`workerd`: they depend on Node package-location behavior and `node:vm`
assumptions, while Workers exposes `node:vm` only as a non-functional
compatibility stub. Eden therefore keeps compilation in Node and deploys a
static Worker-safe generated module bundle with extracted pure helpers.

## Provisional limits

This milestone proves one narrow use case:

- one filesystem agent
- one typed tool
- one durable session
- one bounded model/tool/final-response turn
- two model steps at most for the turn
- at most three attempts for a recoverable logical step/job
- JSON-compatible bounded tool results and final content

External effects are not exactly-once unless the destination honors Eden's
stable idempotency coordinate. Alarms are at-least-once and bounded. Long
sleeps, approvals, external-event waits, extended retries, and dynamic hosted
bundles are future seams, not current guarantees. The local HTTP walkthrough
uses a deterministic bounded runtime fixture; `eden deploy` switches the same
generated bundle to the live Workers AI adapter and verifies remote parity
through the full bounded turn.

## Out of scope

Schedules, subagents, MCP, channels beyond the default HTTP/NDJSON surface,
dashboard UI, shell or filesystem tools, sandbox/container execution, R2,
D1, Queues, native Workflows, Dynamic Workers, Dynamic Workflows, broad
integrations, and hosted multi-tenant bundles are not implemented or implied
by this milestone.

## Cleanup

For local validation, stop only the `eden dev` process started by the current
walkthrough, verify `127.0.0.1:8797` and `127.0.0.1:9297` are free, and remove
only the known temporary project root. Do not use broad process-name or
port-kill commands.

For an authorized remote validation, remove only the unique Worker, bearer
secret, and other resources created by that run. Verify the deployment URL is
unreachable and resource/secret listings no longer contain the temporary
entries. Preserve shared preview or production resources.

## License and attribution

Eden is distributed under the Apache License, Version 2.0; see [`LICENSE`](./LICENSE).
The repository [`NOTICE`](./NOTICE) records the Eve reference, Apache
obligations, and the modified-derivative file markings. Eden does not include
unmodified third-party runtime code.

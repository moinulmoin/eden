# Eden Agent CLI

The Agent command surface is intentionally frozen beneath one namespace:
`eden agent init`, `eden agent build`, `eden agent dev`, and
`eden agent deploy`. No other Eden command is implied.

Start with [installation and account setup](./install.md).

## First successful local Agent

Create an empty project root, initialize it, and install the generated
dependencies:

```sh
mkdir my-agent
eden agent init --project ./my-agent
cd my-agent
corepack enable
pnpm install
```

`corepack enable` is a one-time machine setup. After it, use `pnpm` directly.
The generated project pins pnpm `11.21.0`.

The initial authoring tree is:

```text
agent/
├── agent.ts
├── instructions.md
└── tools/
    └── greet.ts
package.json
pnpm-workspace.yaml
wrangler.jsonc
```

Build one static Worker generation:

```sh
pnpm run build
```

A successful build creates `.eden/` and prints the selected generation. It does
not deploy anything.

### Start authenticated local development

The local Worker fails closed without a bearer secret. Keep the secret outside
the repository while sharing it between two terminals:

```sh
SECRET_FILE="${TMPDIR:-/tmp}/eden-agent-local-${USER}.secret"
umask 077
node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))' > "$SECRET_FILE"
export EDEN_BEARER_SECRET="$(cat "$SECRET_FILE")"
pnpm run dev
```

Leave this first terminal running. Eden prints a ready message after the initial
build and starts only:

- Worker: `http://127.0.0.1:8797`
- Wrangler inspector: `127.0.0.1:9297`

In a second terminal, enter the same project and load the same temporary value:

```sh
cd /absolute/path/to/my-agent
SECRET_FILE="${TMPDIR:-/tmp}/eden-agent-local-${USER}.secret"
export EDEN_BEARER_SECRET="$(cat "$SECRET_FILE")"
```

Verify authenticated health:

```sh
curl --fail --silent \
  --header "Authorization: Bearer $EDEN_BEARER_SECRET" \
  http://127.0.0.1:8797/eden/v1/health
```

Create a session:

```sh
SESSION_JSON="$(curl --fail --silent \
  --header "Authorization: Bearer $EDEN_BEARER_SECRET" \
  --header "Content-Type: application/json" \
  --request POST \
  --data '{}' \
  http://127.0.0.1:8797/eden/v1/session)"

SESSION_ID="$(printf '%s' "$SESSION_JSON" |
  node -e 'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(value).sessionId))')"
```

Send one message and read the committed NDJSON stream:

```sh
curl --fail --silent \
  --header "Authorization: Bearer $EDEN_BEARER_SECRET" \
  --header "Content-Type: application/json" \
  --request POST \
  --data '{"message":"Greet Ada."}' \
  "http://127.0.0.1:8797/eden/v1/session/$SESSION_ID"

curl --fail --silent \
  --header "Authorization: Bearer $EDEN_BEARER_SECRET" \
  "http://127.0.0.1:8797/eden/v1/session/$SESSION_ID/stream?startIndex=0&follow=false"
```

The stream should contain ordered lifecycle events and finish with the session
waiting for another command.

Stop only the `pnpm run dev` process in the first terminal with `Ctrl-C`. Then
remove the local secret file and clear both shell variables:

```sh
rm "$SECRET_FILE"
unset EDEN_BEARER_SECRET SECRET_FILE
```

## First preview deployment

Remote deployment uses Workers AI and requires the Cloudflare account selected
by `npx wrangler@4.120.0 whoami`.

From the generated project root, create a fresh secret and unique preview name:

```sh
export EDEN_BEARER_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
WORKER_NAME="my-agent-preview-$(date +%s)"
```

Deploy:

```sh
pnpm run deploy -- \
  --env preview \
  --name "$WORKER_NAME"
```

The command builds the selected generation, performs Wrangler compatibility
checks, writes the bearer through Wrangler stdin, deploys the Worker and Durable
Object binding, waits for propagation, and verifies authenticated health,
session creation, cursor reconnect, and one live model/tool/final turn.

Copy the exact printed `workers.dev` URL. After testing, delete only the Worker
and secret created with the unique name:

```sh
pnpm exec wrangler secret delete EDEN_BEARER_SECRET \
  --name "$WORKER_NAME" \
  --config "$PWD/wrangler.jsonc"
pnpm exec wrangler delete "$WORKER_NAME" \
  --env preview \
  --config "$PWD/wrangler.jsonc" \
  --force
unset EDEN_BEARER_SECRET
```

Keep `--env` off the name-scoped secret command. Wrangler otherwise targets a
different environment-suffixed name.

Confirm the printed URL is unreachable and compare the Cloudflare Workers list
before and after the run. Require zero new Worker, secret, or Durable Object
target residue associated with `WORKER_NAME`.

For the complete cursor-recovery and lifecycle checks, continue with
[Validation and cleanup](./validation.md).

## `eden agent init`

`eden agent init` creates a minimal project only in an empty selected
directory. It writes:

```text
agent/instructions.md
agent/agent.ts
agent/tools/greet.ts
package.json
pnpm-workspace.yaml
wrangler.jsonc
```

Tool identity is derived from the tool path, so the scaffold discovers `greet`
without a registration file. `init` does not create `.env`, `.dev.vars`, or any
secret file, and it never overwrites an existing root.

Use `--project <path>` to select a root explicitly. Without it, Eden uses the
current working directory exactly. It does not search parent or sibling
directories.

## `eden agent build`

`eden agent build` discovers and validates the selected project, normalizes
the agent and tools, creates one coherent `.eden/` generation, and runs
Wrangler's compatibility dry-run. A successful build produces inspectable
artifacts:

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

## `eden agent dev`

`eden agent dev` builds before starting the local Worker and watches the
authored `agent/` tree for coherent rebuilds. It uses only:

- Worker: `http://127.0.0.1:8797`
- Wrangler inspector: `127.0.0.1:9297`

It refuses occupied approved ports and does not use or stop ports `8787` or
`8800`. The CLI tracks only the child process it starts. Stop that owned
process with `Ctrl-C`; do not kill arbitrary listeners by port or process name.

The local runtime fails closed unless `EDEN_BEARER_SECRET` is set in the
invoking environment. Eden passes that value to Wrangler without putting it in
the project, generated artifacts, or normal output. Keep the value outside the
repository and never paste it into a command transcript.

## `eden agent deploy`

`eden agent deploy` accepts only `--env preview` and `--env production`. If
`--env` is omitted, the target is `preview`; production must be explicit.
The command builds the selected generation, verifies its artifact identity,
runs an environment-specific Wrangler compatibility dry-run, provisions
`EDEN_BEARER_SECRET` through Wrangler stdin, deploys the generated runtime
wrapper and bundle, waits for edge and Durable Object propagation, and validates
authenticated health, generation metadata, session creation, cursor reconnect,
the live Workers AI model/tool/final turn through the `default` AI Gateway, and
the expected lifecycle.

Set `EDEN_BEARER_SECRET` outside the project and pass a unique `--name` for
temporary validation:

```sh
export EDEN_BEARER_SECRET="$(node -e 'process.stdout.write(`eden-gate-${require("crypto").randomBytes(24).toString("hex")}`)')"
eden agent deploy \
  --project "$PROJECT_ROOT" \
  --env preview \
  --name "eden-gate-preview-$(date +%s)"
```

The secret is never placed in an argument, URL, artifact, or normal output.
Successful deployment output includes the selected generation ID and reachable
Worker URL. A deployment failure is reported separately from compatibility,
propagation, authentication, lifecycle, model, and cleanup failures.

The live model adapter uses Cloudflare AI Gateway gateway ID `default`. Cloudflare
creates that gateway on the first authenticated request when it does not already
exist; Eden does not provision a named gateway. See [Cloudflare's AI Gateway
getting-started guide](https://developers.cloudflare.com/ai-gateway/get-started/).

If a validation harness provisions the secret separately instead of using
`eden agent deploy`, the pinned Wrangler command must remain explicitly
scoped to the same unique Worker:

```sh
printf '%s' "$EDEN_BEARER_SECRET" |
  pnpm exec wrangler secret put EDEN_BEARER_SECRET \
    --name "$WORKER_NAME" --config "$PROJECT_ROOT/wrangler.jsonc"
```

Keep `--env` off these name-scoped secret commands intentionally. In Wrangler
4.120, adding `--env` selects an environment-suffixed Worker rather than the
exact unique Worker named by `--name`.

Eden resolves the effective target with Wrangler 4.120's pinned
`unstable_readConfig` parser from the immutable selected config snapshot.
JSONC comments and trailing commas are supported, and Wrangler's environment
overlay rules apply: preview may inherit and receive a preview suffix, while
production may override the name. A configured name selects the target only;
it is treated as shared and never grants destructive cleanup authority.

Only an explicit, unique `--name` authorizes remote compensation. On failure,
Eden may delete the provisioned secret, but it deletes the Worker only after a
deployment was attempted. Configured/shared targets are preserved and report
`REMOTE_CLEANUP_SKIPPED_UNOWNED` alongside the primary failure. If cleanup or
its ownership lease cannot settle, Eden reports `REMOTE_CLEANUP_TIMEOUT` or
`REMOTE_CLEANUP_LEASE_RETAINED` and retains the late operation, lock, and lease
residue for manual inspection and cleanup. Invalid Wrangler syntax fails closed
with actionable `PROJECT_CONFIG_INVALID`.

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
  -> Workers AI through Cloudflare AI Gateway `default`
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

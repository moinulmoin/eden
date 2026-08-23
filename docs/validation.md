# Validation runbook

## Clean-room local validation

The following walkthrough uses only the repository checkout and the approved
local ports. Create a temporary root whose contents are disposable and known
to be validator-generated:

```sh
PROJECT_ROOT="$(mktemp -d)"
eden agent init --project "$PROJECT_ROOT"
eden agent build --project "$PROJECT_ROOT"
```

Check that the generated root contains the five scaffold entries and `.eden/`
after the build. Eden may retain its hidden, root-contained
`.eden-init-provenance-*` ownership directory; it contains only internal
recovery state and is not a secret-bearing project file. There must be no
`.env`, `.dev.vars`, bearer value, raw Durable Object identifier, or secret
file.

In one terminal, set `EDEN_BEARER_SECRET` to a local value held outside the
project and start development:

```sh
export EDEN_BEARER_SECRET
eden agent dev --project "$PROJECT_ROOT"
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

Save the greatest committed `streamIndex` from the NDJSON response. A positive
cursor is the last accepted committed event, not the next event to request. To
reconnect, use it as that last accepted cursor:

```sh
curl --fail --silent \
  -H "Authorization: Bearer ${EDEN_BEARER_SECRET}" \
  "http://127.0.0.1:8797/eden/v1/session/<session-id>/stream?startIndex=<last-stream-index>&follow=false"
```

`startIndex=0` replays from the beginning. A positive `startIndex` resumes
strictly after that cursor. The executable local conformance flow deliberately
disconnects after committed cursor `5`, then reconnects with
`startIndex=5` and verifies cursors `6` through `12`. A disconnected stream
does not cancel an accepted turn; reconnect from the saved absolute cursor and
verify that committed events are ordered and the session reaches
`session.waiting`.

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

Finish local validation by sending `Ctrl-C` to the `eden agent dev` process,
confirming that ports `8797` and `9297` are no longer listening, and removing
only the temporary root created by this walkthrough.

For the complete serial local conformance gate, run this repository-owned
validator after the frozen install:

```sh
corepack pnpm run conformance:local
```

It creates and removes its own empty temporary root, runs the documented
`init` → `build` → `dev` → authenticated session flow, disconnects after
committed cursor `5` and reconnects through `session.waiting`, then runs one
deterministic public failure/recovery flow through the Workers pool. That flow
evicts and reconnects invalid tool input and interrupted-uncommitted sessions,
checks durable failure/retry state and no false success, and verifies a
completed effect replays with execution count `1`. The gate also runs the
journal-delivery and typed-client cursor fixtures. The validator runs
serially, uses only `127.0.0.1:8797` and `127.0.0.1:9297`, keeps its generated
bearer outside the project and captured output, and verifies that its process,
ports, and temporary root are removed.

## Deployed validation

An authorized remote validation uses a unique temporary Worker name and an
isolated environment target. The repository-owned flow is:

1. Build the exact generation that passed local validation.
2. Run `eden agent deploy --env <environment> --name <unique-worker-name>`
   with `EDEN_BEARER_SECRET` held only in the invoking environment. The command
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
uses a deterministic bounded runtime fixture; `eden agent deploy` switches
the same generated bundle to the live Workers AI adapter and verifies remote
parity through the full bounded turn.

## Out of scope

Schedules, subagents, MCP, channels beyond the default HTTP/NDJSON surface,
dashboard UI, shell or filesystem tools, sandbox/container execution, R2,
D1, Queues, native Workflows, Dynamic Workers, Dynamic Workflows, broad
integrations, and hosted multi-tenant bundles are not implemented or implied
by this milestone.

## Cleanup

For local validation, stop only the `eden agent dev` process started by the
current walkthrough, verify `127.0.0.1:8797` and `127.0.0.1:9297` are free,
and remove only the known temporary project root. Do not use broad process-name
or port-kill commands.

For an authorized remote validation, remove only the unique Worker, bearer
secret, and other resources created by that run. Verify the deployment URL is
unreachable and resource/secret listings no longer contain the temporary
entries. Preserve shared preview or production resources.

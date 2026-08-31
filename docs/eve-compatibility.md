# Current Eve compatibility

This maintainer gate validates Eden Deploy against a real, published Eve
project rather than an Eden mock or Eve's private repository test harness.

The standalone fixture under `validation/eve-compat/minimal/` currently pins:

- Eve `0.47.3`
- AI SDK `7.0.58`
- Zod `4.4.3`
- pnpm `11.21.0`
- Node 24 or newer

Update the fixture, its lockfile, and this document together when advancing the
tested Eve line. Do not replace the exact Eve pin with `latest` in a release
gate.

The synthetic compatibility turn uses this ordered AI Gateway model chain:

1. `minimax/minimax-m3-free`
2. `poolside/laguna-s-2.1-free`
3. `alibaba/qwen3.7-flash`

The Gateway tries the next model only when the preceding route fails. The
MiniMax free route is a time-limited promotion, so keep the chain current when
the catalog changes. The fixture declares a 32,000-token logical model window
so Eve plans compaction below Qwen's lowest context-pricing boundary and every
fallback runs against the same test budget.

## Local production-runtime gate

From the Eden repository root, run:

```sh
pnpm run compat:eve:local
```

The repository-owned runner:

1. performs an isolated frozen install from the fixture lockfile;
2. typechecks the authored agent, channel, tool, and eval;
3. runs the fixture's real `eve build`;
4. starts the real production server with `eve start` on an owned local port;
5. requires the documented `/eve/v1/health` ready response;
6. requires `/eve/v1/info` to reject missing auth and accept the fixture bearer;
7. terminates the complete owned process tree and verifies cleanup.

When `AI_GATEWAY_API_KEY` is present, the same runner also invokes Eve's public
black-box eval command against the running production server:

```sh
eve eval --strict --url http://127.0.0.1:<owned-port>
```

The eval requires the model to call the fixture's authored
`compatibility_echo` tool exactly once and checks the input and structured
output. Without `AI_GATEWAY_API_KEY`, the runner reports that this model/tool
assertion was skipped; build, production boot, health, auth, and cleanup still
remain required.

This adopts Eve's supported eval surface (`eve/evals` and `eve eval`) rather
than copying its internal tests, generated Nitro symbols, or private workflow
callback payloads.

## Eden packaging preflight

After the local gate passes, run Eden's real read-only preflight with a unique
target name:

```sh
FIXTURE="$PWD/validation/eve-compat/minimal"
WORKER_NAME="eden-eve-compat-$(date +%s)"

eden preflight \
  --project "$FIXTURE" \
  --env preview \
  --name "$WORKER_NAME"
```

Require all of the following evidence:

- immutable fixture snapshot and exact frozen pnpm install;
- project-local Eve executable and `eve build` output;
- Linux/amd64 runtime image;
- the real `eve start --host 0.0.0.0 --port 8080` process;
- ready health from the booted image;
- exact boot-container and disposable-image cleanup;
- authenticated read-only Cloudflare and target-absence checks.

## Disposable Cloudflare preview

Use a preview only after preflight is green. For a full model/tool proof, put
fresh values in an owner-readable environment file outside the repository:

```text
AI_GATEWAY_API_KEY=<project-owned-key>
EVE_COMPAT_AUTH_TOKEN=<fresh-random-token>
```

Deploy and retain the printed URL:

```sh
eden deploy \
  --project "$FIXTURE" \
  --env preview \
  --name "$WORKER_NAME" \
  --env-file "$ENV_FILE"
```

Require public health, fail-closed unauthenticated info, authenticated info, and
the remote eval:

```sh
curl --fail --silent "$DEPLOY_URL/eve/v1/health"

EVE_EVAL_AUTH_TOKEN="$EVE_COMPAT_AUTH_TOKEN" \
  pnpm --dir "$FIXTURE" --ignore-workspace exec eve eval \
    --strict --url "$DEPLOY_URL"
```

Finally destroy only that exact target:

```sh
eden destroy \
  --project "$FIXTURE" \
  --env preview \
  --name "$WORKER_NAME"
```

Verify all three cleanup signals:

1. the former health URL returns 404;
2. `wrangler containers list` contains no matching application;
3. querying the exact Worker returns Cloudflare code `10007` or equivalent
   does-not-exist evidence.

## What this gate proves

Passing the complete gate proves that the pinned Eve release can be packaged
and hosted through Eden's current Worker + single Container architecture, that
the canonical Eve HTTP/auth surface is preserved, and that one real model/tool
turn crosses the deployed workflow callback path.

It does not prove production durability, horizontal scaling, every Eve authored
slot, every provider, schedule dispatch, or process-replacement recovery. Eve's
local Workflow World and Container-local filesystem remain disposable. A
production project still needs its own Cloudflare-reachable durable Workflow
World and representative application-specific tests.

# Eden Threat Model

## 1. System Overview

Eden is a TypeScript monorepo with two intentionally separate Cloudflare
surfaces:

- **Eden Deploy** builds an explicitly selected existing Eve project, packages
  its Node/Nitro server into one bounded Cloudflare Container, and places a
  generic Worker in front of that Container. Eve remains the application and
  Workflow World authority.
- **Eden Agent** compiles an authored `agent/` tree in Node, emits a static
  Worker-safe generation, and hosts that generation behind one authenticated
  Worker and one SQLite-backed `EdenSession` Durable Object. A bounded model
  and tool turn uses Workers AI through Cloudflare AI Gateway gateway ID
  `default`.

The CLI crosses a remote Cloudflare boundary for Deploy and Agent
publication/validation. It does not rewrite Eve into an Agent, substitute the
Agent runtime for Eve, or silently migrate Eve providers, credentials,
databases, queues, channels, schedules, or Workflow World behavior.

The primary security properties are source and secret separation, immutable
generation identity, exact remote ownership, and fail-closed authentication
and cleanup. Local and remote failures remain observable; an indeterminate
remote operation is never reported as successful.

## 2. Trust Boundaries

1. **CLI caller to Eden control plane.** Command-line project, config, env-file,
   target, and artifact paths are untrusted selectors. Canonical root checks,
   regular-file checks, containment checks, and explicit target parsing happen
   before work.
2. **Authored Eve project to Eden snapshot.** Project files can contain
   symlinks, special files, generated state, package-manager credentials, or
   runtime environment files. The snapshot walker rejects unsafe types and
   excludes generated and sensitive paths.
3. **Eden snapshot to isolated builder.** The builder executes project
   installation scripts and the project-local Eve build. Only a copied
   snapshot, pinned package-manager command, sanitized build environment, and
   immutable Linux/amd64 Node image contract cross this boundary.
4. **Builder to local candidate.** Generated Eve output and its runtime
   dependency closure remain untrusted until the Nitro entrypoint, symlink
   containment, platform identity, source inputs, output, and cleanup evidence
   are verified.
5. **CLI to Cloudflare Deploy control plane.** Wrangler receives the exact
   Worker, Container application, config, image identity, and environment
   selected by the caller. Deployment identity and account/target observations
   must match the candidate before publication.
6. **Runtime configuration to Eve Deploy runtime.** Environment variable names
   and redacted identity cross the packaging seam; runtime values flow only
   through the protected Cloudflare secret/Container environment path. Values
   must never enter argv, image layers, generated artifacts, logs, or journals.
7. **Agent source to Node compiler.** The compiler owns filesystem discovery,
   path-derived tool names, normalization, diagnostics, manifest generation,
   and static bundling. Compiler code and source discovery never run inside
   workerd.
8. **Agent generation to Cloudflare Worker and Durable Object.** Only the
   verified static bundle, runtime wrapper, and declared bindings cross the
   publication boundary. The Worker authenticates and routes; `EdenSession`
   owns SQLite state, journal cursors, and state transitions.
9. **Remote request to Agent session/model services.** Every implemented route
   requires a bearer credential before session lookup. The fixed test
   principal, opaque session IDs, bounded JSON, bounded turns, and Workers AI
   adapter prevent callers from selecting a tenant, principal, provider, or
   platform locator.
10. **Eden to Cloudflare AI Gateway.** The live Agent adapter uses gateway ID
    `default`; Cloudflare creates that gateway on the first authenticated
    request when it does not exist. Eden does not create or claim ownership of
    a named gateway.

## 3. Critical Assets

- Authored Eve source, package manifest, lockfile, build configuration, Agent
  source, generated generations, and prior deployment generations.
- Runtime environment values, package-manager credentials, Cloudflare
  credentials, bearer secrets, private keys, and other project secrets.
- Immutable source, output, bundle, image, generation, and deployment digests.
- Local Docker/OrbStack image, build container, temporary context, and cleanup
  ownership records.
- Cloudflare Worker and Container identities, Durable Object SQLite state,
  journal cursors, model/tool results, and remote validation evidence.
- Existing Eden CLI, compiler, and runtime behavior and public command/package
  contracts.

## 4. Attack Surface Inventory

- `eden preflight`, `eden deploy`, `eden destroy`, and `eden agent deploy`
  project, target, environment, config, env-file, and artifact arguments.
- Recursive filesystem traversal, snapshot copying, source symlinks, and
  generated state.
- JSON package manifests, JSONC Wrangler configs, lockfile metadata, and
  project-local installation/build scripts.
- Docker/OrbStack and Wrangler command invocation, image/context paths, and
  Cloudflare API responses.
- Generated Dockerfiles, `.dockerignore`, Worker wrappers, bundles, manifests,
  diagnostics, logs, and remote validation output.
- Bearer authentication, session IDs, NDJSON cursors, Durable Object alarms,
  model/tool payloads, and Cloudflare AI Gateway requests.
- Existing Agent compiler/runtime and Cloudflare control-plane modules.

## 5. Threat Analysis

### Spoofing

- A symlinked project root, project-local Eve executable, or stale generated
  artifact could impersonate the selected input. Reject root symlinks, require
  the resolved Eve binary and package to remain under snapshot `node_modules`,
  and bind each generation to immutable input and output digests.
- A caller could target a shared or cross-environment Worker by name. Resolve
  the exact environment/config snapshot, compare account and target identity,
  and permit destructive remote compensation only for an explicit unique name
  with an ownership proof.
- A request could present a session ID or body principal as authorization.
  Authenticate before lookup, use one fixed principal, and treat session and
  event IDs as opaque non-authorizing values.

### Tampering

- Concurrent source, lockfile, configuration, or environment-identity
  mutation could produce a mixed-generation candidate. Capture and compare
  allowlisted inputs before copying, after copying, after build, and before
  handoff; do not retry automatically after a race.
- Snapshot files could be modified by install hooks or build scripts. Verify
  every authored snapshot input after the builder returns, and reject lockfile
  rewrites or stale package-manager installs.
- Remote resources could be replaced between read, publication, and cleanup.
  Require exact deployment identity, immutable image/bundle evidence, bounded
  propagation checks, and ownership-aware compensation. Retain evidence when
  the final state is indeterminate.

### Repudiation

- Safe local and remote records retain requested/canonical roots, source and
  lockfile digests, generation/deployment identity, package manager, image or
  bundle digest, target environment, variable names, and cleanup evidence.
  They do not retain source contents, credentials, or raw runtime values.
- Cleanup is bounded and exact. An unverified Worker, Container, secret, or
  Durable Object operation is reported as failed or indeterminate, never
  silently claimed complete.

### Information Disclosure

- Runtime values are never opened by packaging or placed in Docker `ARG`,
  `ENV`, labels, command arguments, manifests, logs, generated source, or
  journals. Only safe variable names and redacted identities cross seams.
- `.env*`, package-manager auth files, private keys, generated state, and
  dependency directories are excluded from the Eve source context. Agent
  bearer secrets remain outside projects and are supplied to Wrangler through
  stdin.
- Request JSON, messages, model/tool payloads, and NDJSON data are bounded.
  Credentials, provider clients, full prompts, complete transcripts, and
  unbounded payloads must not appear in source, tests, events, logs, or docs.
- The local workerd/runtime filesystem is not a project filesystem or a
  security sandbox. Source discovery and compilation happen in Node; the
  Worker receives static artifacts only.

### Denial of Service

- Recursive traversal is bounded to the selected root and excludes common
  generated/dependency trees before descending. Builder, Wrangler, Worker
  propagation, runtime health, and cleanup operations use bounded deadlines.
- Docker and Cloudflare operations are exact to one generated context, image,
  Worker, Container application, and ownership identity. Broad prune,
  account-wide cleanup, and arbitrary process/port killing are forbidden.
- Agent sessions use bounded request sizes, turns, model steps, retries,
  alarms, and journal delivery. Durable Object alarms are bounded,
  at-least-once recovery support, not a general scheduler or workflow engine.

### Elevation of Privilege

- Eve Deploy never routes failures into the Eden Agent compiler/runtime or
  uses global executables. The project-local Eve binary and literal `eve build`
  are the only application build authority.
- Project build scripts are arbitrary code and may execute in the isolated
  builder, but receive no runtime secrets or Cloudflare deployment
  credentials. Host/device requirements are validated, not adapted or hidden.
- Artifact paths and generated state are checked against canonical roots so a
  caller cannot redirect hosting state over authored source.
- Agent authentication and routing cannot select arbitrary principals,
  tenants, sessions, providers, or platform locators. The Durable Object is
  the sole journal and state-transition authority; SQLite commits precede
  NDJSON delivery, model advancement, and tool-result advancement.

## 6. Vulnerability Pattern Library

### Unsafe command execution

Avoid shell interpolation and ambient executable lookup. Docker and Wrangler
operations use argument arrays, bounded sanitized environments, exact config
snapshots, and exact generated identities. Never put a secret in argv.

### Path traversal and symlink escape

Reject symlinked roots, special files, unsafe source/output symlinks, and
artifact parents that resolve through arbitrary links. Verify canonical
containment before copying, publishing, or deleting.

### Secret exposure

Never read runtime env-file contents in packaging. Never place values in image
layers, `ARG`, `ENV`, labels, command arguments, manifests, logs, generated
source, events, or journals. Use only protected secret injection and safe
names/identities.

### Mixed-generation input

Hash and compare the complete allowlisted input set, generation artifacts,
deployment identity, and deployment-safety input identity at every stage. Do
not retry automatically after a race.

### Remote ownership confusion

Do not delete shared or configured targets. Destructive compensation requires
an explicit unique name, exact environment and target identity, and a matching
immutable ownership proof. Preserve late-operation evidence when the lease or
cleanup cannot settle.

### Agent fallback or sandbox confusion

Do not import or invoke the Eden Agent compiler, Agent runtime, turn runner, or
fixture adapters while handling Eve package failures. Do not treat Worker
filesystem access, `node:vm` compatibility, or Container-local disk as a
project sandbox or durable project filesystem.

## 7. Security Testing Strategy

- Unit-test canonical root, regular-file, symlink, special-file, package
  manager, lockfile, global-only Eve, snapshot, source-race, output, Docker
  platform, secret-exclusion, deployment-identity, ownership, authentication,
  cursor, bounded-request, and cleanup cases.
- Run package typecheck, lint, and focused tests serially. Keep Docker and
  Cloudflare integration local-only or explicitly authorized, exact-target
  scoped, and cleanup-verified.
- Exercise both the local Agent lifecycle and an isolated preview Deploy/Agent
  target before any production operation. Verify unauthenticated failure,
  authenticated health, generation identity, session lifecycle, cursor
  reconnect, model/tool/final response, and exact cleanup.
- Review generated manifests, diagnostics, Worker bundles, Docker inputs,
  remote records, and logs for source contents, credentials, unsafe paths, and
  runtime values.

## 8. Assumptions and Accepted Risks

- The Eve deployment-safety seam validates env-file grammar and owns runtime
  values. Packaging and publication trust only its typed, redacted identity
  seam.
- Docker/OrbStack, the pinned Node 24 image, Wrangler credentials, and
  Cloudflare account access are prerequisites for remote Deploy. If unavailable,
  the operation fails closed.
- Project build scripts and authored Agent tools are arbitrary code. They are
  not trusted with runtime secrets, deployment credentials, or other projects'
  state.
- Cloudflare provider availability, propagation, Workers AI behavior, and the
  `default` AI Gateway's account billing/configuration are external
  dependencies. Eden verifies bounded health and lifecycle evidence but makes
  no broader provider SLA claim.
- Container-local memory and disk are disposable; durability belongs to the
  Eve project's configured external World or the Agent's Durable Object
  journal.

## 9. Version Changelog

- 1.2.0: Replaced the local-only packaging description with the actual remote
  Deploy and Agent trust boundaries and the `default` AI Gateway contract.
- 1.1.0: Renamed Eden Native to Eden Agent and replaced the obsolete
  `eden eve` namespace with the top-level Deploy commands.

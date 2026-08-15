# Eden Threat Model

## 1. System Overview

Eden is a TypeScript and Node.js authoring toolchain for generating a
Cloudflare Worker bundle containing an agent, tools, and a durable session
runtime. The repository is a pnpm workspace with definitions, a compiler, a
Cloudflare runtime, a client, a CLI, and a basic example.

The compiler reads an authored project from a selected filesystem root,
discovers `agent/` modules, resolves selected-project dependencies, validates
source and generated JavaScript, writes immutable `.eden` generations, and
promotes a coherent `CURRENT` generation. The CLI invokes the compiler,
starts an owned local Wrangler process for development, or runs environment
scoped compatibility, secret provisioning, deployment, propagation, and
authenticated lifecycle checks.

The deployed Worker exposes authenticated health, session creation, message
submission, and NDJSON stream routes. Sessions are stored in a SQLite-backed
`EdenSession` Durable Object. Model and tool turns are bounded and their
events are written to the session journal.

## 2. Assets

### High sensitivity

- `EDEN_BEARER_SECRET` and any Wrangler secret input.
- Cloudflare account and deployment credentials held by the operator or CI.
- Durable Object session contents, model messages, tool inputs, tool outputs,
  and generated agent artifacts.
- Immutable artifact generations, `CURRENT`, manifest identities, module maps,
  bundle digests, and dependency-integrity metadata.

### Medium sensitivity

- Authored agent and tool source.
- Project dependency source and package metadata.
- Session identifiers, cursor positions, generation identifiers, and
  deployment names.

### Low sensitivity

- Version constants, public protocol definitions, and ordinary health status.

## 3. Trust Boundaries

1. **Authoring filesystem to compiler.** Project files, dependencies, and
   package metadata are input and may be malformed or hostile. The compiler
   must not execute arbitrary authoring code during validation.
2. **Selected project to dependency resolver.** Bare imports are resolved from
   the selected project, not from an unrelated caller workspace. A pinned Zod
   dependency is trusted only after package identity, version, file integrity,
   and generated provenance checks.
3. **Compiler to published artifacts.** Staged files, `CURRENT`, legacy
   migration, and same-identity reuse are untrusted storage. Readers must
   validate all fields, descendants, digests, and runtime bundle shape before
   reuse or promotion.
4. **Generated bundle to Worker runtime.** The bundle is generated JavaScript
   that must remain Worker-compatible and must not contain Node APIs, dynamic
   code, ambient secret access, or forged generated helpers.
5. **Client to Worker.** Requests cross a public network boundary and require
   the bearer secret, input validation, opaque identifiers, bounded body and
   stream behavior, and cursor validation.
6. **CLI to local or remote process.** Wrangler and local development children
   are external process boundaries. The CLI may signal only processes it owns
   and must preserve secrets out of arguments, artifacts, URLs, and logs.
7. **Worker to Cloudflare services.** The Worker relies on Durable Objects,
   SQLite storage, AI bindings, and Wrangler deployment APIs. Binding names,
   environment selection, and deployment identity must remain explicit.

## 4. Attack Surface

- `eden init`, `build`, `dev`, and `deploy` CLI arguments and selected paths.
- Discovery of `agent/agent.ts`, instructions, and tool modules.
- TypeScript and JavaScript parsing, esbuild bundling, dependency resolution,
  and generated artifact parsing.
- `.eden` generation files, `CURRENT`, legacy migration, and repair/promotion.
- Local HTTP routes and NDJSON stream cursors.
- Remote Wrangler compatibility, secret, deploy, delete, and propagation
  commands.
- Model adapters, tool execution, Durable Object session state, and event
  serialization.
- Cloudflare configuration, preview/production environments, and bindings.

## 5. Threat Analysis

### 5.1 Spoofing

- **Forged dependency identity (high):** A package named `zod` or a path-only
  replacement could impersonate the pinned dependency. Mitigations are
  resolved package identity, exact version, trusted file integrity, generated
  dependency digests, authenticated namespace provenance, and fail-closed
  semantic and artifact validation.
- **Bearer impersonation (high):** A stolen bearer secret could access sessions
  and submit turns. The runtime requires the secret on every route and the CLI
  keeps it outside source, artifacts, arguments, URLs, and ordinary output.
  Operators must rotate compromised secrets and use TLS for remote access.
- **Deployment target confusion (high):** Preview and production names or
  Wrangler environments could be confused. The CLI requires explicit
  production selection, scopes secret commands to the exact unique Worker, and
  validates generation identity after deployment.

### 5.2 Tampering

- **Artifact mutation (high):** An attacker with write access to `.eden` could
  alter a manifest, module map, bundle, `CURRENT`, or same-identity candidate.
  Every authoritative read validates JSON shape, descendant safety, coherent
  references, digests, runtime bundle structure, and promotion boundaries.
- **Generated helper or namespace forgery (high):** Replacing esbuild export
  helpers or a verified Zod namespace could turn untrusted functions into
  trusted schema constructors. The compiler authenticates helper structure,
  call count, generated boundary placement, namespace export maps, mutation
  sets, and dependency provenance.
- **Authoring source injection (high):** Tool code could use ambient globals,
  dynamic evaluation, unresolved callbacks, or arbitrary dependency calls.
  Semantic validation rejects unsupported dynamic code, unresolved values,
  ambient secret paths, unsupported Zod calls, and unsafe callbacks.
- **Command injection (high):** CLI arguments or project paths could reach
  shell commands. Commands must use argument arrays or explicitly owned shell
  wrappers, normalized contained paths, fixed Wrangler command structure, and
  no interpolated secrets.

### 5.3 Repudiation

- **Unverifiable deployment (medium):** A deployment could be reported as
  successful without validating the selected generation or runtime. The CLI
  records generation identity and performs compatibility, propagation,
  authentication, lifecycle, and cleanup checks.
- **Ambiguous session history (medium):** A cursor or event sequence that is
  not durable could make actions difficult to reconstruct. The Durable Object
  journal uses committed stream indices and reconnect semantics; consumers
  should retain authenticated request and deployment logs without logging
  bearer values.

### 5.4 Information Disclosure

- **Secret leakage (high):** Bearer values, API credentials, model inputs, or
  tool outputs could enter logs, URLs, generated files, or error messages.
  Secrets are passed through environment or Wrangler stdin; source and
  artifact validators reject ambient secret reads. Avoid enabling verbose
  child-process logging in production.
- **Cross-session access (high):** Guessable or unowned session identifiers
  could expose another user's events. Use opaque IDs, authenticate every
  request, bind reads to the requested session, and validate cursors.
- **Verbose compiler errors (medium):** Diagnostics may reveal source paths or
  dependency details. Keep diagnostics scoped to the selected project and do
  not include source contents or secret values in normal CLI output.

### 5.5 Denial of Service

- **Compiler resource exhaustion (medium/high):** Deep aliases, recursive
  schemas, malformed bundles, or huge dependency graphs could consume CPU or
  memory. Use bounded project inputs, parser limits where available, cycle
  detection, memoized trust checks, bounded child-process timeouts, and
  cleanup barriers.
- **Session and stream exhaustion (medium):** Unbounded message bodies,
  model turns, tool calls, or follow streams could consume Worker resources.
  Enforce request, turn, event, cursor, and stream bounds and retain only
  bounded in-flight work.
- **Process cleanup starvation (medium):** A hung Wrangler or child process
  could block later commands. Track owned process trees, use escalating
  termination with evidence, and fail closed when quiescence cannot be proved.

### 5.6 Elevation of Privilege

- **Forged artifact promotion (high):** Promoting a candidate without
  authoritative validation could execute code not produced by the compiler.
  Validate candidate identity and all artifact fields before `CURRENT` changes.
- **Worker environment escalation (high):** A preview command accidentally
  targeting production could mutate live resources. Require explicit target
  selection, use isolated names, and keep destructive commands out of dry
  runs.
- **Ambient binding escape (high):** Authored code could read `globalThis`,
  `self`, process-like objects, or Worker bindings and exfiltrate secrets.
  Worker semantic analysis must follow aliases, destructuring, reflection, and
  constructor indirection, rejecting unapproved access.

## 6. Vulnerability Pattern Library

### Safe patterns

- Validate resolved package name, exact version, file integrity, and generated
  dependency provenance before granting semantic exemptions.
- Resolve project paths with realpath and containment checks; reject symlink
  escapes and unsafe descendants.
- Use `spawn`/`execFile` argument arrays for fixed commands; if a shell is
  unavoidable, pass a fixed command assembled from validated constants.
- Pass secrets via environment or stdin, never command-line arguments or URLs.
- Read immutable generations authoritatively and promote only after complete
  validation.
- Cache only positive trust results for immutable AST nodes after mutation
  collection; retain cycle detection and fail closed on unknown values.

### Unsafe patterns

```ts
// Never trust a package based only on its name or path.
if (importPath === "zod") acceptDependency();

// Never interpolate project input or a secret into a shell command.
exec(`wrangler deploy --name ${userName} --secret ${bearer}`);

// Never treat an unknown callback, schema, or ambient object as safe.
const schema = z.object({ value: getSchema() });
const secret = globalThis[dynamicKey];
```

## 7. Security Testing Strategy

- Run compiler typecheck, lint, discovery normalization, artifact-only
  validation, legacy migration, same-identity reuse, promotion-race, and
  Wrangler dry-run tests.
- Keep positive pinned-Zod coverage for namespace factories, direct named
  factories, variable aliases, nested shapes, ISO factories, collections,
  wrappers, checks, and composition chains.
- Keep negative coverage for forged dependencies, unresolved schema arguments,
  dynamic callbacks, ambient values, mutated generated helpers, malformed
  published fields, and unsafe path descendants.
- Run local lifecycle and cleanup tests with an external services manifest when
  available. Treat missing authoritative service configuration as an
  environmental verification gap, not as success.
- Before release, run the full repository test suite, inspect process and port
  ownership, review the staged diff, and scan for secrets.

## 8. Assumptions and Accepted Risks

- The operator's local filesystem, Node runtime, pnpm lockfile, and installed
  toolchain are trusted inputs; compromise of the host is outside scope.
- Cloudflare account authentication and provider-side isolation are trusted;
  Eden validates target and generation identity but cannot secure a compromised
  account.
- The pinned Zod version and integrity record are maintained by repository
  owners and must be updated through reviewed changes.
- Model providers may receive model inputs and tool results according to their
  service terms; the runtime does not treat model output as trusted code.
- A missing external services manifest prevents authoritative local-service
  lifecycle verification and must be resolved before claiming that gate.

## 9. Changelog

- 1.0.0 (2026-08-15): Initial repository threat model covering authoring,
  compiler, artifact lifecycle, Worker runtime, CLI, Wrangler, and pinned Zod
  supply-chain validation.

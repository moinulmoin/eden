# Eden Threat Model

## 1. System Overview

Eden is a TypeScript monorepo that provides an explicit CLI, a compiler for
Eden Native projects, a Cloudflare Worker runtime, and an additive Eve
packaging boundary. The reviewed change adds local Eve packaging only. Eve
mode accepts an explicitly selected project root, copies a filtered immutable
snapshot into an Eden-owned generation, runs a pinned pnpm install and the
project-local `eve build` inside a caller-provided builder, and records
redacted input, output, image, and race evidence. It does not deploy, publish,
upload secrets, or call Cloudflare.

The principal security property is source and secret separation: authored
project bytes and runtime values must not be modified or copied into generated
hosting artifacts, and build work must not use ambient global Eve or Native
runtime code.

## 2. Trust Boundaries

1. **CLI caller to Eden control plane.** Command-line project and artifact
   paths are untrusted selectors. Canonical root checks, regular-file checks,
   containment checks, and explicit target parsing are required before work.
2. **Authored Eve project to Eden snapshot.** Project files can contain
   symlinks, special files, generated state, package-manager credentials, or
   runtime environment files. The snapshot walker rejects unsafe types and
   excludes generated and sensitive paths.
3. **Eden snapshot to isolated builder.** The builder executes project
   installation scripts and the project-local Eve build. Only a copied
   snapshot, pinned package-manager command, sanitized build environment, and
   immutable Linux/amd64 image contract may cross this boundary.
4. **Builder to local candidate.** Generated Eve output and runtime dependency
   closure are untrusted until the Nitro entrypoint, symlink containment,
   platform identity, and cleanup evidence are verified.
5. **Deployment-safety runtime configuration to packaging.** Packaging
   receives only safe environment-input identity and variable names. It must
   never open or persist runtime values.
6. **Eden control plane to Cloudflare.** This feature does not cross this
   boundary. Future publication code must keep provider credentials and
   runtime secrets separate and use exact ownership proofs.

## 3. Critical Assets

- Authored Eve source, package manifest, lockfile, build configuration, and
  prior deployment generations.
- Runtime environment values, package-manager credentials, Cloudflare
  credentials, private keys, and other project secrets.
- Immutable source and output digests used for deployment identity.
- Local Docker image, build container, temporary context, and cleanup
  ownership records.
- Existing Eden Native compiler/runtime behavior and CLI ABI.

## 4. Attack Surface Inventory

- `eden eve` project and artifact path arguments.
- Recursive filesystem traversal and snapshot copying.
- JSON package manifest and YAML lockfile metadata parsing.
- Project-local pnpm lifecycle scripts and Eve build code.
- Docker/OrbStack command invocation and image/context paths.
- Generated Dockerfile, `.dockerignore`, manifests, and diagnostic output.
- Runtime configuration identity/name descriptors supplied by another worker.
- Existing Native CLI/runtime and Cloudflare control-plane modules.

## 5. Threat Analysis

### Spoofing

- A symlinked project root or project-local Eve executable could impersonate
  the explicitly selected root or local dependency. Reject root symlinks and
  require the resolved Eve binary and package to remain under snapshot
  `node_modules`.
- A stale Docker image tag could be mistaken for the current candidate.
  Candidate image tags must be new and collision checks must happen before
  building.

### Tampering

- A concurrent source, lockfile, configuration, or environment identity
  mutation could create a mixed-generation candidate. Capture and compare
  input manifests before copying, after copying, after build, and before
  handoff.
- Snapshot files could be modified by install hooks or build scripts. Verify
  every authored snapshot input after the builder returns.
- Lockfile rewrite or stale install must fail. The Dockerfile uses exact pnpm
  version checks and before/after lockfile digests.
- Artifact output must not escape through symlinks or overwrite authored
  files. Use exclusive Eden-owned generation creation and regular-file
  output checks.

### Repudiation

- Safe manifests record requested/canonical roots, source and lockfile
  digests, generation path, package manager, project-local Eve version,
  output digest, and platform identity without recording source contents or
  secrets.
- Cleanup must be bounded and exact. Unverified Docker cleanup is reported as
  a failure rather than silently claimed complete.

### Information Disclosure

- Runtime values must not be opened by packaging. Explicit environment paths
  and runtime variable names are passed only as exclusion/identity evidence.
- `.env*`, package-manager auth files, private keys, generated state, and
  dependency directories are excluded from the source context.
- Dockerfile, image arguments, build environment, manifests, and diagnostics
  must not contain runtime values or provider credentials.
- Error messages use safe relative subjects and fixed remediation text, not
  source contents or child-process output.

### Denial of Service

- Recursive traversal is bounded to the selected root and excludes common
  generated/dependency trees before descending.
- Docker operations are exact to one generated context, image tag, and
  container identity. Broad prune or account-wide cleanup is forbidden.
- Future runtime health and deployment operations must use bounded deadlines,
  single-instance limits, and owned-process cleanup.

### Elevation of Privilege

- Eve mode must never route failures into the Eden Native compiler/runtime or
  use global executables. The project-local Eve binary and literal `eve build`
  are the only application build authority.
- Docker builder commands use a sanitized environment and no runtime secrets.
  Privileged host/device requirements are not adapted or hidden.
- Artifact paths are checked against the canonical project root so a caller
  cannot redirect generated hosting state over authored source.

## 6. Vulnerability Pattern Library

### Unsafe command execution

Avoid shell interpolation and ambient executable lookup. Docker operations use
`execFile` with an argument array, a bounded sanitized environment, an exact
Docker command, and an exact generated image/container identity.

### Path traversal and symlink escape

Reject a symlinked project root, special files, source symlinks, unsafe output
symlinks, and artifact parents that resolve through arbitrary links. Verify
canonical containment before copying or deleting.

### Secret exposure

Never read runtime env-file contents in packaging. Never place values in
Docker `ARG`, `ENV`, labels, command arguments, manifests, logs, or generated
source. Only safe names and identities may be recorded.

### Mixed-generation input

Hash and compare the complete allowlisted input file set and deployment-safety
input identity at every stage. Do not retry automatically after a race.

### Native fallback

Do not import or invoke the Eden compiler, Native runtime, turn runner, or
fixture adapters while handling Eve package failures.

## 7. Security Testing Strategy

- Unit-test canonical root, regular-file, symlink, special-file, package
  manager, lockfile, global-only Eve, snapshot, source-race, output, Docker
  platform, and secret-exclusion cases with fake builders.
- Run package typecheck, lint, and focused tests serially.
- Keep Docker integration local-only, Linux/amd64, exact-image scoped, and
  cleanup-verified.
- Run the repository's serial validation gate before milestone completion.
- Review all generated manifests and diagnostics for values, source contents,
  credentials, or unsafe paths.

## 8. Assumptions and Accepted Risks

- The deployment-safety worker validates env-file grammar and owns runtime
  values. Packaging trusts only its typed, redacted identity seam.
- Docker/OrbStack and the pinned Node 24 image are prerequisites for the
  concrete image builder. If unavailable, packaging fails closed.
- Project build scripts are arbitrary code and may execute during the
  isolated build. They are not trusted with runtime secrets or deployment
  credentials.
- Container-local memory and disk are disposable; durability belongs to the
  Eve project's configured external World.

## 9. Version Changelog

- 1.0.0: Initial repository threat model covering Eden Native and the local
  Eve immutable packaging boundary.

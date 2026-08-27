# Changelog

## 0.1.3 — 2026-08-27

- Made generated Eden Agent projects install cleanly with pinned pnpm 11 by
  approving only the required `esbuild` and `workerd` dependency builds.
- Added detailed user installation, Deploy, Agent, verification, and cleanup
  documentation under `docs/`.

## 0.1.2 — 2026-08-26

- Replaced public `workspace:*` dependency specifiers with exact `0.1.2`
  versions so every supported installer resolves the published package graph.

## 0.1.1 — 2026-08-26

- Replaced the placeholder npm README with complete installation,
  prerequisites, Deploy, Agent, cleanup, and limitation guidance.
- Relaxed the Node engine declaration to `>=24.17.0`; later Node majors are no
  longer rejected without evidence.
- Removed internal Factory mission and scan scaffolding from the public tree.

## 0.1.0 — 2026-08-26

Initial release.

### Eden Deploy

- Added top-level `eden preflight`, `eden deploy`, and `eden destroy` commands for hosting an existing Eve project on Cloudflare without adapting its source or runtime semantics.
- Added immutable Linux/amd64 packaging, bounded Container hosting, Worker routing, protected runtime injection, generation identity checks, health-gated promotion, and exact owned-resource cleanup.
- Added fail-closed validation for project roots, lockfiles, runtime configuration, host requirements, deployment identity, and destroy ownership.

### Eden Agent

- Placed Eden's agent-authoring framework beneath the explicit `eden agent` namespace: `init`, `build`, `dev`, and `deploy`.
- Added filesystem-first agent and tool discovery, coherent generated artifacts, authenticated local and remote runtimes, SQLite-backed Durable Object sessions, NDJSON journals, and bounded model/tool/final-response turns.

### CLI contract

- Removed the obsolete `eden eve` namespace.
- Removed root aliases for Agent `init`, `build`, and `dev`; root `deploy` now always means Eden Deploy.
- Added command-specific help and explicit target selection through `--project`, `--env`, and `--name`.
- Added the `@moinulmoin/eden` package and `eden` binary with npm, pnpm, and
  Bun installer compatibility; Node remains the runtime.

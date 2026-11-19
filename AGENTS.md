# Working on Eden

Eden is a CLI (`packages/cli`), the Cloudflare Worker and Container host it
deploys (`packages/runtime-cloudflare`), and an optional Durable Object World
(`packages/world-cloudflare`). Users and their coding agents read `docs/` and
`skills/eden/SKILL.md` (printed by `eden skill`).

## Checks

```sh
pnpm install
pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run test
```

The Eve compatibility gate needs Postgres and Docker. With Postgres running
as [docs/validation.md](docs/validation.md) describes:

```sh
WORKFLOW_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm run compat:eve:local
```

It runs a Postgres leg and an Eden leg on the `floor` and `latest` fixtures.
Append a fixture or a leg (`postgres`, `eden`) to run only that. CI runs the
Postgres leg in the `gate` job and the Eden leg in one `eden-compat` job per
fixture.

## Rules

- Keep it simple. Prefer deleting code to adding it; no shims for removed
  behavior.
- Tests check what a user or agent sees (output, exit code, files, HTTP).
  No new permanent tests without the maintainer's approval.
- Every failure has a stable `code` and a `remediation` that names the next
  command or action. With `--json`, every run prints exactly one JSON object.
- Docs use short, plain sentences and claim only what was run.

## When you change X, also update Y

| You change | Also update |
| --- | --- |
| A failure or warning code, or its remediation | Its entry in `docs/troubleshooting.md`; `skills/eden/SKILL.md` if agents hit it often |
| A command, flag, environment variable, or JSON output field | `docs/reference.md`, `skills/eden/SKILL.md`, and the help text in `packages/cli/src/eve.ts` |
| The supported Eve or World versions | The table in `docs/eve-compatibility.md`, the fixtures in `validation/eve-compat/`, the `EVE_VERSION_UNSUPPORTED` and `EVE_WORLD_PAIRING` checks, the README's fresh-project steps, and the versions named in `docs/validation.md`, `docs/deploy.md`, and `docs/troubleshooting.md` |
| Deploy, update, destroy, runtime, or World behavior | Run the live check on Cloudflare before release (`pnpm run check:live`, see `docs/validation.md`); update `docs/how-it-works.md` |
| Anything about secrets, auth, or what Eden can change | `docs/security.md` |
| Anything a user can notice | `CHANGELOG.md` |

## Release

1. Add `## X.Y.Z — YYYY-MM-DD` to `CHANGELOG.md`; it becomes the GitHub
   release notes.
2. Set the version in `package.json`, `packages/cli/package.json` (and its
   `@moinulmoin/eden-runtime-cloudflare` dependency),
   `packages/runtime-cloudflare/package.json` (and its
   `@moinulmoin/eden-world-cloudflare` dev dependency), and
   `packages/world-cloudflare/package.json`. Run
   `pnpm install --no-frozen-lockfile`.
3. Run the checks above. When the change needs the live check, run
   `pnpm run check:live -- --env-file <file>` on a machine with the Wrangler
   login and add the dated result to `docs/eve-compatibility-history.md`.
4. Get the maintainer's approval. Commit explicit paths, push `main`, then
   push the tag `vX.Y.Z`. The Publish workflow tests, publishes to npm with
   provenance, smoke-tests the installers, and creates the GitHub release.
5. Deploy the site: `pnpm --dir site run deploy`. It reads the version from
   `packages/cli/package.json`.

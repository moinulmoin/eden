---
name: "elevenlabs-workspaces"
description: "Disable workspace API keys."
---

# workspaces

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs workspaces <method> [flags]
```

## API Resources


### api-keys

 - `disable` — Disable API key
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs workspaces --schema
elevenlabs workspaces <method> --schema

# Human-readable help (for humans)
elevenlabs workspaces --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

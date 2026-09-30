---
name: "elevenlabs-tokens"
description: "Mint short-lived, single-use tokens for client-side use of Conversational AI agents."
---

# tokens

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs tokens <method> [flags]
```

## API Resources


### single-use

 - `create` — Create Single Use Token
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs tokens --schema
elevenlabs tokens <method> --schema

# Human-readable help (for humans)
elevenlabs tokens --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

---
name: "elevenlabs-environment-variables"
description: "Manage workspace environment variables available to agents and tools."
---

# environment-variables

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs environment-variables <method> [flags]
```

## API Resources

 - `create` — Create Environment Variable
 - `get` — Get Environment Variable
 - `list` — List Environment Variables
 - `update` — Update Environment Variable
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs environment-variables --schema
elevenlabs environment-variables <method> --schema

# Human-readable help (for humans)
elevenlabs environment-variables --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

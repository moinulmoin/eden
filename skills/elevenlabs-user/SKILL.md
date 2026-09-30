---
name: "elevenlabs-user"
description: "Read your user account and subscription details."
---

# user

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs user <method> [flags]
```

## API Resources

 - `get` — Get user

### subscription

 - `get` — Get user subscription
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs user --schema
elevenlabs user <method> --schema

# Human-readable help (for humans)
elevenlabs user --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

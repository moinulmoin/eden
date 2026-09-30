---
name: "elevenlabs-speech-engine"
description: "Low-latency, real-time speech generation endpoints."
---

# speech-engine

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs speech-engine <method> [flags]
```

## API Resources

 - `create` — Create Speech Engine
 - `delete` — Delete Speech Engine
 - `get` — Get Speech Engine
 - `list` — List Speech Engines
 - `update` — Update Speech Engine
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs speech-engine --schema
elevenlabs speech-engine <method> --schema

# Human-readable help (for humans)
elevenlabs speech-engine --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

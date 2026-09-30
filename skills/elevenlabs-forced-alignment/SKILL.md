---
name: "elevenlabs-forced-alignment"
description: "Force align an audio file to a text transcript to get precise word-level and character level timing information."
---

# forced-alignment

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs forced-alignment <method> [flags]
```

## API Resources

 - `create` — Create Forced Alignment
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs forced-alignment --schema
elevenlabs forced-alignment <method> --schema

# Human-readable help (for humans)
elevenlabs forced-alignment --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

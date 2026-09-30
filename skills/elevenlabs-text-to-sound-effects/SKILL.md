---
name: "elevenlabs-text-to-sound-effects"
description: "Generate sound effects and non-speech audio from a text prompt."
---

# text-to-sound-effects

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs text-to-sound-effects <method> [flags]
```

## API Resources

 - `convert` — Create sound effect
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs text-to-sound-effects --schema
elevenlabs text-to-sound-effects <method> --schema

# Human-readable help (for humans)
elevenlabs text-to-sound-effects --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

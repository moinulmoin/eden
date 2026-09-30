---
name: "elevenlabs-text-to-speech"
description: "Convert text into lifelike speech using a voice of your choice."
---

# text-to-speech

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs text-to-speech <method> [flags]
```

## API Resources

 - `convert` — Create speech
 - `convert_with_timestamps` — Create speech with timing
 - `stream` — Stream speech
 - `stream_with_timestamps` — Stream speech with timing
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs text-to-speech --schema
elevenlabs text-to-speech <method> --schema

# Human-readable help (for humans)
elevenlabs text-to-speech --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

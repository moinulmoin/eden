---
name: "elevenlabs-speech-to-text"
description: "Transcribe your audio files with detailed speaker annotations and precise timestamps using our cutting-edge model."
---

# speech-to-text

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs speech-to-text <method> [flags]
```

## API Resources

 - `convert` — Create transcript

### transcripts

 - `delete` — Delete Transcript By Id
 - `get` — Get Transcript By Id
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs speech-to-text --schema
elevenlabs speech-to-text <method> --schema

# Human-readable help (for humans)
elevenlabs speech-to-text --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

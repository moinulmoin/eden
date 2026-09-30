---
name: "elevenlabs-speech-to-speech"
description: "Create speech by combining the style and content of an audio file you upload with a voice of your choice."
---

# speech-to-speech

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs speech-to-speech <method> [flags]
```

## API Resources

 - `convert` — Voice changer
 - `stream` — Voice changer stream
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs speech-to-speech --schema
elevenlabs speech-to-speech <method> --schema

# Human-readable help (for humans)
elevenlabs speech-to-speech --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

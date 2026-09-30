---
name: "elevenlabs-audio-isolation"
description: "Isolate speech from background noise in an audio file."
---

# audio-isolation

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs audio-isolation <method> [flags]
```

## API Resources

 - `convert` — Audio isolation
 - `delete` — Delete Audio Isolation History Item
 - `list` — Get Audio Isolation History
 - `stream` — Audio isolation stream
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs audio-isolation --schema
elevenlabs audio-isolation <method> --schema

# Human-readable help (for humans)
elevenlabs audio-isolation --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

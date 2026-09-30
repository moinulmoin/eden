---
name: "elevenlabs-music"
description: "Generate music from a text prompt."
---

# music

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs music <method> [flags]
```

## API Resources

 - `compose` — Compose Music
 - `compose_detailed` — Compose Music With A Detailed Response
 - `compose_detailed_stream` — Stream Composed Music With A Detailed Response
 - `separate_stems` — Stem Separation
 - `stream` — Stream Composed Music
 - `upload` — Upload Music
 - `video_to_music` — Video To Music

### composition-plan

 - `create` — Generate Composition Plan

### finetunes

 - `create` — Create Music Finetune
 - `delete` — Delete Music Finetune
 - `get` — Get Music Finetune
 - `list` — Get Music Finetunes
 - `update` — Update Music Finetune
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs music --schema
elevenlabs music <method> --schema

# Human-readable help (for humans)
elevenlabs music --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

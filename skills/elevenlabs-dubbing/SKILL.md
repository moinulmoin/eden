---
name: "elevenlabs-dubbing"
description: "Dub audio and video content into other languages while preserving the original speaker's voice."
---

# dubbing

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs dubbing <method> [flags]
```

## API Resources

 - `create` — Dub a video or audio file
 - `delete` — Delete dubbing
 - `get` — Get dubbing
 - `list` — List Dubs

### audio

 - `get` — Get dubbed audio

### project

 - `create` — Create Dubbing Project
 - `delete` — Delete Dubbing Project
 - `get` — Get Dubbing Project
 - `list` — List Dubbing Projects

#### language

 - `create` — Create Dubbing Language Target
 - `delete` — Delete Dubbing Language Target
 - `get` — Get Dubbing Language Target
 - `list` — List Dubbing Language Targets

##### transcript

 - `get` — Get Dubbing Target Transcript
 - `regenerate` — Regenerate Dubbing Target
 - `update_segment` — Update Dubbing Target Transcript Segment
 - `update_segments` — Update Dubbing Target Transcript Segments

#### transcript

 - `create_segment` — Add Dubbing Transcript Segment
 - `delete_segment` — Delete Dubbing Transcript Segment
 - `get` — Get Dubbing Transcript
 - `update_segment` — Update Dubbing Transcript Segment
 - `update_segments` — Update Dubbing Transcript Segments

### resource

 - `dub` — Dub segments
 - `get` — Get dubbing resource
 - `migrate_segments` — Move Segments Between Speakers
 - `render` — Render Audio Or Video For The Given Language
 - `transcribe` — Transcribe segments
 - `translate` — Translate segments

#### language

 - `add` — Add language to dubbing resource

#### segment

 - `delete` — Delete a segment
 - `update` — Modify a segment

#### speaker

 - `create` — Create A New Speaker
 - `find_similar_voices` — Search The Elevenlabs Library For Voices Similar To A Speaker.
 - `update` — Update Metadata For A Speaker

##### segment

 - `create` — Add speaker segment to dubbing resource

### transcript

 - `get_transcript_for_dub` — Get dubbed transcript

### transcripts

 - `get` — Retrieve A Transcript
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs dubbing --schema
elevenlabs dubbing <method> --schema

# Human-readable help (for humans)
elevenlabs dubbing --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

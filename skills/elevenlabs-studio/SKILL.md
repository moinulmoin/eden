---
name: "elevenlabs-studio"
description: "Access, create and convert Studio Projects programmatically."
---

# studio

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs studio <method> [flags]
```

## API Resources

 - `create_podcast` — Create Podcast

### projects

 - `convert` — Convert Studio Project
 - `create` — Create Studio Project
 - `delete` — Delete Studio Project
 - `get` — Get Studio Project
 - `get_muted_tracks` — Get Project Muted Tracks
 - `list` — List Studio Projects
 - `update` — Update Studio Project

#### chapters

 - `convert` — Convert Chapter
 - `create` — Create Chapter
 - `delete` — Delete Chapter
 - `get` — Get Chapter
 - `list` — List Chapters
 - `update` — Update Chapter

##### snapshots

 - `get` — Get Chapter Snapshot
 - `list` — List Chapter Snapshots
 - `stream` — Stream Chapter Audio

#### content

 - `update` — Update Studio Project Content

#### pronunciation-dictionaries

 - `create` — Create Pronunciation Dictionaries

#### snapshots

 - `get` — Get Project Snapshot
 - `list` — List Studio Project Snapshots
 - `stream` — Stream Studio Project Audio
 - `stream_archive` — Stream Archive With Studio Project Audio
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs studio --schema
elevenlabs studio <method> --schema

# Human-readable help (for humans)
elevenlabs studio --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

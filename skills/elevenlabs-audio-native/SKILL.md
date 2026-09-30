---
name: "elevenlabs-audio-native"
description: "Embed AI-narrated audio players into your website using Audio Native."
---

# audio-native

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs audio-native <method> [flags]
```

## API Resources

 - `create` — Create audio native project
 - `get_settings` — Get Audio Native Project Settings
 - `update` — Update audio native project
 - `update_content_from_url` — Update Audio-Native Content From Url
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs audio-native --schema
elevenlabs audio-native <method> --schema

# Human-readable help (for humans)
elevenlabs audio-native --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

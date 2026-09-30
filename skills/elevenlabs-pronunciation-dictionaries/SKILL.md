---
name: "elevenlabs-pronunciation-dictionaries"
description: "Manage pronunciation dictionaries that override how specific words are pronounced."
---

# pronunciation-dictionaries

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs pronunciation-dictionaries <method> [flags]
```

## API Resources

 - `create_from_file` — Create a pronunciation dictionary from a file
 - `create_from_rules` — Create a pronunciation dictionary from rules
 - `download` — Get pronunciation dictionary by version
 - `get` — Get pronunciation dictionary
 - `list` — List pronunciation dictionaries
 - `update` — Update Pronunciation Dictionary

### rules

 - `add` — Add pronunciation dictionary rules
 - `remove` — Remove pronunciation dictionary rules
 - `set` — Set pronunciation dictionary rules
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs pronunciation-dictionaries --schema
elevenlabs pronunciation-dictionaries <method> --schema

# Human-readable help (for humans)
elevenlabs pronunciation-dictionaries --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

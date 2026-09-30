---
name: "elevenlabs-samples"
description: "Access to your samples."
---

# samples

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs samples <method> [flags]
```

## API Resources

 - `delete` — Delete voice sample
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs samples --schema
elevenlabs samples <method> --schema

# Human-readable help (for humans)
elevenlabs samples --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

---
name: "elevenlabs-service-accounts"
description: "Manage API keys for your workspace."
---

# service-accounts

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs service-accounts <method> [flags]
```

## API Resources

 - `create` — Create Service Account
 - `list` — Get service accounts

### api-keys

 - `create` — Create API key
 - `delete` — Delete API key
 - `list` — Get API keys
 - `update` — Update API key
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs service-accounts --schema
elevenlabs service-accounts <method> --schema

# Human-readable help (for humans)
elevenlabs service-accounts --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

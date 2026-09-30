---
name: "elevenlabs-webhooks"
description: "Configure workspace webhooks and inspect their delivery history."
---

# webhooks

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs webhooks <method> [flags]
```

## API Resources

 - `create` — Create Workspace Webhook
 - `delete` — Delete Workspace Webhook
 - `list` — List Workspace Webhooks
 - `update` — Update Workspace Webhook
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs webhooks --schema
elevenlabs webhooks <method> --schema

# Human-readable help (for humans)
elevenlabs webhooks --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

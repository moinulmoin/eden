---
name: "elevenlabs-workspace"
description: "Access to workspace related endpoints."
---

# workspace

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs workspace <method> [flags]
```

## API Resources

 - `set-third-party-disabling-policy` — Set Workspace Third-Party Disabling Policy

### analytics


#### requests

 - `get` — List Api Requests

### audit-logs

 - `list` — Get Workspace Audit Logs

### auth-connections

 - `create` — Create Workspace Auth Connection
 - `delete` — Delete Workspace Auth Connection
 - `list` — Get Workspace Auth Connections
 - `update` — Update Workspace Auth Connection

### groups

 - `list` — List workspace groups
 - `search` — Search user group

#### members

 - `add` — Add member to user group
 - `remove` — Remove member from user group

### invites

 - `create` — Invite user
 - `create_batch` — Invite Multiple Users
 - `delete` — Delete invite

### members

 - `list` — Get Workspace Members
 - `update` — Update member

### resources

 - `get` — Get Resource
 - `share` — Share Workspace Resource
 - `unshare` — Unshare Workspace Resource

### usage

 - `get_usage_by_product_over_time` — Get Workspace Usage
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs workspace --schema
elevenlabs workspace <method> --schema

# Human-readable help (for humans)
elevenlabs workspace --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

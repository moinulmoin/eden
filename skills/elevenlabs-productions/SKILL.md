---
name: "elevenlabs-productions"
description: "Access and manage ElevenProductions orders."
---

# productions

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs productions <method> [flags]
```

## API Resources


### orders

 - `create` — Create Order
 - `get` — Get Order
 - `list` — List Orders
 - `submit` — Submit Order
 - `update` — Update Order

#### deliverables

 - `list` — Get Order Deliverables

#### items

 - `remove` — Remove Order Item
 - `upsert` — Upsert Order Item

#### languages

 - `list` — Get Available Languages

#### media

 - `get` — Get Media Info
 - `register` — Register Media
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs productions --schema
elevenlabs productions <method> --schema

# Human-readable help (for humans)
elevenlabs productions --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

---
name: "elevenlabs-voices"
description: "Access to voices created either by you or ElevenLabs."
---

# voices

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs voices <method> [flags]
```

## API Resources

 - `delete` — Delete voice
 - `find_similar_voices` — List similar voices
 - `get` — Get voice
 - `get_all` — List voices
 - `get_shared` — Get shared voices
 - `replicate_to_isolated_environment` — Replicate Voice To Isolated Environment
 - `search` — List voices
 - `share` — Add shared voice
 - `update` — Edit voice

### accents

 - `get` — Get Voice Accents

### ivc

 - `create` — Create voice clone

### pvc

 - `create` — Create PVC voice
 - `train` — Run Pvc Training
 - `update` — Edit Pvc Voice

#### samples

 - `create` — Add Samples To Pvc Voice
 - `delete` — Delete Pvc Voice Sample
 - `update` — Update Pvc Voice Sample

##### audio

 - `get` — Retrieve Voice Sample Audio

##### speakers

 - `get` — Retrieve Speaker Separation Status
 - `separate` — Start Speaker Separation

###### audio

 - `get` — Retrieve Separated Speaker Audio

##### waveform

 - `get` — Retrieve Voice Sample Visual Waveform

#### verification

 - `request` — Request Manual Verification

##### captcha

 - `get` — Get Pvc Voice Captcha
 - `verify` — Verify Pvc Voice Captcha

### samples


#### audio

 - `get` — Get audio from sample

### settings

 - `get` — Get voice settings
 - `get_default` — Get default voice settings
 - `update` — Edit voice settings
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs voices --schema
elevenlabs voices <method> --schema

# Human-readable help (for humans)
elevenlabs voices --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```

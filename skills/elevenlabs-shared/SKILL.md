---
name: "elevenlabs-shared"
description: "elevenlabs CLI: Shared patterns for authentication, global flags, and output formatting."
---

# elevenlabs — Shared Reference

## Authentication

Every request is authenticated with an ElevenLabs API key, sent as the `xi-api-key` header.

```bash
export ELEVENLABS_API_KEY=xi-...
```

A `.env` file in the working directory is loaded automatically. For a one-off call, pass `--xi-api-key xi-...` instead. `elevenlabs auth login` sets up OAuth in a keyring as an alternative to the env var.

## Global Flags

These flags appear across the CLI. The harness-level ones (`--dry-run`, `--format`, `--base-url`, `--quiet`) are available on every command; the rest (`--page-all`, `--output`, ...) surface on operations whose spec supports the affordance — check the per-op `--schema` output's `paginable` / `binaryResponse` hints to know which ops carry them.

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Validate locally without sending the request | |
| `--format <FMT>` | Output format: `json`, `table`, `yaml`, `csv`, `raw`, `jsonl`, `http` | `json` |
| `--base-url <URL>` | Override the API base URL | |
| `--params <JSON>` | URL/query/path parameters as JSON | |
| `--json <JSON>` | Request body for POST/PATCH/PUT | |
| `-o, --output <PATH>` | Write binary responses to a file; use `-` to stream to stdout for piping into other commands (e.g. `ffplay -`, `aplay -`). | |
| `--page-all` | Auto-paginate (NDJSON) | off |
| `--page-limit <N>` | Max pages to fetch | `10` |
| `--page-delay <MS>` | Delay between page fetches | `100` |
| `--no-pager` | Disable pager even on interactive terminals | |
| `--no-retry` | Disable retries | |
| `--no-extract` | Print the full response body | |

## Output Formatting

```bash
# JSON (default)
elevenlabs <resource> <method> --format json

# Table view
elevenlabs <resource> <method> --format table

# Pipe-friendly: jq, grep, etc.
elevenlabs <resource> <method> | jq '.fieldName'
```

## Dry Run

Use `--dry-run` to preview the HTTP request without sending it:

```bash
elevenlabs <resource> <method> --dry-run
```


## Telling us what you are doing

Two inputs let you report what you are trying to accomplish and what you could
not do. Neither changes what a command does.

### `--intent` — why you are running this command

Optional, and available on every command. Sent as a request header. Nothing
changes if you leave it off, but supplying it is what tells us which commands
to build next:

```bash
elevenlabs voices search --intent "pick a narrator voice for an audiobook"
```

One sentence describing the user's goal, max 500 characters, on one line.

No environment variable sets this once for a whole task. A fresh sentence per
command is the point — read back in order, they show what you were actually
working through.

### `elevenlabs feedback missing-capability` — what you could not do

Call this when the user's request cannot be completed with any available
`elevenlabs` command. Describe the capability you were looking for, so it can
inform which commands get built next. Do not call it when an existing command
already covers the request.

```bash
elevenlabs feedback missing-capability \
  "no way to batch-render a script to separate files per speaker"
```

It records the report and returns; it does not fail the task. Continue with the
available commands, or tell the user the thing is not supported yet.

### Never put personal data in either field

Describe the *goal*, not the data. Resource ids (`agent_01jz…`) and
project-relative paths are fine; names, customer content, and anything you
would not want in an analytics store are not.

Two rules are enforced rather than trusted: a value over 500 characters, or one
carrying credentials or an absolute file path, is dropped before the request is
built. `--intent` warns on stderr and the command proceeds normally — a dropped
value still satisfies the requirement, so you do not need to retry, but fix the
wording next time; `feedback` fails so you can rewrite it.

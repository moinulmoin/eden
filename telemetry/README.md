# Eden telemetry collector

The Worker that receives Eden's anonymous usage events at
`https://telemetry.eden.ideaplexa.com/v1/events`. What the CLI sends, and
what it never sends, is in the README's
[Telemetry section](../README.md#telemetry).

`src/index.ts` answers `204` to a JSON `POST` of the exact event shape up
to 1 KB and writes it to the `eden_telemetry` Workers Analytics Engine
dataset. Anything else gets a `4xx` and is not written. It never reads the
IP address, headers other than `content-type` and `content-length`, or the
user agent. `cloudflare.config.ts` turns off `workers.dev`, Preview URLs,
and Workers Logs.

## Deploy

With the `cf` login of the account that owns `ideaplexa.com`:

```sh
pnpm --dir telemetry run deploy
```

`build.mjs` bundles `src/index.ts` with esbuild into Build Output, and
`cf deploy --prebuilt` publishes it. It changes only the `eden-telemetry`
Worker and its custom domain.

## Read the numbers

```sh
pnpm --dir telemetry run stats
```

It runs `cf analytics-engine sql query` with the same `cf` login and prints
active installs, commands by outcome, Eden versions, Eve versions and
Worlds, and platforms for the last 7 days. Analytics Engine keeps three
months of data.

For another question, run your own query, for example
`pnpm --dir telemetry exec cf analytics-engine sql query --body "SELECT ... FROM eden_telemetry FORMAT JSON"`.
The columns:

| Column | Field |
| --- | --- |
| `index1`, `blob1` | `installId` |
| `blob2` | `command` |
| `blob3` | `edenVersion` |
| `blob4` | `failureCode`, empty on success |
| `blob5` | `duration` |
| `blob6` | `os` |
| `blob7` | `arch` |
| `blob8` | `eveVersion`, empty when unknown |
| `blob9` | `world`, empty when unknown |
| `blob10` | `ci`, `true` or `false` |
| `double1` | `exitCode` |
| `double2` | `nodeMajor` |
| `double3` | `schema` |

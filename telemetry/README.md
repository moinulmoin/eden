# Eden telemetry collector

The Worker that receives Eden's anonymous usage events at
`https://telemetry.eden.ideaplexa.com/v1/events`. What the CLI sends, and
what it never sends, is in the README's
[Telemetry section](../README.md#telemetry).

`src/index.ts` answers `204` to a JSON `POST` of the exact event shape,
serialized exactly as the CLI does, up to 1 KB, and writes it to the `eden_telemetry` Workers Analytics Engine
dataset. Anything else gets a `4xx` and is not written. It never reads the
IP address, headers other than `content-type` and `content-length`, or the
user agent. `cloudflare.config.ts` turns off `workers.dev`, Preview URLs,
and Workers Logs.

It accepts only the failure codes in
`packages/cli/src/failure-codes.ts`, the list the CLI sends from, bundled
into the Worker at build. After you add a code there, deploy the collector
before you release a CLI that sends it; until then the collector refuses
those events.

## Deploy

With your `cf` login, on the account that owns `ideaplexa.com`:

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

It runs `cf analytics-engine sql query` with your `cf` login (`cf auth
login`, or `CLOUDFLARE_API_TOKEN` with Account Analytics read) and prints
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
| `blob8` | `eveVersion` |
| `blob9` | `world` |
| `blob10` | `ci`, `true` or `false` |
| `double1` | `exitCode` |
| `double2` | `nodeMajor` |
| `double3` | `schema` |

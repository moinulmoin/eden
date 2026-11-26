// Writes the Build Output that cf deploy --prebuilt publishes: the Worker
// from cloudflare.config.ts with src/index.ts bundled by esbuild.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

import config from "./cloudflare.config.ts";

const output = ".cloudflare/output/v1";
const { entrypoint, ...worker } = config.worker;
await rm(".cloudflare/output", { recursive: true, force: true });
await build({
  entryPoints: [entrypoint],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: `${output}/workers/default/bundle/worker.js`,
  logLevel: "warning",
});
await mkdir(`${output}/workers/default`, { recursive: true });
await writeFile(`${output}/config.json`, JSON.stringify({ buildContext: { isPreview: false } }));
await writeFile(`${output}/workers/default/worker.config.json`, JSON.stringify({
  ...worker,
  manifest: { type: "complete", mainModule: "worker.js", modules: { "worker.js": { type: "esm" } } },
}));

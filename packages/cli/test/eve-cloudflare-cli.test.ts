import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test.each(["SIGINT", "SIGTERM"] as const)("%s while cf runs removes the folder that holds the secrets file", async (signal) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "eden-cf-signal-")));
  cleanups.push(() => rm(temporary, { recursive: true, force: true }));
  // An API that never answers, so the real cf waits with the secrets file on disk.
  const api = createServer(() => undefined);
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { api.closeAllConnections(); api.close(resolve); }));
  const script = join(temporary, "run.mjs");
  await writeFile(script, [
    "const { createCloudflareCliRunner, cloudflareCliEnvironment } = await import(process.argv[2]);",
    "const run = createCloudflareCliRunner((account) => ({ ...cloudflareCliEnvironment(account), CLOUDFLARE_API_TOKEN: 'not-a-token', CLOUDFLARE_API_BASE_URL: process.argv[3] }));",
    "await run({ args: ['workers', 'list'], accountId: '1'.repeat(32), files: { 'secrets.json': '{\"MODEL_KEY\":\"model-key-value\"}' } });",
  ].join("\n"), "utf8");
  const child = spawn(process.execPath, [
    script,
    fileURLToPath(new URL("../src/eve-cloudflare-cli.ts", import.meta.url)),
    "http://127.0.0.1:" + String((api.address() as AddressInfo).port) + "/client/v4",
  ], { env: { ...process.env, TMPDIR: temporary }, stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("close", (_code, by) => resolve(by)));
  const folders = () => readdirSync(temporary).filter((name) => name.startsWith("eden-cf-"));
  await expect.poll(() => folders().some((name) => existsSync(join(temporary, name, "secrets.json"))), { timeout: 20_000 }).toBe(true);
  child.kill(signal);
  expect(await exited).toBe(signal);
  expect(folders()).toEqual([]);
}, 30_000);

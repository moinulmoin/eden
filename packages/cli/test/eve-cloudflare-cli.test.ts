import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";

import { cloudflareApiReader, cloudflareApiTokenArrives } from "../src/eve-cloudflare-api.js";
import { cloudflareCliEnvironment, createCloudflareCliRunner, type CloudflareCliRunner } from "../src/eve-cloudflare-cli.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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

/** Whether another program could take the port now. */
const free = (port: number) => new Promise<boolean>((resolve) => {
  const other = createServer();
  other.once("error", () => resolve(false));
  other.listen(port, "127.0.0.1", () => other.close(() => resolve(true)));
});

test("a cf that cannot be stopped is not reported as gone, and the listener keeps its port", async () => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  // An API that never answers, so the real cf runs until it is stopped.
  const api = createServer(() => undefined);
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { api.closeAllConnections(); api.close(resolve); }));
  const stuck = "http://127.0.0.1:" + String((api.address() as AddressInfo).port) + "/client/v4";
  const real = createCloudflareCliRunner((account) => ({ ...cloudflareCliEnvironment(account), CLOUDFLARE_API_TOKEN: "no-ones-token-" + "0".repeat(30), CLOUDFLARE_API_BASE_URL: stuck }));
  // What Node does when the system refuses the signal: an "error" on the child, which keeps running.
  const children: ChildProcess[] = [];
  const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess) {
    children.push(this);
    this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
    return false;
  });
  cleanups.push(async () => { kill.mockRestore(); children[0]?.kill("SIGKILL"); });
  let port = 0;
  let running: boolean | undefined;
  const cf: CloudflareCliRunner = async (request) => {
    port = Number(new URL(request.apiBaseUrl ?? "").port);
    // cf is sent to the API that never answers, and gets one second.
    const result = await real({ args: request.args, timeoutMs: 1_000 });
    running = result.running;
    return result;
  };
  expect(await cloudflareApiTokenArrives(cf)).toBe(false);
  expect({ running, alive: children[0]?.exitCode === null && children[0].signalCode === null }).toEqual({ running: true, alive: true });
  expect(await free(port)).toBe(false);
}, 30_000);

test("the listener that takes cf's token keeps its port from before cf starts until cf has exited", async () => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  // The real cf, with a token that is no one's: it asks the address it is given who it is, three times.
  const real = createCloudflareCliRunner((account) => ({ ...cloudflareCliEnvironment(account), CLOUDFLARE_API_TOKEN: "no-ones-token-" + "0".repeat(30) }));
  let port = 0;
  let freed = 0;
  const cf: CloudflareCliRunner = async (request) => {
    port = Number(new URL(request.apiBaseUrl ?? "").port);
    let running = true;
    const result = real(request).finally(() => { running = false; });
    // Another local program tries to take the port for as long as cf runs, and once more when it has exited.
    while (running) {
      if (await free(port)) freed += 1;
      await sleep(10);
    }
    if (await free(port)) freed += 1;
    return result;
  };
  expect(await cloudflareApiTokenArrives(cf)).toBe(true);
  expect(freed).toBe(0);
  expect(await free(port)).toBe(true);
}, 30_000);

test("a read of the API with 50 ms left gives the token capture no more than that", async () => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  const asked: (number | undefined)[] = [];
  // A cf that takes as long as it is allowed, up to two seconds, and hands over nothing.
  const cf: CloudflareCliRunner = async (request) => {
    asked.push(request.timeoutMs);
    await sleep(Math.min(request.timeoutMs ?? 2_000, 2_000));
    return { exitCode: undefined, stdout: "", stderr: "" };
  };
  const started = performance.now();
  expect(await cloudflareApiReader(cf)("/accounts/" + "1".repeat(32) + "/workers/subdomain", {}, 50)).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toBeLessThanOrEqual(50);
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

import collector from "../../../telemetry/src/index.js";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A local endpoint that records each body; "slow" never answers. */
async function endpoint(mode: "answer" | "slow" = "answer"): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      bodies.push(body);
      if (mode === "answer") response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: "http://127.0.0.1:" + String((server.address() as AddressInfo).port) + "/v1/events", bodies };
}

/** A machine with an Eve project whose names and paths must never be sent. */
async function machine(): Promise<{ root: string; project: string; config: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eden-telemetry-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "planted-project-acme");
  await mkdir(join(project, "node_modules", "eve"), { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "planted-project-acme",
    dependencies: { eve: "1.3.0", "@moinulmoin/eden-world-cloudflare": "0.15.2" },
  }));
  await writeFile(join(project, "node_modules", "eve", "package.json"), JSON.stringify({ name: "eve", version: "1.3.0" }));
  return { root, project, config: join(root, "config") };
}

async function eden(args: readonly string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr, ms: Date.now() - started };
}

const environment = (where: { root: string; config: string }, url: string, extra: Record<string, string> = {}) => ({
  HOME: where.root,
  TMPDIR: where.root,
  XDG_CONFIG_HOME: where.config,
  EDEN_TELEMETRY_URL: url,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  ...extra,
});

const destroy = (project: string) => ["destroy", "--project", project, "--name", "planted-target", "--json"];

test("the first command prints the notice once on stderr, and --json stdout stays one JSON object", async () => {
  const where = await machine();
  const server = await endpoint();
  const off = await eden(destroy(where.project), environment(where, server.url, { EDEN_TELEMETRY: "0" }));
  const first = await eden(destroy(where.project), environment(where, server.url));
  const second = await eden(destroy(where.project), environment(where, server.url));
  expect([first.code, second.code]).toEqual([off.code, off.code]);
  expect(first.stdout).toBe(off.stdout);
  expect(second.stdout).toBe(off.stdout);
  expect(first.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(first.stdout)).toMatchObject({ ok: false, error: { code: "EVE_DESTROY_RECORD_UNPROVEN" } });
  expect(first.stderr).toContain("Eden sends anonymous usage data");
  expect(first.stderr).toContain("EDEN_TELEMETRY=0 or DO_NOT_TRACK=1");
  expect(first.stderr).toContain("https://github.com/moinulmoin/eden#telemetry");
  expect(second.stderr).toBe("");
  const saved = JSON.parse(await readFile(join(where.config, "eden", "telemetry.json"), "utf8")) as { installId: string };
  expect(server.bodies.map((body) => (JSON.parse(body) as { installId: string }).installId)).toEqual([saved.installId, saved.installId]);
});

test("the event holds exactly the documented fields and nothing that names the project, account, or machine", async () => {
  const where = await machine();
  const server = await endpoint();
  const result = await eden(destroy(where.project), environment(where, server.url, { CI: "true" }));
  expect(result.code).toBe(1);
  expect(server.bodies).toHaveLength(1);
  const body = server.bodies[0] ?? "";
  const event = JSON.parse(body) as Record<string, unknown>;
  expect(Object.keys(event).sort()).toEqual([
    "arch", "ci", "command", "duration", "edenVersion", "eveVersion", "exitCode",
    "failureCode", "installId", "nodeMajor", "os", "schema", "world",
  ]);
  expect(event).toMatchObject({
    schema: 1,
    command: "destroy",
    exitCode: 1,
    failureCode: "EVE_DESTROY_RECORD_UNPROVEN",
    duration: "<10s",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    eveVersion: "1.3.0",
    world: "cloudflare",
    ci: true,
  });
  for (const planted of ["planted-project-acme", "planted-target", ACCOUNT_ID, where.root, hostname()]) {
    expect(body).not.toContain(planted);
  }
  const points: unknown[] = [];
  const accepted = await collector.fetch(new Request("https://telemetry.eden.ideaplexa.com/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    body,
  }), { EVENTS: { writeDataPoint: (point) => { points.push(point); } } });
  expect(accepted.status).toBe(204);
  expect(points).toHaveLength(1);
});

test.each([
  ["EDEN_TELEMETRY", "0"],
  ["EDEN_TELEMETRY", "false"],
  ["EDEN_TELEMETRY", "off"],
  ["DO_NOT_TRACK", "1"],
])("%s=%s sends nothing, prints no notice, and creates no install ID", async (name, value) => {
  const where = await machine();
  const server = await endpoint();
  const result = await eden(destroy(where.project), environment(where, server.url, { [name]: value }));
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  expect(server.bodies).toEqual([]);
  expect(existsSync(where.config)).toBe(false);
});

test("help and version send nothing and create no install ID", async () => {
  const where = await machine();
  const server = await endpoint();
  for (const args of [["--help"], ["--version"], ["deploy", "--help"], ["destroy", "-h", "--json"]]) {
    expect((await eden(args, environment(where, server.url))).code).toBe(0);
  }
  expect(server.bodies).toEqual([]);
  expect(existsSync(where.config)).toBe(false);
});

test("an unreachable or silent endpoint changes neither the exit code nor the output, and adds at most about a second", async () => {
  const where = await machine();
  await mkdir(join(where.config, "eden"), { recursive: true });
  await writeFile(join(where.config, "eden", "telemetry.json"), JSON.stringify({ installId: "3f2b8c1e-6a4d-4f1b-9c2e-7d8a9b0c1d2e" }));
  const silent = await endpoint("slow");
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const unreachable = "http://127.0.0.1:" + String((closed.address() as AddressInfo).port) + "/v1/events";
  await new Promise((resolve) => closed.close(resolve));
  const off = await eden(destroy(where.project), environment(where, silent.url, { EDEN_TELEMETRY: "0" }));
  const refused = await eden(destroy(where.project), environment(where, unreachable));
  const hung = await eden(destroy(where.project), environment(where, silent.url));
  for (const run of [refused, hung]) {
    expect(run.code).toBe(off.code);
    expect(run.stdout).toBe(off.stdout);
    expect(run.stderr).toBe(off.stderr);
  }
  expect(silent.bodies).toHaveLength(1);
  expect(hung.ms - off.ms).toBeLessThan(2_000);
});

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
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

async function eden(
  args: readonly string[],
  env: Record<string, string>,
  { closedStderr = false, script }: { closedStderr?: boolean; script?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, script === undefined ? [cli, ...args] : [script, cli, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  if (closedStderr) child.stderr.destroy();
  else child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
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
    // Destroy stopped before it read a deployment record, so it resolved neither.
    eveVersion: "other",
    world: "other",
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

/**
 * Runs the built CLI's dispatcher with a stand-in for the command's work,
 * the way the eden binary does: it succeeds, or fails with the code given.
 */
async function standIn(root: string): Promise<string> {
  const script = join(root, "stand-in.mjs");
  await writeFile(script, [
    "const [cli, code, ...args] = process.argv.slice(2);",
    "const { runEdenCli, EveCliError } = await import(cli);",
    "process.exitCode = await runEdenCli(args, { telemetry: true, eveRunner: () => {",
    "  if (code !== 'ok') throw new EveCliError({ code, message: 'Planted failure.' });",
    "} });",
  ].join("\n"));
  return script;
}

async function written(body: string): Promise<{ status: number; points: unknown[] }> {
  const points: unknown[] = [];
  const response = await collector.fetch(new Request("https://telemetry.eden.ideaplexa.com/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    body,
  }), { EVENTS: { writeDataPoint: (point) => { points.push(point); } } });
  return { status: response.status, points };
}

const PLANTED_HOST = "build.planted-host.example.com";

test.each([
  ["the installed Eve manifest", { "node_modules/eve/package.json": JSON.stringify({ version: "1.3.0-" + PLANTED_HOST }) }],
  ["the npm lockfile", { "package-lock.json": JSON.stringify({ packages: { "node_modules/eve": { version: "1.3.0+" + PLANTED_HOST } } }) }],
  ["the pnpm lockfile", { "pnpm-lock.yaml": "importers:\n  .:\n    dependencies:\n      eve:\n        specifier: 1.3.0\n        version: 1.3.0-" + PLANTED_HOST + "\n" }],
])("telemetry reads no project file: a version planted in %s never reaches the body or the dataset", async (_source, files) => {
  const where = await machine();
  await rm(join(where.project, "node_modules"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(where.project, path, ".."), { recursive: true });
    await writeFile(join(where.project, path), text);
  }
  const server = await endpoint();
  await eden(destroy(where.project), environment(where, server.url));
  const body = server.bodies[0] ?? "";
  expect(JSON.parse(body)).toMatchObject({ eveVersion: "other" });
  expect(body).not.toContain("planted-host");
  const stored = await written(body);
  expect(stored.status).toBe(204);
  expect(JSON.stringify(stored.points)).not.toContain("planted-host");
});

test("a failure code that is not one of Eden's is sent as other; a success sends exit 0 and no code", async () => {
  const where = await machine();
  const script = await standIn(where.root);
  const server = await endpoint();
  const args = ["destroy", "--project", where.project, "--name", "planted-target", "--json"];
  const failed = await eden(["PLANTED_HOST_EXAMPLE_COM", ...args], environment(where, server.url), { script });
  const succeeded = await eden(["ok", ...args], environment(where, server.url), { script });
  expect([failed.code, succeeded.code]).toEqual([1, 0]);
  expect(server.bodies.map((body) => JSON.parse(body) as Record<string, unknown>)).toMatchObject([
    { exitCode: 1, failureCode: "other" },
    { exitCode: 0, failureCode: null },
  ]);
  expect(server.bodies.join("")).not.toContain("PLANTED");
});

test("a stalled TLS handshake and FIFOs in the project and config end within about a second", async () => {
  const where = await machine();
  await rm(join(where.project, "node_modules"), { recursive: true });
  execFileSync("mkfifo", [join(where.project, "pnpm-lock.yaml")]);
  execFileSync("mkfifo", [join(where.project, "package-lock.json")]);
  const sockets: Socket[] = [];
  const stalled = createTcpServer((socket) => { sockets.push(socket); });
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); stalled.close(resolve); }));
  const url = "https://127.0.0.1:" + String((stalled.address() as AddressInfo).port) + "/v1/events";
  const off = await eden(destroy(where.project), environment(where, url, { EDEN_TELEMETRY: "0" }));
  const tls = await eden(destroy(where.project), environment(where, url));
  expect(sockets.length).toBeGreaterThan(0);
  const fifoConfig = await machine();
  await mkdir(join(fifoConfig.config, "eden"), { recursive: true });
  execFileSync("mkfifo", [join(fifoConfig.config, "eden", "telemetry.json")]);
  const server = await endpoint();
  const config = await eden(destroy(fifoConfig.project), environment(fifoConfig, server.url));
  for (const run of [tls, config]) {
    expect(run.code).toBe(off.code);
    expect(run.stdout.replace(where.project, "")).toBe(off.stdout.replace(where.project, ""));
    expect(run.ms - off.ms).toBeLessThan(1_500);
  }
  expect(server.bodies).toEqual([]);
});

test("two first runs at once send one install ID and print one notice", async () => {
  const where = await machine();
  const other = join(where.root, "second-project");
  await mkdir(other);
  const server = await endpoint();
  const runs = await Promise.all([
    eden(destroy(where.project), environment(where, server.url)),
    eden(destroy(other), environment(where, server.url)),
  ]);
  expect(runs.filter((run) => run.stderr.includes("Eden sends anonymous usage data"))).toHaveLength(1);
  const ids = new Set(server.bodies.map((body) => (JSON.parse(body) as { installId: string }).installId));
  expect(ids.size).toBe(1);
  expect(server.bodies.length).toBeGreaterThanOrEqual(1);
  expect((await readdir(join(where.config, "eden"))).sort()).toEqual(["telemetry.json"]);
});

test.each([
  ["telemetry.json is a symbolic link", async (folder: string, outside: string) => {
    await mkdir(folder, { recursive: true });
    await symlink(join(outside, "unrelated.txt"), join(folder, "telemetry.json"));
  }],
  ["the eden folder is a symbolic link", async (folder: string, outside: string) => {
    await mkdir(join(folder, ".."), { recursive: true });
    await symlink(outside, folder);
  }],
  ["telemetry.json is corrupt", async (folder: string) => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "telemetry.json"), "not json, keep me\n");
  }],
  ["telemetry.json is unreadable", async (folder: string) => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "telemetry.json"), JSON.stringify({ installId: "3f2b8c1e-6a4d-4f1b-9c2e-7d8a9b0c1d2e" }));
    await chmod(join(folder, "telemetry.json"), 0o000);
  }],
  ["the eden folder is not writable", async (folder: string) => {
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o500);
  }],
])("when %s, nothing is sent, no notice is printed, and nothing is overwritten", async (_case, prepare) => {
  const where = await machine();
  const folder = join(where.config, "eden");
  const outside = join(where.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "unrelated.txt"), "not json, keep me\n");
  await prepare(folder, outside);
  cleanups.unshift(() => chmod(folder, 0o700).catch(() => undefined));
  const before = await readdir(outside);
  const server = await endpoint();
  const result = await eden(destroy(where.project), environment(where, server.url));
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  expect(server.bodies).toEqual([]);
  expect(await readdir(outside)).toEqual(before);
  expect(await readFile(join(outside, "unrelated.txt"), "utf8")).toBe("not json, keep me\n");
  if (_case === "telemetry.json is corrupt") {
    expect(await readFile(join(folder, "telemetry.json"), "utf8")).toBe("not json, keep me\n");
  }
});

test("a closed stderr leaves the exit code and stdout of a failed and a successful command unchanged", async () => {
  const where = await machine();
  const script = await standIn(where.root);
  const server = await endpoint();
  const args = ["destroy", "--project", where.project, "--name", "planted-target", "--json"];
  const failed = await eden(destroy(where.project), environment(where, server.url), { closedStderr: true });
  await rm(where.config, { recursive: true, force: true });
  const succeeded = await eden(["ok", ...args], environment(where, server.url), { closedStderr: true, script });
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false });
  expect(succeeded.code).toBe(0);
  expect(JSON.parse(succeeded.stdout)).toMatchObject({ ok: true });
  expect(server.bodies).toHaveLength(2);
});

/* global AbortController, console, fetch, process, setTimeout, clearTimeout, TextDecoder, URL */

// Live Cloudflare check: runs Eden's whole life cycle against the real
// Cloudflare account this machine's Wrangler is logged in to, on one temporary
// target. Once a deploy has started, eden destroy runs at the end, when a step
// fails, and on Ctrl-C. If destroy fails, the retry command is printed and the
// target stays. A killed process (SIGKILL) cleans up nothing. See
// docs/validation.md.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serveWorldTarball } from "../eve-compat/eden-leg.mjs";
import { registryCatalogRefs } from "./registry-catalog.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const edenCli = join(repoRoot, "packages/cli/dist/index.js");
const wranglerCli = join(repoRoot, "node_modules/.bin/wrangler");
const TARGET_PATTERN = /^eden-live-\d{8}-[0-9a-f]{8}$/u;
const WORLD = "@moinulmoin/eden-world-cloudflare";
const MODEL_KEY = "AI_GATEWAY_API_KEY";
const PROOF_FILE = "/workspace/live-check.txt";
// The compatibility fixtures' models: a free one first, then fallbacks for when it is unavailable.
const DEFAULT_MODELS = ["minimax/minimax-m3-free", "poolside/laguna-s-2.1-free", "alibaba/qwen3.7-flash"];

const usage = [
  "Usage: pnpm run check:live -- --env-file <path> [options]",
  "",
  "Deploys a fresh Eve project to a temporary Cloudflare target with the locally",
  "built CLI and the Cloudflare World packed from this workspace, checks sessions",
  "across an update, an Eve upgrade, and a sleep, then destroys the target. Uses",
  "this machine's Wrangler login and Docker.",
  "",
  "Options:",
  "  --env-file <path>     File holding " + MODEL_KEY + "=<key> (required)",
  "  --eve <version>       Eve version to start on (default: the floor fixture's)",
  "  --upgrade-to <version> Eve version to upgrade to (default: the latest fixture's);",
  "                        the upgrade step is skipped when it equals --eve",
  "  --world <source>      " + WORLD + ": workspace packs",
  "                        packages/world-cloudflare into a pnpm project (default);",
  "                        latest or an exact version installs the published",
  "                        package into an npm project",
  "  --model <id>          AI Gateway model (default: " + DEFAULT_MODELS[0] + ", falling back to",
  "                        " + DEFAULT_MODELS.slice(1).join(" and ") + ")",
  "  --sleep-after <time>  Idle window for the sleep step (default: 90s)",
  "  --skip-sleep          Skip the sleep and wake step and keep the 1 hour default",
  "  --keep-work           Keep the temporary project folder (the target is still destroyed)",
  "  --help                Show this help",
].join("\n");

function fixtureEve(name) {
  return JSON.parse(readFileSync(join(repoRoot, "validation/eve-compat", name, "package.json"), "utf8")).dependencies.eve;
}

function parseArguments(argv) {
  const options = {
    eve: fixtureEve("floor"),
    upgradeTo: fixtureEve("latest"),
    world: "workspace",
    model: undefined,
    sleepAfter: "90s",
    skipSleep: false,
    keepWork: false,
  };
  const valued = { "--env-file": "envFile", "--eve": "eve", "--upgrade-to": "upgradeTo", "--world": "world", "--model": "model", "--sleep-after": "sleepAfter" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (argument === "--skip-sleep") options.skipSleep = true;
    else if (argument === "--keep-work") options.keepWork = true;
    else if (valued[argument] !== undefined && argv[index + 1] !== undefined) options[valued[argument]] = argv[++index];
    else throw new Error("Unknown or incomplete option " + argument + ".\n\n" + usage);
  }
  if (options.envFile === undefined) throw new Error("--env-file is required.\n\n" + usage);
  for (const version of [options.eve, options.upgradeTo]) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Eve versions must be exact, for example 1.0.2; got " + version + ".");
  }
  if (!/^(?:workspace|latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.test(options.world)) throw new Error("--world must be workspace, latest, or an exact version.");
  if (options.model !== undefined && !/^[A-Za-z0-9._/:-]+$/u.test(options.model)) throw new Error("--model is not a plain model id.");
  const sleep = /^(\d+)(s|m)$/u.exec(options.sleepAfter);
  if (sleep === null) throw new Error("--sleep-after takes seconds or minutes, for example 90s or 3m.");
  options.sleepAfterMs = Number(sleep[1]) * (sleep[2] === "m" ? 60_000 : 1_000);
  return options;
}

function readModelKey(path) {
  const line = readFileSync(resolve(path), "utf8").split(/\r?\n/u).find((entry) => entry.startsWith(MODEL_KEY + "="));
  const value = line === undefined ? "" : line.slice(MODEL_KEY.length + 1);
  if (value.length === 0) throw new Error(path + " has no " + MODEL_KEY + "=<key> line.");
  return value;
}

const secrets = [];
function redact(text) {
  let result = String(text);
  for (const secret of secrets) result = result.split(secret).join("<redacted>");
  return result;
}
function log(line) {
  console.error(redact(line));
}
function tail(text, lines = 15) {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}
function seconds(ms) {
  return Math.round(ms / 100) / 10;
}
function wait(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Interrupted."));
    }, { once: true });
  });
}

// One child at a time. An interrupt stops the running child, then the caller's
// finally block destroys the target.
const interrupt = new AbortController();
let activeChild;
let cleaning = false;
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(name, () => {
    if (cleaning) {
      log("Still destroying the temporary target; wait for it to finish.");
      return;
    }
    log("\n" + name + " received; stopping and destroying the temporary target.");
    interrupt.abort();
    activeChild?.kill("SIGTERM");
  });
}

// pnpm run exports npm_* settings that point npm at this repository; children
// must see the environment a user's shell would give them.
const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:npm_|pnpm_|INIT_CWD$)/iu.test(name)));

function run(file, args, { cwd = repoRoot, env = baseEnvironment, timeoutMs = 600_000, interruptible = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (interruptible && interrupt.signal.aborted) {
      reject(new Error("Interrupted."));
      return;
    }
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      resolvePromise({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function runOrThrow(label, file, args, options) {
  const result = await run(file, args, options);
  if (result.code !== 0) throw new Error(label + " exited with " + (result.signal ?? result.code) + ".\n" + tail(result.stdout + "\n" + result.stderr));
  return result;
}

let options;
let modelKey;
try {
  options = parseArguments(process.argv.slice(2));
  modelKey = readModelKey(options.envFile);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const authToken = randomBytes(24).toString("hex");
secrets.push(modelKey, authToken);

const target = "eden-live-" + new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomBytes(4).toString("hex");
const workRoot = realpathSync(mkdtempSync(join(tmpdir(), "eden-live-")));
const project = join(workRoot, target);
const envFile = join(workRoot, "live.env");
const nonce = "eden-live-" + randomBytes(6).toString("hex");
let worldTarball;
const edenEnvironment = options.skipSleep ? baseEnvironment : { ...baseEnvironment, EDEN_EVE_CONTAINER_SLEEP_AFTER: options.sleepAfter };

const summary = {
  ok: false,
  target,
  origin: null,
  eve: options.eve,
  upgradedTo: options.upgradeTo === options.eve ? null : options.upgradeTo,
  world: null,
  worldSource: options.world === "workspace" ? "workspace" : "npm",
  model: options.model ?? DEFAULT_MODELS.join(", then "),
  sleepAfter: options.skipSleep ? null : options.sleepAfter,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  steps: [],
};

async function step(title, body) {
  const started = Date.now();
  const entry = { step: title, status: "passed", seconds: 0 };
  summary.steps.push(entry);
  try {
    const detail = await body(entry);
    if (detail === "skipped") entry.status = "skipped";
    else if (detail !== undefined) entry.detail = detail;
  } catch (error) {
    entry.status = "failed";
    entry.detail = redact(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    entry.seconds = seconds(Date.now() - started);
    const mark = entry.status === "passed" ? "✓" : entry.status === "skipped" ? "-" : "✗";
    log(mark + " " + title + " (" + entry.seconds + " s)" + (entry.detail === undefined ? "" : "\n    " + String(entry.detail).split("\n").join("\n    ")));
  }
}

// Every Eden command goes through here, so nothing but this run's generated
// temporary target can be deployed to or destroyed.
async function eden(command, { withEnvFile = true, interruptible = true } = {}) {
  if (!TARGET_PATTERN.test(target) || !project.endsWith("/" + target)) {
    throw new Error("Refusing to run eden " + command + ": " + target + " is not this run's temporary target.");
  }
  const args = [edenCli, command, "--project", project, "--env", "preview", "--name", target, "--json"];
  if (withEnvFile) args.push("--env-file", envFile);
  const result = await run(process.execPath, args, { env: edenEnvironment, timeoutMs: 1_800_000, interruptible });
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error("eden " + command + " did not print one JSON object (exit " + result.code + ").\n" + tail(result.stdout + "\n" + result.stderr));
  }
  // A deploy names the account it pushed to, also when it fails after publishing.
  registryAccount = /^registry\.cloudflare\.com\/([A-Za-z0-9_-]+)\/eden-eve-/u.exec(output.deployment?.imageReference ?? "")?.[1] ?? registryAccount;
  if (result.code !== 0 || output.ok !== true) {
    const failed = (output.checks ?? []).filter((check) => check.status === "failed").map((check) => check.id + ": " + check.message);
    throw new Error(["eden " + command + " failed (exit " + result.code + "): " + (output.error?.code ?? "no error code") + " " + (output.error?.message ?? ""), ...failed, tail(result.stderr, 15)].filter(Boolean).join("\n"));
  }
  return output;
}

function installedVersion(name) {
  return JSON.parse(readFileSync(join(project, "node_modules", name, "package.json"), "utf8")).version;
}

// npm for a published World. pnpm for the workspace World: the manifest and
// lockfile name the tarball's host URL while pnpm runs and its Docker URL
// while Eden builds.
async function install(...packages) {
  if (worldTarball === undefined) {
    await runOrThrow("npm install", "npm", ["install", ...packages], { cwd: project });
    return;
  }
  const files = [join(project, "package.json"), join(project, "pnpm-lock.yaml")];
  worldTarball.pointAt("host", ...files.filter((file) => existsSync(file)));
  const command = packages.length === 0 ? ["install", "--no-frozen-lockfile"] : ["add", ...packages];
  await runOrThrow("pnpm " + command[0], "corepack", ["pnpm", ...command], { cwd: project });
  worldTarball.pointAt("docker", ...files);
}

async function createProject() {
  await runOrThrow("eve init", "npx", ["-y", "eve@" + options.eve, "init", target, "--non-interactive"], { cwd: workRoot });
  const sets = ["dependencies.eve=" + options.eve];
  if (options.world === "workspace") {
    // Eden takes npm packages only from the public registry and rejects file:
    // dependencies, but a pnpm lockfile may name a tarball URL. So the
    // workspace World makes this a pnpm project, as in the gate's Eden leg.
    // The URL stays up until the last build of this run.
    worldTarball = await serveWorldTarball(workRoot, interrupt.signal);
    rmSync(join(project, "package-lock.json"));
    rmSync(join(project, "node_modules"), { recursive: true, force: true });
    sets.push("packageManager=" + JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).packageManager);
    // The floor fixture's pnpm policy for build scripts. pnpm also waits one
    // day before it installs a release, and a check may need a newer one.
    writeFileSync(join(project, "pnpm-workspace.yaml"), readFileSync(join(repoRoot, "validation/eve-compat/floor/pnpm-workspace.yaml"), "utf8") + "minimumReleaseAge: 0\n");
  }
  await runOrThrow("npm pkg set", "npm", ["pkg", "set", ...sets], { cwd: project });
  await install("just-bash", worldTarball?.hostUrl ?? WORLD + "@" + options.world);
  writeFileSync(join(project, "agent/sandbox.ts"), [
    "import { defineSandbox } from 'eve/sandbox';",
    "import { JustBashSandbox } from 'eve/sandbox/just-bash';",
    "",
    "export const environment = JustBashSandbox.environment();",
    "export default defineSandbox(() => environment.open());",
    "",
  ].join("\n"));
  writeFileSync(join(project, "agent/channels/eve.ts"), [
    'import { localDev, type AuthFn } from "eve/channels/auth";',
    'import { eveChannel } from "eve/channels/eve";',
    "",
    "const authenticate: AuthFn<Request> = (request) => {",
    "  const expected = process.env.AGENT_AUTH_TOKEN;",
    '  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {',
    "    return null;",
    "  }",
    "  return {",
    "    attributes: {},",
    '    authenticator: "bearer-token",',
    '    principalId: "app-client",',
    '    principalType: "app",',
    "  };",
    "};",
    "",
    "export default eveChannel({ auth: [authenticate, localDev()] });",
    "",
  ].join("\n"));
  writeFileSync(join(project, "agent/agent.ts"), [
    'import { defineAgent } from "eve";',
    "",
    "export default defineAgent({",
    '  experimental: { workflow: { world: ' + JSON.stringify(WORLD) + " } },",
    "  model: " + JSON.stringify(options.model ?? DEFAULT_MODELS[0]) + ",",
    "  modelContextWindowTokens: 32_000,",
    ...(options.model === undefined
      ? ["  modelOptions: { providerOptions: { gateway: { models: " + JSON.stringify(DEFAULT_MODELS.slice(1)) + " } } },"]
      : []),
    "});",
    "",
  ].join("\n"));
  writeFileSync(join(project, "agent/instructions.md"), "You are Eden's live check agent. When asked to call a named tool, call it exactly as requested. Keep replies short.\n");
  // The only addition a user's guide does not ask for. Its uptime lets the
  // sleep step prove the server process restarted. Eden gives no access to
  // Eve's log on Cloudflare, so the tool also watches what the process writes,
  // from the moment Eve loads its tools at start, for the Workflow SDK's
  // queueAuthMode warning.
  mkdirSync(join(project, "agent/tools"), { recursive: true });
  writeFileSync(join(project, "agent/tools/server_state.ts"), [
    'import { defineTool } from "eve/tools";',
    'import { z } from "zod";',
    "",
    "const watchedFromSeconds = process.uptime();",
    "const queueAuthLines: string[] = [];",
    "for (const stream of [process.stdout, process.stderr]) {",
    "  const write = stream.write;",
    "  stream.write = function (...args: unknown[]) {",
    '    if (String(args[0]).includes("queueAuthMode")) queueAuthLines.push(String(args[0]).slice(0, 200));',
    "    return Reflect.apply(write, stream, args);",
    "  } as typeof stream.write;",
    "}",
    "",
    "export default defineTool({",
    '  description: "Report how long this server process has been running and what it logged about queueAuthMode.",',
    "  inputSchema: z.object({}),",
    "  async execute() {",
    "    return { uptimeSeconds: process.uptime(), watchedFromSeconds, queueAuthLines };",
    "  },",
    "});",
    "",
  ].join("\n"));
  writeFileSync(envFile, MODEL_KEY + "=" + modelKey + "\nAGENT_AUTH_TOKEN=" + authToken + "\n", { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const eve = installedVersion("eve");
  if (eve !== options.eve) throw new Error("Expected Eve " + options.eve + " but found " + eve + " installed.");
  summary.world = installedVersion(WORLD);
  return "Eve " + eve + ", Cloudflare World " + summary.world + " from " + (worldTarball === undefined ? "npm" : "this workspace, pnpm project") + ", just-bash " + installedVersion("just-bash");
}

async function upgradeEve() {
  const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  const sets = ["dependencies.eve=" + options.upgradeTo];
  const connect = manifest.dependencies?.["@vercel/connect"];
  // eden skill: an eve init project moving to Eve 1.0 needs @vercel/connect 2.7.0 or later.
  if (connect !== undefined && Number(options.upgradeTo.split(".")[0]) >= 1) {
    const [major, minor] = installedVersion("@vercel/connect").split(".").map(Number);
    if (major < 2 || (major === 2 && minor < 7)) sets.push("dependencies.@vercel/connect=2.7.0");
  }
  await runOrThrow("npm pkg set", "npm", ["pkg", "set", ...sets], { cwd: project });
  await install();
  const eve = installedVersion("eve");
  if (eve !== options.upgradeTo) throw new Error("Expected Eve " + options.upgradeTo + " but found " + eve + " installed.");
}

async function request(path, init = {}, timeoutMs = 120_000) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const abort = () => timeout.abort();
  interrupt.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(summary.origin + path, { ...init, signal: timeout.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
    interrupt.signal.removeEventListener("abort", abort);
  }
}

async function waitForHealth(timeoutMs = 300_000) {
  const started = Date.now();
  let last = "no response";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await request("/eve/v1/health", {}, 60_000);
      last = "HTTP " + response.status + " " + response.text.slice(0, 200);
      if (response.status === 200 && JSON.parse(response.text).status === "ready") return seconds(Date.now() - started);
    } catch (error) {
      if (interrupt.signal.aborted) throw new Error("Interrupted.");
      last = String(error);
    }
    await wait(3_000, interrupt.signal);
  }
  throw new Error("Health did not report ready within " + timeoutMs / 1000 + " s: " + last);
}

const authorized = { authorization: "Bearer " + authToken, "content-type": "application/json" };

async function post(sessionId, message) {
  const response = await request("/eve/v1/session" + (sessionId === undefined ? "" : "/" + sessionId), {
    method: "POST",
    headers: authorized,
    body: JSON.stringify({ message }),
  });
  let body;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = {};
  }
  if (response.status !== 202 || typeof body.sessionId !== "string" || typeof body.deliveryId !== "string") {
    throw new Error("Expected HTTP 202 with a sessionId, got HTTP " + response.status + ": " + response.text.slice(0, 400));
  }
  if (sessionId !== undefined && body.sessionId !== sessionId) throw new Error("The session ID changed from " + sessionId + " to " + body.sessionId + ".");
  return body;
}

// Reads the session stream (it replays from the start) until the turn that
// answers deliveryId settles.
async function readTurn(sessionId, deliveryId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = { turnId: undefined, calls: [], reply: "", settledTurns: [], eveVersion: undefined, outcome: undefined, errors: [], ended: false };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.max(1_000, deadline - Date.now()));
    const abort = () => timeout.abort();
    interrupt.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(summary.origin + "/eve/v1/session/" + sessionId + "/stream", { headers: authorized, signal: timeout.signal });
      if (response.status !== 200) throw new Error("The session stream returned HTTP " + response.status + ": " + (await response.text()).slice(0, 300));
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop();
        for (const line of lines) {
          if (!line.includes('"facts"')) continue;
          for (const fact of JSON.parse(line).facts) {
            const data = fact.data ?? {};
            if (fact.type === "session.started") turn.eveVersion = data.runtime?.eveVersion;
            if (fact.type === "turn.started" && data.cause?.deliveryId === deliveryId) turn.turnId = data.turnId;
            if (fact.type === "turn.settled") turn.settledTurns.push(data.turnId);
            if (fact.type === "session.ended") turn.ended = true;
            if (data.error?.message !== undefined && !turn.errors.includes(data.error.message)) turn.errors.push(data.error.message);
            if (turn.turnId === undefined || fact.scope?.turnId !== turn.turnId) continue;
            if (fact.type === "call.settled") turn.calls.push(data.output ?? {});
            if (fact.type === "content.completed" && data.phase === "reply") turn.reply = String(data.value ?? "");
            if (fact.type === "turn.settled") {
              turn.outcome = data.outcome;
              return turn;
            }
          }
        }
      }
    } catch (error) {
      if (interrupt.signal.aborted) throw new Error("Interrupted.");
      if (!timeout.signal.aborted && !/terminated|fetch failed|ECONNRESET/u.test(String(error?.cause ?? error))) throw error;
    } finally {
      clearTimeout(timer);
      interrupt.signal.removeEventListener("abort", abort);
      timeout.abort();
    }
    await wait(2_000, interrupt.signal);
  }
  throw new Error("The turn for delivery " + deliveryId + " in " + sessionId + " did not settle within " + timeoutMs / 1000 + " s.");
}

// Sends a message that asks for one tool call and returns the turn once a
// tool result satisfies accept. The proof is the tool's own output, never the
// model's wording. A model that ignores the request gets two more tries.
async function toolTurn(sessionId, message, accept) {
  let last = "";
  let id = sessionId;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const admitted = await post(id, message);
    id = admitted.sessionId;
    const turn = await readTurn(id, admitted.deliveryId);
    const proof = turn.calls.map((call) => accept(call)).find((value) => value !== undefined);
    if (turn.outcome === "completed" && proof !== undefined) return { ...turn, sessionId: id, proof };
    last = "outcome " + turn.outcome + (turn.errors.length === 0 ? "" : ", errors " + JSON.stringify(turn.errors)) + ", tool results " + JSON.stringify(turn.calls).slice(0, 600) + ", reply " + JSON.stringify(turn.reply.slice(0, 300));
    log("    attempt " + attempt + " did not produce the expected tool result: " + last);
    if (turn.ended) {
      if (sessionId !== undefined) throw new Error("Session " + sessionId + " ended. Last: " + last);
      id = undefined;
    }
  }
  throw new Error("No turn produced the expected tool result. Last: " + last);
}

const serverState = (sessionId) => toolTurn(sessionId, "Call the server_state tool. Then reply with its result.", (call) => typeof call.uptimeSeconds === "number" && Array.isArray(call.queueAuthLines) ? call : undefined);
const bashPrints = (text) => (call) => call.exitCode === 0 && typeof call.stdout === "string" && call.stdout.includes(text) ? text : undefined;
const writeFile = "Use the bash tool to run exactly this command: echo " + nonce + " > " + PROOF_FILE + " && cat " + PROOF_FILE + "\nThen reply with the file content.";
const readFile = "Use the bash tool to run exactly this command: cat " + PROOF_FILE + "\nThen reply with the file content.";

async function newSession(label, expectedEve) {
  const marker = "eden-live-" + label + "-" + randomBytes(3).toString("hex");
  const turn = await toolTurn(undefined, "Use the bash tool to run exactly this command: echo " + marker + "\nThen reply with the output.", bashPrints(marker));
  if (turn.eveVersion !== expectedEve) throw new Error("The new session reports Eve " + turn.eveVersion + ", expected " + expectedEve + ".");
  return turn.sessionId + " ran bash on Eve " + turn.eveVersion;
}

// The deployed Worker keeps no logs, so wrangler tail records every
// invocation of the target into the work folder. It is restarted before each
// update and read only when a step fails.
let tailChild;
const tailFiles = [];
function startTail() {
  tailChild?.kill("SIGTERM");
  const file = join(workRoot, "tail-" + (tailFiles.length + 1) + ".json");
  tailFiles.push(file);
  const out = openSync(file, "a");
  tailChild = spawn(wranglerCli, ["tail", target, "--format", "json"], { cwd: workRoot, env: baseEnvironment, stdio: ["ignore", out, "ignore"] });
  tailChild.on("error", () => {});
  closeSync(out);
}

// Invocations that threw or were reset, oldest first.
function tailExceptions() {
  const lines = [];
  for (const file of tailFiles) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Wrangler prints one indented JSON object per invocation. Diagnostics
    // only: a part that cannot be read is skipped, never a failure.
    for (const part of text.split(/\n(?=\{\n)/u)) {
      try {
        const event = JSON.parse(part);
        if (event.outcome === "ok" || event.outcome === "canceled") continue;
        const request = event.event?.request;
        lines.push([
          new Date(event.eventTimestamp).toISOString(),
          event.entrypoint ?? "Worker",
          "version " + String(event.scriptVersion?.id).slice(0, 8),
          event.outcome,
          request === undefined ? "" : request.method + " " + new URL(request.url).pathname,
          (event.exceptions ?? []).map((exception) => exception.name + ": " + exception.message).join("; "),
        ].join(" "));
      } catch {
        continue;
      }
    }
  }
  return lines;
}

async function deploy(expectUpdate, expectImageReplaced = false) {
  const started = Date.now();
  if (expectUpdate) startTail();
  const output = await eden("deploy");
  if (!expectUpdate) startTail();
  const origin = output.deployment?.stableWorkersDevOrigin;
  if (typeof origin !== "string" || !origin.startsWith("https://")) throw new Error("The deploy result has no deployment.stableWorkersDevOrigin.");
  if (output.name !== target) throw new Error("The deploy result names " + output.name + ", not " + target + ".");
  if (registryAccount === undefined) throw new Error("The deploy result does not name the registry account in deployment.imageReference.");
  if (expectUpdate && origin !== summary.origin) throw new Error("The URL changed from " + summary.origin + " to " + origin + ".");
  summary.origin = origin;
  const deployed = seconds(Date.now() - started);
  const healthy = await waitForHealth();
  const warnings = (output.warnings ?? []).map((warning) => warning.id);
  const cleanup = (output.checks ?? []).find((check) => check.id === "VAL-LIFE-007");
  // A same-version update must delete the image it replaced, by its tag.
  if (expectImageReplaced && (cleanup?.status !== "passed" || (output.registryObjectsKept ?? []).length > 0 || warnings.includes("EVE_SUPERSEDED_IMAGE_NOT_DELETED"))) {
    throw new Error("The update did not delete the image it replaced: VAL-LIFE-007 " + (cleanup?.status ?? "missing") + ", kept " + JSON.stringify(output.registryObjectsKept ?? []) + ", warnings " + warnings.join(", "));
  }
  return origin + " in " + deployed + " s, health ready after " + healthy + " s more" + (warnings.length === 0 ? "" : ", warnings: " + warnings.join(", ")) + (cleanup === undefined ? "" : "\nVAL-LIFE-007 " + cleanup.status + ": " + cleanup.message);
}

async function wrangler(args) {
  return run(wranglerCli, args, { timeoutMs: 120_000, interruptible: false });
}

// What Cloudflare's registry itself lists for this run's repositories: each
// tag, and one sha256 entry per manifest. Wrangler's image list leaves the
// sha256 entries out.
// Every repository of this target starts with the same name. The credential
// can only read, and must be for the account a deploy result named; when no
// deploy got far enough to name one, the credential's own account is read.
async function registryRefs() {
  const minted = await wrangler(["containers", "registries", "credentials", "registry.cloudflare.com", "--pull", "--expiration-minutes", "5", "--json"]);
  if (minted.code !== 0) throw new Error("wrangler containers registries credentials exited with code " + minted.code);
  let credential;
  try {
    credential = JSON.parse(minted.stdout);
  } catch {
    throw new Error("wrangler containers registries credentials did not print JSON");
  }
  if (typeof credential?.password === "string") secrets.push(credential.password);
  return registryCatalogRefs({
    account: registryAccount ?? credential?.account_id,
    repositoryPrefix: "eden-eve-preview-" + target + "-",
    credential,
  });
}

// Read-only checks, each filtered to this run's exact temporary name.
async function verifyGone() {
  const problems = [];
  const notes = [];
  if (summary.origin !== null) {
    const response = await fetch(summary.origin + "/eve/v1/health").then((result) => result.status, (error) => String(error));
    if (response === 404) notes.push("URL returns 404");
    else problems.push("URL returned " + response + ", expected 404");
  }
  const worker = await wrangler(["deployments", "list", "--name", target, "--json"]);
  if (worker.code !== 0 && /10007|does not exist|not found/iu.test(worker.stdout + worker.stderr)) notes.push("no Worker");
  else problems.push("Worker " + target + " still answers wrangler deployments list");
  const secretList = await wrangler(["secret", "list", "--name", target]);
  if (secretList.code !== 0 && /10007|does not exist|not found/iu.test(secretList.stdout + secretList.stderr)) notes.push("no secrets");
  else problems.push("Worker secrets for " + target + " can still be listed");
  const containers = await wrangler(["containers", "list", "--json"]);
  if (containers.code !== 0) problems.push("wrangler containers list failed: " + tail(containers.stderr, 3));
  else if (containers.stdout.includes(target)) problems.push("a Container application for " + target + " remains");
  else notes.push("no Container application");
  // Only the exact objects destroy reported as kept may remain.
  const refs = await registryRefs().catch((error) => String(error.message ?? error));
  if (typeof refs === "string") problems.push("the registry's listing could not be read: " + refs);
  else {
    const reported = registryObjectsKept.map((object) => object.ref);
    const unexpected = refs.filter((ref) => !reported.includes(ref));
    if (unexpected.length > 0) problems.push("the registry still lists object(s) that destroy did not report as kept: " + unexpected.join(", "));
    else notes.push(refs.length === 0 ? "nothing in the registry's listing" : "nothing in the registry's listing except the " + refs.length + " object(s) destroy reported as kept");
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  return notes.join(", ");
}

let deployStarted = false;
let registryObjectsKept = [];
// The account in a deploy result's image reference.
let registryAccount;
let failure;
log("Live Cloudflare check: target " + target + ", Eve " + options.eve + (summary.upgradedTo === null ? "" : " -> " + options.upgradeTo) + ", work folder " + workRoot);

try {
  await step("Build the local CLI", async () => {
    await runOrThrow("pnpm run build", "pnpm", ["run", "build"]);
    if (!existsSync(edenCli)) throw new Error(edenCli + " is missing after the build.");
  });
  await step("Create a fresh project on Eve " + options.eve, createProject);
  await step("eden preflight", async () => {
    const output = await eden("preflight");
    const warnings = (output.warnings ?? []).map((warning) => warning.id);
    return output.checks.length + " checks passed" + (warnings.length === 0 ? ", no warnings" : ", warnings: " + warnings.join(", "));
  });
  await step("eden deploy (fresh)", () => {
    deployStarted = true;
    return deploy(false);
  });
  await step("Unauthenticated session is refused", async () => {
    const response = await request("/eve/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hello" }) });
    if (response.status !== 401) throw new Error("Expected HTTP 401, got " + response.status + ".");
    return "HTTP 401";
  });
  await step("Workflow queue routes are closed to the internet", async () => {
    for (const route of ["flow", "step"]) {
      const response = await request("/.well-known/workflow/v1/" + route, { method: "POST", headers: authorized, body: "{}", redirect: "manual" });
      if (response.status !== 404) throw new Error("Expected HTTP 404 from /.well-known/workflow/v1/" + route + ", got " + response.status + ".");
    }
    return "POST /.well-known/workflow/v1/flow and /step with the bearer token: HTTP 404";
  });
  let session;
  const settledBefore = [];
  await step("Session runs bash and writes a file", async () => {
    const turn = await toolTurn(undefined, writeFile, bashPrints(nonce));
    if (!turn.reply.includes(nonce)) throw new Error("The reply does not contain the file content: " + turn.reply.slice(0, 300));
    if (turn.eveVersion !== options.eve) throw new Error("The session reports Eve " + turn.eveVersion + ", expected " + options.eve + ".");
    session = turn.sessionId;
    settledBefore.push(...turn.settledTurns);
    return session + " on Eve " + turn.eveVersion + ", bash exit 0, reply contains the file content";
  });
  const sameSession = async () => {
    const turn = await toolTurn(session, readFile, bashPrints(nonce));
    const missing = settledBefore.filter((turnId) => !turn.settledTurns.includes(turnId));
    if (missing.length > 0) throw new Error("The session stream lost earlier turns: " + missing.join(", "));
    const kept = settledBefore.length;
    settledBefore.splice(0, settledBefore.length, ...turn.settledTurns);
    return session + " answered, " + kept + " earlier turn(s) still in its stream, file intact";
  };
  await step("eden deploy (update in place, same Eve)", () => deploy(true, true));
  await step("Same session continues after the update", sameSession);
  await step("New session starts after the update", () => newSession("update", options.eve));
  if (summary.upgradedTo === null) {
    await step("Eve upgrade", async () => "skipped");
  } else {
    await step("Upgrade the project to Eve " + options.upgradeTo, upgradeEve);
    await step("eden deploy (Eve upgrade)", () => deploy(true));
    await step("Same session continues after the Eve upgrade", sameSession);
    await step("New session starts on Eve " + options.upgradeTo, () => newSession("upgrade", options.upgradeTo));
  }
  // The Cloudflare World declares queueAuthMode "skip", which the step above
  // makes true. Workflow SDK 5.2 and later (Eve 1.0) warn when it is missing.
  await step("Eve logged no queueAuthMode warning", async () => {
    const expected = summary.upgradedTo ?? options.eve;
    const turn = await serverState(undefined);
    if (turn.eveVersion !== expected) throw new Error("The session that asked reports Eve " + turn.eveVersion + ", expected " + expected + ".");
    if (turn.proof.queueAuthLines.length > 0) throw new Error("Eve logged: " + turn.proof.queueAuthLines.join(" | "));
    return "a new session on Eve " + turn.eveVersion + " asked its server process: up " + Math.round(turn.proof.uptimeSeconds) + " s, output watched from " + seconds(turn.proof.watchedFromSeconds * 1000) + " s after start, no queueAuthMode line";
  });
  if (options.skipSleep) {
    await step("Sleep and wake", async () => "skipped");
  } else {
    await step("Sleep and wake", async () => {
      const idleFrom = Date.now();
      // No request may reach the agent while it waits: any request is activity.
      await wait(options.sleepAfterMs + 75_000, interrupt.signal);
      const wakeStarted = Date.now();
      const wake = seconds(await waitForHealth() * 1000);
      const uptime = (await serverState(session)).proof.uptimeSeconds;
      const idleSeconds = seconds(wakeStarted - idleFrom);
      if (uptime >= idleSeconds) throw new Error("The server process has been up " + Math.round(uptime) + " s, longer than the " + idleSeconds + " s idle wait, so the container did not sleep.");
      const file = await sameSession();
      return "idle " + idleSeconds + " s with a " + options.sleepAfter + " window; first health after wake took " + wake + " s; server process up " + Math.round(uptime) + " s when asked, so it restarted; " + file;
    });
  }
} catch (error) {
  failure = error;
  if (tailFiles.length > 0) {
    // Tail delivers an invocation a moment after it ends.
    await wait(3_000);
    const exceptions = tailExceptions();
    log(exceptions.length === 0
      ? "wrangler tail recorded no invocation that threw or was reset."
      : "Invocations that threw or were reset, from wrangler tail (last " + Math.min(exceptions.length, 30) + " of " + exceptions.length + "):\n    " + exceptions.slice(-30).join("\n    "));
  }
} finally {
  cleaning = true;
  tailChild?.kill("SIGTERM");
  let cleaned = !deployStarted;
  if (deployStarted) {
    try {
      await step("eden destroy", async () => {
        const output = await eden("destroy", { withEnvFile: false, interruptible: false });
        registryObjectsKept = output.registryObjectsKept ?? [];
        if (registryObjectsKept.length === 0) return undefined;
        summary.registryObjectsKept = registryObjectsKept;
        // Every image had a tag when it was deleted, so the registry removes each one.
        const stranded = registryObjectsKept.filter((object) => object.class === "accepted-still-listed");
        if (stranded.length > 0) throw new Error("Destroy left " + stranded.length + " accepted-still-listed object(s): " + stranded.map((object) => object.ref).join(", "));
        return "Cloudflare's registry still lists " + registryObjectsKept.length + " object(s) that destroy tried to delete:\n" + registryObjectsKept.map((object) => object.ref + " (" + object.class + ")").join("\n");
      });
      await step("Nothing of the target remains", verifyGone);
      cleaned = true;
    } catch (error) {
      failure ??= error;
      log("\nCLEANUP FAILED for " + target + ". Retry: node " + edenCli + " destroy --project " + project + " --name " + target + "\nThe project folder is kept because destroy needs its .eden records.");
    }
  }
  await worldTarball?.close();
  if (cleaned && !options.keepWork) rmSync(workRoot, { recursive: true, force: true });
  else log("Work folder kept: " + workRoot);
  summary.ok = failure === undefined && summary.steps.every((entry) => entry.status !== "failed");
  summary.finishedAt = new Date().toISOString();
  if (failure !== undefined && !summary.steps.some((entry) => entry.status === "failed")) summary.error = redact(failure instanceof Error ? failure.message : String(failure));
  log(summary.ok ? "\nPASS" : "\nFAIL");
  console.log(redact(JSON.stringify(summary, null, 2)));
  process.exitCode = summary.ok ? 0 : 1;
}

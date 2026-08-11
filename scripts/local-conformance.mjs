/* global AbortController, TextDecoder, clearTimeout, fetch, process, setTimeout */

import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EDEN_HOST = "127.0.0.1";
const EDEN_PORT = 8797;
const EDEN_INSPECTOR_PORT = 9297;
const EDEN_BASE_URL = `http://${EDEN_HOST}:${EDEN_PORT}`;
const EDEN_CLI_PATH = join("packages", "cli", "dist", "index.js");
const STARTUP_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 15_000;
const PROCESS_TIMEOUT_MS = 120_000;

export const LOCAL_RECOVERY_FIXTURES = Object.freeze([
  "packages/runtime-cloudflare/test/turn-runner.test.ts",
  "packages/runtime-cloudflare/test/tool-harness.test.ts",
  "packages/runtime-cloudflare/test/session-recovery.test.ts",
  "packages/runtime-cloudflare/test/session-journal.test.ts",
  "packages/runtime-cloudflare/test/stream-lifecycle.test.ts",
  "packages/runtime-cloudflare/test/http-host.test.ts",
  "packages/client/test/stream.test.ts",
]);

const HAPPY_PATH_LIFECYCLE = Object.freeze([
  "session.started",
  "turn.started",
  "message.received",
  "step.started",
  "actions.requested",
  "action.result",
  "step.completed",
  "step.started",
  "message.completed",
  "step.completed",
  "turn.completed",
  "session.waiting",
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value, secret) {
  return (secret.length === 0 ? value : value.replaceAll(secret, "[redacted]"))
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /(EDEN_BEARER_SECRET\s*[=:]\s*)\S+/giu,
      "$1[redacted]",
    );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unknown validation failure.";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readStreamOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return () => ({ stdout, stderr });
}

function waitForChild(child) {
  return new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1, signal: null }));
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

function runProcess(
  command,
  args,
  {
    cwd,
    env = {},
    timeoutMs = PROCESS_TIMEOUT_MS,
  },
) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    if (env.EDEN_BEARER_SECRET === undefined) {
      delete childEnv.EDEN_BEARER_SECRET;
    }
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collectOutput = readStreamOutput(child);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
    }, timeoutMs);
    waitForChild(child).then((exit) => {
      clearTimeout(timer);
      resolve({ ...exit, ...collectOutput() });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runRepositoryBuild(repositoryRoot) {
  const result = await runProcess(
    "corepack",
    ["pnpm", "run", "build"],
    { cwd: repositoryRoot },
  );
  if (result.code !== 0) {
    throw new Error(
      `The repository build failed before local conformance (exit code ${result.code}).`,
    );
  }
}

async function runCli(repositoryRoot, projectRoot, args, secret) {
  const result = await runProcess(
    process.execPath,
    [join(repositoryRoot, EDEN_CLI_PATH), ...args],
    {
      cwd: repositoryRoot,
      env: secret === undefined ? {} : { EDEN_BEARER_SECRET: secret },
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `eden ${args[0] ?? "command"} failed: ${
        redact(`${result.stdout}\n${result.stderr}`, secret ?? "")
      }`,
    );
  }
  return result;
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function portAvailable(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    const finish = (value) => {
      server.removeAllListeners();
      server.close(() => resolve(value));
    };
    server.once("error", () => finish(false));
    server.listen({ host, port }, () => finish(true));
  });
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readProcessStartMarker(pid) {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        const marker = String(stdout).trim();
        resolve(marker.length === 0 ? undefined : marker);
      },
    );
  });
}

async function ownedProcessAlive(owner) {
  if (!processAlive(owner.pid)) return false;
  if (owner.startedAt === undefined) return true;
  return (await readProcessStartMarker(owner.pid)) === owner.startedAt;
}

async function waitForProcessExit(owner, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await ownedProcessAlive(owner))) return true;
    await delay(100);
  }
  return !(await ownedProcessAlive(owner));
}

async function waitForPortAvailability(host, port, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await portAvailable(host, port)) return true;
    await delay(100);
  }
  return false;
}

async function fetchWithTimeout(url, options, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, received HTTP ${response.status}.`);
  }
  return { response, body };
}

function authorizationHeaders(secret, contentType = false) {
  return {
    authorization: `Bearer ${secret}`,
    ...(contentType ? { "content-type": "application/json" } : {}),
  };
}

async function waitForLocalRuntime(secret) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (await portOpen(EDEN_HOST, EDEN_INSPECTOR_PORT)) {
      try {
        const { response, body } = await readJsonResponse(
          await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/health`, {
            headers: authorizationHeaders(secret),
          }),
        );
        if (response.status === 200 && body?.status === "ok") return;
      } catch {
        // The Worker can accept TCP before its HTTP route is ready.
      }
    }
    await delay(100);
  }
  throw new Error("The local Eden Worker did not become ready.");
}

function parseNdjson(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function readInitialStream(sessionId, secret, expectedCount) {
  const controller = new AbortController();
  const response = await fetch(
    `${EDEN_BASE_URL}/eden/v1/session/${sessionId}/stream?startIndex=0&follow=true`,
    {
      headers: authorizationHeaders(secret),
      signal: controller.signal,
    },
  );
  if (response.status !== 200 || response.body === null) {
    throw new Error(`Initial NDJSON stream failed with HTTP ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events = [];
  let buffered = "";
  const deadline = Date.now() + STREAM_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        events.push(JSON.parse(line));
        if (events.length === expectedCount) {
          await reader.cancel();
          controller.abort();
          return events;
        }
      }
    }
  } catch (error) {
    if (events.length !== expectedCount) throw error;
  } finally {
    controller.abort();
    reader.releaseLock();
  }
  throw new Error("The initial NDJSON stream did not reach the disconnect cursor.");
}

async function readCatchupUntilTerminal(sessionId, secret, startIndex) {
  const events = [];
  let cursor = startIndex;
  const deadline = Date.now() + STREAM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetchWithTimeout(
      `${EDEN_BASE_URL}/eden/v1/session/${sessionId}/stream?startIndex=${cursor}&follow=false`,
      { headers: authorizationHeaders(secret) },
    );
    if (response.status !== 200) {
      throw new Error(`Reconnect NDJSON stream failed with HTTP ${response.status}.`);
    }
    for (const event of parseNdjson(await response.text())) {
      if (event.streamIndex <= cursor) {
        throw new Error("Reconnect returned an event at or before the saved cursor.");
      }
      events.push(event);
      cursor = event.streamIndex;
    }
    if (
      events.at(-1)?.type === "session.waiting" ||
      events.at(-1)?.type === "session.failed"
    ) {
      return events;
    }
    await delay(100);
  }
  throw new Error("Reconnect did not reach a terminal session event.");
}

async function readNdjsonCatchup(sessionId, secret, startIndex) {
  const response = await fetchWithTimeout(
    `${EDEN_BASE_URL}/eden/v1/session/${sessionId}/stream?startIndex=${startIndex}&follow=false`,
    { headers: authorizationHeaders(secret) },
  );
  if (response.status !== 200) {
    throw new Error(`Reconnect NDJSON stream failed with HTTP ${response.status}.`);
  }
  return parseNdjson(await response.text());
}

async function readOwnedProcess(projectRoot) {
  try {
    const contents = await readFile(join(projectRoot, ".eden-dev-state.json"), "utf8");
    const state = JSON.parse(contents);
    return Number.isSafeInteger(state.pid)
      ? {
          pid: state.pid,
          startedAt: typeof state.startedAt === "string"
            ? state.startedAt
            : undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function terminateProcessGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function stopLocalRuntime(projectRoot, devProcess) {
  let processStopped = true;
  let childExited = devProcess === undefined;
  if (devProcess !== undefined) {
    if (devProcess.child.exitCode === null) {
      try {
        devProcess.child.kill("SIGINT");
      } catch (error) {
        if (error?.code !== "ESRCH") processStopped = false;
      }
    }
    childExited = (await Promise.race([
      devProcess.exited,
      delay(5_000),
    ])) !== undefined;
    if (!childExited) {
      try {
        devProcess.child.kill("SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") processStopped = false;
      }
      childExited = (await Promise.race([
        devProcess.exited,
        delay(2_000),
      ])) !== undefined;
    }
  }

  const ownedProcess = await readOwnedProcess(projectRoot);
  if (ownedProcess !== undefined && await ownedProcessAlive(ownedProcess)) {
    if (!terminateProcessGroup(ownedProcess.pid, "SIGTERM")) {
      processStopped = false;
    }
    if (!(await waitForProcessExit(ownedProcess))) {
      if (!terminateProcessGroup(ownedProcess.pid, "SIGKILL")) {
        processStopped = false;
      }
      if (!(await waitForProcessExit(ownedProcess))) {
        processStopped = false;
      }
    }
  }
  if (!childExited && devProcess !== undefined) {
    try {
      devProcess.child.kill("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") processStopped = false;
    }
    childExited = (await Promise.race([
      devProcess.exited,
      delay(2_000),
    ])) !== undefined;
  }
  if (!childExited) processStopped = false;

  const workerPortFree = await waitForPortAvailability(EDEN_HOST, EDEN_PORT);
  const inspectorPortFree = await waitForPortAvailability(
    EDEN_HOST,
    EDEN_INSPECTOR_PORT,
  );
  return { processStopped, workerPortFree, inspectorPortFree };
}

async function assertCleanRoomArtifacts(projectRoot) {
  const initialEntries = (await readdir(projectRoot)).sort();
  if (
    JSON.stringify(initialEntries) !==
    JSON.stringify([".eden", ".wrangler", "agent", "package.json", "wrangler.jsonc"])
  ) {
    throw new Error("eden init/build produced an unexpected project tree.");
  }
  for (const forbidden of [".env", ".dev.vars"]) {
    try {
      await stat(join(projectRoot, forbidden));
      throw new Error(`eden init created forbidden secret file ${forbidden}.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const artifactNames = (await readdir(join(projectRoot, ".eden"))).sort();
  const expectedArtifacts = [
    "CURRENT",
    "agent-bundle.mjs",
    "build-metadata.json",
    "diagnostics.json",
    "discovery.json",
    "generations",
    "manifest.json",
    "module-map.json",
  ];
  if (JSON.stringify(artifactNames) !== JSON.stringify(expectedArtifacts)) {
    throw new Error("eden build produced an incomplete artifact generation.");
  }

  const manifest = JSON.parse(
    await readFile(join(projectRoot, ".eden", "manifest.json"), "utf8"),
  );
  const metadata = JSON.parse(
    await readFile(join(projectRoot, ".eden", "build-metadata.json"), "utf8"),
  );
  const bundle = await readFile(
    join(projectRoot, ".eden", "agent-bundle.mjs"),
    "utf8",
  );
  if (
    manifest.bundleDigest !== sha256(bundle) ||
    metadata.bundleDigest !== manifest.bundleDigest ||
    manifest.tools?.length !== 1 ||
    manifest.tools[0]?.name !== "greet" ||
    manifest.tools[0]?.module !== "tool:greet"
  ) {
    throw new Error("Generated manifest and bundle metadata are incoherent.");
  }
}

async function assertNoSecretOrPlatformLocator(projectRoot, secret) {
  const forbidden = [secret];
  const pending = [projectRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      const contents = await readFile(path, "utf8").catch(() => "");
      if (forbidden.some((value) => contents.includes(value))) {
        throw new Error(`Generated project content leaked a forbidden value in ${entry.name}.`);
      }
    }
  }
}

function assertSafePublicValue(value, secret) {
  const serialized = JSON.stringify(value);
  if (
    serialized.includes(secret) ||
    serialized.includes("eden-session:") ||
    serialized.includes("durable-object-id") ||
    serialized.includes("EDEN_BEARER_SECRET")
  ) {
    throw new Error("A public response or event contained a forbidden value.");
  }
}

async function runLocalFirstUse(
  repositoryRoot,
  projectRoot,
  secret,
  registerDevProcess = () => {},
) {
  await runCli(repositoryRoot, projectRoot, ["init", "--project", projectRoot]);
  await runCli(repositoryRoot, projectRoot, ["build", "--project", projectRoot]);
  await assertCleanRoomArtifacts(projectRoot);
  await assertNoSecretOrPlatformLocator(projectRoot, secret);

  const devProcess = startDev(repositoryRoot, projectRoot, secret);
  registerDevProcess(devProcess);
  await waitForLocalRuntime(secret);

  const health = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/health`, {
      headers: authorizationHeaders(secret),
    }),
  );
  if (health.response.status !== 200 || health.body?.status !== "ok") {
    throw new Error("Authenticated local health check failed.");
  }
  assertSafePublicValue(health.body, secret);

  const unauthorized = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/health`),
  );
  if (unauthorized.response.status !== 401 || JSON.stringify(unauthorized.body).includes(secret)) {
    throw new Error("Local health did not fail closed without the bearer.");
  }
  assertSafePublicValue(unauthorized.body, secret);

  const info = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/info`, {
      headers: authorizationHeaders(secret),
    }),
  );
  if (
    info.response.status !== 200 ||
    info.body?.service !== "eden" ||
    info.body?.versions === undefined
  ) {
    throw new Error("Authenticated local info check failed.");
  }
  assertSafePublicValue(info.body, secret);

  const session = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/session`, {
      method: "POST",
      headers: authorizationHeaders(secret, true),
      body: "{}",
    }),
  );
  const sessionId = session.body?.sessionId;
  if (
    session.response.status !== 201 ||
    typeof sessionId !== "string" ||
    !/^sess_[a-f0-9]{32}$/u.test(sessionId)
  ) {
    throw new Error("Authenticated session creation failed.");
  }
  assertSafePublicValue(session.body, secret);

  const command = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/session/${sessionId}`, {
      method: "POST",
      headers: authorizationHeaders(secret, true),
      body: JSON.stringify({ message: "Say hello to Eden." }),
    }),
  );
  if (command.response.status !== 202 || command.body?.status !== "accepted") {
    throw new Error("Authenticated command acceptance failed.");
  }
  assertSafePublicValue(command.body, secret);

  const firstEvents = await readInitialStream(sessionId, secret, 5);
  const disconnectedCursor = firstEvents.at(-1)?.streamIndex;
  if (disconnectedCursor !== 5) {
    throw new Error("The disconnected stream did not save cursor 5.");
  }

  const remainingEvents = await readCatchupUntilTerminal(
    sessionId,
    secret,
    disconnectedCursor,
  );
  const reconnectEvents = await readNdjsonCatchup(
    sessionId,
    secret,
    disconnectedCursor,
  );
  const allEvents = [...firstEvents, ...remainingEvents];
  const lifecycle = allEvents.map((event) => event.type);
  const cursors = allEvents.map((event) => event.streamIndex);
  if (
    JSON.stringify(lifecycle) !== JSON.stringify(HAPPY_PATH_LIFECYCLE) ||
    JSON.stringify(cursors) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) ||
    JSON.stringify(reconnectEvents.map((event) => event.streamIndex)) !==
      JSON.stringify([6, 7, 8, 9, 10, 11, 12]) ||
    JSON.stringify(allEvents).includes(secret) ||
    JSON.stringify(allEvents).includes("Say hello to Eden.")
  ) {
    throw new Error("The local NDJSON lifecycle or cursor reconnect was invalid.");
  }
  assertSafePublicValue(allEvents, secret);
  await assertNoSecretOrPlatformLocator(projectRoot, secret);

  return {
    lifecycle,
    disconnectedCursor,
    reconnectedCursors: remainingEvents.map((event) => event.streamIndex),
  };
}

function startDev(repositoryRoot, projectRoot, secret) {
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, EDEN_CLI_PATH), "dev", "--project", projectRoot],
    {
      cwd: repositoryRoot,
      env: { ...process.env, EDEN_BEARER_SECRET: secret },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = readStreamOutput(child);
  return {
    child,
    exited: waitForChild(child),
    output,
  };
}

async function runRecoveryFixtures(repositoryRoot) {
  for (const fixture of LOCAL_RECOVERY_FIXTURES) {
    const isRuntimeFixture = fixture.startsWith("packages/runtime-cloudflare/");
    const args = [
      "pnpm",
      "exec",
      "vitest",
      "run",
      ...(isRuntimeFixture
        ? ["--config", "packages/runtime-cloudflare/vitest.config.ts"]
        : []),
      fixture,
      "--maxWorkers=1",
    ];
    const result = await runProcess("corepack", args, {
      cwd: repositoryRoot,
    });
    if (result.code !== 0) {
      throw new Error(
        `Deterministic recovery fixture ${fixture} failed (exit code ${result.code}).`,
      );
    }
  }
}

export async function runLocalConformance({
  repositoryRoot,
  runRecoveryFixtures: shouldRunRecoveryFixtures = true,
}) {
  await runRepositoryBuild(repositoryRoot);
  const projectRoot = await mkdtemp(join(tmpdir(), "eden-local-conformance-"));
  const secret = `eden-local-${randomUUID()}`;
  let localResult;
  let failure;
  let devProcess;
  let localCleanup;
  let devOutput;
  try {
    try {
      localResult = await runLocalFirstUse(
        repositoryRoot,
        projectRoot,
        secret,
        (ownedProcess) => {
          devProcess = ownedProcess;
        },
      );
    } catch (error) {
      failure = error;
    } finally {
      devOutput = devProcess?.output();
      localCleanup = await stopLocalRuntime(projectRoot, devProcess);
      devProcess = undefined;
      if (
        !localCleanup.processStopped ||
        !localCleanup.workerPortFree ||
        !localCleanup.inspectorPortFree
      ) {
        failure ??= new Error(
          `Local resource cleanup failed: ${JSON.stringify(localCleanup)}`,
        );
      }
      const output = `${devOutput?.stdout ?? ""}\n${devOutput?.stderr ?? ""}`;
      if (
        output.includes(secret) ||
        output.includes("eden-session:") ||
        output.includes("durable-object-id")
      ) {
        failure ??= new Error("Local runtime output contained a forbidden value.");
      }
    }

    if (failure === undefined && shouldRunRecoveryFixtures) {
      try {
        await runRecoveryFixtures(repositoryRoot);
      } catch (error) {
        failure = error;
      }
    }
  } finally {
    if (devProcess !== undefined) {
      await stopLocalRuntime(projectRoot, devProcess);
    }
  }

  const cleanup = {
    projectRemoved: false,
    workerPortFree: false,
    inspectorPortFree: false,
    processStopped: localCleanup?.processStopped ?? false,
  };
  await rm(projectRoot, { recursive: true, force: true });
  cleanup.projectRemoved = !(await stat(projectRoot).catch(() => undefined));
  cleanup.workerPortFree = await waitForPortAvailability(EDEN_HOST, EDEN_PORT);
  cleanup.inspectorPortFree = await waitForPortAvailability(
    EDEN_HOST,
    EDEN_INSPECTOR_PORT,
  );
  if (!cleanup.projectRemoved || !cleanup.workerPortFree || !cleanup.inspectorPortFree) {
    failure ??= new Error(`Validation cleanup failed: ${JSON.stringify(cleanup)}`);
  }

  if (failure !== undefined) {
    throw new Error(
      `${errorMessage(failure)} Cleanup: ${JSON.stringify(cleanup)}`,
    );
  }
  if (localResult === undefined) {
    throw new Error(`Local conformance produced no result. Cleanup: ${JSON.stringify(cleanup)}`);
  }

  return {
    lifecycle: localResult.lifecycle,
    disconnectedCursor: localResult.disconnectedCursor,
    reconnectedCursors: localResult.reconnectedCursors,
    cleanup,
  };
}

async function main() {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runLocalConformance({ repositoryRoot });
  process.stdout.write(
    `Local conformance passed: ${result.lifecycle.length} lifecycle events, ` +
      `reconnected after cursor ${result.disconnectedCursor}, ` +
      `${LOCAL_RECOVERY_FIXTURES.length} deterministic recovery fixtures, ` +
      "and all owned resources cleaned up.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Local conformance failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

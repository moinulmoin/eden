/* global AbortController, AbortSignal, TextDecoder, clearTimeout, fetch, process, setTimeout */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { accessSync, constants as fsConstants } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ownedProcessReservationCount,
  runOwnedProcess,
  spawnOwnedProcess,
} from "../test/owned-process.mjs";

const EDEN_HOST = "127.0.0.1";
const EDEN_PORT = 8797;
const EDEN_INSPECTOR_PORT = 9297;
const EDEN_BASE_URL = `http://${EDEN_HOST}:${EDEN_PORT}`;
const EDEN_CLI_PATH = join("packages", "cli", "dist", "index.js");
const STARTUP_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 15_000;
const PROCESS_TIMEOUT_MS = 120_000;
const OPERATION_TIMEOUT_MS = 45_000;
const CLEANUP_RETRY_COUNT = 2;
const CLEANUP_RETRY_DELAY_MS = 100;

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  try {
    const resolved = execFileSync("which", [name], {
      encoding: "utf8",
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (resolved.length > 0) return resolved;
  } catch {
    // Let the child process report the missing executable.
  }
  return name;
}

const COREPACK_ENTRYPOINT = resolveExecutable("corepack");

export const LOCAL_RECOVERY_FIXTURES = Object.freeze([
  "packages/runtime-cloudflare/test/turn-runner.test.ts",
  "packages/runtime-cloudflare/test/tool-harness.test.ts",
  "packages/runtime-cloudflare/test/session-recovery.test.ts",
  "packages/runtime-cloudflare/test/failure-eviction-conformance.test.ts",
  "packages/runtime-cloudflare/test/session-journal.test.ts",
  "packages/runtime-cloudflare/test/stream-lifecycle.test.ts",
  "packages/runtime-cloudflare/test/http-host.test.ts",
  "packages/client/test/stream.test.ts",
]);

export const PUBLIC_FAILURE_FIXTURE =
  "packages/runtime-cloudflare/test/failure-eviction-conformance.test.ts";

export const PUBLIC_FAILURE_CASES = Object.freeze([
  "keeps invalid tool input failed after disconnect, eviction, and reconnect",
  "keeps invalid tool invocation count at zero before and after eviction and reconnect",
  "keeps interrupted uncommitted work inspectably retryable after eviction",
  "redacts deterministic interruption text from public events and durable state",
  "replays a completed effect after eviction without another execution",
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

function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted === true) finish();
  });
}

function abortError(signal) {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error("Local conformance operation aborted.");
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError(signal);
}

function createOperationSignal(parentSignal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("runLocalConformance requires a positive operation timeout.");
  }
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? abortError(parentSignal));
    }
  };
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        new Error(`Local conformance operation exceeded ${timeoutMs}ms.`),
      );
    }
  }, timeoutMs);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted === true) abortFromParent();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function childEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  if (overrides.EDEN_BEARER_SECRET === undefined) {
    delete environment.EDEN_BEARER_SECRET;
  }
  return environment;
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
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function runProcess(
  command,
  args,
  {
    cwd,
    env,
    timeoutMs = PROCESS_TIMEOUT_MS,
    signal,
    label = `conformance-${command}`,
  },
) {
  const file = command === "corepack" ? process.execPath : command;
  const processArgs =
    command === "corepack"
      ? [COREPACK_ENTRYPOINT, ...args]
      : args;
  const result = await runOwnedProcess({
    file,
    args: processArgs,
    cwd,
    env: env ?? childEnvironment(),
    timeoutMs,
    signal,
    label,
  });
  if (!result.unresolvedCleanup) return result;
  let retry = await result.retryCleanup();
  for (
    let attempt = 1;
    attempt < CLEANUP_RETRY_COUNT && retry.unresolvedCleanup;
    attempt += 1
  ) {
    await delay(CLEANUP_RETRY_DELAY_MS);
    retry = await result.retryCleanup();
  }
  const cleanupVerified = retry.cleanupVerified;
  const cleanupFailure = retry.cleanupFailure;
  const ok =
    result.code === 0 &&
    result.signal === null &&
    result.error === undefined &&
    !result.timedOut &&
    !result.aborted &&
    !result.outputLimitExceeded &&
    !result.stdoutTruncated &&
    !result.stderrTruncated &&
    cleanupVerified;
  return {
    ...result,
    ok,
    cleanupVerified,
    unresolvedCleanup: !cleanupVerified,
    cleanupStatus: cleanupVerified ? "verified" : "unresolved",
    cleanupFailure,
  };
}

async function runRepositoryBuild(repositoryRoot, signal) {
  throwIfAborted(signal);
  const result = await runProcess(
    "corepack",
    ["pnpm", "run", "build"],
    { cwd: repositoryRoot, signal, label: "conformance-repository-build" },
  );
  throwIfAborted(signal);
  if (!result.ok) {
    throw new Error(
      `The repository build failed before local conformance (exit code ${
        result.code ?? "unknown"
      }, signal ${result.signal ?? "none"}, cleanup ${result.cleanupStatus}): ${
        result.error?.message ?? `${result.stdout}\n${result.stderr}`.trim()
      }`,
    );
  }
}

async function runCli(repositoryRoot, projectRoot, args, secret, signal) {
  throwIfAborted(signal);
  const result = await runProcess(
    process.execPath,
    [join(repositoryRoot, EDEN_CLI_PATH), ...args],
    {
      cwd: repositoryRoot,
      env: childEnvironment(
        secret === undefined ? {} : { EDEN_BEARER_SECRET: secret },
      ),
      signal,
      label: `conformance-eden-${args[0] ?? "command"}`,
    },
  );
  throwIfAborted(signal);
  if (!result.ok) {
    throw new Error(
      `eden ${args[0] ?? "command"} failed: ${
        redact(`${result.stdout}\n${result.stderr}`, secret ?? "")
      } (cleanup ${result.cleanupStatus}).`,
    );
  }
  return result;
}

function portOpen(host, port, signal) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish(false);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
      return;
    }
  });
}

function portAvailable(host, port, signal) {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (!server.listening) {
        signal?.removeEventListener("abort", abort);
        resolve(value);
        return;
      }
      server.close(() => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      });
    };
    const abort = () => finish(false);
    server.once("error", () => finish(false));
    server.listen({ host, port }, () => finish(true));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
      return;
    }
  });
}

async function waitForPortAvailability(host, port, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await portAvailable(host, port)) return true;
    await delay(100);
  }
  return false;
}

function remainingCleanupTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function fetchWithTimeout(
  url,
  options,
  timeoutMs = 5_000,
  signal,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestSignal =
      signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, signal]);
    return await fetch(url, { ...options, signal: requestSignal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonResponse(response, timeoutMs = 5_000, signal) {
  const text = await readResponseBodyTextWithTimeout(response, timeoutMs, signal);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, received HTTP ${response.status}.`);
  }
  return { response, body };
}

export async function readResponseBodyTextWithTimeout(response, timeoutMs = 5_000, signal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("readResponseBodyTextWithTimeout requires a positive timeout.");
  const reader = response.body?.getReader(); if (reader === undefined) return "";
  let timer, abort;
  const stop = new Promise((_, reject) => {
    abort = () => reject(abortError(signal));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error(`Response body read timeout after ${timeoutMs}ms.`)), timeoutMs);
    if (signal?.aborted === true) abort();
  });
  try {
    return await Promise.race([(async () => {
        const decoder = new TextDecoder("utf-8", { fatal: true }); let text = "";
        for (;;) { const next = await reader.read(); if (next.done) return text + decoder.decode(); text += decoder.decode(next.value, { stream: true }); }
      })(), stop]);
  } finally {
    if (timer !== undefined) clearTimeout(timer); if (abort !== undefined) signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

function authorizationHeaders(secret, contentType = false) {
  return {
    authorization: `Bearer ${secret}`,
    ...(contentType ? { "content-type": "application/json" } : {}),
  };
}

async function waitForLocalRuntime(secret, signal) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    throwIfAborted(signal);
    if (await portOpen(EDEN_HOST, EDEN_INSPECTOR_PORT, signal)) {
      try {
        const { response, body } = await readJsonResponse(
          await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/health`, {
            headers: authorizationHeaders(secret),
          }, 5_000, signal),
          5_000,
          signal,
        );
        if (response.status === 200 && body?.status === "ok") return;
      } catch {
        // The Worker can accept TCP before its HTTP route is ready.
      }
    }
    await delay(100, signal);
  }
  throwIfAborted(signal);
  throw new Error("The local Eden Worker did not become ready.");
}

function parseNdjson(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function readNdjsonWithIdleTimeout(reader, timeoutMs = STREAM_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("readNdjsonWithIdleTimeout requires a positive timeout.");
  }
  let timer;
  try {
    return await Promise.race([reader.read(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`NDJSON stream read idle timeout after ${timeoutMs}ms.`)), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readInitialStream(sessionId, secret, expectedCount, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted === true) abort();
  let reader;
  try {
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

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const events = [];
    let buffered = "";
    const deadline = Date.now() + STREAM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const next = await readNdjsonWithIdleTimeout(
        reader,
        Math.max(1, deadline - Date.now()),
      );
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        events.push(JSON.parse(line));
        if (events.length === expectedCount) {
          await reader.cancel();
          return events;
        }
      }
    }
    throwIfAborted(signal);
    throw new Error("The initial NDJSON stream did not reach the disconnect cursor.");
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
}

async function readCatchupUntilTerminal(
  sessionId,
  secret,
  startIndex,
  signal,
) {
  const events = [];
  let cursor = startIndex;
  const deadline = Date.now() + STREAM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const response = await fetchWithTimeout(
      `${EDEN_BASE_URL}/eden/v1/session/${sessionId}/stream?startIndex=${cursor}&follow=false`,
      { headers: authorizationHeaders(secret) },
      5_000,
      signal,
    );
    if (response.status !== 200) {
      throw new Error(`Reconnect NDJSON stream failed with HTTP ${response.status}.`);
    }
    for (const event of parseNdjson(await readResponseBodyTextWithTimeout(response, 5_000, signal))) {
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
    await delay(100, signal);
  }
  throwIfAborted(signal);
  throw new Error("Reconnect did not reach a terminal session event.");
}

async function readNdjsonCatchup(sessionId, secret, startIndex, signal) {
  const response = await fetchWithTimeout(
    `${EDEN_BASE_URL}/eden/v1/session/${sessionId}/stream?startIndex=${startIndex}&follow=false`,
    { headers: authorizationHeaders(secret) },
    5_000,
    signal,
  );
  if (response.status !== 200) {
    throw new Error(`Reconnect NDJSON stream failed with HTTP ${response.status}.`);
  }
  return parseNdjson(await readResponseBodyTextWithTimeout(response, 5_000, signal));
}

async function stateFileExists(projectRoot) {
  try {
    await stat(join(projectRoot, ".eden-dev-state.json"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

async function signalOwnedChild(devProcess, signal) {
  if (devProcess.child.terminateOwned === undefined) return false;
  return await devProcess.child.terminateOwned(signal);
}

export async function stopLocalRuntime(projectRoot, devProcess, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let processStopped = true;
  let childExited = devProcess === undefined;
  if (devProcess !== undefined) {
    const terminated = await signalOwnedChild(devProcess, "SIGTERM");
    processStopped &&= terminated;
    childExited = await Promise.race([
      devProcess.exited.then(() => true),
      delay(remainingCleanupTime(deadline)).then(() => false),
    ]);
    if (!childExited && Date.now() < deadline) {
      const killed = await signalOwnedChild(devProcess, "SIGKILL");
      processStopped &&= killed;
      childExited = await Promise.race([
        devProcess.exited.then(() => true),
        delay(remainingCleanupTime(deadline)).then(() => false),
      ]);
    }
  }

  // The live owned handle is the only authority allowed to signal. A
  // leftover state file is evidence of incomplete cleanup, never a fallback
  // PID/start-time authorization to signal an unrelated process.
  if (await stateFileExists(projectRoot)) processStopped = false;
  if (!childExited) processStopped = false;

  const workerPortFree = await waitForPortAvailability(
    EDEN_HOST,
    EDEN_PORT,
    remainingCleanupTime(deadline),
  );
  const inspectorPortFree = await waitForPortAvailability(
    EDEN_HOST,
    EDEN_INSPECTOR_PORT,
    remainingCleanupTime(deadline),
  );
  return { processStopped, workerPortFree, inspectorPortFree };
}

async function assertCleanRoomArtifacts(projectRoot) {
  const initialEntries = (await readdir(projectRoot))
    .filter((entry) => !entry.startsWith(".eden-init-provenance-"))
    .sort();
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
  for (const required of ["CURRENT", "generations"]) {
    if (!artifactNames.includes(required)) {
      throw new Error(`eden build produced no ${required} artifact root.`);
    }
  }
  const { readArtifactGeneration } = await import(
    "../packages/compiler/dist/index.js"
  );
  const generation = await readArtifactGeneration(join(projectRoot, ".eden"));
  const manifest = generation.artifacts.manifest;
  const metadata = generation.artifacts.buildMetadata;
  const bundle = generation.artifacts.bundle;
  if (
    manifest.bundleDigest !== sha256(bundle) ||
    metadata.bundleDigest !== manifest.bundleDigest ||
    manifest.tools?.length !== 1 ||
    manifest.tools[0]?.name !== "greet" ||
    manifest.tools[0]?.module !== "tool:greet"
  ) {
    throw new Error("Generated manifest and bundle metadata are incoherent.");
  }
  return generation;
}

async function assertNoSecretOrPlatformLocator(projectRoot, secret, generation) {
  const forbidden = [secret];
  const generatedContents = JSON.stringify(generation.artifacts);
  if (forbidden.some((value) => generatedContents.includes(value))) {
    throw new Error("Generated artifact content leaked a forbidden value.");
  }
  const artifactRoot = join(projectRoot, ".eden");
  const pending = [projectRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (path === artifactRoot) continue;
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
  signal,
  registerDevProcess = () => {},
) {
  await runCli(
    repositoryRoot,
    projectRoot,
    ["init", "--project", projectRoot],
    undefined,
    signal,
  );
  await runCli(
    repositoryRoot,
    projectRoot,
    ["build", "--project", projectRoot],
    undefined,
    signal,
  );
  throwIfAborted(signal);
  const generation = await assertCleanRoomArtifacts(projectRoot);
  await assertNoSecretOrPlatformLocator(projectRoot, secret, generation);

  const devProcess = startDev(repositoryRoot, projectRoot, secret, signal);
  registerDevProcess(devProcess);
  if (await devProcess.child.identityReady !== true) {
    throw new Error("The local Eden Worker process identity was not verified.");
  }
  await waitForLocalRuntime(secret, signal);

  const health = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/health`, {
      headers: authorizationHeaders(secret),
    }, 5_000, signal),
    5_000,
    signal,
  );
  if (health.response.status !== 200 || health.body?.status !== "ok") {
    throw new Error("Authenticated local health check failed.");
  }
  assertSafePublicValue(health.body, secret);

  const unauthorized = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/health`, {}, 5_000, signal),
    5_000,
    signal,
  );
  if (unauthorized.response.status !== 401 || JSON.stringify(unauthorized.body).includes(secret)) {
    throw new Error("Local health did not fail closed without the bearer.");
  }
  assertSafePublicValue(unauthorized.body, secret);

  const info = await readJsonResponse(
    await fetchWithTimeout(`${EDEN_BASE_URL}/eden/v1/info`, {
      headers: authorizationHeaders(secret),
    }, 5_000, signal),
    5_000,
    signal,
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
    }, 5_000, signal),
    5_000,
    signal,
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
    }, 5_000, signal),
    5_000,
    signal,
  );
  if (command.response.status !== 202 || command.body?.status !== "accepted") {
    throw new Error("Authenticated command acceptance failed.");
  }
  assertSafePublicValue(command.body, secret);

  const firstEvents = await readInitialStream(sessionId, secret, 5, signal);
  const disconnectedCursor = firstEvents.at(-1)?.streamIndex;
  if (disconnectedCursor !== 5) {
    throw new Error("The disconnected stream did not save cursor 5.");
  }

  const remainingEvents = await readCatchupUntilTerminal(
    sessionId,
    secret,
    disconnectedCursor,
    signal,
  );
  const reconnectEvents = await readNdjsonCatchup(
    sessionId,
    secret,
    disconnectedCursor,
    signal,
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
  await assertNoSecretOrPlatformLocator(projectRoot, secret, generation);

  return {
    lifecycle,
    disconnectedCursor,
    reconnectedCursors: remainingEvents.map((event) => event.streamIndex),
  };
}

function startDev(repositoryRoot, projectRoot, secret, signal) {
  throwIfAborted(signal);
  const child = spawnOwnedProcess({
    file: process.execPath,
    args: [join(repositoryRoot, EDEN_CLI_PATH), "dev", "--project", projectRoot],
    cwd: repositoryRoot,
    env: childEnvironment({ EDEN_BEARER_SECRET: secret }),
    label: "conformance-eden-dev",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = readStreamOutput(child);
  const abort = () => {
    void child.terminateOwned();
  };
  signal?.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal?.removeEventListener("abort", abort));
  return {
    child,
    exited: waitForChild(child),
    output,
  };
}

async function runRecoveryFixtures(repositoryRoot, signal) {
  const summaries = [];
  for (const fixture of LOCAL_RECOVERY_FIXTURES) {
    throwIfAborted(signal);
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
    let reportRoot;
    try {
      throwIfAborted(signal);
      reportRoot = await mkdtemp(join(tmpdir(), "eden-recovery-report-"));
      const reportPath = join(reportRoot, "vitest.json");
      const result = await runProcess(
        "corepack",
        [...args, "--reporter=json", "--outputFile", reportPath],
        {
          cwd: repositoryRoot,
          signal,
          label: `conformance-recovery-${fixture.replaceAll("/", "-")}`,
        },
      );
      throwIfAborted(signal);
      if (!result.ok) {
        throw new Error(
          `Deterministic recovery fixture ${fixture} failed (exit code ${
            result.code ?? "unknown"
          }, cleanup ${result.cleanupStatus}).`,
        );
      }

      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const fileReport = report.testResults?.find(
        (entry) => typeof entry?.name === "string" && entry.name.endsWith(fixture),
      );
      const passedTests = fileReport?.assertionResults
        ?.filter((entry) => entry.status === "passed")
        .map((entry) => entry.title)
        .filter((title) => typeof title === "string") ?? [];
      if (
        fixture === PUBLIC_FAILURE_FIXTURE &&
        PUBLIC_FAILURE_CASES.some((title) => !passedTests.includes(title))
      ) {
        throw new Error(
          `Public failure conformance cases were not all reported as passed: ${
            JSON.stringify(passedTests)
          }`,
        );
      }
      summaries.push({
        fixture,
        passedTests,
        ...(fixture === PUBLIC_FAILURE_FIXTURE
          ? { publicFailureCases: PUBLIC_FAILURE_CASES }
          : {}),
      });
    } finally {
      if (reportRoot !== undefined) {
        await rm(reportRoot, { recursive: true, force: true });
      }
    }
  }
  return summaries;
}

export async function runLocalConformance({
  repositoryRoot,
  runRecoveryFixtures: shouldRunRecoveryFixtures = true,
  signal: parentSignal,
  operationTimeoutMs = OPERATION_TIMEOUT_MS,
}) {
  const operation = createOperationSignal(parentSignal, operationTimeoutMs);
  const { signal } = operation;
  let projectRoot;
  let localResult;
  let recoveryResults = [];
  let failure;
  let devProcess;
  let localCleanup;
  let devOutput;
  let cleanupError;
  const cleanup = {
    projectRemoved: false,
    workerPortFree: false,
    inspectorPortFree: false,
    processStopped: false,
  };
  try {
    try {
      await runRepositoryBuild(repositoryRoot, signal);
      throwIfAborted(signal);
      projectRoot = await mkdtemp(join(tmpdir(), "eden-local-conformance-"));
      const secret = `eden-local-${randomUUID()}`;
      try {
        localResult = await runLocalFirstUse(
          repositoryRoot,
          projectRoot,
          secret,
          signal,
          (ownedProcess) => {
            devProcess = ownedProcess;
          },
        );
      } catch (error) {
        failure = error;
      } finally {
        devOutput = devProcess?.output();
        if (devProcess !== undefined) {
          localCleanup = await stopLocalRuntime(projectRoot, devProcess);
          if (
            !localCleanup.processStopped ||
            !localCleanup.workerPortFree ||
            !localCleanup.inspectorPortFree
          ) {
            failure ??= new Error(
              `Local resource cleanup failed: ${JSON.stringify(localCleanup)}`,
            );
          }
          if (
            localCleanup.processStopped &&
            localCleanup.workerPortFree &&
            localCleanup.inspectorPortFree
          ) {
            devProcess = undefined;
          }
        } else {
          localCleanup = {
            processStopped: true,
            workerPortFree: await waitForPortAvailability(EDEN_HOST, EDEN_PORT),
            inspectorPortFree: await waitForPortAvailability(
              EDEN_HOST,
              EDEN_INSPECTOR_PORT,
            ),
          };
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
    } catch (error) {
      failure ??= error;
    }

    if (failure === undefined && shouldRunRecoveryFixtures) {
      try {
        recoveryResults = await runRecoveryFixtures(repositoryRoot, signal);
      } catch (error) {
        failure = error;
      }
    }
  } finally {
    try {
      if (devProcess !== undefined && projectRoot !== undefined) {
        const retryCleanup = await stopLocalRuntime(
          projectRoot,
          devProcess,
          10_000,
        );
        localCleanup = retryCleanup;
        if (
          retryCleanup.processStopped &&
          retryCleanup.workerPortFree &&
          retryCleanup.inspectorPortFree
        ) {
          devProcess = undefined;
        }
      }
      cleanup.processStopped =
        devProcess === undefined &&
        (localCleanup?.processStopped ?? projectRoot === undefined);
      cleanup.workerPortFree = await waitForPortAvailability(
        EDEN_HOST,
        EDEN_PORT,
      );
      cleanup.inspectorPortFree = await waitForPortAvailability(
        EDEN_HOST,
        EDEN_INSPECTOR_PORT,
      );

      const localResourcesReleased =
        projectRoot === undefined ||
        (cleanup.processStopped &&
          cleanup.workerPortFree &&
          cleanup.inspectorPortFree &&
          ownedProcessReservationCount() === 0);
      if (projectRoot === undefined) cleanup.projectRemoved = true;
      if (projectRoot !== undefined && localResourcesReleased) {
        await rm(projectRoot, { recursive: true, force: true });
        cleanup.projectRemoved = !(await stat(projectRoot).catch(() => undefined));
      }
      if (
        !localResourcesReleased ||
        (projectRoot !== undefined && !cleanup.projectRemoved)
      ) {
        cleanupError = new Error(
          `Validation cleanup failed: ${JSON.stringify(cleanup)}`,
        );
      }
      if (ownedProcessReservationCount() !== 0) {
        cleanupError ??= new Error(
          "Validation cleanup retained owned process reservations.",
        );
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      if (signal.aborted && failure === undefined) failure = abortError(signal);
      operation.dispose();
    }
  }
  if (cleanupError !== undefined) {
    failure ??= cleanupError;
  }
  if (failure !== undefined) {
    const cleanupDetails = JSON.stringify(cleanup);
    throw new Error(
      `${errorMessage(failure)} Cleanup: ${cleanupDetails}${
        cleanupError === undefined ? "" : ` Cleanup failure: ${errorMessage(cleanupError)}`
      }`,
    );
  }
  if (localResult === undefined) {
    throw new Error(`Local conformance produced no result. Cleanup: ${JSON.stringify(cleanup)}`);
  }

  return {
    lifecycle: localResult.lifecycle,
    disconnectedCursor: localResult.disconnectedCursor,
    reconnectedCursors: localResult.reconnectedCursors,
    recoveryResults,
    cleanup,
  };
}

async function main() {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runLocalConformance({ repositoryRoot });
  process.stdout.write(
    `Local conformance passed: ${result.lifecycle.length} lifecycle events, ` +
      `reconnected after cursor ${result.disconnectedCursor}, ` +
      `${result.recoveryResults.length} deterministic recovery fixtures, ` +
      "and all owned resources cleaned up.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Local conformance failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

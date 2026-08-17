/* global AbortController, AbortSignal, clearInterval, clearTimeout, process, setInterval, setTimeout */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ownedProcessReservationCount, ownedProcessReservationLabels } from "./owned-process.mjs";

import {
  LOCAL_RECOVERY_FIXTURES,
  PUBLIC_FAILURE_CASES,
  PUBLIC_FAILURE_FIXTURE,
  readNdjsonWithIdleTimeout,
  readJsonResponse,
  runLocalConformance,
  stopLocalRuntime,
} from "../scripts/local-conformance.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// The operation deadline leaves a separate cleanup budget inside Vitest's
// public deadline; cleanup must finish before the runner can cancel the test.
const LOCAL_CONFORMANCE_TEST_TIMEOUT_MS = 60_000;
const ABORT_REGRESSION_TIMEOUT_MS = 30_000;
const ABORT_REGRESSION_OPERATION_MS = 20_000;
const ABORT_REGRESSION_ABORT_MS = 10_000;
const TEMPORARY_PREFIXES = [
  "eden-local-conformance-",
  "eden-recovery-report-",
  ".eden-dev-vars-",
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function temporaryEntries() {
  return new Set(
    (await readdir(tmpdir())).filter((entry) =>
      TEMPORARY_PREFIXES.some((prefix) => entry.startsWith(prefix)),
    ),
  );
}

function readProcesses() {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,pgid=,lstart=,command="],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          resolve(new Map());
          return;
        }
        const processes = new Map();
        for (const line of String(stdout).split(/\r?\n/u)) {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*?)\s*$/u);
          if (match !== null) processes.set(Number(match[1]), { pgid: Number(match[2]), start: match[3], command: match[4] });
        }
        resolve(processes);
      },
    );
  });
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    const finish = (available) => {
      server.removeAllListeners();
      if (!server.listening) {
        resolve(available);
        return;
      }
      server.close(() => resolve(available));
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port }, () => finish(true));
  });
}

test("rejects a stalled NDJSON reader at its per-read idle deadline", async () => {
  const reader = { read: () => new Promise(() => {}) };
  await expect(readNdjsonWithIdleTimeout(reader, 25)).rejects.toThrow(
    /idle timeout/iu,
  );
});

test("cancels a stalled JSON response body at its bounded deadline", async () => {
  let cancelled = false;
  const response = new globalThis.Response(new globalThis.ReadableStream({ pull: () => new Promise(() => {}), cancel: () => { cancelled = true; } }));
  await expect(readJsonResponse(response, 25))
    .rejects.toThrow(/body read timeout/iu);
  expect(cancelled).toBe(true);
});

test("aborts and cancels a stalled catch-up body without unhandled rejection", async () => {
  let cancelled = false; const unhandled = [];
  const handler = (error) => unhandled.push(error); process.on("unhandledRejection", handler);
  const response = new globalThis.Response(new globalThis.ReadableStream({ pull: () => new Promise(() => {}), cancel: () => { cancelled = true; } }));
  const controller = new AbortController();
  try {
    const pending = readJsonResponse(response, 5_000, controller.signal);
    controller.abort(new Error("body abort"));
    await expect(pending).rejects.toThrow(/abort/iu); await delay(0);
    expect(cancelled).toBe(true); expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", handler); }
});

test("does not signal a residual state-file PID sentinel", async () => {
  const root = await mkdtemp(join(tmpdir(), "eden-local-conformance-state-"));
  const sentinel = (await import("node:child_process")).spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" },
  );
  try {
    const sentinelInfo = (await readProcesses()).get(sentinel.pid);
    expect(sentinelInfo?.start).toEqual(expect.any(String));
    await writeFile(join(root, ".eden-dev-state.json"), JSON.stringify({ pid: sentinel.pid, startedAt: sentinelInfo.start }), "utf8");
    const cleanup = await stopLocalRuntime(root, { child: { terminateOwned: async () => true }, exited: Promise.resolve() }, 500);
    expect(cleanup.processStopped).toBe(false);
    expect(sentinel.exitCode).toBeNull();
    expect(sentinel.signalCode).toBeNull();
  } finally {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      sentinel.kill("SIGTERM");
      await new Promise((resolve) => sentinel.once("close", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("completes the clean-room local first-use flow and reconnects from a saved cursor", async ({ signal }) => {
  const result = await runLocalConformance({
    repositoryRoot,
    signal,
  });

  expect(result.lifecycle).toEqual([
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
  expect(result.disconnectedCursor).toBe(5);
  expect(result.reconnectedCursors).toEqual([6, 7, 8, 9, 10, 11, 12]);
  expect(result.cleanup).toEqual({
    projectRemoved: true,
    workerPortFree: true,
    inspectorPortFree: true,
    processStopped: true,
  });
  const publicFailure = result.recoveryResults.find(
    (entry) => entry.fixture === PUBLIC_FAILURE_FIXTURE,
  );
  expect(publicFailure?.publicFailureCases).toEqual(PUBLIC_FAILURE_CASES);
  expect(publicFailure?.passedTests).toEqual(PUBLIC_FAILURE_CASES);
}, LOCAL_CONFORMANCE_TEST_TIMEOUT_MS);

test(
  "aborts shortened local conformance without retaining owned resources",
  async ({ signal }) => {
    const temporaryBefore = await temporaryEntries();
    const processesBefore = await readProcesses();
    const controller = new AbortController();
    const abortTimer = setTimeout(
      () => controller.abort(new Error("shortened abort regression")),
      ABORT_REGRESSION_ABORT_MS,
    );
    const ownedGroups = new Set();
    const captureTimer = setInterval(() => ownedProcessReservationLabels().forEach(({ groupId }) => Number.isSafeInteger(groupId) && ownedGroups.add(groupId)), 25);
    let failure;
    try {
      await runLocalConformance({
        repositoryRoot,
        signal: AbortSignal.any([signal, controller.signal]),
        operationTimeoutMs: ABORT_REGRESSION_OPERATION_MS,
      });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(abortTimer);
      clearInterval(captureTimer);
    }

    expect(failure).toBeDefined();
    expect(String(failure?.message)).toMatch(/aborted|exceeded|cleanup/iu);
    await delay(250);
    const temporaryAfter = await temporaryEntries();
    expect([...temporaryAfter].filter((entry) => !temporaryBefore.has(entry))).toEqual([]);

    const processesAfter = await readProcesses();
    const newOwnedRuntimeProcesses = [...processesAfter].filter(
      ([pid, processInfo]) =>
        (!processesBefore.has(pid) ||
          processesBefore.get(pid).start !== processInfo.start) &&
        ownedGroups.has(processInfo.pgid) &&
        /(?:eden-local-conformance|eden-dev|workerd|esbuild|127\.0\.0\.1:(?:8797|9297))/iu.test(
          processInfo.command,
        ),
    );
    expect(newOwnedRuntimeProcesses).toEqual([]);
    expect(ownedProcessReservationCount()).toBe(0);
    await expect(portAvailable(8797)).resolves.toBe(true);
    await expect(portAvailable(9297)).resolves.toBe(true);
  },
  ABORT_REGRESSION_TIMEOUT_MS,
);

test("keeps invalid-input and interrupted-step fixtures in the serial conformance gate", async () => {
  expect(LOCAL_RECOVERY_FIXTURES).toEqual([
    "packages/runtime-cloudflare/test/turn-runner.test.ts",
    "packages/runtime-cloudflare/test/tool-harness.test.ts",
    "packages/runtime-cloudflare/test/session-recovery.test.ts",
    "packages/runtime-cloudflare/test/failure-eviction-conformance.test.ts",
    "packages/runtime-cloudflare/test/session-journal.test.ts",
    "packages/runtime-cloudflare/test/stream-lifecycle.test.ts",
    "packages/runtime-cloudflare/test/http-host.test.ts",
    "packages/client/test/stream.test.ts",
  ]);

  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  expect(readme).toContain("corepack pnpm run conformance:local");
  expect(readme).toMatch(/disconnects after committed cursor `5`/i);
  expect(readme).toMatch(/`startIndex=5`/i);
  expect(readme).toMatch(/invalid tool input/i);
  expect(readme).toMatch(/interrupted/i);
});

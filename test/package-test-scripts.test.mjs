import { readFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { expect, test } from "vitest";
import {
  ownedProcessReservationCount,
  ownedProcessReservationLabels,
  runOwnedProcess,
} from "./owned-process.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspacePackageDirectories = [
  "packages/definitions",
  "packages/compiler",
  "packages/runtime-cloudflare",
  "packages/client",
  "packages/cli",
  "examples/basic-agent",
];
// Six package-local processes run serially. Repeated cold runs measured
// 225.9s for this assertion and 96.0s for the separate compiler-filter
// assertion. A 300s budget leaves at least a 74.1s margin for the slower
// assertion while staying scoped to this portability regression instead of
// masking unrelated hangs globally.
const PACKAGE_TEST_SCRIPTS_TIMEOUT_MS = 300_000;
// The slowest observed compiler-filter child was 96.0s; retain a measured 54s
// cushion for cold starts and serial load while still bounding one hung child
// well inside the enclosing 300s assertion.
const PACKAGE_TEST_PROCESS_TIMEOUT_MS = 150_000;
// Keep compiler output bounded while leaving a measured margin over the
// harness default for six serial package logs. This is intentionally finite;
// a noisy or stuck compiler must produce an explicit harness failure.
const PACKAGE_TEST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return name;
}

const corepackEntrypoint = resolveExecutable("corepack");

async function runPnpm(args, cwd, options = {}) {
  const result = await runOwnedProcess({
    file: options.file ?? process.execPath,
    args:
      options.file === undefined
        ? [corepackEntrypoint, "pnpm", ...args]
        : args,
    cwd,
    timeoutMs: options.timeoutMs ?? PACKAGE_TEST_PROCESS_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? PACKAGE_TEST_MAX_BUFFER_BYTES,
    label: options.label ?? "package-test",
  });
  let cleanupRetry;
  let finalResult = result;
  if (result.unresolvedCleanup) {
    cleanupRetry = await result.retryCleanup();
    finalResult = {
      ...result,
      cleanupVerified: cleanupRetry.cleanupVerified,
      unresolvedCleanup: cleanupRetry.unresolvedCleanup,
      cleanupFailure: cleanupRetry.cleanupFailure,
      cleanupStatus: cleanupRetry.cleanupStatus,
      remainingPids: async () => cleanupRetry.remainingPids,
      ok:
        result.code === 0 &&
        result.signal === null &&
        result.error === undefined &&
        !result.timedOut &&
        !result.aborted &&
        !result.outputLimitExceeded &&
        !result.stdoutTruncated &&
        !result.stderrTruncated &&
        cleanupRetry.cleanupVerified,
    };
  }
  return {
    ...finalResult,
    initialCleanupFailure: result.unresolvedCleanup
      ? result.cleanupFailure
      : undefined,
    cleanupRetry,
  };
}

function outcomeDiagnostic(result, label) {
  return [
    `${label} failed`,
    `timedOut=${result.timedOut}`,
    `aborted=${result.aborted}`,
    `code=${result.code ?? "null"}`,
    `signal=${result.signal ?? "null"}`,
    `cleanupFailure=${result.cleanupFailure ?? "none"}`,
    `initialCleanupFailure=${result.initialCleanupFailure ?? "none"}`,
    `cleanupStatus=${result.cleanupStatus}`,
    `stdoutTruncated=${result.stdoutTruncated}`,
    `stderrTruncated=${result.stderrTruncated}`,
    `outputLimitExceeded=${result.outputLimitExceeded}`,
    `terminationReason=${result.terminationReason ?? "none"}`,
    `reservations=${JSON.stringify(ownedProcessReservationLabels())}`,
    `stdout=${result.stdout}`,
    `stderr=${result.stderr}`,
    `error=${result.error?.message ?? "none"}`,
  ].join(" ");
}

function expectNoReservations(label) {
  expect(
    ownedProcessReservationCount(),
    `${label} reservations=${JSON.stringify(ownedProcessReservationLabels())}`,
  ).toBe(0);
}

function expectSuccessfulPackageChild(result, label) {
  try {
    expect(result.ok, outcomeDiagnostic(result, label)).toBe(true);
    expect(result.timedOut, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.cleanupFailure, outcomeDiagnostic(result, label)).toBeUndefined();
    expect(result.unresolvedCleanup, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.stdoutTruncated, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.stderrTruncated, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.outputLimitExceeded, outcomeDiagnostic(result, label)).toBe(false);
  } finally {
    expectNoReservations(label);
  }
}

test.sequential(
  "workspace package test scripts run from their own directories",
  async () => {
    for (const directory of workspacePackageDirectories) {
      const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, directory, "package.json"), "utf8"),
      );
      expect(packageJson.scripts.test).toContain("--maxWorkers=1");

      const result = await runPnpm(
        ["run", "test"],
        join(repositoryRoot, directory),
      );
      expectSuccessfulPackageChild(result, directory);
    }
  },
  PACKAGE_TEST_SCRIPTS_TIMEOUT_MS,
);

test.sequential(
  "the compiler test script works through a workspace filter",
  async () => {
    const result = await runPnpm(
      ["--filter", "@eden/compiler", "run", "test"],
      repositoryRoot,
      { timeoutMs: PACKAGE_TEST_PROCESS_TIMEOUT_MS },
    );
    expectSuccessfulPackageChild(result, "@eden/compiler filter");
  },
  PACKAGE_TEST_SCRIPTS_TIMEOUT_MS,
);

test("aborts a hung package child tree before the next package script", async () => {
  const result = await runPnpm(
    [
      "-e",
      [
        'const { spawn } = await import("node:child_process");',
        'process.on("SIGTERM", () => {});',
        'spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    repositoryRoot,
    {
      file: process.execPath,
      timeoutMs: 150,
      label: "package-hung-fixture",
    },
  );

  try {
    expect(result.ok, outcomeDiagnostic(result, "package hung fixture")).toBe(
      false,
    );
    expect(result.code).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.cleanupVerified).toBe(true);
    await expect(result.remainingPids()).resolves.toEqual([]);
  } finally {
    expectNoReservations("package hung fixture");
  }

  const followUp = await runPnpm(
    [
      "-e",
      'setTimeout(() => process.stdout.write("after-hung-package"), 100)',
    ],
    repositoryRoot,
    {
      file: process.execPath,
      timeoutMs: 2_000,
      label: "package-follow-up",
    },
  );
  expectSuccessfulPackageChild(followUp, "package follow-up");
  expect(followUp.stdout).toBe("after-hung-package");
});

test("treats a signal or null-code package child as a failure", async () => {
  const result = await runPnpm(
    [
      "-e",
      'setTimeout(() => process.kill(process.pid, "SIGTERM"), 500)',
    ],
    repositoryRoot,
    {
      file: process.execPath,
      timeoutMs: 2_000,
      label: "package-signal-fixture",
    },
  );

  try {
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.ok, outcomeDiagnostic(result, "package signal fixture")).toBe(
      false,
    );
    expect(result.cleanupVerified).toBe(true);
    await expect(result.remainingPids()).resolves.toEqual([]);
  } finally {
    expectNoReservations("package signal fixture");
  }
});

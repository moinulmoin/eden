import { readFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { expect, test } from "vitest";
import { runOwnedProcess } from "./owned-process.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspacePackageDirectories = [
  "packages/definitions",
  "packages/compiler",
  "packages/runtime-cloudflare",
  "packages/client",
  "packages/cli",
  "examples/basic-agent",
];
// Six package-local processes run serially. The exact services gate measured
// 204.5s for this assertion and 88.8s for the separate compiler-filter
// assertion on a cold run. A 240s budget leaves at least a 35s margin for the
// slower assertion while staying scoped to this portability regression instead
// of masking unrelated hangs globally.
const PACKAGE_TEST_SCRIPTS_TIMEOUT_MS = 240_000;
// The slowest observed package-local compiler run is below 90s in isolation;
// retain a measured 60s cushion for cold starts and serial load while still
// bounding one hung child well inside the enclosing 240s assertion.
const PACKAGE_TEST_PROCESS_TIMEOUT_MS = 150_000;

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
    label: options.label ?? "package-test",
  });
  return {
    ...result,
    exitCode: result.ok ? 0 : result.code ?? 1,
  };
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
      expect(result.exitCode, `${directory} test script failed`).toBe(0);
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
    expect(result.exitCode).toBe(0);
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

  expect(result.exitCode).not.toBe(0);
  expect(result.code).toBeNull();
  expect(result.signal).not.toBeNull();
  expect(result.timedOut).toBe(true);
  expect(result.cleanupVerified).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);

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
  expect(followUp.exitCode).toBe(0);
  expect(followUp.stdout).toBe("after-hung-package");
});

test("treats a signal or null-code package child as a failure", async () => {
  const result = await runPnpm(
    [
      "-e",
      'setTimeout(() => process.kill(process.pid, "SIGTERM"), 100)',
    ],
    repositoryRoot,
    {
      file: process.execPath,
      timeoutMs: 2_000,
      label: "package-signal-fixture",
    },
  );

  expect(result.code).toBeNull();
  expect(result.signal).toBe("SIGTERM");
  expect(result.exitCode).not.toBe(0);
  expect(result.ok).toBe(false);
  expect(result.cleanupVerified).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
});

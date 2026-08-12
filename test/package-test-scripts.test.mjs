import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspacePackageDirectories = [
  "packages/definitions",
  "packages/compiler",
  "packages/runtime-cloudflare",
  "packages/client",
  "packages/cli",
  "examples/basic-agent",
];
// Six package-local processes run serially; keep the larger budget scoped to
// this portability regression instead of masking unrelated hangs globally.
const PACKAGE_TEST_SCRIPTS_TIMEOUT_MS = 120_000;

function runPnpm(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      "corepack",
      ["pnpm", ...args],
      { cwd, maxBuffer: 1024 * 1024 },
      (error) => {
        resolve(error?.code ?? 0);
      },
    );
  });
}

test.sequential(
  "workspace package test scripts run from their own directories",
  async () => {
    for (const directory of workspacePackageDirectories) {
      const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, directory, "package.json"), "utf8"),
      );
      expect(packageJson.scripts.test).toContain("--maxWorkers=1");

      const exitCode = await runPnpm(
        ["run", "test"],
        join(repositoryRoot, directory),
      );
      expect(exitCode, `${directory} test script failed`).toBe(0);
    }
  },
  PACKAGE_TEST_SCRIPTS_TIMEOUT_MS,
);

test.sequential(
  "the compiler test script works through a workspace filter",
  async () => {
    const exitCode = await runPnpm(
      ["--filter", "@eden/compiler", "run", "test"],
      repositoryRoot,
    );
    expect(exitCode).toBe(0);
  },
  60_000,
);

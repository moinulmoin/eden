import { spawnSync } from "node:child_process";
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureProject = join(repositoryRoot, "test/type-fixtures/tsconfig.json");
const typescriptCompiler = join(
  repositoryRoot,
  "node_modules/typescript/bin/tsc",
);

test("EdenEvent declarations narrow payloads and reject mismatched envelopes", () => {
  const result = spawnSync(
    process.execPath,
    [typescriptCompiler, "--project", fixtureProject],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
});

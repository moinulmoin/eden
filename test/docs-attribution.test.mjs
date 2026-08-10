import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { runEdenCli } from "../packages/cli/src/index.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readRepositoryFile(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

test("documents the supported CLI and clean-room operator boundaries", async () => {
  const readme = await readRepositoryFile("README.md");
  const commandHeadings = [
    ...readme.matchAll(/^### `eden ([a-z]+)`$/gmu),
  ].map((match) => match[1]);

  expect(new Set(commandHeadings)).toEqual(
    new Set(["init", "dev", "build", "deploy"]),
  );
  expect(commandHeadings).toHaveLength(4);
  expect(readme).toContain("corepack pnpm install --frozen-lockfile");
  expect(readme).toMatch(/without (?:Turbo|Turborepo)/i);
  expect(readme).toMatch(/127\.0\.0\.1:8797/);
  expect(readme).toMatch(/127\.0\.0\.1:9297/);
  expect(readme).toContain("EDEN_BEARER_SECRET");
  expect(readme).toMatch(/cursor|startIndex/i);
  expect(readme).toMatch(/Durable Object/i);
  expect(readme).toMatch(/local validation/i);
  expect(readme).toMatch(/deployed validation/i);
  expect(readme).toMatch(/cleanup/i);
  expect(readme).toMatch(/workerd/i);
  expect(readme).toMatch(/node:vm/i);
  expect(readme).toMatch(/provisional limits/i);
  expect(readme).toMatch(/out of scope/i);
  expect(readme).not.toMatch(/eden (?:run|start|stop|shell|schedule|workflow)\b/i);
  expect(readme).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{12,}/i);
});

test("exposes the four-command help surface and rejects unsupported commands", async () => {
  const help = [];
  const errors = [];
  await expect(
    runEdenCli(["--help"], {
      stdout: (line) => help.push(line),
      stderr: (line) => errors.push(line),
    }),
  ).resolves.toBe(0);

  expect(help.join("\n")).toMatch(/init[\s\S]*build[\s\S]*dev[\s\S]*deploy/);
  expect(help.join("\n")).not.toMatch(
    /^\s+(?:run|start|stop|shell|schedule)\s{2,}/imu,
  );
  expect(errors).toEqual([]);

  await expect(
    runEdenCli(["run"], {
      stdout: (line) => help.push(line),
      stderr: (line) => errors.push(line),
    }),
  ).resolves.toBe(1);
  expect(errors.join("\n")).toMatch(/unknown|init|build|dev|deploy/i);
});

test("ships Apache licensing, Eve attribution, and modified-derivative markers", async () => {
  await expect(access(join(repositoryRoot, "LICENSE"))).resolves.toBeUndefined();
  await expect(access(join(repositoryRoot, "NOTICE"))).resolves.toBeUndefined();

  const license = await readRepositoryFile("LICENSE");
  expect(license).toContain("Apache License");
  expect(license).toContain("Version 2.0, January 2004");
  expect(license).toContain("http://www.apache.org/licenses/");
  expect(license).toContain("END OF TERMS AND CONDITIONS");

  const notice = await readRepositoryFile("NOTICE");
  expect(notice).toMatch(/Eve/i);
  expect(notice).toContain("0b102bc90e7cf2c3e294f6ca3af86c307d449b1a");
  expect(notice).toMatch(/Apache-2\.0/i);
  expect(notice).toMatch(/modified derivative/i);

  const markedFiles = [
    "packages/definitions/src/index.ts",
    "packages/compiler/src/index.ts",
    "packages/client/src/protocol.ts",
    "packages/runtime-cloudflare/src/session-journal.ts",
    "packages/runtime-cloudflare/src/model-normalizers.ts",
  ];
  for (const relativePath of markedFiles) {
    const source = await readRepositoryFile(relativePath);
    expect(source).toMatch(/Modified derivative of portable Eve concepts/i);
    expect(source).toContain("0b102bc90e7cf2c3e294f6ca3af86c307d449b1a");
  }
});

import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

import { runEdenCli } from "../packages/cli/src/index.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function readRepositoryFile(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

function extractDocumentedWranglerCommands(readme) {
  return [...readme.matchAll(/```sh\n([\s\S]*?)```/gu)]
    .flatMap((match) =>
      match[1]
        .replaceAll(/\\\n\s*/gu, " ")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /\bwrangler\s+(?:deploy|secret\s+(?:put|delete)|delete)\b/u.test(line)),
    );
}

function tokensForCommand(command) {
  return command.match(/"[^"]*"|'[^']*'|\S+/gu)?.map((token) => token.replace(/^["']|["']$/gu, "")) ?? [];
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

test("retains the exact upstream Eve NOTICE block", async () => {
  const notice = await readRepositoryFile("NOTICE");
  const expectedNotice = [
    "eve",
    "Copyright 2026 Vercel, Inc. and contributors",
    "",
    "This product includes software developed at Vercel, Inc.",
    "(https://vercel.com/).",
    "",
    "Eden",
    "Copyright 2026 Eden contributors",
    "",
    "This repository contains Eden-owned modified derivative implementations",
    "informed by portable concepts from the Eve framework:",
    "",
    "  Eve, version 0.31.3",
    "  https://github.com/vercel/eve",
    "  reference commit: 0b102bc90e7cf2c3e294f6ca3af86c307d449b1a",
    "",
    "Eve is distributed under the Apache License, Version 2.0. The applicable",
    "Apache-2.0 terms are included in LICENSE. This notice is retained for the",
    "Eve attribution obligation; it does not grant ownership of Eden's original",
    "implementation.",
    "",
    "The following Eden source files are marked in-file as modified derivatives of",
    "portable Eve concepts:",
    "",
    "  packages/definitions/src/index.ts",
    "  packages/compiler/src/index.ts",
    "  packages/client/src/protocol.ts",
    "  packages/runtime-cloudflare/src/session-journal.ts",
    "  packages/runtime-cloudflare/src/model-normalizers.ts",
    "",
    "Eden does not include unmodified Eve source. The listed files are Eden-owned",
    "modifications and must retain their in-file modified-derivative notices when",
    "redistributed.",
  ].join("\n") + "\n";

  expect(notice).toBe(expectedNotice);
});

test("targets every documented mutating Wrangler command explicitly", async () => {
  const readme = await readRepositoryFile("README.md");
  const commands = extractDocumentedWranglerCommands(readme);
  expect(commands.length).toBeGreaterThan(0);

  const helpByCommand = new Map();
  for (const command of ["deploy", "secret put", "secret delete", "delete"]) {
    const commandParts = command.split(" ");
    const result = await execFileAsync(
      "corepack",
      ["pnpm", "exec", "wrangler", ...commandParts, "--help"],
      { cwd: repositoryRoot },
    );
    helpByCommand.set(command, `${result.stdout}\n${result.stderr}`);
  }

  for (const documented of commands) {
    const tokens = tokensForCommand(documented);
    const wranglerIndex = tokens.indexOf("wrangler");
    const commandName = tokens[wranglerIndex + 1];
    const commandKey =
      commandName === "secret"
        ? `secret ${tokens[wranglerIndex + 2]}`
        : commandName;
    const help = helpByCommand.get(commandKey);

    expect(help, documented).toBeDefined();
    if (commandKey === "delete") {
      expect(help, documented).toContain("wrangler delete [name]");
      expect(tokens, documented).toContain("--env");
      expect(tokens[wranglerIndex + 2], documented).not.toMatch(/^--/u);
    } else {
      expect(help, documented).toContain(`wrangler ${commandKey}`);
      expect(tokens, documented).toContain("--name");
      expect(tokens[tokens.indexOf("--name") + 1], documented).not.toMatch(/^--/u);
      expect(tokens, documented).not.toContain("--env");
    }
  }
});

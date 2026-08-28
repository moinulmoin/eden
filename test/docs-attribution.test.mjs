import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { runEdenCli } from "../packages/cli/src/index.ts";
import {
  ownedProcessReservationCount,
  ownedProcessReservationLabels,
  runOwnedProcess,
  snapshotOwnedProcesses,
  spawnOwnedProcess,
} from "./owned-process.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerEntrypoint = join(
  repositoryRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
// The four pinned Wrangler help probes take about 1.9s without the pnpm
// launcher and about 3.0s in Vitest. Keep the margin local to this expensive
// assertion rather than increasing the global Vitest timeout. Each owned
// child also has its own shorter cancellation deadline.
const WRANGLER_HELP_TEST_TIMEOUT_MS = 15_000;
const WRANGLER_HELP_PROCESS_TIMEOUT_MS = 10_000;

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

function processDiagnostic(result) {
  return [
    `timedOut=${result.timedOut}`,
    `aborted=${result.aborted}`,
    `code=${result.code ?? "null"}`,
    `signal=${result.signal ?? "null"}`,
    `cleanupFailure=${result.cleanupFailure ?? "none"}`,
    `cleanupStatus=${result.cleanupStatus}`,
    `stdoutTruncated=${result.stdoutTruncated}`,
    `stderrTruncated=${result.stderrTruncated}`,
    `outputLimitExceeded=${result.outputLimitExceeded}`,
    `terminationReason=${result.terminationReason ?? "none"}`,
    `reservations=${JSON.stringify(ownedProcessReservationLabels())}`,
    `error=${result.error?.message ?? "none"}`,
  ].join(" ");
}

function expectNoProcessReservations(label) {
  expect(
    ownedProcessReservationCount(),
    `${label}: ${JSON.stringify(ownedProcessReservationLabels())}`,
  ).toBe(0);
}

test("documents the supported CLI and clean-room operator boundaries", async () => {
  const readme = await readRepositoryFile("README.md");
  const packageReadme = await readRepositoryFile("packages/cli/README.md");
  const deployDoc = await readRepositoryFile("docs/deploy.md");
  const agentCliDoc = await readRepositoryFile("docs/agent-cli.md");
  const validationDoc = await readRepositoryFile("docs/validation.md");
  const workflow = await readRepositoryFile(".github/workflows/ci.yml");

  const commandHeadings = [
    ...agentCliDoc.matchAll(/^## `eden agent ([a-z]+)`$/gmu),
  ].map((match) => match[1]);

  expect(new Set(commandHeadings)).toEqual(
    new Set(["init", "dev", "build", "deploy"]),
  );
  expect(commandHeadings).toHaveLength(4);
  for (const document of [readme, packageReadme]) {
    expect(document).toContain("npm install --global @moinulmoin/eden@0.1.4");
    expect(document).toContain("pnpm add --global @moinulmoin/eden@0.1.4");
    expect(document).toContain("bun add --global @moinulmoin/eden@0.1.4");
    expect(document).toMatch(/Node `>=24\.17\.0`/u);
    expect(document).toContain("Docker or OrbStack");
    expect(document).toContain("npx wrangler@4.120.0 login");
    expect(document).toContain("eden deploy");
    expect(document).toContain("eden destroy");
    expect(document).toContain("mkdir my-agent");
    expect(document).toContain("eden agent init");
    expect(document).toContain("pnpm install");
    expect(document).toContain("corepack enable");
    expect(document).toContain("runs its project-local Eve executable");
    expect(document).toContain("wrangler delete my-agent-preview");
    expect(document).not.toContain("openssl");
  }
  expect(readme).toContain("pnpm install --frozen-lockfile");
  expect(readme).toContain("## Install");
  expect(readme).toContain("Users install only `@moinulmoin/eden`;");
  expect(readme).toMatch(/Bun is supported as an installer only/i);
  expect(readme).toMatch(/Node `>=24\.17\.0` remains\s+the Eden runtime/i);
  expect(agentCliDoc).toMatch(/AI Gateway[\s\S]*`default`/i);
  expect(agentCliDoc).toContain("https://developers.cloudflare.com/ai-gateway/get-started/");
  expect(validationDoc).toMatch(/AI Gateway[\s\S]*`default`/i);
  expect(validationDoc).toContain("https://developers.cloudflare.com/ai-gateway/get-started/");
  for (const document of [readme, agentCliDoc, validationDoc]) {
    expect(document).not.toMatch(/eden-dev[\s\S]*AI Gateway/i);
  }
  expect(workflow).toContain("permissions:\n  contents: read");
  expect(workflow).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
  expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
  expect(workflow).toContain("bun-version: 1.4.0");
  expect(readme).toMatch(/without (?:Turbo|Turborepo)/i);
  expect(readme).toMatch(/127\.0\.0\.1:8797/);
  expect(readme).toMatch(/127\.0\.0\.1:9297/);
  expect(readme).toContain("EDEN_BEARER_SECRET");
  expect(deployDoc).toMatch(/Eve project/i);
  expect(deployDoc).toMatch(/--env-file/i);
  expect(agentCliDoc).toMatch(/Durable Object/i);
  expect(agentCliDoc).toMatch(/workerd/i);
  expect(agentCliDoc).toMatch(/node:vm/i);
  expect(validationDoc).toMatch(/cursor|startIndex/i);
  expect(validationDoc).toMatch(/local validation/i);
  expect(validationDoc).toMatch(/deployed validation/i);
  expect(validationDoc).toMatch(/cleanup/i);
  expect(validationDoc).toMatch(/provisional limits/i);
  expect(validationDoc).toMatch(/out of scope/i);
  for (const document of [readme, deployDoc, agentCliDoc, validationDoc]) {
    expect(document).not.toMatch(
      /eden (?:run|start|stop|shell|schedule|workflow)\b/i,
    );
    expect(document).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{12,}/i);
  }
});

test("exposes the Deploy-first root help and rejects unsupported commands", async () => {
  const help = [];
  const errors = [];
  await expect(
    runEdenCli(["--help"], {
      stdout: (line) => help.push(line),
      stderr: (line) => errors.push(line),
    }),
  ).resolves.toBe(0);

  expect(help.join("\n")).toMatch(/preflight[\s\S]*deploy[\s\S]*destroy[\s\S]*agent/);
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
  expect(errors.join("\n")).toMatch(/unknown|preflight|deploy|destroy|agent/i);
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

test("retains the exact release NOTICE", async () => {
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
    "Cloudflare Containers",
    "  @cloudflare/containers, version 0.3.7",
    "  https://github.com/cloudflare/containers",
    "",
    "Eden's generated Worker host bundle includes software from",
    "`@cloudflare/containers`, distributed under MIT OR Apache-2.0. Eden",
    "redistributes that bundled software under the Apache-2.0 option included in",
    "LICENSE.",
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

test(
  "targets every documented mutating Wrangler command explicitly",
  async () => {
    const [readme, agentCliDoc, validationDoc] = await Promise.all([
      readRepositoryFile("README.md"),
      readRepositoryFile("docs/agent-cli.md"),
      readRepositoryFile("docs/validation.md"),
    ]);
    const commands = extractDocumentedWranglerCommands(
      `${readme}\n${agentCliDoc}\n${validationDoc}`,
    );

    const helpByCommand = new Map();
    for (const command of ["deploy", "secret put", "secret delete", "delete"]) {
      const commandParts = command.split(" ");
      const result = await runOwnedProcess({
        file: process.execPath,
        args: [wranglerEntrypoint, ...commandParts, "--help"],
        cwd: repositoryRoot,
        timeoutMs: WRANGLER_HELP_PROCESS_TIMEOUT_MS,
        label: `wrangler-help-${command.replaceAll(" ", "-")}`,
      });
      expect(
        result.ok,
        `${command} Wrangler help failed: ${result.stderr || result.stdout}`,
      ).toBe(true);
      expectNoProcessReservations(`Wrangler help ${command}`);
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
  },
  WRANGLER_HELP_TEST_TIMEOUT_MS,
);

test(
  "aborts a hung Wrangler help child and its descendants before the next probe",
  async () => {
    const result = await runOwnedProcess({
      file: process.execPath,
      args: [
        "-e",
        [
          'const { spawn } = await import("node:child_process");',
          'process.on("SIGTERM", () => {});',
          'spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      cwd: repositoryRoot,
      timeoutMs: 150,
      label: "wrangler-hung-help-fixture",
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.cleanupVerified).toBe(true);
    await expect(result.remainingPids()).resolves.toEqual([]);

    const followUp = await runOwnedProcess({
      file: process.execPath,
      args: [
        "-e",
        'setTimeout(() => process.stdout.write("after-hung-wrangler"), 100)',
      ],
      cwd: repositoryRoot,
      timeoutMs: 2_000,
      label: "wrangler-follow-up",
    });
    expect(followUp.ok).toBe(true);
    expect(followUp.stdout).toBe("after-hung-wrangler");
    expectNoProcessReservations("hung Wrangler follow-up");
  },
  5_000,
);

test("classifies a signal-terminated Wrangler child as a failure", async () => {
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      'setTimeout(() => process.kill(process.pid, "SIGTERM"), 500)',
    ],
    cwd: repositoryRoot,
    timeoutMs: 2_000,
    label: "wrangler-signal-fixture",
  });

  expect(result.code).toBeNull();
  expect(result.signal).toBe("SIGTERM");
  expect(result.ok).toBe(false);
  expect(result.cleanupVerified).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("signal-terminated Wrangler child");
});

test("waits for close before returning trailing descendant output", async () => {
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      [
        'const { spawn } = await import("node:child_process");',
        'spawn(process.execPath, ["-e", \'setTimeout(() => process.stdout.write("descendant-tail"), 350)\'], { stdio: ["ignore", "inherit", "ignore"] });',
        'process.stdout.write("root-head");',
        "setTimeout(() => process.exit(0), 300);",
      ].join("\n"),
    ],
    cwd: repositoryRoot,
    timeoutMs: 2_000,
    label: "wrangler-close-trailing-output-fixture",
  });

  expect(result.ok, processDiagnostic(result)).toBe(true);
  expect(result.stdout).toBe("root-headdescendant-tail");
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.cleanupVerified).toBe(true);
  expectNoProcessReservations("close trailing output");
});

test("does not SIGKILL a same-group descendant after root exit", async () => {
  let descendantObserved = false;
  let descendantPid;
  const signals = [];
  const snapshot = () => {
    const entries = snapshotOwnedProcesses();
    if (entries === undefined) return entries;
    const descendant = entries.find((entry) =>
      entry.command.includes("eden-owned-term-descendant-child"),
    );
    if (descendant !== undefined) {
      descendantObserved = true;
      descendantPid ??= descendant.pid;
    }
    return entries;
  };
  let result;
  try {
    result = await runOwnedProcess({
      file: process.execPath,
      args: [
        "-e",
        [
          'const { spawn } = await import("node:child_process");',
        'const marker = "eden-owned-term-descendant-" + "child"; spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); process.on(\\"SIGUSR1\\", () => process.exit(0)); setTimeout(() => {}, 60000); /* " + marker + " */"], { stdio: "ignore" });',
          'process.on("SIGTERM", () => process.exit(0));',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      ],
      cwd: repositoryRoot,
      timeoutMs: 2_000,
      label: "term-descendant",
      snapshot,
      sendSignal: (target, signal) => {
        signals.push(signal);
        return process.kill(target, signal);
      },
    });

    expect(descendantObserved).toBe(true); expect(descendantPid).toBeDefined();
    expect(result.cleanupVerified).toBe(false);
    expect(result.unresolvedCleanup).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    process.kill(descendantPid, "SIGUSR1");
    const cleanup = await result.retryCleanup();
    expect(cleanup.cleanupVerified).toBe(true); expect(cleanup.unresolvedCleanup).toBe(false);
    expectNoProcessReservations("same-group descendant");
  } finally {
    if (descendantPid !== undefined) try { process.kill(descendantPid, "SIGUSR1"); } catch { /* already exited */ }
    if (result !== undefined && ownedProcessReservationCount() !== 0) await result.retryCleanup();
  }
}, 15_000);

test("retries a transient root identity observation before cleanup", async () => {
  let injected = false;
  let observations = 0;
  const snapshot = () => {
    const entries = snapshotOwnedProcesses();
    if (entries === undefined) return entries;
    const root = entries.find((entry) =>
      entry.command.includes("eden-owned-wrangler-transient-identity-"),
    );
    if (root !== undefined) {
      observations += 1;
      if (!injected) {
        injected = true;
        return entries.map((entry) =>
          entry.pid === root.pid
            ? { ...entry, command: "transient-wrong-marker" }
            : entry,
        );
      }
    }
    return entries;
  };
  const result = await runOwnedProcess({
    file: process.execPath,
    args: ["-e", 'setTimeout(() => {}, 500)'],
    cwd: repositoryRoot,
    timeoutMs: 2_000,
    label: "wrangler-transient-identity-fixture",
    snapshot,
  });

  expect(observations).toBeGreaterThanOrEqual(2);
  expect(result.ok, processDiagnostic(result)).toBe(true);
  expect(result.cleanupVerified).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("transient identity observation");
});

test("waits for delayed marker and PGID proof before advertising startup", async () => {
  let observations = 0;
  const snapshot = () => {
    const entries = snapshotOwnedProcesses();
    if (entries === undefined) return entries;
    const root = entries.find((entry) =>
      entry.command.includes("eden-owned-startup-delayed-proof-"),
    );
    if (root === undefined) return entries;
    observations += 1;
    if (observations === 1) {
      return entries.map((entry) =>
        entry.pid === root.pid
          ? { ...entry, command: "delayed-startup-marker" }
          : entry,
      );
    }
    if (observations === 2) {
      return entries.map((entry) =>
        entry.pid === root.pid
          ? { ...entry, pgid: root.pgid + 1 }
          : entry,
      );
    }
    return entries;
  };
  const child = spawnOwnedProcess({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repositoryRoot,
    label: "startup-delayed-proof",
    snapshot,
  });

  try {
    await expect(child.identityReady).resolves.toBe(true);
    expect(observations).toBeGreaterThanOrEqual(3);
    expect(ownedProcessReservationCount()).toBe(1);
  } finally {
    await expect(child.terminateOwned()).resolves.toBe(true);
    await expect(child.identityReady).resolves.toBe(true);
    expectNoProcessReservations("delayed startup proof");
  }
});

test("retries one transient failed startup snapshot before advertising identity", async () => {
  let failedSnapshot = false;
  let snapshots = 0;
  const snapshot = () => {
    snapshots += 1;
    if (!failedSnapshot) {
      failedSnapshot = true;
      return undefined;
    }
    return snapshotOwnedProcesses();
  };
  const child = spawnOwnedProcess({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repositoryRoot,
    label: "startup-transient-snapshot",
    snapshot,
  });

  try {
    await expect(child.identityReady).resolves.toBe(true);
    expect(snapshots).toBeGreaterThanOrEqual(2);
    expect(ownedProcessReservationCount()).toBe(1);
  } finally {
    await expect(child.terminateOwned()).resolves.toBe(true);
    expectNoProcessReservations("transient startup snapshot");
  }
});

test(
  "settles a natural early exit without missing-root identity",
  async () => {
    const child = spawnOwnedProcess({
      file: process.execPath,
      args: [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write(`tail`), 350)"], { stdio: ["ignore", "inherit", "ignore"] });',
          "setTimeout(() => process.exit(0), 25);",
        ].join("\n"),
      ],
      cwd: repositoryRoot,
      label: "natural-early-exit",
      snapshot: () => [],
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await expect(child.identityReady).resolves.toBe(false);
      expect(child.closeObserved).toBe(false);
      const termination = child.terminateOwned();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      expect(child.closeObserved).toBe(false);
      expect(ownedProcessReservationCount()).toBe(1);
      expect(ownedProcessReservationLabels()).toContainEqual(
        expect.objectContaining({ failure: "missing-root-process" }),
      );
      await expect(termination).resolves.toBe(true);
      expectNoProcessReservations("natural early exit");
      expect(ownedProcessReservationLabels()).not.toContainEqual(
        expect.objectContaining({ failure: "missing-root-identity" }),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await child.terminateOwned();
      }
      expectNoProcessReservations("natural early exit cleanup");
    }
  },
  10_000,
);

test("releases a reservation after startup spawn failure", async () => {
  const child = spawnOwnedProcess({
    file: join(repositoryRoot, "missing-owned-startup-fixture"),
    cwd: repositoryRoot,
    label: "startup-spawn-failure",
  });

  try {
    await expect(child.identityReady).resolves.toBe(false);
    if (child.closeObserved !== true) {
      await new Promise((resolve) => child.once("close", resolve));
    }
    await expect(child.terminateOwned()).resolves.toBe(true);
    expectNoProcessReservations("startup spawn failure");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await child.terminateOwned();
    }
    expectNoProcessReservations("startup spawn failure cleanup");
  }
});

test("waits for startup identity before terminating during observation", async () => {
  let observations = 0;
  const signals = [];
  const snapshot = () => {
    const entries = snapshotOwnedProcesses();
    if (entries === undefined) return entries;
    const root = entries.find((entry) =>
      entry.command.includes("eden-owned-terminate-during-startup-"),
    );
    if (root === undefined) return entries;
    observations += 1;
    if (observations <= 2) {
      return entries.map((entry) =>
        entry.pid === root.pid
          ? {
              ...entry,
              command:
                observations === 1
                  ? "startup-termination-marker-delay"
                  : entry.command,
              pgid: observations === 2 ? root.pgid + 1 : entry.pgid,
            }
          : entry,
      );
    }
    return entries;
  };
  const child = spawnOwnedProcess({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repositoryRoot,
    label: "terminate-during-startup",
    snapshot,
    sendSignal: (target, signal) => {
      signals.push(signal);
      return process.kill(target, signal);
    },
  });

  try {
    const termination = child.terminateOwned();
    await expect(child.identityReady).resolves.toBe(true);
    await expect(termination).resolves.toBe(true);
    expect(observations).toBeGreaterThanOrEqual(3);
    expect(signals).toContain("SIGTERM");
    expectNoProcessReservations("termination during startup observation");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await child.terminateOwned();
    }
    expectNoProcessReservations("termination during startup cleanup");
  }
});

test("retries a root hidden once after SIGKILL before declaring cleanup", async () => {
  let hideRootOnNextSnapshot = false;
  let rootHidden = false;
  let rootPid;
  let snapshotsAfterHide = 0;
  const snapshot = () => {
    const entries = snapshotOwnedProcesses();
    if (entries === undefined) return entries;
    if (rootHidden) snapshotsAfterHide += 1;
    const root = entries.find((entry) =>
      entry.command.includes("eden-owned-wrangler-hidden-root-"),
    );
    if (root !== undefined) rootPid = root.pid;
    if (hideRootOnNextSnapshot) {
      hideRootOnNextSnapshot = false;
      rootHidden = rootPid !== undefined;
      if (rootHidden) snapshotsAfterHide += 1;
      return entries.filter((entry) => entry.pid !== rootPid);
    }
    if (rootHidden) snapshotsAfterHide += 1;
    return entries;
  };
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ],
    cwd: repositoryRoot,
    timeoutMs: 150,
    label: "wrangler-hidden-root-fixture",
    snapshot,
    sendSignal: (target, signal) => {
      if (signal === "SIGKILL") hideRootOnNextSnapshot = true;
      return process.kill(target, signal);
    },
  });

  expect(rootHidden).toBe(true);
  expect(snapshotsAfterHide).toBeGreaterThan(0);
  expect(result.ok, processDiagnostic(result)).toBe(false);
  expect(result.timedOut).toBe(true);
  expect(result.signal).toBe("SIGKILL");
  expect(result.cleanupVerified, processDiagnostic(result)).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("hidden root after SIGKILL");
});

test("diagnoses output-limit termination without retaining a reservation", async () => {
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      [
        'process.stdout.write("x".repeat(1024 * 1024 + 1));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    cwd: repositoryRoot,
    timeoutMs: 2_000,
    label: "wrangler-output-limit-fixture",
  });

  expect(result.ok, processDiagnostic(result)).toBe(false);
  expect(result.outputLimitExceeded).toBe(true);
  expect(result.stdoutTruncated).toBe(true);
  expect(result.error?.message).toMatch(/output limit exceeded/iu);
  expect(result.cleanupVerified, processDiagnostic(result)).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("output-limit termination");
});

test("aborts a hung Wrangler child tree within the owned cleanup bound", async () => {
  const controller = new globalThis.AbortController();
  const abortTimer = globalThis.setTimeout(() => controller.abort(), 100);
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ],
    cwd: repositoryRoot,
    timeoutMs: 5_000,
    signal: controller.signal,
    label: "wrangler-abort-fixture",
  });
  globalThis.clearTimeout(abortTimer);

  expect(result.ok).toBe(false);
  expect(result.aborted).toBe(true);
  expect(result.cleanupVerified).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("aborted Wrangler child");
});

test(
  "fails closed on an empty process snapshot before recovering owned cleanup",
  async () => {
  let observe = false;
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      'setInterval(() => {}, 1000)',
    ],
    cwd: repositoryRoot,
    timeoutMs: 1_000,
    label: "wrangler-empty-snapshot-fixture",
    snapshot: () => (observe ? snapshotOwnedProcesses() : []),
  });

  expect(result.ok).toBe(false);
  expect(result.cleanupVerified).toBe(false);
  expect(result.unresolvedCleanup).toBe(true);
  expect(result.cleanupStatus).toBe("unresolved");
  await expect(result.remainingPids()).resolves.toBeUndefined();
  expect(ownedProcessReservationCount()).toBe(1);

  observe = true;
  const cleanup = await result.retryCleanup();
  expect(cleanup.cleanupVerified).toBe(true);
  expect(cleanup.unresolvedCleanup).toBe(false);
  expect(cleanup.remainingPids).toEqual([]);
  expectNoProcessReservations("empty snapshot retry");
  },
  10_000,
);

test(
  "fails closed when process observation itself is unavailable",
  async () => {
  let observe = false;
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ],
    cwd: repositoryRoot,
    timeoutMs: 1_000,
    label: "wrangler-failed-observation-fixture",
    snapshot: () => (observe ? snapshotOwnedProcesses() : undefined),
  });

  expect(result.ok).toBe(false);
  expect(result.cleanupVerified).toBe(false);
  expect(result.cleanupFailure).toBe("process-observation-failed");
  expect(result.unresolvedCleanup).toBe(true);
  await expect(result.remainingPids()).resolves.toBeUndefined();
  expect(ownedProcessReservationCount()).toBe(1);

  observe = true;
  const cleanup = await result.retryCleanup();
  expect(cleanup.cleanupVerified).toBe(true);
  expect(cleanup.remainingPids).toEqual([]);
  expectNoProcessReservations("unavailable snapshot retry");
  },
  10_000,
);

test(
  "fails a zero-code child when cleanup evidence is unavailable",
  async () => {
  let identityObserved = false;
  let restoreObservation = false;
  const snapshot = () => {
    const entries = snapshotOwnedProcesses();
    if (entries === undefined) return entries;
    const root = entries.find((entry) =>
      entry.command.includes("eden-owned-wrangler-zero-code-cleanup-"),
    );
    if (root !== undefined) identityObserved = true;
    if (identityObserved && !restoreObservation && root === undefined) {
      return undefined;
    }
    return entries;
  };
  const result = await runOwnedProcess({
    file: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 100)"],
    cwd: repositoryRoot,
    timeoutMs: 2_000,
    label: "wrangler-zero-code-cleanup-fixture",
    snapshot,
  });

  expect(identityObserved).toBe(true);
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.ok, processDiagnostic(result)).toBe(false);
  expect(result.cleanupVerified).toBe(false);
  expect(result.unresolvedCleanup).toBe(true);
  expect(result.cleanupFailure).toBe("process-observation-failed");
  expect(ownedProcessReservationCount()).toBe(1);

  restoreObservation = true;
  const cleanup = await result.retryCleanup();
  expect(cleanup.cleanupVerified).toBe(true);
  expect(cleanup.unresolvedCleanup).toBe(false);
  expect(cleanup.remainingPids).toEqual([]);
  expectNoProcessReservations("zero-code cleanup retry");
  },
  10_000,
);

test(
  "keeps a replaced terminal root unresolved until identity is restored",
  async () => {
  let replaceIdentity = false;
  let replacementInjected = false;
  let rootPid;
  const signals = [];
  const snapshot = () => {
    const entries = snapshotOwnedProcesses();
    if (entries === undefined) return entries;
    if (!replaceIdentity || rootPid === undefined) return entries;
    return entries.map((entry) =>
      entry.pid === rootPid
        ? {
            ...entry,
            command: "unrelated-replacement-process",
            state: "Z",
          }
        : entry,
    );
  };
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ],
    cwd: repositoryRoot,
    // The fixture must install its SIGTERM handler before the timeout
    // delivers the first signal: node's exec-to-handler window (~25ms here)
    // can stretch past 150ms under load, letting the first SIGTERM terminate
    // an unarmed root and verify cleanup as a natural exit.
    timeoutMs: 600,
    label: "wrangler-identity-replacement-fixture",
    snapshot,
    sendSignal: (target, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM" && !replacementInjected) {
        replacementInjected = true;
        // The harness signals the owned group (-pgid) and the detached root
        // leads that group, so the first SIGTERM target names exactly this
        // run's root. Keying the replacement on that pid ignores stale
        // same-label fixtures leaked by earlier interrupted runs.
        rootPid = Math.abs(target);
        replaceIdentity = true;
      }
      return process.kill(target, signal);
    },
  });

  try {
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.cleanupVerified).toBe(false);
    expect(result.unresolvedCleanup).toBe(true);
    expect(result.cleanupFailure).toMatch(
      /root-marker-mismatch|ownership-unverified|cleanup-unverified|process-observation-failed/u,
    );
    expect(signals).toEqual(["SIGTERM"]);
    await expect(result.remainingPids()).resolves.toBeUndefined();

    replaceIdentity = false;
    const cleanup = await result.retryCleanup();
    expect(cleanup.cleanupVerified).toBe(true);
    expect(cleanup.remainingPids).toEqual([]);
  } finally {
    replaceIdentity = false;
    await result.retryCleanup();
  }
  },
  10_000,
);

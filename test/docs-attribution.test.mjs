import { access, readdir, readFile } from "node:fs/promises";
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
const cfEntrypoint = join(repositoryRoot, "node_modules", "cf", "bin", "cf");
// The cf command users type, at the version Eden runs.
const CF_COMMAND = "npx cf@1.0.0-rc.2";
// One cf help probe takes about 0.4s. Keep the margin local to this
// assertion rather than increasing the global Vitest timeout. Each owned
// child also has its own shorter cancellation deadline.
const CF_HELP_TEST_TIMEOUT_MS = 30_000;
const CF_HELP_PROCESS_TIMEOUT_MS = 10_000;

async function readRepositoryFile(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

// Every cf command line inside a sh block, which is what a user copies.
function extractDocumentedCfCommands(document) {
  return [...document.matchAll(/```sh\n([\s\S]*?)```/gu)]
    .flatMap((match) =>
      match[1]
        .replaceAll(/\\\n\s*/gu, " ")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /(?:^|\s)cf(?:@\S+)?\s/u.test(line)),
    );
}

// The subcommand words of a documented cf line: everything before its first
// flag, placeholder, or value.
function cfCommandPath(tokens) {
  const path = [];
  for (const token of tokens) {
    if (!/^[a-z][a-z-]*$/u.test(token)) break;
    path.push(token);
  }
  return path;
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
  const validationDoc = await readRepositoryFile("docs/validation.md");
  const workflow = await readRepositoryFile(".github/workflows/ci.yml");
  for (const document of [readme, packageReadme]) {
    // Install commands stay unversioned so they never go stale between releases.
    expect(document).toMatch(/^npm install --global @moinulmoin\/eden$/mu);
    expect(document).toMatch(/^pnpm add --global @moinulmoin\/eden$/mu);
    expect(document).toMatch(/^bun add --global @moinulmoin\/eden$/mu);
    expect(document).toMatch(/Node `\^24\.22\.0 \|\| \^26\.12\.0`/u);
    expect(document).toContain("Docker or OrbStack");
    expect(document).toContain(`${CF_COMMAND} auth login`);
    expect(document).not.toMatch(/wrangler@|wrangler (?:login|whoami)/u);
    expect(document).toContain("eden deploy");
    expect(document).toContain("eden destroy");
    expect(document).toMatch(/pnpm (?:add --global|install)/);
    expect(document).toMatch(/runs its project-local Eve\s+executable/);
    expect(document).not.toContain("openssl");
  }
  expect(readme).toContain("pnpm install --frozen-lockfile");
  expect(readme).toContain("## Install");
  expect(readme).toContain("Users install only `@moinulmoin/eden`;");
  expect(readme).toMatch(/Bun is supported as an installer only/i);
  expect(readme).toMatch(/Node `\^24\.22\.0 \|\| \^26\.12\.0` remains\s+the Eden runtime/i);
  expect(workflow).toContain("permissions:\n  contents: read");
  expect(workflow).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
  expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
  expect(workflow).toContain("bun-version: 1.4.0");
  expect(readme).toMatch(/without (?:Turbo|Turborepo)/i);
  expect(deployDoc).toMatch(/Eve project/i);
  expect(deployDoc).toMatch(/--env-file/i);
  expect(validationDoc).toMatch(/compat:eve:local/i);
  expect(validationDoc).toMatch(/deployed validation/i);
  expect(validationDoc).toMatch(/cleanup/i);
  expect(validationDoc).toMatch(/provisional limits/i);
  for (const document of [readme, packageReadme, deployDoc, validationDoc]) {
    expect(document).not.toMatch(/eden agent\b/i);
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

  expect(help.join("\n")).toMatch(/preflight[\s\S]*deploy[\s\S]*destroy/);
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
  expect(errors.join("\n")).toMatch(/unknown|preflight|deploy|destroy/i);
});

test("ships Apache licensing", async () => {
  await expect(access(join(repositoryRoot, "LICENSE"))).resolves.toBeUndefined();
  await expect(access(join(repositoryRoot, "NOTICE"))).resolves.toBeUndefined();

  const license = await readRepositoryFile("LICENSE");
  expect(license).toContain("Apache License");
  expect(license).toContain("Version 2.0, January 2004");
  expect(license).toContain("http://www.apache.org/licenses/");
  expect(license).toContain("END OF TERMS AND CONDITIONS");
});

test("retains the exact release NOTICE", async () => {
  const notice = await readRepositoryFile("NOTICE");
  const expectedNotice = [
    "Eden",
    "Copyright 2026 Eden contributors",
    "",
    "Workflow SDK",
    "  @workflow/world-postgres, version 5.0.0-beta.47",
    "  https://github.com/vercel/workflow",
    "",
    "Eden's Cloudflare World storage implementation",
    "(`@moinulmoin/eden-world-cloudflare`) is adapted from the Workflow SDK",
    "PostgreSQL World, distributed under the Apache License, Version 2.0.",
  ].join("\n") + "\n";

  expect(notice).toBe(expectedNotice);
});

test(
  "documents only cf commands that the pinned cf has, mutating ones included",
  async () => {
    const docs = (await readdir(join(repositoryRoot, "docs")))
      .filter((name) => name.endsWith(".md") && name !== "eve-compatibility-history.md")
      .map((name) => `docs/${name}`);
    const documents = await Promise.all(
      ["README.md", "packages/cli/README.md", "skills/eden/SKILL.md", ...docs].map(readRepositoryFile),
    );
    const commands = [...new Set(documents.flatMap(extractDocumentedCfCommands))];

    const helpByPath = new Map();
    const documentedPaths = new Set();
    for (const documented of commands) {
      const tokens = tokensForCommand(documented);
      // Every cf line a user copies names the version Eden runs.
      expect(documented, documented).toContain(`${CF_COMMAND} `);
      const path = cfCommandPath(tokens.slice(tokens.indexOf("cf@1.0.0-rc.2") + 1));
      expect(path.length, documented).toBeGreaterThan(0);
      const key = path.join(" ");
      documentedPaths.add(key);
      if (!helpByPath.has(key)) {
        const result = await runOwnedProcess({
          file: process.execPath,
          args: [cfEntrypoint, ...path, "--help"],
          cwd: repositoryRoot,
          timeoutMs: CF_HELP_PROCESS_TIMEOUT_MS,
          label: `cf-help-${path.join("-")}`,
        });
        expect(result.ok, `${key} cf help failed: ${result.stderr || result.stdout}`).toBe(true);
        expectNoProcessReservations(`cf help ${key}`);
        helpByPath.set(key, `${result.stdout}\n${result.stderr}`);
      }
      const help = helpByPath.get(key);
      // cf answers an unknown command with an error box and exit code 0.
      expect(help, documented).toMatch(new RegExp(`^cf ${key}(?: |$)`, "mu"));
      expect(help, documented).not.toContain("Unknown command");
      for (const flag of tokens.filter((token) => token.startsWith("--"))) {
        expect(help, documented).toMatch(new RegExp(`(?:^|\\s)${flag}[ ,]`, "mu"));
      }
    }

    // The commands that change the account, which the docs tell a user to type.
    for (const mutating of [
      "auth login",
      "workers delete",
      "containers applications delete",
      "containers images delete",
    ]) {
      expect([...documentedPaths], mutating).toContain(mutating);
    }
  },
  CF_HELP_TEST_TIMEOUT_MS,
);

test(
  "aborts a hung cf help child and its descendants before the next probe",
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
      label: "cf-hung-help-fixture",
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
        'setTimeout(() => process.stdout.write("after-hung-cf"), 100)',
      ],
      cwd: repositoryRoot,
      timeoutMs: 2_000,
      label: "cf-follow-up",
    });
    expect(followUp.ok).toBe(true);
    expect(followUp.stdout).toBe("after-hung-cf");
    expectNoProcessReservations("hung cf follow-up");
  },
  5_000,
);

test("classifies a signal-terminated cf child as a failure", async () => {
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [
      "-e",
      'setTimeout(() => process.kill(process.pid, "SIGTERM"), 500)',
    ],
    cwd: repositoryRoot,
    timeoutMs: 2_000,
    label: "cf-signal-fixture",
  });

  expect(result.code).toBeNull();
  expect(result.signal).toBe("SIGTERM");
  expect(result.ok).toBe(false);
  expect(result.cleanupVerified).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("signal-terminated cf child");
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
    label: "cf-close-trailing-output-fixture",
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
      entry.command.includes("eden-owned-cf-transient-identity-"),
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
    label: "cf-transient-identity-fixture",
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
      entry.command.includes("eden-owned-cf-hidden-root-"),
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
    label: "cf-hidden-root-fixture",
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
    label: "cf-output-limit-fixture",
  });

  expect(result.ok, processDiagnostic(result)).toBe(false);
  expect(result.outputLimitExceeded).toBe(true);
  expect(result.stdoutTruncated).toBe(true);
  expect(result.error?.message).toMatch(/output limit exceeded/iu);
  expect(result.cleanupVerified, processDiagnostic(result)).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("output-limit termination");
});

test("aborts a hung cf child tree within the owned cleanup bound", async () => {
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
    label: "cf-abort-fixture",
  });
  globalThis.clearTimeout(abortTimer);

  expect(result.ok).toBe(false);
  expect(result.aborted).toBe(true);
  expect(result.cleanupVerified).toBe(true);
  await expect(result.remainingPids()).resolves.toEqual([]);
  expectNoProcessReservations("aborted cf child");
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
    label: "cf-empty-snapshot-fixture",
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
    label: "cf-failed-observation-fixture",
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
      entry.command.includes("eden-owned-cf-zero-code-cleanup-"),
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
    label: "cf-zero-code-cleanup-fixture",
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
    label: "cf-identity-replacement-fixture",
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

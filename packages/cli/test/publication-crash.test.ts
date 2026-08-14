import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { readArtifactGeneration } from "@eden/compiler";
import { runEdenCli } from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const childScript = fileURLToPath(
  new URL("./publication-crash-child.mjs", import.meta.url),
);
const roots: string[] = [];
const children: ChildProcess[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function waitForFile(
  path: string,
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `publication crash child exited before reaching its boundary: ${
            child.signalCode ?? child.exitCode ?? "unknown"
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`publication crash child did not reach ${path}`);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
    };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("publication crash child did not exit"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function startCrashChild(
  command: "init" | "build",
  root: string,
  boundary: string,
  target = "",
): {
  readonly child: ChildProcess;
  readonly readyPath: string;
} {
  const readyPath = join(
    root,
    `.eden-crash-ready-${command}-${boundary}-${target || "none"}`,
  );
  const child = spawn(
    process.execPath,
    [childScript, command, root, boundary, target, readyPath],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  children.push(child);
  return { child, readyPath };
}

async function killWithSigkill(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    expect(child.kill("SIGKILL")).toBe(true);
  }
  const result = await waitForExit(child);
  expect(result.code).toBeNull();
  expect(result.signal).toBe("SIGKILL");
}

async function currentProcessStartIdentity(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-p", String(process.pid), "-o", "lstart="],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

async function init(root: string): Promise<void> {
  await expect(
    runEdenCli(["init", "--project", root], {
      cwd: root,
    }),
  ).resolves.toBe(0);
}

async function createOwnedStaleLock(root: string): Promise<void> {
  const { child, readyPath } = startCrashChild(
    "init",
    root,
    "after-lock-acquire",
  );
  await waitForFile(readyPath, child);
  await killWithSigkill(child);
  await rm(readyPath, { force: true });
}

async function build(root: string): Promise<void> {
  await expect(
    runEdenCli(["build", "--project", root], {
      cwd: root,
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    }),
  ).resolves.toBe(0);
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await waitForExit(child).catch(() => undefined);
    }),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI OS-crash publication recovery", () => {
  test("recovers an owned stale-lock quarantine left after SIGKILL", async () => {
    const root = await createRoot("eden-cli-init-quarantine-recovery-");
    await createOwnedStaleLock(root);

    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "before-stale-lock-removal",
    );
    await waitForFile(readyPath, child);
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      readFile(join(root, "agent/agent.ts"), "utf8"),
    ).resolves.toContain("EdenAgentDefinition");
    await expect(stat(join(root, ".eden-init.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readdir(root),
    ).resolves.toEqual(
      expect.arrayContaining(["agent", "package.json", "wrangler.jsonc"]),
    );
  });

  test.each([
    ["after-lock-acquire", ""],
    ["after-target-validation", "package.json"],
    ["before-target-publish", "package.json"],
  ] as const)(
    "recovers init safely after SIGKILL at %s",
    async (boundary, target) => {
      const root = await createRoot("eden-cli-init-os-crash-");
      if (boundary !== "after-lock-acquire") {
        await expect(
          runEdenCli(["init", "--project", root], {
            cwd: root,
            initPublicationHook: async (observedBoundary) => {
              if (observedBoundary === "after-state-write") {
                throw new Error("seed incomplete scaffold");
              }
            },
          }),
        ).resolves.toBe(1);
      }

      const { child, readyPath } = startCrashChild(
        "init",
        root,
        boundary,
        target,
      );
      await waitForFile(readyPath, child);
      if (boundary === "after-lock-acquire") {
        await expect(
          runEdenCli(["init", "--project", root], {
            cwd: root,
          }),
        ).resolves.toBe(1);
        await expect(stat(join(root, ".eden-init.lock"))).resolves.toBeDefined();
      }
      if (boundary === "before-target-publish") {
        await writeFile(
          join(root, target),
          "created by a competing initializer\n",
          {
            encoding: "utf8",
            flag: "wx",
          },
        );
      }
      await killWithSigkill(child);
      await rm(readyPath, { force: true });

      if (boundary === "before-target-publish") {
        await expect(
          runEdenCli(["init", "--project", root], {
            cwd: root,
          }),
        ).resolves.toBe(1);
        await expect(readFile(join(root, target), "utf8")).resolves.toBe(
          "created by a competing initializer\n",
        );
        await expect(
          stat(join(root, ".eden-init-incomplete.json")),
        ).resolves.toBeDefined();
      } else {
        await init(root);
        await expect(
          stat(join(root, "agent/agent.ts")),
        ).resolves.toBeDefined();
        await expect(
          stat(join(root, "agent/instructions.md")),
        ).resolves.toBeDefined();
        await expect(
          stat(join(root, "agent/tools/greet.ts")),
        ).resolves.toBeDefined();
        await expect(stat(join(root, "package.json"))).resolves.toBeDefined();
        await expect(stat(join(root, "wrangler.jsonc"))).resolves.toBeDefined();
        await expect(
          stat(join(root, ".eden-init-incomplete.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(
        readFile(join(root, "agent/agent.ts"), "utf8"),
      ).resolves.toContain("EdenAgentDefinition");
      expect(await readdir(root)).not.toContain(".eden-init.lock");
    },
  );

  test("reconciles an authenticated transition intent in a fresh process after SIGKILL", async () => {
    const root = await createRoot("eden-cli-init-transition-intent-crash-");
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);

    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "after-init-transition-intent",
    );
    await waitForFile(readyPath, child);
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      readFile(join(root, "package.json"), "utf8"),
    ).resolves.toContain('"eden-basic-agent"');
    await expect(
      stat(join(root, ".eden-init-incomplete.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves a replacement staged source after SIGKILL before source removal", async () => {
    const root = await createRoot("eden-cli-init-staged-source-os-race-");
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);

    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "before-init-source-removal",
    );
    await waitForFile(readyPath, child);
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    const state = JSON.parse(
      await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ) as { readonly stageName: string };
    const stagedPath = join(root, state.stageName, "agent/instructions.md");
    await rm(stagedPath, { force: false });
    const replacement = "replacement staged source\n";
    await writeFile(stagedPath, replacement, "utf8");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(1);
    await expect(readFile(stagedPath, "utf8")).resolves.toBe(replacement);
    await expect(
      readFile(join(root, "agent/instructions.md"), "utf8"),
    ).resolves.toContain("concise, helpful");
    await expect(
      stat(join(root, ".eden-init-incomplete.json")),
    ).resolves.toBeDefined();
  });

  test("preserves a replacement live init lock after a stale-lock owner is SIGKILLed", async () => {
    const root = await createRoot("eden-cli-init-lock-os-race-");
    const lockPath = join(root, ".eden-init.lock");
    await createOwnedStaleLock(root);
    const replacement = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: process.pid,
      startedAt: await currentProcessStartIdentity(),
      token: "replacement-live-token",
    })}\n`;
    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "before-stale-lock-removal",
    );
    await waitForFile(readyPath, child);
    await writeFile(lockPath, replacement, "utf8");
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(1);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
    await expect(stat(join(root, "package.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not authenticate a replacement lock with prior lock provenance", async () => {
    const root = await createRoot("eden-cli-init-stale-provenance-reuse-");
    const lockPath = join(root, ".eden-init.lock");
    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "after-lock-acquire",
    );
    await waitForFile(readyPath, child);
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    const replacement = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: 99_999_999,
      startedAt: "replacement-process-start",
      token: "replacement-token",
    })}\n`;
    await writeFile(lockPath, replacement, "utf8");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(1);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
    await expect(stat(join(root, "package.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test.each(["before-current-promotion", "after-current-promotion"] as const)(
    "recovers build artifacts after SIGKILL at %s without mixed output",
    async (boundary) => {
      const root = await createRoot("eden-cli-build-os-crash-");
      await init(root);
      await build(root);
      const before = await readArtifactGeneration(join(root, ".eden"));
      const beforeId = before.artifacts.buildMetadata.generationId;
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        (await readFile(join(root, "agent/tools/greet.ts"), "utf8")).replace(
          "Greet a person by name.",
          "OS-crash generation.",
        ),
        "utf8",
      );

      const { child, readyPath } = startCrashChild(
        "build",
        root,
        boundary,
      );
      await waitForFile(readyPath, child);
      await killWithSigkill(child);
      await rm(readyPath, { force: true });

      const recovered = await readArtifactGeneration(join(root, ".eden"));
      const recoveredId = recovered.artifacts.buildMetadata.generationId;
      expect(recoveredId).toMatch(/^gen_[a-f0-9]{64}$/u);
      expect(recovered.artifacts.manifest.bundleDigest).toBe(
        recovered.artifacts.buildMetadata.bundleDigest,
      );
      expect(recovered.artifacts.manifest.bundleDigest).toBe(
        createHash("sha256").update(recovered.artifacts.bundle).digest("hex"),
      );
      if (boundary === "before-current-promotion") {
        expect(recoveredId).toBe(beforeId);
      } else {
        expect(recoveredId).not.toBe(beforeId);
        expect(recovered.artifacts.bundle).toContain("OS-crash generation.");
      }

      await build(root);
      const afterRecovery = await readArtifactGeneration(join(root, ".eden"));
      expect(afterRecovery.artifacts.manifest.bundleDigest).toBe(
        afterRecovery.artifacts.buildMetadata.bundleDigest,
      );
      expect(afterRecovery.artifacts.manifest.tools.map((tool) => tool.name)).toEqual([
        "greet",
      ]);
    },
  );
});

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
import { spawn, type ChildProcess } from "node:child_process";
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

async function init(root: string): Promise<void> {
  await expect(
    runEdenCli(["agent", "init", "--project", root], {
      cwd: root,
    }),
  ).resolves.toBe(0);
}

async function build(root: string): Promise<void> {
  await expect(
    runEdenCli(["agent", "build", "--project", root], {
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
  test.each([
    ["after-lock-acquire", "", false],
    ["after-stage-write", "", false],
    ["after-state-write", "", true],
    ["after-target-validation", "package.json", true],
    ["before-target-publish", "package.json", true],
    ["after-target-publish", "package.json", true],
    ["before-complete", "", true],
  ] as const)(
    "SIGKILL at %s leaves exact residue and converges only when state is complete",
    async (boundary, target, mayRecover) => {
      const root = await createRoot("eden-cli-init-os-crash-");
      const { child, readyPath } = startCrashChild(
        "init",
        root,
        boundary,
        target,
      );
      await waitForFile(readyPath, child);
      await killWithSigkill(child);
      await rm(readyPath, { force: true });

      const beforeEntries = await readdir(root);
      const recovery = await runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
      });
      if (!mayRecover) {
        expect(recovery).toBe(1);
        expect(await readdir(root)).toEqual(beforeEntries);
        await expect(stat(join(root, "package.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        return;
      }

      expect(recovery).toBe(0);
      for (const relativePath of [
        "agent/instructions.md",
        "agent/agent.ts",
        "agent/tools/greet.ts",
        "package.json",
        "wrangler.jsonc",
      ]) {
        await expect(stat(join(root, relativePath))).resolves.toBeDefined();
      }
      await expect(stat(join(root, ".eden-init-incomplete.json")))
        .resolves.toBeDefined();
      await expect(stat(join(root, ".eden-init.lock"))).resolves.toBeDefined();
    },
  );

  test.each(["before-init-destination-recheck", "after-init-link"] as const)(
    "SIGKILL at the real %s hook converges without false evidence",
    async (boundary) => {
      const root = await createRoot("eden-cli-init-os-real-hook-");
      const { child, readyPath } = startCrashChild(
        "init",
        root,
        boundary,
      );
      await waitForFile(readyPath, child);
      await killWithSigkill(child);
      await rm(readyPath, { force: true });

      await expect(
        runEdenCli(["agent", "init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);
      await expect(
        readFile(join(root, "agent/instructions.md"), "utf8"),
      ).resolves.toContain("concise, helpful");
    },
  );

  test("concurrent init subprocesses leave one owned lock and converge through recovery", async () => {
    const root = await createRoot("eden-cli-init-os-concurrent-");
    const first = startCrashChild("init", root, "after-state-write");
    await waitForFile(first.readyPath, first.child);
    const second = startCrashChild("init", root, "after-lock-acquire");
    const secondResult = await waitForExit(second.child);
    expect(secondResult.code).toBe(1);
    expect(secondResult.signal).toBeNull();
    await killWithSigkill(first.child);
    await rm(first.readyPath, { force: true });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
  });

  test("preserves a competing destination after a fresh-process SIGKILL", async () => {
    const root = await createRoot("eden-cli-init-os-collision-");
    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "before-target-publish",
      "package.json",
    );
    await waitForFile(readyPath, child);
    const sentinel = "created by a competing initializer\n";
    await writeFile(join(root, "package.json"), sentinel, {
      encoding: "utf8",
      flag: "wx",
    });
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(1);
    await expect(readFile(join(root, "package.json"), "utf8"))
      .resolves.toBe(sentinel);
    await expect(stat(join(root, ".eden-init-incomplete.json")))
      .resolves.toBeDefined();
  });

  test("preserves tampered staged residue after a fresh-process SIGKILL", async () => {
    const root = await createRoot("eden-cli-init-os-tampered-residue-");
    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "after-state-write",
    );
    await waitForFile(readyPath, child);
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    const state = JSON.parse(
      await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ) as { readonly stageName: string };
    const residue = join(root, state.stageName, "agent/instructions.md");
    const stateBytes = await readFile(
      join(root, ".eden-init-incomplete.json"),
      "utf8",
    );
    await writeFile(residue, "tampered staged bytes\n", "utf8");

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(1);
    await expect(readFile(residue, "utf8")).resolves.toBe(
      "tampered staged bytes\n",
    );
    await expect(
      readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ).resolves.toBe(stateBytes);
  });

  test("repeated fresh-process recovery is idempotent and complete residue builds", async () => {
    const root = await createRoot("eden-cli-init-os-idempotent-");
    const { child, readyPath } = startCrashChild(
      "init",
      root,
      "after-target-publish",
      "package.json",
    );
    await waitForFile(readyPath, child);
    await killWithSigkill(child);
    await rm(readyPath, { force: true });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const snapshot = await Promise.all([
      readdir(root),
      readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
      readFile(join(root, "package.json"), "utf8"),
    ]);
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      Promise.all([
        readdir(root),
        readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
        readFile(join(root, "package.json"), "utf8"),
      ]),
    ).resolves.toEqual(snapshot);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
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

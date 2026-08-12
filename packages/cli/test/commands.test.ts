import {
  createHash,
} from "crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "fs/promises";
import {
  tmpdir,
} from "os";
import {
  join,
} from "path";
import { afterAll, describe, expect, test, vi } from "vitest";

import { readArtifactGeneration } from "@eden/compiler";
import {
  EDEN_CLI_COMMANDS,
  runEdenCli,
  type EdenCliDryRunRequest,
} from "../src/index.js";

const temporaryRoots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function artifactHashes(root: string): Promise<Record<string, string>> {
  const output = join(root, ".eden");
  const generation = (await readArtifactGeneration(output)).artifacts;
  const values = {
    "agent-bundle.mjs": generation.bundle,
    "build-metadata.json": JSON.stringify(generation.buildMetadata),
    "diagnostics.json": JSON.stringify(generation.diagnostics),
    "discovery.json": JSON.stringify(generation.discovery),
    "manifest.json": JSON.stringify(generation.manifest),
    "module-map.json": JSON.stringify(generation.moduleMap),
  } as const;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(async ([name, contents]) => [
        name,
        createHash("sha256").update(contents).digest("hex"),
      ]),
    ),
  );
}

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("eden CLI project commands", () => {
  test("fails closed when init cannot capture a verifiable process identity", async () => {
    const root = await createRoot("eden-cli-init-identity-unavailable-");
    const psShimDirectory = await createRoot("eden-cli-init-ps-shim-");
    await writeFile(
      join(psShimDirectory, "ps"),
      "#!/bin/sh\nexit 1\n",
      { encoding: "utf8", mode: 0o755 },
    );
    const errors: string[] = [];
    vi.stubEnv("PATH", psShimDirectory);
    try {
      await expect(
        runEdenCli(["init", "--project", root], {
          cwd: root,
          stderr: (line) => errors.push(line),
        }),
      ).resolves.toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(errors.join("\n")).toMatch(/identity|verif/i);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  test("preserves an active lock that contains only a PID fallback identity", async () => {
    const root = await createRoot("eden-cli-init-pid-only-lock-");
    const lockPath = join(root, ".eden-init.lock");
    const lockContents = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: process.pid,
      startedAt: `pid:${process.pid}`,
      token: "pid-only-token",
    })}\n`;
    await writeFile(lockPath, lockContents, "utf8");
    const errors: string[] = [];

    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContents);
    expect(errors.join("\n")).toMatch(/busy|identity|verif|lock/i);
    await expect(readdir(root)).resolves.toEqual([".eden-init.lock"]);
  });

  test("initializes a valid scaffold without a secret file", async () => {
    const root = await createRoot("eden-cli-init-");
    const output: string[] = [];

    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stdout: (line) => output.push(line),
      }),
    ).resolves.toBe(0);

    await expect(stat(join(root, "agent/instructions.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "agent/agent.ts"))).resolves.toBeDefined();
    await expect(stat(join(root, "agent/tools/greet.ts"))).resolves.toBeDefined();
    await expect(stat(join(root, "package.json"))).resolves.toBeDefined();
    await expect(stat(join(root, "wrangler.jsonc"))).resolves.toBeDefined();
    const wrangler = JSON.parse(
      await readFile(join(root, "wrangler.jsonc"), "utf8"),
    ) as {
      readonly ai?: unknown;
      readonly env?: {
        readonly preview?: { readonly name?: unknown };
        readonly production?: { readonly name?: unknown };
      };
    };
    expect(wrangler.ai).toEqual({ binding: "AI" });
    expect(wrangler.env?.preview?.name).toBe("eden-basic-agent-preview");
    expect(wrangler.env?.production?.name).toBe("eden-basic-agent-production");
    expect(
      (await readdir(root))
        .filter((entry) => !entry.startsWith(".eden-init-provenance-"))
        .sort(),
    ).toEqual(["agent", "package.json", "wrangler.jsonc"]);
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".dev.vars"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.join("")).toContain("Initialized");
  });

  test("refuses non-empty roots without changing candidate or unrelated bytes", async () => {
    const root = await createRoot("eden-cli-existing-");
    const unrelated = join(root, "notes.txt");
    const candidate = join(root, "agent");
    await writeFile(unrelated, "keep me\n", "utf8");
    await writeFile(join(root, "agent.ts"), "existing candidate\n", "utf8");
    const before = {
      unrelated: await sha256(unrelated),
      candidate: await sha256(join(root, "agent.ts")),
    };
    const errors: string[] = [];

    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    expect(await sha256(unrelated)).toBe(before.unrelated);
    expect(await sha256(join(root, "agent.ts"))).toBe(before.candidate);
    await expect(stat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    expect(errors.join("")).toMatch(/empty|overwrite/i);
  });

  test.each([
    "after-state-write",
    "after-stage-write",
    "before-target-publish",
    "after-target-publish",
    "before-complete",
  ] as const)(
    "leaves an explicit incomplete scaffold and recovers after %s interruption",
    async (interruption) => {
      const root = await createRoot("eden-cli-init-interrupted-");
      const errors: string[] = [];
      const options = {
        cwd: root,
        stderr: (line: string) => errors.push(line),
        initPublicationHook: async (boundary: string) => {
          if (boundary === interruption) {
            throw new Error(`injected ${interruption} interruption`);
          }
        },
      };

      await expect(
        runEdenCli(["init", "--project", root], options),
      ).resolves.toBe(1);

      await expect(
        stat(join(root, ".eden-init-incomplete.json")),
      ).resolves.toBeDefined();
      await expect(
        runEdenCli(["build", "--project", root], {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
        }),
      ).resolves.toBe(1);
      expect(errors.join("\n")).toMatch(/incomplete|interrupted/i);

      await expect(
        runEdenCli(["init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);
      await expect(stat(join(root, "agent/instructions.md"))).resolves.toBeDefined();
      await expect(stat(join(root, "agent/agent.ts"))).resolves.toBeDefined();
      await expect(stat(join(root, "agent/tools/greet.ts"))).resolves.toBeDefined();
      await expect(stat(join(root, "package.json"))).resolves.toBeDefined();
      await expect(stat(join(root, "wrangler.jsonc"))).resolves.toBeDefined();
      await expect(
        stat(join(root, ".eden-init-incomplete.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("refuses recovery after staged bytes are tampered", async () => {
    const root = await createRoot("eden-cli-init-tampered-");
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("injected init interruption");
          }
        },
      }),
    ).resolves.toBe(1);

    const state = JSON.parse(
      await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ) as { readonly stageName: string };
    await writeFile(
      join(root, state.stageName, "agent/instructions.md"),
      "tampered\n",
      "utf8",
    );
    const errors: string[] = [];
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toMatch(/staged|changed|hash/i);
    await expect(
      readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ).resolves.toContain("eden.init.incomplete");
    expect(await readdir(root)).toContain(state.stageName);
  });

  test("preserves unrelated bytes when recovery finds a new root entry", async () => {
    const root = await createRoot("eden-cli-init-recovery-conflict-");
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("injected init interruption");
          }
        },
      }),
    ).resolves.toBe(1);
    const unrelated = join(root, "notes.txt");
    await writeFile(unrelated, "keep this byte\n", "utf8");
    const before = await sha256(unrelated);
    const errors: string[] = [];

    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    expect(await sha256(unrelated)).toBe(before);
    expect(errors.join("\n")).toMatch(/unrelated|existing|preserved/i);
  });

  test("does not replace a destination created after recovery validation", async () => {
    const root = await createRoot("eden-cli-init-recovery-race-");
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("injected init interruption");
          }
        },
      }),
    ).resolves.toBe(1);

    const sentinel = "created by a competing initializer\n";
    const recoveryOptions = {
      cwd: root,
      initPublicationHook: async (
        boundary: string,
        target?: string,
      ) => {
        if (boundary === "after-target-validation" && target === "package.json") {
          await writeFile(join(root, "package.json"), sentinel, {
            encoding: "utf8",
            flag: "wx",
          });
        }
      },
    } as unknown as Parameters<typeof runEdenCli>[1];

    await expect(
      runEdenCli(["init", "--project", root], recoveryOptions),
    ).resolves.toBe(1);
    await expect(readFile(join(root, "package.json"), "utf8"))
      .resolves.toBe(sentinel);
    await expect(
      readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ).resolves.toContain("eden.init.incomplete");
  });

  test("preserves the source when the destination changes before source removal", async () => {
    const root = await createRoot("eden-cli-init-source-removal-race-");
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("injected init interruption");
          }
        },
      }),
    ).resolves.toBe(1);

    const replacement = "created during source removal\n";
    let replaced = false;
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary, target) => {
          if (
            !replaced &&
            boundary === "before-init-source-removal" &&
            target?.endsWith("package.json")
          ) {
            replaced = true;
            await rm(join(root, "package.json"), { force: true });
            await writeFile(join(root, "package.json"), replacement, "utf8");
          }
        },
      }),
    ).resolves.toBe(1);
    await expect(readFile(join(root, "package.json"), "utf8")).resolves.toBe(
      replacement,
    );
    await expect(
      stat(join(root, ".eden-init-incomplete.json")),
    ).resolves.toBeDefined();
    const stagedState = JSON.parse(
      await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ) as { readonly stageName: string };
    await expect(
      readFile(join(root, stagedState.stageName, "package.json"), "utf8"),
    ).resolves.toContain('"eden-basic-agent"');
  });

  test("fails one of two concurrent init attempts without losing scaffold bytes", async () => {
    const root = await createRoot("eden-cli-init-concurrent-");
    const results = await Promise.all([
      runEdenCli(["init", "--project", root], { cwd: root }),
      runEdenCli(["init", "--project", root], { cwd: root }),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    await expect(readFile(join(root, "agent/agent.ts"), "utf8"))
      .resolves.toContain("EdenAgentDefinition");
    await expect(readFile(join(root, "package.json"), "utf8"))
      .resolves.toContain('"eden-basic-agent"');
    await expect(
      stat(join(root, ".eden-init-incomplete.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves a stale init lock without original Eden provenance", async () => {
    const root = await createRoot("eden-cli-init-stale-lock-");
    const lockContents = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: 99_999_999,
      startedAt: "stale-process-start",
      token: "stale-token",
    })}\n`;
    await writeFile(
      join(root, ".eden-init.lock"),
      lockContents,
      "utf8",
    );

    const errors: string[] = [];
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    await expect(readFile(join(root, ".eden-init.lock"), "utf8")).resolves.toBe(
      lockContents,
    );
    expect(errors.join("\n")).toMatch(/provenance|ownership|preserved|busy/i);
  });

  test("does not promote an incomplete same-identity generation over the prior CURRENT", async () => {
    const root = await createRoot("eden-cli-same-identity-incomplete-");
    const sourcePath = join(root, "agent/tools/greet.ts");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const firstGeneration = await readArtifactGeneration(join(root, ".eden"));
    const firstSource = await readFile(sourcePath, "utf8");
    const secondSource = firstSource.replace(
      "Greet a person by name.",
      "Second same-identity generation.",
    );
    await writeFile(sourcePath, secondSource, "utf8");
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const secondGeneration = await readArtifactGeneration(join(root, ".eden"));
    expect(secondGeneration.artifacts.buildMetadata.generationId).not.toBe(
      firstGeneration.artifacts.buildMetadata.generationId,
    );

    await writeFile(sourcePath, firstSource, "utf8");
    await rm(
      join(
        root,
        ".eden/generations",
        firstGeneration.artifacts.buildMetadata.generationId,
        "manifest.json",
      ),
    );
    const errors: string[] = [];

    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(1);

    const current = await readArtifactGeneration(join(root, ".eden"));
    expect(current.artifacts.buildMetadata.generationId).toBe(
      secondGeneration.artifacts.buildMetadata.generationId,
    );
    expect(errors.join("\n")).toMatch(/incoherent|incomplete|manifest|artifact/i);
  });

  test("does not promote a digest-mismatched same-identity generation over the prior CURRENT", async () => {
    const root = await createRoot("eden-cli-same-identity-digest-");
    const sourcePath = join(root, "agent/tools/greet.ts");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const firstGeneration = await readArtifactGeneration(join(root, ".eden"));
    const firstSource = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      firstSource.replace(
        "Greet a person by name.",
        "Second digest generation.",
      ),
      "utf8",
    );
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const secondGeneration = await readArtifactGeneration(join(root, ".eden"));

    await writeFile(sourcePath, firstSource, "utf8");
    await writeFile(
      join(
        root,
        ".eden/generations",
        firstGeneration.artifacts.buildMetadata.generationId,
        "agent-bundle.mjs",
      ),
      "tampered same-identity bundle\n",
      "utf8",
    );
    const errors: string[] = [];

    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(1);

    const current = await readArtifactGeneration(join(root, ".eden"));
    expect(current.artifacts.buildMetadata.generationId).toBe(
      secondGeneration.artifacts.buildMetadata.generationId,
    );
    expect(errors.join("\n")).toMatch(/digest|incoherent|artifact/i);
  });

  test("rejects an extra generated descendant symlink before same-identity promotion", async () => {
    const root = await createRoot("eden-cli-extra-generated-symlink-");
    const outside = await createRoot("eden-cli-extra-generated-symlink-target-");
    const sourcePath = join(root, "agent/tools/greet.ts");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const first = await readArtifactGeneration(join(root, ".eden"));
    const firstSource = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      firstSource.replace(
        "Greet a person by name.",
        "Second generated identity.",
      ),
      "utf8",
    );
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const second = await readArtifactGeneration(join(root, ".eden"));
    await writeFile(sourcePath, firstSource, "utf8");
    await symlink(
      outside,
      join(
        first.directory,
        "extra-generated-link",
      ),
      "dir",
    );
    const errors: string[] = [];

    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(1);

    await expect(
      realpath(join(root, ".eden/CURRENT")),
    ).resolves.toBe(second.directory);
    expect(errors.join("\n")).toMatch(/symlink|symbolic|unsafe|outside/i);
  });

  test("preserves a replacement lock when an unowned stale lock is observed", async () => {
    const root = await createRoot("eden-cli-init-lock-race-");
    const lockPath = join(root, ".eden-init.lock");
    const liveOwnerStartedAt = await new Promise<string>((resolve, reject) => {
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
    const replacement = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: process.pid,
      startedAt: liveOwnerStartedAt,
      token: "replacement-token",
    })}\n`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        kind: "eden.init.lock",
        version: 1,
        pid: 99_999_999,
        startedAt: "stale-process-start",
        token: "stale-token",
      })}\n`,
      "utf8",
    );

    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary !== "before-stale-lock-removal") return;
          await writeFile(lockPath, replacement, {
            encoding: "utf8",
            flag: "wx",
          });
        },
      }),
    ).resolves.toBe(1);

    await expect(readFile(lockPath, "utf8")).resolves.toContain('"stale-token"');
    await expect(stat(join(root, "package.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not remove a replacement lock during owned-lock release", async () => {
    const root = await createRoot("eden-cli-init-release-lock-race-");
    const lockPath = join(root, ".eden-init.lock");
    const replacement = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: process.pid,
      startedAt: "replacement-live-owner",
      token: "replacement-release-token",
    })}\n`;

    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary !== "before-complete") return;
          const observed = `${lockPath}.observed`;
          await rename(lockPath, observed);
          await writeFile(lockPath, replacement, {
            encoding: "utf8",
            flag: "wx",
          });
          await rm(observed, { force: true });
        },
      }),
    ).resolves.toBe(0);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
    await expect(stat(join(root, "package.json"))).resolves.toBeDefined();
  });

  test("does not overwrite a destination collision during stale-lock quarantine", async () => {
    const root = await createRoot("eden-cli-init-quarantine-destination-race-");
    const lockContents = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: 99_999_999,
      startedAt: "stale-process-start",
      token: "stale-destination-token",
    })}\n`;
    const quarantinePath = join(
      root,
      `.eden-init-stale-lock-999999999-stale-destination-token-${createHash(
        "sha256",
      )
        .update(lockContents)
        .digest("hex")}`,
    );
    const destinationContents = "created by a competing initializer\n";
    await writeFile(join(root, ".eden-init.lock"), lockContents, "utf8");
    await writeFile(quarantinePath, destinationContents, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    await expect(readFile(join(root, ".eden-init.lock"), "utf8")).resolves.toBe(
      lockContents,
    );
    await expect(readFile(quarantinePath, "utf8")).resolves.toBe(
      destinationContents,
    );
    expect(errors.join("\n")).toMatch(/destination|preserved|busy|quarantine/i);
  });

  test("preserves an unowned stale lock instead of creating quarantine state", async () => {
    const root = await createRoot("eden-cli-init-quarantine-source-race-");
    const lockContents = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: 99_999_999,
      startedAt: "stale-process-start",
      token: "stale-source-token",
    })}\n`;
    await writeFile(join(root, ".eden-init.lock"), lockContents, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    await expect(readFile(join(root, ".eden-init.lock"), "utf8")).resolves.toBe(
      lockContents,
    );
    expect(
      (await readdir(root)).some((entry) =>
        entry.startsWith(".eden-init-stale-lock-"),
      ),
    ).toBe(false);
    expect(errors.join("\n")).toMatch(/provenance|ownership|preserved|busy/i);
  });

  test("preserves the prior CURRENT when canonical metadata is malformed", async () => {
    const root = await createRoot("eden-cli-malformed-canonical-metadata-");
    const sourcePath = join(root, "agent/tools/greet.ts");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const first = await readArtifactGeneration(join(root, ".eden"));
    const firstSource = await readFile(sourcePath, "utf8");

    await writeFile(
      sourcePath,
      firstSource.replace(
        "Greet a person by name.",
        "Second coherent generation.",
      ),
      "utf8",
    );
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const second = await readArtifactGeneration(join(root, ".eden"));

    await writeFile(sourcePath, firstSource, "utf8");
    const metadataPath = join(
      root,
      ".eden/generations",
      first.artifacts.buildMetadata.generationId,
      "build-metadata.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    metadata.createdAt = "not-a-timestamp";
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(1);

    await expect(readArtifactGeneration(join(root, ".eden"))).resolves.toMatchObject({
      artifacts: {
        buildMetadata: {
          generationId: second.artifacts.buildMetadata.generationId,
        },
      },
    });
    expect(errors.join("\n")).toMatch(/createdAt|timestamp|artifact|incoherent/i);
  });

  test("does not delete an unverified user-created quarantine filename", async () => {
    const root = await createRoot("eden-cli-unverified-init-quarantine-");
    const token = "user-created-token";
    const userFile = join(
      root,
      `.eden-init-recovery-999999999-${token}-${createHash("sha256")
        .update("not-the-file-contents")
        .digest("hex")}`,
    );
    const userContents = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: 99_999_999,
      startedAt: "stale-process-start",
      token,
    })}\n`;
    await writeFile(userFile, userContents, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    await expect(readFile(userFile, "utf8")).resolves.toBe(userContents);
    expect(errors.join("\n")).toMatch(/lock|quarantine|ownership|preserved|busy/i);
  });

  test("does not delete a self-consistent user-created quarantine filename", async () => {
    const root = await createRoot("eden-cli-forged-init-quarantine-");
    const token = "user-created-self-consistent-token";
    const userContents = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: 99_999_999,
      startedAt: "stale-process-start",
      token,
    })}\n`;
    const userFile = join(
      root,
      `.eden-init-recovery-999999999-${token}-${createHash("sha256")
        .update(userContents)
        .digest("hex")}`,
    );
    await writeFile(userFile, userContents, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    await expect(readFile(userFile, "utf8")).resolves.toBe(userContents);
    expect(errors.join("\n")).toMatch(/lock|quarantine|ownership|preserved|busy/i);
  });

  test("rejects a symbolic-link project root before writing", async () => {
    const parent = await createRoot("eden-cli-symlink-");
    const target = join(parent, "target");
    const link = join(parent, "link");
    await mkdir(target);
    await symlink(target, link, "dir");
    const errors: string[] = [];

    await expect(
      runEdenCli(["init", "--project", link], {
        cwd: parent,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    expect(await readdir(target)).toEqual([]);
    expect(errors.join("")).toMatch(/symbolic link|canonical/i);
  });

  test("builds a coherent artifact generation through a dry-run only", async () => {
    const root = await createRoot("eden-cli-build-");
    const calls: EdenCliDryRunRequest[] = [];

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const originalConfig = await readFile(join(root, "wrangler.jsonc"), "utf8");
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async (request) => {
          calls.push(request);
          return { exitCode: 0, stdout: "dry-run\n", stderr: "" };
        },
      }),
    ).resolves.toBe(0);

    const generation = (await readArtifactGeneration(join(root, ".eden"))).artifacts;
    const manifest = generation.manifest;
    const bundle = generation.bundle;
    expect(manifest.bundleDigest).toBe(
      createHash("sha256").update(bundle).digest("hex"),
    );
    expect(manifest.tools.map((tool) => tool.name)).toEqual(["greet"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "deploy",
      "--dry-run",
      "--config",
      calls[0]?.configPath,
    ]);
    expect(calls[0]?.cwd).toBe(await realpath(root));
    expect(await readFile(join(root, "wrangler.jsonc"), "utf8")).toBe(
      originalConfig,
    );
  });

  test("preserves the last coherent generation when compatibility validation fails", async () => {
    const root = await createRoot("eden-cli-failed-build-");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const before = await artifactHashes(root);
    await writeFile(
      join(root, "agent/tools/greet.ts"),
      `import { readFile } from "node:fs/promises";
export default {
  description: "invalid",
  inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
  execute() { return { value: typeof readFile }; }
};
`,
      "utf8",
    );
    const errors: string[] = [];

    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => {
          throw new Error("dry-run must not be reached");
        },
      }),
    ).resolves.toBe(1);

    expect(await artifactHashes(root)).toEqual(before);
    expect(errors.join("")).toMatch(/MODULE_IMPORT_UNSUPPORTED|Node-only|Worker/i);
    expect(
      (await readdir(root)).filter((entry) => entry.includes(".candidate-")),
    ).toEqual([]);
  });

  test("does not promote a candidate when the dry-run command fails", async () => {
    const root = await createRoot("eden-cli-dry-run-failure-");
    const errors: string[] = [];

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const before = await artifactHashes(root);

    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "compatibility failed",
        }),
      }),
    ).resolves.toBe(1);

    expect(await artifactHashes(root)).toEqual(before);
    expect(errors.join("")).toContain("compatibility failed");
    expect(
      (await readdir(root)).filter((entry) =>
        entry.includes("eden-build-config") ||
        entry.includes("eden-build-candidate") ||
        entry.includes("eden-build-previous"),
      ),
    ).toEqual([]);
  });

  test("rejects source mutation during Wrangler validation before promotion", async () => {
    const root = await createRoot("eden-cli-stale-source-");
    const sourcePath = join(root, "agent/tools/greet.ts");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
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
    const before = await artifactHashes(root);
    const originalSource = await readFile(sourcePath, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => {
          await writeFile(
            sourcePath,
            originalSource.replace(
              "Greet a person by name.",
              "Changed while Wrangler was validating.",
            ),
            "utf8",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBe(1);

    expect(await artifactHashes(root)).toEqual(before);
    expect(errors.join("\n")).toMatch(/source|configuration|changed|stale/i);
  });

  test("rejects Wrangler configuration mutation during validation before promotion", async () => {
    const root = await createRoot("eden-cli-stale-config-");
    const configPath = join(root, "wrangler.jsonc");

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
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
    const before = await artifactHashes(root);
    const originalConfig = await readFile(configPath, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => {
          await writeFile(
            configPath,
            `${originalConfig}\n// changed while Wrangler was validating\n`,
            "utf8",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBe(1);

    expect(await artifactHashes(root)).toEqual(before);
    expect(errors.join("\n")).toMatch(/source|configuration|changed|stale/i);
  });

  test.each([
    "before-canonical-prepare",
    "after-canonical-prepare",
    "before-generation-publish",
    "after-generation-publish",
    "before-current-promotion",
    "after-current-promotion",
  ] as const)(
    "keeps a coherent canonical generation across CLI promotion interruption at %s",
    async (boundary) => {
      const root = await createRoot("eden-cli-build-publication-race-");

      await expect(
        runEdenCli(["init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);
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
      const before = await readArtifactGeneration(join(root, ".eden"));
      const beforeId = before.artifacts.buildMetadata.generationId;
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        (await readFile(join(root, "agent/tools/greet.ts"), "utf8"))
          .replace("Greet a person by name.", "Second generation."),
        "utf8",
      );

      const buildOptions = {
        cwd: root,
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
        buildPublicationHook: async (currentBoundary: string) => {
          if (currentBoundary === boundary) {
            throw new Error(`injected ${boundary} interruption`);
          }
        },
      } as unknown as Parameters<typeof runEdenCli>[1];

      await expect(
        runEdenCli(["build", "--project", root], buildOptions),
      ).resolves.toBe(1);

      const after = await readArtifactGeneration(join(root, ".eden"));
      const afterId = after.artifacts.buildMetadata.generationId;
      expect(afterId).toMatch(/^gen_[a-f0-9]{64}$/u);
      expect(after.artifacts.manifest.bundleDigest).toBe(
        createHash("sha256").update(after.artifacts.bundle).digest("hex"),
      );
      if (boundary !== "after-current-promotion") {
        expect(afterId).toBe(beforeId);
      } else {
        expect(afterId).not.toBe(beforeId);
      }
    },
  );

  test.each([
    "before-canonical-prepare",
    "after-canonical-prepare",
    "before-generation-publish",
    "after-generation-publish",
    "before-current-promotion",
    "after-current-promotion",
  ] as const)(
    "recovers an unavailable first publication after %s interruption",
    async (boundary) => {
      const root = await createRoot("eden-cli-build-first-publication-");
      await expect(
        runEdenCli(["init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);

      await expect(
        runEdenCli(["build", "--project", root], {
          cwd: root,
          dryRunRunner: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
          buildPublicationHook: async (currentBoundary: string) => {
            if (currentBoundary === boundary) {
              throw new Error(`injected ${boundary} interruption`);
            }
          },
        } as unknown as Parameters<typeof runEdenCli>[1]),
      ).resolves.toBe(1);

      if (boundary === "after-current-promotion") {
        await expect(
          readArtifactGeneration(join(root, ".eden")),
        ).resolves.toBeDefined();
      } else {
        await expect(
          readArtifactGeneration(join(root, ".eden")),
        ).rejects.toMatchObject({ name: "EdenCompilerError" });
      }

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
      await expect(
        readArtifactGeneration(join(root, ".eden")),
      ).resolves.toBeDefined();
    },
  );

  test("advertises exactly the supported command names and rejects unknown commands", async () => {
    expect(EDEN_CLI_COMMANDS).toEqual(["init", "dev", "build", "deploy"]);
    const errors: string[] = [];

    await expect(
      runEdenCli(["unknown"], {
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    expect(errors.join("")).toMatch(/unknown|init|dev|build|deploy/i);
  });
});

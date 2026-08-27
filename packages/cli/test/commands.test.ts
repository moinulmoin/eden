import {
  createHash,
} from "crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  readlink,
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
  basename,
  join,
} from "path";
import { fileURLToPath } from "url";
import { afterAll, describe, expect, test, vi } from "vitest";

import { readArtifactGeneration } from "@moinulmoin/eden-compiler";
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

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function initProvenanceDirectory(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  return join(
    canonicalRoot,
    `.eden-init-provenance-${sha256Text(canonicalRoot).slice(0, 16)}`,
  );
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
        runEdenCli(["agent", "init", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockContents);
    expect(errors.join("\n")).toMatch(/busy|identity|verif|lock/i);
    await expect(readdir(root)).resolves.toEqual([".eden-init.lock"]);
  });

  test.each(["directory", "fifo", "symlink"] as const)(
    "returns INIT_BUSY for a wrong-type init lock without opening it (%s)",
    async (kind) => {
      const root = await createRoot(`eden-cli-init-lock-${kind}-`);
      const lockPath = join(root, ".eden-init.lock");
      const outside = join(root, "outside-lock-target");
      if (kind === "directory") {
        await mkdir(lockPath);
      } else if (kind === "fifo") {
        execFileSync("mkfifo", [lockPath]);
      } else {
        await writeFile(outside, "outside lock bytes\n", "utf8");
        await symlink(outside, lockPath);
      }
      const errors: string[] = [];

      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          stderr: (line) => errors.push(line),
        }),
      ).resolves.toBe(1);

      const details = await lstat(lockPath);
      if (kind === "directory") {
        expect(details.isDirectory()).toBe(true);
      } else if (kind === "fifo") {
        expect(details.isFIFO()).toBe(true);
      } else {
        expect(details.isSymbolicLink()).toBe(true);
        await expect(readlink(lockPath)).resolves.toBe(outside);
      }
      expect(errors.join("\n")).toMatch(/busy|lock|type|symlink|preserved/i);
    },
  );

  test("initializes a valid scaffold without a secret file", async () => {
    const root = await createRoot("eden-cli-init-");
    const output: string[] = [];

    await expect(
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        stdout: (line) => output.push(line),
      }),
    ).resolves.toBe(0);

    await expect(stat(join(root, "agent/instructions.md"))).resolves.toBeDefined();
    await expect(stat(join(root, "agent/agent.ts"))).resolves.toBeDefined();
    await expect(stat(join(root, "agent/tools/greet.ts"))).resolves.toBeDefined();
    await expect(stat(join(root, "package.json"))).resolves.toBeDefined();
    await expect(stat(join(root, "pnpm-workspace.yaml"))).resolves.toBeDefined();
    await expect(readFile(join(root, "pnpm-workspace.yaml"), "utf8")).resolves.toBe(
      "allowBuilds:\n  esbuild: true\n  workerd: true\n",
    );
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
    ).toEqual(["agent", "package.json", "pnpm-workspace.yaml", "wrangler.jsonc"]);
    await expect(stat(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".dev.vars"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.join("")).toContain("Initialized");
  });

  test("keeps init recovery root-contained and never creates the external trust registry", async () => {
    const root = await createRoot("eden-cli-init-root-contained-");
    const canonicalRoot = await realpath(root);
    const externalTrustDescriptor = join(
      tmpdir(),
      ".eden-init-trust",
      `trust-${sha256Text(canonicalRoot)}.json`,
    );

    await expect(stat(externalTrustDescriptor)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);

    await expect(stat(externalTrustDescriptor)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(root)).some((entry) =>
        entry.startsWith(".eden-init-provenance-") ||
        entry === ".eden-init-trust"
      ),
    ).toBe(false);
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
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);

    expect(await sha256(unrelated)).toBe(before.unrelated);
    expect(await sha256(join(root, "agent.ts"))).toBe(before.candidate);
    await expect(stat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    expect(errors.join("")).toMatch(/empty|overwrite/i);
  });

  test("rejects precreated init provenance roots and keys without claiming them", async () => {
    for (const withKey of [false, true]) {
      const root = await createRoot(
        `eden-cli-init-precreated-provenance-${withKey ? "key" : "root"}-`,
      );
      const provenance = await initProvenanceDirectory(root);
      await mkdir(provenance);
      if (withKey) {
        await writeFile(join(provenance, "key"), Buffer.alloc(32));
      }
      const errors: string[] = [];

      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          stderr: (line) => errors.push(line),
        }),
      ).resolves.toBe(1);

      await expect(readdir(root)).resolves.toEqual([basename(provenance)]);
      expect(errors.join("\n")).toMatch(/pre-created|trust|provenance|ownership/i);
    }
  });

  test("blocks legacy provenance and malformed recovery state without mutation", async () => {
    const provenanceRoot = await createRoot("eden-cli-init-legacy-state-");
    const provenance = await initProvenanceDirectory(provenanceRoot);
    await mkdir(provenance);
    const transition = join(provenance, "transition-legacy.json");
    const transitionBytes = "legacy transition bytes\n";
    await writeFile(transition, transitionBytes, "utf8");
    const beforeEntries = await readdir(provenanceRoot);

    await expect(
      runEdenCli(["agent", "init", "--project", provenanceRoot], { cwd: provenanceRoot }),
    ).resolves.toBe(1);
    await expect(readdir(provenanceRoot)).resolves.toEqual(beforeEntries);
    await expect(readFile(transition, "utf8")).resolves.toBe(transitionBytes);

    const malformedRoot = await createRoot("eden-cli-init-malformed-state-");
    const statePath = join(malformedRoot, ".eden-init-incomplete.json");
    const stateBytes = "{\"kind\":\"legacy\"}\n";
    await writeFile(statePath, stateBytes, "utf8");
    const errors: string[] = [];
    await expect(
      runEdenCli(["agent", "init", "--project", malformedRoot], {
        cwd: malformedRoot,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    await expect(readFile(statePath, "utf8")).resolves.toBe(stateBytes);
    expect(errors.join("\n")).toMatch(/malformed|unsupported|preserved|busy/i);
  });

  test("recovers only missing canonical files and retains fresh-process residue", async () => {
    const root = await createRoot("eden-cli-init-monotonic-recovery-");
    await expect(
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);

    const statePath = join(root, ".eden-init-incomplete.json");
    const stateBytes = await readFile(statePath, "utf8");
    const state = JSON.parse(stateBytes) as { readonly stageName: string };
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);

    for (const relativePath of [
      "agent/instructions.md",
      "agent/agent.ts",
      "agent/tools/greet.ts",
      "package.json",
      "pnpm-workspace.yaml",
      "wrangler.jsonc",
    ]) {
      await expect(stat(join(root, relativePath))).resolves.toBeDefined();
    }
    await expect(readFile(statePath, "utf8")).resolves.toBe(stateBytes);
    await expect(stat(join(root, state.stageName))).resolves.toBeDefined();
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);

    const before = await Promise.all([
      readFile(join(root, "package.json"), "utf8"),
      readFile(join(root, "agent/agent.ts"), "utf8"),
      readFile(statePath, "utf8"),
    ]);
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      Promise.all([
        readFile(join(root, "package.json"), "utf8"),
        readFile(join(root, "agent/agent.ts"), "utf8"),
        readFile(statePath, "utf8"),
      ]),
    ).resolves.toEqual(before);
  });

  test("refuses ordinary non-empty re-init but accepts exact canonical files only through recovery", async () => {
    const root = await createRoot("eden-cli-init-reinit-");
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const unrelated = join(root, "notes.txt");
    await writeFile(unrelated, "keep this file\n", "utf8");
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(1);
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep this file\n");
    await expect(readFile(join(root, "package.json"), "utf8")).resolves.toContain(
      '"eden-basic-agent"',
    );
  });

  test("blocks build while a partial or ambiguous init residue remains", async () => {
    const root = await createRoot("eden-cli-init-partial-build-");
    await expect(
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);
    const errors: string[] = [];
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => {
          throw new Error("partial init must block before build");
        },
      }),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toMatch(/partial|init|busy|recovery/i);
  });

  test("retains every byte when recovery residue is missing, tampered, or a symlink", async () => {
    for (const mode of ["missing", "tampered", "symlink"] as const) {
      const root = await createRoot(`eden-cli-init-residue-${mode}-`);
      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          initPublicationHook: async (boundary) => {
            if (boundary === "after-state-write") {
              throw new Error("seed incomplete scaffold");
            }
          },
        }),
      ).resolves.toBe(1);
      const state = JSON.parse(
        await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
      ) as { readonly stageName: string };
      const residue = join(root, state.stageName, "agent/instructions.md");
      const beforeState = await readFile(
        join(root, ".eden-init-incomplete.json"),
        "utf8",
      );
      if (mode === "missing") {
        await rm(residue, { force: false });
      } else if (mode === "tampered") {
        await writeFile(residue, "tampered residue\n", "utf8");
      } else {
        await rm(residue, { force: false });
        await symlink(join(root, "outside.txt"), residue);
      }
      const errors: string[] = [];
      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          stderr: (line) => errors.push(line),
        }),
      ).resolves.toBe(1);
      await expect(
        readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
      ).resolves.toBe(beforeState);
      expect(errors.join("\n")).toMatch(/missing|changed|symlink|unsafe|preserved|busy/i);
    }
  });

  test("rejects closed-schema and complete-tree recovery residue without mutation", async () => {
    const root = await createRoot("eden-cli-init-closed-residue-");
    await expect(
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);

    const statePath = join(root, ".eden-init-incomplete.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    const withUnknownMetadata = `${JSON.stringify({
      ...state,
      unexpected: "metadata",
    })}\n`;
    await writeFile(statePath, withUnknownMetadata, "utf8");
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(1);
    await expect(readFile(statePath, "utf8")).resolves.toBe(withUnknownMetadata);

    const freshRoot = await createRoot("eden-cli-init-extra-stage-");
    await expect(
      runEdenCli(["agent", "init", "--project", freshRoot], {
        cwd: freshRoot,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);
    const freshState = JSON.parse(
      await readFile(join(freshRoot, ".eden-init-incomplete.json"), "utf8"),
    ) as { readonly stageName: string };
    const stagePath = join(freshRoot, freshState.stageName);
    const extraPath = join(stagePath, "agent/extra.ts");
    await writeFile(extraPath, "unexpected staged bytes\n", "utf8");
    const beforeEntries = await readdir(freshRoot);
    await expect(
      runEdenCli(["agent", "init", "--project", freshRoot], { cwd: freshRoot }),
    ).resolves.toBe(1);
    await expect(readdir(freshRoot)).resolves.toEqual(beforeEntries);
    await expect(readFile(extraPath, "utf8")).resolves.toBe(
      "unexpected staged bytes\n",
    );
  });

  test.each(["stage", "stage-parent", "canonical-parent"] as const)(
    "blocks a symlink swap in the %s recovery path before publication",
    async (kind) => {
      const root = await createRoot(`eden-cli-init-symlink-${kind}-`);
      const outside = await createRoot(`eden-cli-init-symlink-${kind}-outside-`);
      await writeFile(join(outside, "instructions.md"), "outside bytes\n", "utf8");
      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          initPublicationHook: async (boundary) => {
            if (boundary === "after-state-write") {
              throw new Error("seed incomplete scaffold");
            }
          },
        }),
      ).resolves.toBe(1);
      const state = JSON.parse(
        await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
      ) as { readonly stageName: string };
      const stagePath = join(root, state.stageName);
      if (kind === "stage") {
        await rm(stagePath, { recursive: true, force: false });
        await symlink(outside, stagePath, "dir");
      } else if (kind === "stage-parent") {
        await rm(join(stagePath, "agent"), { recursive: true, force: false });
        await symlink(outside, join(stagePath, "agent"), "dir");
      } else {
        await symlink(outside, join(root, "agent"), "dir");
      }
      const before = await readdir(root);
      await expect(
        runEdenCli(["agent", "init", "--project", root], { cwd: root }),
      ).resolves.toBe(1);
      await expect(readdir(root)).resolves.toEqual(before);
      await expect(readFile(join(outside, "instructions.md"), "utf8")).resolves.toBe(
        "outside bytes\n",
      );
    },
  );

  test.each(["stage", "canonical-parent"] as const)(
    "does not write outside root when a %s is swapped during publication",
    async (kind) => {
      const root = await createRoot(`eden-cli-init-race-${kind}-`);
      const outside = await createRoot(`eden-cli-init-race-${kind}-outside-`);
      await writeFile(join(outside, "instructions.md"), "outside bytes\n", "utf8");
      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          initPublicationHook: async (boundary) => {
            if (boundary === "after-state-write") {
              throw new Error("seed incomplete scaffold");
            }
          },
        }),
      ).resolves.toBe(1);
      const state = JSON.parse(
        await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
      ) as { readonly stageName: string };
      const stagePath = join(root, state.stageName);
      const errors: string[] = [];
      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          stderr: (line) => errors.push(line),
          initPublicationHook: async (boundary, target) => {
            if (
              kind === "stage" &&
              boundary === "before-init-destination-recheck" &&
              target === "agent/instructions.md"
            ) {
              const moved = `${stagePath}.moved`;
              await rename(stagePath, moved);
              await symlink(outside, stagePath, "dir");
            }
            if (
              kind === "canonical-parent" &&
              boundary === "before-init-link" &&
              target === "agent/instructions.md"
            ) {
              const moved = join(root, "agent-owned");
              await rename(join(root, "agent"), moved);
              await symlink(outside, join(root, "agent"), "dir");
            }
          },
        }),
      ).resolves.toBe(1);
      expect(errors.join("\n")).toMatch(/symlink|escape|outside|unsafe|busy/i);
      await expect(readFile(join(outside, "instructions.md"), "utf8")).resolves.toBe(
        "outside bytes\n",
      );
      const swapped = await lstat(
        kind === "stage" ? stagePath : join(root, "agent"),
      );
      expect(swapped.isSymbolicLink()).toBe(true);
    },
  );

  test("preserves a destination rename or replacement during monotonic recovery", async () => {
    const renamedRoot = await createRoot("eden-cli-init-rename-");
    await expect(
      runEdenCli(["agent", "init", "--project", renamedRoot], {
        cwd: renamedRoot,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);
    const renamedPath = join(renamedRoot, "package.renamed.json");
    await expect(
      runEdenCli(["agent", "init", "--project", renamedRoot], {
        cwd: renamedRoot,
        initPublicationHook: async (boundary, target) => {
          if (
            boundary === "after-init-link" &&
            target?.endsWith("package.json") === true
          ) {
            await rename(target, renamedPath);
          }
        },
      }),
    ).resolves.toBe(1);
    await expect(readFile(renamedPath, "utf8")).resolves.toContain(
      '"eden-basic-agent"',
    );
    await expect(stat(join(renamedRoot, "package.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const replacementRoot = await createRoot("eden-cli-init-replacement-");
    await expect(
      runEdenCli(["agent", "init", "--project", replacementRoot], {
        cwd: replacementRoot,
        initPublicationHook: async (boundary) => {
          if (boundary === "after-state-write") {
            throw new Error("seed incomplete scaffold");
          }
        },
      }),
    ).resolves.toBe(1);
    const replacement = "competing initializer bytes\n";
    await expect(
      runEdenCli(["agent", "init", "--project", replacementRoot], {
        cwd: replacementRoot,
        initPublicationHook: async (boundary, target) => {
          if (
            boundary === "after-target-validation" &&
            target === "package.json"
          ) {
            await writeFile(join(replacementRoot, "package.json"), replacement, {
              encoding: "utf8",
              flag: "wx",
            });
          }
        },
      }),
    ).resolves.toBe(1);
    await expect(readFile(join(replacementRoot, "package.json"), "utf8"))
      .resolves.toBe(replacement);
  });

  test.each([
    "after-state-write",
    "after-stage-write",
    "before-target-publish",
    "after-target-publish",
    "before-complete",
  ] as const)(
    "converges or remains explicitly blocked after %s interruption",
    async (interruption) => {
      const root = await createRoot("eden-cli-init-boundary-");
      const errors: string[] = [];
      await expect(
        runEdenCli(["agent", "init", "--project", root], {
          cwd: root,
          stderr: (line) => errors.push(line),
          initPublicationHook: async (boundary) => {
            if (boundary === interruption) {
              throw new Error(`injected ${interruption} interruption`);
            }
          },
        }),
      ).resolves.toBe(1);

      const statePath = join(root, ".eden-init-incomplete.json");
      if (interruption === "after-stage-write") {
        await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          runEdenCli(["agent", "init", "--project", root], {
            cwd: root,
            stderr: (line) => errors.push(line),
          }),
        ).resolves.toBe(1);
        expect(errors.join("\n")).toMatch(/busy|preserved|ambiguous|changed/i);
        return;
      }

      await expect(stat(statePath)).resolves.toBeDefined();
      const recovery = await runEdenCli(["agent", "init", "--project", root], { cwd: root });
      expect(recovery).toBe(0);
      for (const relativePath of [
        "agent/instructions.md",
        "agent/agent.ts",
        "agent/tools/greet.ts",
        "package.json",
        "pnpm-workspace.yaml",
        "wrangler.jsonc",
      ]) {
        await expect(stat(join(root, relativePath))).resolves.toBeDefined();
      }
      if (interruption === "before-complete") {
        await expect(
          runEdenCli(["agent", "build", "--project", root], {
            cwd: root,
            dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          }),
        ).resolves.toBe(0);
      }
    },
  );

  test("recovery contains no destructive pathname operation", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("async function recoverInitScaffold(");
    const end = source.indexOf("async function writeScaffoldUnlocked(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const recovery = source.slice(start, end);
    expect(recovery).not.toMatch(/\b(?:rename|rm|rmdir|unlink)\s*\(/u);
  });

  test("preserves a stale lock without matching recovery state", async () => {
    const root = await createRoot("eden-cli-init-stale-lock-");
    const lockContents = `${JSON.stringify({
      kind: "eden.init.lock",
      version: 1,
      pid: 99_999_999,
      startedAt: "stale-process-start",
      token: "stale-token",
    })}\n`;
    await writeFile(join(root, ".eden-init.lock"), lockContents, "utf8");
    const errors: string[] = [];

    await expect(
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    await expect(readFile(join(root, ".eden-init.lock"), "utf8"))
      .resolves.toBe(lockContents);
    expect(errors.join("\n")).toMatch(/stale|matching|state|preserved|busy/i);
  });

  test("does not promote an incomplete same-identity generation over the prior CURRENT", async () => {
    const root = await createRoot("eden-cli-same-identity-incomplete-");
    const sourcePath = join(root, "agent/tools/greet.ts");

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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

  test("fails closed and preserves a replacement lock during owned cleanup", async () => {
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
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary) => {
          if (boundary !== "before-init-cleanup") return;
          const observed = `${lockPath}.observed`;
          await rename(lockPath, observed);
          await writeFile(lockPath, replacement, {
            encoding: "utf8",
            flag: "wx",
          });
          await rm(observed, { force: true });
        },
      }),
    ).resolves.toBe(1);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(replacement);
    await expect(stat(join(root, "package.json"))).resolves.toBeDefined();
  });

  test("retains a replacement stage directory when recursive owned cleanup loses identity", async () => {
    const root = await createRoot("eden-cli-init-release-stage-race-");
    const outside = await createRoot("eden-cli-init-release-stage-outside-");
    const replacement = join(root, "replacement-stage");
    await expect(
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary, target) => {
          if (
            boundary !== "before-init-cleanup" ||
            target === undefined ||
            !target.startsWith(".eden-init-")
          ) {
            return;
          }
          const state = JSON.parse(
            await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
          ) as { readonly stageName: string };
          const stagePath = join(root, state.stageName);
          await rename(stagePath, replacement);
          await symlink(outside, stagePath, "dir");
        },
      }),
    ).resolves.toBe(1);

    const stage = await lstat(join(root, ".eden-init-incomplete.json"));
    expect(stage.isFile()).toBe(true);
    const state = JSON.parse(
      await readFile(join(root, ".eden-init-incomplete.json"), "utf8"),
    ) as { readonly stageName: string };
    const stagePath = join(root, state.stageName);
    const swapped = await lstat(stagePath);
    expect(swapped.isSymbolicLink()).toBe(true);
    await expect(stat(replacement)).resolves.toBeDefined();
  });

  test("retains a replacement after the final owned-cleanup observation", async () => {
    const root = await createRoot("eden-cli-init-release-final-observation-");
    const replacement = "replacement after final observation\n";
    let observedOriginal = false;
    await expect(
      runEdenCli(["agent", "init", "--project", root], {
        cwd: root,
        initPublicationHook: async (boundary, target) => {
          if (
            boundary !== "after-init-cleanup-observation" ||
            target !== ".eden-init.lock"
          ) {
            return;
          }
          const disposal = (await readdir(root)).find((entry) =>
            entry.startsWith(".eden-init-dispose-file-")
          );
          if (disposal === undefined) {
            throw new Error("owned cleanup disposal was not observable");
          }
          const observedPath = join(root, `${disposal}.observed`);
          await rename(join(root, disposal), observedPath);
          await writeFile(join(root, disposal), replacement, {
            encoding: "utf8",
            flag: "wx",
          });
          observedOriginal = true;
        },
      }),
    ).resolves.toBe(1);

    expect(observedOriginal).toBe(true);
    const disposal = (await readdir(root)).find((entry) =>
      entry.startsWith(".eden-init-dispose-file-")
    );
    expect(disposal).toBeDefined();
    await expect(readFile(join(root, disposal as string), "utf8")).resolves.toBe(
      replacement,
    );
    await expect(
      readFile(join(root, `${disposal as string}.observed`), "utf8"),
    ).resolves.toContain('"eden.init.lock"');
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
      runEdenCli(["agent", "init", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", link], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const originalConfig = await readFile(join(root, "wrangler.jsonc"), "utf8");
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const before = await artifactHashes(root);

    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
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
    const before = await artifactHashes(root);
    const originalSource = await readFile(sourcePath, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
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
    const before = await artifactHashes(root);
    const originalConfig = await readFile(configPath, "utf8");

    const errors: string[] = [];
    await expect(
      runEdenCli(["agent", "build", "--project", root], {
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
        runEdenCli(["agent", "init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);
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
        runEdenCli(["agent", "build", "--project", root], buildOptions),
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
        runEdenCli(["agent", "init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);

      await expect(
        runEdenCli(["agent", "build", "--project", root], {
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
        runEdenCli(["agent", "build", "--project", root], {
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
    expect(EDEN_CLI_COMMANDS).toEqual([
      "preflight",
      "deploy",
      "destroy",
      "agent",
    ]);
    const errors: string[] = [];

    await expect(
      runEdenCli(["unknown"], {
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    expect(errors.join("")).toMatch(/unknown|preflight|deploy|destroy|agent/i);
  });
});

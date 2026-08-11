import {
  createHash,
} from "crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
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
import { afterAll, describe, expect, test } from "vitest";

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
  const names = [
    "agent-bundle.mjs",
    "build-metadata.json",
    "diagnostics.json",
    "discovery.json",
    "manifest.json",
    "module-map.json",
  ] as const;
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await sha256(join(output, name))]),
    ),
  );
}

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("eden CLI project commands", () => {
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
    expect((await readdir(root)).sort()).toEqual([
      "agent",
      "package.json",
      "wrangler.jsonc",
    ]);
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

    const manifest = JSON.parse(
      await readFile(join(root, ".eden/manifest.json"), "utf8"),
    ) as { bundleDigest: string; tools: readonly { name: string }[] };
    const bundle = await readFile(join(root, ".eden/agent-bundle.mjs"), "utf8");
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

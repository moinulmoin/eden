import {
  createHash,
} from "crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "fs/promises";
import {
  createServer,
} from "net";
import {
  tmpdir,
} from "os";
import {
  join,
} from "path";

import { afterEach, describe, expect, test } from "vitest";

import {
  EDEN_LOCAL_HOST,
  EDEN_LOCAL_INSPECTOR_PORT,
  EDEN_LOCAL_PORT,
  runEdenCli,
  type EdenCliDryRunRequest,
  type EdenCliProcessRequest,
} from "../src/index.js";

const roots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function initRoot(root: string): Promise<void> {
  await expect(
    runEdenCli(["init", "--project", root], { cwd: root }),
  ).resolves.toBe(0);
}

async function artifactDigest(root: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(root, ".eden/agent-bundle.mjs")))
    .digest("hex");
}

async function waitForDigestChange(
  root: string,
  previous: string,
  timeoutMs = 2_000,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await artifactDigest(root);
    if (current !== previous) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return artifactDigest(root);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("eden dev and deploy orchestration", () => {
  test("builds before spawning only the approved local runtime and cleans the owned child", async () => {
    const root = await createRoot("eden-cli-dev-");
    await initRoot(root);
    const spawned: EdenCliProcessRequest[] = [];
    let terminated = false;
    const processRunner = {
      spawn(request: EdenCliProcessRequest) {
        spawned.push(request);
        return {
          pid: 41_001,
          exited: Promise.resolve({ exitCode: 0, signal: null }),
          async terminate() {
            terminated = true;
          },
        };
      },
    };

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner,
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).resolves.toBe(0);

    expect(spawned).toHaveLength(1);
    const args = spawned[0]?.args ?? [];
    const configIndex = args.indexOf("--config");
    expect(args.slice(0, configIndex + 2)).toEqual([
      "dev",
      "--local",
      "--ip",
      EDEN_LOCAL_HOST,
      "--port",
      String(EDEN_LOCAL_PORT),
      "--inspector-port",
      String(EDEN_LOCAL_INSPECTOR_PORT),
      "--inspector-ip",
      "127.0.0.1",
      "--config",
      args[configIndex + 1],
    ]);
    expect(spawned[0]?.cwd).toBe(await realpath(root));
    expect(spawned[0]?.env).toMatchObject({
      EDEN_HOST: EDEN_LOCAL_HOST,
      EDEN_PORT: String(EDEN_LOCAL_PORT),
      EDEN_INSPECTOR_PORT: String(EDEN_LOCAL_INSPECTOR_PORT),
    });
    expect(spawned[0]?.args).not.toContain("8787");
    expect(spawned[0]?.args).not.toContain("8800");
    expect(terminated).toBe(false);
  });

  test("does not spawn when the initial build fails", async () => {
    const root = await createRoot("eden-cli-dev-invalid-");
    await initRoot(root);
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
    const spawned: EdenCliProcessRequest[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner: {
          spawn(request: EdenCliProcessRequest) {
            spawned.push(request);
            return {
              pid: 41_002,
              exited: Promise.resolve({ exitCode: 0, signal: null }),
              async terminate() {},
            };
          },
        },
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => {
          throw new Error("dry run must not be reached");
        },
      }),
    ).resolves.toBe(1);

    expect(spawned).toHaveLength(0);
    expect(errors.join("\n")).toMatch(/MODULE_IMPORT_UNSUPPORTED|Node-only|Worker/i);
  });

  test("refuses an occupied approved port without touching its owner", async () => {
    const root = await createRoot("eden-cli-dev-occupied-");
    await initRoot(root);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(EDEN_LOCAL_PORT, EDEN_LOCAL_HOST, () => resolve());
    });
    try {
      const spawned: EdenCliProcessRequest[] = [];
      const errors: string[] = [];
      await expect(
        runEdenCli(["dev", "--project", root], {
          cwd: root,
          processRunner: {
            spawn(request: EdenCliProcessRequest) {
              spawned.push(request);
              return {
                pid: 41_003,
                exited: Promise.resolve({ exitCode: 0, signal: null }),
                async terminate() {},
              };
            },
          },
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
          }),
        }),
      ).resolves.toBe(1);
      expect(spawned).toHaveLength(0);
      expect(errors.join("\n")).toMatch(/8797|occupied|available/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("terminates the owned child when readiness fails", async () => {
    const root = await createRoot("eden-cli-dev-readiness-");
    await initRoot(root);
    let terminated = false;
    const errors: string[] = [];

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner: {
          spawn() {
            return {
              pid: 41_005,
              ready: new Promise<void>((_resolve, reject) => {
                queueMicrotask(() => reject(new Error("readiness fixture failed")));
              }),
              exited: Promise.resolve({ exitCode: 1, signal: null }),
              async terminate() {
                terminated = true;
              },
            };
          },
        },
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).resolves.toBe(1);

    expect(terminated).toBe(true);
    expect(errors.join("\n")).toMatch(/ready|readiness/i);
    await expect(readFile(join(root, ".eden-dev-state.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps the last coherent generation when a watch rebuild fails", async () => {
    const root = await createRoot("eden-cli-dev-watch-");
    await initRoot(root);
    const initialDigest = await (async () => {
      const result = await runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      });
      expect(result).toBe(0);
      return artifactDigest(root);
    })();

    let release: (() => void) | undefined;
    const exited = new Promise<{ readonly exitCode: number; readonly signal: null }>(
      (resolve) => {
        release = () => resolve({ exitCode: 0, signal: null });
      },
    );
    const dryRuns: EdenCliDryRunRequest[] = [];
    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn() {
          return {
            pid: 41_004,
            exited,
            async terminate() {
              release?.();
            },
          };
        },
      },
      dryRunRunner: async (request) => {
        dryRuns.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
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
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await artifactDigest(root)).toBe(initialDigest);

    await writeFile(
      join(root, "agent/tools/greet.ts"),
      `import type { EdenToolDefinition } from "@eden/definitions";
const greet: EdenToolDefinition<{ readonly name: string }, { readonly greeting: string }> = {
  description: "Greet a person by name.",
  inputSchema: {
    "~standard": {
      version: 1,
      vendor: "eden-scaffold",
      validate(value: unknown) {
        if (typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { readonly name?: unknown }).name === "string") {
          return { value: { name: (value as { readonly name: string }).name.trim() } };
        }
        return { issues: [{ message: "name must be a string." }] };
      },
    },
  },
  execute(input) {
    return { greeting: \`Hello, \${input.name}!\` };
  },
};
export default greet;
`,
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dryRuns.length).toBeGreaterThanOrEqual(1);
    expect(await waitForDigestChange(root, initialDigest)).not.toBe(initialDigest);
    release?.();
    await expect(devPromise).resolves.toBe(0);
  }, 10_000);

  test("distinguishes compatibility and Wrangler dry-run failures", async () => {
    const root = await createRoot("eden-cli-deploy-failures-");
    await initRoot(root);

    const compatibilityErrors: string[] = [];
    let compatibilityCalls = 0;
    await expect(
      runEdenCli(["deploy", "--project", root], {
        cwd: root,
        stderr: (line) => compatibilityErrors.push(line),
        dryRunRunner: async () => {
          compatibilityCalls += 1;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "compatibility fixture failed",
          };
        },
      }),
    ).resolves.toBe(1);
    expect(compatibilityCalls).toBe(1);
    expect(compatibilityErrors.join("\n")).toMatch(/compatibility|dry run/i);
    expect(compatibilityErrors.join("\n")).not.toMatch(/remote deployment succeeded/i);

    const wranglerErrors: string[] = [];
    const wranglerCalls: EdenCliDryRunRequest[] = [];
    let call = 0;
    await expect(
      runEdenCli(["deploy", "--project", root, "--env", "production"], {
        cwd: root,
        stderr: (line) => wranglerErrors.push(line),
        dryRunRunner: async (request) => {
          wranglerCalls.push(request);
          call += 1;
          return call === 1
            ? { exitCode: 0, stdout: "", stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "wrangler fixture failed" };
        },
      }),
    ).resolves.toBe(1);
    expect(wranglerCalls).toHaveLength(2);
    expect(wranglerCalls[1]?.args).toContain("production");
    expect(wranglerErrors.join("\n")).toMatch(/wrangler|dry run/i);
    expect(wranglerErrors.join("\n")).not.toMatch(/remote deployment succeeded/i);
  });
});

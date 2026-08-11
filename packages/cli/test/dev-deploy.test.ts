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
import { statSync } from "fs";
import {
  createServer,
} from "net";
import {
  tmpdir,
} from "os";
import {
  join,
} from "path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { readArtifactGeneration } from "@eden/compiler";
import {
  EDEN_LOCAL_HOST,
  EDEN_LOCAL_INSPECTOR_PORT,
  EDEN_LOCAL_PORT,
  runEdenCli,
  stopEdenDev,
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
    .update(
      (await readArtifactGeneration(join(root, ".eden"))).artifacts.bundle,
    )
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
  vi.unstubAllEnvs();
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
          startIdentity: "fixture-start",
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

  test("keeps the local bearer out of Wrangler argv and removes restricted dev vars", async () => {
    const root = await createRoot("eden-cli-dev-secret-");
    await initRoot(root);
    const secret = "local-secret-not-for-argv";
    vi.stubEnv("EDEN_BEARER_SECRET", secret);
    const spawned: EdenCliProcessRequest[] = [];
    let secretFileMode: number | undefined;
    let secretFilePath: string | undefined;

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner: {
          spawn(request: EdenCliProcessRequest) {
            spawned.push(request);
            const secretIndex = request.args.indexOf("--env-file");
            const secretPath = request.args[secretIndex + 1];
            secretFilePath = secretPath;
            secretFileMode = statSync(secretPath).mode & 0o777;
            return {
              pid: 41_006,
              startIdentity: "fixture-start",
              exited: Promise.resolve({ exitCode: 0, signal: null }),
              async terminate() {},
            };
          },
        },
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).resolves.toBe(0);

    expect(secretFileMode).toBe(0o600);
    expect(spawned[0]?.args.join(" ")).not.toContain(secret);
    expect(spawned[0]?.env?.EDEN_BEARER_SECRET).toBeUndefined();
    expect(secretFilePath).toBeDefined();
    await expect(readFile(secretFilePath as string, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed without signaling when the child start identity is unavailable", async () => {
    const root = await createRoot("eden-cli-dev-unverifiable-");
    await initRoot(root);
    let terminated = false;
    const errors: string[] = [];

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner: {
          spawn() {
            return {
              pid: 41_007,
              exited: Promise.resolve({ exitCode: 0, signal: null }),
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

    expect(terminated).toBe(false);
    expect(errors.join("\n")).toMatch(/identity|verif/i);
  });

  test("removes the local secret file when startup fails after creation", async () => {
    const root = await createRoot("eden-cli-dev-secret-failure-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "local-secret-startup-failure");
    let secretFilePath: string | undefined;

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner: {
          spawn(request: EdenCliProcessRequest) {
            const secretIndex = request.args.indexOf("--env-file");
            secretFilePath = request.args[secretIndex + 1];
            throw new Error("spawn fixture failed");
          },
        },
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).resolves.toBe(1);

    expect(secretFilePath).toBeDefined();
    await expect(readFile(secretFilePath as string, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes the local secret file during signal cleanup", async () => {
    const root = await createRoot("eden-cli-dev-secret-signal-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "local-secret-signal-cleanup");
    let secretFilePath: string | undefined;
    let release: ((exit: { readonly exitCode: number | null; readonly signal: null }) => void) | undefined;
    let ready: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const exited = new Promise<{ readonly exitCode: number | null; readonly signal: null }>(
      (resolve) => {
        release = resolve;
      },
    );

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn(request: EdenCliProcessRequest) {
          const secretIndex = request.args.indexOf("--env-file");
          secretFilePath = request.args[secretIndex + 1];
          return {
            pid: 41_009,
            startIdentity: "fixture-start",
            exited,
            async terminate() {
              release?.({ exitCode: 0, signal: null });
            },
          };
        },
      },
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      stdout: (line) => {
        if (line.includes("Eden dev ready")) ready?.();
      },
    });
    await readyPromise;
    process.emit("SIGTERM");
    await expect(devPromise).resolves.toBe(0);
    expect(secretFilePath).toBeDefined();
    await expect(readFile(secretFilePath as string, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not signal a dev PID when the persisted start identity is missing", async () => {
    const root = await createRoot("eden-cli-dev-state-missing-");
    await writeFile(
      join(root, ".eden-dev-state.json"),
      JSON.stringify({
        pid: 41_008,
        workerHost: EDEN_LOCAL_HOST,
        workerPort: EDEN_LOCAL_PORT,
        inspectorHost: EDEN_LOCAL_HOST,
        inspectorPort: EDEN_LOCAL_INSPECTOR_PORT,
      }),
      "utf8",
    );
    const kill = vi.spyOn(process, "kill");
    try {
      await expect(
        stopEdenDev({ cwd: root, projectRoot: root }),
      ).rejects.toMatchObject({ code: "DEV_STATE_INVALID" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  test("does not signal a dev PID when the persisted start identity is stale", async () => {
    const root = await createRoot("eden-cli-dev-state-stale-");
    await writeFile(
      join(root, ".eden-dev-state.json"),
      JSON.stringify({
        pid: 41_010,
        startedAt: "stale-process-start",
        workerHost: EDEN_LOCAL_HOST,
        workerPort: EDEN_LOCAL_PORT,
        inspectorHost: EDEN_LOCAL_HOST,
        inspectorPort: EDEN_LOCAL_INSPECTOR_PORT,
      }),
      "utf8",
    );
    const kill = vi.spyOn(process, "kill");
    try {
      await expect(
        stopEdenDev({ cwd: root, projectRoot: root }),
      ).resolves.toBe(0);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
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
              startIdentity: "fixture-start",
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
                startIdentity: "fixture-start",
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
              startIdentity: "fixture-start",
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
            startIdentity: "fixture-start",
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

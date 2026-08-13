import {
  createHash,
} from "crypto";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "fs/promises";
import { statSync } from "fs";
import { execFile, spawn } from "node:child_process";
import {
  randomUUID,
} from "node:crypto";
import {
  createServer,
} from "net";
import {
  tmpdir,
} from "os";
import {
  join,
} from "path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { readArtifactGeneration } from "@eden/compiler";
import {
  EDEN_LOCAL_HOST,
  EDEN_LOCAL_INSPECTOR_PORT,
  EDEN_LOCAL_PORT,
  runEdenCli,
  stopEdenDev,
  type EdenCliDryRunRequest,
  type EdenCliProcess,
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

async function generationFromRequestForDevTest(
  root: string,
  request: EdenCliProcessRequest,
): Promise<Record<string, unknown>> {
  const configIndex = request.args.indexOf("--config");
  const configPath = request.args[configIndex + 1];
  if (configPath === undefined) throw new Error("missing dev config path");
  const config = await readFile(configPath, "utf8");
  const main = /"main"\s*:\s*"([^"]+)"/u.exec(config)?.[1];
  if (main === undefined) throw new Error("missing dev runtime entry");
  const entry = await readFile(join(root, main), "utf8");
  const marker = "configureEdenArtifact(agentArtifact, ";
  const start = entry.indexOf(marker);
  const end = entry.indexOf(");\nexport", start + marker.length);
  if (start < 0 || end < 0) throw new Error("missing dev generation marker");
  return JSON.parse(
    entry.slice(start + marker.length, end),
  ) as Record<string, unknown>;
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
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  vi.stubEnv("EDEN_BEARER_SECRET", "dev-test-secret");
});


describe("eden dev and deploy orchestration", () => {
  test("authenticates the exact initial generation before state and readiness publication", async () => {
    const root = await createRoot("eden-cli-dev-initial-info-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "initial-info-secret");
    const statePath = join(root, ".eden-dev-state.json");
    const observations: string[] = [];
    let servedGeneration: Record<string, unknown> | undefined;
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let releaseExit: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        observations.push(
          `fetch:${String(input)}:${headers.get("authorization") ?? ""}`,
        );
        if (servedGeneration === undefined) {
          return new Response("not ready", { status: 503 });
        }
        const statePublished = await access(statePath)
          .then(() => true)
          .catch(() => false);
        observations.push(`state:${statePublished ? "present" : "absent"}`);
        return new Response(JSON.stringify({ generation: servedGeneration }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn(request: EdenCliProcessRequest) {
          void generationFromRequestForDevTest(root, request).then((generation) => {
            servedGeneration = generation;
            resolveReady?.();
          });
          return {
            pid: 41_017,
            startIdentity: "initial-info-runtime",
            ready,
            exited,
            async terminate() {
              releaseExit?.();
            },
          };
        },
      },
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    });

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (
          observations.some((value) => value === "state:absent") &&
          observations.some((value) => value.startsWith("fetch:"))
        ) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    expect(observations).toContain(
      "fetch:http://127.0.0.1:8797/eden/v1/info:Bearer initial-info-secret",
    );
    expect(observations).toContain("state:absent");

    process.emit("SIGINT");
    await expect(devPromise).resolves.toBe(0);
  });

  test("fails closed and cleans the child when the initial runtime exposes a wrong generation", async () => {
    const root = await createRoot("eden-cli-dev-initial-wrong-generation-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "initial-wrong-generation-secret");
    const errors: string[] = [];
    const signals: NodeJS.Signals[] = [];
    let releaseExit: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            generation: {
              generationId: "gen_wrong_initial_generation",
              bundleDigest: "wrong-bundle",
              manifestVersion: "wrong-manifest",
              runtimeVersion: "wrong-runtime",
              agentBundleVersion: "wrong-agent",
              protocolVersion: "wrong-protocol",
              schemaVersion: 999,
              toolNames: ["wrong-tool"],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        runtimeReadinessTimeoutMs: 100,
        stderr: (line) => errors.push(line),
        processRunner: {
          spawn() {
            return {
              pid: 41_018,
              startIdentity: "initial-wrong-generation-runtime",
              ready: Promise.resolve(),
              exited,
              async terminate(signal?: NodeJS.Signals) {
                if (signal !== undefined) signals.push(signal);
                releaseExit?.();
              },
            };
          },
        },
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).resolves.toBe(1);

    expect(signals).toContain("SIGTERM");
    expect(errors.join("\n")).toMatch(/generation|ready|reload/i);
    await expect(readFile(join(root, ".eden-dev-state.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readdir(root).then((entries) =>
        entries.filter((entry) =>
          entry.includes("eden-dev-worker") ||
          entry.includes("eden-dev-config"),
        ),
      ),
    ).resolves.toEqual([]);
  });

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

  test("fails closed before local readiness when no bearer can authenticate generation verification", async () => {
    const root = await createRoot("eden-cli-dev-missing-bearer-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "");
    const errors: string[] = [];
    let spawned = false;

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        processRunner: {
          spawn() {
            spawned = true;
            return {
              pid: 41_016,
              startIdentity: "fixture-missing-bearer",
              ready: Promise.resolve(),
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
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/bearer|authenticat|generation/i);
    expect(spawned).toBe(false);
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
    let receivedSignal: NodeJS.Signals | undefined;
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
            async terminate(signal?: NodeJS.Signals) {
              receivedSignal = signal;
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
    expect(receivedSignal).toBe("SIGTERM");
    expect(secretFilePath).toBeDefined();
    await expect(readFile(secretFilePath as string, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("installs startup cleanup before spawning and awaiting readiness", async () => {
    const root = await createRoot("eden-cli-dev-startup-signal-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "local-secret-startup-signal");
    let secretFilePath: string | undefined;
    let terminated = false;
    let receivedSignal: NodeJS.Signals | undefined;
    let releaseReady: (() => void) | undefined;
    let releaseExit: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const exited = new Promise<{ readonly exitCode: number; readonly signal: null }>(
      (resolve) => {
        releaseExit = () => resolve({ exitCode: 0, signal: null });
      },
    );
    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn(request: EdenCliProcessRequest) {
          const secretIndex = request.args.indexOf("--env-file");
          secretFilePath = request.args[secretIndex + 1];
          const startIdentity = new Promise<string>((resolve) => {
            queueMicrotask(() => resolve("fixture-startup-signal"));
          });
          process.emit("SIGTERM");
          return {
            pid: 41_011,
            startIdentity,
            ready,
            exited,
            async terminate(signal?: NodeJS.Signals) {
              terminated = true;
              receivedSignal = signal;
              releaseReady?.();
              releaseExit?.();
            },
          };
        },
      },
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    });

    await expect(devPromise).resolves.toBe(0);
    expect(terminated).toBe(true);
    expect(receivedSignal).toBe("SIGTERM");
    expect(secretFilePath).toBeDefined();
    await expect(readFile(secretFilePath as string, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cancels a hung initial compatibility child before dev cleanup settles", async () => {
    const root = await createRoot("eden-cli-dev-initial-dry-run-signal-");
    await initRoot(root);
    let releaseResult: (() => void) | undefined;
    let terminateSignal: NodeJS.Signals | undefined;
    let dryRunStarted: (() => void) | undefined;
    const dryRunStartedPromise = new Promise<void>((resolve) => {
      dryRunStarted = resolve;
    });
    const result = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseResult = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const dryRunProcess = {
      pid: 41_012,
      startIdentity: "fixture-initial-dry-run",
      exited: result.then(() => ({ exitCode: 0, signal: null })),
      async terminate(signal?: NodeJS.Signals) {
        terminateSignal = signal;
        releaseResult?.();
      },
    };
    const dryRun = { process: dryRunProcess, result };
    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      dryRunRunner: () => {
        dryRunStarted?.();
        return dryRun as never;
      },
    });

    await dryRunStartedPromise;
    process.emit("SIGTERM");
    await expect(
      Promise.race([
        devPromise,
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(-1), 2_000);
        }),
      ]),
    ).resolves.toBe(0);
    expect(terminateSignal).toBe("SIGTERM");
  });

  test("cancels a hung watch compatibility child and the runtime child together", async () => {
    const root = await createRoot("eden-cli-dev-watch-dry-run-signal-");
    await initRoot(root);
    let dryRunCount = 0;
    let watchDryRunStarted: (() => void) | undefined;
    const watchDryRunStartedPromise = new Promise<void>((resolve) => {
      watchDryRunStarted = resolve;
    });
    let releaseWatchResult: (() => void) | undefined;
    let watchTerminateSignal: NodeJS.Signals | undefined;
    let runtimeTerminateSignal: NodeJS.Signals | undefined;
    let releaseRuntime: (() => void) | undefined;
    const runtimeExited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseRuntime = () => resolve({ exitCode: 0, signal: null });
    });
    const watchResult = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseWatchResult = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const watchDryRunProcess = {
      pid: 41_013,
      startIdentity: "fixture-watch-dry-run",
      exited: watchResult.then(() => ({ exitCode: 0, signal: null })),
      async terminate(signal?: NodeJS.Signals) {
        watchTerminateSignal = signal;
        releaseWatchResult?.();
      },
    };
    const watchDryRun = {
      process: watchDryRunProcess,
      result: watchResult,
    };
    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn() {
          return {
            pid: 41_014,
            startIdentity: "fixture-runtime",
            ready: Promise.resolve(),
            exited: runtimeExited,
            async terminate(signal?: NodeJS.Signals) {
              runtimeTerminateSignal = signal;
              releaseRuntime?.();
            },
          };
        },
      },
      dryRunRunner: () => {
        dryRunCount += 1;
        if (dryRunCount === 1) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        watchDryRunStarted?.();
        return watchDryRun as never;
      },
      stdout: (line) => {
        if (line.includes("Eden dev ready")) {
          void writeFile(
            join(root, "agent/tools/greet.ts"),
            `export default {
  description: "watch signal fixture",
  inputSchema: {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate(value: unknown) {
        return { value };
      },
    },
  },
  execute() {
    return { greeting: "watch signal fixture" };
  },
};
`,
            "utf8",
          );
        }
      },
    });

    await watchDryRunStartedPromise;
    process.emit("SIGINT");
    await expect(
      Promise.race([
        devPromise,
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(-1), 2_000);
        }),
      ]),
    ).resolves.toBe(0);
    expect(watchTerminateSignal).toBe("SIGINT");
    expect(runtimeTerminateSignal).toBe("SIGINT");
  }, 10_000);

  test("keeps a replacement ownership marker with a different token", async () => {
    const root = await createRoot("eden-cli-dev-state-token-");
    await initRoot(root);
    const statePath = join(root, ".eden-dev-state.json");
    let observedToken: unknown;
    let release: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      release = () => resolve({ exitCode: 0, signal: null });
    });

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn() {
          return {
            pid: 41_015,
            startIdentity: "fixture-token-owner",
            ready: Promise.resolve(),
            exited,
            async terminate() {
              const current = JSON.parse(
                await readFile(statePath, "utf8"),
              ) as { readonly token?: unknown };
              observedToken = current.token;
              await writeFile(
                statePath,
                JSON.stringify({
                  pid: 41_015,
                  startedAt: "fixture-token-owner",
                  token: "replacement-token",
                  workerHost: EDEN_LOCAL_HOST,
                  workerPort: EDEN_LOCAL_PORT,
                  inspectorHost: EDEN_LOCAL_HOST,
                  inspectorPort: EDEN_LOCAL_INSPECTOR_PORT,
                }),
                "utf8",
              );
              release?.();
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
        if (line.includes("Eden dev ready")) process.emit("SIGTERM");
      },
    });

    await expect(devPromise).resolves.toBe(0);
    expect(observedToken).toEqual(expect.any(String));
    await expect(readFile(statePath, "utf8")).resolves.toContain(
      "replacement-token",
    );
  });

  test("stops startup before spawning when a signal arrives during the initial build", async () => {
    const root = await createRoot("eden-cli-dev-build-signal-");
    await initRoot(root);
    let spawned = false;

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner: {
          spawn() {
            spawned = true;
            throw new Error("startup signal should prevent spawn");
          },
        },
        dryRunRunner: async () => {
          process.emit("SIGINT");
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      }),
    ).resolves.toBe(0);

    expect(spawned).toBe(false);
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

  test("revalidates the owned identity before SIGTERM and SIGKILL escalation", async () => {
    const root = await createRoot("eden-cli-dev-stop-escalation-");
    const marker = `eden-stop-test-${randomUUID()}`;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      {
        argv0: marker,
        detached: true,
        stdio: "ignore",
      },
    );
    const childPid = child.pid;
    expect(childPid).toBeGreaterThan(0);
    let identity: string | undefined;
    for (let attempt = 0; attempt < 50 && identity === undefined; attempt += 1) {
      identity = await new Promise<string | undefined>((resolve) => {
        execFile(
          "ps",
          ["-p", String(childPid), "-o", "command="],
          { encoding: "utf8" },
          (error, stdout) => {
            if (error !== null) {
              resolve(undefined);
              return;
            }
            const value = String(stdout).trim().split(/\s+/u)[0] ?? "";
            resolve(value.length === 0 ? undefined : value);
          },
        );
      });
      if (identity === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(identity).toContain(marker);
    await writeFile(
      join(root, ".eden-dev-state.json"),
      JSON.stringify({
        pid: childPid,
        startedAt: identity,
        token: "owned-stop-token",
        workerHost: EDEN_LOCAL_HOST,
        workerPort: EDEN_LOCAL_PORT,
        inspectorHost: EDEN_LOCAL_HOST,
        inspectorPort: EDEN_LOCAL_INSPECTOR_PORT,
      }),
      "utf8",
    );

    try {
      await expect(
        stopEdenDev({ cwd: root, projectRoot: root }),
      ).resolves.toBe(0);
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }, 15_000);

  test("escalates a stubborn ordinary dev child after SIGTERM does not prove exit", async () => {
    const root = await createRoot("eden-cli-dev-stubborn-child-");
    await initRoot(root);
    const stopController = new AbortController();
    const signals: NodeJS.Signals[] = [];
    let spawned = false;
    const processHandle: EdenCliProcess = {
      pid: 41_011,
      startIdentity: "stubborn-ordinary-dev-child",
      ready: Promise.resolve(),
      exited: new Promise(() => {}),
      async terminate(signal?: NodeJS.Signals) {
        if (signal !== undefined) signals.push(signal);
      },
    };

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner: {
        spawn: () => {
          spawned = true;
          return processHandle;
        },
      },
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    });

    await vi.waitFor(() => {
      expect(spawned).toBe(true);
    }, { timeout: 3_000 });
    stopController.abort();
    await expect(
      Promise.race([
        devPromise,
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(-1), 8_000);
        }),
      ]),
    ).resolves.toBe(0);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }, 12_000);

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

    await vi.waitFor(() => {
      expect(terminated).toBe(true);
    });
    expect(errors.join("\n")).toMatch(/ready|readiness/i);
    await expect(readFile(join(root, ".eden-dev-state.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps the last coherent generation when a watch rebuild fails", async () => {
    const root = await createRoot("eden-cli-dev-watch-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-last-good-secret");
    let servedGeneration: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        servedGeneration === undefined
          ? new Response("not ready", { status: 503 })
          : new Response(JSON.stringify({ generation: servedGeneration }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
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

    const spawned: EdenCliProcessRequest[] = [];
    const releases: Array<() => void> = [];
    const dryRuns: EdenCliDryRunRequest[] = [];
    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn(request: EdenCliProcessRequest) {
          spawned.push(request);
          let release: (() => void) | undefined;
          const exited = new Promise<{
            readonly exitCode: number;
            readonly signal: null;
          }>((resolve) => {
            release = () => resolve({ exitCode: 0, signal: null });
          });
          releases.push(() => release?.());
          const generationReady = generationFromRequestForDevTest(
            root,
            request,
          ).then((generation) => {
            servedGeneration = generation;
          });
          return {
            pid: 41_004 + spawned.length,
            startIdentity: "fixture-start",
            ready: generationReady,
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

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (spawned.length > 0) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    const initialRuntimeConfigPath = spawned[0]?.args[
      (spawned[0]?.args.indexOf("--config") ?? -1) + 1
    ];
    const initialRuntimeConfig = await readFile(
      initialRuntimeConfigPath as string,
      "utf8",
    );
    const initialRuntimeEntryPath = join(
      root,
      /"main"\s*:\s*"([^"]+)"/u.exec(initialRuntimeConfig)?.[1] as string,
    );
    const initialRuntimeEntry = await readFile(initialRuntimeEntryPath, "utf8");
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
    await expect(readFile(initialRuntimeConfigPath as string, "utf8")).resolves.toBe(
      initialRuntimeConfig,
    );
    await expect(readFile(initialRuntimeEntryPath, "utf8")).resolves.toBe(
      initialRuntimeEntry,
    );

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
    releases.forEach((release) => release());
    await expect(devPromise).resolves.toBe(0);
  }, 10_000);

  test("updates the running Wrangler runtime when a watch generation succeeds", async () => {
    const root = await createRoot("eden-cli-dev-watch-runtime-swap-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-runtime-swap-secret");
    let servedGeneration: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        servedGeneration === undefined
          ? new Response("not ready", { status: 503 })
          : new Response(JSON.stringify({ generation: servedGeneration }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    const spawned: EdenCliProcessRequest[] = [];
    const releases: Array<() => void> = [];
    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let resolveRuntimeChange:
      | ((observation: { readonly config: string; readonly entry: string }) => void)
      | undefined;
    const runtimeChanged = new Promise<{
      readonly config: string;
      readonly entry: string;
    }>((resolve) => {
      resolveRuntimeChange = resolve;
    });
    let baselineConfig: string | undefined;
    let baselineEntry: string | undefined;
    const pollers = new Set<NodeJS.Timeout>();

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      processRunner: {
        spawn(request: EdenCliProcessRequest) {
          spawned.push(request);
          const configIndex = request.args.indexOf("--config");
          const configPath = request.args[configIndex + 1] as string;
          const poller = setInterval(() => {
            void (async () => {
              const config = await readFile(configPath, "utf8").catch(() => undefined);
              if (config === undefined) return;
              const main = /"main"\s*:\s*"([^"]+)"/u.exec(config)?.[1];
              if (main === undefined) return;
              const entry = await readFile(join(root, main), "utf8").catch(
                () => undefined,
              );
              if (entry === undefined) return;
              if (baselineConfig === undefined || baselineEntry === undefined) {
                baselineConfig = config;
                baselineEntry = entry;
                return;
              }
              if (config !== baselineConfig || entry !== baselineEntry) {
                clearInterval(poller);
                pollers.delete(poller);
                resolveRuntimeChange?.({ config, entry });
              }
            })();
          }, 20);
          pollers.add(poller);
          const generationReady = generationFromRequestForDevTest(
            root,
            request,
          ).then((generation) => {
            servedGeneration = generation;
          });
          const exited = new Promise<{
            readonly exitCode: number;
            readonly signal: null;
          }>((resolve) => {
            releases.push(() => resolve({ exitCode: 0, signal: null }));
          });
          return {
            pid: 42_101 + spawned.length,
            startIdentity: `fixture-runtime-${spawned.length}`,
            ready: generationReady,
            exited,
            async terminate() {
              releases.splice(0).forEach((release) => release());
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
        if (line.includes("Eden dev ready")) resolveReady?.();
      },
    });

    try {
      await readyPromise;
      const initialDigest = await artifactDigest(root);
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        `import type { EdenToolDefinition } from "@eden/definitions";
const greet: EdenToolDefinition<{ readonly name: string }, { readonly greeting: string }> = {
  description: "Updated watch greeting.",
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
    return { greeting: \`Updated hello, \${input.name}!\` };
  },
};
export default greet;
`,
        "utf8",
      );

      const observed = await Promise.race([
        runtimeChanged,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000)),
      ]);
      expect(observed).toBeDefined();
      expect(await artifactDigest(root)).not.toBe(initialDigest);
      expect(spawned.length).toBeGreaterThan(0);
    } finally {
      pollers.forEach((poller) => clearInterval(poller));
      releases.splice(0).forEach((release) => release());
      await expect(devPromise).resolves.toBe(0);
    }
  }, 10_000);

  test("keeps the previous runtime files when runtime replacement fails", async () => {
    const root = await createRoot("eden-cli-dev-watch-runtime-fallback-");
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-runtime-fallback-secret");
    let servedGeneration: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        servedGeneration === undefined
          ? new Response("not ready", { status: 503 })
          : new Response(JSON.stringify({ generation: servedGeneration }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
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
    const errors: string[] = [];
    let resolveSwapAttempt: ((value: true) => void) | undefined;
    const swapAttempted = new Promise<true>((resolve) => {
      resolveSwapAttempt = resolve;
    });
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const releases: Array<() => void> = [];
    let configPath: string | undefined;
    let entryPath: string | undefined;

    const devOptions = {
      cwd: root,
      processRunner: {
        spawn(request: EdenCliProcessRequest) {
          const configIndex = request.args.indexOf("--config");
          if (configPath === undefined) {
            configPath = request.args[configIndex + 1] as string;
          }
          const generationReady = generationFromRequestForDevTest(
            root,
            request,
          ).then((generation) => {
            servedGeneration = generation;
          });
          let release: (() => void) | undefined;
          const exited = new Promise<{
            readonly exitCode: number;
            readonly signal: null;
          }>((resolve) => {
            release = () => resolve({ exitCode: 0, signal: null });
          });
          releases.push(() => release?.());
          return {
            pid: 42_102,
            startIdentity: "fixture-runtime-fallback",
            ready: generationReady,
            exited,
            async terminate() {
              release?.();
            },
          };
        },
      },
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      stderr: (line: string) => errors.push(line),
      stdout: (line: string) => {
        if (line.includes("Eden dev ready")) resolveReady?.();
      },
      runtimePublicationHook: async (boundary: string) => {
        if (boundary !== "after-runtime-ready") return;
        resolveSwapAttempt?.(true);
        throw new Error("replacement startup fixture failed");
      },
    } as Parameters<typeof runEdenCli>[1];

    const devPromise = runEdenCli(["dev", "--project", root], devOptions);
    try {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (configPath !== undefined) {
            resolve();
            return;
          }
          setTimeout(check, 10);
        };
        check();
      });
      const configBefore = await readFile(configPath as string, "utf8");
      const main = /"main"\s*:\s*"([^"]+)"/u.exec(configBefore)?.[1];
      expect(main).toBeDefined();
      entryPath = join(root, main as string);
      const entryBefore = await readFile(entryPath, "utf8");

      await ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        `import type { EdenToolDefinition } from "@eden/definitions";
const greet: EdenToolDefinition<{ readonly name: string }, { readonly greeting: string }> = {
  description: "Updated watch greeting before a failed replacement.",
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
    return { greeting: \`Replacement hello, \${input.name}!\` };
  },
};
export default greet;
`,
        "utf8",
      );
      const attempted = await Promise.race([
        swapAttempted,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000)),
      ]);
      expect(attempted).toBeDefined();
      await vi.waitFor(
        () => {
          expect(errors.join("\n")).toMatch(/watch rebuild unavailable|replacement/i);
        },
        { timeout: 3_000 },
      );

      await expect(readFile(configPath as string, "utf8")).resolves.toBe(
        configBefore,
      );
      await expect(readFile(entryPath, "utf8")).resolves.toBe(entryBefore);
    } finally {
      releases.forEach((release) => release());
      await expect(devPromise).resolves.toBe(0);
      const temporaryRuntimeFiles = (await readdir(root)).filter((name) =>
        name.includes("eden-dev-worker") || name.includes("eden-dev-config"),
      );
      expect(temporaryRuntimeFiles).toEqual([]);
    }
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

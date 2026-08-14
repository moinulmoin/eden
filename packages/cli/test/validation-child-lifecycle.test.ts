import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildProject } from "@eden/compiler";
import {
  runEdenCli,
  type EdenCliDryRunHandle,
  type EdenCliDryRunResult,
  type EdenCliProcess,
  type EdenCliProcessRequest,
} from "../src/index.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-validation-child-"));
  roots.push(root);
  return root;
}

async function initRoot(root: string): Promise<void> {
  await expect(
    runEdenCli(["init", "--project", root], { cwd: root }),
  ).resolves.toBe(0);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  vi.stubEnv("EDEN_BEARER_SECRET", "validation-test-secret");
});

describe("CLI validation child lifecycle", () => {
  test("uses the direct Wrangler Node entrypoint for owned runtime children", async () => {
    const root = await createRoot();
    await initRoot(root);
    let request: EdenCliProcessRequest | undefined;

    await expect(
      runEdenCli(["dev", "--project", root], {
        cwd: root,
        processRunner: {
          spawn(nextRequest) {
            request = nextRequest;
            return {
              pid: 44_000,
              startIdentity: "direct-wrangler-entrypoint",
              ready: Promise.resolve(),
              exited: Promise.resolve({ exitCode: 0, signal: null }),
              async terminate() {},
            };
          },
        },
        runtimeGenerationProof: async () => true,
        dryRunRunner: () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).resolves.toBe(0);

    expect(request?.command).toBe(process.execPath);
    expect(request?.commandArgs?.[0]).toMatch(
      /wrangler(?:[/\\])wrangler-dist[/\\]cli\.js$/u,
    );
  });

  test("treats a stop-triggered build validation exit as clean cancellation", async () => {
    const root = await createRoot();
    await initRoot(root);
    const errors: string[] = [];
    let release: ((result: EdenCliDryRunResult) => void) | undefined;
    let terminatedWith: NodeJS.Signals | undefined;
    const result = new Promise<EdenCliDryRunResult>((resolve) => {
      release = resolve;
    });
    const processHandle: EdenCliProcess = {
      pid: 44_001,
      startIdentity: "validation-build-cancel",
      exited: result.then(() => ({ exitCode: 1, signal: "SIGINT" })),
      async terminate(signal?: NodeJS.Signals) {
        terminatedWith = signal;
        release?.({
          exitCode: 1,
          stdout: "",
          stderr: "",
        });
      },
    };

    const noOpSignalListener = (): void => undefined;
    process.once("SIGINT", noOpSignalListener);
    try {
      const buildPromise = runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: () => {
          queueMicrotask(() => process.emit("SIGINT"));
          return {
            process: processHandle,
            result,
          };
        },
      });
      await expect(buildPromise).resolves.toBe(0);
    } finally {
      process.removeListener("SIGINT", noOpSignalListener);
      release?.({
        exitCode: 1,
        stdout: "",
        stderr: "",
      });
    }

    expect(terminatedWith).toBe("SIGINT");
    expect(errors.join("\n")).not.toMatch(/compatibility validation failed/i);
  });

  test("rejects promise-returned cancellable handles instead of registering after await", async () => {
    const root = await createRoot();
    await initRoot(root);
    const errors: string[] = [];
    let release: ((result: EdenCliDryRunResult) => void) | undefined;
    const result = new Promise<EdenCliDryRunResult>((resolve) => {
      release = resolve;
    });
    const processHandle: EdenCliProcess = {
      pid: 44_002,
      startIdentity: "late-validation-handle",
      exited: result.then(() => ({ exitCode: 0, signal: null })),
      async terminate() {
        release?.({
          exitCode: 0,
          stdout: "",
          stderr: "",
        });
      },
    };

    const buildPromise = runEdenCli(["build", "--project", root], {
      cwd: root,
      stderr: (line) => errors.push(line),
      dryRunRunner: async () =>
        ({
          process: processHandle,
          result,
        }) as never,
    });
    const observed = await Promise.race([
      buildPromise,
      new Promise<number>((resolve) => {
        setTimeout(() => resolve(-1), 500);
      }),
    ]);
    release?.({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await buildPromise;

    expect(observed).toBe(1);
    expect(errors.join("\n")).toMatch(/unsupported|synchronous|handle/i);
  });

  test("races a never-settling compatibility result with cancellation", async () => {
    const root = await createRoot();
    await initRoot(root);
    const errors: string[] = [];
    const signals: NodeJS.Signals[] = [];
    let releaseResult: (() => void) | undefined;
    const result = new Promise<EdenCliDryRunResult>((resolve) => {
      releaseResult = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const processHandle: EdenCliProcess = {
      pid: 44_003,
      startIdentity: "never-settling-validation-result",
      exited: new Promise(() => {}),
      async terminate(signal?: NodeJS.Signals) {
        if (signal !== undefined) signals.push(signal);
      },
    };

    const buildPromise = runEdenCli(["build", "--project", root], {
      cwd: root,
      stderr: (line) => errors.push(line),
      dryRunRunner: () => {
        queueMicrotask(() => process.emit("SIGTERM"));
        return { process: processHandle, result };
      },
    });
    const observed = await Promise.race([
      buildPromise,
      new Promise<number>((resolve) => {
        setTimeout(() => resolve(-1), 3_000);
      }),
    ]);
    releaseResult?.();

    await expect(buildPromise).resolves.toBe(0);
    expect(observed).toBe(0);
    expect(signals).toContain("SIGTERM");
    expect(errors.join("\n")).not.toMatch(/compatibility validation failed/i);
  });

  test("keeps a synchronous remote spawn reservation in the cleanup barrier", async () => {
    const root = await createRoot();
    await initRoot(root);
    const errors: string[] = [];
    const signals: NodeJS.Signals[] = [];
    let releaseTermination: (() => void) | undefined;
    const termination = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let releaseExit: (() => void) | undefined;
    const remoteExited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });
    let releaseRemoteResult: (() => void) | undefined;
    const remoteResult = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseRemoteResult = () =>
        resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const processHandle: EdenCliProcess = {
      pid: 44_004,
      startIdentity: "reserved-remote-spawn",
      exited: remoteExited,
      async terminate(signal?: NodeJS.Signals) {
        if (signal !== undefined) signals.push(signal);
        await termination;
      },
    };

    const deployPromise = runEdenCli(
      [
        "deploy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-reserved-remote-spawn",
      ],
      {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        remoteCommandRunner: () => {
          process.emit("SIGTERM");
          return { process: processHandle, result: remoteResult };
        },
        remoteBearerSecret: "reserved-remote-secret",
      },
    );

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (signals.length > 0) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    const settledBeforeRelease = await Promise.race([
      deployPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 300);
      }),
    ]);
    expect(settledBeforeRelease).toBe(false);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .resolves.toContain("eden.deploy.lock");
    releaseTermination?.();
    releaseRemoteResult?.();
    releaseExit?.();
    await expect(deployPromise).resolves.toBe(1);
    expect(signals).toContain("SIGTERM");
    expect(errors.join("\n")).toMatch(/cancel|signal|remote/i);
    await vi.waitFor(async () => {
      await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("escalates a stubborn validation child with independent SIGKILL", async () => {
    const root = await createRoot();
    await initRoot(root);
    const signals: NodeJS.Signals[] = [];
    const processHandle: EdenCliProcess = {
      pid: 44_005,
      startIdentity: "stubborn-validation-child",
      exited: new Promise(() => {}),
      async terminate(signal?: NodeJS.Signals) {
        if (signal !== undefined) signals.push(signal);
      },
    };

    const buildPromise = runEdenCli(["build", "--project", root], {
      cwd: root,
      dryRunRunner: () => {
        queueMicrotask(() => process.emit("SIGTERM"));
        return {
          process: processHandle,
          result: new Promise<EdenCliDryRunResult>(() => {}),
        };
      },
    });

    await expect(
      Promise.race([
        buildPromise,
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(-1), 8_000);
        }),
      ]),
    ).resolves.toBe(0);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }, 12_000);

  test("retains a child and temporary files until failed termination later proves exit", async () => {
    const root = await createRoot();
    await initRoot(root);
    const signals: NodeJS.Signals[] = [];
    let releaseExit: (() => void) | undefined;
    let releaseResult: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });
    const result = new Promise<EdenCliDryRunResult>((resolve) => {
      releaseResult = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const processHandle: EdenCliProcess = {
      pid: 44_006,
      startIdentity: "late-proven-exit",
      exited,
      async terminate(signal?: NodeJS.Signals) {
        if (signal !== undefined) signals.push(signal);
      },
    };
    const buildPromise = runEdenCli(["build", "--project", root], {
      cwd: root,
      dryRunRunner: () => {
        queueMicrotask(() => process.emit("SIGTERM"));
        return {
          process: processHandle,
          result,
        };
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    const temporaryFiles = (await readdir(root)).filter((entry) =>
      entry.includes("eden-dev-worker") ||
      entry.includes("eden-dev-config") ||
      entry.includes("eden-build-candidate"),
    );
    expect(temporaryFiles.length).toBeGreaterThan(0);
    releaseExit?.();
    releaseResult?.();
    await expect(buildPromise).resolves.toBe(0);
    await vi.waitFor(
      async () => {
        await expect(
          readdir(root).then((entries) =>
            entries.filter((entry) =>
              entry.includes("eden-dev-worker") ||
              entry.includes("eden-dev-config") ||
              entry.includes("eden-build-candidate"),
            ),
          ),
        ).resolves.toEqual([]);
      },
      { timeout: 2_000 },
    );
  }, 12_000);

  test("does not install process-global signal listeners for injected dev stops", async () => {
    const root = await createRoot();
    await initRoot(root);
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const stopController = new AbortController();
    let releaseExit: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });
    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner: {
        spawn() {
          return {
            pid: 44_007,
            startIdentity: "injected-stop-no-global-listener",
            ready: Promise.resolve(),
            exited,
            async terminate() {
              releaseExit?.();
            },
          };
        },
      },
      runtimeGenerationProof: async () => true,
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
    stopController.abort();
    await expect(devPromise).resolves.toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  test("isolates concurrent injected build stops without process-global listeners", async () => {
    const firstRoot = await createRoot();
    const secondRoot = await createRoot();
    await Promise.all([initRoot(firstRoot), initRoot(secondRoot)]);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    let firstStarted = false;
    let secondStarted = false;
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstResult = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseFirst = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const secondResult = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseSecond = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const firstProcess: EdenCliProcess = {
      pid: 44_008,
      startIdentity: "isolated-build-first",
      exited: firstResult.then(() => ({ exitCode: 0, signal: null })),
      async terminate() {
        releaseFirst?.();
      },
    };
    const secondProcess: EdenCliProcess = {
      pid: 44_009,
      startIdentity: "isolated-build-second",
      exited: secondResult.then(() => ({ exitCode: 0, signal: null })),
      async terminate() {
        releaseSecond?.();
      },
    };

    const firstBuild = runEdenCli(["build", "--project", firstRoot], {
      cwd: firstRoot,
      stopSignal: firstController.signal,
      dryRunRunner: () => {
        firstStarted = true;
        return { process: firstProcess, result: firstResult };
      },
    });
    const secondBuild = runEdenCli(["build", "--project", secondRoot], {
      cwd: secondRoot,
      stopSignal: secondController.signal,
      dryRunRunner: () => {
        secondStarted = true;
        return { process: secondProcess, result: secondResult };
      },
    });

    await vi.waitFor(() => {
      expect(firstStarted).toBe(true);
      expect(secondStarted).toBe(true);
    });
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);

    firstController.abort();
    await expect(firstBuild).resolves.toBe(0);
    expect(secondBuild).toBeInstanceOf(Promise);
    const secondSettled = await Promise.race([
      secondBuild.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(secondSettled).toBe(false);

    secondController.abort();
    await expect(secondBuild).resolves.toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  }, 15_000);

  test("waits for a late compatibility handle before final cleanup", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    let resolveLate: (
      value: EdenCliDryRunHandle,
    ) => void;
    const lateResult = new Promise<EdenCliDryRunHandle>((resolve) => {
      resolveLate = resolve;
    });
    let releaseChild: (() => void) | undefined;
    let terminated = false;
    const childExited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseChild = () => resolve({ exitCode: 0, signal: null });
    });
    const child: EdenCliProcess = {
      pid: 44_010,
      startIdentity: "late-compatibility-child",
      exited: childExited,
      async terminate() {
        terminated = true;
        releaseChild?.();
      },
    };
    let releaseLateResult: (() => void) | undefined;
    const lateChildResult = new Promise<EdenCliDryRunResult>((resolve) => {
      releaseLateResult = () =>
        resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    let releaseHook: (() => void) | undefined;
    const hook = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let runnerStarted: (() => void) | undefined;
    const runnerStartedPromise = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    const buildPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      dryRunRunner: () => {
        runnerStarted?.();
        return lateResult as never;
      },
      buildPublicationHook: async () => hook,
    });

    await runnerStartedPromise;
    stopController.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    resolveLate!({
      process: child,
      result: lateChildResult,
    });
    releaseHook?.();
    releaseLateResult?.();

    await expect(buildPromise).resolves.toBe(0);
    expect(terminated).toBe(true);
  }, 15_000);

  test("bounds a permanently pending generation continuation", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    let hookStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    let releaseHook: (() => void) | undefined;
    const hook = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner: {
        spawn() {
          throw new Error("the runtime must not spawn while generation is pending");
        },
      },
      runtimeGenerationProof: async () => true,
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      buildPublicationHook: async () => {
        hookStarted?.();
        await hook;
      },
    });

    await started;
    stopController.abort();
    const settled = await Promise.race([
      devPromise.then((code) => ({ settled: true, code })),
      new Promise<{ readonly settled: false }>((resolve) =>
        setTimeout(() => resolve({ settled: false }), 1_500),
      ),
    ]);
    releaseHook?.();
    await expect(devPromise).resolves.toBe(1);
    expect(settled).toEqual({ settled: true, code: 1 });
  }, 10_000);

  test("fails closed when generation publication never settles", async () => {
    const root = await createRoot();
    await initRoot(root);
    let releaseHook: (() => void) | undefined;
    const hook = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let hookStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    const errors: string[] = [];
    const buildPromise = runEdenCli(["build", "--project", root], {
      cwd: root,
      stderr: (line) => errors.push(line),
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      buildPublicationHook: async () => {
        hookStarted?.();
        await hook;
      },
    });

    await started;
    const startedAt = Date.now();
    await expect(buildPromise).resolves.toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(errors.join("\n")).toMatch(/GENERATION_WORK_TIMEOUT|failed closed/i);
    releaseHook?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }, 10_000);

  test("exposes quiescence timeout as a secondary diagnostic beside a primary dev error", async () => {
    const root = await createRoot();
    await initRoot(root);
    const errors: string[] = [];
    let releaseHook: (() => void) | undefined;
    const hook = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    let hookStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stderr: (line) => errors.push(line),
      buildPublicationHook: async (boundary) => {
        if (boundary !== "before-canonical-prepare") return;
        hookStarted?.();
        await hook;
      },
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await started;
    await expect(devPromise).resolves.toBe(1);
    const joined = errors.join("\n");
    expect(joined).toMatch(/GENERATION_WORK_TIMEOUT/);
    expect(joined).toMatch(/DEV_QUIESCENCE_TIMEOUT/);
    expect(joined.indexOf("GENERATION_WORK_TIMEOUT")).toBeLessThan(
      joined.indexOf("DEV_QUIESCENCE_TIMEOUT"),
    );
    releaseHook?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 10_000);

  test("fails closed when the initial compiler generation never settles", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    const errors: string[] = [];
    let resolveInitialBuild: (() => void) | undefined;
    const initialBuildStarted = new Promise<void>((resolve) => {
      resolveInitialBuild = resolve;
    });

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      stderr: (line) => errors.push(line),
      processRunner: {
        spawn() {
          throw new Error("the runtime must not spawn while initial build is pending");
        },
      },
      buildProjectRunner: async () => {
        resolveInitialBuild?.();
        return new Promise<never>(() => {});
      },
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      runtimeGenerationProof: async () => true,
    } as Parameters<typeof runEdenCli>[1]);

    await initialBuildStarted;
    const startedAt = Date.now();
    stopController.abort();
    await expect(devPromise).resolves.toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(errors.join("\n")).toMatch(/quiescence|retained|generation/i);
  }, 10_000);

  test("allows a normal compiler generation to exceed the cleanup budget", async () => {
    const root = await createRoot();
    await initRoot(root);
    const startedAt = Date.now();

    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        buildProjectRunner: async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 1_100));
          return buildProject(request);
        },
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
  }, 15_000);

  test("retains late initial-generation work and temporary ownership after stop", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    let releaseGeneration: (() => void) | undefined;
    let generationStarted: (() => void) | undefined;
    const generationStartedPromise = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      buildProjectRunner: async (request) => {
        await mkdir(request.outputDirectory, { recursive: true });
        generationStarted?.();
        return await new Promise((resolve, reject) => {
          releaseGeneration = () => {
            void buildProject(request).then(resolve, reject);
          };
        });
      },
      processRunner: {
        spawn() {
          throw new Error("the runtime must not spawn while generation is pending");
        },
      },
      runtimeGenerationProof: async () => true,
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await generationStartedPromise;
    stopController.abort();
    await expect(devPromise).resolves.toBe(1);

    const retainedCandidates = (await readdir(root)).filter((entry) =>
      entry.startsWith(".eden-build-candidate-"),
    );
    expect(retainedCandidates.length).toBeGreaterThan(0);

    releaseGeneration?.();
    await vi.waitFor(
      async () => {
        await expect(
          readdir(root).then((entries) =>
            entries.filter((entry) =>
              entry.startsWith(".eden-build-candidate-"),
            ),
          ),
        ).resolves.toEqual([]);
      },
      { timeout: 15_000 },
    );
  }, 20_000);

  test("keeps publication timeout separate from compiler generation deadline", async () => {
    const root = await createRoot();
    await initRoot(root);
    const errors: string[] = [];
    let publicationStarted: (() => void) | undefined;
    const publicationStartedPromise = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    let releasePublication: (() => void) | undefined;
    const neverSettlingPublication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const startedAt = Date.now();

    const buildPromise = runEdenCli(["build", "--project", root], {
      cwd: root,
      stderr: (line) => errors.push(line),
      buildProjectRunner: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return buildProject(request);
      },
      buildPublicationHook: async (boundary) => {
        if (boundary === "before-canonical-prepare") {
          publicationStarted?.();
          await neverSettlingPublication;
        }
      },
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    const publicationReached = await Promise.race([
      publicationStartedPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 3_000),
      ),
    ]);
    expect(publicationReached).toBe(true);
    await expect(buildPromise).resolves.toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(errors.join("\n")).toMatch(/GENERATION_WORK_TIMEOUT|failed closed/i);
    releasePublication?.();
  }, 15_000);

  test("requires an explicit proof seam for an injected process runner", async () => {
    const root = await createRoot();
    await initRoot(root);
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
              pid: 44_011,
              startIdentity: "missing-explicit-proof-seam",
              ready: Promise.resolve(),
              exited: Promise.resolve({ exitCode: 0, signal: null }),
              async terminate() {},
            };
          },
        },
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(1);

    expect(spawned).toBe(false);
    expect(errors.join("\n")).toMatch(/proof|authenticated|generation/i);
  });

  test("uses an explicit authenticated proof seam with an injected process runner", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    let releaseExit: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });
    let proofCalls = 0;
    let ready: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner: {
        spawn() {
          return {
            pid: 44_012,
            startIdentity: "explicit-proof-seam",
            ready: Promise.resolve(),
            exited,
            async terminate() {
              releaseExit?.();
            },
          };
        },
      },
      dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      runtimeGenerationProof: async ({ generation, signal }) => {
        proofCalls += 1;
        expect(generation.generationId).toMatch(/^gen_[a-f0-9]{64}$/u);
        expect(signal).toBeInstanceOf(AbortSignal);
        ready?.();
        return true;
      },
      stdout: (line) => {
        if (line.includes("Eden dev ready")) {
          stopController.abort();
        }
      },
    } as Parameters<typeof runEdenCli>[1]);

    await readyPromise;
    await expect(devPromise).resolves.toBe(0);
    expect(proofCalls).toBeGreaterThan(0);
  });
});

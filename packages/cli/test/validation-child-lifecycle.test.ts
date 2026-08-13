import {
  mkdtemp,
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

import {
  runEdenCli,
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
    const remoteResult = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>(() => {});
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
    releaseTermination?.();
    await expect(deployPromise).resolves.toBe(1);
    expect(signals).toContain("SIGTERM");
    expect(errors.join("\n")).toMatch(/cancel|signal|remote/i);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .resolves.toContain("eden.deploy.lock");
    releaseExit?.();
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
});

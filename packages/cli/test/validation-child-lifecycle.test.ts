import {
  mkdtemp,
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
});

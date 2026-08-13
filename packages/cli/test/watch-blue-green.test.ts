import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
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
  type EdenCliProcess,
  type EdenCliProcessRequest,
} from "../src/index.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-watch-blue-green-"));
  roots.push(root);
  return root;
}

async function initRoot(root: string): Promise<void> {
  await expect(
    runEdenCli(["init", "--project", root], { cwd: root }),
  ).resolves.toBe(0);
}

async function waitForValue<T>(
  read: () => T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for fixture value");
}

async function generationFromRequest(
  root: string,
  request: EdenCliProcessRequest,
): Promise<Record<string, unknown>> {
  const configIndex = request.args.indexOf("--config");
  const configPath = request.args[configIndex + 1];
  if (configPath === undefined) {
    throw new Error("watch fixture did not receive a config path");
  }
  const config = await readFile(configPath, "utf8");
  const main = /"main"\s*:\s*"([^"]+)"/u.exec(config)?.[1];
  if (main === undefined) {
    throw new Error("watch fixture config did not contain main");
  }
  const entry = await readFile(join(root, main), "utf8");
  const marker = "configureEdenArtifact(agentArtifact, ";
  const markerStart = entry.indexOf(marker);
  const serializedStart = markerStart + marker.length;
  const serializedEnd = entry.indexOf(");\nexport", serializedStart);
  if (markerStart < 0 || serializedEnd < serializedStart) {
    throw new Error("watch fixture entry did not contain generation metadata");
  }
  const value = JSON.parse(
    entry.slice(serializedStart, serializedEnd),
  ) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("watch fixture generation metadata was malformed");
  }
  return value as Record<string, unknown>;
}

function updatedToolSource(description: string): string {
  return `import type { EdenToolDefinition } from "@eden/definitions";

const greet: EdenToolDefinition<
  { readonly name: string },
  { readonly greeting: string }
> = {
  description: ${JSON.stringify(description)},
  inputSchema: {
    "~standard": {
      version: 1,
      vendor: "eden-watch-fixture",
      validate(value: unknown) {
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          typeof (value as { readonly name?: unknown }).name === "string"
        ) {
          return {
            value: {
              name: (value as { readonly name: string }).name.trim(),
            },
          };
        }
        return { issues: [{ message: "name must be a string." }] };
      },
    },
  },
  execute(input) {
    return { greeting: \`Watch hello, \${input.name}!\` };
  },
};

export default greet;
`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  vi.stubEnv("EDEN_BEARER_SECRET", "watch-test-secret");
});

describe("eden dev watch blue-green replacement", () => {
  test.each([
    "before-runtime-entry-publish",
    "after-runtime-entry-publish",
    "before-runtime-config-publish",
    "after-runtime-config-publish",
    "after-runtime-ready",
  ] as const)(
    "stop guards late replacement publication at %s",
    async (boundary) => {
      const root = await createRoot();
      await initRoot(root);
      const stopController = new AbortController();
      vi.stubEnv("EDEN_BEARER_SECRET", `watch-stop-${boundary}`);

      let servedGeneration: Record<string, unknown> | undefined;
      let initialGeneration: Record<string, unknown> | undefined;
      let resolveDevReady: (() => void) | undefined;
      const devReady = new Promise<void>((resolve) => {
        resolveDevReady = resolve;
      });
      let spawnCount = 0;
      let releaseExit: (() => void) | undefined;
      const exitPromises: Array<Promise<{
        readonly exitCode: number;
        readonly signal: null;
      }>> = [];
      let replacementPublicationReached: (() => void) | undefined;
      const publicationReached = new Promise<void>((resolve) => {
        replacementPublicationReached = resolve;
      });
      let releasePublicationHook: (() => void) | undefined;
      const errors: string[] = [];

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (servedGeneration === undefined) {
            return new Response("not ready", { status: 503 });
          }
          return new Response(JSON.stringify({ generation: servedGeneration }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      );

      const processRunner = {
        spawn(request: EdenCliProcessRequest): EdenCliProcess {
          spawnCount += 1;
          const ownGeneration = {
            value: undefined as Record<string, unknown> | undefined,
          };
          let resolveExit: (() => void) | undefined;
          const exited = new Promise<{
            readonly exitCode: number;
            readonly signal: null;
          }>((resolve) => {
            resolveExit = () => resolve({ exitCode: 0, signal: null });
          });
          exitPromises.push(exited);
          void generationFromRequest(root, request).then((generation) => {
            ownGeneration.value = generation;
            if (spawnCount === 1) {
              initialGeneration = generation;
              servedGeneration = generation;
            } else {
              servedGeneration = generation;
            }
          });
          return {
            pid: 45_500 + spawnCount,
            startIdentity: `watch-stop-${boundary}-${spawnCount}`,
            ready: Promise.resolve(),
            exited,
            async terminate() {
              if (
                ownGeneration.value !== undefined &&
                servedGeneration === ownGeneration.value
              ) {
                servedGeneration = initialGeneration;
              }
              resolveExit?.();
              releaseExit?.();
            },
          };
        },
      };

      const devPromise = runEdenCli(["dev", "--project", root], {
        cwd: root,
        stopSignal: stopController.signal,
        processRunner,
        runtimeGenerationProof: "authenticated-fetch",
        dryRunRunner: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
        runtimePublicationHook: async (observedBoundary) => {
          if (observedBoundary !== boundary || spawnCount < 2) return;
          replacementPublicationReached?.();
          if (boundary === "after-runtime-ready") {
            await new Promise<void>((resolve) => {
              releasePublicationHook = resolve;
            });
          }
          stopController.abort();
        },
        stderr: (line) => errors.push(line),
        stdout: (line) => {
          if (line.includes("Eden dev ready")) resolveDevReady?.();
        },
      });

      try {
        await devReady;
        expect(initialGeneration?.generationId).toEqual(expect.any(String));
        await writeFile(
          join(root, "agent/tools/greet.ts"),
          updatedToolSource(`stop at ${boundary}`),
          "utf8",
        );
        await publicationReached;
        if (boundary === "after-runtime-ready") {
          stopController.abort();
          releasePublicationHook?.();
        }
        await expect(devPromise).resolves.toBe(0);
        await expect(access(join(root, ".eden-dev-state.json")))
          .rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          readdir(root).then((entries) =>
            entries.filter((entry) =>
              entry.includes("eden-dev-worker") ||
              entry.includes("eden-dev-config"),
            ),
          ),
        ).resolves.toEqual([]);
        releasePublicationHook?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expect(access(join(root, ".eden-dev-state.json")))
          .rejects.toMatchObject({ code: "ENOENT" });
        expect(errors.join("\n")).not.toMatch(/unhandled/i);
        expect(exitPromises.length).toBeGreaterThanOrEqual(2);
      } finally {
        releasePublicationHook?.();
        stopController.abort();
        await expect(devPromise).resolves.toBe(0);
      }
    },
    15_000,
  );

  test("proves a successful replacement through authenticated live info", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-live-secret");

    let servedGeneration: Record<string, unknown> | undefined;
    let initialGeneration: Record<string, unknown> | undefined;
    let resolveDevReady: (() => void) | undefined;
    const devReady = new Promise<void>((resolve) => {
      resolveDevReady = resolve;
    });
    const requests: Array<{
      readonly url: string;
      readonly authorization: string | undefined;
      readonly generationId: unknown;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(input),
          authorization: headers.get("authorization") ?? undefined,
          generationId: servedGeneration?.generationId,
        });
        if (servedGeneration === undefined) {
          return new Response("not ready", { status: 503 });
        }
        return new Response(JSON.stringify({ generation: servedGeneration }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    let spawnCount = 0;
    const processRunner = {
      spawn(request: EdenCliProcessRequest): EdenCliProcess {
        spawnCount += 1;
        const ownGeneration = {
          value: undefined as Record<string, unknown> | undefined,
        };
        let resolveExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const exited = new Promise<{
          readonly exitCode: number;
          readonly signal: null;
        }>((resolve) => {
          resolveExit = () => resolve({ exitCode: 0, signal: null });
        });
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        void generationFromRequest(root, request)
          .then((generation) => {
            ownGeneration.value = generation;
            if (spawnCount === 1) {
              initialGeneration = generation;
            }
            servedGeneration = generation;
            resolveReady?.();
          })
          .catch((error: unknown) => {
            console.error("watch live fixture generation failed", error);
          });
        return {
          pid: 45_000 + spawnCount,
          startIdentity: `watch-live-${spawnCount}`,
          ready,
          exited,
          async terminate() {
            if (ownGeneration.value !== undefined) {
              if (servedGeneration === ownGeneration.value) {
                servedGeneration = initialGeneration;
              }
            }
            resolveExit?.();
          },
        };
      },
    };

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner,
      runtimeGenerationProof: "authenticated-fetch",
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      stdout: (line) => {
        if (line.includes("Eden dev ready")) resolveDevReady?.();
      },
    });

    try {
      await devReady;
      const initial = await waitForValue(() => initialGeneration);
      const initialGenerationId = initial.generationId;
      expect(initialGenerationId).toEqual(expect.any(String));

      await writeFile(
        join(root, "agent/tools/greet.ts"),
        updatedToolSource("live generation replacement"),
        "utf8",
      );

      const replacementRequest = await waitForValue(() =>
        requests.find(
          (request) =>
            request.url.endsWith("/eden/v1/info") &&
            request.authorization === "Bearer watch-live-secret" &&
            request.generationId !== initialGenerationId,
        ),
        20_000,
      );
      expect(replacementRequest.generationId).toBe(
        servedGeneration?.generationId,
      );
      expect(servedGeneration?.generationId).not.toBe(initialGenerationId);
      expect(spawnCount).toBe(2);
    } finally {
      stopController.abort();
      await expect(devPromise).resolves.toBe(0);
    }
  }, 30_000);

  test("verifies the old generation after replacement readiness fails", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-rollback-secret");

    let servedGeneration: Record<string, unknown> | undefined;
    let initialGeneration: Record<string, unknown> | undefined;
    let resolveDevReady: (() => void) | undefined;
    const devReady = new Promise<void>((resolve) => {
      resolveDevReady = resolve;
    });
    const requests: Array<Record<string, unknown> | undefined> = [];
    const errors: string[] = [];
    let readinessTimedOut = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(servedGeneration);
        if (servedGeneration === undefined) {
          return new Response("not ready", { status: 503 });
        }
        if (replacementProbe) {
          await new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("readiness probe stalled")),
              2_000,
            );
            const signal = init?.signal;
            const abort = (): void => {
              readinessTimedOut = true;
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            };
            if (signal?.aborted === true) {
              abort();
              return;
            }
            signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return new Response(JSON.stringify({ generation: servedGeneration }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    let spawnCount = 0;
    let replacementProbe = false;
    const processRunner = {
      spawn(request: EdenCliProcessRequest): EdenCliProcess {
        spawnCount += 1;
        const spawnIndex = spawnCount;
        const ownGeneration = {
          value: undefined as Record<string, unknown> | undefined,
        };
        let resolveExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const exited = new Promise<{
          readonly exitCode: number;
          readonly signal: null;
        }>((resolve) => {
          resolveExit = () => resolve({ exitCode: 0, signal: null });
        });
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        void generationFromRequest(root, request)
          .then((generation) => {
            ownGeneration.value = generation;
            if (spawnIndex === 1) {
              initialGeneration = generation;
              servedGeneration = generation;
            } else if (spawnIndex === 2) {
              replacementProbe = true;
            } else {
              replacementProbe = false;
            }
            resolveReady?.();
          })
          .catch((error: unknown) => {
            console.error("watch rollback fixture generation failed", error);
          });
        return {
          pid: 45_100 + spawnCount,
          startIdentity: `watch-rollback-${spawnCount}`,
          ready,
          exited,
          async terminate() {
            if (
              ownGeneration.value !== undefined &&
              servedGeneration === ownGeneration.value
            ) {
              servedGeneration = initialGeneration;
            }
            resolveExit?.();
          },
        };
      },
    };

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner,
      runtimeGenerationProof: "authenticated-fetch",
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      stderr: (line) => errors.push(line),
      runtimeReadinessTimeoutMs: 250,
      stdout: (line) => {
        if (line.includes("Eden dev ready")) resolveDevReady?.();
      },
    } as Parameters<typeof runEdenCli>[1]);

    try {
      await devReady;
      const initial = await waitForValue(() => initialGeneration);
      const initialGenerationId = initial.generationId;
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        updatedToolSource("failed replacement"),
        "utf8",
      );

      try {
        await waitForValue(
          () =>
            errors.find((line) =>
              /watch rebuild unavailable|rollback|replacement/i.test(line),
            ),
          5_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ` +
          `(spawnCount=${spawnCount}, readinessTimedOut=${readinessTimedOut}, ` +
          `requests=${requests.length}, errors=${JSON.stringify(errors)})`,
        );
      }
      expect(spawnCount).toBeGreaterThanOrEqual(2);
      expect(servedGeneration?.generationId).toBe(initialGenerationId);
      expect(readinessTimedOut).toBe(true);
      expect(
        requests.some(
          (generation) => generation?.generationId === initialGenerationId,
        ),
      ).toBe(true);
    } finally {
      stopController.abort();
      await expect(devPromise).resolves.toBe(0);
      await expect(
        readdir(root).then((entries) =>
          entries.filter((entry) =>
            entry.includes("eden-dev-worker") ||
            entry.includes("eden-dev-config"),
          ),
        ),
      ).resolves.toEqual([]);
    }
  }, 15_000);

  test("aborts a stalled readiness request when dev cleanup starts", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-abort-secret");

    let servedGeneration: Record<string, unknown> | undefined;
    let initialGenerationId: unknown;
    let resolveDevReady: (() => void) | undefined;
    const devReady = new Promise<void>((resolve) => {
      resolveDevReady = resolve;
    });
    let readinessStartedObserved = false;
    let readinessAborted = false;
    let replacementProbe = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (replacementProbe) {
          readinessStartedObserved = true;
          await new Promise<never>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted === true) {
              readinessAborted = true;
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                readinessAborted = true;
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }
        return new Response(JSON.stringify({ generation: servedGeneration }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    let spawnCount = 0;
    const processRunner = {
      spawn(request: EdenCliProcessRequest): EdenCliProcess {
        spawnCount += 1;
        const ownGeneration = {
          value: undefined as Record<string, unknown> | undefined,
        };
        let resolveExit: (() => void) | undefined;
        let resolveReady: (() => void) | undefined;
        const exited = new Promise<{
          readonly exitCode: number;
          readonly signal: null;
        }>((resolve) => {
          resolveExit = () => resolve({ exitCode: 0, signal: null });
        });
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        void generationFromRequest(root, request)
          .then((generation) => {
            ownGeneration.value = generation;
            if (spawnCount === 1) {
              initialGenerationId = generation.generationId;
              servedGeneration = generation;
            } else {
              servedGeneration = generation;
              replacementProbe = true;
            }
            resolveReady?.();
          })
          .catch((error: unknown) => {
            console.error("watch abort fixture generation failed", error);
          });
        return {
          pid: 45_200 + spawnCount,
          startIdentity: `watch-abort-${spawnCount}`,
          ready,
          exited,
          async terminate() {
            if (
              ownGeneration.value !== undefined &&
              servedGeneration === ownGeneration.value
            ) {
              servedGeneration = undefined;
            }
            resolveExit?.();
          },
        };
      },
    };

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner,
      runtimeGenerationProof: "authenticated-fetch",
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      runtimeReadinessTimeoutMs: 10_000,
      stdout: (line) => {
        if (line.includes("Eden dev ready")) resolveDevReady?.();
      },
    } as Parameters<typeof runEdenCli>[1]);

    try {
      await devReady;
      await waitForValue(() => initialGenerationId);
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        updatedToolSource("stalled replacement"),
        "utf8",
      );
      try {
        await waitForValue(
          () => (readinessStartedObserved ? true : undefined),
          5_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ` +
          `(spawnCount=${spawnCount}, replacementProbe=${replacementProbe}, ` +
          `initialGenerationId=${String(initialGenerationId)}, ` +
          `servedGeneration=${JSON.stringify(servedGeneration)})`,
        );
      }
      const startedAt = Date.now();
      stopController.abort();
      await expect(devPromise).resolves.toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(readinessAborted).toBe(true);
      expect(spawnCount).toBeGreaterThanOrEqual(2);
    } finally {
      stopController.abort();
      await expect(devPromise).resolves.toBe(0);
    }
  }, 15_000);

  test("does not leak a rollback child when stop races its synchronous spawn", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-rollback-race-secret");

    let servedGeneration: Record<string, unknown> | undefined;
    let initialGeneration: Record<string, unknown> | undefined;
    let resolveDevReady: (() => void) | undefined;
    const devReady = new Promise<void>((resolve) => {
      resolveDevReady = resolve;
    });
    let spawnCount = 0;
    let rollbackGuardReached = false;
    const errors: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (servedGeneration === undefined) {
          return new Response("not ready", { status: 503 });
        }
        return new Response(JSON.stringify({ generation: servedGeneration }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const processRunner = {
      spawn(request: EdenCliProcessRequest): EdenCliProcess {
        spawnCount += 1;
        const spawnIndex = spawnCount;
        const ownGeneration = {
          value: undefined as Record<string, unknown> | undefined,
        };
        let resolveExit: (() => void) | undefined;
        const exited = new Promise<{
          readonly exitCode: number;
          readonly signal: null;
        }>((resolve) => {
          resolveExit = () => resolve({ exitCode: 0, signal: null });
        });
        void generationFromRequest(root, request)
          .then((generation) => {
            ownGeneration.value = generation;
            if (spawnCount === 1) {
              initialGeneration = generation;
              servedGeneration = generation;
            } else {
              servedGeneration = generation;
            }
          })
          .catch((error: unknown) => {
            console.error("watch rollback-race fixture failed", error);
          });
        const processHandle: EdenCliProcess = {
          pid: 45_300 + spawnIndex,
          startIdentity: `watch-rollback-race-${spawnIndex}`,
          ready: Promise.resolve(),
          exited,
          async terminate() {
            if (
              ownGeneration.value !== undefined &&
              servedGeneration === ownGeneration.value
            ) {
              servedGeneration = initialGeneration;
            }
            resolveExit?.();
          },
        };
        return processHandle;
      },
    };

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner,
      runtimeGenerationProof: "authenticated-fetch",
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      stderr: (line) => errors.push(line),
      runtimePublicationHook: async (boundary) => {
        if (boundary === "after-runtime-ready") {
          throw new Error("replacement publication failed");
        }
        if (boundary === "before-runtime-rollback") {
          rollbackGuardReached = true;
          stopController.abort();
        }
      },
      stdout: (line) => {
        if (line.includes("Eden dev ready")) resolveDevReady?.();
      },
    });

    try {
      await devReady;
      await waitForValue(() => initialGeneration);
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        updatedToolSource("rollback spawn race"),
        "utf8",
      );
      await waitForValue(
        () => (rollbackGuardReached ? true : undefined),
        5_000,
      );
      expect(spawnCount).toBe(2);
    } finally {
      stopController.abort();
      await expect(devPromise).resolves.toBe(0);
    }

  }, 15_000);

  test("keeps the old runtime after replacement termination is rejected when live proof succeeds", async () => {
    const root = await createRoot();
    await initRoot(root);
    const stopController = new AbortController();
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-termination-rejection-secret");

    let servedGeneration: Record<string, unknown> | undefined;
    let initialGeneration: Record<string, unknown> | undefined;
    let resolveDevReady: (() => void) | undefined;
    const devReady = new Promise<void>((resolve) => {
      resolveDevReady = resolve;
    });
    let spawnCount = 0;
    let oldTerminationAttempts = 0;
    const errors: string[] = [];
    const requests: Array<Record<string, unknown> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requests.push(servedGeneration);
        if (servedGeneration === undefined) {
          return new Response("not ready", { status: 503 });
        }
        return new Response(JSON.stringify({ generation: servedGeneration }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const processRunner = {
      spawn(request: EdenCliProcessRequest): EdenCliProcess {
        spawnCount += 1;
        const ownGeneration = {
          value: undefined as Record<string, unknown> | undefined,
        };
        void generationFromRequest(root, request)
          .then((generation) => {
            ownGeneration.value = generation;
            if (spawnCount === 1) {
              initialGeneration = generation;
              servedGeneration = generation;
            }
          })
          .catch((error: unknown) => {
            console.error("watch termination-rejection fixture failed", error);
          });
        return {
          pid: 45_400 + spawnCount,
          startIdentity: `watch-termination-rejection-${spawnCount}`,
          ready: Promise.resolve(),
          exited: new Promise(() => {}),
          async terminate() {
            if (spawnCount === 1) {
              oldTerminationAttempts += 1;
              throw new Error("old runtime termination was rejected");
            }
          },
        };
      },
    };

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner,
      runtimeGenerationProof: "authenticated-fetch",
      dryRunRunner: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
      stderr: (line) => errors.push(line),
      runtimeReadinessTimeoutMs: 250,
      stdout: (line) => {
        if (line.includes("Eden dev ready")) resolveDevReady?.();
      },
    });

    try {
      await devReady;
      const initial = await waitForValue(() => initialGeneration);
      const settledBeforeStop = await Promise.race([
        devPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(settledBeforeStop).toBe(false);
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        updatedToolSource("termination rejection"),
        "utf8",
      );
      await waitForValue(
        () => errors.find((line) => /watch rebuild unavailable|termination|old runtime/i.test(line)),
        5_000,
      );
      expect(spawnCount).toBe(1);
      expect(oldTerminationAttempts).toBeGreaterThan(0);
      expect(
        requests.some(
          (generation) => generation?.generationId === initial.generationId,
        ),
      ).toBe(true);
      expect(servedGeneration?.generationId).toBe(initial.generationId);
    } finally {
      stopController.abort();
      await expect(devPromise).resolves.toBe(1);
    }
  }, 15_000);

  test("waits for a rebuild that races stop before task registration", async () => {
    const root = await createRoot();
    await initRoot(root);
    vi.stubEnv("EDEN_BEARER_SECRET", "watch-hermetic-stop-secret");
    const stopController = new AbortController();
    const errors: string[] = [];
    let servedGeneration: Record<string, unknown> | undefined;
    let resolveDevReady: (() => void) | undefined;
    const devReady = new Promise<void>((resolve) => {
      resolveDevReady = resolve;
    });
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      resolveExit = () => resolve({ exitCode: 0, signal: null });
    });
    let spawnCount = 0;
    let dryRunCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (servedGeneration === undefined) {
          return new Response("not ready", { status: 503 });
        }
        return new Response(JSON.stringify({ generation: servedGeneration }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const devPromise = runEdenCli(["dev", "--project", root], {
      cwd: root,
      stopSignal: stopController.signal,
      processRunner: {
        spawn(request: EdenCliProcessRequest): EdenCliProcess {
          spawnCount += 1;
          const ownGeneration = {
            value: undefined as Record<string, unknown> | undefined,
          };
          void generationFromRequest(root, request).then((generation) => {
            ownGeneration.value = generation;
            servedGeneration = generation;
          });
          return {
            pid: 45_600 + spawnCount,
            startIdentity: `watch-hermetic-${spawnCount}`,
            ready: Promise.resolve(),
            exited,
            async terminate() {
              if (ownGeneration.value !== undefined &&
                servedGeneration === ownGeneration.value) {
                servedGeneration = undefined;
              }
              resolveExit?.();
            },
          };
        },
      },
      runtimeGenerationProof: "authenticated-fetch",
      dryRunRunner: () => {
        dryRunCount += 1;
        if (dryRunCount === 2) {
          stopController.abort();
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      stderr: (line) => errors.push(line),
      stdout: (line) => {
        if (line.includes("Eden dev ready")) resolveDevReady?.();
      },
    });

    await devReady;
    await writeFile(
      join(root, "agent/tools/greet.ts"),
      updatedToolSource("hermetic stop race"),
      "utf8",
    );
    await expect(devPromise).resolves.toBe(0);

    await rm(root, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors.join("\n")).not.toMatch(
      /PROJECT_ROOT_INVALID|selected project root is unavailable/i,
    );
  }, 15_000);
});

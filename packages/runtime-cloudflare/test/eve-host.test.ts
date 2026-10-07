import { describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";
import { NodeSqliteAdapter } from "../../world-cloudflare/src/core/node-sqlite.js";

import {
  EVE_HOST_DEFAULTS,
  createEveHostConfig,
  createEveReadinessGate,
  createTrustedEveRequest,
  eveScheduleCronFiresWithin,
  expandEveCronField,
  generateEveHostWorkerSource,
  parseEveScheduleCron,
  resolveStableWorkersDevOrigin,
} from "../src/eve-host.js";
import {
  EVE_HOST_CARRY_LIMITS,
  createEveHostWorker,
  EveHostDurableContainer,
  EdenWorldDurableObject,
  routeEveOutboundRequest,
} from "../src/eve-host-runtime.js";

const IDENTITY = {
  workerName: "eden-eve-preview",
  containerApplicationName: "eden-eve-preview-container",
  stableContainerInstanceName: "eden-eve-preview-instance",
  deploymentId: "dep-test",
  generationId: "gen-test",
};

const CURRENT_IMAGE =
  "registry.example/eden-eve-gen@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD_IMAGE =
  "registry.example/eden-eve-old@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

interface FakeRuntimeOptions {
  readonly running?: boolean;
  readonly inspectImage?: string;
  readonly snapshotFails?: number;
  /** Bytes the fake `tar -czf - sessions` streams on carry-out. */
  readonly carryArchive?: string;
  readonly carryOutExitCode?: number;
  readonly carryInExitCode?: number;
  /** Makes every exec call throw, simulating a dead runtime. */
  readonly execFails?: boolean;
}

const CARRY_OUT_SCRIPT = "tar -czf - sessions";
const CARRY_IN_SCRIPT = "tar -xzf -";

async function drainStream(
  stream: ReadableStream | undefined | null,
): Promise<Uint8Array> {
  if (stream === undefined || stream === null) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    parts.push(value);
    total += value.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function streamOf(text: string): ReadableStream {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeContainerRuntime(options: FakeRuntimeOptions = {}) {
  const state = {
    running: options.running ?? false,
    image: options.inspectImage ?? CURRENT_IMAGE,
    snapshotCalls: 0,
    destroyCalls: 0,
    carryOutCalls: 0,
    carryInCalls: 0,
    /** Payloads the fake container received on carry-in stdin. */
    carryInPayloads: [] as string[],
    /** Order of container events, e.g. ["carry-out","destroy","start"]. */
    timeline: [] as string[],
  };
  const runtime: FakeContainerRuntime & {
    lastStart?: {
      image?: string;
      containerSnapshot?: { id: string };
    };
  } = {
    state,
    get running() {
      return state.running;
    },
    images: { eve: CURRENT_IMAGE },
    start(startOptions) {
      state.running = true;
      // Cloudflare's inspect() reports an empty image for a snapshot restore.
      state.image = startOptions.containerSnapshot === undefined
        ? startOptions.image ?? state.image
        : "";
      state.timeline.push("start");
      runtime.lastStart = {
        ...(startOptions.image === undefined ? {} : { image: startOptions.image }),
        ...(startOptions.containerSnapshot === undefined
          ? {}
          : { containerSnapshot: startOptions.containerSnapshot }),
      };
    },
    monitor() {
      return new Promise<void>(() => {});
    },
    async destroy() {
      state.destroyCalls += 1;
      state.running = false;
      state.timeline.push("destroy");
    },
    async inspect() {
      return state.running ? { image: state.image } : null;
    },
    async snapshotContainer() {
      state.snapshotCalls += 1;
      if (state.snapshotCalls <= (options.snapshotFails ?? 0)) {
        throw new Error("snapshot unavailable");
      }
      return { id: "snapshot-1" };
    },
    async setInactivityTimeout(ms: number) {
      if (ms > 6 * 3_600_000) {
        throw new Error(
          "The maximum amount of time that a container can stay disconnected from a Durable Object is 6 hours",
        );
      }
    },
    async interceptOutboundHttps() {},
    getTcpPort() {
      return {
        fetch: async (request: Request) => {
          state.timeline.push(
            new URL(request.url).pathname === EVE_HOST_DEFAULTS.healthPath
              ? "health"
              : "forward",
          );
          return Response.json({ status: "ready" });
        },
      };
    },
    async exec(command, execOptions) {
      if (options.execFails === true) throw new Error("exec unavailable");
      const script = command[0] === "sh" && typeof command[1] === "string" &&
          command[1] === "-c" && typeof command[2] === "string"
        ? command[2]
        : "";
      if (script.includes(CARRY_OUT_SCRIPT)) {
        state.carryOutCalls += 1;
        state.timeline.push("carry-out");
        return {
          exitCode: Promise.resolve(options.carryOutExitCode ?? 0),
          stdout: streamOf(options.carryArchive ?? ""),
          stderr: null,
        };
      }
      if (script.includes(CARRY_IN_SCRIPT)) {
        state.carryInCalls += 1;
        state.timeline.push("carry-in");
        state.carryInPayloads.push(
          new TextDecoder().decode(await drainStream(execOptions?.stdin)),
        );
        return {
          exitCode: Promise.resolve(options.carryInExitCode ?? 0),
          stdout: null,
          stderr: null,
        };
      }
      return { exitCode: Promise.resolve(0), stdout: null, stderr: null };
    },
  };
  return runtime;
}

interface FakeContainerRuntime {
  state: {
    running: boolean;
    image: string;
    snapshotCalls: number;
    destroyCalls: number;
    carryOutCalls: number;
    carryInCalls: number;
    carryInPayloads: string[];
    timeline: string[];
  };
  readonly running: boolean;
  images: { eve: string };
  start(startOptions: {
    image?: string;
    containerSnapshot?: { id: string };
    instance: string;
    enableInternet: boolean;
    env: Record<string, string>;
  }): void;
  monitor(): Promise<void>;
  destroy(): Promise<void>;
  inspect(): Promise<{ image: string } | null>;
  snapshotContainer(): Promise<{ id: string }>;
  setInactivityTimeout(ms: number): Promise<void>;
  interceptOutboundHttps(): Promise<void>;
  getTcpPort(): { fetch(request: Request): Promise<Response> };
  exec(
    command: readonly string[],
    options?: {
      readonly stdin?: ReadableStream;
      readonly stdout?: "pipe" | "ignore";
      readonly stderr?: "pipe" | "ignore" | "combined";
    },
  ): Promise<{
    readonly exitCode: Promise<number>;
    readonly stdout: ReadableStream | null;
    readonly stderr: ReadableStream | null;
  }>;
}

function hostContainer(
  stored: Map<string, unknown>,
  runtime: FakeContainerRuntime,
  alarms?: number[],
) {
  const container = new EveHostDurableContainer(
    {
      container: runtime,
      storage: {
        sql: { exec: () => [] },
        get: async (key: string) => stored.get(key),
        put: async (key: string, value: unknown) => {
          stored.set(key, value);
        },
        delete: async (key: string) => {
          stored.delete(key);
        },
        setAlarm: async (at: number) => {
          alarms?.push(at);
        },
      },
      blockConcurrencyWhile: (callback: () => Promise<void>) => {
        void callback().catch(() => {});
      },
    } as never,
    {
      EVE_PUBLIC_ORIGIN: "https://eden-eve-preview.account.workers.dev",
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EDEN_EVE_DEPLOYMENT_ID: IDENTITY.deploymentId,
      EDEN_EVE_GENERATION_ID: IDENTITY.generationId,
    },
  );
  return container;
}

/** Temporarily shrinks the sandbox carry limits for chunking/cap tests. */
async function withCarryLimits<T>(
  limits: { readonly chunkBytes: number; readonly maxBytes: number },
  run: () => Promise<T>,
): Promise<T> {
  const previous = { ...EVE_HOST_CARRY_LIMITS };
  Object.assign(EVE_HOST_CARRY_LIMITS, limits);
  try {
    return await run();
  } finally {
    Object.assign(EVE_HOST_CARRY_LIMITS, previous);
  }
}

describe("durable World queue acknowledgements", () => {
  test.each(["body-error", "continuation"] as const)(
    "preserves an unacknowledged queue message after %s",
    async (responseKind) => {
      const sql = new NodeSqliteAdapter();
      const { encode } = createRequire(
        import.meta.resolve("@moinulmoin/eden-world-cloudflare"),
      )("cbor-x") as { encode(value: unknown): Uint8Array };
      let alarm: number | null = null;
      const object = new EdenWorldDurableObject({
        storage: {
          sql,
          transactionSync: sql.transactionSync.bind(sql),
          setAlarm: async (at: number) => { alarm = at; },
          deleteAlarm: async () => { alarm = null; },
        },
        blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
      } as never, {
        EVE_PUBLIC_ORIGIN: "https://eden-eve-preview.account.workers.dev",
        EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
        EVE_CONTAINER: {
          getByName: () => ({
            loopbackFetch: async () => responseKind === "body-error"
              ? new Response(new ReadableStream({
                  start(controller) { controller.error(new Error("transport interrupted")); },
                }))
              : Response.json({ timeoutSeconds: 2 }),
          }),
        },
      });
      try {
        await object.fetch(new Request("https://world.invalid/rpc", {
          method: "POST",
          body: encode({ op: "queue.enqueue", args: ["workflow", { runId: "proof" }] }) as Uint8Array<ArrayBuffer>,
        }));
        await object.alarm();
        const row = sql.exec(
          "SELECT completed,attempt,due_at FROM workflow_queue_messages",
        ).toArray()[0];
        expect(row?.completed).toBe(0);
        expect(row?.attempt).toBe(2);
        expect(alarm).toBe(row?.due_at);
      } finally {
        sql.close();
      }
    },
  );
});

describe("generic Eve Cloudflare host", () => {
  test("builds one private named Worker/Container graph with one stable identity", () => {
    const config = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin: "https://eden-eve-preview.account.workers.dev",
      containerImage: "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      containerImageBuildContext: "./container",
      runtimeVariableNames: ["EVE_AUTH_SECRET", "WORKFLOW_API_URL"],
      runtimeRevisionHandle: "revision-1",
    });

    expect(config.worker.name).toBe(IDENTITY.workerName);
    expect(config.worker.workers_dev).toBe(true);
    expect(config.worker.route).toBeUndefined();
    expect(config.worker.routes).toBeUndefined();
    expect(config.worker.containers).toEqual([
      {
        name: IDENTITY.containerApplicationName,
        class_name: "EveHostDurableContainer",
        scheduling_policy: "durable_object",
        images: {
          eve: { image: config.worker.containers?.[0]?.images.eve.image },
        },
      },
    ]);
    expect(config.worker.durable_objects?.bindings).toEqual([
      {
        name: "EVE_CONTAINER",
        class_name: "EveHostDurableContainer",
      },
    ]);
    expect(config.worker.migrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: ["EveHostDurableContainer"],
      },
    ]);
    expect(config.container.instanceName).toBe(
      IDENTITY.stableContainerInstanceName,
    );
    expect(config.container.port).toBe(EVE_HOST_DEFAULTS.internalPort);
    expect(config.container.publicOrigin).toBe(
      "https://eden-eve-preview.account.workers.dev",
    );
    expect(config.worker.vars).toEqual({
      EVE_PUBLIC_ORIGIN: "https://eden-eve-preview.account.workers.dev",
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EDEN_EVE_DEPLOYMENT_ID: IDENTITY.deploymentId,
      EDEN_EVE_GENERATION_ID: IDENTITY.generationId,
      EVE_RUNTIME_VARIABLE_NAMES: ["EVE_AUTH_SECRET", "WORKFLOW_API_URL"],
      EDEN_EVE_RUNTIME_REVISION: "revision-1",
    });
    const source = generateEveHostWorkerSource({ config });
    expect(source).toContain("EveHostDurableContainer");
    expect(source).toContain(IDENTITY.stableContainerInstanceName);
    expect(source).toContain("export { EveHostLoopback };");
    expect(source).not.toMatch(/EdenSession|handleEdenRequest|\/eden\/v1/u);
    expect(source).not.toContain("secret-value");

    expect(source).toContain("export { EveHostDurableContainer };");
    expect(config.worker.compatibility_flags).toEqual(["enable_ctx_exports"]);
    expect(source).not.toMatch(/@moinulmoin\/eden-runtime-cloudflare|node:/u);
  });

  test("resolves only an explicit workers.dev account subdomain", () => {
    expect(
      resolveStableWorkersDevOrigin({
        workerName: "eden-eve-preview",
        workersDevSubdomain: "account",
      }),
    ).toBe("https://eden-eve-preview.account.workers.dev");

    expect(() =>
      resolveStableWorkersDevOrigin({
        workerName: "eden-eve-preview",
        workersDevSubdomain: "account.workers.dev",
      }),
    ).toThrow(/workers\.dev/u);
    expect(() =>
      resolveStableWorkersDevOrigin({
        workerName: "other worker",
        workersDevSubdomain: "account",
      }),
    ).toThrow(/worker/u);
    expect(() =>
      createEveHostConfig({
        ...IDENTITY,
        stableWorkersDevOrigin:
          "https://eden-eve-preview.attacker.account.workers.dev",
        containerImage:
          "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow(/provider-assigned/u);
  });

  test("strips spoofed host metadata while preserving application headers and bytes", async () => {
    const requestBody = new Uint8Array([0, 255, 1, 2, 3]);
    const request = new Request(
      "https://client.invalid/eve/%2Fencoded?tag=one&tag=two",
      {
        method: "PATCH",
        body: requestBody,
        headers: {
          authorization: "Bearer app-token",
          cookie: "eve=session",
          "content-type": "application/octet-stream",
          forwarded: "for=attacker;host=evil.invalid;proto=http",
          "x-forwarded-for": "198.51.100.9",
          "x-forwarded-host": "evil.invalid",
          "x-forwarded-proto": "http",
          "x-real-ip": "198.51.100.9",
          "cf-container-target-port": "9999",
          "x-eden-eve-deployment-id": "attacker-deployment",
          "x-eden-eve-generation-id": "attacker-generation",
          "x-eden-eve-public-origin": "https://evil.invalid",
        },
      },
    );
    const upstream = createTrustedEveRequest(request, {
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      correlationId: "corr-test",
    });
    expect(upstream.method).toBe("PATCH");
    expect(new URL(upstream.url).origin).toBe(
      "https://eden-eve-preview.account.workers.dev",
    );
    expect(new URL(upstream.url).pathname).toBe("/eve/%2Fencoded");
    expect(new URL(upstream.url).search).toBe("?tag=one&tag=two");
    expect(new Uint8Array(await upstream.arrayBuffer())).toEqual(requestBody);
    expect(upstream.headers.get("authorization")).toBe("Bearer app-token");
    expect(upstream.headers.get("cookie")).toBe("eve=session");
    expect(upstream.headers.get("x-forwarded-host")).toBe(
      "eden-eve-preview.account.workers.dev",
    );
    expect(upstream.headers.get("x-forwarded-proto")).toBe("https");
    expect(upstream.headers.get("x-real-ip")).toBeNull();
    expect(upstream.headers.get("cf-container-target-port")).toBeNull();
    expect(upstream.headers.get("x-eden-eve-deployment-id")).toBe(
      IDENTITY.deploymentId,
    );
    expect(upstream.headers.get("x-eden-eve-generation-id")).toBe(
      IDENTITY.generationId,
    );
    expect(upstream.headers.get("x-eden-eve-public-origin")).toBe(
      "https://eden-eve-preview.account.workers.dev",
    );
    expect(upstream.headers.get("forwarded")).toBe(
      "proto=https;host=eden-eve-preview.account.workers.dev",
    );
  });

  test("constructs a forwarding request without reading the application body", async () => {
    const request = new Request("https://client.invalid/root", {
      method: "POST",
      body: "opaque-body",
    });
    expect(request.bodyUsed).toBe(false);
    const forwarded = createTrustedEveRequest(request, {
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      correlationId: "corr-request",
    });
    expect(request.bodyUsed).toBe(false);
    expect(await forwarded.text()).toBe("opaque-body");
  });

  test("coalesces cold-start readiness and accepts only the real Eve ready contract", async () => {
    let starts = 0;
    let healthCalls = 0;
    const gate = createEveReadinessGate({
      start: async () => {
        starts += 1;
      },
      healthFetch: async (request) => {
        healthCalls += 1;
        expect(request.method).toBe("GET");
        expect(new URL(request.url).pathname).toBe("/eve/v1/health");
        return new Response(
          JSON.stringify({ status: "ready" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const first = gate(new AbortController().signal);
    const second = gate(new AbortController().signal);
    const [firstEvidence, secondEvidence] = await Promise.all([first, second]);

    expect(firstEvidence.healthVerified).toBe(true);
    expect(secondEvidence.healthStatus).toBe("ready");
    expect(starts).toBe(1);
    expect(healthCalls).toBe(1);

    await gate(new AbortController().signal);
    expect(starts).toBe(1);
    expect(healthCalls).toBe(1);
  });

  test("keeps a shared cold start alive when the first caller aborts", async () => {
    let releaseHealth: (() => void) | undefined;
    const healthReady = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const gate = createEveReadinessGate({
      start: async () => undefined,
      healthFetch: async () => {
        await healthReady;
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const firstController = new AbortController();
    const first = gate(firstController.signal);
    const second = gate(new AbortController().signal);
    firstController.abort();
    releaseHealth?.();

    await expect(first).rejects.toMatchObject({
      code: "HOST_REQUEST_ABORTED",
    });
    await expect(second).resolves.toMatchObject({ healthStatus: "ready" });
  });

  test("resets cached readiness only when the Container generation stops", async () => {
    let starts = 0;
    let healthCalls = 0;
    const gate = createEveReadinessGate({
      start: async () => {
        starts += 1;
      },
      healthFetch: async () => {
        healthCalls += 1;
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await gate(new AbortController().signal);
    await gate(new AbortController().signal);
    expect(starts).toBe(1);
    expect(healthCalls).toBe(1);
    gate.reset();
    await gate(new AbortController().signal);
    expect(starts).toBe(2);
    expect(healthCalls).toBe(2);
  });

  test("does not treat a listening port or synthetic response as Eve readiness", async () => {
    const gate = createEveReadinessGate({
      start: async () => undefined,
      readinessTimeoutMs: 10,
      waitIntervalMs: 1,
      healthFetch: async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(gate(new AbortController().signal)).rejects.toMatchObject({
      code: "HOST_READINESS_UNPROVEN",
    });
  });

  test("bounds the health poll by the overall readiness deadline", async () => {
    const gate = createEveReadinessGate({
      start: async () => undefined,
      readinessTimeoutMs: 15,
      waitIntervalMs: 1,
      healthTimeoutMs: 5,
      healthFetch: async () => new Promise<Response>(() => {}),
    });

    await expect(gate(new AbortController().signal)).rejects.toMatchObject({
      code: "HOST_READINESS_UNPROVEN",
    });
  });

  test("refuses the Workflow queue-delivery subtree on the public Worker path", async () => {
    const forwardedUrls: string[] = [];
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
    });
    const env = {
      EVE_CONTAINER: {
        getByName: () => ({
          fetch: async (request: Request) => {
            forwardedUrls.push(request.url);
            return new Response("forwarded");
          },
        }),
      },
    };

    for (const path of [
      "/.well-known/workflow/v1/flow",
      "/.well-known/workflow/v1/flow?__health",
      "/.well-known/workflow/v1/step",
      "/.well-known/%77orkflow/v1/flow",
      "/.well-known/workflow/v1/%66low",
      "/.well-known/workflow/v1/FLOW/",
      "/.well-known//workflow/v1/flow",
      "/__eden/world/rpc",
      "/__eden/%77orld/rpc",
      "/%5f%5feden/world/rpc",
      "/__eden//world/rpc",
      "/__eden/world/other",
    ]) {
      const response = await worker.fetch(
        new Request(`https://eden-eve-preview.account.workers.dev${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vqs-queue-name": "__wkf_workflow_",
            "x-vqs-message-id": "msg_forge",
            "x-vqs-message-attempt": "1",
          },
          body: "{}",
        }),
        env,
      );
      expect(response.status).toBe(404);
    }
    expect(forwardedUrls).toEqual([]);

    const webhook = await worker.fetch(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/webhook/token-123",
        { method: "POST", body: "{}" },
      ),
      env,
    );
    expect(webhook.status).toBe(200);
    expect(forwardedUrls).toEqual([
      "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/webhook/token-123",
    ]);
    const manifest = await worker.fetch(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/manifest.json",
      ),
      env,
    );
    expect(await manifest.text()).toBe("forwarded");

    const api = await worker.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
      env,
    );
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("forwarded");
  });

  test("routes container egress to the public origin back through the container", async () => {
    const loopback: string[] = [];
    const env = {
      EVE_PUBLIC_ORIGIN: "https://eden-eve-preview.account.workers.dev",
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EDEN_EVE_DEPLOYMENT_ID: IDENTITY.deploymentId,
      EDEN_EVE_GENERATION_ID: IDENTITY.generationId,
      EVE_CONTAINER: {
        getByName: (name: string) => ({
          loopbackFetch: async (request: Request) => {
            loopback.push(`${name}:${request.url}`);
            return new Response("delivered inside");
          },
        }),
      },
    };
    const container = new EveHostDurableContainer(
      {
        container: fakeContainerRuntime(),
        storage: {
          sql: { exec: () => [] },
          get: async () => undefined,
          put: async () => undefined,
          setAlarm: async () => undefined,
        },
        blockConcurrencyWhile: (callback: () => Promise<void>) => {
          void callback().catch(() => {});
        },
      } as never,
      env,
    );
    await container.ensureEveReady(new AbortController().signal);
    const response = await routeEveOutboundRequest(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/flow",
        { method: "POST", body: "{}" },
      ),
      env as never,
    );
    expect(await response.text()).toBe("delivered inside");
    expect(loopback).toEqual([
      `${IDENTITY.stableContainerInstanceName}:https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/flow`,
    ]);
  });
});

describe("Eve schedule wake triggers", () => {
  test("emits one every-minute cron trigger only when schedules exist", () => {
    const withSchedules = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin:
        "https://eden-eve-preview.account.workers.dev",
      containerImage:
        "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schedules: [
        { name: "digest", cron: "0 9 * * 1-5" },
        { name: "sweep", cron: "*/15 * * * *" },
      ],
    });
    expect(withSchedules.worker.triggers).toEqual({
      crons: ["* * * * *"],
    });
    expect(withSchedules.container.schedules).toHaveLength(2);
    const source = generateEveHostWorkerSource({ config: withSchedules });
    expect(source).toContain('"schedules"');
    expect(source).toContain('"0 9 * * 1-5"');

    const without = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin:
        "https://eden-eve-preview.account.workers.dev",
      containerImage:
        "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(without.worker.triggers).toBeUndefined();
    expect(without.container.schedules).toEqual([]);
    expect(generateEveHostWorkerSource({ config: without })).not.toContain(
      '"schedules"',
    );
  });

  test("rejects schedule crons the wake trigger cannot evaluate", () => {
    for (const cron of ["@daily", "*/30 * * * * *", "0 0 L * *"]) {
      expect(() =>
        createEveHostConfig({
          ...IDENTITY,
          stableWorkersDevOrigin:
            "https://eden-eve-preview.account.workers.dev",
          containerImage:
            "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          schedules: [{ name: "bad", cron }],
        }),
      ).toThrow(/cron expression/u);
      expect(parseEveScheduleCron(cron)).toBeUndefined();
    }
  });

  test("parses the standard 5-field subset with Vixie dom/dow semantics", () => {
    expect(expandEveCronField("*/15", 0)?.has(45)).toBe(true);
    expect(expandEveCronField("9-17", 1)?.has(12)).toBe(true);
    expect(expandEveCronField("mon-fri", 4)?.has(3)).toBe(true);
    expect(expandEveCronField("jan,jun", 3)?.has(6)).toBe(true);
    expect(expandEveCronField("7", 4)?.has(0)).toBe(true);
    expect(parseEveScheduleCron("0 9 * * 1-5")).not.toBeUndefined();

    const friday9 = Date.parse("2026-10-02T09:00:00Z");
    expect(eveScheduleCronFiresWithin("0 9 * * 1-5", friday9)).toBe(true);
    expect(
      eveScheduleCronFiresWithin(
        "0 9 * * 1-5",
        friday9 - 4 * 60_000,
      ),
    ).toBe(true);
    expect(
      eveScheduleCronFiresWithin(
        "0 9 * * 1-5",
        friday9 - 5 * 60_000,
      ),
    ).toBe(false);
    expect(
      eveScheduleCronFiresWithin("0 9 * * 1-5", friday9 + 120_000),
    ).toBe(false);
    expect(eveScheduleCronFiresWithin("*/5 * * * *", friday9)).toBe(true);
  });

  test("the scheduled handler wakes the container only inside the lead window", async () => {
    const wakeUrls: string[] = [];
    const env = {
      EVE_CONTAINER: {
        getByName: () => ({
          fetch: async (request: Request) => {
            wakeUrls.push(request.url);
            return new Response("ok");
          },
        }),
      },
    };
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      schedules: [{ name: "digest", cron: "0 9 * * 1-5" }],
    });
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (task: Promise<unknown>) => {
        waited.push(task);
      },
    };

    const farTick = Date.parse("2026-10-02T10:00:00Z");
    worker.scheduled?.(
      { cron: "* * * * *", scheduledTime: farTick },
      env,
      ctx,
    );
    expect(waited).toEqual([]);

    const nearTick = Date.parse("2026-10-02T08:57:00Z");
    worker.scheduled?.(
      { cron: "* * * * *", scheduledTime: nearTick },
      env,
      ctx,
    );
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(wakeUrls).toEqual([
      "https://eden-eve-preview.account.workers.dev/eve/v1/health",
    ]);
  });

  test("omits the scheduled handler when no schedules exist", () => {
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
    });
    expect(worker.scheduled).toBeUndefined();
  });

  test("schedules do not loosen the internal-route refusal", async () => {
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      schedules: [{ name: "digest", cron: "*/5 * * * *" }],
    });
    const response = await worker.fetch(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/flow",
        { method: "POST", body: "{}" },
      ),
      {
        EVE_CONTAINER: {
          getByName: () => ({
            fetch: async () => new Response("forwarded"),
          }),
        },
      },
    );
    expect(response.status).toBe(404);
  });
});

describe("in-place update Durable Object history", () => {
  const CONTAINER_IMAGE =
    "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  test("carries prior bindings and migrations verbatim and appends v2 for a new class", () => {
    const config = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin: "https://eden-eve-preview.account.workers.dev",
      containerImage: CONTAINER_IMAGE,
      workflowWorld: "@moinulmoin/eden-world-cloudflare",
      durableObjects: {
        bindings: [
          { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
        ],
        migrations: [
          { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
        ],
      },
    });
    // v1 is never re-emitted for an existing class; the new classes are
    // appended under a fresh tag.
    expect(config.worker.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
      {
        tag: "v2",
        new_sqlite_classes: ["EdenWorldDurableObject"],
      },
    ]);
    expect(config.worker.durable_objects.bindings).toEqual([
      { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
      { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
    ]);
  });


  test("keeps the World class binding and export when the World switches away", () => {
    const config = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin: "https://eden-eve-preview.account.workers.dev",
      containerImage: CONTAINER_IMAGE,
      durableObjects: {
        bindings: [
          { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
          { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
        ],
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: [
              "EveHostDurableContainer",
              "EdenWorldDurableObject",
            ],
          },
        ],
      },
    });
    expect(config.worker.vars.EDEN_EVE_WORLD_CLOUDFLARE).toBeUndefined();
    expect(config.worker.migrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: [
          "EveHostDurableContainer",
          "EdenWorldDurableObject",
        ],
      },
    ]);
    expect(config.worker.durable_objects.bindings).toContainEqual({
      name: "EDEN_WORLD",
      class_name: "EdenWorldDurableObject",
    });
    expect(generateEveHostWorkerSource({ config })).toContain(
      "export { EdenWorldDurableObject }",
    );
  });

  test("rejects malformed recorded migration history instead of rewriting it", () => {
    expect(() =>
      createEveHostConfig({
        ...IDENTITY,
        stableWorkersDevOrigin: "https://eden-eve-preview.account.workers.dev",
        containerImage: CONTAINER_IMAGE,
        durableObjects: {
          migrations: [
            { tag: "", new_sqlite_classes: [] },
          ],
        },
      }),
    ).toThrow(/migration history/u);
  });

});

describe("EveHostDurableContainer lifecycle", () => {
  test("restores a stored snapshot only when its image matches the configured image", async () => {
    const stored = new Map<string, unknown>([
      ["eden.eve.host.workspace-snapshot", {
        id: "snap-ok",
        image: CURRENT_IMAGE,
        at: 0,
      }],
    ]);
    const runtime = fakeContainerRuntime();
    const container = hostContainer(stored, runtime);
    await container.ensureEveReady(new AbortController().signal);
    expect(runtime.lastStart?.containerSnapshot).toEqual({ id: "snap-ok" });
    expect(runtime.lastStart?.image).toBeUndefined();

    const stale = new Map<string, unknown>([
      ["eden.eve.host.workspace-snapshot", {
        id: "snap-old",
        image: OLD_IMAGE,
        at: 0,
      }],
    ]);
    const staleRuntime = fakeContainerRuntime();
    const staleContainer = hostContainer(stale, staleRuntime);
    await staleContainer.ensureEveReady(new AbortController().signal);
    expect(staleRuntime.lastStart?.containerSnapshot).toBeUndefined();
    expect(staleRuntime.lastStart?.image).toBe(CURRENT_IMAGE);
  });

  test("restarts a running container whose image predates the deployment", async () => {
    const stored = new Map<string, unknown>();
    const runtime = fakeContainerRuntime({
      running: true,
      inspectImage: OLD_IMAGE,
    });
    const container = hostContainer(stored, runtime);
    await container.ensureEveReady(new AbortController().signal);
    expect(runtime.state.destroyCalls).toBe(1);
    expect(runtime.lastStart?.image).toBe(CURRENT_IMAGE);
  });

  test("keeps a snapshot-restored container whose inspect() image is empty", async () => {
    const stored = new Map<string, unknown>([
      ["eden.eve.host.workspace-snapshot", { id: "snap-ok", image: CURRENT_IMAGE, at: 0 }],
    ]);
    const runtime = fakeContainerRuntime();
    await hostContainer(stored, runtime).ensureEveReady(new AbortController().signal);
    expect(runtime.lastStart?.containerSnapshot).toEqual({ id: "snap-ok" });
    // A fresh Durable Object (e.g. after eviction) must not replace it.
    await hostContainer(stored, runtime).ensureEveReady(new AbortController().signal);
    expect(runtime.state.destroyCalls).toBe(0);
  });

  test("replaces a running container recorded as started from an older image", async () => {
    const stored = new Map<string, unknown>([
      ["eden.eve.host.started-image", OLD_IMAGE],
    ]);
    const runtime = fakeContainerRuntime({ running: true, inspectImage: "" });
    await hostContainer(stored, runtime).ensureEveReady(new AbortController().signal);
    expect(runtime.state.destroyCalls).toBe(1);
    expect(runtime.lastStart?.image).toBe(CURRENT_IMAGE);
  });

  test("the default sleep window fits Cloudflare's 6-hour inactivity limit", async () => {
    const runtime = fakeContainerRuntime();
    await expect(
      hostContainer(new Map(), runtime).ensureEveReady(new AbortController().signal),
    ).resolves.toMatchObject({ healthPath: EVE_HOST_DEFAULTS.healthPath });
  });

  test("rejects a sleep override Cloudflare cannot honor before it snapshots", () => {
    const request = {
      ...IDENTITY,
      stableWorkersDevOrigin: "https://eden-eve-preview.account.workers.dev",
      containerImage:
        "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    expect(() =>
      createEveHostConfig({ ...request, containerSleepAfter: "6h" }),
    ).toThrow(/exceeds 345m/u);
    expect(() =>
      createEveHostConfig({ ...request, containerSleepAfter: "345m" }),
    ).not.toThrow();
  });

  test("echoes the started deployment only when the served image and deployment id match", async () => {
    const stored = new Map<string, unknown>();
    const runtime = fakeContainerRuntime();
    const container = hostContainer(stored, runtime);
    const response = await container.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info", {
        headers: { "x-eden-eve-deployment-id": IDENTITY.deploymentId },
      }),
    );
    expect(response.headers.get("x-eden-eve-started-deployment")).toBe(
      IDENTITY.deploymentId,
    );

    const foreign = await container.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info", {
        headers: { "x-eden-eve-deployment-id": "dep-other" },
      }),
    );
    expect(foreign.headers.get("x-eden-eve-started-deployment")).toBeNull();
  });

  test("alarm snapshots and destroys the idle container", async () => {
    const stored = new Map<string, unknown>([
      ["eden.eve.host.last-activity-at", 0],
    ]);
    const alarms: number[] = [];
    const runtime = fakeContainerRuntime({ running: true });
    const container = hostContainer(stored, runtime, alarms);
    await container.alarm();
    expect(runtime.state.snapshotCalls).toBe(1);
    expect(runtime.state.destroyCalls).toBe(1);
    expect(runtime.state.running).toBe(false);
    expect(stored.get("eden.eve.host.workspace-snapshot")).toEqual({
      id: "snapshot-1",
      image: CURRENT_IMAGE,
      at: expect.any(Number),
    });
  });

  test("alarm reschedules while the container is not yet idle", async () => {
    const now = Date.now();
    const stored = new Map<string, unknown>([
      ["eden.eve.host.last-activity-at", now],
    ]);
    const alarms: number[] = [];
    const runtime = fakeContainerRuntime({ running: true });
    const container = hostContainer(stored, runtime, alarms);
    await container.alarm();
    expect(runtime.state.snapshotCalls).toBe(0);
    expect(runtime.state.destroyCalls).toBe(0);
    expect(alarms.at(-1)).toBeGreaterThan(now);
  });

  test("alarm retries a failed snapshot then destroys after the cap", async () => {
    const stored = new Map<string, unknown>([
      ["eden.eve.host.last-activity-at", 0],
    ]);
    const alarms: number[] = [];
    const runtime = fakeContainerRuntime({ running: true, snapshotFails: 99 });
    const container = hostContainer(stored, runtime, alarms);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await container.alarm();
      expect(runtime.state.destroyCalls).toBe(0);
    }
    await container.alarm();
    expect(runtime.state.snapshotCalls).toBe(3);
    expect(runtime.state.destroyCalls).toBe(1);
    expect(stored.get("eden.eve.host.workspace-snapshot")).toBeUndefined();
  });
});

describe("sandbox session carry across image updates", () => {
  const CARRY_META_KEY = "eden.eve.host.sandbox-carry";

  test("saves a chunked carry before destroying a stale image and restores it before the first forwarded request", async () => {
    await withCarryLimits({ chunkBytes: 4, maxBytes: 1024 }, async () => {
      const stored = new Map<string, unknown>();
      const runtime = fakeContainerRuntime({
        running: true,
        inspectImage: OLD_IMAGE,
        carryArchive: "sessions-archive-v1",
      });
      const container = hostContainer(stored, runtime);
      const response = await container.fetch(
        new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
      );
      expect(response.status).toBe(200);
      expect(runtime.state.timeline).toEqual([
        "carry-out",
        "destroy",
        "start",
        "health",
        "carry-in",
        "forward",
      ]);
      expect(runtime.lastStart?.image).toBe(CURRENT_IMAGE);
      const carry = stored.get(CARRY_META_KEY) as {
        id: string;
        chunks: number;
        bytes: number;
        at: number;
      };
      expect(carry.chunks).toBe(5);
      expect(carry.bytes).toBe(19);
      const decoder = new TextDecoder();
      const joined = Array.from({ length: carry.chunks }, (_, index) =>
        decoder.decode(
          stored.get(`${CARRY_META_KEY}.${carry.id}.${index}`) as Uint8Array,
        ),
      ).join("");
      expect(joined).toBe("sessions-archive-v1");
      expect(runtime.state.carryInPayloads).toEqual(["sessions-archive-v1"]);
    });
  });

  test("does not restore a carry after a same-image snapshot wake", async () => {
    const carryId = "carry-alarm";
    const stored = new Map<string, unknown>([
      ["eden.eve.host.workspace-snapshot", {
        id: "snap-ok",
        image: CURRENT_IMAGE,
        at: 0,
      }],
      [CARRY_META_KEY, { id: carryId, chunks: 1, bytes: 3, at: 0 }],
      [`${CARRY_META_KEY}.${carryId}.0`, new TextEncoder().encode("abc")],
    ]);
    const runtime = fakeContainerRuntime();
    const container = hostContainer(stored, runtime);
    await container.ensureEveReady(new AbortController().signal);
    expect(runtime.lastStart?.containerSnapshot).toEqual({ id: "snap-ok" });
    expect(runtime.state.carryInCalls).toBe(0);
    expect(runtime.state.timeline).toEqual(["start", "health"]);
  });

  test("alarm carries sessions out together with the snapshot", async () => {
    const stored = new Map<string, unknown>([
      ["eden.eve.host.last-activity-at", 0],
    ]);
    const alarms: number[] = [];
    const runtime = fakeContainerRuntime({
      running: true,
      carryArchive: "alarm-archive",
    });
    const container = hostContainer(stored, runtime, alarms);
    await container.alarm();
    expect(runtime.state.timeline).toEqual(["carry-out", "destroy"]);
    expect(runtime.state.snapshotCalls).toBe(1);
    const carry = stored.get(CARRY_META_KEY) as {
      id: string;
      chunks: number;
      bytes: number;
    };
    expect(carry.chunks).toBe(1);
    expect(carry.bytes).toBe(13);
    expect(stored.get(`${CARRY_META_KEY}.${carry.id}.0`)).toEqual(
      new TextEncoder().encode("alarm-archive"),
    );
    expect(stored.get("eden.eve.host.workspace-snapshot")).toEqual({
      id: "snapshot-1",
      image: CURRENT_IMAGE,
      at: expect.any(Number),
    });
  });

  test("keeps the previous carry when the new carry exceeds the cap", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await withCarryLimits({ chunkBytes: 4, maxBytes: 8 }, async () => {
      const stored = new Map<string, unknown>([
        [CARRY_META_KEY, { id: "carry-prev", chunks: 2, bytes: 8, at: 0 }],
        [`${CARRY_META_KEY}.carry-prev.0`, new TextEncoder().encode("0123")],
        [`${CARRY_META_KEY}.carry-prev.1`, new TextEncoder().encode("4567")],
      ]);
      const runtime = fakeContainerRuntime({
        running: true,
        inspectImage: OLD_IMAGE,
        carryArchive: "0123456789ABCDEF",
      });
      const container = hostContainer(stored, runtime);
      await container.fetch(
        new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
      );
      expect(runtime.state.destroyCalls).toBe(1);
      expect(stored.get(CARRY_META_KEY)).toEqual({
        id: "carry-prev",
        chunks: 2,
        bytes: 8,
        at: 0,
      });
      expect(stored.has(`${CARRY_META_KEY}.carry-prev.0`)).toBe(true);
      expect(stored.has(`${CARRY_META_KEY}.carry-prev.1`)).toBe(true);
      const extraKeys = [...stored.keys()].filter(
        (key) => key.startsWith(`${CARRY_META_KEY}.`) &&
          !key.endsWith("carry-prev.0") &&
          !key.endsWith("carry-prev.1") &&
          key !== CARRY_META_KEY,
      );
      expect(extraKeys).toEqual([]);
      expect(errorSpy).toHaveBeenCalled();
    });
    errorSpy.mockRestore();
  });

  test("a failed restore does not block serving", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const carryId = "carry-broken";
    const stored = new Map<string, unknown>([
      [CARRY_META_KEY, { id: carryId, chunks: 1, bytes: 3, at: 0 }],
      [`${CARRY_META_KEY}.${carryId}.0`, new TextEncoder().encode("abc")],
    ]);
    const runtime = fakeContainerRuntime({ carryInExitCode: 7 });
    const container = hostContainer(stored, runtime);
    const response = await container.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
    );
    expect(response.status).toBe(200);
    expect(runtime.state.timeline).toEqual([
      "start",
      "health",
      "carry-in",
      "forward",
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("a failing carry still lets the update destroy and restart", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = new Map<string, unknown>();
    const runtime = fakeContainerRuntime({
      running: true,
      inspectImage: OLD_IMAGE,
      execFails: true,
    });
    const container = hostContainer(stored, runtime);
    const response = await container.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
    );
    expect(response.status).toBe(200);
    expect(runtime.state.destroyCalls).toBe(1);
    expect(runtime.state.carryInCalls).toBe(0);
    expect(stored.has(CARRY_META_KEY)).toBe(false);
    errorSpy.mockRestore();
  });
});

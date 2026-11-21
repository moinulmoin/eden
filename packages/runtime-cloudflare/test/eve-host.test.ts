import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  /** Snapshot ids Cloudflare no longer has: a start from one never runs and
   * `monitor()` rejects with `Snapshot "<id>" was not found.` (observed live). */
  readonly missingSnapshotIds?: readonly string[];
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
    /** Set when the last start came from a snapshot Cloudflare no longer has. */
    startFailure: undefined as Error | undefined,
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
      const missingSnapshot = startOptions.containerSnapshot !== undefined &&
        (options.missingSnapshotIds ?? []).includes(startOptions.containerSnapshot.id);
      state.running = !missingSnapshot;
      state.startFailure = missingSnapshot
        ? new Error(`Snapshot "${startOptions.containerSnapshot?.id}" was not found.`)
        : undefined;
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
      const failure = state.startFailure;
      return failure === undefined
        ? new Promise<void>(() => {})
        : Promise.reject(failure);
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
          if (!state.running) {
            throw new Error("The container is not listening on port 8080");
          }
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
    startFailure: Error | undefined;
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
  options: {
    readonly deploymentId?: string;
    readonly abort?: (reason?: string) => void;
    readonly env?: Record<string, unknown>;
    /** The object's instance name, for a target with deployment affinity. */
    readonly instance?: string;
  } = {},
) {
  const container = new EveHostDurableContainer(
    {
      id: { equals: (other: unknown) => other === options.instance },
      container: runtime,
      waitUntil: (promise: Promise<unknown>) => { void promise; },
      abort: options.abort ?? ((reason?: string) => {
        throw new Error(reason);
      }),
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
      EDEN_EVE_DEPLOYMENT_ID: options.deploymentId ?? IDENTITY.deploymentId,
      EDEN_EVE_GENERATION_ID: IDENTITY.generationId,
      ...options.env,
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
      const background: Promise<void>[] = [];
      const object = new EdenWorldDurableObject({
        storage: {
          sql,
          transactionSync: sql.transactionSync.bind(sql),
          setAlarm: async (at: number) => { alarm = at; },
          deleteAlarm: async () => { alarm = null; },
        },
        blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
        waitUntil: (promise: Promise<void>) => { background.push(promise); },
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
        await Promise.all(background);
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

describe("World object after a deploy", () => {
  const origin = "https://eden-eve-preview.account.workers.dev";
  const { encode } = createRequire(
    import.meta.resolve("@moinulmoin/eden-world-cloudflare"),
  )("cbor-x") as { encode(value: unknown): Uint8Array };

  /** One World object in SQLite that Cloudflare restarts on `restartsOn` when it resets. */
  function worldFixture(startsOn: readonly [string, string?], restartsOn: readonly [string, string?]) {
    const sql = new NodeSqliteAdapter();
    const resets: string[] = [];
    const worldOn = ([release, previous]: readonly [string, string?]): EdenWorldDurableObject => new EdenWorldDurableObject({
      storage: {
        sql,
        transactionSync: sql.transactionSync.bind(sql),
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
      },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
      waitUntil: () => undefined,
      abort: (reason?: string) => {
        resets.push(release);
        fixture.live = worldOn(restartsOn);
        throw new Error(`remote exception: ${reason}`);
      },
    } as never, {
      EVE_PUBLIC_ORIGIN: origin,
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EDEN_EVE_DEPLOYMENT_ID: "dep-test",
      EDEN_EVE_RELEASE_ID: release,
      ...(previous === undefined ? {} : { EDEN_EVE_PREVIOUS_RELEASE_ID: previous }),
      EVE_CONTAINER: { getByName: () => ({ loopbackFetch: async () => Response.json({}) }) },
    });
    const fixture = {
      live: worldOn(startsOn),
      resets,
      messages: () => sql.exec("SELECT COUNT(*) AS n FROM workflow_queue_messages").toArray()[0]?.n,
      /** A container of `release` enqueues one message through `send`. */
      container(release: string, previous?: string, send = (request: Request) => fixture.live.fetch(request)) {
        const env = {
          EVE_PUBLIC_ORIGIN: origin,
          EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
          EDEN_EVE_DEPLOYMENT_ID: "dep-test",
          EDEN_EVE_RELEASE_ID: release,
          ...(previous === undefined ? {} : { EDEN_EVE_PREVIOUS_RELEASE_ID: previous }),
          EDEN_WORLD: { idFromName: () => "world", get: () => ({ fetch: send }) },
        };
        return () => routeEveOutboundRequest(
          new Request(`${origin}/__eden/world/rpc`, {
            method: "POST",
            headers: { "x-eden-world-token": "token" },
            body: encode({ op: "queue.enqueue", args: ["workflow", { runId: "proof" }] }) as Uint8Array<ArrayBuffer>,
          }),
          env as never,
          "dep-test",
          "token",
        );
      },
      close: () => sql.close(),
    };
    return fixture;
  }

  // Workers have crypto.subtle.timingSafeEqual; Node does not.
  const subtle = crypto.subtle as unknown as Record<string, unknown>;
  beforeEach(() => {
    subtle.timingSafeEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  });
  afterEach(() => {
    delete subtle.timingSafeEqual;
  });

  test("a World object left on the release before restarts for the new release's container and still serves the replaced one", async () => {
    const world = worldFixture(["release-1"], ["release-2", "release-1"]);
    try {
      expect((await world.container("release-2", "release-1")()).status).toBe(200);
      expect(world.resets).toEqual(["release-1"]);
      expect((await world.container("release-1")()).status).toBe(200);
      expect((await world.container("release-2", "release-1")()).status).toBe(200);
      expect(world.resets).toEqual(["release-1"]);
      expect(world.messages()).toBe(3);
    } finally {
      world.close();
    }
  });

  test("a call whose answer is lost in a World reset gets a retryable 503 and is not sent again", async () => {
    const world = worldFixture(["release-2", "release-1"], ["release-2", "release-1"]);
    try {
      const lost = world.container("release-2", "release-1", async (request) => {
        const response = await world.live.fetch(request);
        // The enqueue committed; another caller's reset loses the reply.
        if (request.method === "POST") throw new Error("remote exception: stale Worker version");
        return response;
      });
      const response = await lost();
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(world.messages()).toBe(1);
    } finally {
      world.close();
    }
  });

  test("a container of any other release is answered as before, and the World object is not reset", async () => {
    const world = worldFixture(["release-3", "release-2"], ["release-3", "release-2"]);
    try {
      for (const [release, previous] of [["release-1", undefined], ["release-9", "release-8"]] as const) {
        expect((await world.container(release, previous)()).status).toBe(200);
      }
      expect(world.resets).toEqual([]);
      expect(world.messages()).toBe(2);
    } finally {
      world.close();
    }
  });

  test("a World object that does not answer holds a call 30 seconds, then the container gets a retryable 503", async () => {
    const world = worldFixture(["release-2", "release-1"], ["release-2", "release-1"]);
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const pending = world.container("release-2", "release-1", () => new Promise<Response>(() => {}))();
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(Date.now() - started).toBe(30_000);
      expect(world.messages()).toBe(0);
    } finally {
      vi.useRealTimers();
      world.close();
    }
  });

  test("a container waits 30 seconds for a World object that keeps coming back on the release before, then gets a retryable 503", async () => {
    const world = worldFixture(["release-1"], ["release-1"]);
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const pending = world.container("release-2", "release-1")();
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(Date.now() - started).toBe(30_000);
      expect(world.messages()).toBe(0);
    } finally {
      vi.useRealTimers();
      world.close();
    }
  });
});

describe("World deliveries after a deploy", () => {
  const origin = "https://eden-eve-preview.account.workers.dev";
  const instance = `${IDENTITY.stableContainerInstanceName}:dep-a`;
  const { encode } = createRequire(
    import.meta.resolve("@moinulmoin/eden-world-cloudflare"),
  )("cbor-x") as { encode(value: unknown): Uint8Array };

  /** The World object on release-2, and one Container object that Cloudflare moves between releases. */
  function deliveryFixture(runtime: FakeContainerRuntime) {
    const sql = new NodeSqliteAdapter();
    const background: Promise<void>[] = [];
    const shared = {
      EVE_PUBLIC_ORIGIN: origin,
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EDEN_EVE_DEPLOYMENT_ID: "dep-a",
      EDEN_EVE_DEPLOYMENTS: JSON.stringify({ "dep-a": { image: "eve", generationId: IDENTITY.generationId } }),
      EDEN_EVE_WORLD_CLOUDFLARE: true,
    };
    const stored = new Map<string, unknown>([["eden.eve.host.started-image", CURRENT_IMAGE]]);
    const world: EdenWorldDurableObject = new EdenWorldDurableObject({
      storage: {
        sql,
        transactionSync: sql.transactionSync.bind(sql),
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
      },
      blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
      waitUntil: (promise: Promise<void>) => { background.push(promise); },
    } as never, {
      ...shared,
      EDEN_EVE_RELEASE_ID: "release-2",
      EDEN_EVE_PREVIOUS_RELEASE_ID: "release-1",
      EVE_CONTAINER: { getByName: () => fixture.container },
      EDEN_WORLD: { getByName: () => world },
    } as never);
    const containerOn = (release: string, previous: string | undefined, image: string): EveHostDurableContainer => {
      runtime.images.eve = image;
      return hostContainer(stored, runtime, undefined, {
        deploymentId: "dep-a",
        instance,
        env: {
          ...shared,
          EDEN_EVE_RELEASE_ID: release,
          ...(previous === undefined ? {} : { EDEN_EVE_PREVIOUS_RELEASE_ID: previous }),
          EVE_CONTAINER: { idFromName: (name: string) => name },
          EDEN_WORLD: { getByName: () => world },
        },
      });
    };
    const fixture = {
      world,
      container: containerOn("release-1", undefined, OLD_IMAGE),
      /** Cloudflare moves the Container object to the new release. */
      moveContainer: () => { fixture.container = containerOn("release-2", "release-1", CURRENT_IMAGE); },
      async deliver() {
        await world.alarm();
        await Promise.all(background.splice(0));
      },
      enqueue: () => world.fetch(new Request(`${origin}/__eden/world/rpc`, {
        method: "POST",
        body: encode({ op: "queue.enqueue", args: ["workflow", { runId: "proof" }, { deploymentId: "dep-a" }] }) as Uint8Array<ArrayBuffer>,
      })),
      message: () => sql.exec("SELECT completed,attempt FROM workflow_queue_messages").toArray()[0],
      openClaims: () => sql.exec("SELECT COUNT(*) AS n FROM workflow_delivery_claims WHERE settled=0").toArray()[0]?.n,
      close: () => sql.close(),
    };
    return fixture;
  }

  test("a queued step is not run by a Container object still on the replaced release; it stays queued and runs on the new image once the object has moved", async () => {
    // The new release already started its container; the object came back on the old code.
    const runtime = fakeContainerRuntime({ running: true, inspectImage: CURRENT_IMAGE });
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = deliveryFixture(runtime);
    try {
      await fixture.enqueue();
      await fixture.deliver();
      expect(runtime.state.timeline).toEqual([]);
      expect(runtime.state.image).toBe(CURRENT_IMAGE);
      expect(fixture.message()).toEqual({ completed: 0, attempt: 2 });
      expect(fixture.openClaims()).toBe(0);

      fixture.moveContainer();
      vi.setSystemTime(Date.now() + 1_000);
      await fixture.deliver();
      expect(runtime.state.timeline).toEqual(["health", "forward"]);
      expect(runtime.state.destroyCalls).toBe(0);
      expect(fixture.message()).toEqual({ completed: 1, attempt: 3 });
      expect(fixture.openClaims()).toBe(0);
    } finally {
      vi.useRealTimers();
      fixture.close();
    }
  });

  test("a file transfer from the new release's World is refused by a Container object still on the replaced release", async () => {
    const runtime = fakeContainerRuntime({ running: true, inspectImage: CURRENT_IMAGE });
    const fixture = deliveryFixture(runtime);
    try {
      const world = { "x-eden-eve-release-id": "release-2", "x-eden-eve-previous-release-id": "release-1" };
      await expect(fixture.container.importSandboxSessions("dep-old", "dep-a", "transfer", "session", world))
        .rejects.toThrow("on the release before the World object's");
      expect(runtime.state.timeline).toEqual([]);
    } finally {
      fixture.close();
    }
  });
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
      EDEN_EVE_RELEASE_ID: IDENTITY.deploymentId,
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
          "x-vqs-message-id": "attacker-message",
          "x-vqs-message-attempt": "1",
          "x-vqs-queue-name": "attacker-queue",
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
    expect(upstream.headers.get("x-vqs-message-id")).toBeNull();
    expect(upstream.headers.get("x-vqs-message-attempt")).toBeNull();
    expect(upstream.headers.get("x-vqs-queue-name")).toBeNull();
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
      "https://eden-eve-preview.account.workers.dev/eve/v1/health",
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

  test.each([
    new Error("container transport failed"),
    Object.assign(new Error("transient infrastructure failure"), { retryable: true }),
    "stale Worker version",
  ])("does not replay POST requests after their transport fails: %s", async (error) => {
    const upstreamFetch = vi.fn(async (request: Request) => {
      if (request.method === "GET") return new Response("synchronized");
      expect(await request.text()).toBe("non-idempotent-body");
      throw error;
    });
    const getByName = vi.fn(() => ({ fetch: upstreamFetch }));
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    await expect(worker.fetch(new Request("https://client.invalid/write", {
      method: "POST",
      body: "non-idempotent-body",
    }), { EVE_CONTAINER: { getByName } })).rejects.toBe(error);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(getByName).toHaveBeenCalledTimes(1);
  });

  test.each([
    new Error("health transport failed"),
    Object.assign(new Error("transient infrastructure failure"), { retryable: true }),
  ])("does not send an upload when version synchronization fails: %s", async (error) => {
    const methods: string[] = [];
    const upstreamFetch = vi.fn(async (request: Request) => {
      methods.push(request.method);
      throw error;
    });
    const getByName = vi.fn(() => ({ fetch: upstreamFetch }));
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    await expect(worker.fetch(new Request("https://client.invalid/write", {
      method: "POST",
      body: "non-idempotent-body",
    }), { EVE_CONTAINER: { getByName } })).rejects.toBe(error);
    expect(methods).toEqual(["GET"]);
    expect(getByName).toHaveBeenCalledTimes(1);
  });

  test("synchronizes before streaming the original body once without cloning it", async () => {
    const clone = vi.spyOn(Request.prototype, "clone").mockImplementation(() => {
      throw new Error("uploads must not be cloned");
    });
    const cancel = vi.fn();
    const methods: string[] = [];
    const original = new Request("https://client.invalid/write", {
      method: "POST",
      headers: {
        "content-length": "15",
        "content-type": "application/octet-stream",
      },
      body: "streamed-upload",
    });
    const upstreamFetch = vi.fn(async (request: Request) => {
      methods.push(request.method);
      expect(request.headers.get("x-eden-eve-deployment-id")).toBe(
        IDENTITY.deploymentId,
      );
      if (request.method === "GET") {
        expect(new URL(request.url).pathname).toBe(EVE_HOST_DEFAULTS.healthPath);
        expect(request.body).toBeNull();
        expect(request.headers.get("content-length")).toBeNull();
        expect(request.headers.get("content-type")).toBeNull();
        expect(original.bodyUsed).toBe(false);
        return new Response(new ReadableStream({ cancel }));
      }
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(request.headers.get("content-length")).toBe("15");
      expect(request.headers.get("content-type")).toBe("application/octet-stream");
      expect(await request.text()).toBe("streamed-upload");
      return new Response("uploaded");
    });
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    try {
      const response = await worker.fetch(original, {
        EVE_CONTAINER: { getByName: () => ({ fetch: upstreamFetch }) },
      });
      expect(await response.text()).toBe("uploaded");
      expect(methods).toEqual(["GET", "POST"]);
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  test.each([
    ["POST", "non-idempotent-body"],
    ["DELETE", undefined],
  ] as const)("a %s whose answer is lost in an object reset gets a retryable 503 and runs once", async (method, body) => {
    let ran = 0;
    const upstreamFetch = vi.fn(async (request: Request) => {
      if (request.method === "GET") return new Response("synchronized");
      ran += 1;
      // The request ran; another caller's reset loses the reply.
      throw new Error("remote exception: stale Worker version");
    });
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    const response = await worker.fetch(new Request("https://client.invalid/write", {
      method,
      ...(body === undefined ? {} : { body }),
    }), { EVE_CONTAINER: { getByName: () => ({ fetch: upstreamFetch }) } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(ran).toBe(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  test("does not send an upload when the health read before it is refused", async () => {
    const methods: string[] = [];
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    const response = await worker.fetch(new Request("https://client.invalid/write", {
      method: "POST",
      body: "non-idempotent-body",
    }), {
      EVE_CONTAINER: {
        getByName: () => ({
          fetch: async (request: Request) => {
            methods.push(request.method);
            return new Response("retired", { status: 503 });
          },
        }),
      },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("retired");
    expect(methods).toEqual(["GET"]);
  });

  test.each([0, 7_000])(
    "waits 30 seconds for an object still on the old release, then answers a retryable 503 without sending the body (each try takes %d ms)",
    async (tryMs) => {
      const startedAt: number[] = [];
      const upstreamFetch = vi.fn(async (request: Request) => {
        expect(request.method).toBe("GET");
        expect(new URL(request.url).pathname).toBe(EVE_HOST_DEFAULTS.healthPath);
        startedAt.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, tryMs));
        throw new Error("remote exception: stale Worker version");
      });
      const worker = createEveHostWorker({
        publicOrigin: "https://eden-eve-preview.account.workers.dev",
        ...IDENTITY,
      });
      vi.useFakeTimers();
      try {
        const started = Date.now();
        const pending = worker.fetch(new Request("https://client.invalid/write", {
          method: "POST",
          body: "non-idempotent-body",
        }), { EVE_CONTAINER: { getByName: () => ({ fetch: upstreamFetch }) } });
        await vi.runAllTimersAsync();
        const response = await pending;
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        // No try starts after 30 seconds; the last one may still be in flight.
        expect(Math.max(...startedAt) - started).toBeLessThanOrEqual(30_000);
        expect(Date.now() - started).toBeLessThanOrEqual(30_000 + tryMs);
        expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("no try starts after 30 seconds when the pauses run late", async () => {
    const startedAt: number[] = [];
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    vi.useFakeTimers();
    const fakeSetTimeout = globalThis.setTimeout;
    const late = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) =>
      fakeSetTimeout(() => {
        vi.setSystemTime(Date.now() + 15_000);
        callback();
      }, ms)) as never);
    try {
      const started = Date.now();
      const pending = worker.fetch(new Request("https://client.invalid/eve/v1/info"), {
        EVE_CONTAINER: {
          getByName: () => ({
            fetch: async () => {
              startedAt.push(Date.now() - started);
              throw new Error("remote exception: stale Worker version");
            },
          }),
        },
      });
      await vi.runAllTimersAsync();
      expect((await pending).status).toBe(503);
      expect(Math.max(...startedAt)).toBeLessThanOrEqual(30_000);
    } finally {
      late.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a retained version's object that cannot place this release gives the client a retryable 503", async () => {
    const current = hostContainer(new Map(), fakeContainerRuntime({ running: true, inspectImage: CURRENT_IMAGE }), undefined, {
      env: {
        EDEN_EVE_DEPLOYMENTS: JSON.stringify({
          [IDENTITY.deploymentId]: { image: "eve", generationId: IDENTITY.generationId },
          "dep-retained": { image: "eve-retained", generationId: "gen-retained" },
        }),
        EVE_CONTAINER: {
          idFromName: (name: string) => name,
          getByName: () => ({
            fetch: async () => new Response("Eden is switching versions. Retry the request.\n", { status: 503, headers: { "retry-after": "5" } }),
          }),
        } as never,
      },
    });
    (current as unknown as { ctx: { id: unknown } }).ctx.id = {
      equals: (other: string) => other !== IDENTITY.stableContainerInstanceName && other.includes(IDENTITY.deploymentId),
    };
    const response = await createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    }).fetch(new Request("https://client.invalid/eve/v1/health"), {
      EVE_CONTAINER: { getByName: () => ({ fetch: (request: Request) => current.fetch(new Request(request)) }) },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  test("one retained version still on the old release holds a request 30 seconds, not longer, before the retryable 503", async () => {
    const retainedFetch = vi.fn(async () => {
      throw new Error("remote exception: stale Worker version");
    });
    const current = hostContainer(new Map(), fakeContainerRuntime({ running: true, inspectImage: CURRENT_IMAGE }), undefined, {
      env: {
        EDEN_EVE_DEPLOYMENTS: JSON.stringify({
          [IDENTITY.deploymentId]: { image: "eve", generationId: IDENTITY.generationId },
          "dep-retained": { image: "eve-retained", generationId: "gen-retained" },
        }),
        EVE_CONTAINER: { idFromName: (name: string) => name, getByName: () => ({ fetch: retainedFetch }) } as never,
      },
    });
    // This object is the one named for the current version.
    (current as unknown as { ctx: { id: unknown } }).ctx.id = {
      equals: (other: string) => other !== IDENTITY.stableContainerInstanceName && other.includes(IDENTITY.deploymentId),
    };
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const pending = worker.fetch(new Request("https://client.invalid/write", { method: "POST", body: "{}" }), {
        EVE_CONTAINER: { getByName: () => ({ fetch: (request: Request) => current.fetch(new Request(request)) }) },
      });
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(Date.now() - started).toBe(30_000);
      // One call to the retained object for each try of the Worker.
      expect(retainedFetch.mock.calls.length).toBeLessThanOrEqual(13);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a request that meets an object on the old release is served once the object restarts on the new one", async () => {
    let attempts = 0;
    const getByName = vi.fn(() => ({
      fetch: async () => {
        attempts += 1;
        if (attempts <= 4) throw new Error("remote exception: stale Worker version");
        return new Response("eve");
      },
    }));
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    vi.useFakeTimers();
    try {
      const pending = worker.fetch(new Request("https://client.invalid/eve/v1/session/s/stream"), { EVE_CONTAINER: { getByName } });
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("eve");
      expect(attempts).toBe(5);
    } finally {
      vi.useRealTimers();
    }
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
          delete: async () => undefined,
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
            expect(request.headers.get("x-eden-eve-deployment-id")).toBe(
              IDENTITY.deploymentId,
            );
            expect(request.headers.get("x-eden-eve-generation-id")).toBe(
              IDENTITY.generationId,
            );
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

  test.each([false, true])(
    "a scheduled wake waits for an object on the old release (object stays old: %s)",
    async (secondAttemptFails) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = new Error("remote exception: stale Worker version");
      let attempts = 0;
      const wakeFetch = vi.fn(async (request: Request) => {
        attempts += 1;
        expect(request.url).toBe(
          "https://eden-eve-preview.account.workers.dev/eve/v1/health",
        );
        expect(request.headers.get("x-eden-eve-deployment-id")).toBe(
          IDENTITY.deploymentId,
        );
        expect(request.headers.get("x-eden-eve-generation-id")).toBe(
          IDENTITY.generationId,
        );
        if (attempts === 1 || secondAttemptFails) throw error;
        return new Response("awake");
      });
      const getByName = vi.fn(() => ({ fetch: wakeFetch }));
      const worker = createEveHostWorker({
        publicOrigin: "https://eden-eve-preview.account.workers.dev",
        ...IDENTITY,
        schedules: [{ name: "digest", cron: "0 9 * * 1-5" }],
      });
      const waited: Promise<unknown>[] = [];
      vi.useFakeTimers();
      try {
        worker.scheduled?.(
          { cron: "* * * * *", scheduledTime: Date.parse("2026-10-02T08:57:00Z") },
          { EVE_CONTAINER: { getByName } },
          { waitUntil: (task) => { waited.push(task); } },
        );
        await vi.runAllTimersAsync();
        const [wake] = await Promise.all(waited) as [Response];
        expect(waited).toHaveLength(1);
        expect(wake.status).toBe(secondAttemptFails ? 503 : 200);
        if (secondAttemptFails) {
          expect(errorSpy).toHaveBeenCalledExactlyOnceWith("The scheduled wake request failed:", "HTTP 503");
        } else {
          expect(wakeFetch).toHaveBeenCalledTimes(2);
          expect(errorSpy).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
        errorSpy.mockRestore();
      }
    },
  );

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
  test("aborts a stale DO before readiness, activity, forwarding, or storage writes", async () => {
    const stored = new Map<string, unknown>();
    const runtime = fakeContainerRuntime({ running: true, inspectImage: OLD_IMAGE });
    const alarms: number[] = [];
    const abort = vi.fn((reason?: string) => { throw new Error(reason); });
    const container = hostContainer(stored, runtime, alarms, { abort });
    await expect(container.fetch(new Request(
      "https://eden-eve-preview.account.workers.dev/eve/v1/info",
      { headers: { "x-eden-eve-deployment-id": "dep-current", "x-eden-eve-previous-release-id": IDENTITY.deploymentId } },
    ))).rejects.toThrow("stale Worker version");
    expect(abort).toHaveBeenCalledExactlyOnceWith("stale Worker version");
    expect(runtime.state.timeline).toEqual([]);
    expect(stored.size).toBe(0);
    expect(alarms).toEqual([]);
    expect(runtime.running).toBe(true);
  });

  test("requests that arrive together during an image update all get Eve's answer from one new container", async () => {
    const runtime = fakeContainerRuntime({ running: true, inspectImage: OLD_IMAGE, carryArchive: "session-files" });
    const object = hostContainer(new Map(), runtime);
    const responses = await Promise.all([1, 2, 3, 4].map(() => object.fetch(new Request(
      "https://eden-eve-preview.account.workers.dev/eve/v1/info",
      { headers: { "x-eden-eve-deployment-id": IDENTITY.deploymentId } },
    ))));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(runtime.state.timeline.filter((event) => event !== "health" && event !== "forward")).toEqual([
      "carry-out", "destroy", "start", "carry-in",
    ]);
    expect(runtime.lastStart?.image).toBe(CURRENT_IMAGE);
  });

  test("a request through a Worker of the replaced release gets Eve's answer, and the new object is not reset", async () => {
    const runtime = fakeContainerRuntime({ running: true, inspectImage: CURRENT_IMAGE });
    const abort = vi.fn((reason?: string) => { throw new Error(reason); });
    const object = hostContainer(new Map(), runtime, undefined, {
      abort,
      env: { EDEN_EVE_RELEASE_ID: "release-new", EDEN_EVE_PREVIOUS_RELEASE_ID: "release-old" },
    });
    const env = { EVE_CONTAINER: { getByName: () => ({ fetch: (request: Request) => object.fetch(new Request(request)) }) } };
    const worker = (releaseId: string) => createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
      releaseId,
    });

    for (const init of [{}, { method: "POST", body: "{}" }]) {
      const older = await worker("release-old").fetch(new Request("https://client.invalid/eve/v1/session", init), env);
      expect(older.status).toBe(200);
      expect(await older.json()).toEqual({ status: "ready" });
      expect(older.headers.get("x-eden-eve-release-id")).toBe("release-old");
      // Only a Worker of this release proves the deploy's health.
      expect(older.headers.get("x-eden-eve-started-deployment")).toBeNull();
    }
    const current = await worker("release-new").fetch(new Request("https://client.invalid/eve/v1/health"), env);
    expect(current.headers.get("x-eden-eve-started-deployment")).toBe("release-new");
    expect(abort).not.toHaveBeenCalled();

    // A release this object cannot place gets a retryable answer and no
    // reset, with or without a claim about some other release.
    for (const previous of [undefined, "release-older"]) {
      const unknown = await object.fetch(new Request("https://client.invalid/eve/v1/health", {
        headers: {
          "x-eden-eve-deployment-id": IDENTITY.deploymentId,
          "x-eden-eve-release-id": "release-unknown",
          ...(previous === undefined ? {} : { "x-eden-eve-previous-release-id": previous }),
        },
      }));
      expect(unknown.status).toBe(503);
      expect(unknown.headers.get("retry-after")).toBe("5");
    }
    expect(abort).not.toHaveBeenCalled();

    // Only the release that names this one as the release it replaces resets it.
    await expect(object.fetch(new Request("https://client.invalid/eve/v1/health", {
      headers: {
        "x-eden-eve-deployment-id": IDENTITY.deploymentId,
        "x-eden-eve-release-id": "release-next",
        "x-eden-eve-previous-release-id": "release-new",
      },
    }))).rejects.toThrow("stale Worker version");
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test("without deployment affinity a Worker of the replaced release gets a retryable 503, and nothing reaches the new image", async () => {
    const runtime = fakeContainerRuntime({ running: true, inspectImage: CURRENT_IMAGE });
    const abort = vi.fn((reason?: string) => { throw new Error(reason); });
    // Every release is its own deployment without affinity.
    const object = hostContainer(new Map(), runtime, undefined, {
      abort,
      deploymentId: "release-new",
      env: { EDEN_EVE_RELEASE_ID: "release-new", EDEN_EVE_PREVIOUS_RELEASE_ID: "release-old" },
    });
    const env = { EVE_CONTAINER: { getByName: () => ({ fetch: (request: Request) => object.fetch(new Request(request)) }) } };
    for (const init of [{}, { method: "POST", body: "{}" }]) {
      const response = await createEveHostWorker({
        publicOrigin: "https://eden-eve-preview.account.workers.dev",
        ...IDENTITY,
        deploymentId: "release-old",
        releaseId: "release-old",
      }).fetch(new Request("https://client.invalid/eve/v1/session", init), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
    }
    expect(abort).not.toHaveBeenCalled();
    expect(runtime.state.timeline).toEqual([]);
  });

  test("a Worker of the replaced release that names a version no longer routed gets a retryable 503", async () => {
    const runtime = fakeContainerRuntime({ running: true, inspectImage: CURRENT_IMAGE });
    const abort = vi.fn((reason?: string) => { throw new Error(reason); });
    const object = hostContainer(new Map(), runtime, undefined, {
      abort,
      env: {
        EDEN_EVE_RELEASE_ID: "release-new",
        EDEN_EVE_PREVIOUS_RELEASE_ID: "release-old",
        EDEN_EVE_DEPLOYMENTS: JSON.stringify({ "dep-new": { image: "eve", generationId: "gen-new" } }),
      },
    });
    const response = await createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
      releaseId: "release-old",
    }).fetch(new Request("https://client.invalid/eve/v1/session", { method: "POST", body: "{}" }), {
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EVE_CONTAINER: { getByName: () => ({ fetch: (request: Request) => object.fetch(new Request(request)) }) },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(abort).not.toHaveBeenCalled();
    expect(runtime.state.timeline).toEqual([]);
  });

  test("a current Worker resets the old DO, carries files, and only then echoes its started deployment", async () => {
    const stored = new Map<string, unknown>();
    const runtime = fakeContainerRuntime({
      running: true,
      inspectImage: OLD_IMAGE,
      carryArchive: "persistent-session-files",
    });
    runtime.images.eve = OLD_IMAGE;
    const abort = vi.fn((reason?: string) => {
      expect(runtime.state.timeline).toEqual([]);
      expect(runtime.running).toBe(true);
      runtime.images.eve = CURRENT_IMAGE;
      active = hostContainer(stored, runtime);
      throw new Error(`remote exception: ${reason}`);
    });
    const stale = hostContainer(stored, runtime, undefined, {
      deploymentId: "dep-old",
      abort,
    });
    let active = stale;
    const prior = await stale.fetch(new Request("https://client.invalid/eve/v1/info", {
      headers: { "x-eden-eve-deployment-id": "dep-old" },
    }));
    expect(prior.headers.get("x-eden-eve-started-deployment")).toBe("dep-old");
    expect(runtime.state.destroyCalls).toBe(0);
    runtime.state.timeline.length = 0;

    const payloads: Uint8Array[] = [];
    const port = runtime.getTcpPort();
    vi.spyOn(runtime, "getTcpPort").mockReturnValue({
      fetch: async (request) => {
        if (request.method === "POST") {
          payloads.push(new Uint8Array(await request.arrayBuffer()));
        }
        return port.fetch(request);
      },
    });
    const getByName = vi.fn(() => {
      const object = active;
      return {
        // Transport the original upload only after the bodyless version
        // handshake has reset the stale instance and loaded current code.
        fetch: async (request: Request) => object.fetch(new Request(request)),
      };
    });
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    const bytes = new Uint8Array([0, 255, 1, 2, 3]);
    const response = await worker.fetch(new Request("https://client.invalid/write", {
      method: "POST",
      headers: { "x-eden-eve-deployment-id": "spoofed-deployment" },
      body: bytes,
    }), { EVE_CONTAINER: { getByName }, EDEN_EVE_PREVIOUS_RELEASE_ID: "dep-old" });

    expect(abort).toHaveBeenCalledExactlyOnceWith("stale Worker version");
    expect(getByName).toHaveBeenCalledTimes(2);
    expect(active).not.toBe(stale);
    expect(runtime.state.timeline).toEqual([
      "carry-out", "destroy", "start", "health", "carry-in", "health", "forward",
    ]);
    expect(runtime.lastStart?.image).toBe(CURRENT_IMAGE);
    expect(runtime.state.carryInPayloads).toEqual(["persistent-session-files"]);
    expect(payloads).toEqual([bytes]);
    expect(response.headers.get("x-eden-eve-started-deployment")).toBe(
      IDENTITY.deploymentId,
    );
  });

  test("an old container that has not stopped after 10 seconds gets the client a retryable 503, and nothing is served from the old image", async () => {
    const runtime = fakeContainerRuntime({ running: true, inspectImage: OLD_IMAGE });
    let stops = false;
    vi.spyOn(runtime, "destroy").mockImplementation(async () => {
      runtime.state.timeline.push("destroy");
      if (stops) runtime.state.running = false;
    });
    const object = hostContainer(new Map(), runtime);
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      ...IDENTITY,
    });
    const env = { EVE_CONTAINER: { getByName: () => ({ fetch: (request: Request) => object.fetch(new Request(request)) }) } };
    vi.useFakeTimers();
    try {
      for (const init of [{}, { method: "POST", body: "{}" }]) {
        const started = Date.now();
        const pending = worker.fetch(new Request("https://client.invalid/eve/v1/session", init), env);
        await vi.runAllTimersAsync();
        const response = await pending;
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        expect(response.headers.get("x-eden-eve-started-deployment")).toBeNull();
        expect(Date.now() - started).toBe(10_000);
      }
      expect(runtime.state.timeline).toEqual(["carry-out", "destroy", "carry-out", "destroy"]);

      stops = true;
      const pending = worker.fetch(new Request("https://client.invalid/eve/v1/session"), env);
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.headers.get("x-eden-eve-started-deployment")).toBe(IDENTITY.deploymentId);
      expect(runtime.lastStart?.image).toBe(CURRENT_IMAGE);
    } finally {
      vi.useRealTimers();
    }
  });

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

  test("keeps same-deployment, headerless, and loopback requests on the current DO", async () => {
    const stored = new Map<string, unknown>();
    const runtime = fakeContainerRuntime();
    const abort = vi.fn((reason?: string) => { throw new Error(reason); });
    const container = hostContainer(stored, runtime, undefined, { abort });
    const response = await container.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info", {
        headers: { "x-eden-eve-deployment-id": IDENTITY.deploymentId },
      }),
    );
    expect(response.headers.get("x-eden-eve-started-deployment")).toBe(
      IDENTITY.deploymentId,
    );

    const headerless = await container.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
    );
    expect(headerless.headers.get("x-eden-eve-started-deployment")).toBeNull();
    const loopback = await container.loopbackFetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info", {
        headers: { "x-eden-eve-deployment-id": "dep-other" },
      }),
    );
    expect(loopback.headers.get("x-eden-eve-started-deployment")).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    expect(runtime.state.destroyCalls).toBe(0);
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

  test("wakes from the image with the carried files when the stored snapshot is gone", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const carryId = "carry-at-sleep";
    const stored = new Map<string, unknown>([
      ["eden.eve.host.workspace-snapshot", {
        id: "snap-expired",
        image: CURRENT_IMAGE,
        at: 0,
      }],
      [CARRY_META_KEY, { id: carryId, chunks: 1, bytes: 18, at: 0 }],
      [`${CARRY_META_KEY}.${carryId}.0`, new TextEncoder().encode("conversation-files")],
    ]);
    const runtime = fakeContainerRuntime({ missingSnapshotIds: ["snap-expired"] });
    const container = hostContainer(stored, runtime);

    const response = await container.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
    );

    expect(response.status).toBe(200);
    expect(runtime.state.running).toBe(true);
    expect(runtime.lastStart).toEqual({ image: CURRENT_IMAGE });
    expect(runtime.state.carryInPayloads).toEqual(["conversation-files"]);
    expect(stored.has("eden.eve.host.workspace-snapshot")).toBe(false);
    errorSpy.mockRestore();
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

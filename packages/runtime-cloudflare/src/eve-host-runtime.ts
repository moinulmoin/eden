import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { WorldCore } from "@moinulmoin/eden-world-cloudflare/core";

import {
  EVE_HOST_DEFAULTS,
  EVE_HOST_SLEEP_SNAPSHOT_MARGIN_MS,
  EVE_SCHEDULE_WAKE_LEAD_MS,
  parseEveSleepAfterMs,
  EveHostError,
  assertNonEmpty,
  assertStableOrigin,
  createEveReadinessGate,
  createTrustedEveRequest,
  eveScheduleCronFiresWithin,
  readProtectedRuntimeVariables,
  WORKER_NAME_PATTERN,
  type EveHostContainerEnvironment,
  type EveHostForwardingMetadata,
  type EveHostReadinessEvidence,
  type EveScheduleCronEntry,
  isEveWorkflowInternalRoute,
  type EveReadinessGate,
} from "./eve-host.js";

const EVE_CLOUDFLARE_CONTAINERS_CA_PATH =
  "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/**
 * Cloudflare's durable_object containers expose `/dev/kvm`, which makes Eve's
 * `DefaultSandbox` pick microsandbox at runtime, while Eden's isolated builder
 * (no KVM, no Docker daemon) prepared the just-bash template — every sandbox
 * tool then fails with a provider mismatch. Hiding the device before Eve
 * starts keeps runtime selection equal to the build's. Same Eve start
 * command as the image entrypoint.
 */
const EVE_HOST_ENTRYPOINT = Object.freeze([
  "/bin/sh",
  "-c",
  "rm -f /dev/kvm; cd /workspace && exec ./node_modules/.bin/eve start --host 0.0.0.0 --port 8080",
]);

/**
 * The native `ctx.container` surface under `scheduling_policy:
 * "durable_object"`. Declared structurally so the emitted declarations never
 * depend on a specific `@cloudflare/workers-types` revision.
 */
interface EveContainerPort {
  fetch(request: Request): Promise<Response>;
}

/** Structural slice of `ExecProcess` from `@cloudflare/workers-types`. */
interface EveContainerExecProcess {
  readonly exitCode: Promise<number>;
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
}

interface EveContainerRuntime {
  readonly running: boolean;
  readonly images: Record<string, string | undefined>;
  start(options: {
    readonly image?: string;
    readonly containerSnapshot?: { readonly id: string };
    readonly instance: string;
    readonly enableInternet: boolean;
    readonly env: Record<string, string>;
    readonly entrypoint: readonly string[];
  }): void;
  monitor(): Promise<void>;
  destroy(error?: unknown): Promise<void>;
  inspect(): Promise<{ readonly image?: string } | null>;
  snapshotContainer(options: {
    readonly name: string;
  }): Promise<{ readonly id: string }>;
  setInactivityTimeout(ms: number): Promise<void> | void;
  interceptOutboundHttps(hostname: string, entrypoint: unknown): Promise<void> | void;
  getTcpPort(port: number): EveContainerPort;
  exec(
    command: readonly string[],
    options?: {
      readonly stdin?: ReadableStream;
      readonly stdout?: "pipe" | "ignore";
      readonly stderr?: "pipe" | "ignore" | "combined";
    },
  ): Promise<EveContainerExecProcess>;
}

interface EveContainerContext {
  readonly container?: EveContainerRuntime | undefined;
  readonly storage: {
    get<T>(key: string): Promise<T | undefined> | T | undefined;
    put(key: string, value: unknown): Promise<void> | void;
    delete(key: string): Promise<boolean> | boolean;
    setAlarm(ms: number): Promise<void> | void;
    sql?: { exec(query: string): unknown };
    transactionSync?(callback: () => void): unknown;
  };
  readonly exports?: Record<string, unknown> | undefined;
  blockConcurrencyWhile(callback: () => Promise<void>): void | Promise<void>;
}

/** Durable Object storage keys owned by `EveHostDurableContainer`. */
const EVE_HOST_CONTAINER_ACTIVITY_KEY =
  "eden.eve.host.last-activity-at";
const EVE_HOST_CONTAINER_SNAPSHOT_KEY =
  "eden.eve.host.workspace-snapshot";
const EVE_HOST_CONTAINER_SNAPSHOT_ATTEMPTS_KEY =
  "eden.eve.host.snapshot-attempts";
/**
 * The image the current container was started with. `inspect()` reports an
 * empty image for a container restored from a snapshot (and while one is
 * starting), so update detection falls back to this record.
 */
const EVE_HOST_CONTAINER_STARTED_IMAGE_KEY =
  "eden.eve.host.started-image";

/**
 * Sandbox-session carry keys. The meta record names the active carry; its
 * archive streams into `<chunkPrefix>.<carryId>.<index>` values so no single
 * key+value pair approaches the SQLite-backed 2 MiB storage limit and the
 * whole archive never sits in isolate memory (128 MB limit).
 */
const EVE_HOST_SANDBOX_CARRY_KEY = "eden.eve.host.sandbox-carry";
const EVE_HOST_SANDBOX_CARRY_CHUNK_PREFIX = "eden.eve.host.sandbox-carry";
/** The only `/workspace` subtree carried across an image update. */
const EVE_HOST_SANDBOX_CARRY_SOURCE = "/workspace/.eve/sandbox-cache/just-bash";
/**
 * Carry archive limits. `chunkBytes` stays safely under the per-key limit;
 * `maxBytes` caps the compressed archive (tests shrink both).
 */
export const EVE_HOST_CARRY_LIMITS = {
  chunkBytes: 1024 * 1024,
  maxBytes: 1024 * 1024 * 1024,
};

/** Meta record for the active carried sandbox-session archive. */
interface EveStoredSandboxCarry {
  readonly id: string;
  readonly chunks: number;
  readonly bytes: number;
  readonly at: number;
}

/** Snapshot attempts the alarm retries before destroying anyway so a stuck
 * snapshot path never keeps billing alive forever. */
const EVE_HOST_SNAPSHOT_MAX_ATTEMPTS = 3;

interface EveStoredContainerSnapshot {
  readonly id: string;
  readonly image: string;
  readonly at: number;
}

interface EveContainerLoopbackNamespace {
  getByName(name: string): {
    loopbackFetch(request: Request): Promise<Response>;
  };
}

/** The deployment's single SQLite-backed Workflow World. */
export class EdenWorldDurableObject {
  private readonly core: WorldCore;

  constructor(ctx: DurableObjectState, env: EveHostContainerEnvironment) {
    this.core = new WorldCore({
      sql: {
        exec: ctx.storage.sql.exec.bind(ctx.storage.sql),
        transactionSync: ctx.storage.transactionSync.bind(ctx.storage),
      },
      scheduleAlarm: async (atMs) => {
        if (atMs === null) await ctx.storage.deleteAlarm();
        else await ctx.storage.setAlarm(atMs);
      },
      delivery: {
        deliver: async (message) => {
          const origin = env.EVE_PUBLIC_ORIGIN;
          const instance = env.EVE_CONTAINER_INSTANCE_NAME;
          if (typeof origin !== "string" || typeof instance !== "string") {
            throw new Error("The World queue Container identity is unavailable.");
          }
          const namespace = env.EVE_CONTAINER as EveContainerLoopbackNamespace;
          const response = await namespace.getByName(instance).loopbackFetch(
            new Request(new URL(`/.well-known/workflow/v1/${message.path}`, origin), {
              method: "POST",
              headers: {
                ...message.headers,
                "content-type": "application/json",
                "x-vqs-queue-name": message.queueName,
                "x-vqs-message-id": message.messageId,
                "x-vqs-message-attempt": String(message.attempt),
              },
              body: message.body as Uint8Array<ArrayBuffer>,
            }),
          );
          // Body transport errors must remain retryable; an HTTP status alone
          // is not an acknowledgement of a streamed Container response.
          const body = await response.text();
          let result: { timeoutSeconds?: number } | null = null;
          try {
            result = JSON.parse(body) as { timeoutSeconds?: number };
          } catch {
            // World-local also accepts successful non-JSON responses.
          }
          const timeout = result?.timeoutSeconds;
          return {
            ok: response.ok && timeout === undefined,
            ...(typeof timeout === "number" && timeout >= 0
              ? { retryAfterMs: timeout * 1_000 }
              : {}),
          };
        },
      },
    });
    void ctx.blockConcurrencyWhile(async () => this.core.migrate());
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const result = await this.core.handleRpc(new Uint8Array(await request.arrayBuffer()));
    return new Response(result as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": "application/cbor" },
    });
  }

  async alarm(): Promise<void> {
    await this.core.runAlarm();
  }
}

/**
 * Delivers the container's own HTTPS requests to its public workers.dev
 * origin back into the deployment without crossing the public edge. The
 * Workflow local World posts queue deliveries to `WORKFLOW_LOCAL_BASE_URL`,
 * which must remain the public origin so Eve's externally visible callback
 * URLs stay correct; the DO registers an outbound-HTTPS intercept for that
 * hostname aimed at `EveHostLoopback`, and this function routes the request:
 * non-public hosts egress plainly, `/__eden/world/rpc` reaches the World
 * Durable Object, and everything else re-enters the container over the
 * internal port so the public Worker path can keep refusing the
 * unauthenticated queue endpoints.
 */
export async function routeEveOutboundRequest(
  request: Request,
  env: EveHostContainerEnvironment,
): Promise<Response> {
  const publicOrigin = env.EVE_PUBLIC_ORIGIN;
  const instanceName = env.EVE_CONTAINER_INSTANCE_NAME;
  if (
    typeof publicOrigin !== "string" ||
    typeof instanceName !== "string"
  ) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The container loopback identity is unavailable to the outbound handler.",
    );
  }
  assertStableOrigin(publicOrigin);
  assertNonEmpty(instanceName, "Container instance name");
  const hostname = new URL(request.url).hostname;
  if (hostname !== new URL(publicOrigin).hostname) {
    return fetch(request);
  }
  if (new URL(request.url).pathname === "/__eden/world/rpc") {
    const world = env.EDEN_WORLD as {
      idFromName(name: string): unknown;
      get(id: unknown): { fetch(request: Request): Promise<Response> };
    } | undefined;
    if (world === undefined) return new Response(null, { status: 404 });
    return world.get(world.idFromName("world")).fetch(request);
  }
  const namespace = env.EVE_CONTAINER as
    | EveContainerLoopbackNamespace
    | undefined;
  if (namespace === undefined) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The configured Container binding is unavailable to the outbound handler.",
    );
  }
  return namespace.getByName(instanceName).loopbackFetch(request);
}

/**
 * This module is the only Eve-host surface that depends on provider runtime
 * packages. It is bundled into the deployed Worker directory instead of the
 * package's public declaration surface, so plain-Node consumers never load
 * `cloudflare:workers`-dependent code.
 */

/**
 * The WorkerEntrypoint the container's intercepted outbound HTTPS traffic is
 * delivered to (registered by `EveHostDurableContainer` right after every
 * `ctx.container.start()`). Props carry the DO instance name because
 * entrypoint props cannot hold a Fetcher.
 */
export class EveHostLoopback extends WorkerEntrypoint<EveHostContainerEnvironment> {
  override async fetch(request: Request): Promise<Response> {
    return routeEveOutboundRequest(request, this.env);
  }
}

/**
 * The Eve host Durable Object. It drives `ctx.container` directly: the
 * image is selected at `start()` from this Worker version's `images.eve`
 * entry, the writable filesystem is preserved across sleep via a container
 * snapshot, and an update restarts the instance when `inspect()` shows the
 * running image predates the configured one.
 */
export class EveHostDurableContainer extends DurableObject<EveHostContainerEnvironment> {
  /** Evidence is cached only while the container it was proven on keeps running. */
  private readinessEvidence: EveHostReadinessEvidence | undefined;
  /** True once the running container's image was proven to equal `images.eve`. */
  private imageVerified = false;
  /**
   * Bumped whenever the Container stops or is reset. Readiness work captures
   * the epoch it started under and may only cache evidence if no stop
   * happened in between.
   */
  private readinessEpoch = 0;
  private monitorAttached = false;
  /** Serializes sandbox-session carry-outs on this Durable Object instance. */
  private carryOutQueue: Promise<void> = Promise.resolve();
  /** True only while the last start was fresh from `images.eve`, not a snapshot. */
  private pendingCarryRestore = false;
  /** Shared single-flight carry restore for the current container generation. */
  private carryRestorePromise: Promise<void> | undefined;
  private readonly envVars: Record<string, string>;
  private readonly sleepAfterMs: number;
  private readonly readiness: EveReadinessGate;

  constructor(
    ctx: DurableObjectState,
    env: EveHostContainerEnvironment,
  ) {
    super(ctx, env);
    const publicOrigin = env.EVE_PUBLIC_ORIGIN;
    const deploymentId = env.EDEN_EVE_DEPLOYMENT_ID;
    const generationId = env.EDEN_EVE_GENERATION_ID;
    if (
      publicOrigin === undefined ||
      deploymentId === undefined ||
      generationId === undefined
    ) {
      throw new EveHostError(
        "HOST_ORIGIN_UNAVAILABLE",
        "The verified public origin and deployment identity must exist before Eve starts.",
      );
    }
    assertStableOrigin(publicOrigin);
    assertNonEmpty(deploymentId, "deployment identity");
    const runtimeEnv = readProtectedRuntimeVariables(env);
    this.envVars = {
      ...runtimeEnv,
      HOST: "0.0.0.0",
      NITRO_HOST: "0.0.0.0",
      PORT: String(EVE_HOST_DEFAULTS.internalPort),
      NITRO_PORT: String(EVE_HOST_DEFAULTS.internalPort),
      NODE_ENV: "production",
      WORKFLOW_LOCAL_BASE_URL: publicOrigin,
      EDEN_EVE_DEPLOYMENT_ID: deploymentId,
      ...(env.EDEN_EVE_WORLD_CLOUDFLARE
        ? {
            EDEN_WORLD_URL: `${publicOrigin}/__eden/world/rpc`,
            CBOR_NATIVE_ACCELERATION_DISABLED: "true",
          }
        : {}),
      EDEN_EVE_GENERATION_ID: generationId,
      // Trust the runtime-mounted Cloudflare Containers CA so the intercepted
      // HTTPS deliveries to the public origin below complete TLS.
      NODE_EXTRA_CA_CERTS: EVE_CLOUDFLARE_CONTAINERS_CA_PATH,
      ...(env.EDEN_EVE_RUNTIME_REVISION === undefined
        ? {}
        : { EDEN_EVE_RUNTIME_REVISION: env.EDEN_EVE_RUNTIME_REVISION }),
    };
    this.sleepAfterMs = parseEveSleepAfterMs(
      env.EDEN_EVE_CONTAINER_SLEEP_AFTER ?? EVE_HOST_DEFAULTS.sleepAfter,
    );
    this.readiness = createEveReadinessGate({
      start: async () => {
        await this.ensureContainerStarted();
      },
      healthFetch: (request) => {
        const container = this.containerRuntime();
        if (container === undefined) {
          throw new EveHostError(
            "HOST_READINESS_UNPROVEN",
            "The Container runtime is unavailable.",
          );
        }
        const url = new URL(request.url);
        return container
          .getTcpPort(EVE_HOST_DEFAULTS.internalPort)
          .fetch(
            new Request(`http://container${url.pathname}${url.search}`, request),
          );
      },
    });
    const runtime = this.containerRuntime();
    if (runtime?.running === true) {
      // DO restarts lose the inactivity timeout; the monitor for this
      // container generation is also gone, so both are re-attached here.
      this.ctx.blockConcurrencyWhile(async () => {
        await runtime.setInactivityTimeout(this.inactivityTimeoutMs);
        this.attachMonitor(runtime);
      });
    }
  }

  private containerRuntime(): EveContainerRuntime | undefined {
    return (this.ctx as EveContainerContext).container;
  }

  /** Container lifetime the platform keeps after the DO goes inactive: long
   * enough for the idle alarm to snapshot first, within Cloudflare's 6 h cap. */
  private get inactivityTimeoutMs(): number {
    return this.sleepAfterMs + EVE_HOST_SLEEP_SNAPSHOT_MARGIN_MS;
  }

  private attachMonitor(runtime: EveContainerRuntime): void {
    if (this.monitorAttached) return;
    this.monitorAttached = true;
    runtime.monitor().then(
      () => {
        this.monitorAttached = false;
        this.recordContainerStopped();
      },
      () => {
        this.monitorAttached = false;
        this.recordContainerStopped();
      },
    );
  }

  private recordContainerStopped(): void {
    this.readinessEpoch += 1;
    this.readinessEvidence = undefined;
    this.imageVerified = false;
    this.pendingCarryRestore = false;
    this.carryRestorePromise = undefined;
    this.readiness.reset();
  }

  /** Routes the container's own requests to its public origin back inside. */
  private async registerLoopbackIntercept(
    runtime: EveContainerRuntime,
  ): Promise<void> {
    const exportsMap = (this.ctx as EveContainerContext).exports;
    const entryFactory = exportsMap?.["EveHostLoopback"];
    if (typeof entryFactory !== "function") return;
    const entrypoint = (
      entryFactory as (options: {
        props: Record<string, string>;
      }) => unknown
    )({ props: {} });
    await runtime.interceptOutboundHttps(
      new URL(this.env.EVE_PUBLIC_ORIGIN ?? "").hostname,
      entrypoint,
    );
  }

  /**
   * Records request activity and arms the sleep alarm at
   * `lastActivityAt + sleepAfter`. The alarm — not the inactivity timeout —
   * is what snapshots the writable filesystem before the container stops.
   */
  private async touchActivity(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put(EVE_HOST_CONTAINER_ACTIVITY_KEY, now);
    await this.ctx.storage.setAlarm(now + this.sleepAfterMs);
  }

  /**
   * Starts the container when it is not running. A stored workspace snapshot
   * is restored only when it was captured from the exact image this Worker
   * version configures — restoring an older snapshot silently runs the
   * previous image — so after an image update the container starts fresh and
   * the readiness path restores the carried sandbox sessions instead.
   */
  private async ensureContainerStarted(): Promise<void> {
    const runtime = this.containerRuntime();
    if (runtime === undefined) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Container runtime is unavailable on this Durable Object.",
      );
    }
    if (runtime.running) return;
    const expectedImage = runtime.images["eve"];
    if (expectedImage === undefined) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The configured Container image is unavailable to this Worker version.",
      );
    }
    const storedSnapshot = await this.ctx.storage.get<EveStoredContainerSnapshot>(
      EVE_HOST_CONTAINER_SNAPSHOT_KEY,
    );
    const snapshotId = storedSnapshot !== undefined &&
        storedSnapshot.image === expectedImage
      ? storedSnapshot.id
      : undefined;
    runtime.start({
      ...(snapshotId === undefined
        ? { image: expectedImage }
        : { containerSnapshot: { id: snapshotId } }),
      instance: EVE_HOST_DEFAULTS.instance,
      enableInternet: true,
      env: this.envVars,
      entrypoint: EVE_HOST_ENTRYPOINT,
    });
    // Set before any await: a failure below makes the readiness retry see a
    // running container and skip this method, so the restore must already be
    // pending. A start from the configured image (an update) has no sandbox
    // sessions yet; a same-image snapshot wake already contains them.
    this.pendingCarryRestore = snapshotId === undefined;
    // Both start sources run `expectedImage` (a snapshot is only restored
    // from that image).
    await this.ctx.storage.put(EVE_HOST_CONTAINER_STARTED_IMAGE_KEY, expectedImage);
    // Intercepts do not survive a container start and late registration lags;
    // register inside the same block before readiness polling.
    await this.registerLoopbackIntercept(runtime);
    this.attachMonitor(runtime);
    await runtime.setInactivityTimeout(this.inactivityTimeoutMs);
  }

  /**
   * Replaces the running container when it still serves a pre-update image:
   * this Worker version's `images.eve` is selected at `start()`, so an
   * in-place update must stop the stale instance itself. `inspect()` reports
   * an empty image for a snapshot-restored container, so the image recorded
   * at start stands in for it.
   */
  private async reconcileRunningImage(): Promise<void> {
    if (this.imageVerified) return;
    const runtime = this.containerRuntime();
    if (runtime === undefined || !runtime.running) return;
    const expectedImage = runtime.images["eve"];
    let info: { readonly image?: string } | null;
    try {
      info = await runtime.inspect();
    } catch {
      info = null;
    }
    const runningImage = info?.image !== undefined && info.image !== ""
      ? info.image
      : await this.ctx.storage.get<string>(EVE_HOST_CONTAINER_STARTED_IMAGE_KEY);
    if (runningImage === expectedImage) {
      this.imageVerified = true;
      return;
    }
    this.recordContainerStopped();
    // The stale container's conversation sandboxes must survive the update:
    // stream them into Durable Object storage before the destroy makes the
    // container unreachable. A failed carry still lets the update proceed.
    try {
      await this.carrySandboxSessionsOut(runtime);
    } catch (error: unknown) {
      console.error(
        "The Eve sandbox session carry failed before the image update:",
        error instanceof Error ? error.message : "unknown",
      );
    }
    await runtime.destroy();
    const stoppedAt = Date.now();
    while (runtime.running && Date.now() - stoppedAt < 10_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Streams `/workspace/.eve/sandbox-cache/just-bash/sessions` — every
   * conversation's sandbox files and metadata — into Durable Object storage,
   * so a fresh container started by an image update can restore them. Not
   * carried: templates and the rest of `/workspace`, which come from the new
   * image. One carry runs at a time on this Durable Object; a failure never
   * blocks the destroy that follows and leaves the previous carry intact.
   */
  private carrySandboxSessionsOut(
    runtime: EveContainerRuntime,
  ): Promise<void> {
    const run = this.carryOutQueue.then(() =>
      this.carrySandboxSessionsOutNow(runtime)
    );
    this.carryOutQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async carrySandboxSessionsOutNow(
    runtime: EveContainerRuntime,
  ): Promise<void> {
    const previous = await this.ctx.storage.get<EveStoredSandboxCarry>(
      EVE_HOST_SANDBOX_CARRY_KEY,
    );
    const carryId = globalThis.crypto.randomUUID();
    const chunkPrefix = `${EVE_HOST_SANDBOX_CARRY_CHUNK_PREFIX}.${carryId}.`;
    const writtenChunkKeys: string[] = [];
    const discardWrittenChunks = async (): Promise<void> => {
      for (const key of writtenChunkKeys) await this.ctx.storage.delete(key);
    };
    const exec = await runtime.exec(
      [
        "sh",
        "-c",
        `cd ${EVE_HOST_SANDBOX_CARRY_SOURCE} && [ -d sessions ] && tar -czf - sessions || true`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let chunks = 0;
    let bytes = 0;
    const flushOnce = async (): Promise<void> => {
      if (bufferedBytes === 0) return;
      const size = Math.min(bufferedBytes, EVE_HOST_CARRY_LIMITS.chunkBytes);
      const value = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const part = buffered[0];
        if (part === undefined) break;
        const take = Math.min(part.byteLength, size - offset);
        value.set(
          take === part.byteLength ? part : part.subarray(0, take),
          offset,
        );
        offset += take;
        if (take === part.byteLength) buffered.shift();
        else buffered[0] = part.subarray(take);
      }
      bufferedBytes -= size;
      const key = `${chunkPrefix}${chunks}`;
      writtenChunkKeys.push(key);
      await this.ctx.storage.put(key, value);
      chunks += 1;
      bytes += value.byteLength;
    };
    const flushBufferedChunks = async (): Promise<void> => {
      while (bufferedBytes >= EVE_HOST_CARRY_LIMITS.chunkBytes) {
        await flushOnce();
      }
    };
    try {
      const stdout = exec.stdout;
      if (stdout === null) throw new Error("the exec stdout was not piped");
      const reader = stdout.getReader();
      let overflowed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        buffered.push(value);
        bufferedBytes += value.byteLength;
        if (bytes + bufferedBytes > EVE_HOST_CARRY_LIMITS.maxBytes) {
          overflowed = true;
          break;
        }
        await flushBufferedChunks();
      }
      await reader.cancel().catch(() => undefined);
      if (overflowed) {
        await discardWrittenChunks();
        console.error(
          `The Eve sandbox session carry exceeded ${EVE_HOST_CARRY_LIMITS.maxBytes} compressed bytes; keeping the previous carry.`,
        );
        return;
      }
      await flushOnce();
    } catch (error: unknown) {
      await discardWrittenChunks();
      throw error;
    }
    let exitCode = -1;
    try {
      exitCode = await exec.exitCode;
    } catch {
      exitCode = -1;
    }
    if (exitCode !== 0) {
      await discardWrittenChunks();
      console.error(
        `The Eve sandbox session carry failed with exit code ${exitCode}; keeping the previous carry.`,
      );
      return;
    }
    if (bytes === 0) {
      // No sessions directory in this container (nothing to carry); keep any
      // previous carry as the restore source.
      return;
    }
    await this.ctx.storage.put(EVE_HOST_SANDBOX_CARRY_KEY, {
      id: carryId,
      chunks,
      bytes,
      at: Date.now(),
    } satisfies EveStoredSandboxCarry);
    if (previous !== undefined) {
      for (let index = 0; index < previous.chunks; index += 1) {
        await this.ctx.storage.delete(
          `${EVE_HOST_SANDBOX_CARRY_CHUNK_PREFIX}.${previous.id}.${index}`,
        );
      }
    }
  }

  /**
   * Single restore per fresh container generation, shared by every
   * concurrent readiness caller: the first caller starts it, everyone awaits
   * the same promise, and no request is forwarded before it settles.
   */
  private async restoreCarriedSandboxSessions(): Promise<void> {
    if (!this.pendingCarryRestore) return;
    this.carryRestorePromise ??= this.carrySandboxSessionsIn();
    await this.carryRestorePromise;
    this.pendingCarryRestore = false;
  }

  /**
   * Extracts the carried sandbox sessions into a container that started
   * fresh from `images.eve`. The archive streams chunk by chunk from Durable
   * Object storage through exec stdin, so it never sits in isolate memory. A
   * failure is logged and swallowed: the agent still serves, only the
   * carried files are missing.
   */
  private async carrySandboxSessionsIn(): Promise<void> {
    try {
      const carry = await this.ctx.storage.get<EveStoredSandboxCarry>(
        EVE_HOST_SANDBOX_CARRY_KEY,
      );
      if (carry === undefined) return;
      let nextChunk = 0;
      const archive = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (nextChunk >= carry.chunks) {
            controller.close();
            return;
          }
          const chunk = await this.ctx.storage.get<Uint8Array>(
            `${EVE_HOST_SANDBOX_CARRY_CHUNK_PREFIX}.${carry.id}.${nextChunk}`,
          );
          const index = nextChunk;
          nextChunk += 1;
          if (chunk === undefined) {
            controller.error(
              new Error(`The sandbox carry chunk ${index} is missing.`),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      });
      const runtime = this.containerRuntime();
      if (runtime === undefined) {
        throw new Error("the Container runtime is unavailable");
      }
      const exec = await runtime.exec(
        [
          "sh",
          "-c",
          `mkdir -p ${EVE_HOST_SANDBOX_CARRY_SOURCE} && tar -xzf - -C ${EVE_HOST_SANDBOX_CARRY_SOURCE}`,
        ],
        { stdin: archive, stderr: "pipe" },
      );
      let exitCode = -1;
      try {
        exitCode = await exec.exitCode;
      } catch {
        exitCode = -1;
      }
      if (exitCode !== 0) {
        console.error(
          `The Eve sandbox session restore failed with exit code ${exitCode}; the agent serves without the carried files.`,
        );
      }
    } catch (error: unknown) {
      console.error(
        "The Eve sandbox session restore failed; the agent serves without the carried files:",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }

  async ensureEveReady(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EveHostReadinessEvidence> {
    await this.reconcileRunningImage();
    if (this.readinessEvidence !== undefined) {
      return this.readinessEvidence;
    }
    const epoch = this.readinessEpoch;
    const evidence = await this.readiness(signal);
    if (epoch === this.readinessEpoch) {
      // Restore carried sandbox sessions while still inside the single-flight
      // readiness path, before evidence is cached: every fetch and loopback
      // request waits on this evidence, so nothing reaches Eve first.
      await this.restoreCarriedSandboxSessions();
      this.readinessEvidence = evidence;
      // Readiness under this Worker version proves the running container
      // serves `images.eve`: it was either verified by inspect() or freshly
      // started from the configured image above.
      this.imageVerified = true;
    }
    return evidence;
  }

  override async fetch(request: Request): Promise<Response> {
    const requestDeploymentId =
      request.headers.get("x-eden-eve-deployment-id") ?? undefined;
    const response = await this.forwardToEve(request);
    // Reporting the verified start back lets deploy health-gate promotion on
    // the served container actually running this generation's image: the
    // header echoes only when the running container's image equals this
    // Worker version's configured image and the request names this
    // deployment.
    if (
      requestDeploymentId !== undefined &&
      requestDeploymentId === this.env.EDEN_EVE_DEPLOYMENT_ID &&
      this.readinessEvidence !== undefined &&
      this.imageVerified
    ) {
      const headers = new Headers(response.headers);
      headers.set("x-eden-eve-started-deployment", requestDeploymentId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  }

  /**
   * Queue deliveries and loopback traffic enter here: same readiness and
   * forwarding as `fetch` without the deployment-header echo rules (the
   * loopback path is not a deployment-health signal).
   */
  async loopbackFetch(request: Request): Promise<Response> {
    return this.forwardToEve(request);
  }

  private async forwardToEve(request: Request): Promise<Response> {
    await this.ensureEveReady(request.signal);
    await this.touchActivity();
    const runtime = this.containerRuntime();
    if (runtime === undefined) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Container runtime is unavailable on this Durable Object.",
      );
    }
    const url = new URL(request.url);
    return runtime
      .getTcpPort(EVE_HOST_DEFAULTS.internalPort)
      .fetch(
        new Request(`http://container${url.pathname}${url.search}`, request),
      );
  }

  /**
   * The idle-sleep path: once the container has been quiet for `sleepAfter`,
   * snapshot the writable filesystem (so `/workspace` survives the sleep)
   * and destroy the instance. A snapshot failure retries up to
   * `EVE_HOST_SNAPSHOT_MAX_ATTEMPTS` times, then destroys anyway so billing
   * for the running container stops.
   */
  override async alarm(): Promise<void> {
    const runtime = this.containerRuntime();
    const lastActivity =
      (await this.ctx.storage.get<number>(EVE_HOST_CONTAINER_ACTIVITY_KEY)) ?? 0;
    const now = Date.now();
    if (now - lastActivity < this.sleepAfterMs) {
      await this.ctx.storage.setAlarm(lastActivity + this.sleepAfterMs);
      return;
    }
    if (runtime === undefined || !runtime.running) return;
    // The snapshot restores same-image wakes; the carry additionally lets an
    // update that lands while asleep restore the conversation sandboxes. A
    // failed carry must not degrade the snapshot path, so it is only logged.
    try {
      await this.carrySandboxSessionsOut(runtime);
    } catch (error: unknown) {
      console.error(
        "The Eve sandbox session carry failed during idle sleep:",
        error instanceof Error ? error.message : "unknown",
      );
    }
    const attempts =
      (await this.ctx.storage.get<number>(
        EVE_HOST_CONTAINER_SNAPSHOT_ATTEMPTS_KEY,
      )) ?? 0;
    try {
      const snapshot = await runtime.snapshotContainer({
        name: "eden-workspace",
      });
      const image = (await runtime.inspect().catch(() => null))?.image ??
        runtime.images["eve"] ??
        "";
      const record: EveStoredContainerSnapshot = {
        id: snapshot.id,
        image,
        at: now,
      };
      await this.ctx.storage.put(EVE_HOST_CONTAINER_SNAPSHOT_KEY, record);
      await this.ctx.storage.put(EVE_HOST_CONTAINER_SNAPSHOT_ATTEMPTS_KEY, 0);
      // The snapshot takes seconds and requests may interleave with it; a
      // request that arrived meanwhile must not have its container destroyed
      // underneath it. Keep running and re-arm sleep from that activity.
      const activityAfterSnapshot =
        (await this.ctx.storage.get<number>(EVE_HOST_CONTAINER_ACTIVITY_KEY)) ?? 0;
      if (activityAfterSnapshot !== lastActivity) {
        await this.ctx.storage.setAlarm(activityAfterSnapshot + this.sleepAfterMs);
        return;
      }
      await runtime.destroy(new Error("idle-snapshot-done"));
      this.recordContainerStopped();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown";
      if (attempts + 1 >= EVE_HOST_SNAPSHOT_MAX_ATTEMPTS) {
        console.error(
          `The Eve workspace snapshot failed ${attempts + 1} times; destroying the container without it: ${message}`,
        );
        await this.ctx.storage.put(
          EVE_HOST_CONTAINER_SNAPSHOT_ATTEMPTS_KEY,
          0,
        );
        await runtime.destroy(
          new Error("idle-snapshot-abandoned"),
        );
        this.recordContainerStopped();
        return;
      }
      console.error(
        `The Eve workspace snapshot failed (attempt ${attempts + 1}): ${message}`,
      );
      await this.ctx.storage.put(
        EVE_HOST_CONTAINER_SNAPSHOT_ATTEMPTS_KEY,
        attempts + 1,
      );
      await this.ctx.storage.setAlarm(now + 60_000);
    }
  }
}

export interface EveHostWorkerOptions extends EveHostForwardingMetadata {
  readonly workerName: string;
  readonly stableContainerInstanceName: string;
  readonly schedules?: readonly EveScheduleCronEntry[];
}

/**
 * Structural worker-handler shape. Declared locally so the emitted module
 * declarations never reference provider ambient types.
 */
export interface EveHostWorkerHandler {
  fetch(request: Request, env: EveHostContainerEnvironment): Promise<Response>;
  scheduled?(
    event: { readonly cron: string; readonly scheduledTime: number },
    env: EveHostContainerEnvironment,
    ctx: { waitUntil(task: Promise<unknown>): void },
  ): void;
}

interface EveContainerNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

export function createEveHostWorker(
  options: EveHostWorkerOptions,
): EveHostWorkerHandler {
  if (!WORKER_NAME_PATTERN.test(options.workerName)) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The exact Worker name is not valid.",
    );
  }
  assertStableOrigin(options.publicOrigin, options.workerName);
  assertNonEmpty(options.stableContainerInstanceName, "Container instance name");
  const schedules = options.schedules ?? [];
  const resolveContainer = (env: EveHostContainerEnvironment) => {
    const namespace = env.EVE_CONTAINER as EveContainerNamespace | undefined;
    if (namespace === undefined) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The configured Container binding is unavailable.",
      );
    }
    return namespace.getByName(options.stableContainerInstanceName);
  };
  return {
    async fetch(request, env): Promise<Response> {
      // Queue deliveries to these endpoints arrive through the container's
      // intercepted outbound loopback instead, so any request that reaches
      // the public Worker fetch path is external and unauthenticated.
      if (isEveWorkflowInternalRoute(new URL(request.url).pathname)) {
        return new Response(null, { status: 404 });
      }
      const container = resolveContainer(env);
      const forwarded = createTrustedEveRequest(request, {
        publicOrigin: options.publicOrigin,
        deploymentId: options.deploymentId,
        generationId: options.generationId,
        correlationId: globalThis.crypto.randomUUID(),
        ...(options.runtimeRevisionHandle === undefined
          ? {}
          : { runtimeRevisionHandle: options.runtimeRevisionHandle }),
      });
      const response = await container.fetch(forwarded);
      const headers = new Headers(response.headers);
      headers.set("x-eden-eve-worker-name", options.workerName);
      headers.set("x-eden-eve-public-origin", options.publicOrigin);
      headers.set("x-eden-eve-deployment-id", options.deploymentId);
      headers.set("x-eden-eve-generation-id", options.generationId);
      headers.set(
        "x-eden-eve-container-instance",
        options.stableContainerInstanceName,
      );
      if (options.runtimeRevisionHandle !== undefined) {
        headers.set(
          "x-eden-eve-runtime-revision",
          options.runtimeRevisionHandle,
        );
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    ...(schedules.length === 0
      ? {}
      : {
          scheduled(event, env, ctx) {
            const due = schedules.some((schedule) =>
              eveScheduleCronFiresWithin(
                schedule.cron,
                event.scheduledTime,
                EVE_SCHEDULE_WAKE_LEAD_MS,
              ));
            if (!due) return;
            // Wake only: the in-process Nitro runner inside the container
            // fires the tick itself, so the schedule runs exactly once.
            ctx.waitUntil(
              resolveContainer(env)
                .fetch(new Request(
                  new URL(EVE_HOST_DEFAULTS.healthPath, options.publicOrigin),
                ))
                .catch((error: unknown) => {
                  console.error(
                    "The scheduled wake request failed:",
                    error instanceof Error ? error.message : "unknown",
                  );
                }),
            );
          },
        }),
  };
}

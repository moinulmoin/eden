import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { WorldCore } from "@moinulmoin/eden-world-cloudflare/core";

import {
  EVE_HOST_DEFAULTS,
  EVE_SCHEDULE_WAKE_LEAD_MS,
  EveHostError,
  assertNonEmpty,
  assertStableOrigin,
  createEveHostLifecycleObserver,
  createEveReadinessGate,
  createTrustedEveRequest,
  eveScheduleCronFiresWithin,
  IDENTIFIER_PATTERN,
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
 * The native `ctx.container` surface under `scheduling_policy:
 * "durable_object"`. Declared structurally so the emitted declarations never
 * depend on a specific `@cloudflare/workers-types` revision.
 */
interface EveContainerPort {
  fetch(request: Request): Promise<Response>;
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
}

interface EveContainerContext {
  readonly container?: EveContainerRuntime | undefined;
  readonly storage: {
    get<T>(key: string): Promise<T | undefined> | T | undefined;
    put(key: string, value: unknown): Promise<void> | void;
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

/** Snapshot attempts the alarm retries before destroying anyway so a stuck
 * snapshot path never keeps billing alive forever. */
const EVE_HOST_SNAPSHOT_MAX_ATTEMPTS = 3;

interface EveStoredContainerSnapshot {
  readonly id: string;
  readonly image: string;
  readonly at: number;
}

/** Parses the `sleepAfter` duration spellings wrangler accepts ("300ms",
 * "30s", "15m", "24h", "7d", or a bare number of seconds). */
function sleepAfterDurationMs(value: string): number | undefined {
  const match = /^([0-9]+)(ms|s|m|h|d)?$/u.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "s";
  const factor = unit === "ms"
    ? 1
    : unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return amount * factor;
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
          const binding = env.EVE_CONTAINER_BINDING_NAME;
          const instance = env.EVE_CONTAINER_INSTANCE_NAME;
          if (typeof origin !== "string" || typeof binding !== "string" ||
              typeof instance !== "string") {
            throw new Error("The World queue Container identity is unavailable.");
          }
          const namespace = env[binding] as EveContainerLoopbackNamespace;
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
  const bindingName = env.EVE_CONTAINER_BINDING_NAME;
  const instanceName = env.EVE_CONTAINER_INSTANCE_NAME;
  if (
    typeof publicOrigin !== "string" ||
    typeof bindingName !== "string" ||
    typeof instanceName !== "string"
  ) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The container loopback identity is unavailable to the outbound handler.",
    );
  }
  assertStableOrigin(publicOrigin);
  assertNonEmpty(bindingName, "Container binding name");
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
  const namespace = (env as Record<string, unknown>)[bindingName] as
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
  readonly lifecycle = createEveHostLifecycleObserver();
  private readinessStarted = false;
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
    const sleepAfterOverride = env.EDEN_EVE_CONTAINER_SLEEP_AFTER;
    this.sleepAfterMs =
      sleepAfterOverride === undefined
        ? sleepAfterDurationMs(EVE_HOST_DEFAULTS.sleepAfter) ?? 86_400_000
        : sleepAfterDurationMs(sleepAfterOverride) ??
          (() => {
            throw new EveHostError(
              "HOST_READINESS_UNPROVEN",
              "The Container sleepAfter override is not a parseable duration.",
            );
          })();
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

  /** Container lifetime the platform keeps after the DO goes inactive. */
  private get inactivityTimeoutMs(): number {
    return this.sleepAfterMs + 15 * 60_000;
  }

  private attachMonitor(runtime: EveContainerRuntime): void {
    if (this.monitorAttached) return;
    this.monitorAttached = true;
    runtime.monitor().then(
      () => {
        this.monitorAttached = false;
        this.recordContainerStopped("exit");
      },
      (error: unknown) => {
        this.monitorAttached = false;
        this.recordContainerStopped(
          error instanceof Error ? error.name : "runtime_signal",
        );
      },
    );
  }

  private recordContainerStopped(reason: string): void {
    this.readinessEpoch += 1;
    this.readinessStarted = false;
    this.readinessEvidence = undefined;
    this.imageVerified = false;
    this.readiness.reset();
    this.lifecycle.record("stopped", reason);
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
   * workspace files intentionally do not carry across.
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
    if (this.lifecycle.events.some((event) => event.type === "started")) {
      this.lifecycle.record("replaced");
    }
    runtime.start({
      ...(storedSnapshot !== undefined && storedSnapshot.image === expectedImage
        ? { containerSnapshot: { id: storedSnapshot.id } }
        : { image: expectedImage }),
      instance: EVE_HOST_DEFAULTS.instance,
      enableInternet: true,
      env: this.envVars,
    });
    // Intercepts do not survive a container start and late registration lags;
    // register inside the same block before readiness polling.
    await this.registerLoopbackIntercept(runtime);
    this.attachMonitor(runtime);
    await runtime.setInactivityTimeout(this.inactivityTimeoutMs);
    this.lifecycle.record("started");
  }

  /**
   * Replaces the running container when `inspect()` proves it still serves a
   * pre-update image: this Worker version's `images.eve` is selected at
   * `start()`, so an in-place update must stop the stale instance itself.
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
    if (info?.image === expectedImage) {
      this.imageVerified = true;
      return;
    }
    this.lifecycle.record("image_mismatch");
    this.recordContainerStopped("replaced");
    await runtime.destroy();
    const stoppedAt = Date.now();
    while (runtime.running && Date.now() - stoppedAt < 10_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async ensureEveReady(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EveHostReadinessEvidence> {
    await this.reconcileRunningImage();
    if (this.readinessEvidence !== undefined) {
      return this.readinessEvidence;
    }
    if (!this.readinessStarted) {
      this.readinessStarted = true;
      this.lifecycle.record("start_requested");
    }
    const epoch = this.readinessEpoch;
    const evidence = await this.readiness(signal);
    if (epoch === this.readinessEpoch) {
      this.readinessEvidence = evidence;
      // Readiness under this Worker version proves the running container
      // serves `images.eve`: it was either verified by inspect() or freshly
      // started from the configured image above.
      this.imageVerified = true;
    }
    this.lifecycle.record("health_ready", evidence.healthStatus);
    return evidence;
  }

  override async fetch(request: Request): Promise<Response> {
    const requestDeploymentId =
      request.headers.get("x-eden-eve-deployment-id") ?? undefined;
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
    const response = await runtime
      .getTcpPort(EVE_HOST_DEFAULTS.internalPort)
      .fetch(
        new Request(`http://container${url.pathname}${url.search}`, request),
      );
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
      this.recordContainerStopped("snapshot:idle");
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
        this.recordContainerStopped("snapshot:abandoned");
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

export type EveHostWorkerEnvironment = EveHostContainerEnvironment;

export interface EveHostWorkerOptions extends EveHostForwardingMetadata {
  readonly workerName: string;
  readonly containerBindingName: string;
  readonly stableContainerInstanceName: string;
  readonly schedules?: readonly EveScheduleCronEntry[];
}

/**
 * Structural worker-handler shape. Declared locally so the emitted module
 * declarations never reference provider ambient types.
 */
export interface EveHostWorkerHandler {
  fetch(request: Request, env: EveHostWorkerEnvironment): Promise<Response>;
  scheduled?(
    event: { readonly cron: string; readonly scheduledTime: number },
    env: EveHostWorkerEnvironment,
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
  if (!IDENTIFIER_PATTERN.test(options.containerBindingName)) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Container binding name is not valid.",
    );
  }
  const schedules = options.schedules ?? [];
  const resolveContainer = (env: EveHostWorkerEnvironment) => {
    const namespace = (
      env as unknown as Record<string, EveContainerNamespace | undefined>
    )[options.containerBindingName];
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
                  {
                    headers: {
                      // Stamp the Worker's own deployment so a stale Durable
                      // Object never falls back to its own environment.
                      "x-eden-eve-deployment-id": options.deploymentId,
                    },
                  },
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

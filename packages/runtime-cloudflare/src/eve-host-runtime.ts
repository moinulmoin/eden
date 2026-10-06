import { Container, ContainerProxy } from "@cloudflare/containers";
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

export { ContainerProxy };

const EVE_CLOUDFLARE_CONTAINERS_CA_PATH =
  "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

interface EveContainerLoopbackNamespace {
  getByName(name: string): {
    containerFetch(request: Request, port?: number): Promise<Response>;
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
          const response = await namespace.getByName(instance).containerFetch(
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
            EVE_HOST_DEFAULTS.internalPort,
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
 * Delivers the container's own HTTPS requests to its public workers.dev origin
 * back into the container over the internal port instead of the public edge.
 * The Workflow local World posts queue deliveries to
 * `WORKFLOW_LOCAL_BASE_URL`, which must remain the public origin so Eve's
 * externally visible callback URLs stay correct; re-routing that traffic
 * inside the Worker lets the public Worker path refuse the unauthenticated
 * queue endpoints without breaking delivery.
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
  return namespace
    .getByName(instanceName)
    .containerFetch(request, EVE_HOST_DEFAULTS.internalPort);
}

/**
 * This module is the only Eve-host surface that depends on provider runtime
 * packages. It is bundled into the deployed Worker directory instead of the
 * package's public declaration surface, so plain-Node consumers never load
 * `cloudflare:workers`-dependent code.
 */

type EveHostContainerContext = ConstructorParameters<typeof Container>[0];

/**
 * Durable Object storage key recording which deployment last started the
 * Container. Cloudflare does not roll DO-managed Container instances onto a
 * new image when the Worker redeploys — the image is selected at
 * `ctx.container.start()` — so an in-place update must restart the running
 * instance itself before new code is served.
 */
const EVE_HOST_CONTAINER_DEPLOYMENT_KEY =
  "eden.eve.host.started-deployment";

/** Restart attempts are rate-limited under this key: during the
 * Worker-active-before-image-rollout window a restart still launches the old
 * image, so retries must wait for the rollout. */
const EVE_HOST_CONTAINER_RESTART_ATTEMPT_KEY =
  "eden.eve.host.restart-attempted-at";

/** Compares image references by their generation-scoped repository name so
 * digest and tag spellings of the same pushed image match. */
function containerRepositoryName(image: string): string {
  return (image.split("@")[0] ?? "").split(":")[0] ?? "";
}


export class EveHostContainer extends Container<EveHostContainerEnvironment> {
  override defaultPort = EVE_HOST_DEFAULTS.internalPort;
  override sleepAfter: string | number = EVE_HOST_DEFAULTS.sleepAfter;
  override requiredPorts = [EVE_HOST_DEFAULTS.internalPort];
  override interceptHttps = true;
  override enableInternet = true;
  override pingEndpoint = "localhost/eve/v1/health";
  readonly lifecycle = createEveHostLifecycleObserver();
  private readinessStarted = false;
  /** Evidence is cached only under the deployment whose image was verified. */
  private readinessEvidence:
    | { readonly deploymentId: string | undefined; readonly evidence: EveHostReadinessEvidence }
    | undefined;
  /**
   * Bumped whenever the Container stops or is reset. Readiness work captures
   * the epoch it started under and may only record a marker or cache
   * evidence if no stop happened in between.
   */
  private readinessEpoch = 0;
  private readonly readiness: EveReadinessGate;
  constructor(
    ctx: EveHostContainerContext,
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
    if (sleepAfterOverride !== undefined) {
      // `env` is only readable after `super()`, so the override is applied in
      // the constructor body; the base class reads `this.sleepAfter` again on
      // every subsequent activity renewal.
      this.sleepAfter = sleepAfterOverride;
    }
    this.readiness = createEveReadinessGate({
      startAndWaitForPorts: (options) =>
        this.startAndWaitForPorts(options),
      healthFetch: (request) =>
        this.containerFetch(request, EVE_HOST_DEFAULTS.internalPort),
    });
  }

  /**
   * Compares the deployment the running Container was started under (stored
   * in Durable Object storage, which survives Worker redeploys) against the
   * deployment the *current* Worker stamps on the forwarded request. A
   * stale Durable Object still detects the update because the header is
   * stamped by new Worker code, not this code's environment.
   *
   * DO-managed Container instances are excluded from the application's fleet
   * rollout — the image is only re-selected on the next
   * `ctx.container.start()` — so an update must stop the instance itself.
   * A missing marker means the running image cannot be trusted, so the
   * container is restarted too (first update from runtimes that predate the
   * marker). Restarts are rate-limited because Cloudflare activates a new
   * Worker before the image rollout lands; starting in that window would
   * re-launch the *old* image, so the deployment marker is only recorded
   * after `inspect()` proves the running image is the expected one.
   */
  private async reconcileStartedDeployment(
    requestDeploymentId: string | undefined,
    requestImage: string | undefined,
  ): Promise<void> {
    // Requests without the Worker's deployment header (scheduled wakes on old
    // Worker code, probes) cannot arbitrate drift; the Durable Object's own
    // environment may itself be stale, so never fall back to it here.
    if (requestDeploymentId === undefined) return;
    const storage = this.ctx?.storage;
    if (
      storage === undefined ||
      typeof storage.get !== "function" ||
      typeof storage.put !== "function"
    ) {
      return;
    }
    const lastStarted = await storage.get<string>(
      EVE_HOST_CONTAINER_DEPLOYMENT_KEY,
    );
    if (lastStarted === requestDeploymentId) return;
    const runtime = this.ctx?.container;
    if (runtime?.running !== true) return;
    if (
      requestImage !== undefined &&
      (await this.containerServesImage(runtime, requestImage)) === true
    ) {
      // The running instance already provably serves this deployment's image
      // (e.g. the rollout replaced it); safe to mark it as started.
      await storage.put(EVE_HOST_CONTAINER_DEPLOYMENT_KEY, requestDeploymentId);
      return;
    }
    const attemptedAt = await storage.get<number>(
      EVE_HOST_CONTAINER_RESTART_ATTEMPT_KEY,
    );
    const now = Date.now();
    if (attemptedAt !== undefined && now - attemptedAt < 30_000) return;
    await storage.put(EVE_HOST_CONTAINER_RESTART_ATTEMPT_KEY, now);
    this.lifecycle.record("replaced");
    this.readinessEpoch += 1;
    this.readinessStarted = false;
    this.readinessEvidence = undefined;
    this.readiness.reset();
    await this.stop();
    const stoppedAt = Date.now();
    while (runtime.running && Date.now() - stoppedAt < 10_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  private async containerServesImage(
    runtime: { readonly running: boolean },
    expectedImage: string,
  ): Promise<boolean | undefined> {
    const inspect = (
      runtime as {
        inspect?: () => Promise<{ readonly image?: string } | null>;
      }
    ).inspect;
    if (typeof inspect !== "function") return undefined;
    let info: { readonly image?: string } | null;
    try {
      info = await inspect.call(runtime);
    } catch {
      return undefined;
    }
    if (info?.image === undefined) return undefined;
    return containerRepositoryName(info.image) ===
      containerRepositoryName(expectedImage);
  }

  /**
   * Records the started deployment only when the running Container provably
   * serves this deployment's image (`inspect()` matches the forwarded
   * `x-eden-eve-image`). `false` or unknown (no `inspect`, a throwing call,
   * or no image field) never records — a start inside the
   * Worker-active-before-image-rollout window must not pin the old image.
   * When the Worker stamps no image, the marker is recorded unverified,
   * matching pre-drift behavior.
   */
  private async recordStartedDeployment(
    requestDeploymentId: string | undefined,
    requestImage: string | undefined,
  ): Promise<boolean> {
    if (requestDeploymentId === undefined) return true;
    const storage = this.ctx?.storage;
    if (
      storage === undefined ||
      typeof storage.get !== "function" ||
      typeof storage.put !== "function"
    ) {
      return true;
    }
    const runtime = this.ctx?.container;
    if (requestImage !== undefined) {
      // A stopped (or stopping) instance can't prove which image it serves.
      if (runtime?.running !== true) {
        this.lifecycle.record("image_mismatch");
        return false;
      }
      const verified = await this.containerServesImage(runtime, requestImage);
      if (verified !== true) {
        this.lifecycle.record("image_mismatch");
        return false;
      }
    }
    await storage.put(EVE_HOST_CONTAINER_DEPLOYMENT_KEY, requestDeploymentId);
    return true;
  }


  async ensureEveReady(
    signal: AbortSignal = new AbortController().signal,
    requestDeploymentId?: string,
    requestImage?: string,
  ): Promise<EveHostReadinessEvidence> {
    await this.reconcileStartedDeployment(requestDeploymentId, requestImage);
    // Cached evidence only serves the deployment it was verified under;
    // a request for a different deployment re-runs readiness.
    if (
      this.readinessEvidence !== undefined &&
      this.readinessEvidence.deploymentId === requestDeploymentId
    ) {
      return this.readinessEvidence.evidence;
    }
    if (!this.readinessStarted) {
      this.readinessStarted = true;
      this.lifecycle.record("start_requested");
    }
    const epoch = this.readinessEpoch;
    const evidence = await this.readiness(signal);
    if (
      epoch === this.readinessEpoch &&
      await this.recordStartedDeployment(requestDeploymentId, requestImage) &&
      epoch === this.readinessEpoch
    ) {
      this.readinessEvidence = {
        deploymentId: requestDeploymentId,
        evidence,
      };
    }
    this.lifecycle.record("health_ready", evidence.healthStatus);
    return evidence;
  }

  override async fetch(request: Request): Promise<Response> {
    const requestDeploymentId =
      request.headers.get("x-eden-eve-deployment-id") ?? undefined;
    await this.ensureEveReady(
      request.signal,
      requestDeploymentId,
      request.headers.get("x-eden-eve-image") ?? undefined,
    );
    const response = await super.fetch(request);
    // Reporting the verified marker back lets deploy health-gate promotion on
    // the served container actually running this generation's image.
    if (
      this.readinessEvidence !== undefined &&
      this.readinessEvidence.deploymentId === requestDeploymentId &&
      requestDeploymentId !== undefined
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

  override onStart(): void {
    if (this.lifecycle.events.some((event) => event.type === "started")) {
      this.lifecycle.record("replaced");
    }
    this.lifecycle.record("started");
  }

  override onStop(params: {
    readonly exitCode: number;
    readonly reason: "exit" | "runtime_signal";
  }): void {
    this.readinessEpoch += 1;
    this.readinessStarted = false;
    this.readinessEvidence = undefined;
    this.readiness.reset();
    this.lifecycle.record("stopped", `${params.reason}:${params.exitCode}`);
  }

  override onError(error: unknown): unknown {
    this.readinessEpoch += 1;
    this.readinessStarted = false;
    this.readinessEvidence = undefined;
    this.readiness.reset();
    this.lifecycle.record(
      "errored",
      error instanceof Error ? error.name : "unknown",
    );
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Eve Container supervisor reported an error.",
    );
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
        ...(options.containerImage === undefined
          ? {}
          : { containerImage: options.containerImage }),
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
                      // Object never falls back to its own environment when
                      // deciding whether to restart the running Container.
                      "x-eden-eve-deployment-id": options.deploymentId,
                      ...(options.containerImage === undefined
                        ? {}
                        : { "x-eden-eve-image": options.containerImage }),
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

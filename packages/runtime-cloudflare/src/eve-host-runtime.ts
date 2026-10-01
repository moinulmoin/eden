import { Container, ContainerProxy } from "@cloudflare/containers";

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

export class EveHostContainer extends Container<EveHostContainerEnvironment> {
  override defaultPort = EVE_HOST_DEFAULTS.internalPort;
  override sleepAfter: string | number = EVE_HOST_DEFAULTS.sleepAfter;
  override requiredPorts = [EVE_HOST_DEFAULTS.internalPort];
  override interceptHttps = true;
  override enableInternet = true;
  override pingEndpoint = "localhost/eve/v1/health";
  readonly lifecycle = createEveHostLifecycleObserver();
  private readinessStarted = false;
  private readinessEvidence: EveHostReadinessEvidence | undefined;
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
    assertNonEmpty(generationId, "generation identity");
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

  async ensureEveReady(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<EveHostReadinessEvidence> {
    if (this.readinessEvidence !== undefined) {
      return this.readinessEvidence;
    }
    if (!this.readinessStarted) {
      this.readinessStarted = true;
      this.lifecycle.record("start_requested");
    }
    const evidence = await this.readiness(signal);
    this.readinessEvidence = evidence;
    this.lifecycle.record("health_ready", evidence.healthStatus);
    return evidence;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureEveReady(request.signal);
    return super.fetch(request);
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
    this.readinessStarted = false;
    this.readinessEvidence = undefined;
    this.readiness.reset();
    this.lifecycle.record("stopped", `${params.reason}:${params.exitCode}`);
  }

  override onError(error: unknown): unknown {
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

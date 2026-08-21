import { Container } from "@cloudflare/containers";

import {
  EVE_HOST_DEFAULTS,
  EveHostError,
  assertNonEmpty,
  assertStableOrigin,
  createEveHostLifecycleObserver,
  createEveReadinessGate,
  createTrustedEveRequest,
  IDENTIFIER_PATTERN,
  readProtectedRuntimeVariables,
  WORKER_NAME_PATTERN,
  type EveHostContainerEnvironment,
  type EveHostForwardingMetadata,
  type EveHostReadinessEvidence,
  type EveReadinessGate,
} from "./eve-host.js";

/**
 * This module is the only Eve-host surface that depends on provider runtime
 * packages. It is bundled into the deployed Worker directory instead of the
 * package's public declaration surface, so plain-Node consumers never load
 * `cloudflare:workers`-dependent code.
 */

type EveHostContainerContext = ConstructorParameters<typeof Container>[0];

export class EveHostContainer extends Container<EveHostContainerEnvironment> {
  override defaultPort = EVE_HOST_DEFAULTS.internalPort;
  override requiredPorts = [EVE_HOST_DEFAULTS.internalPort];
  override sleepAfter = EVE_HOST_DEFAULTS.sleepAfter;
  override entrypoint = [...EVE_HOST_DEFAULTS.startCommand];
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
      ...(env.EDEN_EVE_RUNTIME_REVISION === undefined
        ? {}
        : { EDEN_EVE_RUNTIME_REVISION: env.EDEN_EVE_RUNTIME_REVISION }),
    };
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
}

/**
 * Structural worker-handler shape. Declared locally so the emitted module
 * declarations never reference provider ambient types.
 */
export interface EveHostWorkerHandler {
  fetch(request: Request, env: EveHostWorkerEnvironment): Promise<Response>;
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
  return {
    async fetch(request, env): Promise<Response> {
      const namespace = (
        env as unknown as Record<string, EveContainerNamespace | undefined>
      )[options.containerBindingName];
      if (namespace === undefined) {
        throw new EveHostError(
          "HOST_READINESS_UNPROVEN",
          "The configured Container binding is unavailable.",
        );
      }
      const container = namespace.getByName(
        options.stableContainerInstanceName,
      );
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
  };
}

export const EVE_HOST_DEFAULTS = {
  compatibilityDate: "2026-04-01",
  healthPath: "/eve/v1/health",
  internalPort: 8080,
  maxInstances: 1,
  startCommand: [
    "./node_modules/.bin/eve",
    "start",
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
  ] as const,
  sleepAfter: "24h",
} as const;

export const EVE_HOST_OWNED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-forwarded-scheme",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-visitor",
  "true-client-ip",
  "x-original-host",
  "x-original-proto",
  "x-envoy-original-host",
  "x-envoy-original-proto",
  "x-proxy-host",
  "x-host",
  "x-eve-public-origin",
  "x-workflow-local-base-url",
  "x-eden-eve-callback-base",
  "x-eden-eve-deployment-id",
  "x-eden-eve-generation-id",
  "x-eden-eve-public-origin",
  "x-eden-eve-correlation-id",
  "x-eden-eve-container-name",
  "x-eden-eve-container-id",
  "x-eden-eve-runtime-revision",
  "x-eden-deployment-id",
  "x-eden-generation-id",
  "x-eden-container-name",
  "x-eden-container-id",
  "cf-container-target-port",
] as const;

const EVE_HOST_OWNED_HEADER_SET = new Set<string>(EVE_HOST_OWNED_HEADERS);
export const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const INSTANCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,125}[a-z0-9])?$/u;
const SHA256_IMAGE_PATTERN =
  /^(?:[a-z0-9.-]+\/)?[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/u;

export type EveHostErrorCode =
  | "HOST_ORIGIN_UNAVAILABLE"
  | "HOST_REQUEST_ABORTED"
  | "HOST_READINESS_UNPROVEN"
  | "HOST_TRANSPORT_UNTESTABLE"
  | "HOST_WEBSOCKET_UNSUPPORTED";

export class EveHostError extends Error {
  readonly code: EveHostErrorCode;

  constructor(code: EveHostErrorCode, message: string) {
    super(message);
    this.name = "EveHostError";
    this.code = code;
  }
}

export interface StableWorkersDevOriginRequest {
  readonly workerName: string;
  readonly workersDevSubdomain: string;
}

export function resolveStableWorkersDevOrigin(
  request: StableWorkersDevOriginRequest,
): string {
  if (!WORKER_NAME_PATTERN.test(request.workerName)) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The exact Worker name is not valid for a stable workers.dev origin.",
    );
  }
  if (
    !SUBDOMAIN_PATTERN.test(request.workersDevSubdomain) ||
    request.workersDevSubdomain.includes(".")
  ) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The authenticated workers.dev account subdomain is unavailable or invalid.",
    );
  }
  return `https://${request.workerName}.${request.workersDevSubdomain}.workers.dev`;
}

export interface EveHostIdentity {
  readonly workerName: string;
  readonly containerApplicationName: string;
  readonly containerClassName: string;
  readonly containerBindingName: string;
  readonly stableContainerInstanceName: string;
  readonly deploymentId: string;
  readonly generationId: string;
}

export interface EveHostConfigRequest extends EveHostIdentity {
  readonly accountId?: string;
  readonly stableWorkersDevOrigin: string;
  readonly containerImage: string;
  readonly containerImageBuildContext?: string;
  readonly runtimeVariableNames?: readonly string[];
  readonly runtimeRevisionHandle?: string;
}

export interface EveHostWranglerConfig {
  readonly account_id?: string;
  readonly name: string;
  readonly main: string;
  readonly compatibility_date: string;
  readonly workers_dev: true;
  readonly vars: {
    readonly EVE_PUBLIC_ORIGIN: string;
    readonly EVE_CONTAINER_INSTANCE_NAME: string;
    readonly EDEN_EVE_DEPLOYMENT_ID: string;
    readonly EDEN_EVE_GENERATION_ID: string;
    readonly EVE_RUNTIME_VARIABLE_NAMES: readonly string[];
    readonly EDEN_EVE_RUNTIME_REVISION?: string;
  };
  readonly containers: readonly [
    {
      readonly name: string;
      readonly class_name: string;
      readonly image: string;
      readonly image_build_context?: string;
      readonly max_instances: 1;
    },
  ];
  readonly durable_objects: {
    readonly bindings: readonly [
      {
        readonly name: string;
        readonly class_name: string;
      },
    ];
  };
  readonly migrations: readonly [
    {
      readonly tag: "v1";
      readonly new_sqlite_classes: readonly [string];
    },
  ];
}

export interface EveHostContainerConfig {
  readonly applicationName: string;
  readonly className: string;
  readonly instanceName: string;
  readonly bindingName: string;
  readonly port: 8080;
  readonly publicOrigin: string;
  readonly deploymentId: string;
  readonly generationId: string;
  readonly runtimeRevisionHandle?: string;
}

export interface EveHostConfig {
  readonly worker: EveHostWranglerConfig;
  readonly container: EveHostContainerConfig;
}

export interface EveGeneratedWorkerSourceRequest {
  readonly config: EveHostConfig;
}

export function assertNonEmpty(value: string, subject: string): void {
  if (value.length === 0) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      `The ${subject} must be non-empty.`,
    );
  }
}

export function assertStableOrigin(value: string, workerName?: string): void {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The stable workers.dev origin is not a valid absolute URL.",
    );
  }
  if (
    origin.protocol !== "https:" ||
    origin.port.length !== 0 ||
    origin.pathname !== "/" ||
    origin.search.length !== 0 ||
    origin.hash.length !== 0 ||
    !origin.hostname.endsWith(".workers.dev")
  ) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The stable origin must be an HTTPS provider-assigned workers.dev origin.",
    );
  }
  if (
    workerName !== undefined &&
    !origin.hostname.startsWith(`${workerName}.`)
  ) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The stable workers.dev origin does not belong to the exact Worker target.",
    );
  }
  const labels = origin.hostname.split(".");
  if (
    labels.length !== 4 ||
    labels[labels.length - 2] !== "workers" ||
    labels[labels.length - 1] !== "dev" ||
    !SUBDOMAIN_PATTERN.test(labels[1] ?? "") ||
    (workerName !== undefined && labels[0] !== workerName)
  ) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The stable origin must be the exact provider-assigned Worker workers.dev hostname.",
    );
  }
}

function assertContainerImage(value: string): void {
  if (!SHA256_IMAGE_PATTERN.test(value)) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Container image must be an immutable sha256 digest reference.",
    );
  }
}

export function createEveHostConfig(
  request: EveHostConfigRequest,
): EveHostConfig {
  if (!WORKER_NAME_PATTERN.test(request.workerName)) {
    throw new EveHostError(
      "HOST_ORIGIN_UNAVAILABLE",
      "The exact Worker name is not valid.",
    );
  }
  if (
    !WORKER_NAME_PATTERN.test(request.containerApplicationName) ||
    !IDENTIFIER_PATTERN.test(request.containerClassName)
  ) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Container application and class names must be stable safe identifiers.",
    );
  }
  if (!IDENTIFIER_PATTERN.test(request.containerBindingName)) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Container binding name must be a valid Worker environment identifier.",
    );
  }
  if (!INSTANCE_NAME_PATTERN.test(request.stableContainerInstanceName)) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The stable Container instance name must be a bounded logical identifier.",
    );
  }
  assertNonEmpty(request.deploymentId, "deployment identity");
  assertNonEmpty(request.generationId, "generation identity");
  assertStableOrigin(request.stableWorkersDevOrigin, request.workerName);
  assertContainerImage(request.containerImage);
  for (const name of request.runtimeVariableNames ?? []) {
    if (!IDENTIFIER_PATTERN.test(name) || RESERVED_EVE_HOST_VARIABLES.has(name)) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        `The protected runtime variable name ${name} is invalid or reserved.`,
      );
    }
  }

  const container = {
    name: request.containerApplicationName,
    class_name: request.containerClassName,
    image: request.containerImage,
    ...(request.containerImageBuildContext === undefined
      ? {}
      : { image_build_context: request.containerImageBuildContext }),
    max_instances: EVE_HOST_DEFAULTS.maxInstances,
  } as const;
  return {
    worker: {
      ...(request.accountId === undefined
        ? {}
        : { account_id: request.accountId }),
      name: request.workerName,
      main: "worker.ts",
      compatibility_date: EVE_HOST_DEFAULTS.compatibilityDate,
      workers_dev: true,
      vars: {
        EVE_PUBLIC_ORIGIN: request.stableWorkersDevOrigin,
        EVE_CONTAINER_INSTANCE_NAME: request.stableContainerInstanceName,
        EDEN_EVE_DEPLOYMENT_ID: request.deploymentId,
        EDEN_EVE_GENERATION_ID: request.generationId,
        EVE_RUNTIME_VARIABLE_NAMES: request.runtimeVariableNames ?? [],
        ...(request.runtimeRevisionHandle === undefined
          ? {}
          : { EDEN_EVE_RUNTIME_REVISION: request.runtimeRevisionHandle }),
      },
      containers: [container],
      durable_objects: {
        bindings: [
          {
            name: request.containerBindingName,
            class_name: request.containerClassName,
          },
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: [request.containerClassName],
        },
      ],
    },
    container: {
      applicationName: request.containerApplicationName,
      className: request.containerClassName,
      instanceName: request.stableContainerInstanceName,
      bindingName: request.containerBindingName,
      port: EVE_HOST_DEFAULTS.internalPort,
      publicOrigin: request.stableWorkersDevOrigin,
      deploymentId: request.deploymentId,
      generationId: request.generationId,
      ...(request.runtimeRevisionHandle === undefined
        ? {}
        : { runtimeRevisionHandle: request.runtimeRevisionHandle }),
    },
  };
}

export function generateEveHostWorkerSource(
  request: EveGeneratedWorkerSourceRequest,
): string {
  const moduleSpecifier = "./eden-eve-host-worker.mjs";
  const workerOptions = {
    publicOrigin: request.config.container.publicOrigin,
    workerName: request.config.worker.name,
    containerBindingName: request.config.container.bindingName,
    deploymentId: request.config.container.deploymentId,
    generationId: request.config.container.generationId,
    stableContainerInstanceName: request.config.container.instanceName,
    ...(request.config.container.runtimeRevisionHandle === undefined
      ? {}
      : {
          runtimeRevisionHandle:
            request.config.container.runtimeRevisionHandle,
        }),
  };
  return [
    `import { EveHostContainer, createEveHostWorker } from ${JSON.stringify(moduleSpecifier)};`,
    request.config.container.className === "EveHostContainer"
      ? "export { EveHostContainer };"
      : `export { EveHostContainer as ${request.config.container.className} };`,
    "",
    `export default createEveHostWorker(${JSON.stringify(workerOptions)});`,
    "",
  ].join("\n");
}

export interface EveHostForwardingMetadata {
  readonly publicOrigin: string;
  readonly deploymentId: string;
  readonly generationId: string;
  readonly correlationId: string;
  readonly runtimeRevisionHandle?: string;
}

function originHost(origin: string): string {
  const parsed = new URL(origin);
  return parsed.host;
}

function isBodylessMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function isHostOwnedHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    EVE_HOST_OWNED_HEADER_SET.has(lowerName) ||
    lowerName.startsWith("x-forwarded-") ||
    lowerName.startsWith("x-eden-") ||
    lowerName.startsWith("cf-")
  );
}

export function createTrustedEveRequest(
  request: Request,
  metadata: EveHostForwardingMetadata,
): Request {
  assertStableOrigin(metadata.publicOrigin);
  assertNonEmpty(metadata.deploymentId, "deployment identity");
  assertNonEmpty(metadata.generationId, "generation identity");
  assertNonEmpty(metadata.correlationId, "correlation identity");

  const headers = new Headers(request.headers);
  const headersToStrip: string[] = [];
  headers.forEach((_value, header) => {
    if (isHostOwnedHeader(header)) {
      headersToStrip.push(header);
    }
  });
  for (const header of headersToStrip) headers.delete(header);
  const host = originHost(metadata.publicOrigin);
  const targetOrigin = new URL(metadata.publicOrigin);
  const targetUrl = new URL(request.url);
  targetUrl.protocol = targetOrigin.protocol;
  targetUrl.hostname = targetOrigin.hostname;
  targetUrl.port = targetOrigin.port;
  const edgeUrl = new URL(request.url);
  const edgeProtocol = edgeUrl.protocol === "http:" ? "http" : "https";
  const publicPort =
    targetOrigin.port.length > 0
      ? targetOrigin.port
      : targetOrigin.protocol === "https:"
        ? "443"
        : "80";
  headers.set("forwarded", `proto=${edgeProtocol};host=${host}`);
  headers.set("host", host);
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-port", publicPort);
  headers.set("x-forwarded-proto", edgeProtocol);
  headers.set("x-eden-eve-public-origin", metadata.publicOrigin);
  headers.set("x-eden-eve-deployment-id", metadata.deploymentId);
  headers.set("x-eden-eve-generation-id", metadata.generationId);
  headers.set("x-eden-eve-correlation-id", metadata.correlationId);
  if (metadata.runtimeRevisionHandle !== undefined) {
    headers.set(
      "x-eden-eve-runtime-revision",
      metadata.runtimeRevisionHandle,
    );
  }

  const init: RequestInit & { readonly duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: request.redirect,
    signal: request.signal,
    ...(isBodylessMethod(request.method) || request.body === null
      ? {}
      : { body: request.body, duplex: "half" }),
  };
  return new Request(targetUrl, init);
}

export interface EveContainerTransport {
  readonly containerFetch: (request: Request) => Promise<Response>;
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface EveHostProxyOptions extends EveHostForwardingMetadata {
  readonly transport: EveContainerTransport;
  readonly ensureReady: (signal: AbortSignal) => Promise<void>;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new EveHostError(
      "HOST_REQUEST_ABORTED",
      "The client request was cancelled before Eve became ready.",
    );
  }
}

export function createEveHostProxy(
  options: EveHostProxyOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    throwIfAborted(request.signal);
    await options.ensureReady(request.signal);
    throwIfAborted(request.signal);
    const forwarded = createTrustedEveRequest(request, options);
    return isWebSocketUpgrade(request)
      ? options.transport.fetch(forwarded)
      : options.transport.containerFetch(forwarded);
  };
}

export interface EveHostLifecycleEvent {
  readonly type:
    | "start_requested"
    | "started"
    | "health_ready"
    | "stopped"
    | "errored"
    | "replaced";
  readonly at: number;
  readonly safeStatus?: string;
}

export interface EveHostLifecycleObserver {
  readonly events: readonly EveHostLifecycleEvent[];
  record(
    type: EveHostLifecycleEvent["type"],
    safeStatus?: string,
  ): EveHostLifecycleEvent;
}

export function createEveHostLifecycleObserver(
  now: () => number = Date.now,
): EveHostLifecycleObserver {
  const events: EveHostLifecycleEvent[] = [];
  return {
    events,
    record(type, safeStatus) {
      const event = {
        type,
        at: now(),
        ...(safeStatus === undefined ? {} : { safeStatus }),
      };
      events.push(event);
      return event;
    },
  };
}

export interface EveHostContainerEnvironment {
  readonly [name: string]: unknown;
  readonly EVE_RUNTIME_VARIABLE_NAMES?: readonly string[];
  readonly EVE_PUBLIC_ORIGIN?: string;
  readonly EVE_CONTAINER_INSTANCE_NAME?: string;
  readonly EDEN_EVE_DEPLOYMENT_ID?: string;
  readonly EDEN_EVE_GENERATION_ID?: string;
  readonly EDEN_EVE_RUNTIME_REVISION?: string;
}

export interface EveHostReadinessEvidence {
  readonly healthPath: "/eve/v1/health";
  readonly healthStatus: "ready";
  readonly healthVerified: true;
  readonly port: 8080;
  readonly checkedAt: string;
}

export interface EveHostReadinessOptions {
  readonly startAndWaitForPorts: (
    options: {
      readonly ports: 8080;
      readonly cancellationOptions: {
        readonly abort: AbortSignal;
        readonly instanceGetTimeoutMS: number;
        readonly portReadyTimeoutMS: number;
        readonly waitInterval: number;
      };
    },
  ) => Promise<void>;
  readonly healthFetch: (request: Request) => Promise<Response>;
  readonly healthPath?: "/eve/v1/health";
  readonly port?: 8080;
  readonly instanceGetTimeoutMs?: number;
  readonly portReadyTimeoutMs?: number;
  readonly healthTimeoutMs?: number;
  readonly waitIntervalMs?: number;
}

export interface EveReadinessGate {
  (signal: AbortSignal): Promise<EveHostReadinessEvidence>;
  reset(): void;
}

function responseBodyIsReady(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.status === "ready" ||
    record.state === "ready" ||
    record.health === "ready" ||
    record.ready === true ||
    record.healthy === true
  );
}

const RESERVED_EVE_HOST_VARIABLES = new Set([
  "HOST",
  "NITRO_HOST",
  "PORT",
  "NITRO_PORT",
  "NODE_ENV",
  "WORKFLOW_LOCAL_BASE_URL",
  "EDEN_EVE_DEPLOYMENT_ID",
  "EDEN_EVE_GENERATION_ID",
  "EDEN_EVE_RUNTIME_REVISION",
]);

export function readProtectedRuntimeVariables(
  env: EveHostContainerEnvironment,
): Record<string, string> {
  const names = env.EVE_RUNTIME_VARIABLE_NAMES ?? [];
  const values: Record<string, string> = {};
  for (const name of names) {
    if (!IDENTIFIER_PATTERN.test(name) || RESERVED_EVE_HOST_VARIABLES.has(name)) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        `The protected runtime contract contains an invalid or reserved variable name ${name}.`,
      );
    }
    const value = env[name];
    if (typeof value !== "string") {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        `The protected runtime contract is missing variable ${name}.`,
      );
    }
    values[name] = value;
  }
  return values;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new EveHostError(
        "HOST_REQUEST_ABORTED",
        "The client request was cancelled before Eve became ready.",
      ),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new EveHostError(
          "HOST_REQUEST_ABORTED",
          "The client request was cancelled before Eve became ready.",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createEveReadinessGate(
  options: EveHostReadinessOptions,
): EveReadinessGate {
  const port = options.port ?? EVE_HOST_DEFAULTS.internalPort;
  const healthPath = options.healthPath ?? EVE_HOST_DEFAULTS.healthPath;
  const instanceGetTimeoutMs = options.instanceGetTimeoutMs ?? 120_000;
  const portReadyTimeoutMs = options.portReadyTimeoutMs ?? 30_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 10_000;
  const waitIntervalMs = options.waitIntervalMs ?? 300;
  let evidence: EveHostReadinessEvidence | undefined;
  let inFlight:
    | Promise<EveHostReadinessEvidence>
    | undefined;
  let inFlightController: AbortController | undefined;
  let generation = 0;

  const run = async (signal: AbortSignal): Promise<EveHostReadinessEvidence> => {
    try {
      await options.startAndWaitForPorts({
        ports: port,
        cancellationOptions: {
          abort: signal,
          instanceGetTimeoutMS: instanceGetTimeoutMs,
          portReadyTimeoutMS: portReadyTimeoutMs,
          waitInterval: waitIntervalMs,
        },
      });
    } catch {
      if (signal.aborted) {
        throw new EveHostError(
          "HOST_REQUEST_ABORTED",
          "The client request was cancelled before Eve became ready.",
        );
      }
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Eve Container did not reach its internal port readiness deadline.",
      );
    }
    const healthController = new AbortController();
    let rejectHealthTimeout: ((reason?: unknown) => void) | undefined;
    const abortHealth = (): void => {
      healthController.abort();
      rejectHealthTimeout?.(
        new EveHostError(
          "HOST_REQUEST_ABORTED",
          "The client request was cancelled before Eve became ready.",
        ),
      );
    };
    signal.addEventListener("abort", abortHealth, { once: true });
    const healthTimeoutResult = new Promise<Response>((_resolve, reject) => {
      rejectHealthTimeout = reject;
    });
    const healthTimeout = setTimeout(() => {
      healthController.abort();
      rejectHealthTimeout?.(
        new EveHostError(
          "HOST_READINESS_UNPROVEN",
          "The bounded Eve health probe timed out.",
        ),
      );
    }, healthTimeoutMs);
    let response: Response;
    try {
      const healthRequest = new Request(`http://localhost${healthPath}`, {
        method: "GET",
        signal: healthController.signal,
      });
      const healthResult = options.healthFetch(healthRequest);
      response = await Promise.race([healthResult, healthTimeoutResult]);
    } catch {
      if (signal.aborted) {
        throw new EveHostError(
          "HOST_REQUEST_ABORTED",
          "The client request was cancelled before Eve became ready.",
        );
      }
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The bounded Eve health probe did not complete.",
      );
    } finally {
      clearTimeout(healthTimeout);
      signal.removeEventListener("abort", abortHealth);
    }
    if (response.status !== 200) {
      await response.arrayBuffer().catch(() => undefined);
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Eve health route did not return the expected successful status.",
      );
    }
    if (
      !(response.headers.get("content-type") ?? "")
        .toLowerCase()
        .startsWith("application/json")
    ) {
      await response.arrayBuffer().catch(() => undefined);
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Eve health route did not return the expected JSON contract.",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Eve health route did not return a valid ready response.",
      );
    }
    if (!responseBodyIsReady(body)) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Eve health route is reachable but has not reported ready.",
      );
    }
    return {
      healthPath,
      healthStatus: "ready",
      healthVerified: true,
      port,
      checkedAt: new Date().toISOString(),
    };
  };

  const gate = ((signal: AbortSignal): Promise<EveHostReadinessEvidence> => {
    throwIfAborted(signal);
    if (evidence !== undefined) {
      return Promise.resolve(evidence);
    }
    if (inFlight === undefined) {
      const runGeneration = generation;
      inFlightController = new AbortController();
      inFlight = run(inFlightController.signal)
        .then((result) => {
          if (runGeneration === generation) {
            evidence = result;
          }
          return result;
        })
        .finally(() => {
          if (runGeneration === generation) {
            inFlight = undefined;
            inFlightController = undefined;
          }
        });
    }
    return raceWithAbort(inFlight, signal);
  }) as EveReadinessGate;
  gate.reset = (): void => {
    generation += 1;
    evidence = undefined;
    inFlightController?.abort();
    inFlightController = undefined;
    inFlight = undefined;
  };
  return gate;
}


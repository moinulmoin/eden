export const EVE_HOST_DEFAULTS = {
  compatibilityDate: "2026-04-01",
  healthPath: "/eve/v1/health",
  internalPort: 8080,
  maxInstances: 1,
  instanceType: "basic",
  sleepAfter: "24h",
} as const;

export const EVE_SCHEDULE_WAKE_TRIGGER_CRON = "* * * * *";
/**
 * How far ahead of a tick the every-minute wake trigger starts the Container.
 * A sleeping Container cold-starts in well under a minute on a warm image; the
 * wider window absorbs slow starts without missing the tick.
 */
export const EVE_SCHEDULE_WAKE_LEAD_MS = 240_000;
const EVE_SCHEDULE_WAKE_GRACE_MS = 60_000;
const MINUTE_MS = 60_000;

/**
 * One authored Eve schedule reduced to the fields the host needs. `cron` is the
 * 5-field expression from the compiled manifest.
 */
export interface EveScheduleCronEntry {
  readonly name: string;
  readonly cron: string;
}

const EVE_CRON_FIELD_BOUNDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 are Sunday)
] as const;

const EVE_CRON_MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const EVE_CRON_DAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseCronValue(
  token: string,
  bounds: { readonly min: number; readonly max: number },
  fieldIndex: number,
): number | undefined {
  const names = fieldIndex === 3
    ? EVE_CRON_MONTH_NAMES
    : fieldIndex === 4
      ? EVE_CRON_DAY_NAMES
      : undefined;
  const named = names?.[token.toLowerCase()];
  const value = named !== undefined
    ? named
    : /^[0-9]+$/u.test(token)
      ? Number.parseInt(token, 10)
      : Number.NaN;
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return undefined;
  }
  return fieldIndex === 4 && value === 7 ? 0 : value;
}

/**
 * Expands one cron field (`*`, `*\/n`, `a-b/n`, `a,b,...`) into the set of
 * matching unit values. Returns undefined when the field uses syntax outside
 * the standard 5-field subset Eve documents (e.g. `?`, `L`, `W`, `#`).
 */
export function expandEveCronField(
  field: string,
  fieldIndex: number,
): ReadonlySet<number> | undefined {
  const bounds = EVE_CRON_FIELD_BOUNDS[fieldIndex];
  if (bounds === undefined) return undefined;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/([0-9]+)$/u.exec(part);
    const rangeText = stepMatch?.[1] ?? part;
    const step = stepMatch === null ? 1 : Number.parseInt(stepMatch[2] ?? "", 10);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let low: number;
    let high: number;
    if (rangeText === "*" || rangeText === "?") {
      low = bounds.min;
      high = bounds.max;
    } else {
      const rangeMatch = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/u.exec(rangeText);
      const lowToken = rangeMatch === null ? rangeText : rangeMatch[1];
      const lowValue = lowToken === undefined
        ? undefined
        : parseCronValue(lowToken, bounds, fieldIndex);
      if (lowValue === undefined) return undefined;
      low = lowValue;
      const highToken = rangeMatch?.[2];
      const highValue = highToken === undefined
        ? undefined
        : parseCronValue(highToken, bounds, fieldIndex);
      high = rangeMatch === null
        ? (stepMatch === null ? lowValue : bounds.max)
        : highValue ?? -1;
      if (high < low) return undefined;
    }
    for (let value = low; value <= high; value += step) {
      values.add(fieldIndex === 4 && value === 7 ? 0 : value);
    }
  }
  return values;
}

interface ParsedEveCron {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/**
 * Parses a standard 5-field cron expression (minute granularity, UTC, Vixie
 * day-of-month/day-of-week OR semantics — the same evaluation Vercel and
 * croner use for Eve schedules). Returns undefined for anything else: named
 * `@` schedules, seconds-prefixed 6-field expressions, or unsupported syntax.
 */
export function parseEveScheduleCron(cron: string): ParsedEveCron | undefined {
  const fields = cron.trim().split(/\s+/u);
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (
    fields.length !== 5 || minuteField === undefined || hourField === undefined ||
    domField === undefined || monthField === undefined || dowField === undefined
  ) return undefined;
  const minute = expandEveCronField(minuteField, 0);
  const hour = expandEveCronField(hourField, 1);
  const dayOfMonth = expandEveCronField(domField, 2);
  const month = expandEveCronField(monthField, 3);
  const dayOfWeek = expandEveCronField(dowField, 4);
  if (
    minute === undefined || hour === undefined || dayOfMonth === undefined ||
    month === undefined || dayOfWeek === undefined
  ) {
    return undefined;
  }
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: domField !== "*",
    dowRestricted: dowField !== "*",
  };
}

function cronMatches(parsed: ParsedEveCron, atMs: number): boolean {
  const at = new Date(atMs);
  if (!parsed.minute.has(at.getUTCMinutes())) return false;
  if (!parsed.hour.has(at.getUTCHours())) return false;
  if (!parsed.month.has(at.getUTCMonth() + 1)) return false;
  const dom = parsed.dayOfMonth.has(at.getUTCDate());
  const dow = parsed.dayOfWeek.has(at.getUTCDay());
  if (parsed.domRestricted && parsed.dowRestricted) return dom || dow;
  return dom && dow;
}

/**
 * True when the schedule's next tick lands inside the wake window: at or just
 * after `nowMs` through `nowMs + leadMs` (Cloudflare Cron Triggers are
 * minute-aligned UTC, matching Eve's minute-granularity schedules).
 */
export function eveScheduleCronFiresWithin(
  cron: string,
  nowMs: number,
  leadMs: number = EVE_SCHEDULE_WAKE_LEAD_MS,
): boolean {
  const parsed = parseEveScheduleCron(cron);
  if (parsed === undefined) return false;
  const firstCandidate =
    Math.floor((nowMs - EVE_SCHEDULE_WAKE_GRACE_MS) / MINUTE_MS) * MINUTE_MS;
  const lastCandidate =
    Math.floor((nowMs + leadMs) / MINUTE_MS) * MINUTE_MS;
  for (
    let candidate = firstCandidate;
    candidate <= lastCandidate;
    candidate += MINUTE_MS
  ) {
    if (cronMatches(parsed, candidate)) return true;
  }
  return false;
}

/** Queue and World RPC routes are private; webhooks and manifests stay forwarded. */
export function isEveWorkflowInternalRoute(pathname: string): boolean {
  let decodedPath = pathname;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot identify an internal route.
  }
  return /^\/(?:\.well-known\/workflow\/v1\/(?:flow|step)|__eden\/world)(?:\/|$)/iu.test(
    decodedPath.replace(/\/+/gu, "/"),
  );
}

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
  /**
   * Compiled authored schedules. Entries whose cron cannot be expressed are
   * rejected here; the caller reports that as a deploy warning.
   */
  readonly schedules?: readonly EveScheduleCronEntry[];
  /** Overrides the Container `sleepAfter` (e.g. "30s") for testing. */
  readonly containerSleepAfter?: string;
  readonly workflowWorld?: string;
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
    readonly EVE_CONTAINER_BINDING_NAME: string;
    readonly EDEN_EVE_DEPLOYMENT_ID: string;
    readonly EDEN_EVE_GENERATION_ID: string;
    readonly EVE_RUNTIME_VARIABLE_NAMES: readonly string[];
    readonly EDEN_EVE_RUNTIME_REVISION?: string;
    readonly EDEN_EVE_CONTAINER_SLEEP_AFTER?: string;
    readonly EDEN_EVE_WORLD_CLOUDFLARE?: true;
  };
  readonly triggers?: { readonly crons: readonly string[] };
  readonly containers: readonly [
    {
      readonly name: string;
      readonly class_name: string;
      readonly image: string;
      readonly image_build_context?: string;
      readonly max_instances: 1;
      readonly instance_type: "basic";
    },
  ];
  readonly durable_objects: {
    readonly bindings: readonly {
      readonly name: string;
      readonly class_name: string;
    }[];
  };
  readonly migrations: readonly [
    {
      readonly tag: "v1";
      readonly new_sqlite_classes: readonly string[];
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
  readonly schedules: readonly EveScheduleCronEntry[];
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

  const schedules = request.schedules ?? [];
  for (const schedule of schedules) {
    if (parseEveScheduleCron(schedule.cron) === undefined) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        `The schedule ${schedule.name} uses a cron expression the wake trigger cannot express.`,
      );
    }
  }
  if (request.containerSleepAfter !== undefined) {
    if (!/^[0-9]+(?:ms|s|m|h|d)?$/u.test(request.containerSleepAfter)) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The Container sleepAfter override is not a parseable duration.",
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
    instance_type: EVE_HOST_DEFAULTS.instanceType,
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
        EVE_CONTAINER_BINDING_NAME: request.containerBindingName,
        EDEN_EVE_DEPLOYMENT_ID: request.deploymentId,
        EDEN_EVE_GENERATION_ID: request.generationId,
        EVE_RUNTIME_VARIABLE_NAMES: request.runtimeVariableNames ?? [],
        ...(request.runtimeRevisionHandle === undefined
          ? {}
          : { EDEN_EVE_RUNTIME_REVISION: request.runtimeRevisionHandle }),
        ...(request.containerSleepAfter === undefined
          ? {}
          : { EDEN_EVE_CONTAINER_SLEEP_AFTER: request.containerSleepAfter }),
        ...(request.workflowWorld === "@moinulmoin/eden-world-cloudflare"
          ? { EDEN_EVE_WORLD_CLOUDFLARE: true as const }
          : {}),
      },
      ...(schedules.length === 0
        ? {}
        : { triggers: { crons: [EVE_SCHEDULE_WAKE_TRIGGER_CRON] } }),
      containers: [container],
      durable_objects: {
        bindings: [
          {
            name: request.containerBindingName,
            class_name: request.containerClassName,
          },
          ...(request.workflowWorld === "@moinulmoin/eden-world-cloudflare"
            ? [{ name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" }]
            : []),
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: [
            request.containerClassName,
            ...(request.workflowWorld === "@moinulmoin/eden-world-cloudflare"
              ? ["EdenWorldDurableObject"]
              : []),
          ],
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
      schedules,
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
    ...(request.config.container.schedules.length === 0
      ? {}
      : { schedules: request.config.container.schedules }),
  };
  return [
    `import { ContainerProxy, EveHostContainer, createEveHostWorker, routeEveOutboundRequest } from ${JSON.stringify(moduleSpecifier)};`,
    request.config.container.className === "EveHostContainer"
      ? "export { ContainerProxy, EveHostContainer };"
      : `export { ContainerProxy, EveHostContainer as ${request.config.container.className} };`,
    "",
    ...(request.config.worker.vars.EDEN_EVE_WORLD_CLOUDFLARE
      ? [`export { EdenWorldDurableObject } from ${JSON.stringify(moduleSpecifier)};`]
      : []),
    `EveHostContainer.outboundByHost = { ${JSON.stringify(new URL(request.config.container.publicOrigin).hostname)}: routeEveOutboundRequest };`,
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
  readonly EVE_CONTAINER_BINDING_NAME?: string;
  readonly EDEN_EVE_DEPLOYMENT_ID?: string;
  readonly EDEN_EVE_GENERATION_ID?: string;
  readonly EDEN_EVE_RUNTIME_REVISION?: string;
  readonly EDEN_EVE_CONTAINER_SLEEP_AFTER?: string;
  readonly EDEN_EVE_WORLD_CLOUDFLARE?: boolean;
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
  "NODE_EXTRA_CA_CERTS",
  "WORKFLOW_LOCAL_BASE_URL",
  "EDEN_WORLD_URL",
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


export const EVE_HOST_DEFAULTS = {
  compatibilityDate: "2026-04-01",
  healthPath: "/eve/v1/health",
  internalPort: 8080,
  instance: "standard-1",
  sleepAfter: "1h",
} as const;

/**
 * Cloudflare stops a container at most 6 hours after its Durable Object goes
 * inactive (`setInactivityTimeout` rejects longer values). The idle-sleep
 * alarm must fire before that so it can snapshot first, and the inactivity
 * timeout is `sleepAfter` plus this margin.
 */
export const EVE_HOST_SLEEP_SNAPSHOT_MARGIN_MS = 15 * 60_000;
export const EVE_HOST_MAX_SLEEP_AFTER_MS =
  6 * 3_600_000 - EVE_HOST_SLEEP_SNAPSHOT_MARGIN_MS;

/**
 * Parses a `sleepAfter` duration ("300ms", "30s", "15m", "1h", or a bare
 * number of seconds) and enforces Cloudflare's inactivity ceiling.
 */
export function parseEveSleepAfterMs(value: string): number {
  const match = /^([0-9]+)(ms|s|m|h|d)?$/u.exec(value.trim());
  if (match === null) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Container sleepAfter override is not a parseable duration.",
    );
  }
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
  const ms = amount * factor;
  if (ms > EVE_HOST_MAX_SLEEP_AFTER_MS) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Container sleepAfter override exceeds 345m (5 h 45 min); Cloudflare stops a container within 6 hours of its Durable Object going idle, so Eden must snapshot before then.",
    );
  }
  return ms;
}

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
  "x-real-ip",
  "true-client-ip",
  "x-original-host",
  "x-original-proto",
  "x-envoy-original-host",
  "x-envoy-original-proto",
  "x-proxy-host",
  "x-host",
  "x-eve-public-origin",
  "x-workflow-local-base-url",
] as const;

const EVE_HOST_OWNED_HEADER_SET = new Set<string>(EVE_HOST_OWNED_HEADERS);
export const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SUBDOMAIN_PATTERN = WORKER_NAME_PATTERN;
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const INSTANCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,125}[a-z0-9])?$/u;
const SHA256_IMAGE_PATTERN =
  /^(?:[a-z0-9.-]+\/)?[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/u;

export type EveHostErrorCode =
  | "HOST_ORIGIN_UNAVAILABLE"
  | "HOST_REQUEST_ABORTED"
  | "HOST_READINESS_UNPROVEN";

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
  /**
   * Durable Object state already published for this exact target. In-place
   * updates carry the recorded binding and migration history forward
   * verbatim: a class is only ever added once (`new_sqlite_classes` entries
   * are append-only) and a class is never removed.
   */
  readonly durableObjects?: {
    readonly bindings?: readonly EveDurableBinding[];
    readonly migrations?: readonly EveDurableMigration[];
  };
}

/** One `durable_objects.bindings` entry as it appears in wrangler config. */
export interface EveDurableBinding {
  readonly name: string;
  readonly class_name: string;
}

/**
 * One `migrations` entry as it appears in wrangler config. Entries are
 * compared by tag and carried forward verbatim across in-place updates;
 * `new_sqlite_classes` declares a class.
 */
export interface EveDurableMigration {
  readonly tag: string;
  readonly new_sqlite_classes?: readonly string[];
}

export interface EveHostWranglerConfig {
  readonly account_id?: string;
  readonly name: string;
  readonly main: string;
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly ["enable_ctx_exports"];
  readonly workers_dev: true;
  readonly vars: {
    readonly EVE_PUBLIC_ORIGIN: string;
    readonly EVE_CONTAINER_INSTANCE_NAME: string;
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
      readonly scheduling_policy: "durable_object";
      readonly images: {
        readonly eve: { readonly image: string };
      };
    },
  ];
  readonly durable_objects: {
    readonly bindings: readonly EveDurableBinding[];
  };
  readonly migrations: readonly EveDurableMigration[];
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
  if (!WORKER_NAME_PATTERN.test(request.containerApplicationName)) {
    throw new EveHostError(
      "HOST_READINESS_UNPROVEN",
      "The Container application and class names must be stable safe identifiers.",
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
    parseEveSleepAfterMs(request.containerSleepAfter);
  }
  const container = {
    name: request.containerApplicationName,
    class_name: "EveHostDurableContainer",
    scheduling_policy: "durable_object",
    images: { eve: { image: request.containerImage } },
  } as const;
  const worldCloudflare =
    request.workflowWorld === "@moinulmoin/eden-world-cloudflare";
  const priorMigrations: EveDurableMigration[] = [];
  for (const migration of request.durableObjects?.migrations ?? []) {
    const validClassList = (
      value: unknown,
    ): value is readonly string[] =>
      Array.isArray(value) &&
      value.every(
        (className) =>
          typeof className === "string" &&
          IDENTIFIER_PATTERN.test(className),
      );
    if (
      typeof migration.tag !== "string" ||
      migration.tag.length === 0 ||
      !validClassList(migration.new_sqlite_classes)
    ) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The recorded Durable Object migration history is not safely reusable; refusing to drop or rewrite prior tags.",
      );
    }
    priorMigrations.push(migration);
  }
  const bindings: EveDurableBinding[] = [
    {
      name: "EVE_CONTAINER",
      class_name: "EveHostDurableContainer",
    },
    ...(worldCloudflare
      ? [{ name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" }]
      : []),
  ];
  for (const priorBinding of request.durableObjects?.bindings ?? []) {
    if (
      typeof priorBinding.name !== "string" ||
      !IDENTIFIER_PATTERN.test(priorBinding.name) ||
      typeof priorBinding.class_name !== "string" ||
      !IDENTIFIER_PATTERN.test(priorBinding.class_name)
    ) {
      throw new EveHostError(
        "HOST_READINESS_UNPROVEN",
        "The recorded Durable Object bindings are not safely reusable; refusing to drop or rewrite prior bindings.",
      );
    }
    // Only classes the generated Worker can export are carried; the World
    // Durable Object's binding is retained across World switches so its class
    // (and SQLite data) is never dropped or left without a namespace.
    if (
      priorBinding.class_name === "EdenWorldDurableObject" &&
      bindings.every((binding) => binding.name !== priorBinding.name)
    ) {
      bindings.push(priorBinding);
    }
  }
  const declaredClasses = new Set(
    priorMigrations.flatMap(
      (migration) => migration.new_sqlite_classes ?? [],
    ),
  );
  const newClasses = [
    ...new Set(bindings.map((binding) => binding.class_name)),
  ].filter((className) => !declaredClasses.has(className));
  const migrations: EveDurableMigration[] = [...priorMigrations];
  if (newClasses.length > 0) {
    let sequence = priorMigrations.reduce(
      (highest, migration) =>
        /^v(\d+)$/u.test(migration.tag)
          ? Math.max(highest, Number(migration.tag.slice(1)))
          : highest,
      0,
    );
    const usedTags = new Set(priorMigrations.map((migration) => migration.tag));
    let tag = `v${sequence + 1}`;
    while (usedTags.has(tag)) {
      sequence += 1;
      tag = `v${sequence + 1}`;
    }
    migrations.push({ tag, new_sqlite_classes: newClasses });
  }
  return {
    worker: {
      ...(request.accountId === undefined
        ? {}
        : { account_id: request.accountId }),
      name: request.workerName,
      main: "worker.ts",
      compatibility_date: EVE_HOST_DEFAULTS.compatibilityDate,
      compatibility_flags: ["enable_ctx_exports"],
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
      durable_objects: { bindings },
      migrations,
    },
    container: {
      applicationName: request.containerApplicationName,
      className: "EveHostDurableContainer",
      instanceName: request.stableContainerInstanceName,
      bindingName: "EVE_CONTAINER",
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
    `import { EdenWorldDurableObject, EveHostDurableContainer, EveHostLoopback, createEveHostWorker } from ${JSON.stringify(moduleSpecifier)};`,
    `export { EveHostLoopback };`,
    "export { EveHostDurableContainer };",
    "",
    ...(request.config.worker.vars.EDEN_EVE_WORLD_CLOUDFLARE === true ||
      request.config.worker.durable_objects.bindings.some(
        (binding) => binding.class_name === "EdenWorldDurableObject",
      ) ||
      request.config.worker.migrations.some((migration) =>
        (migration.new_sqlite_classes ?? []).includes(
          "EdenWorldDurableObject",
        )
      )
      ? ["export { EdenWorldDurableObject };"]
      : []),
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new EveHostError(
      "HOST_REQUEST_ABORTED",
      "The client request was cancelled before Eve became ready.",
    );
  }
}

export interface EveHostContainerEnvironment {
  readonly [name: string]: unknown;
  readonly EVE_RUNTIME_VARIABLE_NAMES?: readonly string[];
  readonly EVE_PUBLIC_ORIGIN?: string;
  readonly EVE_CONTAINER_INSTANCE_NAME?: string;
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
  /**
   * Ensures the Container is started (`ctx.container.start` when not
   * running). Transient failures — scheduling-capacity errors surface only
   * through `monitor()`/`start()` — are retried inside the gate's overall
   * readiness deadline.
   */
  readonly start: (signal: AbortSignal) => Promise<void>;
  readonly healthFetch: (request: Request) => Promise<Response>;
  readonly healthPath?: "/eve/v1/health";
  readonly port?: 8080;
  /** Total deadline covering start retries and the health poll. */
  readonly readinessTimeoutMs?: number;
  /** Per-probe cap on a single health request. */
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
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 150_000;
  const healthTimeoutMs = options.healthTimeoutMs ?? 10_000;
  const waitIntervalMs = options.waitIntervalMs ?? 300;
  let evidence: EveHostReadinessEvidence | undefined;
  let inFlight:
    | Promise<EveHostReadinessEvidence>
    | undefined;
  let inFlightController: AbortController | undefined;
  let generation = 0;

  const run = async (signal: AbortSignal): Promise<EveHostReadinessEvidence> => {
    const deadline = Date.now() + readinessTimeoutMs;
    let lastFailure: EveHostError | undefined;
    const sleep = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitIntervalMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(
            new EveHostError(
              "HOST_REQUEST_ABORTED",
              "The client request was cancelled before Eve became ready.",
            ),
          );
        }, { once: true });
      });
    const probe = async (): Promise<EveHostReadinessEvidence | undefined> => {
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
        // The port is not open yet (or the probe was aborted); poll again
        // until the overall readiness deadline.
        return undefined;
      } finally {
        clearTimeout(healthTimeout);
        signal.removeEventListener("abort", abortHealth);
      }
      if (response.status !== 200) {
        await response.arrayBuffer().catch(() => undefined);
        lastFailure = new EveHostError(
          "HOST_READINESS_UNPROVEN",
          "The Eve health route did not return the expected successful status.",
        );
        return undefined;
      }
      if (
        !(response.headers.get("content-type") ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        await response.arrayBuffer().catch(() => undefined);
        lastFailure = new EveHostError(
          "HOST_READINESS_UNPROVEN",
          "The Eve health route did not return the expected JSON contract.",
        );
        return undefined;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        lastFailure = new EveHostError(
          "HOST_READINESS_UNPROVEN",
          "The Eve health route did not return a valid ready response.",
        );
        return undefined;
      }
      if (!responseBodyIsReady(body)) {
        lastFailure = new EveHostError(
          "HOST_READINESS_UNPROVEN",
          "The Eve health route is reachable but has not reported ready.",
        );
        return undefined;
      }
      return {
        healthPath,
        healthStatus: "ready",
        healthVerified: true,
        port,
        checkedAt: new Date().toISOString(),
      };
    };
    for (;;) {
      throwIfAborted(signal);
      try {
        await options.start(signal);
      } catch (error: unknown) {
        throwIfAborted(signal);
        // Transient scheduling/capacity failures surface through start() or
        // monitor(); retry until the readiness deadline.
        lastFailure = error instanceof EveHostError
          ? error
          : new EveHostError(
            "HOST_READINESS_UNPROVEN",
            "The Eve Container could not be scheduled for start.",
          );
      }
      const result = await probe();
      if (result !== undefined) return result;
      if (Date.now() >= deadline) {
        throw lastFailure ?? new EveHostError(
          "HOST_READINESS_UNPROVEN",
          "The Eve Container did not reach its readiness deadline.",
        );
      }
      await sleep();
    }
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


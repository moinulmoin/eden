import { randomUUID } from "crypto";
import { Resolver } from "dns/promises";
import { constants } from "fs";
import { link, lstat, mkdir, open, unlink } from "fs/promises";
import { request as httpRequest, type ClientRequest, type RequestOptions } from "http";
import { request as httpsRequest } from "https";
import { isIP } from "net";
import { homedir } from "os";
import { isAbsolute, join } from "path";

import { readEveVersion } from "./eve-packaging.js";

/** Where events go unless EDEN_TELEMETRY_URL names another endpoint. See README.md#telemetry. */
export const TELEMETRY_URL = "https://telemetry.eden.ideaplexa.com/v1/events";

/** Everything telemetry does, from reading the project to the response, ends by then. */
const DEADLINE_MS = 1_000;
/** Larger files are not read; a pnpm lockfile of a large project stays well under this. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

const NOTICE = [
  "Eden sends anonymous usage data after each preflight, deploy, and destroy: the command, its outcome, a rough duration, and versions.",
  "It never sends project, target, or account names, paths, or secrets. What is sent: https://github.com/moinulmoin/eden#telemetry",
  "Turn it off with EDEN_TELEMETRY=0 or DO_NOT_TRACK=1. This notice is shown once.",
];

/** Only whether these are set is read; no value is sent. */
const CI_VARIABLES = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TRAVIS",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
];

/**
 * Eden's own stable failure codes. Any other code is sent as "other". Add a
 * new code here when you add it to docs/troubleshooting.md.
 */
export const TELEMETRY_FAILURE_CODES: ReadonlySet<string> = new Set([
  "CLEANUP_UNVERIFIED", "COMMAND_UNKNOWN", "DEPENDENCY_AMBIGUITY", "DEPLOY_INDETERMINATE",
  "DOCKER_PLATFORM_BLOCKED", "EVE_AFFINITY_CONTROL_ACTIVATION_TIMEOUT",
  "EVE_AFFINITY_DRAIN_UNPROVEN", "EVE_AFFINITY_LIMIT", "EVE_AFFINITY_REQUIRED",
  "EVE_AFFINITY_RETIRE_UNPROVEN", "EVE_AI_GATEWAY_KEY_MISSING", "EVE_ARGUMENT_UNKNOWN",
  "EVE_BUILD_FAILED", "EVE_CF_LOGIN_TOKEN_UNAVAILABLE", "EVE_CF_UNAVAILABLE", "EVE_COMMAND_UNKNOWN",
  "EVE_DEPLOYMENT_FAILED", "EVE_DEPLOY_BUSY", "EVE_DEPLOY_CHECKS_FAILED",
  "EVE_DEPLOY_LOCK_RELEASE_UNPROVEN", "EVE_DEPLOY_PROMOTION_FAILED", "EVE_DESTROY_ABSENCE_UNPROVEN",
  "EVE_DESTROY_FAILED", "EVE_DESTROY_IMAGES_RETAINED", "EVE_DESTROY_INDETERMINATE",
  "EVE_DESTROY_OWNERSHIP_UNPROVEN", "EVE_DESTROY_POINTER_UNCLEARED", "EVE_DESTROY_RECORD_MISMATCH",
  "EVE_DESTROY_RECORD_UNPROVEN", "EVE_ENV_FILE_DUPLICATE", "EVE_ENV_FILE_ENCODING",
  "EVE_ENV_FILE_INVALID", "EVE_ENV_FILE_MALFORMED", "EVE_ENV_FILE_NOT_FOUND", "EVE_ENV_FILE_RACE",
  "EVE_ENV_FILE_REPEATED", "EVE_ENV_FILE_UNREADABLE", "EVE_ENV_FILE_UNSUPPORTED", "EVE_ENV_INVALID",
  "EVE_ENV_REPEATED", "EVE_ENV_RESERVED_VARIABLE", "EVE_EXECUTION_FAILED", "EVE_HEALTH_FAILED",
  "EVE_HOST_BUNDLE_UNAVAILABLE", "EVE_HOST_CONFIG_INVALID", "EVE_IMAGE_IDENTITY_MISMATCH",
  "EVE_IMAGE_IDENTITY_UNAVAILABLE", "EVE_JUST_BASH_MISSING", "EVE_NAME_CONTAINER_SHARED",
  "EVE_NAME_DERIVATION_FAILED", "EVE_NAME_INVALID", "EVE_NAME_REPEATED", "EVE_NAME_REQUIRED",
  "EVE_NODE_UNSUPPORTED", "EVE_NPM_INSTALL_SCRIPTS_SKIPPED", "EVE_OPTION_UNKNOWN",
  "EVE_OPTION_VALUE_MISSING", "EVE_ORIGIN_UNAVAILABLE", "EVE_PREFLIGHT_FAILED",
  "EVE_PROJECT_INVALID", "EVE_PROJECT_REPEATED", "EVE_PROJECT_ROOT_INVALID",
  "EVE_REGISTRY_OBJECTS_KEPT", "EVE_RUNTIME_IMAGE_CLEANUP_FAILED", "EVE_RUNTIME_INJECTION_INVALID",
  "EVE_RUNTIME_LOCAL_INJECTION_UNSUPPORTED", "EVE_RUNTIME_PROTECTED_STORE_UNAVAILABLE",
  "EVE_RUNTIME_PROTECTED_UPLOAD_FAILED", "EVE_SANDBOX_PROVIDER", "EVE_SCHEDULE_UNSUPPORTED",
  "EVE_SUPERSEDED_IMAGE_NOT_DELETED", "EVE_UNAUTHENTICATED_VERSIONS_RETIRED",
  "EVE_UPDATE_IN_FLIGHT", "EVE_UPDATE_RECORD_UNAVAILABLE", "EVE_UPDATE_WORLD_SWITCH",
  "EVE_VERCEL_CONNECT", "EVE_VERSION_UNSUPPORTED", "EVE_WORLD_LOCAL", "EVE_WORLD_PAIRING",
  "EVE_WORLD_POSTGRES_POOLED", "ROOT_INVALID", "RUNTIME_CLOSURE_INCOMPLETE",
  "SECRET_EXCLUSION_FAILED", "SINGLETON_ARTIFACT_EXISTS", "SOURCE_RACE", "UNSUPPORTED_EVE_OUTPUT",
  "UNSUPPORTED_HOST_REQUIREMENT", "UNSUPPORTED_TOOLCHAIN", "VERSION_UNAVAILABLE",
  "WORLD_MIGRATION_FAILED",
]);

/** A release version with small numbers and a known prerelease label; anything else is "other". */
const VERSION_PATTERN = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?:-(?:alpha|beta|rc|canary|next|preview)(?:\.(?:0|[1-9]\d{0,2}))?)?$/u;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface TelemetryRun {
  readonly command: "preflight" | "deploy" | "destroy";
  /** Reads Eden's own version; a failure here drops the event. */
  readonly edenVersion: () => string;
  /** The code of the failure; undefined when the command succeeded. */
  readonly failureCode: string | undefined;
  readonly durationMs: number;
  /** The selected project folder, read only for its Eve version and World package. */
  readonly projectRoot: string | undefined;
}

function isSet(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized !== "" && normalized !== "0" && normalized !== "false";
}

function telemetryOff(env: NodeJS.ProcessEnv): boolean {
  const eden = env.EDEN_TELEMETRY?.trim().toLowerCase();
  return eden === "0" || eden === "false" || eden === "off" || isSet(env.DO_NOT_TRACK);
}

function boundedVersion(version: string | undefined): string | null {
  if (version === undefined) return null;
  return VERSION_PATTERN.test(version) ? version : "other";
}

function durationBucket(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return "<10s";
  if (seconds < 60) return "10s-1m";
  if (seconds < 300) return "1m-5m";
  if (seconds < 900) return "5m-15m";
  if (seconds < 3600) return "15m-1h";
  return ">1h";
}

/**
 * Reads a regular file without following a symbolic link at its path and
 * without waiting on a FIFO or device; undefined for anything else.
 */
async function readRegularFile(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_READ_BYTES) return undefined;
    return await handle.readFile("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function worldKind(projectRoot: string): Promise<"cloudflare" | "postgres" | "local" | "other" | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readRegularFile(join(projectRoot, "package.json")) ?? "");
  } catch {
    return null;
  }
  if (manifest === null || typeof manifest !== "object") return null;
  const names = ["dependencies", "devDependencies", "optionalDependencies"].flatMap((field) => {
    const deps = (manifest as Record<string, unknown>)[field];
    return deps !== null && typeof deps === "object" ? Object.keys(deps) : [];
  });
  if (names.includes("@moinulmoin/eden-world-cloudflare")) return "cloudflare";
  if (names.includes("@workflow/world-postgres")) return "postgres";
  if (names.some((name) => name.startsWith("@workflow/world-") && name !== "@workflow/world-local")) return "other";
  return "local";
}

/** The saved ID, undefined when the file is missing, or null when it is there but not Eden's. */
async function savedId(file: string): Promise<string | undefined | null> {
  const details = await lstat(file).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : null);
  if (details === undefined) return undefined;
  if (details === null || !details.isFile()) return null;
  try {
    const saved: unknown = JSON.parse(await readRegularFile(file) ?? "");
    const id = saved !== null && typeof saved === "object" && "installId" in saved ? saved.installId : undefined;
    return typeof id === "string" && UUID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Reads the install ID, or creates it with one atomic, no-clobber link.
 * Undefined, and telemetry skipped, when the folder or file is a symbolic
 * link, unreadable, unwritable, or not Eden's.
 */
async function installId(env: NodeJS.ProcessEnv, expired: () => boolean): Promise<{ id: string; created: boolean } | undefined> {
  const configHome = env.XDG_CONFIG_HOME !== undefined && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  const folder = join(configHome, "eden");
  const file = join(folder, "telemetry.json");
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  if ((await lstat(folder).catch(() => undefined))?.isDirectory() !== true) return undefined;
  const saved = await savedId(file);
  if (saved !== undefined) return saved === null ? undefined : { id: saved, created: false };
  if (expired()) return undefined;
  const id = randomUUID();
  const staged = join(folder, `.telemetry-${randomUUID()}.tmp`);
  try {
    const handle = await open(staged, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ installId: id })}\n`);
    } finally {
      await handle.close();
    }
    if (expired()) return undefined;
    await link(staged, file);
    return { id, created: true };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    const other = await savedId(file);
    return typeof other === "string" ? { id: other, created: false } : undefined;
  } finally {
    await unlink(staged).catch(() => undefined);
  }
}

/** Posts the body once. Every handle it opens is registered in `cleanups`. */
async function post(url: URL, body: string, cleanups: (() => void)[], expired: () => boolean): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  const hostname = url.hostname.replace(/^\[(.*)\]$/u, "$1");
  let address = hostname;
  if (hostname === "localhost") address = "127.0.0.1";
  else if (isIP(hostname) === 0) {
    // A cancellable resolver: getaddrinfo, which Node uses by default, cannot be stopped.
    const resolver = new Resolver({ timeout: DEADLINE_MS, tries: 1 });
    cleanups.push(() => resolver.cancel());
    const addresses = await resolver.resolve4(hostname).catch(() => expired() ? [] : resolver.resolve6(hostname));
    if (addresses[0] === undefined) return;
    address = addresses[0];
  }
  if (expired()) return;
  const options: RequestOptions & { servername?: string } = {
    host: address,
    ...(url.port === "" ? {} : { port: Number(url.port) }),
    path: `${url.pathname}${url.search}`,
    method: "POST",
    agent: false,
    headers: { host: url.host, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
  };
  const request: ClientRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)(options);
  cleanups.push(() => request.destroy());
  await new Promise<void>((resolve, reject) => {
    request.on("response", () => resolve());
    request.on("error", reject);
    request.end(body);
  });
}

async function deliver(
  run: TelemetryRun,
  env: NodeJS.ProcessEnv,
  notice: (line: string) => void,
  cleanups: (() => void)[],
  expired: () => boolean,
): Promise<void> {
  const install = await installId(env, expired);
  if (install === undefined) return;
  if (install.created) {
    for (const line of NOTICE) {
      try { notice(line); } catch { break; }
    }
  }
  const eveVersion = run.projectRoot === undefined ? undefined : await readEveVersion(run.projectRoot, readRegularFile);
  const world = run.projectRoot === undefined ? null : await worldKind(run.projectRoot);
  if (expired()) return;
  const body = JSON.stringify({
    schema: 1,
    installId: install.id,
    command: run.command,
    edenVersion: boundedVersion(run.edenVersion()) ?? "other",
    exitCode: run.failureCode === undefined ? 0 : 1,
    failureCode: run.failureCode === undefined
      ? null
      : TELEMETRY_FAILURE_CODES.has(run.failureCode) ? run.failureCode : "other",
    duration: durationBucket(run.durationMs),
    os: ["darwin", "linux", "win32"].includes(process.platform) ? process.platform : "other",
    arch: ["arm64", "x64"].includes(process.arch) ? process.arch : "other",
    nodeMajor: Number(process.versions.node.split(".")[0]),
    eveVersion: boundedVersion(eveVersion),
    world,
    ci: CI_VARIABLES.some((name) => isSet(env[name])),
  });
  await post(new URL(env.EDEN_TELEMETRY_URL || TELEMETRY_URL), body, cleanups, expired);
}

/**
 * Sends one anonymous event for a finished command. Everything it does ends
 * within one second: at the deadline it stops waiting and closes every
 * socket and DNS query it opened, so nothing holds the process. It never
 * throws and prints nothing but the first-run notice.
 */
export async function sendTelemetry(
  run: TelemetryRun,
  env: NodeJS.ProcessEnv,
  notice: (line: string) => void,
): Promise<void> {
  if (telemetryOff(env)) return;
  const cleanups: (() => void)[] = [];
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, DEADLINE_MS); });
  const work = deliver(run, env, notice, cleanups, () => done).catch(() => undefined);
  await Promise.race([work, deadline]);
  done = true;
  clearTimeout(timer);
  for (const cleanup of cleanups) {
    try { cleanup(); } catch { /* already closed */ }
  }
}

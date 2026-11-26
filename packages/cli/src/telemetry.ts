import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join } from "path";

import { parseEveRelease, readEveVersion } from "./eve-packaging.js";

/** Where events go unless EDEN_TELEMETRY_URL names another endpoint. See README.md#telemetry. */
export const TELEMETRY_URL = "https://telemetry.eden.ideaplexa.com/v1/events";

const SEND_TIMEOUT_MS = 1_000;

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface TelemetryRun {
  readonly command: "preflight" | "deploy" | "destroy";
  /** Reads Eden's own version; a failure here drops the event. */
  readonly edenVersion: () => string;
  /** The stable code of the failure; undefined when the command succeeded. */
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

function durationBucket(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return "<10s";
  if (seconds < 60) return "10s-1m";
  if (seconds < 300) return "1m-5m";
  if (seconds < 900) return "5m-15m";
  if (seconds < 3600) return "15m-1h";
  return ">1h";
}

async function worldKind(projectRoot: string): Promise<"cloudflare" | "postgres" | "local" | "other" | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
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

/** Reads the install ID, or creates it and prints the notice. Undefined when it cannot be kept. */
async function installId(env: NodeJS.ProcessEnv, stderr: (line: string) => void): Promise<string | undefined> {
  const configHome = env.XDG_CONFIG_HOME !== undefined && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  const folder = join(configHome, "eden");
  const file = join(folder, "telemetry.json");
  try {
    const saved: unknown = JSON.parse(await readFile(file, "utf8"));
    const id = saved !== null && typeof saved === "object" && "installId" in saved ? saved.installId : undefined;
    if (typeof id === "string" && UUID_PATTERN.test(id)) return id;
  } catch {
    // A missing or unreadable file gets a new ID below.
  }
  const id = randomUUID();
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ installId: id })}\n`, { mode: 0o600 });
  } catch {
    return undefined;
  }
  for (const line of NOTICE) stderr(line);
  return id;
}

/**
 * Sends one anonymous event for a finished command. It never throws, prints
 * nothing but the first-run notice, and gives up after one second.
 */
export async function sendTelemetry(
  run: TelemetryRun,
  env: NodeJS.ProcessEnv,
  stderr: (line: string) => void,
): Promise<void> {
  try {
    if (telemetryOff(env)) return;
    const id = await installId(env, stderr);
    if (id === undefined) return;
    const eveVersion = run.projectRoot === undefined ? undefined : await readEveVersion(run.projectRoot);
    const event = {
      schema: 1,
      installId: id,
      command: run.command,
      edenVersion: run.edenVersion(),
      exitCode: run.failureCode === undefined ? 0 : 1,
      failureCode: run.failureCode === undefined
        ? null
        : /^[A-Z][A-Z0-9_]{0,63}$/u.test(run.failureCode) ? run.failureCode : "EVE_EXECUTION_FAILED",
      duration: durationBucket(run.durationMs),
      os: ["darwin", "linux", "win32"].includes(process.platform) ? process.platform : "other",
      arch: ["arm64", "x64"].includes(process.arch) ? process.arch : "other",
      nodeMajor: Number(process.versions.node.split(".")[0]),
      eveVersion: eveVersion !== undefined && eveVersion.length <= 64 && parseEveRelease(eveVersion) !== null
        ? eveVersion
        : null,
      world: run.projectRoot === undefined ? null : await worldKind(run.projectRoot),
      ci: CI_VARIABLES.some((name) => isSet(env[name])),
    };
    const response = await fetch(env.EDEN_TELEMETRY_URL || TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    // A failed or slow send is dropped.
  }
}

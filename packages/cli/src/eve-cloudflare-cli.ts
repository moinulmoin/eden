import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cfEntrypoint = join(
  dirname(createRequire(import.meta.url).resolve("cf/package.json")),
  "bin",
  "cf",
);

/** The cf command users run by hand, at the version Eden runs. Tested on Cloudflare on 2026-11-20. */
export const CF_COMMAND = "npx cf@1.0.0-rc.2";

export interface CloudflareCliRequest {
  readonly args: readonly string[];
  /** Makes cf act on this account or fail. Without it cf names the login's own. */
  readonly accountId?: string;
  /** Files written into the command's private folder before it runs, by relative path. */
  readonly files?: Readonly<Record<string, string | Buffer>>;
  readonly timeoutMs?: number;
}

export interface CloudflareCliResult {
  /** The code cf itself exited with; undefined when it was killed, timed out, or never started. */
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

export type CloudflareCliRunner = (
  request: CloudflareCliRequest,
) => Promise<CloudflareCliResult>;

/** The variables cf and Docker need; nothing else of the caller's environment reaches them. */
export function cloudflareCliEnvironment(accountId: string | undefined): NodeJS.ProcessEnv {
  const env = process.env;
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    TMPDIR: env.TMPDIR,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    DOCKER_HOST: env.DOCKER_HOST,
    DOCKER_CONTEXT: env.DOCKER_CONTEXT,
    DOCKER_CONFIG: env.DOCKER_CONFIG,
    DOCKER_CERT_PATH: env.DOCKER_CERT_PATH,
    DOCKER_TLS_VERIFY: env.DOCKER_TLS_VERIFY,
    HTTP_PROXY: env.HTTP_PROXY,
    HTTPS_PROXY: env.HTTPS_PROXY,
    NO_PROXY: env.NO_PROXY,
    http_proxy: env.http_proxy,
    https_proxy: env.https_proxy,
    no_proxy: env.no_proxy,
    NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_AUTH_PROFILE: env.CLOUDFLARE_AUTH_PROFILE,
    CLOUDFLARE_ACCOUNT_ID: accountId ?? env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
    CF_SEND_TELEMETRY: env.CF_SEND_TELEMETRY,
    DO_NOT_TRACK: env.DO_NOT_TRACK,
    NO_COLOR: "1",
    CF_QUIET: "1",
  };
}

/**
 * Runs cf in a private folder of its own. cf runs the nearest
 * cloudflare.config.ts it finds from its folder upward and reads .env files
 * beside it, so the folder holds an empty config and nothing else of the
 * user's: no file on disk chooses the account or the credentials.
 */
export const runCloudflareCli: CloudflareCliRunner = createCloudflareCliRunner();

/** `environment` replaces the variables cf gets; the live check uses it to put a failing API in front of one command. */
export function createCloudflareCliRunner(
  environment: (accountId: string | undefined) => NodeJS.ProcessEnv = cloudflareCliEnvironment,
): CloudflareCliRunner {
  return (request) => runCf(request, environment);
}

async function runCf(
  request: CloudflareCliRequest,
  environment: (accountId: string | undefined) => NodeJS.ProcessEnv,
): Promise<CloudflareCliResult> {
  const cwd = await mkdtemp(join(tmpdir(), "eden-cf-"));
  try {
    await writeFile(join(cwd, "cloudflare.config.ts"), "export default {};\n", { mode: 0o600 });
    for (const [path, content] of Object.entries(request.files ?? {})) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content, { mode: 0o600 });
    }
    return await new Promise<CloudflareCliResult>((resolveResult) => {
      const child = spawn(process.execPath, [cfEntrypoint, ...request.args], {
        cwd,
        env: environment(request.accountId),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (exitCode: number | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(undefined);
      }, request.timeoutMs ?? 120_000);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", () => finish(undefined));
      child.on("close", (code) => finish(code ?? undefined));
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** What cf returned on stdout as JSON, only when cf exited 0 and printed one JSON value. */
export function cloudflareCliJson(result: CloudflareCliResult): { readonly value: unknown } | undefined {
  if (result.exitCode !== 0) return undefined;
  try {
    return { value: JSON.parse(result.stdout) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * The paging facts cf printed for a list, which it writes to stderr as one
 * `result_info: {...}` line. Undefined when cf printed none; null when what
 * it printed cannot be read as exactly one.
 */
export function cloudflareResultInfo(
  result: CloudflareCliResult,
): Readonly<Record<string, unknown>> | undefined | null {
  const lines = result.stderr.split("\n").filter((line) => line.startsWith("result_info:"));
  if (lines.length === 0) return undefined;
  if (lines.length > 1) return null;
  try {
    const value = JSON.parse((lines[0] as string).slice("result_info:".length)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Readonly<Record<string, unknown>>
      : null;
  } catch {
    return null;
  }
}

export interface CloudflareApiError {
  /** Each error or message Cloudflare's API sent, in order. */
  readonly entries: readonly { readonly code?: number; readonly message: string }[];
  readonly status: number;
  /** The request path after /client/v4, with its query. */
  readonly path: string;
}

/**
 * The one Cloudflare API error cf 1.0.0-rc.2 printed, or undefined for
 * anything else. cf prints errors as text, read on 2026-11-20:
 *
 *   ┌ APIError
 *   │ [10007] This Worker does not exist on your account.
 *   │ 404 Not Found · HTTP /accounts/<id>/workers/scripts/<name>/deployments
 *   └
 *
 * Only a normal exit with code 1, an empty stdout, and exactly one such box
 * whose every line is accounted for is an answer. Whatever does not fit is
 * undefined, and no caller reads undefined as "absent".
 */
export function cloudflareApiError(result: CloudflareCliResult): CloudflareApiError | undefined {
  const text = errorBox(result, "APIError");
  if (text === undefined || text.length < 2) return undefined;
  const tail = /^(\d{3}) [A-Za-z' -]+ · HTTP (\/\S+)$/u.exec(text[text.length - 1] ?? "");
  if (tail === null) return undefined;
  const entries: { code?: number; message: string }[] = [];
  for (const line of text.slice(0, -1)) {
    if (line.length === 0) continue;
    const coded = /^\[(\d+)\] (.*)$/u.exec(line);
    const plain = /^\[error\] (.*)$/u.exec(line);
    if (coded !== null) entries.push({ code: Number(coded[1]), message: coded[2] ?? "" });
    else if (plain !== null) entries.push({ message: plain[1] ?? "" });
    else return undefined;
  }
  if (entries.length === 0) return undefined;
  return { entries, status: Number(tail[1]), path: tail[2] ?? "" };
}

/** The lines of the one error box with this title that cf printed and exited 1 on, and nothing else. */
function errorBox(result: CloudflareCliResult, title: string): readonly string[] | undefined {
  if (result.exitCode !== 1 || result.stdout.length > 0) return undefined;
  const lines = result.stderr.split("\n").map((line) => line.replace(/\r$/u, ""));
  const start = lines.findIndex((line) => line.startsWith("┌ "));
  if (lines[start] !== `┌ ${title}` || lines.some((line, at) => at !== start && line.startsWith("┌"))) return undefined;
  const end = lines.indexOf("└", start);
  if (end === -1) return undefined;
  // Outside the box cf prints only blank lines and one "→" hint.
  const outside = [...lines.slice(0, start), ...lines.slice(end + 1)];
  if (outside.some((line) => line.trim().length > 0 && !line.startsWith("→ "))) return undefined;
  const inner = lines.slice(start + 1, end);
  if (inner.some((line) => line !== "│" && !line.startsWith("│ "))) return undefined;
  return inner.map((line) => line.slice(2));
}

/**
 * The message of the one error of its own that cf printed, or undefined for
 * anything else. cf wraps a long message over several lines of its box,
 * breaking at spaces, read on 2026-11-20:
 *
 *   ┌ Error
 *   │ Failed to delete
 *   │ <repository>:<tag>
 *   │ (digest:
 *   │ sha256:<digest>): 403
 *   │ Forbidden
 *   └
 */
export function cloudflareCliError(result: CloudflareCliResult): string | undefined {
  const text = errorBox(result, "Error");
  return text === undefined || text.length === 0 || text.some((line) => line.length === 0)
    ? undefined
    : text.join(" ");
}

/** True only for Cloudflare's own single answer with this status, code, and exact request path. */
export function cloudflareApiAnswered(
  result: CloudflareCliResult,
  expected: { readonly status: number; readonly code: number; readonly path: string },
): boolean {
  const error = cloudflareApiError(result);
  return error !== undefined && error.status === expected.status && error.path === expected.path &&
    error.entries.length === 1 && error.entries[0]?.code === expected.code;
}

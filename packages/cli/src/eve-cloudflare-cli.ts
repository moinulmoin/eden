import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The one cf version Eden runs. Tested on Cloudflare on 2026-11-20. */
export const CF_VERSION = "1.0.0-rc.2";

/** The cf command users run by hand, at the version Eden runs. */
export const CF_COMMAND = `npx cf@${CF_VERSION}`;

/**
 * The cf login profile every command of Eden uses: the one
 * CLOUDFLARE_AUTH_PROFILE names, else cf's "default". Naming it in each
 * command keeps a folder's "cf auth activate" binding from choosing another.
 */
export function cloudflareAuthProfile(): string {
  const named = process.env.CLOUDFLARE_AUTH_PROFILE;
  return named !== undefined && named.length > 0 ? named : "default";
}

/** The cf auth command to run by hand so that it reads the login Eden reads. */
export function cfAuthCommand(command: "login" | "whoami"): string {
  return `${CF_COMMAND} auth ${command} --profile ${cloudflareAuthProfile()}`;
}

/** The cf package installed beside Eden, looked up when a command needs it, so help works without it. */
function installedCloudflareCli(): { readonly entrypoint: string; readonly version: unknown } {
  const manifest = createRequire(import.meta.url).resolve("cf/package.json");
  return {
    entrypoint: join(dirname(manifest), "bin", "cf"),
    version: (JSON.parse(readFileSync(manifest, "utf8")) as { readonly version?: unknown }).version,
  };
}

/**
 * Why Eden cannot run its cf, or undefined when the pinned one is installed.
 * `found` replaces the installed version for a test; null stands for none.
 */
export function pinnedCliProblem(
  found?: string | null,
): { readonly message: string; readonly remediation: string } | undefined {
  let version: unknown = found ?? undefined;
  if (found === undefined) {
    try {
      version = installedCloudflareCli().version;
    } catch {
      version = undefined;
    }
  }
  if (version === CF_VERSION) return undefined;
  return {
    message: typeof version === "string"
      ? `Eden runs Cloudflare's cf CLI ${CF_VERSION} and found cf ${version} installed in its place.`
      : `Eden runs Cloudflare's cf CLI ${CF_VERSION}, which is installed with Eden, and could not find it.`,
    remediation: `Install @moinulmoin/eden again with your package manager, which installs cf ${CF_VERSION} beside it, and do not install another cf version over that one. Then run the command again.`,
  };
}

export interface CloudflareCliRequest {
  readonly args: readonly string[];
  /** Makes cf act on this account or fail. Without it cf names the login's own. */
  readonly accountId?: string;
  /** Files written into the command's private folder before it runs, by relative path. */
  readonly files?: Readonly<Record<string, string | Buffer>>;
  readonly timeoutMs?: number;
  /**
   * Where this one command finds Cloudflare's API, in place of Cloudflare's
   * own address. Only the read of cf's login uses it, with a listener of
   * Eden's own, so the command also gets no proxy and sends no telemetry.
   */
  readonly apiBaseUrl?: string;
  /** Written to standard error when Ctrl-C or a kill ends Eden while this command runs. */
  readonly interruptNote?: string;
}

export interface CloudflareCliResult {
  /** The code cf itself exited with; undefined when it was killed, timed out, or never started. */
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when cf was started, was told to stop, and did not report that it had stopped. */
  readonly running?: true;
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
    CLOUDFLARE_AUTH_PROFILE: cloudflareAuthProfile(),
    // Where cf keeps and looks for its login; without it a keyring-only login can look signed out.
    CLOUDFLARE_AUTH_USE_KEYRING: env.CLOUDFLARE_AUTH_USE_KEYRING,
    CLOUDFLARE_ACCOUNT_ID: accountId ?? env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
    CF_SEND_TELEMETRY: env.CF_SEND_TELEMETRY,
    DO_NOT_TRACK: env.DO_NOT_TRACK,
    NO_COLOR: "1",
    CF_QUIET: "1",
    // With this set, cf never hands the command to another cf installed above its folder.
    CF_DELEGATION: "1",
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
  // The time allowed covers the folder and its files too: a command whose time ran out there is not started.
  const deadline = performance.now() + (request.timeoutMs ?? 120_000);
  const cwd = await mkdtemp(join(tmpdir(), "eden-cf-"));
  let child: ReturnType<typeof spawn> | undefined;
  // The folder can hold the secrets file. Ctrl-C and a plain kill must not
  // leave it: remove it, stop cf, then let the signal end Eden as it would have.
  const interrupted = (signal: NodeJS.Signals): void => {
    child?.kill("SIGKILL");
    if (child !== undefined && request.interruptNote !== undefined) process.stderr.write(request.interruptNote + "\n");
    rmSync(cwd, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    process.kill(process.pid, signal);
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  try {
    await writeFile(join(cwd, "cloudflare.config.ts"), "export default {};\n", { mode: 0o600 });
    for (const [path, content] of Object.entries(request.files ?? {})) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), content, { mode: 0o600 });
    }
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) return { exitCode: undefined, stdout: "", stderr: "" };
    return await new Promise<CloudflareCliResult>((resolveResult) => {
      const started = spawn(process.execPath, [installedCloudflareCli().entrypoint, ...request.args], {
        cwd,
        env: {
          ...environment(request.accountId),
          ...(request.apiBaseUrl === undefined ? {} : {
            CLOUDFLARE_API_BASE_URL: request.apiBaseUrl,
            HTTP_PROXY: undefined,
            HTTPS_PROXY: undefined,
            http_proxy: undefined,
            https_proxy: undefined,
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
            CF_SEND_TELEMETRY: "false",
            DO_NOT_TRACK: "1",
          }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = started;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let unstopped: NodeJS.Timeout | undefined;
      const finish = (exitCode: number | undefined, running = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(unstopped);
        resolveResult({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...(running ? { running: true as const } : {}),
        });
      };
      // Out of time: cf is killed, and the result waits until it is gone.
      // Only cf's own exit shows that. A kill that could not be delivered
      // does not, so after two seconds without an exit the result says cf
      // may still run.
      const timer = setTimeout(() => {
        timedOut = true;
        started.kill("SIGKILL");
        unstopped = setTimeout(() => finish(undefined, true), 2_000);
      }, left);
      started.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      started.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      // An error from a cf that never started ends the command. One from a
      // cf that did start, such as a signal that was not delivered, says
      // nothing about whether cf has stopped.
      started.on("error", () => { if (started.pid === undefined) finish(undefined); });
      started.on("exit", () => { if (timedOut) finish(undefined); });
      started.on("close", (code) => finish(timedOut ? undefined : code ?? undefined));
    });
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
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

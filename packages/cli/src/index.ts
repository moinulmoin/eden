#!/usr/bin/env node

import {
  createHash,
  randomUUID,
} from "crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "fs/promises";
import {
  watch,
  type FSWatcher,
} from "chokidar";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "path";
import {
  fileURLToPath,
} from "url";
import {
  execFile,
  spawn as spawnChild,
} from "child_process";
import {
  createConnection,
  createServer,
} from "net";
import {
  createRequire,
} from "module";

import {
  buildProject,
  createArtifactIdentity,
  EdenCompilerError,
  resolveContainedProjectPath,
  resolveProjectRoot,
} from "@eden/compiler";
import type {
  EdenDiagnostic,
  EdenManifest,
  EdenModuleMap,
} from "@eden/compiler";

const require = createRequire(import.meta.url);

export const EDEN_CLI_COMMANDS = [
  "init",
  "dev",
  "build",
  "deploy",
] as const;

export type EdenCliCommand = (typeof EDEN_CLI_COMMANDS)[number];

export const EDEN_LOCAL_HOST = "127.0.0.1" as const;
export const EDEN_LOCAL_PORT = 8797 as const;
export const EDEN_LOCAL_INSPECTOR_HOST = "127.0.0.1" as const;
export const EDEN_LOCAL_INSPECTOR_PORT = 9297 as const;

export interface EdenCliInvocation {
  readonly command: EdenCliCommand;
  readonly projectRoot?: string;
}

export interface EdenCliResult {
  readonly command: EdenCliCommand;
  readonly ok: boolean;
}

export interface EdenCliDryRunRequest {
  readonly cwd: string;
  readonly configPath: string;
  readonly originalConfigPath: string;
  readonly args: readonly string[];
}

export interface EdenCliDryRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EdenCliProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readiness?: readonly {
    readonly host: string;
    readonly port: number;
  }[];
}

export interface EdenCliProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface EdenCliProcess {
  readonly pid: number;
  readonly exited: Promise<EdenCliProcessExit>;
  readonly ready?: Promise<void>;
  terminate(signal?: NodeJS.Signals): Promise<void>;
}

export interface EdenCliProcessRunner {
  spawn(request: EdenCliProcessRequest): EdenCliProcess;
}

export interface EdenCliRunOptions {
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly dryRunRunner?: (
    request: EdenCliDryRunRequest,
  ) => Promise<EdenCliDryRunResult>;
  readonly processRunner?: EdenCliProcessRunner;
}

interface ParsedInvocation {
  readonly command: EdenCliCommand;
  readonly projectRoot?: string;
  readonly environment?: "preview" | "production";
}

interface CliErrorOptions {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  readonly diagnostics?: readonly EdenDiagnostic[];
}

class EdenCliError extends Error {
  readonly code: string;
  readonly source: string | undefined;
  readonly diagnostics: readonly EdenDiagnostic[];

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.name = "EdenCliError";
    this.code = options.code;
    this.source = options.source;
    this.diagnostics = options.diagnostics ?? [];
  }
}

interface ScaffoldFile {
  readonly relativePath: string;
  readonly content: string;
}

interface ProjectConfiguration {
  readonly packagePath: string;
  readonly configPath: string;
}

const INIT_SCAFFOLD: readonly ScaffoldFile[] = [
  {
    relativePath: "agent/instructions.md",
    content: `You are a concise, helpful Eden example agent.
`,
  },
  {
    relativePath: "agent/agent.ts",
    content: `import type { EdenAgentDefinition } from "@eden/definitions";

const agent: EdenAgentDefinition = {
  model: "@cf/zai-org/glm-4.7-flash",
  options: {
    maxOutputTokens: 512,
    thinking: false,
  },
};

export default agent;
`,
  },
  {
    relativePath: "agent/tools/greet.ts",
    content: `import type { EdenToolDefinition } from "@eden/definitions";

interface GreetInput {
  readonly name: string;
}

const inputSchema = {
  "~standard": {
    version: 1,
    vendor: "eden-scaffold",
    validate(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { readonly name?: unknown }).name === "string" &&
        (value as { readonly name: string }).name.trim().length > 0
      ) {
        return {
          value: {
            name: (value as { readonly name: string }).name.trim(),
          },
        };
      }
      return {
        issues: [{ message: "name must be a non-empty string." }],
      };
    },
  },
} as const;

const greet: EdenToolDefinition<GreetInput, { readonly greeting: string }> = {
  description: "Greet a person by name.",
  inputSchema,
  execute(input) {
    return { greeting: \`Hello, \${input.name}!\` };
  },
};

export default greet;
`,
  },
  {
    relativePath: "package.json",
    content: `{
  "name": "eden-basic-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "eden build",
    "dev": "eden dev",
    "deploy": "eden deploy"
  }
}
`,
  },
  {
    relativePath: "wrangler.jsonc",
    content: `{
  "name": "eden-basic-agent",
  "main": ".eden/agent-bundle.mjs",
  "compatibility_date": "2026-04-01",
  "durable_objects": {
    "bindings": [
      {
        "name": "EDEN_SESSIONS",
        "class_name": "EdenSession"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["EdenSession"]
    }
  ]
}
`,
  },
] as const;

const CONFIG_CANDIDATES = [
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
] as const;

const USAGE = `Usage: eden <command> [options]

Commands:
  init    Create a minimal Eden project scaffold
  build   Validate and build a Worker-safe Eden artifact
  dev     Run the local Eden Worker on the approved Eden ports
  deploy  Validate and dry-run the deployment

Options:
  --project <path>  Select the project root (defaults to the current directory)
  --env <name>      Select preview or production for deploy
  --help            Show this help
`;

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function cliError(options: CliErrorOptions): EdenCliError {
  return new EdenCliError(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProjectValue(
  value: string | undefined,
): string {
  if (value === undefined || value.length === 0) {
    throw cliError({
      code: "PROJECT_ARGUMENT_INVALID",
      message: "The --project option requires a non-empty path.",
    });
  }
  return value;
}

function parseEnvironmentValue(
  value: string | undefined,
): "preview" | "production" {
  if (value === "preview" || value === "production") return value;
  throw cliError({
    code: "ENVIRONMENT_INVALID",
    message: "The --env option must be preview or production.",
  });
}

function parseArguments(
  args: readonly string[],
): ParsedInvocation | "help" {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return "help";
  }

  const commandValue = args[0];
  if (commandValue === undefined || !isEdenCliCommand(commandValue)) {
    throw cliError({
      code: "COMMAND_UNKNOWN",
      message: `Unknown Eden command "${commandValue ?? ""}".`,
    });
  }

  let projectRoot: string | undefined;
  let environment: "preview" | "production" | undefined;
  let help = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--project") {
      if (projectRoot !== undefined) {
        throw cliError({
          code: "PROJECT_ARGUMENT_REPEATED",
          message: "The --project option may be supplied only once.",
        });
      }
      projectRoot = parseProjectValue(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--project=") === true) {
      if (projectRoot !== undefined) {
        throw cliError({
          code: "PROJECT_ARGUMENT_REPEATED",
          message: "The --project option may be supplied only once.",
        });
      }
      projectRoot = parseProjectValue(argument.slice("--project=".length));
      continue;
    }
    if (argument === "--env") {
      if (environment !== undefined) {
        throw cliError({
          code: "ENVIRONMENT_REPEATED",
          message: "The --env option may be supplied only once.",
        });
      }
      environment = parseEnvironmentValue(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--env=") === true) {
      if (environment !== undefined) {
        throw cliError({
          code: "ENVIRONMENT_REPEATED",
          message: "The --env option may be supplied only once.",
        });
      }
      environment = parseEnvironmentValue(argument.slice("--env=".length));
      continue;
    }
    throw cliError({
      code: "ARGUMENT_UNKNOWN",
      message: `Unknown option "${argument ?? ""}".`,
    });
  }

  if (help) return "help";
  if (
    environment !== undefined &&
    commandValue !== "deploy"
  ) {
    throw cliError({
      code: "ENVIRONMENT_UNSUPPORTED",
      message: "The --env option is supported only by eden deploy.",
    });
  }
  return {
    command: commandValue,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(environment === undefined ? {} : { environment }),
  };
}

async function selectedProjectRoot(
  invocation: ParsedInvocation,
  cwd: string,
): Promise<string> {
  const selected = invocation.projectRoot ?? cwd;
  const lexicalPath = isAbsolute(selected)
    ? selected
    : resolve(cwd, selected);
  const lexicalDetails = await lstat(lexicalPath).catch(() => undefined);
  if (lexicalDetails?.isSymbolicLink() === true) {
    throw cliError({
      code: "PROJECT_ROOT_INVALID",
      message:
        "The selected project root must not be a symbolic link; choose its canonical directory explicitly.",
    });
  }
  return resolveProjectRoot({
    cwd,
    ...(invocation.projectRoot === undefined
      ? {}
      : { projectRoot: invocation.projectRoot }),
  });
}

async function ensureRegularFile(
  root: string,
  relativePath: string,
  requiredMessage: string,
): Promise<string> {
  const path = await resolveContainedProjectPath(root, relativePath);
  const details = await lstat(path).catch(() => undefined);
  if (details === undefined || !details.isFile()) {
    throw cliError({
      code: "PROJECT_FILE_MISSING",
      message: requiredMessage,
      source: relativePath,
    });
  }
  return path;
}

async function readProjectConfiguration(
  root: string,
): Promise<ProjectConfiguration> {
  const packagePath = await ensureRegularFile(
    root,
    "package.json",
    "The selected project must contain package.json before it can be built.",
  );
  let packageValue: unknown;
  try {
    packageValue = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
  } catch {
    throw cliError({
      code: "PACKAGE_JSON_INVALID",
      message: "The selected package.json is not valid JSON.",
      source: "package.json",
    });
  }
  if (
    !isRecord(packageValue) ||
    typeof packageValue.name !== "string" ||
    packageValue.name.trim().length === 0
  ) {
    throw cliError({
      code: "PACKAGE_JSON_INVALID",
      message: "package.json must define a non-empty name.",
      source: "package.json",
    });
  }

  for (const relativePath of CONFIG_CANDIDATES) {
    const path = await resolveContainedProjectPath(root, relativePath);
    const details = await lstat(path).catch(() => undefined);
    if (details?.isFile() === true) {
      return { packagePath, configPath: path };
    }
  }
  throw cliError({
    code: "PROJECT_CONFIG_MISSING",
    message:
      "The selected project must contain wrangler.jsonc, wrangler.json, or wrangler.toml.",
    source: "wrangler.jsonc",
  });
}

function uniqueTemporaryName(prefix: string): string {
  return `.${prefix}-${process.pid}-${randomUUID()}`;
}

function assertWithinRoot(
  root: string,
  candidate: string,
  description: string,
): void {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (
    candidate !== normalizedRoot &&
    !candidate.startsWith(`${normalizedRoot}/`) &&
    !candidate.startsWith(`${normalizedRoot}\\`)
  ) {
    throw cliError({
      code: "PATH_OUTSIDE_PROJECT",
      message: `${description} must remain inside the selected project root.`,
    });
  }
}

async function writeScaffold(
  root: string,
): Promise<void> {
  const entries = await readdir(root);
  if (entries.length !== 0) {
    throw cliError({
      code: "INIT_ROOT_NOT_EMPTY",
      message:
        "eden init requires an empty selected project root and will not overwrite existing files.",
    });
  }

  const stageName = uniqueTemporaryName("eden-init");
  const stage = join(root, stageName);
  assertWithinRoot(root, stage, "The scaffold staging directory");
  const moved: string[] = [];
  try {
    await mkdir(join(stage, "agent/tools"), { recursive: true });
    for (const file of INIT_SCAFFOLD) {
      const stagedPath = join(stage, file.relativePath);
      await writeFile(stagedPath, file.content, { encoding: "utf8", flag: "wx" });
    }

    const afterStage = await readdir(root);
    if (
      afterStage.length !== 1 ||
      afterStage[0] !== stageName
    ) {
      throw cliError({
        code: "INIT_ROOT_CHANGED",
        message:
          "The selected project root changed while eden init was preparing the scaffold; no files were overwritten.",
      });
    }

    const targets = ["agent", "package.json", "wrangler.jsonc"] as const;
    for (const target of targets) {
      const destination = join(root, target);
      const existing = await lstat(destination).catch(() => undefined);
      if (existing !== undefined) {
        throw cliError({
          code: "INIT_ROOT_CHANGED",
          message:
            "A file appeared during eden init; the scaffold was cancelled without overwriting it.",
          source: target,
        });
      }
      await rename(join(stage, target), destination);
      moved.push(destination);
    }
  } catch (error: unknown) {
    for (const path of moved.reverse()) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

function shortOutput(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 2_000) return normalized;
  return `${normalized.slice(0, 2_000)}…`;
}

function redactOutput(value: string): string {
  return shortOutput(value)
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /(EDEN_BEARER_SECRET\s*[=:]\s*)\S+/giu,
      "$1[redacted]",
    )
    .replace(
      /((?:authorization|token|secret|password|api[_-]?key)\s*[:=]\s*)\S+/giu,
      "$1[redacted]",
    );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertArtifactDirectory(
  directory: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as {
    readonly bundleDigest?: unknown;
  };
  const moduleMap = JSON.parse(
    await readFile(join(directory, "module-map.json"), "utf8"),
  ) as Record<string, unknown>;
  const buildMetadata = JSON.parse(
    await readFile(join(directory, "build-metadata.json"), "utf8"),
  ) as {
    readonly bundleDigest?: unknown;
    readonly generationId?: unknown;
  };
  const bundle = await readFile(join(directory, "agent-bundle.mjs"), "utf8");
  if (
    typeof manifest.bundleDigest !== "string" ||
    manifest.bundleDigest !== sha256(bundle) ||
    buildMetadata.bundleDigest !== manifest.bundleDigest ||
    typeof buildMetadata.generationId !== "string"
  ) {
    throw cliError({
      code: "ARTIFACT_INCOHERENT",
      message:
        "The compiler produced an artifact generation whose manifest, bundle, or metadata digest does not agree.",
    });
  }
  const generationId = createArtifactIdentity({
    manifest: manifest as unknown as EdenManifest,
    moduleMap: moduleMap as unknown as EdenModuleMap,
    bundle,
  });
  if (buildMetadata.generationId !== generationId) {
    throw cliError({
      code: "ARTIFACT_INCOHERENT",
      message:
        "The compiler produced an artifact generation with a stale identity.",
    });
  }
}

function replaceJsonMain(
  source: string,
  main: string,
): string {
  const value = JSON.stringify(main);
  const property =
    /^(\s*["']main["']\s*:\s*)["'][^"']*["'](?=\s*(?:,|\/\/|\/\*|$))/mu;
  if (property.test(source)) {
    return source.replace(property, `$1${value}`);
  }
  const opening = source.indexOf("{");
  if (opening < 0) {
    throw cliError({
      code: "PROJECT_CONFIG_INVALID",
      message: "The selected JSON configuration does not contain an object.",
    });
  }
  const remainder = source.slice(opening + 1);
  const separator = remainder.trimStart().startsWith("}") ? "" : ",";
  return `${source.slice(0, opening + 1)}\n  "main": ${value}${separator}${remainder}`;
}

function replaceTomlMain(
  source: string,
  main: string,
): string {
  const value = JSON.stringify(main);
  const property =
    /^(\s*main\s*=\s*)(?:"[^"]*"|'[^']*')(\s*(?:#.*)?\s*)$/mu;
  if (property.test(source)) {
    return source.replace(property, `$1${value}$2`);
  }
  return `main = ${value}\n${source}`;
}

async function resolveDeploymentExecutable(
  cwd: string,
): Promise<string> {
  const executableName = process.platform === "win32"
    ? "wrangler.cmd"
    : "wrangler";
  const packageDirectory = dirname(fileURLToPath(import.meta.url));
  const packageLocalExecutable = join(
    packageDirectory,
    "../node_modules/.bin",
    executableName,
  );
  const packageRootExecutable = join(
    packageDirectory,
    "../../..",
    "node_modules/.bin",
    executableName,
  );
  const candidates = [
    packageLocalExecutable,
    packageRootExecutable,
    join(cwd, "node_modules/.bin", executableName),
    join(process.cwd(), "node_modules/.bin", executableName),
  ];
  for (const candidate of candidates) {
    const details = await lstat(candidate).catch(() => undefined);
    if (details !== undefined && (details.isFile() || details.isSymbolicLink())) {
      return candidate;
    }
  }
  return executableName;
}

async function resolveRuntimeWorkerEntrypoint(): Promise<string> {
  const packageDirectory = dirname(fileURLToPath(import.meta.url));
  const runtimePackage = (() => {
    try {
      return dirname(require.resolve("@eden/runtime-cloudflare"));
    } catch {
      return undefined;
    }
  })();
  const candidates = [
    ...(runtimePackage === undefined
      ? []
      : [join(runtimePackage, "test-worker.js")]),
    join(
      packageDirectory,
      "../../runtime-cloudflare/dist/test-worker.js",
    ),
    join(
      packageDirectory,
      "../../runtime-cloudflare/src/test-worker.ts",
    ),
  ];
  for (const candidate of candidates) {
    const details = await lstat(candidate).catch(() => undefined);
    if (details?.isFile() === true) return candidate;
  }
  throw cliError({
    code: "DEV_RUNTIME_UNAVAILABLE",
    message:
      "The Eden local runtime entrypoint is unavailable; build the runtime package before starting dev.",
  });
}

interface RuntimeFiles {
  readonly configPath: string;
  readonly entryPath: string;
}

const DEV_STATE_FILE = ".eden-dev-state.json";

interface DevState {
  readonly pid: number;
  readonly startedAt?: string;
  readonly workerHost: typeof EDEN_LOCAL_HOST;
  readonly workerPort: typeof EDEN_LOCAL_PORT;
  readonly inspectorHost: typeof EDEN_LOCAL_INSPECTOR_HOST;
  readonly inspectorPort: typeof EDEN_LOCAL_INSPECTOR_PORT;
}

function readProcessStartMarker(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolveResult) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          resolveResult(undefined);
          return;
        }
        const marker = String(stdout).trim();
        resolveResult(marker.length === 0 ? undefined : marker);
      },
    );
  });
}

async function writeDevState(root: string, pid: number): Promise<string> {
  const statePath = await resolveContainedProjectPath(root, DEV_STATE_FILE);
  const existing = await lstat(statePath).catch(() => undefined);
  if (existing !== undefined) {
    const previous = await readDevState(root);
    let alive = true;
    if (previous !== undefined) {
      try {
        process.kill(previous.pid, 0);
        const currentStart = await readProcessStartMarker(previous.pid);
        if (
          previous.startedAt !== undefined &&
          currentStart !== undefined &&
          currentStart !== previous.startedAt
        ) {
          alive = false;
        }
      } catch (error: unknown) {
        const code = error as NodeJS.ErrnoException;
        if (code.code === "ESRCH") alive = false;
      }
    }
    if (alive) {
      throw cliError({
        code: "DEV_STATE_EXISTS",
        message:
          "An Eden dev process state file already exists; stop the owned process before starting another dev invocation.",
        source: DEV_STATE_FILE,
      });
    }
    await rm(statePath, { force: true });
  }
  const startedAt = await readProcessStartMarker(pid);
  const state: DevState = {
    pid,
    ...(startedAt === undefined ? {} : { startedAt }),
    workerHost: EDEN_LOCAL_HOST,
    workerPort: EDEN_LOCAL_PORT,
    inspectorHost: EDEN_LOCAL_INSPECTOR_HOST,
    inspectorPort: EDEN_LOCAL_INSPECTOR_PORT,
  };
  await writeFile(statePath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return statePath;
}

async function readDevState(root: string): Promise<DevState | undefined> {
  const statePath = await resolveContainedProjectPath(root, DEV_STATE_FILE);
  const contents = await readFile(statePath, "utf8").catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw cliError({
      code: "DEV_STATE_INVALID",
      message: "The Eden dev process state file is invalid.",
      source: DEV_STATE_FILE,
    });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "pid",
          "startedAt",
          "workerHost",
          "workerPort",
          "inspectorHost",
          "inspectorPort",
        ].includes(key),
    )
  ) {
    throw cliError({
      code: "DEV_STATE_INVALID",
      message: "The Eden dev process state file is invalid.",
      source: DEV_STATE_FILE,
    });
  }
  const state = value as Partial<DevState>;
  if (
    !Number.isSafeInteger(state.pid) ||
    (state.pid as number) <= 0 ||
    (state.startedAt !== undefined && typeof state.startedAt !== "string") ||
    state.workerHost !== EDEN_LOCAL_HOST ||
    state.workerPort !== EDEN_LOCAL_PORT ||
    state.inspectorHost !== EDEN_LOCAL_INSPECTOR_HOST ||
    state.inspectorPort !== EDEN_LOCAL_INSPECTOR_PORT
  ) {
    throw cliError({
      code: "DEV_STATE_INVALID",
      message: "The Eden dev process state file does not describe an owned Eden process.",
      source: DEV_STATE_FILE,
    });
  }
  return state as DevState;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveResult) => setTimeout(resolveResult, 50));
  }
  throw cliError({
    code: "DEV_STOP_TIMEOUT",
    message: "The owned Eden dev process did not exit after termination.",
  });
}

export async function stopEdenDev(
  options: { readonly cwd?: string; readonly projectRoot?: string } = {},
): Promise<number> {
  const root = await resolveProjectRoot({
    cwd: options.cwd ?? process.cwd(),
    ...(options.projectRoot === undefined
      ? {}
      : { projectRoot: options.projectRoot }),
  });
  const state = await readDevState(root);
  if (state === undefined) return 0;
  try {
    if (state.startedAt !== undefined) {
      const currentStart = await readProcessStartMarker(state.pid);
      if (currentStart === undefined || currentStart !== state.startedAt) {
        return 0;
      }
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-state.pid, "SIGTERM");
      } else {
        process.kill(state.pid, "SIGTERM");
      }
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "ESRCH") throw error;
    }
    await waitForProcessExit(state.pid);
    return 0;
  } finally {
    await rm(
      await resolveContainedProjectPath(root, DEV_STATE_FILE),
      { force: true },
    ).catch(() => undefined);
  }
}

async function createRuntimeFiles(
  root: string,
  configPath: string,
  candidateDirectory: string,
): Promise<RuntimeFiles> {
  const runtimeEntrypoint = await resolveRuntimeWorkerEntrypoint();
  const entryPath = join(
    root,
    `${uniqueTemporaryName("eden-dev-worker")}.mjs`,
  );
  assertWithinRoot(root, entryPath, "The local runtime entrypoint");
  const bundlePath = join(candidateDirectory, "agent-bundle.mjs");
  const runtimeImport = relative(dirname(entryPath), runtimeEntrypoint)
    .split("\\")
    .join("/");
  const bundleImport = relative(dirname(entryPath), bundlePath)
    .split("\\")
    .join("/");
  const moduleSpecifier = (value: string): string =>
    value.startsWith("./") || value.startsWith("../")
      ? value
      : `./${value}`;
  const entryContents = `import runtimeWorker, { EdenSession } from ${JSON.stringify(
    moduleSpecifier(runtimeImport),
  )};
import agentArtifact from ${JSON.stringify(
    moduleSpecifier(bundleImport),
  )};

void agentArtifact;
export { EdenSession };
export default runtimeWorker;
`;
  await writeFile(entryPath, entryContents, {
    encoding: "utf8",
    flag: "wx",
  });

  try {
    const source = await readFile(configPath, "utf8");
    const relativeMain = relative(root, entryPath)
      .split("\\")
      .join("/");
    const extension = extname(configPath).toLowerCase();
    const contents = extension === ".toml"
      ? replaceTomlMain(source, relativeMain)
      : replaceJsonMain(source, relativeMain);
    const temporaryConfig = join(
      root,
      `${uniqueTemporaryName("eden-dev-config")}${extension || ".jsonc"}`,
    );
    assertWithinRoot(root, temporaryConfig, "The local runtime configuration");
    await writeFile(temporaryConfig, contents, {
      encoding: "utf8",
      flag: "wx",
    });
    return { configPath: temporaryConfig, entryPath };
  } catch (error: unknown) {
    await rm(entryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function runDefaultDryRun(
  request: EdenCliDryRunRequest,
): Promise<EdenCliDryRunResult> {
  return resolveDeploymentExecutable(request.cwd).then(
    (executable) =>
      new Promise((resolveResult) => {
        execFile(
          executable,
      [...request.args],
      {
        cwd: request.cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const rawCode = error === null
          ? 0
          : typeof error.code === "number"
            ? error.code
            : 1;
        resolveResult({
          exitCode: rawCode,
          stdout: String(stdout),
          stderr: String(stderr),
        });
        },
      );
      }),
  );
}

async function buildProjectFromCli(
  root: string,
  options: EdenCliRunOptions,
  environment?: "preview" | "production",
): Promise<string> {
  const configuration = await readProjectConfiguration(root);
  const canonicalOutput = await resolveContainedProjectPath(root, ".eden");
  const existingOutput = await lstat(canonicalOutput).catch(() => undefined);
  if (existingOutput?.isSymbolicLink() === true) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: "The .eden artifact directory must not be a symbolic link.",
      source: ".eden",
    });
  }

  const candidateName = uniqueTemporaryName("eden-build-candidate");
  const candidateOutput = join(root, candidateName);
  assertWithinRoot(root, candidateOutput, "The artifact candidate directory");
  let temporaryConfig: string | undefined;
  let runtimeFiles: RuntimeFiles | undefined;
  let promoted = false;
  try {
    let result;
    try {
      result = await buildProject({
        projectRoot: root,
        outputDirectory: candidateOutput,
      });
    } catch (error: unknown) {
      if (error instanceof EdenCompilerError) {
        const compatibility = error.message
          .toLowerCase()
          .includes("worker compatibility");
        throw cliError({
          code: compatibility
            ? "COMPATIBILITY_VALIDATION_FAILED"
            : "BUILD_FAILED",
          message: error.message,
          diagnostics: error.diagnostics,
        });
      }
      throw error;
    }
    await assertArtifactDirectory(candidateOutput);
    runtimeFiles = await createRuntimeFiles(
      root,
      configuration.configPath,
      candidateOutput,
    );
    temporaryConfig = runtimeFiles.configPath;
    const request: EdenCliDryRunRequest = {
      cwd: root,
      configPath: temporaryConfig,
      originalConfigPath: configuration.configPath,
      args: [
        "deploy",
        "--dry-run",
        ...(environment === undefined
          ? []
          : ["--env", environment]),
        "--config",
        temporaryConfig,
      ],
    };
    let dryRun: EdenCliDryRunResult;
    try {
      dryRun = await (options.dryRunRunner ?? runDefaultDryRun)(request);
    } catch (error: unknown) {
      throw cliError({
        code: "COMPATIBILITY_VALIDATION_FAILED",
        message: error instanceof Error
          ? `Worker compatibility dry run could not be started: ${error.message}`
          : "Worker compatibility dry run could not be started.",
      });
    }
    const dryRunOutput = redactOutput(dryRun.stdout);
    if (dryRunOutput.length > 0) options.stdout?.(dryRunOutput);
    if (dryRun.exitCode !== 0) {
      const dryRunError = redactOutput(dryRun.stderr);
      throw cliError({
        code: "COMPATIBILITY_VALIDATION_FAILED",
        message: `Worker compatibility validation failed during the dry run (exit code ${dryRun.exitCode}).${
          dryRunError.length === 0 ? "" : ` ${dryRunError}`
        }`,
      });
    }

    const backupOutput = join(root, uniqueTemporaryName("eden-build-previous"));
    const current = await lstat(canonicalOutput).catch(() => undefined);
    if (current !== undefined && !current.isDirectory()) {
      throw cliError({
        code: "ARTIFACT_OUTPUT_INVALID",
        message: "The .eden artifact path must be a directory.",
        source: ".eden",
      });
    }
    if (current === undefined) {
      await rename(candidateOutput, canonicalOutput);
      promoted = true;
    } else {
      await rename(canonicalOutput, backupOutput);
      try {
        await rename(candidateOutput, canonicalOutput);
        promoted = true;
      } catch (error: unknown) {
        await rename(backupOutput, canonicalOutput).catch(() => undefined);
        throw error;
      }
      await rm(backupOutput, { recursive: true, force: true });
    }

    options.stdout?.(
      `Built Eden project generation ${result.artifacts.buildMetadata.generationId}.`,
    );
    options.stdout?.("Worker compatibility dry run passed; no deployment was performed.");
    return result.artifacts.buildMetadata.generationId;
  } finally {
    if (!promoted) {
      await rm(candidateOutput, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    if (temporaryConfig !== undefined) {
      await rm(temporaryConfig, { force: true }).catch(() => undefined);
    }
    if (runtimeFiles !== undefined) {
      await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
    }
  }
}

function errorLines(error: unknown): readonly string[] {
  if (error instanceof EdenCompilerError) {
    const diagnostics = error.diagnostics.map((diagnostic) => {
      const source = diagnostic.source === undefined
        ? ""
        : ` [${diagnostic.source}]`;
      return `${diagnostic.code}${source}: ${diagnostic.message}`;
    });
    return [
      error.message,
      ...diagnostics,
    ];
  }
  if (error instanceof EdenCliError) {
    const source = error.source === undefined ? "" : ` [${error.source}]`;
    return [
      `${error.code}${source}: ${error.message}`,
      ...error.diagnostics.map((diagnostic) => {
        const diagnosticSource = diagnostic.source === undefined
          ? ""
          : ` [${diagnostic.source}]`;
        return `${diagnostic.code}${diagnosticSource}: ${diagnostic.message}`;
      }),
    ];
  }
  return [
    error instanceof Error
      ? error.message
      : "The Eden command failed unexpectedly.",
  ];
}

interface ApprovedPort {
  readonly host: string;
  readonly port: number;
  readonly name: string;
}

const APPROVED_PORTS: readonly ApprovedPort[] = [
  {
    host: EDEN_LOCAL_HOST,
    port: EDEN_LOCAL_PORT,
    name: "Eden Worker",
  },
  {
    host: EDEN_LOCAL_INSPECTOR_HOST,
    port: EDEN_LOCAL_INSPECTOR_PORT,
    name: "Eden inspector",
  },
] as const;

function portIsAvailable(
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolveResult) => {
    const server = createServer();
    const finish = (available: boolean): void => {
      server.removeAllListeners();
      server.close(() => resolveResult(available));
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        finish(false);
        return;
      }
      finish(false);
    });
    server.listen({ host, port }, () => finish(true));
  });
}

async function assertApprovedPortsAvailable(): Promise<void> {
  for (const approved of APPROVED_PORTS) {
    if (!(await portIsAvailable(approved.host, approved.port))) {
      throw cliError({
        code: "PORT_OCCUPIED",
        message:
          `${approved.name} port ${approved.host}:${approved.port} is occupied; ` +
          "eden will not stop or take over an existing process.",
      });
    }
  }
}

function waitForTcpPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolveResult, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const attempt = (): void => {
      if (settled) return;
      const socket = createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        if (timer !== undefined) clearTimeout(timer);
        settled = true;
        resolveResult();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          settled = true;
          reject(
            cliError({
              code: "DEV_NOT_READY",
              message: `The local runtime did not become ready on ${host}:${port}.`,
            }),
          );
          return;
        }
        timer = setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function defaultProcessRunner(): EdenCliProcessRunner {
  return {
    spawn(request) {
      const child = spawnChild(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        detached: process.platform !== "win32",
        stdio: "inherit",
      });
      const pid = child.pid ?? -1;
      const exited = new Promise<EdenCliProcessExit>((resolveExit) => {
        child.once("error", () => {
          resolveExit({ exitCode: 1, signal: null });
        });
        child.once("exit", (exitCode, signal) => {
          resolveExit({ exitCode, signal });
        });
      });
      const ready = request.readiness === undefined
        ? Promise.resolve()
        : Promise.all(
            request.readiness.map((port) =>
              waitForTcpPort(port.host, port.port, 10_000),
            ),
          ).then(() => undefined);
      return {
        pid,
        exited,
        ready,
        async terminate(signal = "SIGTERM") {
          if (pid <= 0) return;
          try {
            if (process.platform !== "win32") {
              process.kill(-pid, signal);
            } else {
              child.kill(signal);
            }
          } catch (error: unknown) {
            const code = error as NodeJS.ErrnoException;
            if (code.code !== "ESRCH") throw error;
          }
          const graceful = await Promise.race([
            exited,
            new Promise<void>((resolveExit) => {
              setTimeout(resolveExit, 5_000);
            }),
          ]);
          if (graceful === undefined) {
            try {
              if (process.platform !== "win32") {
                process.kill(-pid, "SIGKILL");
              } else {
                child.kill("SIGKILL");
              }
            } catch (error: unknown) {
              const code = error as NodeJS.ErrnoException;
              if (code.code !== "ESRCH") throw error;
            }
            await Promise.race([
              exited,
              new Promise<void>((resolveExit) => {
                setTimeout(resolveExit, 5_000);
              }),
            ]);
          }
        },
      };
    },
  };
}

async function closeWatcher(watcher: FSWatcher | undefined): Promise<void> {
  if (watcher === undefined) return;
  await watcher.close();
}

async function runDev(
  root: string,
  options: EdenCliRunOptions,
): Promise<void> {
  await readProjectConfiguration(root);
  await assertApprovedPortsAvailable();
  await buildProjectFromCli(root, options);

  const configuration = await readProjectConfiguration(root);
  const canonicalOutput = await resolveContainedProjectPath(root, ".eden");
  const runtimeFiles = await createRuntimeFiles(
    root,
    configuration.configPath,
    canonicalOutput,
  );
  const temporaryConfig = runtimeFiles.configPath;
  let child: EdenCliProcess | undefined;
  let watcher: FSWatcher | undefined;
  let stopped = false;
  let rebuildTimer: NodeJS.Timeout | undefined;
  let rebuildInFlight = false;
  let rebuildPending = false;
  const rebuildTasks = new Set<Promise<void>>();
  let statePath: string | undefined;
  let requestedStop = false;
  let stopOnSignal: (() => void) | undefined;
  const runner = options.processRunner ?? defaultProcessRunner();
  const executable = await resolveDeploymentExecutable(root);
  const processRequest: EdenCliProcessRequest = {
    command: executable,
    args: [
      "dev",
      "--local",
      "--ip",
      EDEN_LOCAL_HOST,
      "--port",
      String(EDEN_LOCAL_PORT),
      "--inspector-port",
      String(EDEN_LOCAL_INSPECTOR_PORT),
      "--inspector-ip",
      EDEN_LOCAL_INSPECTOR_HOST,
      "--config",
      temporaryConfig,
      ...(process.env.EDEN_BEARER_SECRET === undefined
        ? []
        : ["--var", `EDEN_BEARER_SECRET:${process.env.EDEN_BEARER_SECRET}`]),
    ],
    cwd: root,
    env: {
      EDEN_HOST: EDEN_LOCAL_HOST,
      EDEN_PORT: String(EDEN_LOCAL_PORT),
      EDEN_INSPECTOR_PORT: String(EDEN_LOCAL_INSPECTOR_PORT),
    },
    readiness: APPROVED_PORTS.map(({ host, port }) => ({ host, port })),
  };

  const rebuild = async (): Promise<void> => {
    if (stopped) return;
    if (rebuildInFlight) {
      rebuildPending = true;
      return;
    }
    rebuildInFlight = true;
    try {
      const generationId = await buildProjectFromCli(root, options);
      options.stdout?.(`Eden dev generation ${generationId} is coherent.`);
    } catch (error: unknown) {
      for (const line of errorLines(error)) {
        options.stderr?.(`Watch rebuild unavailable: ${line}`);
      }
    } finally {
      rebuildInFlight = false;
      if (rebuildPending && !stopped) {
        rebuildPending = false;
        await rebuild();
      }
    }
  };

  try {
    try {
      child = runner.spawn(processRequest);
      const readiness = child.ready ?? Promise.resolve();
      void readiness.catch(() => undefined);
      statePath = await writeDevState(root, child.pid);
      try {
        await readiness;
      } catch (error: unknown) {
        throw error instanceof EdenCliError
          ? error
          : cliError({
              code: "DEV_NOT_READY",
              message: error instanceof Error
                ? error.message
                : "The local runtime did not become ready.",
            });
      }
    } catch (error: unknown) {
      throw error instanceof EdenCliError
        ? error
        : cliError({
            code: "DEV_START_FAILED",
            message: error instanceof Error
              ? error.message
              : "The local runtime could not be started.",
          });
    }
    stopOnSignal = (): void => {
      requestedStop = true;
      stopped = true;
      void child?.terminate().catch(() => undefined);
    };
    process.once("SIGINT", stopOnSignal);
    process.once("SIGTERM", stopOnSignal);
    options.stdout?.(
      `Eden dev ready at http://${EDEN_LOCAL_HOST}:${EDEN_LOCAL_PORT} ` +
      `(inspector ${EDEN_LOCAL_INSPECTOR_HOST}:${EDEN_LOCAL_INSPECTOR_PORT}).`,
    );

    watcher = watch(join(root, "agent"), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });
    watcher.on("all", () => {
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        rebuildTimer = undefined;
        const task = rebuild();
        rebuildTasks.add(task);
        void task.then(
          () => rebuildTasks.delete(task),
          () => rebuildTasks.delete(task),
        );
      }, 75);
    });

    const exit = await child.exited;
    stopped = true;
    if (!requestedStop && exit.exitCode !== 0) {
      throw cliError({
        code: "DEV_RUNTIME_FAILED",
        message:
          exit.signal === null
            ? `The local runtime exited with code ${exit.exitCode ?? 1}.`
            : `The local runtime exited after ${exit.signal}.`,
      });
    }
    await assertApprovedPortsAvailable();
  } catch (error: unknown) {
    stopped = true;
    if (child !== undefined) {
      await child.terminate().catch(() => undefined);
    }
    throw error;
  } finally {
    stopped = true;
    if (stopOnSignal !== undefined) {
      process.removeListener("SIGINT", stopOnSignal);
      process.removeListener("SIGTERM", stopOnSignal);
    }
    if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
    await closeWatcher(watcher);
    await Promise.all([...rebuildTasks]);
    await rm(temporaryConfig, { force: true }).catch(() => undefined);
    await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
    if (statePath !== undefined) {
      await rm(statePath, { force: true }).catch(() => undefined);
    }
  }
}

async function runDeploy(
  root: string,
  options: EdenCliRunOptions,
  environment: "preview" | "production",
): Promise<void> {
  const configuration = await readProjectConfiguration(root);
  await buildProjectFromCli(root, options, environment);
  const canonicalOutput = await resolveContainedProjectPath(root, ".eden");
  const runtimeFiles = await createRuntimeFiles(
    root,
    configuration.configPath,
    canonicalOutput,
  );
  const temporaryConfig = runtimeFiles.configPath;
  try {
    await assertArtifactDirectory(canonicalOutput);
    const request: EdenCliDryRunRequest = {
      cwd: root,
      configPath: temporaryConfig,
      originalConfigPath: configuration.configPath,
      args: [
        "deploy",
        "--dry-run",
        "--env",
        environment,
        "--config",
        temporaryConfig,
      ],
    };
    let dryRun: EdenCliDryRunResult;
    try {
      dryRun = await (options.dryRunRunner ?? runDefaultDryRun)(request);
    } catch (error: unknown) {
      throw cliError({
        code: "WRANGLER_DRY_RUN_FAILED",
        message: error instanceof Error
          ? `Deployment dry-run could not be started: ${error.message}`
          : "Deployment dry-run could not be started.",
      });
    }
    if (dryRun.exitCode !== 0) {
      const dryRunError = redactOutput(dryRun.stderr);
      throw cliError({
        code: "WRANGLER_DRY_RUN_FAILED",
        message: `Deployment dry-run failed for ${environment} (exit code ${dryRun.exitCode}).${
          dryRunError.length === 0 ? "" : ` ${dryRunError}`
        }`,
      });
    }
    options.stdout?.(
      `Deployment dry-run passed for ${environment}; no remote deployment was performed.`,
    );
  } finally {
    await rm(temporaryConfig, { force: true }).catch(() => undefined);
    await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
  }
}

async function runInvocation(
  invocation: ParsedInvocation,
  options: EdenCliRunOptions,
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const root = await selectedProjectRoot(invocation, cwd);
  switch (invocation.command) {
    case "init":
      await writeScaffold(root);
      options.stdout?.(`Initialized Eden project in ${root}.`);
      return;
    case "build":
      await buildProjectFromCli(root, options);
      return;
    case "dev":
      await runDev(root, options);
      return;
    case "deploy":
      await runDeploy(root, options, invocation.environment ?? "preview");
      return;
  }
}

export async function runEdenCli(
  args: readonly string[],
  options: EdenCliRunOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  try {
    const parsed = parseArguments(args);
    if (parsed === "help") {
      stdout(USAGE.trimEnd());
      return 0;
    }
    await runInvocation(parsed, {
      ...options,
      stdout,
      stderr,
    });
    return 0;
  } catch (error: unknown) {
    for (const line of errorLines(error)) stderr(line);
    return 1;
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runEdenCli(args);
}

export function isEdenCliCommand(value: string): value is EdenCliCommand {
  return (EDEN_CLI_COMMANDS as readonly string[]).includes(value);
}

if (
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

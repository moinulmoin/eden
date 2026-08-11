#!/usr/bin/env node

import {
  createHash,
  randomUUID,
} from "crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
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
  tmpdir,
} from "os";
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
  EdenCompilerError,
  readArtifactGeneration,
  resolveContainedProjectPath,
  resolveProjectRoot,
} from "@eden/compiler";
import type {
  EdenArtifactGeneration,
  EdenDiagnostic,
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

export type EdenCliRemoteCommandKind =
  | "secret-put"
  | "secret-delete"
  | "deploy"
  | "delete";

export interface EdenCliRemoteCommandRequest {
  readonly kind: EdenCliRemoteCommandKind;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface EdenCliRemoteCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface EdenCliRemoteValidationRequest {
  readonly cwd: string;
  readonly environment: "preview" | "production";
  readonly workerName: string;
  readonly url: string;
  readonly expectedGeneration: {
    readonly generationId: string;
    readonly bundleDigest: string;
    readonly manifestVersion: string;
    readonly runtimeVersion: string;
    readonly agentBundleVersion: string;
    readonly protocolVersion: string;
    readonly schemaVersion: number;
    readonly toolNames: readonly string[];
  };
}

export interface EdenCliRemoteValidationResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
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
  /**
   * A process-start identity captured by the process runner immediately after
   * spawn. PID alone is never sufficient to authorize cleanup.
   */
  readonly startIdentity?: string | Promise<string | undefined>;
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
  readonly initPublicationHook?: (
    boundary: EdenInitPublicationBoundary,
    target?: string,
  ) => void | Promise<void>;
  readonly buildPublicationHook?: (
    boundary: EdenBuildPublicationBoundary,
  ) => void | Promise<void>;
  readonly dryRunRunner?: (
    request: EdenCliDryRunRequest,
  ) => Promise<EdenCliDryRunResult>;
  readonly processRunner?: EdenCliProcessRunner;
  readonly remoteCommandRunner?: (
    request: EdenCliRemoteCommandRequest,
  ) => Promise<EdenCliRemoteCommandResult>;
  readonly remoteValidationRunner?: (
    request: EdenCliRemoteValidationRequest,
  ) => Promise<EdenCliRemoteValidationResult>;
  readonly remoteBearerSecret?: string;
}

export type EdenInitPublicationBoundary =
  | "after-state-write"
  | "after-stage-write"
  | "after-target-validation"
  | "before-target-publish"
  | "after-target-publish"
  | "before-complete";

export type EdenBuildPublicationBoundary =
  | "before-canonical-prepare"
  | "after-canonical-prepare"
  | "before-generation-publish"
  | "after-generation-publish"
  | "before-current-promotion"
  | "after-current-promotion";

interface ParsedInvocation {
  readonly command: EdenCliCommand;
  readonly projectRoot?: string;
  readonly environment?: "preview" | "production";
  readonly workerName?: string;
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

interface InitState {
  readonly kind: "eden.init.incomplete";
  readonly version: 1;
  readonly stageName: string;
  readonly files: readonly {
    readonly relativePath: string;
    readonly sha256: string;
  }[];
}

interface ProjectInputFingerprint {
  readonly digest: string;
  readonly files: readonly {
    readonly relativePath: string;
    readonly sha256: string;
  }[];
}

interface InitPublicationLockState {
  readonly kind: "eden.init.lock";
  readonly version: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

const INIT_STATE_FILE = ".eden-init-incomplete.json";
const INIT_LOCK_FILE = ".eden-init.lock";
const CANONICAL_ARTIFACT_NAMES = [
  "discovery.json",
  "diagnostics.json",
  "manifest.json",
  "module-map.json",
  "agent-bundle.mjs",
  "build-metadata.json",
] as const;

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
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "eden-basic-agent",
  "main": ".eden/agent-bundle.mjs",
  "compatibility_date": "2026-04-01",
  "ai": {
    "binding": "AI"
  },
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
  ],
  "env": {
    "preview": {
      "name": "eden-basic-agent-preview",
      "ai": {
        "binding": "AI"
      },
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
    },
    "production": {
      "name": "eden-basic-agent-production",
      "ai": {
        "binding": "AI"
      },
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
  }
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
  dev     Run the local Eden Worker on 127.0.0.1:8797 (inspector 9297)
  deploy  Build, validate, and deploy a selected remote environment

Options:
  --project <path>  Select the project root (defaults to the current directory)
  --env <name>      Select preview or production for deploy (defaults to preview)
  --name <name>     Select the deployed Worker name for deploy
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

function parseWorkerNameValue(
  value: string | undefined,
): string {
  if (
    value === undefined ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)
  ) {
    throw cliError({
      code: "WORKER_NAME_INVALID",
      message:
        "The --name option must be a lowercase alphanumeric Worker name with optional dashes.",
    });
  }
  return value;
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
  let workerName: string | undefined;
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
    if (argument === "--name") {
      if (workerName !== undefined) {
        throw cliError({
          code: "WORKER_NAME_REPEATED",
          message: "The --name option may be supplied only once.",
        });
      }
      workerName = parseWorkerNameValue(args[index + 1]);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--name=") === true) {
      if (workerName !== undefined) {
        throw cliError({
          code: "WORKER_NAME_REPEATED",
          message: "The --name option may be supplied only once.",
        });
      }
      workerName = parseWorkerNameValue(argument.slice("--name=".length));
      continue;
    }
    throw cliError({
      code: "ARGUMENT_UNKNOWN",
      message: `Unknown option "${argument ?? ""}".`,
    });
  }

  if (help) return "help";
  if (
    (environment !== undefined || workerName !== undefined) &&
    commandValue !== "deploy"
  ) {
    throw cliError({
      code: "DEPLOY_OPTIONS_UNSUPPORTED",
      message: "The --env and --name options are supported only by eden deploy.",
    });
  }
  return {
    command: commandValue,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(environment === undefined ? {} : { environment }),
    ...(workerName === undefined ? {} : { workerName }),
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
  const incompleteInit = await readInitState(root);
  if (incompleteInit !== undefined) {
    throw cliError({
      code: "INIT_INCOMPLETE",
      message:
        "The selected project contains an interrupted Eden scaffold; rerun eden init to recover it before building.",
      source: INIT_STATE_FILE,
    });
  }
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

async function acquireInitPublicationLock(
  root: string,
): Promise<{ readonly release: () => Promise<void> }> {
  const lockPath = join(root, INIT_LOCK_FILE);
  const startedAt =
    (await readProcessStartMarker(process.pid)) ?? `pid:${process.pid}`;
  const state: InitPublicationLockState = {
    kind: "eden.init.lock",
    version: 1,
    pid: process.pid,
    startedAt,
    token: randomUUID(),
  };
  const serialized = `${JSON.stringify(state)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return {
        release: async () => {
          const current = await readFile(lockPath, "utf8").catch(
            () => undefined,
          );
          if (current === serialized) {
            await rm(lockPath, { force: true }).catch(() => undefined);
          }
        },
      };
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "EEXIST") throw error;
      const existing = await readFile(lockPath, "utf8").catch(
        () => undefined,
      );
      if (existing === undefined) continue;
      let existingState: unknown;
      try {
        existingState = JSON.parse(existing) as unknown;
      } catch {
        throw cliError({
          code: "INIT_BUSY",
          message:
            "Another Eden init owns scaffold publication; the malformed lock was preserved.",
          source: INIT_LOCK_FILE,
        });
      }
      if (
        !isRecord(existingState) ||
        existingState.kind !== "eden.init.lock" ||
        existingState.version !== 1 ||
        typeof existingState.pid !== "number" ||
        !Number.isSafeInteger(existingState.pid) ||
        existingState.pid <= 0 ||
        typeof existingState.startedAt !== "string" ||
        existingState.startedAt.length === 0 ||
        typeof existingState.token !== "string" ||
        existingState.token.length === 0
      ) {
        throw cliError({
          code: "INIT_BUSY",
          message:
            "Another Eden init owns scaffold publication; the malformed lock was preserved.",
          source: INIT_LOCK_FILE,
        });
      }
      const existingLock = existingState as {
        readonly pid: number;
        readonly startedAt: string;
      };
      const ownerStart = await readProcessStartMarker(existingLock.pid);
      if (ownerStart === existingLock.startedAt) {
        throw cliError({
          code: "INIT_BUSY",
          message:
            "Another Eden init is publishing the scaffold; retry after it completes.",
          source: INIT_LOCK_FILE,
        });
      }
      if (
        ownerStart === undefined &&
        isProcessAlive(existingLock.pid)
      ) {
        throw cliError({
          code: "INIT_BUSY",
          message:
            "Another Eden init owns scaffold publication but its start identity could not be verified.",
          source: INIT_LOCK_FILE,
        });
      }
      const latest = await readFile(lockPath, "utf8").catch(
        () => undefined,
      );
      if (latest !== existing) continue;
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
  throw cliError({
    code: "INIT_BUSY",
    message:
      "Another Eden init is publishing the scaffold; retry after it completes.",
    source: INIT_LOCK_FILE,
  });
}

async function writeScaffold(
  root: string,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<void> {
  const lock = await acquireInitPublicationLock(root);
  try {
    await writeScaffoldUnlocked(root, hook);
  } finally {
    await lock.release();
  }
}

async function writeScaffoldUnlocked(
  root: string,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<void> {
  const interrupted = await readInitState(root);
  if (interrupted !== undefined) {
    await resumeScaffold(root, interrupted, hook);
    return;
  }

  const entries = (await readdir(root)).filter(
    (entry) => entry !== INIT_LOCK_FILE,
  );
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
  const statePath = join(root, INIT_STATE_FILE);
  assertWithinRoot(root, statePath, "The scaffold state file");
  const existingStage = await lstat(stage).catch(() => undefined);
  if (existingStage !== undefined) {
    throw cliError({
      code: "INIT_STAGE_CONFLICT",
      message: "The scaffold staging path is already occupied; no files were written.",
      source: stageName,
    });
  }
  let stageCreated = false;
  let stateWritten = false;
  try {
    await mkdir(join(stage, "agent/tools"), { recursive: true });
    stageCreated = true;
    for (const file of INIT_SCAFFOLD) {
      const stagedPath = join(stage, file.relativePath);
      await writeFile(stagedPath, file.content, { encoding: "utf8", flag: "wx" });
    }

    const state: InitState = {
      kind: "eden.init.incomplete",
      version: 1,
      stageName,
      files: INIT_SCAFFOLD.map((file) => ({
        relativePath: file.relativePath,
        sha256: sha256(file.content),
      })),
    };
    await writeFile(statePath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    stateWritten = true;
    await hook?.("after-state-write");

    const afterStage = await readdir(root);
    if (
      afterStage.some(
        (entry) =>
          entry !== stageName &&
          entry !== INIT_STATE_FILE &&
          entry !== INIT_LOCK_FILE,
      )
    ) {
      throw cliError({
        code: "INIT_ROOT_CHANGED",
        message:
          "The selected project root changed while eden init was preparing the scaffold; rerun eden init to recover the explicitly incomplete scaffold.",
      });
    }
    await assertStagedScaffold(root, state);
    await hook?.("after-stage-write");
    await resumeScaffold(root, state, hook);
  } catch (error: unknown) {
    if (!stateWritten) {
      if (stageCreated) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function readInitState(
  root: string,
): Promise<InitState | undefined> {
  const statePath = await resolveContainedProjectPath(root, INIT_STATE_FILE);
  const contents = await readFile(statePath, "utf8").catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw cliError({
      code: "INIT_STATE_INVALID",
      message: "The Eden scaffold recovery state could not be read safely.",
      source: INIT_STATE_FILE,
    });
  });
  if (contents === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw cliError({
      code: "INIT_STATE_INVALID",
      message: "The Eden scaffold recovery state is not valid JSON.",
      source: INIT_STATE_FILE,
    });
  }
  if (!isRecord(value)) {
    throw cliError({
      code: "INIT_STATE_INVALID",
      message: "The Eden scaffold recovery state is malformed.",
      source: INIT_STATE_FILE,
    });
  }
  const stageName = value.stageName;
  const files = value.files;
  if (
    value.kind !== "eden.init.incomplete" ||
    value.version !== 1 ||
    typeof stageName !== "string" ||
    !/^\.eden-init-[0-9]+-[0-9a-f-]+$/u.test(stageName) ||
    !Array.isArray(files) ||
    files.length !== INIT_SCAFFOLD.length ||
    files.some(
      (file) =>
        !isRecord(file) ||
        typeof file.relativePath !== "string" ||
        typeof file.sha256 !== "string",
    )
  ) {
    throw cliError({
      code: "INIT_STATE_INVALID",
      message: "The Eden scaffold recovery state is malformed.",
      source: INIT_STATE_FILE,
    });
  }

  const expectedFiles = INIT_SCAFFOLD.map((file) => ({
    relativePath: file.relativePath,
    sha256: sha256(file.content),
  }));
  const stateFiles = files as {
    readonly relativePath: string;
    readonly sha256: string;
  }[];
  if (JSON.stringify(stateFiles) !== JSON.stringify(expectedFiles)) {
    throw cliError({
      code: "INIT_STATE_INVALID",
      message: "The Eden scaffold recovery state does not match the selected scaffold.",
      source: INIT_STATE_FILE,
    });
  }
  return {
    kind: "eden.init.incomplete",
    version: 1,
    stageName,
    files: stateFiles,
  };
}

async function scaffoldPathState(
  root: string,
  path: string,
  expectedSha256: string,
): Promise<"missing" | "match" | "mismatch"> {
  const containedPath = await resolveContainedProjectPath(
    root,
    relative(root, path),
  ).catch(() => undefined);
  if (containedPath === undefined) return "mismatch";
  const details = await lstat(containedPath).catch(() => undefined);
  if (details === undefined) return "missing";
  if (!details.isFile() || details.isSymbolicLink()) return "mismatch";
  const contents = await readFile(containedPath).catch(() => undefined);
  if (contents === undefined) return "mismatch";
  return sha256(contents) === expectedSha256 ? "match" : "mismatch";
}

async function assertStagedScaffold(
  root: string,
  state: InitState,
  published = new Map<string, "missing" | "match" | "mismatch">(),
): Promise<void> {
  const stage = join(root, state.stageName);
  assertWithinRoot(root, stage, "The scaffold staging directory");
  for (const file of state.files) {
    if (published.get(file.relativePath) === "match") continue;
    const path = join(stage, file.relativePath);
    const stateResult = await scaffoldPathState(root, path, file.sha256);
    if (stateResult !== "match") {
      throw cliError({
        code: "INIT_STAGE_INVALID",
        message:
          `The staged scaffold file "${file.relativePath}" is missing or changed; ` +
          "the incomplete scaffold was left untouched.",
        source: file.relativePath,
      });
    }
  }
}

async function assertPublishedScaffoldFile(
  root: string,
  relativePath: string,
  expectedSha256: string,
): Promise<"missing" | "match" | "mismatch"> {
  const path = join(root, relativePath);
  return scaffoldPathState(root, path, expectedSha256);
}

async function assertPublishedScaffold(
  root: string,
  state: InitState,
): Promise<void> {
  for (const file of state.files) {
    const stateResult = await assertPublishedScaffoldFile(
      root,
      file.relativePath,
      file.sha256,
    );
    if (stateResult !== "match") {
      throw cliError({
        code: "INIT_PUBLISH_INVALID",
        message:
          `The published scaffold file "${file.relativePath}" is missing or changed; ` +
          "the incomplete scaffold remains explicitly unavailable.",
        source: file.relativePath,
      });
    }
  }
}

async function publishScaffoldTargetNoReplace(
  root: string,
  stage: string,
  target: "agent" | "package.json" | "wrangler.jsonc",
  files: readonly InitState["files"][number][],
): Promise<void> {
  const destination = join(root, target);
  if (target === "agent") {
    const existingDestination = await lstat(destination).catch(
      () => undefined,
    );
    if (existingDestination === undefined) {
      await mkdir(destination);
    } else if (
      !existingDestination.isDirectory() ||
      existingDestination.isSymbolicLink()
    ) {
      throw cliError({
        code: "INIT_RECOVERY_CONFLICT",
        message:
          'The interrupted scaffold cannot recover because "agent" contains unrelated or changed bytes; no existing file was overwritten.',
        source: "agent",
      });
    }
    const toolsDirectory = join(destination, "tools");
    const existingToolsDirectory = await lstat(toolsDirectory).catch(
      () => undefined,
    );
    if (existingToolsDirectory === undefined) {
      await mkdir(toolsDirectory);
    } else if (
      !existingToolsDirectory.isDirectory() ||
      existingToolsDirectory.isSymbolicLink()
    ) {
      throw cliError({
        code: "INIT_RECOVERY_CONFLICT",
        message:
          'The interrupted scaffold cannot recover because "agent/tools" contains unrelated or changed bytes; no existing file was overwritten.',
        source: "agent/tools",
      });
    }
    for (const file of files) {
      const stagedPath = join(stage, file.relativePath);
      const publishedPath = join(root, file.relativePath);
      await link(stagedPath, publishedPath);
      await rm(stagedPath, { force: false });
    }
    await rm(join(stage, target), { recursive: true, force: false });
    return;
  }

  const stagedPath = join(stage, target);
  await link(stagedPath, destination);
  await rm(stagedPath, { force: false });
}

async function assertPartialAgentDestination(
  root: string,
  files: readonly InitState["files"][number][],
): Promise<void> {
  const agent = join(root, "agent");
  const agentDetails = await lstat(agent).catch(() => undefined);
  if (agentDetails === undefined) return;
  if (!agentDetails.isDirectory() || agentDetails.isSymbolicLink()) {
    throw cliError({
      code: "INIT_RECOVERY_CONFLICT",
      message:
        'The interrupted scaffold cannot recover because "agent" contains unrelated or changed bytes; no existing file was overwritten.',
      source: "agent",
    });
  }
  const expectedAgentEntries = new Set([
    "agent.ts",
    "instructions.md",
    "tools",
  ]);
  const agentEntries = await readdir(agent);
  if (agentEntries.some((entry) => !expectedAgentEntries.has(entry))) {
    throw cliError({
      code: "INIT_RECOVERY_CONFLICT",
      message:
        'The interrupted scaffold cannot recover because "agent" contains unrelated or changed bytes; no existing file was overwritten.',
      source: "agent",
    });
  }
  const tools = join(agent, "tools");
  const toolsDetails = await lstat(tools).catch(() => undefined);
  if (toolsDetails === undefined) return;
  if (!toolsDetails.isDirectory() || toolsDetails.isSymbolicLink()) {
    throw cliError({
      code: "INIT_RECOVERY_CONFLICT",
      message:
        'The interrupted scaffold cannot recover because "agent/tools" contains unrelated or changed bytes; no existing file was overwritten.',
      source: "agent/tools",
    });
  }
  const expectedToolEntries = new Set(
    files
      .filter((file) => file.relativePath.startsWith("agent/tools/"))
      .map((file) => file.relativePath.slice("agent/tools/".length)),
  );
  const toolEntries = await readdir(tools);
  if (toolEntries.some((entry) => !expectedToolEntries.has(entry))) {
    throw cliError({
      code: "INIT_RECOVERY_CONFLICT",
      message:
        'The interrupted scaffold cannot recover because "agent/tools" contains unrelated or changed bytes; no existing file was overwritten.',
      source: "agent/tools",
    });
  }
}

async function resumeScaffold(
  root: string,
  state: InitState,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<void> {
  const stage = join(root, state.stageName);
  assertWithinRoot(root, stage, "The scaffold staging directory");
  const statePath = join(root, INIT_STATE_FILE);
  assertWithinRoot(root, statePath, "The scaffold state file");
  const targetDirectories = new Set(["agent"]);
  const allowedRootEntries = new Set([
    state.stageName,
    INIT_STATE_FILE,
    INIT_LOCK_FILE,
    "agent",
    "package.json",
    "wrangler.jsonc",
  ]);
  const unexpectedRootEntries = (await readdir(root)).filter(
    (entry) => !allowedRootEntries.has(entry),
  );
  if (unexpectedRootEntries.length > 0) {
    throw cliError({
      code: "INIT_RECOVERY_CONFLICT",
      message:
        "The interrupted scaffold cannot recover because unrelated files appeared in the selected root; existing bytes were preserved.",
      source: unexpectedRootEntries[0] ?? ".",
    });
  }
  const alreadyPublished = await Promise.all(
    state.files.map((file) =>
      assertPublishedScaffoldFile(root, file.relativePath, file.sha256),
    ),
  );
  if (alreadyPublished.every((value) => value === "match")) {
    await rm(stage, { recursive: true, force: true });
    await rm(statePath, { force: true });
    return;
  }
  await assertStagedScaffold(
    root,
    state,
    new Map(
      state.files.map((file, index) => [
        file.relativePath,
        alreadyPublished[index] ?? "missing",
      ]),
    ),
  );

  for (const target of ["agent", "package.json", "wrangler.jsonc"] as const) {
    const targetFiles = state.files.filter((file) =>
      targetDirectories.has(target)
        ? file.relativePath === target ||
          file.relativePath.startsWith(`${target}/`)
        : file.relativePath === target,
    );
    const published = await Promise.all(
      targetFiles.map((file) =>
        assertPublishedScaffoldFile(root, file.relativePath, file.sha256),
      ),
    );
    if (published.length > 0 && published.every((value) => value === "match")) {
      continue;
    }
    if (published.some((value) => value === "mismatch")) {
      throw cliError({
        code: "INIT_RECOVERY_CONFLICT",
        message:
          `The interrupted scaffold cannot recover because "${target}" contains unrelated or changed bytes; no existing file was overwritten.`,
        source: target,
      });
    }

    const stagedTarget = join(stage, target);
    const stagedDetails = await lstat(stagedTarget).catch(() => undefined);
    if (
      stagedDetails === undefined ||
      (targetDirectories.has(target)
        ? !stagedDetails.isDirectory() || stagedDetails.isSymbolicLink()
        : !stagedDetails.isFile() || stagedDetails.isSymbolicLink())
    ) {
      throw cliError({
        code: "INIT_STAGE_INVALID",
        message:
          `The interrupted scaffold is missing its staged "${target}" target; ` +
          "no existing file was overwritten.",
        source: target,
      });
    }
    const destination = join(root, target);
    const destinationDetails = await lstat(destination).catch(() => undefined);
    const targetWasInitiallyMissing = published.every(
      (value) => value === "missing",
    );
    if (
      destinationDetails !== undefined &&
      (target !== "agent" || targetWasInitiallyMissing)
    ) {
      throw cliError({
        code: "INIT_RECOVERY_CONFLICT",
        message:
          `The interrupted scaffold cannot publish "${target}" because existing bytes appeared; no existing file was overwritten.`,
        source: target,
      });
    }
    if (target === "agent") {
      await assertPartialAgentDestination(root, state.files);
    }
    await hook?.("after-target-validation", target);
    await hook?.("before-target-publish", target);
    const destinationAfterValidation = await lstat(destination).catch(
      () => undefined,
    );
    if (
      destinationAfterValidation !== undefined &&
      (target !== "agent" || targetWasInitiallyMissing)
    ) {
      throw cliError({
        code: "INIT_RECOVERY_CONFLICT",
        message:
          `The interrupted scaffold cannot publish "${target}" because existing bytes appeared; no existing file was overwritten.`,
        source: target,
      });
    }
    if (target === "agent") {
      await assertPartialAgentDestination(root, state.files);
    }
    const missingTargetFiles = targetFiles.filter(
      (_file, index) => published[index] === "missing",
    );
    try {
      await publishScaffoldTargetNoReplace(
        root,
        stage,
        target,
        missingTargetFiles,
      );
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "EEXIST" || code.code === "ENOTEMPTY") {
        throw cliError({
          code: "INIT_RECOVERY_CONFLICT",
          message:
            `The interrupted scaffold could not publish "${target}" because existing bytes appeared; no existing file was overwritten.`,
          source: target,
        });
      }
      throw error;
    }
    await hook?.("after-target-publish", target);
  }

  await assertPublishedScaffold(root, state);
  await hook?.("before-complete");
  await assertPublishedScaffold(root, state);
  await rm(stage, { recursive: true, force: true });
  await rm(statePath, { force: true });
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function projectInputPaths(
  root: string,
  configuration: ProjectConfiguration,
): Promise<readonly string[]> {
  const paths = new Set<string>([
    relative(root, configuration.packagePath),
    relative(root, configuration.configPath),
  ]);
  const ignoredDirectories = new Set([
    ".eden",
    ".git",
    ".wrangler",
    "dist",
    "node_modules",
  ]);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      if (
        ignoredDirectories.has(entry.name) ||
        (directory === root && entry.name.startsWith(".eden-"))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        await resolveContainedProjectPath(root, relativePath);
        paths.add(relativePath);
      }
    }
  };
  const agentDirectory = await resolveContainedProjectPath(root, "agent");
  const details = await lstat(agentDirectory).catch(() => undefined);
  if (details?.isDirectory() !== true || details.isSymbolicLink()) {
    throw cliError({
      code: "PROJECT_INPUT_INVALID",
      message: "The selected project agent directory is unavailable during validation.",
      source: "agent",
    });
  }
  await visit(root);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function fingerprintProjectInputs(
  root: string,
  configuration: ProjectConfiguration,
): Promise<ProjectInputFingerprint> {
  const files: ProjectInputFingerprint["files"][number][] = [];
  for (const relativePath of await projectInputPaths(root, configuration)) {
    const path = await resolveContainedProjectPath(root, relativePath);
    const details = await lstat(path).catch(() => undefined);
    if (
      details === undefined ||
      (!details.isFile() && !details.isSymbolicLink())
    ) {
      throw cliError({
        code: "PROJECT_INPUT_INVALID",
        message:
          `Selected project input "${relativePath}" is missing or is not a regular file.`,
        source: relativePath,
      });
    }
    const contents = await readFile(path).catch(() => undefined);
    if (contents === undefined) {
      throw cliError({
        code: "PROJECT_INPUT_INVALID",
        message: `Selected project input "${relativePath}" could not be read.`,
        source: relativePath,
      });
    }
    files.push({
      relativePath,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return {
    files,
    digest: sha256(JSON.stringify(files)),
  };
}

async function assertProjectInputsUnchanged(
  root: string,
  configuration: ProjectConfiguration,
  expected: ProjectInputFingerprint,
): Promise<void> {
  let current: ProjectInputFingerprint;
  try {
    current = await fingerprintProjectInputs(root, configuration);
  } catch (error: unknown) {
    if (error instanceof EdenCliError) {
      throw cliError({
        code: "SOURCE_CHANGED_DURING_VALIDATION",
        message:
          `Selected source or configuration changed during Worker compatibility validation: ${error.message}`,
        ...(error.source === undefined ? {} : { source: error.source }),
      });
    }
    throw error;
  }
  if (
    current.digest !== expected.digest ||
    JSON.stringify(current.files) !== JSON.stringify(expected.files)
  ) {
    const changed = new Set(
      [...expected.files, ...current.files].map((file) => file.relativePath),
    );
    const changedPath = [...changed].find((relativePath) => {
      const before = expected.files.find((file) => file.relativePath === relativePath);
      const after = current.files.find((file) => file.relativePath === relativePath);
      return before?.sha256 !== after?.sha256;
    });
    throw cliError({
      code: "SOURCE_CHANGED_DURING_VALIDATION",
      message:
        "Selected source or configuration changed during Worker compatibility validation; the stale candidate was not promoted.",
      ...(changedPath === undefined ? {} : { source: changedPath }),
    });
  }
}

async function assertArtifactDirectory(
  directory: string,
): Promise<EdenArtifactGeneration> {
  try {
    return await readArtifactGeneration(directory);
  } catch (error: unknown) {
    if (error instanceof EdenCompilerError) {
      throw cliError({
        code: "ARTIFACT_INCOHERENT",
        message: error.message,
        diagnostics: error.diagnostics,
      });
    }
    throw error;
  }
}

async function ensureCanonicalArtifactDirectory(
  root: string,
  outputDirectory: string,
): Promise<void> {
  assertWithinRoot(root, outputDirectory, "The canonical artifact directory");
  const existing = await lstat(outputDirectory).catch(() => undefined);
  if (existing?.isSymbolicLink() === true) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: "The .eden artifact directory must not be a symbolic link.",
      source: ".eden",
    });
  }
  if (existing !== undefined && !existing.isDirectory()) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: "The .eden artifact path must be a directory.",
      source: ".eden",
    });
  }
  await mkdir(outputDirectory, { recursive: true });
  const generations = join(outputDirectory, "generations");
  await assertContainedPathForCli(root, outputDirectory, ".eden");
  const generationsDetails = await lstat(generations).catch(() => undefined);
  if (generationsDetails?.isSymbolicLink() === true) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: "The .eden generations directory must not be a symbolic link.",
      source: ".eden/generations",
    });
  }
  if (generationsDetails !== undefined && !generationsDetails.isDirectory()) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: "The .eden generations path must be a directory.",
      source: ".eden/generations",
    });
  }
  await mkdir(generations, { recursive: true });
  await assertContainedPathForCli(root, generations, ".eden/generations");

  const current = join(outputDirectory, "CURRENT");
  const currentDetails = await lstat(current).catch(() => undefined);
  if (currentDetails !== undefined && !currentDetails.isSymbolicLink()) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: "The .eden CURRENT pointer must be a symbolic link.",
      source: ".eden/CURRENT",
    });
  }
  if (currentDetails !== undefined) {
    await assertArtifactDirectory(outputDirectory);
  }

  for (const name of CANONICAL_ARTIFACT_NAMES) {
    const alias = join(outputDirectory, name);
    const details = await lstat(alias).catch(() => undefined);
    if (details === undefined) {
      await symlink(join("CURRENT", name), alias);
      continue;
    }
    if (!details.isSymbolicLink()) {
      throw cliError({
        code: "ARTIFACT_OUTPUT_INVALID",
        message:
          `The canonical artifact alias "${name}" must be a symbolic link to CURRENT.`,
        source: name,
      });
    }
    const target = await readlink(alias).catch(() => undefined);
    if (target !== join("CURRENT", name)) {
      throw cliError({
        code: "ARTIFACT_OUTPUT_INVALID",
        message:
          `The canonical artifact alias "${name}" does not resolve through CURRENT.`,
        source: name,
      });
    }
  }
}

async function assertContainedPathForCli(
  root: string,
  path: string,
  source: string,
): Promise<void> {
  const canonical = await realpath(path).catch(() => undefined);
  if (
    canonical === undefined ||
    (canonical !== root && !canonical.startsWith(`${root}/`))
  ) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: `Generated artifact path "${source}" escapes the selected project root.`,
      source,
    });
  }
}

async function promoteCurrentGeneration(
  outputDirectory: string,
  generationId: string,
): Promise<void> {
  const currentPointer = join(outputDirectory, "CURRENT");
  const generationsDirectory = join(outputDirectory, "generations");
  const generation = join(generationsDirectory, generationId);
  const generationDetails = await lstat(generation).catch(() => undefined);
  if (
    generationDetails === undefined ||
    !generationDetails.isDirectory() ||
    generationDetails.isSymbolicLink()
  ) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: `The candidate generation "${generationId}" is unavailable.`,
      source: generationId,
    });
  }
  const pointerStage = join(
    outputDirectory,
    `.CURRENT-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  try {
    await symlink(join("generations", generationId), pointerStage);
    await rename(pointerStage, currentPointer);
  } finally {
    await rm(pointerStage, { force: true }).catch(() => undefined);
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

interface RuntimeGeneration {
  readonly generationId: string;
  readonly bundleDigest: string;
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly agentBundleVersion: string;
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly toolNames: readonly string[];
}

const DEV_STATE_FILE = ".eden-dev-state.json";

interface DevState {
  readonly pid: number;
  readonly startedAt: string;
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    return code.code !== "ESRCH";
  }
}

async function writeDevState(
  root: string,
  pid: number,
  startedAt: string,
): Promise<string> {
  if (startedAt.length === 0) {
    throw cliError({
      code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
      message:
        "The Eden dev process start identity could not be verified; cleanup is disabled.",
      source: DEV_STATE_FILE,
    });
  }
  const statePath = await resolveContainedProjectPath(root, DEV_STATE_FILE);
  const existing = await lstat(statePath).catch(() => undefined);
  if (existing !== undefined) {
    const previous = await readDevState(root);
    let alive = true;
    if (previous !== undefined) {
      const currentStart = await readProcessStartMarker(previous.pid);
      alive = currentStart !== undefined && currentStart === previous.startedAt;
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
  const state: DevState = {
    pid,
    startedAt,
    workerHost: EDEN_LOCAL_HOST,
    workerPort: EDEN_LOCAL_PORT,
    inspectorHost: EDEN_LOCAL_INSPECTOR_HOST,
    inspectorPort: EDEN_LOCAL_INSPECTOR_PORT,
  };
  await writeFile(statePath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
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
    typeof state.startedAt !== "string" ||
    state.startedAt.length === 0 ||
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

async function waitForProcessExit(
  pid: number,
  expectedStart: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const currentStart = await readProcessStartMarker(pid);
    if (currentStart === undefined || currentStart !== expectedStart) return;
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
    const currentStart = await readProcessStartMarker(state.pid);
    if (currentStart === undefined || currentStart !== state.startedAt) {
      return 0;
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
    await waitForProcessExit(state.pid, state.startedAt);
    await waitForApprovedPortsAvailable();
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
  generation: EdenArtifactGeneration,
  executionMode: "local" | "remote" = "local",
): Promise<RuntimeFiles> {
  const runtimeGeneration = readRuntimeGeneration(generation);
  const runtimeEntrypoint = await resolveRuntimeWorkerEntrypoint();
  const entryPath = join(
    root,
    `${uniqueTemporaryName("eden-dev-worker")}.mjs`,
  );
  assertWithinRoot(root, entryPath, "The local runtime entrypoint");
  const bundlePath = join(generation.directory, "agent-bundle.mjs");
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
  const entryContents = `import runtimeWorker, { EdenSession, configureEdenArtifact } from ${JSON.stringify(
    moduleSpecifier(runtimeImport),
  )};
import agentArtifact from ${JSON.stringify(
    moduleSpecifier(bundleImport),
  )};

configureEdenArtifact(agentArtifact, ${JSON.stringify({
  ...runtimeGeneration,
  executionMode,
})});
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

function readRuntimeGeneration(
  resolved: EdenArtifactGeneration,
): RuntimeGeneration {
  const { manifest, buildMetadata } = resolved.artifacts;
  const toolNames = manifest.tools.map((tool) => tool.name);
  if (
    toolNames.some((name) => typeof name !== "string") ||
    buildMetadata.generationId.length === 0 ||
    buildMetadata.bundleDigest.length === 0
  ) {
    throw cliError({
      code: "ARTIFACT_INCOHERENT",
      message:
        "The generated Worker metadata is incomplete and cannot configure the runtime.",
    });
  }
  return {
    generationId: buildMetadata.generationId,
    bundleDigest: buildMetadata.bundleDigest,
    manifestVersion: manifest.version,
    runtimeVersion: manifest.runtimeVersion,
    agentBundleVersion: manifest.agentBundleVersion,
    protocolVersion: manifest.protocolVersion,
    schemaVersion: manifest.schemaVersion,
    toolNames,
  };
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

function runDefaultRemoteCommand(
  request: EdenCliRemoteCommandRequest,
): Promise<EdenCliRemoteCommandResult> {
  return resolveDeploymentExecutable(request.cwd).then(
    (executable) =>
      new Promise((resolveResult) => {
        const child = spawnChild(executable, [...request.args], {
          cwd: request.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        if (request.stdin === undefined) {
          child.stdin?.end();
        } else {
          child.stdin?.end(request.stdin);
        }
        child.once("error", () => {
          resolveResult({ exitCode: 1, stdout, stderr });
        });
        child.once("exit", (exitCode) => {
          resolveResult({
            exitCode: exitCode ?? 1,
            stdout,
            stderr,
          });
        });
      }),
  );
}

function findDeploymentUrl(output: string): string | undefined {
  const match = output.match(
    /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev(?:\/[^\s]*)?/iu,
  );
  return match?.[0];
}

function remoteHeaders(secret: string): HeadersInit {
  return { authorization: `Bearer ${secret}` };
}

async function fetchRemote(
  url: string,
  secret: string | undefined,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(secret === undefined ? {} : remoteHeaders(secret)),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readRemoteJson(
  response: Response,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text()) as unknown;
  } catch {
    throw cliError({
      code: "REMOTE_RESPONSE_INVALID",
      message: `The deployed Worker returned invalid JSON (HTTP ${response.status}).`,
    });
  }
  if (!isRecord(value)) {
    throw cliError({
      code: "REMOTE_RESPONSE_INVALID",
      message: `The deployed Worker returned an invalid response (HTTP ${response.status}).`,
    });
  }
  return value;
}

function parseRemoteEvents(value: string): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of value.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw cliError({
        code: "REMOTE_STREAM_INVALID",
        message: "The deployed Worker returned an invalid NDJSON event.",
      });
    }
    if (!isRecord(parsed)) {
      throw cliError({
        code: "REMOTE_STREAM_INVALID",
        message: "The deployed Worker returned an invalid NDJSON event envelope.",
      });
    }
    events.push(parsed);
  }
  return events;
}

function remoteDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveResult) => {
    setTimeout(resolveResult, milliseconds);
  });
}

async function runDefaultRemoteValidation(
  request: EdenCliRemoteValidationRequest,
  secret: string,
): Promise<EdenCliRemoteValidationResult> {
  const healthUrl = `${request.url}/eden/v1/health`;
  const infoUrl = `${request.url}/eden/v1/info`;
  const sessionUrl = `${request.url}/eden/v1/session`;
  const startedAt = Date.now();
  let info: Record<string, unknown> | undefined;
  while (Date.now() - startedAt < 90_000) {
    try {
      const unauthorized = await fetchRemote(healthUrl, undefined);
      if (unauthorized.status === 200) {
        return {
          ok: false,
          code: "REMOTE_AUTHENTICATION_FAILED",
          message: "The deployed Worker did not fail closed without its bearer.",
        };
      }
      if (unauthorized.status !== 401) {
        await remoteDelay(1_000);
        continue;
      }
      const infoResponse = await fetchRemote(infoUrl, secret);
      if (infoResponse.status !== 200) {
        await remoteDelay(1_000);
        continue;
      }
      const health = await fetchRemote(healthUrl, secret);
      if (health.status !== 200) {
        await remoteDelay(1_000);
        continue;
      }
      const healthBody = await readRemoteJson(health);
      if (healthBody.status !== "ok") {
        return {
          ok: false,
          code: "REMOTE_HEALTH_FAILED",
          message: "The deployed Worker returned an unexpected health status.",
        };
      }
      info = await readRemoteJson(infoResponse);
      break;
    } catch {
      // Edge propagation can leave DNS and Worker routes temporarily unavailable.
    }
    await remoteDelay(1_000);
  }
  if (info === undefined) {
    return {
      ok: false,
      code: "REMOTE_PROPAGATION_TIMEOUT",
      message: "The deployed Worker did not expose authenticated health and info after propagation.",
    };
  }

  const generation = info.generation;
  if (!isRecord(generation)) {
    return {
      ok: false,
      code: "REMOTE_GENERATION_MISSING",
      message: "The deployed Worker did not expose expected generation metadata.",
    };
  }
  for (const key of [
    "generationId",
    "bundleDigest",
    "manifestVersion",
    "runtimeVersion",
    "agentBundleVersion",
    "protocolVersion",
    "schemaVersion",
  ] as const) {
    if (generation[key] !== request.expectedGeneration[key]) {
      return {
        ok: false,
        code: "REMOTE_GENERATION_MISMATCH",
        message: "The reachable Worker exposed a stale or mixed generation.",
      };
    }
  }
  if (
    JSON.stringify(generation.toolNames) !==
    JSON.stringify(request.expectedGeneration.toolNames)
  ) {
    return {
      ok: false,
      code: "REMOTE_GENERATION_MISMATCH",
      message: "The reachable Worker exposed a different tool identity set.",
    };
  }

  let session: Record<string, unknown> | undefined;
  const sessionStartedAt = Date.now();
  while (Date.now() - sessionStartedAt < 90_000) {
    try {
      const sessionResponse = await fetchRemote(sessionUrl, secret, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (sessionResponse.status === 201) {
        session = await readRemoteJson(sessionResponse);
        break;
      }
    } catch {
      // Durable Object namespace propagation can lag the Worker route.
    }
    await remoteDelay(1_000);
  }
  if (session === undefined) {
    return {
      ok: false,
      code: "REMOTE_PROPAGATION_TIMEOUT",
      message: "The deployed Worker did not create an authenticated session after propagation.",
    };
  }
  if (
    typeof session.sessionId !== "string" ||
    !/^sess_[a-f0-9]{32}$/u.test(session.sessionId)
  ) {
    return {
      ok: false,
      code: "REMOTE_SESSION_FAILED",
      message: "The deployed Worker returned an invalid opaque session identifier.",
    };
  }
  const sessionId = session.sessionId;
  const commandResponse = await fetchRemote(`${sessionUrl}/${sessionId}`, secret, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Say hello to Eden." }),
  });
  if (commandResponse.status !== 202) {
    return {
      ok: false,
      code: "REMOTE_COMMAND_FAILED",
      message: "The deployed Worker did not durably accept the validation command.",
    };
  }

  const streamUrl = `${sessionUrl}/${sessionId}/stream`;
  const firstEvents: Record<string, unknown>[] = [];
  let cursor = 0;
  const streamStartedAt = Date.now();
  while (firstEvents.length < 5 && Date.now() - streamStartedAt < 60_000) {
    const response = await fetchRemote(
      `${streamUrl}?startIndex=${cursor}&follow=false`,
      secret,
    );
    if (response.status !== 200) {
      return {
        ok: false,
        code: "REMOTE_STREAM_FAILED",
        message: "The deployed Worker did not expose an authenticated NDJSON stream.",
      };
    }
    for (const event of parseRemoteEvents(await response.text())) {
      const streamIndex = event.streamIndex;
      if (
        typeof streamIndex !== "number" ||
        !Number.isSafeInteger(streamIndex) ||
        streamIndex <= cursor
      ) {
        return {
          ok: false,
          code: "REMOTE_STREAM_INVALID",
          message: "The deployed Worker returned an invalid or non-monotonic cursor.",
        };
      }
      cursor = streamIndex;
      firstEvents.push(event);
      if (firstEvents.length === 5) break;
    }
    if (firstEvents.length < 5) await remoteDelay(250);
  }
  if (firstEvents.length < 5) {
    return {
      ok: false,
      code: "REMOTE_STREAM_TIMEOUT",
      message: "The deployed Worker did not reach the validation disconnect cursor.",
    };
  }
  const disconnectedCursor = Number(firstEvents.at(-1)?.streamIndex);
  const remaining: Record<string, unknown>[] = [];
  let terminal = false;
  const reconnectStartedAt = Date.now();
  while (!terminal && Date.now() - reconnectStartedAt < 90_000) {
    const response = await fetchRemote(
      `${streamUrl}?startIndex=${disconnectedCursor}&follow=false`,
      secret,
    );
    if (response.status !== 200) {
      return {
        ok: false,
        code: "REMOTE_RECONNECT_FAILED",
        message: "The deployed Worker rejected cursor reconnection.",
      };
    }
    for (const event of parseRemoteEvents(await response.text())) {
      const streamIndex = event.streamIndex;
      if (
        typeof streamIndex !== "number" ||
        !Number.isSafeInteger(streamIndex) ||
        streamIndex <= disconnectedCursor
      ) {
        return {
          ok: false,
          code: "REMOTE_RECONNECT_INVALID",
          message: "The deployed Worker returned an event at or before the saved cursor.",
        };
      }
      if (!remaining.some((existing) => existing.eventId === event.eventId)) {
        remaining.push(event);
      }
      if (event.type === "session.waiting" || event.type === "session.failed") {
        terminal = true;
      }
    }
    if (!terminal) await remoteDelay(250);
  }
  if (!terminal) {
    return {
      ok: false,
      code: "REMOTE_TURN_TIMEOUT",
      message: "The deployed Worker did not complete the bounded validation turn.",
    };
  }
  const allEvents = [...firstEvents, ...remaining];
  const lifecycle = allEvents.map((event) => event.type);
  const expectedLifecycle = [
    "session.started",
    "turn.started",
    "message.received",
    "step.started",
    "actions.requested",
    "action.result",
    "step.completed",
    "step.started",
    "message.completed",
    "step.completed",
    "turn.completed",
    "session.waiting",
  ];
  if (JSON.stringify(lifecycle) !== JSON.stringify(expectedLifecycle)) {
    return {
      ok: false,
      code: "REMOTE_LIFECYCLE_INVALID",
      message: "The deployed Worker returned an unexpected lifecycle order.",
    };
  }
  const action = allEvents.find((event) => event.type === "action.result");
  const actionData = isRecord(action?.data) ? action.data : undefined;
  if (
    actionData?.toolName !== request.expectedGeneration.toolNames[0] ||
    !isRecord(actionData?.output)
  ) {
    return {
      ok: false,
      code: "REMOTE_TOOL_INVALID",
      message: "The deployed Worker did not complete the expected typed tool action.",
    };
  }
  const completed = allEvents.find((event) => event.type === "message.completed");
  const completedData = isRecord(completed?.data) ? completed.data : undefined;
  if (typeof completedData?.content !== "string") {
    return {
      ok: false,
      code: "REMOTE_FINAL_INVALID",
      message: "The deployed Worker did not commit an Eden-owned final response.",
    };
  }
  return { ok: true };
}

async function buildProjectFromCli(
  root: string,
  options: EdenCliRunOptions,
  environment?: "preview" | "production",
): Promise<string> {
  const configuration = await readProjectConfiguration(root);
  const inputFingerprint = await fingerprintProjectInputs(root, configuration);
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
    const candidateGeneration = await assertArtifactDirectory(candidateOutput);
    runtimeFiles = await createRuntimeFiles(
      root,
      configuration.configPath,
      candidateGeneration,
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
    await assertProjectInputsUnchanged(root, configuration, inputFingerprint);
    await options.buildPublicationHook?.("before-canonical-prepare");
    await ensureCanonicalArtifactDirectory(root, canonicalOutput);
    await options.buildPublicationHook?.("after-canonical-prepare");

    const generationId = result.artifacts.buildMetadata.generationId;
    const candidateGenerationPath = join(
      candidateOutput,
      "generations",
      generationId,
    );
    const canonicalGeneration = join(
      canonicalOutput,
      "generations",
      generationId,
    );
    await options.buildPublicationHook?.("before-generation-publish");
    const existingGeneration = await lstat(canonicalGeneration).catch(
      () => undefined,
    );
    if (existingGeneration === undefined) {
      await rename(candidateGenerationPath, canonicalGeneration);
    } else {
      if (
        !existingGeneration.isDirectory() ||
        existingGeneration.isSymbolicLink()
      ) {
        throw cliError({
          code: "ARTIFACT_OUTPUT_INVALID",
          message:
            `The canonical generation "${generationId}" is not a real directory.`,
          source: generationId,
        });
      }
      await assertArtifactDirectory(candidateOutput);
      await rm(candidateGenerationPath, { recursive: true, force: true });
    }
    await options.buildPublicationHook?.("after-generation-publish");
    await options.buildPublicationHook?.("before-current-promotion");
    await promoteCurrentGeneration(canonicalOutput, generationId);
    await assertArtifactDirectory(canonicalOutput);
    await options.buildPublicationHook?.("after-current-promotion");

    options.stdout?.(
      `Built Eden project generation ${generationId}.`,
    );
    options.stdout?.("Worker compatibility dry run passed; no deployment was performed.");
    return result.artifacts.buildMetadata.generationId;
  } finally {
    await rm(candidateOutput, { recursive: true, force: true }).catch(
      () => undefined,
    );
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

async function waitForApprovedPortsAvailable(
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let available = true;
    for (const approved of APPROVED_PORTS) {
      if (!(await portIsAvailable(approved.host, approved.port))) {
        available = false;
        break;
      }
    }
    if (available) return;
    await new Promise((resolveResult) => setTimeout(resolveResult, 50));
  }
  throw cliError({
    code: "DEV_PORT_RELEASE_TIMEOUT",
    message:
      "The owned Eden dev process exited, but an approved local listener remains.",
  });
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
        env: (() => {
          const childEnv = { ...process.env, ...request.env };
          if (request.env.EDEN_BEARER_SECRET === undefined) {
            delete childEnv.EDEN_BEARER_SECRET;
          }
          return childEnv;
        })(),
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
      const startIdentity = readProcessStartMarker(pid);
      return {
        pid,
        startIdentity,
        exited,
        ready,
        async terminate(signal = "SIGTERM") {
          if (pid <= 0) return;
          const expected = await startIdentity;
          if (
            expected === undefined ||
            (await readProcessStartMarker(pid)) !== expected
          ) {
            return;
          }
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
  const generation = await readArtifactGeneration(canonicalOutput);
  const runtimeFiles = await createRuntimeFiles(
    root,
    configuration.configPath,
    generation,
  );
  const temporaryConfig = runtimeFiles.configPath;
  const localSecret = process.env.EDEN_BEARER_SECRET;
  const localSecretPath = localSecret === undefined
    ? undefined
    : join(tmpdir(), uniqueTemporaryName("eden-dev-vars"));
  if (localSecretPath !== undefined) {
    if (
      typeof localSecret !== "string" ||
      localSecret.length === 0 ||
      /[\r\n]/u.test(localSecret)
    ) {
      await rm(temporaryConfig, { force: true }).catch(() => undefined);
      await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
      throw cliError({
        code: "DEV_SECRET_INVALID",
        message:
          "EDEN_BEARER_SECRET must be a non-empty single-line value for local dev.",
      });
    }
    try {
      await writeFile(
        localSecretPath,
        `EDEN_BEARER_SECRET=${JSON.stringify(localSecret)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
    } catch (error: unknown) {
      await rm(localSecretPath, { force: true }).catch(() => undefined);
      await rm(temporaryConfig, { force: true }).catch(() => undefined);
      await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  let child: EdenCliProcess | undefined;
  let watcher: FSWatcher | undefined;
  let stopped = false;
  let rebuildTimer: NodeJS.Timeout | undefined;
  let rebuildInFlight = false;
  let rebuildPending = false;
  const rebuildTasks = new Set<Promise<void>>();
  let statePath: string | undefined;
  let requestedStop = false;
  let ownershipVerified = false;
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
      ...(localSecretPath === undefined
        ? []
        : ["--env-file", localSecretPath]),
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
      const startIdentity = await child.startIdentity;
      if (typeof startIdentity !== "string" || startIdentity.length === 0) {
        throw cliError({
          code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
          message:
            "The Eden dev process start identity could not be verified; no PID or process group was signaled.",
          source: DEV_STATE_FILE,
        });
      }
      ownershipVerified = true;
      const readiness = child.ready ?? Promise.resolve();
      void readiness.catch(() => undefined);
      statePath = await writeDevState(root, child.pid, startIdentity);
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
      if (child !== undefined && ownershipVerified) {
        void child.terminate().catch(() => undefined);
      }
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
    if (child !== undefined && ownershipVerified) {
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
    if (localSecretPath !== undefined) {
      await rm(localSecretPath, { force: true }).catch(() => undefined);
    }
    if (statePath !== undefined) {
      await rm(statePath, { force: true }).catch(() => undefined);
    }
  }
}

async function readConfiguredWorkerName(
  configPath: string,
  environment: "preview" | "production",
): Promise<string | undefined> {
  const source = await readFile(configPath, "utf8");
  const extension = extname(configPath).toLowerCase();
  if (extension !== ".toml") {
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    try {
      const value = JSON.parse(withoutComments) as unknown;
      if (isRecord(value)) {
        const environments = isRecord(value.env) ? value.env : undefined;
        const selected = environments?.[environment];
        if (isRecord(selected) && typeof selected.name === "string") {
          return parseWorkerNameValue(selected.name);
        }
        if (typeof value.name === "string") {
          return parseWorkerNameValue(value.name);
        }
      }
    } catch {
      // The source-oriented fallback below preserves malformed config diagnostics.
    }
  }

  const section = extension === ".toml"
    ? new RegExp(
        `\\[env\\.${environment}\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`,
        "u",
      ).exec(source)?.[1]
    : undefined;
  const selectedName = section?.match(
    /^\s*name\s*=\s*["']([^"']+)["']/mu,
  )?.[1];
  const topLevelName = source.match(
    /^\s*name\s*=\s*["']([^"']+)["']/mu,
  )?.[1];
  const name = selectedName ?? topLevelName;
  return name === undefined ? undefined : parseWorkerNameValue(name);
}

async function runDeploy(
  root: string,
  options: EdenCliRunOptions,
  environment: "preview" | "production",
  requestedWorkerName: string | undefined,
): Promise<void> {
  const configuration = await readProjectConfiguration(root);
  await buildProjectFromCli(root, options, environment);
  const deploymentInputFingerprint = await fingerprintProjectInputs(
    root,
    configuration,
  );
  const canonicalOutput = await resolveContainedProjectPath(root, ".eden");
  const generation = await readArtifactGeneration(canonicalOutput);
  const runtimeGeneration = readRuntimeGeneration(generation);
  const runtimeFiles = await createRuntimeFiles(
    root,
    configuration.configPath,
    generation,
    "remote",
  );
  const temporaryConfig = runtimeFiles.configPath;
  const configuredWorkerName = await readConfiguredWorkerName(
    configuration.configPath,
    environment,
  );
  const workerName = requestedWorkerName ?? configuredWorkerName;
  if (workerName === undefined) {
    throw cliError({
      code: "WORKER_NAME_MISSING",
      message:
        "The selected deployment environment must define a Worker name or eden deploy must receive --name.",
    });
  }
  const secret = options.remoteBearerSecret ?? process.env.EDEN_BEARER_SECRET;
  let secretProvisioned = false;
  let workerDeployed = false;
  let deploymentUrl: string | undefined;
  const remoteCommand = options.remoteCommandRunner ?? runDefaultRemoteCommand;
  const remoteValidate = options.remoteValidationRunner ??
    ((request: EdenCliRemoteValidationRequest) => {
      if (secret === undefined || secret.length === 0) {
        return Promise.resolve({
          ok: false,
          code: "REMOTE_SECRET_REQUIRED",
          message: "A bearer secret is required for remote validation.",
        });
      }
      return runDefaultRemoteValidation(request, secret);
    });
  let deploymentFailure: unknown;
  try {
    const compatibilityRequest: EdenCliDryRunRequest = {
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
      dryRun = await (options.dryRunRunner ?? runDefaultDryRun)(
        compatibilityRequest,
      );
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
    await assertProjectInputsUnchanged(
      root,
      configuration,
      deploymentInputFingerprint,
    );
    if (secret === undefined || secret.length === 0) {
      throw cliError({
        code: "REMOTE_SECRET_REQUIRED",
        message:
          "Set EDEN_BEARER_SECRET outside the project before a real deployment.",
      });
    }

    secretProvisioned = true;
    const putSecret = await remoteCommand({
      kind: "secret-put",
      cwd: root,
      args: [
        "secret",
        "put",
        "EDEN_BEARER_SECRET",
        "--name",
        workerName,
        "--config",
        temporaryConfig,
      ],
      stdin: `${secret}\n`,
    });
    if (putSecret.exitCode !== 0) {
      throw cliError({
        code: "REMOTE_SECRET_FAILED",
        message: `The deployment tool could not provision the validation secret for ${environment}.${
          redactOutput(putSecret.stderr).length === 0
            ? ""
            : ` ${redactOutput(putSecret.stderr)}`
        }`,
      });
    }
    workerDeployed = true;
    const deployment = await remoteCommand({
      kind: "deploy",
      cwd: root,
      args: [
        "deploy",
        "--env",
        environment,
        "--name",
        workerName,
        "--config",
        temporaryConfig,
      ],
    });
    if (deployment.exitCode !== 0) {
      throw cliError({
        code: "REMOTE_DEPLOY_FAILED",
        message: `The deployment tool failed for ${environment}.${
          redactOutput(deployment.stderr).length === 0
            ? ""
            : ` ${redactOutput(deployment.stderr)}`
        }`,
      });
    }
    deploymentUrl = findDeploymentUrl(
      `${deployment.stdout}\n${deployment.stderr}`,
    );
    if (deploymentUrl === undefined) {
      throw cliError({
        code: "REMOTE_URL_MISSING",
        message:
          "The deployment tool completed without exposing a reachable workers.dev deployment URL.",
      });
    }
    const validation = await remoteValidate({
      cwd: root,
      environment,
      workerName,
      url: deploymentUrl,
      expectedGeneration: runtimeGeneration,
    });
    if (!validation.ok) {
      throw cliError({
        code: validation.code ?? "REMOTE_VALIDATION_FAILED",
        message:
          validation.message ??
          "The deployed Worker failed post-deployment validation.",
      });
    }
    options.stdout?.(
      `Deployment passed for ${environment}; Worker ${workerName} exposed generation ${runtimeGeneration.generationId} at ${deploymentUrl}.`,
    );
  } catch (error: unknown) {
    deploymentFailure = error;
    throw error;
  } finally {
    if (
      deploymentFailure !== undefined &&
      requestedWorkerName !== undefined &&
      (secretProvisioned || workerDeployed)
    ) {
      let cleanupFailed = false;
      if (secretProvisioned) {
        const removed = await remoteCommand({
          kind: "secret-delete",
          cwd: root,
          args: [
            "secret",
            "delete",
            "EDEN_BEARER_SECRET",
            "--name",
            workerName,
            "--config",
            configuration.configPath,
          ],
        }).catch(() => ({ exitCode: 1 }));
        cleanupFailed ||= removed.exitCode !== 0;
      }
      if (workerDeployed) {
        const deleted = await remoteCommand({
          kind: "delete",
          cwd: root,
          args: [
            "delete",
            workerName,
            "--env",
            environment,
            "--config",
            configuration.configPath,
            "--force",
          ],
        }).catch(() => ({ exitCode: 1 }));
        cleanupFailed ||= deleted.exitCode !== 0;
      }
      if (cleanupFailed) {
        options.stderr?.(
          `REMOTE_CLEANUP_FAILED: Validation cleanup did not remove every owned ${environment} resource for Worker ${workerName}.`,
        );
      }
    }
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
      await writeScaffold(root, options.initPublicationHook);
      options.stdout?.(`Initialized Eden project in ${root}.`);
      return;
    case "build":
      await buildProjectFromCli(root, options);
      return;
    case "dev":
      await runDev(root, options);
      return;
    case "deploy":
      await runDeploy(
        root,
        options,
        invocation.environment ?? "preview",
        invocation.workerName,
      );
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

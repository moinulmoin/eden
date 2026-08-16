#!/usr/bin/env node

import {
  createHash,
  randomUUID,
} from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import {
  cp,
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
  basename,
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
  type ChildProcess,
} from "child_process";
import {
  createConnection,
  createServer,
} from "net";
import {
  createRequire,
} from "module";

import {
  captureProjectImportClosure,
  buildProject,
  EdenCompilerError,
  readArtifactGeneration,
  readArtifactGenerationAt,
  resolveContainedProjectPath,
  resolveProjectRoot,
} from "@eden/compiler";
import type {
  EdenCompilerResult,
  EdenArtifactGeneration,
  EdenDiagnostic,
} from "@eden/compiler";

const require = createRequire(import.meta.url);

type InternalConfigReadConfig = (
  input: {
    readonly config: string;
    readonly env: "preview" | "production";
  },
  options: {
    readonly hideWarnings: boolean;
  },
) => {
  readonly name?: string;
};

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

export interface EdenCliDryRunHandle {
  readonly process: EdenCliProcess;
  readonly result: Promise<EdenCliDryRunResult>;
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

export interface EdenCliRemoteCommandHandle {
  readonly process: EdenCliProcess;
  readonly result: Promise<EdenCliRemoteCommandResult>;
}

export type EdenCliRemoteCommandReturn =
  | EdenCliRemoteCommandResult
  | EdenCliRemoteCommandHandle
  | Promise<EdenCliRemoteCommandResult | EdenCliRemoteCommandHandle>;

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
  /**
   * Arguments needed to invoke the executable directly. The package shim is a
   * shell script on POSIX and discards custom argv0 markers, so the default
   * runner supplies the real Node entrypoint here.
   */
  readonly commandArgs?: readonly string[];
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processIdentity?: string;
  readonly readiness?: readonly {
    readonly host: string;
    readonly port: number;
  }[];
}

export type EdenCliProcessIdentity = { readonly marker: string; readonly pid: number; readonly pgid: number; readonly lstart: string; };

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
  readonly identity?: EdenCliProcessIdentity | Promise<EdenCliProcessIdentity | undefined>;
  readonly startIdentity?: string | Promise<string | undefined>;
  readonly exited: Promise<EdenCliProcessExit>;
  readonly ready?: Promise<void>;
  terminate(signal?: NodeJS.Signals): Promise<void>;
}

export interface EdenCliProcessRunner {
  spawn(request: EdenCliProcessRequest): EdenCliProcess;
}

export interface EdenCliBuildProjectRequest {
  readonly projectRoot: string;
  readonly outputDirectory: string;
}

export type EdenCliBuildProjectRunner = (
  request: EdenCliBuildProjectRequest,
) => Promise<EdenCompilerResult>;

export interface EdenCliRuntimeGeneration {
  readonly generationId: string;
  readonly bundleDigest: string;
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly agentBundleVersion: string;
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly toolNames: readonly string[];
}

export interface EdenCliRuntimeGenerationProofRequest {
  readonly process: EdenCliProcess | undefined;
  readonly generation: EdenCliRuntimeGeneration;
  readonly signal: AbortSignal;
}

export type EdenCliRuntimeGenerationProof =
  | "authenticated-fetch"
  | ((
    request: EdenCliRuntimeGenerationProofRequest,
  ) => boolean | Promise<boolean>);

export type EdenRuntimePublicationBoundary =
  | "before-runtime-entry-publish"
  | "after-runtime-entry-publish"
  | "before-runtime-config-publish"
  | "after-runtime-config-publish"
  | "after-runtime-ready"
  | "before-runtime-rollback"
  | "after-runtime-rollback";

export type EdenDeploymentBoundary =
  | "before-compatibility-dry-run"
  | "before-remote-runner-invocation"
  | "after-remote-runner-preflight"
  | "after-remote-final-read"
  | "after-compatibility-dry-run"
  | "before-secret-provision"
  | "after-secret-provision"
  | "before-deploy"
  | "after-deploy"
  | "before-remote-validation"
  | "after-remote-validation";

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
  ) =>
    | EdenCliDryRunResult
    | EdenCliDryRunHandle
    | Promise<EdenCliDryRunResult>;
  readonly processRunner?: EdenCliProcessRunner;
  /**
   * Internal finite-test override for the compiler invocation. The returned
   * promise is still owned by the same cancellation/quiescence barrier as the
   * production compiler call.
   */
  readonly buildProjectRunner?: EdenCliBuildProjectRunner;
  /**
   * Internal finite-test override for the authenticated local runtime
   * readiness probe. Production callers use the bounded default.
   */
  readonly runtimeReadinessTimeoutMs?: number;
  /**
   * Internal lifecycle injection for finite callers that need to stop dev
   * without emitting a process-global signal.
   */
  readonly stopSignal?: AbortSignal;
  /**
   * An injected process runner must provide this explicit proof seam. The
   * string selects Eden's bearer-authenticated /eden/v1/info probe; a callback
   * may provide an equivalent authenticated proof for a finite fixture.
   */
  readonly runtimeGenerationProof?: EdenCliRuntimeGenerationProof;
  readonly runtimePublicationHook?: (
    boundary: EdenRuntimePublicationBoundary,
  ) => void | Promise<void>;
  readonly deploymentBoundaryHook?: (
    boundary: EdenDeploymentBoundary,
  ) => void | Promise<void>;
  readonly remoteCommandRunner?: (
    request: EdenCliRemoteCommandRequest,
  ) => EdenCliRemoteCommandReturn;
  readonly remoteValidationRunner?: (
    request: EdenCliRemoteValidationRequest,
  ) => Promise<EdenCliRemoteValidationResult>;
  readonly remoteBearerSecret?: string;
}

export type EdenInitPublicationBoundary =
  | "after-lock-acquire"
  | "after-state-write"
  | "after-stage-write"
  | "after-target-validation"
  | "after-init-link"
  | "before-init-destination-recheck"
  | "before-init-cleanup"
  | "after-init-cleanup-observation"
  | "after-init-cleanup"
  | "before-init-link"
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

interface DeploymentExecutable {
  readonly command: string;
  readonly commandArgs: readonly string[];
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
  "wrangler.json",
  "wrangler.jsonc",
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

function loadInternalConfigReadConfig(): InternalConfigReadConfig {
  let moduleValue: unknown;
  try {
    moduleValue = require("wrangler") as unknown;
  } catch (error: unknown) {
    const reason = error instanceof Error
      ? error.message
      : "the module could not be loaded";
    throw cliError({
      code: "WRANGLER_CONFIG_LOADER_UNAVAILABLE",
      message: `The pinned configuration loader is unavailable: ${reason}.`,
    });
  }
  if (
    !isRecord(moduleValue) ||
    typeof moduleValue.unstable_readConfig !== "function"
  ) {
    throw cliError({
      code: "WRANGLER_CONFIG_LOADER_UNAVAILABLE",
      message:
        "The pinned configuration loader does not export unstable_readConfig.",
    });
  }
  return moduleValue.unstable_readConfig as InternalConfigReadConfig;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return JSON.stringify(actualKeys) === JSON.stringify(sortedExpectedKeys);
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
    await assertInitRootEntries(root, incompleteInit);
    await assertInitStage(root, incompleteInit);
    await assertInitAgentDirectories(root, incompleteInit);
    const published = await Promise.all(
      incompleteInit.files.map((file) =>
        readInitCanonicalState(root, file.relativePath, file.sha256)
      ),
    );
    if (published.some((value) => value !== "match")) {
      throw initBusy(
        "The selected project contains a partial Eden scaffold; rerun init to recover it before building.",
        INIT_STATE_FILE,
      );
    }
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

function isContainedPath(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return (
    candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}/`) ||
    candidate.startsWith(`${normalizedRoot}\\`)
  );
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
  readonly excludedRelativePaths: readonly string[];
}

interface DeploymentLockState {
  readonly kind: "eden.deploy.lock";
  readonly version: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

interface DeploymentLeaseHandle {
  readonly path: string;
  readonly lockPath: string;
  readonly state: DeploymentLockState;
  readonly serialized: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
  };
  readonly release: () => Promise<boolean>;
}

interface InitPublicationLockState {
  readonly kind: "eden.init.lock";
  readonly version: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

interface InitFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface InitFileObservation {
  readonly identity: InitFileIdentity;
  readonly serialized: string;
}

interface InitLockHandle {
  readonly path: string;
  readonly token: string;
  readonly serialized: string;
  readonly observation: InitFileObservation;
  readonly owned: boolean;
  readonly release: (
    hook?: EdenCliRunOptions["initPublicationHook"],
  ) => Promise<void>;
}

const INIT_STATE_FILE = ".eden-init-incomplete.json";
const INIT_LOCK_FILE = ".eden-init.lock";
const DEPLOY_LOCK_FILE = ".eden-deploy.lock";
const DEPLOY_LEASE_PATTERN =
  /^\.eden-deploy-lease-[0-9]+-[a-f0-9-]+$/u;
const DEPLOY_LEASE_QUARANTINE_PATTERN =
  /^\.eden-deploy-release-lease-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEPLOY_LOCK_QUARANTINE_PATTERN =
  /^\.eden-deploy-(?:stale-lock|release-lock)-[0-9]+-[a-f0-9-]+$/u;
const INIT_PROVENANCE_DIRECTORY_PREFIX = ".eden-init-provenance-";
const activeInitLockTokens = new Set<string>();
const INIT_LEGACY_STATE_PREFIXES = [
  ".eden-init-",
  INIT_PROVENANCE_DIRECTORY_PREFIX,
  ".eden-init-transition-",
  ".eden-init-stale-lock-",
  ".eden-init-release-lock-",
  ".eden-init-recovery-",
] as const;
const REMOTE_RESULT_TIMEOUT_MS = 500;
const CANONICAL_ARTIFACT_NAMES = [
  "discovery.json",
  "diagnostics.json",
  "manifest.json",
  "module-map.json",
  "agent-bundle.mjs",
  "build-metadata.json",
] as const;

function initBusy(
  message: string,
  source: string,
): EdenCliError {
  return cliError({
    code: "INIT_BUSY",
    message,
    source,
  });
}

function parseInitPublicationLockState(
  value: unknown,
): InitPublicationLockState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "version", "pid", "startedAt", "token"]) ||
    value.kind !== "eden.init.lock" ||
    value.version !== 1 ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAt !== "string" ||
    value.startedAt.length === 0 ||
    value.startedAt.startsWith("pid:") ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.token)
  ) {
    return undefined;
  }
  return {
    kind: "eden.init.lock",
    version: 1,
    pid: value.pid,
    startedAt: value.startedAt,
    token: value.token,
  };
}

function sameInitFileIdentity(
  left: InitFileIdentity,
  right: InitFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameInitFileObservation(
  left: InitFileObservation,
  right: InitFileObservation,
): boolean {
  return sameInitFileIdentity(left.identity, right.identity) &&
    left.serialized === right.serialized;
}

async function assertInitParentChain(
  root: string,
  path: string,
  source: string,
  allowMissing = true,
): Promise<void> {
  const parent = resolve(dirname(path));
  const normalizedRoot = resolve(root);
  if (!isContainedPath(normalizedRoot, parent)) {
    throw initBusy(
      "The init path escapes the selected project root; all state was preserved.",
      source,
    );
  }
  const parts = relative(normalizedRoot, parent)
    .split(/[\\/]/u)
    .filter(Boolean);
  let current = normalizedRoot;
  for (const part of parts) {
    current = join(current, part);
    const details = await lstat(current).catch((error: unknown) => {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT" && allowMissing) return undefined;
      throw initBusy(
        "The init path could not be inspected safely; all state was preserved.",
        source,
      );
    });
    if (details === undefined) return;
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw initBusy(
        "An init parent directory was a symlink or unsupported file type; all state was preserved.",
        source,
      );
    }
    const canonical = await realpath(current).catch(() => undefined);
    if (
      canonical === undefined ||
      resolve(canonical) !== resolve(current) ||
      !isContainedPath(normalizedRoot, canonical)
    ) {
      throw initBusy(
        "An init parent directory escapes the selected project root; all state was preserved.",
        source,
      );
    }
  }
}

function runInContainedDirectory<T>(
  root: string,
  directory: string,
  source: string,
  operation: () => T,
): T {
  const previous = process.cwd();
  try {
    process.chdir(directory);
    const canonical = realpathSync(".");
    if (
      resolve(canonical) !== resolve(directory) ||
      !isContainedPath(resolve(root), canonical)
    ) {
      throw initBusy(
        "An init parent directory escaped the selected project root; all state was preserved.",
        source,
      );
    }
    return operation();
  } catch (error: unknown) {
    if (error instanceof EdenCliError) throw error;
    const code = error as NodeJS.ErrnoException;
    if (code.code === "EEXIST") throw error;
    throw initBusy(
      `The init path could not be updated safely; all state was preserved${
        code.code === undefined ? "." : ` (${code.code}).`
      }`,
      source,
    );
  } finally {
    try {
      process.chdir(previous);
    } catch {
      try {
        process.chdir(root);
      } catch {
        // The selected root is retained as the final recovery anchor.
      }
    }
  }
}

function writeInitFileAtStableParent(
  root: string,
  path: string,
  contents: string,
  source: string,
): InitFileObservation {
  const parent = dirname(path);
  const name = basename(path);
  return runInContainedDirectory(root, parent, source, () => {
    let before: ReturnType<typeof lstatSync> | undefined;
    try {
      before = lstatSync(name);
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "ENOENT") throw error;
    }
    if (before !== undefined) {
      throw Object.assign(new Error("destination exists"), {
        code: "EEXIST",
      });
    }
    writeFileSync(name, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const after = lstatSync(name);
    if (!after.isFile() || after.isSymbolicLink()) {
      throw new Error("published destination has an unsafe type");
    }
    return {
      identity: { dev: after.dev, ino: after.ino },
      serialized: contents,
    };
  });
}

function initStageName(value: string): boolean {
  return /^\.eden-init-[0-9]+-[0-9a-f-]+$/u.test(value) &&
    basename(value) === value;
}

function isInitLegacyEntry(entry: string): boolean {
  return INIT_LEGACY_STATE_PREFIXES.some((prefix) => entry.startsWith(prefix));
}

function initExpectedFiles(): InitState["files"] {
  return INIT_SCAFFOLD.map((file) => ({
    relativePath: file.relativePath,
    sha256: sha256(file.content),
  }));
}

function initStateMatchesExpected(value: unknown): value is InitState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "version", "stageName", "files"]) ||
    value.kind !== "eden.init.incomplete" ||
    value.version !== 1 ||
    typeof value.stageName !== "string" ||
    !initStageName(value.stageName) ||
    !Array.isArray(value.files) ||
    value.files.length !== INIT_SCAFFOLD.length
  ) {
    return false;
  }
  const expected = initExpectedFiles();
  return value.files.every((file, index) => {
    const expectedFile = expected[index];
    return (
      isRecord(file) &&
      expectedFile !== undefined &&
      hasExactKeys(file, ["relativePath", "sha256"]) &&
      file.relativePath === expectedFile.relativePath &&
      file.sha256 === expectedFile.sha256
    );
  });
}

async function readInitFileObservation(
  path: string,
  source: string,
  root?: string,
): Promise<InitFileObservation | undefined> {
  if (root !== undefined) {
    await assertInitParentChain(root, path, source);
    const parent = dirname(path);
    const parentDetails = await lstat(parent).catch((error: unknown) => {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") return undefined;
      throw initBusy(
        "The init recovery path could not be inspected safely; all state was preserved.",
        source,
      );
    });
    if (parentDetails === undefined) return undefined;
    return runInContainedDirectory(root, parent, source, () => {
      const name = basename(path);
      let before: ReturnType<typeof lstatSync>;
      try {
        before = lstatSync(name);
      } catch (error: unknown) {
        const code = error as NodeJS.ErrnoException;
        if (code.code === "ENOENT") return undefined;
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        throw initBusy(
          "The init recovery path was a symlink or unsupported file type; all state was preserved.",
          source,
        );
      }
      const serialized = readFileSync(name, "utf8");
      const after = lstatSync(name);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        !sameInitFileIdentity(
          { dev: before.dev, ino: before.ino },
          { dev: after.dev, ino: after.ino },
        ) ||
        before.size !== after.size
      ) {
        throw initBusy(
          "The init recovery path changed while it was being read; all state was preserved.",
          source,
        );
      }
      return {
        identity: { dev: before.dev, ino: before.ino },
        serialized,
      };
    });
  }
  const before = await lstat(path).catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init recovery path could not be inspected safely; all state was preserved.",
      source,
    );
  });
  if (before === undefined) return undefined;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw initBusy(
      "The init recovery path was a symlink or unsupported file type; all state was preserved.",
      source,
    );
  }
  const serialized = await readFile(path, "utf8").catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init recovery path could not be read safely; all state was preserved.",
      source,
    );
  });
  if (serialized === undefined) return undefined;
  const after = await lstat(path).catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init recovery path changed while it was being read; all state was preserved.",
      source,
    );
  });
  if (
    after === undefined ||
    !sameInitFileIdentity(
      { dev: before.dev, ino: before.ino },
      { dev: after.dev, ino: after.ino },
    ) ||
    before.size !== after.size
  ) {
    throw initBusy(
      "The init recovery path changed while it was being read; all state was preserved.",
      source,
    );
  }
  return {
    identity: { dev: before.dev, ino: before.ino },
    serialized,
  };
}

async function readInitState(
  root: string,
): Promise<InitState | undefined> {
  const statePath = join(root, INIT_STATE_FILE);
  assertWithinRoot(root, statePath, "The init recovery state");
  const observation = await readInitFileObservation(
    statePath,
    INIT_STATE_FILE,
    root,
  );
  if (observation === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(observation.serialized) as unknown;
  } catch {
    throw initBusy(
      "The init recovery state is malformed; all bytes were preserved.",
      INIT_STATE_FILE,
    );
  }
  if (!initStateMatchesExpected(value)) {
    throw initBusy(
      "The init recovery state is unsupported or malformed; all bytes were preserved.",
      INIT_STATE_FILE,
    );
  }
  return value;
}

async function readInitLock(
  path: string,
  root: string,
): Promise<{
  readonly state: InitPublicationLockState;
  readonly serialized: string;
  readonly observation: InitFileObservation;
} | undefined> {
  const observation = await readInitFileObservation(path, INIT_LOCK_FILE, root);
  if (observation === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(observation.serialized) as unknown;
  } catch {
    throw initBusy(
      "The Eden init lock is malformed; it was preserved.",
      INIT_LOCK_FILE,
    );
  }
  const state = parseInitPublicationLockState(value);
  if (state === undefined) {
    throw initBusy(
      "The Eden init lock is unsupported or malformed; it was preserved.",
      INIT_LOCK_FILE,
    );
  }
  return { state, serialized: observation.serialized, observation };
}

async function initLockOwnerIsActive(
  state: InitPublicationLockState,
): Promise<boolean> {
  if (state.pid === process.pid) {
    return activeInitLockTokens.has(state.token);
  }
  const ownerStart = await readProcessStartTime(state.pid);
  if (ownerStart === state.startedAt) return true;
  if (ownerStart === undefined && isProcessAlive(state.pid)) return true;
  return false;
}

function initRootEntriesAllowed(
  state: InitState | undefined,
  stageName?: string,
): Set<string> {
  const allowed = new Set([
    INIT_LOCK_FILE,
    INIT_STATE_FILE,
    "agent",
    "package.json",
    "wrangler.jsonc",
    ".eden",
  ]);
  if (state !== undefined) allowed.add(state.stageName);
  if (stageName !== undefined) allowed.add(stageName);
  return allowed;
}

async function assertInitRootEntries(
  root: string,
  state: InitState | undefined,
  stageName?: string,
): Promise<void> {
  const allowed = initRootEntriesAllowed(state, stageName);
  const entries = await readdir(root);
  for (const entry of entries) {
    if (allowed.has(entry)) continue;
    if (isInitLegacyEntry(entry)) {
      throw initBusy(
        "Legacy or ambiguous Eden init state was found and was preserved; remove it only after inspecting the project.",
        entry,
      );
    }
    if (state === undefined) continue;
    throw initBusy(
      "The selected project changed or contains unrelated bytes; Eden init preserved every entry.",
      entry,
    );
  }
}

async function readInitCanonicalState(
  root: string,
  relativePath: string,
  expectedSha256: string,
): Promise<"missing" | "match" | "mismatch"> {
  const path = join(root, relativePath);
  assertWithinRoot(root, path, "The canonical scaffold path");
  const observation = await readInitFileObservation(path, relativePath, root);
  if (observation === undefined) return "missing";
  return sha256(observation.serialized) === expectedSha256
    ? "match"
    : "mismatch";
}

async function assertInitStage(
  root: string,
  state: InitState,
): Promise<InitFileObservation> {
  const stagePath = join(root, state.stageName);
  assertWithinRoot(root, stagePath, "The scaffold staging directory");
  const stageDetails = await lstat(stagePath).catch(() => undefined);
  if (
    stageDetails === undefined ||
    !stageDetails.isDirectory() ||
    stageDetails.isSymbolicLink()
  ) {
    throw initBusy(
      "The interrupted scaffold staging residue is missing or unsafe; all state was preserved.",
      state.stageName,
    );
  }
  for (const file of state.files) {
    const path = join(stagePath, file.relativePath);
    const observation = await readInitFileObservation(
      path,
      file.relativePath,
      root,
    );
    if (observation === undefined || sha256(observation.serialized) !== file.sha256) {
      throw initBusy(
        `The interrupted scaffold residue for "${file.relativePath}" is missing or changed; all state was preserved.`,
        file.relativePath,
      );
    }
  }
  const finalStage = await lstat(stagePath).catch(() => undefined);
  if (
    finalStage === undefined ||
    !finalStage.isDirectory() ||
    finalStage.isSymbolicLink() ||
    !sameInitFileIdentity(
      { dev: stageDetails.dev, ino: stageDetails.ino },
      { dev: finalStage.dev, ino: finalStage.ino },
    )
  ) {
    throw initBusy(
      "The interrupted scaffold staging directory changed during recovery; all state was preserved.",
      state.stageName,
    );
  }
  await assertInitStageTree(root, stagePath, state);
  return {
    identity: { dev: stageDetails.dev, ino: stageDetails.ino },
    serialized: state.stageName,
  };
}

async function assertInitStageTree(
  root: string,
  stagePath: string,
  state: InitState,
): Promise<void> {
  const expectedFiles = new Set(
    state.files.map((file) => file.relativePath),
  );
  const expectedDirectories = new Set(["agent", "agent/tools"]);
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativeEntry = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const candidate = join(directory, entry.name);
      await assertInitParentChain(root, candidate, relativeEntry);
      if (entry.isSymbolicLink()) {
        throw initBusy(
          `The interrupted scaffold staging descendant "${relativeEntry}" is a symlink; all state was preserved.`,
          relativeEntry,
        );
      }
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relativeEntry)) {
          throw initBusy(
            `The interrupted scaffold staging descendant "${relativeEntry}" is unexpected; all state was preserved.`,
            relativeEntry,
          );
        }
        await visit(candidate, relativeEntry);
        continue;
      }
      if (!entry.isFile() || !expectedFiles.has(relativeEntry)) {
        throw initBusy(
          `The interrupted scaffold staging descendant "${relativeEntry}" is an unsupported or unexpected type; all state was preserved.`,
          relativeEntry,
        );
      }
      const details = await lstat(candidate);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw initBusy(
          `The interrupted scaffold staging descendant "${relativeEntry}" is an unsupported type; all state was preserved.`,
          relativeEntry,
        );
      }
    }
  };
  await visit(stagePath, "");
}

async function assertInitAgentDirectories(
  root: string,
  state: InitState,
): Promise<void> {
  const agentPath = join(root, "agent");
  await assertInitParentChain(root, agentPath, "agent");
  const agentDetails = await lstat(agentPath).catch(() => undefined);
  if (agentDetails !== undefined) {
    if (!agentDetails.isDirectory() || agentDetails.isSymbolicLink()) {
      throw initBusy(
        'The "agent" scaffold path is a symlink or unsupported type; all bytes were preserved.',
        "agent",
      );
    }
    const entries = await readdir(agentPath);
    for (const entry of entries) {
      if (entry !== "agent.ts" && entry !== "instructions.md" && entry !== "tools") {
        throw initBusy(
          'The "agent" directory contains unrelated bytes; all bytes were preserved.',
          `agent/${entry}`,
        );
      }
    }
  }
  const toolsPath = join(agentPath, "tools");
  await assertInitParentChain(root, toolsPath, "agent/tools");
  const toolsDetails = await lstat(toolsPath).catch(() => undefined);
  if (toolsDetails !== undefined) {
    if (!toolsDetails.isDirectory() || toolsDetails.isSymbolicLink()) {
      throw initBusy(
        'The "agent/tools" scaffold path is a symlink or unsupported type; all bytes were preserved.',
        "agent/tools",
      );
    }
    const expected = new Set(
      state.files
        .filter((file) => file.relativePath.startsWith("agent/tools/"))
        .map((file) => file.relativePath.slice("agent/tools/".length)),
    );
    for (const entry of await readdir(toolsPath)) {
      if (!expected.has(entry)) {
        throw initBusy(
          'The "agent/tools" directory contains unrelated bytes; all bytes were preserved.',
          `agent/tools/${entry}`,
        );
      }
    }
  }
}

async function assertInitCanonicalScaffold(
  root: string,
  state: InitState,
): Promise<void> {
  for (const file of state.files) {
    const result = await readInitCanonicalState(
      root,
      file.relativePath,
      file.sha256,
    );
    if (result !== "match") {
      throw initBusy(
        `The canonical scaffold file "${file.relativePath}" is missing or changed; all bytes were preserved.`,
        file.relativePath,
      );
    }
  }
}

async function findInitRenamedCanonicalFile(
  root: string,
  state: InitState,
  expected: InitState["files"][number],
): Promise<string | undefined> {
  const destination = resolve(join(root, expected.relativePath));
  const stage = resolve(join(root, state.stageName));
  const visit = async (directory: string): Promise<string | undefined> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      const resolvedCandidate = resolve(candidate);
      if (
        resolvedCandidate === stage ||
        resolvedCandidate.startsWith(`${stage}/`) ||
        entry.name === INIT_LOCK_FILE ||
        entry.name === INIT_STATE_FILE ||
        isInitLegacyEntry(entry.name)
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const nested = await visit(candidate);
        if (nested !== undefined) return nested;
        continue;
      }
      if (resolvedCandidate === destination) continue;
      const observation = await readInitFileObservation(
        candidate,
        toPosixPath(relative(root, candidate)),
        root,
      );
      if (
        observation !== undefined &&
        sha256(observation.serialized) === expected.sha256
      ) {
        return candidate;
      }
    }
    return undefined;
  };
  return visit(root);
}

function ensureInitParentDirectories(
  root: string,
  path: string,
  source: string,
): void {
  const parent = dirname(path);
  const normalizedRoot = resolve(root);
  const parts = relative(normalizedRoot, parent).split(/[\\/]/u).filter(Boolean);
  assertWithinRoot(normalizedRoot, resolve(parent), "The scaffold directory");
  runInContainedDirectory(normalizedRoot, normalizedRoot, source, () => {
    let expectedDirectory = normalizedRoot;
    for (const part of parts) {
      expectedDirectory = join(expectedDirectory, part);
      let details: ReturnType<typeof lstatSync> | undefined;
      try {
        details = lstatSync(part);
      } catch (error: unknown) {
        const code = error as NodeJS.ErrnoException;
        if (code.code !== "ENOENT") throw error;
      }
      if (details === undefined) {
        try {
          mkdirSync(part, { mode: 0o700 });
        } catch (error: unknown) {
          const code = error as NodeJS.ErrnoException;
          if (code.code !== "EEXIST") throw error;
        }
        details = lstatSync(part);
      }
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw initBusy(
          "The scaffold directory is a symlink or unsupported type; all state was preserved.",
          source,
        );
      }
      process.chdir(part);
      const canonical = realpathSync(".");
      if (
        resolve(canonical) !== resolve(expectedDirectory) ||
        !isContainedPath(normalizedRoot, canonical)
      ) {
        throw initBusy(
          "The scaffold directory escapes the selected project root; all state was preserved.",
          source,
        );
      }
    }
  });
}

async function publishInitFileNoReplace(
  root: string,
  state: InitState,
  file: InitState["files"][number],
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<void> {
  const stagePath = join(root, state.stageName, file.relativePath);
  const destinationPath = join(root, file.relativePath);
  const source = await readInitFileObservation(
    stagePath,
    file.relativePath,
    root,
  );
  if (source === undefined || sha256(source.serialized) !== file.sha256) {
    throw initBusy(
      `The staged scaffold file "${file.relativePath}" is missing or changed; all bytes were preserved.`,
      file.relativePath,
    );
  }
  const before = await readInitCanonicalState(root, file.relativePath, file.sha256);
  if (before === "match") return;
  if (before === "mismatch") {
    throw initBusy(
      `The canonical scaffold file "${file.relativePath}" collides with changed bytes; all bytes were preserved.`,
      file.relativePath,
    );
  }

  await hook?.("before-init-destination-recheck", file.relativePath);
  const latestSource = await readInitFileObservation(
    stagePath,
    file.relativePath,
    root,
  );
  if (
    latestSource === undefined ||
    !sameInitFileObservation(latestSource, source) ||
    sha256(latestSource.serialized) !== file.sha256
  ) {
    throw initBusy(
      `The staged scaffold file "${file.relativePath}" changed before publication; all bytes were preserved.`,
      file.relativePath,
    );
  }
  const latestDestination = await readInitCanonicalState(
    root,
    file.relativePath,
    file.sha256,
  );
  if (latestDestination === "match") return;
  if (latestDestination === "mismatch") {
    throw initBusy(
      `The canonical scaffold file "${file.relativePath}" appeared or changed during publication; all bytes were preserved.`,
      file.relativePath,
    );
  }

  await assertInitParentChain(root, stagePath, file.relativePath, false);
  ensureInitParentDirectories(root, destinationPath, file.relativePath);
  await hook?.("before-init-link", file.relativePath);
  await assertInitParentChain(root, stagePath, file.relativePath, false);
  ensureInitParentDirectories(root, destinationPath, file.relativePath);
  const finalSource = await readInitFileObservation(
    stagePath,
    file.relativePath,
    root,
  );
  if (
    finalSource === undefined ||
    !sameInitFileObservation(finalSource, latestSource) ||
    sha256(finalSource.serialized) !== file.sha256
  ) {
    throw initBusy(
      `The staged scaffold file "${file.relativePath}" changed before no-replace publication; all bytes were preserved.`,
      file.relativePath,
    );
  }
  try {
    runInContainedDirectory(
      root,
      dirname(destinationPath),
      file.relativePath,
      () => {
        writeFileSync(basename(destinationPath), finalSource.serialized, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      },
    );
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "EEXIST") {
      const raced = await readInitCanonicalState(root, file.relativePath, file.sha256);
      if (raced === "match") return;
      throw initBusy(
        `The canonical scaffold file "${file.relativePath}" collided during publication; all bytes were preserved.`,
        file.relativePath,
      );
    }
    if (code.code === "EXDEV") {
      throw initBusy(
        `The canonical scaffold file "${file.relativePath}" is on an unsupported cross-device boundary; all bytes were preserved.`,
        file.relativePath,
      );
    }
    throw initBusy(
      `The canonical scaffold file "${file.relativePath}" could not be published without replacement; all bytes were preserved.`,
      file.relativePath,
    );
  }
  await hook?.("after-init-link", destinationPath);
  const published = await readInitCanonicalState(root, file.relativePath, file.sha256);
  if (published !== "match") {
    throw initBusy(
      `The canonical scaffold file "${file.relativePath}" changed after no-replace publication; all bytes were preserved.`,
      file.relativePath,
    );
  }
}

async function writeInitState(
  root: string,
  state: InitState,
): Promise<InitFileObservation> {
  const path = join(root, INIT_STATE_FILE);
  const serialized = `${JSON.stringify(state)}\n`;
  try {
    writeInitFileAtStableParent(root, path, serialized, INIT_STATE_FILE);
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "EEXIST") {
      throw initBusy(
        "The init recovery state already exists; all bytes were preserved.",
        INIT_STATE_FILE,
      );
    }
    throw initBusy(
      "The init recovery state could not be created safely; all bytes were preserved.",
      INIT_STATE_FILE,
    );
  }
  const observed = await readInitFileObservation(path, INIT_STATE_FILE, root);
  if (observed === undefined || observed.serialized !== serialized) {
    throw initBusy(
      "The init recovery state changed before it could be observed; all bytes were preserved.",
      INIT_STATE_FILE,
    );
  }
  return observed;
}

async function removeOwnedInitPath(
  root: string,
  path: string,
  expected: InitFileObservation,
  source: string,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<boolean> {
  await assertInitParentChain(root, path, source, false);
  const observed = await readInitFileObservation(path, source, root);
  if (observed === undefined) return false;
  if (!sameInitFileObservation(observed, expected)) return false;
  const latest = await readInitFileObservation(path, source, root);
  if (latest === undefined || !sameInitFileObservation(latest, expected)) return false;
  await hook?.("before-init-cleanup", source);
  const final = await readInitFileObservation(path, source, root);
  if (final === undefined || !sameInitFileObservation(final, expected)) {
    return false;
  }
  const quarantine = join(
    root,
    uniqueTemporaryName("eden-init-release-file"),
  );
  assertWithinRoot(root, quarantine, source);
  try {
    runInContainedDirectory(root, root, source, () => {
      renameSync(basename(path), basename(quarantine));
    });
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT" || code.code === "EEXIST") return false;
    return false;
  }
  const moved = await readInitFileObservation(quarantine, source, root);
  if (moved === undefined) {
    return false;
  }
  if (!sameInitFileObservation(moved, expected)) {
    return false;
  }
  const disposal = join(
    root,
    uniqueTemporaryName("eden-init-dispose-file"),
  );
  try {
    runInContainedDirectory(root, root, source, () => {
      renameSync(basename(quarantine), basename(disposal));
    });
  } catch {
    return false;
  }
  const disposed = await readInitFileObservation(disposal, source, root);
  if (disposed === undefined || !sameInitFileObservation(disposed, expected)) {
    return false;
  }
  await hook?.("after-init-cleanup-observation", source);
  const finalDisposed = await readInitFileObservation(disposal, source, root);
  if (
    finalDisposed === undefined ||
    !sameInitFileObservation(finalDisposed, expected)
  ) {
    return false;
  }
  try {
    runInContainedDirectory(root, root, source, () => {
      rmSync(basename(disposal), { force: false });
    });
  } catch {
    return false;
  }
  return (await lstat(disposal).catch(() => undefined)) === undefined;
}

async function removeOwnedInitDirectory(
  root: string,
  path: string,
  expected: InitFileObservation,
  state: InitState,
  source: string,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<boolean> {
  await assertInitParentChain(root, path, source, false);
  const observed = await lstat(path).catch(() => undefined);
  if (observed === undefined) return false;
  if (
    !observed.isDirectory() ||
    observed.isSymbolicLink() ||
    !sameInitFileIdentity(
      { dev: observed.dev, ino: observed.ino },
      expected.identity,
    )
  ) {
    return false;
  }
  await assertInitStageTree(root, path, state);
  await hook?.("before-init-cleanup", source);
  const latest = await lstat(path).catch(() => undefined);
  if (
    latest === undefined ||
    !latest.isDirectory() ||
    latest.isSymbolicLink() ||
    !sameInitFileIdentity(
      { dev: latest.dev, ino: latest.ino },
      expected.identity,
    )
  ) {
    return false;
  }
  await assertInitStageTree(root, path, state);
  const final = await lstat(path).catch(() => undefined);
  if (
    final === undefined ||
    !final.isDirectory() ||
    final.isSymbolicLink() ||
    !sameInitFileIdentity(
      { dev: final.dev, ino: final.ino },
      expected.identity,
    )
  ) {
    return false;
  }
  const quarantine = join(
    root,
    uniqueTemporaryName("eden-init-release-stage"),
  );
  assertWithinRoot(root, quarantine, source);
  try {
    runInContainedDirectory(root, root, source, () => {
      renameSync(basename(path), basename(quarantine));
    });
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== "ENOENT" && code.code !== "EEXIST") return false;
    return false;
  }
  const moved = await lstat(quarantine).catch(() => undefined);
  if (
    moved === undefined ||
    !moved.isDirectory() ||
    moved.isSymbolicLink() ||
    !sameInitFileIdentity(
      { dev: moved.dev, ino: moved.ino },
      expected.identity,
    )
  ) {
    return false;
  }
  await assertInitStageTree(root, quarantine, state);
  const disposal = join(
    root,
    uniqueTemporaryName("eden-init-dispose-stage"),
  );
  try {
    runInContainedDirectory(root, root, source, () => {
      renameSync(basename(quarantine), basename(disposal));
    });
  } catch {
    return false;
  }
  const disposed = await lstat(disposal).catch(() => undefined);
  if (
    disposed === undefined ||
    !disposed.isDirectory() ||
    disposed.isSymbolicLink() ||
    !sameInitFileIdentity(
      { dev: disposed.dev, ino: disposed.ino },
      expected.identity,
    )
  ) {
    return false;
  }
  await assertInitStageTree(root, disposal, state);
  await hook?.("after-init-cleanup-observation", source);
  const finalDisposed = await lstat(disposal).catch(() => undefined);
  if (
    finalDisposed === undefined ||
    !finalDisposed.isDirectory() ||
    finalDisposed.isSymbolicLink() ||
    !sameInitFileIdentity(
      { dev: finalDisposed.dev, ino: finalDisposed.ino },
      expected.identity,
    )
  ) {
    return false;
  }
  try {
    runInContainedDirectory(root, root, source, () => {
      rmSync(basename(disposal), { force: false, recursive: true });
    });
  } catch {
    return false;
  }
  return (await lstat(disposal).catch(() => undefined)) === undefined;
}

async function cleanupOwnedInitResidue(
  root: string,
  state: InitState | undefined,
  stateObservation: InitFileObservation | undefined,
  stageObservation: InitFileObservation | undefined,
  stateOwnedByInvocation: boolean,
  lock: InitLockHandle,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<void> {
  if (!lock.owned) return;
  await lock.release(hook);
  if (
    stateOwnedByInvocation &&
    state !== undefined &&
    stateObservation !== undefined
  ) {
    const stagePath = join(root, state.stageName);
    if (
      stageObservation === undefined ||
      !(await removeOwnedInitDirectory(
        root,
        stagePath,
        stageObservation,
        state,
        state.stageName,
        hook,
      ))
    ) {
      throw initBusy(
        "The completed init staging residue changed before owned cleanup; it was retained.",
        state.stageName,
      );
    }
    if (!(await removeOwnedInitPath(
      root,
      join(root, INIT_STATE_FILE),
      stateObservation,
      INIT_STATE_FILE,
      hook,
    ))) {
      throw initBusy(
        "The completed init recovery state changed before owned cleanup; it was retained.",
        INIT_STATE_FILE,
      );
    }
  }
  await hook?.("after-init-cleanup");
}

async function acquireInitPublicationLock(
  root: string,
): Promise<InitLockHandle> {
  const lockPath = join(root, INIT_LOCK_FILE);
  assertWithinRoot(root, lockPath, "The init lock");
  const preexistingState = await readInitState(root);
  const preexistingLock = await lstat(lockPath).catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init lock could not be inspected safely; all state was preserved.",
      INIT_LOCK_FILE,
    );
  });
  if (
    preexistingLock !== undefined &&
    (!preexistingLock.isFile() || preexistingLock.isSymbolicLink())
  ) {
    throw initBusy(
      "The Eden init lock is a symlink or unsupported file type; it was preserved.",
      INIT_LOCK_FILE,
    );
  }
  if (preexistingState !== undefined && preexistingLock === undefined) {
    throw initBusy(
      "The interrupted scaffold has no matching init lock; recovery is ambiguous and all state was preserved.",
      INIT_STATE_FILE,
    );
  }
  const startedAt = await readProcessStartTime(process.pid);
  if (startedAt === undefined) {
    throw cliError({
      code: "INIT_PROCESS_IDENTITY_UNAVAILABLE",
      message:
        "The Eden init process start identity could not be verified; scaffold publication is disabled.",
      source: INIT_LOCK_FILE,
    });
  }
  const state: InitPublicationLockState = {
    kind: "eden.init.lock",
    version: 1,
    pid: process.pid,
    startedAt,
    token: randomUUID(),
  };
  const serialized = `${JSON.stringify(state)}\n`;
  try {
    writeInitFileAtStableParent(root, lockPath, serialized, INIT_LOCK_FILE);
    const observed = await readInitFileObservation(
      lockPath,
      INIT_LOCK_FILE,
      root,
    );
    if (observed === undefined || observed.serialized !== serialized) {
      throw initBusy(
        "The init lock changed before ownership could be observed; it was preserved.",
        INIT_LOCK_FILE,
      );
    }
    activeInitLockTokens.add(state.token);
    return {
      path: lockPath,
      token: state.token,
      serialized,
      observation: observed,
      owned: true,
      release: async (hook) => {
        if (!(await removeOwnedInitPath(
          root,
          lockPath,
          observed,
          INIT_LOCK_FILE,
          hook,
        ))) {
          throw initBusy(
            "The init lock changed before owned cleanup; it was retained.",
            INIT_LOCK_FILE,
          );
        }
      },
    };
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== "EEXIST") throw error;
  }

  const existing = await readInitLock(lockPath, root);
  if (existing === undefined) {
    throw initBusy(
      "The init lock disappeared or could not be observed; all state was preserved.",
      INIT_LOCK_FILE,
    );
  }
  if (await initLockOwnerIsActive(existing.state)) {
    throw initBusy(
      "Another Eden init is publishing the scaffold; retry after it completes.",
      INIT_LOCK_FILE,
    );
  }
  if ((await readInitState(root)) === undefined) {
    throw initBusy(
      "The init lock is stale but has no matching recovery state; the lock was preserved.",
      INIT_LOCK_FILE,
    );
  }
  return {
    path: lockPath,
    token: existing.state.token,
    serialized: existing.serialized,
    observation: existing.observation,
    owned: false,
    release: async () => undefined,
  };
}

async function createInitStage(
  root: string,
  state: InitState,
): Promise<InitFileObservation> {
  const stagePath = join(root, state.stageName);
  assertWithinRoot(root, stagePath, "The scaffold staging directory");
  try {
    runInContainedDirectory(root, root, state.stageName, () => {
      mkdirSync(state.stageName, { mode: 0o700 });
    });
    ensureInitParentDirectories(
      root,
      join(stagePath, "agent/tools/greet.ts"),
      state.stageName,
    );
    for (const file of INIT_SCAFFOLD) {
      const path = join(stagePath, file.relativePath);
      writeInitFileAtStableParent(root, path, file.content, file.relativePath);
    }
  } catch (error: unknown) {
    throw initBusy(
      `The scaffold staging residue could not be created safely; all bytes were preserved: ${
        error instanceof Error ? error.message : "I/O failure"
      }`,
      state.stageName,
    );
  }
  const observed = await lstat(stagePath).catch(() => undefined);
  if (
    observed === undefined ||
    !observed.isDirectory() ||
    observed.isSymbolicLink()
  ) {
    throw initBusy(
      "The scaffold staging directory changed before publication; all bytes were preserved.",
      state.stageName,
    );
  }
  return {
    identity: { dev: observed.dev, ino: observed.ino },
    serialized: state.stageName,
  };
}

async function recoverInitScaffold(
  root: string,
  state: InitState,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<void> {
  await assertInitRootEntries(root, state);
  const stageObservation = await assertInitStage(root, state);
  await assertInitAgentDirectories(root, state);
  const statuses = await Promise.all(
    state.files.map((file) =>
      readInitCanonicalState(root, file.relativePath, file.sha256)
    ),
  );
  if (statuses.some((value) => value === "mismatch")) {
    const index = statuses.findIndex((value) => value === "mismatch");
    throw initBusy(
      `The canonical scaffold file "${state.files[index]?.relativePath ?? "unknown"}" contains changed bytes; all bytes were preserved.`,
      state.files[index]?.relativePath ?? INIT_STATE_FILE,
    );
  }
  if (statuses.every((value) => value === "match")) {
    await assertInitCanonicalScaffold(root, state);
    return;
  }

  for (const [index, file] of state.files.entries()) {
    if (statuses[index] === "match") continue;
    const renamed = await findInitRenamedCanonicalFile(root, state, file);
    if (renamed !== undefined) {
      throw initBusy(
        `The canonical scaffold file "${file.relativePath}" was renamed to "${toPosixPath(relative(root, renamed))}"; all bytes were preserved.`,
        toPosixPath(relative(root, renamed)),
      );
    }
    await hook?.("after-target-validation", file.relativePath);
    await hook?.("before-target-publish", file.relativePath);
    await publishInitFileNoReplace(root, state, file, hook);
    await hook?.("after-target-publish", file.relativePath);
  }
  void stageObservation;
  await assertInitCanonicalScaffold(root, state);
}

async function writeScaffoldUnlocked(
  root: string,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<{
  readonly state?: InitState;
  readonly stateObservation?: InitFileObservation;
  readonly stageObservation?: InitFileObservation;
  readonly stateOwnedByInvocation: boolean;
}> {
  const state = await readInitState(root);
  if (state !== undefined) {
    const stateObservation = await readInitFileObservation(
      join(root, INIT_STATE_FILE),
      INIT_STATE_FILE,
      root,
    );
    if (stateObservation === undefined) {
      throw initBusy(
        "The init recovery state disappeared before recovery; all bytes were preserved.",
        INIT_STATE_FILE,
      );
    }
    const stageObservation = await assertInitStage(root, state);
    await recoverInitScaffold(root, state, hook);
    await hook?.("before-complete");
    await assertInitCanonicalScaffold(root, state);
    return {
      state,
      stateObservation,
      stageObservation,
      stateOwnedByInvocation: false,
    };
  }

  await assertInitRootEntries(root, undefined);
  const entries = await readdir(root);
  if (entries.some((entry) => entry !== INIT_LOCK_FILE)) {
    throw cliError({
      code: "INIT_ROOT_NOT_EMPTY",
      message:
        "eden init requires an empty selected project root and will not overwrite existing files.",
    });
  }

  const stateToWrite: InitState = {
    kind: "eden.init.incomplete",
    version: 1,
    stageName: uniqueTemporaryName("eden-init"),
    files: initExpectedFiles(),
  };
  const stageObservation = await createInitStage(root, stateToWrite);
  await hook?.("after-stage-write");
  const stateObservation = await writeInitState(root, stateToWrite);
  await hook?.("after-state-write");
  await recoverInitScaffold(root, stateToWrite, hook);
  await hook?.("before-complete");
  await assertInitCanonicalScaffold(root, stateToWrite);
  return {
    state: stateToWrite,
    stateObservation,
    stageObservation,
    stateOwnedByInvocation: true,
  };
}

async function writeScaffold(
  root: string,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<void> {
  const lock = await acquireInitPublicationLock(root);
  let result: {
    readonly state?: InitState;
    readonly stateObservation?: InitFileObservation;
    readonly stageObservation?: InitFileObservation;
    readonly stateOwnedByInvocation: boolean;
  } | undefined;
  try {
    await hook?.("after-lock-acquire");
    result = await writeScaffoldUnlocked(root, hook);
  } finally {
    try {
      if (result !== undefined) {
        await cleanupOwnedInitResidue(
          root,
          result.state,
          result.stateObservation,
          result.stageObservation,
          result.stateOwnedByInvocation,
          lock,
          hook,
        );
      } else if (lock.owned) {
        try {
          if ((await readInitState(root)) === undefined) {
            await lock.release(hook);
          }
        } catch {
          // Retain a lock when recovery state exists or cannot be authenticated.
          // The next process must fail closed rather than pathname-delete it.
        }
      }
    } finally {
      if (lock.owned) activeInitLockTokens.delete(lock.token);
    }
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosixPath(value: string): string {
  return value.split("\\").join("/");
}

async function fingerprintProjectInputs(
  root: string,
  configuration: ProjectConfiguration,
  excludedRelativePaths: readonly string[] = [],
): Promise<ProjectInputFingerprint> {
  const exactExcludedRelativePaths = [...new Set(
    excludedRelativePaths
      .map((path) => toPosixPath(path))
      .map((path) => path.replace(/^\.\/|\/+$/gu, "")),
  )].sort((left, right) => left.localeCompare(right));
  const excluded = new Set(exactExcludedRelativePaths);
  const closure = await captureProjectImportClosure({ projectRoot: root });
  if (closure.diagnostics.length > 0) {
    const firstDiagnostic = closure.diagnostics[0];
    throw cliError({
      code: "PROJECT_INPUT_INVALID",
      message:
        firstDiagnostic?.message ??
        "The compiler could not capture the selected project's import closure.",
      ...(firstDiagnostic?.source === undefined
        ? {}
        : { source: firstDiagnostic.source }),
      diagnostics: closure.diagnostics,
    });
  }

  const filesByPath = new Map<string, ProjectInputFingerprint["files"][number]>();
  for (const source of closure.files) {
    const relativePath = toPosixPath(source.relativePath);
    if (excluded.has(relativePath)) continue;
    filesByPath.set(relativePath, {
      relativePath,
      sha256: source.sha256,
    });
  }
  for (const path of [
    configuration.packagePath,
    configuration.configPath,
  ]) {
    const relativePath = toPosixPath(relative(root, path));
    if (excluded.has(relativePath)) continue;
    const containedPath = await resolveContainedProjectPath(root, relativePath);
    const details = await lstat(containedPath).catch(() => undefined);
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
    const contents = await readFile(containedPath).catch(() => undefined);
    if (contents === undefined) {
      throw cliError({
        code: "PROJECT_INPUT_INVALID",
        message: `Selected project input "${relativePath}" could not be read.`,
        source: relativePath,
      });
    }
    filesByPath.set(relativePath, {
      relativePath,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  const files = [...filesByPath.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return {
    files,
    digest: sha256(JSON.stringify(files)),
    excludedRelativePaths: exactExcludedRelativePaths,
  };
}

async function assertProjectInputsUnchanged(
  root: string,
  configuration: ProjectConfiguration,
  expected: ProjectInputFingerprint,
  additionalExcludedRelativePaths: readonly string[] = [],
): Promise<void> {
  let current: ProjectInputFingerprint;
  try {
    current = await fingerprintProjectInputs(
      root,
      configuration,
      [
        ...expected.excludedRelativePaths,
        ...additionalExcludedRelativePaths,
      ],
    );
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

interface DeploymentSourceSnapshot {
  readonly fingerprint: ProjectInputFingerprint;
  readonly configurationContents: string;
}

interface DeploymentArtifactSnapshot {
  readonly root: string;
  readonly generation: EdenArtifactGeneration;
  readonly fileDigests: Readonly<
    Record<(typeof CANONICAL_ARTIFACT_NAMES)[number], string>
  >;
}

async function captureDeploymentSourceSnapshot(
  root: string,
  configuration: ProjectConfiguration,
): Promise<DeploymentSourceSnapshot> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const configurationContents = await readFile(
      configuration.configPath,
      "utf8",
    ).catch((error: unknown) => {
      throw cliError({
        code: "PROJECT_INPUT_INVALID",
        message:
          error instanceof Error
            ? `The selected Worker configuration could not be read: ${error.message}`
            : "The selected Worker configuration could not be read.",
        source: relative(root, configuration.configPath),
      });
    });
    const fingerprint = await fingerprintProjectInputs(root, configuration);
    const configurationRelativePath = toPosixPath(
      relative(root, configuration.configPath),
    );
    const fingerprintedConfiguration = fingerprint.files.find(
      (file) => file.relativePath === configurationRelativePath,
    );
    if (
      fingerprintedConfiguration !== undefined &&
      fingerprintedConfiguration.sha256 === sha256(configurationContents)
    ) {
      return {
        fingerprint,
        configurationContents,
      };
    }
  }
  throw cliError({
    code: "SOURCE_CHANGED_DURING_SNAPSHOT",
    message:
      "Selected source or configuration changed while the immutable deployment snapshot was being captured; no remote action was started.",
    source: relative(root, configuration.configPath),
  });
}

async function copyDeploymentGenerationSnapshot(
  root: string,
  generation: EdenArtifactGeneration,
): Promise<DeploymentArtifactSnapshot> {
  const snapshotRoot = join(
    root,
    uniqueTemporaryName("eden-deploy-snapshot"),
  );
  const snapshotGeneration = join(
    snapshotRoot,
    generation.artifacts.buildMetadata.generationId,
  );
  assertWithinRoot(
    root,
    snapshotRoot,
    "The immutable deployment snapshot",
  );
  await mkdir(snapshotRoot, { recursive: true });
  try {
    await cp(generation.directory, snapshotGeneration, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const validated = await readArtifactGenerationAt(
      root,
      snapshotGeneration,
    );
    if (stableJson(validated.artifacts) !== stableJson(generation.artifacts)) {
      throw cliError({
        code: "ARTIFACT_INCOHERENT",
        message:
          "The immutable deployment snapshot changed while it was being copied; no remote action was started.",
        source: generation.artifacts.buildMetadata.generationId,
      });
    }
    return {
      root: snapshotRoot,
      generation: {
        directory: snapshotGeneration,
        artifacts: validated.artifacts,
      },
      fileDigests: captureArtifactFileDigests(snapshotGeneration),
    };
  } catch (error: unknown) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

function captureArtifactFileDigests(
  generationDirectory: string,
): Readonly<
  Record<(typeof CANONICAL_ARTIFACT_NAMES)[number], string>
> {
  return Object.fromEntries(
    CANONICAL_ARTIFACT_NAMES.map((name) => [
      name,
      sha256(readFileSync(join(generationDirectory, name))),
    ]),
  ) as Record<(typeof CANONICAL_ARTIFACT_NAMES)[number], string>;
}

function assertArtifactSnapshotStable(
  generationDirectory: string,
  expected: Readonly<
    Record<(typeof CANONICAL_ARTIFACT_NAMES)[number], string>
  >,
): void {
  for (const name of CANONICAL_ARTIFACT_NAMES) {
    const observed = sha256(readFileSync(join(generationDirectory, name)));
    if (observed !== expected[name]) {
      throw cliError({
        code: "DEPLOYMENT_SNAPSHOT_CHANGED",
        message:
          "The immutable deployment artifact snapshot changed; no stale remote mutation may continue.",
        source: name,
      });
    }
  }
}

interface DeploymentLockHandle {
  readonly path: string;
  readonly state: DeploymentLockState;
  readonly serialized: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
  };
  readonly release: () => Promise<boolean>;
}

function parseDeploymentLockState(value: unknown): DeploymentLockState | undefined {
  const pid = isRecord(value) ? value.pid : undefined;
  const startedAt = isRecord(value) ? value.startedAt : undefined;
  const token = isRecord(value) ? value.token : undefined;
  if (
    !isRecord(value) ||
    value.kind !== "eden.deploy.lock" ||
    value.version !== 1 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof startedAt !== "string" ||
    startedAt.length === 0 ||
    typeof token !== "string" ||
    token.length === 0
  ) {
    return undefined;
  }
  return value as unknown as DeploymentLockState;
}

async function readDeploymentLockState(
  path: string,
): Promise<DeploymentLockState | undefined> {
  const contents = await readFile(path, "utf8").catch(() => undefined);
  if (contents === undefined) return undefined;
  try {
    return parseDeploymentLockState(JSON.parse(contents) as unknown);
  } catch {
    return undefined;
  }
}

async function assertDeploymentLockOwned(
  lock: DeploymentLockHandle,
): Promise<void> {
  const details = await lstat(lock.path).catch(() => undefined);
  const serialized = await readFile(lock.path, "utf8").catch(
    () => undefined,
  );
  const observed = await readDeploymentLockState(lock.path);
  if (
    details === undefined ||
    details.dev !== lock.identity.dev ||
    details.ino !== lock.identity.ino ||
    serialized !== lock.serialized ||
    observed?.pid !== lock.state.pid ||
    observed.startedAt !== lock.state.startedAt ||
    observed.token !== lock.state.token
  ) {
    throw cliError({
      code: "DEPLOY_OWNERSHIP_LOST",
      message:
        "The Eden deployment ownership lock changed or disappeared; no stale remote mutation was started.",
      source: DEPLOY_LOCK_FILE,
    });
  }
}

async function removeOwnedDeploymentLease(
  lease: DeploymentLeaseHandle,
): Promise<boolean> {
  const observedDetails = await lstat(lease.path).catch(
    (error: unknown) => {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (observedDetails === undefined) return false;
  if (
    observedDetails.dev !== lease.identity.dev ||
    observedDetails.ino !== lease.identity.ino
  ) {
    return false;
  }
  const observed = await readFile(lease.path, "utf8").catch(
    () => undefined,
  );
  if (observed !== lease.serialized) return false;
  const quarantine = join(
    dirname(lease.path),
    uniqueTemporaryName("eden-deploy-release-lease"),
  );
  await rename(lease.path, quarantine);
  const quarantinedDetails = await lstat(quarantine).catch(
    () => undefined,
  );
  const quarantined = await readFile(quarantine, "utf8").catch(
    () => undefined,
  );
  if (
    quarantinedDetails?.dev !== lease.identity.dev ||
    quarantinedDetails.ino !== lease.identity.ino ||
    quarantined !== lease.serialized
  ) {
    await link(quarantine, lease.path).catch(() => undefined);
    return false;
  }
  await rm(quarantine, { force: true });
  return true;
}

async function acquireDeploymentLease(
  root: string,
  lock: DeploymentLockHandle,
): Promise<DeploymentLeaseHandle> {
  const path = join(root, uniqueTemporaryName("eden-deploy-lease"));
  assertWithinRoot(root, path, "The deployment lease path");
  try {
    await link(lock.path, path);
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "EEXIST" || code.code === "ENOENT") {
      throw cliError({
        code: "DEPLOY_OWNERSHIP_LOST",
        message:
          "The Eden deployment ownership changed before its cross-process lease could be acquired.",
        source: DEPLOY_LOCK_FILE,
      });
    }
    throw error;
  }
  const details = await lstat(path);
  const serialized = await readFile(path, "utf8");
  if (
    details.dev !== lock.identity.dev ||
    details.ino !== lock.identity.ino ||
    serialized !== lock.serialized
  ) {
    await rm(path, { force: true }).catch(() => undefined);
    throw cliError({
      code: "DEPLOY_OWNERSHIP_LOST",
      message:
        "The Eden deployment ownership changed before its cross-process lease could be established.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  let state: DeploymentLockState | undefined;
  try {
    state = parseDeploymentLockState(JSON.parse(serialized) as unknown);
  } catch {
    state = undefined;
  }
  if (state === undefined) {
    await rm(path, { force: true }).catch(() => undefined);
    throw cliError({
      code: "DEPLOY_OWNERSHIP_LOST",
      message:
        "The Eden deployment ownership lease contained an invalid identity.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  const lease: DeploymentLeaseHandle = {
    path,
    lockPath: lock.path,
    state,
    serialized,
    identity: {
      dev: details.dev,
      ino: details.ino,
    },
    release: async () => removeOwnedDeploymentLease(lease),
  };
  return lease;
}

async function assertDeploymentLeaseOwned(
  lease: DeploymentLeaseHandle,
): Promise<void> {
  const details = await lstat(lease.path).catch(() => undefined);
  const lockDetails = await lstat(lease.lockPath).catch(() => undefined);
  const serialized = await readFile(lease.path, "utf8").catch(
    () => undefined,
  );
  const lockSerialized = await readFile(lease.lockPath, "utf8").catch(
    () => undefined,
  );
  let parsed: DeploymentLockState | undefined;
  try {
    parsed = parseDeploymentLockState(
      JSON.parse(serialized ?? "null") as unknown,
    );
  } catch {
    parsed = undefined;
  }
  if (
    details === undefined ||
    details.dev !== lease.identity.dev ||
    details.ino !== lease.identity.ino ||
    lockDetails === undefined ||
    lockDetails.dev !== lease.identity.dev ||
    lockDetails.ino !== lease.identity.ino ||
    serialized !== lease.serialized ||
    lockSerialized !== lease.serialized ||
    parsed === undefined
  ) {
    throw cliError({
      code: "DEPLOY_OWNERSHIP_LOST",
      message:
        "The Eden deployment cross-process lease changed or disappeared; no stale remote mutation was started.",
      source: DEPLOY_LOCK_FILE,
    });
  }
}

async function recoverDeploymentLeases(root: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!DEPLOY_LEASE_PATTERN.test(entry.name)) continue;
    if (!entry.isFile()) {
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lease record is not a regular file and cannot be recovered safely.",
        source: entry.name,
      });
    }
    const leasePath = join(root, entry.name);
    const state = await readDeploymentLockState(leasePath);
    if (state === undefined) {
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lease record is present but its ownership identity could not be verified.",
        source: entry.name,
      });
    }
    const observedStartedAt = await readProcessStartTime(state.pid);
    if (
      observedStartedAt === state.startedAt ||
      (observedStartedAt === undefined && isProcessAlive(state.pid))
    ) {
      return true;
    }
    await rm(leasePath, { force: true });
  }
  return false;
}

async function recoverDeploymentLeaseQuarantines(
  root: string,
): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!DEPLOY_LEASE_QUARANTINE_PATTERN.test(entry.name)) continue;
    if (!entry.isFile()) {
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lease release residue is not a regular file and cannot be recovered safely.",
        source: entry.name,
      });
    }
    const quarantinePath = join(root, entry.name);
    const observedDetails = await lstat(quarantinePath).catch(
      () => undefined,
    );
    const observedSerialized = await readFile(
      quarantinePath,
      "utf8",
    ).catch(() => undefined);
    const state = await readDeploymentLockState(quarantinePath);
    if (
      observedDetails === undefined ||
      !observedDetails.isFile() ||
      observedDetails.isSymbolicLink() ||
      observedSerialized === undefined ||
      state === undefined
    ) {
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lease release residue is present but its ownership identity could not be verified; the residue was retained.",
        source: entry.name,
      });
    }
    const observedStartedAt = await readProcessStartTime(state.pid);
    const alive = isProcessAlive(state.pid);
    if (
      observedStartedAt === state.startedAt ||
      (observedStartedAt === undefined && alive)
    ) {
      return true;
    }
    const disposalPath = join(
      root,
      uniqueTemporaryName("eden-deploy-release-lease"),
    );
    assertWithinRoot(
      root,
      disposalPath,
      "The deployment lease release recovery path",
    );
    try {
      await rename(quarantinePath, disposalPath);
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") continue;
      throw error;
    }
    const disposedDetails = await lstat(disposalPath).catch(
      () => undefined,
    );
    const disposedSerialized = await readFile(
      disposalPath,
      "utf8",
    ).catch(() => undefined);
    const disposedState = await readDeploymentLockState(disposalPath);
    if (
      disposedDetails === undefined ||
      !disposedDetails.isFile() ||
      disposedDetails.isSymbolicLink() ||
      disposedDetails.dev !== observedDetails.dev ||
      disposedDetails.ino !== observedDetails.ino ||
      disposedSerialized === undefined ||
      disposedSerialized !== observedSerialized ||
      disposedState?.pid !== state.pid ||
      disposedState.startedAt !== state.startedAt ||
      disposedState.token !== state.token
    ) {
      await link(disposalPath, quarantinePath).catch(() => undefined);
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lease release residue changed during identity-preserving recovery; both the residue and any replacement were retained.",
        source: entry.name,
      });
    }
    const finalDisposedDetails = await lstat(disposalPath).catch(
      () => undefined,
    );
    const finalDisposedSerialized = await readFile(
      disposalPath,
      "utf8",
    ).catch(() => undefined);
    if (
      finalDisposedDetails === undefined ||
      finalDisposedDetails.dev !== observedDetails.dev ||
      finalDisposedDetails.ino !== observedDetails.ino ||
      finalDisposedSerialized !== disposedSerialized
    ) {
      await link(disposalPath, quarantinePath).catch(() => undefined);
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lease release residue changed before cleanup; the residue was retained.",
        source: entry.name,
      });
    }
    await rm(disposalPath, { force: false });
  }
  return false;
}

async function removeOwnedDeploymentLock(
  root: string,
  lock: DeploymentLockHandle,
): Promise<boolean> {
  const quarantinePath = join(
    root,
    uniqueTemporaryName("eden-deploy-release-lock"),
  );
  assertWithinRoot(
    root,
    quarantinePath,
    "The deployment lock release quarantine path",
  );
  const currentDetails = await lstat(lock.path).catch(() => undefined);
  const currentSerialized = await readFile(lock.path, "utf8").catch(
    () => undefined,
  );
  if (
    currentDetails === undefined ||
    currentDetails.dev !== lock.identity.dev ||
    currentDetails.ino !== lock.identity.ino ||
    currentSerialized !== lock.serialized
  ) {
    return false;
  }
  try {
    await rename(lock.path, quarantinePath);
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return false;
    throw error;
  }
  const quarantinedDetails = await lstat(quarantinePath).catch(
    () => undefined,
  );
  const quarantinedSerialized = await readFile(
    quarantinePath,
    "utf8",
  ).catch(() => undefined);
  const observed = await readDeploymentLockState(quarantinePath);
  if (
    quarantinedDetails?.dev === lock.identity.dev &&
    quarantinedDetails.ino === lock.identity.ino &&
    quarantinedSerialized === lock.serialized &&
    observed?.pid === lock.state.pid &&
    observed.startedAt === lock.state.startedAt &&
    observed.token === lock.state.token
  ) {
    await rm(quarantinePath, { force: true }).catch(() => undefined);
    return true;
  }
  try {
    await link(quarantinePath, lock.path);
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== "EEXIST") throw error;
  }
  await rm(quarantinePath, { force: true }).catch(() => undefined);
  return false;
}

async function recoverDeploymentLockQuarantines(
  root: string,
): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!DEPLOY_LOCK_QUARANTINE_PATTERN.test(entry.name)) continue;
    if (!entry.isFile()) {
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lock recovery record is not a regular file and cannot be recovered safely.",
        source: entry.name,
      });
    }
    const quarantinePath = join(root, entry.name);
    const state = await readDeploymentLockState(quarantinePath);
    if (state === undefined) {
      throw cliError({
        code: "DEPLOY_BUSY",
        message:
          "A deployment lock recovery record is present but its ownership identity could not be verified.",
        source: entry.name,
      });
    }
    const observedStartedAt = await readProcessStartTime(state.pid);
    const alive = isProcessAlive(state.pid);
    if (observedStartedAt === state.startedAt || (observedStartedAt === undefined && alive)) {
      return true;
    }
    await rm(quarantinePath, { force: true }).catch(() => undefined);
  }
  return false;
}

async function acquireDeploymentLock(root: string): Promise<DeploymentLockHandle> {
  const startedAt = await readProcessStartTime(process.pid);
  if (startedAt === undefined) {
    throw cliError({
      code: "DEPLOY_PROCESS_IDENTITY_UNAVAILABLE",
      message:
        "The Eden deploy process start identity could not be verified; remote deployment is disabled.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  const path = await resolveContainedProjectPath(root, DEPLOY_LOCK_FILE);
  if (await recoverDeploymentLeases(root)) {
    throw cliError({
      code: "DEPLOY_BUSY",
      message:
        "Another Eden deploy owns the selected project's cross-process lease; wait for it to finish before retrying.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  if (await recoverDeploymentLeaseQuarantines(root)) {
    throw cliError({
      code: "DEPLOY_BUSY",
      message:
        "Another Eden deploy is releasing its cross-process lease; wait for it to finish before retrying.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  if (await recoverDeploymentLockQuarantines(root)) {
    throw cliError({
      code: "DEPLOY_BUSY",
      message:
        "Another Eden deploy is releasing its ownership record; wait for it to finish before retrying.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  const state: DeploymentLockState = {
    kind: "eden.deploy.lock",
    version: 1,
    pid: process.pid,
    startedAt,
    token: randomUUID(),
  };
  const serialized = `${JSON.stringify(state)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const identity = await lstat(path);
      const handle: DeploymentLockHandle = {
        path,
        state,
        serialized,
        identity: {
          dev: identity.dev,
          ino: identity.ino,
        },
        release: async () => removeOwnedDeploymentLock(root, handle),
      };
      return handle;
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "EEXIST") throw error;
      const existing = await readDeploymentLockState(path);
      if (existing === undefined) {
        throw cliError({
          code: "DEPLOY_BUSY",
          message:
            "Another Eden deploy owns the selected project, but its lock identity could not be verified.",
          source: DEPLOY_LOCK_FILE,
        });
      }
      const existingStartedAt = await readProcessStartTime(existing.pid);
      const existingAlive = isProcessAlive(existing.pid);
      if (
        existingStartedAt === existing.startedAt ||
        (existingStartedAt === undefined && existingAlive)
      ) {
        throw cliError({
          code: "DEPLOY_BUSY",
          message:
            "Another Eden deploy owns the selected project; wait for it to finish before retrying.",
          source: DEPLOY_LOCK_FILE,
        });
      }
      const staleQuarantine = join(
        root,
        uniqueTemporaryName("eden-deploy-stale-lock"),
      );
      assertWithinRoot(
        root,
        staleQuarantine,
        "The stale deployment lock quarantine path",
      );
      try {
        await rename(path, staleQuarantine);
      } catch (renameError: unknown) {
        const renameCode = renameError as NodeJS.ErrnoException;
        if (renameCode.code === "ENOENT") continue;
        throw renameError;
      }
      const quarantined = await readDeploymentLockState(staleQuarantine);
      if (
        quarantined?.pid === existing.pid &&
        quarantined.startedAt === existing.startedAt &&
        quarantined.token === existing.token
      ) {
        await rm(staleQuarantine, { force: true }).catch(() => undefined);
      } else {
        try {
          await link(staleQuarantine, path);
        } catch (linkError: unknown) {
          const linkCode = linkError as NodeJS.ErrnoException;
          if (linkCode.code !== "EEXIST") throw linkError;
        }
        await rm(staleQuarantine, { force: true }).catch(() => undefined);
      }
    }
  }
  throw cliError({
    code: "DEPLOY_BUSY",
    message:
      "The deployment lock changed while stale ownership was being recovered; retry without taking over the replacement invocation.",
    source: DEPLOY_LOCK_FILE,
  });
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function assertCanonicalGenerationMatches(
  projectRoot: string,
  generationDirectory: string,
  generationId: string,
  expected: EdenArtifactGeneration["artifacts"],
): Promise<void> {
  try {
    const canonical = await readArtifactGenerationAt(
      projectRoot,
      generationDirectory,
    );
    if (canonical.artifacts.buildMetadata.generationId !== generationId) {
      throw new Error("the canonical generation identity is invalid");
    }
    const { buildMetadata, ...canonicalWithoutMetadata } =
      canonical.artifacts;
    const {
      buildMetadata: expectedBuildMetadata,
      ...expectedWithoutMetadata
    } =
      expected;
    if (
      stableJson(canonicalWithoutMetadata) !==
      stableJson(expectedWithoutMetadata)
    ) {
      throw new Error(
        "the canonical generation does not match the validated candidate",
      );
    }
    const existingMetadata = Object.fromEntries(
      Object.entries(buildMetadata).filter(([key]) => key !== "createdAt"),
    );
    const expectedMetadata = Object.fromEntries(
      Object.entries(expectedBuildMetadata).filter(
        ([key]) => key !== "createdAt",
      ),
    );
    if (stableJson(existingMetadata) !== stableJson(expectedMetadata)) {
      throw new Error("the canonical build metadata is incoherent");
    }
  } catch (error: unknown) {
    throw cliError({
      code: "ARTIFACT_INCOHERENT",
      message:
        error instanceof Error
          ? `The canonical generation "${generationId}" is incomplete or incoherent: ${error.message}.`
          : `The canonical generation "${generationId}" is incomplete or incoherent.`,
      source: generationId,
    });
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
  await assertCanonicalArtifactTree(root, outputDirectory);

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

async function assertCanonicalArtifactTree(
  root: string,
  outputDirectory: string,
): Promise<void> {
  const outputRoot = await realpath(outputDirectory).catch(() => undefined);
  if (outputRoot === undefined) {
    throw cliError({
      code: "ARTIFACT_OUTPUT_INVALID",
      message: "The .eden artifact directory could not be resolved safely.",
      source: ".eden",
    });
  }
  const generationsDirectory = join(outputRoot, "generations");
  const generationsRoot = await realpath(generationsDirectory).catch(
    () => undefined,
  );
  const currentPath = join(outputRoot, "CURRENT");
  const currentDetails = await lstat(currentPath).catch(() => undefined);
  let currentGeneration: string | undefined;
  if (currentDetails?.isSymbolicLink() === true) {
    const currentTarget = await readlink(currentPath).catch(() => undefined);
    if (
      currentTarget === undefined ||
      !/^generations\/[^/]+$/u.test(currentTarget)
    ) {
      throw cliError({
        code: "ARTIFACT_OUTPUT_INVALID",
        message:
          "The .eden CURRENT pointer must target one contained generation.",
        source: ".eden/CURRENT",
      });
    }
    const resolvedCurrent = await realpath(currentPath).catch(() => undefined);
    const resolvedCurrentDetails =
      resolvedCurrent === undefined
        ? undefined
        : await lstat(resolvedCurrent).catch(() => undefined);
    if (
      generationsRoot === undefined ||
      resolvedCurrent === undefined ||
      resolvedCurrentDetails === undefined ||
      !resolvedCurrentDetails.isDirectory() ||
      resolvedCurrentDetails.isSymbolicLink() ||
      !isContainedPath(generationsRoot, resolvedCurrent)
    ) {
      throw cliError({
        code: "ARTIFACT_OUTPUT_INVALID",
        message:
          "The .eden CURRENT pointer must resolve to a real contained generation directory.",
        source: ".eden/CURRENT",
      });
    }
    currentGeneration = resolvedCurrent;
  }

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(directory, entry.name);
      const childRelative = toPosixPath(relative(outputRoot, child));
      if (entry.isSymbolicLink()) {
        const isCurrent = childRelative === "CURRENT";
        const isCompatibilityAlias =
          CANONICAL_ARTIFACT_NAMES.includes(
            childRelative as typeof CANONICAL_ARTIFACT_NAMES[number],
          );
        if (!isCurrent && !isCompatibilityAlias) {
          throw cliError({
            code: "ARTIFACT_OUTPUT_INVALID",
            message:
              `Generated descendant "${childRelative}" must not be a symbolic link.`,
            source: childRelative,
          });
        }
        if (isCompatibilityAlias) {
          if (currentGeneration === undefined) continue;
          const expectedTarget = `CURRENT/${childRelative}`;
          const target = await readlink(child).catch(() => undefined);
          const resolved = await realpath(child).catch(() => undefined);
          const expected = currentGeneration === undefined
            ? undefined
            : join(currentGeneration, childRelative);
          const expectedDetails =
            expected === undefined
              ? undefined
              : await lstat(expected).catch(() => undefined);
          if (
            target !== expectedTarget ||
            resolved === undefined ||
            expected === undefined ||
            resolved !== expected ||
            expectedDetails === undefined ||
            !expectedDetails.isFile() ||
            expectedDetails.isSymbolicLink()
          ) {
            throw cliError({
              code: "ARTIFACT_OUTPUT_INVALID",
              message:
                `Generated compatibility alias "${childRelative}" must target the exact regular file under CURRENT.`,
              source: childRelative,
            });
          }
        }
        continue;
      }
      const resolved = await realpath(child).catch(() => undefined);
      if (
        resolved === undefined ||
        !isContainedPath(root, resolved) ||
        !isContainedPath(outputRoot, resolved)
      ) {
        throw cliError({
          code: "ARTIFACT_OUTPUT_INVALID",
          message:
            `Generated descendant "${childRelative}" escapes the selected artifact root.`,
          source: childRelative,
        });
      }
      const details = await lstat(child);
      if (details.isDirectory()) {
        await visit(child);
      }
    }
  };
  await visit(outputRoot);
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
): Promise<DeploymentExecutable> {
  return resolveDeploymentExecutableSync(cwd);
}

function resolveDeploymentExecutableSync(
  cwd: string,
): DeploymentExecutable {
  const packageDirectory = dirname(fileURLToPath(import.meta.url));
  const packageDirectoryCandidates = [
    join(packageDirectory, "../node_modules/wrangler"),
    join(packageDirectory, "../../..", "node_modules/wrangler"),
    join(cwd, "node_modules/wrangler"),
    join(process.cwd(), "node_modules/wrangler"),
  ];
  for (const packageDirectoryCandidate of packageDirectoryCandidates) {
    const directEntry = join(
      packageDirectoryCandidate,
      "wrangler-dist/cli.js",
    );
    if (existsSync(directEntry)) {
      return {
        command: process.execPath,
        commandArgs: [directEntry],
      };
    }
  }

  // Keep the legacy executable lookup as a last-resort diagnostic path. The
  // workspace install always has the direct deployment entrypoint above, while
  // an arbitrary shell shim cannot preserve the ownership marker required for
  // safe child cleanup.
  const executableName = process.platform === "win32"
    ? "wrangler.cmd"
    : "wrangler";
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
    if (existsSync(candidate)) {
      throw cliError({
        code: "WRANGLER_IDENTITY_UNAVAILABLE",
        message:
          "The installed deployment executable is only available through a shell shim; Eden refuses to start an unowned validation child.",
        source: candidate,
      });
    }
  }
  throw cliError({
    code: "WRANGLER_UNAVAILABLE",
    message:
      "The direct deployment CLI entrypoint could not be resolved in the selected project installation.",
  });
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

type RuntimeGeneration = EdenCliRuntimeGeneration;

const DEV_STATE_FILE = ".eden-dev-state.json";

interface DevState {
  readonly pid: number;
  readonly version?: 1 | 2; readonly marker?: string; readonly pgid?: number; readonly lstart?: string; readonly startedAt?: string;
  readonly token?: string;
  readonly workerHost: typeof EDEN_LOCAL_HOST;
  readonly workerPort: typeof EDEN_LOCAL_PORT;
  readonly inspectorHost: typeof EDEN_LOCAL_INSPECTOR_HOST;
  readonly inspectorPort: typeof EDEN_LOCAL_INSPECTOR_PORT;
}

type DevStateV2 = DevState & { readonly version: 2; readonly marker: string; readonly pgid: number; readonly lstart: string; readonly token: string; };
type DevStateOwner = EdenCliProcessIdentity & { readonly token: string; readonly version: 2; };

type ProcessObservation = { readonly pid: number; readonly pgid: number; readonly lstart: string; readonly command: string; };

const PROCESS_IDENTITY_PREFIX = "eden-dev-process-";

function scrubChildEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
  };
  delete childEnv.EDEN_BEARER_SECRET;
  return childEnv;
}

function processCommandContainsMarker(
  command: string,
  marker: string,
): boolean {
  return command.includes(marker);
}

function readProcessCommand(
  pid: number,
  format = "command=",
): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolveResult) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", format],
      {
        encoding: "utf8",
        env: scrubChildEnvironment(),
      },
      (error, stdout) => {
        if (error !== null) {
          resolveResult(undefined);
          return;
        }
        const command = String(stdout).trim();
        resolveResult(command.length === 0 ? undefined : command);
      },
    );
  });
}

function readProcessObservation(
  pid: number,
): Promise<ProcessObservation | undefined> {
  return readProcessCommand(pid, "pid=,pgid=,lstart=,command=").then((output) => {
    const m = output === undefined ? null :
      /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*?)\s*$/u.exec(output);
    if (m === null) return;
    const pid = Number(m[1]), pgid = Number(m[2]), lstart = m[3] ?? "", command = m[4] ?? "";
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(pgid) && pgid > 0 && lstart.length > 0 && command.length > 0
      ? { pid, pgid, lstart, command } : undefined;
  });
}

function readProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolveResult) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        env: scrubChildEnvironment(),
      },
      (error, stdout) => {
        if (error !== null) {
          resolveResult(undefined);
          return;
        }
        const startedAt = String(stdout).trim();
        resolveResult(startedAt.length === 0 ? undefined : startedAt);
      },
    );
  });
}

async function verifyProcessIdentity(
  pid: number,
  expectedIdentity: EdenCliProcessIdentity,
): Promise<boolean> {
  if (pid <= 0 || expectedIdentity.pgid <= 0 || expectedIdentity.marker.length === 0 ||
    expectedIdentity.lstart.length === 0 || process.platform === "win32") return false;
  const observed = await readProcessObservation(pid);
  return observed !== undefined &&
    observed.pid === pid &&
    observed.pgid === expectedIdentity.pgid &&
    observed.lstart === expectedIdentity.lstart &&
    processCommandContainsMarker(observed.command, expectedIdentity.marker);
}

function isProcessIdentity(value: unknown): value is EdenCliProcessIdentity {
  return isRecord(value) && typeof value.marker === "string" && value.marker.length > 0 && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.pgid === "number" && Number.isSafeInteger(value.pgid) && value.pgid > 0 && typeof value.lstart === "string" && value.lstart.length > 0;
}

function identityFromDevState(state: DevStateV2): EdenCliProcessIdentity {
  return { marker: state.marker, pid: state.pid, pgid: state.pgid, lstart: state.lstart };
}
function devStateOwner(identity: EdenCliProcessIdentity, token: string): DevStateOwner {
  return { ...identity, token, version: 2 };
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
  identity: unknown,
): Promise<{ readonly path: string; readonly token: string }> {
  if (!isProcessIdentity(identity)) {
    throw cliError({
      code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
      message:
        "The Eden dev process identity could not be verified; cleanup is disabled.",
      source: DEV_STATE_FILE,
    });
  }
  const statePath = await resolveContainedProjectPath(root, DEV_STATE_FILE);
  const existing = await lstat(statePath).catch(() => undefined);
  if (existing !== undefined) {
    const previous = await readDevState(root);
    if (previous === undefined || previous.version !== 2) throw cliError({ code: "DEV_STATE_INVALID", message: "The existing Eden dev process state is legacy and cannot be replaced safely.", source: DEV_STATE_FILE });
    const previousIdentity = identityFromDevState(previous as DevStateV2);
    const alive = await verifyProcessIdentity(previousIdentity.pid, previousIdentity);
    if (alive) throw cliError({ code: "DEV_STATE_EXISTS", message: "An Eden dev process state file already exists; stop the owned process before starting another dev invocation.", source: DEV_STATE_FILE });
    const removed = await removeOwnedDevState(root, previous as DevStateOwner);
    if (!removed) throw cliError({ code: "DEV_STATE_EXISTS", message: "The Eden dev process state changed while it was being replaced; retry without taking over the replacement process.", source: DEV_STATE_FILE });
  }
  const token = randomUUID();
  const state: DevStateV2 = {
    version: 2, marker: identity.marker, pid: identity.pid, pgid: identity.pgid, lstart: identity.lstart, token,
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
  return { path: statePath, token };
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
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version", "marker", "pid",
          "pgid", "lstart", "startedAt",
          "token",
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
  const version = state.version ?? 1;
  const identity = isProcessIdentity({ marker: state.marker, pid: state.pid, pgid: state.pgid, lstart: state.lstart });
  const legacy = version === 1 && typeof state.startedAt === "string" && state.startedAt.length > 0 &&
    (state.token === undefined || (typeof state.token === "string" && state.token.length > 0));
  if (
    !Number.isSafeInteger(state.pid) ||
    (state.pid as number) <= 0 ||
    (version !== 1 && version !== 2) ||
    !(version === 1 ? legacy : identity && typeof state.token === "string" && state.token.length > 0) ||
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

async function removeOwnedDevState(
  root: string,
  owner: DevStateOwner,
): Promise<boolean> {
  if (owner.token === undefined || owner.token.length === 0) return false;
  const statePath = await resolveContainedProjectPath(root, DEV_STATE_FILE);
  const quarantinePath = join(
    root,
    uniqueTemporaryName("eden-dev-state-remove"),
  );
  assertWithinRoot(root, quarantinePath, "The Eden dev state removal quarantine path");
  try {
    await rename(statePath, quarantinePath);
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return false;
    throw error;
  }
  const contents = await readFile(quarantinePath, "utf8").catch(
    () => undefined,
  );
  let matches = false;
  if (contents !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch {
      value = undefined;
    }
    matches = isRecord(value) && value.version === 2 && value.pid === owner.pid && value.marker === owner.marker &&
      value.pgid === owner.pgid && value.lstart === owner.lstart && value.token === owner.token;
  }
  let restoreError: unknown;
  if (matches) {
    await rm(quarantinePath, { force: true }).catch(() => undefined);
  } else {
    try {
      await link(quarantinePath, statePath);
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "EEXIST") restoreError = error;
    }
    await rm(quarantinePath, { force: true }).catch(() => undefined);
  }
  if (restoreError !== undefined) {
    throw restoreError;
  }
  return matches;
}

async function signalOwnedProcess(
  pid: number,
  expectedIdentity: EdenCliProcessIdentity,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (!(await verifyProcessIdentity(pid, expectedIdentity))) return false;
  try {
    if (process.platform !== "win32") {
      process.kill(-expectedIdentity.pgid, signal);
    } else {
      process.kill(pid, signal);
    }
    return true;
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(
  pid: number,
  expectedIdentity: EdenCliProcessIdentity,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (!(await verifyProcessIdentity(pid, expectedIdentity))) return !isProcessAlive(pid);
    await new Promise((resolveResult) => setTimeout(resolveResult, 50));
  }
  return !(await verifyProcessIdentity(pid, expectedIdentity)) && !isProcessAlive(pid);
}

async function waitForOwnedProcessExit(
  process: EdenCliProcess,
  timeoutMs = OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
  cleanupSignal?: AbortSignal,
): Promise<boolean> {
  if (cleanupSignal?.aborted === true) return false;
  const exited = process.exited.then(
    () => true,
    () => false,
  );
  let timeout: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const stopped = cleanupSignal === undefined
    ? undefined
    : new Promise<boolean>((resolveResult) => {
        abort = () => resolveResult(false);
        cleanupSignal.addEventListener("abort", abort, { once: true });
      });
  try {
    const result = await Promise.race([
      exited,
      new Promise<boolean>((resolveResult) => {
        timeout = setTimeout(() => resolveResult(false), timeoutMs);
      }),
      ...(stopped === undefined ? [] : [stopped]),
    ]);
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort !== undefined && cleanupSignal !== undefined) {
      cleanupSignal.removeEventListener("abort", abort);
    }
  }
}

async function resolveOwnedProcessIdentity(
  process: EdenCliProcess,
  timeoutMs = OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const identity = await Promise.race([
      Promise.resolve(process.startIdentity),
      new Promise<undefined>((resolveResult) => {
        setTimeout(() => resolveResult(undefined), timeoutMs);
      }),
    ]);
    return typeof identity === "string" && identity.length > 0
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

async function terminateRuntimeChild(
  process: EdenCliProcess,
  signal: NodeJS.Signals,
): Promise<boolean> {
  const identity = await resolveOwnedProcessIdentity(
    process,
    Math.min(OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS, 100),
  );
  if (identity === undefined) return false;
  // A stop aborts readiness polling, but it must not abort child termination.
  // The child remains owned until its exit promise proves a terminal state.
  const termination: boolean = await Promise.race<boolean>([
    Promise.resolve()
      .then(() => process.terminate(signal).then(() => true))
      .then((value) => value, () => false),
    new Promise<boolean>((resolveResult) => {
      setTimeout(() => resolveResult(false), OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS);
    }),
  ]);
  if (termination) {
    const exitedAfterSignal = await waitForOwnedProcessExit(
      process,
      OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
    );
    if (exitedAfterSignal) return true;
  }
  await Promise.race([
    Promise.resolve()
      .then(() => process.terminate("SIGKILL"))
      .then(() => undefined, () => undefined),
    new Promise<void>((resolveResult) => {
      setTimeout(resolveResult, OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS);
    }),
  ]);
  return await waitForOwnedProcessExit(
    process,
    OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
  );
}

async function waitForSettlements(
  settlements: Iterable<Promise<unknown>>,
  timeoutMs = OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
): Promise<void> {
  const pending = [...settlements];
  if (pending.length === 0) return;
  await Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((resolveResult) => {
      setTimeout(resolveResult, timeoutMs);
    }),
  ]);
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
  let removeState = false;
  try {
    if (state.token === undefined) {
      return 0;
    }
    if (state.version !== 2) {
      return 0;
    }
    const currentState = state as DevStateV2;
    const identity = identityFromDevState(currentState);
    if (!(await verifyProcessIdentity(identity.pid, identity))) return 0;
    const termSent = await signalOwnedProcess(
      identity.pid,
      identity,
      "SIGTERM",
    );
    if (!termSent) return 0;
    const exitedAfterTerm = await waitForProcessExit(
      identity.pid,
      identity,
    );
    if (!exitedAfterTerm) {
      const killSent = await signalOwnedProcess(
        identity.pid,
        identity,
        "SIGKILL",
      );
      if (!killSent) return 0;
      if (killSent && !(await waitForProcessExit(identity.pid, identity))) {
        throw cliError({
          code: "DEV_STOP_TIMEOUT",
          message: "The owned Eden dev process did not exit after termination.",
        });
      }
    }
    await waitForApprovedPortsAvailable();
    removeState = true;
    return 0;
  } finally {
    if (removeState) {
      await removeOwnedDevState(root, state as DevStateOwner);
    }
  }
}

async function createRuntimeFiles(
  root: string,
  configPath: string,
  generation: EdenArtifactGeneration,
  executionMode: "local" | "remote" = "local",
  targetEntryPath?: string,
  configurationContents?: string,
): Promise<RuntimeFiles> {
  const runtimeGeneration = readRuntimeGeneration(generation);
  const runtimeEntrypoint = await resolveRuntimeWorkerEntrypoint();
  const entryPath = join(
    root,
    `${uniqueTemporaryName("eden-dev-worker")}.mjs`,
  );
  const entryReferencePath = targetEntryPath ?? entryPath;
  assertWithinRoot(root, entryPath, "The local runtime entrypoint");
  assertWithinRoot(root, entryReferencePath, "The local runtime entrypoint");
  const bundlePath = join(generation.directory, "agent-bundle.mjs");
  const runtimeImport = relative(dirname(entryReferencePath), runtimeEntrypoint)
    .split("\\")
    .join("/");
  const bundleImport = relative(dirname(entryReferencePath), bundlePath)
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
    const source = configurationContents ?? await readFile(configPath, "utf8");
    const relativeMain = relative(root, entryReferencePath)
      .split("\\")
      .join("/");
    const extension = extname(configPath).toLowerCase();
    const contents = extension === ".toml"
      ? replaceTomlMain(source, relativeMain)
      : replaceJsonMain(source, relativeMain);
    const marker = extension === ".toml"
      ? `# Eden runtime generation: ${runtimeGeneration.generationId}`
      : `// Eden runtime generation: ${runtimeGeneration.generationId}`;
    const configContents = extension === ".json"
      ? contents
      : `${marker}\n${contents}`;
    const temporaryConfig = join(
      root,
      `${uniqueTemporaryName("eden-dev-config")}${extension || ".jsonc"}`,
    );
    assertWithinRoot(root, temporaryConfig, "The local runtime configuration");
    await writeFile(temporaryConfig, configContents, {
      encoding: "utf8",
      flag: "wx",
    });
    return { configPath: temporaryConfig, entryPath };
  } catch (error: unknown) {
    await rm(entryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface RuntimeFileContents {
  readonly config: string;
  readonly entry: string;
}

async function readRuntimeFileContents(
  files: RuntimeFiles,
): Promise<RuntimeFileContents> {
  const [config, entry] = await Promise.all([
    readFile(files.configPath, "utf8"),
    readFile(files.entryPath, "utf8"),
  ]);
  return { config, entry };
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

function createDefaultProcessHandle(
  child: ChildProcess,
  processMarker: string,
  readiness?: readonly {
    readonly host: string;
    readonly port: number;
  }[],
): EdenCliProcess {
  const pid = child.pid ?? -1;
  const exited = new Promise<EdenCliProcessExit>((resolveExit) => {
    child.once("error", () => {
      resolveExit({ exitCode: 1, signal: null });
    });
    child.once("exit", (exitCode, signal) => {
      resolveExit({ exitCode, signal });
    });
  });
  const ready = readiness === undefined
    ? undefined
    : Promise.all(
        readiness.map((port) =>
          waitForTcpPort(port.host, port.port, RUNTIME_PROCESS_READY_TIMEOUT_MS)
        ),
      ).then(() => undefined);
  const identity = Promise.race([
    observeProcessIdentity(pid, processMarker),
    exited.then(() => undefined),
  ]);
  const signalOwnedChild = async (signal: NodeJS.Signals): Promise<boolean> => {
    const expected = await Promise.race([
      identity,
      new Promise<undefined>((resolveResult) => setTimeout(resolveResult, OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS)),
    ]);
    if (
      !isProcessIdentity(expected) ||
      !(await verifyProcessIdentity(expected.pid, expected))
    ) {
      return false;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-expected.pgid, signal);
      } else {
        child.kill(signal);
      }
      return true;
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ESRCH") return false;
      throw error;
    }
  };
  return {
    pid,
    identity,
    startIdentity: identity.then((value) => value?.marker),
    exited,
    ...(ready === undefined ? {} : { ready }),
    async terminate(signal = "SIGTERM") {
      if (pid <= 0) return;
      await signalOwnedChild(signal);
    },
  };
}

function runDefaultDryRun(
  request: EdenCliDryRunRequest,
): EdenCliDryRunHandle {
  const processMarker = `${PROCESS_IDENTITY_PREFIX}dry-run-${randomUUID()}`;
  const executable = resolveDeploymentExecutableSync(request.cwd);
  const child = spawnChild(
    executable.command,
    [...executable.commandArgs, ...request.args],
    {
      argv0: processMarker,
      cwd: request.cwd,
      env: scrubChildEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const processHandle = createDefaultProcessHandle(child, processMarker);
  const result = processHandle.exited.then((exit) => ({
    exitCode: exit.exitCode ?? 1,
    stdout,
    stderr,
  }));
  return {
    process: processHandle,
    result,
  };
}

function runDefaultRemoteCommand(
  request: EdenCliRemoteCommandRequest,
): EdenCliRemoteCommandHandle {
  const processMarker = `${PROCESS_IDENTITY_PREFIX}remote-${randomUUID()}`;
  const executable = resolveDeploymentExecutableSync(request.cwd);
  const child = spawnChild(
    executable.command,
    [...executable.commandArgs, ...request.args],
    {
      argv0: processMarker,
      cwd: request.cwd,
      env: scrubChildEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
  const processHandle = createDefaultProcessHandle(child, processMarker);
  const result = processHandle.exited.then((exit) => ({
    exitCode: exit.exitCode ?? 1,
    stdout,
    stderr,
  }));
  return {
    process: processHandle,
    result,
  };
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

interface OwnedProcessRegistry {
  readonly isStopping: () => boolean;
  readonly isQuiescent: () => boolean;
  readonly stopped: Promise<NodeJS.Signals>;
  readonly reserve: () => {
    readonly release: () => void;
    readonly start: <T>(runner: () => T, allowWhenStopping?: boolean) => T;
  };
  readonly registerReservationProcess: (
    reservation: {
      readonly release: () => void;
    },
    process: EdenCliProcess,
  ) => void;
  readonly register: (process: EdenCliProcess) => void;
  readonly terminate: (process: EdenCliProcess) => Promise<boolean>;
  readonly unregister: (process: EdenCliProcess) => void;
  readonly trackLateResult: (settlement: PromiseLike<void>) => void;
  readonly deferCleanup: (
    cleanup: () => void | Promise<void>,
  ) => Promise<void>;
  readonly waitForQuiescence: () => Promise<boolean>;
  readonly cleanup: (
    signal: NodeJS.Signals,
    timeoutMs?: number,
  ) => Promise<boolean>;
}

async function awaitBuildPublicationHook(
  hook: EdenCliRunOptions["buildPublicationHook"],
  boundary: EdenBuildPublicationBoundary,
  ownedProcesses?: OwnedProcessRegistry,
): Promise<boolean> {
  if (hook === undefined) return true;
  if (ownedProcesses?.isStopping() === true) return false;
  const continuation = Promise.resolve().then(() => hook(boundary));
  ownedProcesses?.trackLateResult(continuation);
  if (ownedProcesses === undefined) {
    await continuation;
    return true;
  }
  return await Promise.race([
    continuation.then(() => true),
    ownedProcesses.stopped.then(() => false),
  ]);
}

async function awaitBoundedGenerationWork<T>(
  work: PromiseLike<T>,
  ownedProcesses: OwnedProcessRegistry | undefined,
  timeoutMs = GENERATION_WORK_TIMEOUT_MS,
): Promise<T | undefined> {
  const workPromise = Promise.resolve(work);
  ownedProcesses?.trackLateResult(workPromise.then(() => undefined));
  if (ownedProcesses === undefined) {
    return await workPromise;
  }
  const timeout = Symbol("eden.generation.timeout");
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      workPromise,
      ownedProcesses.stopped.then(() => undefined),
      new Promise<typeof timeout>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timeout), timeoutMs);
      }),
    ]);
    if (result === timeout) {
      throw cliError({
        code: "GENERATION_WORK_TIMEOUT",
        message:
          `Eden generation work did not settle within ${timeoutMs}ms; the operation failed closed.`,
      });
    }
    return result;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

const OWNED_PROCESS_TERMINATION_TIMEOUT_MS = 2_000;
const OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS = 750;
const OWNED_PROCESS_CLEANUP_TIMEOUT_MS =
  OWNED_PROCESS_TERMINATION_TIMEOUT_MS * 2 +
  OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS * 2 +
  500;
/**
 * The compiler path includes discovery, authored-definition loading, bundling,
 * and a Worker compatibility pass. Keep its deadline independent from the
 * short publication/cleanup budgets below; the measured local path is already
 * longer than one second on a clean build.
 */
const GENERATION_WORK_TIMEOUT_MS = 5_000;
const GENERATION_PUBLICATION_TIMEOUT_MS = 1_000;
const CLEANUP_POLL_TIMEOUT_MS = 1_000;
const RUNTIME_GENERATION_PROOF_TIMEOUT_MS = 10_000;
const RUNTIME_PROCESS_READY_TIMEOUT_MS = 10_000;
const RUNTIME_WATCHER_READY_TIMEOUT_MS = 10_000;

interface OwnedRunnerReservation {
  readonly release: () => void;
  readonly start: <T>(runner: () => T, allowWhenStopping?: boolean) => T;
}

async function terminateOwnedProcess(
  process: EdenCliProcess,
  signal: NodeJS.Signals,
): Promise<boolean> {
  const attempt = async (requestedSignal: NodeJS.Signals): Promise<boolean> => {
    let termination: Promise<void>;
    try {
      termination = Promise.resolve(process.terminate(requestedSignal));
    } catch {
      return false;
    }
    return Promise.race([
      termination.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), OWNED_PROCESS_TERMINATION_TIMEOUT_MS);
      }),
    ]);
  };
  const initialSignalSent = await attempt(signal);
  if (initialSignalSent) {
    const exited = await waitForOwnedProcessExit(
      process,
      OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
    );
    if (exited) return true;
  }
  await attempt("SIGKILL");
  return await waitForOwnedProcessExit(
    process,
    OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
  );
}

function createOwnedProcessRegistry(): OwnedProcessRegistry {
  const processes = new Set<EdenCliProcess>();
  const processRecords = new Map<
    EdenCliProcess,
    {
      releaseRequested: boolean;
      terminal: boolean;
      terminationAttempted: boolean;
    }
  >();
  const pendingTerminations = new Map<EdenCliProcess, Promise<boolean>>();
  const lateResults = new Set<Promise<void>>();
  const reservations = new Set<{
    readonly settled: Promise<void>;
    readonly release: () => void;
  }>();
  const deferredCleanups = new Set<() => void | Promise<void>>();
  let stopping = false;
  let cleanupPromise: Promise<boolean> | undefined;
  let cleanupFinished = false;
  let cleanupFinishedQuiescent = false;
  let cleanupSignal: NodeJS.Signals = "SIGTERM";
  let deferredCleanupPromise: Promise<void> | undefined;
  let resolveStopped: ((signal: NodeJS.Signals) => void) | undefined;
  const stopped = new Promise<NodeJS.Signals>((resolve) => {
    resolveStopped = resolve;
  });
  const isQuiescent = (): boolean =>
    processes.size === 0 &&
    pendingTerminations.size === 0 &&
    reservations.size === 0 &&
    lateResults.size === 0;
  const drainDeferredCleanups = async (): Promise<void> => {
    if (!isQuiescent() || deferredCleanups.size === 0) return;
    if (deferredCleanupPromise !== undefined) {
      await deferredCleanupPromise;
      return;
    }
    deferredCleanupPromise = (async () => {
      while (isQuiescent() && deferredCleanups.size > 0) {
        const cleanupTask = deferredCleanups.values().next().value as
          | (() => void | Promise<void>)
          | undefined;
        if (cleanupTask === undefined) break;
        deferredCleanups.delete(cleanupTask);
        await Promise.resolve().then(cleanupTask).catch(() => undefined);
      }
    })().finally(() => {
      deferredCleanupPromise = undefined;
    });
    await deferredCleanupPromise;
  };
  const scheduleQuiescenceCheck = (): void => {
    if (stopping && cleanupFinished && !isQuiescent()) {
      cleanupFinished = false;
      void cleanup(cleanupSignal, CLEANUP_POLL_TIMEOUT_MS);
    }
    if (isQuiescent()) {
      void drainDeferredCleanups();
    }
  };
  const markTerminal = (process: EdenCliProcess): void => {
    const record = processRecords.get(process);
    if (record === undefined) return;
    record.terminal = true;
    if (
      (record.releaseRequested || stopping) &&
      !pendingTerminations.has(process)
    ) {
      processRecords.delete(process);
      processes.delete(process);
    }
    scheduleQuiescenceCheck();
  };
  const observeProcess = (process: EdenCliProcess): void => {
    void process.exited.then(
      () => markTerminal(process),
      () => undefined,
    );
  };
  const terminateTracked = (process: EdenCliProcess): Promise<boolean> => {
    const existing = pendingTerminations.get(process);
    if (existing !== undefined) return existing;
    const record = processRecords.get(process);
    if (record === undefined) return Promise.resolve(true);
    if (record.terminal) {
      processRecords.delete(process);
      processes.delete(process);
      scheduleQuiescenceCheck();
      return Promise.resolve(true);
    }
    if (record.terminationAttempted) return Promise.resolve(false);
    record.terminationAttempted = true;
    const termination = terminateOwnedProcess(process, cleanupSignal)
      .then((settled) => {
        if (settled) {
          processRecords.delete(process);
          processes.delete(process);
        }
        return settled;
      })
      .finally(() => {
        pendingTerminations.delete(process);
        const record = processRecords.get(process);
        if (record?.terminal && (record.releaseRequested || stopping)) {
          processRecords.delete(process);
          processes.delete(process);
        }
        scheduleQuiescenceCheck();
      });
    pendingTerminations.set(process, termination);
    return termination;
  };
  const retryUnresolvedTerminations = (): void => {
    if (!stopping || pendingTerminations.size > 0) return;
    for (const process of processes) {
      const record = processRecords.get(process);
      if (record !== undefined && !record.terminal) {
        record.terminationAttempted = false;
      }
    }
    if (cleanupFinished) {
      cleanupFinished = false;
      void cleanup(cleanupSignal, CLEANUP_POLL_TIMEOUT_MS);
    }
  };
  async function cleanup(
    signal: NodeJS.Signals,
    timeoutMs = OWNED_PROCESS_CLEANUP_TIMEOUT_MS,
  ): Promise<boolean> {
    cleanupSignal = signal;
    stopping = true;
    resolveStopped?.(signal);
    resolveStopped = undefined;
    if (cleanupPromise !== undefined) return cleanupPromise;
    if (cleanupFinished) return cleanupFinishedQuiescent;
    cleanupPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const processSnapshot = [...processes];
        const reservationSnapshot = [...reservations];
        const terminations = processSnapshot.map((process) =>
          terminateTracked(process),
        );
        await Promise.all(terminations);
        const remainingMs = Math.max(1, deadline - Date.now());
        await Promise.all([
          waitForSettlements(
            processSnapshot.map((process) => process.exited),
            Math.min(OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS, remainingMs),
          ),
          waitForSettlements(
            reservationSnapshot.map((reservation) => reservation.settled),
            Math.min(OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS, remainingMs),
          ),
        ]);
        if (isQuiescent()) {
          await drainDeferredCleanups();
          return isQuiescent();
        }
        if (
          processes.size > 0 &&
          pendingTerminations.size === 0 &&
          reservations.size === 0 &&
          lateResults.size === 0
        ) {
          // A termination attempt was bounded but exit was not proven. Keep
          // the process owned and leave deferred files/locks in place; a
          // later exit observation will drain them without a second signal
          // storm or a false quiescence result.
          return false;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await drainDeferredCleanups();
      return isQuiescent();
    })();
    try {
      return await cleanupPromise;
    } finally {
      cleanupFinished = true;
      cleanupFinishedQuiescent = isQuiescent();
      cleanupPromise = undefined;
    }
  }
  return {
    isStopping: () => stopping,
    isQuiescent,
    stopped,
    reserve: () => {
      let resolveReservation: (() => void) | undefined;
      const settled = new Promise<void>((resolve) => {
        resolveReservation = resolve;
      });
      let released = false;
      const reservation: {
        readonly settled: Promise<void>;
        readonly release: () => void;
      } = {
        settled,
        release: (): void => {
          if (released) return;
          released = true;
          cleanupFinished = false;
          reservations.delete(reservation);
          resolveReservation?.();
          scheduleQuiescenceCheck();
        },
      };
      reservations.add(reservation);
      const ownedReservation: OwnedRunnerReservation = {
        release: (): void => {
          reservation.release();
        },
        start: <T>(runner: () => T, allowWhenStopping = false): T => {
          if (stopping && !allowWhenStopping) {
            throw cliError({
              code: "DEPLOY_CANCELLED",
              message:
                "The Eden operation was cancelled before the owned runner handoff completed.",
            });
          }
          return runner();
        },
      };
      return ownedReservation;
    },
    registerReservationProcess: (reservation, process) => {
      cleanupFinished = false;
      if (!processRecords.has(process)) {
        processRecords.set(process, {
          releaseRequested: false,
          terminal: false,
          terminationAttempted: false,
        });
        processes.add(process);
        observeProcess(process);
      }
      reservation.release();
      if (stopping) {
        void terminateTracked(process);
      }
    },
    register: (process) => {
      cleanupFinished = false;
      if (processRecords.has(process)) return;
      processRecords.set(process, {
        releaseRequested: false,
        terminal: false,
        terminationAttempted: false,
      });
      processes.add(process);
      observeProcess(process);
      if (stopping) {
        void terminateTracked(process);
      }
    },
    terminate: terminateTracked,
    unregister: (process) => {
      const record = processRecords.get(process);
      if (record === undefined) return;
      record.releaseRequested = true;
      if (
        !stopping &&
        record.terminal &&
        !pendingTerminations.has(process)
      ) {
        processRecords.delete(process);
        processes.delete(process);
      }
      scheduleQuiescenceCheck();
    },
    trackLateResult: (settlement) => {
      const restartCleanup = stopping && cleanupFinished;
      cleanupFinished = false;
      const tracked = Promise.resolve(settlement).then(
        () => undefined,
        () => undefined,
      );
      lateResults.add(tracked);
      if (restartCleanup) {
        void cleanup(cleanupSignal, CLEANUP_POLL_TIMEOUT_MS);
      }
      void tracked.then(() => {
        lateResults.delete(tracked);
        scheduleQuiescenceCheck();
        retryUnresolvedTerminations();
      });
    },
    deferCleanup: async (cleanupTask) => {
      deferredCleanups.add(cleanupTask);
      await drainDeferredCleanups();
    },
    waitForQuiescence: async () => {
      if (!stopping) return true;
      const signal = await stopped;
      return await cleanup(signal);
    },
    cleanup,
  };
}

interface OwnedRemoteCommandOutcome {
  readonly result: EdenCliRemoteCommandResult;
  readonly leaseHeldUntilTerminal: boolean;
  /**
   * This promise resolves only after the remote result is settled and the
   * child exit observation fulfills. A rejected exit observation intentionally
   * leaves it pending: rejection is not proof that the child is terminal.
   */
  readonly terminal: Promise<void>;
  readonly waitForTerminal: () => Promise<void>;
  readonly releaseLeaseAfterTerminal: () => Promise<boolean>;
}

interface RemoteTerminalObservation {
  readonly proof: Promise<boolean>;
  readonly terminal: Promise<void>;
}

function observeRemoteTerminal(
  result: PromiseLike<unknown>,
  exited: PromiseLike<unknown>,
): RemoteTerminalObservation {
  const resultSettled = Promise.resolve(result).then(
    () => true,
    () => true,
  );
  const exitProven = Promise.resolve(exited).then(
    () => true,
    () => false,
  );
  const proof = Promise.all([resultSettled, exitProven]).then(
    ([resultIsSettled, exitIsProven]) => resultIsSettled && exitIsProven,
  );
  const terminal = proof.then((proven) => {
    if (proven) return;
    // A rejected exit observation is unresolved ownership. Keep this
    // barrier pending so compensation and local cleanup cannot proceed.
    return new Promise<void>(() => {});
  });
  return { proof, terminal };
}

function observeRemoteResult(
  result: PromiseLike<unknown>,
): RemoteTerminalObservation {
  const proof = Promise.resolve(result).then(
    () => true,
    () => true,
  );
  return {
    proof,
    terminal: proof.then(() => undefined),
  };
}

function registerRemoteTerminalBarrier(
  ownedProcesses: OwnedProcessRegistry,
  barrier: Promise<void>,
  register?: (barrier: Promise<void>) => void,
): void {
  ownedProcesses.trackLateResult(barrier);
  register?.(barrier);
}

function retainUnsupportedHandle(
  handle: EdenCliDryRunHandle | EdenCliRemoteCommandHandle,
  reservation: { readonly release: () => void } | undefined,
  ownedProcesses?: OwnedProcessRegistry,
): void {
  const observation = observeRemoteTerminal(
    handle.result,
    handle.process.exited,
  );
  if (ownedProcesses === undefined) {
    void Promise.resolve()
      .then(() => terminateOwnedProcess(handle.process, "SIGTERM"))
      .catch(() => undefined);
    void observation.terminal.then(() => {
      reservation?.release();
    });
    return;
  }
  ownedProcesses.register(handle.process);
  registerRemoteTerminalBarrier(ownedProcesses, observation.terminal);
  void ownedProcesses.terminate(handle.process).catch(() => undefined);
  void observation.terminal.then(() => {
    reservation?.release();
  });
}

function isDryRunHandle(
  value: unknown,
): value is EdenCliDryRunHandle {
  const result = isRecord(value) ? value.result : undefined;
  const processValue = isRecord(value) ? value.process : undefined;
  return (
    isRecord(value) &&
    isRecord(processValue) &&
    typeof result === "object" &&
    result !== null &&
    "then" in result &&
    typeof processValue.pid === "number" &&
    typeof processValue.terminate === "function"
  );
}

function isRemoteCommandHandle(
  value: unknown,
): value is EdenCliRemoteCommandHandle {
  const result = isRecord(value) ? value.result : undefined;
  const processValue = isRecord(value) ? value.process : undefined;
  return (
    isRecord(value) &&
    isRecord(processValue) &&
    typeof result === "object" &&
    result !== null &&
    "then" in result &&
    typeof processValue.pid === "number" &&
    typeof processValue.terminate === "function"
  );
}

async function runCompatibilityDryRun(
  options: EdenCliRunOptions,
  request: EdenCliDryRunRequest,
  ownedProcesses?: OwnedProcessRegistry,
  beforeStart?: () => void | Promise<void>,
  afterPreflight?: () => void | Promise<void>,
): Promise<EdenCliDryRunResult> {
  const runner = options.dryRunRunner ?? runDefaultDryRun;
  const reservation = ownedProcesses?.reserve();
  let returned: EdenCliDryRunResult | EdenCliDryRunHandle | Promise<EdenCliDryRunResult>;
  try {
    await beforeStart?.();
    if (ownedProcesses?.isStopping() === true) {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message: "The Eden operation was cancelled before compatibility validation started.",
      });
    }
    await afterPreflight?.();
    if (ownedProcesses?.isStopping() === true) {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          "The Eden operation was cancelled during the compatibility runner handoff.",
      });
    }
    returned = reservation === undefined
      ? runner(request)
      : reservation.start(() => runner(request));
  } catch (error: unknown) {
    reservation?.release();
    throw error;
  }
  if (isDryRunHandle(returned)) {
    if (ownedProcesses !== undefined && reservation !== undefined) {
      ownedProcesses.registerReservationProcess(reservation, returned.process);
      ownedProcesses.trackLateResult(
        returned.result.then(
          () => undefined,
          () => undefined,
        ),
      );
    } else {
      ownedProcesses?.register(returned.process);
      reservation?.release();
    }
    try {
      return await raceOwnedResult(
        returned.result,
        ownedProcesses,
        "The compatibility validation was cancelled before its result settled.",
      );
    } finally {
      ownedProcesses?.unregister(returned.process);
    }
  }
  let resolved: EdenCliDryRunResult | EdenCliDryRunHandle;
  try {
    if (isPromiseLikeValue(returned)) {
      resolved = await raceOwnedResult(
        returned,
        ownedProcesses,
        "The compatibility validation was cancelled before its result settled.",
      );
    } else {
      resolved = returned;
    }
  } catch (error: unknown) {
    const lateSettlement = settleLateChildResult(
      Promise.resolve(returned),
      reservation,
      isDryRunHandle,
      ownedProcesses,
    );
    ownedProcesses?.trackLateResult(lateSettlement);
    throw error;
  }
  if (isDryRunHandle(resolved)) {
    // A promise-returned handle may already have spawned before this await.
    // It cannot be registered synchronously, so this shape is unsupported.
    // Give the returned owner one best-effort termination opportunity rather
    // than leaving an untracked child behind.
    retainUnsupportedHandle(resolved, reservation, ownedProcesses);
    throw cliError({
      code: "DRY_RUN_HANDLE_UNSUPPORTED",
      message:
        "The compatibility runner returned a cancellable handle through a promise; return the handle synchronously so it can be registered before awaiting.",
    });
  }
  reservation?.release();
  return resolved;
}

async function runRemoteCommand(
  options: EdenCliRunOptions,
  request: EdenCliRemoteCommandRequest,
  ownedProcesses: OwnedProcessRegistry,
  allowWhenStopping = false,
  onStarted?: () => void,
  onPossiblyStarted?: () => void,
  beforeStart?: () => void | Promise<void>,
  afterPreflight?: () => void | Promise<void>,
  acquireLease?: (
    terminal: Promise<void>,
  ) => Promise<DeploymentLeaseHandle>,
  registerTerminal?: (barrier: Promise<void>) => void,
): Promise<OwnedRemoteCommandOutcome> {
  if (!allowWhenStopping && ownedProcesses.isStopping()) {
    throw cliError({
      code: "DEPLOY_CANCELLED",
      message:
        "Eden deploy was cancelled before the remote command could start.",
    });
  }
  const runner = options.remoteCommandRunner ?? runDefaultRemoteCommand;
  const reservation = ownedProcesses.reserve();
  let resolveOperationTerminal: (() => void) | undefined;
  const operationTerminal = new Promise<void>((resolve) => {
    resolveOperationTerminal = resolve;
  });
  let runnerInvoked = false;
  let returned: EdenCliRemoteCommandReturn;
  let lease: DeploymentLeaseHandle | undefined;
  try {
    await beforeStart?.();
    if (!allowWhenStopping && ownedProcesses.isStopping()) {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          "Eden deploy was cancelled before the remote command could start.",
      });
    }
    await afterPreflight?.();
    if (!allowWhenStopping && ownedProcesses.isStopping()) {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          "Eden deploy was cancelled during the remote runner handoff.",
      });
    }
    lease = await acquireLease?.(operationTerminal);
    if (lease !== undefined) {
      registerRemoteTerminalBarrier(
        ownedProcesses,
        operationTerminal,
        registerTerminal,
      );
    }
    if (!allowWhenStopping && ownedProcesses.isStopping()) {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          "Eden deploy was cancelled before the cross-process remote lease handoff completed.",
      });
    }
    returned = reservation.start(
      () => {
        runnerInvoked = true;
        return runner(request);
      },
      allowWhenStopping,
    );
    onPossiblyStarted?.();
  } catch (error: unknown) {
    if (runnerInvoked) {
      onPossiblyStarted?.();
      reservation.release();
      throw error;
    }
    resolveOperationTerminal?.();
    await lease?.release().catch(() => undefined);
    reservation.release();
    throw error;
  }
  if (isRemoteCommandHandle(returned)) {
    ownedProcesses.registerReservationProcess(reservation, returned.process);
    onStarted?.();
    const observation = observeRemoteTerminal(
      returned.result,
      returned.process.exited,
    );
    void observation.terminal.then(() => resolveOperationTerminal?.());
    registerRemoteTerminalBarrier(
      ownedProcesses,
      observation.terminal,
      registerTerminal,
    );
    try {
      if (allowWhenStopping) {
        const result = await Promise.race([
          returned.result,
          new Promise<EdenCliRemoteCommandResult>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  exitCode: 1,
                  stdout: "",
                  stderr: "Remote cleanup command did not settle.",
                }),
              OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
            );
          }),
        ]);
        return {
          result,
          leaseHeldUntilTerminal: true,
          terminal: observation.terminal,
          waitForTerminal: async () => {
            await waitForRemoteTerminal(observation);
          },
          releaseLeaseAfterTerminal: async () => {
            await observation.terminal;
            return await lease?.release().catch(() => false) ?? true;
          },
        };
      }
      const result = await Promise.race([
        returned.result,
        ownedProcesses.stopped.then((signal) => {
          throw cliError({
            code: "DEPLOY_CANCELLED",
            message:
              `Eden deploy was cancelled by ${signal}; the owned remote command was terminated.`,
          });
        }),
      ]);
      return {
        result,
        leaseHeldUntilTerminal: true,
        terminal: observation.terminal,
        waitForTerminal: async () => {
          await waitForRemoteTerminal(observation);
        },
        releaseLeaseAfterTerminal: async () => {
          await observation.terminal;
          return await lease?.release().catch(() => false) ?? true;
        },
      };
    } finally {
      ownedProcesses.unregister(returned.process);
    }
  }
  let resolved: EdenCliRemoteCommandResult | EdenCliRemoteCommandHandle;
  const returnedTerminal = isPromiseLikeValue(returned)
    ? observeRemoteTerminalReturn(returned, isRemoteCommandHandle)
    : undefined;
  if (returnedTerminal !== undefined) {
    void returnedTerminal.terminal.then(() => resolveOperationTerminal?.());
    registerRemoteTerminalBarrier(
      ownedProcesses,
      returnedTerminal.terminal,
      registerTerminal,
    );
  }
  try {
    if (isPromiseLikeValue(returned)) {
      resolved = await raceOwnedResult(
        returned,
        ownedProcesses,
        "The remote command was cancelled before its result settled.",
        REMOTE_RESULT_TIMEOUT_MS,
      );
    } else {
      resolved = returned;
    }
  } catch (error: unknown) {
    const lateSettlement = settleLateChildResult(
      Promise.resolve(returned),
      reservation,
      isRemoteCommandHandle,
      ownedProcesses,
    ).then(async () => {
      await operationTerminal;
      await lease?.release().catch(() => undefined);
    });
    onPossiblyStarted?.();
    ownedProcesses.trackLateResult(lateSettlement);
    throw error;
  }
  if (isRemoteCommandHandle(resolved)) {
    onPossiblyStarted?.();
    ownedProcesses.register(resolved.process);
    const observation = observeRemoteTerminal(
      resolved.result,
      resolved.process.exited,
    );
    registerRemoteTerminalBarrier(
      ownedProcesses,
      observation.terminal,
      registerTerminal,
    );
    const terminated = await ownedProcesses.terminate(resolved.process);
    onStarted?.();
    reservation.release();
    if (allowWhenStopping && terminated) {
      await observation.terminal;
      await lease?.release().catch(() => false);
      return {
        result: {
          exitCode: 0,
          stdout: "",
          stderr: "",
        },
        leaseHeldUntilTerminal: false,
        terminal: observation.terminal,
        waitForTerminal: async () => undefined,
        releaseLeaseAfterTerminal: async () => true,
      };
    }
    throw cliError({
      code: "REMOTE_COMMAND_HANDLE_UNSUPPORTED",
      message:
        "The remote command runner returned a cancellable handle through a promise; return the handle synchronously so it can be registered before awaiting.",
    });
  }
  resolveOperationTerminal?.();
  reservation.release();
  onStarted?.();
  return {
    result: resolved,
    leaseHeldUntilTerminal: false,
    terminal: returnedTerminal?.terminal ??
      observeRemoteResult(Promise.resolve(resolved)).terminal,
    waitForTerminal: async () => undefined,
    releaseLeaseAfterTerminal: async () => true,
  };
}

function observeRemoteTerminalReturn(
  returned: PromiseLike<unknown>,
  isHandle: (value: unknown) => value is {
    readonly process: EdenCliProcess;
    readonly result: PromiseLike<unknown>;
  },
): RemoteTerminalObservation {
  const observation = Promise.resolve(returned).then(
    (resolved) => {
      if (isHandle(resolved)) {
        return observeRemoteTerminal(
          resolved.result,
          resolved.process.exited,
        ).terminal;
      }
      return undefined;
    },
    () => undefined,
  );
  const proof = observation.then(() => true);
  return {
    proof,
    terminal: proof.then(() => undefined),
  };
}

async function waitForRemoteTerminal(
  observation: RemoteTerminalObservation,
): Promise<void> {
  const proof = await Promise.race([
    observation.proof,
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS);
    }),
  ]);
  if (proof !== true) {
    throw cliError({
      code: "REMOTE_TERMINALITY_UNPROVEN",
      message:
        "The remote operation result or child exit could not be proven terminal; ownership and cleanup were retained.",
    });
  }
}

async function runBoundedRemoteValidation(
  validation: (
    request: EdenCliRemoteValidationRequest,
  ) => Promise<EdenCliRemoteValidationResult>,
  request: EdenCliRemoteValidationRequest,
  ownedProcesses: OwnedProcessRegistry,
  mode: "read-only" | "mutating" = "read-only",
  registerTerminal?: (barrier: Promise<void>) => void,
): Promise<EdenCliRemoteValidationResult> {
  const validationResult = Promise.resolve().then(() => validation(request));
  const terminal = validationResult.then(
    () => undefined,
    () => undefined,
  );
  ownedProcesses.trackLateResult(terminal);
  if (mode === "mutating") {
    registerRemoteTerminalBarrier(ownedProcesses, terminal, registerTerminal);
  }
  return await Promise.race([
    validationResult,
    ownedProcesses.stopped.then((signal) => {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          `Eden deploy was cancelled by ${signal} before remote validation settled.`,
      });
    }),
  ]);
}

async function settleLateChildResult<T>(
  returned: PromiseLike<T>,
  reservation: { readonly release: () => void } | undefined,
  isHandle: (value: unknown) => value is {
    readonly process: EdenCliProcess;
    readonly result: PromiseLike<unknown>;
  },
  ownedProcesses?: OwnedProcessRegistry,
): Promise<void> {
  let resolved: T;
  try {
    resolved = await Promise.resolve(returned);
  } catch {
    reservation?.release();
    return;
  }
  if (isHandle(resolved)) {
    const observation = observeRemoteTerminal(
      resolved.result,
      resolved.process.exited,
    );
    if (ownedProcesses === undefined) {
      await terminateOwnedProcess(resolved.process, "SIGTERM");
    } else {
      ownedProcesses.register(resolved.process);
      ownedProcesses.trackLateResult(observation.terminal);
      void ownedProcesses.terminate(resolved.process).catch(() => undefined);
    }
    await observation.terminal;
  }
  reservation?.release();
}

function isPromiseLikeValue(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

async function raceOwnedResult<T>(
  result: T | PromiseLike<T>,
  ownedProcesses: OwnedProcessRegistry | undefined,
  cancellationMessage: string,
  timeoutMs?: number,
): Promise<T> {
  if (ownedProcesses === undefined) {
    return await result;
  }
  const timeout = timeoutMs === undefined
    ? []
    : [
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              cliError({
                code: "REMOTE_RESULT_TIMEOUT",
                message:
                  `The remote command result did not settle within ${timeoutMs}ms.`,
              }),
            );
          }, timeoutMs);
        }),
      ];
  return await Promise.race([
    Promise.resolve(result),
    ownedProcesses.stopped.then(() => {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message: cancellationMessage,
      });
    }),
    ...timeout,
  ]);
}

async function buildProjectFromCli(
  root: string,
  options: EdenCliRunOptions,
  environment?: "preview" | "production",
  sourceFingerprint?: ProjectInputFingerprint,
  ownedProcesses?: OwnedProcessRegistry,
  generationTimeoutMs = GENERATION_WORK_TIMEOUT_MS,
  workerName?: string,
  configurationContents?: string,
): Promise<EdenArtifactGeneration | undefined> {
  const configuration = await readProjectConfiguration(root);
  const inputFingerprint =
    sourceFingerprint ?? await fingerprintProjectInputs(root, configuration);
  const configuredWorkerName = environment === undefined
    ? undefined
    : await readConfiguredWorkerName(
        root,
        configuration.configPath,
        environment,
        configurationContents,
      );
  const effectiveWorkerName = workerName ?? configuredWorkerName;
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
    let result: EdenCompilerResult | undefined;
    try {
      const buildRunner = options.buildProjectRunner ?? buildProject;
      const buildWork = Promise.resolve().then(() =>
        buildRunner({
          projectRoot: root,
          outputDirectory: candidateOutput,
        }),
      );
      result = await awaitBoundedGenerationWork(
        buildWork,
        ownedProcesses,
        generationTimeoutMs,
      );
      if (result === undefined) {
        return undefined;
      }
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
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
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
        ...(effectiveWorkerName === undefined ? [] : ["--name", effectiveWorkerName]),
        "--config",
        temporaryConfig,
      ],
    };
    let dryRun: EdenCliDryRunResult;
    try {
      dryRun = await runCompatibilityDryRun(options, request, ownedProcesses);
    } catch (error: unknown) {
      if (ownedProcesses?.isStopping() === true) {
        return candidateGeneration;
      }
      throw cliError({
        code: "COMPATIBILITY_VALIDATION_FAILED",
        message: error instanceof Error
          ? `Worker compatibility dry run could not be started: ${error.message}`
          : "Worker compatibility dry run could not be started.",
      });
    }
    const dryRunOutput = redactOutput(dryRun.stdout);
    if (dryRunOutput.length > 0) options.stdout?.(dryRunOutput);
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
    if (dryRun.exitCode !== 0) {
      const dryRunError = redactOutput(dryRun.stderr);
      throw cliError({
        code: "COMPATIBILITY_VALIDATION_FAILED",
        message: `Worker compatibility validation failed during the dry run (exit code ${dryRun.exitCode}).${
          dryRunError.length === 0 ? "" : ` ${dryRunError}`
        }`,
      });
    }
    await assertProjectInputsUnchanged(
      root,
      configuration,
      inputFingerprint,
      [
        relative(root, candidateOutput),
        ...(temporaryConfig === undefined
          ? []
          : [relative(root, temporaryConfig)]),
        relative(root, runtimeFiles?.entryPath ?? candidateOutput),
      ],
    );
    const beforeCanonicalPrepare = await awaitBoundedGenerationWork(
      awaitBuildPublicationHook(
        options.buildPublicationHook,
        "before-canonical-prepare",
        ownedProcesses,
      ),
      ownedProcesses,
      GENERATION_PUBLICATION_TIMEOUT_MS,
    );
    if (beforeCanonicalPrepare !== true) {
      return candidateGeneration;
    }
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
    await ensureCanonicalArtifactDirectory(root, canonicalOutput);
    const afterCanonicalPrepare = await awaitBoundedGenerationWork(
      awaitBuildPublicationHook(
        options.buildPublicationHook,
        "after-canonical-prepare",
        ownedProcesses,
      ),
      ownedProcesses,
      GENERATION_PUBLICATION_TIMEOUT_MS,
    );
    if (afterCanonicalPrepare !== true) {
      return candidateGeneration;
    }
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }

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
    const beforeGenerationPublish = await awaitBoundedGenerationWork(
      awaitBuildPublicationHook(
        options.buildPublicationHook,
        "before-generation-publish",
        ownedProcesses,
      ),
      ownedProcesses,
      GENERATION_PUBLICATION_TIMEOUT_MS,
    );
    if (beforeGenerationPublish !== true) {
      return candidateGeneration;
    }
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
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
      await assertCanonicalGenerationMatches(
        root,
        canonicalGeneration,
        generationId,
        result.artifacts,
      );
      await rm(candidateGenerationPath, { recursive: true, force: true });
    }
    const afterGenerationPublish = await awaitBoundedGenerationWork(
      awaitBuildPublicationHook(
        options.buildPublicationHook,
        "after-generation-publish",
        ownedProcesses,
      ),
      ownedProcesses,
      GENERATION_PUBLICATION_TIMEOUT_MS,
    );
    if (afterGenerationPublish !== true) {
      return candidateGeneration;
    }
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
    const beforeCurrentPromotion = await awaitBoundedGenerationWork(
      awaitBuildPublicationHook(
        options.buildPublicationHook,
        "before-current-promotion",
        ownedProcesses,
      ),
      ownedProcesses,
      GENERATION_PUBLICATION_TIMEOUT_MS,
    );
    if (beforeCurrentPromotion !== true) {
      return candidateGeneration;
    }
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
    await assertCanonicalGenerationMatches(
      root,
      canonicalGeneration,
      generationId,
      result.artifacts,
    );
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
    await promoteCurrentGeneration(canonicalOutput, generationId);
    await assertArtifactDirectory(canonicalOutput);
    const afterCurrentPromotion = await awaitBoundedGenerationWork(
      awaitBuildPublicationHook(
        options.buildPublicationHook,
        "after-current-promotion",
        ownedProcesses,
      ),
      ownedProcesses,
      GENERATION_PUBLICATION_TIMEOUT_MS,
    );
    if (afterCurrentPromotion !== true) {
      return candidateGeneration;
    }
    if (ownedProcesses?.isStopping() === true) {
      return candidateGeneration;
    }
    options.stdout?.(
      `Built Eden project generation ${generationId}.`,
    );
    options.stdout?.("Worker compatibility dry run passed; no deployment was performed.");
    return {
      directory: canonicalGeneration,
      artifacts: result.artifacts,
    };
  } finally {
    const cleanupTemporaryBuildFiles = async (): Promise<void> => {
      await rm(candidateOutput, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (temporaryConfig !== undefined) {
        await rm(temporaryConfig, { force: true }).catch(() => undefined);
      }
      if (runtimeFiles !== undefined) {
        await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
      }
    };
    if (ownedProcesses === undefined) {
      await cleanupTemporaryBuildFiles();
    } else {
      await ownedProcesses.deferCleanup(cleanupTemporaryBuildFiles);
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

function appendSecondaryDiagnostic(
  error: unknown,
  diagnostic: EdenDiagnostic,
): unknown {
  if (error instanceof EdenCliError) {
    return new EdenCliError({
      code: error.code,
      message: error.message,
      ...(error.source === undefined ? {} : { source: error.source }),
      diagnostics: [...error.diagnostics, diagnostic],
    });
  }
  if (error instanceof EdenCompilerError) {
    return new EdenCliError({
      code: "CLI_FAILED",
      message: error.message,
      diagnostics: [...error.diagnostics, diagnostic],
    });
  }
  return new EdenCliError({
    code: "CLI_FAILED",
    message: error instanceof Error
      ? error.message
      : "The Eden command failed unexpectedly.",
    diagnostics: [diagnostic],
  });
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
  cleanupSignal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (cleanupSignal?.aborted === true) return;
    let available = true;
    for (const approved of APPROVED_PORTS) {
      if (!(await portIsAvailable(approved.host, approved.port))) {
        available = false;
        break;
      }
    }
    if (available) return;
    await new Promise<void>((resolveResult) => {
      if (cleanupSignal?.aborted === true) {
        resolveResult();
        return;
      }
      const timer = setTimeout(() => {
        cleanupSignal?.removeEventListener("abort", abort);
        resolveResult();
      }, 50);
      const abort = (): void => {
        clearTimeout(timer);
        cleanupSignal?.removeEventListener("abort", abort);
        resolveResult();
      };
      cleanupSignal?.addEventListener("abort", abort, { once: true });
    });
  }
  if (cleanupSignal?.aborted === true) return;
  throw cliError({
    code: "DEV_PORT_RELEASE_TIMEOUT",
    message:
      "The owned Eden dev process exited, but an approved local listener remains.",
  });
}

async function observeProcessIdentity(
  pid: number,
  marker: string,
  timeoutMs = 5_000,
): Promise<EdenCliProcessIdentity | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const observed = await readProcessObservation(pid);
    if (observed !== undefined && processCommandContainsMarker(observed.command, marker)) {
      return { marker, ...observed };
    }
    await new Promise((resolveResult) => setTimeout(resolveResult, 25));
  }
  return undefined;
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

async function waitForRuntimeGeneration(
  child: EdenCliProcess | undefined,
  generation: RuntimeGeneration,
  timeoutMs = RUNTIME_GENERATION_PROOF_TIMEOUT_MS,
  cleanupSignal?: AbortSignal,
): Promise<boolean> {
  const secret = process.env.EDEN_BEARER_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw cliError({
      code: "DEV_BEARER_REQUIRED",
      message:
        "EDEN_BEARER_SECRET is required to authenticate local generation verification; Eden dev fails closed without it.",
    });
  }
  const startedAt = Date.now();
  const url =
    `http://${EDEN_LOCAL_HOST}:${EDEN_LOCAL_PORT}/eden/v1/info`;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const requestController = new AbortController();
      const requestTimeout = setTimeout(
        () => requestController.abort(),
        Math.min(1_000, Math.max(1, timeoutMs)),
      );
      const abortRequest = (): void => {
        requestController.abort(cleanupSignal?.reason);
      };
      if (cleanupSignal?.aborted) return false;
      cleanupSignal?.addEventListener("abort", abortRequest, { once: true });
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${secret}`,
          },
          signal: requestController.signal,
        });
        if (response.ok) {
          const body = await response.json() as unknown;
          const observed = isRecord(body) ? body.generation : undefined;
          if (
            isRecord(observed) &&
            observed.generationId === generation.generationId &&
            observed.bundleDigest === generation.bundleDigest &&
            observed.manifestVersion === generation.manifestVersion &&
            observed.runtimeVersion === generation.runtimeVersion &&
            observed.agentBundleVersion === generation.agentBundleVersion &&
            observed.protocolVersion === generation.protocolVersion &&
            observed.schemaVersion === generation.schemaVersion &&
            Array.isArray(observed.toolNames) &&
            JSON.stringify(observed.toolNames) ===
              JSON.stringify(generation.toolNames)
          ) {
            if (child !== undefined) {
              const exited = await Promise.race([
                child.exited.then(() => true),
                new Promise<boolean>((resolveResult) => {
                  setTimeout(() => resolveResult(false), 0);
                }),
              ]);
              if (exited && cleanupSignal?.aborted !== true) {
                throw cliError({
                  code: "DEV_RUNTIME_RELOAD_FAILED",
                  message:
                    "The local runtime exited immediately after exposing the expected generation.",
                });
              }
            }
            return true;
          }
        }
      } finally {
        clearTimeout(requestTimeout);
        cleanupSignal?.removeEventListener("abort", abortRequest);
      }
    } catch {
      if (cleanupSignal?.aborted) return false;
      // The local process may briefly close its listener while reloading.
    }
    if (cleanupSignal?.aborted) return false;
    if (child !== undefined) {
      const exited = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolveResult) => {
          setTimeout(() => resolveResult(false), 0);
        }),
      ]);
      if (exited && cleanupSignal?.aborted !== true) {
        throw cliError({
          code: "DEV_RUNTIME_RELOAD_FAILED",
          message:
            "The local runtime exited before the new Eden generation became ready.",
        });
      }
    }
    await new Promise<void>((resolveResult) => {
      if (cleanupSignal?.aborted) {
        resolveResult();
        return;
      }
      const timer = setTimeout(() => {
        cleanupSignal?.removeEventListener("abort", abortDelay);
        resolveResult();
      }, 50);
      const abortDelay = (): void => {
        clearTimeout(timer);
        cleanupSignal?.removeEventListener("abort", abortDelay);
        resolveResult();
      };
      cleanupSignal?.addEventListener("abort", abortDelay, { once: true });
    });
  }
  if (cleanupSignal?.aborted) return false;
  throw cliError({
    code: "DEV_RUNTIME_RELOAD_FAILED",
    message:
      `The local runtime did not expose generation ${generation.generationId} after the watch rebuild.`,
  });
}

async function waitForRuntimeGenerationProof(
  proof: EdenCliRuntimeGenerationProof,
  child: EdenCliProcess | undefined,
  generation: RuntimeGeneration,
  timeoutMs: number,
  cleanupSignal: AbortSignal,
  ownedProcesses?: OwnedProcessRegistry,
): Promise<boolean> {
  if (proof === "authenticated-fetch") {
    return await waitForRuntimeGeneration(
      child,
      generation,
      timeoutMs,
      cleanupSignal,
    );
  }
  if (cleanupSignal.aborted) return false;
  const proofResult = Promise.resolve().then(() =>
    proof({
      process: child,
      generation,
      signal: cleanupSignal,
    })
  ).then(
    (result) => result === true,
    () => false,
  );
  ownedProcesses?.trackLateResult(proofResult.then(() => undefined));
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<boolean>((resolveResult) => {
    timer = setTimeout(() => resolveResult(false), timeoutMs);
  });
  const stopped = new Promise<boolean>((resolveResult) => {
    onAbort = (): void => resolveResult(false);
    cleanupSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([proofResult, timeout, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) {
      cleanupSignal.removeEventListener("abort", onAbort);
    }
  }
}

function defaultProcessRunner(): EdenCliProcessRunner {
  return {
    spawn(request) {
      const processMarker =
        request.processIdentity ?? `${PROCESS_IDENTITY_PREFIX}${randomUUID()}`;
      const child = spawnChild(
        request.command,
        [...(request.commandArgs ?? []), ...request.args],
        {
          argv0: processMarker,
          cwd: request.cwd,
          env: scrubChildEnvironment(request.env),
          detached: process.platform !== "win32",
          stdio: "inherit",
        },
      );
      return createDefaultProcessHandle(
        child,
        processMarker,
        request.readiness,
      );
    },
  };
}

async function closeWatcher(watcher: FSWatcher | undefined): Promise<void> {
  if (watcher === undefined) return;
  await watcher.close();
}

async function waitForWatcherReady(
  watcher: FSWatcher,
  timeoutMs: number,
  cleanupSignal?: AbortSignal,
): Promise<boolean> {
  if (cleanupSignal?.aborted === true) return false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const ready = new Promise<boolean>((resolveResult, reject) => {
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined && cleanupSignal !== undefined) {
        cleanupSignal.removeEventListener("abort", onAbort);
      }
      watcher.removeListener("ready", onReady);
      watcher.removeListener("error", onError);
    };
    const onReady = (): void => {
      cleanup();
      resolveResult(true);
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    onAbort = (): void => {
      cleanup();
      resolveResult(false);
    };
    watcher.once("ready", onReady);
    watcher.once("error", onError);
    cleanupSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolveResult(false);
    }, timeoutMs);
  });
  return await ready;
}

async function runDev(
  root: string,
  options: EdenCliRunOptions,
): Promise<void> {
  let child: EdenCliProcess | undefined;
  let childExited = false;
  let startupComplete = false;
  let watcher: FSWatcher | undefined;
  let stopped = false;
  let rebuildTimer: NodeJS.Timeout | undefined;
  type ScheduledRebuild = {
    readonly task: Promise<void>;
    readonly cancel: () => void;
  };
  let scheduledRebuild: ScheduledRebuild | undefined;
  const scheduledRebuilds = new Set<ScheduledRebuild>();
  let rebuildInFlight = false;
  let rebuildPending = false;
  const rebuildTasks = new Set<Promise<void>>();
  let statePath: string | undefined;
  let stateOwner: DevStateOwner | undefined;
  let temporaryConfig: string | undefined;
  let runtimeEntryPath: string | undefined;
  let runtimeGeneration: RuntimeGeneration | undefined;
  let runtimeContents: RuntimeFileContents | undefined;
  let runtimeArtifact: EdenArtifactGeneration | undefined;
  let replacementChild: EdenCliProcess | undefined;
  const runtimeChildren = new Set<EdenCliProcess>();
  const runtimeTerminationAttempts = new Map<
    EdenCliProcess,
    Promise<boolean>
  >();
  const runtimeTemporaryFiles = new Set<string>();
  const readinessAbortController = new AbortController();
  let localSecretPath: string | undefined;
  let cleanupPromise: Promise<boolean> | undefined;
  let cleanupRunning = false;
  let childCleanupRequested = false;
  let replacingRuntime = false;
  let requestedStop = false;
  let requestedSignal: NodeJS.Signals = "SIGTERM";
  let signalResolve: (() => void) | undefined;
  let runtimeChangeResolve: (() => void) | undefined;
  let runtimeChange = new Promise<void>((resolve) => {
    runtimeChangeResolve = resolve;
  });
  const signalReceived = new Promise<void>((resolveResult) => {
    signalResolve = resolveResult;
  });
  const startupStopped = Symbol("eden.startup.stopped");
  const usingDefaultProcessRunner = options.processRunner === undefined;
  const runner = options.processRunner ?? defaultProcessRunner();
  const ownedValidationProcesses = createOwnedProcessRegistry();
  const runtimePublicationHook = options.runtimePublicationHook;
  let runtimeExecutable: DeploymentExecutable | undefined;
  const runtimeGenerationProof = options.runtimeGenerationProof;
  if (options.processRunner !== undefined && runtimeGenerationProof === undefined) {
    throw cliError({
      code: "DEV_PROOF_SEAM_REQUIRED",
      message:
        "An injected process runner requires an explicit authenticated runtime generation proof seam.",
      source: "runtimeGenerationProof",
    });
  }
  const notifyRuntimeChange = (): void => {
    runtimeChangeResolve?.();
    runtimeChange = new Promise<void>((resolve) => {
      runtimeChangeResolve = resolve;
    });
  };
  const markRuntimeUnavailable = (): void => {
    replacingRuntime = false;
    child = undefined;
    childExited = true;
    runtimeGeneration = undefined;
    runtimeContents = undefined;
    runtimeArtifact = undefined;
    notifyRuntimeChange();
  };
  const removeRuntimeTemporaryFiles = async (): Promise<void> => {
    for (const path of [...runtimeTemporaryFiles]) {
      await rm(path, { force: true }).catch(() => undefined);
      runtimeTemporaryFiles.delete(path);
    }
    if (temporaryConfig !== undefined) {
      await rm(temporaryConfig, { force: true }).catch(() => undefined);
      temporaryConfig = undefined;
    }
    if (runtimeEntryPath !== undefined) {
      await rm(runtimeEntryPath, { force: true }).catch(() => undefined);
      runtimeEntryPath = undefined;
    }
  };
  const removeRuntimeOwnedResources = async (): Promise<void> => {
    await removeRuntimeTemporaryFiles();
    if (localSecretPath !== undefined) {
      await rm(localSecretPath, { force: true }).catch(() => undefined);
      localSecretPath = undefined;
    }
    if (statePath !== undefined && stateOwner !== undefined) {
      await removeOwnedDevState(root, stateOwner).catch(() => undefined);
      statePath = undefined;
      stateOwner = undefined;
    }
  };
  const terminateRuntimeChildOnce = (
    processHandle: EdenCliProcess,
    signal: NodeJS.Signals,
  ): Promise<boolean> => {
    const existing = runtimeTerminationAttempts.get(processHandle);
    if (existing !== undefined) return existing;
    const attempt = terminateRuntimeChild(
      processHandle,
      signal,
    );
    runtimeTerminationAttempts.set(processHandle, attempt);
    return attempt;
  };
  const createTrackedRuntimeFiles = async (
    configurationPath: string,
    generation: EdenArtifactGeneration,
  ): Promise<RuntimeFiles | undefined> => {
    if (stopped) return undefined;
    const files = await createRuntimeFiles(
      root,
      configurationPath,
      generation,
    );
    runtimeTemporaryFiles.add(files.configPath);
    runtimeTemporaryFiles.add(files.entryPath);
    if (stopped) {
      await rm(files.configPath, { force: true }).catch(() => undefined);
      await rm(files.entryPath, { force: true }).catch(() => undefined);
      runtimeTemporaryFiles.delete(files.configPath);
      runtimeTemporaryFiles.delete(files.entryPath);
      return undefined;
    }
    return files;
  };
  const awaitRuntimePublicationHook = async (
    boundary: EdenRuntimePublicationBoundary,
  ): Promise<boolean> => {
    const hookReservation = ownedValidationProcesses.reserve();
    if (stopped) {
      hookReservation.release();
      return false;
    }
    const hookResult: Promise<void | typeof startupStopped> = (async () => {
      try {
        await runtimePublicationHook?.(boundary);
        return undefined;
      } catch (error: unknown) {
        if (stopped) return startupStopped;
        throw error;
      }
    })();
    ownedValidationProcesses.trackLateResult(
      hookResult.then(
        () => undefined,
        () => undefined,
      ),
    );
    const stopResult: Promise<typeof startupStopped> = signalReceived.then(
      () => startupStopped,
    );
    let hookSettled = false;
    const settleHook = (): void => {
      if (hookSettled) return;
      hookSettled = true;
      hookReservation.release();
    };
    void hookResult.then(settleHook, settleHook);
    const result = await Promise.race<void | typeof startupStopped>([
      hookResult,
      stopResult,
    ]);
    if (result === startupStopped || stopped) {
      return false;
    }
    return true;
  };
  const initialRuntimeGenerationProof = async (
    processHandle: EdenCliProcess,
    generation: RuntimeGeneration,
  ): Promise<boolean> => {
    const proof = verifyRuntimeGeneration(processHandle, generation);
    return await proof;
  };
  const assertChildRunning = async (processHandle: EdenCliProcess): Promise<void> => {
    if (!usingDefaultProcessRunner) return;
    const terminal = await Promise.race([
      processHandle.exited.then(() => true, () => true),
      new Promise<boolean>((resolveResult) => setTimeout(() => resolveResult(false), 0)),
    ]);
    if (terminal) throw cliError({ code: "DEV_START_FAILED", message: "The Eden dev process exited before startup completed.", source: DEV_STATE_FILE });
  };
  const verifyRuntimeGeneration = async (
    processHandle: EdenCliProcess | undefined,
    generation: RuntimeGeneration | undefined,
  ): Promise<boolean> => {
    if (generation === undefined) return false;
    if (runtimeGenerationProof !== undefined) {
      return await waitForRuntimeGenerationProof(
        runtimeGenerationProof,
        processHandle,
        generation,
        options.runtimeReadinessTimeoutMs ?? RUNTIME_GENERATION_PROOF_TIMEOUT_MS,
        readinessAbortController.signal,
        ownedValidationProcesses,
      );
    }
    return await waitForRuntimeGeneration(
      processHandle,
      generation,
      options.runtimeReadinessTimeoutMs ?? RUNTIME_GENERATION_PROOF_TIMEOUT_MS,
      readinessAbortController.signal,
    );
  };

  const createRuntimeProcessRequest = (
    configPath: string,
  ): EdenCliProcessRequest => {
    if (runtimeExecutable === undefined) {
      throw cliError({
        code: "WRANGLER_UNAVAILABLE",
        message:
          "The local runtime executable was not resolved before child startup.",
      });
    }
    return {
      command: runtimeExecutable.command,
      commandArgs: runtimeExecutable.commandArgs,
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
        configPath,
        ...(localSecretPath === undefined
          ? []
          : ["--env-file", localSecretPath]),
      ],
      cwd: root,
      processIdentity: `${PROCESS_IDENTITY_PREFIX}runtime-${randomUUID()}`,
      env: {
        EDEN_HOST: EDEN_LOCAL_HOST,
        EDEN_PORT: String(EDEN_LOCAL_PORT),
        EDEN_INSPECTOR_PORT: String(EDEN_LOCAL_INSPECTOR_PORT),
      },
      readiness: APPROVED_PORTS.map(({ host, port }) => ({ host, port })),
    };
  };

  const startRuntimeChild = async (
    configPath: string,
  ): Promise<EdenCliProcess | typeof startupStopped> => {
    if (stopped) return startupStopped;
    const processHandle = runner.spawn(createRuntimeProcessRequest(configPath));
    runtimeChildren.add(processHandle);
    void processHandle.exited.finally(() => {
      runtimeChildren.delete(processHandle);
      if (stopped) {
        if (child === processHandle) child = undefined;
        if (replacementChild === processHandle) replacementChild = undefined;
      }
    });
    replacementChild = processHandle;
    if (stopped) {
      const terminated = await terminateRuntimeChildOnce(
        processHandle,
        requestedSignal,
      );
      replacementChild = undefined;
      if (!terminated) {
        void cleanup(CLEANUP_POLL_TIMEOUT_MS);
      }
      return startupStopped;
    }
    if (stopped) return startupStopped;
    void processHandle.exited.then(
      () => {
        if (processHandle === child) childExited = true;
      },
      () => {
        if (processHandle === child) childExited = true;
      },
    );
    const startIdentityResult = await Promise.race<
      string | undefined | typeof startupStopped
    >([
      Promise.resolve(processHandle.startIdentity),
      signalReceived.then(() => startupStopped),
    ]);
    if (startIdentityResult === startupStopped) return startupStopped;
    if (stopped) {
      const terminated = await terminateRuntimeChildOnce(
        processHandle,
        requestedSignal,
      );
      replacementChild = undefined;
      if (!terminated) {
        void cleanup(CLEANUP_POLL_TIMEOUT_MS);
      }
      return startupStopped;
    }
    if (
      typeof startIdentityResult !== "string" ||
      startIdentityResult.length === 0
    ) {
      const exitedBeforeIdentityCheck = await Promise.race([
        processHandle.exited.then(() => true, () => true),
        new Promise<boolean>((resolveResult) => {
          setTimeout(() => resolveResult(false), 0);
        }),
      ]);
      if (exitedBeforeIdentityCheck && replacementChild === processHandle) {
        replacementChild = undefined;
      }
      throw cliError({
        code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
        message:
          "The Eden dev process start identity could not be verified; no PID or process group was signaled.",
        source: DEV_STATE_FILE,
      });
    }
    if (usingDefaultProcessRunner && !isProcessIdentity(await Promise.resolve(processHandle.identity))) {
      throw cliError({ code: "DEV_PROCESS_IDENTITY_UNAVAILABLE", message: "The default Eden dev process identity could not be verified before readiness.", source: DEV_STATE_FILE });
    }
    const readiness = processHandle.ready ?? Promise.resolve();
    void readiness.catch(() => undefined);
    try {
      const readinessResult = await Promise.race<
        void | typeof startupStopped
      >([
        readiness,
        signalReceived.then(() => startupStopped),
      ]);
      if (readinessResult === startupStopped) return startupStopped;
      if (stopped) {
        const terminated = await terminateRuntimeChildOnce(
          processHandle,
          requestedSignal,
        );
        replacementChild = undefined;
        if (!terminated) {
          void cleanup(CLEANUP_POLL_TIMEOUT_MS);
        }
        return startupStopped;
      }
    } catch (error: unknown) {
      if (child === undefined && replacementChild !== undefined) {
        await terminateRuntimeChildOnce(
          replacementChild,
          requestedSignal,
        ).catch(() => false);
        replacementChild = undefined;
      }
      throw error instanceof EdenCliError
        ? error
        : cliError({
            code: "DEV_NOT_READY",
            message: error instanceof Error
              ? error.message
              : "The local runtime did not become ready.",
          });
    }
    return processHandle;
  };

  const rebuild = async (): Promise<void> => {
    if (stopped) return;
    if (rebuildInFlight) {
      rebuildPending = true;
      return;
    }
    rebuildInFlight = true;
    try {
      const builtGeneration = await buildProjectFromCli(
        root,
        options,
        undefined,
        undefined,
        ownedValidationProcesses,
      );
      if (builtGeneration === undefined) return;
      if (ownedValidationProcesses.isStopping()) return;
      if (stopped) return;
      const resolvedConfiguration = await readProjectConfiguration(root);
      if (stopped) return;
      const nextGeneration = builtGeneration;
      const nextRuntimeGeneration = readRuntimeGeneration(nextGeneration);
      if (
        runtimeGeneration === undefined ||
        runtimeContents === undefined ||
        runtimeArtifact === undefined ||
        runtimeEntryPath === undefined ||
        temporaryConfig === undefined
      ) {
        throw cliError({
          code: "DEV_RUNTIME_UNAVAILABLE",
          message:
            "The running Eden runtime is unavailable; the coherent watch generation was not activated.",
        });
      }
      const oldArtifact = runtimeArtifact;
      const nextRuntimeFiles = await createTrackedRuntimeFiles(
        resolvedConfiguration.configPath,
        nextGeneration,
      );
      if (nextRuntimeFiles === undefined || stopped) return;
      let oldRuntimeStopped = false;
      let oldConfig: string | undefined;
      let oldEntry: string | undefined;
      let candidateChild: EdenCliProcess | undefined;
      let nextRuntimePromoted = false;
      try {
        if (stopped) return;
        const oldChild = child;
        oldConfig = temporaryConfig;
        oldEntry = runtimeEntryPath;
        oldRuntimeStopped = oldChild === undefined;
        replacingRuntime = true;
        if (oldChild !== undefined) {
          const oldIdentity = await Promise.resolve(oldChild.startIdentity);
          if (typeof oldIdentity !== "string" || oldIdentity.length === 0) {
            throw cliError({
              code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
              message:
                "The last good Eden runtime identity could not be verified before replacement.",
              source: DEV_STATE_FILE,
            });
          }
          oldRuntimeStopped = await terminateRuntimeChildOnce(
            oldChild,
            "SIGTERM",
          );
          if (stopped) return;
          if (oldRuntimeStopped) {
            await waitForApprovedPortsAvailable(
              5_000,
              readinessAbortController.signal,
            );
            if (stopped) return;
          } else if (!stopped) {
            const oldGenerationStillServes = await verifyRuntimeGeneration(
              oldChild,
              runtimeGeneration,
            );
            if (stopped) return;
            if (oldGenerationStillServes) {
              throw cliError({
                code: "DEV_RUNTIME_RELOAD_FAILED",
                message:
                  "The previous Eden runtime did not confirm termination; its authenticated old generation remains active.",
              });
            }
            throw cliError({
              code: "DEV_RUNTIME_RELOAD_FAILED",
              message:
                "The previous Eden runtime termination was uncertain and its authenticated old generation could not be verified.",
            });
          }
        }
        if (stopped) return;
        const replacement = await startRuntimeChild(nextRuntimeFiles.configPath);
        if (replacement === startupStopped) {
          replacingRuntime = false;
          return;
        }
        if (stopped) {
          replacingRuntime = false;
          return;
        }
        candidateChild = replacement;
        replacementChild = replacement;
        const replacementIdentity = await Promise.resolve(
          replacement.startIdentity,
        );
        if (
          typeof replacementIdentity !== "string" ||
          replacementIdentity.length === 0
        ) {
          throw cliError({
            code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
            message:
              "The replacement Eden runtime identity could not be verified; the old runtime remains unavailable.",
            source: DEV_STATE_FILE,
          });
        }
        const replacementVerified = await verifyRuntimeGeneration(
          replacement,
          nextRuntimeGeneration,
        );
        if (!replacementVerified && !stopped) {
          throw cliError({
            code: "DEV_RUNTIME_RELOAD_FAILED",
            message:
              "The replacement Eden runtime did not prove the expected immutable generation.",
          });
        }
        await assertChildRunning(replacement);
        if (stopped) {
          replacingRuntime = false;
          return;
        }
        if (!(await awaitRuntimePublicationHook("before-runtime-entry-publish"))) return;
        if (!(await awaitRuntimePublicationHook("after-runtime-entry-publish"))) return;
        if (!(await awaitRuntimePublicationHook("before-runtime-config-publish"))) return;
        if (!(await awaitRuntimePublicationHook("after-runtime-config-publish"))) return;
        if (!(await awaitRuntimePublicationHook("after-runtime-ready"))) return;

        const nextContents = await readRuntimeFileContents(nextRuntimeFiles);
        if (stopped) return;
        const previousChild = child;
        child = replacement;
        replacementChild = undefined;
        childExited = false;
        runtimeContents = nextContents;
        runtimeGeneration = nextRuntimeGeneration;
        runtimeArtifact = nextGeneration;
        temporaryConfig = nextRuntimeFiles.configPath;
        runtimeEntryPath = nextRuntimeFiles.entryPath;
        if (usingDefaultProcessRunner && stateOwner !== undefined) {
          const replacementFullIdentity = await Promise.resolve(replacement.identity);
          const writtenState = await writeDevState(root, replacementFullIdentity);
          statePath = writtenState.path;
          stateOwner = devStateOwner(replacementFullIdentity as EdenCliProcessIdentity, writtenState.token);
          await assertChildRunning(replacement);
          if (stopped) {
            await removeOwnedDevState(root, stateOwner).catch(() => undefined);
            statePath = undefined;
            stateOwner = undefined;
            return;
          }
        }
        nextRuntimePromoted = true;
        replacingRuntime = false;
        notifyRuntimeChange();
        if (previousChild !== undefined && previousChild !== replacement) {
          const previousChildExited = await waitForOwnedProcessExit(
            previousChild,
            OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
            readinessAbortController.signal,
          );
          if (
            !previousChildExited ||
            stopped ||
            ownedValidationProcesses.isStopping()
          ) {
            return;
          }
        }
        if (stopped || ownedValidationProcesses.isStopping()) return;
        if (oldConfig !== undefined) {
          await rm(oldConfig, { force: true }).catch(() => undefined);
          if (stopped || ownedValidationProcesses.isStopping()) return;
        }
        if (oldEntry !== undefined) {
          await rm(oldEntry, { force: true }).catch(() => undefined);
          if (stopped || ownedValidationProcesses.isStopping()) return;
        }
      } catch (error: unknown) {
        const pendingCandidate =
          candidateChild ??
          (replacementChild !== undefined && replacementChild !== child
            ? replacementChild
            : undefined);
        if (pendingCandidate !== undefined) {
          await terminateRuntimeChildOnce(
            pendingCandidate,
            "SIGTERM",
          );
          if (stopped) return;
          if (child === pendingCandidate) {
            child = undefined;
            childExited = true;
          }
          replacementChild = undefined;
          if (!stopped) {
            try {
              await waitForApprovedPortsAvailable();
              if (stopped) return;
            } catch (portError: unknown) {
              markRuntimeUnavailable();
              throw portError;
            }
          }
        }
        let oldRuntimeVerified = false;
        if (!oldRuntimeStopped && pendingCandidate === undefined && !stopped) {
          try {
            oldRuntimeVerified = await verifyRuntimeGeneration(
              child,
              runtimeGeneration,
            );
          } catch {
            oldRuntimeVerified = false;
          }
        }
        if (
          oldRuntimeStopped &&
          pendingCandidate === undefined &&
          !stopped
        ) {
          try {
            await waitForApprovedPortsAvailable(
              5_000,
              readinessAbortController.signal,
            );
          } catch (portError: unknown) {
            markRuntimeUnavailable();
            throw portError;
          }
        }
        const rollbackFiles = oldRuntimeVerified
          ? undefined
          : oldConfig !== undefined && oldEntry !== undefined
            ? {
                configPath: oldConfig,
                entryPath: oldEntry,
              }
            : await createTrackedRuntimeFiles(
                resolvedConfiguration.configPath,
                oldArtifact,
              ).catch(() => undefined);
        if (stopped) return;
        const rollbackFilesOwned =
          rollbackFiles !== undefined &&
          (rollbackFiles.configPath !== oldConfig ||
            rollbackFiles.entryPath !== oldEntry);
        let rollbackChild: EdenCliProcess | undefined;
        let rollbackVerified = false;
        try {
          if (rollbackFiles !== undefined) {
            if (
              !(await awaitRuntimePublicationHook("before-runtime-rollback"))
            ) {
              return;
            }
            const rollback = await startRuntimeChild(rollbackFiles.configPath);
            if (rollback === startupStopped) {
              if (stopped) return;
              throw cliError({
                code: "DEV_RUNTIME_RELOAD_FAILED",
                message:
                  "The last good Eden runtime rollback was interrupted before startup identity verification.",
              });
            }
            rollbackChild = rollback;
            const rollbackIdentity = await Promise.resolve(
              rollback.startIdentity,
            );
            if (
              typeof rollbackIdentity !== "string" ||
              rollbackIdentity.length === 0
            ) {
              throw cliError({
                code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
                message:
                  "The rollback Eden runtime identity could not be verified.",
                source: DEV_STATE_FILE,
              });
            }
            const rollbackReady = await verifyRuntimeGeneration(
              rollback,
              runtimeGeneration,
            );
            if (!rollbackReady && !stopped) {
              throw cliError({
                code: "DEV_RUNTIME_RELOAD_FAILED",
                message:
                  "The last good Eden runtime rollback did not prove its immutable generation.",
              });
            }
            if (!rollbackReady || stopped) return;
            await assertChildRunning(rollback);
            const rollbackContents = await readRuntimeFileContents(
              rollbackFiles,
            );
            if (stopped) return;
            child = rollback;
            replacementChild = undefined;
            childExited = false;
            temporaryConfig = rollbackFiles.configPath;
            runtimeEntryPath = rollbackFiles.entryPath;
            runtimeContents = rollbackContents;
            if (usingDefaultProcessRunner && stateOwner !== undefined) {
              const rollbackFullIdentity = await Promise.resolve(rollback.identity);
              const rollbackState = await writeDevState(root, rollbackFullIdentity);
              statePath = rollbackState.path;
              stateOwner = devStateOwner(rollbackFullIdentity as EdenCliProcessIdentity, rollbackState.token);
              await assertChildRunning(rollback);
              if (stopped) {
                await removeOwnedDevState(root, stateOwner).catch(() => undefined);
                statePath = undefined;
                stateOwner = undefined;
                return;
              }
            }
            rollbackVerified = true;
            notifyRuntimeChange();
          }
        } catch (rollbackError: unknown) {
          const pendingRollback = rollbackChild ?? replacementChild;
          if (pendingRollback !== undefined) {
            await terminateRuntimeChildOnce(
              pendingRollback,
              "SIGTERM",
            );
          }
          replacementChild = undefined;
          if (rollbackFilesOwned && rollbackFiles !== undefined) {
            await rm(rollbackFiles.configPath, { force: true }).catch(
              () => undefined,
            );
            await rm(rollbackFiles.entryPath, { force: true }).catch(
              () => undefined,
            );
          }
          if (stopped) return;
          markRuntimeUnavailable();
          if (statePath !== undefined && stateOwner !== undefined) {
            await removeOwnedDevState(root, stateOwner).catch(
              () => undefined,
            );
            statePath = undefined;
            stateOwner = undefined;
          }
          throw cliError({
            code: "DEV_RUNTIME_RELOAD_FAILED",
            message:
              `The last good Eden runtime could not be restored after replacement failure: ${errorLines(rollbackError).join(" ")}`,
          });
        }
        if (rollbackVerified) {
          replacingRuntime = false;
          notifyRuntimeChange();
          try {
            await awaitRuntimePublicationHook("after-runtime-rollback");
          } catch {
            // Preserve the original replacement failure.
          }
        } else {
          replacingRuntime = false;
          notifyRuntimeChange();
        }
        throw error;
      } finally {
        if (!nextRuntimePromoted) {
          await ownedValidationProcesses.deferCleanup(async () => {
            await rm(nextRuntimeFiles.configPath, { force: true }).catch(
              () => undefined,
            );
            await rm(nextRuntimeFiles.entryPath, { force: true }).catch(
              () => undefined,
            );
          });
        }
      }
      if (stopped || ownedValidationProcesses.isStopping()) return;
      options.stdout?.(
        `Eden dev generation ${nextGeneration.artifacts.buildMetadata.generationId} is coherent.`,
      );
    } catch (error: unknown) {
      if (stopped) return;
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

  const cleanup = (
    timeoutMs = OWNED_PROCESS_CLEANUP_TIMEOUT_MS,
  ): Promise<boolean> => {
    if (cleanupRunning && cleanupPromise !== undefined) return cleanupPromise;
    cleanupRunning = true;
    cleanupPromise = (async () => {
      stopped = true;
      readinessAbortController.abort();
      await ownedValidationProcesses.cleanup(
        requestedSignal,
        Math.min(timeoutMs, CLEANUP_POLL_TIMEOUT_MS),
      );
      if (rebuildTimer !== undefined) {
        clearTimeout(rebuildTimer);
        rebuildTimer = undefined;
      }
      const pendingScheduledRebuild = scheduledRebuild;
      pendingScheduledRebuild?.cancel();
      await closeWatcher(watcher);
      watcher = undefined;

      const cleanupDeadline = Date.now() + timeoutMs;
      while (Date.now() < cleanupDeadline) {
        await waitForSettlements(
          [
            ...rebuildTasks,
            ...[...scheduledRebuilds].map((scheduled) => scheduled.task),
          ],
          Math.min(
            OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
            Math.max(1, cleanupDeadline - Date.now()),
          ),
        );
        const snapshot = [
          child,
          replacementChild,
          ...runtimeChildren,
        ].filter(
          (value, index, values): value is EdenCliProcess =>
            value !== undefined && values.indexOf(value) === index,
        );
        let allChildrenTerminal = true;
        if (snapshot.length === 0) {
          if (rebuildTasks.size === 0 && scheduledRebuilds.size === 0) {
            await ownedValidationProcesses.deferCleanup(
              removeRuntimeOwnedResources,
            );
          }
          break;
        }
        for (const ownedProcess of snapshot) {
          const isCurrentChild = ownedProcess === child;
          if (
            isCurrentChild &&
            childCleanupRequested === false &&
            childExited &&
            startupComplete &&
            requestedStop === false
          ) {
            child = undefined;
            runtimeChildren.delete(ownedProcess);
            continue;
          }
          const identity = await resolveOwnedProcessIdentity(ownedProcess);
          if (identity === undefined) {
            allChildrenTerminal = false;
            continue;
          }
          if (ownedProcess === child) childCleanupRequested = true;
          const settled = await terminateRuntimeChildOnce(
            ownedProcess,
            requestedSignal,
          );
          allChildrenTerminal &&= settled;
          if (settled) {
            if (ownedProcess === child) child = undefined;
            if (ownedProcess === replacementChild) replacementChild = undefined;
            runtimeChildren.delete(ownedProcess);
          }
        }
        await waitForSettlements(
          snapshot.map((ownedProcess) => ownedProcess.exited),
          OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
        );
        const remaining = [child, replacementChild, ...runtimeChildren].filter(
          (value, index, values): value is EdenCliProcess =>
            value !== undefined && values.indexOf(value) === index,
        );
        if (
          remaining.length === 0 &&
          allChildrenTerminal &&
          rebuildTasks.size === 0 &&
          scheduledRebuilds.size === 0 &&
          runtimeTemporaryFiles.size === 0 &&
          statePath === undefined
        ) {
          await ownedValidationProcesses.deferCleanup(
            removeRuntimeOwnedResources,
          );
          break;
        }
      }

      await waitForSettlements(
        [
          ...rebuildTasks,
          ...[...scheduledRebuilds].map((scheduled) => scheduled.task),
        ],
        timeoutMs,
      );
      const rebuildWorkSettled =
        rebuildTasks.size === 0 && scheduledRebuilds.size === 0;
      const validationQuiescent =
        await ownedValidationProcesses.waitForQuiescence();
      const remainingChildren = [
        child,
        replacementChild,
        ...runtimeChildren,
      ].filter(
        (value, index, values): value is EdenCliProcess =>
          value !== undefined && values.indexOf(value) === index,
      );
      if (
        validationQuiescent &&
        remainingChildren.length === 0 &&
        rebuildWorkSettled
      ) {
        await ownedValidationProcesses.deferCleanup(
          removeRuntimeOwnedResources,
        );
      } else {
        void Promise.allSettled([
          ...remainingChildren.map((ownedProcess) => ownedProcess.exited),
          ...rebuildTasks,
          ...[...scheduledRebuilds].map((scheduled) => scheduled.task),
        ]).then(async () => {
          for (const ownedProcess of remainingChildren) {
            if (ownedProcess === child) child = undefined;
            if (ownedProcess === replacementChild) replacementChild = undefined;
            runtimeChildren.delete(ownedProcess);
          }
          const stillRunning = [
            child,
            replacementChild,
            ...runtimeChildren,
          ].some((ownedProcess) => ownedProcess !== undefined);
          if (
            stillRunning ||
            rebuildTasks.size > 0 ||
            scheduledRebuilds.size > 0
          ) {
            return;
          }
          await ownedValidationProcesses.deferCleanup(
            removeRuntimeOwnedResources,
          );
        });
      }
      return (
        validationQuiescent &&
        remainingChildren.length === 0 &&
        rebuildWorkSettled &&
        ownedValidationProcesses.isQuiescent()
      );
    })();
    void cleanupPromise.then(
      () => {
        cleanupRunning = false;
      },
      () => {
        cleanupRunning = false;
      },
    );
    return cleanupPromise;
  };

  const requestStop = (signal: NodeJS.Signals): void => {
    requestedStop = true;
    stopped = true;
    requestedSignal = signal;
    signalResolve?.();
    void cleanup(CLEANUP_POLL_TIMEOUT_MS);
  };
  const stopOnSigint = (): void => requestStop("SIGINT");
  const stopOnSigterm = (): void => requestStop("SIGTERM");
  const stopOnInjectedSignal = (): void => requestStop("SIGTERM");
  const usesProcessSignals = options.stopSignal === undefined;
  if (usesProcessSignals) {
    process.once("SIGINT", stopOnSigint);
    process.once("SIGTERM", stopOnSigterm);
  }
  options.stopSignal?.addEventListener("abort", stopOnInjectedSignal, {
    once: true,
  });
  if (options.stopSignal?.aborted === true) {
    requestStop("SIGTERM");
  }

  let runError: unknown;
  try {
    await (async (): Promise<void> => {
    await readProjectConfiguration(root);
    if (stopped) return;
    await assertApprovedPortsAvailable();
    if (stopped) return;
    const generation = await buildProjectFromCli(
      root,
      options,
      undefined,
      undefined,
      ownedValidationProcesses,
    );
    if (generation === undefined) {
      return;
    }
    if (stopped) return;

    const resolvedConfiguration = await readProjectConfiguration(root);
    if (stopped) return;
    const runtimeFiles = await createTrackedRuntimeFiles(
      resolvedConfiguration.configPath,
      generation,
    );
    if (runtimeFiles === undefined || stopped) return;
    temporaryConfig = runtimeFiles.configPath;
    runtimeEntryPath = runtimeFiles.entryPath;
    runtimeGeneration = readRuntimeGeneration(generation);
    const initialRuntimeContents = await readRuntimeFileContents(runtimeFiles);
    if (stopped) return;
    runtimeContents = initialRuntimeContents;
    runtimeArtifact = generation;
    if (stopped) return;

    const localSecret = process.env.EDEN_BEARER_SECRET;
    if (typeof localSecret !== "string" || localSecret.length === 0) {
      throw cliError({
        code: "DEV_BEARER_REQUIRED",
        message:
          "EDEN_BEARER_SECRET is required for bearer-authenticated local generation verification.",
      });
    }
    localSecretPath = join(tmpdir(), uniqueTemporaryName("eden-dev-vars"));
    if (/[\r\n]/u.test(localSecret)) {
      throw cliError({
        code: "DEV_SECRET_INVALID",
        message:
          "EDEN_BEARER_SECRET must be a non-empty single-line value for local dev.",
      });
    }
    await writeFile(
      localSecretPath,
      `EDEN_BEARER_SECRET=${JSON.stringify(localSecret)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
    if (stopped) return;

    runtimeExecutable = await resolveDeploymentExecutable(root);
    if (stopped) return;

    try {
      const started = await startRuntimeChild(temporaryConfig as string);
      if (started === startupStopped) return;
      if (stopped) return;
      const initialChild = started;
      child = initialChild;
      replacementChild = undefined;
      void initialChild.exited.then(
        () => {
          childExited = true;
        },
        () => {
          childExited = true;
        },
      );
      const startIdentity = await Promise.resolve(initialChild.startIdentity);
      if (stopped) return;
      if (typeof startIdentity !== "string" || startIdentity.length === 0) {
        throw cliError({
          code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
          message:
            "The Eden dev process start identity could not be verified; no PID or process group was signaled.",
          source: DEV_STATE_FILE,
        });
      }
      if (stopped) return;
      const initialGenerationVerified = await initialRuntimeGenerationProof(
        initialChild,
        runtimeGeneration,
      );
      if (!initialGenerationVerified && !stopped) {
        throw cliError({
          code: "DEV_RUNTIME_RELOAD_FAILED",
          message:
            "The initial Eden runtime did not prove the expected immutable generation.",
        });
      }
      if (stopped) return;
      await assertChildRunning(initialChild);
      if (usingDefaultProcessRunner) {
        const initialIdentity = await Promise.resolve(initialChild.identity);
        const writtenState = await writeDevState(root, initialIdentity);
        statePath = writtenState.path;
        stateOwner = devStateOwner(initialIdentity as EdenCliProcessIdentity, writtenState.token);
        await assertChildRunning(initialChild);
      }
      if (stopped) {
        if (stateOwner !== undefined) {
          await removeOwnedDevState(root, stateOwner).catch(() => undefined);
        }
        statePath = undefined;
        stateOwner = undefined;
        return;
      }
      if (stopped) return;
      await assertChildRunning(initialChild);
      startupComplete = true;
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
    if (child === undefined) throw cliError({ code: "DEV_START_FAILED", message: "The Eden dev process exited before watcher startup.", source: DEV_STATE_FILE });
    await assertChildRunning(child);
    watcher = watch(
      [
        join(root, "agent"),
        resolvedConfiguration.packagePath,
        resolvedConfiguration.configPath,
      ],
      {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
      },
    );
    watcher.on("all", () => {
      if (stopped) return;
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
      scheduledRebuild?.cancel();
      let resolveScheduled: (() => void) | undefined;
      let started = false;
      let settled = false;
      const scheduledTask = new Promise<void>((resolve) => {
        resolveScheduled = resolve;
      });
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolveScheduled?.();
        resolveScheduled = undefined;
      };
      const scheduled = {
        task: scheduledTask,
        cancel: (): void => {
          if (!started) {
            settle();
            scheduledRebuilds.delete(scheduled);
            if (scheduledRebuild === scheduled) {
              scheduledRebuild = undefined;
            }
          }
        },
      };
      scheduledRebuilds.add(scheduled);
      scheduledRebuild = scheduled;
      rebuildTimer = setTimeout(() => {
        rebuildTimer = undefined;
        started = true;
        if (stopped) {
          settle();
          scheduledRebuilds.delete(scheduled);
          if (scheduledRebuild === scheduled) scheduledRebuild = undefined;
          return;
        }
        const task = Promise.resolve().then(() => rebuild());
        rebuildTasks.add(task);
        ownedValidationProcesses.trackLateResult(task);
        void task.then(
          () => {
            rebuildTasks.delete(task);
            settle();
            scheduledRebuilds.delete(scheduled);
            if (scheduledRebuild === scheduled) scheduledRebuild = undefined;
          },
          () => {
            rebuildTasks.delete(task);
            settle();
            scheduledRebuilds.delete(scheduled);
            if (scheduledRebuild === scheduled) scheduledRebuild = undefined;
          },
        );
      }, 75);
    });

    if (
      !(await waitForWatcherReady(
        watcher,
        RUNTIME_WATCHER_READY_TIMEOUT_MS,
        readinessAbortController.signal,
      ))
    ) {
      return;
    }

    if (child === undefined) throw cliError({ code: "DEV_START_FAILED", message: "The Eden dev process exited before ready output.", source: DEV_STATE_FILE });
    await assertChildRunning(child);
    options.stdout?.(
      `Eden dev ready at http://${EDEN_LOCAL_HOST}:${EDEN_LOCAL_PORT} ` +
      `(inspector ${EDEN_LOCAL_INSPECTOR_HOST}:${EDEN_LOCAL_INSPECTOR_PORT}).`,
    );

    let exit: EdenCliProcessExit;
    while (true) {
      const observedChild: EdenCliProcess | undefined = child;
      const observedRuntimeChange = runtimeChange;
      const exitResult = await Promise.race<
        | { readonly kind: "exit"; readonly value: EdenCliProcessExit }
        | { readonly kind: "runtime-change" }
        | typeof startupStopped
      >([
        observedChild?.exited.then((value: EdenCliProcessExit) => ({
          kind: "exit" as const,
          value,
        })) ?? Promise.resolve({
          kind: "exit" as const,
          value: { exitCode: 1, signal: null },
        }),
        observedRuntimeChange.then(() => ({ kind: "runtime-change" as const })),
        signalReceived.then(() => startupStopped),
      ]);
      if (exitResult === startupStopped) {
        return;
      }
      if (exitResult.kind === "runtime-change") continue;
      if (observedChild !== child) continue;
      if (replacingRuntime) {
        const replacementResult = await Promise.race([
          observedRuntimeChange.then(() => undefined),
          signalReceived.then(() => startupStopped),
        ]);
        if (replacementResult === startupStopped) {
          return;
        }
        continue;
      }
      exit = exitResult.value;
      break;
    }
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
    })();
  } catch (error: unknown) {
    runError = error;
  } finally {
    if (usesProcessSignals) {
      process.removeListener("SIGINT", stopOnSigint);
      process.removeListener("SIGTERM", stopOnSigterm);
    }
    options.stopSignal?.removeEventListener("abort", stopOnInjectedSignal);
    const quiescent = await cleanup();
    if (!quiescent) {
      const quiescenceDiagnostic: EdenDiagnostic = {
        code: "DEV_QUIESCENCE_TIMEOUT",
        message:
          "Eden dev stopped without proving owned generation, publication, and child work quiescent; owned temporary state was retained.",
        severity: "error",
      };
      if (runError === undefined) {
        runError = cliError({
          code: quiescenceDiagnostic.code,
          message: quiescenceDiagnostic.message,
        });
      } else {
        runError = appendSecondaryDiagnostic(
          runError,
          quiescenceDiagnostic,
        );
      }
    }
  }
  if (runError === undefined) return undefined;
  throw runError;
}

async function readConfiguredWorkerName(
  root: string,
  configPath: string,
  environment: "preview" | "production",
  sourceContents?: string,
): Promise<string | undefined> {
  const snapshotPath = sourceContents === undefined
    ? configPath
    : join(
        dirname(configPath),
        `${uniqueTemporaryName("eden-config-snapshot")}${extname(configPath)}`,
      );
  try {
    if (sourceContents !== undefined) {
      await writeFile(snapshotPath, sourceContents, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    const readConfig = loadInternalConfigReadConfig();
    let config: ReturnType<typeof readConfig>;
    try {
      config = readConfig(
        { config: snapshotPath, env: environment },
        { hideWarnings: true },
      );
    } catch (error: unknown) {
      const reason = error instanceof Error
        ? error.message
        : "the parser returned an unknown error";
      throw cliError({
        code: "PROJECT_CONFIG_INVALID",
        message:
          `The selected deployment configuration could not be parsed for ${environment}: ${reason}. Fix the configuration syntax and retry.`,
        source: toPosixPath(relative(root, configPath)),
      });
    }
    return config.name === undefined
      ? undefined
      : parseWorkerNameValue(config.name);
  } finally {
    if (sourceContents !== undefined) {
      await rm(snapshotPath, { force: true }).catch(() => undefined);
    }
  }
}

async function runDeploy(
  root: string,
  options: EdenCliRunOptions,
  environment: "preview" | "production",
  requestedWorkerName: string | undefined,
): Promise<void> {
  const ownedValidationProcesses = createOwnedProcessRegistry();
  let deploymentLock: DeploymentLockHandle | undefined;
  let requestedSignal: NodeJS.Signals | undefined;
  const usesProcessSignals = options.stopSignal === undefined;
  const requestStop = (signal: NodeJS.Signals): void => {
    requestedSignal ??= signal;
    void ownedValidationProcesses.cleanup(signal, CLEANUP_POLL_TIMEOUT_MS);
  };
  const stopOnSigint = (): void => requestStop("SIGINT");
  const stopOnSigterm = (): void => requestStop("SIGTERM");
  const stopOnInjectedSignal = (): void => requestStop("SIGTERM");
  const removeStopListeners = (): void => {
    if (usesProcessSignals) {
      process.removeListener("SIGINT", stopOnSigint);
      process.removeListener("SIGTERM", stopOnSigterm);
    }
    options.stopSignal?.removeEventListener("abort", stopOnInjectedSignal);
  };
  if (usesProcessSignals) {
    process.on("SIGINT", stopOnSigint);
    process.on("SIGTERM", stopOnSigterm);
  }
  options.stopSignal?.addEventListener("abort", stopOnInjectedSignal, {
    once: true,
  });
  if (options.stopSignal?.aborted === true) {
    requestStop("SIGTERM");
  }
  try {
    deploymentLock = await acquireDeploymentLock(root);
  } catch (error: unknown) {
    removeStopListeners();
    await ownedValidationProcesses.cleanup(
      requestedSignal ?? "SIGTERM",
      CLEANUP_POLL_TIMEOUT_MS,
    );
    throw error;
  }
  if (deploymentLock === undefined) {
    removeStopListeners();
    await ownedValidationProcesses.cleanup(
      requestedSignal ?? "SIGTERM",
      CLEANUP_POLL_TIMEOUT_MS,
    );
    throw cliError({
      code: "DEPLOY_LOCK_UNAVAILABLE",
      message: "The Eden deployment ownership lock could not be acquired.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  const lock: DeploymentLockHandle = deploymentLock;
  const deploymentLeases = new Set<DeploymentLeaseHandle>();
  let deploymentLease: DeploymentLeaseHandle | undefined;
  let releaseDeploymentLockAfterQuiescence: (() => Promise<void>) | undefined;
  const trackedLeaseReleases = new Map<
    DeploymentLeaseHandle,
    Promise<boolean>
  >();
  const deploymentLeaseTerminalBarriers = new Map<
    DeploymentLeaseHandle,
    Promise<void>
  >();
  const remoteTerminalBarriers = new Set<Promise<void>>();
  const registerRemoteTerminal = (barrier: Promise<void>): void => {
    const tracked = barrier.then(
      () => {
        remoteTerminalBarriers.delete(tracked);
      },
      () => {
        // Terminal observations are deliberately non-rejecting. If a test or
        // injected runner violates that invariant, retain the barrier.
      },
    );
    remoteTerminalBarriers.add(tracked);
  };
  const retryTrackedLeaseRelease = (
    lease: DeploymentLeaseHandle,
    scheduleLockCleanup = true,
  ): Promise<boolean> => {
    const existing = trackedLeaseReleases.get(lease);
    if (existing !== undefined) return existing;
    const release = (async (): Promise<boolean> => {
      const terminal = deploymentLeaseTerminalBarriers.get(lease);
      if (terminal !== undefined) {
        const terminalityProven = await Promise.race([
          terminal.then(() => true, () => false),
          new Promise<boolean>((resolveResult) => {
            const timeout = setTimeout(
              () => resolveResult(false),
              CLEANUP_POLL_TIMEOUT_MS,
            );
            timeout.unref?.();
          }),
        ]);
        if (!terminalityProven) return false;
      }
      while (true) {
        const [leaseDetails, lockDetails] = await Promise.all([
          lstat(lease.path).catch(() => undefined),
          lstat(lease.lockPath).catch(() => undefined),
        ]);
        if (leaseDetails === undefined && lockDetails === undefined) {
          return false;
        }
        const removed = await lease.release().catch(() => false);
        if (removed) return true;
        await new Promise<void>((resolveResult) => {
          const retryTimer = setTimeout(resolveResult, 50);
          retryTimer.unref?.();
        });
      }
    })();
    trackedLeaseReleases.set(lease, release);
    ownedValidationProcesses.trackLateResult(
      release.then(
        () => undefined,
        () => undefined,
      ),
    );
    void release.then(() => {
      trackedLeaseReleases.delete(lease);
      if (
        scheduleLockCleanup &&
        releaseDeploymentLockAfterQuiescence !== undefined
      ) {
        void ownedValidationProcesses.deferCleanup(
          releaseDeploymentLockAfterQuiescence,
        );
      }
    });
    return release;
  };
  const assertDeploymentActive = (): void => {
    if (requestedSignal !== undefined) {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          `Eden deploy was cancelled by ${requestedSignal}; no further remote action was started.`,
      });
    }
  };
  let configuration: ProjectConfiguration;
  let generation: EdenArtifactGeneration;
  let deploymentSnapshot: DeploymentSourceSnapshot;
  let deploymentArtifactSnapshotRoot: string | undefined;
  let deploymentArtifactSnapshotFileDigests:
    | DeploymentArtifactSnapshot["fileDigests"]
    | undefined;
  let deploymentRuntimeContents: RuntimeFileContents | undefined;
  const acquireTrackedDeploymentLease = async (): Promise<DeploymentLeaseHandle> => {
    const rawLease = await acquireDeploymentLease(root, lock);
    const trackedLease: DeploymentLeaseHandle = {
      ...rawLease,
      release: async () => {
        const releaseAttempt = rawLease.release().then(
          (released) => released === true,
          () => false,
        );
        ownedValidationProcesses.trackLateResult(
          releaseAttempt.then(() => undefined),
        );
        const released = await releaseAttempt;
        if (released) {
          deploymentLeases.delete(trackedLease);
          deploymentLeaseTerminalBarriers.delete(trackedLease);
          if (deploymentLease === trackedLease) {
            deploymentLease = undefined;
          }
        }
        return released;
      },
    };
    deploymentLeases.add(trackedLease);
    deploymentLease = trackedLease;
    return trackedLease;
  };
  const assertBoundGeneration = async (): Promise<void> => {
    await assertCanonicalGenerationMatches(
      root,
      generation.directory,
      generation.artifacts.buildMetadata.generationId,
      generation.artifacts,
    );
  };
  try {
    configuration = await readProjectConfiguration(root);
    assertDeploymentActive();
    deploymentSnapshot = await captureDeploymentSourceSnapshot(
      root,
      configuration,
    );
    assertDeploymentActive();
    const builtGeneration = await buildProjectFromCli(
      root,
      options,
      environment,
      deploymentSnapshot.fingerprint,
      ownedValidationProcesses,
      undefined,
      requestedWorkerName,
      deploymentSnapshot.configurationContents,
    );
    if (builtGeneration === undefined) {
      assertDeploymentActive();
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          "Eden deploy generation work did not complete before cancellation.",
      });
    }
    generation = builtGeneration;
    assertDeploymentActive();
    await assertBoundGeneration();
    const deploymentArtifactSnapshot =
      await copyDeploymentGenerationSnapshot(root, generation);
    deploymentArtifactSnapshotRoot = deploymentArtifactSnapshot.root;
    deploymentArtifactSnapshotFileDigests =
      deploymentArtifactSnapshot.fileDigests;
    generation = deploymentArtifactSnapshot.generation;
  } catch (error: unknown) {
    removeStopListeners();
    await ownedValidationProcesses.cleanup(
      requestedSignal ?? "SIGTERM",
      CLEANUP_POLL_TIMEOUT_MS,
    );
    releaseDeploymentLockAfterQuiescence = async () => {
      if (deploymentArtifactSnapshotRoot !== undefined) {
        await rm(deploymentArtifactSnapshotRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        deploymentArtifactSnapshotRoot = undefined;
      }
      await lock.release().catch(() => undefined);
    };
    await ownedValidationProcesses.deferCleanup(releaseDeploymentLockAfterQuiescence);
    throw error;
  }
  let runtimeGeneration: RuntimeGeneration;
  let setupRuntimeFiles: RuntimeFiles | undefined;
  let workerName: string;
  try {
    runtimeGeneration = readRuntimeGeneration(generation);
    setupRuntimeFiles = await createRuntimeFiles(
      root,
      configuration.configPath,
      generation,
      "remote",
      undefined,
      deploymentSnapshot.configurationContents,
    );
    deploymentRuntimeContents = await readRuntimeFileContents(setupRuntimeFiles);
    const configuredWorkerName = await readConfiguredWorkerName(
      root,
      configuration.configPath,
      environment,
      deploymentSnapshot.configurationContents,
    );
    workerName = requestedWorkerName ?? configuredWorkerName ?? "";
    if (workerName.length === 0) {
      throw cliError({
        code: "WORKER_NAME_MISSING",
        message:
          "The selected deployment environment must define a Worker name or eden deploy must receive --name.",
      });
    }
  } catch (error: unknown) {
    removeStopListeners();
    await ownedValidationProcesses.cleanup(
      requestedSignal ?? "SIGTERM",
      CLEANUP_POLL_TIMEOUT_MS,
    );
    releaseDeploymentLockAfterQuiescence = async () => {
      if (setupRuntimeFiles !== undefined) {
        await rm(setupRuntimeFiles.configPath, { force: true }).catch(
          () => undefined,
        );
        await rm(setupRuntimeFiles.entryPath, { force: true }).catch(
          () => undefined,
        );
      }
      if (deploymentArtifactSnapshotRoot !== undefined) {
        await rm(deploymentArtifactSnapshotRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        deploymentArtifactSnapshotRoot = undefined;
      }
      await lock.release().catch(() => undefined);
    };
    await ownedValidationProcesses.deferCleanup(releaseDeploymentLockAfterQuiescence);
    throw error;
  }
  const runtimeFiles = setupRuntimeFiles;
  if (runtimeFiles === undefined) {
    removeStopListeners();
    await ownedValidationProcesses.cleanup(
      requestedSignal ?? "SIGTERM",
      CLEANUP_POLL_TIMEOUT_MS,
    );
    releaseDeploymentLockAfterQuiescence = async () => {
      if (deploymentArtifactSnapshotRoot !== undefined) {
        await rm(deploymentArtifactSnapshotRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        deploymentArtifactSnapshotRoot = undefined;
      }
      await lock.release().catch(() => undefined);
    };
    await ownedValidationProcesses.deferCleanup(releaseDeploymentLockAfterQuiescence);
    throw cliError({
      code: "DEPLOY_RUNTIME_UNAVAILABLE",
      message: "The deployment runtime files could not be created.",
    });
  }
  const temporaryConfig = runtimeFiles.configPath;
  if (deploymentRuntimeContents === undefined) {
    removeStopListeners();
    await ownedValidationProcesses.cleanup(
      requestedSignal ?? "SIGTERM",
      CLEANUP_POLL_TIMEOUT_MS,
    );
    releaseDeploymentLockAfterQuiescence = async () => {
      await rm(runtimeFiles.configPath, { force: true }).catch(() => undefined);
      await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
      if (deploymentArtifactSnapshotRoot !== undefined) {
        await rm(deploymentArtifactSnapshotRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        deploymentArtifactSnapshotRoot = undefined;
      }
      await lock.release().catch(() => undefined);
    };
    await ownedValidationProcesses.deferCleanup(releaseDeploymentLockAfterQuiescence);
    throw cliError({
      code: "DEPLOY_RUNTIME_UNAVAILABLE",
      message: "The deployment runtime snapshot could not be read.",
    });
  }
  const assertDeploymentCandidateStable = async (): Promise<void> => {
    assertDeploymentActive();
    await assertDeploymentLockOwned(lock);
    if (deploymentLease !== undefined) {
      await assertDeploymentLeaseOwned(deploymentLease);
    }
    await assertBoundGeneration();
    if (deploymentArtifactSnapshotFileDigests !== undefined) {
      assertArtifactSnapshotStable(
        generation.directory,
        deploymentArtifactSnapshotFileDigests,
      );
    }
    await assertProjectInputsUnchanged(
      root,
      configuration,
      deploymentSnapshot.fingerprint,
      [
        relative(root, temporaryConfig),
        relative(root, runtimeFiles.entryPath),
      ],
    );
    await assertBoundGeneration();
    const currentRuntimeContents = await readRuntimeFileContents(runtimeFiles);
    if (
      currentRuntimeContents.config !== deploymentRuntimeContents.config ||
      currentRuntimeContents.entry !== deploymentRuntimeContents.entry
    ) {
      throw cliError({
        code: "DEPLOYMENT_SNAPSHOT_CHANGED",
        message:
          "The immutable deployment runtime snapshot changed; no stale remote mutation may continue.",
        source: relative(root, temporaryConfig),
      });
    }
    await assertDeploymentLockOwned(lock);
    if (deploymentLease !== undefined) {
      await assertDeploymentLeaseOwned(deploymentLease);
    }
  };
  const assertDeploymentCompatibilityStable = async (): Promise<void> => {
    assertDeploymentActive();
    await assertDeploymentLockOwned(lock);
    await assertBoundGeneration();
    if (deploymentArtifactSnapshotFileDigests !== undefined) {
      assertArtifactSnapshotStable(
        generation.directory,
        deploymentArtifactSnapshotFileDigests,
      );
    }
    const currentRuntimeContents = await readRuntimeFileContents(runtimeFiles);
    if (
      currentRuntimeContents.config !== deploymentRuntimeContents.config ||
      currentRuntimeContents.entry !== deploymentRuntimeContents.entry
    ) {
      throw cliError({
        code: "DEPLOYMENT_SNAPSHOT_CHANGED",
        message:
          "The immutable deployment runtime snapshot changed; no stale remote mutation may continue.",
        source: relative(root, temporaryConfig),
      });
    }
    await assertDeploymentLockOwned(lock);
  };
  const secret = options.remoteBearerSecret ?? process.env.EDEN_BEARER_SECRET;
  const cleanupAuthorizedByExplicitName = requestedWorkerName !== undefined;
  let secretProvisioned = false;
  let deploymentAttempted = false;
  let deploymentUrl: string | undefined;
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
  const deployBoundary = async (
    boundary: EdenDeploymentBoundary,
  ): Promise<void> => {
    await options.deploymentBoundaryHook?.(boundary);
    assertDeploymentActive();
  };
  const runOwnedRemoteMutation = async (
    request: EdenCliRemoteCommandRequest,
    markStarted?: () => void,
  ): Promise<EdenCliRemoteCommandResult> => {
    let preflightCompleted = false;
    let outcome: OwnedRemoteCommandOutcome;
    try {
      outcome = await runRemoteCommand(
        options,
        request,
        ownedValidationProcesses,
        false,
        markStarted,
        markStarted,
        async () => {
          await options.deploymentBoundaryHook?.(
            "before-remote-runner-invocation",
          );
          await assertDeploymentCandidateStable();
        },
        async () => {
          await options.deploymentBoundaryHook?.(
            "after-remote-runner-preflight",
          );
          await assertDeploymentCandidateStable();
          preflightCompleted = true;
        },
        async (terminal) => {
          deploymentLease = await acquireTrackedDeploymentLease();
          deploymentLeaseTerminalBarriers.set(
            deploymentLease,
            terminal,
          );
          await options.deploymentBoundaryHook?.("after-remote-final-read");
          await assertDeploymentLockOwned(lock);
          await assertDeploymentLeaseOwned(deploymentLease);
          return deploymentLease;
        },
        registerRemoteTerminal,
      );
    } catch (error: unknown) {
      const pendingLease = deploymentLease;
      if (pendingLease !== undefined) {
        void retryTrackedLeaseRelease(pendingLease);
      }
      throw error;
    }
    await outcome.waitForTerminal();
    const releasedAfterTerminal = await outcome.releaseLeaseAfterTerminal();
    if (!releasedAfterTerminal) {
      const pendingLease = deploymentLease;
      if (pendingLease !== undefined) {
        void retryTrackedLeaseRelease(pendingLease);
      }
      throw cliError({
        code: "DEPLOY_LEASE_RELEASE_UNPROVEN",
        message:
          "The remote operation became terminal, but its deployment lease could not be identity-preservingly released; local ownership residue was retained.",
        source: DEPLOY_LOCK_FILE,
      });
    }
    if (!preflightCompleted) {
      throw cliError({
        code: "DEPLOYMENT_HANDOFF_INVALID",
        message:
          "The remote deployment runner did not complete its ownership preflight before starting.",
      });
    }
    await assertDeploymentCandidateStable();
    const completedLease = deploymentLease;
    deploymentLease = undefined;
    if (completedLease !== undefined) {
      const released = await retryTrackedLeaseRelease(completedLease);
      if (!released) {
        throw cliError({
          code: "DEPLOY_LEASE_RELEASE_UNPROVEN",
          message:
            "The deployment lease could not be identity-preservingly released; local ownership residue was retained.",
          source: DEPLOY_LOCK_FILE,
        });
      }
    }
    return outcome.result;
  };
  const runOwnedRemoteCleanup = async (
    request: EdenCliRemoteCommandRequest,
  ): Promise<{
    readonly result: EdenCliRemoteCommandResult;
    readonly leaseReleaseFailed: boolean;
  }> => {
    let outcome: OwnedRemoteCommandOutcome;
    try {
      outcome = await runRemoteCommand(
        options,
        request,
        ownedValidationProcesses,
        true,
        undefined,
        undefined,
        () => assertDeploymentLockOwned(lock),
        undefined,
        async (terminal) => {
          deploymentLease = await acquireTrackedDeploymentLease();
          deploymentLeaseTerminalBarriers.set(
            deploymentLease,
            terminal,
          );
          return deploymentLease;
        },
        registerRemoteTerminal,
      );
    } catch (error: unknown) {
      const pendingLease = deploymentLease;
      if (
        pendingLease !== undefined &&
        ownedValidationProcesses.isQuiescent()
      ) {
        deploymentLease = undefined;
        await retryTrackedLeaseRelease(pendingLease);
      }
      throw error;
    }
    await outcome.waitForTerminal();
    const released = await outcome.releaseLeaseAfterTerminal().catch(
      () => false,
    );
    let leaseReleaseFailed = !released;
    if (!released && deploymentLease !== undefined) {
      void retryTrackedLeaseRelease(deploymentLease);
    }
    if (!ownedValidationProcesses.isStopping()) {
      await assertDeploymentLockOwned(lock);
    }
    const completedLease = deploymentLease;
    deploymentLease = undefined;
    if (
      completedLease !== undefined &&
      !outcome.leaseHeldUntilTerminal &&
      released
    ) {
      const completedLeaseReleased = await completedLease.release().catch(
        () => false,
      );
      leaseReleaseFailed ||= !completedLeaseReleased;
      if (!completedLeaseReleased) {
        void retryTrackedLeaseRelease(completedLease);
      }
    }
    return { result: outcome.result, leaseReleaseFailed };
  };
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
        "--name",
        workerName,
        "--config",
        temporaryConfig,
      ],
    };
    await deployBoundary("before-compatibility-dry-run");
    let dryRun: EdenCliDryRunResult;
    try {
      dryRun = await runCompatibilityDryRun(
        options,
        compatibilityRequest,
        ownedValidationProcesses,
        () => assertDeploymentCompatibilityStable(),
        () => assertDeploymentCompatibilityStable(),
      );
    } catch (error: unknown) {
      if (ownedValidationProcesses.isStopping()) {
        throw cliError({
          code: "DEPLOY_CANCELLED",
          message:
            "Eden deploy was cancelled while validating the selected generation.",
        });
      }
      throw cliError({
        code: "WRANGLER_DRY_RUN_FAILED",
        message: error instanceof Error
          ? `Deployment dry-run could not be started: ${error.message}`
          : "Deployment dry-run could not be started.",
      });
    }
    if (ownedValidationProcesses.isStopping()) {
      throw cliError({
        code: "DEPLOY_CANCELLED",
        message:
          "Eden deploy was cancelled while validating the selected generation.",
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
    await deployBoundary("after-compatibility-dry-run");
    await assertDeploymentCandidateStable();
    if (secret === undefined || secret.length === 0) {
      throw cliError({
        code: "REMOTE_SECRET_REQUIRED",
        message:
          "Set EDEN_BEARER_SECRET outside the project before a real deployment.",
      });
    }

    await deployBoundary("before-secret-provision");
    const putSecret = await runOwnedRemoteMutation(
      {
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
      },
      () => {
        secretProvisioned = true;
      },
    );
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
    await deployBoundary("after-secret-provision");
    await assertDeploymentCandidateStable();
    await deployBoundary("before-deploy");
    const deployment = await runOwnedRemoteMutation(
      {
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
      },
      () => {
        deploymentAttempted = true;
      },
    );
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
    await deployBoundary("after-deploy");
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
    await deployBoundary("before-remote-validation");
    const validation = await runBoundedRemoteValidation(
      remoteValidate,
      {
        cwd: root,
        environment,
        workerName,
        url: deploymentUrl,
        expectedGeneration: runtimeGeneration,
      },
      ownedValidationProcesses,
      "mutating",
      registerRemoteTerminal,
    );
    await deployBoundary("after-remote-validation");
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
  } finally {
    const scheduleSerializedCompensation = async (
      requests: readonly EdenCliRemoteCommandRequest[],
    ): Promise<{
      readonly cleanupFailed: boolean;
      readonly leaseReleaseFailed: boolean;
    }> => {
      let cleanupFailed = false;
      let leaseReleaseFailed = false;
      for (const request of requests) {
        while (remoteTerminalBarriers.size > 0) {
          const barriers = [...remoteTerminalBarriers];
          await Promise.all(barriers);
        }
        const outcome = await runOwnedRemoteCleanup(request).catch(() => ({
          result: { exitCode: 1, stdout: "", stderr: "" },
          leaseReleaseFailed: deploymentLeases.size > 0,
        }));
        cleanupFailed ||= outcome.result.exitCode !== 0;
        leaseReleaseFailed ||= outcome.leaseReleaseFailed;
      }
      return { cleanupFailed, leaseReleaseFailed };
    };
    if (
      deploymentFailure !== undefined &&
      (secretProvisioned || deploymentAttempted) &&
      !cleanupAuthorizedByExplicitName
    ) {
      deploymentFailure = appendSecondaryDiagnostic(
        deploymentFailure,
        {
          code: "REMOTE_CLEANUP_SKIPPED_UNOWNED",
          message:
            `Remote cleanup was skipped for configured/shared Worker ${workerName}; only an explicit unique --name authorizes destructive compensation.`,
          source: workerName,
          severity: "error",
        },
      );
    } else if (
      deploymentFailure !== undefined &&
      (secretProvisioned || deploymentAttempted)
    ) {
      const compensationRequests: EdenCliRemoteCommandRequest[] = [];
      if (secretProvisioned) {
        compensationRequests.push({
          kind: "secret-delete",
          cwd: root,
          args: [
            "secret",
            "delete",
            "EDEN_BEARER_SECRET",
            "--name",
            workerName,
            "--config",
            temporaryConfig,
          ],
        });
      }
      if (deploymentAttempted) {
        compensationRequests.push({
          kind: "delete",
          cwd: root,
          args: [
            "delete",
            workerName,
            "--env",
            environment,
            "--config",
            temporaryConfig,
            "--force",
          ],
        });
      }
      const compensation = scheduleSerializedCompensation(compensationRequests);
      const startedOrSettled = await Promise.race([
        compensation.then(() => true),
        new Promise<boolean>((resolveResult) => {
          setTimeout(() => resolveResult(false), CLEANUP_POLL_TIMEOUT_MS);
        }),
      ]);
      if (!startedOrSettled) {
        deploymentFailure = appendSecondaryDiagnostic(
          deploymentFailure,
          {
            code: "REMOTE_CLEANUP_TIMEOUT",
            message:
              `Remote cleanup did not settle within ${CLEANUP_POLL_TIMEOUT_MS}ms; the late remote operation, deployment lock, and lease were retained for manual cleanup.`,
            source: workerName,
            severity: "error",
          },
        );
        ownedValidationProcesses.trackLateResult(
          compensation.then(
            () => undefined,
            () => undefined,
          ),
        );
      } else {
        const compensationResult = await compensation;
        if (compensationResult.cleanupFailed) {
          options.stderr?.(
            `REMOTE_CLEANUP_FAILED: Validation cleanup did not remove every owned ${environment} resource for Worker ${workerName}.`,
          );
        }
        if (compensationResult.leaseReleaseFailed) {
          deploymentFailure = appendSecondaryDiagnostic(
            deploymentFailure,
            {
              code: "REMOTE_CLEANUP_LEASE_RETAINED",
              message:
                `Remote cleanup could not release the deployment lease for Worker ${workerName}; inspect ${DEPLOY_LOCK_FILE} and .eden-deploy-lease-* residue before retrying.`,
              source: DEPLOY_LOCK_FILE,
              severity: "error",
            },
          );
        }
      }
    }
    removeStopListeners();
    await ownedValidationProcesses.cleanup(
      requestedSignal ?? "SIGTERM",
      CLEANUP_POLL_TIMEOUT_MS,
    );
    releaseDeploymentLockAfterQuiescence = async () => {
      let leasesReleased = true;
      for (const lease of [...deploymentLeases]) {
        const released = await retryTrackedLeaseRelease(lease, false);
        leasesReleased &&= released;
      }
      if (!leasesReleased || deploymentLeases.size > 0) {
        return;
      }
      deploymentLease = undefined;
      await rm(temporaryConfig, { force: true }).catch(() => undefined);
      await rm(runtimeFiles.entryPath, { force: true }).catch(() => undefined);
      if (deploymentArtifactSnapshotRoot !== undefined) {
        await rm(deploymentArtifactSnapshotRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        deploymentArtifactSnapshotRoot = undefined;
      }
      await lock.release().catch(() => false);
    };
    await ownedValidationProcesses.deferCleanup(releaseDeploymentLockAfterQuiescence);
  }
  if (deploymentFailure !== undefined) throw deploymentFailure;
}

async function runBuild(
  root: string,
  options: EdenCliRunOptions,
): Promise<void> {
  const ownedValidationProcesses = createOwnedProcessRegistry();
  let requestedSignal: NodeJS.Signals = "SIGTERM";
  const usesProcessSignals = options.stopSignal === undefined;
  const requestStop = (signal: NodeJS.Signals): void => {
    requestedSignal = signal;
    void ownedValidationProcesses.cleanup(signal, CLEANUP_POLL_TIMEOUT_MS);
  };
  const stopOnSigint = (): void => requestStop("SIGINT");
  const stopOnSigterm = (): void => requestStop("SIGTERM");
  const stopOnInjectedSignal = (): void => requestStop("SIGTERM");
  if (usesProcessSignals) {
    process.on("SIGINT", stopOnSigint);
    process.on("SIGTERM", stopOnSigterm);
  }
  options.stopSignal?.addEventListener("abort", stopOnInjectedSignal, {
    once: true,
  });
  if (options.stopSignal?.aborted === true) {
    requestStop("SIGTERM");
  }
  try {
    await buildProjectFromCli(
      root,
      options,
      undefined,
      undefined,
      ownedValidationProcesses,
    );
  } finally {
    if (usesProcessSignals) {
      process.removeListener("SIGINT", stopOnSigint);
      process.removeListener("SIGTERM", stopOnSigterm);
    }
    options.stopSignal?.removeEventListener("abort", stopOnInjectedSignal);
    await ownedValidationProcesses.cleanup(
      requestedSignal,
      CLEANUP_POLL_TIMEOUT_MS,
    );
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
      await runBuild(root, options);
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

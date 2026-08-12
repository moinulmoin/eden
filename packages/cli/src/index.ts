#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import {
  existsSync,
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
  homedir,
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
   * Internal finite-test override for the authenticated local runtime
   * readiness probe. Production callers use the bounded default.
   */
  readonly runtimeReadinessTimeoutMs?: number;
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
  | "before-target-publish"
  | "after-target-publish"
  | "before-stale-lock-removal"
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

interface InitPublicationLockState {
  readonly kind: "eden.init.lock";
  readonly version: 1;
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

const INIT_STATE_FILE = ".eden-init-incomplete.json";
const INIT_LOCK_FILE = ".eden-init.lock";
const DEPLOY_LOCK_FILE = ".eden-deploy.lock";
const DEPLOY_LOCK_QUARANTINE_PATTERN =
  /^\.eden-deploy-(?:stale-lock|release-lock)-[0-9]+-[a-f0-9-]+$/u;
const INIT_QUARANTINE_TOKEN_PATTERN =
  /[A-Za-z0-9][A-Za-z0-9._-]*/u;
const INIT_LOCK_QUARANTINE_PATTERN =
  new RegExp(
    `^\\.eden-init-(?:stale-lock|release-lock|recovery)-[0-9]+-(${INIT_QUARANTINE_TOKEN_PATTERN.source})-([a-f0-9]{64})$`,
    "u",
  );
const INIT_PROVENANCE_DIRECTORY = join(
  homedir(),
  `.eden-init-provenance-${process.getuid?.() ?? "user"}`,
);
const INIT_PROVENANCE_KEY_PATH = join(
  INIT_PROVENANCE_DIRECTORY,
  "key",
);
const INIT_PROVENANCE_RECORD_PATTERN =
  /^[a-f0-9]{64}-[0-9a-f-]{36}\.json$/u;
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

function isContainedPath(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return (
    candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}/`) ||
    candidate.startsWith(`${normalizedRoot}\\`)
  );
}

function parseInitPublicationLockState(
  value: unknown,
): InitPublicationLockState | undefined {
  if (
    !isRecord(value) ||
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

function initQuarantineAuthToken(serialized: string): string {
  return sha256(serialized);
}

interface InitFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface InitFileObservation {
  readonly identity: InitFileIdentity;
  readonly serialized: string;
}

interface InitQuarantineProvenance {
  readonly recordPath: string;
  readonly recordObservation: InitFileObservation;
  readonly record: InitProvenanceRecord;
  readonly expectedObservation: InitFileObservation;
}

interface InitProvenanceRecord {
  readonly kind: "eden.init.provenance";
  readonly version: 1;
  readonly root: string;
  readonly operation: "stale-lock" | "release-lock" | "recovery";
  readonly sourceName: string;
  readonly quarantineName: string;
  readonly recoveryName: string;
  readonly lockDigest: string;
  readonly sourceDev: number;
  readonly sourceIno: number;
  readonly mac: string;
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

function initProvenanceMessage(
  root: string,
  record: Omit<InitProvenanceRecord, "mac">,
): string {
  return [
    sha256(root),
    record.operation,
    record.sourceName,
    record.quarantineName,
    record.recoveryName,
    record.lockDigest,
    String(record.sourceDev),
    String(record.sourceIno),
  ].join("\n");
}

function initProvenanceMac(
  key: Uint8Array,
  root: string,
  record: Omit<InitProvenanceRecord, "mac">,
): string {
  return createHmac("sha256", key)
    .update(initProvenanceMessage(root, record))
    .digest("hex");
}

async function initProvenanceKey(): Promise<Buffer> {
  try {
    await mkdir(INIT_PROVENANCE_DIRECTORY, { recursive: true, mode: 0o700 });
  } catch {
    throw initBusy(
      "The Eden init provenance directory could not be created safely; ownership state was preserved.",
      INIT_PROVENANCE_DIRECTORY,
    );
  }
  const directoryDetails = await lstat(INIT_PROVENANCE_DIRECTORY).catch(
    (error: unknown) => {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") return undefined;
      throw initBusy(
        "The Eden init provenance directory could not be inspected safely; ownership state was preserved.",
        INIT_PROVENANCE_DIRECTORY,
      );
    },
  );
  if (
    directoryDetails === undefined ||
    !directoryDetails.isDirectory() ||
    directoryDetails.isSymbolicLink()
  ) {
    throw initBusy(
      "The Eden init provenance directory was not a regular directory; ownership state was preserved.",
      INIT_PROVENANCE_DIRECTORY,
    );
  }
  const existing = await readFile(INIT_PROVENANCE_KEY_PATH).catch(
    (error: unknown) => {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") return undefined;
      throw initBusy(
        "The Eden init provenance key could not be read safely; ownership state was preserved.",
        INIT_PROVENANCE_KEY_PATH,
      );
    },
  );
  if (existing !== undefined) {
    const details = await lstat(INIT_PROVENANCE_KEY_PATH).catch(
      (error: unknown) => {
        const code = error as NodeJS.ErrnoException;
        if (code.code === "ENOENT") return undefined;
        throw initBusy(
          "The Eden init provenance key could not be inspected safely; ownership state was preserved.",
          INIT_PROVENANCE_KEY_PATH,
        );
      },
    );
    if (
      details === undefined ||
      !details.isFile() ||
      details.isSymbolicLink()
    ) {
      throw initBusy(
        "The Eden init provenance key was not a regular file; ownership state was preserved.",
        INIT_PROVENANCE_KEY_PATH,
      );
    }
    if (existing.length !== 32) {
      throw initBusy(
        "The Eden init provenance key was malformed; ownership state was preserved.",
        INIT_PROVENANCE_KEY_PATH,
      );
    }
    return existing;
  }
  const key = randomBytes(32);
  try {
    await writeFile(INIT_PROVENANCE_KEY_PATH, key, {
      mode: 0o600,
      flag: "wx",
    });
    return key;
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== "EEXIST") {
      throw initBusy(
        "The Eden init provenance key could not be created safely; ownership state was preserved.",
        INIT_PROVENANCE_KEY_PATH,
      );
    }
    const raced = await readFile(INIT_PROVENANCE_KEY_PATH).catch(
      (readError: unknown) => {
        const readCode = readError as NodeJS.ErrnoException;
        if (readCode.code === "ENOENT") return undefined;
        throw initBusy(
          "The Eden init provenance key could not be read safely; ownership state was preserved.",
          INIT_PROVENANCE_KEY_PATH,
        );
      },
    );
    if (raced === undefined || raced.length !== 32) {
      throw initBusy(
        "The Eden init provenance key was unavailable after concurrent creation; ownership state was preserved.",
        INIT_PROVENANCE_KEY_PATH,
      );
    }
    const racedDetails = await lstat(INIT_PROVENANCE_KEY_PATH).catch(
      (readError: unknown) => {
        const readCode = readError as NodeJS.ErrnoException;
        if (readCode.code === "ENOENT") return undefined;
        throw initBusy(
          "The Eden init provenance key could not be inspected safely; ownership state was preserved.",
          INIT_PROVENANCE_KEY_PATH,
        );
      },
    );
    if (
      racedDetails === undefined ||
      !racedDetails.isFile() ||
      racedDetails.isSymbolicLink()
    ) {
      throw initBusy(
        "The Eden init provenance key was not a regular file; ownership state was preserved.",
        INIT_PROVENANCE_KEY_PATH,
      );
    }
    return raced;
  }
}

async function readInitFileObservation(
  path: string,
  source: string,
): Promise<InitFileObservation | undefined> {
  const before = await lstat(path).catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init ownership record could not be inspected safely and was preserved.",
      source,
    );
  });
  if (before === undefined) return undefined;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw initBusy(
      "The init ownership record was not a regular file and was preserved.",
      source,
    );
  }
  const serialized = await readFile(path, "utf8").catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init ownership record could not be read safely and was preserved.",
      source,
    );
  });
  if (serialized === undefined) return undefined;
  const after = await lstat(path).catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init ownership record changed while it was being read and was preserved.",
      source,
    );
  });
  if (after === undefined) return undefined;
  const reread = await readFile(path, "utf8").catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init ownership record changed while it was being read and was preserved.",
      source,
    );
  });
  if (reread === undefined) return undefined;
  const final = await lstat(path).catch((error: unknown) => {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return undefined;
    throw initBusy(
      "The init ownership record changed while it was being read and was preserved.",
      source,
    );
  });
  if (final === undefined) return undefined;
  if (
    !sameInitFileIdentity(
      { dev: before.dev, ino: before.ino },
      { dev: final.dev, ino: final.ino },
    ) ||
    before.size !== final.size ||
    serialized !== reread
  ) {
    throw initBusy(
      "The init ownership record changed while it was being read and was preserved.",
      source,
    );
  }
  return {
    identity: { dev: before.dev, ino: before.ino },
    serialized,
  };
}

function initQuarantinePath(
  root: string,
  kind: "stale-lock" | "release-lock" | "recovery",
  pid: number,
  token: string,
  serialized: string,
): string {
  return join(
    root,
    `.eden-init-${kind}-${pid}-${token}-${initQuarantineAuthToken(serialized)}`,
  );
}

function quarantineNameAuth(
  entry: string,
): {
  readonly kind: "stale-lock" | "release-lock" | "recovery";
  readonly token: string;
  readonly digest: string;
} | undefined {
  const match = INIT_LOCK_QUARANTINE_PATTERN.exec(entry);
  if (match === null) return undefined;
  const kind = entry.startsWith(".eden-init-stale-lock-")
    ? "stale-lock"
    : entry.startsWith(".eden-init-release-lock-")
      ? "release-lock"
      : "recovery";
  return {
    kind,
    token: match[1] as string,
    digest: match[2] as string,
  };
}

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

async function readInitPublicationLockState(
  path: string,
): Promise<{
  readonly state: InitPublicationLockState;
  readonly serialized: string;
  readonly observation: InitFileObservation;
} | undefined> {
  const observation = await readInitFileObservation(path, basename(path));
  if (observation === undefined) return undefined;
  const { serialized } = observation;
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw initBusy(
      "Another Eden init owns scaffold publication; the malformed lock was preserved.",
      basename(path),
    );
  }
  const state = parseInitPublicationLockState(value);
  if (state === undefined) {
    throw initBusy(
      "Another Eden init owns scaffold publication; the malformed lock was preserved.",
      basename(path),
    );
  }
  return { state, serialized, observation };
}

async function initLockOwnerIsActive(
  state: InitPublicationLockState,
): Promise<boolean> {
  const ownerStart = await readProcessStartTime(state.pid);
  if (ownerStart === state.startedAt) return true;
  if (ownerStart === undefined && isProcessAlive(state.pid)) return true;
  return false;
}

function parseInitProvenanceRecord(
  value: unknown,
): InitProvenanceRecord | undefined {
  if (
    !isRecord(value) ||
    value.kind !== "eden.init.provenance" ||
    value.version !== 1 ||
    typeof value.root !== "string" ||
    (value.operation !== "stale-lock" &&
      value.operation !== "release-lock" &&
      value.operation !== "recovery") ||
    typeof value.sourceName !== "string" ||
    typeof value.quarantineName !== "string" ||
    typeof value.recoveryName !== "string" ||
    typeof value.lockDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.lockDigest) ||
    typeof value.sourceDev !== "number" ||
    !Number.isSafeInteger(value.sourceDev) ||
    value.sourceDev < 0 ||
    typeof value.sourceIno !== "number" ||
    !Number.isSafeInteger(value.sourceIno) ||
    value.sourceIno < 0 ||
    typeof value.mac !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.mac)
  ) {
    return undefined;
  }
  return {
    kind: "eden.init.provenance",
    version: 1,
    root: value.root,
    operation: value.operation,
    sourceName: value.sourceName,
    quarantineName: value.quarantineName,
    recoveryName: value.recoveryName,
    lockDigest: value.lockDigest,
    sourceDev: value.sourceDev,
    sourceIno: value.sourceIno,
    mac: value.mac,
  };
}

async function readInitProvenance(
  path: string,
  root: string,
  expected: InitFileObservation,
): Promise<InitQuarantineProvenance | undefined> {
  const recordObservation = await readInitFileObservation(path, basename(path));
  if (recordObservation === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(recordObservation.serialized) as unknown;
  } catch {
    throw initBusy(
      "The Eden init provenance record was malformed and was preserved.",
      basename(path),
    );
  }
  const record = parseInitProvenanceRecord(value);
  if (record === undefined) {
    throw initBusy(
      "The Eden init provenance record was malformed and was preserved.",
      basename(path),
    );
  }
  if (record.root !== root) return undefined;
  if (
    record.lockDigest !== sha256(expected.serialized) ||
    record.sourceDev !== expected.identity.dev ||
    record.sourceIno !== expected.identity.ino
  ) {
    return undefined;
  }
  const expectedMac = initProvenanceMac(
    await initProvenanceKey(),
    root,
    record,
  );
  const actualMac = Buffer.from(record.mac, "hex");
  if (
    actualMac.length !== 32 ||
    !timingSafeEqual(Buffer.from(expectedMac, "hex"), actualMac)
  ) {
    throw initBusy(
      "The Eden init provenance record was not authenticated by Eden and was preserved.",
      basename(path),
    );
  }
  return {
    recordPath: path,
    recordObservation,
    record,
    expectedObservation: expected,
  };
}

async function createInitProvenance(
  root: string,
  operation: InitProvenanceRecord["operation"],
  sourceName: string,
  quarantineName: string,
  recoveryName: string,
  expected: InitFileObservation,
): Promise<InitQuarantineProvenance> {
  const sourceEntry = basename(sourceName);
  const quarantineEntry = basename(quarantineName);
  const recoveryEntry = basename(recoveryName);
  const recordWithoutMac: Omit<InitProvenanceRecord, "mac"> = {
    kind: "eden.init.provenance",
    version: 1,
    root,
    operation,
    sourceName: sourceEntry,
    quarantineName: quarantineEntry,
    recoveryName: recoveryEntry,
    lockDigest: sha256(expected.serialized),
    sourceDev: expected.identity.dev,
    sourceIno: expected.identity.ino,
  };
  const record: InitProvenanceRecord = {
    ...recordWithoutMac,
    mac: initProvenanceMac(
      await initProvenanceKey(),
      root,
      recordWithoutMac,
    ),
  };
  const recordPath = join(
    INIT_PROVENANCE_DIRECTORY,
    `${sha256(root)}-${randomUUID()}.json`,
  );
  const serialized = `${JSON.stringify(record)}\n`;
  try {
    await writeFile(recordPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    throw initBusy(
      "The Eden init provenance record could not be created safely; ownership state was preserved.",
      basename(recordPath),
    );
  }
  const observed = await readInitProvenance(recordPath, root, expected);
  if (observed === undefined) {
    throw initBusy(
      "The Eden init provenance record disappeared before verification; ownership state was preserved.",
      basename(recordPath),
    );
  }
  return observed;
}

async function findInitProvenance(
  root: string,
  expected: InitFileObservation,
  quarantineName: string,
): Promise<InitQuarantineProvenance> {
  const entries = await readdir(INIT_PROVENANCE_DIRECTORY).catch(
    (error: unknown) => {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") return [];
      throw initBusy(
        "The init provenance records could not be inspected safely; ownership state was preserved.",
        quarantineName,
      );
    },
  );
  const matches: InitQuarantineProvenance[] = [];
  const rootPrefix = `${sha256(root)}-`;
  for (const entry of entries) {
    if (
      !INIT_PROVENANCE_RECORD_PATTERN.test(entry) ||
      !entry.startsWith(rootPrefix)
    ) {
      continue;
    }
    const provenance = await readInitProvenance(
      join(INIT_PROVENANCE_DIRECTORY, entry),
      root,
      expected,
    );
    if (
      provenance !== undefined &&
      (provenance.record.quarantineName === basename(quarantineName) ||
        provenance.record.recoveryName === basename(quarantineName))
    ) {
      matches.push(provenance);
    }
  }
  if (matches.length !== 1) {
    throw initBusy(
      "The init-lock quarantine has no unique Eden-authenticated provenance record; its state was preserved.",
      quarantineName,
    );
  }
  return matches[0] as InitQuarantineProvenance;
}

async function ensureInitProvenance(
  root: string,
  operation: InitProvenanceRecord["operation"],
  sourceName: string,
  quarantineName: string,
  recoveryName: string,
  expected: InitFileObservation,
): Promise<InitQuarantineProvenance> {
  const entries = await readdir(INIT_PROVENANCE_DIRECTORY).catch(
    (error: unknown) => {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT") return [];
      throw initBusy(
        "The init provenance records could not be inspected safely; ownership state was preserved.",
        quarantineName,
      );
    },
  );
  const rootPrefix = `${sha256(root)}-`;
  const matches: InitQuarantineProvenance[] = [];
  for (const entry of entries) {
    if (
      !INIT_PROVENANCE_RECORD_PATTERN.test(entry) ||
      !entry.startsWith(rootPrefix)
    ) {
      continue;
    }
    const provenance = await readInitProvenance(
      join(INIT_PROVENANCE_DIRECTORY, entry),
      root,
      expected,
    );
    if (
      provenance !== undefined &&
      provenance.record.operation === operation &&
      provenance.record.sourceName === basename(sourceName) &&
      (provenance.record.quarantineName === basename(quarantineName) ||
        provenance.record.recoveryName === basename(recoveryName))
    ) {
      matches.push(provenance);
    }
  }
  if (matches.length > 1) {
    throw initBusy(
      "The init ownership record has ambiguous Eden provenance; its state was preserved.",
      basename(quarantineName),
    );
  }
  if (matches.length === 1) return matches[0] as InitQuarantineProvenance;
  return createInitProvenance(
    root,
    operation,
    sourceName,
    quarantineName,
    recoveryName,
    expected,
  );
}

async function removeInitFileExact(
  path: string,
  expected: InitFileObservation,
  source: string,
): Promise<boolean> {
  const observed = await readInitFileObservation(path, source);
  if (observed === undefined) return false;
  if (!sameInitFileObservation(observed, expected)) {
    throw initBusy(
      "The init ownership record changed before removal; the replacement was preserved.",
      source,
    );
  }
  try {
    await rm(path, { force: false });
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return false;
    throw initBusy(
      "The init ownership record could not be removed safely; its state was preserved.",
      source,
    );
  }
  const after = await readInitFileObservation(path, source);
  if (after !== undefined) {
    throw initBusy(
      "The init ownership record remained present after removal; its state was preserved.",
      source,
    );
  }
  return true;
}

async function removeInitFileAfterExactRecheck(
  path: string,
  expected: InitFileObservation,
  source: string,
): Promise<boolean> {
  const current = await readInitFileObservation(path, source);
  if (current === undefined) return false;
  if (!sameInitFileObservation(current, expected)) {
    throw initBusy(
      "The init ownership record changed before removal; the replacement was preserved.",
      source,
    );
  }
  return removeInitFileExact(path, current, source);
}

async function removeInitProvenanceRecord(
  provenance: InitQuarantineProvenance,
): Promise<void> {
  await removeInitFileAfterExactRecheck(
    provenance.recordPath,
    provenance.recordObservation,
    basename(provenance.recordPath),
  );
}

async function linkInitFileNoReplace(
  sourcePath: string,
  destinationPath: string,
  expected: InitFileObservation,
  source: string,
): Promise<boolean> {
  const sourceObservation = await readInitFileObservation(sourcePath, source);
  if (sourceObservation === undefined) {
    return false;
  }
  if (!sameInitFileObservation(sourceObservation, expected)) {
    throw initBusy(
      "The init ownership record changed before its transition; the replacement was preserved.",
      source,
    );
  }
  try {
    await link(sourcePath, destinationPath);
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return false;
    if (code.code === "EEXIST") {
      throw initBusy(
        "The init ownership transition destination already exists; its state was preserved.",
        basename(destinationPath),
      );
    }
    throw initBusy(
      "The init ownership transition could not be created safely; its state was preserved.",
      source,
    );
  }
  const destinationObservation = await readInitFileObservation(
    destinationPath,
    basename(destinationPath),
  );
  if (
    destinationObservation === undefined ||
    !sameInitFileObservation(destinationObservation, expected)
  ) {
    if (destinationObservation === undefined) {
      return false;
    }
    throw initBusy(
      "The init ownership transition changed before it could be committed; its state was preserved.",
      basename(destinationPath),
    );
  }
  return true;
}

async function moveInitFileNoReplace(
  sourcePath: string,
  destinationPath: string,
  expected: InitFileObservation,
  source: string,
): Promise<boolean> {
  const linked = await linkInitFileNoReplace(
    sourcePath,
    destinationPath,
    expected,
    source,
  );
  if (!linked) return false;
  const sourceObservation = await readInitFileObservation(sourcePath, source);
  if (sourceObservation === undefined) {
    const destinationObservation = await readInitFileObservation(
      destinationPath,
      basename(destinationPath),
    );
    if (destinationObservation !== undefined) {
      throw initBusy(
        "The init ownership transition source disappeared before removal; its destination was preserved.",
        basename(destinationPath),
      );
    }
    return false;
  }
  if (!sameInitFileObservation(sourceObservation, expected)) {
    throw initBusy(
      "The init ownership transition source changed before removal; the replacement was preserved.",
      source,
    );
  }
  await removeInitFileAfterExactRecheck(sourcePath, expected, source);
  return true;
}

async function restoreInitLockQuarantine(
  quarantinePath: string,
  lockPath: string,
  expected: InitFileObservation,
  provenance: InitQuarantineProvenance,
): Promise<void> {
  const observed = await readInitFileObservation(
    quarantinePath,
    basename(quarantinePath),
  );
  if (observed === undefined) return;
  if (!sameInitFileObservation(observed, expected)) {
    throw initBusy(
      "The init-lock quarantine changed during restoration; its state was preserved.",
      basename(quarantinePath),
    );
  }
  const restored = await moveInitFileNoReplace(
    quarantinePath,
    lockPath,
    expected,
    basename(quarantinePath),
  );
  if (restored) {
    await removeInitFileAfterExactRecheck(
      provenance.recordPath,
      provenance.recordObservation,
      basename(provenance.recordPath),
    );
  }
}

/**
 * A stale-lock owner can be SIGKILLed after the lock has been atomically
 * renamed out of the root name. Quarantine files are deliberately discoverable
 * and token-checked so the next initializer can remove only the exact stale
 * lock it observed, rather than treating every root entry as user content or
 * deleting a replacement lock.
 */
async function recoverInitLockQuarantines(
  root: string,
): Promise<void> {
  const entries = await readdir(root);
  for (const entry of entries) {
    if (!INIT_LOCK_QUARANTINE_PATTERN.test(entry)) continue;
    const quarantinePath = join(root, entry);
    assertWithinRoot(
      root,
      quarantinePath,
      "The init-lock recovery quarantine path",
    );
    const nameAuth = quarantineNameAuth(entry);
    if (nameAuth === undefined) {
      throw initBusy(
        "The init-lock quarantine filename could not be authenticated; it was preserved.",
        entry,
      );
    }
    const parsed = await readInitPublicationLockState(quarantinePath);
    if (parsed === undefined) continue;
    const { state, serialized, observation } = parsed;
    if (
      state.token !== nameAuth.token ||
      initQuarantineAuthToken(serialized) !== nameAuth.digest
    ) {
      throw initBusy(
        "The init-lock quarantine ownership token did not match its authenticated filename; it was preserved.",
        entry,
      );
    }
    const provenance = await findInitProvenance(root, observation, entry);
    if (await initLockOwnerIsActive(state)) {
      throw initBusy(
        "Another Eden init is publishing the scaffold; retry after it completes.",
        entry,
      );
    }
    await removeInitFileAfterExactRecheck(
      quarantinePath,
      observation,
      entry,
    );
    await removeInitFileAfterExactRecheck(
      provenance.recordPath,
      provenance.recordObservation,
      basename(provenance.recordPath),
    );
  }
}

async function acquireInitPublicationLock(
  root: string,
  hook?: EdenCliRunOptions["initPublicationHook"],
): Promise<{ readonly release: () => Promise<void> }> {
  const lockPath = join(root, INIT_LOCK_FILE);
  const startedAt = await readProcessStartTime(process.pid);
  if (startedAt === undefined) {
    throw cliError({
      code: "INIT_PROCESS_IDENTITY_UNAVAILABLE",
      message:
        "The Eden init process start identity could not be verified; scaffold lock ownership is disabled.",
      source: INIT_LOCK_FILE,
    });
  }
  await recoverInitLockQuarantines(root);
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
      const owned = await readInitPublicationLockState(lockPath);
      if (owned === undefined) {
        throw initBusy(
          "The init lock disappeared before ownership could be recorded; its state was preserved.",
          INIT_LOCK_FILE,
        );
      }
      return {
        release: async () => {
          const releaseQuarantine = initQuarantinePath(
            root,
            "release-lock",
            state.pid,
            state.token,
            serialized,
          );
          assertWithinRoot(
            root,
            releaseQuarantine,
            "The init-lock release quarantine path",
          );
          const currentLock = await readInitPublicationLockState(lockPath);
          if (currentLock === undefined) return;
          if (
            currentLock.serialized !== serialized ||
            currentLock.state.pid !== state.pid ||
            currentLock.state.startedAt !== state.startedAt ||
            currentLock.state.token !== state.token
          ) {
            return;
          }
          const provenance = await ensureInitProvenance(
            root,
            "release-lock",
            INIT_LOCK_FILE,
            releaseQuarantine,
            releaseQuarantine,
            owned.observation,
          );
          const moved = await moveInitFileNoReplace(
            lockPath,
            releaseQuarantine,
            owned.observation,
            INIT_LOCK_FILE,
          );
          if (!moved) return;
          const movedObservation = await readInitFileObservation(
            releaseQuarantine,
            basename(releaseQuarantine),
          );
          if (
            movedObservation === undefined ||
            !sameInitFileObservation(movedObservation, owned.observation)
          ) {
            await restoreInitLockQuarantine(
              releaseQuarantine,
              lockPath,
              owned.observation,
              provenance,
            );
            return;
          }
          await removeInitFileAfterExactRecheck(
            releaseQuarantine,
            movedObservation,
            basename(releaseQuarantine),
          );
          await removeInitProvenanceRecord(provenance);
          return;
        },
      };
    } catch (error: unknown) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "EEXIST") throw error;
      const parsedExisting = await readInitPublicationLockState(lockPath);
      if (parsedExisting === undefined) continue;
      const {
        state: existingLock,
        serialized: existing,
        observation,
      } = parsedExisting;
      const ownerStart = await readProcessStartTime(existingLock.pid);
      if (ownerStart === existingLock.startedAt) {
        throw initBusy(
          "Another Eden init is publishing the scaffold; retry after it completes.",
          INIT_LOCK_FILE,
        );
      }
      if (
        ownerStart === undefined &&
        isProcessAlive(existingLock.pid)
      ) {
        throw initBusy(
          "Another Eden init owns scaffold publication but its start identity could not be verified.",
          INIT_LOCK_FILE,
        );
      }
      const latest = await readInitPublicationLockState(lockPath);
      if (
        latest === undefined ||
        latest.serialized !== existing ||
        !sameInitFileObservation(latest.observation, observation)
      ) continue;
      const staleLockQuarantine = initQuarantinePath(
        root,
        "stale-lock",
        existingLock.pid,
        existingLock.token,
        existing,
      );
      assertWithinRoot(
        root,
        staleLockQuarantine,
        "The stale init-lock quarantine path",
      );
      const provenance = await ensureInitProvenance(
        root,
        "stale-lock",
        INIT_LOCK_FILE,
        staleLockQuarantine,
        initQuarantinePath(
          root,
          "recovery",
          existingLock.pid,
          existingLock.token,
          existing,
        ),
        observation,
      );
      const quarantined = await moveInitFileNoReplace(
        lockPath,
        staleLockQuarantine,
        observation,
        INIT_LOCK_FILE,
      );
      if (!quarantined) continue;
      await hook?.("before-stale-lock-removal");
      const moved = await readInitPublicationLockState(staleLockQuarantine);
      if (moved === undefined) {
        const replacement = await readInitFileObservation(
          staleLockQuarantine,
          basename(staleLockQuarantine),
        );
        if (replacement !== undefined) {
          throw initBusy(
            "The init-lock quarantine changed before removal; its replacement was preserved.",
            basename(staleLockQuarantine),
          );
        }
        continue;
      }
      if (
        moved.serialized !== existing ||
        moved.state.pid !== existingLock.pid ||
        moved.state.startedAt !== existingLock.startedAt ||
        moved.state.token !== existingLock.token ||
        !sameInitFileObservation(moved.observation, observation)
      ) {
        await restoreInitLockQuarantine(
          staleLockQuarantine,
          lockPath,
          observation,
          provenance,
        );
        throw initBusy(
          "The stale init lock changed while it was being quarantined; the replacement was preserved.",
          INIT_LOCK_FILE,
        );
      }
      if (await initLockOwnerIsActive(existingLock)) {
        await restoreInitLockQuarantine(
          staleLockQuarantine,
          lockPath,
          observation,
          provenance,
        );
        throw initBusy(
          "Another Eden init became active while its lock was being quarantined; the lock was preserved.",
          INIT_LOCK_FILE,
        );
      }
      await removeInitFileAfterExactRecheck(
        staleLockQuarantine,
        moved.observation,
        basename(staleLockQuarantine),
      );
      await removeInitProvenanceRecord(provenance);
      continue;
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
  const lock = await acquireInitPublicationLock(root, hook);
  try {
    await hook?.("after-lock-acquire");
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
    };
  } catch (error: unknown) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

interface DeploymentLockHandle {
  readonly path: string;
  readonly state: DeploymentLockState;
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
  const observed = await readDeploymentLockState(lock.path);
  if (
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
  try {
    await rename(lock.path, quarantinePath);
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return false;
    throw error;
  }
  const observed = await readDeploymentLockState(quarantinePath);
  if (
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
      const handle: DeploymentLockHandle = {
        path,
        state,
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
  readonly token?: string;
  readonly workerHost: typeof EDEN_LOCAL_HOST;
  readonly workerPort: typeof EDEN_LOCAL_PORT;
  readonly inspectorHost: typeof EDEN_LOCAL_INSPECTOR_HOST;
  readonly inspectorPort: typeof EDEN_LOCAL_INSPECTOR_PORT;
}

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
): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolveResult) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "command="],
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
  expectedIdentity: string,
): Promise<boolean> {
  if (
    pid <= 0 ||
    expectedIdentity.length === 0 ||
    process.platform === "win32"
  ) {
    return false;
  }
  const command = await readProcessCommand(pid);
  return command !== undefined &&
    processCommandContainsMarker(command, expectedIdentity);
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
): Promise<{ readonly path: string; readonly token: string }> {
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
      alive = await verifyProcessIdentity(previous.pid, previous.startedAt);
    }
    if (alive) {
      throw cliError({
        code: "DEV_STATE_EXISTS",
        message:
          "An Eden dev process state file already exists; stop the owned process before starting another dev invocation.",
        source: DEV_STATE_FILE,
      });
    }
    if (previous?.token === undefined) {
      throw cliError({
        code: "DEV_STATE_INVALID",
        message:
          "The existing Eden dev process state has no ownership token and cannot be replaced safely.",
        source: DEV_STATE_FILE,
      });
    }
    const removed = await removeOwnedDevState(root, previous);
    if (!removed) {
      throw cliError({
        code: "DEV_STATE_EXISTS",
        message:
          "The Eden dev process state changed while it was being replaced; retry without taking over the replacement process.",
        source: DEV_STATE_FILE,
      });
    }
  }
  const token = randomUUID();
  const state: DevState = {
    pid,
    startedAt,
    token,
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
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "pid",
          "startedAt",
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
  if (
    !Number.isSafeInteger(state.pid) ||
    (state.pid as number) <= 0 ||
    typeof state.startedAt !== "string" ||
    state.startedAt.length === 0 ||
    (state.token !== undefined &&
      (typeof state.token !== "string" || state.token.length === 0)) ||
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
  owner: Pick<DevState, "pid" | "startedAt" | "token">,
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
    matches =
      isRecord(value) &&
      value.pid === owner.pid &&
      value.startedAt === owner.startedAt &&
      value.token === owner.token;
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
  expectedIdentity: string,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (!(await verifyProcessIdentity(pid, expectedIdentity))) return false;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
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
  expectedIdentity: string,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (!(await verifyProcessIdentity(pid, expectedIdentity))) return true;
    await new Promise((resolveResult) => setTimeout(resolveResult, 50));
  }
  return !(await verifyProcessIdentity(pid, expectedIdentity));
}

async function waitForOwnedProcessExit(
  process: EdenCliProcess,
  timeoutMs = OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
  cleanupSignal?: AbortSignal,
): Promise<boolean> {
  if (cleanupSignal?.aborted === true) return false;
  const exited = process.exited.then(
    () => true,
    () => true,
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
  cleanupSignal?: AbortSignal,
): Promise<boolean> {
  const identity = await resolveOwnedProcessIdentity(process);
  if (identity === undefined) return false;
  if (cleanupSignal?.aborted === true) {
    return await waitForOwnedProcessExit(
      process,
      OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
      cleanupSignal,
    );
  }
  const termination: boolean = await Promise.race<boolean>([
    Promise.resolve()
      .then(() => process.terminate(signal))
      .then(() => true, () => false),
    new Promise<boolean>((resolveResult) => {
      setTimeout(() => resolveResult(false), OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS);
    }),
  ]);
  if (
    termination === false &&
    (cleanupSignal === undefined || cleanupSignal.aborted === false)
  ) {
    await Promise.race([
      Promise.resolve()
        .then(() => process.terminate("SIGKILL"))
        .then(() => undefined, () => undefined),
      new Promise<void>((resolveResult) => {
        setTimeout(resolveResult, OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS);
      }),
    ]);
  }
  return await waitForOwnedProcessExit(
    process,
    OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
    cleanupSignal,
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
    if (!(await verifyProcessIdentity(state.pid, state.startedAt))) {
      return 0;
    }
    const termSent = await signalOwnedProcess(
      state.pid,
      state.startedAt,
      "SIGTERM",
    );
    if (!termSent) return 0;
    const exitedAfterTerm = await waitForProcessExit(
      state.pid,
      state.startedAt,
    );
    if (!exitedAfterTerm) {
      const killSent = await signalOwnedProcess(
        state.pid,
        state.startedAt,
        "SIGKILL",
      );
      if (killSent && !(await waitForProcessExit(state.pid, state.startedAt))) {
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
      await removeOwnedDevState(root, state);
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
        readiness.map((port) => waitForTcpPort(port.host, port.port, 10_000)),
      ).then(() => undefined);
  const startIdentity = Promise.race([
    waitForProcessIdentity(pid, processMarker),
    exited.then(() => undefined),
  ]);
  let termination: Promise<void> | undefined;
  const signalOwnedChild = async (
    signal: NodeJS.Signals,
  ): Promise<boolean> => {
    const expected = await startIdentity;
    if (
      expected === undefined ||
      !(await verifyProcessIdentity(pid, expected))
    ) {
      return false;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-pid, signal);
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
    startIdentity,
    exited,
    ...(ready === undefined ? {} : { ready }),
    async terminate(signal = "SIGTERM") {
      if (termination !== undefined) {
        await termination;
        return;
      }
      termination = (async () => {
        if (pid <= 0) return;
        await signalOwnedChild(signal);
        const graceful = await Promise.race([
          exited,
          new Promise<undefined>((resolveExit) => {
            setTimeout(() => resolveExit(undefined), 5_000);
          }),
        ]);
        if (graceful !== undefined) return;
        await signalOwnedChild("SIGKILL");
        await Promise.race([
          exited,
          new Promise<undefined>((resolveExit) => {
            setTimeout(() => resolveExit(undefined), 5_000);
          }),
        ]);
      })();
      await termination;
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
  readonly stopped: Promise<NodeJS.Signals>;
  readonly register: (process: EdenCliProcess) => void;
  readonly unregister: (process: EdenCliProcess) => void;
  readonly cleanup: (signal: NodeJS.Signals) => Promise<void>;
}

const OWNED_PROCESS_TERMINATION_TIMEOUT_MS = 2_000;
const OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS = 750;

async function terminateOwnedProcess(
  process: EdenCliProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  const attempt = async (requestedSignal: NodeJS.Signals): Promise<boolean> => {
    let termination: Promise<void>;
    try {
      termination = Promise.resolve(process.terminate(requestedSignal));
    } catch {
      return true;
    }
    return Promise.race([
      termination.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), OWNED_PROCESS_TERMINATION_TIMEOUT_MS);
      }),
    ]);
  };
  if (await attempt(signal)) return;
  await attempt("SIGKILL");
}

function createOwnedProcessRegistry(): OwnedProcessRegistry {
  const processes = new Set<EdenCliProcess>();
  let stopping = false;
  let cleanupPromise: Promise<void> | undefined;
  let cleanupSignal: NodeJS.Signals = "SIGTERM";
  let resolveStopped: ((signal: NodeJS.Signals) => void) | undefined;
  const stopped = new Promise<NodeJS.Signals>((resolve) => {
    resolveStopped = resolve;
  });
  const cleanup = (signal: NodeJS.Signals): Promise<void> => {
    cleanupSignal = signal;
    stopping = true;
    resolveStopped?.(signal);
    resolveStopped = undefined;
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = (async () => {
      await Promise.all(
        [...processes].map((process) =>
          terminateOwnedProcess(process, cleanupSignal),
        ),
      );
    })();
    return cleanupPromise;
  };
  return {
    isStopping: () => stopping,
    stopped,
    register: (process) => {
      processes.add(process);
      if (stopping) {
        void terminateOwnedProcess(process, cleanupSignal);
      }
    },
    unregister: (process) => {
      processes.delete(process);
    },
    cleanup,
  };
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
): Promise<EdenCliDryRunResult> {
  const runner = options.dryRunRunner ?? runDefaultDryRun;
  const returned = runner(request);
  if (isDryRunHandle(returned)) {
    ownedProcesses?.register(returned.process);
    try {
      return await returned.result;
    } finally {
      ownedProcesses?.unregister(returned.process);
    }
  }
  const resolved = await returned;
  if (isDryRunHandle(resolved)) {
    // A promise-returned handle may already have spawned before this await.
    // It cannot be registered synchronously, so this shape is unsupported.
    // Give the returned owner one best-effort termination opportunity rather
    // than leaving an untracked child behind.
    await terminateOwnedProcess(resolved.process, "SIGTERM");
    throw cliError({
      code: "DRY_RUN_HANDLE_UNSUPPORTED",
      message:
        "The compatibility runner returned a cancellable handle through a promise; return the handle synchronously so it can be registered before awaiting.",
    });
  }
  return resolved;
}

async function runRemoteCommand(
  options: EdenCliRunOptions,
  request: EdenCliRemoteCommandRequest,
  ownedProcesses: OwnedProcessRegistry,
  allowWhenStopping = false,
  onStarted?: () => void,
): Promise<EdenCliRemoteCommandResult> {
  if (!allowWhenStopping && ownedProcesses.isStopping()) {
    throw cliError({
      code: "DEPLOY_CANCELLED",
      message:
        "Eden deploy was cancelled before the remote command could start.",
    });
  }
  const runner = options.remoteCommandRunner ?? runDefaultRemoteCommand;
  const returned = runner(request);
  if (isRemoteCommandHandle(returned)) {
    onStarted?.();
    ownedProcesses.register(returned.process);
    try {
      if (allowWhenStopping) {
        return await Promise.race([
          returned.result,
          new Promise<EdenCliRemoteCommandResult>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  exitCode: 1,
                  stdout: "",
                  stderr: "Remote cleanup command did not settle.",
                }),
              OWNED_PROCESS_TERMINATION_TIMEOUT_MS,
            );
          }),
        ]);
      }
      return await Promise.race([
        returned.result,
        ownedProcesses.stopped.then((signal) => {
          throw cliError({
            code: "DEPLOY_CANCELLED",
            message:
              `Eden deploy was cancelled by ${signal}; the owned remote command was terminated.`,
          });
        }),
      ]);
    } finally {
      ownedProcesses.unregister(returned.process);
    }
  }
  let resolved: EdenCliRemoteCommandResult | EdenCliRemoteCommandHandle;
  try {
    resolved = await Promise.race([
      Promise.resolve(returned),
      ...(allowWhenStopping
        ? []
        : [
            ownedProcesses.stopped.then((signal) => {
              throw cliError({
                code: "DEPLOY_CANCELLED",
                message:
                  `Eden deploy was cancelled by ${signal} before a remote command handle was registered.`,
              });
            }),
          ]),
    ]);
  } catch (error: unknown) {
    void Promise.resolve(returned)
      .then((late) => {
        if (isRemoteCommandHandle(late)) {
          void terminateOwnedProcess(late.process, "SIGTERM");
        }
      })
      .catch(() => undefined);
    throw error;
  }
  if (isRemoteCommandHandle(resolved)) {
    await terminateOwnedProcess(resolved.process, "SIGTERM");
    throw cliError({
      code: "REMOTE_COMMAND_HANDLE_UNSUPPORTED",
      message:
        "The remote command runner returned a cancellable handle through a promise; return the handle synchronously so it can be registered before awaiting.",
    });
  }
  onStarted?.();
  return resolved;
}

async function buildProjectFromCli(
  root: string,
  options: EdenCliRunOptions,
  environment?: "preview" | "production",
  sourceFingerprint?: ProjectInputFingerprint,
  ownedProcesses?: OwnedProcessRegistry,
): Promise<EdenArtifactGeneration> {
  const configuration = await readProjectConfiguration(root);
  const inputFingerprint =
    sourceFingerprint ?? await fingerprintProjectInputs(root, configuration);
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
      await assertCanonicalGenerationMatches(
        root,
        canonicalGeneration,
        generationId,
        result.artifacts,
      );
      await rm(candidateGenerationPath, { recursive: true, force: true });
    }
    await options.buildPublicationHook?.("after-generation-publish");
    await options.buildPublicationHook?.("before-current-promotion");
    await assertCanonicalGenerationMatches(
      root,
      canonicalGeneration,
      generationId,
      result.artifacts,
    );
    await promoteCurrentGeneration(canonicalOutput, generationId);
    await assertArtifactDirectory(canonicalOutput);
    await options.buildPublicationHook?.("after-current-promotion");

    options.stdout?.(
      `Built Eden project generation ${generationId}.`,
    );
    options.stdout?.("Worker compatibility dry run passed; no deployment was performed.");
    return {
      directory: canonicalGeneration,
      artifacts: result.artifacts,
    };
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

async function waitForProcessIdentity(
  pid: number,
  marker: string,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await verifyProcessIdentity(pid, marker)) return marker;
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
  timeoutMs = 10_000,
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
              if (exited) {
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
      if (exited) {
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
  let rebuildInFlight = false;
  let rebuildPending = false;
  const rebuildTasks = new Set<Promise<void>>();
  let statePath: string | undefined;
  let stateOwner: Pick<DevState, "pid" | "startedAt" | "token"> | undefined;
  let temporaryConfig: string | undefined;
  let runtimeEntryPath: string | undefined;
  let runtimeGeneration: RuntimeGeneration | undefined;
  let runtimeContents: RuntimeFileContents | undefined;
  let runtimeArtifact: EdenArtifactGeneration | undefined;
  let replacementChild: EdenCliProcess | undefined;
  const runtimeChildren = new Set<EdenCliProcess>();
  const readinessAbortController = new AbortController();
  let localSecretPath: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
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
  const runner = options.processRunner ?? defaultProcessRunner();
  const ownedValidationProcesses = createOwnedProcessRegistry();
  const runtimePublicationHook = options.runtimePublicationHook;
  let runtimeExecutable: DeploymentExecutable | undefined;
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
      processIdentity: basename(configPath),
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
    });
    replacementChild = processHandle;
    if (stopped) {
      await terminateRuntimeChild(processHandle, requestedSignal);
      replacementChild = undefined;
      return startupStopped;
    }
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
    if (
      typeof startIdentityResult !== "string" ||
      startIdentityResult.length === 0
    ) {
      throw cliError({
        code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
        message:
          "The Eden dev process start identity could not be verified; no PID or process group was signaled.",
        source: DEV_STATE_FILE,
      });
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
      if (ownedValidationProcesses.isStopping()) return;
      const resolvedConfiguration = await readProjectConfiguration(root);
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
      const nextRuntimeFiles = await createRuntimeFiles(
        root,
        resolvedConfiguration.configPath,
        nextGeneration,
        "local",
      );
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
          oldRuntimeStopped = await terminateRuntimeChild(
            oldChild,
            "SIGTERM",
            readinessAbortController.signal,
          );
          if (oldRuntimeStopped) {
            await waitForApprovedPortsAvailable(
              5_000,
              readinessAbortController.signal,
            );
          } else if (!stopped) {
            const oldGenerationStillServes = await waitForRuntimeGeneration(
              oldChild,
              runtimeGeneration,
              options.runtimeReadinessTimeoutMs ?? 10_000,
              readinessAbortController.signal,
            );
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
        await waitForRuntimeGeneration(
          replacement,
          nextRuntimeGeneration,
          options.runtimeReadinessTimeoutMs ?? 10_000,
          readinessAbortController.signal,
        );
        if (stopped) {
          replacingRuntime = false;
          return;
        }
        await runtimePublicationHook?.("before-runtime-entry-publish");
        await runtimePublicationHook?.("after-runtime-entry-publish");
        await runtimePublicationHook?.("before-runtime-config-publish");
        await runtimePublicationHook?.("after-runtime-config-publish");
        await runtimePublicationHook?.("after-runtime-ready");

        const nextContents = await readRuntimeFileContents(nextRuntimeFiles);
        const previousChild = child;
        child = replacement;
        replacementChild = undefined;
        childExited = false;
        runtimeContents = nextContents;
        runtimeGeneration = nextRuntimeGeneration;
        runtimeArtifact = nextGeneration;
        temporaryConfig = nextRuntimeFiles.configPath;
        runtimeEntryPath = nextRuntimeFiles.entryPath;
        if (stateOwner !== undefined) {
          const writtenState = await writeDevState(
            root,
            replacement.pid,
            replacementIdentity,
          );
          statePath = writtenState.path;
          stateOwner = {
            pid: replacement.pid,
            startedAt: replacementIdentity,
            token: writtenState.token,
          };
        }
        nextRuntimePromoted = true;
        replacingRuntime = false;
        notifyRuntimeChange();
        if (previousChild !== undefined && previousChild !== replacement) {
          await waitForOwnedProcessExit(
            previousChild,
            OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
            readinessAbortController.signal,
          );
        }
        if (oldConfig !== undefined) {
          await rm(oldConfig, { force: true }).catch(() => undefined);
        }
        if (oldEntry !== undefined) {
          await rm(oldEntry, { force: true }).catch(() => undefined);
        }
      } catch (error: unknown) {
        const pendingCandidate =
          candidateChild ??
          (replacementChild !== undefined && replacementChild !== child
            ? replacementChild
            : undefined);
        if (pendingCandidate !== undefined) {
          await terminateRuntimeChild(
            pendingCandidate,
            "SIGTERM",
          );
          if (child === pendingCandidate) {
            child = undefined;
            childExited = true;
          }
          replacementChild = undefined;
          if (!stopped) {
            try {
              await waitForApprovedPortsAvailable();
            } catch (portError: unknown) {
              markRuntimeUnavailable();
              throw portError;
            }
          }
        }
        let oldRuntimeVerified = false;
        if (!oldRuntimeStopped && pendingCandidate === undefined && !stopped) {
          try {
            oldRuntimeVerified = await waitForRuntimeGeneration(
              child,
              runtimeGeneration,
              options.runtimeReadinessTimeoutMs ?? 10_000,
              readinessAbortController.signal,
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
            : await createRuntimeFiles(
                root,
                resolvedConfiguration.configPath,
                oldArtifact,
                "local",
              ).catch(() => undefined);
        const rollbackFilesOwned =
          rollbackFiles !== undefined &&
          (rollbackFiles.configPath !== oldConfig ||
            rollbackFiles.entryPath !== oldEntry);
        let rollbackChild: EdenCliProcess | undefined;
        let rollbackVerified = false;
        try {
          if (rollbackFiles !== undefined) {
            if (stopped) return;
            await runtimePublicationHook?.("before-runtime-rollback");
            if (stopped) return;
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
            const rollbackReady = await waitForRuntimeGeneration(
              rollback,
              runtimeGeneration,
              options.runtimeReadinessTimeoutMs ?? 10_000,
              readinessAbortController.signal,
            );
            if (!rollbackReady || stopped) return;
            const rollbackContents = await readRuntimeFileContents(
              rollbackFiles,
            );
            child = rollback;
            replacementChild = undefined;
            childExited = false;
            temporaryConfig = rollbackFiles.configPath;
            runtimeEntryPath = rollbackFiles.entryPath;
            runtimeContents = rollbackContents;
            if (stateOwner !== undefined) {
              const rollbackState = await writeDevState(
                root,
                rollback.pid,
                rollbackIdentity,
              );
              statePath = rollbackState.path;
              stateOwner = {
                pid: rollback.pid,
                startedAt: rollbackIdentity,
                token: rollbackState.token,
              };
            }
            rollbackVerified = true;
            notifyRuntimeChange();
          }
        } catch (rollbackError: unknown) {
          const pendingRollback = rollbackChild ?? replacementChild;
          if (pendingRollback !== undefined) {
            await terminateRuntimeChild(
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
            await runtimePublicationHook?.("after-runtime-rollback");
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
          await rm(nextRuntimeFiles.configPath, { force: true }).catch(
            () => undefined,
          );
          await rm(nextRuntimeFiles.entryPath, { force: true }).catch(
            () => undefined,
          );
        }
      }
      options.stdout?.(
        `Eden dev generation ${nextGeneration.artifacts.buildMetadata.generationId} is coherent.`,
      );
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

  const cleanup = (): Promise<void> => {
    if (cleanupRunning && cleanupPromise !== undefined) return cleanupPromise;
    cleanupRunning = true;
    cleanupPromise = (async () => {
      stopped = true;
      readinessAbortController.abort();
      await ownedValidationProcesses.cleanup(requestedSignal);
      if (rebuildTimer !== undefined) {
        clearTimeout(rebuildTimer);
        rebuildTimer = undefined;
      }
      await closeWatcher(watcher);
      watcher = undefined;

      for (let cleanupAttempt = 0; cleanupAttempt < 3; cleanupAttempt += 1) {
        const snapshot = [
          child,
          replacementChild,
          ...runtimeChildren,
        ].filter(
          (value, index, values): value is EdenCliProcess =>
            value !== undefined && values.indexOf(value) === index,
        );
        if (snapshot.length === 0) break;
        for (const ownedProcess of snapshot) {
          if (
            ownedProcess === child &&
            childCleanupRequested === false &&
            childExited &&
            startupComplete &&
            requestedStop === false
          ) {
            continue;
          }
          const identity = await resolveOwnedProcessIdentity(ownedProcess);
          if (identity === undefined) continue;
          if (ownedProcess === child) childCleanupRequested = true;
          await terminateRuntimeChild(ownedProcess, requestedSignal);
        }
        await waitForSettlements(
          snapshot.map((ownedProcess) => ownedProcess.exited),
          OWNED_PROCESS_SETTLEMENT_TIMEOUT_MS,
        );
        const remaining = [child, replacementChild, ...runtimeChildren].filter(
          (value, index, values): value is EdenCliProcess =>
            value !== undefined && values.indexOf(value) === index,
        );
        if (remaining.length === 0) break;
      }

      await waitForSettlements(rebuildTasks);
      if (temporaryConfig !== undefined) {
        await rm(temporaryConfig, { force: true }).catch(() => undefined);
        temporaryConfig = undefined;
      }
      if (runtimeEntryPath !== undefined) {
        await rm(runtimeEntryPath, { force: true }).catch(() => undefined);
        runtimeEntryPath = undefined;
      }
      if (localSecretPath !== undefined) {
        await rm(localSecretPath, { force: true }).catch(() => undefined);
        localSecretPath = undefined;
      }
      if (statePath !== undefined && stateOwner !== undefined) {
        await removeOwnedDevState(root, stateOwner);
        statePath = undefined;
        stateOwner = undefined;
      }
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
    void cleanup();
  };
  const stopOnSigint = (): void => requestStop("SIGINT");
  const stopOnSigterm = (): void => requestStop("SIGTERM");
  process.once("SIGINT", stopOnSigint);
  process.once("SIGTERM", stopOnSigterm);

  try {
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
    if (stopped) return;

    const resolvedConfiguration = await readProjectConfiguration(root);
    if (stopped) return;
    const runtimeFiles = await createRuntimeFiles(
      root,
      resolvedConfiguration.configPath,
      generation,
    );
    temporaryConfig = runtimeFiles.configPath;
    runtimeEntryPath = runtimeFiles.entryPath;
    runtimeGeneration = readRuntimeGeneration(generation);
    runtimeContents = await readRuntimeFileContents(runtimeFiles);
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
      child = started;
      replacementChild = undefined;
      void child.exited.then(
        () => {
          childExited = true;
        },
        () => {
          childExited = true;
        },
      );
      const startIdentity = await Promise.resolve(child.startIdentity);
      if (typeof startIdentity !== "string" || startIdentity.length === 0) {
        throw cliError({
          code: "DEV_PROCESS_IDENTITY_UNAVAILABLE",
          message:
            "The Eden dev process start identity could not be verified; no PID or process group was signaled.",
          source: DEV_STATE_FILE,
        });
      }
      if (stopped) return;
      const writtenState = await writeDevState(root, child.pid, startIdentity);
      statePath = writtenState.path;
      stateOwner = {
        pid: child.pid,
        startedAt: startIdentity,
        token: writtenState.token,
      };
      if (stopped) return;
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

    if (
      !(await waitForWatcherReady(
        watcher,
        10_000,
        readinessAbortController.signal,
      ))
    ) {
      return;
    }

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
  } finally {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await cleanup();
  }
}

async function readConfiguredWorkerName(
  configPath: string,
  environment: "preview" | "production",
  sourceContents?: string,
): Promise<string | undefined> {
  const source = sourceContents ?? await readFile(configPath, "utf8");
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
  const ownedValidationProcesses = createOwnedProcessRegistry();
  let deploymentLock: DeploymentLockHandle | undefined;
  let requestedSignal: NodeJS.Signals | undefined;
  const requestStop = (signal: NodeJS.Signals): void => {
    requestedSignal ??= signal;
    void ownedValidationProcesses.cleanup(signal);
  };
  const stopOnSigint = (): void => requestStop("SIGINT");
  const stopOnSigterm = (): void => requestStop("SIGTERM");
  process.on("SIGINT", stopOnSigint);
  process.on("SIGTERM", stopOnSigterm);
  try {
    deploymentLock = await acquireDeploymentLock(root);
  } catch (error: unknown) {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal ?? "SIGTERM");
    throw error;
  }
  if (deploymentLock === undefined) {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal ?? "SIGTERM");
    throw cliError({
      code: "DEPLOY_LOCK_UNAVAILABLE",
      message: "The Eden deployment ownership lock could not be acquired.",
      source: DEPLOY_LOCK_FILE,
    });
  }
  const lock: DeploymentLockHandle = deploymentLock;
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
  let deploymentRuntimeContents: RuntimeFileContents | undefined;
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
    generation = await buildProjectFromCli(
      root,
      options,
      environment,
      deploymentSnapshot.fingerprint,
      ownedValidationProcesses,
    );
    assertDeploymentActive();
    await assertBoundGeneration();
    const deploymentArtifactSnapshot =
      await copyDeploymentGenerationSnapshot(root, generation);
    deploymentArtifactSnapshotRoot = deploymentArtifactSnapshot.root;
    generation = deploymentArtifactSnapshot.generation;
  } catch (error: unknown) {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal ?? "SIGTERM");
    await lock.release().catch(() => undefined);
    if (deploymentArtifactSnapshotRoot !== undefined) {
      await rm(deploymentArtifactSnapshotRoot, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
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
    if (setupRuntimeFiles !== undefined) {
      await rm(setupRuntimeFiles.configPath, { force: true }).catch(
        () => undefined,
      );
      await rm(setupRuntimeFiles.entryPath, { force: true }).catch(
        () => undefined,
      );
    }
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal ?? "SIGTERM");
    await lock.release().catch(() => undefined);
    if (deploymentArtifactSnapshotRoot !== undefined) {
      await rm(deploymentArtifactSnapshotRoot, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    throw error;
  }
  const runtimeFiles = setupRuntimeFiles;
  if (runtimeFiles === undefined) {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal ?? "SIGTERM");
    await lock.release().catch(() => undefined);
    if (deploymentArtifactSnapshotRoot !== undefined) {
      await rm(deploymentArtifactSnapshotRoot, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    throw cliError({
      code: "DEPLOY_RUNTIME_UNAVAILABLE",
      message: "The deployment runtime files could not be created.",
    });
  }
  const temporaryConfig = runtimeFiles.configPath;
  if (deploymentRuntimeContents === undefined) {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal ?? "SIGTERM");
    await lock.release().catch(() => undefined);
    if (deploymentArtifactSnapshotRoot !== undefined) {
      await rm(deploymentArtifactSnapshotRoot, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    throw cliError({
      code: "DEPLOY_RUNTIME_UNAVAILABLE",
      message: "The deployment runtime snapshot could not be read.",
    });
  }
  const assertDeploymentCandidateStable = async (): Promise<void> => {
    assertDeploymentActive();
    await assertDeploymentLockOwned(lock);
    await assertBoundGeneration();
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
  };
  const secret = options.remoteBearerSecret ?? process.env.EDEN_BEARER_SECRET;
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
  const runOwnedRemoteMutation = async (
    request: EdenCliRemoteCommandRequest,
    markStarted?: () => void,
  ): Promise<EdenCliRemoteCommandResult> => {
    await assertDeploymentCandidateStable();
    const result = await runRemoteCommand(
      options,
      request,
      ownedValidationProcesses,
      false,
      markStarted,
    );
    await assertDeploymentCandidateStable();
    return result;
  };
  const runOwnedRemoteCleanup = async (
    request: EdenCliRemoteCommandRequest,
  ): Promise<EdenCliRemoteCommandResult> => {
    await assertDeploymentLockOwned(lock);
    const result = await runRemoteCommand(
      options,
      request,
      ownedValidationProcesses,
      true,
    );
    if (!ownedValidationProcesses.isStopping()) {
      await assertDeploymentLockOwned(lock);
    }
    return result;
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
        "--config",
        temporaryConfig,
      ],
    };
    await options.deploymentBoundaryHook?.("before-compatibility-dry-run");
    assertDeploymentActive();
    let dryRun: EdenCliDryRunResult;
    try {
      dryRun = await runCompatibilityDryRun(
        options,
        compatibilityRequest,
        ownedValidationProcesses,
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
    await options.deploymentBoundaryHook?.("after-compatibility-dry-run");
    await assertDeploymentCandidateStable();
    if (secret === undefined || secret.length === 0) {
      throw cliError({
        code: "REMOTE_SECRET_REQUIRED",
        message:
          "Set EDEN_BEARER_SECRET outside the project before a real deployment.",
      });
    }

    await options.deploymentBoundaryHook?.("before-secret-provision");
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
    await options.deploymentBoundaryHook?.("after-secret-provision");
    await assertDeploymentCandidateStable();
    await options.deploymentBoundaryHook?.("before-deploy");
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
    await options.deploymentBoundaryHook?.("after-deploy");
    assertDeploymentActive();
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
    await options.deploymentBoundaryHook?.("before-remote-validation");
    assertDeploymentActive();
    const validation = await remoteValidate({
      cwd: root,
      environment,
      workerName,
      url: deploymentUrl,
      expectedGeneration: runtimeGeneration,
    });
    await options.deploymentBoundaryHook?.("after-remote-validation");
    assertDeploymentActive();
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
      (secretProvisioned || deploymentAttempted)
    ) {
      let cleanupFailed = false;
      if (secretProvisioned) {
        const removed = await runOwnedRemoteCleanup({
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
        }).catch(() => ({ exitCode: 1 }));
        cleanupFailed ||= removed.exitCode !== 0;
      }
      if (deploymentAttempted) {
        const deleted = await runOwnedRemoteCleanup({
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
    if (deploymentArtifactSnapshotRoot !== undefined) {
      await rm(deploymentArtifactSnapshotRoot, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      deploymentArtifactSnapshotRoot = undefined;
    }
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal ?? "SIGTERM");
    await lock.release().catch(() => undefined);
  }
}

async function runBuild(
  root: string,
  options: EdenCliRunOptions,
): Promise<void> {
  const ownedValidationProcesses = createOwnedProcessRegistry();
  let requestedSignal: NodeJS.Signals = "SIGTERM";
  const requestStop = (signal: NodeJS.Signals): void => {
    requestedSignal = signal;
    void ownedValidationProcesses.cleanup(signal);
  };
  const stopOnSigint = (): void => requestStop("SIGINT");
  const stopOnSigterm = (): void => requestStop("SIGTERM");
  process.on("SIGINT", stopOnSigint);
  process.on("SIGTERM", stopOnSigterm);
  try {
    await buildProjectFromCli(
      root,
      options,
      undefined,
      undefined,
      ownedValidationProcesses,
    );
  } finally {
    process.removeListener("SIGINT", stopOnSigint);
    process.removeListener("SIGTERM", stopOnSigterm);
    await ownedValidationProcesses.cleanup(requestedSignal);
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

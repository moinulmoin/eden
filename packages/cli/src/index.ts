#!/usr/bin/env -S node --

import {
  readFileSync,
  realpathSync,
} from "fs";
import {
  lstat,
  readFile,
  realpath,
} from "fs/promises";

import {
  isAbsolute,
  join,
  resolve,
} from "path";
import {
  fileURLToPath,
} from "url";

import {
  EVE_CLI_COMMANDS,
  EveCliError,
  deriveEveTargetName,
  eveHelpText,
  parseEveArguments,
  type EveCliExecutionRequest,
  type EveCliInvocation,
  type ParsedEveInvocation,
} from "./eve.js";
import { pinnedCliProblem } from "./eve-cloudflare-cli.js";
import { sendTelemetry } from "./telemetry.js";
import {
  EveRuntimeConfigError,
  readEveRuntimeConfig,
  redactEveRuntimeOutput,
} from "./eve-runtime-config.js";
import {
  DEFAULT_EVE_HOST_REQUIREMENTS,
  runEveControlPlane,
  runEveDestroy,
  type EvePreflightOptions,
} from "./eve-control-plane.js";

export {
  EVE_CLI_COMMANDS,
  EveCliError,
  deriveEveTargetName,
  eveHelpText,
  parseEveArguments,
} from "./eve.js";
export {
  EvePackagingError,
  buildEveProjectSnapshot,
  createDockerEveProjectBuilder,
  revalidateEveProjectCandidateInputs,
} from "./eve-packaging.js";
export {
  EVE_RESERVED_HOST_VARIABLES,
  EVE_START_COMMAND,
  EveRuntimeConfig,
  EveRuntimeConfigError,
  prepareEveRuntimeInjection,
  readEveRuntimeConfig,
  redactEveRuntimeOutput,
} from "./eve-runtime-config.js";
export type {
  EveReservedHostVariable,
  EveRuntimeConfigErrorCode,
  EveRuntimeInjection,
  EveRuntimeInjectionMode,
  EveRuntimeInjectionOptions,
  EveRuntimeInputIdentity,
  EveRuntimeProtectedPutRequest,
  EveRuntimeProtectedPutResult,
  EveRuntimeProtectedStore,
  EveStartProcessRequest,
  RedactedRuntimeConfigSeam,
} from "./eve-runtime-config.js";
export {
  buildEveRuntimeImage,
  discardEveRuntimeImage,
  revalidateEveRuntimeCandidate,
  validateEveHostRequirements,
} from "./eve-runtime-image.js";
export type {
  EveCliCommand,
  EveCliEnvironment,
  EveCliExecutionRequest,
  EveCliHelp,
  EveCliInvocation,
  ParsedEveInvocation,
} from "./eve.js";
export type {
  EveNodeImage,
  EvePackagingCheck,
  EvePackagingCode,
  EveProjectBuilder,
  EveProjectBuilderRequest,
  EveProjectBuilderResult,
  EveProjectBuildCandidate,
  EveProjectFile,
  EveProjectImage,
  EveProjectInputManifest,
  EveProjectOutput,
  EveProjectPackagingResult,
  EveProjectSnapshot,
  EveProjectSnapshotOptions,
  EveProjectToolchain,
  EveRuntimeConfigExclusion,
} from "./eve-packaging.js";
export type {
  EveHostRequirements,
  EveRuntimeClosure,
  EveRuntimeClosureFile,
  EveRuntimeCleanup,
  EveRuntimeImage,
  EveRuntimeImageDiscardRequest,
  EveRuntimeImageMetadata,
  EveRuntimeImageRequest,
  EveRuntimeImageResult,
  EveRuntimeNativeModule,
  EveRuntimeStatus,
} from "./eve-runtime-image.js";
export {
  DEFAULT_EVE_HOST_REQUIREMENTS,
  DEFAULT_EVE_NODE_IMAGE,
  runEveControlPlane,
  runEveDestroy,
} from "./eve-control-plane.js";
export type {
  EveCloudflareReadRequest,
  EveCloudflareReadResult,
  EveCloudflareReadRunner,
  EveCloudflareTargetState,
  EveContainerDeleteRunner,
  EveDeploymentCompensationRequest,
  EveDeploymentCompensationRunner,
  EveDeploymentHealthRequest,
  EveDeploymentHealthResult,
  EveDeploymentHealthRunner,
  EveDeploymentIdentity,
  EveDeploymentIdentityProof,
  EveDeploymentMetadata,
  EveDeploymentPublicationRequest,
  EveDeploymentPublicationResult,
  EveDeploymentPublicationRunner,
  EveDeploymentStatus,
  EveDestroyCloudflareReadRequest,
  EveDestroyCloudflareReadRunner,
  EveDestroyOutcome,
  EveDestroyTargetRead,
  EveImagePublicationRequest,
  EveImagePublicationResult,
  EveImagePublicationRunner,
  EvePreflightCandidate,
  EvePreflightResult,
  EvePreflightRuntimeEvidence,
  EvePreflightWarning,
  EvePreflightRuntimeRunner,
  EvePreflightRuntimeRunnerRequest,
  EveRegistryRepositoryDeleteRunner,
  EveRuntimeConfigLoader,
  EveRuntimeImageDiscardRunner,
  EveWorkerDeleteRunner,
} from "./eve-control-plane.js";

export interface EdenCliRunOptions {
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /**
   * Eve execution is a separate control-plane seam. The default path fails
   * closed.
   */
  readonly eveRunner?: (
    request: EveCliExecutionRequest,
  ) => void | Promise<void>;
  /**
   * Finite local control-plane seams for the built-in Eve preflight path.
   * Runtime values and remote-provider mutations never cross this boundary.
   */
  readonly eveControlPlane?: EvePreflightOptions;
  /** The Node version to check instead of the running one. */
  readonly nodeVersion?: string;
  /** The installed cf version to check instead of the real one; null for none installed. */
  readonly cfVersion?: string | null;
  /** Send one anonymous usage event when the command ends, as the eden binary does. See README.md#telemetry. */
  readonly telemetry?: boolean;
}



const USAGE = `Usage: eden <command> [options]

Commands:
  preflight  Build and inspect a local Eve candidate without remote mutation
  deploy     Deploy the selected Eve project to the exact named target
  destroy    Remove the exact owned Eve target
  skill      Print the bundled Eden skill for coding agents

preflight and deploy default to the current directory, the preview
environment, and a target name derived from package.json. destroy and
--env production always require an explicit --name.
Run eden <preflight|deploy|destroy> --help for command-specific options.
Run eden --version to print the installed version.

Telemetry: preflight, deploy, and destroy each send one anonymous usage
event when they end. EDEN_TELEMETRY=0 or DO_NOT_TRACK=1 turns it off. The
Telemetry section of the README lists every field.
`;

/** Reads the version from this package's manifest, which npm always ships next to dist/. */
function edenVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new EveCliError({
      code: "VERSION_UNAVAILABLE",
      message: "The Eden package manifest has no version.",
    });
  }
  return manifest.version;
}

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function selectedEveProjectRoot(
  projectRoot: string,
  cwd: string,
): Promise<string> {
  const lexicalPath = isAbsolute(projectRoot)
    ? projectRoot
    : resolve(cwd, projectRoot);
  const details = await lstat(lexicalPath).catch(() => undefined);
  if (
    details === undefined ||
    !details.isDirectory() ||
    details.isSymbolicLink()
  ) {
    throw new EveCliError({
      code: "EVE_PROJECT_ROOT_INVALID",
      message:
        "The selected Eve project root must be an existing, canonical directory.",
      source: "project",
    });
  }
  const canonical = await realpath(lexicalPath).catch(() => undefined);
  if (canonical === undefined) {
    throw new EveCliError({
      code: "EVE_PROJECT_ROOT_INVALID",
      message:
        "The selected Eve project root could not be resolved canonically.",
      source: "project",
    });
  }
  return canonical;
}

const UNEXPECTED_FAILURE_REMEDIATION =
  "Run eden preflight for the same project and target, resolve its failed checks, then retry the command.";

function errorLines(error: unknown): readonly string[] {
  if (error instanceof EveCliError) {
    const source = error.source === undefined ? "" : ` [${error.source}]`;
    return [
      `${error.code}${source}: ${error.message}`,
      `  → ${error.remediation}`,
      ...error.diagnostics.map((diagnostic) => {
        const diagnosticSource = diagnostic.source === undefined
          ? ""
          : ` [${diagnostic.source}]`;
        return `${diagnostic.code}${diagnosticSource}: ${diagnostic.message}`;
      }),
    ];
  }
  if (error instanceof EveRuntimeConfigError) {
    const source = error.source === undefined ? "" : ` [${error.source}]`;
    return [
      `${error.code}${source}: ${error.message}`,
      `  → ${error.remediation}`,
    ];
  }
  return [
    `EVE_EXECUTION_FAILED: ${error instanceof Error ? error.message : "The Eden command failed unexpectedly."}`,
    `  → ${UNEXPECTED_FAILURE_REMEDIATION}`,
  ];
}

/**
 * Derive the deterministic preview target name from the project's package.json
 * name, falling back to the project directory name. Only used when --name was
 * not supplied; production and destroy never reach this path without --name.
 */
async function derivedEveTargetName(projectRoot: string): Promise<string> {
  const rawManifest = await readFile(join(projectRoot, "package.json"), "utf8")
    .catch(() => undefined);
  let rawName: string | undefined;
  if (rawManifest !== undefined) {
    const parsed: unknown = JSON.parse(rawManifest);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      typeof parsed.name === "string" &&
      parsed.name.length > 0
    ) {
      rawName = parsed.name;
    }
  }
  rawName ??= projectRoot.split("/").filter(Boolean).pop() ?? "";
  return deriveEveTargetName(rawName);
}

async function runEveInvocation(
  invocation: EveCliInvocation,
  options: EdenCliRunOptions,
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = await selectedEveProjectRoot(
    invocation.projectRoot,
    cwd,
  );
  const request: EveCliExecutionRequest = {
    command: invocation.command,
    cwd,
    projectRoot,
    environment: invocation.environment,
    name: invocation.name ?? (await derivedEveTargetName(projectRoot)),
    ...(invocation.envFile === undefined
      ? {}
      : { envFile: invocation.envFile }),
    ...(invocation.json === true ? { json: true } : {}),
  };
  if (options.eveRunner === undefined) {
    if (invocation.command === "preflight" || invocation.command === "deploy") {
      const runtimeConfigLoader = options.eveControlPlane?.runtimeConfigLoader ??
        ((path: string, configCwd: string) =>
          readEveRuntimeConfig(path, { cwd: configCwd }));
      await runEveControlPlane(request, {
        ...options.eveControlPlane,
        outputFormat: request.json === true ? "json" : "human",
        runtimeConfigLoader,
        ...(options.eveControlPlane?.hostRequirements === undefined
          ? { hostRequirements: DEFAULT_EVE_HOST_REQUIREMENTS }
          : {}),
        ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
      });
      return;
    }
    await runEveDestroy(request, {
      ...options.eveControlPlane,
      outputFormat: request.json === true ? "json" : "human",
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    });
    return;
  }
  try {
    await options.eveRunner(request);
  } catch (error: unknown) {
    if (
      error instanceof EveCliError ||
      error instanceof EveRuntimeConfigError
    ) {
      throw error;
    }
    throw new EveCliError({
      code: "EVE_EXECUTION_FAILED",
      message: `The ${invocation.command} operation failed.`,
    });
  }
}

export async function runEdenCli(
  args: readonly string[],
  options: EdenCliRunOptions = {},
): Promise<number> {
  const writeStdout = options.stdout ?? defaultStdout;
  const json = args.includes("--json");
  const output: string[] = [];
  const stdout = json
    ? (text: string): void => { output.push(text); }
    : (text: string): void => { writeStdout(redactEveRuntimeOutput(text)); };
  const command = (EVE_CLI_COMMANDS as readonly string[]).includes(args[0] ?? "")
    ? `eden ${args[0]}`
    : "eden";
  const flushJson = (error?: unknown): void => {
    let result: Record<string, unknown> | undefined;
    for (const text of output) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          result = parsed as Record<string, unknown>;
        }
      } catch {
        // Help and version text are wrapped below rather than printed separately.
      }
    }
    result ??= { command, ok: error === undefined, ...(output.length === 0 ? {} : { output: output.join("\n") }) };
    if (error !== undefined) {
      result = {
        ...result,
        ok: false,
        error: {
          code: error instanceof EveCliError || error instanceof EveRuntimeConfigError
            ? error.code : "EVE_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : "The Eden command failed unexpectedly.",
          ...(error instanceof EveCliError || error instanceof EveRuntimeConfigError ? {
            remediation: error.remediation,
            ...(error.source === undefined ? {} : { source: error.source }),
            ...(error instanceof EveCliError && error.diagnostics.length > 0 ? { diagnostics: error.diagnostics } : {}),
          } : {
            remediation: UNEXPECTED_FAILURE_REMEDIATION,
          }),
        },
      };
    }
    // Redact strings before serialization so replacement cannot break JSON escaping.
    writeStdout(JSON.stringify(result, (_key, value: unknown) =>
      typeof value === "string" ? redactEveRuntimeOutput(value) : value));
  };
  const stderr = options.stderr ?? defaultStderr;
  const startedAt = Date.now();
  let telemetryCommand: EveCliExecutionRequest["command"] | undefined;
  let projectRoot: string | undefined;
  let failure: unknown;
  try {
    if (
      args.length === 0 ||
      args[0] === "--help" ||
      args[0] === "-h"
    ) {
      stdout(USAGE.trimEnd());
      if (json) flushJson();
      return 0;
    }
    if (args[0] === "--version" || args[0] === "-v") {
      stdout(edenVersion());
      if (json) flushJson();
      return 0;
    }
    if (args[0] === "skill") {
      if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
        stdout("Usage: eden skill");
        if (json) flushJson();
        return 0;
      }
      if (args.length !== 1) {
        throw new EveCliError({
          code: "EVE_ARGUMENT_UNKNOWN",
          message: "eden skill takes no arguments or options.",
        });
      }
      const skill = readFileSync(new URL("./SKILL.md", import.meta.url), "utf8");
      stdout(skill);
      if (json) flushJson();
      return 0;
    }
    if (!(EVE_CLI_COMMANDS as readonly string[]).includes(args[0] ?? "")) {
      throw new EveCliError({
        code: "COMMAND_UNKNOWN",
        message: `Unknown Eden command "${args[0] ?? ""}".`,
      });
    }
    telemetryCommand = args[0] as EveCliExecutionRequest["command"];
    const parsed: ParsedEveInvocation = parseEveArguments(args);
    if (
      typeof parsed === "object" &&
      "kind" in parsed &&
      parsed.kind === "help"
    ) {
      telemetryCommand = undefined;
      stdout(eveHelpText(parsed.scope));
      if (json) flushJson();
      return 0;
    }
    projectRoot = resolve(options.cwd ?? process.cwd(), parsed.projectRoot);
    // The CLI that Eden runs for deploys needs this Node.
    const node = options.nodeVersion ?? process.versions.node;
    const [major = 0, minor = 0] = node.split(".").map(Number);
    // The Node lines cf 1.0.0-rc.2 declares, from 24 up.
    if (!((major === 24 && minor >= 22) || (major === 26 && minor >= 12))) {
      throw new EveCliError({
        code: "EVE_NODE_UNSUPPORTED",
        message: `Eden needs Node 24.22.0 or newer on the 24 line, or 26.12.0 or newer on the 26 line, and is running on Node ${node}.`,
        remediation: "Install Node 24.22.0 or newer on the 24 line (for example: nvm install 24), check it with node --version, then run the command again.",
      });
    }
    const pin = pinnedCliProblem(options.cfVersion);
    if (pin !== undefined) throw new EveCliError({ code: "EVE_CF_UNAVAILABLE", ...pin });
    await runEveInvocation(parsed, {
      ...options,
      stdout,
      stderr,
    });
    if (json) flushJson();
    return 0;
  } catch (error: unknown) {
    failure = error;
    if (json) {
      flushJson(error);
      return 1;
    }
    for (const line of errorLines(error)) {
      stderr(redactEveRuntimeOutput(line));
    }
    return 1;
  } finally {
    if (options.telemetry === true && telemetryCommand !== undefined) {
      await sendTelemetry({
        command: telemetryCommand,
        edenVersion,
        failureCode: failure === undefined
          ? undefined
          : failure instanceof EveCliError || failure instanceof EveRuntimeConfigError
            ? failure.code
            : "EVE_EXECUTION_FAILED",
        durationMs: Date.now() - startedAt,
        projectRoot,
      }, process.env, stderr);
    }
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  return runEdenCli(args, { telemetry: true });
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

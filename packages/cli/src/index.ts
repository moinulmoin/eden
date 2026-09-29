#!/usr/bin/env -S node --

import {
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
  EVE_USAGE,
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
  loadEveRuntimeConfig,
  parseEveRuntimeConfig,
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
  EveCliRunner,
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
  EveProjectRuntime,
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
  EvePreflightCheck,
  EvePreflightCheckStatus,
  EvePreflightOptions,
  EvePreflightResult,
  EvePreflightRuntimeEvidence,
  EvePreflightRuntimeRunner,
  EvePreflightRuntimeRunnerRequest,
  EveRuntimeConfigLoader,
  EveRuntimeImageDiscardRunner,
  EveWorkerDeleteRunner,
} from "./eve-control-plane.js";

export const EDEN_CLI_COMMANDS = [
  "preflight",
  "deploy",
  "destroy",
] as const;

export type EdenCliCommand = (typeof EDEN_CLI_COMMANDS)[number];

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
}



const USAGE = `Usage: eden <command> [options]

Commands:
  preflight  Build and inspect a local Eve candidate without remote mutation
  deploy     Deploy the selected Eve project to the exact named target
  destroy    Remove the exact owned Eve target

preflight and deploy default to the current directory, the preview
environment, and a target name derived from package.json. destroy and
--env production always require an explicit --name.
Run eden <preflight|deploy|destroy> --help for command-specific options.
`;

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

function errorLines(error: unknown): readonly string[] {
  if (error instanceof EveCliError) {
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
  if (error instanceof EveRuntimeConfigError) {
    const source = error.source === undefined ? "" : ` [${error.source}]`;
    return [`${error.code}${source}: ${error.message}`];
  }
  return [
    error instanceof Error
      ? error.message
      : "The Eden command failed unexpectedly.",
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
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  try {
    if (
      args.length === 0 ||
      args[0] === "--help" ||
      args[0] === "-h"
    ) {
      stdout(USAGE.trimEnd());
      return 0;
    }
    if (!(EVE_CLI_COMMANDS as readonly string[]).includes(args[0] ?? "")) {
      throw new EveCliError({
        code: "COMMAND_UNKNOWN",
        message: `Unknown Eden command "${args[0] ?? ""}".`,
      });
    }
    const parsed: ParsedEveInvocation = parseEveArguments(args);
    if (
      typeof parsed === "object" &&
      "kind" in parsed &&
      parsed.kind === "help"
    ) {
      stdout(eveHelpText(parsed.scope));
      return 0;
    }
    await runEveInvocation(parsed, {
      ...options,
      stdout,
      stderr,
    });
    return 0;
  } catch (error: unknown) {
    for (const line of errorLines(error)) {
      stderr(redactEveRuntimeOutput(line));
    }
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
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

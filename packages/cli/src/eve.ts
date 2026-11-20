import { createHash } from "node:crypto";

export const EVE_CLI_COMMANDS = [
  "preflight",
  "deploy",
  "destroy",
] as const;

export type EveCliCommand = (typeof EVE_CLI_COMMANDS)[number];
export type EveCliEnvironment = "preview" | "production";

export interface EveCliInvocation {
  readonly kind: "invocation";
  readonly command: EveCliCommand;
  readonly projectRoot: string;
  readonly environment: EveCliEnvironment;
  /**
   * Absent only on preflight/deploy preview invocations; index.ts derives a
   * deterministic Worker name from the project before execution.
   */
  readonly name?: string;
  readonly envFile?: string;
  /** When true the command prints the machine-readable result object. */
  readonly json?: boolean;
}

export interface EveCliHelp {
  readonly kind: "help";
  readonly scope: EveCliCommand;
}

export type ParsedEveInvocation = EveCliHelp | EveCliInvocation;

export interface EveCliExecutionRequest {
  readonly command: EveCliCommand;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly environment: EveCliEnvironment;
  readonly name: string;
  /**
   * The path is intentionally opaque at this boundary. The deployment-safety
   * layer is the only owner allowed to open or parse its contents.
   */
  readonly envFile?: string;
  /** When true the command prints the machine-readable result object. */
  readonly json?: boolean;
}

export interface EveCliDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
}

export class EveCliError extends Error {
  readonly code: string;
  readonly source: string | undefined;
  readonly diagnostics: readonly EveCliDiagnostic[];
  readonly remediation: string;

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly source?: string;
    readonly diagnostics?: readonly EveCliDiagnostic[];
    readonly remediation?: string;
  }) {
    super(options.message);
    this.name = "EveCliError";
    this.code = options.code;
    this.source = options.source;
    this.diagnostics = options.diagnostics ?? [];
    this.remediation = options.remediation ?? eveErrorRemediation(options.code);
  }
}

function eveErrorRemediation(code: string): string {
  switch (code) {
    case "COMMAND_UNKNOWN":
    case "EVE_COMMAND_UNKNOWN":
    case "EVE_ARGUMENT_UNKNOWN":
    case "EVE_OPTION_UNKNOWN":
    case "EVE_OPTION_VALUE_MISSING":
    case "EVE_PROJECT_INVALID":
    case "EVE_PROJECT_REPEATED":
    case "EVE_ENV_INVALID":
    case "EVE_ENV_REPEATED":
    case "EVE_NAME_INVALID":
    case "EVE_NAME_REPEATED":
    case "EVE_ENV_FILE_INVALID":
    case "EVE_ENV_FILE_REPEATED":
      return "Run eden --help to see supported commands and options.";
    case "EVE_ENV_FILE_UNSUPPORTED":
      return "Rerun eden destroy without --env-file; cleanup needs no application secrets.";
    case "EVE_NAME_REQUIRED":
      return "Rerun with --name <name>. For destroy, use the exact name the deploy printed.";
    case "EVE_NAME_DERIVATION_FAILED":
      return "Rerun with an explicit --name <name>.";
    case "VERSION_UNAVAILABLE":
    case "EVE_HOST_BUNDLE_UNAVAILABLE":
      return "Reinstall Eden from the published package with your existing package manager.";
    case "EVE_PREFLIGHT_FAILED":
      return "Fix each failed check using its remediation, then rerun eden preflight.";
    case "EVE_DEPLOY_CHECKS_FAILED":
      return "Fix each failed check using its remediation, then rerun eden deploy.";
    case "EVE_DEPLOY_BUSY":
      return "Wait for the other eden run on this target to finish, then retry. If that run was killed, confirm no eden process is still running before you remove .eden/eve-deploy/locks/<env>-<name>.lock by hand.";
    case "EVE_DEPLOY_LOCK_RELEASE_UNPROVEN":
      return "Confirm no eden process is still running against the target, then remove the stale lock file at .eden/eve-deploy/locks/<env>-<name>.lock.";
    case "EVE_DEPLOY_PROMOTION_FAILED":
      return "Inspect the local record under .eden/eve-deploy/targets/<env>-<name>/CURRENT and the live target before retrying.";
    case "EVE_DEPLOYMENT_FAILED":
      return "Read the last check and .eden/eve-deploy/generations/<generation>/deployment.json, resolve the cause, then rerun eden deploy for the same target.";
    case "EVE_RUNTIME_IMAGE_CLEANUP_FAILED":
      return "The deployment is live; do not redeploy. Remove only the recorded local runtime image, or what the failed VAL-LIFE-007 check names in the superseded registry repository.";
    case "EVE_IMAGE_IDENTITY_MISMATCH":
      return "Rerun eden deploy so Eden resolves the image reference from the verified local image again.";
    case "EVE_IMAGE_IDENTITY_UNAVAILABLE":
      return "Rebuild with the pinned Docker or OrbStack runtime by rerunning eden deploy.";
    case "EVE_UPDATE_RECORD_UNAVAILABLE":
      return "Re-run the last successful deploy generation, or destroy the exact target with eden destroy.";
    case "EVE_ORIGIN_UNAVAILABLE":
      return "Run npx wrangler@4.147.0 whoami to confirm the account, log in with npx wrangler@4.147.0 login if needed, then retry.";
    case "EVE_HOST_CONFIG_INVALID":
      return "Correct the value the message names, then rerun eden deploy.";
    case "EVE_PROJECT_ROOT_INVALID":
      return "Pass --project with an existing canonical project directory, not a symbolic link.";
    case "DEPLOY_INDETERMINATE":
      return "Check the deployment URL's /eve/v1/health and inspect the retained .eden evidence, then rerun eden deploy with the exact same --project, --env, and --name. Never switch names, delete resources by prefix, or delete .eden.";
    case "EVE_AFFINITY_REQUIRED":
      return "Install a World package declaring deploymentAffinity, then rerun eden deploy for the same target.";
    case "EVE_AFFINITY_LIMIT":
      return "Let the listed deployments finish their live sessions, runs, messages, and transfers, then rerun eden deploy for the same target.";
    case "EVE_AFFINITY_CONTROL_ACTIVATION_TIMEOUT":
      return "Check the existing deployment's health and connectivity, then rerun eden deploy for the same target after its deployment-control credential activates.";
    case "EVE_AFFINITY_DRAIN_UNPROVEN":
    case "EVE_AFFINITY_RETIRE_UNPROVEN":
      return "Check the authenticated World's deployment-control response and health, then rerun eden deploy for the same target. Retain .eden and the existing deployments.";
    case "EVE_DESTROY_FAILED":
      return "Inspect the retained .eden evidence and Cloudflare target state, then rerun eden destroy with the same --project, --env, and --name.";
    case "EVE_DESTROY_RECORD_UNPROVEN":
      return "Run eden destroy from the project you deployed, or pass that project with --project, using the exact --env and --name the deploy printed; its .eden folder holds the deployment record. If this target was never deployed from this project, there is nothing for Eden to destroy.";
    case "EVE_DESTROY_RECORD_MISMATCH":
      return "Rerun eden destroy with the exact --env and --name the deploy printed.";
    case "EVE_DESTROY_OWNERSHIP_UNPROVEN":
      return "Run npx wrangler@4.147.0 whoami and sign in to the account that owns this deployment if it names another. If the account is right and the last eden deploy ended DEPLOY_INDETERMINATE, its publish may have stopped partway: wait a minute and rerun eden destroy. If it still refuses, stop and read EVE_DESTROY_OWNERSHIP_UNPROVEN in docs/troubleshooting.md. Eden will not delete a different Worker that now uses this name.";
    case "EVE_DESTROY_INDETERMINATE":
    case "EVE_DESTROY_ABSENCE_UNPROVEN":
      return "Wait a minute for Cloudflare to settle, then rerun eden destroy with the same --project, --env, and --name. Keep the .eden folder; never delete resources by name prefix.";
    case "EVE_DESTROY_IMAGES_RETAINED":
      return "Rerun eden destroy with the same --project, --env, and --name: it deletes what the registry still lists, verifies the registry, and clears the target's CURRENT pointer. A rerun that finds nothing left reports absent; nothing more is needed then. Deleting tags by hand with npx wrangler@4.147.0 containers images delete <repository:tag> removes no sha256: entry, so rerun eden destroy afterwards. An object with one of the three kept answers (refused-snapshot, refused-singleton-artifact, accepted-still-listed) is reported as EVE_REGISTRY_OBJECTS_KEPT and does not count here. Eden reads the registry's listing and each answer with direct requests to registry.cloudflare.com and never uses a proxy for them; if this machine cannot reach the registry directly, rerun eden destroy from one that can.";
    case "EVE_DESTROY_POINTER_UNCLEARED":
      return "The Cloudflare resources are gone; only the local .eden/eve-deploy/targets/<env>-<name>/CURRENT pointer is left. Check that the .eden folder is writable, then rerun eden destroy with the same --project, --env, and --name.";
    case "EVE_EXECUTION_FAILED":
      return "Run eden preflight with the same --project, --env, and --name and resolve its failed checks before retrying.";
    default:
      return "Look up this code in docs/troubleshooting.md and resolve the reported cause before retrying the same command.";
  }
}

export const EVE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const EVE_COMMAND_USAGE: Readonly<Record<EveCliCommand, string>> = {
  preflight: `Usage: eden preflight [--project <path>] [--env <preview|production>] [--name <name>] [--env-file <path>] [--json]

Build and inspect an immutable local Eve candidate. Preflight is read-only toward remote resources.

Options:
  --project <path>     Eve project root (default: current directory)
  --env <environment>  preview or production target (default: preview)
  --name <name>        Exact target name (default: derived from the project's package.json; required for production)
  --env-file <path>    Optional opaque runtime environment file
  --json               Print the machine-readable result object (default: human summary)
  --help               Show this help
`,
  deploy: `Usage: eden deploy [--project <path>] [--env <preview|production>] [--name <name>] [--env-file <path>] [--json]

Deploy the selected Eve project to one exact target after host checks pass. When the exact target already exists and Eden's immutable record proves it owns it, deploy updates the Worker in place and keeps Durable Object data; a target Eden cannot prove it owns still fails the conflict check.

Options:
  --project <path>     Eve project root (default: current directory)
  --env <environment>  preview or production target (default: preview)
  --name <name>        Exact target name (default: derived from the project's package.json; required for production)
  --env-file <path>    Optional opaque runtime environment file
  --json               Print the machine-readable result object (default: human summary)
  --help               Show this help

When an update removes a superseded version and Cloudflare's registry still
lists some of its objects, deploy adds the warning EVE_REGISTRY_OBJECTS_KEPT.
With --json the result then lists it in warnings and adds registryObjectsKept:
one { ref, class } per object, where class is the registry's answer
(refused-snapshot, refused-singleton-artifact, or accepted-still-listed).

Each pushed image is tagged with its generation ID. A same-version update
deletes the image it replaced by its tag after promotion. When that delete
cannot be shown, deploy still succeeds and adds the warning
EVE_SUPERSEDED_IMAGE_NOT_DELETED; the next same-version deploy tries again.
`,
  destroy: `Usage: eden destroy --name <name> [--project <path>] [--env <preview|production>] [--json]

Destroy only the exact owned Eve target after ownership verification.

Options:
  --name <name>        Required exact target name
  --project <path>     Eve project root (default: current directory)
  --env <environment>  preview or production target (default: preview)
  --json               Print the machine-readable result object (default: human summary)
  --help               Show this help

Destroy deletes everything Cloudflare's registry lists for the target. The
registry keeps some objects: it refuses to delete container snapshots and
its own chain artifacts, and it can accept the delete of a manifest and
still list it. When those are all that is left, destroy succeeds with
the warning EVE_REGISTRY_OBJECTS_KEPT. With --json the result then adds
warnings and registryObjectsKept: one { ref, class } per object, where class
is the registry's answer (refused-snapshot, refused-singleton-artifact, or
accepted-still-listed).
`,
};

function eveError(
  code: string,
  message: string,
  source?: string,
): EveCliError {
  return new EveCliError({
    code,
    message,
    ...(source === undefined ? {} : { source }),
  });
}

function parseOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): { readonly value: string; readonly nextIndex: number } {
  const value = args[index + 1];
  if (
    value === undefined ||
    value.length === 0 ||
    value.startsWith("-")
  ) {
    throw eveError(
      "EVE_OPTION_VALUE_MISSING",
      `The ${option} option requires a value.`,
    );
  }
  return { value, nextIndex: index + 1 };
}

function parseProjectValue(value: string): string {
  if (value.length === 0) {
    throw eveError(
      "EVE_PROJECT_INVALID",
      "The --project option requires a non-empty path.",
    );
  }
  return value;
}

function parseEnvironmentValue(value: string): EveCliEnvironment {
  if (value === "preview" || value === "production") return value;
  throw eveError(
    "EVE_ENV_INVALID",
    "The --env option must be preview or production.",
  );
}

function parseNameValue(value: string): string {
  if (!EVE_NAME_PATTERN.test(value)) {
    throw eveError(
      "EVE_NAME_INVALID",
      "The --name option must be a lowercase alphanumeric target name with optional dashes.",
    );
  }
  return value;
}

function parseEnvFileValue(value: string): string {
  if (value.length === 0) {
    throw eveError(
      "EVE_ENV_FILE_INVALID",
      "The --env-file option requires a non-empty path.",
    );
  }
  return value;
}

function parseCommand(
  value: string | undefined,
): EveCliCommand {
  if (
    value === "preflight" ||
    value === "deploy" ||
    value === "destroy"
  ) {
    return value;
  }
  throw eveError(
    "EVE_COMMAND_UNKNOWN",
    `Unknown Eve command "${value ?? ""}".`,
  );
}


export function eveHelpText(scope: EveCliHelp["scope"]): string {
  return EVE_COMMAND_USAGE[scope].trimEnd();
}

export function parseEveArguments(
  args: readonly string[],
): ParsedEveInvocation {
  const command = parseCommand(args[0]);
  if (
    args.length === 2 &&
    (args[1] === "--help" || args[1] === "-h")
  ) {
    return { kind: "help", scope: command };
  }


  let projectRoot: string | undefined;
  let environment: EveCliEnvironment | undefined;
  let name: string | undefined;
  let envFile: string | undefined;
  let help = false;
  let json = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      throw eveError(
        "EVE_ARGUMENT_UNKNOWN",
        "The Eve command contains an invalid argument.",
      );
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--project") {
      if (projectRoot !== undefined) {
        throw eveError(
          "EVE_PROJECT_REPEATED",
          "The --project option may be supplied only once.",
        );
      }
      const parsed = parseOptionValue(args, index, "--project");
      projectRoot = parseProjectValue(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (argument.startsWith("--project=")) {
      if (projectRoot !== undefined) {
        throw eveError(
          "EVE_PROJECT_REPEATED",
          "The --project option may be supplied only once.",
        );
      }
      projectRoot = parseProjectValue(argument.slice("--project=".length));
      continue;
    }
    if (argument === "--env") {
      if (environment !== undefined) {
        throw eveError(
          "EVE_ENV_REPEATED",
          "The --env option may be supplied only once.",
        );
      }
      const parsed = parseOptionValue(args, index, "--env");
      environment = parseEnvironmentValue(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (argument.startsWith("--env=")) {
      if (environment !== undefined) {
        throw eveError(
          "EVE_ENV_REPEATED",
          "The --env option may be supplied only once.",
        );
      }
      environment = parseEnvironmentValue(argument.slice("--env=".length));
      continue;
    }
    if (argument === "--name") {
      if (name !== undefined) {
        throw eveError(
          "EVE_NAME_REPEATED",
          "The --name option may be supplied only once.",
        );
      }
      const parsed = parseOptionValue(args, index, "--name");
      name = parseNameValue(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (argument.startsWith("--name=")) {
      if (name !== undefined) {
        throw eveError(
          "EVE_NAME_REPEATED",
          "The --name option may be supplied only once.",
        );
      }
      name = parseNameValue(argument.slice("--name=".length));
      continue;
    }
    if (argument === "--env-file") {
      if (command === "destroy") {
        throw eveError(
          "EVE_ENV_FILE_UNSUPPORTED",
          "The --env-file option is supported only by eden preflight and eden deploy.",
        );
      }
      if (envFile !== undefined) {
        throw eveError(
          "EVE_ENV_FILE_REPEATED",
          "The --env-file option may be supplied only once.",
        );
      }
      const parsed = parseOptionValue(args, index, "--env-file");
      envFile = parseEnvFileValue(parsed.value);
      index = parsed.nextIndex;
      continue;
    }
    if (argument.startsWith("--env-file=")) {
      if (command === "destroy") {
        throw eveError(
          "EVE_ENV_FILE_UNSUPPORTED",
          "The --env-file option is supported only by eden preflight and eden deploy.",
        );
      }
      if (envFile !== undefined) {
        throw eveError(
          "EVE_ENV_FILE_REPEATED",
          "The --env-file option may be supplied only once.",
        );
      }
      envFile = parseEnvFileValue(argument.slice("--env-file=".length));
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument.startsWith("-")) {
      throw eveError(
        "EVE_OPTION_UNKNOWN",
        `Unknown option ${argument.split("=")[0] ?? argument}.`,
      );
    }
    throw eveError(
      "EVE_ARGUMENT_UNKNOWN",
      "The Eve command does not accept positional arguments.",
    );
  }

  if (help) {
    return { kind: "help", scope: command };
  }
  const resolvedEnvironment = environment ?? "preview";
  const resolvedProjectRoot = projectRoot ?? ".";
  if (
    name === undefined &&
    (command === "destroy" || resolvedEnvironment === "production")
  ) {
    throw eveError(
      "EVE_NAME_REQUIRED",
      "An explicit --name is required for destroy and for production targets.",
    );
  }

  return {
    kind: "invocation",
    command,
    projectRoot: resolvedProjectRoot,
    environment: resolvedEnvironment,
    ...(name === undefined ? {} : { name }),
    ...(envFile === undefined ? {} : { envFile }),
    ...(json ? { json: true } : {}),
  };
}

const WORKER_NAME_LIMIT = 63;

/**
 * Derive a stable, collision-safe Cloudflare Worker name from a raw package
 * name. The sanitized slug is combined with a short digest of the raw name so
 * distinct package names that collide after sanitization stay distinct. The
 * result is deterministic across runs and always satisfies EVE_NAME_PATTERN.
 */
export function deriveEveTargetName(rawPackageName: string): string {
  const slug = rawPackageName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug.length === 0) {
    throw eveError(
      "EVE_NAME_DERIVATION_FAILED",
      "A target name could not be derived from the project package.json; pass an explicit --name.",
    );
  }
  const digest = createHash("sha256")
    .update(rawPackageName, "utf8")
    .digest("hex")
    .slice(0, 8);
  const stem = slug
    .slice(0, WORKER_NAME_LIMIT - digest.length - 1)
    .replace(/-+$/u, "");
  return `${stem}-${digest}`;
}

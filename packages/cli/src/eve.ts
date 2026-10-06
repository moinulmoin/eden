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


export type EveCliRunner = (
  request: EveCliExecutionRequest,
) => void | Promise<void>;

export interface EveCliDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
}

export class EveCliError extends Error {
  readonly code: string;
  readonly source: string | undefined;
  readonly diagnostics: readonly EveCliDiagnostic[];

  constructor(options: {
    readonly code: string;
    readonly message: string;
    readonly source?: string;
    readonly diagnostics?: readonly EveCliDiagnostic[];
  }) {
    super(options.message);
    this.name = "EveCliError";
    this.code = options.code;
    this.source = options.source;
    this.diagnostics = options.diagnostics ?? [];
  }
}

const EVE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const EVE_USAGE = `Usage: eden <preflight|deploy|destroy> [options]

Eden Deploy commands:
  preflight  Build and inspect a local Eve candidate without remote mutation
  deploy     Deploy the selected Eve project to the exact named target
  destroy    Remove the exact owned Eve target

Without flags, preflight and deploy use the current directory, the preview
environment, and a Worker name derived from the project's package.json name.
--env accepts only preview or production; production and destroy always
require an explicit --name. --env-file is accepted only by preflight and deploy.
All three commands print a human summary by default; --json prints the
machine-readable result object for scripts and CI.

Options:
  --help  Show this help
`;

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
`,
  destroy: `Usage: eden destroy --name <name> [--project <path>] [--env <preview|production>] [--json]

Destroy only the exact owned Eve target after ownership verification.

Options:
  --name <name>        Required exact target name
  --project <path>     Eve project root (default: current directory)
  --env <environment>  preview or production target (default: preview)
  --json               Print the machine-readable result object (default: human summary)
  --help               Show this help
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
        "The Eve command contains an unknown option.",
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

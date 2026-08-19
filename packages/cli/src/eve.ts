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
  readonly name: string;
  readonly envFile?: string;
}

export interface EveCliHelp {
  readonly kind: "help";
  readonly scope: "namespace" | EveCliCommand;
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

export const EVE_USAGE = `Usage: eden eve [command] [options]

Eve commands:
  preflight  Build and inspect a local Eve candidate without remote mutation
  deploy     Deploy the selected Eve candidate to the exact named target
  destroy    Remove the exact owned Eve target

Every Eve command requires --project, --env, and --name.
--env accepts only preview or production.
--env-file is accepted only by preflight and deploy.
Eden Native remains available through the top-level init, build, dev, and deploy commands.

Options:
  --help  Show this help
`;

const EVE_COMMAND_USAGE: Readonly<Record<EveCliCommand, string>> = {
  preflight: `Usage: eden eve preflight --project <path> --env <preview|production> --name <name> [--env-file <path>]

Build and inspect an immutable local Eve candidate. Preflight is read-only toward remote resources.

Options:
  --project <path>     Required canonical Eve project root
  --env <environment>  Required preview or production target
  --name <name>        Required exact target name
  --env-file <path>    Optional opaque runtime environment file
  --help               Show this help
`,
  deploy: `Usage: eden eve deploy --project <path> --env <preview|production> --name <name> [--env-file <path>]

Deploy the selected Eve project to one exact target after host checks pass.

Options:
  --project <path>     Required canonical Eve project root
  --env <environment>  Required preview or production target
  --name <name>        Required exact target name
  --env-file <path>    Optional opaque runtime environment file
  --help               Show this help
`,
  destroy: `Usage: eden eve destroy --project <path> --env <preview|production> --name <name>

Destroy only the exact owned Eve target after ownership verification.

Options:
  --project <path>     Required canonical Eve project root
  --env <environment>  Required preview or production target
  --name <name>        Required exact target name
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

function namespaceHelp(args: readonly string[]): EveCliHelp | undefined {
  if (args.length === 1) {
    return { kind: "help", scope: "namespace" };
  }
  if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
    return { kind: "help", scope: "namespace" };
  }
  return undefined;
}

export function eveHelpText(scope: EveCliHelp["scope"]): string {
  return scope === "namespace"
    ? EVE_USAGE.trimEnd()
    : EVE_COMMAND_USAGE[scope].trimEnd();
}

export function parseEveArguments(
  args: readonly string[],
): ParsedEveInvocation {
  if (args[0] !== "eve") {
    throw eveError(
      "EVE_NAMESPACE_REQUIRED",
      "Eve commands must start with the literal eve namespace.",
    );
  }

  const namespace = namespaceHelp(args);
  if (namespace !== undefined) return namespace;

  const command = parseCommand(args[1]);
  let projectRoot: string | undefined;
  let environment: EveCliEnvironment | undefined;
  let name: string | undefined;
  let envFile: string | undefined;
  let help = false;

  for (let index = 2; index < args.length; index += 1) {
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
          "The --env-file option is supported only by eve preflight and eve deploy.",
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
          "The --env-file option is supported only by eve preflight and eve deploy.",
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
  if (projectRoot === undefined) {
    throw eveError(
      "EVE_PROJECT_REQUIRED",
      "The --project option is required for every Eve command.",
    );
  }
  if (environment === undefined) {
    throw eveError(
      "EVE_ENV_REQUIRED",
      "The --env option is required for every Eve command.",
    );
  }
  if (name === undefined) {
    throw eveError(
      "EVE_NAME_REQUIRED",
      "The --name option is required for every Eve command.",
    );
  }

  return {
    kind: "invocation",
    command,
    projectRoot,
    environment,
    name,
    ...(envFile === undefined ? {} : { envFile }),
  };
}

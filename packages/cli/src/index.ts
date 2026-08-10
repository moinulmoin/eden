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
} from "child_process";

import {
  buildProject,
  createArtifactIdentity,
  EdenCompilerError,
  resolveContainedProjectPath,
  resolveProjectRoot,
} from "@eden/compiler";
import type {
  EdenManifest,
  EdenModuleMap,
} from "@eden/compiler";

export const EDEN_CLI_COMMANDS = [
  "init",
  "dev",
  "build",
  "deploy",
] as const;

export type EdenCliCommand = (typeof EDEN_CLI_COMMANDS)[number];

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

export interface EdenCliRunOptions {
  readonly cwd?: string;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly dryRunRunner?: (
    request: EdenCliDryRunRequest,
  ) => Promise<EdenCliDryRunResult>;
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
}

class EdenCliError extends Error {
  readonly code: string;
  readonly source: string | undefined;

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.name = "EdenCliError";
    this.code = options.code;
    this.source = options.source;
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
  dev     Run the local Eden Worker (not available in this CLI build)
  deploy  Deploy a validated Eden project (not available in this CLI build)

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

async function resolveWranglerExecutable(
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

async function createDryRunConfiguration(
  root: string,
  configPath: string,
  candidateDirectory: string,
): Promise<string> {
  const source = await readFile(configPath, "utf8");
  const relativeMain = relative(root, join(candidateDirectory, "agent-bundle.mjs"))
    .split("\\")
    .join("/");
  const extension = extname(configPath).toLowerCase();
  const contents = extension === ".toml"
    ? replaceTomlMain(source, relativeMain)
    : replaceJsonMain(source, relativeMain);
  const temporaryConfig = join(
    root,
    `${uniqueTemporaryName("eden-build-config")}${extension || ".jsonc"}`,
  );
  assertWithinRoot(root, temporaryConfig, "The temporary build configuration");
  await writeFile(temporaryConfig, contents, { encoding: "utf8", flag: "wx" });
  return temporaryConfig;
}

function runDefaultDryRun(
  request: EdenCliDryRunRequest,
): Promise<EdenCliDryRunResult> {
  return resolveWranglerExecutable(request.cwd).then(
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
): Promise<void> {
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
  let promoted = false;
  try {
    const result = await buildProject({
      projectRoot: root,
      outputDirectory: candidateOutput,
    });
    await assertArtifactDirectory(candidateOutput);
    temporaryConfig = await createDryRunConfiguration(
      root,
      configuration.configPath,
      candidateOutput,
    );
    const request: EdenCliDryRunRequest = {
      cwd: root,
      configPath: temporaryConfig,
      originalConfigPath: configuration.configPath,
      args: [
        "deploy",
        "--dry-run",
        "--config",
        temporaryConfig,
      ],
    };
    const dryRun = await (options.dryRunRunner ?? runDefaultDryRun)(request);
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
  } finally {
    if (!promoted) {
      await rm(candidateOutput, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    if (temporaryConfig !== undefined) {
      await rm(temporaryConfig, { force: true }).catch(() => undefined);
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
    return [`${error.code}${source}: ${error.message}`];
  }
  return [
    error instanceof Error
      ? error.message
      : "The Eden command failed unexpectedly.",
  ];
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
      throw cliError({
        code: "COMMAND_NOT_READY",
        message: "eden dev is not available in this CLI build.",
      });
    case "deploy":
      throw cliError({
        code: "COMMAND_NOT_READY",
        message: "eden deploy is not available in this CLI build.",
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

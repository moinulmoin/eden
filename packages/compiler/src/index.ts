/*
 * Modified derivative of portable Eve concepts. Eve 0.31.3 reference commit:
 * 0b102bc90e7cf2c3e294f6ca3af86c307d449b1a. See repository NOTICE and LICENSE.
 */

import { build } from "esbuild";
import {
  createHash,
} from "crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "path";

import type {
  EdenAgentDefinition,
  EdenArtifactSet,
  EdenBuildMetadata,
  EdenDiagnostic,
  EdenInstructionManifest,
  EdenJsonValue,
  EdenModuleMap,
  EdenManifest,
  EdenSourceReference,
  EdenStandardSchemaIssue,
  EdenStandardSchemaV1,
  EdenToolContext,
} from "@eden/definitions";
import {
  EDEN_AGENT_BUNDLE_VERSION,
  EDEN_MANIFEST_VERSION,
  EDEN_PROTOCOL_VERSION,
  EDEN_RUNTIME_VERSION,
  EDEN_SCHEMA_VERSION,
} from "@eden/definitions";

export {
  EDEN_AGENT_BUNDLE_VERSION,
  EDEN_MANIFEST_VERSION,
  EDEN_PROTOCOL_VERSION,
  EDEN_RUNTIME_VERSION,
  EDEN_SCHEMA_VERSION,
} from "@eden/definitions";
export type {
  EdenAgentDefinition,
  EdenArtifactSet,
  EdenBuildMetadata,
  EdenDiagnostic,
  EdenDiscoveryRecord,
  EdenInstructionManifest,
  EdenModuleMap,
  EdenManifest,
  EdenSourceReference,
  EdenToolManifest,
} from "@eden/definitions";

export interface EdenCompilerOptions {
  readonly projectRoot: string;
  readonly outputDirectory?: string;
}

export interface EdenCompilerResult {
  readonly artifacts: EdenArtifactSet;
  readonly diagnostics: readonly EdenDiagnostic[];
}

export interface EdenCompiler {
  readonly version: string;
  build(options: EdenCompilerOptions): Promise<EdenCompilerResult>;
}

export class EdenCompilerError extends Error {
  readonly diagnostics: readonly EdenDiagnostic[];

  constructor(message: string, diagnostics: readonly EdenDiagnostic[] = []) {
    super(message);
    this.name = "EdenCompilerError";
    this.diagnostics = diagnostics;
  }
}

export class EdenSchemaValidationError extends EdenCompilerError {
  readonly issues: readonly EdenStandardSchemaIssue[];

  constructor(
    message: string,
    issues: readonly EdenStandardSchemaIssue[],
  ) {
    super(message, [
      {
        code: "SCHEMA_VALIDATION_FAILED",
        message,
        severity: "error",
      },
    ]);
    this.name = "EdenSchemaValidationError";
    this.issues = issues;
  }
}

export interface EdenProjectSelectionOptions {
  readonly projectRoot?: string;
  readonly cwd?: string;
}

export type EdenProjectSelection =
  | EdenProjectSelectionOptions
  | string;

export interface EdenDiscoveryResult {
  readonly projectRoot: string;
  readonly discovery: {
    readonly agent: EdenSourceReference;
    readonly instructions: EdenSourceReference;
    readonly tools: readonly EdenSourceReference[];
  };
  readonly diagnostics: readonly EdenDiagnostic[];
}

export interface EdenNormalizedTool {
  readonly name: string;
  readonly description: string;
  readonly source: EdenSourceReference;
  readonly inputSchema: EdenStandardSchemaV1<unknown>;
  readonly schema: {
    readonly vendor: string;
    readonly version: number;
  };
  readonly execute: (
    input: unknown,
    context: EdenToolContext,
  ) => EdenJsonValue | Promise<EdenJsonValue>;
}

export interface EdenNormalizedProject {
  readonly projectRoot: string;
  readonly discovery: EdenDiscoveryResult["discovery"];
  readonly agent: EdenAgentDefinition;
  readonly instructions: EdenInstructionManifest;
  readonly tools: readonly EdenNormalizedTool[];
}

export function createSourceReference(
  relativePath: string,
  sha256: string,
): EdenSourceReference {
  return { relativePath, sha256 };
}

export function createManifest(
  manifest: EdenManifest,
): EdenManifest {
  return manifest;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const REQUIRED_AGENT_PATH = "agent/agent.ts";
const REQUIRED_INSTRUCTIONS_PATH = "agent/instructions.md";
const TOOLS_DIRECTORY = "agent/tools";

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface SourcePathInfo {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly source: EdenSourceReference;
}

interface DiscoveryCandidate extends SourcePathInfo {
  readonly name: string;
}

const EMPTY_SOURCE = (relativePath: string): EdenSourceReference => ({
  relativePath,
  sha256: "",
});

function diagnostic(
  code: string,
  message: string,
  source?: string,
): EdenDiagnostic {
  return {
    code,
    message,
    ...(source === undefined ? {} : { source }),
    severity: "error",
  };
}

function asCompilerError(error: unknown): EdenCompilerError {
  if (error instanceof EdenCompilerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new EdenCompilerError(message);
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sourcePath(
  root: string,
  candidate: string,
  canonicalPath: string,
): SourcePathInfo {
  return {
    relativePath: toPosixPath(relative(root, candidate)),
    absolutePath: candidate,
    canonicalPath,
    source: EMPTY_SOURCE(toPosixPath(relative(root, candidate))),
  };
}

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function readUtf8File(path: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
}

async function readSourcePath(
  root: string,
  relativePath: string,
  diagnostics: EdenDiagnostic[],
): Promise<SourcePathInfo | undefined> {
  const lexicalPath = await resolveContainedProjectPath(root, relativePath).catch(
    (error: unknown) => {
      const compilerError = asCompilerError(error);
      diagnostics.push(
        ...compilerError.diagnostics.map((item) => ({
          ...item,
          source: item.source ?? relativePath,
        })),
      );
      return undefined;
    },
  );

  if (lexicalPath === undefined) return undefined;

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      diagnostics.push(
        diagnostic(
          "SOURCE_MISSING",
          `Required source "${relativePath}" does not exist.`,
          relativePath,
        ),
      );
      return undefined;
    }
    diagnostics.push(
      diagnostic(
        "SOURCE_UNREADABLE",
        `Unable to resolve source "${relativePath}".`,
        relativePath,
      ),
    );
    return undefined;
  }

  if (!isWithinRoot(root, canonicalPath)) {
    diagnostics.push(
      diagnostic(
        "PATH_OUTSIDE_PROJECT",
        `Source "${relativePath}" resolves outside the selected project root.`,
        relativePath,
      ),
    );
    return undefined;
  }

  try {
    const source = {
      relativePath: toPosixPath(relative(root, lexicalPath)),
      sha256: await hashFile(canonicalPath),
    };
    return {
      relativePath: source.relativePath,
      absolutePath: lexicalPath,
      canonicalPath,
      source,
    };
  } catch {
    diagnostics.push(
      diagnostic(
        "SOURCE_UNREADABLE",
        `Unable to read source "${relativePath}".`,
        relativePath,
      ),
    );
    return undefined;
  }
}

async function inspectToolEntries(
  root: string,
  diagnostics: EdenDiagnostic[],
): Promise<DiscoveryCandidate[]> {
  const toolsPath = join(root, TOOLS_DIRECTORY);
  let canonicalToolsPath: string;
  try {
    canonicalToolsPath = await realpath(toolsPath);
  } catch {
    canonicalToolsPath = toolsPath;
  }
  if (!isWithinRoot(root, canonicalToolsPath)) {
    diagnostics.push(
      diagnostic(
        "PATH_OUTSIDE_PROJECT",
        `Tool directory "${TOOLS_DIRECTORY}" resolves outside the selected project root.`,
        TOOLS_DIRECTORY,
      ),
    );
    return [];
  }
  let entries: readonly {
    readonly name: string;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
  }[];
  try {
    entries = await readdir(toolsPath, { withFileTypes: true });
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    diagnostics.push(
      diagnostic(
        "TOOLS_UNREADABLE",
        `Unable to read the direct tool directory "${TOOLS_DIRECTORY}".`,
        TOOLS_DIRECTORY,
      ),
    );
    return [];
  }

  const candidates: DiscoveryCandidate[] = [];
  const sortedEntries = [...entries].sort((left, right) =>
    comparePath(left.name, right.name),
  );
  for (const entry of sortedEntries) {
    const relativePath = `${TOOLS_DIRECTORY}/${entry.name}`;
    const absolutePath = join(root, TOOLS_DIRECTORY, entry.name);

    if (entry.isDirectory()) {
      diagnostics.push(
        diagnostic(
          "TOOL_NESTED_UNSUPPORTED",
          `Nested tool directories are unsupported; move "${relativePath}" directly under "${TOOLS_DIRECTORY}".`,
          relativePath,
        ),
      );
      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(".ts")) continue;

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch {
      diagnostics.push(
        diagnostic(
          "PATH_OUTSIDE_PROJECT",
          `Tool source "${relativePath}" is an unresolved symbolic link or does not exist.`,
          relativePath,
        ),
      );
      continue;
    }
    if (!isWithinRoot(root, canonicalPath)) {
      diagnostics.push(
        diagnostic(
          "PATH_OUTSIDE_PROJECT",
          `Tool source "${relativePath}" resolves outside the selected project root.`,
          relativePath,
        ),
      );
      continue;
    }
    let candidateStat;
    try {
      candidateStat = await stat(canonicalPath);
    } catch {
      diagnostics.push(
        diagnostic(
          "SOURCE_MISSING",
          `Tool source "${relativePath}" does not exist.`,
          relativePath,
        ),
      );
      continue;
    }
    if (!candidateStat.isFile()) {
      diagnostics.push(
        diagnostic(
          "TOOL_NESTED_UNSUPPORTED",
          `Tool source "${relativePath}" must be a TypeScript file, not a directory.`,
          relativePath,
        ),
      );
      continue;
    }

    const source: EdenSourceReference = {
      relativePath,
      sha256: await hashFile(canonicalPath),
    };
    candidates.push({
      ...sourcePath(root, absolutePath, canonicalPath),
      source,
      name: basename(entry.name, ".ts"),
    });
  }

  candidates.sort((left, right) => {
    const leftKey = toPosixPath(relative(root, left.canonicalPath));
    const rightKey = toPosixPath(relative(root, right.canonicalPath));
    return comparePath(leftKey, rightKey) || comparePath(left.relativePath, right.relativePath);
  });
  return candidates;
}

function emptyDiscovery(): EdenDiscoveryResult["discovery"] {
  return {
    agent: EMPTY_SOURCE(REQUIRED_AGENT_PATH),
    instructions: EMPTY_SOURCE(REQUIRED_INSTRUCTIONS_PATH),
    tools: [],
  };
}

export async function resolveProjectRoot(
  selection: EdenProjectSelection = {},
): Promise<string> {
  const options =
    typeof selection === "string" ? { projectRoot: selection } : selection;
  const selected = options.projectRoot ?? options.cwd ?? process.cwd();
  if (selected.trim().length === 0) {
    throw new EdenCompilerError("A project root must not be empty", [
      diagnostic(
        "PROJECT_ROOT_INVALID",
        "Select a non-empty project root before compiling.",
      ),
    ]);
  }

  const candidate = resolve(options.cwd ?? process.cwd(), selected);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new EdenCompilerError("The selected project root is unavailable", [
      diagnostic(
        "PROJECT_ROOT_INVALID",
        `Selected project root "${selected}" does not exist or cannot be resolved.`,
      ),
    ]);
  }

  try {
    const details = await stat(canonical);
    if (!details.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new EdenCompilerError("The selected project root is not a directory", [
      diagnostic(
        "PROJECT_ROOT_INVALID",
        `Selected project root "${selected}" must be a readable directory.`,
      ),
    ]);
  }
  return canonical;
}

export async function resolveContainedProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  const root = await realpath(projectRoot).catch(() => {
    throw new EdenCompilerError("The selected project root is unavailable", [
      diagnostic(
        "PROJECT_ROOT_INVALID",
        `Selected project root "${projectRoot}" does not exist or cannot be resolved.`,
      ),
    ]);
  });
  const candidate = isAbsolute(relativePath)
    ? normalize(relativePath)
    : resolve(root, relativePath);

  if (!isWithinRoot(root, candidate)) {
    throw new EdenCompilerError("Project path escapes the selected root", [
      diagnostic(
        "PATH_OUTSIDE_PROJECT",
        `Path "${relativePath}" escapes the selected project root.`,
        relativePath,
      ),
    ]);
  }

  try {
    const canonical = await realpath(candidate);
    if (!isWithinRoot(root, canonical)) {
      throw new EdenCompilerError("Project path escapes the selected root", [
        diagnostic(
          "PATH_OUTSIDE_PROJECT",
          `Path "${relativePath}" resolves outside the selected project root.`,
          relativePath,
        ),
      ]);
    }
  } catch (error: unknown) {
    if (error instanceof EdenCompilerError) throw error;
    const details = await lstat(candidate).catch(() => undefined);
    if (details?.isSymbolicLink()) {
      throw new EdenCompilerError("Project path cannot be resolved safely", [
        diagnostic(
          "PATH_OUTSIDE_PROJECT",
          `Path "${relativePath}" is an unresolved symbolic link.`,
          relativePath,
        ),
      ]);
    }
  }
  return candidate;
}

export async function discoverProject(
  selection: EdenProjectSelection = {},
): Promise<EdenDiscoveryResult> {
  const options =
    typeof selection === "string" ? { projectRoot: selection } : selection;
  let projectRoot: string;
  try {
    projectRoot = await resolveProjectRoot(options);
  } catch (error: unknown) {
    const compilerError = asCompilerError(error);
    return {
      projectRoot: options.projectRoot ?? options.cwd ?? process.cwd(),
      discovery: emptyDiscovery(),
      diagnostics: compilerError.diagnostics,
    };
  }

  const diagnostics: EdenDiagnostic[] = [];
  const agent = await readSourcePath(
    projectRoot,
    REQUIRED_AGENT_PATH,
    diagnostics,
  );
  const instructions = await readSourcePath(
    projectRoot,
    REQUIRED_INSTRUCTIONS_PATH,
    diagnostics,
  );
  const candidates = await inspectToolEntries(projectRoot, diagnostics);
  const names = new Map<string, DiscoveryCandidate>();

  for (const candidate of candidates) {
    if (!TOOL_NAME_PATTERN.test(candidate.name)) {
      diagnostics.push(
        diagnostic(
          "TOOL_NAME_INVALID",
          `Tool name "${candidate.name}" must start with lowercase and contain only lowercase letters, digits, "-" or "_".`,
          candidate.relativePath,
        ),
      );
    }
    const previous = names.get(candidate.name);
    if (previous !== undefined) {
      diagnostics.push(
        diagnostic(
          "TOOL_NAME_COLLISION",
          `Tool name "${candidate.name}" is derived from both "${previous.relativePath}" and "${candidate.relativePath}"; rename one source.`,
          candidate.relativePath,
        ),
      );
    } else {
      names.set(candidate.name, candidate);
    }

    const canonicalMatches = candidates.filter(
      (other) => other.canonicalPath === candidate.canonicalPath,
    );
    if (
      canonicalMatches.length > 1 &&
      canonicalMatches[0]?.relativePath === candidate.relativePath
    ) {
      for (const match of canonicalMatches.slice(1)) {
        diagnostics.push(
          diagnostic(
            "TOOL_CANONICAL_COLLISION",
            `Tool sources "${candidate.relativePath}" and "${match.relativePath}" resolve to the same canonical file; remove the alias.`,
            match.relativePath,
          ),
        );
      }
    }
  }

  return {
    projectRoot,
    discovery: {
      agent: agent?.source ?? EMPTY_SOURCE(REQUIRED_AGENT_PATH),
      instructions:
        instructions?.source ?? EMPTY_SOURCE(REQUIRED_INSTRUCTIONS_PATH),
      tools: candidates.map((candidate) => candidate.source),
    },
    diagnostics,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function schemaMetadata(
  value: unknown,
  source: string,
  diagnostics: EdenDiagnostic[],
): { readonly vendor: string; readonly version: number } | undefined {
  if (!isRecord(value) || !isRecord(value["~standard"])) {
    diagnostics.push(
      diagnostic(
        "SCHEMA_INVALID",
        "Tool inputSchema must implement Standard Schema v1 with a ~standard descriptor.",
        source,
      ),
    );
    return undefined;
  }
  const standard = value["~standard"];
  if (
    standard.version !== 1 ||
    typeof standard.vendor !== "string" ||
    standard.vendor.trim().length === 0 ||
    typeof standard.validate !== "function"
  ) {
    diagnostics.push(
      diagnostic(
        "SCHEMA_INVALID",
        "Tool inputSchema must expose version 1, a non-empty vendor, and a validate function.",
        source,
      ),
    );
    return undefined;
  }
  return { vendor: standard.vendor, version: standard.version };
}

function validateAgent(
  value: unknown,
  source: string,
  diagnostics: EdenDiagnostic[],
): EdenAgentDefinition | undefined {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        "AGENT_INVALID",
        "The default agent export must be an object.",
        source,
      ),
    );
    return undefined;
  }
  const allowed = new Set(["model", "options"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push(
        diagnostic(
          "AGENT_FIELD_UNSUPPORTED",
          `Agent field "${key}" is not supported by the Eden authoring contract.`,
          source,
        ),
      );
    }
  }
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    diagnostics.push(
      diagnostic(
        "AGENT_MODEL_INVALID",
        "The agent model must be a non-empty string.",
        source,
      ),
    );
    return undefined;
  }

  if (value.options === undefined) return { model: value.model };
  if (!isRecord(value.options)) {
    diagnostics.push(
      diagnostic(
        "AGENT_OPTIONS_INVALID",
        "Agent options must be an object when provided.",
        source,
      ),
    );
    return undefined;
  }

  const options = value.options;
  const optionKeys = new Set(["temperature", "maxOutputTokens", "thinking"]);
  for (const key of Object.keys(options)) {
    if (!optionKeys.has(key)) {
      diagnostics.push(
        diagnostic(
          "AGENT_OPTION_UNSUPPORTED",
          `Agent option "${key}" is not supported by the bounded model contract.`,
          source,
        ),
      );
    }
  }
  if (
    options.temperature !== undefined &&
    (typeof options.temperature !== "number" ||
      !Number.isFinite(options.temperature) ||
      options.temperature < 0 ||
      options.temperature > 2)
  ) {
    diagnostics.push(
      diagnostic(
        "AGENT_TEMPERATURE_INVALID",
        "Agent temperature must be a finite number between 0 and 2.",
        source,
      ),
    );
  }
  if (
    options.maxOutputTokens !== undefined &&
    (typeof options.maxOutputTokens !== "number" ||
      !Number.isInteger(options.maxOutputTokens) ||
      options.maxOutputTokens < 1 ||
      options.maxOutputTokens > 32768)
  ) {
    diagnostics.push(
      diagnostic(
        "AGENT_MAX_OUTPUT_TOKENS_INVALID",
        "Agent maxOutputTokens must be an integer between 1 and 32768.",
        source,
      ),
    );
  }
  if (options.thinking !== undefined && typeof options.thinking !== "boolean") {
    diagnostics.push(
      diagnostic(
        "AGENT_THINKING_INVALID",
        "Agent thinking must be a boolean.",
        source,
      ),
    );
  }

  const temperature =
    typeof options.temperature === "number" ? options.temperature : undefined;
  const maxOutputTokens =
    typeof options.maxOutputTokens === "number"
      ? options.maxOutputTokens
      : undefined;
  const thinking =
    typeof options.thinking === "boolean" ? options.thinking : undefined;
  const normalizedOptions = {
    ...(temperature === undefined
      ? {}
      : { temperature }),
    ...(maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens }),
    ...(thinking === undefined ? {} : { thinking }),
  };
  return {
    model: value.model,
    ...(Object.keys(normalizedOptions).length === 0
      ? {}
      : { options: normalizedOptions }),
  };
}

function standardSchemaResult(
  result: unknown,
): { kind: "value"; value: unknown } | { kind: "issues"; issues: EdenStandardSchemaIssue[] } {
  if (!isRecord(result)) return { kind: "issues", issues: [] };
  const hasValue = hasOwn(result, "value");
  const hasIssues = hasOwn(result, "issues");
  if (hasValue && !hasIssues) return { kind: "value", value: result.value };
  if (
    !hasValue &&
    hasIssues &&
    Array.isArray(result.issues) &&
    result.issues.every(
      (issue) =>
        isRecord(issue) &&
        typeof issue.message === "string" &&
        issue.message.trim().length > 0 &&
        (issue.path === undefined ||
          (Array.isArray(issue.path) &&
            issue.path.every(
              (segment) =>
                typeof segment === "string" || typeof segment === "number",
            ))),
    )
  ) {
    return {
      kind: "issues",
      issues: result.issues.map((issue) => ({
        message: issue.message as string,
        ...(issue.path === undefined
          ? {}
          : { path: issue.path as readonly (string | number)[] }),
      })),
    };
  }
  return { kind: "issues", issues: [] };
}

export async function validateStandardSchema<TOutput>(
  schema: EdenStandardSchemaV1<TOutput>,
  value: unknown,
): Promise<TOutput> {
  const descriptor = schema?.["~standard"];
  if (
    !descriptor ||
    descriptor.version !== 1 ||
    typeof descriptor.vendor !== "string" ||
    descriptor.vendor.trim().length === 0 ||
    typeof descriptor.validate !== "function"
  ) {
    throw new EdenCompilerError("Malformed Standard Schema descriptor", [
      diagnostic(
        "SCHEMA_INVALID",
        "The supplied schema does not implement Standard Schema v1.",
      ),
    ]);
  }
  let rawResult: unknown;
  try {
    rawResult = await descriptor.validate(value);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EdenCompilerError("Standard Schema validation threw", [
      diagnostic(
        "SCHEMA_VALIDATION_THROWN",
        `Standard Schema validation failed: ${message}`,
      ),
    ]);
  }
  const result = standardSchemaResult(rawResult);
  if (result.kind === "issues") {
    if (result.issues.length === 0) {
      throw new EdenCompilerError("Malformed Standard Schema result", [
        diagnostic(
          "SCHEMA_RESULT_INVALID",
          "Standard Schema validate must return exactly one value or a non-empty issues array.",
        ),
      ]);
    }
    throw new EdenSchemaValidationError(
      result.issues.map((issue) => issue.message).join("; "),
      result.issues,
    );
  }
  return result.value as TOutput;
}

function jsonValue(
  value: unknown,
  source?: string,
  stack: WeakSet<object> = new WeakSet(),
): EdenJsonValue {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) {
      throw new EdenCompilerError("Tool output is not JSON-compatible", [
        diagnostic(
          "TOOL_OUTPUT_INVALID",
          "Tool output must not contain circular references.",
          source,
        ),
      ]);
    }
    stack.add(value);
    try {
      return Array.from({ length: value.length }, (_, index) =>
        Object.prototype.hasOwnProperty.call(value, index)
          ? jsonValue(value[index], source, stack)
          : null,
      );
    } finally {
      stack.delete(value);
    }
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EdenCompilerError("Tool output is not JSON-compatible", [
        diagnostic(
          "TOOL_OUTPUT_INVALID",
          "Tool output must contain only JSON-compatible primitives, arrays, and plain objects.",
          source,
        ),
      ]);
    }
    if (stack.has(value)) {
      throw new EdenCompilerError("Tool output is not JSON-compatible", [
        diagnostic(
          "TOOL_OUTPUT_INVALID",
          "Tool output must not contain circular references.",
          source,
        ),
      ]);
    }
    stack.add(value);
    const output: Record<string, EdenJsonValue> = {};
    try {
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          value: jsonValue(item, source, stack),
          writable: true,
        });
      }
    } finally {
      stack.delete(value);
    }
    return output;
  }
  throw new EdenCompilerError("Tool output is not JSON-compatible", [
    diagnostic(
      "TOOL_OUTPUT_INVALID",
      "Tool output must contain only JSON-compatible primitives, arrays, and plain objects.",
      source,
    ),
  ]);
}

export function normalizeJsonValue(
  value: unknown,
  source?: string,
): EdenJsonValue {
  return jsonValue(value, source);
}

function importSourceIsUnsupported(source: string): boolean {
  return (
    /\bimport\s*\(/u.test(source) ||
    /\b(?:from\s*|import\s*)["']node:/u.test(source) ||
    /\b(?:from\s*|import\s*)["'](?:fs|path|url|module|os|crypto)["']/u.test(
      source,
    )
  );
}

async function loadDefaultExport(
  projectRoot: string,
  sourceInfo: SourcePathInfo,
  diagnostics: EdenDiagnostic[],
): Promise<unknown | undefined> {
  let source: string;
  try {
    source = await readUtf8File(sourceInfo.canonicalPath);
  } catch {
    diagnostics.push(
      diagnostic(
        "SOURCE_UNREADABLE",
        `Unable to read "${sourceInfo.relativePath}" for normalization.`,
        sourceInfo.relativePath,
      ),
    );
    return undefined;
  }
  if (importSourceIsUnsupported(source)) {
    diagnostics.push(
      diagnostic(
        "MODULE_IMPORT_UNSUPPORTED",
        `Module "${sourceInfo.relativePath}" imports a Node-only or dynamic dependency that is not supported in Eden authoring.`,
        sourceInfo.relativePath,
      ),
    );
    return undefined;
  }

  try {
    const result = await build({
      entryPoints: [sourceInfo.canonicalPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "es2022",
      write: false,
      logLevel: "silent",
      nodePaths: [
        join(projectRoot, "node_modules"),
        join(process.cwd(), "node_modules"),
      ],
      plugins: [
        {
          name: "eden-contained-source-imports",
          setup(context) {
            context.onResolve({ filter: /^(?:\.{1,2}(?:\/|$)|\/)/ }, async (args) => {
              const importerRoot = await realpath(args.resolveDir).catch(
                () => args.resolveDir,
              );
              const allowedDependencyRoot = [
                join(projectRoot, "node_modules"),
                join(process.cwd(), "node_modules"),
              ].some((dependencyRoot) =>
                isWithinRoot(dependencyRoot, importerRoot),
              );
              if (allowedDependencyRoot) return undefined;

              const resolvedImport = resolve(args.resolveDir, args.path);
              const canonicalImport = await realpath(resolvedImport).catch(
                () => resolvedImport,
              );
              if (!isWithinRoot(projectRoot, canonicalImport)) {
                return {
                  errors: [
                    {
                      text: `Import "${args.path}" from "${sourceInfo.relativePath}" escapes the selected project root.`,
                    },
                  ],
                };
              }
              return undefined;
            });
          },
        },
      ],
    });
    const output = result.outputFiles?.[0]?.text;
    if (output === undefined) throw new Error("esbuild emitted no module");
    const module = await import(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(output)}`
    );
    return module.default;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      diagnostic(
        "MODULE_LOAD_FAILED",
        `Unable to load "${sourceInfo.relativePath}": ${message}`,
        sourceInfo.relativePath,
      ),
    );
    return undefined;
  }
}

async function sourceInfoFor(
  projectRoot: string,
  relativePath: string,
): Promise<SourcePathInfo | undefined> {
  const candidate = await resolveContainedProjectPath(projectRoot, relativePath);
  const canonicalPath = await realpath(candidate);
  const source: EdenSourceReference = {
    relativePath,
    sha256: await hashFile(canonicalPath),
  };
  return {
    relativePath,
    absolutePath: candidate,
    canonicalPath,
    source,
  };
}

export async function normalizeProject(
  selection: EdenProjectSelection,
): Promise<EdenNormalizedProject> {
  const options =
    typeof selection === "string" ? { projectRoot: selection } : selection;
  const discovered = await discoverProject(options);
  const diagnostics = [...discovered.diagnostics];
  const root = discovered.projectRoot;
  const agentInfo = await sourceInfoFor(root, REQUIRED_AGENT_PATH).catch(
    () => undefined,
  );
  const instructionsInfo = await sourceInfoFor(
    root,
    REQUIRED_INSTRUCTIONS_PATH,
  ).catch(() => undefined);

  const agentValue =
    agentInfo === undefined
      ? undefined
      : await loadDefaultExport(root, agentInfo, diagnostics);
  const agent =
    agentInfo === undefined
      ? undefined
      : validateAgent(agentValue, REQUIRED_AGENT_PATH, diagnostics);

  let instructions: EdenInstructionManifest | undefined;
  if (instructionsInfo !== undefined) {
    try {
      instructions = {
        source: instructionsInfo.source,
        content: await readUtf8File(instructionsInfo.canonicalPath),
        sha256: instructionsInfo.source.sha256,
      };
    } catch {
      diagnostics.push(
        diagnostic(
          "SOURCE_UNREADABLE",
          `Unable to read "${REQUIRED_INSTRUCTIONS_PATH}" as UTF-8 Markdown.`,
          REQUIRED_INSTRUCTIONS_PATH,
        ),
      );
    }
  }

  const candidates: SourcePathInfo[] = [];
  for (const source of discovered.discovery.tools) {
    const absolutePath = join(root, source.relativePath);
    candidates.push({
      source,
      absolutePath,
      canonicalPath: await realpath(absolutePath).catch(() => absolutePath),
      relativePath: source.relativePath,
    });
  }
  candidates.sort((left, right) =>
    comparePath(left.relativePath, right.relativePath),
  );
  const tools: EdenNormalizedTool[] = [];
  for (const candidate of candidates) {
    const loaded = await loadDefaultExport(root, candidate, diagnostics);
    if (!isRecord(loaded)) {
      diagnostics.push(
        diagnostic(
          "TOOL_INVALID",
          "The default tool export must be an object.",
          candidate.relativePath,
        ),
      );
      continue;
    }
    if (hasOwn(loaded, "name") || hasOwn(loaded, "id")) {
      diagnostics.push(
        diagnostic(
          "TOOL_IDENTITY_FIELD",
          `Tool "${candidate.relativePath}" must not author a name or id; Eden derives identity from the filename.`,
          candidate.relativePath,
        ),
      );
      continue;
    }
    for (const key of Object.keys(loaded)) {
      if (!new Set(["description", "inputSchema", "execute"]).has(key)) {
        diagnostics.push(
          diagnostic(
            "TOOL_FIELD_UNSUPPORTED",
            `Tool field "${key}" is not supported by the Eden authoring contract.`,
            candidate.relativePath,
          ),
        );
      }
    }
    if (
      typeof loaded.description !== "string" ||
      loaded.description.trim().length === 0
    ) {
      diagnostics.push(
        diagnostic(
          "TOOL_DESCRIPTION_INVALID",
          "Tool description must be a non-empty string.",
          candidate.relativePath,
        ),
      );
      continue;
    }
    const schema = schemaMetadata(loaded.inputSchema, candidate.relativePath, diagnostics);
    if (schema === undefined) continue;
    if (typeof loaded.execute !== "function") {
      diagnostics.push(
        diagnostic(
          "TOOL_EXECUTE_INVALID",
          "Tool execute must be a function.",
          candidate.relativePath,
        ),
      );
      continue;
    }
    const name = basename(candidate.relativePath, ".ts");
    if (!TOOL_NAME_PATTERN.test(name)) continue;
    const execute = loaded.execute as EdenNormalizedTool["execute"];
    tools.push({
      name,
      description: loaded.description,
      source: candidate.source,
      inputSchema: loaded.inputSchema as EdenStandardSchemaV1<unknown>,
      schema,
      execute: async (input, context) =>
        normalizeJsonValue(await execute(input, context), candidate.relativePath),
    });
  }

  if (diagnostics.length > 0 || agent === undefined || instructions === undefined) {
    throw new EdenCompilerError(
      "Eden authoring normalization failed",
      diagnostics,
    );
  }

  return {
    projectRoot: root,
    discovery: discovered.discovery,
    agent,
    instructions,
    tools,
  };
}

const ARTIFACT_FILE_NAMES = {
  discovery: "discovery.json",
  diagnostics: "diagnostics.json",
  manifest: "manifest.json",
  moduleMap: "module-map.json",
  bundle: "agent-bundle.mjs",
  buildMetadata: "build-metadata.json",
} as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(comparePath)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifactModuleMap(
  normalized: EdenNormalizedProject,
): EdenModuleMap {
  return {
    kind: "eden.module-map",
    version: EDEN_AGENT_BUNDLE_VERSION,
    agent: {
      name: "agent",
      module: "agent:default",
      source: normalized.discovery.agent,
    },
    instructions: {
      name: "instructions",
      module: "instructions:default",
      source: normalized.discovery.instructions,
    },
    tools: normalized.tools.map((tool) => ({
      name: tool.name,
      module: `tool:${tool.name}`,
      source: tool.source,
    })),
  };
}

function sourceImportPath(relativePath: string): string {
  return `./${relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function bundleEntrySource(
  normalized: EdenNormalizedProject,
  moduleMap: EdenModuleMap,
): string {
  const agentImport = "edenAgent";
  const toolImports = normalized.tools.map((tool, index) => ({
    importName: `edenTool${index}`,
    path: sourceImportPath(tool.source.relativePath),
    tool,
  }));
  const imports = [
    `import ${agentImport} from ${JSON.stringify(sourceImportPath(normalized.discovery.agent.relativePath))};`,
    ...toolImports.map(
      ({ importName, path }) =>
        `import ${importName} from ${JSON.stringify(path)};`,
    ),
  ].join("\n");
  const toolEntries = toolImports
    .map(
      ({ importName, tool }) =>
        `[${JSON.stringify(tool.name)}, ${importName}]`,
    )
    .join(",\n    ");
  const toolModuleEntries = moduleMap.tools
    .map(
      ({ name, module }) =>
        `[${JSON.stringify(name)}, ${JSON.stringify(module)}]`,
    )
    .join(",\n    ");

  return `${imports}

const edenTools = Object.freeze(Object.fromEntries([
    ${toolEntries}
  ]));

export const agent = edenAgent;
export const instructions = ${JSON.stringify(normalized.instructions.content)};
export const tools = edenTools;
export const moduleMap = Object.freeze({
  agent: ${JSON.stringify(moduleMap.agent.module)},
  instructions: ${JSON.stringify(moduleMap.instructions.module)},
  tools: Object.freeze(Object.fromEntries([
    ${toolModuleEntries}
  ]))
});
export default Object.freeze({ agent, instructions, tools, moduleMap });
`;
}

function unsupportedBundleDependency(
  bundle: string,
): { readonly code: string; readonly message: string } | undefined {
  const checks: readonly {
    readonly code: string;
    readonly pattern: RegExp;
    readonly message: string;
  }[] = [
    {
      code: "MODULE_IMPORT_UNSUPPORTED",
      pattern: /\bimport\s*\(/u,
      message:
        "The Worker bundle contains a dynamic import; use a statically analyzable authored dependency.",
    },
    {
      code: "MODULE_IMPORT_UNSUPPORTED",
      pattern: /["']node:(?:fs|path|url|module|os|crypto|vm)(?:\/[^"']*)?["']/u,
      message:
        "The Worker bundle contains a Node-only builtin import; remove the Node dependency.",
    },
    {
      code: "MODULE_IMPORT_UNSUPPORTED",
      pattern: /(?:from|import)\s*["'](?:fs|path|url|module|os|crypto|vm)["']/u,
      message:
        "The Worker bundle contains a Node-only builtin import; remove the Node dependency.",
    },
    {
      code: "MODULE_IMPORT_UNSUPPORTED",
      pattern:
        /\b(?:from|import)\s*["'](?:chokidar|wrangler|@eden\/compiler)["']/u,
      message:
        "The Worker bundle contains a compiler or development dependency; keep it on the Node build side.",
    },
    {
      code: "MODULE_AMBIENT_BINDING",
      pattern:
        /\b(?:process\.env|process\.cwd|Buffer|require|__dirname|__filename)\b/u,
      message:
        "The Worker bundle depends on a Node or ambient runtime binding; use explicit Eden inputs instead.",
    },
  ];
  return checks.find((check) => check.pattern.test(bundle));
}

function authoredWorkerDependency(
  source: string,
): { readonly code: string; readonly message: string } | undefined {
  if (/\bimport\s*\(/u.test(source)) {
    return {
      code: "MODULE_IMPORT_UNSUPPORTED",
      message:
        "Dynamic imports are not supported in Worker artifacts; use a statically analyzable authored dependency.",
    };
  }
  if (
    /\b(?:from\s*|import\s*)["'](?:node:(?:fs|path|url|module|os|crypto|vm)|fs|path|url|module|os|crypto|vm)["']/u.test(
      source,
    )
  ) {
    return {
      code: "MODULE_IMPORT_UNSUPPORTED",
      message:
        "Node-only builtin imports are not supported in Worker artifacts; remove the Node dependency.",
    };
  }
  if (
    /\b(?:process\s*\.\s*(?:env|cwd)|Buffer|require\s*\(|__dirname|__filename)\b/u.test(
      source,
    )
  ) {
    return {
      code: "MODULE_AMBIENT_BINDING",
      message:
        "Node or ambient runtime bindings are not supported in Worker artifacts; use explicit Eden inputs instead.",
    };
  }
  return undefined;
}

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

async function resolveAuthoredImport(
  projectRoot: string,
  importerPath: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return undefined;
  }
  const base = isAbsolute(specifier)
    ? specifier
    : resolve(dirname(importerPath), specifier);
  if (!isWithinRoot(projectRoot, normalize(base))) {
    throw new EdenCompilerError("Worker compatibility validation failed", [
      diagnostic(
        "PATH_OUTSIDE_PROJECT",
        `Import "${specifier}" escapes the selected project root.`,
        toPosixPath(relative(projectRoot, importerPath)),
      ),
    ]);
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.js"),
    join(base, "index.mjs"),
  ];
  for (const candidate of candidates) {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical === undefined) continue;
    if (!isWithinRoot(projectRoot, canonical)) {
      throw new EdenCompilerError("Worker compatibility validation failed", [
        diagnostic(
          "PATH_OUTSIDE_PROJECT",
          `Import "${specifier}" resolves outside the selected project root.`,
          toPosixPath(relative(projectRoot, importerPath)),
        ),
      ]);
    }
    const details = await stat(canonical).catch(() => undefined);
    if (details?.isFile()) return canonical;
  }
  return undefined;
}

async function validateAuthoredWorkerSources(
  normalized: EdenNormalizedProject,
): Promise<void> {
  const pending = [
    normalized.discovery.agent.relativePath,
    ...normalized.discovery.tools.map((source) => source.relativePath),
  ];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const relativePath = pending.shift();
    if (relativePath === undefined) continue;
    const sourcePath = join(normalized.projectRoot, relativePath);
    const canonicalPath = await realpath(sourcePath).catch(() => sourcePath);
    if (visited.has(canonicalPath)) continue;
    visited.add(canonicalPath);
    const contents = await readUtf8File(canonicalPath);
    const issue = authoredWorkerDependency(contents);
    if (issue !== undefined) {
      throw new EdenCompilerError("Worker compatibility validation failed", [
        diagnostic(issue.code, issue.message, relativePath),
      ]);
    }
    for (const specifier of importedSpecifiers(contents)) {
      const importedPath = await resolveAuthoredImport(
        normalized.projectRoot,
        canonicalPath,
        specifier,
      );
      if (importedPath !== undefined) {
        pending.push(toPosixPath(relative(normalized.projectRoot, importedPath)));
      }
    }
  }
}

async function bundleProject(
  normalized: EdenNormalizedProject,
  moduleMap: EdenModuleMap,
): Promise<string> {
  const entry = bundleEntrySource(normalized, moduleMap);
  let compatibilityIssue:
    | {
        readonly code: string;
        readonly message: string;
        readonly source: string;
      }
    | undefined;
  try {
    const result = await build({
      absWorkingDir: normalized.projectRoot,
      bundle: true,
      charset: "utf8",
      format: "esm",
      logLevel: "silent",
      nodePaths: [join(process.cwd(), "node_modules")],
      stdin: {
        contents: entry,
        loader: "js",
        resolveDir: normalized.projectRoot,
        sourcefile: "eden-artifact-entry.mjs",
      },
      platform: "browser",
      plugins: [
        {
          name: "eden-worker-contained-imports",
          setup(context) {
            context.onResolve(
              {
                filter:
                  /^(?:node:(?:fs|path|url|module|os|crypto|vm)|fs|path|url|module|os|crypto|vm)$/,
              },
              (args) => {
                const source = toPosixPath(
                  relative(normalized.projectRoot, args.importer),
                );
                compatibilityIssue = {
                  code: "MODULE_IMPORT_UNSUPPORTED",
                  message:
                    "Node-only builtin imports are not supported in Worker artifacts; remove the Node dependency.",
                  source,
                };
                return {
                  errors: [
                    {
                      text: compatibilityIssue.message,
                    },
                  ],
                };
              },
            );
            context.onResolve(
              { filter: /^(?:\.{1,2}(?:\/|$)|\/)/ },
              async (args) => {
                const resolved = isAbsolute(args.path)
                  ? args.path
                  : resolve(args.resolveDir, args.path);
                const canonical = await realpath(resolved).catch(
                  () => resolved,
                );
                const dependencyRoots = await Promise.all(
                  [
                    join(normalized.projectRoot, "node_modules"),
                    join(process.cwd(), "node_modules"),
                  ].map((root) => realpath(root).catch(() => root)),
                );
                const importer = await realpath(args.resolveDir).catch(
                  () => args.resolveDir,
                );
                if (
                  dependencyRoots.some((root) =>
                    isWithinRoot(root, importer),
                  )
                ) {
                  return undefined;
                }
                if (!isWithinRoot(normalized.projectRoot, canonical)) {
                  return {
                    errors: [
                      {
                        text: `Import "${args.path}" from "${args.importer}" escapes the selected project root.`,
                      },
                    ],
                  };
                }
                return undefined;
              },
            );
          },
        },
      ],
      legalComments: "none",
      minify: false,
      outfile: "eden-artifact.mjs",
      sourcemap: false,
      target: "es2022",
      write: false,
    });
    const output = result.outputFiles?.[0]?.text;
    if (output === undefined) throw new Error("esbuild emitted no Worker bundle");
    const unsupported = unsupportedBundleDependency(output);
    if (unsupported !== undefined) {
      throw new EdenCompilerError("Worker compatibility validation failed", [
        diagnostic(unsupported.code, unsupported.message),
      ]);
    }
    return output;
  } catch (error: unknown) {
    if (error instanceof EdenCompilerError) throw error;
    if (compatibilityIssue !== undefined) {
      throw new EdenCompilerError(
        "Worker compatibility validation failed",
        [
          diagnostic(
            compatibilityIssue.code,
            compatibilityIssue.message,
            compatibilityIssue.source,
          ),
        ],
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new EdenCompilerError(
      `Worker compatibility validation failed: ${message}`,
      [
        diagnostic(
          "WORKER_BUNDLE_FAILED",
          `Unable to create a self-contained Worker bundle: ${message}`,
        ),
      ],
    );
  }
}

function createGeneratedManifest(
  normalized: EdenNormalizedProject,
  moduleMap: EdenModuleMap,
  bundleDigest: string,
): EdenManifest {
  const moduleByName = new Map(
    moduleMap.tools.map((reference) => [reference.name, reference.module]),
  );
  return {
    kind: "eden.manifest",
    version: EDEN_MANIFEST_VERSION,
    runtimeVersion: EDEN_RUNTIME_VERSION,
    agentBundleVersion: EDEN_AGENT_BUNDLE_VERSION,
    protocolVersion: EDEN_PROTOCOL_VERSION,
    schemaVersion: EDEN_SCHEMA_VERSION,
    agent: {
      source: normalized.discovery.agent,
      model: normalized.agent.model,
      ...(normalized.agent.options === undefined
        ? {}
        : { options: normalized.agent.options }),
    },
    instructions: normalized.instructions,
    tools: normalized.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      source: tool.source,
      module: moduleByName.get(tool.name) as string,
      schema: tool.schema,
    })),
    bundleDigest,
  };
}

function createBuildMetadata(
  manifest: EdenManifest,
  moduleMap: EdenModuleMap,
  bundle: string,
): EdenBuildMetadata {
  const moduleMapDigest = sha256(stableJson(moduleMap));
  return {
    generationId: createArtifactIdentity({
      manifest,
      moduleMap,
      bundle,
    }),
    createdAt: new Date().toISOString(),
    bundleDigest: sha256(bundle),
    manifestVersion: manifest.version,
    runtimeVersion: manifest.runtimeVersion,
    agentBundleVersion: manifest.agentBundleVersion,
    protocolVersion: manifest.protocolVersion,
    schemaVersion: manifest.schemaVersion,
    moduleMapDigest,
  };
}

export function createArtifactIdentity(
  artifacts: Pick<EdenArtifactSet, "manifest" | "moduleMap" | "bundle">,
): string {
  return `gen_${sha256(
    stableJson({
      bundle: sha256(artifacts.bundle),
      manifest: artifacts.manifest,
      moduleMap: artifacts.moduleMap,
    }),
  )}`;
}

function assertArtifactCoherence(
  manifest: EdenManifest,
  moduleMap: EdenModuleMap,
  bundle: string,
  buildMetadata: EdenBuildMetadata,
): void {
  const bundleDigest = sha256(bundle);
  if (manifest.bundleDigest !== bundleDigest) {
    throw new EdenCompilerError("Generated artifact digest mismatch", [
      diagnostic(
        "ARTIFACT_DIGEST_MISMATCH",
        "Manifest bundleDigest does not match the generated bundle bytes.",
      ),
    ]);
  }
  if (buildMetadata.bundleDigest !== bundleDigest) {
    throw new EdenCompilerError("Generated artifact digest mismatch", [
      diagnostic(
        "ARTIFACT_METADATA_DIGEST_MISMATCH",
        "Build metadata bundleDigest does not match the generated bundle bytes.",
      ),
    ]);
  }
  if (buildMetadata.moduleMapDigest !== sha256(stableJson(moduleMap))) {
    throw new EdenCompilerError("Generated module map digest mismatch", [
      diagnostic(
        "ARTIFACT_MODULE_MAP_DIGEST_MISMATCH",
        "Build metadata moduleMapDigest does not match the static module map.",
      ),
    ]);
  }
  if (buildMetadata.generationId !== createArtifactIdentity({
    manifest,
    moduleMap,
    bundle,
  })) {
    throw new EdenCompilerError("Generated artifact identity mismatch", [
      diagnostic(
        "ARTIFACT_IDENTITY_MISMATCH",
        "Build metadata generationId does not describe the generated manifest, module map, and bundle.",
      ),
    ]);
  }
  const manifestModules = [
    "agent:default",
    "instructions:default",
    ...manifest.tools.map((tool) => tool.module),
  ];
  const mappedModules = [
    moduleMap.agent.module,
    moduleMap.instructions.module,
    ...moduleMap.tools.map((tool) => tool.module),
  ];
  if (
    manifestModules.length !== mappedModules.length ||
    manifestModules.some((module, index) => module !== mappedModules[index])
  ) {
    throw new EdenCompilerError("Generated module map mismatch", [
      diagnostic(
        "ARTIFACT_MODULE_MAP_MISMATCH",
        "Manifest executable references do not match the static module map.",
      ),
    ]);
  }
  if (
    !bundle.includes("agent:default") ||
    !bundle.includes("instructions:default") ||
    manifest.tools.some((tool) => !bundle.includes(tool.module))
  ) {
    throw new EdenCompilerError("Generated module reference is unresolved", [
      diagnostic(
        "ARTIFACT_MODULE_UNRESOLVED",
        "Every manifest module reference must resolve in the generated Worker bundle.",
      ),
    ]);
  }
}

async function outputDirectoryFor(
  projectRoot: string,
  outputDirectory: string | undefined,
): Promise<string> {
  const selected = outputDirectory ?? ".eden";
  const candidate = isAbsolute(selected)
    ? normalize(selected)
    : resolve(projectRoot, selected);
  if (!isWithinRoot(projectRoot, candidate)) {
    throw new EdenCompilerError("Artifact output escapes the project root", [
      diagnostic(
        "OUTPUT_OUTSIDE_PROJECT",
        `Artifact output "${selected}" escapes the selected project root.`,
        selected,
      ),
    ]);
  }
  const parent = dirname(candidate);
  let existingAncestor = parent;
  while (true) {
    const resolvedAncestor = await realpath(existingAncestor).catch(
      () => undefined,
    );
    if (resolvedAncestor !== undefined) {
      if (!isWithinRoot(projectRoot, resolvedAncestor)) {
        throw new EdenCompilerError(
          "Artifact output escapes the project root",
          [
            diagnostic(
              "OUTPUT_OUTSIDE_PROJECT",
              `Artifact output "${selected}" has a parent outside the selected project root.`,
              selected,
            ),
          ],
        );
      }
      break;
    }
    const next = dirname(existingAncestor);
    if (next === existingAncestor) break;
    existingAncestor = next;
  }
  if (!isWithinRoot(projectRoot, existingAncestor)) {
    throw new EdenCompilerError("Artifact output escapes the project root", [
      diagnostic(
        "OUTPUT_OUTSIDE_PROJECT",
        `Artifact output "${selected}" has a parent outside the selected project root.`,
        selected,
      ),
    ]);
  }
  return candidate;
}

async function publishArtifacts(
  outputDirectory: string,
  artifacts: EdenArtifactSet,
): Promise<void> {
  const parent = dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  const stage = join(
    parent,
    `.${basename(outputDirectory)}.staging-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  const backup = join(
    parent,
    `.${basename(outputDirectory)}.previous-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  let movedCurrent = false;
  try {
    await mkdir(stage);
    await Promise.all([
      writeFile(
        join(stage, ARTIFACT_FILE_NAMES.discovery),
        jsonDocument(artifacts.discovery),
        "utf8",
      ),
      writeFile(
        join(stage, ARTIFACT_FILE_NAMES.diagnostics),
        jsonDocument(artifacts.diagnostics),
        "utf8",
      ),
      writeFile(
        join(stage, ARTIFACT_FILE_NAMES.manifest),
        jsonDocument(artifacts.manifest),
        "utf8",
      ),
      writeFile(
        join(stage, ARTIFACT_FILE_NAMES.moduleMap),
        jsonDocument(artifacts.moduleMap),
        "utf8",
      ),
      writeFile(
        join(stage, ARTIFACT_FILE_NAMES.bundle),
        artifacts.bundle,
        "utf8",
      ),
      writeFile(
        join(stage, ARTIFACT_FILE_NAMES.buildMetadata),
        jsonDocument(artifacts.buildMetadata),
        "utf8",
      ),
    ]);

    const existing = await lstat(outputDirectory).catch(() => undefined);
    if (existing !== undefined) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new EdenCompilerError("Artifact output is not a directory", [
          diagnostic(
            "OUTPUT_INVALID",
            `Artifact output "${outputDirectory}" must be a real directory.`,
          ),
        ]);
      }
      await rename(outputDirectory, backup);
      movedCurrent = true;
    }
    await rename(stage, outputDirectory);
    if (movedCurrent) await rm(backup, { recursive: true, force: true });
  } catch (error: unknown) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (movedCurrent) {
      const current = await lstat(outputDirectory).catch(() => undefined);
      if (current === undefined) {
        await rename(backup, outputDirectory).catch(() => undefined);
      }
    }
    throw error;
  }
}

export async function buildProject(
  options: EdenCompilerOptions,
): Promise<EdenCompilerResult> {
  const projectRoot = await resolveProjectRoot({
    projectRoot: options.projectRoot,
  });
  const outputDirectory = await outputDirectoryFor(
    projectRoot,
    options.outputDirectory,
  );
  const normalized = await normalizeProject({ projectRoot });
  await validateAuthoredWorkerSources(normalized);
  const moduleMap = artifactModuleMap(normalized);
  const bundle = await bundleProject(normalized, moduleMap);
  const manifest = createGeneratedManifest(normalized, moduleMap, sha256(bundle));
  const buildMetadata = createBuildMetadata(manifest, moduleMap, bundle);
  const diagnostics: readonly EdenDiagnostic[] = [];
  const artifacts: EdenArtifactSet = {
    discovery: normalized.discovery,
    diagnostics,
    manifest,
    moduleMap,
    bundle,
    buildMetadata,
  };
  assertArtifactCoherence(manifest, moduleMap, bundle, buildMetadata);
  await publishArtifacts(outputDirectory, artifacts);
  return { artifacts, diagnostics };
}

export class EdenNodeCompiler implements EdenCompiler {
  readonly version = EDEN_RUNTIME_VERSION;

  async build(options: EdenCompilerOptions): Promise<EdenCompilerResult> {
    return buildProject(options);
  }
}

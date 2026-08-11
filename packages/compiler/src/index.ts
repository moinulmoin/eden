/*
 * Modified derivative of portable Eve concepts. Eve 0.31.3 reference commit:
 * 0b102bc90e7cf2c3e294f6ca3af86c307d449b1a. See repository NOTICE and LICENSE.
 */

import { build } from "esbuild";
import * as ts from "typescript";
import {
  createHash,
} from "crypto";
import { tmpdir } from "os";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  readlink,
  rm,
  stat,
  symlink,
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
import { createRequire } from "module";

import type {
  EdenAgentDefinition,
  EdenArtifactSet,
  EdenBuildMetadata,
  EdenDiagnostic,
  EdenDiscoveryRecord,
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
  readonly hooks?: EdenCompilerHooks;
}

export type EdenPublicationBoundary =
  | "before-stage-write"
  | "after-stage-write"
  | "before-current-promotion"
  | "after-current-promotion";

export interface EdenCompilerHooks {
  readonly afterSourceSnapshot?: () => void | Promise<void>;
  readonly onPublicationBoundary?: (
    boundary: EdenPublicationBoundary,
  ) => void | Promise<void>;
}

export interface EdenCompilerResult {
  readonly artifacts: EdenArtifactSet;
  readonly diagnostics: readonly EdenDiagnostic[];
}

export interface EdenCompiler {
  readonly version: string;
  build(options: EdenCompilerOptions): Promise<EdenCompilerResult>;
}

export interface EdenArtifactGeneration {
  readonly directory: string;
  readonly artifacts: EdenArtifactSet;
}

export interface EdenArtifactGenerationReadOptions {
  /**
   * Test-only publication race hook. Production consumers should omit this
   * callback and rely on the resolved directory returned by this reader.
   */
  readonly afterCurrentResolution?: () => void | Promise<void>;
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
  readonly contents: Uint8Array;
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
  location?: {
    readonly line: number;
    readonly column: number;
  },
): EdenDiagnostic {
  return {
    code,
    message,
    ...(source === undefined ? {} : { source }),
    ...(location === undefined ? {} : location),
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
    contents: new Uint8Array(),
  };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveSelectedProjectDependency(
  projectRoot: string,
  importer: string,
  specifier: string,
): string | undefined {
  try {
    const require = createRequire(join(projectRoot, ".eden-resolver.cjs"));
    const importerPath = isAbsolute(importer)
      ? importer
      : resolve(projectRoot, importer);
    return require.resolve(specifier, {
      paths: [
        dirname(importerPath),
        join(projectRoot, "node_modules"),
        projectRoot,
      ],
    });
  } catch {
    return undefined;
  }
}

function dependencyPackageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0] ?? specifier;
}

async function hasSelectedProjectDependency(
  projectRoot: string,
  specifier: string,
): Promise<boolean> {
  const details = await lstat(
    join(projectRoot, "node_modules", dependencyPackageName(specifier)),
  ).catch(() => undefined);
  return details !== undefined;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
    const contents = await readFile(canonicalPath);
    const source = {
      relativePath: toPosixPath(relative(root, lexicalPath)),
      sha256: hashBytes(contents),
    };
    return {
      relativePath: source.relativePath,
      absolutePath: lexicalPath,
      canonicalPath,
      source,
      contents,
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

    const contents = await readFile(canonicalPath);
    const source: EdenSourceReference = {
      relativePath,
      sha256: hashBytes(contents),
    };
    candidates.push({
      ...sourcePath(root, absolutePath, canonicalPath),
      source,
      contents,
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

interface SnapshotFile {
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly contents: Uint8Array;
}

interface EdenSourceSnapshot {
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly diagnostics: readonly EdenDiagnostic[];
  readonly discovery: EdenDiscoveryResult["discovery"];
  readonly files: ReadonlyMap<string, SnapshotFile>;
  readonly cleanup: () => Promise<void>;
}

async function copySnapshotFile(
  snapshotRoot: string,
  file: SnapshotFile,
): Promise<string> {
  const destination = join(snapshotRoot, file.relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, file.contents, { flag: "wx" });
  return destination;
}

async function packageJsonFor(
  projectRoot: string,
  sourcePath: string,
): Promise<SnapshotFile | undefined> {
  const nodeModulesRoot = normalize(join(projectRoot, "node_modules"));
  let directory = dirname(sourcePath);
  while (isWithinRoot(nodeModulesRoot, directory)) {
    const packagePath = join(directory, "package.json");
    const contents = await readFile(packagePath).catch(() => undefined);
    if (contents !== undefined) {
      return {
        relativePath: toPosixPath(relative(projectRoot, packagePath)),
        sourcePath: packagePath,
        contents,
      };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

async function collectAuthoredImportClosure(
  projectRoot: string,
  entries: readonly SourcePathInfo[],
): Promise<readonly SnapshotFile[]> {
  const files = new Map<string, SnapshotFile>();
  for (const entry of entries) {
    files.set(entry.relativePath, {
      relativePath: entry.relativePath,
      sourcePath: entry.absolutePath,
      contents: entry.contents,
    });
  }

  let dependencyIssue: EdenDiagnostic | undefined;
  const dependencyOrigins = new Map<string, string>();
  const entryOrigins = new Map(
    entries.map((entry) => [normalize(entry.canonicalPath), entry.relativePath]),
  );
  const authoredSourceFor = (importer: string): string | undefined => {
    const normalizedImporter = normalize(
      isAbsolute(importer) ? importer : resolve(projectRoot, importer),
    );
    const entryOrigin = entryOrigins.get(normalizedImporter);
    if (entryOrigin !== undefined) return entryOrigin;
    const knownOrigin = dependencyOrigins.get(normalizedImporter);
    if (knownOrigin !== undefined) return knownOrigin;
    if (!isWithinRoot(projectRoot, normalizedImporter)) return undefined;
    const relativeImporter = toPosixPath(relative(projectRoot, normalizedImporter));
    if (
      relativeImporter.startsWith("..") ||
      relativeImporter.startsWith("node_modules/")
    ) {
      return undefined;
    }
    return relativeImporter;
  };
  try {
    const result = await build({
      absWorkingDir: projectRoot,
      entryPoints: entries
        .filter((entry) => entry.relativePath.endsWith(".ts"))
        .map((entry) => entry.relativePath),
      bundle: true,
      format: "esm",
      metafile: true,
      outdir: join(projectRoot, ".eden-compiler-closure"),
      nodePaths: [join(projectRoot, "node_modules")],
      platform: "node",
      preserveSymlinks: true,
      target: "es2022",
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "eden-snapshot-contained-imports",
          setup(context) {
            context.onResolve({ filter: /^[^./]/ }, async (args) => {
              const origin =
                authoredSourceFor(args.importer) ??
                (args.importer.length === 0 ? undefined : args.importer);
              const resolved = resolveSelectedProjectDependency(
                projectRoot,
                args.importer,
                args.path,
              );
              if (
                origin !== undefined &&
                resolved !== undefined &&
                !isWithinRoot(projectRoot, normalize(resolved)) &&
                !(await hasSelectedProjectDependency(projectRoot, args.path))
              ) {
                dependencyIssue ??= diagnostic(
                  "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                  "An authored dependency resolved outside the selected project root.",
                  origin,
                );
              }
              if (resolved !== undefined && origin !== undefined) {
                dependencyOrigins.set(normalize(resolved), origin);
              }
              return undefined;
            });
            context.onLoad({ filter: /./ }, (args) => {
              if (
                isWithinRoot(projectRoot, normalize(args.path)) ||
                isWithinRoot(
                  normalize(join(projectRoot, "node_modules")),
                  normalize(args.path),
                )
              ) {
                return undefined;
              }
              const message =
                "An authored dependency resolved outside the selected project root.";
              dependencyIssue ??= diagnostic(
                "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                message,
                authoredSourceFor(args.path),
              );
              return { errors: [{ text: message }] };
            });
            context.onResolve(
              { filter: /^(?:\.{1,2}(?:\/|$)|\/)/ },
              async (args) => {
                const importerRoot = normalize(args.resolveDir);
                if (
                  isWithinRoot(
                    normalize(join(projectRoot, "node_modules")),
                    importerRoot,
                  )
                ) {
                  return undefined;
                }
                const resolvedImport = isAbsolute(args.path)
                  ? args.path
                  : resolve(args.resolveDir, args.path);
                const canonicalImport = await realpath(resolvedImport).catch(
                  () => resolvedImport,
                );
                const origin =
                  authoredSourceFor(args.importer) ??
                  toPosixPath(relative(projectRoot, args.importer));
                if (origin !== undefined) {
                  dependencyOrigins.set(normalize(canonicalImport), origin);
                }
                if (
                  !isWithinRoot(projectRoot, normalize(resolvedImport)) ||
                  !isWithinRoot(projectRoot, canonicalImport)
                ) {
                  dependencyIssue ??= diagnostic(
                    "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                    `Import "${args.path}" from "${origin}" escapes the selected project root.`,
                    origin,
                  );
                  return {
                    errors: [
                      {
                        text:
                          `Import "${args.path}" from "${origin}" ` +
                          "escapes the selected project root.",
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
    });
    for (const input of Object.keys(result.metafile?.inputs ?? {})) {
      const logicalPath = isAbsolute(input)
        ? normalize(input)
        : resolve(projectRoot, input);
      if (!isWithinRoot(projectRoot, logicalPath)) {
        throw new EdenCompilerError("Worker source snapshot escaped the project", [
          diagnostic(
            "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
            `Dependency "${input}" resolves outside the selected project root.`,
          ),
        ]);
      }
      const relativePath = toPosixPath(relative(projectRoot, logicalPath));
      const contents = await readFile(logicalPath);
      if (!files.has(relativePath)) {
        files.set(relativePath, {
          relativePath,
          sourcePath: logicalPath,
          contents,
        });
      }
      const packageJson = await packageJsonFor(projectRoot, logicalPath);
      if (packageJson !== undefined) {
        if (!files.has(packageJson.relativePath)) {
          files.set(packageJson.relativePath, packageJson);
        }
      }
    }
  } catch (error: unknown) {
    if (dependencyIssue !== undefined) {
      throw new EdenCompilerError(
        "Unable to capture the authored source snapshot",
        [dependencyIssue],
      );
    }
    if (error instanceof EdenCompilerError) throw error;
    // Invalid authored syntax is diagnosed during normalization from the
    // captured entry bytes; the direct source snapshot is still sufficient.
  }
  return [...files.values()];
}

async function captureSourceSnapshot(
  projectRoot: string,
): Promise<EdenSourceSnapshot> {
  const discovered = await discoverProject({ projectRoot });
  const diagnostics = [...discovered.diagnostics];
  const sourceEntries: SourcePathInfo[] = [];
  const agent = await readSourcePath(projectRoot, REQUIRED_AGENT_PATH, diagnostics);
  const instructions = await readSourcePath(
    projectRoot,
    REQUIRED_INSTRUCTIONS_PATH,
    diagnostics,
  );
  if (agent !== undefined) sourceEntries.push(agent);
  if (instructions !== undefined) sourceEntries.push(instructions);

  const tools: SourcePathInfo[] = [];
  for (const source of discovered.discovery.tools) {
    const absolutePath = await resolveContainedProjectPath(
      projectRoot,
      source.relativePath,
    ).catch(() => join(projectRoot, source.relativePath));
    const canonicalPath = await realpath(absolutePath).catch(() => absolutePath);
    const contents = await readFile(canonicalPath).catch(() => undefined);
    if (contents === undefined) continue;
    const sourceReference: EdenSourceReference = {
      relativePath: source.relativePath,
      sha256: hashBytes(contents),
    };
    const candidate: SourcePathInfo = {
      relativePath: source.relativePath,
      absolutePath,
      canonicalPath,
      source: sourceReference,
      contents,
    };
    tools.push(candidate);
    sourceEntries.push(candidate);
  }

  const files = new Map<string, SnapshotFile>(
    sourceEntries.map((entry) => [
      entry.relativePath,
      {
        relativePath: entry.relativePath,
        sourcePath: entry.absolutePath,
        contents: entry.contents,
      },
    ]),
  );
  try {
    for (const file of await collectAuthoredImportClosure(projectRoot, sourceEntries)) {
      files.set(file.relativePath, file);
    }
  } catch (error: unknown) {
    if (error instanceof EdenCompilerError) {
      diagnostics.push(...error.diagnostics);
    } else {
      diagnostics.push(
        diagnostic(
          "MODULE_SNAPSHOT_FAILED",
          "Unable to capture the authored source/import closure.",
        ),
      );
    }
  }
  for (const file of files.values()) {
    const currentContents = await readFile(file.sourcePath).catch(
      () => undefined,
    );
    if (
      currentContents === undefined ||
      !bytesEqual(file.contents, currentContents)
    ) {
      diagnostics.push(
        diagnostic(
          "SOURCE_CHANGED_DURING_BUILD",
          `Source "${file.relativePath}" changed while its import closure was being captured; retry the build.`,
          file.relativePath,
        ),
      );
    }
  }
  const afterCaptureDiscovery = await discoverProject({ projectRoot });
  if (
    stableJson({
      discovery: discovered.discovery,
      diagnostics: discovered.diagnostics,
    }) !==
    stableJson({
      discovery: afterCaptureDiscovery.discovery,
      diagnostics: afterCaptureDiscovery.diagnostics,
    })
  ) {
    diagnostics.push(
      diagnostic(
        "SOURCE_CHANGED_DURING_BUILD",
        "Authored source or tool discovery changed while its import closure was being captured; retry the build.",
      ),
    );
  }

  const temporarySnapshotRoot = await mkdtemp(
    join(tmpdir(), "eden-compiler-snapshot-"),
  );
  const snapshotRoot = await realpath(temporarySnapshotRoot);
  try {
    for (const file of files.values()) {
      await copySnapshotFile(snapshotRoot, file);
    }
  } catch (error: unknown) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const snapshotDiscovery: EdenDiscoveryResult["discovery"] = {
    agent: agent?.source ?? EMPTY_SOURCE(REQUIRED_AGENT_PATH),
    instructions: instructions?.source ?? EMPTY_SOURCE(REQUIRED_INSTRUCTIONS_PATH),
    tools: tools
      .sort((left, right) => comparePath(left.relativePath, right.relativePath))
      .map((tool) => tool.source),
  };

  return {
    projectRoot,
    sourceRoot: snapshotRoot,
    diagnostics,
    discovery: snapshotDiscovery,
    files,
    cleanup: async () => {
      await rm(snapshotRoot, { recursive: true, force: true });
    },
  };
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

const NODE_ONLY_MODULES = new Set([
  "assert",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

function isUnsupportedModuleSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    NODE_ONLY_MODULES.has(specifier) ||
    specifier === "chokidar" ||
    specifier === "wrangler" ||
    specifier === "@eden/compiler"
  );
}

function sourceFileForValidation(
  fileName: string,
  source: string,
): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : fileName.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : fileName.endsWith(".js") ||
            fileName.endsWith(".mjs") ||
            fileName.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
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
  const importIssue = authoredWorkerDependency(source);
  if (importIssue !== undefined) {
    diagnostics.push(
      diagnostic(
        importIssue.code,
        importIssue.message,
        sourceInfo.relativePath,
        importIssue.location,
      ),
    );
    return undefined;
  }

  let dependencyIssue: EdenDiagnostic | undefined;
  const dependencyOrigins = new Map<string, string>();
  const authoredSourceFor = (importer: string): string => {
    const normalizedImporter = normalize(
      isAbsolute(importer) ? importer : resolve(projectRoot, importer),
    );
    if (normalizedImporter === normalize(sourceInfo.canonicalPath)) {
      return sourceInfo.relativePath;
    }
    const knownOrigin = dependencyOrigins.get(normalizedImporter);
    if (knownOrigin !== undefined) return knownOrigin;
    const relativeImporter = toPosixPath(relative(projectRoot, normalizedImporter));
    return relativeImporter.startsWith("../") ||
      relativeImporter.startsWith("node_modules/")
      ? sourceInfo.relativePath
      : relativeImporter;
  };
  try {
    const result = await build({
      absWorkingDir: projectRoot,
      entryPoints: [sourceInfo.canonicalPath],
      bundle: true,
      format: "esm",
      platform: "node",
      preserveSymlinks: true,
      target: "es2022",
      write: false,
      logLevel: "silent",
      nodePaths: [join(projectRoot, "node_modules")],
      plugins: [
        {
          name: "eden-contained-source-imports",
          setup(context) {
            context.onResolve({ filter: /^[^./]/ }, async (args) => {
              const origin = authoredSourceFor(args.importer);
              const resolved = resolveSelectedProjectDependency(
                projectRoot,
                args.importer,
                args.path,
              );
              if (
                resolved !== undefined &&
                !isWithinRoot(projectRoot, normalize(resolved)) &&
                !(await hasSelectedProjectDependency(projectRoot, args.path))
              ) {
                dependencyIssue ??= diagnostic(
                  "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                  "An authored dependency resolved outside the selected project root.",
                  origin,
                );
              }
              if (resolved !== undefined) {
                dependencyOrigins.set(normalize(resolved), origin);
              }
              return undefined;
            });
            context.onLoad({ filter: /./ }, (args) => {
              if (isWithinRoot(projectRoot, normalize(args.path))) {
                return undefined;
              }
              const message =
                `Dependency loaded by "${authoredSourceFor(args.path)}" resolves outside ` +
                "the selected project root; declare it in the selected project's install context.";
              dependencyIssue ??= diagnostic(
                "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                message,
                authoredSourceFor(args.path),
              );
              return {
                errors: [{ text: message }],
              };
            });
            context.onResolve({ filter: /^(?:\.{1,2}(?:\/|$)|\/)/ }, async (args) => {
              const importerRoot = normalize(args.resolveDir);
              if (
                isWithinRoot(
                  normalize(join(projectRoot, "node_modules")),
                  importerRoot,
                )
              ) {
                return undefined;
              }

              const resolvedImport = resolve(args.resolveDir, args.path);
              const canonicalImport = await realpath(resolvedImport).catch(
                () => resolvedImport,
              );
              const origin = authoredSourceFor(args.importer);
              dependencyOrigins.set(normalize(canonicalImport), origin);
              if (!isWithinRoot(projectRoot, canonicalImport)) {
                return {
                  errors: [
                    {
                      text: `Import "${args.path}" from "${origin}" escapes the selected project root.`,
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
    if (dependencyIssue !== undefined) {
      diagnostics.push(dependencyIssue);
      return undefined;
    }
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

function snapshotSourceInfo(
  snapshot: EdenSourceSnapshot,
  relativePath: string,
): SourcePathInfo | undefined {
  const file = snapshot.files.get(relativePath);
  if (file === undefined) return undefined;
  const absolutePath = join(snapshot.sourceRoot, relativePath);
  return {
    relativePath,
    absolutePath,
    canonicalPath: absolutePath,
    source: {
      relativePath,
      sha256: hashBytes(file.contents),
    },
    contents: file.contents,
  };
}

async function normalizeSnapshot(
  snapshot: EdenSourceSnapshot,
): Promise<EdenNormalizedProject> {
  const diagnostics = [...snapshot.diagnostics];
  const root = snapshot.sourceRoot;
  const agentInfo = snapshotSourceInfo(snapshot, REQUIRED_AGENT_PATH);
  const instructionsInfo = snapshotSourceInfo(
    snapshot,
    REQUIRED_INSTRUCTIONS_PATH,
  );

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
        content: new TextDecoder("utf-8", { fatal: true }).decode(
          instructionsInfo.contents,
        ),
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
  for (const source of snapshot.discovery.tools) {
    const candidate = snapshotSourceInfo(snapshot, source.relativePath);
    if (candidate !== undefined) candidates.push(candidate);
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
    discovery: snapshot.discovery,
    agent,
    instructions,
    tools,
  };
}

export async function normalizeProject(
  selection: EdenProjectSelection,
): Promise<EdenNormalizedProject> {
  const options =
    typeof selection === "string" ? { projectRoot: selection } : selection;
  const projectRoot = await resolveProjectRoot(options);
  const snapshot = await captureSourceSnapshot(projectRoot);
  try {
    await validateAuthoredWorkerSources(snapshot);
    const normalized = await normalizeSnapshot(snapshot);
    return {
      ...normalized,
      projectRoot,
    };
  } finally {
    await snapshot.cleanup();
  }
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
  const toolSchemaEntries = normalized.tools
    .map((tool) => {
      const candidate = tool.inputSchema as unknown as {
        readonly jsonSchema?: unknown;
        readonly toJSONSchema?: () => unknown;
      };
      let schema: EdenJsonValue = {
        type: "object",
        additionalProperties: true,
      };
      try {
        const generated =
          typeof candidate.toJSONSchema === "function"
            ? candidate.toJSONSchema()
            : candidate.jsonSchema;
        if (generated !== undefined) {
          schema = normalizeJsonValue(generated, tool.source.relativePath);
        }
      } catch {
        // Some Standard Schema transforms cannot be represented as JSON Schema.
        // The runtime still validates the provider's input through the authored
        // schema before invoking the tool.
      }
      return `[${JSON.stringify(tool.name)}, ${JSON.stringify(schema)}]`;
    })
    .join(",\n    ");

  return `${imports}

const edenTools = Object.freeze(Object.fromEntries([
    ${toolEntries}
  ]));

export const agent = edenAgent;
export const instructions = ${JSON.stringify(normalized.instructions.content)};
export const tools = edenTools;
export const toolSchemas = Object.freeze(Object.fromEntries([
    ${toolSchemaEntries}
  ]));
export const moduleMap = Object.freeze({
  agent: ${JSON.stringify(moduleMap.agent.module)},
  instructions: ${JSON.stringify(moduleMap.instructions.module)},
  tools: Object.freeze(Object.fromEntries([
    ${toolModuleEntries}
  ]))
});
export default Object.freeze({ agent, instructions, tools, toolSchemas, moduleMap });
`;
}

function unsupportedBundleDependency(
  bundle: string,
): { readonly code: string; readonly message: string } | undefined {
  const sourceFile = sourceFileForValidation("eden-artifact-bundle.mjs", bundle);
  let issue:
    | { readonly code: string; readonly message: string }
    | undefined;
  function visit(node: ts.Node): void {
    if (issue !== undefined) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      issue = {
        code: "MODULE_IMPORT_UNSUPPORTED",
        message:
          "The Worker bundle contains a dynamic import; use a statically analyzable authored dependency.",
      };
      return;
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isUnsupportedModuleSpecifier(node.moduleSpecifier.text)
    ) {
      issue = {
        code: "MODULE_IMPORT_UNSUPPORTED",
        message:
          "The Worker bundle contains a Node-only or compiler dependency; keep it on the Node build side.",
      };
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return issue;
}

function authoredWorkerDependency(
  source: string,
): {
  readonly code: string;
  readonly message: string;
  readonly location?: { readonly line: number; readonly column: number };
} | undefined {
  const sourceFile = sourceFileForValidation("eden-authored-source.ts", source);
  let issue:
    | {
        readonly code: string;
        readonly message: string;
        readonly location: { readonly line: number; readonly column: number };
      }
    | undefined;
  function visit(node: ts.Node): void {
    if (issue !== undefined) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      issue = {
        code: "MODULE_IMPORT_UNSUPPORTED",
        message:
          "Dynamic imports are not supported in Worker artifacts; use a statically analyzable authored dependency.",
        location: semanticLocation(sourceFile, node),
      };
      return;
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isUnsupportedModuleSpecifier(node.moduleSpecifier.text)
    ) {
      issue = {
        code: "MODULE_IMPORT_UNSUPPORTED",
        message:
          "Node-only or compiler dependencies are not supported in Worker artifacts; remove the dependency.",
        location: semanticLocation(sourceFile, node.moduleSpecifier),
      };
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return issue;
}

const SUPPORTED_WORKER_GLOBALS = new Set([
  // Standard ECMAScript values and constructors available in Workers.
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "Atomics",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "FinalizationRegistry",
  "Float32Array",
  "Float64Array",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Intl",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "URIError",
  "URL",
  "URLSearchParams",
  "undefined",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "queueMicrotask",
  "setInterval",
  "setTimeout",
  "structuredClone",
  "unescape",
  "clearInterval",
  "clearTimeout",
  // Web APIs and Worker globals intentionally supported by Eden artifacts.
  "AbortController",
  "AbortSignal",
  "atob",
  "btoa",
  "Blob",
  "BroadcastChannel",
  "Cache",
  "CacheStorage",
  "CloseEvent",
  "CompressionStream",
  "CountQueuingStrategy",
  "Crypto",
  "CryptoKey",
  "CustomEvent",
  "DOMException",
  "DecompressionStream",
  "ErrorEvent",
  "Event",
  "EventTarget",
  "File",
  "FixedLengthStream",
  "FormData",
  "HTMLRewriter",
  "Headers",
  "MessageChannel",
  "MessageEvent",
  "MessagePort",
  "Navigator",
  "Performance",
  "PerformanceEntry",
  "PerformanceMark",
  "PerformanceMeasure",
  "PerformanceObserver",
  "PerformanceObserverEntryList",
  "PerformanceResourceTiming",
  "ReadableByteStreamController",
  "ReadableStream",
  "ReadableStreamBYOBReader",
  "ReadableStreamBYOBRequest",
  "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader",
  "Request",
  "Response",
  "scheduler",
  "SubtleCrypto",
  "TextDecoder",
  "TextDecoderStream",
  "TextEncoder",
  "TextEncoderStream",
  "TransformStream",
  "TransformStreamDefaultController",
  "URLPattern",
  "WebSocket",
  "WritableStream",
  "WritableStreamDefaultController",
  "WritableStreamDefaultWriter",
  "console",
  "addEventListener",
  "clearImmediate",
  "crypto",
  "dispatchEvent",
  "fetch",
  "globalThis",
  "caches",
  "origin",
  "performance",
  "removeEventListener",
  "reportError",
  "self",
  "setImmediate",
  "navigator",
  "WebSocketPair",
  "WebSocketRequestResponsePair",
  "IdentityTransformStream",
  "WebAssembly",
]);

const FORBIDDEN_AMBIENT_GLOBALS = new Set([
  "Buffer",
  "Deno",
  "Bun",
  "__dirname",
  "__filename",
  "global",
  "module",
  "process",
  "require",
]);

const DYNAMIC_CODE_GLOBALS = new Set(["eval", "Function"]);

function semanticLocation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { readonly line: number; readonly column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function isJavaScriptSourcePath(relativePath: string): boolean {
  return /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/u.test(relativePath);
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (
    ts.isBindingElement(parent) &&
    (parent.name === node || parent.propertyName === node)
  ) {
    return true;
  }
  if (
    ts.isCatchClause(parent) &&
    parent.variableDeclaration?.name === node
  ) {
    return true;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isBreakStatement(parent) && parent.label === node) return true;
  if (ts.isContinueStatement(parent) && parent.label === node) return true;
  return false;
}

function isNonReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isTypeNode(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (
    (ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isNamespaceExportDeclaration(parent)
  ) {
    return true;
  }
  if (ts.isExportSpecifier(parent)) {
    const exportDeclaration = parent.parent.parent;
    if (
      ts.isExportDeclaration(exportDeclaration) &&
      exportDeclaration.moduleSpecifier !== undefined
    ) {
      return true;
    }
    return (
      parent.name === node &&
      parent.propertyName !== undefined
    );
  }
  if (
    ts.isBindingElement(parent) &&
    (parent.name === node || parent.propertyName === node)
  ) {
    return true;
  }
  if (ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  if (ts.isJsxAttribute(parent) && parent.name === node) return true;
  if (ts.isJsxNamespacedName(parent)) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent)) {
    return true;
  }
  if (ts.isContinueStatement(parent)) return true;
  return isDeclarationIdentifier(node);
}

function isSecretLikeAmbientName(name: string): boolean {
  return /(?:secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|binding|environment|env)/iu.test(
    name,
  );
}

function semanticWorkerBindingDiagnostics(
  sourceFile: ts.SourceFile,
  relativePath: string,
  checker: ts.TypeChecker,
): EdenDiagnostic[] {
  const diagnostics: EdenDiagnostic[] = [];
  const importedBindings = new Set<string>();
  function isTypeOnlyImport(
    declaration: ts.Declaration,
  ): boolean {
    if (ts.isImportSpecifier(declaration)) {
      return (
        declaration.isTypeOnly || declaration.parent.parent.isTypeOnly
      );
    }
    if (ts.isNamespaceImport(declaration)) {
      return declaration.parent.isTypeOnly;
    }
    if (ts.isImportClause(declaration)) return declaration.isTypeOnly;
    return false;
  }

  function collectImportedBindings(node: ts.Node): void {
    if (
      ts.isImportClause(node) &&
      !node.isTypeOnly &&
      node.name !== undefined
    ) {
      importedBindings.add(node.name.text);
    } else if (
      ts.isNamespaceImport(node) &&
      !node.parent.isTypeOnly
    ) {
      importedBindings.add(node.name.text);
    } else if (
      ts.isImportSpecifier(node) &&
      !node.isTypeOnly &&
      !node.parent.parent.isTypeOnly
    ) {
      importedBindings.add((node.name ?? node.propertyName).text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      importedBindings.add(node.name.text);
    }
    ts.forEachChild(node, collectImportedBindings);
  }
  collectImportedBindings(sourceFile);

  function hasAuthoredBinding(node: ts.Identifier): boolean {
    const symbol = checker.getSymbolAtLocation(node);
    return (
      importedBindings.has(node.text) ||
      (symbol?.declarations?.some(
        (declaration) =>
          declaration.getSourceFile().fileName === sourceFile.fileName &&
          !isTypeOnlyImport(declaration) &&
          (ts.getCombinedModifierFlags(declaration) &
            ts.ModifierFlags.Ambient) ===
            0 &&
          !ts.isInterfaceDeclaration(declaration) &&
          !ts.isTypeAliasDeclaration(declaration) &&
          !ts.isTypeParameterDeclaration(declaration),
      ) ?? false)
    );
  }

  function hasArgumentsBinding(node: ts.Identifier): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (ts.isArrowFunction(current)) {
        current = current.parent;
        continue;
      }
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  type AmbientValue =
    | { readonly kind: "root"; readonly root: "globalThis" | "self" }
    | {
        readonly kind: "property";
        readonly root: "globalThis" | "self";
        readonly name: string;
      }
    | {
        readonly kind: "dynamic-property";
        readonly root: "globalThis" | "self";
      }
    | { readonly kind: "dynamic-code"; readonly name: "eval" | "Function" };

  const ambientValues = new Map<ts.Symbol, AmbientValue>();
  const variableDeclarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];

  function collectAmbientCandidates(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      variableDeclarations.push(node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assignments.push(node);
    }
    ts.forEachChild(node, collectAmbientCandidates);
  }
  collectAmbientCandidates(sourceFile);

  function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }

  function constantStringExpression(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): string | undefined {
    const current = unwrapExpression(expression);
    if (ts.isStringLiteralLike(current)) return current.text;
    if (ts.isTemplateExpression(current)) {
      let value = current.head.text;
      for (const span of current.templateSpans) {
        const expressionValue = constantStringExpression(
          span.expression,
          seenSymbols,
        );
        if (expressionValue === undefined) return undefined;
        value += expressionValue + span.literal.text;
      }
      return value;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = constantStringExpression(current.left, seenSymbols);
      const right = constantStringExpression(current.right, seenSymbols);
      return left === undefined || right === undefined
        ? undefined
        : left + right;
    }
    if (ts.isConditionalExpression(current)) {
      const whenTrue = constantStringExpression(
        current.whenTrue,
        seenSymbols,
      );
      const whenFalse = constantStringExpression(
        current.whenFalse,
        seenSymbols,
      );
      return whenTrue !== undefined && whenTrue === whenFalse
        ? whenTrue
        : undefined;
    }
    if (!ts.isIdentifier(current)) return undefined;
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seenSymbols.has(symbol)) return undefined;
    seenSymbols.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      ) {
        const value = constantStringExpression(
          declaration.initializer,
          seenSymbols,
        );
        if (value !== undefined) return value;
      }
    }
    return undefined;
  }

  function ambientRootName(
    expression: ts.Expression,
  ): "globalThis" | "self" | undefined {
    const current = unwrapExpression(expression);
    if (
      ts.isIdentifier(current) &&
      (current.text === "globalThis" || current.text === "self") &&
      !hasAuthoredBinding(current)
    ) {
      return current.text;
    }
    return undefined;
  }

  function mergeAmbientValues(
    left: AmbientValue | undefined,
    right: AmbientValue,
  ): AmbientValue {
    if (left === undefined) return right;
    if (
      left.kind === "root" &&
      right.kind === "root" &&
      left.root === right.root
    ) {
      return left;
    }
    if (
      left.kind === "dynamic-property" &&
      right.kind === "dynamic-property" &&
      left.root === right.root
    ) {
      return left;
    }
    if (
      left.kind === "property" &&
      right.kind === "property" &&
      left.root === right.root &&
      left.name === right.name
    ) {
      return left;
    }
    if (
      left.kind === "dynamic-code" &&
      right.kind === "dynamic-code" &&
      left.name === right.name
    ) {
      return left;
    }
    if (left.kind === "dynamic-code" || right.kind === "dynamic-code") {
      return {
        kind: "dynamic-code",
        name:
          left.kind === "dynamic-code"
            ? left.name
            : (right as Extract<AmbientValue, { kind: "dynamic-code" }>).name,
      };
    }
    const root =
      left.kind === "root" || left.kind === "property"
        ? left.root
        : right.kind === "root" || right.kind === "property"
          ? right.root
          : "globalThis";
    return {
      kind: "dynamic-property",
      root,
    };
  }

  function addAmbientValue(
    symbol: ts.Symbol,
    value: AmbientValue,
  ): void {
    ambientValues.set(symbol, mergeAmbientValues(ambientValues.get(symbol), value));
  }

  function resolveAmbientValue(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): AmbientValue | undefined {
    const current = unwrapExpression(expression);
    const root = ambientRootName(current);
    if (root !== undefined) return { kind: "root", root };
    if (ts.isIdentifier(current)) {
      if (
        DYNAMIC_CODE_GLOBALS.has(current.text) &&
        !hasAuthoredBinding(current)
      ) {
        return {
          kind: "dynamic-code",
          name: current.text as "eval" | "Function",
        };
      }
      const symbol = checker.getSymbolAtLocation(current);
      if (symbol === undefined || seenSymbols.has(symbol)) return undefined;
      seenSymbols.add(symbol);
      const symbols = [symbol];
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== symbol) symbols.push(aliased);
      }
      for (const candidate of symbols) {
        const known = ambientValues.get(candidate);
        if (known !== undefined) return known;
        for (const declaration of candidate.declarations ?? []) {
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined
          ) {
            const value = resolveAmbientValue(
              declaration.initializer,
              seenSymbols,
            );
            if (value !== undefined) return value;
          }
        }
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(current)) {
      const base = resolveAmbientValue(current.expression, seenSymbols);
      if (base?.kind === "root") {
        if (DYNAMIC_CODE_GLOBALS.has(current.name.text)) {
          return {
            kind: "dynamic-code",
            name: current.name.text as "eval" | "Function",
          };
        }
        return {
          kind: "property",
          root: base.root,
          name: current.name.text,
        };
      }
      if (base?.kind === "dynamic-code") return base;
      if (base?.kind === "property") {
        return {
          kind: "property",
          root: base.root,
          name: `${base.name}.${current.name.text}`,
        };
      }
      if (base?.kind === "dynamic-property") {
        return {
          kind: "dynamic-property",
          root: base.root,
        };
      }
      return undefined;
    }
    if (ts.isElementAccessExpression(current)) {
      const base = resolveAmbientValue(current.expression, seenSymbols);
      if (base?.kind === "dynamic-code") return base;
      if (base?.kind === "property" || base?.kind === "dynamic-property") {
        if (base.kind === "dynamic-property") {
          return {
            kind: "dynamic-property",
            root: base.root,
          };
        }
        const name =
          current.argumentExpression === undefined
            ? undefined
            : constantStringExpression(current.argumentExpression);
        return name === undefined
          ? {
              kind: "dynamic-property",
              root: base.root,
            }
          : {
              kind: "property",
              root: base.root,
              name: `${base.name}.${name}`,
            };
      }
      if (base?.kind !== "root") return undefined;
      const name =
        current.argumentExpression === undefined
          ? undefined
          : constantStringExpression(current.argumentExpression);
      if (name === undefined) {
        return { kind: "dynamic-property", root: base.root };
      }
      if (DYNAMIC_CODE_GLOBALS.has(name)) {
        return {
          kind: "dynamic-code",
          name: name as "eval" | "Function",
        };
      }
      return { kind: "property", root: base.root, name };
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return resolveAmbientValue(current.right, seenSymbols);
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      const left = resolveAmbientValue(current.left, seenSymbols);
      const right = resolveAmbientValue(current.right, seenSymbols);
      if (left === undefined) return right;
      if (right === undefined) return left;
      return mergeAmbientValues(left, right);
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        const expression = ts.isSpreadAssignment(property)
          ? property.expression
          : ts.isPropertyAssignment(property)
            ? property.initializer
            : ts.isShorthandPropertyAssignment(property)
              ? property.name
              : undefined;
        if (expression === undefined) continue;
        const value = resolveAmbientValue(expression, seenSymbols);
        if (value?.kind === "dynamic-code") return value;
        if (value !== undefined) {
          return {
            kind: "dynamic-property",
            root:
              value.kind === "root" ||
              value.kind === "property" ||
              value.kind === "dynamic-property"
                ? value.root
                : "globalThis",
          };
        }
      }
      return undefined;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const value = resolveAmbientValue(element, seenSymbols);
        if (value?.kind === "dynamic-code") return value;
        if (value !== undefined) {
          return {
            kind: "dynamic-property",
            root:
              value.kind === "root" ||
              value.kind === "property" ||
              value.kind === "dynamic-property"
                ? value.root
                : "globalThis",
          };
        }
      }
      return undefined;
    }
    if (ts.isConditionalExpression(current)) {
      const whenTrue = resolveAmbientValue(current.whenTrue, seenSymbols);
      const whenFalse = resolveAmbientValue(current.whenFalse, seenSymbols);
      if (whenTrue === undefined) return whenFalse;
      if (whenFalse === undefined) return whenTrue;
      return mergeAmbientValues(whenTrue, whenFalse);
    }
    if (ts.isCallExpression(current)) {
      const callee = resolveAmbientValue(current.expression, seenSymbols);
      if (callee?.kind === "dynamic-code") return callee;
      if (callee?.kind === "dynamic-property") return callee;
      for (const argument of current.arguments) {
        const value = resolveAmbientValue(argument, seenSymbols);
        if (value?.kind === "dynamic-code") return value;
        if (value !== undefined) {
          return {
            kind: "dynamic-property",
            root:
              value.kind === "root" ||
              value.kind === "property" ||
              value.kind === "dynamic-property"
                ? value.root
                : "globalThis",
          };
        }
      }
      if (!ts.isIdentifier(current.expression)) return undefined;
      const symbol = checker.getSymbolAtLocation(current.expression);
      if (symbol === undefined || seenSymbols.has(symbol)) return undefined;
      seenSymbols.add(symbol);
      const returns: AmbientValue[] = [];
      for (const declaration of symbol.declarations ?? []) {
        let body: ts.ConciseBody | undefined;
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          body = declaration.initializer.body;
        } else if (ts.isFunctionDeclaration(declaration)) {
          body = declaration.body;
        } else if (
          ts.isMethodDeclaration(declaration) ||
          ts.isGetAccessorDeclaration(declaration) ||
          ts.isSetAccessorDeclaration(declaration)
        ) {
          body = declaration.body;
        }
        if (body === undefined) continue;
        if (!ts.isBlock(body)) {
          const value = resolveAmbientValue(body, new Set(seenSymbols));
          if (value !== undefined) returns.push(value);
          continue;
        }
        function collectReturns(node: ts.Node): void {
          if (ts.isFunctionLike(node) && node !== body) return;
          if (ts.isReturnStatement(node) && node.expression !== undefined) {
            const value = resolveAmbientValue(
              node.expression,
              new Set(seenSymbols),
            );
            if (value !== undefined) returns.push(value);
          }
          ts.forEachChild(node, collectReturns);
        }
        collectReturns(body);
      }
      if (returns.length === 0) return undefined;
      return returns.slice(1).reduce(
        (currentValue, value) => mergeAmbientValues(currentValue, value),
        returns[0] as AmbientValue,
      );
    }
    if (ts.isNewExpression(current)) {
      const callee = resolveAmbientValue(current.expression, seenSymbols);
      if (callee?.kind === "dynamic-code") return callee;
      if (callee?.kind === "dynamic-property") return callee;
      for (const argument of current.arguments ?? []) {
        const value = resolveAmbientValue(argument, seenSymbols);
        if (value?.kind === "dynamic-code") return value;
        if (value !== undefined) {
          return {
            kind: "dynamic-property",
            root:
              value.kind === "root" ||
              value.kind === "property" ||
              value.kind === "dynamic-property"
                ? value.root
                : "globalThis",
          };
        }
      }
      return undefined;
    }
    return undefined;
  }

  function bindingPropertyName(
    binding: ts.BindingElement,
  ): string | undefined {
    if (binding.dotDotDotToken !== undefined) return undefined;
    if (binding.propertyName !== undefined) {
      if (ts.isComputedPropertyName(binding.propertyName)) {
        return constantStringExpression(binding.propertyName.expression);
      }
      return ts.isStringLiteralLike(binding.propertyName) ||
        ts.isIdentifier(binding.propertyName)
        ? binding.propertyName.text
        : undefined;
    }
    return ts.isIdentifier(binding.name) ? binding.name.text : undefined;
  }

  function assignBindingPattern(
    pattern: ts.BindingName,
    value: AmbientValue,
  ): void {
    if (ts.isIdentifier(pattern)) {
      const symbol = checker.getSymbolAtLocation(pattern);
      if (symbol !== undefined) addAmbientValue(symbol, value);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        const propertyName = bindingPropertyName(element);
        const elementValue =
          value.kind === "root" && propertyName !== undefined
            ? DYNAMIC_CODE_GLOBALS.has(propertyName)
              ? {
                  kind: "dynamic-code" as const,
                  name: propertyName as "eval" | "Function",
                }
              : {
                  kind: "property" as const,
                  root: value.root,
                  name: propertyName,
                }
            : {
                kind: "dynamic-property" as const,
                root: value.kind === "root" ? value.root : "globalThis",
              };
        assignBindingPattern(element.name, elementValue);
      }
      return;
    }
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      assignBindingPattern(element.name, {
        kind: "dynamic-property",
        root: value.kind === "root" ? value.root : "globalThis",
      });
    }
  }

  function assignExpressionPattern(
    pattern: ts.Expression,
    value: AmbientValue,
  ): void {
    const current = unwrapExpression(pattern);
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (symbol !== undefined) addAmbientValue(symbol, value);
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getSymbolAtLocation(property.name);
          if (symbol !== undefined) {
            const name = property.name.text;
            const propertyValue =
              value.kind === "root"
                ? DYNAMIC_CODE_GLOBALS.has(name)
                  ? {
                      kind: "dynamic-code" as const,
                      name: name as "eval" | "Function",
                    }
                  : {
                      kind: "property" as const,
                      root: value.root,
                      name,
                    }
                : {
                    kind: "dynamic-property" as const,
                    root:
                      value.kind === "property" ||
                      value.kind === "dynamic-property"
                        ? value.root
                        : "globalThis",
                  };
            addAmbientValue(symbol, propertyValue);
          }
          continue;
        }
        if (ts.isSpreadAssignment(property)) {
          const propertyValue = resolveAmbientValue(property.expression);
          if (propertyValue !== undefined) {
            assignExpressionPattern(property.expression, propertyValue);
          }
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const name = ts.isComputedPropertyName(property.name)
          ? constantStringExpression(property.name.expression)
          : ts.isStringLiteralLike(property.name) ||
              ts.isIdentifier(property.name)
            ? property.name.text
            : undefined;
        if (name === undefined) {
          assignExpressionPattern(property.initializer, {
            kind: "dynamic-property",
            root:
              value.kind === "root" ||
              value.kind === "property" ||
              value.kind === "dynamic-property"
                ? value.root
                : "globalThis",
          });
          continue;
        }
        const propertyValue =
          value.kind === "root"
            ? DYNAMIC_CODE_GLOBALS.has(name)
              ? {
                  kind: "dynamic-code" as const,
                  name: name as "eval" | "Function",
                }
              : {
                  kind: "property" as const,
                  root: value.root,
                  name,
                }
            : {
                kind: "dynamic-property" as const,
                root:
                  value.kind === "property" ||
                  value.kind === "dynamic-property"
                    ? value.root
                    : "globalThis",
              };
        assignExpressionPattern(property.initializer, propertyValue);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) continue;
        assignExpressionPattern(element, {
          kind: "dynamic-property",
          root:
            value.kind === "root" ||
            value.kind === "property" ||
            value.kind === "dynamic-property"
              ? value.root
              : "globalThis",
        });
      }
    }
  }

  for (let iteration = 0; iteration < variableDeclarations.length + assignments.length + 2; iteration += 1) {
    for (const declaration of variableDeclarations) {
      if (declaration.initializer === undefined) continue;
      const value = resolveAmbientValue(declaration.initializer);
      if (value !== undefined) {
        assignBindingPattern(declaration.name, value);
      }
    }
    for (const assignment of assignments) {
      const value = resolveAmbientValue(assignment.right);
      if (value !== undefined) {
        assignExpressionPattern(assignment.left, value);
      }
    }
  }

  function reportResolvedAmbient(
    node: ts.Node,
    value: AmbientValue | undefined,
  ): void {
    if (value === undefined) return;
    const location = semanticLocation(sourceFile, node);
    if (value.kind === "dynamic-code") {
      diagnostics.push(
        diagnostic(
          "MODULE_DYNAMIC_CODE_UNSUPPORTED",
          `Dynamic code generation through "${value.name}" is not supported in Worker artifacts; use statically authored code.`,
          relativePath,
          location,
        ),
      );
      return;
    }
    if (value.kind === "dynamic-property") {
      diagnostics.push(
        diagnostic(
          "MODULE_AMBIENT_BINDING",
          `Dynamic property access through ${value.root} is not allowed because it may read a secret or environment binding; use explicit Eden inputs instead.`,
          relativePath,
          location,
        ),
      );
      return;
    }
    if (
      value.kind === "property" &&
      (isSecretLikeAmbientName(value.name) ||
        FORBIDDEN_AMBIENT_GLOBALS.has(value.name))
    ) {
      diagnostics.push(
        diagnostic(
          "MODULE_AMBIENT_BINDING",
          `Property "${value.name}" reads a secret-like or environment ambient binding; use explicit Eden inputs instead (line ${location.line}, column ${location.column}).`,
          relativePath,
          location,
        ),
      );
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      reportResolvedAmbient(node, resolveAmbientValue(node));
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const calleeValue = resolveAmbientValue(node.expression);
      if (calleeValue === undefined) {
        reportResolvedAmbient(node, resolveAmbientValue(node));
      }
    }
    if (ts.isIdentifier(node) && !isNonReferenceIdentifier(node)) {
      const name = node.text;
      const implicitlyBound =
        name === "arguments" && hasArgumentsBinding(node);
      const declared =
        importedBindings.has(name) || hasAuthoredBinding(node);
      const isPropertyBase =
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node;
      if (!isPropertyBase) {
        reportResolvedAmbient(node, resolveAmbientValue(node));
      }
      if (
        !SUPPORTED_WORKER_GLOBALS.has(name) &&
        !FORBIDDEN_AMBIENT_GLOBALS.has(name) &&
        !declared &&
        !implicitlyBound &&
        !DYNAMIC_CODE_GLOBALS.has(name)
      ) {
        const location = semanticLocation(sourceFile, node);
        diagnostics.push(
          diagnostic(
            "MODULE_UNDECLARED_IDENTIFIER",
            `Identifier "${name}" is not declared in the authored Worker graph or the supported Worker global allowlist (line ${location.line}, column ${location.column}).`,
            relativePath,
            location,
          ),
        );
      } else if (FORBIDDEN_AMBIENT_GLOBALS.has(name) && !declared) {
        const location = semanticLocation(sourceFile, node);
        diagnostics.push(
          diagnostic(
            "MODULE_AMBIENT_BINDING",
            `Identifier "${name}" is a forbidden Node or ambient binding; use explicit Eden inputs instead (line ${location.line}, column ${location.column}).`,
            relativePath,
            location,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return diagnostics;
}

async function validateAuthoredWorkerSources(
  snapshot: EdenSourceSnapshot,
): Promise<void> {
  const files = [...snapshot.files.values()].sort((left, right) =>
    comparePath(left.relativePath, right.relativePath),
  );
  const sourceFiles = files
    .filter(
      (file) =>
        isJavaScriptSourcePath(file.relativePath) &&
        !file.relativePath.startsWith("node_modules/"),
    )
    .map((file) => ({
      file,
      fileName: join(snapshot.sourceRoot, file.relativePath),
      contents: new TextDecoder("utf-8", { fatal: true }).decode(file.contents),
    }));
  const sourceByFileName = new Map(
    sourceFiles.map((item) => [item.fileName, item]),
  );
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile?.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const authored = sourceByFileName.get(fileName);
    if (authored !== undefined) {
      return ts.createSourceFile(
        fileName,
        authored.contents,
        languageVersion,
        true,
        fileName.endsWith(".tsx")
          ? ts.ScriptKind.TSX
          : fileName.endsWith(".jsx")
            ? ts.ScriptKind.JSX
            : fileName.endsWith(".js") ||
                fileName.endsWith(".mjs") ||
                fileName.endsWith(".cjs")
              ? ts.ScriptKind.JS
              : ts.ScriptKind.TS,
      );
    }
    return originalGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  host.readFile = (fileName) =>
    sourceByFileName.get(fileName)?.contents ?? originalReadFile?.(fileName);
  host.fileExists = (fileName) =>
    sourceByFileName.has(fileName) || originalFileExists(fileName);
  const program = ts.createProgram({
    host,
    options: compilerOptions,
    rootNames: sourceFiles.map((item) => item.fileName),
  });
  const checker = program.getTypeChecker();
  const diagnostics: EdenDiagnostic[] = [];

  for (const file of files) {
    if (
      !isJavaScriptSourcePath(file.relativePath) ||
      file.relativePath.startsWith("node_modules/")
    ) {
      continue;
    }
    const contents = sourceByFileName.get(
      join(snapshot.sourceRoot, file.relativePath),
    )?.contents;
    if (contents === undefined) continue;
    if (!file.relativePath.endsWith(".d.ts")) {
      const sourceFile = program.getSourceFile(
        join(snapshot.sourceRoot, file.relativePath),
      );
      if (sourceFile === undefined) continue;
      const semanticDiagnostics = semanticWorkerBindingDiagnostics(
        sourceFile,
        file.relativePath,
        checker,
      );
      diagnostics.push(...semanticDiagnostics);
    }
  }
  if (diagnostics.length > 0) {
    throw new EdenCompilerError(
      "Worker compatibility validation failed",
      diagnostics,
    );
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
      nodePaths: [join(normalized.projectRoot, "node_modules")],
      preserveSymlinks: true,
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
            const dependencyOrigins = new Map<string, string>();
            const authoredSources = [
              normalized.discovery.agent,
              normalized.discovery.instructions,
              ...normalized.discovery.tools,
            ];
            for (const source of authoredSources) {
              dependencyOrigins.set(
                normalize(join(normalized.projectRoot, source.relativePath)),
                source.relativePath,
              );
            }
            const authoredSourceFor = (importer: string): string => {
              const normalizedImporter = normalize(
                isAbsolute(importer)
                  ? importer
                  : resolve(normalized.projectRoot, importer),
              );
              const knownOrigin = dependencyOrigins.get(normalizedImporter);
              if (knownOrigin !== undefined) return knownOrigin;
              const relativeImporter = toPosixPath(
                relative(normalized.projectRoot, normalizedImporter),
              );
              return relativeImporter.startsWith("../") ||
                relativeImporter.startsWith("node_modules/") ||
                relativeImporter === "eden-artifact-entry.mjs"
                ? normalized.discovery.agent.relativePath
                : relativeImporter;
            };
            context.onResolve({ filter: /^[^./]/ }, (args) => {
              const resolved = resolveSelectedProjectDependency(
                normalized.projectRoot,
                args.importer,
                args.path,
              );
              const origin = authoredSourceFor(args.importer);
              if (resolved !== undefined) {
                dependencyOrigins.set(normalize(resolved), origin);
                if (!isWithinRoot(normalized.projectRoot, normalize(resolved))) {
                  compatibilityIssue = {
                    code: "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                    message:
                      `Authored import from "${origin}" resolves outside the selected project root; ` +
                      "declare it in the selected project's install context.",
                    source: origin,
                  };
                }
              }
              return undefined;
            });
            context.onResolve(
              {
                filter:
                  /^(?:node:(?:fs|path|url|module|os|crypto|vm)|fs|path|url|module|os|crypto|vm)$/,
              },
              (args) => {
                const source = authoredSourceFor(args.importer);
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
                const importer = normalize(args.resolveDir);
                const origin = authoredSourceFor(args.importer);
                if (
                  isWithinRoot(
                    normalize(join(normalized.projectRoot, "node_modules")),
                    importer,
                  )
                ) {
                  dependencyOrigins.set(normalize(canonical), origin);
                  return undefined;
                }
                if (!isWithinRoot(normalized.projectRoot, canonical)) {
                  compatibilityIssue = {
                    code: "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                    message:
                      `Authored import from "${origin}" resolves outside the selected project root.`,
                    source: origin,
                  };
                  return {
                    errors: [
                      {
                        text:
                          `Import "${args.path}" from "${origin}" escapes the selected project root.`,
                      },
                    ],
                  };
                }
                dependencyOrigins.set(normalize(canonical), origin);
                return undefined;
              },
            );
            context.onLoad({ filter: /./ }, (args) => {
              if (
                isWithinRoot(
                  normalized.projectRoot,
                  normalize(args.path),
                )
              ) {
                return undefined;
              }
              compatibilityIssue = {
                code: "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
                message:
                  `Authored import from "${authoredSourceFor(args.path)}" resolves outside the selected project root; ` +
                  "declare it in the selected project's install context.",
                source: authoredSourceFor(args.path),
              };
              return {
                errors: [{ text: compatibilityIssue.message }],
              };
            });
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

function sourceReferenceEqual(
  left: EdenSourceReference,
  right: EdenSourceReference,
): boolean {
  return stableJson(left) === stableJson(right);
}

function assertDiscoveryCoherence(
  discovery: EdenDiscoveryRecord,
  manifest: EdenManifest,
  moduleMap: EdenModuleMap,
): void {
  if (
    moduleMap.kind !== "eden.module-map" ||
    moduleMap.version !== EDEN_AGENT_BUNDLE_VERSION ||
    manifest.kind !== "eden.manifest" ||
    manifest.version !== EDEN_MANIFEST_VERSION ||
    manifest.runtimeVersion !== EDEN_RUNTIME_VERSION ||
    manifest.agentBundleVersion !== EDEN_AGENT_BUNDLE_VERSION ||
    manifest.protocolVersion !== EDEN_PROTOCOL_VERSION ||
    manifest.schemaVersion !== EDEN_SCHEMA_VERSION
  ) {
    throw new EdenCompilerError("Published artifact metadata is malformed", [
      diagnostic(
        "OUTPUT_INVALID",
        "Published artifact kind or version metadata is not compatible with Eden.",
      ),
    ]);
  }
  if (!sourceReferenceEqual(discovery.agent, manifest.agent.source)) {
    throw new EdenCompilerError("Published discovery metadata is incoherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Discovery agent metadata does not match the generated manifest.",
      ),
    ]);
  }
  if (!sourceReferenceEqual(discovery.instructions, manifest.instructions.source)) {
    throw new EdenCompilerError("Published discovery metadata is incoherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Discovery instruction metadata does not match the generated manifest.",
      ),
    ]);
  }
  if (
    discovery.tools.length !== manifest.tools.length ||
    discovery.tools.some(
      (source, index) =>
        !sourceReferenceEqual(source, manifest.tools[index]?.source as EdenSourceReference),
    )
  ) {
    throw new EdenCompilerError("Published discovery metadata is incoherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Discovery tool metadata does not match the generated manifest.",
      ),
    ]);
  }
  if (
    !sourceReferenceEqual(moduleMap.agent.source, discovery.agent) ||
    moduleMap.agent.name !== "agent" ||
    moduleMap.agent.module !== "agent:default" ||
    !sourceReferenceEqual(moduleMap.instructions.source, discovery.instructions) ||
    moduleMap.instructions.name !== "instructions" ||
    moduleMap.instructions.module !== "instructions:default" ||
    moduleMap.tools.length !== discovery.tools.length ||
    moduleMap.tools.some(
      (reference, index) =>
        !sourceReferenceEqual(
          reference.source,
          discovery.tools[index] as EdenSourceReference,
        ) ||
        reference.name !== manifest.tools[index]?.name ||
        reference.module !== manifest.tools[index]?.module,
    )
  ) {
    throw new EdenCompilerError("Published discovery metadata is incoherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Static module-map source metadata does not match discovery metadata.",
      ),
    ]);
  }
}

function assertDiagnosticRecords(value: unknown): asserts value is readonly EdenDiagnostic[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !isRecord(item) ||
        typeof item.code !== "string" ||
        typeof item.message !== "string" ||
        !["error", "warning", "info"].includes(String(item.severity)) ||
        (item.source !== undefined && typeof item.source !== "string") ||
        (item.line !== undefined && !Number.isInteger(item.line)) ||
        (item.column !== undefined && !Number.isInteger(item.column)),
    )
  ) {
    throw new EdenCompilerError("Published diagnostics are malformed", [
      diagnostic(
        "OUTPUT_INVALID",
        "The generated diagnostics artifact must contain Eden diagnostic records.",
      ),
    ]);
  }
}

function assertPublishedArtifactCoherence(
  discovery: EdenDiscoveryRecord,
  diagnostics: unknown,
  manifest: EdenManifest,
  moduleMap: EdenModuleMap,
  bundle: string,
  buildMetadata: EdenBuildMetadata,
): void {
  assertDiagnosticRecords(diagnostics);
  if (diagnostics.length !== 0) {
    throw new EdenCompilerError("Published diagnostics are not coherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "A successful generated artifact generation must contain no error diagnostics.",
      ),
    ]);
  }
  assertArtifactCoherence(manifest, moduleMap, bundle, buildMetadata);
  assertDiscoveryCoherence(discovery, manifest, moduleMap);
  if (
    buildMetadata.manifestVersion !== manifest.version ||
    buildMetadata.runtimeVersion !== manifest.runtimeVersion ||
    buildMetadata.agentBundleVersion !== manifest.agentBundleVersion ||
    buildMetadata.protocolVersion !== manifest.protocolVersion ||
    buildMetadata.schemaVersion !== manifest.schemaVersion
  ) {
    throw new EdenCompilerError("Published artifact versions are incoherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Build metadata versions do not match the generated manifest versions.",
      ),
    ]);
  }
}

async function readPublishedGeneration(
  projectRoot: string,
  directory: string,
): Promise<EdenArtifactSet> {
  try {
    await assertNoGeneratedSymlinks(projectRoot, directory);
    const directoryDetails = await lstat(directory);
    if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()) {
      throw new EdenCompilerError("Published artifact generation is invalid", [
        diagnostic(
          "OUTPUT_INVALID",
          `Existing artifact generation "${basename(directory)}" is not a real directory.`,
        ),
      ]);
    }
    const artifactPaths = Object.values(ARTIFACT_FILE_NAMES).map((name) =>
      join(directory, name),
    );
    const artifactDetails = await Promise.all(
      artifactPaths.map((path) => lstat(path)),
    );
    if (
      artifactDetails.some(
        (details) => !details.isFile() || details.isSymbolicLink(),
      )
    ) {
      throw new EdenCompilerError("Published artifact generation is invalid", [
        diagnostic(
          "OUTPUT_INVALID",
          `Existing artifact generation "${basename(directory)}" is incomplete or contains symbolic links.`,
        ),
      ]);
    }
    const [
      discovery,
      diagnostics,
      manifest,
      moduleMap,
      buildMetadata,
      bundle,
    ] = await Promise.all([
      readFile(join(directory, ARTIFACT_FILE_NAMES.discovery), "utf8"),
      readFile(join(directory, ARTIFACT_FILE_NAMES.diagnostics), "utf8"),
      readFile(join(directory, ARTIFACT_FILE_NAMES.manifest), "utf8"),
      readFile(join(directory, ARTIFACT_FILE_NAMES.moduleMap), "utf8"),
      readFile(join(directory, ARTIFACT_FILE_NAMES.buildMetadata), "utf8"),
      readFile(join(directory, ARTIFACT_FILE_NAMES.bundle), "utf8"),
    ]);
    return decodePublishedArtifactSet(
      {
        discovery,
        diagnostics,
        manifest,
        moduleMap,
        buildMetadata,
        bundle,
      },
      directory,
    );
  } catch (error: unknown) {
    if (error instanceof EdenCompilerError) throw error;
    throw new EdenCompilerError("Published artifact generation is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Existing artifact generation "${basename(directory)}" is incomplete or malformed.`,
      ),
    ]);
  }
}

interface PublishedArtifactContents {
  readonly discovery: string;
  readonly diagnostics: string;
  readonly manifest: string;
  readonly moduleMap: string;
  readonly bundle: string;
  readonly buildMetadata: string;
}

function decodePublishedArtifactSet(
  contents: PublishedArtifactContents,
  directory?: string,
): EdenArtifactSet {
  const discovery = JSON.parse(contents.discovery) as EdenDiscoveryRecord;
  const diagnostics = JSON.parse(contents.diagnostics) as unknown;
  const manifest = JSON.parse(contents.manifest) as EdenManifest;
  const moduleMap = JSON.parse(contents.moduleMap) as EdenModuleMap;
  const buildMetadata = JSON.parse(
    contents.buildMetadata,
  ) as EdenBuildMetadata;
  const bundle = contents.bundle;
  assertPublishedArtifactCoherence(
    discovery,
    diagnostics,
    manifest,
    moduleMap,
    bundle,
    buildMetadata,
  );
  if (directory !== undefined && basename(directory) !== buildMetadata.generationId) {
    throw new EdenCompilerError("Published artifact identity is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Existing artifact generation "${basename(directory)}" does not match its recorded generation identity.`,
      ),
    ]);
  }
  return {
    discovery,
    diagnostics: diagnostics as readonly EdenDiagnostic[],
    manifest,
    moduleMap,
    bundle,
    buildMetadata,
  };
}

async function readLegacyArtifactSet(
  outputDirectory: string,
): Promise<{
  readonly artifacts: EdenArtifactSet;
  readonly contents: PublishedArtifactContents;
} | undefined> {
  const artifactPaths = Object.values(ARTIFACT_FILE_NAMES).map((name) => ({
    name,
    path: join(outputDirectory, name),
  }));
  const details = await Promise.all(
    artifactPaths.map(({ path }) => lstat(path).catch(() => undefined)),
  );
  const present = details.filter((detail) => detail !== undefined);
  if (present.length === 0) return undefined;
  if (
    present.length !== artifactPaths.length ||
    details.some(
      (detail) =>
        detail === undefined ||
        !detail.isFile() ||
        detail.isSymbolicLink(),
    )
  ) {
    throw new EdenCompilerError("Legacy artifact set is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Legacy artifact output "${outputDirectory}" must contain all six regular artifact files before migration.`,
        outputDirectory,
      ),
    ]);
  }
  try {
    const [
      discovery,
      diagnostics,
      manifest,
      moduleMap,
      bundle,
      buildMetadata,
    ] = await Promise.all([
      readFile(join(outputDirectory, ARTIFACT_FILE_NAMES.discovery), "utf8"),
      readFile(join(outputDirectory, ARTIFACT_FILE_NAMES.diagnostics), "utf8"),
      readFile(join(outputDirectory, ARTIFACT_FILE_NAMES.manifest), "utf8"),
      readFile(join(outputDirectory, ARTIFACT_FILE_NAMES.moduleMap), "utf8"),
      readFile(join(outputDirectory, ARTIFACT_FILE_NAMES.bundle), "utf8"),
      readFile(
        join(outputDirectory, ARTIFACT_FILE_NAMES.buildMetadata),
        "utf8",
      ),
    ]);
    const contents: PublishedArtifactContents = {
      discovery,
      diagnostics,
      manifest,
      moduleMap,
      bundle,
      buildMetadata,
    };
    return {
      contents,
      artifacts: decodePublishedArtifactSet(contents),
    };
  } catch (error: unknown) {
    if (error instanceof EdenCompilerError) {
      throw error;
    }
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new EdenCompilerError(`Legacy artifact set is invalid${message}`, [
      diagnostic(
        "OUTPUT_INVALID",
        `Legacy artifact output "${outputDirectory}" is malformed or incoherent and cannot become CURRENT${message}.`,
        outputDirectory,
      ),
    ]);
  }
}

async function writePublishedArtifactContents(
  directory: string,
  contents: PublishedArtifactContents,
): Promise<void> {
  await Promise.all([
    writeFile(
      join(directory, ARTIFACT_FILE_NAMES.discovery),
      contents.discovery,
      "utf8",
    ),
    writeFile(
      join(directory, ARTIFACT_FILE_NAMES.diagnostics),
      contents.diagnostics,
      "utf8",
    ),
    writeFile(
      join(directory, ARTIFACT_FILE_NAMES.manifest),
      contents.manifest,
      "utf8",
    ),
    writeFile(
      join(directory, ARTIFACT_FILE_NAMES.moduleMap),
      contents.moduleMap,
      "utf8",
    ),
    writeFile(
      join(directory, ARTIFACT_FILE_NAMES.bundle),
      contents.bundle,
      "utf8",
    ),
    writeFile(
      join(directory, ARTIFACT_FILE_NAMES.buildMetadata),
      contents.buildMetadata,
      "utf8",
    ),
  ]);
}

async function assertPublishedGeneration(
  projectRoot: string,
  directory: string,
): Promise<void> {
  await readPublishedGeneration(projectRoot, directory);
}

async function assertArtifactCompatibilityLinks(
  outputDirectory: string,
  generationDirectory: string,
): Promise<void> {
  for (const name of Object.values(ARTIFACT_FILE_NAMES)) {
    const alias = join(outputDirectory, name);
    const details = await lstat(alias).catch(() => undefined);
    const expected = join(generationDirectory, name);
    const expectedDetails = await lstat(expected).catch(() => undefined);
    const target = details?.isSymbolicLink()
      ? await readlink(alias).catch(() => undefined)
      : undefined;
    const resolved = await realpath(alias).catch(() => undefined);
    if (
      details === undefined ||
      !details.isSymbolicLink() ||
      target !== join("CURRENT", name) ||
      expectedDetails === undefined ||
      !expectedDetails.isFile() ||
      expectedDetails.isSymbolicLink() ||
      resolved !== expected
    ) {
      throw new EdenCompilerError("Artifact compatibility links are invalid", [
        diagnostic(
          "OUTPUT_INVALID",
          `Generated artifact alias "${name}" must target the exact regular file under the resolved CURRENT generation.`,
          name,
        ),
      ]);
    }
  }
}

/**
 * Resolve CURRENT exactly once, then load and validate all six artifacts from
 * that immutable generation directory. Compatibility aliases at the output
 * root are intentionally not consulted.
 */
export async function readArtifactGeneration(
  outputDirectory: string,
  options: EdenArtifactGenerationReadOptions = {},
): Promise<EdenArtifactGeneration> {
  const outputDetails = await lstat(outputDirectory).catch(() => undefined);
  if (
    outputDetails === undefined ||
    !outputDetails.isDirectory() ||
    outputDetails.isSymbolicLink()
  ) {
    throw new EdenCompilerError("Artifact output is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Artifact output "${outputDirectory}" must be a real directory.`,
        outputDirectory,
      ),
    ]);
  }
  const outputRoot = await realpath(outputDirectory).catch(() => undefined);
  if (outputRoot === undefined) {
    throw new EdenCompilerError("Artifact output is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Artifact output "${outputDirectory}" could not be resolved.`,
        outputDirectory,
      ),
    ]);
  }
  const generationsDirectory = join(outputRoot, "generations");
  const generationsDetails = await lstat(generationsDirectory).catch(
    () => undefined,
  );
  if (
    generationsDetails === undefined ||
    !generationsDetails.isDirectory() ||
    generationsDetails.isSymbolicLink()
  ) {
    throw new EdenCompilerError("Artifact generations are invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Artifact output "${outputDirectory}" must contain a real generations directory.`,
        "generations",
      ),
    ]);
  }
  const currentPointer = join(outputRoot, "CURRENT");
  const currentDetails = await lstat(currentPointer).catch(() => undefined);
  if (currentDetails === undefined || !currentDetails.isSymbolicLink()) {
    throw new EdenCompilerError("Artifact CURRENT pointer is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Artifact output "${outputDirectory}" CURRENT must be a symbolic link to one generation.`,
        "CURRENT",
      ),
    ]);
  }
  const directory = await realpath(currentPointer).catch(() => undefined);
  if (
    directory === undefined ||
    !isWithinRoot(generationsDirectory, directory)
  ) {
    throw new EdenCompilerError("Artifact CURRENT pointer is unsafe", [
      diagnostic(
        "OUTPUT_OUTSIDE_PROJECT",
        `Artifact output "${outputDirectory}" CURRENT must resolve inside its generations directory.`,
        "CURRENT",
      ),
    ]);
  }
  const directoryDetails = await lstat(directory).catch(() => undefined);
  if (
    directoryDetails === undefined ||
    !directoryDetails.isDirectory() ||
    directoryDetails.isSymbolicLink()
  ) {
    throw new EdenCompilerError("Artifact CURRENT pointer is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Artifact output "${outputDirectory}" CURRENT must target a real generation directory.`,
        "CURRENT",
      ),
    ]);
  }
  await options.afterCurrentResolution?.();
  return {
    directory,
    artifacts: await readPublishedGeneration(outputRoot, directory),
  };
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

async function assertContainedGeneratedPath(
  projectRoot: string,
  path: string,
  description: string,
  requiredDirectory = false,
): Promise<void> {
  const details = await lstat(path).catch(() => undefined);
  if (details === undefined) return;
  if (details.isSymbolicLink()) {
    const resolved = await realpath(path).catch(() => undefined);
    throw new EdenCompilerError("Generated output path is unsafe", [
      diagnostic(
        "OUTPUT_OUTSIDE_PROJECT",
        resolved === undefined || !isWithinRoot(projectRoot, resolved)
          ? `${description} is a symbolic link that escapes the selected project root.`
          : `${description} must be a real directory, not a symbolic link.`,
        path,
      ),
    ]);
  }
  if (requiredDirectory && !details.isDirectory()) {
    throw new EdenCompilerError("Generated output path is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `${description} must be a real directory.`,
        path,
      ),
    ]);
  }
  const resolved = await realpath(path).catch(() => undefined);
  if (resolved === undefined || !isWithinRoot(projectRoot, resolved)) {
    throw new EdenCompilerError("Generated output path escapes the project root", [
      diagnostic(
        "OUTPUT_OUTSIDE_PROJECT",
        `${description} resolves outside the selected project root.`,
        path,
      ),
    ]);
  }
}

async function assertNoGeneratedSymlinks(
  projectRoot: string,
  directory: string,
): Promise<void> {
  await assertContainedGeneratedPath(
    projectRoot,
    directory,
    `Generated directory "${directory}"`,
    true,
  );
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new EdenCompilerError("Generated output path is unsafe", [
        diagnostic(
          "OUTPUT_OUTSIDE_PROJECT",
          `Generated descendant "${child}" must not be a symbolic link.`,
          child,
        ),
      ]);
    }
    if (entry.isDirectory()) {
      await assertNoGeneratedSymlinks(projectRoot, child);
    } else {
      await assertContainedGeneratedPath(
        projectRoot,
        child,
        `Generated descendant "${child}"`,
      );
    }
  }
}

async function publishArtifacts(
  projectRoot: string,
  outputDirectory: string,
  artifacts: EdenArtifactSet,
  hooks: EdenCompilerHooks = {},
): Promise<void> {
  const outputDetails = await lstat(outputDirectory).catch(() => undefined);
  if (
    outputDetails !== undefined &&
    (!outputDetails.isDirectory() || outputDetails.isSymbolicLink())
  ) {
    throw new EdenCompilerError("Artifact output is not a directory", [
      diagnostic(
        "OUTPUT_INVALID",
        `Artifact output "${outputDirectory}" must be a real directory.`,
      ),
    ]);
  }
  await mkdir(outputDirectory, { recursive: true });
  const generationsDirectory = join(outputDirectory, "generations");
  const currentPointer = join(outputDirectory, "CURRENT");
  await assertContainedGeneratedPath(
    projectRoot,
    outputDirectory,
    `Artifact output "${outputDirectory}"`,
    true,
  );
  await assertContainedGeneratedPath(
    projectRoot,
    generationsDirectory,
    `Artifact generations directory "${generationsDirectory}"`,
    true,
  );
  await mkdir(generationsDirectory, { recursive: true });
  await assertContainedGeneratedPath(
    projectRoot,
    generationsDirectory,
    `Artifact generations directory "${generationsDirectory}"`,
    true,
  );
  await assertNoGeneratedSymlinks(projectRoot, generationsDirectory);
  const stage = join(
    generationsDirectory,
    `.staging-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  const generationDirectory = join(
    generationsDirectory,
    artifacts.buildMetadata.generationId,
  );

  const artifactNames = Object.values(ARTIFACT_FILE_NAMES);
  const readCurrent = async (): Promise<boolean> => {
    const current = await lstat(currentPointer).catch(() => undefined);
    if (current === undefined) return false;
    if (!current.isSymbolicLink()) {
      throw new EdenCompilerError("Artifact output is not a directory", [
        diagnostic(
          "OUTPUT_INVALID",
          `Artifact output "${outputDirectory}" has a non-symbolic CURRENT pointer.`,
        ),
      ]);
    }
    const resolved = await realpath(currentPointer).catch(() => undefined);
    if (
      resolved === undefined ||
      !isWithinRoot(projectRoot, resolved) ||
      !isWithinRoot(generationsDirectory, resolved)
    ) {
      throw new EdenCompilerError("Artifact CURRENT pointer is unsafe", [
        diagnostic(
          "OUTPUT_OUTSIDE_PROJECT",
          `Artifact output "${outputDirectory}" has a CURRENT pointer outside its selected generation root.`,
          "CURRENT",
        ),
      ]);
    }
    const resolvedDetails = await lstat(resolved).catch(() => undefined);
    if (resolvedDetails === undefined || !resolvedDetails.isDirectory()) {
      throw new EdenCompilerError("Artifact CURRENT pointer is invalid", [
        diagnostic(
          "OUTPUT_INVALID",
          `Artifact output "${outputDirectory}" CURRENT must target a generation directory.`,
          "CURRENT",
        ),
      ]);
    }
    return true;
  };

  const makePointer = async (target: string): Promise<void> => {
    const pointerStage = join(
      outputDirectory,
      `.CURRENT-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
    );
    const relativeTarget = relative(outputDirectory, target);
    try {
      await symlink(relativeTarget, pointerStage);
      await rename(pointerStage, currentPointer);
    } finally {
      await rm(pointerStage, { force: true }).catch(() => undefined);
    }
  };

  const makeArtifactLinks = async (): Promise<{
    readonly backups: readonly string[];
    readonly createdLinks: readonly string[];
  }> => {
    const backups: string[] = [];
    const createdLinks: string[] = [];
    try {
      for (const name of artifactNames) {
        const destination = join(outputDirectory, name);
        const existing = await lstat(destination).catch(() => undefined);
        if (existing?.isSymbolicLink() === true) {
          const resolved = await realpath(destination).catch(() => undefined);
          const expected = join(generationDirectory, name);
          const target = await readlink(destination).catch(() => undefined);
          if (
            target === join("CURRENT", name) &&
            resolved === expected &&
            (await lstat(expected).catch(() => undefined))?.isFile() === true
          ) {
            continue;
          }
        }
        if (existing !== undefined) {
          if (!existing.isFile() && !existing.isSymbolicLink()) {
            throw new EdenCompilerError("Artifact compatibility link is invalid", [
              diagnostic(
                "OUTPUT_INVALID",
                `Generated artifact link "${name}" must replace a regular file, directory, or symlink.`,
                name,
              ),
            ]);
          }
          const backup = join(
            outputDirectory,
            `.${name}.previous-${process.pid}-${Date.now()}-${Math.random()
              .toString(16)
              .slice(2)}`,
          );
          await rename(destination, backup);
          backups.push(backup);
        }
        await symlink(join("CURRENT", name), destination);
        createdLinks.push(destination);
      }
    } catch (error: unknown) {
      await restoreArtifactLinks({ backups, createdLinks });
      throw error;
    }
    return { backups, createdLinks };
  };

  const restoreArtifactLinks = async (transaction: {
    readonly backups: readonly string[];
    readonly createdLinks: readonly string[];
  }): Promise<void> => {
    for (const destination of transaction.createdLinks) {
      await rm(destination, { force: true }).catch(() => undefined);
    }
    for (const backup of [...transaction.backups].reverse()) {
      const name = basename(backup).replace(
        /^\.([^/]+)\.previous-\d+-\d+-[a-f0-9]+$/u,
        "$1",
      );
      await rename(backup, join(outputDirectory, name)).catch(() => undefined);
    }
  };

  const cleanupBackups = async (backups: readonly string[]): Promise<void> => {
    await Promise.all(
      backups.map((backup) =>
        rm(backup, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  };

  let artifactLinkTransaction:
    | {
        readonly backups: readonly string[];
        readonly createdLinks: readonly string[];
      }
    | undefined;
  let generationPromoted = false;
  try {
    const currentExists = await readCurrent();
    if (!currentExists) {
      const legacy = await readLegacyArtifactSet(outputDirectory);
      if (legacy !== undefined) {
        const legacyDirectory = join(
          generationsDirectory,
          legacy.artifacts.buildMetadata.generationId,
        );
        const existingLegacy = await lstat(legacyDirectory).catch(
          () => undefined,
        );
        if (existingLegacy === undefined) {
          await mkdir(legacyDirectory);
          try {
            await writePublishedArtifactContents(
              legacyDirectory,
              legacy.contents,
            );
            await assertPublishedGeneration(projectRoot, legacyDirectory);
          } catch (error: unknown) {
            await rm(legacyDirectory, { recursive: true, force: true }).catch(
              () => undefined,
            );
            throw error;
          }
        } else {
          if (!existingLegacy.isDirectory() || existingLegacy.isSymbolicLink()) {
            throw new EdenCompilerError("Legacy artifact set is invalid", [
              diagnostic(
                "OUTPUT_INVALID",
                `Legacy generation "${legacy.artifacts.buildMetadata.generationId}" is not a real directory.`,
                legacy.artifacts.buildMetadata.generationId,
              ),
            ]);
          }
          await assertPublishedGeneration(projectRoot, legacyDirectory);
        }
      }
    }

    await hooks.onPublicationBoundary?.("before-stage-write");
    await assertContainedGeneratedPath(
      projectRoot,
      outputDirectory,
      `Artifact output "${outputDirectory}"`,
      true,
    );
    await assertContainedGeneratedPath(
      projectRoot,
      generationsDirectory,
      `Artifact generations directory "${generationsDirectory}"`,
      true,
    );
    await assertNoGeneratedSymlinks(projectRoot, generationsDirectory);
    await mkdir(stage);
    await writePublishedArtifactContents(stage, {
      discovery: jsonDocument(artifacts.discovery),
      diagnostics: jsonDocument(artifacts.diagnostics),
      manifest: jsonDocument(artifacts.manifest),
      moduleMap: jsonDocument(artifacts.moduleMap),
      bundle: artifacts.bundle,
      buildMetadata: jsonDocument(artifacts.buildMetadata),
    });

    await assertNoGeneratedSymlinks(projectRoot, stage);
    const stagedBundle = await readFile(join(stage, ARTIFACT_FILE_NAMES.bundle), "utf8");
    const stagedDiscovery = JSON.parse(
      await readFile(join(stage, ARTIFACT_FILE_NAMES.discovery), "utf8"),
    ) as EdenDiscoveryRecord;
    const stagedDiagnostics = JSON.parse(
      await readFile(join(stage, ARTIFACT_FILE_NAMES.diagnostics), "utf8"),
    ) as unknown;
    const stagedManifest = JSON.parse(
      await readFile(join(stage, ARTIFACT_FILE_NAMES.manifest), "utf8"),
    ) as EdenManifest;
    const stagedModuleMap = JSON.parse(
      await readFile(join(stage, ARTIFACT_FILE_NAMES.moduleMap), "utf8"),
    ) as EdenModuleMap;
    const stagedMetadata = JSON.parse(
      await readFile(join(stage, ARTIFACT_FILE_NAMES.buildMetadata), "utf8"),
    ) as EdenBuildMetadata;
    assertPublishedArtifactCoherence(
      stagedDiscovery,
      stagedDiagnostics,
      stagedManifest,
      stagedModuleMap,
      stagedBundle,
      stagedMetadata,
    );
    await hooks.onPublicationBoundary?.("after-stage-write");

    await assertNoGeneratedSymlinks(projectRoot, generationsDirectory);
    const existingGeneration = await lstat(generationDirectory).catch(
      () => undefined,
    );
    if (existingGeneration === undefined) {
      await rename(stage, generationDirectory);
      await assertPublishedGeneration(projectRoot, generationDirectory);
    } else {
      if (!existingGeneration.isDirectory() || existingGeneration.isSymbolicLink()) {
        throw new EdenCompilerError("Artifact output is not a directory", [
          diagnostic(
            "OUTPUT_INVALID",
            `Artifact generation "${artifacts.buildMetadata.generationId}" is not a real directory.`,
          ),
        ]);
      }
      await assertPublishedGeneration(projectRoot, generationDirectory);
      await rm(stage, { recursive: true, force: true });
    }

    artifactLinkTransaction = await makeArtifactLinks();
    await hooks.onPublicationBoundary?.("before-current-promotion");
    await assertPublishedGeneration(projectRoot, generationDirectory);
    await makePointer(generationDirectory);
    generationPromoted = true;
    await hooks.onPublicationBoundary?.("after-current-promotion");
    await cleanupBackups(artifactLinkTransaction.backups);
    await assertArtifactCompatibilityLinks(outputDirectory, generationDirectory);
  } catch (error: unknown) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (!generationPromoted && artifactLinkTransaction !== undefined) {
      await restoreArtifactLinks(artifactLinkTransaction);
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
  const snapshot = await captureSourceSnapshot(projectRoot);
  try {
    await options.hooks?.afterSourceSnapshot?.();
    await validateAuthoredWorkerSources(snapshot);
    const normalized = await normalizeSnapshot(snapshot);
    const moduleMap = artifactModuleMap(normalized);
    const bundle = await bundleProject(normalized, moduleMap);
    const manifest = createGeneratedManifest(
      normalized,
      moduleMap,
      sha256(bundle),
    );
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
    await publishArtifacts(projectRoot, outputDirectory, artifacts, options.hooks);
    return { artifacts, diagnostics };
  } finally {
    await snapshot.cleanup();
  }
}

export class EdenNodeCompiler implements EdenCompiler {
  readonly version = EDEN_RUNTIME_VERSION;

  async build(options: EdenCompilerOptions): Promise<EdenCompilerResult> {
    return buildProject(options);
  }
}

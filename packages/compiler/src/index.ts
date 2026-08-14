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

/**
 * Read and validate one immutable generation directory without consulting
 * CURRENT. CLI publication uses this to validate an existing same-identity
 * generation before changing the pointer, while the compiler remains the
 * single owner of artifact schemas, runtime shape, coherence, and descendant
 * tree safety.
 */
export async function readArtifactGenerationAt(
  projectRoot: string,
  generationDirectory: string,
): Promise<EdenArtifactGeneration> {
  const resolvedProjectRoot = await resolveProjectRoot({ projectRoot });
  const candidate = isAbsolute(generationDirectory)
    ? normalize(generationDirectory)
    : resolve(resolvedProjectRoot, generationDirectory);
  const details = await lstat(candidate).catch(() => undefined);
  if (
    details === undefined ||
    !details.isDirectory() ||
    details.isSymbolicLink()
  ) {
    throw new EdenCompilerError("Artifact generation is invalid", [
      diagnostic(
        "OUTPUT_INVALID",
        `Artifact generation "${generationDirectory}" must be a real directory.`,
        generationDirectory,
      ),
    ]);
  }
  const resolvedDirectory = await realpath(candidate).catch(() => undefined);
  if (
    resolvedDirectory === undefined ||
    !isWithinRoot(resolvedProjectRoot, resolvedDirectory)
  ) {
    throw new EdenCompilerError("Artifact generation is unsafe", [
      diagnostic(
        "OUTPUT_OUTSIDE_PROJECT",
        `Artifact generation "${generationDirectory}" must resolve inside the selected project root.`,
        generationDirectory,
      ),
    ]);
  }
  return {
    directory: resolvedDirectory,
    artifacts: await readPublishedGeneration(
      resolvedProjectRoot,
      candidate,
    ),
  };
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

export interface EdenImportClosure {
  readonly files: readonly EdenSourceReference[];
  readonly diagnostics: readonly EdenDiagnostic[];
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

/**
 * Capture the exact contained source/import closure used by the compiler.
 *
 * The returned paths are the compiler's logical project-relative inputs,
 * including selected-project dependency files and their package metadata.
 * Callers that validate source identity must use this closure instead of
 * recursively walking the project filesystem.
 */
export async function captureProjectImportClosure(
  selection: EdenProjectSelection,
): Promise<EdenImportClosure> {
  const options =
    typeof selection === "string" ? { projectRoot: selection } : selection;
  const projectRoot = await resolveProjectRoot(options);
  const snapshot = await captureSourceSnapshot(projectRoot);
  try {
    const files = [...snapshot.files.values()]
      .map((file) => ({
        relativePath: file.relativePath,
        sha256: hashBytes(file.contents),
      }))
      .sort((left, right) =>
        comparePath(left.relativePath, right.relativePath),
      );
    return {
      files,
      diagnostics: snapshot.diagnostics,
    };
  } finally {
    await snapshot.cleanup();
  }
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

// eden-artifact-entry.mjs
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

function isTypeDeclarationPath(relativePath: string): boolean {
  return /\.d\.[cm]?ts$/u.test(relativePath);
}

const TRUSTED_ZOD_PACKAGE = Object.freeze({
  root: "node_modules/zod",
  name: "zod",
  version: "4.4.3",
  // This digest covers the exact captured executable/package-metadata closure
  // for the pinned Zod package. It is intentionally stricter than a path check
  // and changes when any captured package byte changes.
  integrity:
    "73a8deb738c4820403c98860048e14031bb17df2367592ae4f1d56e55a472fe7",
});

const TRUSTED_ZOD_GENERATED_DEPENDENCY_DIGEST =
  "27dc003cd49baf8edbf0da0af36edb66e18c1ce66fa10667c5ba5b9c16bbf224";
const TRUSTED_GENERATED_EXPORT_HELPER_DIGEST =
  "8880c33da927f05af9f8b8f873eaf291c5c30dbd61d7d1268a09615c7c33da10";

function dependencyPackageRoot(relativePath: string): string | undefined {
  const segments = relativePath.split("/");
  if (segments[0] !== "node_modules") return undefined;
  if (segments[1]?.startsWith("@")) {
    return segments.length >= 3
      ? segments.slice(0, 3).join("/")
      : undefined;
  }
  return segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined;
}

function dependencyClosureIntegrity(
  files: readonly SnapshotFile[],
  packageRoot: string,
): string {
  const hash = createHash("sha256");
  const packageFiles = files
    .filter((file) => dependencyPackageRoot(file.relativePath) === packageRoot)
    .sort((left, right) => comparePath(left.relativePath, right.relativePath));
  for (const file of packageFiles) {
    hash.update(file.relativePath.slice(packageRoot.length + 1));
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

interface GeneratedBundleLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function generatedBundleLines(bundle: string): readonly GeneratedBundleLine[] {
  const lines: GeneratedBundleLine[] = [];
  let start = 0;
  while (start <= bundle.length) {
    const newline = bundle.indexOf("\n", start);
    const end = newline < 0 ? bundle.length : newline;
    lines.push({
      text: bundle.slice(start, end).replace(/\r$/u, ""),
      start,
      end,
    });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function generatedBundleCommentLineStarts(
  bundle: string,
): ReadonlySet<number> {
  const starts = new Set<number>();
  const sourceFile = ts.createSourceFile(
    "agent-bundle.mjs",
    bundle,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  for (const statement of sourceFile.statements) {
    for (const range of ts.getLeadingCommentRanges(bundle, statement.getFullStart()) ?? []) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      const start = range.pos;
      const lineStart = bundle.lastIndexOf("\n", start - 1) + 1;
      if (start === lineStart) starts.add(lineStart);
    }
  }
  return starts;
}

function generatedDependencyNamespaceNames(
  bundle: string,
  packageRoot: string,
): readonly string[] {
  const namespaces = new Set<string>();
  const commentLineStarts = generatedBundleCommentLineStarts(bundle);
  let inPackageSection = false;
  for (const line of generatedBundleLines(bundle)) {
    if (commentLineStarts.has(line.start) && line.text.startsWith("// ")) {
      inPackageSection =
        line.text.startsWith(`// ${packageRoot}/`) ||
        line.text.startsWith(`// ${packageRoot}:`);
      continue;
    }
    if (!inPackageSection) continue;
    const match = line.text.match(
      /^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\};/u,
    );
    if (match?.[1] !== undefined && /_exports\d*$/u.test(match[1])) {
      namespaces.add(match[1]);
    }
  }
  return [...namespaces].sort(comparePath);
}

function generatedDependencyNamespaceCandidates(
  bundle: string,
  packageRoot: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    "agent-bundle.mjs",
    bundle,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const ranges = generatedDependencySectionRanges(bundle, packageRoot);
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    const start = statement.getStart(sourceFile);
    if (
      !ranges.some((range) => start >= range.start && start < range.end) ||
      !ts.isVariableStatement(statement)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        /_exports\d*$/u.test(declaration.name.text) &&
        declaration.initializer !== undefined &&
        ts.isObjectLiteralExpression(declaration.initializer) &&
        declaration.initializer.properties.length === 0
      ) {
        namespaces.add(declaration.name.text);
      }
    }
  }
  return [...namespaces].sort(comparePath);
}

function generatedDependencyHasPackageMarker(
  bundle: string,
  packageRoot: string,
): boolean {
  const commentLineStarts = generatedBundleCommentLineStarts(bundle);
  return generatedBundleLines(bundle).some(
    (line) =>
      commentLineStarts.has(line.start) &&
      (line.text.startsWith(`// ${packageRoot}/`) ||
        line.text.startsWith(`// ${packageRoot}:`)),
  );
}

function generatedDependencyContentDigest(
  bundle: string,
  packageRoot: string,
): string {
  const lines: string[] = [];
  const commentLineStarts = generatedBundleCommentLineStarts(bundle);
  let inPackageSection = false;
  for (const line of generatedBundleLines(bundle)) {
    if (commentLineStarts.has(line.start) && line.text.startsWith("// ")) {
      inPackageSection =
        line.text.startsWith(`// ${packageRoot}/`) ||
        line.text.startsWith(`// ${packageRoot}:`);
      if (inPackageSection) lines.push(line.text);
      continue;
    }
    if (inPackageSection) lines.push(line.text);
  }
  return sha256(lines.join("\n"));
}

function generatedDependencySectionRanges(
  bundle: string,
  packageRoot: string,
): readonly { readonly start: number; readonly end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const commentLineStarts = generatedBundleCommentLineStarts(bundle);
  let activeStart = -1;
  for (const line of generatedBundleLines(bundle)) {
    if (commentLineStarts.has(line.start) && line.text.startsWith("// ")) {
      const path = line.text.slice(3);
      const isPackageSection =
        path.startsWith(`${packageRoot}/`) ||
        path.startsWith(`${packageRoot}:`);
      const isSourceSection =
        path.startsWith("node_modules/") ||
        path.startsWith("agent/") ||
        path === "eden-artifact-entry.mjs";
      if (isPackageSection) {
        if (activeStart >= 0) {
          ranges.push({ start: activeStart, end: line.start });
        }
        activeStart = line.end < bundle.length ? line.end + 1 : bundle.length;
      } else if (activeStart >= 0 && isSourceSection) {
        ranges.push({ start: activeStart, end: line.start });
        activeStart = -1;
      }
    }
  }
  if (activeStart >= 0) {
    ranges.push({ start: activeStart, end: bundle.length });
  }
  return ranges;
}

function generatedDependencyNamespaceDigest(
  namespaceNames: readonly string[],
  contentDigest: string,
): string {
  return sha256(
    stableJson({
      packageName: TRUSTED_ZOD_PACKAGE.name,
      packageVersion: TRUSTED_ZOD_PACKAGE.version,
      packageRoot: TRUSTED_ZOD_PACKAGE.root,
      integrity: TRUSTED_ZOD_PACKAGE.integrity,
      namespaceNames,
      contentDigest,
    }),
  );
}

interface GeneratedArtifactEntryBoundary {
  readonly markerStart: number;
  readonly markerEnd: number;
  readonly entryStart: number;
  readonly defaultStart: number;
}

function generatedArtifactEntryBoundary(
  bundle: string,
): GeneratedArtifactEntryBoundary | undefined {
  const sourceFile = sourceFileForValidation("agent-bundle.mjs", bundle);
  const markerRanges = new Map<number, { start: number; end: number }>();
  const markerPattern =
    /(?:^|\r?\n)[ \t]*\/\/ eden-artifact-entry\.mjs[ \t]*(?=\r?\n|$)/gu;
  for (const match of bundle.matchAll(markerPattern)) {
    const matchStart = match.index ?? 0;
    const lineStart = bundle[matchStart] === "\n" ? matchStart + 1 : matchStart;
    const leadingWhitespace =
      bundle.slice(lineStart).match(/^[ \t]*/u)?.[0] ?? "";
    const start = lineStart + leadingWhitespace.length;
    const end = start + "// eden-artifact-entry.mjs".length;
    markerRanges.set(start, { start, end });
  }
  for (const statement of sourceFile.statements) {
    for (
      const range of
        ts.getLeadingCommentRanges(bundle, statement.getFullStart()) ?? []
    ) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      if (
        bundle.slice(range.pos, range.end).trim() !==
        "// eden-artifact-entry.mjs"
      ) {
        continue;
      }
      markerRanges.set(range.pos, { start: range.pos, end: range.end });
    }
  }
  const entryStatements = sourceFile.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "edenTools",
      ),
  );
  const defaultStatements = sourceFile.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "eden_artifact_entry_default",
      ),
  );
  if (
    markerRanges.size !== 1 ||
    entryStatements.length !== 1 ||
    defaultStatements.length !== 1
  ) {
    return undefined;
  }
  const marker = [...markerRanges.values()][0] as {
    start: number;
    end: number;
  };
  const entryStatement = entryStatements[0] as ts.Statement;
  const defaultStatement = defaultStatements[0] as ts.Statement;
  const betweenMarkerAndEntry = bundle.slice(
    marker.end,
    entryStatement.getStart(sourceFile),
  );
  if (
    !/^\r?\n(?:[ \t]*\r?\n)?$/u.test(betweenMarkerAndEntry) ||
    entryStatement.getStart(sourceFile) <= marker.start ||
    defaultStatement.getStart(sourceFile) <= entryStatement.getStart(sourceFile)
  ) {
    return undefined;
  }
  return {
    markerStart: marker.start,
    markerEnd: marker.end,
    entryStart: entryStatement.getStart(sourceFile),
    defaultStart: defaultStatement.getStart(sourceFile),
  };
}

function generatedArtifactEntryStart(bundle: string): number {
  return generatedArtifactEntryBoundary(bundle)?.markerStart ?? -1;
}

function attachGeneratedDependencyProvenance(
  bundle: string,
  verifiedDependency: boolean,
): string {
  if (!verifiedDependency) return bundle;
  const entryStart = generatedArtifactEntryStart(bundle);
  if (entryStart < 0) return bundle;
  const namespaceNames = generatedDependencyNamespaceNames(
    bundle,
    TRUSTED_ZOD_PACKAGE.root,
  );
  if (namespaceNames.length === 0) return bundle;
  const generatedDependencyDigest = generatedDependencyContentDigest(
    bundle,
    TRUSTED_ZOD_PACKAGE.root,
  );
  const provenance = `var edenVerifiedDependencyProvenance = {
  packageName: ${JSON.stringify(TRUSTED_ZOD_PACKAGE.name)},
  packageVersion: ${JSON.stringify(TRUSTED_ZOD_PACKAGE.version)},
  packageRoot: ${JSON.stringify(TRUSTED_ZOD_PACKAGE.root)},
  integrity: ${JSON.stringify(TRUSTED_ZOD_PACKAGE.integrity)},
  namespaceNames: ${JSON.stringify(namespaceNames)},
  generatedDependencyDigest: ${JSON.stringify(generatedDependencyDigest)},
  namespaceDigest: ${JSON.stringify(
    generatedDependencyNamespaceDigest(
      namespaceNames,
      generatedDependencyDigest,
    ),
  )}
};

`;
  return `${bundle.slice(0, entryStart)}${provenance}${bundle.slice(entryStart)}`;
}

function isTrustedWorkerDependency(
  files: readonly SnapshotFile[],
  relativePath: string,
): boolean {
  const packageRoot = dependencyPackageRoot(relativePath);
  if (packageRoot !== TRUSTED_ZOD_PACKAGE.root) return false;
  const packageJson = files.find(
    (file) => file.relativePath === `${packageRoot}/package.json`,
  );
  if (packageJson === undefined) return false;
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(packageJson.contents),
    ) as unknown;
  } catch {
    return false;
  }
  if (
    !isRecord(metadata) ||
    metadata.name !== TRUSTED_ZOD_PACKAGE.name ||
    metadata.version !== TRUSTED_ZOD_PACKAGE.version
  ) {
    return false;
  }
  return (
    dependencyClosureIntegrity(files, packageRoot) ===
    TRUSTED_ZOD_PACKAGE.integrity
  );
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
  trustedDependencyContext: {
    readonly sourceRoot: string;
    readonly files: readonly SnapshotFile[];
    readonly resolveModule: (
      moduleSpecifier: ts.StringLiteralLike,
      sourceFile: ts.SourceFile,
    ) => ts.ResolvedModuleFull | undefined;
  },
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
    | { readonly kind: "global"; readonly name: string }
    | {
        readonly kind: "property";
        readonly root: "globalThis" | "self";
        readonly name: string;
      }
    | {
        readonly kind: "dynamic-property";
        readonly root: "globalThis" | "self";
      }
    | { readonly kind: "dynamic-code"; readonly name: "eval" | "Function" }
    | { readonly kind: "reflect" }
    | { readonly kind: "reflect-get" }
    | {
        readonly kind: "callable";
        readonly returns: readonly AmbientValue[];
      }
    | {
        /**
         * An any/unknown call result whose concrete shape is unresolved.
         * Preserve this capability through aliases and branch expressions so
         * later callable use fails closed instead of disappearing as unknown.
         */
        readonly kind: "call-result";
      }
    | { readonly kind: "unknown-callable" };

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
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current)
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

  function isConstructorIndirection(expression: ts.Expression): boolean {
    const current = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(current)) {
      return current.name.text === "constructor";
    }
    if (ts.isElementAccessExpression(current)) {
      const name =
        current.argumentExpression === undefined
          ? undefined
          : constantStringExpression(current.argumentExpression);
      return name === "constructor";
    }
    return false;
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

  function directSupportedGlobalName(
    expression: ts.Expression,
  ): string | undefined {
    const current = unwrapExpression(expression);
    if (
      !ts.isIdentifier(current) ||
      hasAuthoredBinding(current) ||
      !SUPPORTED_WORKER_GLOBALS.has(current.text)
    ) {
      return undefined;
    }
    return current.text;
  }

  function resolveSupportedGlobalName(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): string | undefined {
    const current = unwrapExpression(expression);
    const direct = directSupportedGlobalName(current);
    if (direct !== undefined) return direct;
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (symbol === undefined) return undefined;
      const known = ambientValues.get(symbol);
      if (known?.kind === "reflect") return "Reflect";
      if (known?.kind === "reflect-get") return "Reflect.get";
      if (seenSymbols.has(symbol)) return undefined;
      seenSymbols.add(symbol);
      const symbols = [symbol];
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== symbol) symbols.push(aliased);
      }
      for (const candidate of symbols) {
        const knownCandidate = ambientValues.get(candidate);
        if (knownCandidate?.kind === "reflect") return "Reflect";
        if (knownCandidate?.kind === "reflect-get") return "Reflect.get";
        for (const declaration of candidate.declarations ?? []) {
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined
          ) {
            const resolved = resolveSupportedGlobalName(
              declaration.initializer,
              seenSymbols,
            );
            if (resolved !== undefined) return resolved;
          }
        }
      }
      return undefined;
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      const base = resolveSupportedGlobalName(
        current.expression,
        new Set(seenSymbols),
      );
      const propertyName = ts.isPropertyAccessExpression(current)
        ? current.name.text
        : propertyNameExpression(current.argumentExpression);
      if (
        (base === "globalThis" || base === "self") &&
        propertyName === "Reflect"
      ) {
        return "Reflect";
      }
      if (base === "Reflect" && propertyName === "get") {
        return "Reflect.get";
      }
      if (base !== undefined && propertyName !== undefined) {
        return `${base}.${propertyName}`;
      }
    }
    return undefined;
  }

  function isReflectIdentityExpression(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (resolveSupportedGlobalName(current) === "Reflect") return true;
    if (
      (ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)) &&
      propertyNameExpression(
        ts.isPropertyAccessExpression(current)
          ? current.name
          : current.argumentExpression,
      ) === "Reflect"
    ) {
      return ambientRootName(current.expression) !== undefined;
    }
    if (!ts.isIdentifier(current)) return false;
    if (current.text === "Reflect" && !hasAuthoredBinding(current)) {
      return true;
    }
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    const symbols = [symbol];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== symbol) symbols.push(aliased);
    }
    for (const candidate of symbols) {
      if (ambientValues.get(candidate)?.kind === "reflect") return true;
      for (const declaration of candidate.declarations ?? []) {
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          isReflectIdentityExpression(
            declaration.initializer,
            new Set(seenSymbols),
          )
        ) {
          return true;
        }
        if (ts.isBindingElement(declaration)) {
          const bindingPattern = declaration.parent;
          const variableDeclaration = bindingPattern.parent;
          if (
            ts.isObjectBindingPattern(bindingPattern) &&
            bindingPropertyName(declaration) === "Reflect" &&
            ts.isVariableDeclaration(variableDeclaration) &&
            variableDeclaration.initializer !== undefined &&
            ambientRootName(variableDeclaration.initializer) !== undefined
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function isReflectGetAliasExpression(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (
      (ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)) &&
      propertyNameExpression(
        ts.isPropertyAccessExpression(current)
          ? current.name
          : current.argumentExpression,
      ) === "get"
    ) {
      return isReflectIdentityExpression(current.expression);
    }
    if (!ts.isIdentifier(current)) return false;
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    const symbols = [symbol];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== symbol) symbols.push(aliased);
    }
    for (const candidate of symbols) {
      const known = ambientValues.get(candidate);
      if (known?.kind === "reflect-get") return true;
      for (const declaration of candidate.declarations ?? []) {
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          isReflectGetAliasExpression(
            declaration.initializer,
            new Set(seenSymbols),
          )
        ) {
          return true;
        }
        if (ts.isBindingElement(declaration)) {
          const bindingPattern = declaration.parent;
          const variableDeclaration = bindingPattern.parent;
          if (
            ts.isObjectBindingPattern(bindingPattern) &&
            bindingPropertyName(declaration) === "get" &&
            ts.isVariableDeclaration(variableDeclaration) &&
            variableDeclaration.initializer !== undefined &&
            isReflectIdentityExpression(variableDeclaration.initializer)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  function isReflectGetExpression(expression: ts.Expression): boolean {
    const current = unwrapExpression(expression);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    const propertyName = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : propertyNameExpression(current.argumentExpression);
    return (
      propertyName === "get" &&
      isReflectIdentityExpression(current.expression)
    );
  }

  function isPotentialConstructorBase(expression: ts.Expression): boolean {
    const globalName = resolveSupportedGlobalName(expression);
    if (globalName !== undefined) {
      return (
        globalName !== "globalThis" &&
        globalName !== "self" &&
        globalName !== "Reflect" &&
        globalName !== "Reflect.get"
      );
    }
    const value = resolveAmbientValue(expression);
    return (
      value?.kind === "global" ||
      value?.kind === "property" ||
      value?.kind === "dynamic-property" ||
      value?.kind === "dynamic-code"
    );
  }

  function propertyNameExpression(
    expression: ts.Expression | undefined,
  ): string | undefined {
    return expression === undefined
      ? undefined
      : constantStringExpression(expression);
  }

  function objectPropertyName(
    property: ts.ObjectLiteralElementLike,
  ): string | undefined {
    const name = property.name;
    if (name === undefined) return undefined;
    return ts.isComputedPropertyName(name)
      ? constantStringExpression(name.expression)
      : ts.isStringLiteralLike(name) || ts.isIdentifier(name)
        ? name.text
        : undefined;
  }

  function objectPropertyDeclarations(
    expression: ts.Expression,
    propertyName: string | undefined,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): ts.Declaration[] {
    const current = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(current)) {
      return current.properties.filter((property) => {
        if (
          !ts.isMethodDeclaration(property) &&
          !ts.isGetAccessorDeclaration(property) &&
          !ts.isSetAccessorDeclaration(property) &&
          !ts.isPropertyAssignment(property)
        ) {
          return false;
        }
        return (
          propertyName === undefined ||
          objectPropertyName(property) === propertyName
        );
      });
    }
    if (!ts.isIdentifier(current)) return [];
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seenSymbols.has(symbol)) return [];
    seenSymbols.add(symbol);
    const declarations = [symbol];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== symbol) declarations.push(aliased);
    }
    const results: ts.Declaration[] = [];
    for (const candidate of declarations) {
      for (const declaration of candidate.declarations ?? []) {
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined
        ) {
          results.push(
            ...objectPropertyDeclarations(
              declaration.initializer,
              propertyName,
              new Set(seenSymbols),
            ),
          );
        }
      }
    }
    return results;
  }

  function callableDeclarations(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol>,
  ): ts.Declaration[] {
    const current = unwrapExpression(expression);
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return [current];
    }

    const declarations: ts.Declaration[] = [];
    const addSymbolDeclarations = (symbol: ts.Symbol | undefined): void => {
      if (symbol === undefined || seenSymbols.has(symbol)) return;
      seenSymbols.add(symbol);
      const symbols = [symbol];
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== symbol) symbols.push(aliased);
      }
      for (const candidate of symbols) {
        declarations.push(...(candidate.declarations ?? []));
      }
    };

    if (ts.isIdentifier(current)) {
      addSymbolDeclarations(checker.getSymbolAtLocation(current));
      return declarations;
    }

    if (ts.isPropertyAccessExpression(current)) {
      addSymbolDeclarations(checker.getSymbolAtLocation(current.name));
      if (declarations.length === 0) {
        addSymbolDeclarations(
          checker.getPropertyOfType(
            checker.getTypeAtLocation(current.expression),
            current.name.text,
          ),
        );
      }
      if (declarations.length > 0) return declarations;
      const propertyName = current.name.text;
      declarations.push(
        ...objectPropertyDeclarations(current.expression, propertyName),
      );
      return declarations;
    }

    if (ts.isElementAccessExpression(current)) {
      const propertyName = propertyNameExpression(current.argumentExpression);
      if (propertyName !== undefined) {
        addSymbolDeclarations(
          checker.getPropertyOfType(
            checker.getTypeAtLocation(current.expression),
            propertyName,
          ),
        );
      }
      if (declarations.length > 0) return declarations;
      if (declarations.length === 0) {
        declarations.push(
          ...objectPropertyDeclarations(current.expression, propertyName),
        );
      }
      if (declarations.length === 0 && propertyName === undefined) {
        declarations.push(
          ...objectPropertyDeclarations(current.expression, undefined),
        );
      }
      return declarations;
    }

    return declarations;
  }

  function callableBodies(
    declaration: ts.Declaration,
    seenSymbols: Set<ts.Symbol>,
    seenDeclarations: Set<ts.Declaration>,
  ): AmbientValue[] {
    if (seenDeclarations.has(declaration)) return [];
    seenDeclarations.add(declaration);
    const returns: AmbientValue[] = [];

    const collectBodyReturns = (body: ts.ConciseBody | undefined): void => {
      if (body === undefined) return;
      if (!ts.isBlock(body)) {
        const value = resolveAmbientValue(body, new Set(seenSymbols));
        if (value !== undefined) returns.push(value);
        return;
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
    };

    if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
      collectBodyReturns(declaration.body);
    } else if (ts.isVariableDeclaration(declaration)) {
      const initializer = declaration.initializer;
      if (initializer !== undefined) {
        returns.push(
          ...resolveCallableReturns(
            initializer,
            new Set(seenSymbols),
            seenDeclarations,
          ),
        );
      }
    } else if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isGetAccessorDeclaration(declaration) ||
      ts.isSetAccessorDeclaration(declaration)
    ) {
      collectBodyReturns(declaration.body);
    } else if (
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration)
    ) {
      if (ts.isPropertyDeclaration(declaration)) {
        if (declaration.initializer !== undefined) {
          returns.push(
            ...resolveCallableReturns(
              declaration.initializer,
              new Set(seenSymbols),
              seenDeclarations,
            ),
          );
        }
      } else {
        returns.push(
          ...resolveCallableReturns(
            declaration.initializer,
            new Set(seenSymbols),
            seenDeclarations,
          ),
        );
      }
    } else if (ts.isBindingElement(declaration)) {
      const bindingPattern = declaration.parent;
      const variableDeclaration = bindingPattern.parent;
      if (
        (ts.isObjectBindingPattern(bindingPattern) ||
          ts.isArrayBindingPattern(bindingPattern)) &&
        ts.isVariableDeclaration(variableDeclaration) &&
        variableDeclaration.initializer !== undefined
      ) {
        const propertyName = ts.isObjectBindingPattern(bindingPattern)
          ? bindingPropertyName(declaration)
          : undefined;
        const properties = objectPropertyDeclarations(
          variableDeclaration.initializer,
          propertyName,
        );
        for (const property of properties) {
          returns.push(
            ...callableBodies(
              property,
              new Set(seenSymbols),
              seenDeclarations,
            ),
          );
        }
        if (properties.length === 0) {
          returns.push({ kind: "unknown-callable" });
        }
      }
    }
    return returns;
  }

  function callableAmbientValue(
    declarations: readonly ts.Declaration[],
  ): AmbientValue | undefined {
    const returns: AmbientValue[] = [];
    const seenDeclarations = new Set<ts.Declaration>();
    for (const declaration of declarations) {
      returns.push(
        ...callableBodies(
          declaration,
          new Set<ts.Symbol>(),
          seenDeclarations,
        ),
      );
    }
    if (returns.length === 0) return undefined;
    return { kind: "callable", returns };
  }

  function isAnyOrUnknownType(expression: ts.Expression): boolean {
    const flags = checker.getTypeAtLocation(expression).flags;
    return (
      (flags & ts.TypeFlags.Any) !== 0 ||
      (flags & ts.TypeFlags.Unknown) !== 0
    );
  }

  function isCallResultExpression(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      return isAnyOrUnknownType(current);
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      return isCallResultExpression(current.expression, seenSymbols);
    }
    if (ts.isConditionalExpression(current)) {
      return (
        isCallResultExpression(current.whenTrue, new Set(seenSymbols)) ||
        isCallResultExpression(current.whenFalse, new Set(seenSymbols))
      );
    }
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return (
        isCallResultExpression(current.left, new Set(seenSymbols)) ||
        isCallResultExpression(current.right, new Set(seenSymbols))
      );
    }
    if (!ts.isIdentifier(current)) return false;
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    const known = ambientValues.get(symbol);
    if (
      known?.kind === "call-result" ||
      known?.kind === "unknown-callable"
    ) {
      return true;
    }
    const symbols = [symbol];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== symbol) symbols.push(aliased);
    }
    return symbols.some((candidate) => {
      if (
        (candidate.declarations ?? []).some(
          (declaration) =>
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            isCallResultExpression(
              declaration.initializer,
              new Set(seenSymbols),
            ),
        )
      ) {
        return true;
      }
      return assignments.some((assignment) => {
        if (!ts.isIdentifier(assignment.left)) return false;
        const leftSymbol = checker.getSymbolAtLocation(assignment.left);
        return (
          leftSymbol === candidate &&
          isCallResultExpression(assignment.right, new Set(seenSymbols))
        );
      });
    });
  }

  function isAuthoredCallableExpression(
    expression: ts.Expression,
  ): boolean {
    const declarations = callableDeclarations(
      expression,
      new Set<ts.Symbol>(),
    );
    return declarations.some(
      (declaration) =>
        ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration) ||
        ts.isMethodDeclaration(declaration) ||
        ts.isGetAccessorDeclaration(declaration) ||
        ts.isSetAccessorDeclaration(declaration),
    );
  }

  const SAFE_INPUT_METHODS = new Set(["toUpperCase", "trim"]);
  const SAFE_INPUT_PROPERTIES = new Set(["length"]);

  function isParameterBackedExpression(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(current)) {
      return isParameterBackedExpression(current.expression, seenSymbols);
    }
    if (ts.isElementAccessExpression(current)) {
      return isParameterBackedExpression(current.expression, seenSymbols);
    }
    if (!ts.isIdentifier(current)) return false;
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    return (symbol.declarations ?? []).some((declaration) =>
      ts.isParameter(declaration),
    );
  }

  function isSafeInputMethodCall(expression: ts.Expression): boolean {
    const current = unwrapExpression(expression);
    if (!ts.isCallExpression(current)) return false;
    const callee = unwrapExpression(current.expression);
    if (
      !ts.isPropertyAccessExpression(callee) &&
      !ts.isElementAccessExpression(callee)
    ) {
      return false;
    }
    const propertyName = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : propertyNameExpression(callee.argumentExpression);
    if (propertyName === undefined || !SAFE_INPUT_METHODS.has(propertyName)) {
      return false;
    }
    return (
      isParameterBackedExpression(callee.expression) ||
      isSafeInputMethodCall(callee.expression)
    );
  }

  function isSafeInputMethodPropertyAccess(
    expression: ts.Expression,
  ): boolean {
    const current = unwrapExpression(expression);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    const propertyName = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : propertyNameExpression(current.argumentExpression);
    if (
      propertyName !== undefined &&
      SAFE_INPUT_PROPERTIES.has(propertyName) &&
      isSafeInputMethodCall(current.expression)
    ) {
      return true;
    }
    return (
      propertyName !== undefined &&
      SAFE_INPUT_METHODS.has(propertyName) &&
      isSafeInputMethodCall(current.expression)
    );
  }

  const TRUSTED_ZOD_ROOT_FACTORIES = new Set([
    "any",
    "array",
    "bigint",
    "boolean",
    "catch",
    "date",
    "discriminatedUnion",
    "enum",
    "file",
    "function",
    "instanceof",
    "intersection",
    "json",
    "lazy",
    "literal",
    "map",
    "nan",
    "nativeEnum",
    "never",
    "null",
    "nullable",
    "number",
    "object",
    "promise",
    "record",
    "set",
    "string",
    "symbol",
    "templateLiteral",
    "tuple",
    "undefined",
    "union",
    "unknown",
    "void",
  ]);
  const TRUSTED_ZOD_NAMESPACE_PROPERTIES = new Set([
    "coerce",
    "codec",
  ]);
  const TRUSTED_ZOD_SCHEMA_METHODS = new Set([
    "and",
    "array",
    "base64",
    "brand",
    "catch",
    "check",
    "cidr",
    "cuid",
    "cuid2",
    "datetime",
    "default",
    "describe",
    "email",
    "endsWith",
    "extend",
    "extract",
    "finite",
    "gt",
    "gte",
    "includes",
    "int",
    "length",
    "lt",
    "lte",
    "max",
    "min",
    "nonoptional",
    "nullable",
    "nullish",
    "optional",
    "or",
    "overwrite",
    "passthrough",
    "pipe",
    "prefix",
    "readonly",
    "regex",
    "refine",
    "refinement",
    "safe",
    "startsWith",
    "strict",
    "superRefine",
    "transform",
    "trim",
    "toLowerCase",
    "toUpperCase",
    "unwrap",
    "url",
    "uuid",
  ]);
  function zodPropertyName(
    expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): string | undefined {
    return ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : propertyNameExpression(expression.argumentExpression);
  }

  function isTrustedZodNamespaceExpression(
    expression: ts.Expression,
    seenExpressions: Set<ts.Expression> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (seenExpressions.has(current)) return false;
    seenExpressions.add(current);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    const propertyName = zodPropertyName(current);
    if (propertyName === undefined) return false;
    const receiver = current.expression;
    if (
      ts.isIdentifier(unwrapExpression(receiver)) &&
      isTrustedZodImportIdentifier(receiver)
    ) {
      return TRUSTED_ZOD_NAMESPACE_PROPERTIES.has(propertyName);
    }
    return (
      TRUSTED_ZOD_NAMESPACE_PROPERTIES.has(propertyName) &&
      isTrustedZodNamespaceExpression(receiver, seenExpressions)
    );
  }

  function isTrustedZodSchemaCallee(
    expression: ts.Expression,
    seenExpressions: Set<ts.Expression> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (seenExpressions.has(current)) return false;
    seenExpressions.add(current);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    const propertyName = zodPropertyName(current);
    if (propertyName === undefined) return false;
    const receiver = current.expression;
    const receiverExpression = unwrapExpression(receiver);
    if (
      ts.isIdentifier(receiverExpression) &&
      isTrustedZodImportIdentifier(receiverExpression)
    ) {
      return TRUSTED_ZOD_ROOT_FACTORIES.has(propertyName);
    }
    if (
      TRUSTED_ZOD_ROOT_FACTORIES.has(propertyName) &&
      isTrustedZodNamespaceExpression(receiverExpression)
    ) {
      return true;
    }
    return (
      TRUSTED_ZOD_SCHEMA_METHODS.has(propertyName) &&
      isTrustedZodExpression(receiver)
    );
  }

  function isTrustedZodCall(expression: ts.Expression): boolean {
    const current = unwrapExpression(expression);
    return (
      ts.isCallExpression(current) &&
      isTrustedZodSchemaCallee(current.expression)
    );
  }

  function isTrustedZodImportIdentifier(
    expression: ts.Expression,
  ): boolean {
    const current = unwrapExpression(expression);
    if (!ts.isIdentifier(current)) return false;
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined) return false;
    const symbols = [symbol];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== symbol) symbols.push(aliased);
    }
    return symbols.some((candidate) =>
      (candidate.declarations ?? []).some((declaration) => {
        if (
          !ts.isImportSpecifier(declaration) &&
          !ts.isNamespaceImport(declaration) &&
          !ts.isImportClause(declaration)
        ) {
          return false;
        }
        const importDeclaration = ts.isImportSpecifier(declaration)
          ? declaration.parent.parent.parent
          : ts.isNamespaceImport(declaration)
            ? declaration.parent.parent
            : declaration.parent;
        if (
          !ts.isImportDeclaration(importDeclaration) ||
          !ts.isStringLiteralLike(importDeclaration.moduleSpecifier) ||
          importDeclaration.moduleSpecifier.text !== "zod"
        ) {
          return false;
        }
        const resolved = trustedDependencyContext.resolveModule(
          importDeclaration.moduleSpecifier,
          importDeclaration.getSourceFile(),
        );
        return (
          resolved?.packageId?.name === TRUSTED_ZOD_PACKAGE.name &&
          resolved.packageId.version === TRUSTED_ZOD_PACKAGE.version &&
          isTrustedWorkerDependency(
            trustedDependencyContext.files,
            toPosixPath(
              relative(
                normalize(trustedDependencyContext.sourceRoot),
                normalize(resolved.resolvedFileName),
              ),
            ),
          )
        );
      }),
    );
  }

  function isZodImportIdentifier(expression: ts.Expression): boolean {
    const current = unwrapExpression(expression);
    if (!ts.isIdentifier(current)) return false;
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined) return false;
    const symbols = [symbol];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== symbol) symbols.push(aliased);
    }
    return symbols.some((candidate) =>
      (candidate.declarations ?? []).some((declaration) => {
        const importDeclaration = ts.isImportSpecifier(declaration)
          ? declaration.parent.parent.parent
          : ts.isNamespaceImport(declaration)
            ? declaration.parent.parent
            : ts.isImportClause(declaration)
              ? declaration.parent
              : undefined;
        return (
          importDeclaration !== undefined &&
          ts.isImportDeclaration(importDeclaration) &&
          ts.isStringLiteralLike(importDeclaration.moduleSpecifier) &&
          importDeclaration.moduleSpecifier.text === "zod"
        );
      }),
    );
  }

  function isUnresolvedZodImportExpression(
    expression: ts.Expression,
    seenExpressions: Set<ts.Expression> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (seenExpressions.has(current)) return false;
    seenExpressions.add(current);
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (symbol === undefined) return false;
      const symbols = [symbol];
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== symbol) symbols.push(aliased);
      }
      return symbols.some((candidate) =>
        (candidate.declarations ?? []).some((declaration) => {
          const importDeclaration = ts.isImportSpecifier(declaration)
            ? declaration.parent.parent.parent
            : ts.isNamespaceImport(declaration)
              ? declaration.parent.parent
              : ts.isImportClause(declaration)
                ? declaration.parent
                : undefined;
          if (
            importDeclaration === undefined ||
            !ts.isImportDeclaration(importDeclaration) ||
            !ts.isStringLiteralLike(importDeclaration.moduleSpecifier) ||
            importDeclaration.moduleSpecifier.text !== "zod"
          ) {
            return false;
          }
          return !trustedDependencyContext.files.some(
            (file) =>
              file.relativePath === `${TRUSTED_ZOD_PACKAGE.root}/package.json`,
          );
        }),
      );
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      return isUnresolvedZodImportExpression(
        current.expression,
        seenExpressions,
      );
    }
    return false;
  }

  function isZodImportExpression(
    expression: ts.Expression,
    seenExpressions: Set<ts.Expression> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (seenExpressions.has(current)) return false;
    seenExpressions.add(current);
    if (isZodImportIdentifier(current)) return true;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      return isZodImportExpression(current.expression, seenExpressions);
    }
    return false;
  }

  function isTrustedZodExpression(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): boolean {
    const current = unwrapExpression(expression);
    if (
      isTrustedZodCall(current) ||
      isTrustedZodSchemaCallee(current)
    ) {
      return true;
    }
    if (!ts.isIdentifier(current)) return false;
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol === undefined || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    const symbols = [symbol];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      if (aliased !== symbol) symbols.push(aliased);
    }
    return symbols.some((candidate) =>
      (candidate.declarations ?? []).some(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          isTrustedZodExpression(
            declaration.initializer,
            new Set(seenSymbols),
          ),
      ),
    );
  }

  function isUnresolvedCallablePropertyAccess(
    expression: ts.Expression,
  ): boolean {
    const current = unwrapExpression(expression);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    const receiver = current.expression;
    if (isTrustedZodCall(receiver)) return false;
    if (isSafeInputMethodPropertyAccess(current)) return false;
    const unwrappedReceiver = unwrapExpression(receiver);
    if (
      ts.isCallExpression(unwrappedReceiver) &&
      isUnresolvedZodImportExpression(unwrappedReceiver.expression)
    ) {
      return false;
    }
    const receiverValue = resolveAmbientValue(receiver);
    if (
      receiverValue?.kind === "call-result" ||
      receiverValue?.kind === "unknown-callable"
    ) {
      return true;
    }
    if (!isCallResultExpression(receiver)) return false;
    return isAnyOrUnknownType(receiver);
  }

  function ambientObjectPropertyValue(
    source: ts.Expression,
    propertyName: string | undefined,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): AmbientValue | undefined {
    const current = unwrapExpression(source);
    if (ts.isObjectLiteralExpression(current)) {
      const properties = current.properties.filter(
        (property) =>
          propertyName === undefined ||
          objectPropertyName(property) === propertyName,
      );
      for (const property of properties) {
        if (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        ) {
          return callableAmbientValue([property]);
        }
        if (ts.isPropertyAssignment(property)) {
          return (
            resolveAmbientValue(property.initializer, new Set(seenSymbols)) ??
            callableAmbientValue([property])
          );
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return resolveAmbientValue(property.name, new Set(seenSymbols));
        }
        if (ts.isSpreadAssignment(property)) {
          const spread = ambientObjectPropertyValue(
            property.expression,
            propertyName,
            new Set(seenSymbols),
          );
          if (spread !== undefined) return spread;
        }
      }
      return undefined;
    }
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (symbol === undefined || seenSymbols.has(symbol)) return undefined;
      seenSymbols.add(symbol);
      const symbols = [symbol];
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased !== symbol) symbols.push(aliased);
      }
      for (const candidate of symbols) {
        for (const declaration of candidate.declarations ?? []) {
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined
          ) {
            const value = ambientObjectPropertyValue(
              declaration.initializer,
              propertyName,
              new Set(seenSymbols),
            );
            if (value !== undefined) return value;
          }
        }
      }
      for (const assignment of assignments) {
        if (!ts.isIdentifier(assignment.left)) continue;
        const leftSymbol = checker.getSymbolAtLocation(assignment.left);
        if (leftSymbol !== symbol) continue;
        const value = resolveAmbientValue(
          assignment.right,
          new Set(seenSymbols),
        );
        if (value !== undefined) return value;
      }
    }
    const value = resolveAmbientValue(current, new Set(seenSymbols));
    return value === undefined
      ? undefined
      : ambientPropertyValue(value, propertyName);
  }

  function assignBindingPatternFromSource(
    pattern: ts.BindingName,
    source: ts.Expression,
  ): void {
    if (ts.isIdentifier(pattern)) {
      const value = resolveAmbientValue(source);
      if (value !== undefined) {
        const symbol = checker.getSymbolAtLocation(pattern);
        if (symbol !== undefined) addAmbientValue(symbol, value);
      }
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        const propertyName = bindingPropertyName(element);
        const value = ambientObjectPropertyValue(source, propertyName);
        if (value !== undefined) {
          assignBindingPattern(element.name, value);
        }
      }
      return;
    }
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const value = ambientObjectPropertyValue(source, undefined);
      if (value !== undefined) {
        assignBindingPattern(element.name, value);
      }
    }
  }

  function resolveCallableReturns(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
    seenDeclarations: Set<ts.Declaration> = new Set(),
  ): AmbientValue[] {
    const current = unwrapExpression(expression);
    const declarations = callableDeclarations(current, seenSymbols);
    const returns: AmbientValue[] = [];
    for (const declaration of declarations) {
      returns.push(
        ...callableBodies(declaration, seenSymbols, seenDeclarations),
      );
    }
    if (
      returns.length === 0 &&
      ts.isElementAccessExpression(current) &&
      propertyNameExpression(current.argumentExpression) === undefined
    ) {
      returns.push({ kind: "unknown-callable" });
    }
    return returns;
  }

  function resolveReflectGetValue(
    target: ts.Expression | undefined,
    key: string | undefined,
    seenSymbols: Set<ts.Symbol>,
  ): AmbientValue | undefined {
    if (target === undefined) return undefined;
    if (key === "constructor") {
      return {
        kind: "dynamic-code",
        name: "Function",
      };
    }
    const root = ambientRootName(target);
    if (root !== undefined) {
      if (key === undefined) return { kind: "dynamic-property", root };
      if (key === "Reflect") return { kind: "reflect" };
      if (DYNAMIC_CODE_GLOBALS.has(key)) {
        return {
          kind: "dynamic-code",
          name: key as "eval" | "Function",
        };
      }
      return { kind: "property", root, name: key };
    }
    if (key === undefined) {
      return {
        kind: "dynamic-code",
        name: "Function",
      };
    }
    const globalName = resolveSupportedGlobalName(target);
    if (globalName !== undefined) {
      return {
        kind: "dynamic-code",
        name: "Function",
      };
    }
    return resolveAmbientValue(target, new Set(seenSymbols));
  }

  function resolveReflectGetCallResult(
    expression: ts.CallExpression,
    seenSymbols: Set<ts.Symbol>,
  ): AmbientValue | undefined {
    const result = resolveReflectGet(expression, seenSymbols);
    if (result !== undefined) return result;
    const callee = unwrapExpression(expression.expression);
    if (
      (ts.isPropertyAccessExpression(callee) ||
        ts.isElementAccessExpression(callee)) &&
      propertyNameExpression(
        ts.isPropertyAccessExpression(callee)
          ? callee.name
          : callee.argumentExpression,
      ) === "get" &&
      isReflectGetAliasExpression(callee.expression)
    ) {
      return resolveReflectGetValue(
        expression.arguments[0],
        propertyNameExpression(expression.arguments[1]),
        seenSymbols,
      );
    }
    return undefined;
  }

  function resolveReflectGet(
    expression: ts.CallExpression,
    seenSymbols: Set<ts.Symbol>,
  ): AmbientValue | undefined {
    const callee = unwrapExpression(expression.expression);
    if (
      (!ts.isPropertyAccessExpression(callee) &&
        !ts.isElementAccessExpression(callee)) ||
      propertyNameExpression(
        ts.isPropertyAccessExpression(callee)
          ? callee.name
          : callee.argumentExpression,
      ) !== "get" ||
      !isReflectIdentityExpression(callee.expression)
    ) {
      return undefined;
    }
    return resolveReflectGetValue(
      expression.arguments[0],
      propertyNameExpression(expression.arguments[1]),
      seenSymbols,
    );
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
      left.kind === "global" &&
      right.kind === "global" &&
      left.name === right.name
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
    if (left.kind === "reflect" && right.kind === "reflect") {
      return left;
    }
    if (left.kind === "reflect-get" && right.kind === "reflect-get") {
      return left;
    }
    if (
      left.kind === "callable" &&
      right.kind === "callable"
    ) {
      return {
        kind: "callable",
        returns: [...left.returns, ...right.returns],
      };
    }
    if (left.kind === "unknown-callable" || right.kind === "unknown-callable") {
      return { kind: "unknown-callable" };
    }
    if (left.kind === "call-result" || right.kind === "call-result") {
      return { kind: "call-result" };
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

  function ambientPropertyValue(
    value: AmbientValue,
    propertyName: string | undefined,
  ): AmbientValue {
    if (propertyName === "constructor") {
      return {
        kind: "dynamic-code",
        name: "Function",
      };
    }
    if (propertyName === undefined) {
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
    if (value.kind === "root") {
      if (propertyName === "Reflect") return { kind: "reflect" };
      if (DYNAMIC_CODE_GLOBALS.has(propertyName)) {
        return {
          kind: "dynamic-code",
          name: propertyName as "eval" | "Function",
        };
      }
      return {
        kind: "property",
        root: value.root,
        name: propertyName,
      };
    }
    if (value.kind === "reflect" && propertyName === "get") {
      return { kind: "reflect-get" };
    }
    if (
      value.kind === "global" &&
      value.name === "Reflect" &&
      propertyName === "get"
    ) {
      return { kind: "reflect-get" };
    }
    if (
      value.kind === "property" &&
      value.root === "globalThis" &&
      value.name === "Reflect" &&
      propertyName === "get"
    ) {
      return { kind: "reflect-get" };
    }
    if (value.kind === "property") {
      return {
        kind: "property",
        root: value.root,
        name: `${value.name}.${propertyName}`,
      };
    }
    if (value.kind === "call-result") {
      return { kind: "unknown-callable" };
    }
    if (value.kind === "global") {
      return {
        kind: "global",
        name: `${value.name}.${propertyName}`,
      };
    }
    if (value.kind === "dynamic-code") return value;
    return {
      kind: "dynamic-property",
      root:
        value.kind === "dynamic-property" ? value.root : "globalThis",
    };
  }

  function resolveAmbientValue(
    expression: ts.Expression,
    seenSymbols: Set<ts.Symbol> = new Set(),
  ): AmbientValue | undefined {
    const current = unwrapExpression(expression);
    if (isConstructorIndirection(current)) {
      return { kind: "dynamic-code", name: "Function" };
    }
    if (ts.isIdentifier(current) && current.text === "Function") {
      return { kind: "dynamic-code", name: "Function" };
    }
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
      const globalName = directSupportedGlobalName(current);
      if (globalName !== undefined) {
        return { kind: "global", name: globalName };
      }
      const symbol = checker.getSymbolAtLocation(current);
      if (symbol === undefined) return undefined;
      if (seenSymbols.has(symbol)) return undefined;
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
          if (ts.isBindingElement(declaration)) {
            const bindingPattern = declaration.parent;
            const variableDeclaration = bindingPattern.parent;
            if (
              ts.isVariableDeclaration(variableDeclaration) &&
              variableDeclaration.initializer !== undefined &&
              ts.isObjectBindingPattern(bindingPattern)
            ) {
              const value = ambientObjectPropertyValue(
                variableDeclaration.initializer,
                bindingPropertyName(declaration),
              );
              if (value !== undefined) return value;
            }
          }
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
        const callable = callableAmbientValue(candidate.declarations ?? []);
        if (callable !== undefined) return callable;
      }
      for (const assignment of assignments) {
        if (!ts.isIdentifier(assignment.left)) continue;
        const leftSymbol = checker.getSymbolAtLocation(assignment.left);
        if (leftSymbol !== symbol) continue;
        const value = resolveAmbientValue(
          assignment.right,
          new Set(seenSymbols),
        );
        if (value !== undefined) return value;
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (isUnresolvedZodImportExpression(current)) {
        return undefined;
      }
      if (
        isTrustedZodExpression(current.expression) &&
        TRUSTED_ZOD_SCHEMA_METHODS.has(current.name.text)
      ) {
        return undefined;
      }
      const base = resolveAmbientValue(current.expression, seenSymbols);
      if (base?.kind === "root") {
        if (DYNAMIC_CODE_GLOBALS.has(current.name.text)) {
          return {
            kind: "dynamic-code",
            name: current.name.text as "eval" | "Function",
          };
        }
        if (current.name.text === "Reflect") {
          return { kind: "reflect" };
        }
        return {
          kind: "property",
          root: base.root,
          name: current.name.text,
        };
      }
      if (base?.kind === "reflect") {
        if (current.name.text === "get") {
          return { kind: "reflect-get" };
        }
        return {
          kind: "property",
          root: "globalThis",
          name: `Reflect.${current.name.text}`,
        };
      }
      if (base?.kind === "reflect-get") {
        return {
          kind: "property",
          root: "globalThis",
          name: `Reflect.get.${current.name.text}`,
        };
      }
      if (base?.kind === "unknown-callable") return base;
      if (base?.kind === "call-result") {
        return { kind: "unknown-callable" };
      }
      if (base?.kind === "callable") {
        return base.returns.reduce<AmbientValue | undefined>(
          (resolved, value) => mergeAmbientValues(resolved, value),
          undefined,
        ) ?? { kind: "unknown-callable" };
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
      if (base?.kind === "global") {
        const name = `${base.name}.${current.name.text}`;
        if (name === "Reflect.get") {
          return { kind: "reflect-get" };
        }
        return { kind: "global", name };
      }
      if (isReflectGetExpression(current)) {
        return { kind: "reflect-get" };
      }
      if (isUnresolvedCallablePropertyAccess(current)) {
        return { kind: "unknown-callable" };
      }
      return undefined;
    }
    if (ts.isElementAccessExpression(current)) {
      if (isUnresolvedZodImportExpression(current)) {
        return undefined;
      }
      if (
        isTrustedZodExpression(current.expression) &&
        TRUSTED_ZOD_SCHEMA_METHODS.has(
          propertyNameExpression(current.argumentExpression) ?? "",
        )
      ) {
        return undefined;
      }
      if (isZodImportExpression(current.expression)) {
        return { kind: "unknown-callable" };
      }
      const elementName = propertyNameExpression(current.argumentExpression);
      if (
        elementName !== undefined &&
        ts.isIdentifier(unwrapExpression(current.expression)) &&
        ambientRootName(current.expression) !== undefined &&
        SUPPORTED_WORKER_GLOBALS.has(elementName)
      ) {
        return {
          kind: "global",
          name: elementName,
        };
      }
      if (isReflectGetExpression(current)) {
        return { kind: "reflect-get" };
      }
      if (isPotentialConstructorBase(current.expression)) {
        return {
          kind: "dynamic-code",
          name: "Function",
        };
      }
      const base = resolveAmbientValue(current.expression, seenSymbols);
      if (base?.kind === "dynamic-code") return base;
      if (base?.kind === "reflect") {
        const name =
          current.argumentExpression === undefined
            ? undefined
            : constantStringExpression(current.argumentExpression);
        if (name === "get") return { kind: "reflect-get" };
        return {
          kind: "property",
          root: "globalThis",
          name: name === undefined ? "Reflect" : `Reflect.${name}`,
        };
      }
      if (base?.kind === "reflect-get") {
        const name =
          current.argumentExpression === undefined
            ? undefined
            : constantStringExpression(current.argumentExpression);
        return {
          kind: "property",
          root: "globalThis",
          name:
            name === undefined ? "Reflect.get" : `Reflect.get.${name}`,
        };
      }
      if (base?.kind === "unknown-callable") return base;
      if (base?.kind === "call-result") {
        return { kind: "unknown-callable" };
      }
      if (base?.kind === "callable") {
        return base.returns.reduce<AmbientValue | undefined>(
          (resolved, value) => mergeAmbientValues(resolved, value),
          undefined,
        ) ?? { kind: "unknown-callable" };
      }
      if (base?.kind === "global") {
        const name =
          current.argumentExpression === undefined
            ? undefined
            : constantStringExpression(current.argumentExpression);
        if (name === "constructor") {
          return {
            kind: "dynamic-code",
            name: "Function",
          };
        }
        if (base.name === "Reflect" && name === "get") {
          return { kind: "reflect-get" };
        }
        return name === undefined
          ? {
              kind: "dynamic-property",
              root: "globalThis",
            }
          : {
              kind: "global",
              name: `${base.name}.${name}`,
            };
      }
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
      if (name === "Reflect") return { kind: "reflect" };
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
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const returns = resolveCallableReturns(
        current,
        new Set(seenSymbols),
      );
      if (returns.length === 0) return undefined;
      return { kind: "callable", returns };
    }
    if (ts.isCallExpression(current)) {
      if (isSafeInputMethodCall(current)) return undefined;
      if (isTrustedZodCall(current)) return undefined;
      if (isZodImportExpression(current.expression)) {
        if (isUnresolvedZodImportExpression(current.expression)) {
          return { kind: "unknown-callable" };
        }
        return { kind: "unknown-callable" };
      }
      const reflective = resolveReflectGetCallResult(current, seenSymbols);
      if (reflective !== undefined) return reflective;
      if (isReflectGetAliasExpression(current.expression)) {
        const reflectiveAlias = resolveReflectGetValue(
          current.arguments[0],
          propertyNameExpression(current.arguments[1]),
          seenSymbols,
        );
        if (reflectiveAlias !== undefined) return reflectiveAlias;
        return { kind: "unknown-callable" };
      }
      const callee = resolveAmbientValue(
        current.expression,
        new Set(seenSymbols),
      );
      if (callee?.kind === "dynamic-code") return callee;
      if (callee?.kind === "dynamic-property") return callee;
      if (callee?.kind === "unknown-callable") return callee;
      if (callee?.kind === "call-result") {
        return { kind: "unknown-callable" };
      }
      if (callee?.kind === "callable") {
        return callee.returns.reduce<AmbientValue | undefined>(
          (resolved, value) => mergeAmbientValues(resolved, value),
          undefined,
        ) ?? { kind: "unknown-callable" };
      }
      if (callee?.kind === "reflect-get") {
        const reflective = resolveReflectGetValue(
          current.arguments[0],
          propertyNameExpression(current.arguments[1]),
          seenSymbols,
        );
        if (reflective !== undefined) return reflective;
        return { kind: "unknown-callable" };
      }
      if (callee?.kind === "global" && callee.name === "Reflect.get") {
        const reflective = resolveReflectGetValue(
          current.arguments[0],
          propertyNameExpression(current.arguments[1]),
          seenSymbols,
        );
        if (reflective !== undefined) return reflective;
      }
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
      const returns = resolveCallableReturns(
        current.expression,
        new Set(seenSymbols),
      );
      if (
        returns.length === 0 &&
        ts.isElementAccessExpression(current.expression) &&
        propertyNameExpression(current.expression.argumentExpression) ===
          undefined
      ) {
        return { kind: "unknown-callable" };
      }
      if (returns.length === 0) {
        if (isCallResultExpression(current.expression)) {
          return { kind: "unknown-callable" };
        }
        return (
          isAnyOrUnknownType(current) &&
          isAuthoredCallableExpression(current.expression)
        )
          ? { kind: "call-result" }
          : undefined;
      }
      return returns.slice(1).reduce(
        (currentValue, value) => mergeAmbientValues(currentValue, value),
        returns[0] as AmbientValue,
      );
    }
    if (ts.isNewExpression(current)) {
      const callee = resolveAmbientValue(current.expression, seenSymbols);
      if (callee?.kind === "dynamic-code") return callee;
      if (callee?.kind === "dynamic-property") return callee;
      if (callee?.kind === "unknown-callable") return callee;
      if (callee?.kind === "call-result") {
        return { kind: "unknown-callable" };
      }
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
        const elementValue = ambientPropertyValue(value, propertyName);
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
            const propertyValue = ambientPropertyValue(value, name);
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
        const propertyValue = ambientPropertyValue(value, name);
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

  function assignExpressionPatternFromSource(
    pattern: ts.Expression,
    source: ts.Expression,
  ): void {
    const current = unwrapExpression(pattern);
    if (ts.isIdentifier(current)) {
      const value = resolveAmbientValue(source);
      if (value !== undefined) {
        const symbol = checker.getSymbolAtLocation(current);
        if (symbol !== undefined) addAmbientValue(symbol, value);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        const propertyName = objectPropertyName(property);
        if (propertyName === undefined) continue;
        const target =
          ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isPropertyAssignment(property)
              ? property.initializer
              : undefined;
        if (target === undefined) continue;
        const value = ambientObjectPropertyValue(source, propertyName);
        if (value !== undefined) {
          assignExpressionPattern(target, value);
        }
      }
    }
  }

  for (let iteration = 0; iteration < variableDeclarations.length + assignments.length + 2; iteration += 1) {
    for (const declaration of variableDeclarations) {
      if (declaration.initializer === undefined) continue;
      assignBindingPatternFromSource(
        declaration.name,
        declaration.initializer,
      );
    }
    for (const assignment of assignments) {
      assignExpressionPatternFromSource(assignment.left, assignment.right);
    }
  }

  function reportResolvedAmbient(
    node: ts.Node,
    value: AmbientValue | undefined,
  ): void {
    if (value === undefined) return;
    // A call-result is provenance, not itself an unsafe access. Preserve it
    // for aliases and report only when a later property/call use remains
    // unresolved.
    if (value.kind === "call-result") return;
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
      value.kind === "unknown-callable" ||
      value.kind === "callable"
    ) {
      diagnostics.push(
        diagnostic(
          "MODULE_AMBIENT_BINDING",
          "Unresolved callable return paths are not allowed because they may carry an ambient binding or dynamic-code capability; return a statically analyzable value.",
          relativePath,
          location,
        ),
      );
      return;
    }
    if (
      value.kind === "property" &&
      (isSecretLikeAmbientName(value.name) ||
        FORBIDDEN_AMBIENT_GLOBALS.has(value.name) ||
        !SUPPORTED_WORKER_GLOBALS.has(value.name.split(".")[0] ?? ""))
    ) {
      diagnostics.push(
        diagnostic(
          "MODULE_AMBIENT_BINDING",
          `Property "${value.name}" is not an explicitly supported Worker global or reads a secret-like ambient binding; use explicit Eden inputs instead (line ${location.line}, column ${location.column}).`,
          relativePath,
          location,
        ),
      );
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isBindingElement(node)) {
      const propertyName = bindingPropertyName(node);
      if (propertyName === "constructor") {
        reportResolvedAmbient(node, {
          kind: "dynamic-code",
          name: "Function",
        });
      }
      const bindingPattern = node.parent;
      const variableDeclaration = bindingPattern.parent;
      if (
        ts.isObjectBindingPattern(bindingPattern) &&
        ts.isVariableDeclaration(variableDeclaration) &&
        variableDeclaration.initializer !== undefined
      ) {
        const sourceValue = resolveAmbientValue(
          variableDeclaration.initializer,
        );
        if (sourceValue !== undefined) {
          reportResolvedAmbient(
            node,
            ambientPropertyValue(sourceValue, propertyName),
          );
        }
        reportResolvedAmbient(
          node,
          ambientObjectPropertyValue(
            variableDeclaration.initializer,
            propertyName,
          ),
        );
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) ||
        ts.isStringLiteralLike(node.name) ||
        ts.isComputedPropertyName(node.name)) &&
      (ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isStringLiteralLike(node.name)
          ? node.name.text
          : constantStringExpression(node.name.expression)) === "constructor" &&
      ts.isObjectLiteralExpression(node.parent) &&
      ts.isBinaryExpression(node.parent.parent) &&
      node.parent.parent.left === node.parent &&
      node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      reportResolvedAmbient(node, {
        kind: "dynamic-code",
        name: "Function",
      });
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      reportResolvedAmbient(node, resolveAmbientValue(node));
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const calleeValue = resolveAmbientValue(node.expression);
      reportResolvedAmbient(node, calleeValue);
      if (calleeValue?.kind === "reflect-get") {
        reportResolvedAmbient(node, {
          kind: "dynamic-code",
          name: "Function",
        });
      }
      if (
        calleeValue === undefined ||
        calleeValue.kind === "reflect-get" ||
        calleeValue.kind === "call-result" ||
        calleeValue.kind === "unknown-callable" ||
        calleeValue.kind === "callable"
      ) {
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
        !isTypeDeclarationPath(file.relativePath) &&
        !isTrustedWorkerDependency(files, file.relativePath),
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
  const unresolvedBareImports = new Set<string>();
  const hasRuntimeImportBinding = (
    node: ts.ImportDeclaration | ts.ExportDeclaration,
  ): boolean => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause === undefined || clause.isTypeOnly) {
        return clause === undefined;
      }
      if (clause.namedBindings === undefined) return true;
      if (ts.isNamespaceImport(clause.namedBindings)) return true;
      return clause.namedBindings.elements.some(
        (specifier) => !specifier.isTypeOnly,
      );
    }
    if (node.isTypeOnly) return false;
    if (node.exportClause === undefined) return true;
    if (ts.isNamespaceExport(node.exportClause)) return true;
    return node.exportClause.elements.some(
      (specifier) => !specifier.isTypeOnly,
    );
  };
  for (const source of sourceFiles) {
    const sourceFile = program.getSourceFile(source.fileName);
    if (sourceFile === undefined) continue;
    sourceFile.forEachChild((node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        hasRuntimeImportBinding(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        !node.moduleSpecifier.text.startsWith(".") &&
        resolveSelectedProjectDependency(
          snapshot.projectRoot,
          join(snapshot.projectRoot, source.file.relativePath),
          node.moduleSpecifier.text,
        ) === undefined
      ) {
        unresolvedBareImports.add(source.file.relativePath);
      }
    });
  }

  for (const file of files) {
    if (
      !isJavaScriptSourcePath(file.relativePath) ||
      isTypeDeclarationPath(file.relativePath) ||
      isTrustedWorkerDependency(files, file.relativePath)
    ) {
      continue;
    }
    const contents = sourceByFileName.get(
      join(snapshot.sourceRoot, file.relativePath),
    )?.contents;
    if (contents === undefined) continue;
    const sourceFile = program.getSourceFile(
      join(snapshot.sourceRoot, file.relativePath),
    );
    if (sourceFile === undefined) continue;
    const semanticDiagnostics = semanticWorkerBindingDiagnostics(
      sourceFile,
      file.relativePath,
      checker,
      {
        sourceRoot: snapshot.sourceRoot,
        files,
        resolveModule: (moduleSpecifier, containingFile) =>
          ts.resolveModuleName(
            moduleSpecifier.text,
            containingFile.fileName,
            compilerOptions,
            host,
          ).resolvedModule,
      },
    );
    diagnostics.push(...semanticDiagnostics);
    if (unresolvedBareImports.has(file.relativePath)) {
      diagnostics.push(
        diagnostic(
          "MODULE_LOAD_FAILED",
          `Unable to resolve one or more imports in "${file.relativePath}" from the selected project.`,
          file.relativePath,
        ),
      );
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
  verifiedZodDependency: boolean,
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
    return attachGeneratedDependencyProvenance(output, verifiedZodDependency);
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

type BundleShape =
  | { readonly kind: "unknown" }
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "function" }
  | { readonly kind: "class" }
  | {
      readonly kind: "record";
      readonly properties: ReadonlyMap<string, BundleShape>;
    }
  | { readonly kind: "array"; readonly elements: readonly BundleShape[] }
  | { readonly kind: "schema-call" };

interface BundleShapeEnvironment {
  readonly bindings: ReadonlyMap<
    string,
    ts.Expression | "function" | "class"
  >;
  readonly trustedSchemaFactoryBindings: ReadonlySet<ts.VariableDeclaration>;
  readonly bindingDeclarations: ReadonlyMap<string, ts.Declaration>;
  readonly valueDeclarationCounts: ReadonlyMap<string, number>;
  readonly trustedGeneratedDependencyNamespaces: ReadonlySet<
    ts.VariableDeclaration
  >;
  readonly trustedGeneratedExportHelpers: ReadonlySet<
    ts.VariableDeclaration
  >;
  readonly generatedEntryBoundary: GeneratedArtifactEntryBoundary | undefined;
  readonly hasVerifiedDependencyMarker: boolean;
  readonly generatedExportHelperCandidateCount: number;
  readonly generatedExportHelperDigest: string | undefined;
  readonly invalidGeneratedExportHelperUse: boolean;
  readonly invalidGeneratedMutation: boolean;
  readonly mutatedBindings: ReadonlySet<string>;
}

const STANDARD_SCHEMA_FACTORY_NAMES = new Set([
  "any",
  "array",
  "boolean",
  "catch",
  "coerce",
  "date",
  "default",
  "discriminatedUnion",
  "enum",
  "intersection",
  "lazy",
  "literal",
  "never",
  "nullable",
  "number",
  "object",
  "optional",
  "pipe",
  "preprocess",
  "record",
  "string",
  "transform",
  "tuple",
  "union",
  "unknown",
]);

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function bundlePropertyName(
  name: ts.PropertyName | ts.BindingName,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function bundleRecordShape(
  properties: ReadonlyMap<string, BundleShape>,
): BundleShape {
  return { kind: "record", properties };
}

function bundleShapeForIdentifier(
  name: string,
  environment: BundleShapeEnvironment,
  resolving: Set<string>,
): BundleShape {
  if (name === "undefined") return { kind: "undefined" };
  if (name === "null") return { kind: "null" };
  const binding = environment.bindings.get(name);
  if (binding === undefined) return { kind: "unknown" };
  if (environment.mutatedBindings.has(name)) return { kind: "unknown" };
  if (binding === "class") return { kind: "class" };
  if (binding === "function") return { kind: "function" };
  if (resolving.has(name)) return { kind: "unknown" };
  resolving.add(name);
  try {
    return bundleShapeForExpression(binding, environment, resolving);
  } finally {
    resolving.delete(name);
  }
}

function isStandardSchemaFactoryCall(
  expression: ts.CallExpression,
  environment: BundleShapeEnvironment,
): boolean {
  if (!ts.isPropertyAccessExpression(expression.expression)) return false;
  const target = expression.expression.expression;
  if (!ts.isIdentifier(target)) return false;
  const trustedNamespaceDeclaration =
    environment.bindingDeclarations.get(target.text);
  if (
    trustedNamespaceDeclaration === undefined ||
    !ts.isVariableDeclaration(trustedNamespaceDeclaration) ||
    environment.valueDeclarationCounts.get(target.text) !== 1 ||
    environment.mutatedBindings.has(target.text)
  ) {
    return false;
  }
  return (
    STANDARD_SCHEMA_FACTORY_NAMES.has(expression.expression.name.text) &&
    environment.trustedSchemaFactoryBindings.has(
      trustedNamespaceDeclaration,
    )
  );
}

function isObjectMemberCall(
  expression: ts.Expression,
  objectName: string,
  propertyName: string,
): expression is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === objectName &&
    expression.name.text === propertyName
  );
}

function bundleShapeTruthiness(
  shape: BundleShape,
): boolean | undefined {
  switch (shape.kind) {
    case "undefined":
    case "null":
      return false;
    case "string":
      return shape.value.length > 0;
    case "number":
      return Number.isNaN(shape.value) ? false : shape.value !== 0;
    case "boolean":
      return shape.value;
    case "function":
    case "class":
    case "record":
    case "array":
    case "schema-call":
      return true;
    case "unknown":
      return undefined;
  }
}

function bundleShapeForExpression(
  expression: ts.Expression,
  environment: BundleShapeEnvironment,
  resolving: Set<string> = new Set(),
): BundleShape {
  if (ts.isParenthesizedExpression(expression)) {
    return bundleShapeForExpression(expression.expression, environment, resolving);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return bundleShapeForExpression(expression.expression, environment, resolving);
  }
  if (ts.isAwaitExpression(expression)) {
    return bundleShapeForExpression(expression.expression, environment, resolving);
  }
  if (ts.isIdentifier(expression)) {
    return bundleShapeForIdentifier(expression.text, environment, resolving);
  }
  if (ts.isStringLiteralLike(expression)) {
    return { kind: "string", value: expression.text };
  }
  if (ts.isNumericLiteral(expression)) {
    return { kind: "number", value: Number(expression.text) };
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = bundleShapeForExpression(
        span.expression,
        environment,
        resolving,
      );
      if (
        substitution.kind !== "string" &&
        substitution.kind !== "number" &&
        substitution.kind !== "boolean"
      ) {
        return { kind: "unknown" };
      }
      value += String(substitution.value);
      value += span.literal.text;
    }
    return { kind: "string", value };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "boolean", value: true };
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: false };
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "null" };
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    const operand = bundleShapeForExpression(
      expression.operand,
      environment,
      resolving,
    );
    if (
      operand.kind === "number" &&
      (expression.operator === ts.SyntaxKind.MinusToken ||
        expression.operator === ts.SyntaxKind.PlusToken)
    ) {
      return {
        kind: "number",
        value:
          expression.operator === ts.SyntaxKind.MinusToken
            ? -operand.value
            : operand.value,
      };
    }
    return { kind: "unknown" };
  }
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return { kind: "function" };
  }
  if (ts.isClassExpression(expression)) {
    return { kind: "class" };
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return {
      kind: "array",
      elements: expression.elements.map((element) =>
        ts.isSpreadElement(element)
          ? { kind: "unknown" }
          : bundleShapeForExpression(element, environment, resolving),
      ),
    };
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const properties = new Map<string, BundleShape>();
    for (const property of expression.properties) {
      if (
        property.name !== undefined &&
        ts.isComputedPropertyName(property.name)
      ) {
        return { kind: "unknown" };
      }
      if (ts.isSpreadAssignment(property)) {
        const spread = bundleShapeForExpression(
          property.expression,
          environment,
          resolving,
        );
        if (spread.kind !== "record") {
          return { kind: "unknown" };
        }
        for (const [key, value] of spread.properties) {
          if (properties.has(key)) return { kind: "unknown" };
          properties.set(key, value);
        }
        continue;
      }
      if (ts.isMethodDeclaration(property)) {
        const key = bundlePropertyName(property.name);
        if (key === undefined) return { kind: "unknown" };
        if (properties.has(key)) return { kind: "unknown" };
        properties.set(
          key,
          ts.isClassDeclaration(property.parent)
            ? { kind: "class" }
            : { kind: "function" },
        );
        continue;
      }
      if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
        const key = bundlePropertyName(property.name);
        if (key === undefined) return { kind: "unknown" };
        if (properties.has(key)) return { kind: "unknown" };
        properties.set(key, { kind: "unknown" });
        continue;
      }
      if (ts.isPropertyAssignment(property)) {
        const key = bundlePropertyName(property.name);
        if (key === undefined) return { kind: "unknown" };
        if (properties.has(key)) return { kind: "unknown" };
        properties.set(
          key,
          bundleShapeForExpression(property.initializer, environment, resolving),
        );
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        if (properties.has(property.name.text)) return { kind: "unknown" };
        properties.set(
          property.name.text,
          bundleShapeForIdentifier(property.name.text, environment, resolving),
        );
      }
    }
    return bundleRecordShape(properties);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      expression.name.text === "object" &&
      ts.isIdentifier(expression.expression)
    ) {
      const targetBinding = environment.bindings.get(expression.expression.text);
      if (
        targetBinding !== undefined &&
        !(
          typeof targetBinding === "string" ||
          ts.isIdentifier(targetBinding)
        )
      ) {
        const target = bundleShapeForExpression(
          targetBinding,
          environment,
          resolving,
        );
        if (target.kind === "record") return target;
      }
    }
    const target = bundleShapeForExpression(
      expression.expression,
      environment,
      resolving,
    );
    if (target.kind !== "record") return { kind: "unknown" };
    const property = target.properties.get(expression.name.text);
    if (property !== undefined) return property;
    return { kind: "unknown" };
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument === undefined) return { kind: "unknown" };
    const key = bundleShapeForExpression(argument, environment, resolving);
    if (key.kind !== "string" && key.kind !== "number") {
      return { kind: "unknown" };
    }
    const target = bundleShapeForExpression(
      expression.expression,
      environment,
      resolving,
    );
    if (target.kind !== "record") return { kind: "unknown" };
    return target.properties.get(String(key.value)) ?? { kind: "unknown" };
  }
  if (ts.isConditionalExpression(expression)) {
    const condition = bundleShapeForExpression(
      expression.condition,
      environment,
      resolving,
    );
    const truthy = bundleShapeTruthiness(condition);
    if (truthy === undefined) return { kind: "unknown" };
    return bundleShapeForExpression(
      truthy ? expression.whenTrue : expression.whenFalse,
      environment,
      resolving,
    );
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const left = bundleShapeForExpression(
        expression.left,
        environment,
        resolving,
      );
      const truthy = bundleShapeTruthiness(left);
      if (operator === ts.SyntaxKind.QuestionQuestionToken) {
        if (left.kind === "null" || left.kind === "undefined") {
          return bundleShapeForExpression(
            expression.right,
            environment,
            resolving,
          );
        }
        if (left.kind === "unknown") return { kind: "unknown" };
        return left;
      }
      if (truthy === undefined) return { kind: "unknown" };
      if (
        (operator === ts.SyntaxKind.BarBarToken && truthy) ||
        (operator === ts.SyntaxKind.AmpersandAmpersandToken && !truthy)
      ) {
        return left;
      }
      return bundleShapeForExpression(
        expression.right,
        environment,
        resolving,
      );
    }
    const whenTrue = bundleShapeForExpression(
      expression.left,
      environment,
      resolving,
    );
    const whenFalse = bundleShapeForExpression(
      expression.right,
      environment,
      resolving,
    );
    const left = whenTrue;
    const right = whenFalse;
    const primitiveValue = (
      value: BundleShape,
    ): string | number | boolean | undefined =>
      value.kind === "string" ||
      value.kind === "number" ||
      value.kind === "boolean"
        ? value.value
        : undefined;
    const leftValue = primitiveValue(left);
    const rightValue = primitiveValue(right);
    if (
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      leftValue !== undefined &&
      rightValue !== undefined
    ) {
      if (typeof leftValue === "string" || typeof rightValue === "string") {
        return {
          kind: "string",
          value: String(leftValue) + String(rightValue),
        };
      }
      if (typeof leftValue === "number" && typeof rightValue === "number") {
        return { kind: "number", value: leftValue + rightValue };
      }
      return { kind: "unknown" };
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      if (
        left.kind === "null" ||
        left.kind === "undefined" ||
        (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
          ((left.kind === "string" && left.value.length === 0) ||
            (left.kind === "number" && left.value === 0) ||
            (left.kind === "boolean" && !left.value)))
      ) {
        return right;
      }
      return left;
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (
        left.kind === "null" ||
        left.kind === "undefined" ||
        (left.kind === "string" && left.value.length === 0) ||
        (left.kind === "number" && left.value === 0) ||
        (left.kind === "boolean" && !left.value)
      ) {
        return left;
      }
      return right;
    }
    return { kind: "unknown" };
  }
  if (ts.isCallExpression(expression)) {
    if (
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "defineProperty" &&
      ts.isIdentifier(expression.expression.expression) &&
      expression.expression.expression.text === "Object"
    ) {
      return { kind: "unknown" };
    }
    if (isObjectMemberCall(expression.expression, "Object", "freeze")) {
      const value = expression.arguments[0];
      return value === undefined
        ? { kind: "unknown" }
        : bundleShapeForExpression(value, environment, resolving);
    }
    if (
      isObjectMemberCall(expression.expression, "Object", "defineProperty")
    ) {
      return { kind: "unknown" };
    }
    if (isObjectMemberCall(expression.expression, "Object", "assign")) {
      const properties = new Map<string, BundleShape>();
      for (const argument of expression.arguments) {
        const value = bundleShapeForExpression(argument, environment, resolving);
        if (value.kind !== "record") return { kind: "unknown" };
        for (const [key, property] of value.properties) {
          properties.set(key, property);
        }
      }
      return bundleRecordShape(properties);
    }
    if (isObjectMemberCall(expression.expression, "Object", "fromEntries")) {
      const argument = expression.arguments[0];
      if (argument === undefined) return { kind: "unknown" };
      const entries = bundleShapeForExpression(argument, environment, resolving);
      if (entries.kind !== "array") return { kind: "unknown" };
      const properties = new Map<string, BundleShape>();
      for (const entry of entries.elements) {
        if (entry.kind !== "array" || entry.elements.length < 2) {
          return { kind: "unknown" };
        }
        const key = entry.elements[0];
        if (key?.kind !== "string" && key?.kind !== "number") {
          return { kind: "unknown" };
        }
        const value = entry.elements[1];
        if (value === undefined) return { kind: "unknown" };
        properties.set(String(key.value), value);
      }
      return bundleRecordShape(properties);
    }
    if (isStandardSchemaFactoryCall(expression, environment)) {
      return { kind: "schema-call" };
    }
    return { kind: "unknown" };
  }
  if (ts.isNewExpression(expression)) {
    return { kind: "unknown" };
  }
  if (ts.isFunctionLike(expression)) {
    return ts.isClassLike(expression) ? { kind: "class" } : { kind: "function" };
  }
  return { kind: "unknown" };
}

function bundleShapeEnvironment(
  sourceFile: ts.SourceFile,
): BundleShapeEnvironment {
  const bindings = new Map<string, ts.Expression | "function" | "class">();
  const bindingDeclarations = new Map<string, ts.Declaration>();
  const valueDeclarationCounts = new Map<string, number>();
  const functionDeclarations = new Map<string, ts.FunctionLikeDeclaration>();
  const bindPattern = (
    pattern: ts.BindingName,
    initializer: ts.Expression,
  ): void => {
    if (ts.isIdentifier(pattern)) {
      bindings.set(pattern.text, initializer);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken !== undefined) continue;
        const propertyName =
          element.propertyName === undefined
            ? ts.isIdentifier(element.name)
              ? element.name.text
              : undefined
            : ts.isIdentifier(element.propertyName) ||
                ts.isStringLiteralLike(element.propertyName)
              ? element.propertyName.text
              : undefined;
        if (propertyName === undefined) continue;
        bindPattern(
          element.name,
          ts.factory.createPropertyAccessExpression(initializer, propertyName),
        );
      }
      return;
    }
    for (const [index, element] of pattern.elements.entries()) {
      if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined) {
        continue;
      }
      bindPattern(
        element.name,
        ts.factory.createElementAccessExpression(
          initializer,
          ts.factory.createNumericLiteral(index),
        ),
      );
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          bindingDeclarations.set(declaration.name.text, declaration);
          valueDeclarationCounts.set(
            declaration.name.text,
            (valueDeclarationCounts.get(declaration.name.text) ?? 0) + 1,
          );
        }
        if (declaration.initializer !== undefined) {
          bindPattern(declaration.name, declaration.initializer);
          if (
            ts.isIdentifier(declaration.name) &&
            ts.isFunctionLike(declaration.initializer) &&
            !ts.isClassLike(declaration.initializer)
          ) {
            functionDeclarations.set(
              declaration.name.text,
              declaration.initializer,
            );
          }
        }
      }
    } else if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined
    ) {
      bindings.set(statement.name.text, "function");
      functionDeclarations.set(statement.name.text, statement);
    } else if (
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined
    ) {
      bindings.set(statement.name.text, "class");
    }
  }
  const trustedSchemaFactoryBindings = new Set<ts.VariableDeclaration>();
  const trustedGeneratedExportHelpers = new Set<ts.VariableDeclaration>();
  const trustedGeneratedDependencyNamespaces = new Set<
    ts.VariableDeclaration
  >();
  const generatedDependencyProvenanceBinding =
    "edenVerifiedDependencyProvenance";
  const generatedEntryBoundary = generatedArtifactEntryBoundary(
    sourceFile.text,
  );
  const entryStart = generatedEntryBoundary?.markerStart ?? -1;
  const isBeforeGeneratedEntry = (node: ts.Node): boolean =>
    entryStart < 0 || node.getStart(sourceFile) < entryStart;
  const isGeneratedEntryNode = (node: ts.Node): boolean =>
    generatedEntryBoundary !== undefined &&
    node.getStart(sourceFile) >= generatedEntryBoundary.entryStart;
  const generatedExportHelperName = "__export";
  const generatedDependencyNamespaceNamesInSource = new Set(
    generatedDependencyNamespaceCandidates(
      sourceFile.text,
      TRUSTED_ZOD_PACKAGE.root,
    ),
  );
  const provenanceDeclarations: ts.VariableDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === generatedDependencyProvenanceBinding
      ) {
        provenanceDeclarations.push(declaration);
      }
    }
  }
  let invalidGeneratedDependencyProvenance =
    provenanceDeclarations.length > 1;
  if (provenanceDeclarations.length === 1) {
    const declaration = provenanceDeclarations[0] as ts.VariableDeclaration;
    const initializer = declaration.initializer;
    const properties =
      initializer !== undefined && ts.isObjectLiteralExpression(initializer)
        ? initializer.properties
        : undefined;
    const property = (name: string): ts.Expression | undefined => {
      const match = properties?.find(
        (candidate) =>
          ts.isPropertyAssignment(candidate) &&
          !ts.isComputedPropertyName(candidate.name) &&
          bundlePropertyName(candidate.name) === name,
      );
      return match !== undefined && ts.isPropertyAssignment(match)
        ? match.initializer
        : undefined;
    };
    const stringValue = (
      expression: ts.Expression | undefined,
    ): string | undefined =>
      expression !== undefined && ts.isStringLiteralLike(expression)
        ? expression.text
        : undefined;
    const namespaceNamesExpression = property("namespaceNames");
    const namespaceNames: readonly (string | undefined)[] | undefined =
      namespaceNamesExpression !== undefined &&
      ts.isArrayLiteralExpression(namespaceNamesExpression)
        ? namespaceNamesExpression.elements.map((element) =>
            ts.isStringLiteralLike(element) ? element.text : undefined,
          )
        : undefined;
    const namespaceDigest = stringValue(property("namespaceDigest"));
    const generatedDependencyDigest = stringValue(
      property("generatedDependencyDigest"),
    );
    const expectedNamespaces = generatedDependencyNamespaceNames(
      sourceFile.text,
      TRUSTED_ZOD_PACKAGE.root,
    );
    const actualGeneratedDependencyDigest = generatedDependencyContentDigest(
      sourceFile.text,
      TRUSTED_ZOD_PACKAGE.root,
    );
    const expectedDigest =
      namespaceNames === undefined ||
      namespaceNames.some((name) => name === undefined) ||
      generatedDependencyDigest !== TRUSTED_ZOD_GENERATED_DEPENDENCY_DIGEST ||
      actualGeneratedDependencyDigest !== TRUSTED_ZOD_GENERATED_DEPENDENCY_DIGEST ||
      new Set(namespaceNames).size !== namespaceNames.length
        ? undefined
        : generatedDependencyNamespaceDigest(
            namespaceNames.filter((name): name is string => name !== undefined),
            generatedDependencyDigest ?? "",
          );
    const namespaceValues =
      namespaceNames === undefined
        ? []
        : namespaceNames.filter((name): name is string => name !== undefined);
    const expectedProperties = new Set([
      "packageName",
      "packageVersion",
      "packageRoot",
      "integrity",
      "namespaceNames",
      "generatedDependencyDigest",
      "namespaceDigest",
    ]);
    const actualProperties = new Set(
      (properties ?? []).flatMap((candidate) => {
        if (
          !ts.isPropertyAssignment(candidate) ||
          ts.isComputedPropertyName(candidate.name)
        ) {
          return [];
        }
        const name = bundlePropertyName(candidate.name);
        return name === undefined ? [] : [name];
      }),
    );
    if (
      entryStart < 0 ||
      declaration.getStart(sourceFile) >= entryStart ||
      properties === undefined ||
      actualProperties.size !== expectedProperties.size ||
      [...expectedProperties].some((name) => !actualProperties.has(name)) ||
      stringValue(property("packageName")) !== TRUSTED_ZOD_PACKAGE.name ||
      stringValue(property("packageVersion")) !== TRUSTED_ZOD_PACKAGE.version ||
      stringValue(property("packageRoot")) !== TRUSTED_ZOD_PACKAGE.root ||
      stringValue(property("integrity")) !== TRUSTED_ZOD_PACKAGE.integrity ||
      generatedDependencyDigest !== actualGeneratedDependencyDigest ||
      namespaceNames === undefined ||
      namespaceNames.some((name) => name === undefined) ||
      [...namespaceValues].sort(comparePath).join("\0") !==
        expectedNamespaces.join("\0") ||
      namespaceDigest !== expectedDigest
    ) {
      invalidGeneratedDependencyProvenance = true;
    } else {
      for (const namespace of namespaceValues) {
        const namespaceDeclaration = bindingDeclarations.get(namespace);
        if (
          namespaceDeclaration !== undefined &&
          ts.isVariableDeclaration(namespaceDeclaration) &&
          valueDeclarationCounts.get(namespace) === 1
        ) {
          trustedGeneratedDependencyNamespaces.add(namespaceDeclaration);
        } else {
          invalidGeneratedDependencyProvenance = true;
        }
      }
    }
  }
  const isObjectDefineProperty = (expression: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Object" &&
    expression.name.text === "defineProperty";
  const isGeneratedExportHelper = (
    declaration: ts.VariableDeclaration,
  ): boolean => {
    if (!ts.isIdentifier(declaration.name)) return false;
    const initializer = declaration.initializer;
    if (initializer === undefined || !ts.isArrowFunction(initializer)) {
      return false;
    }
    const helper = initializer;
    if (helper.parameters.length !== 2 || !ts.isBlock(helper.body)) {
      return false;
    }
    const [targetParameter, exportsParameter] = helper.parameters;
    if (
      targetParameter === undefined ||
      exportsParameter === undefined ||
      !ts.isIdentifier(targetParameter.name) ||
      !ts.isIdentifier(exportsParameter.name) ||
      helper.body.statements.length !== 1
    ) {
      return false;
    }
    const statement = helper.body.statements[0];
    if (statement === undefined) return false;
    if (!ts.isForInStatement(statement)) return false;
    if (
      !ts.isVariableDeclarationList(statement.initializer) ||
      statement.initializer.declarations.length !== 1
    ) {
      return false;
    }
    const loopDeclaration = statement.initializer.declarations[0];
    if (
      loopDeclaration === undefined ||
      !ts.isIdentifier(loopDeclaration.name) ||
      !ts.isIdentifier(statement.expression) ||
      statement.expression.text !== exportsParameter.name.text ||
      !ts.isExpressionStatement(statement.statement)
    ) {
      return false;
    }
    const call = statement.statement.expression;
    if (
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      call.arguments.length !== 3
    ) {
      return false;
    }
    const helperBinding = bindings.get(call.expression.text);
    if (
      helperBinding === undefined ||
      typeof helperBinding === "string" ||
      !isObjectDefineProperty(helperBinding)
    ) {
      return false;
    }
    const [target, key, descriptor] = call.arguments;
    if (
      target === undefined ||
      key === undefined ||
      descriptor === undefined ||
      !ts.isIdentifier(target) ||
      !ts.isIdentifier(key) ||
      target.text !== targetParameter.name.text ||
      key.text !== loopDeclaration.name.text ||
      !ts.isObjectLiteralExpression(descriptor)
    ) {
      return false;
    }
    const get = descriptor.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        bundlePropertyName(property.name) === "get",
    );
    const enumerable = descriptor.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        bundlePropertyName(property.name) === "enumerable",
    );
    if (get === undefined || enumerable === undefined) return false;
    if (!ts.isPropertyAssignment(get) || !ts.isPropertyAssignment(enumerable)) {
      return false;
    }
    const getter = get.initializer;
    const enumerableValue = enumerable.initializer;
    if (
      !ts.isElementAccessExpression(getter) ||
      !ts.isIdentifier(getter.expression) ||
      getter.expression.text !== exportsParameter.name.text ||
      !ts.isIdentifier(getter.argumentExpression) ||
      getter.argumentExpression.text !== loopDeclaration.name.text ||
      enumerableValue.kind !== ts.SyntaxKind.TrueKeyword
    ) {
      return false;
    }
    return true;
  };
  const generatedExportHelperCandidateCount = sourceFile.statements.reduce(
    (count, statement) =>
      count +
      (isBeforeGeneratedEntry(statement) &&
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "__export" &&
          isGeneratedExportHelper(declaration),
      )
        ? 1
        : 0),
    0,
  );
  const generatedExportHelper = sourceFile.statements.find(
    (statement) =>
      isBeforeGeneratedEntry(statement) &&
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "__export" &&
          isGeneratedExportHelper(declaration),
      ),
  );
  const generatedExportHelperDigest =
    generatedExportHelper === undefined
      ? undefined
      : sha256(generatedExportHelper.getText(sourceFile).replace(/\r\n/gu, "\n"));
  const hasVerifiedDependencyMarker = generatedDependencyHasPackageMarker(
    sourceFile.text,
    TRUSTED_ZOD_PACKAGE.root,
  );
  const trustedGeneratedHelperRange =
    generatedExportHelper !== undefined &&
    generatedExportHelperCandidateCount === 1 &&
    generatedExportHelperDigest === TRUSTED_GENERATED_EXPORT_HELPER_DIGEST
      ? {
          start: generatedExportHelper.getStart(sourceFile),
          end: generatedExportHelper.getEnd(),
        }
      : undefined;
  if (
    generatedExportHelper !== undefined &&
    generatedExportHelperCandidateCount === 1 &&
    generatedExportHelperDigest === TRUSTED_GENERATED_EXPORT_HELPER_DIGEST
  ) {
    const helperDeclaration = bindingDeclarations.get("__export");
    if (
      helperDeclaration !== undefined &&
      ts.isVariableDeclaration(helperDeclaration) &&
      valueDeclarationCounts.get("__export") === 1
    ) {
      trustedGeneratedExportHelpers.add(helperDeclaration);
    }
  }
  for (const statement of sourceFile.statements) {
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        isBeforeGeneratedEntry(node) &&
        (() => {
          const declaration = bindingDeclarations.get(node.expression.text);
          return (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            valueDeclarationCounts.get(node.expression.text) === 1 &&
            trustedGeneratedExportHelpers.has(declaration)
          );
        })() &&
        node.arguments.length === 2
      ) {
        const namespaceArgument = node.arguments[0];
        const exportArgument = node.arguments[1];
        if (
          namespaceArgument !== undefined &&
          ts.isIdentifier(namespaceArgument) &&
          isBeforeGeneratedEntry(namespaceArgument) &&
          (() => {
            const declaration = bindingDeclarations.get(namespaceArgument.text);
            return (
              declaration !== undefined &&
              ts.isVariableDeclaration(declaration) &&
              valueDeclarationCounts.get(namespaceArgument.text) === 1 &&
              trustedGeneratedDependencyNamespaces.has(declaration)
            );
          })() &&
          exportArgument !== undefined &&
          ts.isObjectLiteralExpression(exportArgument)
        ) {
          let hasFactory = false;
          let hasObject = false;
          let hasString = false;
          for (const property of exportArgument.properties) {
            if (
              !ts.isPropertyAssignment(property) ||
              ts.isComputedPropertyName(property.name)
            ) {
              continue;
            }
            const name = bundlePropertyName(property.name);
            if (name === "object") hasObject = true;
            if (name === "string") hasString = true;
            if (
              name !== undefined &&
              STANDARD_SCHEMA_FACTORY_NAMES.has(name) &&
              ts.isArrowFunction(property.initializer) &&
              ts.isIdentifier(property.initializer.body) &&
              property.initializer.body.text === name
            ) {
              const factory = property.initializer.body.text;
              if (bindings.get(factory) === "function") {
                hasFactory = true;
              }
            }
          }
          if (hasFactory && hasObject && hasString) {
            const namespaceDeclaration = bindingDeclarations.get(
              namespaceArgument.text,
            );
            if (
              namespaceDeclaration !== undefined &&
              ts.isVariableDeclaration(namespaceDeclaration)
            ) {
              trustedSchemaFactoryBindings.add(namespaceDeclaration);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(statement);
  }
  let invalidGeneratedExportHelperUse = false;
  function inspectGeneratedExportHelperUse(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "__export" &&
      !isBeforeGeneratedEntry(node)
    ) {
      invalidGeneratedExportHelperUse = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__export" &&
      (!isBeforeGeneratedEntry(node) ||
        (() => {
          const declaration = bindingDeclarations.get(node.expression.text);
          return (
            declaration === undefined ||
            !ts.isVariableDeclaration(declaration) ||
            valueDeclarationCounts.get(node.expression.text) !== 1 ||
            !trustedGeneratedExportHelpers.has(declaration)
          );
        })())
    ) {
      invalidGeneratedExportHelperUse = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      (node.left.text === generatedExportHelperName ||
        generatedDependencyNamespaceNamesInSource.has(node.left.text))
    ) {
      invalidGeneratedExportHelperUse = true;
    }
    ts.forEachChild(node, inspectGeneratedExportHelperUse);
  }
  inspectGeneratedExportHelperUse(sourceFile);
  const mutatedBindings = new Set<string>();
  const bindingRoots = (
    name: string,
    seen: Set<string> = new Set(),
  ): Set<string> => {
    if (seen.has(name)) return new Set([name]);
    seen.add(name);
    const binding = bindings.get(name);
    if (binding === undefined || typeof binding === "string") {
      return new Set([name]);
    }
    if (!ts.isIdentifier(binding)) {
      if (
        ts.isPropertyAccessExpression(binding) ||
        ts.isElementAccessExpression(binding)
      ) {
        const expression = binding.expression;
        if (ts.isIdentifier(expression)) {
          return bindingRoots(expression.text, seen);
        }
      }
      return new Set([name]);
    }
    return bindingRoots(binding.text, seen);
  };
  const mutationRoot = (expression: ts.Expression): string | undefined => {
    let current = expression;
    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
    }
    return ts.isIdentifier(current) ? current.text : undefined;
  };
  const mutatedFunctionParameters = new Map<
    ts.FunctionLikeDeclaration,
    Set<number>
  >();
  const functionParameterIndex = (
    node: ts.Node,
    name: string,
  ): {
    readonly declaration: ts.FunctionLikeDeclaration;
    readonly index: number;
  } | undefined => {
    let current: ts.Node | undefined = node;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current) ||
        ts.isConstructorDeclaration(current)
      ) {
        const index = current.parameters.findIndex(
          (parameter) =>
            ts.isIdentifier(parameter.name) && parameter.name.text === name,
        );
        if (index >= 0) {
          return { declaration: current, index };
        }
        return undefined;
      }
      current = current.parent;
    }
    return undefined;
  };
  const noteFunctionParameterMutation = (
    node: ts.Node,
    root: string,
  ): boolean => {
    const parameter = functionParameterIndex(node, root);
    if (parameter === undefined) return false;
    const indexes =
      mutatedFunctionParameters.get(parameter.declaration) ?? new Set<number>();
    indexes.add(parameter.index);
    mutatedFunctionParameters.set(parameter.declaration, indexes);
    return true;
  };
  type MutationKind =
    | "object-assign"
    | "object-define-property"
    | "reflect-set"
    | "reflect-define-property"
    | "reflect-apply";
  interface MutationCallable {
    readonly kind: MutationKind;
    readonly boundArguments: readonly ts.Expression[];
    readonly invocation?: "call" | "apply";
  }
  const unwrapMutationExpression = (
    expression: ts.Expression,
  ): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const directMutationKind = (
    expression: ts.Expression,
  ): MutationKind | undefined => {
    const current = unwrapMutationExpression(expression);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return undefined;
    }
    const propertyName = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression !== undefined &&
          ts.isStringLiteralLike(current.argumentExpression)
        ? current.argumentExpression.text
        : undefined;
    if (propertyName === undefined || !ts.isIdentifier(current.expression)) {
      return undefined;
    }
    const objectName = current.expression.text;
    if (bindings.has(objectName)) return undefined;
    if (objectName === "Object" && propertyName === "assign") {
      return "object-assign";
    }
    if (objectName === "Object" && propertyName === "defineProperty") {
      return "object-define-property";
    }
    if (objectName === "Reflect" && propertyName === "set") {
      return "reflect-set";
    }
    if (objectName === "Reflect" && propertyName === "defineProperty") {
      return "reflect-define-property";
    }
    if (objectName === "Reflect" && propertyName === "apply") {
      return "reflect-apply";
    }
    return undefined;
  };
  const mutationCallable = (
    expression: ts.Expression,
    resolving: Set<string> = new Set(),
  ): MutationCallable | undefined => {
    const current = unwrapMutationExpression(expression);
    if (ts.isCallExpression(current)) {
      const callee = unwrapMutationExpression(current.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "bind"
      ) {
        const target = mutationCallable(callee.expression, resolving);
        if (target === undefined) return undefined;
        return {
          kind: target.kind,
          boundArguments: [
            ...target.boundArguments,
            ...current.arguments.slice(1),
          ],
        };
      }
    }
    if (
      ts.isPropertyAccessExpression(current) &&
      (current.name.text === "call" || current.name.text === "apply")
    ) {
      const target = mutationCallable(current.expression, resolving);
      if (target === undefined) return undefined;
      return {
        ...target,
        invocation: current.name.text,
      };
    }
    const direct = directMutationKind(current);
    if (direct !== undefined) {
      return { kind: direct, boundArguments: [] };
    }
    if (!ts.isIdentifier(current) || resolving.has(current.text)) {
      return undefined;
    }
    const binding = bindings.get(current.text);
    if (binding === undefined || typeof binding === "string") {
      return undefined;
    }
    resolving.add(current.text);
    try {
      return mutationCallable(binding, resolving);
    } finally {
      resolving.delete(current.text);
    }
  };
  const mutationInvocationArguments = (
    node: ts.CallExpression,
  ): { readonly callable: MutationCallable; readonly arguments: readonly ts.Expression[] } | undefined => {
    const callExpression = unwrapMutationExpression(node.expression);
    if (
      ts.isPropertyAccessExpression(callExpression) &&
      (callExpression.name.text === "call" ||
        callExpression.name.text === "apply")
    ) {
      const callable = mutationCallable(callExpression.expression);
      if (callable === undefined) return undefined;
      if (callExpression.name.text === "call") {
        return {
          callable,
          arguments: [
            ...callable.boundArguments,
            ...node.arguments.slice(1),
          ],
        };
      }
      const argumentsList = node.arguments[1];
      if (
        argumentsList === undefined ||
        !ts.isArrayLiteralExpression(argumentsList) ||
        argumentsList.elements.some(ts.isSpreadElement)
      ) {
        return undefined;
      }
      return {
        callable,
        arguments: [
          ...callable.boundArguments,
          ...argumentsList.elements,
        ],
      };
    }
    const callable = mutationCallable(node.expression);
    if (callable === undefined) return undefined;
    if (callable.invocation === "call") {
      return {
        callable,
        arguments: [
          ...callable.boundArguments,
          ...node.arguments.slice(1),
        ],
      };
    }
    if (callable.invocation === "apply") {
      const argumentsList = node.arguments[1];
      if (
        argumentsList === undefined ||
        !ts.isArrayLiteralExpression(argumentsList) ||
        argumentsList.elements.some(ts.isSpreadElement)
      ) {
        return undefined;
      }
      return {
        callable,
        arguments: [
          ...callable.boundArguments,
          ...argumentsList.elements,
        ],
      };
    }
    return {
      callable,
      arguments: [...callable.boundArguments, ...node.arguments],
    };
  };
  const functionDeclarationForExpression = (
    expression: ts.Expression,
    resolving: Set<string> = new Set(),
  ): ts.FunctionLikeDeclaration | undefined => {
    const current = unwrapMutationExpression(expression);
    if (!ts.isIdentifier(current) || resolving.has(current.text)) {
      return undefined;
    }
    const declaration = functionDeclarations.get(current.text);
    if (declaration !== undefined) return declaration;
    const binding = bindings.get(current.text);
    if (
      binding === undefined ||
      typeof binding === "string" ||
      ts.isFunctionLike(binding)
    ) {
      return undefined;
    }
    resolving.add(current.text);
    try {
      return functionDeclarationForExpression(binding, resolving);
    } finally {
      resolving.delete(current.text);
    }
  };
  const markBindingMutation = (root: string): void => {
    for (const binding of bindingRoots(root)) mutatedBindings.add(binding);
  };
  const isAllowedGeneratedConstructionCall = (
    expression: ts.Expression,
  ): boolean =>
    isObjectMemberCall(expression, "Object", "freeze") ||
    isObjectMemberCall(expression, "Object", "fromEntries") ||
    isObjectMemberCall(expression, "Object", "defineProperty") ||
    isObjectMemberCall(expression, "Object", "assign");
  let invalidGeneratedMutation = false;
  const noteMutation = (): void => {
    invalidGeneratedMutation = true;
  };
  const isTrustedGeneratedHelperNode = (node: ts.Node): boolean =>
    trustedGeneratedHelperRange !== undefined &&
    node.getStart(sourceFile) >= trustedGeneratedHelperRange.start &&
    node.getEnd() <= trustedGeneratedHelperRange.end;
  const isCompilerProvenanceNode = (node: ts.Node): boolean => {
    const provenance = provenanceDeclarations[0];
    return (
      provenance !== undefined &&
      node.getStart(sourceFile) >= provenance.getStart(sourceFile) &&
      node.getEnd() <= provenance.getEnd()
    );
  };
  const trustedGeneratedDependencyRanges: readonly {
    readonly start: number;
    readonly end: number;
  }[] = generatedDependencySectionRanges(
    sourceFile.text,
    TRUSTED_ZOD_PACKAGE.root,
  );
  const isTrustedGeneratedDependencyNode = (node: ts.Node): boolean => {
    const start = node.getStart(sourceFile);
    return (
      start < entryStart &&
      trustedGeneratedDependencyRanges.some(
        (range) => start >= range.start && start < range.end,
      )
    );
  };
  const isTrustedDependencySubtree = (node: ts.Node): boolean => {
    const start = node.getStart(sourceFile);
    return (
      start < entryStart &&
      trustedGeneratedDependencyRanges.some(
        (range) => start >= range.start && start < range.end,
      )
    );
  };
  const isTrustedDependencyGeneratedExportCall = (
    node: ts.CallExpression,
  ): boolean => {
    if (
      !ts.isIdentifier(node.expression) ||
      node.expression.text !== "__export" ||
      node.arguments.length !== 2
    ) {
      return false;
    }
    const target = node.arguments[0];
    return (
      target !== undefined &&
      ts.isIdentifier(target) &&
      (() => {
        const declaration = bindingDeclarations.get(target.text);
        return (
          declaration !== undefined &&
          ts.isVariableDeclaration(declaration) &&
          valueDeclarationCounts.get(target.text) === 1 &&
          trustedGeneratedDependencyNamespaces.has(declaration)
        );
      })()
    );
  };
  const isFunctionParameterName = (name: string, node: ts.Node): boolean => {
    return functionParameterIndex(node, name) !== undefined;
  };
  const mutationTargets = (node: ts.CallExpression): ts.Expression[] => {
    const invocation = mutationInvocationArguments(node);
    if (invocation === undefined) return [];
    if (invocation.callable.kind === "reflect-apply") {
      const argumentsList = invocation.arguments[2];
      return argumentsList !== undefined &&
        ts.isArrayLiteralExpression(argumentsList) &&
        argumentsList.elements[0] !== undefined &&
        !ts.isSpreadElement(argumentsList.elements[0])
        ? [argumentsList.elements[0]]
        : [];
    }
    const target = invocation.arguments[0];
    return target === undefined ? [] : [target];
  };
  const markUnknownEntryMutation = (node: ts.Node): void => {
    if (!isGeneratedEntryNode(node)) return;
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (isAllowedGeneratedConstructionCall(callee)) return;
    noteMutation();
    const root = ts.isIdentifier(callee) ? callee.text : undefined;
    if (root !== undefined) markBindingMutation(root);
  };
  function collectMutations(node: ts.Node): void {
    if (
      isTrustedGeneratedHelperNode(node) ||
      isTrustedGeneratedDependencyNode(node)
    ) {
      ts.forEachChild(node, collectMutations);
      return;
    }
    if (isGeneratedEntryNode(node) && ts.isDeleteExpression(node)) {
      noteMutation();
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const root = mutationRoot(node.left);
      if (root !== undefined) {
        if (isGeneratedEntryNode(node)) {
          noteMutation();
        }
        if (!noteFunctionParameterMutation(node, root)) {
          for (const binding of bindingRoots(root)) mutatedBindings.add(binding);
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const root = mutationRoot(node.operand);
      if (root !== undefined) {
        if (isGeneratedEntryNode(node)) {
          noteMutation();
        }
        if (!noteFunctionParameterMutation(node, root)) {
          for (const binding of bindingRoots(root)) mutatedBindings.add(binding);
        }
      }
    } else if (ts.isNewExpression(node) && isGeneratedEntryNode(node)) {
      noteMutation();
    } else if (ts.isCallExpression(node)) {
      const targets = mutationTargets(node);
      const isTrustedDependencyMutation =
        targets.length > 0 &&
        isTrustedDependencyGeneratedExportCall(node);
      if (
        targets.length > 0 &&
        !isTrustedGeneratedHelperNode(node) &&
        !isCompilerProvenanceNode(node) &&
        !isTrustedDependencySubtree(node) &&
        !isTrustedDependencyMutation
      ) {
        const root = mutationRoot(targets[0] as ts.Expression);
        if (root !== undefined) {
          if (isGeneratedEntryNode(node)) {
            noteMutation();
          }
          if (!noteFunctionParameterMutation(node, root)) {
            markBindingMutation(root);
          }
        }
      }
      if (
        !isTrustedDependencyMutation &&
        !isTrustedDependencySubtree(node) &&
        targets.some((target) => {
          const root = mutationRoot(target);
          return root !== undefined && isFunctionParameterName(root, node);
        })
      ) {
        noteMutation();
      }
      if (
        !isTrustedDependencyMutation &&
        !isTrustedGeneratedHelperNode(node) &&
        !isCompilerProvenanceNode(node) &&
        !isTrustedDependencySubtree(node)
      ) {
        markUnknownEntryMutation(node);
      }
    }
    ts.forEachChild(node, collectMutations);
  }
  const propagateFunctionParameterMutations = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const declaration = functionDeclarationForExpression(node.expression);
          const mutatedParameters =
            declaration === undefined
              ? undefined
              : mutatedFunctionParameters.get(declaration);
          if (mutatedParameters !== undefined) {
            for (const index of mutatedParameters) {
              const argument = node.arguments[index];
              if (argument === undefined || ts.isSpreadElement(argument)) {
                continue;
              }
              const root = mutationRoot(argument);
              if (root === undefined) {
                if (isGeneratedEntryNode(node)) noteMutation();
                continue;
              }
              const callerParameter = functionParameterIndex(node, root);
              if (callerParameter !== undefined) {
                const indexes =
                  mutatedFunctionParameters.get(callerParameter.declaration) ??
                  new Set<number>();
                if (!indexes.has(callerParameter.index)) {
                  indexes.add(callerParameter.index);
                  mutatedFunctionParameters.set(
                    callerParameter.declaration,
                    indexes,
                  );
                  changed = true;
                }
              } else {
                const before = new Set(mutatedBindings);
                markBindingMutation(root);
                if (before.size !== mutatedBindings.size) changed = true;
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
    }
  };
  collectMutations(sourceFile);
  propagateFunctionParameterMutations();
  return {
    bindings,
    trustedSchemaFactoryBindings,
    bindingDeclarations,
    valueDeclarationCounts,
    trustedGeneratedDependencyNamespaces,
    trustedGeneratedExportHelpers,
    generatedEntryBoundary,
    hasVerifiedDependencyMarker,
    generatedExportHelperCandidateCount,
    generatedExportHelperDigest,
    invalidGeneratedExportHelperUse:
      invalidGeneratedExportHelperUse ||
      invalidGeneratedDependencyProvenance ||
      generatedEntryBoundary === undefined ||
      (hasVerifiedDependencyMarker
        ? generatedExportHelperCandidateCount !== 1 ||
          generatedExportHelperDigest !== TRUSTED_GENERATED_EXPORT_HELPER_DIGEST
        : generatedExportHelperCandidateCount !== 0),
    invalidGeneratedMutation,
    mutatedBindings,
  };
}

function defaultBundleExpression(
  sourceFile: ts.SourceFile,
): ts.Expression | undefined {
  const boundary = generatedArtifactEntryBoundary(sourceFile.text);
  const defaultDeclarations = sourceFile.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === "eden_artifact_entry_default",
        )
      : [],
  );
  if (
    boundary === undefined ||
    defaultDeclarations.length !== 1 ||
    defaultDeclarations[0]?.parent.parent.getStart(sourceFile) !==
      boundary.defaultStart
  ) {
    return undefined;
  }
  const isOwnedTarget = (expression: ts.Expression): boolean =>
    ts.isIdentifier(expression) &&
    expression.text === "eden_artifact_entry_default";
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return isOwnedTarget(statement.expression)
        ? statement.expression
        : undefined;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const defaultSpecifier = statement.exportClause.elements.find(
        (specifier) => specifier.name.text === "default",
      );
      if (defaultSpecifier !== undefined) {
        const target = defaultSpecifier.propertyName ?? defaultSpecifier.name;
        return isOwnedTarget(target) ? target : undefined;
      }
    }
  }
  return undefined;
}

function bundleShapeProperty(
  shape: BundleShape,
  field: string,
  path: string,
): BundleShape {
  if (shape.kind !== "record") {
    artifactSchemaFailure(path, "must be an object.");
  }
  const value = shape.properties.get(field);
  if (value === undefined) {
    artifactSchemaFailure(path, `must contain "${field}".`);
  }
  return value;
}

function bundleRecordProperty(
  properties: ReadonlyMap<string, BundleShape>,
  field: string,
  path: string,
): BundleShape {
  const value = properties.get(field);
  if (value === undefined) {
    artifactSchemaFailure(path, `must contain "${field}".`);
  }
  return value;
}

function assertBundleKeys(
  properties: ReadonlyMap<string, BundleShape>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of properties.keys()) {
    if (!allowed.has(key)) {
      artifactSchemaFailure(`${path}.${key}`, "is not supported.");
    }
  }
}

function bundleShapeString(
  shape: BundleShape,
  path: string,
  nonEmpty = false,
): string {
  if (shape.kind !== "string" || (nonEmpty && shape.value.trim().length === 0)) {
    artifactSchemaFailure(
      path,
      nonEmpty ? "must be a non-empty string." : "must be a string.",
    );
  }
  return shape.value;
}

function bundleShapeNumber(
  shape: BundleShape,
  path: string,
  minimum?: number,
  maximum?: number,
): number {
  if (
    shape.kind !== "number" ||
    !Number.isFinite(shape.value) ||
    (minimum !== undefined && shape.value < minimum) ||
    (maximum !== undefined && shape.value > maximum)
  ) {
    artifactSchemaFailure(path, "must be a finite number in the supported range.");
  }
  return shape.value;
}

function bundleShapeRecord(
  shape: BundleShape,
  path: string,
): ReadonlyMap<string, BundleShape> {
  if (shape.kind !== "record") {
    artifactSchemaFailure(path, "must be an object.");
  }
  return shape.properties;
}

function assertRuntimeJsonShape(shape: BundleShape, path: string): void {
  if (
    shape.kind === "string" ||
    shape.kind === "boolean" ||
    shape.kind === "null"
  ) {
    return;
  }
  if (shape.kind === "number") {
    if (!Number.isFinite(shape.value)) {
      artifactSchemaFailure(path, "must be a finite JSON-compatible number.");
    }
    return;
  }
  if (shape.kind === "array") {
    shape.elements.forEach((item, index) =>
      assertRuntimeJsonShape(item, `${path}[${index}]`),
    );
    return;
  }
  if (shape.kind === "record") {
    for (const [key, value] of shape.properties) {
      assertRuntimeJsonShape(value, `${path}.${key}`);
    }
    return;
  }
  artifactSchemaFailure(path, "must be a JSON-compatible value.");
}

function assertRuntimeModuleMapShape(
  shape: BundleShape,
  path: string,
  expectedToolNames: readonly string[],
): void {
  const moduleMap = bundleShapeRecord(shape, path);
  assertBundleKeys(moduleMap, new Set(["agent", "instructions", "tools"]), path);
  const agent = bundleShapeString(
    bundleRecordProperty(moduleMap, "agent", `${path}.agent`),
    `${path}.agent`,
    true,
  );
  if (agent !== "agent:default") {
    artifactSchemaFailure(
      `${path}.agent`,
      'must be the generated "agent:default" module reference.',
    );
  }
  const instructions = bundleShapeString(
    bundleRecordProperty(moduleMap, "instructions", `${path}.instructions`),
    `${path}.instructions`,
    true,
  );
  if (instructions !== "instructions:default") {
    artifactSchemaFailure(
      `${path}.instructions`,
      'must be the generated "instructions:default" module reference.',
    );
  }
  const tools = bundleShapeRecord(
    bundleRecordProperty(moduleMap, "tools", `${path}.tools`),
    `${path}.tools`,
  );
  const actualToolNames = [...tools.keys()];
  if (
    actualToolNames.length !== expectedToolNames.length ||
    expectedToolNames.some((name) => !tools.has(name))
  ) {
    artifactSchemaFailure(
      `${path}.tools`,
      "must contain exactly the manifest tool set.",
    );
  }
  for (const name of expectedToolNames) {
    const module = bundleShapeString(
      tools.get(name) as BundleShape,
      `${path}.tools.${name}`,
      true,
    );
    if (module !== `tool:${name}`) {
      artifactSchemaFailure(
        `${path}.tools.${name}`,
        `must be the generated "tool:${name}" module reference.`,
      );
    }
  }
}

function assertRuntimeSchemaShape(shape: BundleShape, path: string): void {
  if (shape.kind === "schema-call") return;
  const standard = bundleShapeRecord(
    bundleShapeProperty(shape, "~standard", `${path}.~standard`),
    `${path}.~standard`,
  );
  bundleShapeNumber(
    bundleRecordProperty(standard, "version", `${path}.~standard.version`),
    `${path}.~standard.version`,
    1,
    1,
  );
  bundleShapeString(
    bundleRecordProperty(standard, "vendor", `${path}.~standard.vendor`),
    `${path}.~standard.vendor`,
    true,
  );
  const validate = bundleRecordProperty(
    standard,
    "validate",
    `${path}.~standard.validate`,
  );
  if (validate.kind !== "function") {
    artifactSchemaFailure(
      `${path}.~standard.validate`,
      "must be a function.",
    );
  }
}

function assertRuntimeBundleContract(
  bundle: string,
  manifest: EdenManifest,
): void {
  const sourceFile = sourceFileForValidation("agent-bundle.mjs", bundle);
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    artifactSchemaFailure(
      "agent-bundle.mjs",
      "must contain syntactically valid ESM.",
    );
  }
  const expression = defaultBundleExpression(sourceFile);
  if (expression === undefined) {
    artifactSchemaFailure(
      "agent-bundle.mjs.default",
      "must provide an authoritative default export.",
    );
  }
  const environment = bundleShapeEnvironment(sourceFile);
  // The injected provenance declaration is itself compiler-owned metadata.
  // It must not make the generated dependency's pre-entry construction
  // appear to be authored artifact mutation.
  if (environment.invalidGeneratedExportHelperUse) {
    artifactSchemaFailure(
      "agent-bundle.mjs",
      `contains an unverified generated export helper declaration or use (boundary=${environment.generatedEntryBoundary === undefined ? "missing" : "present"}, dependency=${environment.hasVerifiedDependencyMarker ? "present" : "absent"}, candidates=${String(environment.generatedExportHelperCandidateCount)}, digest=${environment.generatedExportHelperDigest ?? "missing"}).`,
    );
  }
  if (environment.invalidGeneratedMutation) {
    artifactSchemaFailure(
      "agent-bundle.mjs",
      "contains an unresolved or unsupported generated artifact mutation.",
    );
  }
  const artifact = bundleShapeForExpression(expression, environment);
  const artifactProperties = bundleShapeRecord(
    artifact,
    "agent-bundle.mjs.default",
  );
  assertBundleKeys(
    artifactProperties,
    new Set(["agent", "instructions", "tools", "toolSchemas", "moduleMap"]),
    "agent-bundle.mjs.default",
  );
  const agent = bundleShapeRecord(
    bundleRecordProperty(
      artifactProperties,
      "agent",
      "agent-bundle.mjs.default.agent",
    ),
    "agent-bundle.mjs.default.agent",
  );
  assertBundleKeys(
    agent,
    new Set(["model", "options"]),
    "agent-bundle.mjs.default.agent",
  );
  const model = bundleRecordProperty(
    agent,
    "model",
    "agent-bundle.mjs.default.agent.model",
  );
  bundleShapeString(model, "agent-bundle.mjs.default.agent.model", true);
  const options = agent.get("options");
  if (options !== undefined) {
    const optionProperties = bundleShapeRecord(
      options,
      "agent-bundle.mjs.default.agent.options",
    );
    assertBundleKeys(
      optionProperties,
      new Set(["temperature", "maxOutputTokens", "thinking"]),
      "agent-bundle.mjs.default.agent.options",
    );
    for (const [name, value] of optionProperties) {
      if (name === "temperature") {
        bundleShapeNumber(
          value,
          `agent-bundle.mjs.default.agent.options.${name}`,
          0,
          2,
        );
      } else if (name === "maxOutputTokens") {
        const maxOutputTokens = bundleShapeNumber(
          value,
          `agent-bundle.mjs.default.agent.options.${name}`,
          1,
          32768,
        );
        if (!Number.isInteger(maxOutputTokens)) {
          artifactSchemaFailure(
            `agent-bundle.mjs.default.agent.options.${name}`,
            "must be an integer.",
          );
        }
      } else if (value.kind !== "boolean") {
        artifactSchemaFailure(
          `agent-bundle.mjs.default.agent.options.${name}`,
          "must be a boolean.",
        );
      }
    }
  }

  bundleShapeString(
    bundleRecordProperty(
      artifactProperties,
      "instructions",
      "agent-bundle.mjs.default.instructions",
    ),
    "agent-bundle.mjs.default.instructions",
  );

  const tools = bundleShapeRecord(
    bundleRecordProperty(
      artifactProperties,
      "tools",
      "agent-bundle.mjs.default.tools",
    ),
    "agent-bundle.mjs.default.tools",
  );
  const toolSchemas = bundleShapeRecord(
    bundleRecordProperty(
      artifactProperties,
      "toolSchemas",
      "agent-bundle.mjs.default.toolSchemas",
    ),
    "agent-bundle.mjs.default.toolSchemas",
  );
  assertRuntimeModuleMapShape(
    bundleRecordProperty(
      artifactProperties,
      "moduleMap",
      "agent-bundle.mjs.default.moduleMap",
    ),
    "agent-bundle.mjs.default.moduleMap",
    manifest.tools.map((tool) => tool.name),
  );
  const expectedToolNames = manifest.tools.map((tool) => tool.name);
  const actualToolNames = [...tools.keys()];
  const actualSchemaNames = [...toolSchemas.keys()];
  if (
    actualToolNames.length !== expectedToolNames.length ||
    actualSchemaNames.length !== expectedToolNames.length ||
    expectedToolNames.some(
      (name) =>
        !tools.has(name) ||
        !toolSchemas.has(name),
    )
  ) {
    artifactSchemaFailure(
      "agent-bundle.mjs.default",
      "tools and toolSchemas must contain exactly the manifest tool set.",
    );
  }
  for (const toolName of expectedToolNames) {
    const toolPath = `agent-bundle.mjs.default.tools.${toolName}`;
    const tool = bundleShapeRecord(
      tools.get(toolName) as BundleShape,
      toolPath,
    );
    assertBundleKeys(
      tool,
      new Set(["description", "inputSchema", "execute"]),
      toolPath,
    );
    bundleShapeString(
      bundleRecordProperty(tool, "description", `${toolPath}.description`),
      `${toolPath}.description`,
      true,
    );
    assertRuntimeSchemaShape(
      bundleRecordProperty(tool, "inputSchema", `${toolPath}.inputSchema`),
      `${toolPath}.inputSchema`,
    );
    const execute = bundleRecordProperty(tool, "execute", `${toolPath}.execute`);
    if (execute.kind !== "function") {
      artifactSchemaFailure(`${toolPath}.execute`, "must be a function.");
    }
    assertRuntimeJsonShape(
      toolSchemas.get(toolName) as BundleShape,
      `agent-bundle.mjs.default.toolSchemas.${toolName}`,
    );
  }
}

function assertArtifactCoherence(
  manifest: EdenManifest,
  moduleMap: EdenModuleMap,
  bundle: string,
  buildMetadata: EdenBuildMetadata,
): void {
  assertRuntimeBundleContract(bundle, manifest);
  const sourceFile = sourceFileForValidation("agent-bundle.mjs", bundle);
  const provenanceDeclaration = sourceFile.text.match(
    /var\s+edenVerifiedDependencyProvenance\s*=\s*\{[\s\S]*?\};/u,
  )?.[0];
  const provenanceDigest = provenanceDeclaration?.match(
    /generatedDependencyDigest:\s*"(?<digest>[a-f0-9]{64})"/u,
  )?.groups?.digest;
  const expectedGeneratedDependencyDigest = generatedDependencyContentDigest(
    sourceFile.text,
    TRUSTED_ZOD_PACKAGE.root,
  );
  if (provenanceDeclaration === undefined) {
    if (
      generatedDependencyHasPackageMarker(
        sourceFile.text,
        TRUSTED_ZOD_PACKAGE.root,
      )
    ) {
      throw new EdenCompilerError("Generated dependency provenance is missing", [
        diagnostic(
          "OUTPUT_INVALID",
          "Verified generated dependencies must include compiler-owned provenance.",
        ),
      ]);
    }
  } else if (
    provenanceDigest === undefined ||
    expectedGeneratedDependencyDigest !== provenanceDigest
  ) {
    throw new EdenCompilerError("Generated dependency provenance mismatch", [
      diagnostic(
        "OUTPUT_INVALID",
        "Generated dependency content does not match its verified provenance.",
      ),
    ]);
  }
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

function assertSortedUniqueArtifactSources(
  sources: readonly EdenSourceReference[],
  field: string,
): void {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const [index, source] of sources.entries()) {
    if (seen.has(source.relativePath)) {
      throw new EdenCompilerError("Published artifact metadata is incoherent", [
        diagnostic(
          "OUTPUT_INVALID",
          `${field}[${index}] duplicates source "${source.relativePath}".`,
          field,
        ),
      ]);
    }
    if (previous !== undefined && comparePath(previous, source.relativePath) >= 0) {
      throw new EdenCompilerError("Published artifact metadata is incoherent", [
        diagnostic(
          "OUTPUT_INVALID",
          `${field} must be sorted by canonical relative path.`,
          field,
        ),
      ]);
    }
    seen.add(source.relativePath);
    previous = source.relativePath;
  }
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
  if (
    discovery.agent.relativePath !== REQUIRED_AGENT_PATH ||
    discovery.instructions.relativePath !== REQUIRED_INSTRUCTIONS_PATH
  ) {
    throw new EdenCompilerError("Published discovery metadata is incoherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Discovery required source slots do not match the Eden authoring layout.",
      ),
    ]);
  }
  assertSortedUniqueArtifactSources(discovery.tools, "discovery.tools");
  if (
    manifest.instructions.sha256 !==
      sha256(manifest.instructions.content) ||
    manifest.instructions.source.sha256 !== manifest.instructions.sha256
  ) {
    throw new EdenCompilerError("Published instruction metadata is incoherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Instruction content, source hash, and recorded hash must agree.",
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
  for (const [index, tool] of manifest.tools.entries()) {
    const source = discovery.tools[index];
    if (source === undefined) continue;
    const expectedPath = `agent/tools/${tool.name}.ts`;
    const expectedModule = `tool:${tool.name}`;
    if (
      source.relativePath !== expectedPath ||
      tool.module !== expectedModule
    ) {
      throw new EdenCompilerError("Published tool metadata is incoherent", [
        diagnostic(
          "OUTPUT_INVALID",
          `Tool "${tool.name}" must reference source "${expectedPath}" and module "${expectedModule}".`,
          `manifest.tools[${index}]`,
        ),
      ]);
    }
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

const ARTIFACT_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ARTIFACT_MODULE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/u;

function artifactSchemaFailure(field: string, message: string): never {
  throw new EdenCompilerError("Published artifact schema is invalid", [
    diagnostic("OUTPUT_INVALID", `${field}: ${message}`, field),
  ]);
}

function artifactRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    return artifactSchemaFailure(field, "must be an object.");
  }
  return value;
}

function assertArtifactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const missing = required.filter((key) => !hasOwn(value, key));
  const unknown = keys.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing ${missing.join(", ")}`]),
      ...(unknown.length === 0 ? [] : [`unknown ${unknown.join(", ")}`]),
    ].join("; ");
    artifactSchemaFailure(field, `has invalid fields (${details}).`);
  }
}

function artifactString(
  value: unknown,
  field: string,
  options: { readonly nonEmpty?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    (options.nonEmpty === true && value.trim().length === 0)
  ) {
    return artifactSchemaFailure(
      field,
      options.nonEmpty === true
        ? "must be a non-empty string."
        : "must be a string.",
    );
  }
  return value;
}

function artifactSha256(value: unknown, field: string): string {
  const text = artifactString(value, field, { nonEmpty: true });
  if (!ARTIFACT_SHA256_PATTERN.test(text)) {
    return artifactSchemaFailure(
      field,
      "must be a lowercase SHA-256 hexadecimal digest.",
    );
  }
  return text;
}

function artifactRelativePath(value: unknown, field: string): string {
  const path = artifactString(value, field, { nonEmpty: true });
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return artifactSchemaFailure(
      field,
      "must be a normalized relative POSIX path.",
    );
  }
  return path;
}

function artifactModule(value: unknown, field: string): string {
  const module = artifactString(value, field, { nonEmpty: true });
  if (!ARTIFACT_MODULE_PATTERN.test(module)) {
    return artifactSchemaFailure(
      field,
      "must be a valid Eden module reference.",
    );
  }
  return module;
}

function artifactSafeInteger(
  value: unknown,
  field: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (options.minimum !== undefined && value < options.minimum) ||
    (options.maximum !== undefined && value > options.maximum)
  ) {
    const range =
      options.minimum === undefined && options.maximum === undefined
        ? "a safe integer"
        : `a safe integer between ${String(options.minimum ?? Number.MIN_SAFE_INTEGER)} and ${String(options.maximum ?? Number.MAX_SAFE_INTEGER)}`;
    return artifactSchemaFailure(field, `must be ${range}.`);
  }
  return value;
}

function artifactFiniteNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return artifactSchemaFailure(
      field,
      `must be a finite number between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function decodeArtifactSourceReference(
  value: unknown,
  field: string,
): EdenSourceReference {
  const record = artifactRecord(value, field);
  assertArtifactKeys(record, ["relativePath", "sha256"], [], field);
  return {
    relativePath: artifactRelativePath(record.relativePath, `${field}.relativePath`),
    sha256: artifactSha256(record.sha256, `${field}.sha256`),
  };
}

function decodeArtifactModelOptions(
  value: unknown,
  field: string,
): EdenManifest["agent"]["options"] {
  if (value === undefined) return undefined;
  const record = artifactRecord(value, field);
  assertArtifactKeys(
    record,
    [],
    ["temperature", "maxOutputTokens", "thinking"],
    field,
  );
  const options: {
    temperature?: number;
    maxOutputTokens?: number;
    thinking?: boolean;
  } = {};
  if (hasOwn(record, "temperature")) {
    options.temperature = artifactFiniteNumber(
      record.temperature,
      `${field}.temperature`,
      0,
      2,
    );
  }
  if (hasOwn(record, "maxOutputTokens")) {
    options.maxOutputTokens = artifactSafeInteger(
      record.maxOutputTokens,
      `${field}.maxOutputTokens`,
      { minimum: 1, maximum: 32768 },
    );
  }
  if (hasOwn(record, "thinking") && typeof record.thinking !== "boolean") {
    artifactSchemaFailure(`${field}.thinking`, "must be a boolean.");
  }
  if (hasOwn(record, "thinking")) {
    options.thinking = record.thinking as boolean;
  }
  return Object.keys(options).length === 0 ? {} : options;
}

function decodeArtifactAgent(
  value: unknown,
  field: string,
): EdenManifest["agent"] {
  const record = artifactRecord(value, field);
  assertArtifactKeys(record, ["source", "model"], ["options"], field);
  const agent: EdenManifest["agent"] = {
    source: decodeArtifactSourceReference(record.source, `${field}.source`),
    model: artifactString(record.model, `${field}.model`, { nonEmpty: true }),
  };
  const options = decodeArtifactModelOptions(record.options, `${field}.options`);
  if (options !== undefined) {
    return { ...agent, options };
  }
  return agent;
}

function decodeArtifactInstructionManifest(
  value: unknown,
  field: string,
): EdenInstructionManifest {
  const record = artifactRecord(value, field);
  assertArtifactKeys(record, ["source", "content", "sha256"], [], field);
  return {
    source: decodeArtifactSourceReference(record.source, `${field}.source`),
    content: artifactString(record.content, `${field}.content`),
    sha256: artifactSha256(record.sha256, `${field}.sha256`),
  };
}

function decodeArtifactSchemaMetadata(
  value: unknown,
  field: string,
): { readonly vendor: string; readonly version: number } {
  const record = artifactRecord(value, field);
  assertArtifactKeys(record, ["vendor", "version"], [], field);
  const version = artifactSafeInteger(record.version, `${field}.version`, {
    minimum: 1,
    maximum: 1,
  });
  return {
    vendor: artifactString(record.vendor, `${field}.vendor`, {
      nonEmpty: true,
    }),
    version,
  };
}

function decodeArtifactToolManifest(
  value: unknown,
  field: string,
): EdenManifest["tools"][number] {
  const record = artifactRecord(value, field);
  assertArtifactKeys(
    record,
    ["name", "description", "source", "module", "schema"],
    [],
    field,
  );
  const name = artifactString(record.name, `${field}.name`, { nonEmpty: true });
  if (!TOOL_NAME_PATTERN.test(name)) {
    artifactSchemaFailure(
      `${field}.name`,
      "must use the published tool-name grammar.",
    );
  }
  return {
    name,
    description: artifactString(record.description, `${field}.description`, {
      nonEmpty: true,
    }),
    source: decodeArtifactSourceReference(record.source, `${field}.source`),
    module: artifactModule(record.module, `${field}.module`),
    schema: decodeArtifactSchemaMetadata(record.schema, `${field}.schema`),
  };
}

function decodeArtifactModuleReference(
  value: unknown,
  field: string,
): EdenModuleMap["agent"] {
  const record = artifactRecord(value, field);
  assertArtifactKeys(record, ["name", "module", "source"], [], field);
  return {
    name: artifactString(record.name, `${field}.name`, { nonEmpty: true }),
    module: artifactModule(record.module, `${field}.module`),
    source: decodeArtifactSourceReference(record.source, `${field}.source`),
  };
}

function assertUniqueArtifactNames(
  values: readonly { readonly name: string }[],
  field: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.name)) {
      artifactSchemaFailure(
        `${field}[${index}].name`,
        `duplicates "${value.name}".`,
      );
    }
    seen.add(value.name);
  }
}

function decodeArtifactDiscovery(value: unknown): EdenDiscoveryRecord {
  const field = "discovery.json";
  const record = artifactRecord(value, field);
  assertArtifactKeys(record, ["agent", "instructions", "tools"], [], field);
  if (!Array.isArray(record.tools)) {
    artifactSchemaFailure("discovery.json.tools", "must be an array.");
  }
  return {
    agent: decodeArtifactSourceReference(record.agent, "discovery.json.agent"),
    instructions: decodeArtifactSourceReference(
      record.instructions,
      "discovery.json.instructions",
    ),
    tools: record.tools.map((item, index) =>
      decodeArtifactSourceReference(item, `discovery.json.tools[${index}]`),
    ),
  };
}

function decodeArtifactDiagnostics(value: unknown): readonly EdenDiagnostic[] {
  const field = "diagnostics.json";
  if (!Array.isArray(value)) {
    artifactSchemaFailure(field, "must be an array.");
  }
  return value.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const record = artifactRecord(item, itemField);
    assertArtifactKeys(
      record,
      ["code", "message", "severity"],
      ["source", "line", "column"],
      itemField,
    );
    const severity = record.severity;
    if (severity !== "error" && severity !== "warning" && severity !== "info") {
      artifactSchemaFailure(
        `${itemField}.severity`,
        'must be "error", "warning", or "info".',
      );
    }
    const result: EdenDiagnostic = {
      code: artifactString(record.code, `${itemField}.code`, {
        nonEmpty: true,
      }),
      message: artifactString(record.message, `${itemField}.message`, {
        nonEmpty: true,
      }),
      severity,
    };
    if (hasOwn(record, "source")) {
      (result as { source?: string }).source = artifactString(
        record.source,
        `${itemField}.source`,
        { nonEmpty: true },
      );
    }
    if (hasOwn(record, "line")) {
      (result as { line?: number }).line = artifactSafeInteger(
        record.line,
        `${itemField}.line`,
        { minimum: 1 },
      );
    }
    if (hasOwn(record, "column")) {
      (result as { column?: number }).column = artifactSafeInteger(
        record.column,
        `${itemField}.column`,
        { minimum: 1 },
      );
    }
    return result;
  });
}

function decodeArtifactManifest(value: unknown): EdenManifest {
  const field = "manifest.json";
  const record = artifactRecord(value, field);
  assertArtifactKeys(
    record,
    [
      "kind",
      "version",
      "runtimeVersion",
      "agentBundleVersion",
      "protocolVersion",
      "schemaVersion",
      "agent",
      "instructions",
      "tools",
      "bundleDigest",
    ],
    [],
    field,
  );
  if (record.kind !== "eden.manifest") {
    artifactSchemaFailure(`${field}.kind`, 'must be "eden.manifest".');
  }
  if (record.version !== EDEN_MANIFEST_VERSION) {
    artifactSchemaFailure(
      `${field}.version`,
      `must be "${EDEN_MANIFEST_VERSION}".`,
    );
  }
  if (record.runtimeVersion !== EDEN_RUNTIME_VERSION) {
    artifactSchemaFailure(
      `${field}.runtimeVersion`,
      `must be "${EDEN_RUNTIME_VERSION}".`,
    );
  }
  if (record.agentBundleVersion !== EDEN_AGENT_BUNDLE_VERSION) {
    artifactSchemaFailure(
      `${field}.agentBundleVersion`,
      `must be "${EDEN_AGENT_BUNDLE_VERSION}".`,
    );
  }
  if (record.protocolVersion !== EDEN_PROTOCOL_VERSION) {
    artifactSchemaFailure(
      `${field}.protocolVersion`,
      `must be "${EDEN_PROTOCOL_VERSION}".`,
    );
  }
  if (record.schemaVersion !== EDEN_SCHEMA_VERSION) {
    artifactSchemaFailure(
      `${field}.schemaVersion`,
      `must be ${EDEN_SCHEMA_VERSION}.`,
    );
  }
  if (!Array.isArray(record.tools)) {
    artifactSchemaFailure(`${field}.tools`, "must be an array.");
  }
  const tools = record.tools.map((item, index) =>
    decodeArtifactToolManifest(item, `${field}.tools[${index}]`),
  );
  assertUniqueArtifactNames(tools, `${field}.tools`);
  return {
    kind: "eden.manifest",
    version: EDEN_MANIFEST_VERSION,
    runtimeVersion: EDEN_RUNTIME_VERSION,
    agentBundleVersion: EDEN_AGENT_BUNDLE_VERSION,
    protocolVersion: EDEN_PROTOCOL_VERSION,
    schemaVersion: EDEN_SCHEMA_VERSION,
    agent: decodeArtifactAgent(record.agent, `${field}.agent`),
    instructions: decodeArtifactInstructionManifest(
      record.instructions,
      `${field}.instructions`,
    ),
    tools,
    bundleDigest: artifactSha256(record.bundleDigest, `${field}.bundleDigest`),
  };
}

function decodeArtifactModuleMap(value: unknown): EdenModuleMap {
  const field = "module-map.json";
  const record = artifactRecord(value, field);
  assertArtifactKeys(record, ["kind", "version", "agent", "instructions", "tools"], [], field);
  if (record.kind !== "eden.module-map") {
    artifactSchemaFailure(`${field}.kind`, 'must be "eden.module-map".');
  }
  if (record.version !== EDEN_AGENT_BUNDLE_VERSION) {
    artifactSchemaFailure(
      `${field}.version`,
      `must be "${EDEN_AGENT_BUNDLE_VERSION}".`,
    );
  }
  if (!Array.isArray(record.tools)) {
    artifactSchemaFailure(`${field}.tools`, "must be an array.");
  }
  const tools = record.tools.map((item, index) =>
    decodeArtifactModuleReference(item, `${field}.tools[${index}]`),
  );
  assertUniqueArtifactNames(tools, `${field}.tools`);
  return {
    kind: "eden.module-map",
    version: EDEN_AGENT_BUNDLE_VERSION,
    agent: decodeArtifactModuleReference(record.agent, `${field}.agent`),
    instructions: decodeArtifactModuleReference(
      record.instructions,
      `${field}.instructions`,
    ),
    tools,
  };
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function decodeArtifactBuildMetadata(value: unknown): EdenBuildMetadata {
  const field = "build-metadata.json";
  const record = artifactRecord(value, field);
  assertArtifactKeys(
    record,
    [
      "generationId",
      "createdAt",
      "bundleDigest",
      "manifestVersion",
      "runtimeVersion",
      "agentBundleVersion",
      "protocolVersion",
      "schemaVersion",
      "moduleMapDigest",
    ],
    [],
    field,
  );
  const generationId = artifactString(record.generationId, `${field}.generationId`, {
    nonEmpty: true,
  });
  if (!/^gen_[a-f0-9]{64}$/u.test(generationId)) {
    artifactSchemaFailure(
      `${field}.generationId`,
      "must be a generated Eden identity.",
    );
  }
  const createdAt = artifactString(record.createdAt, `${field}.createdAt`, {
    nonEmpty: true,
  });
  if (!isIsoTimestamp(createdAt)) {
    artifactSchemaFailure(
      `${field}.createdAt`,
      "must be a valid UTC ISO-8601 timestamp.",
    );
  }
  if (record.manifestVersion !== EDEN_MANIFEST_VERSION) {
    artifactSchemaFailure(
      `${field}.manifestVersion`,
      `must be "${EDEN_MANIFEST_VERSION}".`,
    );
  }
  if (record.runtimeVersion !== EDEN_RUNTIME_VERSION) {
    artifactSchemaFailure(
      `${field}.runtimeVersion`,
      `must be "${EDEN_RUNTIME_VERSION}".`,
    );
  }
  if (record.agentBundleVersion !== EDEN_AGENT_BUNDLE_VERSION) {
    artifactSchemaFailure(
      `${field}.agentBundleVersion`,
      `must be "${EDEN_AGENT_BUNDLE_VERSION}".`,
    );
  }
  if (record.protocolVersion !== EDEN_PROTOCOL_VERSION) {
    artifactSchemaFailure(
      `${field}.protocolVersion`,
      `must be "${EDEN_PROTOCOL_VERSION}".`,
    );
  }
  if (record.schemaVersion !== EDEN_SCHEMA_VERSION) {
    artifactSchemaFailure(
      `${field}.schemaVersion`,
      `must be ${EDEN_SCHEMA_VERSION}.`,
    );
  }
  return {
    generationId,
    createdAt,
    bundleDigest: artifactSha256(record.bundleDigest, `${field}.bundleDigest`),
    manifestVersion: EDEN_MANIFEST_VERSION,
    runtimeVersion: EDEN_RUNTIME_VERSION,
    agentBundleVersion: EDEN_AGENT_BUNDLE_VERSION,
    protocolVersion: EDEN_PROTOCOL_VERSION,
    schemaVersion: EDEN_SCHEMA_VERSION,
    moduleMapDigest: artifactSha256(
      record.moduleMapDigest,
      `${field}.moduleMapDigest`,
    ),
  };
}

function assertPublishedArtifactCoherence(
  discovery: EdenDiscoveryRecord,
  diagnostics: readonly EdenDiagnostic[],
  manifest: EdenManifest,
  moduleMap: EdenModuleMap,
  bundle: string,
  buildMetadata: EdenBuildMetadata,
): void {
  if (diagnostics.some((item) => item.severity === "error")) {
    throw new EdenCompilerError("Published diagnostics are not coherent", [
      diagnostic(
        "OUTPUT_INVALID",
        "Error diagnostics prevent a published artifact generation from becoming authoritative.",
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
  let discoveryValue: unknown;
  let diagnosticsValue: unknown;
  let manifestValue: unknown;
  let moduleMapValue: unknown;
  let buildMetadataValue: unknown;
  try {
    discoveryValue = JSON.parse(contents.discovery) as unknown;
    diagnosticsValue = JSON.parse(contents.diagnostics) as unknown;
    manifestValue = JSON.parse(contents.manifest) as unknown;
    moduleMapValue = JSON.parse(contents.moduleMap) as unknown;
    buildMetadataValue = JSON.parse(contents.buildMetadata) as unknown;
  } catch {
    throw new EdenCompilerError("Published artifact JSON is malformed", [
      diagnostic(
        "OUTPUT_INVALID",
        "Every JSON artifact must contain one valid JSON document.",
      ),
    ]);
  }
  const discovery = decodeArtifactDiscovery(discoveryValue);
  const diagnostics = decodeArtifactDiagnostics(diagnosticsValue);
  const manifest = decodeArtifactManifest(manifestValue);
  const moduleMap = decodeArtifactModuleMap(moduleMapValue);
  const buildMetadata = decodeArtifactBuildMetadata(buildMetadataValue);
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
        assertPublishedArtifactCoherence(
          legacy.artifacts.discovery,
          legacy.artifacts.diagnostics,
          legacy.artifacts.manifest,
          legacy.artifacts.moduleMap,
          legacy.artifacts.bundle,
          legacy.artifacts.buildMetadata,
        );
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
    const stagedContents = {
      discovery: await readFile(
        join(stage, ARTIFACT_FILE_NAMES.discovery),
        "utf8",
      ),
      diagnostics: await readFile(
        join(stage, ARTIFACT_FILE_NAMES.diagnostics),
        "utf8",
      ),
      manifest: await readFile(
        join(stage, ARTIFACT_FILE_NAMES.manifest),
        "utf8",
      ),
      moduleMap: await readFile(
        join(stage, ARTIFACT_FILE_NAMES.moduleMap),
        "utf8",
      ),
      bundle: await readFile(join(stage, ARTIFACT_FILE_NAMES.bundle), "utf8"),
      buildMetadata: await readFile(
        join(stage, ARTIFACT_FILE_NAMES.buildMetadata),
        "utf8",
      ),
    } satisfies PublishedArtifactContents;
    decodePublishedArtifactSet(stagedContents);
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
    const verifiedZodDependency = isTrustedWorkerDependency(
      [...snapshot.files.values()],
      `${TRUSTED_ZOD_PACKAGE.root}/package.json`,
    );
    const bundle = await bundleProject(
      normalized,
      moduleMap,
      verifiedZodDependency,
    );
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

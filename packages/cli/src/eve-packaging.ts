import {
  createHash,
} from "node:crypto";
import {
  execFile,
} from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  promisify,
} from "node:util";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const execFileAsync = promisify(execFile);

export type EvePackagingCode =
  | "ROOT_INVALID"
  | "UNSUPPORTED_TOOLCHAIN"
  | "DEPENDENCY_AMBIGUITY"
  | "SOURCE_RACE"
  | "EVE_BUILD_FAILED"
  | "UNSUPPORTED_EVE_OUTPUT"
  | "SECRET_EXCLUSION_FAILED"
  | "DOCKER_PLATFORM_BLOCKED"
  | "CLEANUP_UNVERIFIED"
  | "PACKAGE_VERIFICATION_FAILED";

export interface EveRuntimeConfigExclusion {
  /**
   * This path is opaque. The packaging worker only uses its lexical identity
   * to exclude it from a copied snapshot and never opens or stats it.
   */
  readonly envFilePath?: string;
  /**
   * The deployment-safety seam owns this identity. It may represent the
   * explicit env file and parsed runtime configuration without exposing values.
   */
  readonly inputIdentity?: string;
  readonly readInputIdentity?: () => string | Promise<string>;
  readonly variableNames?: readonly string[];
  readonly redactionRegistered?: boolean;
}

export interface EveNodeImage {
  readonly reference: string;
  readonly digest: string;
}

export interface EveProjectBuilderRequest {
  readonly generationRoot: string;
  readonly snapshotRoot: string;
  readonly inputManifestPath: string;
  readonly dockerfilePath: string | undefined;
  readonly packageManagerVersion: string;
  readonly installCommand: readonly [
    "corepack",
    "pnpm",
    "install",
    "--frozen-lockfile",
  ];
  readonly buildCommand: readonly ["./node_modules/.bin/eve", "build"];
  readonly platform: "linux/amd64";
  readonly sourceDigest: string;
  /**
   * The builder must execute only from this Eden-owned immutable snapshot.
   * It is metadata for builders and test seams, not a permission to read the
   * authored project root.
   */
  readonly buildContext: "immutable-snapshot";
}

export interface EveProjectBuilderResult {
  readonly eveVersion?: string;
  readonly imageId?: string;
  readonly imagePlatform?: "linux/amd64";
  readonly imageReference?: string;
  readonly imageDigest?: string;
}

export interface EveProjectBuilder {
  readonly nodeImage?: EveNodeImage;
  build(request: EveProjectBuilderRequest): Promise<EveProjectBuilderResult>;
  discard?(result: EveProjectBuilderResult): Promise<void>;
}

export interface EveProjectSnapshotOptions {
  readonly projectRoot: string;
  /**
   * This must identify one new Eden-owned generation directory. The function
   * refuses an existing directory and never writes to a prior generation.
   */
  readonly artifactRoot: string;
  readonly builder: EveProjectBuilder;
  readonly runtimeConfig?: EveRuntimeConfigExclusion;
  readonly nodeImage?: EveNodeImage;
}

export interface EveProjectFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mode: number;
}

export interface EveProjectInputManifest {
  readonly version: 1;
  readonly requestedRoot: string;
  readonly canonicalRoot: string;
  readonly projectId: string;
  readonly packageManager: "pnpm";
  readonly packageManagerVersion: string;
  readonly packageJsonSha256: string;
  readonly lockfileSha256: string;
  readonly sourceDigest: string;
  readonly files: readonly EveProjectFile[];
  readonly excludedRelativePaths: readonly string[];
  readonly runtimeConfigInputIdentity?: string;
  readonly runtimeVariableNames: readonly string[];
}

export interface EveProjectSnapshot {
  readonly generationId: string;
  readonly path: string;
  readonly sha256: string;
  readonly includedFileCount: number;
  readonly excludedCategories: readonly string[];
  readonly sourceRaceChecked: boolean;
}

export interface EveProjectOutput {
  readonly entrypointPath: ".output/server/index.mjs";
  readonly sha256: string;
  readonly regularFile: true;
  readonly symlinkEscape: false;
  readonly outputDigest: string;
  readonly fileCount: number;
}

export interface EveProjectBuildCandidate {
  readonly generationId: string;
  readonly generationRoot: string;
  readonly snapshotRoot: string;
  readonly inputManifestPath: string;
  readonly packageManager: "pnpm";
  readonly packageManagerVersion: string;
  readonly installCommand: readonly [
    "corepack",
    "pnpm",
    "install",
    "--frozen-lockfile",
  ];
  readonly buildCommand: readonly ["./node_modules/.bin/eve", "build"];
  readonly eveExecutable: "node_modules/.bin/eve";
  readonly eveVersion: string;
  readonly packageJsonSha256: string;
  readonly lockfileSha256: string;
  readonly sourceDigest: string;
  readonly snapshotDigest: string;
  readonly generatedOutput: EveProjectOutput;
  readonly runtimeConfigInputIdentity?: string;
  readonly runtimeVariableNames: readonly string[];
}

export interface EveProjectToolchain {
  readonly nodeVersion: "24.17.0";
  readonly packageManager: "pnpm";
  readonly packageManagerVersion: string;
  readonly installCommand: readonly [
    "corepack",
    "pnpm",
    "install",
    "--frozen-lockfile",
  ];
  readonly buildCommand: readonly ["./node_modules/.bin/eve", "build"];
  readonly startCommand: readonly [
    "./node_modules/.bin/eve",
    "start",
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
  ];
  readonly eveExecutable: "node_modules/.bin/eve";
  readonly eveVersion: string;
  readonly lockfileUnchanged: true;
  readonly nativeBuildPlatform: "linux/amd64";
}

export interface EveProjectImage {
  readonly dockerfilePath: string | null;
  readonly platform: "linux/amd64";
  readonly builderImage: string | null;
  readonly runtimeImage: string | null;
  readonly imageId: string | null;
  readonly imageReference: string | null;
  readonly imageDigest: string | null;
  readonly launchCommand: readonly [
    "./node_modules/.bin/eve",
    "start",
    "--host",
    "0.0.0.0",
    "--port",
    "8080",
  ];
  readonly workingDirectory: "/app";
  readonly hostEnvironment: {
    readonly HOST: "0.0.0.0";
    readonly NITRO_HOST: "0.0.0.0";
    readonly PORT: "8080";
    readonly NITRO_PORT: "8080";
    readonly NODE_ENV: "production";
  };
  readonly generatedOutput: EveProjectOutput | null;
}

export interface EveProjectRuntime {
  readonly listenHost: "0.0.0.0";
  readonly listenPort: 8080;
  readonly healthMethod: "GET";
  readonly healthPath: "/eve/v1/health";
  readonly healthStatus: "not-run";
  readonly healthVerified: false;
  readonly durableLocalFilesystemClaim: false;
}

export interface EveProjectSecretsEvidence {
  readonly runtimeVariableNames: readonly string[];
  readonly valuesRecorded: false;
  readonly excludedFromSnapshot: true;
  readonly excludedFromBuildEnvironment: true;
  readonly excludedFromDockerContext: true;
  readonly excludedFromImage: true;
  readonly excludedFromHistory: true;
  readonly excludedFromManifestsAndLogs: true;
  readonly redactionRegisteredBeforeChildren: boolean;
}

export interface EvePackagingCheck {
  readonly id: string;
  readonly status: "pass" | "blocked";
  readonly subject: string;
  readonly reason: string;
  readonly remediation: string | null;
}

export interface EveProjectPackagingResult {
  readonly schemaVersion: 1;
  readonly worker: "eve-packaging-worker";
  readonly operation: "local-package";
  readonly status: "ready" | "blocked" | "failed";
  readonly returnCode: EvePackagingCode | "EVE_PACKAGE_READY";
  readonly deployable: boolean;
  readonly project: {
    readonly requestedRoot: string;
    readonly canonicalRoot: string;
    readonly projectId: string;
    readonly packageJson: {
      readonly path: "package.json";
      readonly sha256: string;
    };
    readonly lockfile: {
      readonly path: "pnpm-lock.yaml";
      readonly sha256: string;
    };
    readonly sourceDigest: string;
    readonly inputManifestPath: string;
  } | null;
  readonly candidate: EveProjectBuildCandidate | null;
  readonly snapshot: EveProjectSnapshot | null;
  readonly toolchain: EveProjectToolchain | null;
  readonly image: EveProjectImage | null;
  readonly runtime: EveProjectRuntime | null;
  readonly secrets: EveProjectSecretsEvidence;
  readonly checks: readonly EvePackagingCheck[];
  readonly candidateImageId: string | null;
  readonly candidateImageRetainedLocally: boolean;
  readonly writtenPaths: readonly string[];
  readonly error: {
    readonly code: EvePackagingCode;
    readonly subject: string;
    readonly reason: string;
    readonly remediation: string;
  } | null;
}

export class EvePackagingError extends Error {
  readonly code: EvePackagingCode;
  readonly subject: string;
  readonly remediation: string;

  constructor(options: {
    readonly code: EvePackagingCode;
    readonly subject: string;
    readonly reason: string;
    readonly remediation: string;
  }) {
    super(options.reason);
    this.name = "EvePackagingError";
    this.code = options.code;
    this.subject = options.subject;
    this.remediation = options.remediation;
  }
}

const INSTALL_COMMAND = [
  "corepack",
  "pnpm",
  "install",
  "--frozen-lockfile",
] as const;
const BUILD_COMMAND = ["./node_modules/.bin/eve", "build"] as const;
const START_COMMAND = [
  "./node_modules/.bin/eve",
  "start",
  "--host",
  "0.0.0.0",
  "--port",
  "8080",
] as const;
const EVE_ENTRYPOINT = ".output/server/index.mjs" as const;
const EVE_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".eden",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".cache",
  ".npm",
  ".yarn",
  ".output",
  ".turbo",
  ".wrangler",
  "coverage",
  "node_modules",
]);
const EVE_EXCLUDED_FILE_NAMES = new Set([
  ".DS_Store",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".bunfig.toml",
  ".yarnrc",
  ".yarnrc.yml",
  "credentials.json",
  "service-account.json",
]);
const EVE_COMPETING_LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "yarn.lock",
]);
const HOST_ENVIRONMENT = {
  HOST: "0.0.0.0",
  NITRO_HOST: "0.0.0.0",
  PORT: "8080",
  NITRO_PORT: "8080",
  NODE_ENV: "production",
} as const;

interface CapturedFile extends EveProjectFile {
  readonly bytes: Buffer;
}

interface CapturedInputs {
  readonly files: readonly CapturedFile[];
  readonly excludedRelativePaths: readonly string[];
  readonly sourceDigest: string;
}

interface ProjectContract {
  readonly projectId: string;
  readonly packageManagerVersion: string;
  readonly packageJsonSha256: string;
  readonly lockfileSha256: string;
  readonly lockfileBytes: Buffer;
}

interface StableFile {
  readonly bytes: Buffer;
  readonly mode: number;
  readonly sha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}/`);
}

function safeRelativePath(root: string, candidate: string): string {
  return relative(root, candidate).split("\\").join("/");
}

function isAllowedSystemAlias(path: string): boolean {
  const normalized = resolve(path);
  return normalized === "/var" || normalized === "/tmp";
}

function isPathExcluded(
  relativePath: string,
  runtimeEnvRelativePath: string | undefined,
): { readonly excluded: boolean; readonly category: string | undefined } {
  const parts = relativePath.split("/");
  const name = parts[parts.length - 1];
  const excludedDirectory = parts.find((part) =>
    EVE_EXCLUDED_DIRECTORY_NAMES.has(part)
  );
  if (excludedDirectory !== undefined) {
    return {
      excluded: true,
      category: excludedDirectory === ".eden" || excludedDirectory === ".git"
        ? "generated-state"
        : excludedDirectory === "node_modules"
          ? "node_modules"
          : "build-cache",
    };
  }
  if (runtimeEnvRelativePath !== undefined && relativePath === runtimeEnvRelativePath) {
    return { excluded: true, category: "runtime-env" };
  }
  if (name !== undefined && name.startsWith(".env")) {
    return { excluded: true, category: "runtime-env" };
  }
  if (
    (name !== undefined && EVE_EXCLUDED_FILE_NAMES.has(name)) ||
    (name !== undefined && (name.endsWith(".pem") || name.endsWith(".key")))
  ) {
    return { excluded: true, category: "credentials" };
  }
  if (
    name !== undefined &&
    (name.endsWith(".swp") || name.endsWith(".swo") || name.endsWith(".tmp"))
  ) {
    return { excluded: true, category: "temporary-state" };
  }
  return { excluded: false, category: undefined };
}

async function readStableFile(path: string): Promise<StableFile> {
  const before = await lstat(path).catch(() => undefined);
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink()
  ) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: safeRelativePath(dirname(path), path),
      reason: "The Eve build input is missing, symlinked, or not a regular file.",
      remediation: "Replace the input with a readable regular file inside the selected project root.",
    });
  }
  const bytes = await readFile(path);
  const secondRead = await readFile(path).catch(() => undefined);
  const after = await lstat(path).catch(() => undefined);
  if (
    secondRead === undefined ||
    !bytes.equals(secondRead) ||
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode
  ) {
    throw new EvePackagingError({
      code: "SOURCE_RACE",
      subject: basename(path),
      reason: "An Eve build input changed while it was being observed.",
      remediation: "Retry only after the selected project and its lockfile are quiescent.",
    });
  }
  return {
    bytes,
    mode: before.mode & 0o777,
    sha256: sha256(bytes),
  };
}

async function captureInputs(
  root: string,
  runtimeConfig: EveRuntimeConfigExclusion | undefined,
  artifactRoot: string,
  runtimeInputIdentity = runtimeConfig?.inputIdentity,
  requestedRoot = root,
): Promise<CapturedInputs> {
  const runtimeEnvRelativePath = (() => {
    if (runtimeConfig?.envFilePath === undefined) return undefined;
    const candidate = resolve(runtimeConfig.envFilePath);
    if (isWithin(root, candidate)) return safeRelativePath(root, candidate);
    if (isWithin(resolve(requestedRoot), candidate)) {
      return safeRelativePath(resolve(requestedRoot), candidate);
    }
    return undefined;
  })();
  const files: CapturedFile[] = [];
  const excludedRelativePaths: string[] = [];

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const candidate = join(directory, entry.name);
      const absoluteCandidate = resolve(candidate);
      if (isWithin(artifactRoot, absoluteCandidate)) {
        excludedRelativePaths.push(relativePath);
        continue;
      }
      const exclusion = isPathExcluded(relativePath, runtimeEnvRelativePath);
      if (exclusion.excluded) {
        excludedRelativePaths.push(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new EvePackagingError({
          code: relativePath === "pnpm-lock.yaml"
            ? "DEPENDENCY_AMBIGUITY"
            : "ROOT_INVALID",
          subject: relativePath,
          reason: relativePath === "pnpm-lock.yaml"
            ? "The root pnpm-lock.yaml must be a regular file, not a symbolic link."
            : "Eve build inputs may not contain symbolic links.",
          remediation: relativePath === "pnpm-lock.yaml"
            ? "Copy the matching lockfile into the selected project root and retry."
            : "Copy the file into the selected project root and retry.",
        });
      }
      if (entry.isDirectory()) {
        await visit(candidate, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new EvePackagingError({
          code: "ROOT_INVALID",
          subject: relativePath,
          reason: "Eve build inputs may not contain devices, sockets, FIFOs, or other special files.",
          remediation: "Remove the special file from the selected project inputs and retry.",
        });
      }
      let stable: StableFile;
      try {
        stable = await readStableFile(candidate);
      } catch (error: unknown) {
        if (
          relativePath === "pnpm-lock.yaml" &&
          error instanceof EvePackagingError &&
          error.code === "ROOT_INVALID"
        ) {
          throw new EvePackagingError({
            code: "DEPENDENCY_AMBIGUITY",
            subject: relativePath,
            reason: "The root pnpm-lock.yaml is unreadable or changed while it was observed.",
            remediation: "Provide one readable regular lockfile generated by the declared exact pnpm version.",
          });
        }
        throw error;
      }
      files.push({
        relativePath,
        sha256: stable.sha256,
        byteLength: stable.bytes.byteLength,
        mode: stable.mode,
        bytes: stable.bytes,
      });
    }
  };

  await visit(root, "");
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  excludedRelativePaths.sort();
  const sourceDigest = sha256(jsonBytes({
    files: files.map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      byteLength: file.byteLength,
      mode: file.mode,
    })),
    runtimeConfigInputIdentity: runtimeInputIdentity,
  }));
  return {
    files,
    excludedRelativePaths,
    sourceDigest,
  };
}

function sourceInputsEqual(
  left: CapturedInputs,
  right: CapturedInputs,
): boolean {
  if (left.sourceDigest !== right.sourceDigest) return false;
  if (left.files.length !== right.files.length) return false;
  return left.files.every((file, index) => {
    const other = right.files[index];
    return other !== undefined &&
      file.relativePath === other.relativePath &&
      file.sha256 === other.sha256 &&
      file.byteLength === other.byteLength &&
      file.mode === other.mode;
  });
}

function parsePnpmVersion(packageManager: unknown): string {
  if (typeof packageManager !== "string") {
    throw new EvePackagingError({
      code: "UNSUPPORTED_TOOLCHAIN",
      subject: "package.json.packageManager",
      reason: "The Eve MVP requires packageManager to pin an exact pnpm version.",
      remediation: 'Set package.json.packageManager to an exact value such as "pnpm@11.21.0".',
    });
  }
  const match = /^pnpm@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u.exec(
    packageManager,
  );
  if (match === null) {
    throw new EvePackagingError({
      code: "UNSUPPORTED_TOOLCHAIN",
      subject: "package.json.packageManager",
      reason: "The Eve MVP supports only an exact pnpm@<major>.<minor>.<patch> pin.",
      remediation: 'Replace ranges, tags, and other package managers with an exact pnpm pin.',
    });
  }
  return match[1] as string;
}

function lockfileMajor(lockfile: Buffer): number | undefined {
  const text = lockfile.toString("utf8");
  const match = /^\s*lockfileVersion:\s*['"]?([0-9]+)(?:\.[0-9]+)?['"]?\s*$/mu.exec(text);
  return match === null ? undefined : Number(match[1]);
}

function lockfileMatchesPnpm(version: string, lockfile: Buffer): boolean {
  const [majorText] = version.split(".");
  const pnpmMajor = Number(majorText);
  const declaredLockfileMajor = lockfileMajor(lockfile);
  if (declaredLockfileMajor === undefined) return false;
  if (pnpmMajor >= 9) return declaredLockfileMajor === 9;
  if (pnpmMajor >= 7) return declaredLockfileMajor === 6;
  return declaredLockfileMajor === 5;
}

function packageJsonObject(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "package.json",
      reason: "The selected package.json is not valid JSON.",
      remediation: "Fix package.json and retry with the same explicit project root.",
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "package.json",
      reason: "The selected package.json must contain a JSON object.",
      remediation: "Provide a regular Eve project manifest with a non-empty name.",
    });
  }
  return parsed as Record<string, unknown>;
}

function validateProjectContract(inputs: CapturedInputs): ProjectContract {
  const packageFile = inputs.files.find((file) => file.relativePath === "package.json");
  if (packageFile === undefined) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "package.json",
      reason: "The selected Eve project root must contain a regular package.json.",
      remediation: "Select the actual Eve application root instead of an ancestor or nested directory.",
    });
  }
  const packageValue = packageJsonObject(packageFile.bytes);
  const projectId = packageValue.name;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "package.json.name",
      reason: "The selected package.json must define a non-empty project identity.",
      remediation: "Add a non-empty package.json name and retry.",
    });
  }
  const packageManagerVersion = parsePnpmVersion(packageValue.packageManager);
  const lockFiles = inputs.files.filter((file) =>
    file.relativePath === "pnpm-lock.yaml" ||
    file.relativePath.endsWith("/pnpm-lock.yaml")
  );
  if (lockFiles.length !== 1 || lockFiles[0]?.relativePath !== "pnpm-lock.yaml") {
    throw new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "pnpm-lock.yaml",
      reason: "The selected Eve root must contain exactly one regular root pnpm-lock.yaml.",
      remediation: "Remove competing or nested lockfiles and retry with the matching root lockfile.",
    });
  }
  const competing = inputs.files.find((file) =>
    EVE_COMPETING_LOCKFILES.has(basename(file.relativePath))
  );
  if (competing !== undefined) {
    throw new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: competing.relativePath,
      reason: "A competing package-manager lockfile was found at the selected Eve root.",
      remediation: "Keep only the pinned pnpm toolchain and its matching root lockfile.",
    });
  }
  const lockfile = lockFiles[0];
  if (lockfile === undefined || !lockfileMatchesPnpm(packageManagerVersion, lockfile.bytes)) {
    throw new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "pnpm-lock.yaml",
      reason: "The root pnpm-lock.yaml is malformed or does not match the exact packageManager pin.",
      remediation: "Regenerate the lockfile with the declared pnpm version, without changing it during packaging.",
    });
  }
  return {
    projectId,
    packageManagerVersion,
    packageJsonSha256: packageFile.sha256,
    lockfileSha256: lockfile.sha256,
    lockfileBytes: lockfile.bytes,
  };
}

async function assertCanonicalRoot(projectRoot: string): Promise<{
  readonly requestedRoot: string;
  readonly canonicalRoot: string;
}> {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "project",
      reason: "The Eve project root must be an explicit non-empty path.",
      remediation: "Pass the canonical application directory explicitly.",
    });
  }
  const requestedRoot = isAbsolute(projectRoot)
    ? resolve(projectRoot)
    : resolve(process.cwd(), projectRoot);
  const details = await lstat(requestedRoot).catch(() => undefined);
  if (
    details === undefined ||
    !details.isDirectory() ||
    details.isSymbolicLink()
  ) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "project",
      reason: "The selected Eve project root must be an existing canonical directory.",
      remediation: "Pass the actual readable application directory, not a file, symlink, ancestor, or missing path.",
    });
  }
  const canonicalRoot = await realpath(requestedRoot).catch(() => undefined);
  if (canonicalRoot === undefined) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "project",
      reason: "The selected Eve project root is not canonical.",
      remediation: "Resolve the path and pass the real directory explicitly.",
    });
  }
  await readdir(canonicalRoot).catch(() => {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "project",
      reason: "The selected Eve project root is not readable.",
      remediation: "Grant read access to the explicit project root and retry.",
    });
  });
  return { requestedRoot, canonicalRoot };
}

async function assertRequiredRootInputs(root: string): Promise<void> {
  const packageDetails = await lstat(join(root, "package.json")).catch(() => undefined);
  if (
    packageDetails === undefined ||
    !packageDetails.isFile() ||
    packageDetails.isSymbolicLink()
  ) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "package.json",
      reason: "The selected Eve root must contain a regular package.json before any build input is walked.",
      remediation: "Select the actual Eve application root instead of an ancestor or nested directory.",
    });
  }
}

async function prepareOutputParentChain(
  path: string,
): Promise<string> {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let current = absolute.startsWith("/") ? "/" : "";
  let missingStart = parts.length;
  for (const [index, part] of parts.entries()) {
    const candidate = current === "/" ? `/${part}` : join(current, part);
    const details = await lstat(candidate).catch(() => undefined);
    if (details === undefined) {
      missingStart = index;
      break;
    }
    if (details.isSymbolicLink()) {
      if (!isAllowedSystemAlias(candidate)) {
        throw new EvePackagingError({
          code: "ROOT_INVALID",
          subject: path,
          reason: "The Eden-owned artifact parent contains an unsafe symbolic link.",
          remediation: "Use a regular artifact directory and retry.",
        });
      }
      current = candidate;
      continue;
    }
    if (!details.isDirectory()) {
      throw new EvePackagingError({
        code: "ROOT_INVALID",
        subject: path,
        reason: "The Eden-owned artifact parent is not a directory.",
        remediation: "Choose a writable regular artifact parent and retry.",
      });
    }
    current = candidate;
  }
  const canonicalBase = await realpath(current).catch(() => undefined);
  if (canonicalBase === undefined) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: path,
      reason: "The Eden-owned artifact parent could not be resolved safely.",
      remediation: "Choose a writable artifact parent and retry.",
    });
  }
  if (missingStart === parts.length) return canonicalBase;
  let created = canonicalBase;
  for (const part of parts.slice(missingStart)) {
    created = join(created, part);
    await mkdir(created);
    const details = await lstat(created).catch(() => undefined);
    const canonicalCreated = await realpath(created).catch(() => undefined);
    if (
      details === undefined ||
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      canonicalCreated !== created
    ) {
      throw new EvePackagingError({
        code: "ROOT_INVALID",
        subject: path,
        reason: "The Eden-owned artifact parent could not be created as regular directories.",
        remediation: "Choose a writable artifact parent and retry.",
      });
    }
  }
  return created;
}

async function createGenerationRoot(
  artifactRoot: string,
  projectRoot: string,
): Promise<string> {
  const generationRoot = resolve(artifactRoot);
  if (generationRoot === projectRoot) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "artifactRoot",
      reason: "Generated Eve artifacts may not overwrite the selected project root.",
      remediation: "Use a new Eden-owned generation directory outside authored source.",
    });
  }
  if (isWithin(projectRoot, generationRoot)) {
    const first = safeRelativePath(projectRoot, generationRoot).split("/")[0];
    if (first !== ".eden") {
      throw new EvePackagingError({
        code: "ROOT_INVALID",
        subject: "artifactRoot",
        reason: "Generated Eve artifacts may only be nested under the project-local .eden directory.",
        remediation: "Use .eden/eve-deploy/generations/<new-id> or an external Eden-owned directory.",
      });
    }
  }
  const parent = dirname(generationRoot);
  const canonicalParent = await prepareOutputParentChain(parent);
  const canonicalGenerationRoot = join(canonicalParent, basename(generationRoot));
  if (isWithin(projectRoot, canonicalGenerationRoot)) {
    const first = safeRelativePath(projectRoot, canonicalGenerationRoot).split("/")[0];
    if (first !== ".eden") {
      throw new EvePackagingError({
        code: "ROOT_INVALID",
        subject: "artifactRoot",
        reason: "The resolved Eden artifact path would overwrite authored project files.",
        remediation: "Use a generation directory under .eden or outside the canonical project root.",
      });
    }
  }
  const existing = await lstat(canonicalGenerationRoot).catch(() => undefined);
  if (existing !== undefined) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "artifactRoot",
      reason: "The requested Eve generation directory already exists.",
      remediation: "Create a new generation directory and preserve the prior generation.",
    });
  }
  await mkdir(canonicalGenerationRoot);
  const created = await lstat(canonicalGenerationRoot).catch(() => undefined);
  if (
    created === undefined ||
    !created.isDirectory() ||
    created.isSymbolicLink()
  ) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "artifactRoot",
      reason: "The Eden-owned generation directory could not be created safely.",
      remediation: "Choose a writable regular directory and retry.",
    });
  }
  return canonicalGenerationRoot;
}

async function copySnapshot(
  snapshotRoot: string,
  inputs: CapturedInputs,
): Promise<void> {
  for (const file of inputs.files) {
    const destination = join(snapshotRoot, file.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { mode: file.mode });
    await chmod(destination, file.mode).catch(() => undefined);
    const copied = await readStableFile(destination);
    if (copied.sha256 !== file.sha256 || copied.bytes.byteLength !== file.byteLength) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: file.relativePath,
        reason: "The immutable Eve snapshot did not retain the observed input bytes.",
        remediation: "Retry after the selected project is quiescent.",
      });
    }
  }
}

async function verifySnapshotInputs(
  snapshotRoot: string,
  inputs: CapturedInputs,
): Promise<void> {
  const generatedRoots = new Set([".dockerignore", ".output", "node_modules"]);
  const observedInputPaths: string[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const firstSegment = relativePath.split("/")[0];
      if (firstSegment !== undefined && generatedRoots.has(firstSegment)) {
        continue;
      }
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new EvePackagingError({
            code: "SOURCE_RACE",
            subject: relativePath,
            reason: "The immutable Eve snapshot gained an unsafe or unsupported input.",
            remediation: "Discard the mixed-generation candidate and retry from quiescent source bytes.",
          });
        }
        observedInputPaths.push(relativePath);
        continue;
      }
      await visit(candidate, relativePath);
    }
  };
  await visit(snapshotRoot, "");
  const expectedInputPaths = inputs.files.map((file) => file.relativePath).sort();
  observedInputPaths.sort();
  if (
    observedInputPaths.length !== expectedInputPaths.length ||
    observedInputPaths.some((path, index) => path !== expectedInputPaths[index])
  ) {
    throw new EvePackagingError({
      code: "SOURCE_RACE",
      subject: "snapshot input set",
      reason: "The immutable Eve snapshot gained or lost authored input paths during installation or build.",
      remediation: "Discard the mixed-generation candidate and retry from quiescent source bytes.",
    });
  }
  for (const file of inputs.files) {
    try {
      const observed = await readStableFile(join(snapshotRoot, file.relativePath));
      if (
        observed.sha256 !== file.sha256 ||
        observed.bytes.byteLength !== file.byteLength ||
        observed.mode !== file.mode
      ) {
        throw new EvePackagingError({
          code: "SOURCE_RACE",
          subject: file.relativePath,
          reason: "The immutable Eve snapshot changed during installation or build.",
          remediation: "Discard the mixed-generation candidate and retry from quiescent source bytes.",
        });
      }
    } catch (error: unknown) {
      if (error instanceof EvePackagingError) {
        if (error.code === "SOURCE_RACE") throw error;
        throw new EvePackagingError({
          code: "SOURCE_RACE",
          subject: file.relativePath,
          reason: "The immutable Eve snapshot changed during installation or build.",
          remediation: "Discard the mixed-generation candidate and retry from quiescent source bytes.",
        });
      }
      throw error;
    }
  }
}

async function snapshotDigest(snapshotRoot: string): Promise<string> {
  const files: Array<{ readonly relativePath: string; readonly sha256: string; readonly byteLength: number }> = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(candidate).catch(() => undefined);
        if (
          resolved === undefined ||
          !isWithin(snapshotRoot, resolve(resolved))
        ) {
          throw new EvePackagingError({
            code: "SOURCE_RACE",
            subject: relativePath,
            reason: "The immutable Eve snapshot contains a symbolic link that escapes its dependency tree.",
            remediation: "Discard the candidate and retry from a clean project snapshot.",
          });
        }
        files.push({
          relativePath,
          sha256: `link:${await readlink(candidate)}`,
          byteLength: 0,
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(candidate, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new EvePackagingError({
          code: "SOURCE_RACE",
          subject: relativePath,
          reason: "The immutable Eve snapshot contains an unsupported file type.",
          remediation: "Discard the candidate and retry from a regular-file project tree.",
        });
      }
      const stable = await readStableFile(candidate);
      files.push({
        relativePath,
        sha256: stable.sha256,
        byteLength: stable.bytes.byteLength,
      });
    }
  };
  await visit(snapshotRoot, "");
  return sha256(jsonBytes(files));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, jsonBytes(value), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function writeDockerBuildFiles(options: {
  readonly snapshotRoot: string;
  readonly dockerfilePath: string;
  readonly nodeImage: EveNodeImage;
  readonly packageManagerVersion: string;
  readonly lockfileSha256: string;
}): Promise<void> {
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(options.nodeImage.digest) ||
    !/^node:24\.17\.0(?:-[a-z0-9][a-z0-9._-]*)?$/u.test(options.nodeImage.reference)
  ) {
    throw new EvePackagingError({
      code: "DOCKER_PLATFORM_BLOCKED",
      subject: "node-24-image",
      reason: "The Linux/amd64 builder requires an immutable Node 24 image digest.",
      remediation: "Supply a verified Node 24 image reference and sha256 digest.",
    });
  }
  const image = `${options.nodeImage.reference}@${options.nodeImage.digest}`;
  const dockerfile = `# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 ${image} AS builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \\
  && corepack prepare pnpm@${options.packageManagerVersion} --activate \\
  && test "$(corepack pnpm --version)" = "${options.packageManagerVersion}" \\
  && test "$(sha256sum pnpm-lock.yaml | cut -d ' ' -f1)" = "${options.lockfileSha256}" \\
  && corepack pnpm install --frozen-lockfile
RUN test "$(sha256sum pnpm-lock.yaml | cut -d ' ' -f1)" = "${options.lockfileSha256}"
COPY . ./
RUN test -x ./node_modules/.bin/eve \\
  && ./node_modules/.bin/eve build

FROM builder AS runtime-deps
RUN corepack pnpm prune --prod

FROM --platform=linux/amd64 ${image} AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 \\
    NITRO_HOST=0.0.0.0 \\
    PORT=8080 \\
    NITRO_PORT=8080 \\
    NODE_ENV=production
COPY --from=builder /workspace/.output /app/.output
COPY --from=runtime-deps /workspace/node_modules /app/node_modules
EXPOSE 8080
ENTRYPOINT ["./node_modules/.bin/eve", "start", "--host", "0.0.0.0", "--port", "8080"]
`;
  const dockerignore = `node_modules
.output
.eden
.git
.env*
.npmrc
.yarnrc*
*.pem
*.key
`;
  await writeFile(options.dockerfilePath, dockerfile, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(options.snapshotRoot, ".dockerignore"), dockerignore, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function resolveProjectLocalEve(
  snapshotRoot: string,
): Promise<{ readonly version: string; readonly path: string }> {
  const binPath = join(snapshotRoot, "node_modules/.bin/eve");
  const binDetails = await lstat(binPath).catch(() => undefined);
  if (
    binDetails === undefined ||
    (!binDetails.isFile() && !binDetails.isSymbolicLink())
  ) {
    throw new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "node_modules/.bin/eve",
      reason: "The installed project-local Eve executable is missing.",
      remediation: "Declare Eve in the project dependencies and use the frozen pnpm install.",
    });
  }
  const resolved = await realpath(binPath).catch(() => undefined);
  const nodeModulesRoot = resolve(join(snapshotRoot, "node_modules"));
  if (
    resolved === undefined ||
    !isWithin(nodeModulesRoot, resolve(resolved))
  ) {
    throw new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "node_modules/.bin/eve",
      reason: "The Eve executable resolves outside the isolated project dependency tree.",
      remediation: "Remove the global or escaping Eve executable and install Eve locally.",
    });
  }
  const resolvedDetails = await lstat(resolved).catch(() => undefined);
  if (
    resolvedDetails === undefined ||
    !resolvedDetails.isFile() ||
    (resolvedDetails.mode & 0o111) === 0
  ) {
    throw new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "node_modules/.bin/eve",
      reason: "The project-local Eve executable is not a readable executable file.",
      remediation: "Install a regular executable Eve package through the pinned lockfile and retry.",
    });
  }
  let current = dirname(resolved);
  while (isWithin(nodeModulesRoot, current) && current !== nodeModulesRoot) {
    const packagePath = join(current, "package.json");
    const packageDetails = await lstat(packagePath).catch(() => undefined);
    if (packageDetails?.isFile() === true && !packageDetails.isSymbolicLink()) {
      let packageValue: unknown;
      try {
        packageValue = JSON.parse((await readFile(packagePath)).toString("utf8")) as unknown;
      } catch {
        packageValue = undefined;
      }
      if (
        typeof packageValue === "object" &&
        packageValue !== null &&
        !Array.isArray(packageValue) &&
        (packageValue as { readonly name?: unknown }).name === "eve" &&
        typeof (packageValue as { readonly version?: unknown }).version === "string" &&
        (packageValue as { readonly version: string }).version.length > 0
      ) {
        return {
          version: (packageValue as { readonly version: string }).version,
          path: "node_modules/.bin/eve",
        };
      }
    }
    current = dirname(current);
  }
  throw new EvePackagingError({
    code: "DEPENDENCY_AMBIGUITY",
    subject: "node_modules/.bin/eve",
    reason: "The project-local Eve executable has no readable installed package version.",
    remediation: "Install Eve through the pinned lockfile and retry.",
  });
}

async function scanGeneratedOutput(
  snapshotRoot: string,
): Promise<EveProjectOutput> {
  const readGeneratedFile = async (
    path: string,
    subject: string,
  ): Promise<StableFile> => {
    try {
      return await readStableFile(path);
    } catch {
      throw new EvePackagingError({
        code: "UNSUPPORTED_EVE_OUTPUT",
        subject,
        reason: "The generated Eve output is unreadable or changed during validation.",
        remediation: "Regenerate the Eve output inside the immutable snapshot and retry.",
      });
    }
  };
  const outputRoot = join(snapshotRoot, ".output");
  const outputDetails = await lstat(outputRoot).catch(() => undefined);
  const outputCanonical = await realpath(outputRoot).catch(() => undefined);
  if (
    outputDetails === undefined ||
    !outputDetails.isDirectory() ||
    outputDetails.isSymbolicLink() ||
    outputCanonical === undefined ||
    !isWithin(snapshotRoot, resolve(outputCanonical))
  ) {
    throw new EvePackagingError({
      code: "UNSUPPORTED_EVE_OUTPUT",
      subject: ".output",
      reason: "The project-local Eve build output is missing or escapes the immutable snapshot.",
      remediation: "Regenerate .output as a regular directory inside the isolated build snapshot.",
    });
  }
  const entrypoint = join(snapshotRoot, EVE_ENTRYPOINT);
  const entryDetails = await lstat(entrypoint).catch(() => undefined);
  if (
    entryDetails === undefined ||
    !entryDetails.isFile() ||
    entryDetails.isSymbolicLink()
  ) {
    throw new EvePackagingError({
      code: "UNSUPPORTED_EVE_OUTPUT",
      subject: EVE_ENTRYPOINT,
      reason: "The project-local Eve build did not produce a regular Nitro server entrypoint.",
      remediation: "Fix the project-local Eve build so .output/server/index.mjs is generated inside the snapshot.",
    });
  }
  const files: Array<{ readonly relativePath: string; readonly sha256: string; readonly byteLength: number }> = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new EvePackagingError({
          code: "UNSUPPORTED_EVE_OUTPUT",
          subject: `.output/${relativePath}`,
          reason: "Generated Eve output contains a symbolic-link escape or unsupported link.",
          remediation: "Regenerate output as regular files inside the immutable build snapshot.",
        });
      }
      if (entry.isDirectory()) {
        await visit(candidate, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new EvePackagingError({
          code: "UNSUPPORTED_EVE_OUTPUT",
          subject: `.output/${relativePath}`,
          reason: "Generated Eve output contains an unsupported file type.",
          remediation: "Remove special files from the Eve build output and retry.",
        });
      }
      const stable = await readGeneratedFile(candidate, `.output/${relativePath}`);
      files.push({
        relativePath: `.output/${relativePath}`,
        sha256: stable.sha256,
        byteLength: stable.bytes.byteLength,
      });
    }
  };
  await visit(outputRoot, "");
  const entryStable = await readGeneratedFile(entrypoint, EVE_ENTRYPOINT);
  if (entryStable.bytes.byteLength === 0) {
    throw new EvePackagingError({
      code: "UNSUPPORTED_EVE_OUTPUT",
      subject: EVE_ENTRYPOINT,
      reason: "The project-local Eve build produced an empty Nitro server entrypoint.",
      remediation: "Regenerate .output/server/index.mjs from the project-local Eve build.",
    });
  }
  try {
    await execFileAsync(
      process.execPath,
      ["--check", entrypoint],
      {
        cwd: snapshotRoot,
        env: {
          PATH: process.env.PATH,
          NODE_PATH: undefined,
          NODE_OPTIONS: undefined,
        },
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    throw new EvePackagingError({
      code: "UNSUPPORTED_EVE_OUTPUT",
      subject: EVE_ENTRYPOINT,
      reason: "The generated Nitro server entrypoint is not valid JavaScript.",
      remediation: "Fix the project-local Eve build so .output/server/index.mjs passes Node syntax validation.",
    });
  }
  return {
    entrypointPath: EVE_ENTRYPOINT,
    sha256: entryStable.sha256,
    regularFile: true,
    symlinkEscape: false,
    outputDigest: sha256(jsonBytes(files)),
    fileCount: files.length,
  };
}

async function assertGeneratedTreesExcludeSecrets(
  snapshotRoot: string,
): Promise<void> {
  const roots = [
    join(snapshotRoot, "node_modules"),
    join(snapshotRoot, ".output"),
  ];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const candidate = join(directory, entry.name);
      if (
        entry.name.startsWith(".env") ||
        EVE_EXCLUDED_FILE_NAMES.has(entry.name) ||
        entry.name.endsWith(".pem") ||
        entry.name.endsWith(".key")
      ) {
        throw new EvePackagingError({
          code: "SECRET_EXCLUSION_FAILED",
          subject: relativePath,
          reason: "The generated Eve runtime closure contains a credential or environment file.",
          remediation: "Remove credential material from the project dependency/output closure and retry.",
        });
      }
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(candidate).catch(() => undefined);
        if (
          resolved === undefined ||
          !isWithin(snapshotRoot, resolve(resolved))
        ) {
          throw new EvePackagingError({
            code: "SECRET_EXCLUSION_FAILED",
            subject: relativePath,
            reason: "The generated Eve runtime closure contains an escaping symbolic link.",
            remediation: "Regenerate dependencies and output without links outside the immutable snapshot.",
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(candidate, relativePath);
      }
    }
  };
  for (const root of roots) {
    const details = await lstat(root).catch(() => undefined);
    if (details?.isSymbolicLink()) {
      throw new EvePackagingError({
        code: "SECRET_EXCLUSION_FAILED",
        subject: relative(snapshotRoot, root),
        reason: "The generated Eve runtime closure root is a symbolic link.",
        remediation: "Regenerate dependencies and output as regular directories inside the immutable snapshot.",
      });
    }
    if (details?.isDirectory() === true) {
      const canonical = await realpath(root).catch(() => undefined);
      if (
        canonical === undefined ||
        !isWithin(snapshotRoot, resolve(canonical))
      ) {
        throw new EvePackagingError({
          code: "SECRET_EXCLUSION_FAILED",
          subject: relative(snapshotRoot, root),
          reason: "The generated Eve runtime closure root escapes the immutable snapshot.",
          remediation: "Regenerate dependencies and output inside the isolated project snapshot.",
        });
      }
      await visit(root, relative(root, root));
    }
  }
}

function safeError(
  error: EvePackagingError,
): EveProjectPackagingResult["error"] {
  return {
    code: error.code,
    subject: error.subject,
    reason: error.message,
    remediation: error.remediation,
  };
}

function classifyDockerBuildFailure(error: unknown): EvePackagingError {
  const stderr = typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof (error as { readonly stderr?: unknown }).stderr === "string"
    ? (error as { readonly stderr: string }).stderr
    : "";
  if (
    /ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_MISSING_DEPENDENCY)/u.test(stderr) ||
    /frozen-lockfile|pnpm --version/u.test(stderr)
  ) {
    return new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "frozen pnpm install",
      reason: "The isolated pinned pnpm install could not complete without changing or bypassing the lockfile.",
      remediation: "Regenerate pnpm-lock.yaml with the declared pnpm version and retry without relaxing frozen mode.",
    });
  }
  if (/node_modules\/\.bin\/eve|test -x/u.test(stderr)) {
    return new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "node_modules/.bin/eve",
      reason: "The isolated build could not resolve the project-local Eve executable.",
      remediation: "Declare Eve as a project dependency and retry with the frozen lockfile.",
    });
  }
  if (/eve build/u.test(stderr)) {
    return new EvePackagingError({
      code: "EVE_BUILD_FAILED",
      subject: "eve build",
      reason: "The project-local Eve build failed inside the isolated Linux/amd64 builder.",
      remediation: "Fix the project-local Eve build and retry without changing the authored project during packaging.",
    });
  }
  return new EvePackagingError({
    code: "DOCKER_PLATFORM_BLOCKED",
    subject: "Docker/OrbStack",
    reason: "The isolated Linux/amd64 Eve builder was unavailable or failed before a verified image was produced.",
    remediation: "Start Docker/OrbStack with BuildKit and retry without changing the project inputs.",
  });
}

function blockedResult(
  error: EvePackagingError,
  extra: Partial<Pick<EveProjectPackagingResult, "project" | "writtenPaths" | "checks">> = {},
): EveProjectPackagingResult {
  return {
    schemaVersion: 1,
    worker: "eve-packaging-worker",
    operation: "local-package",
    status: "blocked",
    returnCode: error.code,
    deployable: false,
    project: extra.project ?? null,
    candidate: null,
    snapshot: null,
    toolchain: null,
    image: null,
    runtime: null,
    secrets: {
      runtimeVariableNames: [],
      valuesRecorded: false,
      excludedFromSnapshot: true,
      excludedFromBuildEnvironment: true,
      excludedFromDockerContext: true,
      excludedFromImage: true,
      excludedFromHistory: true,
      excludedFromManifestsAndLogs: true,
      redactionRegisteredBeforeChildren: false,
    },
    checks: extra.checks ?? [{
      id: error.code,
      status: "blocked",
      subject: error.subject,
      reason: error.message,
      remediation: error.remediation,
    }],
    candidateImageId: null,
    candidateImageRetainedLocally: false,
    writtenPaths: extra.writtenPaths ?? [],
    error: safeError(error),
  };
}

async function currentInputIdentity(
  runtimeConfig: EveRuntimeConfigExclusion | undefined,
): Promise<string | undefined> {
  if (runtimeConfig?.readInputIdentity !== undefined) {
    return await runtimeConfig.readInputIdentity();
  }
  return runtimeConfig?.inputIdentity;
}

async function sourceRaceErrorIfChanged(
  root: string,
  initial: CapturedInputs,
  initialInputIdentity: string | undefined,
  runtimeConfig: EveRuntimeConfigExclusion | undefined,
  artifactRoot: string,
  requestedRoot: string,
): Promise<EvePackagingError | undefined> {
  const requestedDetails = await lstat(requestedRoot).catch(() => undefined);
  const requestedCanonical = await realpath(requestedRoot).catch(() => undefined);
  if (
    requestedDetails === undefined ||
    !requestedDetails.isDirectory() ||
    requestedDetails.isSymbolicLink() ||
    requestedCanonical !== root
  ) {
    return new EvePackagingError({
      code: "SOURCE_RACE",
      subject: "project root",
      reason: "The explicitly selected Eve project root changed during packaging.",
      remediation: "Retry only after the selected canonical project root is quiescent.",
    });
  }
  let latestIdentity: string | undefined;
  try {
    latestIdentity = await currentInputIdentity(runtimeConfig);
  } catch {
    return new EvePackagingError({
      code: "SOURCE_RACE",
      subject: "runtime configuration identity",
      reason: "The explicit environment identity could not be revalidated safely.",
      remediation: "Retry after the deployment-safety runtime-config seam is stable.",
    });
  }
  let latest: CapturedInputs;
  try {
    latest = await captureInputs(
      root,
      runtimeConfig,
      artifactRoot,
      latestIdentity,
      requestedRoot,
    );
  } catch (error: unknown) {
    if (error instanceof EvePackagingError) {
      return new EvePackagingError({
        code: "SOURCE_RACE",
        subject: error.subject,
        reason: "The selected Eve inputs changed or became unsafe during revalidation.",
        remediation: "Retry only after the selected project and its lockfile are quiescent.",
      });
    }
    return new EvePackagingError({
      code: "SOURCE_RACE",
      subject: "project inputs",
      reason: "The selected Eve inputs could not be revalidated safely.",
      remediation: "Retry only after the selected project and its lockfile are quiescent.",
    });
  }
  if (
    initialInputIdentity !== latestIdentity ||
    !sourceInputsEqual(initial, latest)
  ) {
    return new EvePackagingError({
      code: "SOURCE_RACE",
      subject: "project inputs",
      reason: "The selected Eve source, lockfile, configuration, or explicit environment identity changed during packaging.",
      remediation: "Retry only after all selected inputs are quiescent; the mixed-generation candidate was discarded.",
    });
  }
  return undefined;
}

export async function buildEveProjectSnapshot(
  options: EveProjectSnapshotOptions,
): Promise<EveProjectPackagingResult> {
  let roots: { readonly requestedRoot: string; readonly canonicalRoot: string };
  let initialInputs: CapturedInputs;
  let contract: ProjectContract;
  let initialRuntimeInputIdentity: string | undefined;
  try {
    roots = await assertCanonicalRoot(options.projectRoot);
    await assertRequiredRootInputs(roots.canonicalRoot);
    if (
      options.runtimeConfig !== undefined &&
      options.runtimeConfig.redactionRegistered !== true
    ) {
      throw new EvePackagingError({
        code: "SECRET_EXCLUSION_FAILED",
        subject: "runtime configuration",
        reason: "Runtime configuration redaction was not registered before the isolated builder would start.",
        remediation: "Register the deployment-safety redaction handle before packaging and retry.",
      });
    }
    if (
      options.runtimeConfig?.envFilePath !== undefined &&
      options.runtimeConfig.inputIdentity === undefined &&
      options.runtimeConfig.readInputIdentity === undefined
    ) {
      throw new EvePackagingError({
        code: "SECRET_EXCLUSION_FAILED",
        subject: "runtime configuration identity",
        reason: "An explicit environment file was supplied without a deployment-safety input identity.",
        remediation: "Pass the validated redacted environment identity from deployment-safety before packaging.",
      });
    }
    const runtimeVariableNames = options.runtimeConfig?.variableNames ?? [];
    if (
      runtimeVariableNames.some((name) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      ) ||
      new Set(runtimeVariableNames).size !== runtimeVariableNames.length
    ) {
      throw new EvePackagingError({
        code: "SECRET_EXCLUSION_FAILED",
        subject: "runtime variable names",
        reason: "The runtime-config seam returned an invalid or duplicate variable name.",
        remediation: "Return only validated non-secret environment variable names and retry.",
      });
    }
    initialRuntimeInputIdentity = await currentInputIdentity(options.runtimeConfig);
    if (
      options.runtimeConfig?.envFilePath !== undefined &&
      initialRuntimeInputIdentity === undefined
    ) {
      throw new EvePackagingError({
        code: "SECRET_EXCLUSION_FAILED",
        subject: "runtime configuration identity",
        reason: "The explicit environment file identity was unavailable.",
        remediation: "Revalidate the redacted environment input through deployment-safety before packaging.",
      });
    }
    const artifactRoot = resolve(options.artifactRoot);
    initialInputs = await captureInputs(
      roots.canonicalRoot,
      options.runtimeConfig,
      artifactRoot,
      initialRuntimeInputIdentity,
      roots.requestedRoot,
    );
    contract = validateProjectContract(initialInputs);
  } catch (error: unknown) {
    if (error instanceof EvePackagingError) return blockedResult(error);
    return blockedResult(new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "project",
      reason: "The Eve project could not be inspected safely.",
      remediation: "Retry with a readable canonical project root.",
    }));
  }

  let generationRoot: string;
  try {
    generationRoot = await createGenerationRoot(
      options.artifactRoot,
      roots.canonicalRoot,
    );
  } catch (error: unknown) {
    if (error instanceof EvePackagingError) return blockedResult(error);
    return blockedResult(new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "artifactRoot",
      reason: "The Eden-owned generation directory could not be prepared safely.",
      remediation: "Use a new writable generation directory.",
    }));
  }

  const snapshotRoot = join(generationRoot, "container/snapshot");
  const inputManifestPath = join(generationRoot, "input-manifest.json");
  const dockerfilePath = join(generationRoot, "container/Dockerfile");
  const writtenPaths = [
    generationRoot,
    inputManifestPath,
    snapshotRoot,
  ];
  const runtimeVariableNames = [...(options.runtimeConfig?.variableNames ?? [])]
    .sort();
  let buildResult: EveProjectBuilderResult | undefined;
  const inputManifest: EveProjectInputManifest = {
    version: 1,
    requestedRoot: roots.requestedRoot,
    canonicalRoot: roots.canonicalRoot,
    projectId: contract.projectId,
    packageManager: "pnpm",
    packageManagerVersion: contract.packageManagerVersion,
    packageJsonSha256: contract.packageJsonSha256,
    lockfileSha256: contract.lockfileSha256,
    sourceDigest: initialInputs.sourceDigest,
    files: initialInputs.files.map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256,
      byteLength: file.byteLength,
      mode: file.mode,
    })),
    excludedRelativePaths: initialInputs.excludedRelativePaths,
    ...(initialRuntimeInputIdentity === undefined
      ? {}
      : { runtimeConfigInputIdentity: initialRuntimeInputIdentity }),
    runtimeVariableNames,
  };
  const discardBuiltCandidate = async (): Promise<EvePackagingError | undefined> => {
    if (buildResult === undefined || options.builder.discard === undefined) {
      return undefined;
    }
    try {
      await options.builder.discard(buildResult);
    } catch {
      return new EvePackagingError({
        code: "CLEANUP_UNVERIFIED",
        subject: "candidate image",
        reason: "The failed Eve candidate could not be removed with exact ownership proof.",
        remediation: "Inspect the recorded candidate image identity before retrying; no broad Docker cleanup was attempted.",
      });
    }
    buildResult = undefined;
    return undefined;
  };
  try {
    await mkdir(dirname(inputManifestPath), { recursive: true });
    await mkdir(snapshotRoot, { recursive: true });
    await writeJson(inputManifestPath, inputManifest);
    await copySnapshot(snapshotRoot, initialInputs);
    const afterCopyRace = await sourceRaceErrorIfChanged(
      roots.canonicalRoot,
      initialInputs,
      initialRuntimeInputIdentity,
      options.runtimeConfig,
      resolve(options.artifactRoot),
      roots.requestedRoot,
    );
    if (afterCopyRace !== undefined) return blockedResult(afterCopyRace, { writtenPaths });

    const nodeImage = options.nodeImage ?? options.builder.nodeImage;
    let actualDockerfilePath: string | undefined;
    if (nodeImage !== undefined) {
      await writeDockerBuildFiles({
        snapshotRoot,
        dockerfilePath,
        nodeImage,
        packageManagerVersion: contract.packageManagerVersion,
        lockfileSha256: contract.lockfileSha256,
      });
      actualDockerfilePath = dockerfilePath;
      writtenPaths.push(dockerfilePath, join(snapshotRoot, ".dockerignore"));
    }

    buildResult = await options.builder.build({
      generationRoot,
      snapshotRoot,
      inputManifestPath,
      dockerfilePath: actualDockerfilePath,
      packageManagerVersion: contract.packageManagerVersion,
      installCommand: INSTALL_COMMAND,
      buildCommand: BUILD_COMMAND,
      platform: "linux/amd64",
      sourceDigest: initialInputs.sourceDigest,
      buildContext: "immutable-snapshot",
    });
    if (
      buildResult.imageId !== undefined &&
      buildResult.imagePlatform !== "linux/amd64"
    ) {
      throw new EvePackagingError({
        code: "DOCKER_PLATFORM_BLOCKED",
        subject: "linux/amd64 image",
        reason: "The builder returned an image without verified linux/amd64 metadata.",
        remediation: "Inspect the final image and return its verified Linux/amd64 identity.",
      });
    }
    try {
      await verifySnapshotInputs(snapshotRoot, initialInputs);
    } catch (error: unknown) {
      const cleanupError = await discardBuiltCandidate();
      if (cleanupError !== undefined) return blockedResult(cleanupError, { writtenPaths });
      if (error instanceof EvePackagingError) {
        return blockedResult(error, { writtenPaths });
      }
      throw error;
    }

    const afterBuildRace = await sourceRaceErrorIfChanged(
      roots.canonicalRoot,
      initialInputs,
      initialRuntimeInputIdentity,
      options.runtimeConfig,
      resolve(options.artifactRoot),
      roots.requestedRoot,
    );
    if (afterBuildRace !== undefined) {
      const cleanupError = await discardBuiltCandidate();
      return blockedResult(cleanupError ?? afterBuildRace, { writtenPaths });
    }

    const snapshotLockfile = await readStableFile(join(snapshotRoot, "pnpm-lock.yaml"));
    if (
      snapshotLockfile.sha256 !== contract.lockfileSha256 ||
      !snapshotLockfile.bytes.equals(contract.lockfileBytes)
    ) {
      const dependencyError = new EvePackagingError({
        code: "DEPENDENCY_AMBIGUITY",
        subject: "pnpm-lock.yaml",
        reason: "The frozen install changed the captured lockfile bytes.",
        remediation: "Use the exact declared pnpm version with pnpm install --frozen-lockfile.",
      });
      const cleanupError = await discardBuiltCandidate();
      return blockedResult(cleanupError ?? dependencyError, { writtenPaths });
    }

    const eve = await resolveProjectLocalEve(snapshotRoot);
    const output = await scanGeneratedOutput(snapshotRoot);
    await assertGeneratedTreesExcludeSecrets(snapshotRoot);
    const snapshotSourceDigest = await snapshotDigest(snapshotRoot);
    const runtimeManifestPath = join(generationRoot, "runtime-manifest.json");
    await writeJson(runtimeManifestPath, {
      version: 1,
      generationId: basename(generationRoot),
      packageManager: "pnpm",
      packageManagerVersion: contract.packageManagerVersion,
      installCommand: INSTALL_COMMAND,
      buildCommand: BUILD_COMMAND,
      startCommand: START_COMMAND,
      sourceDigest: initialInputs.sourceDigest,
      snapshotDigest: snapshotSourceDigest,
      generatedOutput: output,
      artifactPath: EVE_ENTRYPOINT,
      platform: "linux/amd64",
      runtimeVariableNames,
    });
    writtenPaths.push(runtimeManifestPath);

    let image: EveProjectImage | null = null;
    if (buildResult.imageId !== undefined) {
      image = {
        dockerfilePath: actualDockerfilePath ?? null,
        platform: "linux/amd64",
        builderImage: nodeImage === undefined
          ? null
          : `${nodeImage.reference}@${nodeImage.digest}`,
        runtimeImage: nodeImage === undefined
          ? null
          : `${nodeImage.reference}@${nodeImage.digest}`,
        imageId: buildResult.imageId,
        imageReference: buildResult.imageReference ?? null,
        imageDigest: buildResult.imageDigest ?? buildResult.imageId,
        launchCommand: START_COMMAND,
        workingDirectory: "/app",
        hostEnvironment: HOST_ENVIRONMENT,
        generatedOutput: output,
      };
    }
    const snapshot: EveProjectSnapshot = {
      generationId: basename(generationRoot),
      path: snapshotRoot,
      sha256: snapshotSourceDigest,
      includedFileCount: initialInputs.files.length,
      excludedCategories: [...new Set(
        initialInputs.excludedRelativePaths.map((path) =>
          isPathExcluded(path, undefined).category ?? "generated-state"
        ),
      )].sort(),
      sourceRaceChecked: true,
    };
    if (
      (buildResult.imageId !== undefined &&
        !/^sha256:[0-9a-f]{64}$/u.test(buildResult.imageId)) ||
      (buildResult.imageId !== undefined &&
        buildResult.imagePlatform !== "linux/amd64")
    ) {
      const imageError = new EvePackagingError({
        code: "DOCKER_PLATFORM_BLOCKED",
        subject: "linux/amd64 image",
        reason: "The local Eve image metadata was present but did not include a verified Linux/amd64 identity.",
        remediation: "Inspect the image identity or return the build candidate to the image-runtime worker.",
      });
      const cleanupError = await discardBuiltCandidate();
      return blockedResult(cleanupError ?? imageError, { writtenPaths });
    }
    const project = {
      requestedRoot: roots.requestedRoot,
      canonicalRoot: roots.canonicalRoot,
      projectId: contract.projectId,
      packageJson: {
        path: "package.json" as const,
        sha256: contract.packageJsonSha256,
      },
      lockfile: {
        path: "pnpm-lock.yaml" as const,
        sha256: contract.lockfileSha256,
      },
      sourceDigest: initialInputs.sourceDigest,
      inputManifestPath,
    };
    const candidate: EveProjectBuildCandidate = {
      generationId: basename(generationRoot),
      generationRoot,
      snapshotRoot,
      inputManifestPath,
      packageManager: "pnpm",
      packageManagerVersion: contract.packageManagerVersion,
      installCommand: INSTALL_COMMAND,
      buildCommand: BUILD_COMMAND,
      eveExecutable: "node_modules/.bin/eve",
      eveVersion: eve.version,
      packageJsonSha256: contract.packageJsonSha256,
      lockfileSha256: contract.lockfileSha256,
      sourceDigest: initialInputs.sourceDigest,
      snapshotDigest: snapshotSourceDigest,
      generatedOutput: output,
      ...(initialRuntimeInputIdentity === undefined
        ? {}
        : { runtimeConfigInputIdentity: initialRuntimeInputIdentity }),
      runtimeVariableNames,
    };
    const handoffRace = await sourceRaceErrorIfChanged(
      roots.canonicalRoot,
      initialInputs,
      initialRuntimeInputIdentity,
      options.runtimeConfig,
      resolve(options.artifactRoot),
      roots.requestedRoot,
    );
    if (handoffRace !== undefined) {
      const cleanupError = await discardBuiltCandidate();
      return blockedResult(cleanupError ?? handoffRace, { writtenPaths });
    }
    return {
      schemaVersion: 1,
      worker: "eve-packaging-worker",
      operation: "local-package",
      status: "ready",
      returnCode: "EVE_PACKAGE_READY",
      deployable: true,
      project,
      snapshot,
      toolchain: {
        nodeVersion: "24.17.0",
        packageManager: "pnpm",
        packageManagerVersion: contract.packageManagerVersion,
        installCommand: INSTALL_COMMAND,
        buildCommand: BUILD_COMMAND,
        startCommand: START_COMMAND,
        eveExecutable: eve.path as "node_modules/.bin/eve",
        eveVersion: eve.version,
        lockfileUnchanged: true,
        nativeBuildPlatform: "linux/amd64",
      },
      image,
      candidate,
      runtime: null,
      secrets: {
        runtimeVariableNames,
        valuesRecorded: false,
        excludedFromSnapshot: true,
        excludedFromBuildEnvironment: true,
        excludedFromDockerContext: true,
        excludedFromImage: true,
        excludedFromHistory: true,
        excludedFromManifestsAndLogs: true,
        redactionRegisteredBeforeChildren:
          options.runtimeConfig?.redactionRegistered ?? false,
      },
      checks: [
        {
          id: "VAL-CLI-004",
          status: "pass",
          subject: "project-root",
          reason: "The explicit project root is canonical and readable.",
          remediation: null,
        },
        {
          id: "VAL-BUILD-001",
          status: "pass",
          subject: "package-manager",
          reason: "The exact pnpm pin and one matching regular root lockfile were verified.",
          remediation: null,
        },
        {
          id: "VAL-BUILD-002",
          status: "pass",
          subject: "frozen-install",
          reason: "The isolated builder was given the exact frozen install command.",
          remediation: null,
        },
        {
          id: "VAL-BUILD-003",
          status: "pass",
          subject: "immutable-snapshot",
          reason: "The build consumed one Eden-owned snapshot and source races were checked.",
          remediation: null,
        },
        {
          id: "VAL-BUILD-004",
          status: "pass",
          subject: "project-local-eve",
          reason: "The resolved Eve executable is inside the isolated project dependency tree.",
          remediation: null,
        },
      ],
      candidateImageId: buildResult.imageId ?? null,
      candidateImageRetainedLocally: buildResult.imageId !== undefined,
      writtenPaths,
      error: null,
    };
  } catch (error: unknown) {
    const cleanupError = await discardBuiltCandidate();
    if (cleanupError !== undefined) {
      return blockedResult(cleanupError, { writtenPaths });
    }
    if (error instanceof EvePackagingError) {
      return blockedResult(error, { writtenPaths });
    }
    return blockedResult(new EvePackagingError({
      code: "EVE_BUILD_FAILED",
      subject: "eve build",
      reason: "The project-local Eve build did not complete successfully.",
      remediation: "Inspect the project-local Eve build in the isolated builder and retry after fixing it.",
    }), { writtenPaths });
  }
}

export function createDockerEveProjectBuilder(options: {
  readonly nodeImage: EveNodeImage;
  readonly dockerCommand?: string;
}): EveProjectBuilder {
  const dockerCommand = options.dockerCommand ?? "docker";
  return {
    nodeImage: options.nodeImage,
    async build(request) {
      if (request.dockerfilePath === undefined) {
        throw new EvePackagingError({
          code: "DOCKER_PLATFORM_BLOCKED",
          subject: "Dockerfile",
          reason: "The isolated Docker builder requires a generated pinned Dockerfile.",
          remediation: "Supply a verified Node 24 image and use the generated packaging context.",
        });
      }
      const imageIdFile = join(request.generationRoot, "image-id");
      const safeEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        DOCKER_HOST: process.env.DOCKER_HOST,
        DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      };
      let containerId: string | undefined;
      let imageBuilt = false;
      let retainImage = false;
      let builtImageId: string | undefined;
      const cleanupOwnedResources = async (): Promise<boolean> => {
        let cleanupFailed = false;
        if (containerId !== undefined) {
          await execFileAsync(
            dockerCommand,
            ["rm", "--force", containerId],
            { env: safeEnv, cwd: request.generationRoot },
          ).catch(() => {
            cleanupFailed = true;
          });
          const remainingContainer = await execFileAsync(
            dockerCommand,
            ["container", "inspect", containerId, "--format", "{{.Id}}"],
            { env: safeEnv, cwd: request.generationRoot },
          ).catch(() => undefined);
          if (remainingContainer !== undefined && remainingContainer.stdout.trim().length > 0) {
            cleanupFailed = true;
          }
        }
        if (imageBuilt && !retainImage && builtImageId === undefined) {
          cleanupFailed = true;
        } else if (imageBuilt && !retainImage && builtImageId !== undefined) {
          await execFileAsync(
            dockerCommand,
            ["image", "rm", "--force", builtImageId],
            { env: safeEnv, cwd: request.generationRoot },
          ).catch(() => {
            cleanupFailed = true;
          });
          const remainingImage = await execFileAsync(
            dockerCommand,
            ["image", "inspect", builtImageId, "--format", "{{.Id}}"],
            { env: safeEnv, cwd: request.generationRoot },
          ).catch(() => undefined);
          if (remainingImage !== undefined && remainingImage.stdout.trim().length > 0) {
            cleanupFailed = true;
          }
        }
        return cleanupFailed;
      };
      try {
        await execFileAsync(
          dockerCommand,
          ["version", "--format", "{{.Server.Version}}"],
          { env: safeEnv, cwd: request.generationRoot },
        );
        await execFileAsync(
          dockerCommand,
          [
            "build",
            "--platform=linux/amd64",
            "--file",
            request.dockerfilePath,
            "--iidfile",
            imageIdFile,
            request.snapshotRoot,
          ],
          { env: safeEnv, cwd: request.generationRoot, maxBuffer: 1024 * 1024 },
        );
        imageBuilt = true;
        builtImageId = (await readFile(imageIdFile, "utf8")).trim();
        if (!/^sha256:[0-9a-f]{64}$/u.test(builtImageId)) {
          throw new EvePackagingError({
            code: "DOCKER_PLATFORM_BLOCKED",
            subject: "image identity",
            reason: "Docker did not return a verifiable immutable image identity.",
            remediation: "Use a BuildKit Docker/OrbStack builder that supports an iidfile.",
          });
        }
        const imageDetails = await execFileAsync(
          dockerCommand,
          [
            "image",
            "inspect",
            builtImageId,
            "--format",
            "{{.Id}} {{.Os}} {{.Architecture}}",
          ],
          { env: safeEnv, cwd: request.generationRoot },
        );
        const [imageId, os, architecture] = imageDetails.stdout.trim().split(/\s+/u);
        if (
          imageId === undefined ||
          imageId !== builtImageId ||
          os !== "linux" ||
          architecture !== "amd64"
        ) {
          throw new EvePackagingError({
            code: "DOCKER_PLATFORM_BLOCKED",
            subject: "linux/amd64 image",
            reason: "The built Eve image did not report the required Linux/amd64 platform.",
            remediation: "Use a Docker/OrbStack builder that can produce and run linux/amd64 images.",
          });
        }
        const created = await execFileAsync(
          dockerCommand,
          ["create", builtImageId],
          { env: safeEnv, cwd: request.generationRoot },
        );
        containerId = created.stdout.trim();
        if (!/^[a-f0-9]+$/u.test(containerId)) {
          throw new EvePackagingError({
            code: "DOCKER_PLATFORM_BLOCKED",
            subject: "build container",
            reason: "The isolated Eve build container identity could not be verified.",
            remediation: "Retry with a Docker daemon that returns a stable container identity.",
          });
        }
        await execFileAsync(
          dockerCommand,
          ["cp", `${containerId}:/app/.output`, join(request.snapshotRoot, ".output")],
          { env: safeEnv, cwd: request.generationRoot },
        );
        await execFileAsync(
          dockerCommand,
          ["cp", `${containerId}:/app/node_modules`, join(request.snapshotRoot, "node_modules")],
          { env: safeEnv, cwd: request.generationRoot },
        );
        const result: EveProjectBuilderResult = {
          imageId: builtImageId,
          imagePlatform: "linux/amd64",
          imageReference: builtImageId,
          imageDigest: builtImageId,
        };
        retainImage = true;
        if (await cleanupOwnedResources()) {
          throw new EvePackagingError({
            code: "CLEANUP_UNVERIFIED",
            subject: "Docker build resources",
            reason: "Owned Docker cleanup could not be verified after the Eve build attempt.",
            remediation: "Inspect only the recorded container identity before retrying; no broad Docker cleanup was attempted.",
          });
        }
        return result;
      } catch (error: unknown) {
        if (await cleanupOwnedResources()) {
          throw new EvePackagingError({
            code: "CLEANUP_UNVERIFIED",
            subject: "Docker build resources",
            reason: "Owned Docker cleanup could not be verified after the Eve build attempt.",
            remediation: "Inspect only the recorded image and container identities before retrying; no broad Docker cleanup was attempted.",
          });
        }
        if (error instanceof EvePackagingError) throw error;
        throw classifyDockerBuildFailure(error);
      }
    },
    async discard(result) {
      const imageReference = result.imageReference;
      if (imageReference === undefined) return;
      const safeEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        DOCKER_HOST: process.env.DOCKER_HOST,
        DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      };
      await execFileAsync(
        dockerCommand,
        ["image", "rm", "--force", imageReference],
        { env: safeEnv },
      );
      const remainingImage = await execFileAsync(
        dockerCommand,
        ["image", "inspect", imageReference, "--format", "{{.Id}}"],
        { env: safeEnv },
      ).catch(() => undefined);
      if (remainingImage !== undefined && remainingImage.stdout.trim().length > 0) {
        throw new EvePackagingError({
          code: "CLEANUP_UNVERIFIED",
          subject: imageReference,
          reason: "The failed Eve image remained after exact cleanup.",
          remediation: "Inspect the exact image identity manually; do not run broad Docker cleanup.",
        });
      }
    },
  };
}

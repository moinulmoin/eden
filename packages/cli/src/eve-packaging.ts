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
  rm,
  writeFile,
} from "node:fs/promises";
import {
  promisify,
} from "node:util";
import {
  EVE_HOST_ENVIRONMENT as HOST_ENVIRONMENT,
  EVE_START_COMMAND as START_COMMAND,
  type EveRuntimeInputIdentity,
} from "./eve-runtime-config.js";
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
  | "RUNTIME_CLOSURE_INCOMPLETE"
  | "SECRET_EXCLUSION_FAILED"
  | "DOCKER_PLATFORM_BLOCKED"
  | "UNSUPPORTED_HOST_REQUIREMENT"
  | "EVE_HEALTH_FAILED"
  | "WORLD_MIGRATION_FAILED"
  | "CLEANUP_UNVERIFIED";

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
  readonly inputIdentity?: string | EveRuntimeInputIdentity;
  readonly readInputIdentity?: () =>
    | string
    | EveRuntimeInputIdentity
    | Promise<string | EveRuntimeInputIdentity>;
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

/** Snapshot-relative root of Eve's prepared sandbox templates. */
export const EVE_SANDBOX_CACHE_ROOT = ".eve/sandbox-cache" as const;

/**
 * Evidence for the sandbox templates `eve build` prepared inside the isolated
 * builder. Runtime sandboxes resolve their template at
 * `<appRoot>/.eve/sandbox-cache/<provider>/templates/<key>`, so this tree must
 * ship inside the runtime image or every `bash`/`read_file`/`write_file` call
 * fails with "Sandbox template ... is not provisioned". `null` when this Eve
 * build prepared no sandbox template.
 */
export interface EveSandboxCacheOutput {
  readonly present: true;
  readonly root: typeof EVE_SANDBOX_CACHE_ROOT;
  readonly outputDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
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
  readonly sandboxCache: EveSandboxCacheOutput | null;
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
  readonly secrets: EveProjectSecretsEvidence;
  readonly checks: readonly EvePackagingCheck[];
  /**
   * Outcome of the builder's temporary eve#4440 sandbox-resume patch:
   * `applied` when the shipped just-bash binding carries it, `skipped` when
   * the binding is a version Eden does not know, `absent` when this Eve
   * build has no just-bash binding or packaging never reached the image.
   */
  readonly sandboxResumePatch: EveSandboxResumePatchStatus;
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

// The Postgres World's `cbor-x` dependency declares `cbor-extract` as an
// optional native accelerator whose prebuilt binary cannot load in the
// runtime image. pnpm's CLI cannot exempt a single package from
// strict-dep-builds, so the Dockerfile passes
// `--config.strict-dep-builds=false` and then runs
// IGNORED_BUILDS_GUARD, which restores the strict failure for every ignored
// build script except cbor-extract. Eden never runs dependency build scripts
// either way, `--frozen-lockfile` stays honest, cbor-extract's .node binary is
// exempt from the ldd check, and the runtime stage sets
// CBOR_NATIVE_ACCELERATION_DISABLED.
const IGNORED_BUILDS_GUARD =
  `node -e 'const m=JSON.parse(require("fs").readFileSync("node_modules/.modules.yaml","utf8"));const b=(m.ignoredBuilds||[]).filter((p)=>!p.startsWith("cbor-extract@"));if(b.length){console.error("ERR_PNPM_IGNORED_BUILDS Ignored build scripts: "+b.join(", "));process.exit(1)}'`;

/**
 * Eden's temporary fix for upstream https://github.com/vercel/eve/issues/4440
 * (repro: https://github.com/moinulmoin/eve-justbash-resume-repro).
 * Eve's just-bash provider permanently refuses to resume a conversation once
 * the sandbox template changes (skills, `agent/sandbox/workspace/`, or the
 * sandbox definition) and never falls back, so one `eden deploy` update would
 * break every existing conversation's sandbox forever. The isolated builder
 * rewrites one file in the installed Eve copy so an existing session reopens
 * against the current template instead of throwing; user files under
 * `/workspace` always win over the template. The patch applies only when the
 * target file's sha256 equals `EVE_SANDBOX_RESUME_PATCH_KNOWN_SHA256`, and it
 * is removed entirely once upstream ships the fix.
 */
export const EVE_SANDBOX_RESUME_PATCH_KNOWN_SHA256 =
  "0ba0ac3a237c99af2f67a6028f1675bf7c04b22454b4ebfb4cd9d19e5bf5aaf8";
/** Marker the patched binding always contains; proves the patch shipped. */
export const EVE_SANDBOX_RESUME_PATCH_SIGNATURE = "edenRefreshJustBashSessionSkills";
/** Path of the just-bash binding inside the resolved Eve package root. */
const EVE_JUST_BASH_BINDING_PATH =
  "dist/src/execution/sandbox/bindings/just-bash.js";

/** The exact `resume()` implementation in eve 0.68.0, 0.71.2, and 0.72.1. */
export const EVE_JUST_BASH_RESUME_ORIGINAL =
  `async resume(e,n,r){let i=requirePreparedJustBashArtifact(n),a=requireJustBashSessionState(r),o=createSandboxProviderIdentity({artifact:i,version:1}),s=sessionRootPath(e,i);if(a.generation!==o||a.rootPath!==s)throw Error(\`just-bash session state is incompatible with this environment.\`);if(!await pathExists(a.rootPath))throw Error(\`just-bash session root "\${a.rootPath}" no longer exists.\`);return await openHandle(e,a.rootPath,t)}`;

/**
 * The replacement `resume()`: a session whose template generation moved is
 * contained to the same sessions directory and reopened with its authored
 * skills refreshed from the current template. A session folder that is gone
 * (for example a deploy that could not carry it) is recreated from the
 * current template instead of failing every later sandbox call.
 */
export const EVE_SANDBOX_RESUME_PATCHED =
  `async resume(e,n,r){let i=requirePreparedJustBashArtifact(n),a=requireJustBashSessionState(r),o=createSandboxProviderIdentity({artifact:i,version:1}),s=sessionRootPath(e,i);if((a.generation!==o||a.rootPath!==s)&&dirname(a.rootPath)!==dirname(s))throw Error(\`just-bash session state is incompatible with this environment.\`);await ensureSessionRoot(i,a.rootPath);if(a.generation!==o)await edenRefreshJustBashSessionSkills(i.templateRootPath,a.rootPath);return await openHandle(e,a.rootPath,t)}`;

/**
 * Helpers appended to the patched binding. They use only identifiers the
 * module already imports (`readdir`, `rm`, `join`, `pathExists`,
 * `copyDirectoryAtomically`). Skills live at `$HOME/.agents/skills` inside a
 * just-bash root, so the session keeps the same path relative to its `fs`
 * directory as the template; the template's `fs` is scanned because `$HOME`
 * is only known inside the sandbox.
 */
export const EVE_SANDBOX_RESUME_PATCH_HELPERS = `async function edenRefreshJustBashSessionSkills(e,t){let n=await edenFindTemplateSkillsRelativePath(join(e,"fs"));if(n===void 0)return;let r=join(t,"fs",n);await rm(r,{force:!0,recursive:!0}),await copyDirectoryAtomically(join(e,"fs",n),r)}
async function edenFindTemplateSkillsRelativePath(e){let t=[["",0]];for(;t.length>0;){let n=t.shift(),r=n[0],i=n[1];if(i>3)continue;let a=[];try{a=await readdir(join(e,r),{withFileTypes:!0})}catch{a=[]}for(let o of a){if(!o.isDirectory())continue;let s=r===""?o.name:r+"/"+o.name;if(o.name===".agents")return await pathExists(join(e,s,"skills"))?s+"/skills":void 0;t.push([s,i+1])}}return void 0}
`;

/**
 * The CommonJS patcher the isolated builder runs between the frozen install
 * and `eve build` (and again for the production reinstall). It never touches
 * project files, applies only against the known sha256, verifies the
 * replacement matched exactly once, validates the result with `node --check`,
 * and breaks hardlinks by writing a temp file and renaming it into place.
 */
export const EVE_SANDBOX_RESUME_PATCH_SCRIPT = `// Eden temporary fix for https://github.com/vercel/eve/issues/4440: Eve's
// just-bash provider permanently refuses to resume a conversation after the
// sandbox template changes (skills, agent/sandbox/workspace/, sandbox
// definition) and never falls back. This rewrites one file in the installed
// Eve copy so an existing session reopens against the current template. It
// runs only against the sha256 Eden knows and is removed once upstream
// ships the fix.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const KNOWN_SHA256 = ${JSON.stringify(EVE_SANDBOX_RESUME_PATCH_KNOWN_SHA256)};
const SIGNATURE = ${JSON.stringify(EVE_SANDBOX_RESUME_PATCH_SIGNATURE)};
const BINDING_PATH = ${JSON.stringify(EVE_JUST_BASH_BINDING_PATH)};
const ORIGINAL = ${JSON.stringify(EVE_JUST_BASH_RESUME_ORIGINAL)};
const PATCHED_RESUME = ${JSON.stringify(EVE_SANDBOX_RESUME_PATCHED)};
const HELPERS = ${JSON.stringify(EVE_SANDBOX_RESUME_PATCH_HELPERS)};
function finish(outcome, detail) {
  console.log("eden-eve-sandbox-resume-patch: " + outcome + " (" + detail + ")");
}
let packageJsonPath;
try {
  packageJsonPath = fs.realpathSync("node_modules/eve/package.json");
} catch {
  finish("absent", "no project-local eve package to patch");
  process.exit(0);
}
const binding = path.join(path.dirname(packageJsonPath), BINDING_PATH);
let source;
try {
  source = fs.readFileSync(binding, "utf8");
} catch {
  finish("absent", "this eve build has no just-bash binding");
  process.exit(0);
}
if (source.includes(SIGNATURE)) {
  finish("applied", "already patched");
  process.exit(0);
}
const digest = crypto.createHash("sha256").update(source).digest("hex");
if (digest !== KNOWN_SHA256) {
  finish("skipped", "sha256 " + digest + " is not a version Eden knows (eve#4440)");
  process.exit(0);
}
const first = source.indexOf(ORIGINAL);
if (first === -1 || source.indexOf(ORIGINAL, first + 1) !== -1) {
  console.error("eden-eve-sandbox-resume-patch: the known resume implementation did not match exactly once; refusing to patch");
  process.exit(1);
}
const patched = source.slice(0, first) + PATCHED_RESUME +
  source.slice(first + ORIGINAL.length) + "\\n" + HELPERS + "\\n";
const temporary = binding + ".tmp.js";
fs.rmSync(temporary, { force: true });
fs.writeFileSync(temporary, patched);
const parsed = spawnSync(process.execPath, ["--check", temporary], { encoding: "utf8" });
if (parsed.status !== 0) {
  fs.rmSync(temporary, { force: true });
  console.error("eden-eve-sandbox-resume-patch: the patched file failed node --check; refusing to install it" + (typeof parsed.stderr === "string" ? "\\n" + parsed.stderr : ""));
  process.exit(1);
}
// Rename (not write) so any hardlink to the original inode is broken.
fs.renameSync(temporary, binding);
finish("applied", "temporary eve#4440 fix written into the isolated builder image");
`;

/** The heredoc COPY + RUN inserted after each frozen install in the builder. */
const EVE_SANDBOX_RESUME_PATCH_DOCKERFILE_STEP =
  `COPY <<'EDEN_EVE_PATCH_EOF' /tmp/eden-eve-sandbox-resume-patch.cjs
${EVE_SANDBOX_RESUME_PATCH_SCRIPT}EDEN_EVE_PATCH_EOF
RUN node /tmp/eden-eve-sandbox-resume-patch.cjs
`;

/** Outcome of the builder's sandbox-resume patch for the packaged image. */
export type EveSandboxResumePatchStatus = "applied" | "skipped" | "absent";

const INSTALL_COMMAND = [
  "corepack",
  "pnpm",
  "install",
  "--frozen-lockfile",
] as const;
const BUILD_COMMAND = ["./node_modules/.bin/eve", "build"] as const;
const EVE_ENTRYPOINT = ".output/server/index.mjs" as const;
const EVE_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".eden",
  ".eve",
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

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}/`);
}

export function safeRelativePath(root: string, candidate: string): string {
  return relative(root, candidate).split("\\").join("/");
}

export const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const NODE_IMAGE_PATTERN = /^node:24\.17\.0(?:-[a-z0-9][a-z0-9._-]*)?$/u;

export function imageReference(
  nodeImage: EveNodeImage,
  reason: string,
  remediation: string,
): string {
  if (!NODE_IMAGE_PATTERN.test(nodeImage.reference) ||
      !IMAGE_ID_PATTERN.test(nodeImage.digest)) {
    throw new EvePackagingError({
      code: "DOCKER_PLATFORM_BLOCKED",
      subject: "node-24-image",
      reason,
      remediation,
    });
  }
  return `${nodeImage.reference}@${nodeImage.digest}`;
}

function safeDockerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  };
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
      category: excludedDirectory === ".eden" ||
          excludedDirectory === ".eve" || excludedDirectory === ".git"
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

async function readStableFile(
  path: string,
  containmentRoot?: string,
): Promise<StableFile> {
  const canonicalRoot = containmentRoot === undefined
    ? undefined
    : await realpath(containmentRoot).catch(() => undefined);
  const parentBefore = containmentRoot === undefined
    ? undefined
    : await realpath(dirname(path)).catch(() => undefined);
  if (
    containmentRoot !== undefined &&
    (canonicalRoot === undefined ||
      parentBefore === undefined ||
      !isWithin(canonicalRoot, resolve(parentBefore)))
  ) {
    throw new EvePackagingError({
      code: "SOURCE_RACE",
      subject: safeRelativePath(containmentRoot ?? dirname(path), path),
      reason: "The observed file parent escaped its Eden-owned containment root.",
      remediation: "Retry only after the selected source tree is quiescent.",
    });
  }
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
  const parentAfter = containmentRoot === undefined
    ? undefined
    : await realpath(dirname(path)).catch(() => undefined);
  if (
    secondRead === undefined ||
    !bytes.equals(secondRead) ||
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    (containmentRoot !== undefined && parentAfter !== parentBefore)
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
    const directoryDetails = await lstat(directory).catch(() => undefined);
    const canonicalDirectory = await realpath(directory).catch(() => undefined);
    if (
      directoryDetails === undefined ||
      !directoryDetails.isDirectory() ||
      directoryDetails.isSymbolicLink() ||
      canonicalDirectory === undefined ||
      !isWithin(root, resolve(canonicalDirectory))
    ) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: relativeDirectory || ".",
        reason: "The selected Eve source directory was replaced or escaped while it was being observed.",
        remediation: "Retry only after the selected project tree is quiescent.",
      });
    }
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
        stable = await readStableFile(candidate, root);
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
  const parentBeforeCreate = await realpath(canonicalParent).catch(() => undefined);
  if (parentBeforeCreate !== canonicalParent) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "artifactRoot",
      reason: "The Eden-owned artifact parent changed before generation creation.",
      remediation: "Use a stable regular artifact parent and retry.",
    });
  }
  await mkdir(canonicalGenerationRoot);
  const parentAfterCreate = await realpath(canonicalParent).catch(() => undefined);
  if (parentAfterCreate !== canonicalParent) {
    throw new EvePackagingError({
      code: "ROOT_INVALID",
      subject: "artifactRoot",
      reason: "The Eden-owned artifact parent changed during generation creation.",
      remediation: "Use a stable regular artifact parent and retry.",
    });
  }
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

async function ensureSnapshotDirectory(
  snapshotRoot: string,
  directory: string,
): Promise<void> {
  const relativeDirectory = safeRelativePath(snapshotRoot, resolve(directory));
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith("../") ||
    relativeDirectory.includes("/../")
  ) {
    throw new EvePackagingError({
      code: "SOURCE_RACE",
      subject: relativeDirectory,
      reason: "The immutable Eve snapshot directory escaped its Eden-owned root.",
      remediation: "Discard the mixed-generation candidate and retry from a clean snapshot.",
    });
  }
  const rootDetails = await lstat(snapshotRoot).catch(() => undefined);
  const rootCanonical = await realpath(snapshotRoot).catch(() => undefined);
  if (
    rootDetails === undefined ||
    !rootDetails.isDirectory() ||
    rootDetails.isSymbolicLink() ||
    rootCanonical === undefined ||
    !isWithin(snapshotRoot, resolve(rootCanonical))
  ) {
    throw new EvePackagingError({
      code: "SOURCE_RACE",
      subject: ".",
      reason: "The immutable Eve snapshot root was replaced or escaped during creation.",
      remediation: "Discard the mixed-generation candidate and retry from a clean snapshot.",
    });
  }
  let current = snapshotRoot;
  let currentCanonical = rootCanonical;
  for (const part of relativeDirectory.split("/").filter(Boolean)) {
    const currentObserved = await realpath(current).catch(() => undefined);
    if (currentObserved !== currentCanonical) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: safeRelativePath(snapshotRoot, current),
        reason: "The immutable Eve snapshot parent was replaced during creation.",
        remediation: "Discard the mixed-generation candidate and retry from a clean snapshot.",
      });
    }
    const next = join(current, part);
    const expectedCanonical = join(currentCanonical, part);
    const existing = await lstat(next).catch(() => undefined);
    if (existing === undefined) {
      await mkdir(next);
    }
    const details = await lstat(next).catch(() => undefined);
    const canonical = await realpath(next).catch(() => undefined);
    if (
      details === undefined ||
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      canonical === undefined ||
      canonical !== expectedCanonical ||
      !isWithin(rootCanonical, resolve(canonical))
    ) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: safeRelativePath(snapshotRoot, next),
        reason: "The immutable Eve snapshot directory was replaced or escaped during creation.",
        remediation: "Discard the mixed-generation candidate and retry from a clean snapshot.",
      });
    }
    current = next;
    currentCanonical = canonical;
  }
}

async function copySnapshot(
  snapshotRoot: string,
  inputs: CapturedInputs,
): Promise<void> {
  for (const file of inputs.files) {
    const destination = join(snapshotRoot, file.relativePath);
    const parent = dirname(destination);
    await ensureSnapshotDirectory(snapshotRoot, parent);
    const canonicalRoot = await realpath(snapshotRoot).catch(() => undefined);
    const canonicalParent = await realpath(parent).catch(() => undefined);
    if (
      canonicalRoot === undefined ||
      canonicalParent === undefined ||
      !isWithin(canonicalRoot, resolve(canonicalParent))
    ) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: file.relativePath,
        reason: "The immutable Eve snapshot parent could not be proven contained before writing.",
        remediation: "Discard the mixed-generation candidate and retry from a clean snapshot.",
      });
    }
    await writeFile(destination, file.bytes, {
      flag: "wx",
      mode: file.mode,
    });
    const afterParent = await realpath(parent).catch(() => undefined);
    if (afterParent !== canonicalParent) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: file.relativePath,
        reason: "The immutable Eve snapshot parent changed during writing.",
        remediation: "Discard the mixed-generation candidate and retry from a clean snapshot.",
      });
    }
    await chmod(destination, file.mode).catch(() => undefined);
    const copied = await readStableFile(destination, snapshotRoot);
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
    const directoryDetails = await lstat(directory).catch(() => undefined);
    const directoryCanonical = await realpath(directory).catch(() => undefined);
    if (
      directoryDetails === undefined ||
      !directoryDetails.isDirectory() ||
      directoryDetails.isSymbolicLink() ||
      directoryCanonical === undefined ||
      !isWithin(snapshotRoot, resolve(directoryCanonical))
    ) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: relativeDirectory || ".",
        reason: "The immutable Eve snapshot directory escaped or changed during verification.",
        remediation: "Discard the mixed-generation candidate and retry from quiescent source bytes.",
      });
    }
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
      if (
        relativePath === EVE_SANDBOX_CACHE_ROOT ||
        relativePath.startsWith(`${EVE_SANDBOX_CACHE_ROOT}/`)
      ) {
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
      const observed = await readStableFile(
        join(snapshotRoot, file.relativePath),
        snapshotRoot,
      );
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
    const directoryDetails = await lstat(directory).catch(() => undefined);
    const directoryCanonical = await realpath(directory).catch(() => undefined);
    if (
      directoryDetails === undefined ||
      !directoryDetails.isDirectory() ||
      directoryDetails.isSymbolicLink() ||
      directoryCanonical === undefined ||
      !isWithin(snapshotRoot, resolve(directoryCanonical))
    ) {
      throw new EvePackagingError({
        code: "SOURCE_RACE",
        subject: relativeDirectory || ".",
        reason: "The immutable Eve snapshot directory escaped or changed during digest capture.",
        remediation: "Discard the mixed-generation candidate and retry from a clean project snapshot.",
      });
    }
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
      const stable = await readStableFile(candidate, snapshotRoot);
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
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
  });
}

const EVE_GENERATED_SNAPSHOT_ROOTS: Record<string, true> = {
  ".dockerignore": true,
  ".output": true,
  "node_modules": true,
};

/**
 * The authored Eve project source the runtime stage must carry so `eve start`
 * can resolve the project context (agent/, agents/ workspaces, flat layouts,
 * and the manifest). Returns validated top-level snapshot entries with every
 * capture-time exclusion still applied; generated roots are never source.
 */
export async function eveSnapshotSourceEntries(
  snapshotRoot: string,
): Promise<readonly string[]> {
  const entries = await readdir(snapshotRoot, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue;
    if (EVE_GENERATED_SNAPSHOT_ROOTS[entry.name] === true) continue;
    if (isPathExcluded(entry.name, undefined).excluded) continue;
    names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right));
  return names;
}

async function writeDockerBuildFiles(options: {
  readonly snapshotRoot: string;
  readonly dockerfilePath: string;
  readonly nodeImage: EveNodeImage;
  readonly packageManagerVersion: string;
  readonly lockfileSha256: string;
}): Promise<void> {
  const image = imageReference(
    options.nodeImage,
    "The Linux/amd64 builder requires an immutable Node 24 image digest.",
    "Supply a verified Node 24 image reference and sha256 digest.",
  );
  const installSources = ["package.json", "pnpm-lock.yaml"];
  if (
    (await lstat(join(options.snapshotRoot, "pnpm-workspace.yaml"))
      .catch(() => undefined))?.isFile() === true
  ) {
    installSources.push("pnpm-workspace.yaml");
  }
  const runtimeSourceCopies = (await eveSnapshotSourceEntries(options.snapshotRoot))
    .map((name) =>
      `COPY --from=builder ${JSON.stringify([`/workspace/${name}`, `/app/${name}`])}`
    )
    .join("\n");
  const dockerfile = `# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 ${image} AS builder
WORKDIR /workspace
COPY ${JSON.stringify([...installSources, "./"])}
RUN corepack enable \\
  && corepack prepare pnpm@${options.packageManagerVersion} --activate \\
  && test "$(corepack pnpm --version)" = "${options.packageManagerVersion}" \\
  && test "$(sha256sum pnpm-lock.yaml | cut -d ' ' -f1)" = "${options.lockfileSha256}" \\
  && corepack pnpm install --frozen-lockfile --config.node-linker=hoisted --config.strict-dep-builds=false \\
  && ${IGNORED_BUILDS_GUARD}
${EVE_SANDBOX_RESUME_PATCH_DOCKERFILE_STEP}RUN test "$(sha256sum pnpm-lock.yaml | cut -d ' ' -f1)" = "${options.lockfileSha256}"
COPY . ./
RUN test -x ./node_modules/.bin/eve \\
  && ./node_modules/.bin/eve build \\
  && mkdir -p .eve/sandbox-cache

FROM builder AS runtime-deps
RUN rm -rf node_modules \\
  && corepack pnpm install --frozen-lockfile --prod --config.node-linker=hoisted --config.strict-dep-builds=false \\
  && ${IGNORED_BUILDS_GUARD} \\
  && for l in node_modules/.bin/*; do t=$(readlink "$l") || continue; case "$t" in /*) ln -sfn "$(realpath --relative-to=node_modules/.bin "$t")" "$l" ;; esac; done
${EVE_SANDBOX_RESUME_PATCH_DOCKERFILE_STEP}

FROM --platform=linux/amd64 ${image} AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 \\
    NITRO_HOST=0.0.0.0 \\
    PORT=8080 \\
    NITRO_PORT=8080 \\
    NODE_ENV=production
COPY --from=builder /workspace/.output /app/.output
# Eve's prepared just-bash sandbox template: the builder stage's eve build
# prewarm wrote it under /workspace/.eve/sandbox-cache, and the runtime sandbox
# resolves it at /app/.eve/sandbox-cache (bash/read_file/write_file fail
# without it). The mkdir in the build step guarantees the source exists even
# when this Eve build prepared no template.
COPY --from=builder /workspace/.eve/sandbox-cache /app/.eve/sandbox-cache
${runtimeSourceCopies}
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
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(options.snapshotRoot, ".dockerignore"), dockerignore, {
    flag: "wx",
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
  const directPackagePath = await realpath(
    join(nodeModulesRoot, "eve", "package.json"),
  ).catch(() => undefined);
  if (
    directPackagePath !== undefined &&
    isWithin(nodeModulesRoot, directPackagePath)
  ) {
    let directValue: unknown;
    try {
      directValue = JSON.parse(
        (await readFile(directPackagePath)).toString("utf8"),
      ) as unknown;
    } catch {
      directValue = undefined;
    }
    if (
      typeof directValue === "object" &&
      directValue !== null &&
      !Array.isArray(directValue) &&
      (directValue as { readonly name?: unknown }).name === "eve" &&
      typeof (directValue as { readonly version?: unknown }).version ===
        "string" &&
      (directValue as { readonly version: string }).version.length > 0
    ) {
      return {
        version: (directValue as { readonly version: string }).version,
        path: "node_modules/.bin/eve",
      };
    }
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
      return await readStableFile(path, snapshotRoot);
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
    const directoryDetails = await lstat(directory).catch(() => undefined);
    const directoryCanonical = await realpath(directory).catch(() => undefined);
    if (
      directoryDetails === undefined ||
      !directoryDetails.isDirectory() ||
      directoryDetails.isSymbolicLink() ||
      directoryCanonical === undefined ||
      !isWithin(snapshotRoot, resolve(directoryCanonical))
    ) {
      throw new EvePackagingError({
        code: "UNSUPPORTED_EVE_OUTPUT",
        subject: `.output/${relativeDirectory}`,
        reason: "Generated Eve output escaped or changed during validation.",
        remediation: "Regenerate output as regular files inside the immutable build snapshot.",
      });
    }
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

/**
 * A generous sanity bound for the prepared sandbox-template tree (templates
 * carry the sandbox filesystem seeds and authored skills; the minimal Eve
 * fixture produces ~1 KiB). Anything larger means the builder extracted more
 * than Eve's build-time prewarm could have written.
 */
const EVE_SANDBOX_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Validates the prepared sandbox-template tree the builder extracted into
 * `<snapshot>/.eve/sandbox-cache` with the same rigor as `.output`: regular
 * files and directories only, no symbolic links, no special files, stable
 * reads inside the immutable snapshot, and a total-size sanity bound.
 * Returns `null` when this Eve build prepared no sandbox template.
 */
async function scanGeneratedSandboxCache(
  snapshotRoot: string,
): Promise<EveSandboxCacheOutput | null> {
  const cacheRoot = join(snapshotRoot, EVE_SANDBOX_CACHE_ROOT);
  const rootDetails = await lstat(cacheRoot).catch(() => undefined);
  if (rootDetails === undefined) return null;
  const rootCanonical = await realpath(cacheRoot).catch(() => undefined);
  if (
    !rootDetails.isDirectory() ||
    rootDetails.isSymbolicLink() ||
    rootCanonical === undefined ||
    !isWithin(snapshotRoot, resolve(rootCanonical))
  ) {
    throw new EvePackagingError({
      code: "UNSUPPORTED_EVE_OUTPUT",
      subject: EVE_SANDBOX_CACHE_ROOT,
      reason: "The prepared sandbox template root is missing, a symbolic link, or escapes the immutable snapshot.",
      remediation: "Rebuild the candidate so the isolated builder extracts a regular .eve/sandbox-cache directory.",
    });
  }
  const files: Array<{ readonly relativePath: string; readonly sha256: string; readonly byteLength: number }> = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const directoryDetails = await lstat(directory).catch(() => undefined);
    const directoryCanonical = await realpath(directory).catch(() => undefined);
    if (
      directoryDetails === undefined ||
      !directoryDetails.isDirectory() ||
      directoryDetails.isSymbolicLink() ||
      directoryCanonical === undefined ||
      !isWithin(snapshotRoot, resolve(directoryCanonical))
    ) {
      throw new EvePackagingError({
        code: "UNSUPPORTED_EVE_OUTPUT",
        subject: relativeDirectory,
        reason: "The prepared sandbox template tree escaped or changed during validation.",
        remediation: "Rebuild the candidate so the isolated builder extracts regular template files.",
      });
    }
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
          subject: `${EVE_SANDBOX_CACHE_ROOT}/${relativePath}`,
          reason: "The prepared sandbox template tree contains a symbolic link.",
          remediation: "Rebuild the candidate so the isolated builder extracts regular template files only.",
        });
      }
      if (entry.isDirectory()) {
        await visit(candidate, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new EvePackagingError({
          code: "UNSUPPORTED_EVE_OUTPUT",
          subject: `${EVE_SANDBOX_CACHE_ROOT}/${relativePath}`,
          reason: "The prepared sandbox template tree contains a device, socket, FIFO, or other unsupported file.",
          remediation: "Rebuild the candidate so the isolated builder extracts regular template files only.",
        });
      }
      let stable: StableFile;
      try {
        stable = await readStableFile(candidate, snapshotRoot);
      } catch {
        throw new EvePackagingError({
          code: "UNSUPPORTED_EVE_OUTPUT",
          subject: `${EVE_SANDBOX_CACHE_ROOT}/${relativePath}`,
          reason: "The prepared sandbox template file is unreadable or changed during validation.",
          remediation: "Rebuild the candidate so the isolated builder extracts a stable template tree.",
        });
      }
      totalBytes += stable.bytes.byteLength;
      if (totalBytes > EVE_SANDBOX_CACHE_MAX_BYTES) {
        throw new EvePackagingError({
          code: "UNSUPPORTED_EVE_OUTPUT",
          subject: EVE_SANDBOX_CACHE_ROOT,
          reason: `The prepared sandbox template tree exceeds the ${EVE_SANDBOX_CACHE_MAX_BYTES}-byte sanity bound.`,
          remediation: "Rebuild the candidate; the extracted template tree must contain only Eve's prepared templates.",
        });
      }
      files.push({
        relativePath: `${EVE_SANDBOX_CACHE_ROOT}/${relativePath}`,
        sha256: stable.sha256,
        byteLength: stable.bytes.byteLength,
      });
    }
  };
  await visit(cacheRoot, "");
  return {
    present: true,
    root: EVE_SANDBOX_CACHE_ROOT,
    outputDigest: sha256(jsonBytes(files)),
    fileCount: files.length,
    totalBytes,
  };
}

async function assertGeneratedTreesExcludeSecrets(
  snapshotRoot: string,
): Promise<void> {
  const roots = [
    join(snapshotRoot, "node_modules"),
    join(snapshotRoot, ".output"),
    join(snapshotRoot, EVE_SANDBOX_CACHE_ROOT),
  ];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const directoryDetails = await lstat(directory).catch(() => undefined);
    const directoryCanonical = await realpath(directory).catch(() => undefined);
    if (
      directoryDetails === undefined ||
      !directoryDetails.isDirectory() ||
      directoryDetails.isSymbolicLink() ||
      directoryCanonical === undefined ||
      !isWithin(snapshotRoot, resolve(directoryCanonical))
    ) {
      throw new EvePackagingError({
        code: "SECRET_EXCLUSION_FAILED",
        subject: relativeDirectory,
        reason: "The generated Eve runtime closure escaped or changed during secret validation.",
        remediation: "Regenerate dependencies and output inside the immutable project snapshot.",
      });
    }
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

export function safeError(
  error: EvePackagingError,
): EveProjectPackagingResult["error"] {
  return {
    code: error.code,
    subject: error.subject,
    reason: error.message,
    remediation: error.remediation,
  };
}

/**
 * The reported BuildKit step decides the classification: an echoed
 * `RUN corepack pnpm install --frozen-lockfile` line from an earlier cached
 * step must not relabel a failing `eve build` step as a pnpm install failure.
 */
function failingDockerStepCommand(stderr: string): string | undefined {
  let command: string | undefined;
  let position = -1;
  for (const pattern of [
    /process "([^"]+)" did not complete/gu,
    /executor failed running \[([^\]]+)\]/gu,
    /The command '([^']+)' returned a non-zero code/gu,
  ]) {
    for (const match of stderr.matchAll(pattern)) {
      if (match.index >= position) {
        position = match.index;
        command = match[1];
      }
    }
  }
  return command;
}

function classifyPnpmInstallFailure(stderr: string): EvePackagingError | undefined {
  if (/ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/u.test(stderr)) {
    return new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
      reason: "The isolated pinned pnpm install rejected a dependency that is newer than the project's minimumReleaseAge policy.",
      remediation: "Wait until the release ages past the minimumReleaseAge cutoff, or name the exact pin in minimumReleaseAgeExclude inside the project pnpm-workspace.yaml.",
    });
  }
  if (/ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_MISSING_DEPENDENCY)/u.test(stderr)) {
    return new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "frozen pnpm install",
      reason: "The isolated pinned pnpm install could not complete without changing or bypassing the lockfile.",
      remediation: "Regenerate pnpm-lock.yaml with the declared pnpm version and retry without relaxing frozen mode.",
    });
  }
  if (/ERR_PNPM_IGNORED_BUILDS/u.test(stderr)) {
    return new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "ERR_PNPM_IGNORED_BUILDS",
      reason: "The isolated pinned pnpm install refused dependency build scripts that the project pnpm policy neither allows nor ignores (the known-optional cbor-extract addon is already exempted by Eden).",
      remediation: "Name the dependency under allowBuilds or ignoredBuiltDependencies in the project pnpm-workspace.yaml and retry.",
    });
  }
  const pnpmErrorCode = /ERR_PNPM_[A-Z0-9_]+/u.exec(stderr)?.[0];
  if (pnpmErrorCode !== undefined) {
    return new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: pnpmErrorCode,
      reason: `The isolated pinned pnpm install failed with ${pnpmErrorCode}.`,
      remediation: "Fix the pnpm failure reported by the isolated build without relaxing the frozen lockfile or the declared pnpm pin, then retry.",
    });
  }
  return undefined;
}

function classifyEveBuildFailure(stderr: string): EvePackagingError {
  if (/\bjust-bash\b/u.test(stderr)) {
    return new EvePackagingError({
      code: "EVE_BUILD_FAILED",
      subject: "eve build",
      reason: "The project-local Eve build failed inside the isolated Linux/amd64 builder because Eve's default sandbox needs just-bash where no Docker daemon or /dev/kvm exists.",
      remediation: "Declare just-bash as a production dependency of the Eve project, regenerate pnpm-lock.yaml, and retry.",
    });
  }
  return new EvePackagingError({
    code: "EVE_BUILD_FAILED",
    subject: "eve build",
    reason: "The project-local Eve build failed inside the isolated Linux/amd64 builder.",
    remediation: "Fix the project-local Eve build and retry without changing the authored project during packaging.",
  });
}

function classifyDockerBuildFailure(error: unknown): EvePackagingError {
  const stderr = typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof (error as { readonly stderr?: unknown }).stderr === "string"
    ? (error as { readonly stderr: string }).stderr
    : "";
  const step = failingDockerStepCommand(stderr);
  if (step !== undefined) {
    if (/\beve\b/u.test(step) && /\bbuild\b/u.test(step)) {
      return classifyEveBuildFailure(stderr);
    }
    if (/pnpm|corepack/u.test(step)) {
      const pnpmFailure = classifyPnpmInstallFailure(stderr);
      if (pnpmFailure !== undefined) return pnpmFailure;
      return new EvePackagingError({
        code: "DEPENDENCY_AMBIGUITY",
        subject: "frozen pnpm install",
        reason: "The isolated pinned pnpm toolchain or install step did not complete inside the builder.",
        remediation: "Keep the declared exact pnpm version and the frozen lockfile; fix the reported toolchain or install failure and retry.",
      });
    }
  }
  const pnpmFailure = classifyPnpmInstallFailure(stderr);
  if (pnpmFailure !== undefined) return pnpmFailure;
  if (/\bjust-bash\b|Cannot find package/u.test(stderr)) {
    return classifyEveBuildFailure(stderr);
  }
  if (/eve build/u.test(stderr)) {
    return classifyEveBuildFailure(stderr);
  }
  if (/frozen-lockfile|pnpm --version/u.test(stderr)) {
    return new EvePackagingError({
      code: "DEPENDENCY_AMBIGUITY",
      subject: "frozen pnpm install",
      reason: "The isolated pinned pnpm toolchain or install step did not complete inside the builder.",
      remediation: "Keep the declared exact pnpm version and the frozen lockfile; fix the reported toolchain or install failure and retry.",
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
  return new EvePackagingError({
    code: "DOCKER_PLATFORM_BLOCKED",
    subject: "Docker/OrbStack",
    reason: "The isolated Linux/amd64 Eve builder was unavailable or failed before a verified image was produced.",
    remediation: "Start Docker/OrbStack with BuildKit and retry without changing the project inputs.",
  });
}

function blockedResult(
  error: EvePackagingError,
  extra: Partial<Pick<EveProjectPackagingResult, "writtenPaths">> = {},
): EveProjectPackagingResult {
  return {
    schemaVersion: 1,
    worker: "eve-packaging-worker",
    operation: "local-package",
    status: "blocked",
    returnCode: error.code,
    deployable: false,
    project: null,
    candidate: null,
    snapshot: null,
    toolchain: null,
    image: null,
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
    checks: [{
      id: error.code,
      status: "blocked",
      subject: error.subject,
      reason: error.message,
      remediation: error.remediation,
    }],
    sandboxResumePatch: "absent",
    candidateImageId: null,
    candidateImageRetainedLocally: false,
    writtenPaths: extra.writtenPaths ?? [],
    error: safeError(error),
  };
}

/**
 * Decides the sandbox-resume patch outcome from the `node_modules` the
 * builder copied out of the finished image: the shipped just-bash binding is
 * the single source of truth and stays correct under Docker layer caching
 * (a cached patch step still ships the patched file). Reading never throws —
 * an unreadable tree counts as `absent`.
 */
async function detectEveSandboxResumePatch(
  snapshotRoot: string,
): Promise<EveSandboxResumePatchStatus> {
  try {
    const packageJsonPath = await realpath(
      join(snapshotRoot, "node_modules/eve/package.json"),
    );
    const binding = await readFile(
      join(dirname(packageJsonPath), EVE_JUST_BASH_BINDING_PATH),
      "utf8",
    );
    return binding.includes(EVE_SANDBOX_RESUME_PATCH_SIGNATURE)
      ? "applied"
      : "skipped";
  } catch {
    return "absent";
  }
}

async function currentInputIdentity(
  runtimeConfig: EveRuntimeConfigExclusion | undefined,
): Promise<string | undefined> {
  const token = (
    value: string | EveRuntimeInputIdentity | undefined,
  ): string | undefined => {
    if (typeof value === "string") return value;
    return value?.token;
  };
  if (runtimeConfig?.readInputIdentity !== undefined) {
    return token(await runtimeConfig.readInputIdentity());
  }
  return token(runtimeConfig?.inputIdentity);
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

    const snapshotLockfile = await readStableFile(
      join(snapshotRoot, "pnpm-lock.yaml"),
      snapshotRoot,
    );
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
    const sandboxResumePatch = await detectEveSandboxResumePatch(snapshotRoot);
    const output = await scanGeneratedOutput(snapshotRoot);
    const sandboxCache = await scanGeneratedSandboxCache(snapshotRoot);
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
      sandboxCache,
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
      buildResult.imageId !== undefined &&
      !IMAGE_ID_PATTERN.test(buildResult.imageId)
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
      sandboxCache,
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
        ...(sandboxResumePatch === "applied"
          ? [{
              id: "EVE_SANDBOX_RESUME_PATCH",
              status: "pass",
              subject: "eve-sandbox-resume",
              reason: "applied temporary fix for eve#4440",
              remediation: null,
            } satisfies EvePackagingCheck]
          : []),
      ],
      sandboxResumePatch,
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

export async function revalidateEveProjectCandidateInputs(
  candidate: EveProjectBuildCandidate,
  runtimeConfig?: EveRuntimeConfigExclusion,
): Promise<void> {
  const fail = (): never => {
    throw new EvePackagingError({
      code: "SOURCE_RACE",
      subject: "project inputs",
      reason:
        "The selected Eve source, lockfile, configuration, or explicit environment identity changed after the candidate was built.",
      remediation:
        "Discard the stale candidate and retry only after all selected inputs are quiescent.",
    });
  };
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      await readFile(candidate.inputManifestPath, "utf8"),
    ) as unknown;
  } catch {
    fail();
  }
  if (
    typeof manifestValue !== "object" ||
    manifestValue === null ||
    Array.isArray(manifestValue)
  ) {
    fail();
  }
  const manifest = manifestValue as {
    readonly requestedRoot?: unknown;
    readonly canonicalRoot?: unknown;
    readonly sourceDigest?: unknown;
    readonly packageJsonSha256?: unknown;
    readonly lockfileSha256?: unknown;
    readonly runtimeConfigInputIdentity?: unknown;
  };
  if (
    typeof manifest.requestedRoot !== "string" ||
    typeof manifest.canonicalRoot !== "string" ||
    typeof manifest.sourceDigest !== "string" ||
    typeof manifest.packageJsonSha256 !== "string" ||
    typeof manifest.lockfileSha256 !== "string"
  ) {
    fail();
  }
  const requestedRoot = manifest.requestedRoot as string;
  const canonicalRoot = manifest.canonicalRoot as string;
  const sourceDigest = manifest.sourceDigest as string;
  const packageJsonSha256 = manifest.packageJsonSha256 as string;
  const lockfileSha256 = manifest.lockfileSha256 as string;
  const requestedDetails = await lstat(requestedRoot).catch(() => undefined);
  const requestedCanonical = await realpath(requestedRoot).catch(() => undefined);
  if (
    requestedDetails === undefined ||
    !requestedDetails.isDirectory() ||
    requestedDetails.isSymbolicLink() ||
    requestedCanonical !== canonicalRoot
  ) {
    fail();
  }
  const latestIdentity = await currentInputIdentity(runtimeConfig).catch(() =>
    undefined
  );
  const expectedIdentity = candidate.runtimeConfigInputIdentity;
  if (
    latestIdentity !== expectedIdentity ||
    (typeof manifest.runtimeConfigInputIdentity === "string" &&
      latestIdentity !== manifest.runtimeConfigInputIdentity)
  ) {
    fail();
  }
  let latest: CapturedInputs | undefined;
  try {
    latest = await captureInputs(
      canonicalRoot,
      runtimeConfig,
      resolve(candidate.generationRoot),
      latestIdentity,
      requestedRoot,
    );
  } catch {
    fail();
  }
  const observedLatest = latest ?? fail();
  const packageFile = observedLatest.files.find((file) => file.relativePath === "package.json");
  const lockfile = observedLatest.files.find((file) => file.relativePath === "pnpm-lock.yaml");
  if (
    packageFile === undefined ||
    lockfile === undefined ||
    packageFile.sha256 !== candidate.packageJsonSha256 ||
    packageFile.sha256 !== packageJsonSha256 ||
    lockfile.sha256 !== candidate.lockfileSha256 ||
    lockfile.sha256 !== lockfileSha256 ||
    observedLatest.sourceDigest !== candidate.sourceDigest ||
    observedLatest.sourceDigest !== sourceDigest
  ) {
    fail();
  }
  let latestSnapshotDigest: string | undefined;
  try {
    latestSnapshotDigest = await snapshotDigest(candidate.snapshotRoot);
  } catch {
    fail();
  }
  if (
    latestSnapshotDigest === undefined ||
    latestSnapshotDigest !== candidate.snapshotDigest
  ) {
    fail();
  }
}

async function dockerIdentityAbsent(
  dockerCommand: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  },
): Promise<boolean> {
  try {
    const result = await execFileAsync(dockerCommand, [...args], options);
    return result.stdout.trim().length === 0;
  } catch (error: unknown) {
    const stderr = typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof (error as { readonly stderr?: unknown }).stderr === "string"
      ? (error as { readonly stderr: string }).stderr
      : "";
    return /(?:no such|not found|does not exist)/iu.test(stderr);
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
      const safeEnv = safeDockerEnvironment();
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
          const containerAbsent = await dockerIdentityAbsent(
            dockerCommand,
            ["container", "inspect", containerId, "--format", "{{.Id}}"],
            { env: safeEnv, cwd: request.generationRoot },
          );
          if (!containerAbsent) {
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
          const imageAbsent = await dockerIdentityAbsent(
            dockerCommand,
            ["image", "inspect", builtImageId, "--format", "{{.Id}}"],
            { env: safeEnv, cwd: request.generationRoot },
          );
          if (!imageAbsent) {
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
        if (!IMAGE_ID_PATTERN.test(builtImageId)) {
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
        // The builder stage's `eve build` prewarm writes the just-bash sandbox
        // template under its workdir; the runtime stage copies it to
        // /app/.eve/sandbox-cache (the mkdir in the Dockerfile guarantees the
        // path exists). Extract exactly that subtree so runtime sandboxes can
        // resolve their template; never the rest of `.eve` (sessions, locks,
        // builds). Treated as absent when the container has no such path.
        const sandboxCacheTarget = join(request.snapshotRoot, EVE_SANDBOX_CACHE_ROOT);
        await ensureSnapshotDirectory(request.snapshotRoot, dirname(sandboxCacheTarget));
        try {
          await execFileAsync(
            dockerCommand,
            ["cp", `${containerId}:/app/${EVE_SANDBOX_CACHE_ROOT}`, sandboxCacheTarget],
            { env: safeEnv, cwd: request.generationRoot },
          );
        } catch (error: unknown) {
          const stderr = typeof error === "object" &&
              error !== null &&
              "stderr" in error &&
              typeof error.stderr === "string"
            ? error.stderr
            : "";
          if (
            !/(?:could not find|no such|not found|does not exist)/iu.test(stderr)
          ) {
            throw error;
          }
          // Absent: remove the `.eve` parent this extraction created.
          await rm(dirname(sandboxCacheTarget), { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
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
      const safeEnv = safeDockerEnvironment();
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

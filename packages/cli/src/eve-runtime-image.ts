import {
  createHash,
} from "node:crypto";
import {
  execFile,
  spawn,
} from "node:child_process";
import {
  cp,
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
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import {
  promisify,
} from "node:util";

import {
  EvePackagingError,
  type EveNodeImage,
  type EvePackagingCheck,
  type EvePackagingCode,
  type EveProjectBuildCandidate,
  type EveProjectOutput,
} from "./eve-packaging.js";
import type {
  EveRuntimeInjection,
} from "./eve-runtime-config.js";

const execFileAsync = promisify(execFile);

const START_COMMAND = [
  "./node_modules/.bin/eve",
  "start",
  "--host",
  "0.0.0.0",
  "--port",
  "8080",
] as const;
const HEALTH_PATH = "/eve/v1/health" as const;
const INTERNAL_PORT = 8080 as const;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const NODE_IMAGE_PATTERN = /^node:24\.17\.0(?:-[a-z0-9][a-z0-9._-]*)?$/u;
const FORBIDDEN_RUNTIME_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "credentials.json",
  "service-account.json",
]);

const HOST_ENVIRONMENT = {
  HOST: "0.0.0.0",
  NITRO_HOST: "0.0.0.0",
  PORT: "8080",
  NITRO_PORT: "8080",
  NODE_ENV: "production",
} as const;

export interface EveHostRequirements {
  readonly architecture: string;
  readonly world: "supported" | "unsupported" | "unknown";
  readonly sandbox: "supported" | "unsupported" | "unknown";
  readonly privileged: boolean;
  readonly devices: "none" | "required" | "unknown";
  readonly kernel: "supported" | "unsupported" | "unknown";
  readonly network: "supported" | "unsupported" | "unknown";
  readonly durableLocalFilesystem: boolean;
}

export interface EveRuntimeClosureFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly symbolicLink: boolean;
}

export interface EveRuntimeNativeModule {
  readonly path: string;
  readonly sha256: string;
  readonly platform: "linux/amd64";
}

export interface EveRuntimeClosure {
  readonly root: "/app/node_modules";
  readonly outputDigest: string;
  readonly dependencyDigest: string;
  readonly digest: string;
  readonly files: readonly EveRuntimeClosureFile[];
  readonly nativeModules: readonly EveRuntimeNativeModule[];
  readonly eveStartClosureRetained: true;
  readonly builderOnlyMaterialExcluded: true;
}

export interface EveRuntimeImage extends EveRuntimeImageMetadata {
  readonly runtimeClosure: EveRuntimeClosure;
}

export interface EveRuntimeImageMetadata {
  readonly dockerfilePath: string;
  readonly runtimeContextPath: string;
  readonly platform: "linux/amd64";
  readonly builderImage: string;
  readonly runtimeImage: string;
  readonly imageId: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly launchCommand: typeof START_COMMAND;
  readonly workingDirectory: "/app";
  readonly hostEnvironment: typeof HOST_ENVIRONMENT;
  readonly publicOrigin?: string;
  readonly generatedOutput: EveProjectOutput;
}

export interface EveRuntimeStatus {
  readonly listenHost: "0.0.0.0";
  readonly listenPort: 8080;
  readonly healthMethod: "GET";
  readonly healthPath: typeof HEALTH_PATH;
  readonly healthStatus: "ready";
  readonly healthVerified: true;
  readonly healthVerifiedAt: string;
  readonly durableLocalFilesystemClaim: false;
}

export interface EveRuntimeCleanup {
  readonly bootContainerId: string | null;
  readonly bootContainerRemoved: boolean;
  readonly imageIdentity: "exact" | "indeterminate";
  readonly imageRetained: boolean;
  readonly verified: boolean;
}

export interface EveRuntimeImageRequest {
  readonly candidate: EveProjectBuildCandidate;
  readonly nodeImage: EveNodeImage;
  readonly dockerCommand?: string;
  readonly healthPort: number;
  readonly healthTimeoutMs?: number;
  readonly healthPollIntervalMs?: number;
  readonly fetchHealth?: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly hostRequirements?: EveHostRequirements;
  readonly publicOrigin?: string;
  readonly runtimeInjection?: EveRuntimeInjection;
  /**
   * Preflight must remove its disposable runtime image after health proof.
   * Deploy may retain the exact image for the publication handoff.
   */
  readonly retainImage?: boolean;
}

export interface EveRuntimeImageResult {
  readonly schemaVersion: 1;
  readonly worker: "eve-packaging-worker";
  readonly operation: "runtime-image";
  readonly status: "ready" | "blocked";
  readonly returnCode: EvePackagingCode | "EVE_PACKAGE_READY";
  readonly deployable: boolean;
  readonly candidate: EveProjectBuildCandidate;
  readonly image: EveRuntimeImage | null;
  readonly runtime: EveRuntimeStatus | null;
  readonly cleanup: EveRuntimeCleanup;
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

interface RuntimeClosureCapture {
  readonly files: readonly EveRuntimeClosureFile[];
  readonly nativeModules: readonly EveRuntimeNativeModule[];
  readonly outputDigest: string;
  readonly dependencyDigest: string;
  readonly digest: string;
}

interface DockerState {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly generationRoot: string;
  readonly imageIdPath: string;
  readonly imageLabel: string;
  imageBuilt: boolean;
  imageId: string | undefined;
  containerId: string | undefined;
  imageRetained: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function safeRelativePath(root: string, candidate: string): string {
  return relative(root, candidate).split("\\").join("/");
}

async function assertFreshOwnedFilePath(
  path: string,
  root: string,
  subject: string,
): Promise<string> {
  const canonicalRoot = await realpath(root).catch(() => undefined);
  const canonicalParent = await realpath(dirname(path)).catch(() => undefined);
  const existing = await lstat(path).catch(() => undefined);
  if (
    canonicalRoot === undefined ||
    canonicalParent === undefined ||
    !isWithin(canonicalRoot, resolve(canonicalParent)) ||
    existing !== undefined
  ) {
    throw packagingError(
      "ROOT_INVALID",
      subject,
      "An Eden-owned generated path was missing a regular parent or was already occupied.",
      "Create a fresh Eden-owned generation and retry without following symbolic links.",
    );
  }
  return canonicalParent;
}

async function verifyOwnedFilePath(
  path: string,
  root: string,
  expectedParent: string,
  subject: string,
): Promise<void> {
  const canonicalRoot = await realpath(root).catch(() => undefined);
  const canonicalParent = await realpath(dirname(path)).catch(() => undefined);
  const details = await lstat(path).catch(() => undefined);
  const canonicalPath = await realpath(path).catch(() => undefined);
  if (
    canonicalRoot === undefined ||
    canonicalParent !== expectedParent ||
    details === undefined ||
    !details.isFile() ||
    details.isSymbolicLink() ||
    canonicalPath === undefined ||
    !isWithin(canonicalRoot, resolve(canonicalPath))
  ) {
    throw packagingError(
      "SOURCE_RACE",
      subject,
      "An Eden-owned generated path changed or escaped during creation.",
      "Discard the mixed-generation candidate and retry from a clean Eden-owned generation.",
    );
  }
}

function imageReference(nodeImage: EveNodeImage): string {
  if (
    !NODE_IMAGE_PATTERN.test(nodeImage.reference) ||
    !IMAGE_ID_PATTERN.test(nodeImage.digest)
  ) {
    throw new EvePackagingError({
      code: "DOCKER_PLATFORM_BLOCKED",
      subject: "node-24-image",
      reason: "The runtime image requires an immutable Linux/amd64 Node 24 image.",
      remediation: "Supply the verified Node 24 image reference and sha256 digest.",
    });
  }
  return `${nodeImage.reference}@${nodeImage.digest}`;
}

function packagingError(
  code: EvePackagingCode,
  subject: string,
  reason: string,
  remediation: string,
): EvePackagingError {
  return new EvePackagingError({
    code,
    subject,
    reason,
    remediation,
  });
}

export function validateEveHostRequirements(
  requirements: EveHostRequirements,
): void {
  if (requirements.architecture !== "linux/amd64") {
    throw packagingError(
      "DOCKER_PLATFORM_BLOCKED",
      "architecture",
      "The Eve Container requires Linux/amd64 execution.",
      "Run the project with a Docker/OrbStack builder that can prove linux/amd64; no alternate architecture is selected.",
    );
  }
  if (requirements.world !== "supported") {
    throw packagingError(
      "UNSUPPORTED_HOST_REQUIREMENT",
      "Workflow World",
      "The selected Workflow World has an unknown or unsupported Container host requirement.",
      "Configure a project-owned Eve-compatible World whose runtime requirements are supported by a disposable Linux/amd64 Container.",
    );
  }
  if (requirements.sandbox !== "supported") {
    throw packagingError(
      "UNSUPPORTED_HOST_REQUIREMENT",
      "sandbox",
      "The selected Eve sandbox has an unknown or unsupported Container host requirement.",
      "Use a sandbox that can prewarm without privileged, device, or host-kernel access, or run the project outside Eden Eve.",
    );
  }
  if (requirements.privileged) {
    throw packagingError(
      "UNSUPPORTED_HOST_REQUIREMENT",
      "privileged execution",
      "The Eve project requires privileged Container execution outside the hosting contract.",
      "Remove the privileged requirement or run the project on a host that explicitly supports it; Eden does not adapt or substitute the runtime.",
    );
  }
  if (requirements.devices !== "none") {
    throw packagingError(
      "UNSUPPORTED_HOST_REQUIREMENT",
      "device access",
      "The Eve project requires a device or unknown device capability outside the hosting contract.",
      "Remove the device requirement or choose a supported host; Eden does not grant devices or fall back to Native.",
    );
  }
  if (requirements.kernel !== "supported") {
    throw packagingError(
      "UNSUPPORTED_HOST_REQUIREMENT",
      "kernel capability",
      "The Eve project requires an unknown or unsupported host-kernel capability.",
      "Use only the documented process, network, and disposable-filesystem capabilities of the Linux/amd64 Container.",
    );
  }
  if (requirements.network !== "supported") {
    throw packagingError(
      "UNSUPPORTED_HOST_REQUIREMENT",
      "outbound network",
      "The Eve project requires an unknown or unsupported Container network capability.",
      "Use only bounded outbound networking supported by the Linux/amd64 Container; Eden does not provide a network adapter or fallback.",
    );
  }
  if (requirements.durableLocalFilesystem) {
    throw packagingError(
      "UNSUPPORTED_HOST_REQUIREMENT",
      "durable local filesystem",
      "The Eve project requires durable local Container filesystem state.",
      "Configure a project-owned durable Eve-compatible World or external service; Container-local disk is disposable.",
    );
  }
}

async function readRegularFile(
  path: string,
  containmentRoot?: string,
): Promise<{
  readonly bytes: Buffer;
  readonly sha256: string;
}> {
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
    throw packagingError(
      "RUNTIME_CLOSURE_INCOMPLETE",
      safeRelativePath(containmentRoot ?? dirname(path), path),
      "The candidate runtime file parent escaped its immutable runtime root.",
      "Regenerate the immutable Eve candidate with regular runtime files inside the snapshot.",
    );
  }
  const details = await lstat(path).catch(() => undefined);
  if (details === undefined || !details.isFile() || details.isSymbolicLink()) {
    throw packagingError(
      "RUNTIME_CLOSURE_INCOMPLETE",
      path,
      "The candidate runtime closure contains a missing or non-regular file.",
      "Regenerate the immutable Eve candidate with a complete output and project-local start closure.",
    );
  }
  const bytes = await readFile(path);
  const secondRead = await readFile(path).catch(() => undefined);
  const parentAfter = containmentRoot === undefined
    ? undefined
    : await realpath(dirname(path)).catch(() => undefined);
  if (
    secondRead === undefined ||
    !bytes.equals(secondRead) ||
    (containmentRoot !== undefined && parentAfter !== parentBefore)
  ) {
    throw packagingError(
      "SOURCE_RACE",
      safeRelativePath(containmentRoot ?? dirname(path), path),
      "The candidate runtime file parent changed during validation.",
      "Discard the mixed-generation runtime candidate and rebuild from quiescent inputs.",
    );
  }
  return { bytes, sha256: sha256(bytes) };
}

async function captureRuntimeTree(
  root: string,
  snapshotRoot: string,
  label: "output" | "dependencies",
): Promise<{
  readonly files: readonly EveRuntimeClosureFile[];
  readonly nativeModules: readonly EveRuntimeNativeModule[];
  readonly digest: string;
}> {
  const canonicalRoot = await realpath(root).catch(() => undefined);
  const canonicalSnapshotRoot = await realpath(snapshotRoot).catch(() => undefined);
  if (
    canonicalRoot === undefined ||
    canonicalSnapshotRoot === undefined ||
    !isWithin(canonicalSnapshotRoot, resolve(canonicalRoot))
  ) {
    throw packagingError(
      "RUNTIME_CLOSURE_INCOMPLETE",
      safeRelativePath(snapshotRoot, root),
      "The candidate runtime closure root is missing or escapes the immutable snapshot.",
      "Regenerate the immutable Eve candidate with regular runtime roots inside the snapshot.",
    );
  }
  const files: EveRuntimeClosureFile[] = [];
  const nativeModules: EveRuntimeNativeModule[] = [];
  const visit = async (directory: string): Promise<void> => {
    const directoryDetails = await lstat(directory).catch(() => undefined);
    const directoryCanonical = await realpath(directory).catch(() => undefined);
    if (
      directoryDetails === undefined ||
      !directoryDetails.isDirectory() ||
      directoryDetails.isSymbolicLink() ||
      directoryCanonical === undefined ||
      !isWithin(canonicalSnapshotRoot, resolve(directoryCanonical))
    ) {
      throw packagingError(
        "RUNTIME_CLOSURE_INCOMPLETE",
        safeRelativePath(canonicalSnapshotRoot, directory),
        "The candidate runtime closure directory escaped or changed during validation.",
        "Regenerate the immutable Eve candidate with regular runtime directories inside the snapshot.",
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      const relativePath = safeRelativePath(canonicalSnapshotRoot, candidate);
      if (FORBIDDEN_RUNTIME_NAMES.has(entry.name) ||
        entry.name.startsWith(".env") ||
        entry.name.endsWith(".pem") ||
        entry.name.endsWith(".key")) {
        throw packagingError(
          "SECRET_EXCLUSION_FAILED",
          relativePath,
          "The candidate runtime closure contains an environment or credential file.",
          "Remove credential material from the project dependency/output closure and rebuild the candidate.",
        );
      }
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(candidate).catch(() => undefined);
        if (
          resolved === undefined ||
          !isWithin(canonicalRoot, resolve(resolved))
        ) {
          throw packagingError(
            "RUNTIME_CLOSURE_INCOMPLETE",
            relativePath,
            "The candidate runtime closure contains a symbolic link that escapes its runtime root.",
            "Materialize the Eve output and dependencies inside the immutable runtime closure before image assembly.",
          );
        }
        const targetParts = safeRelativePath(canonicalRoot, resolve(resolved))
          .split("/");
        if (
          targetParts.some((part) =>
            FORBIDDEN_RUNTIME_NAMES.has(part) ||
            part.startsWith(".env") ||
            part.endsWith(".pem") ||
            part.endsWith(".key")
          )
        ) {
          throw packagingError(
            "SECRET_EXCLUSION_FAILED",
            relativePath,
            "The candidate runtime closure contains a symbolic link to credential or environment material.",
            "Remove links to credential material from the project dependency/output closure and rebuild the candidate.",
          );
        }
        await validateRuntimeTargetTree(
          resolve(resolved),
          canonicalRoot,
          new Set<string>(),
        );
        files.push({
          path: relativePath,
          sha256: `link:${await readlink(candidate)}`,
          byteLength: 0,
          symbolicLink: true,
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile()) {
        throw packagingError(
          "RUNTIME_CLOSURE_INCOMPLETE",
          relativePath,
          "The candidate runtime closure contains a device, socket, FIFO, or other unsupported file.",
          "Regenerate the Eve candidate with regular runtime files only.",
        );
      }
      const { bytes, sha256: digest } = await readRegularFile(
        candidate,
        canonicalRoot,
      );
      files.push({
        path: relativePath,
        sha256: digest,
        byteLength: bytes.byteLength,
        symbolicLink: false,
      });
      if (entry.name.endsWith(".node")) {
        const fileResult = await execFileAsync("file", [candidate], {
          maxBuffer: 1024 * 1024,
        }).catch(() => undefined);
        if (
          fileResult === undefined ||
          !/ELF 64-bit/u.test(fileResult.stdout)
        ) {
          throw packagingError(
            "RUNTIME_CLOSURE_INCOMPLETE",
            relativePath,
            "A native Eve dependency could not be verified as a loadable module.",
            "Rebuild native dependencies for Linux/amd64 inside the immutable builder.",
          );
        }
        if (!/(?:x86-64|x86_64|AMD64)/u.test(fileResult.stdout)) {
          throw packagingError(
            "RUNTIME_CLOSURE_INCOMPLETE",
            relativePath,
            "A native Eve dependency was built for an unsupported architecture.",
            "Rebuild native dependencies for Linux/amd64 inside the immutable builder.",
          );
        }
        nativeModules.push({
          path: relativePath,
          sha256: digest,
          platform: "linux/amd64",
        });
      }
    }
  };
  await visit(canonicalRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  nativeModules.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    nativeModules,
    digest: sha256(jsonBytes({
      label,
      files,
      nativeModules,
    })),
  };
}

async function validateRuntimeTargetTree(
  path: string,
  root: string,
  visited: Set<string>,
): Promise<void> {
  const details = await lstat(path).catch(() => undefined);
  const canonical = await realpath(path).catch(() => undefined);
  if (
    details === undefined ||
    canonical === undefined ||
    !isWithin(root, resolve(canonical))
  ) {
    throw packagingError(
      "RUNTIME_CLOSURE_INCOMPLETE",
      safeRelativePath(root, path),
      "A runtime closure link target is missing or escapes its runtime root.",
      "Materialize the Eve output and dependencies inside the immutable runtime closure before image assembly.",
    );
  }
  const canonicalPath = resolve(canonical);
  if (visited.has(canonicalPath)) return;
  visited.add(canonicalPath);
  const targetName = canonicalPath.split("/").at(-1) ?? "";
  if (
    FORBIDDEN_RUNTIME_NAMES.has(targetName) ||
    targetName.startsWith(".env") ||
    targetName.endsWith(".pem") ||
    targetName.endsWith(".key")
  ) {
    throw packagingError(
      "SECRET_EXCLUSION_FAILED",
      safeRelativePath(root, path),
      "A runtime closure link target is credential or environment material.",
      "Remove credential material from the project dependency/output closure and rebuild the candidate.",
    );
  }
  if (details.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      await validateRuntimeTargetTree(
        join(path, entry.name),
        root,
        visited,
      );
    }
    return;
  }
  if (!details.isFile() && !details.isSymbolicLink()) {
    throw packagingError(
      "RUNTIME_CLOSURE_INCOMPLETE",
      safeRelativePath(root, path),
      "A runtime closure link target is not a regular file or directory.",
      "Regenerate the immutable Eve candidate with regular runtime files only.",
    );
  }
}

async function validateCandidateClosure(
  candidate: EveProjectBuildCandidate,
): Promise<RuntimeClosureCapture> {
  const generationRoot = resolve(candidate.generationRoot);
  const requestedSnapshotRoot = resolve(candidate.snapshotRoot);
  const canonicalGenerationRoot = await realpath(generationRoot).catch(() =>
    generationRoot
  );
  const snapshotRoot = await realpath(requestedSnapshotRoot).catch(() =>
    requestedSnapshotRoot
  );
  if (
    !isWithin(generationRoot, requestedSnapshotRoot) ||
    !isWithin(canonicalGenerationRoot, snapshotRoot) ||
    !isWithin(generationRoot, resolve(candidate.inputManifestPath))
  ) {
    throw packagingError(
      "RUNTIME_CLOSURE_INCOMPLETE",
      "candidate",
      "The validated Eve candidate points outside its Eden-owned generation.",
      "Pass the immutable candidate returned by the Eve snapshot/build boundary without changing its paths.",
    );
  }
  if (candidate.generatedOutput.entrypointPath !== ".output/server/index.mjs") {
    throw packagingError(
      "UNSUPPORTED_EVE_OUTPUT",
      "generated Eve entrypoint",
      "The runtime candidate does not identify the required .output/server/index.mjs artifact.",
      "Regenerate the Eve candidate with the project-local Eve/Nitro entrypoint at .output/server/index.mjs.",
    );
  }
  const outputRoot = join(snapshotRoot, ".output");
  const dependenciesRoot = join(snapshotRoot, "node_modules");
  const outputDetails = await lstat(outputRoot).catch(() => undefined);
  const dependencyDetails = await lstat(dependenciesRoot).catch(() => undefined);
  if (
    outputDetails === undefined ||
    !outputDetails.isDirectory() ||
    outputDetails.isSymbolicLink() ||
    dependencyDetails === undefined ||
    !dependencyDetails.isDirectory() ||
    dependencyDetails.isSymbolicLink()
  ) {
    throw packagingError(
      "RUNTIME_CLOSURE_INCOMPLETE",
      ".output/node_modules",
      "The validated Eve candidate is missing its generated output or project dependency closure.",
      "Regenerate the candidate and retain both .output and the installed runtime dependencies.",
    );
  }
  const entrypoint = join(outputRoot, candidate.generatedOutput.entrypointPath.slice(".output/".length));
  const entrypointDetails = await lstat(entrypoint).catch(() => undefined);
  if (
    entrypointDetails === undefined ||
    !entrypointDetails.isFile() ||
    entrypointDetails.isSymbolicLink()
  ) {
    throw packagingError(
      "UNSUPPORTED_EVE_OUTPUT",
      candidate.generatedOutput.entrypointPath,
      "The candidate does not retain the regular generated Eve/Nitro server entrypoint.",
      "Regenerate .output/server/index.mjs inside the immutable Eve candidate.",
    );
  }
  const eveBin = join(dependenciesRoot, ".bin/eve");
  const eveDetails = await lstat(eveBin).catch(() => undefined);
  const eveResolved = await realpath(eveBin).catch(() => undefined);
  if (
    eveDetails === undefined ||
    (!eveDetails.isFile() && !eveDetails.isSymbolicLink()) ||
    eveResolved === undefined ||
    !isWithin(snapshotRoot, resolve(eveResolved))
  ) {
    throw packagingError(
      "UNSUPPORTED_EVE_OUTPUT",
      "node_modules/.bin/eve",
      "The candidate does not retain a project-local Eve start executable inside its dependency tree.",
      "Retain the installed project-local Eve CLI and its start closure in the candidate.",
    );
  }
  const eveResolvedDetails = await lstat(eveResolved).catch(() => undefined);
  if (
    eveResolvedDetails === undefined ||
    !eveResolvedDetails.isFile() ||
    (eveResolvedDetails.mode & 0o111) === 0
  ) {
    throw packagingError(
      "UNSUPPORTED_EVE_OUTPUT",
      "node_modules/.bin/eve",
      "The candidate Eve start executable is not executable.",
      "Rebuild the project-local Eve dependency closure in the pinned builder.",
    );
  }
  const [output, dependencies] = await Promise.all([
    captureRuntimeTree(outputRoot, snapshotRoot, "output"),
    captureRuntimeTree(dependenciesRoot, snapshotRoot, "dependencies"),
  ]);
  const entrypointBytes = await readRegularFile(entrypoint, snapshotRoot);
  const candidateOutputDigest = sha256(jsonBytes(
    output.files.map((file) => ({
      relativePath: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
    })),
  ));
  if (
    entrypointBytes.sha256 !== candidate.generatedOutput.sha256 ||
    output.files.length !== candidate.generatedOutput.fileCount ||
    candidateOutputDigest !== candidate.generatedOutput.outputDigest
  ) {
    throw packagingError(
      "SOURCE_RACE",
      ".output",
      "The generated Eve output no longer matches the immutable candidate digest.",
      "Discard the mixed-generation runtime candidate and rebuild from a quiescent snapshot.",
    );
  }
  return {
    files: [...output.files, ...dependencies.files],
    nativeModules: dependencies.nativeModules,
    outputDigest: output.digest,
    dependencyDigest: dependencies.digest,
    digest: sha256(jsonBytes({
      outputDigest: output.digest,
      dependencyDigest: dependencies.digest,
    })),
  };
}

export async function revalidateEveRuntimeCandidate(
  candidate: EveProjectBuildCandidate,
): Promise<EveRuntimeClosure> {
  const closure = await validateCandidateClosure(candidate);
  return {
    root: "/app/node_modules",
    outputDigest: closure.outputDigest,
    dependencyDigest: closure.dependencyDigest,
    digest: closure.digest,
    files: closure.files,
    nativeModules: closure.nativeModules,
    eveStartClosureRetained: true,
    builderOnlyMaterialExcluded: true,
  };
}

async function writeRuntimeContext(
  candidate: EveProjectBuildCandidate,
  nodeImage: EveNodeImage,
  closure: RuntimeClosureCapture,
): Promise<{
  readonly runtimeContextPath: string;
  readonly dockerfilePath: string;
}> {
  const runtimeContextPath = join(candidate.generationRoot, "container/runtime-context");
  const dockerfilePath = join(candidate.generationRoot, "container/runtime.Dockerfile");
  const existing = await lstat(runtimeContextPath).catch(() => undefined);
  if (existing !== undefined) {
    throw packagingError(
      "ROOT_INVALID",
      "runtime-context",
      "The Eden-owned runtime context already exists and cannot be reused.",
      "Create a fresh immutable Eve generation before assembling a runtime image.",
    );
  }
  const runtimeContextParent = await assertFreshOwnedFilePath(
    runtimeContextPath,
    candidate.generationRoot,
    "runtime-context",
  );
  await mkdir(runtimeContextPath);
  const runtimeContextDetails = await lstat(runtimeContextPath).catch(() => undefined);
  const runtimeContextCanonical = await realpath(runtimeContextPath).catch(() => undefined);
  if (
    runtimeContextDetails === undefined ||
    !runtimeContextDetails.isDirectory() ||
    runtimeContextDetails.isSymbolicLink() ||
    runtimeContextCanonical === undefined ||
    !isWithin(runtimeContextParent, resolve(runtimeContextCanonical))
  ) {
    throw packagingError(
      "ROOT_INVALID",
      "runtime-context",
      "The Eden-owned runtime context could not be created as a regular contained directory.",
      "Create a fresh immutable Eve generation before assembling a runtime image.",
    );
  }
  try {
    await cp(
      join(candidate.snapshotRoot, ".output"),
      join(runtimeContextPath, ".output"),
      { recursive: true },
    );
    await cp(
      join(candidate.snapshotRoot, "node_modules"),
      join(runtimeContextPath, "node_modules"),
      { recursive: true },
    );
    const copiedOutput = await captureRuntimeTree(
      join(runtimeContextPath, ".output"),
      runtimeContextPath,
      "output",
    );
    const copiedDependencies = await captureRuntimeTree(
      join(runtimeContextPath, "node_modules"),
      runtimeContextPath,
      "dependencies",
    );
    if (
      copiedOutput.digest !== closure.outputDigest ||
      copiedDependencies.digest !== closure.dependencyDigest
    ) {
      throw packagingError(
        "SOURCE_RACE",
        "runtime context",
        "The copied runtime context does not match the validated immutable closure.",
        "Discard the mixed-generation runtime context and rebuild from a quiescent candidate.",
      );
    }
    const dockerfile = `# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 ${imageReference(nodeImage)} AS candidate
WORKDIR /candidate
COPY .output /candidate/.output
COPY node_modules /candidate/node_modules

FROM --platform=linux/amd64 ${imageReference(nodeImage)} AS runtime
WORKDIR /app
ENV HOST=0.0.0.0 \\
    NITRO_HOST=0.0.0.0 \\
    PORT=8080 \\
    NITRO_PORT=8080 \\
    NODE_ENV=production
COPY --from=candidate /candidate/.output /app/.output
COPY --from=candidate /candidate/node_modules /app/node_modules
EXPOSE 8080
ENTRYPOINT ["./node_modules/.bin/eve", "start", "--host", "0.0.0.0", "--port", "8080"]
`;
    const dockerignore = `*
!.output
!.output/**
!node_modules
!node_modules/**
`;
    const dockerfileParent = await assertFreshOwnedFilePath(
      dockerfilePath,
      candidate.generationRoot,
      "runtime Dockerfile",
    );
    await writeFile(dockerfilePath, dockerfile, {
      flag: "wx",
      encoding: "utf8",
      mode: 0o600,
    });
    await verifyOwnedFilePath(
      dockerfilePath,
      candidate.generationRoot,
      dockerfileParent,
      "runtime Dockerfile",
    );
    const dockerignorePath = join(runtimeContextPath, ".dockerignore");
    const dockerignoreParent = await assertFreshOwnedFilePath(
      dockerignorePath,
      candidate.generationRoot,
      "runtime .dockerignore",
    );
    await writeFile(dockerignorePath, dockerignore, {
      flag: "wx",
      encoding: "utf8",
      mode: 0o600,
    });
    await verifyOwnedFilePath(
      dockerignorePath,
      candidate.generationRoot,
      dockerignoreParent,
      "runtime .dockerignore",
    );
    const forbiddenRuntimeConfigFile = (file: EveRuntimeClosureFile): boolean =>
      file.path.split("/").some((segment) =>
        segment.startsWith(".env") || segment === ".npmrc"
      );
    if (dockerfile.includes("RUNTIME_SECRET") ||
      closure.files.some(forbiddenRuntimeConfigFile)) {
      throw packagingError(
        "SECRET_EXCLUSION_FAILED",
        "runtime image context",
        "The generated runtime context contains forbidden runtime configuration material.",
        "Remove runtime values and package-manager credentials before image assembly.",
      );
    }
    return { runtimeContextPath, dockerfilePath };
  } catch (error: unknown) {
    if (
      !(await removeOwnedRuntimeContext(
        runtimeContextPath,
        candidate.generationRoot,
      ))
    ) {
      throw packagingError(
        "CLEANUP_UNVERIFIED",
        "runtime context",
        "The owned runtime context could not be removed with exact containment proof.",
        "Inspect only the recorded runtime context path; no broad filesystem cleanup was attempted.",
      );
    }
    throw error;
  }
}

async function removeOwnedRuntimeContext(
  runtimeContextPath: string,
  generationRoot: string,
): Promise<boolean> {
  let details: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    details = await lstat(runtimeContextPath);
  } catch (error: unknown) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT";
  }
  if (details === undefined) return true;
  if (!details.isDirectory() || details.isSymbolicLink()) return false;
  let canonical: string;
  let canonicalGenerationRoot: string;
  try {
    canonical = await realpath(runtimeContextPath);
    canonicalGenerationRoot = await realpath(generationRoot);
  } catch {
    return false;
  }
  if (
    canonical === undefined ||
    !isWithin(resolve(canonicalGenerationRoot), resolve(canonical))
  ) {
    return false;
  }
  try {
    await rm(runtimeContextPath, { recursive: true, force: false });
  } catch {
    return false;
  }
  try {
    await lstat(runtimeContextPath);
    return false;
  } catch (error: unknown) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT";
  }
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

async function docker(
  state: DockerState,
  args: readonly string[],
  options: { readonly maxBuffer?: number } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFileAsync(state.command, [...args], {
    env: state.env,
    cwd: state.generationRoot,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
  });
}

async function dockerWithInput(
  state: DockerState,
  args: readonly string[],
  input: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(state.command, [...args], {
      cwd: state.generationRoot,
      env: state.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectResult);
    child.once("close", (code) => {
      if (code === 0) {
        resolveResult({ stdout, stderr });
      } else {
        const error = new Error(stderr || "The Docker operation failed.");
        Object.assign(error, { stdout, stderr, code });
        rejectResult(error);
      }
    });
    child.stdin.end(input);
  });
}

function runtimeContainerEnvironment(
  request: EveRuntimeImageRequest,
): Readonly<Record<string, string>> {
  return {
    ...HOST_ENVIRONMENT,
    ...(request.publicOrigin === undefined
      ? {}
      : { WORKFLOW_LOCAL_BASE_URL: request.publicOrigin }),
  };
}

function validateHealthPort(port: number): void {
  if (!Number.isInteger(port) || port < 4310 || port > 4399) {
    throw packagingError(
      "DOCKER_PLATFORM_BLOCKED",
      "health port",
      "The local Eve health probe must use a task-owned host port in 4310-4399.",
      "Choose an unused task-owned host port between 4310 and 4399.",
    );
  }
}

function validateHealthTiming(timeoutMs: number, pollIntervalMs: number): void {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0
  ) {
    throw packagingError(
      "EVE_HEALTH_FAILED",
      "health deadline",
      "The Eve health probe requires finite positive timeout and polling intervals.",
      "Use a bounded positive health timeout and polling interval.",
    );
  }
}

async function recoverImageIdentity(state: DockerState): Promise<string | undefined> {
  const fromIid = await readFile(state.imageIdPath, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (IMAGE_ID_PATTERN.test(fromIid)) return fromIid;
  const listed = await docker(state, [
    "image",
    "ls",
    "--no-trunc",
    "--filter",
    `label=${state.imageLabel}`,
    "--format",
    "{{.ID}}",
  ]).catch(() => undefined);
  const matches = (listed?.stdout ?? "")
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => IMAGE_ID_PATTERN.test(value));
  return matches.length === 1 ? matches[0] : undefined;
}

async function validateImageMetadata(
  state: DockerState,
  imageId: string,
): Promise<void> {
  const details = await docker(state, [
    "image",
    "inspect",
    imageId,
    "--format",
    "{{.Id}} {{.Os}} {{.Architecture}}",
  ]);
  const [actualId, os, architecture] = details.stdout.trim().split(/\s+/u);
  if (actualId !== imageId || os !== "linux" || architecture !== "amd64") {
    throw packagingError(
      "DOCKER_PLATFORM_BLOCKED",
      "linux/amd64 image",
      "The runtime image did not report the required Linux/amd64 identity.",
      "Use a Docker/OrbStack builder that can inspect a Linux/amd64 image before retaining it.",
    );
  }
  const entrypoint = await docker(state, [
    "image",
    "inspect",
    imageId,
    "--format",
    "{{json .Config.Entrypoint}}",
  ]);
  if (entrypoint.stdout.trim() !== JSON.stringify([...START_COMMAND])) {
    throw packagingError(
      "UNSUPPORTED_EVE_OUTPUT",
      "Container launch command",
      "The runtime image does not launch the project-local Eve start supervisor with the required host and port.",
      "Use ./node_modules/.bin/eve start --host 0.0.0.0 --port 8080 as the image entrypoint.",
    );
  }
  const workingDirectory = await docker(state, [
    "image",
    "inspect",
    imageId,
    "--format",
    "{{.Config.WorkingDir}}",
  ]);
  if (workingDirectory.stdout.trim() !== "/app") {
    throw packagingError(
      "UNSUPPORTED_EVE_OUTPUT",
      "Container working directory",
      "The runtime image does not use /app as its self-contained working directory.",
      "Build the runtime image with the generated Eve output and start closure under /app.",
    );
  }
  const environment = await docker(state, [
    "image",
    "inspect",
    imageId,
    "--format",
    "{{json .Config.Env}}",
  ]);
  let values: unknown;
  try {
    values = JSON.parse(environment.stdout.trim()) as unknown;
  } catch {
    throw packagingError(
      "DOCKER_PLATFORM_BLOCKED",
      "runtime environment",
      "The runtime image environment could not be inspected safely.",
      "Use a Docker builder that returns JSON image configuration metadata.",
    );
  }
  if (
    !Array.isArray(values) ||
    Object.entries(HOST_ENVIRONMENT).some(([name, value]) =>
      !values.includes(`${name}=${value}`)
    )
  ) {
    throw packagingError(
      "UNSUPPORTED_EVE_OUTPUT",
      "host environment",
      "The runtime image is missing one or more required host-owned Eve variables.",
      "Retain HOST, NITRO_HOST, PORT, NITRO_PORT, and NODE_ENV in the final image.",
    );
  }
  const history = await docker(state, ["history", "--no-trunc", imageId]);
  if (/(?:\.env|\.npmrc|credentials|secret|token|password)/iu.test(history.stdout)) {
    throw packagingError(
      "SECRET_EXCLUSION_FAILED",
      "image history",
      "The runtime image history contains a credential or runtime environment marker.",
      "Rebuild without runtime values, credentials, or secret-bearing Docker arguments.",
    );
  }
}

async function removeOwnedContainer(
  state: DockerState,
): Promise<boolean> {
  if (state.containerId === undefined) return true;
  let verified = true;
  await docker(state, ["stop", "--time", "5", state.containerId]).catch(() => {
    verified = false;
  });
  await docker(state, ["rm", "--force", state.containerId]).catch(() => {
    verified = false;
  });
  let remaining: { readonly stdout: string } | undefined;
  try {
    remaining = await docker(state, [
      "container",
      "inspect",
      state.containerId,
      "--format",
      "{{.Id}}",
    ]);
  } catch (error: unknown) {
    const stderr = typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof (error as { readonly stderr?: unknown }).stderr === "string"
      ? (error as { readonly stderr: string }).stderr
      : "";
    if (!/(?:no such|not found|does not exist)/iu.test(stderr)) {
      verified = false;
    }
  }
  if (remaining !== undefined && remaining.stdout.trim().length > 0) {
    verified = false;
  }
  return verified;
}

async function removeOwnedImage(
  state: DockerState,
): Promise<boolean> {
  if (!state.imageBuilt) return true;
  if (state.imageId === undefined) return false;
  let verified = true;
  await docker(state, ["image", "rm", "--force", state.imageId]).catch(() => {
    verified = false;
  });
  let remaining: { readonly stdout: string } | undefined;
  try {
    remaining = await docker(state, [
      "image",
      "inspect",
      state.imageId,
      "--format",
      "{{.Id}}",
    ]);
  } catch (error: unknown) {
    const stderr = typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof (error as { readonly stderr?: unknown }).stderr === "string"
      ? (error as { readonly stderr: string }).stderr
      : "";
    if (!/(?:no such|not found|does not exist)/iu.test(stderr)) {
      verified = false;
    }
  }
  if (remaining !== undefined && remaining.stdout.trim().length > 0) {
    verified = false;
  }
  return verified;
}

function healthReady(value: unknown): boolean {
  if (value === "ready") return true;
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => healthReady(item));
  const record = value as Record<string, unknown>;
  if (
    record.ready === true ||
    record.healthy === true ||
    record.status === "ready" ||
    record.state === "ready" ||
    record.health === "ready"
  ) {
    return true;
  }
  return false;
}

async function pollEveHealth(
  port: number,
  timeoutMs: number,
  pollIntervalMs: number,
  fetchHealth: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>,
): Promise<void> {
  const url = `http://127.0.0.1:${port}${HEALTH_PATH}`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unreachable";
  while (Date.now() <= deadline) {
    try {
      const response = await fetchHealth(url, {
        method: "GET",
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, timeoutMs))),
      });
      const body = await response.text();
      lastStatus = `${response.status}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        parsed = body;
      }
      if (response.ok && healthReady(parsed)) return;
    } catch {
      lastStatus = "unreachable";
    }
    if (Date.now() + pollIntervalMs > deadline) break;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, pollIntervalMs);
    });
  }
  throw packagingError(
    "EVE_HEALTH_FAILED",
    HEALTH_PATH,
    `The real Eve health route did not report ready before the bounded deadline (last status: ${lastStatus}).`,
    "Inspect the project-local eve start supervisor, Nitro child, sandbox prewarm, and Workflow World startup without replacing them with a synthetic listener.",
  );
}

function errorRecord(error: EvePackagingError): EveRuntimeImageResult["error"] {
  return {
    code: error.code,
    subject: error.subject,
    reason: error.message,
    remediation: error.remediation,
  };
}

function blockedResult(
  candidate: EveProjectBuildCandidate,
  error: EvePackagingError,
  cleanup: EveRuntimeCleanup,
  writtenPaths: readonly string[],
): EveRuntimeImageResult {
  return {
    schemaVersion: 1,
    worker: "eve-packaging-worker",
    operation: "runtime-image",
    status: "blocked",
    returnCode: error.code,
    deployable: false,
    candidate,
    image: null,
    runtime: null,
    cleanup,
    checks: [{
      id: error.code,
      status: "blocked",
      subject: error.subject,
      reason: error.message,
      remediation: error.remediation,
    }],
    candidateImageId: null,
    candidateImageRetainedLocally: false,
    writtenPaths,
    error: errorRecord(error),
  };
}

export async function buildEveRuntimeImage(
  request: EveRuntimeImageRequest,
): Promise<EveRuntimeImageResult> {
  const dockerCommand = request.dockerCommand ?? "docker";
  const healthPort = request.healthPort;
  const timeoutMs = request.healthTimeoutMs ?? 30_000;
  const pollIntervalMs = request.healthPollIntervalMs ?? 100;
  const retainImage = request.retainImage ?? true;
  const writtenPaths: string[] = [];
  let imageIdentity: "exact" | "indeterminate" = "indeterminate";
  let imageRetained = false;
  let cleanupVerified = true;
  let containerRemoved = true;
  let bootContainerId: string | null = null;
  let runtimeContextPath: string | undefined;
  const state: DockerState = {
    command: dockerCommand,
    env: safeDockerEnvironment(),
    generationRoot: request.candidate.generationRoot,
    imageIdPath: join(request.candidate.generationRoot, "runtime-image-id"),
    imageLabel: `eden.eve.generation=${request.candidate.generationId}`,
    imageBuilt: false,
    imageId: undefined,
    containerId: undefined,
    imageRetained: false,
  };
  try {
    validateHealthPort(healthPort);
    validateHealthTiming(timeoutMs, pollIntervalMs);
    if (request.hostRequirements === undefined) {
      throw packagingError(
        "UNSUPPORTED_HOST_REQUIREMENT",
        "host requirements",
        "The Eve project host requirements were not proven for the runtime image.",
        "Provide an explicit host-capability result for Linux/amd64, World, sandbox, process, network, and disposable storage behavior.",
      );
    }
    validateEveHostRequirements(request.hostRequirements);
    const closure = await validateCandidateClosure(request.candidate);
    const context = await writeRuntimeContext(
      request.candidate,
      request.nodeImage,
      closure,
    );
    runtimeContextPath = context.runtimeContextPath;
    writtenPaths.push(context.runtimeContextPath, context.dockerfilePath);
    await docker(state, ["version", "--format", "{{.Server.Version}}"]);
    state.imageBuilt = true;
    await docker(state, [
      "build",
      "--platform=linux/amd64",
      "--file",
      context.dockerfilePath,
      "--iidfile",
      state.imageIdPath,
      "--label",
      state.imageLabel,
      context.runtimeContextPath,
    ]);
    const postBuildOutput = await captureRuntimeTree(
      join(context.runtimeContextPath, ".output"),
      context.runtimeContextPath,
      "output",
    );
    const postBuildDependencies = await captureRuntimeTree(
      join(context.runtimeContextPath, "node_modules"),
      context.runtimeContextPath,
      "dependencies",
    );
    if (
      postBuildOutput.digest !== closure.outputDigest ||
      postBuildDependencies.digest !== closure.dependencyDigest
    ) {
      throw packagingError(
        "SOURCE_RACE",
        "runtime context",
        "The runtime context changed while the immutable Linux/amd64 image was being built.",
        "Discard the mixed-generation runtime image and rebuild from a quiescent candidate.",
      );
    }
    state.imageId = await recoverImageIdentity(state);
    if (state.imageId === undefined) {
      throw packagingError(
        "CLEANUP_UNVERIFIED",
        "runtime image identity",
        "The runtime image build completed but its immutable identity could not be recovered.",
        "Use a Docker/OrbStack builder that preserves an iidfile or one exact generation label; cleanup is indeterminate and no broad image deletion was attempted.",
      );
    }
    imageIdentity = "exact";
    await validateImageMetadata(state, state.imageId);
    const containerName = `eden-eve-boot-${request.candidate.generationId}`;
    const runtimeEnvironment = request.runtimeInjection === undefined
      ? runtimeContainerEnvironment(request)
      : await request.runtimeInjection.runLocal({
        cwd: request.candidate.generationRoot,
        hostEnvironment: runtimeContainerEnvironment(request),
        run: (startRequest) => startRequest.env,
      });
    const bootArgs = [
      "run",
      "--detach",
      "--name",
      containerName,
      "--label",
      state.imageLabel,
      "--publish",
      `${healthPort}:${INTERNAL_PORT}`,
      ...(request.runtimeInjection === undefined
        ? Object.entries(runtimeEnvironment).flatMap(([name, value]) => [
          "--env",
          `${name}=${value}`,
        ])
        : ["--env-file", "-"]),
      state.imageId,
    ] as const;
    const boot = request.runtimeInjection === undefined
      ? await docker(state, bootArgs)
      : await dockerWithInput(
        state,
        bootArgs,
        `${Object.entries(runtimeEnvironment)
          .map(([name, value]) => `${name}=${value}`)
          .join("\n")}\n`,
      );
    state.containerId = boot.stdout.trim();
    bootContainerId = state.containerId;
    if (state.containerId.length === 0) {
      throw packagingError(
        "DOCKER_PLATFORM_BLOCKED",
        "boot container identity",
        "The Docker runtime did not return an owned boot-container identity.",
        "Use a Docker/OrbStack runtime that returns a stable container ID for exact lifecycle cleanup.",
      );
    }
    const processTree = await docker(state, ["top", state.containerId]);
    if (
      !processTree.stdout.includes("eve") ||
      !processTree.stdout.includes("start") ||
      !processTree.stdout.includes("--host") ||
      !processTree.stdout.includes("0.0.0.0") ||
      !processTree.stdout.includes("--port") ||
      !processTree.stdout.includes("8080")
    ) {
      throw packagingError(
        "UNSUPPORTED_EVE_OUTPUT",
        "eve start process",
        "The booted image process is not the project-local Eve start supervisor.",
        "Start the image with ./node_modules/.bin/eve start --host 0.0.0.0 --port 8080.",
      );
    }
    await docker(state, [
      "exec",
      state.containerId,
      "sh",
      "-ceu",
      "test -f /app/.output/server/index.mjs && test -x /app/node_modules/.bin/eve",
    ]);
    await docker(state, [
      "exec",
      state.containerId,
      "sh",
      "-ceu",
      "set -o noglob; for module in $(find /app/node_modules -type f -name '*.node'); do ldd \"$module\" 2>&1 | grep -q 'not found' && exit 1; done",
    ]);
    await pollEveHealth(
      healthPort,
      timeoutMs,
      pollIntervalMs,
      request.fetchHealth ?? fetch,
    );
    await docker(state, [
      "exec",
      state.containerId,
      "sh",
      "-ceu",
      "awk '$2 ~ /^00000000:1F90/ { found=1 } END { exit found ? 0 : 1 }' /proc/net/tcp /proc/net/tcp6",
    ]);
    await docker(state, [
      "exec",
      state.containerId,
      "sh",
      "-ceu",
      "test -z \"$(find /app -type f \\( -name '.env*' -o -name '.npmrc' -o -name '.pnpmrc' -o -name '*.pem' -o -name '*.key' -o -name 'credentials.json' -o -name 'service-account.json' \\) -print -quit)\"",
    ]);
    imageRetained = retainImage;
    state.imageRetained = retainImage;
    containerRemoved = await removeOwnedContainer(state);
    state.containerId = undefined;
    cleanupVerified = containerRemoved;
    if (!cleanupVerified) {
      throw packagingError(
        "CLEANUP_UNVERIFIED",
        "boot container",
        "The owned Eve boot container could not be stopped and verified absent.",
        "Inspect only the recorded boot-container identity; no broad Docker cleanup was attempted.",
      );
    }
    if (!imageRetained) {
      cleanupVerified = (await removeOwnedImage(state)) && cleanupVerified;
      if (!cleanupVerified) {
        throw packagingError(
          "CLEANUP_UNVERIFIED",
          "runtime image",
          "The disposable Eve runtime image could not be removed and verified absent.",
          "Inspect only the recorded runtime image identity; no broad Docker cleanup was attempted.",
        );
      }
    }
    const contextRemoved = await removeOwnedRuntimeContext(
      context.runtimeContextPath,
      request.candidate.generationRoot,
    );
    if (!contextRemoved) {
      throw packagingError(
        "CLEANUP_UNVERIFIED",
        "runtime context",
        "The owned runtime context could not be removed with exact containment proof.",
        "Inspect only the recorded runtime context path; no broad filesystem cleanup was attempted.",
      );
    }
    runtimeContextPath = undefined;
    const runtimeManifestPath = join(request.candidate.generationRoot, "runtime-image-manifest.json");
    await writeFile(runtimeManifestPath, `${JSON.stringify({
      version: 1,
      generationId: request.candidate.generationId,
      platform: "linux/amd64",
      imageId: state.imageId,
      imageDigest: state.imageId,
      launchCommand: START_COMMAND,
      ...(request.publicOrigin === undefined
        ? {}
        : { publicOrigin: request.publicOrigin }),
      applicationArtifact: request.candidate.generatedOutput.entrypointPath,
      runtimeClosure: closure,
      health: {
        method: "GET",
        path: HEALTH_PATH,
        status: "ready",
      },
      hostEnvironment: HOST_ENVIRONMENT,
      durableLocalFilesystemClaim: false,
    })}\n`, { flag: "wx", encoding: "utf8", mode: 0o600 });
    writtenPaths.push(runtimeManifestPath, state.imageIdPath);
    const image: EveRuntimeImage = {
      dockerfilePath: context.dockerfilePath,
      runtimeContextPath: context.runtimeContextPath,
      platform: "linux/amd64",
      builderImage: imageReference(request.nodeImage),
      runtimeImage: imageReference(request.nodeImage),
      imageId: state.imageId,
      imageReference: state.imageId,
      imageDigest: state.imageId,
      launchCommand: START_COMMAND,
      workingDirectory: "/app",
      hostEnvironment: HOST_ENVIRONMENT,
      ...(request.publicOrigin === undefined
        ? {}
        : { publicOrigin: request.publicOrigin }),
      generatedOutput: request.candidate.generatedOutput,
      runtimeClosure: {
        root: "/app/node_modules",
        outputDigest: closure.outputDigest,
        dependencyDigest: closure.dependencyDigest,
        digest: closure.digest,
        files: closure.files,
        nativeModules: closure.nativeModules,
        eveStartClosureRetained: true,
        builderOnlyMaterialExcluded: true,
      },
    };
    return {
      schemaVersion: 1,
      worker: "eve-packaging-worker",
      operation: "runtime-image",
      status: "ready",
      returnCode: "EVE_PACKAGE_READY",
      deployable: true,
      candidate: request.candidate,
      image,
      runtime: {
        listenHost: "0.0.0.0",
        listenPort: INTERNAL_PORT,
        healthMethod: "GET",
        healthPath: HEALTH_PATH,
        healthStatus: "ready",
        healthVerified: true,
        healthVerifiedAt: new Date().toISOString(),
        durableLocalFilesystemClaim: false,
      },
      cleanup: {
        bootContainerId,
        bootContainerRemoved: true,
        imageIdentity,
        imageRetained: imageRetained,
        verified: cleanupVerified,
      },
      checks: [
        {
          id: "VAL-BUILD-005",
          status: "pass",
          subject: "runtime image",
          reason: "The runtime image reports Linux/amd64 and contains the generated Eve output and runtime closure.",
          remediation: null,
        },
        {
          id: "VAL-BUILD-006",
          status: "pass",
          subject: "eve start",
          reason: "The actual boot process is the project-local Eve start supervisor with host 0.0.0.0 and port 8080.",
          remediation: null,
        },
        {
          id: "VAL-BUILD-007",
          status: "pass",
          subject: "host requirements",
          reason: "World, sandbox, process, network, architecture, and disposable-storage requirements are supported.",
          remediation: null,
        },
      ],
      candidateImageId: state.imageId,
      candidateImageRetainedLocally: imageRetained,
      writtenPaths,
      error: null,
    };
  } catch (error: unknown) {
    if (runtimeContextPath !== undefined) {
      const contextRemoved = await removeOwnedRuntimeContext(
        runtimeContextPath,
        request.candidate.generationRoot,
      );
      cleanupVerified = contextRemoved && cleanupVerified;
      runtimeContextPath = undefined;
    }
    if (state.containerId !== undefined) {
      containerRemoved = await removeOwnedContainer(state);
      state.containerId = undefined;
    }
    if (!imageRetained && state.imageBuilt) {
      if (state.imageId === undefined) {
        state.imageId = await recoverImageIdentity(state);
        if (state.imageId === undefined) {
          cleanupVerified = false;
        } else {
          imageIdentity = "exact";
          cleanupVerified = (await removeOwnedImage(state)) && cleanupVerified;
        }
      } else {
        cleanupVerified = (await removeOwnedImage(state)) && cleanupVerified;
      }
    }
    const cleanup = {
      bootContainerId,
      bootContainerRemoved: containerRemoved,
      imageIdentity,
      imageRetained,
      verified: cleanupVerified,
    } as const;
    if (error instanceof EvePackagingError) {
      if (error.code === "CLEANUP_UNVERIFIED" || !cleanupVerified) {
        return blockedResult(
          request.candidate,
          error.code === "CLEANUP_UNVERIFIED"
            ? error
            : packagingError(
              "CLEANUP_UNVERIFIED",
              "owned Docker resources",
              "Owned runtime-image resources could not be verified absent.",
              "Inspect only the recorded image and boot-container identities; no broad Docker cleanup was attempted.",
            ),
          cleanup,
          writtenPaths,
        );
      }
      return blockedResult(request.candidate, error, cleanup, writtenPaths);
    }
    const fallback = packagingError(
      "DOCKER_PLATFORM_BLOCKED",
      "runtime image",
      "The Linux/amd64 Eve runtime image could not be built or inspected safely.",
      "Retry with Docker/OrbStack BuildKit and preserve the exact candidate inputs.",
    );
    return blockedResult(request.candidate, fallback, cleanup, writtenPaths);
  }
}

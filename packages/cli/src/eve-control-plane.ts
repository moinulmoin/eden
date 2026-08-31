import {
  createRequire,
} from "node:module";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  join,
  dirname,
  relative,
} from "node:path";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  homedir,
} from "node:os";
import {
  createServer,
} from "node:net";
import {
  execFile,
  spawn,
} from "node:child_process";
import {
  fileURLToPath,
} from "node:url";
import {
  promisify,
} from "node:util";

import {
  EveCliError,
  type EveCliEnvironment,
  type EveCliExecutionRequest,
} from "./eve.js";
import {
  buildEveProjectSnapshot,
  createDockerEveProjectBuilder,
  revalidateEveProjectCandidateInputs,
  EvePackagingError,
  type EveNodeImage,
  type EvePackagingCheck,
  type EveProjectBuildCandidate,
  type EveProjectBuilder,
  type EveProjectPackagingResult,
  type EveRuntimeConfigExclusion,
} from "./eve-packaging.js";
import {
  buildEveRuntimeImage,
  discardEveRuntimeImage,
  revalidateEveRuntimeCandidate,
  validateEveHostRequirements,
  type EveHostRequirements,
  type EveRuntimeCleanup,
  type EveRuntimeImageDiscardRequest,
  type EveRuntimeImageRequest,
} from "./eve-runtime-image.js";
import {
  EveRuntimeConfigError,
  prepareEveRuntimeInjection,
  redactEveRuntimeOutput,
  type EveRuntimeConfig,
  type EveRuntimeInjection,
  type EveRuntimeProtectedStore,
} from "./eve-runtime-config.js";
import type {
  EveHostConfig,
} from "@moinulmoin/eden-runtime-cloudflare";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const wranglerEntrypoint = require.resolve("wrangler");

export const DEFAULT_EVE_HOST_REQUIREMENTS: EveHostRequirements = Object.freeze({
  architecture: "linux/amd64",
  world: "supported",
  sandbox: "supported",
  privileged: false,
  devices: "none",
  kernel: "supported",
  network: "supported",
  durableLocalFilesystem: false,
});
const wranglerCwd = dirname(wranglerEntrypoint);

export const DEFAULT_EVE_NODE_IMAGE: EveNodeImage = Object.freeze({
  reference: "node:24.17.0-bookworm-slim",
  digest: "sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532",
});

export type EvePreflightCheckStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "skipped";

export interface EvePreflightCheck {
  readonly id: string;
  readonly status: EvePreflightCheckStatus;
  readonly message: string;
  readonly remediation?: string;
}

export interface EvePreflightCandidate {
  readonly generationId: string;
  readonly sourceDigest: string;
  readonly outputDigest: string;
  readonly imageDigest?: string;
}

export type EveDeploymentStatus =
  | "deployed"
  | "failed"
  | "indeterminate";

export interface EveDeploymentMetadata {
  readonly status: EveDeploymentStatus;
  readonly targetKey: string;
  readonly deploymentId: string;
  readonly workerName: string;
  readonly containerApplicationName: string;
  readonly stableContainerInstanceName: string;
  readonly stableWorkersDevOrigin: string;
  readonly imageReference: string;
  readonly runtimeVariableNames: readonly string[];
  readonly evidenceRetained: true;
}

export interface EvePreflightResult {
  readonly command: "eve preflight" | "eve deploy";
  readonly ok: boolean;
  readonly environment: EveCliEnvironment;
  readonly name: string;
  readonly checks: readonly EvePreflightCheck[];
  readonly candidate: EvePreflightCandidate | null;
  readonly deployment?: EveDeploymentMetadata;
}

export type EveCloudflareTargetState =
  | "absent"
  | "owned"
  | "unowned"
  | "mismatched"
  | "cross-environment"
  | "ambiguous";

export interface EveCloudflareReadRequest {
  readonly projectId: string;
  readonly sourceDigest: string;
  readonly environment: EveCliEnvironment;
  readonly name: string;
}

export interface EveCloudflareReadResult {
  readonly accountAccess: "available" | "unavailable";
  readonly containerAccess: "available" | "unavailable";
  readonly accountId?: string;
  readonly workersDevSubdomain?: string;
  readonly stableWorkersDevOrigin?: string;
  readonly target: {
    readonly state: EveCloudflareTargetState;
    readonly matchesCandidate?: boolean;
    readonly message?: string;
    readonly remediation?: string;
    readonly identity?: EveDeploymentIdentityProof;
  };
}

export type EveCloudflareReadRunner = (
  request: EveCloudflareReadRequest,
) => EveCloudflareReadResult | Promise<EveCloudflareReadResult>;

export interface EvePreflightRuntimeEvidence {
  readonly ok: boolean;
  readonly checks: readonly EvePreflightCheck[];
  readonly imageDigest?: string;
  readonly imageReference?: string;
  readonly cleanup: EveRuntimeCleanup;
}

export interface EvePreflightRuntimeRunnerRequest {
  readonly candidate: EveProjectBuildCandidate;
  readonly nodeImage: EveNodeImage;
  readonly healthPort: number;
  readonly hostRequirements: EveHostRequirements;
  readonly publicOrigin?: string;
  readonly runtimeInjection?: EveRuntimeInjection;
  readonly retainImage?: boolean;
}

export type EvePreflightRuntimeRunner = (
  request: EvePreflightRuntimeRunnerRequest,
) => EvePreflightRuntimeEvidence | Promise<EvePreflightRuntimeEvidence>;

export type EveRuntimeImageDiscardRunner = (
  request: EveRuntimeImageDiscardRequest,
) => boolean | Promise<boolean>;

export interface EveDeploymentIdentity {
  readonly projectId: string;
  readonly sourceDigest: string;
  readonly generationId: string;
  readonly deploymentId: string;
  readonly environment: EveCliEnvironment;
  readonly name: string;
  readonly accountId: string;
  readonly workersDevSubdomain: string;
  readonly stableWorkersDevOrigin: string;
  readonly workerName: string;
  readonly containerApplicationName: string;
  readonly stableContainerInstanceName: string;
  readonly containerImage: string;
  readonly runtimeVariableNames: readonly string[];
  readonly runtimeRevisionHandle?: string;
}

export type EveDeploymentIdentityProof = Partial<EveDeploymentIdentity>;

export interface EveDeploymentPublicationRequest {
  readonly identity: EveDeploymentIdentity;
  readonly hostConfig: EveHostConfig;
  readonly workerSource: string;
  readonly workerSourcePath: string;
  readonly wranglerConfigPath: string;
  readonly runtimeInjection?: EveRuntimeInjection;
}

export type EveDeploymentPublicationResult =
  | {
    readonly status: "published";
    readonly identity: EveDeploymentIdentityProof;
    readonly createdByAttempt: boolean;
    readonly ownershipProven: true;
  }
  | {
    readonly status: "failed";
    readonly reason: string;
    readonly createdByAttempt?: boolean;
    readonly ownershipProven?: boolean;
  }
  | {
    readonly status: "indeterminate";
    readonly reason: string;
    readonly ownershipEvidenceRetained: true;
  };

export type EveDeploymentPublicationRunner = (
  request: EveDeploymentPublicationRequest,
) =>
  | EveDeploymentPublicationResult
  | Promise<EveDeploymentPublicationResult>;

export interface EveDeploymentCompensationRequest {
  readonly identity: EveDeploymentIdentity;
  readonly publication: EveDeploymentPublicationResult & {
    readonly status: "published" | "failed";
  };
}

export type EveDeploymentCompensationRunner = (
  request: EveDeploymentCompensationRequest,
) => void | Promise<void>;

export interface EveDeploymentHealthRequest {
  readonly identity: EveDeploymentIdentity;
  readonly origin: string;
}

export type EveDeploymentHealthResult =
  | {
    readonly status: "ready";
    readonly identity: EveDeploymentIdentityProof;
  }
  | {
    readonly status: "failed";
    readonly reason: string;
  }
  | {
    readonly status: "indeterminate";
    readonly reason: string;
  };

export type EveDeploymentHealthRunner = (
  request: EveDeploymentHealthRequest,
) => EveDeploymentHealthResult | Promise<EveDeploymentHealthResult>;

export interface EveImagePublicationRequest {
  readonly accountId: string;
  readonly targetImageReference: string;
  readonly localImageReference: string;
  readonly localImageTag: string;
  readonly generationRoot: string;
}

export type EveImagePublicationResult =
  | {
    readonly status: "published";
    readonly imageReference: string;
    readonly imageDigest: string;
  }
  | {
    readonly status: "indeterminate";
    readonly reason: string;
    readonly evidenceRetained: true;
  };

export type EveImagePublicationRunner = (
  request: EveImagePublicationRequest,
) => EveImagePublicationResult | Promise<EveImagePublicationResult>;

export interface EvePreflightOptions {
  /**
   * The candidate builder is intentionally the existing packaging seam. It
   * owns source snapshots, frozen installs, project-local Eve build, and
   * source/input race checks.
   */
  readonly builder?: EveProjectBuilder;
  readonly nodeImage?: EveNodeImage;
  readonly artifactRoot?: string;
  readonly healthPort?: number;
  readonly hostRequirements?:
    | EveHostRequirements
    | ((
      candidate: EveProjectBuildCandidate,
    ) => EveHostRequirements | Promise<EveHostRequirements>);
  /**
   * A runtime runner is required for env-file preflight so runtime values can
   * enter only through the deployment-safety protected local injection seam.
   */
  readonly runtimeRunner?: EvePreflightRuntimeRunner;
  /**
   * Deployment-safety owns opening/parsing the opaque environment file. The
   * control plane receives only this typed handoff.
   */
  readonly runtimeConfigLoader?: EveRuntimeConfigLoader;
  readonly cloudflareRead?: EveCloudflareReadRunner;
  readonly containerImageReference?: string;
  readonly protectedStore?: EveRuntimeProtectedStore;
  readonly publish?: EveDeploymentPublicationRunner;
  readonly publishImage?: EveImagePublicationRunner;
  readonly compensate?: EveDeploymentCompensationRunner;
  readonly health?: EveDeploymentHealthRunner;
  readonly afterPromotion?: () => void | Promise<void>;
  readonly discardRuntimeImage?: EveRuntimeImageDiscardRunner;
  readonly retainRuntimeImage?: boolean;
  readonly stdout?: (line: string) => void;
  /**
   * Destroy seams. Defaults use only Wrangler reads/deletes plus the
   * immutable local deployment record; tests may inject exact fakes.
   */
  readonly destroyCloudflareRead?: EveDestroyCloudflareReadRunner;
  readonly deleteWorker?: EveWorkerDeleteRunner;
  readonly deleteContainer?: EveContainerDeleteRunner;
}

export interface EveDestroyTargetRead {
  readonly workerExists: boolean;
  readonly containerApplicationId?: string;
  readonly accountId?: string;
}

export type EveDestroyCloudflareReadRunner = (
  request: EveDestroyCloudflareReadRequest,
) => EveDestroyTargetRead | Promise<EveDestroyTargetRead>;

export type EveWorkerDeleteRunner = (
  request: { readonly name: string },
) => "deleted" | "absent" | "indeterminate" | Promise<
  "deleted" | "absent" | "indeterminate"
>;

export type EveContainerDeleteRunner = (
  request: { readonly applicationId: string },
) => "deleted" | "absent" | "indeterminate" | Promise<
  "deleted" | "absent" | "indeterminate"
>;

export type EveRuntimeConfigLoader = (
  path: string,
  cwd: string,
) => EveRuntimeConfig | Promise<EveRuntimeConfig>;

export interface EveDestroyCloudflareReadRequest {
  readonly workerName: string;
  readonly containerApplicationName: string;
}


interface EvePreflightCollection {
  readonly result: EvePreflightResult;
  readonly runtimeConfig: EveRuntimeConfig | undefined;
  readonly candidate?: EveProjectBuildCandidate;
  readonly projectId?: string;
  readonly runtimeEvidence?: EvePreflightRuntimeEvidence;
  readonly cloudflare?: EveCloudflareReadResult;
}

function safeText(value: string): string {
  return redactEveRuntimeOutput(value)
    .replace(/(?:^|[\s"'=])(?:Bearer|Token)\s+\S+/giu, "$1[redacted]")
    .slice(0, 2_000);
}

function check(
  id: string,
  status: EvePreflightCheckStatus,
  message: string,
  remediation?: string,
): EvePreflightCheck {
  return {
    id,
    status,
    message: safeText(message),
    ...(remediation === undefined ? {} : { remediation: safeText(remediation) }),
  };
}

function mapPackagingCheck(value: EvePackagingCheck): EvePreflightCheck {
  const id = (() => {
    if (value.id.startsWith("VAL-")) return value.id;
    switch (value.id) {
      case "ROOT_INVALID":
        return "VAL-CLI-004";
      case "UNSUPPORTED_TOOLCHAIN":
      case "DEPENDENCY_AMBIGUITY":
        return "VAL-BUILD-001";
      case "SOURCE_RACE":
        return "VAL-CROSS-004";
      case "EVE_BUILD_FAILED":
      case "UNSUPPORTED_EVE_OUTPUT":
        return "VAL-BUILD-004";
      case "SECRET_EXCLUSION_FAILED":
        return "VAL-SEC-003";
      case "DOCKER_PLATFORM_BLOCKED":
        return "VAL-BUILD-005";
      default:
        return `EVE-${value.id}`;
    }
  })();
  return check(
    id,
    value.status === "pass" ? "passed" : "failed",
    value.reason,
    value.remediation ?? undefined,
  );
}

function blockedAfterFailure(id: string, message: string): EvePreflightCheck {
  return check(
    id,
    "blocked",
    message,
    "Resolve the earlier failed or blocked check, then retry the exact Eve target.",
  );
}

function allChecksClear(checks: readonly EvePreflightCheck[]): boolean {
  return checks.every((value) =>
    value.status === "passed" || value.status === "skipped"
  );
}

function runtimeConfigExclusion(
  config: EveRuntimeConfig | undefined,
): EveRuntimeConfigExclusion | undefined {
  if (config === undefined) return undefined;
  return {
    envFilePath: config.inputPath,
    inputIdentity: config.seam.inputIdentity,
    readInputIdentity: () => config.readInputIdentity(),
    variableNames: config.seam.variableNames,
    redactionRegistered: true,
  };
}

function candidateMetadata(
  candidate: EveProjectBuildCandidate,
  imageDigest: string | undefined,
): EvePreflightCandidate {
  return {
    generationId: candidate.generationId,
    sourceDigest: candidate.sourceDigest,
    outputDigest: candidate.generatedOutput.outputDigest,
    ...(imageDigest === undefined ? {} : { imageDigest }),
  };
}

function safeWranglerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    NODE_OPTIONS: undefined,
  };
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

interface WranglerJsonResult {
  readonly value?: unknown;
  readonly failed: boolean;
  readonly stderr?: string;
}

async function readWranglerJson(
  args: readonly string[],
): Promise<WranglerJsonResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [wranglerEntrypoint, ...args],
      {
        env: safeWranglerEnvironment(),
        cwd: wranglerCwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    return { value: parsed, failed: false };
  } catch (error: unknown) {
    const stderr = typeof error === "object" &&
        error !== null &&
        typeof (error as { readonly stderr?: unknown }).stderr === "string"
      ? (error as { readonly stderr: string }).stderr
      : undefined;
    return {
      failed: true,
      ...(stderr === undefined ? {} : { stderr: safeText(stderr) }),
    };
  }
}

function jsonCollection(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { readonly result?: unknown }).result)
  ) {
    return (value as { readonly result: readonly unknown[] }).result;
  }
  return undefined;
}

function exactContainerEntries(
  value: unknown,
  name: string,
): readonly { readonly id: string; readonly name: string }[] | undefined {
  const collection = jsonCollection(value);
  if (collection === undefined) return undefined;
  const entries: { id: string; name: string }[] = [];
  for (const entry of collection) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { readonly id?: unknown }).id !== "string" ||
      typeof (entry as { readonly name?: unknown }).name !== "string"
    ) {
      return undefined;
    }
    const id = (entry as { readonly id: string }).id;
    const entryName = (entry as { readonly name: string }).name;
    if (entryName === name) entries.push({ id, name: entryName });
  }
  if (entries.length === 0 && collection.length >= 100) {
    return undefined;
  }
  return entries;
}

function exactDeploymentEntries(
  value: unknown,
): readonly unknown[] | undefined {
  const collection = jsonCollection(value);
  if (collection === undefined) return undefined;
  if (collection.some((entry) => typeof entry !== "object" || entry === null)) {
    return undefined;
  }
  return collection;
}

function authenticatedWranglerAccount(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    (value as { readonly loggedIn?: unknown }).loggedIn === true &&
    Array.isArray((value as { readonly accounts?: unknown }).accounts);
}

function authenticatedAccountId(value: unknown): string | undefined {
  if (!authenticatedWranglerAccount(value)) return undefined;
  const accounts = (value as {
    readonly accounts: readonly unknown[];
  }).accounts;
  if (accounts.length !== 1) return undefined;
  const account = accounts[0];
  if (
    typeof account !== "object" ||
    account === null ||
    typeof (account as { readonly id?: unknown }).id !== "string"
  ) {
    return undefined;
  }
  return (account as { readonly id: string }).id;
}

async function readWranglerOAuthToken(): Promise<string | undefined> {
  const root = process.env.WRANGLER_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Preferences", ".wrangler")
      : join(homedir(), ".config", ".wrangler"));
  const raw = await readFile(join(root, "config", "default.toml"), "utf8")
    .catch(() => undefined);
  if (raw === undefined) return undefined;
  const match = /^oauth_token\s*=\s*["']([^"'\r\n]+)["']/m.exec(raw);
  return match === null ? undefined : match[1];
}

async function readWorkersDevSubdomain(
  accountId: string | undefined,
): Promise<string | undefined> {
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  const token = envToken !== undefined && envToken.length > 0
    ? envToken
    : await readWranglerOAuthToken();
  if (accountId === undefined || token === undefined || token.length === 0) {
    return undefined;
  }
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return undefined;
    const body = await response.json() as unknown;
    const result = typeof body === "object" && body !== null
      ? (body as { readonly result?: unknown }).result
      : undefined;
    const subdomain = typeof result === "object" && result !== null
      ? (result as { readonly subdomain?: unknown }).subdomain
      : undefined;
    return typeof subdomain === "string" &&
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)
      ? subdomain
      : undefined;
  } catch {
    return undefined;
  }
}

async function defaultCloudflareRead(
  request: EveCloudflareReadRequest,
): Promise<EveCloudflareReadResult> {
  const account = await readWranglerJson(["whoami", "--json"]);
  const containers = await readWranglerJson([
    "containers",
    "list",
    "--json",
    "--per-page",
    "100",
  ]);
  const containerCollection = jsonCollection(containers.value);
  const deployments = await readWranglerJson([
    "deployments",
    "list",
    "--name",
    request.name,
    "--json",
  ]);
  const accountId = authenticatedAccountId(account.value);
  const accountAccess = account.failed || accountId === undefined
    ? "unavailable"
    : "available";
  const containerEntries = exactContainerEntries(containers.value, request.name);
  const containerAccess = containers.failed || containerEntries === undefined
    ? "unavailable"
    : "available";
  const deploymentEntries = deployments.failed &&
      /(?:does not exist|not found)/iu.test(deployments.stderr ?? "")
    ? []
    : exactDeploymentEntries(deployments.value);
  const workersDevSubdomain = await readWorkersDevSubdomain(accountId);
  if (
    accountAccess === "unavailable" ||
    containerAccess === "unavailable" ||
    deploymentEntries === undefined
  ) {
    return {
      accountAccess,
      containerAccess,
      ...(accountId === undefined
        ? {}
        : { accountId }),
      ...(workersDevSubdomain === undefined
        ? {}
        : { workersDevSubdomain }),
      target: {
        state: "ambiguous",
        message:
          "The authenticated Cloudflare read-only checks did not return a complete exact-target result.",
        remediation:
          "Retry with authenticated account, Container, and exact Worker deployment reads; preflight never guesses or mutates a target.",
      },
    };
  }
  if (
    deploymentEntries.length === 0 &&
    containerCollection?.length === 0
  ) {
    return {
      accountAccess,
      containerAccess,
      ...(accountId === undefined
        ? {}
        : { accountId }),
      ...(workersDevSubdomain === undefined
        ? {}
        : { workersDevSubdomain }),
      target: { state: "absent" },
    };
  }
  return {
    accountAccess,
    containerAccess,
    ...(accountId === undefined
      ? {}
      : { accountId }),
    ...(workersDevSubdomain === undefined
      ? {}
      : { workersDevSubdomain }),
    target: {
      state: "ambiguous",
      message:
        "The exact target could not be proven absent or owned from the read-only Cloudflare inventory.",
      remediation:
        "Resolve the exact Worker and Container ownership state before deployment; no target was claimed or changed.",
    },
  };
}

async function readEveCloudflareTarget(
  request: EveCloudflareReadRequest,
  options: EvePreflightOptions,
): Promise<EveCloudflareReadResult> {
  return options.cloudflareRead === undefined
    ? defaultCloudflareRead(request)
    : options.cloudflareRead(request);
}

async function resolvedCloudflareOrigin(
  result: EveCloudflareReadResult,
  workerName: string,
): Promise<string | undefined> {
  if (
    result.accountId === undefined ||
    result.workersDevSubdomain === undefined
  ) {
    return undefined;
  }
  try {
    const { resolveStableWorkersDevOrigin } = await import(
      "@moinulmoin/eden-runtime-cloudflare"
    );
    const origin = resolveStableWorkersDevOrigin({
      workerName,
      workersDevSubdomain: result.workersDevSubdomain,
    });
    return result.stableWorkersDevOrigin === undefined ||
        result.stableWorkersDevOrigin === origin
      ? origin
      : undefined;
  } catch {
    return undefined;
  }
}

async function findAvailableEveHealthPort(): Promise<number> {
  for (let port = 4310; port <= 4399; port += 1) {
    const available = await new Promise<boolean>((resolveResult) => {
      const server = createServer();
      const finish = (value: boolean): void => {
        server.removeAllListeners();
        server.close(() => resolveResult(value));
      };
      server.once("error", () => finish(false));
      server.listen({ host: "127.0.0.1", port }, () => finish(true));
    });
    if (available) return port;
  }
  throw new EveCliError({
    code: "EVE_HEALTH_PORT_UNAVAILABLE",
    message:
      "No task-owned Eve health port was available in the allowed 4310-4399 range.",
  });
}

async function defaultRuntimeRunner(
  request: EvePreflightRuntimeRunnerRequest,
): Promise<EvePreflightRuntimeEvidence> {
  let result: Awaited<ReturnType<typeof buildEveRuntimeImage>>;
  try {
    const imageRequest: EveRuntimeImageRequest = {
      candidate: request.candidate,
      nodeImage: request.nodeImage,
      healthPort: request.healthPort,
      hostRequirements: request.hostRequirements,
      ...(request.publicOrigin === undefined
        ? {}
        : { publicOrigin: request.publicOrigin }),
      ...(request.runtimeInjection === undefined
        ? {}
        : { runtimeInjection: request.runtimeInjection }),
      retainImage: request.retainImage ?? false,
    };
    result = await buildEveRuntimeImage(imageRequest);
  } catch {
    return {
      ok: false,
      checks: [
        check(
          "VAL-BUILD-005",
          "failed",
          "The Linux/amd64 Eve runtime image runner failed before returning a verified result.",
          "Retry with the pinned Docker/OrbStack runtime and inspect only the owned candidate identities.",
        ),
      ],
      cleanup: {
        bootContainerId: null,
        bootContainerRemoved: false,
        imageIdentity: "indeterminate",
        imageRetained: false,
        verified: false,
      },
    };
  }
  return {
    ok: result.deployable,
    checks: result.checks.map((value) =>
      check(
        value.id,
        value.status === "pass" ? "passed" : "failed",
        value.reason,
        value.remediation ?? undefined,
      )
    ),
    ...(result.image?.imageDigest === undefined
      ? {}
      : { imageDigest: result.image.imageDigest }),
    ...(result.image?.imageReference === undefined
      ? {}
      : { imageReference: result.image.imageReference }),
    cleanup: result.cleanup,
  };
}

function cloudflareChecks(
  result: EveCloudflareReadResult,
): readonly EvePreflightCheck[] {
  const accessMessage =
    result.accountAccess === "available" &&
      result.containerAccess === "available"
      ? "Authenticated account and Container access were verified through the read-only adapter."
      : "Authenticated Cloudflare account and Container access could not be verified without a mutating operation.";
  const accessRemediation =
    result.accountAccess === "available" &&
      result.containerAccess === "available"
      ? undefined
      : "Use an authenticated read-only adapter with account and Container access; preflight never uploads, publishes, or changes remote state.";
  const target = result.target;
  const targetPasses =
    target.state === "absent" ||
    (target.state === "owned" && target.matchesCandidate === true);
  const targetMessage = targetPasses
    ? target.state === "absent"
      ? "The exact target read is absent and is eligible without claiming ownership."
      : "The exact target is already owned by this candidate identity; no ownership claim was attempted."
    : target.message ??
      "The exact target read is unowned, mismatched, cross-environment, or ambiguous.";
  const targetRemediation = targetPasses
    ? undefined
    : target.remediation ??
      "Inspect only the exact target and resolve ownership or identity ambiguity before deploy; do not broaden the target.";
  return [
    check(
      "VAL-CLI-007-CLOUDFLARE-ACCESS",
      accessMessage === undefined ? "blocked" : (
        result.accountAccess === "available" &&
          result.containerAccess === "available"
          ? "passed"
          : "blocked"
      ),
      accessMessage,
      accessRemediation,
    ),
    check(
      "VAL-CLI-007-TARGET-CONFLICT",
      targetPasses ? "passed" : "failed",
      targetMessage,
      targetRemediation,
    ),
  ];
}

function stableDeploymentKey(
  projectId: string,
  accountId: string,
  environment: EveCliEnvironment,
  name: string,
): string {
  const digest = createHash("sha256")
    .update(`${projectId}\n${accountId}\n${environment}\n${name}`, "utf8")
    .digest("hex");
  return `${environment}-${name}-${digest.slice(0, 24)}`;
}

function boundedResourceName(
  name: string,
  suffix: string,
): string {
  const value = `${name}-${suffix}`;
  return value.length <= 63 ? value : value.slice(0, 63).replace(/-+$/u, "");
}

function imageDigestFromReference(value: string): string | undefined {
  const match = /@sha256:([0-9a-f]{64})$/u.exec(value);
  return match === null ? undefined : `sha256:${match[1]}`;
}
function transportIdentityMatches(
  expected: EveDeploymentIdentity,
  observed: EveDeploymentIdentityProof | undefined,
): boolean {
  if (observed === undefined) return false;
  const required: readonly (keyof EveDeploymentIdentity)[] = [
    "deploymentId",
    "generationId",
    "stableWorkersDevOrigin",
    "workerName",
    "stableContainerInstanceName",
  ];
  if (!required.every((key) => observed[key] === expected[key])) {
    return false;
  }
  return expected.runtimeRevisionHandle === undefined
    ? observed.runtimeRevisionHandle === undefined
    : observed.runtimeRevisionHandle === expected.runtimeRevisionHandle;
}


function identityMatches(
  expected: EveDeploymentIdentity,
  observed: EveDeploymentIdentityProof | undefined,
): boolean {
  if (observed === undefined) return false;
  const required: readonly (keyof EveDeploymentIdentity)[] = [
    "projectId",
    "sourceDigest",
    "generationId",
    "deploymentId",
    "environment",
    "name",
    "accountId",
    "workersDevSubdomain",
    "stableWorkersDevOrigin",
    "workerName",
    "containerApplicationName",
    "stableContainerInstanceName",
    "containerImage",
  ];
  if (!required.every((key) => observed[key] === expected[key])) return false;
  if (
    observed.runtimeVariableNames === undefined ||
    observed.runtimeVariableNames.length !== expected.runtimeVariableNames.length ||
    observed.runtimeVariableNames.some(
      (name, index) => name !== expected.runtimeVariableNames[index],
    )
  ) {
    return false;
  }
  return expected.runtimeRevisionHandle === undefined
    ? observed.runtimeRevisionHandle === undefined
    : observed.runtimeRevisionHandle === expected.runtimeRevisionHandle;
}

function safeIdentity(identity: EveDeploymentIdentity): Record<string, unknown> {
  return {
    projectId: identity.projectId,
    sourceDigest: identity.sourceDigest,
    generationId: identity.generationId,
    deploymentId: identity.deploymentId,
    environment: identity.environment,
    name: identity.name,
    accountId: identity.accountId,
    workersDevSubdomain: identity.workersDevSubdomain,
    stableWorkersDevOrigin: identity.stableWorkersDevOrigin,
    workerName: identity.workerName,
    containerApplicationName: identity.containerApplicationName,
    stableContainerInstanceName: identity.stableContainerInstanceName,
    containerImage: identity.containerImage,
    runtimeVariableNames: identity.runtimeVariableNames,
    ...(identity.runtimeRevisionHandle === undefined
      ? {}
      : { runtimeRevisionHandle: identity.runtimeRevisionHandle }),
  };
}

async function writeEveDeploymentArtifacts(
  candidate: EveProjectBuildCandidate,
  hostConfig: EveHostConfig,
  workerSource: string,
): Promise<{
  readonly workerSourcePath: string;
  readonly wranglerConfigPath: string;
}> {
  const workerRoot = join(candidate.generationRoot, "worker");
  const workerSourcePath = join(workerRoot, "worker.ts");
  const wranglerConfigPath = join(workerRoot, "wrangler.jsonc");
  await mkdir(workerRoot, { recursive: true });
  await writeFile(workerSourcePath, workerSource, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const runtimePackageRoot = dirname(
    dirname(
      fileURLToPath(import.meta.resolve("@moinulmoin/eden-runtime-cloudflare")),
    ),
  );
  const bundleSource = join(
    runtimePackageRoot,
    "dist",
    "eden-eve-host-worker.mjs",
  );
  const bundleContents = await readFile(bundleSource).catch(() => undefined);
  if (bundleContents === undefined) {
    throw deploymentFailure(
      "EVE_HOST_BUNDLE_UNAVAILABLE",
      "The vendored Eve host worker bundle is missing from the installed runtime package.",
    );
  }
  await writeFile(
    join(workerRoot, "eden-eve-host-worker.mjs"),
    bundleContents,
    { mode: 0o644, flag: "wx" },
  );
  const config = {
    $schema: "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
    ...hostConfig.worker,
    main: "worker.ts",
  };
  await writeFile(
    wranglerConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
  return { workerSourcePath, wranglerConfigPath };
}

function runWranglerWithInput(
  args: readonly string[],
  cwd: string,
  input?: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      [wranglerEntrypoint, ...args],
      {
        cwd,
        env: safeWranglerEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }): void => {
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: result.exitCode,
        stdout: safeText(result.stdout),
        stderr: safeText(result.stderr),
      });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        exitCode: 1,
        stdout,
        stderr: "The bounded Wrangler operation timed out.",
      });
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", () => {
      clearTimeout(timeout);
      finish({ exitCode: 1, stdout, stderr: "Wrangler could not be started." });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      finish({ exitCode: code ?? 1, stdout, stderr });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function defaultProtectedStore(
  workerName: string,
): EveRuntimeProtectedStore {
  return {
    async put(request) {
      for (const name of request.variableNames) {
        const result = await runWranglerWithInput(
          [
            "secret",
            "put",
            name,
            "--name",
            workerName,
          ],
          process.cwd(),
          request.values[name] === undefined ? "" : `${request.values[name]}\n`,
        );
        if (result.exitCode !== 0) {
          throw new EveRuntimeConfigError({
            code: "EVE_RUNTIME_PROTECTED_UPLOAD_FAILED",
            message: "The protected Cloudflare runtime upload failed.",
          });
        }
      }
      return {
        revision: request.revision,
        handle: `eve-runtime-handle-${randomUUID()}`,
      };
    },
  };
}

async function defaultImagePublicationRunner(
  request: EveImagePublicationRequest,
): Promise<EveImagePublicationResult> {
  try {
    await execFileAsync(
      "docker",
      ["tag", request.localImageReference, request.localImageTag],
      {
        env: safeDockerEnvironment(),
        cwd: request.generationRoot,
        maxBuffer: 512 * 1024,
      },
    );
    const pushed = await runWranglerWithInput(
      ["containers", "push", request.localImageTag],
      request.generationRoot,
    );
    if (pushed.exitCode !== 0) {
      return {
        status: "indeterminate",
        reason: "The exact Cloudflare Container image push did not complete.",
        evidenceRetained: true,
      };
    }
    const inspected = await execFileAsync(
      "docker",
      [
        "image",
        "inspect",
        request.localImageTag,
        "--format",
        "{{json .RepoDigests}}",
      ],
      {
        env: safeDockerEnvironment(),
        cwd: request.generationRoot,
        maxBuffer: 512 * 1024,
      },
    );
    const repoDigests = JSON.parse(inspected.stdout.trim()) as unknown;
    const exact = Array.isArray(repoDigests)
      ? repoDigests.find((value): value is string =>
        typeof value === "string" &&
        value.startsWith(`${request.targetImageReference.split("@")[0]}@`)
      )
      : undefined;
    if (
      exact === undefined ||
      !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/u
        .test(exact)
    ) {
      return {
        status: "indeterminate",
        reason: "The pushed Cloudflare image digest could not be proven exactly.",
        evidenceRetained: true,
      };
    }
    const digest = imageDigestFromReference(exact);
    if (digest === undefined) {
      return {
        status: "indeterminate",
        reason: "The pushed Cloudflare image returned no immutable digest.",
        evidenceRetained: true,
      };
    }
    return {
      status: "published",
      imageReference: exact,
      imageDigest: digest,
    };
  } catch {
    return {
      status: "indeterminate",
      reason: "The exact Cloudflare Container image publication failed ambiguously.",
      evidenceRetained: true,
    };
  }
}

function defaultPublicationRunner(): EveDeploymentPublicationRunner {
  return async (request) => {
    const result = await runWranglerWithInput(
      [
        "deploy",
        "--config",
        request.wranglerConfigPath,
        "--name",
        request.identity.workerName,
        "--env",
        request.identity.environment,
        "--strict",
        "--containers-rollout",
        "immediate",
      ],
      dirname(request.wranglerConfigPath),
    );
    if (result.exitCode !== 0) {
      return {
        status: "indeterminate",
        reason:
          "The exact Cloudflare publication did not return a terminal success result.",
        ownershipEvidenceRetained: true,
      };
    }
    const containers = await readWranglerJson([
      "containers",
      "list",
      "--json",
      "--per-page",
      "100",
    ]);
    const containerEntries = exactContainerEntries(
      containers.value,
      request.hostConfig.container.applicationName,
    );
    const deployments = await readWranglerJson([
      "deployments",
      "list",
      "--name",
      request.identity.workerName,
      "--json",
    ]);
    const deploymentEntries = exactDeploymentEntries(deployments.value);
    if (
      containers.failed ||
      containerEntries === undefined ||
      containerEntries.length !== 1 ||
      deployments.failed ||
      deploymentEntries === undefined ||
      deploymentEntries.length === 0
    ) {
      return {
        status: "indeterminate",
        reason:
          "The exact Worker deployment and named Container could not be re-read after publication.",
        ownershipEvidenceRetained: true,
      };
    }
    return {
      status: "published",
      identity: request.identity,
      createdByAttempt: true,
      ownershipProven: true,
    };
  };
}

function responseIdentity(
  response: Response,
  body: unknown,
): EveDeploymentIdentityProof {
  const record = typeof body === "object" && body !== null
    ? body as Record<string, unknown>
    : {};
  const identity: EveDeploymentIdentityProof = {};
  const read = (name: keyof EveDeploymentIdentity, header: string): void => {
    const bodyValue = record[name];
    const headerValue = response.headers.get(header);
    if (typeof bodyValue === "string") {
      (identity as Record<string, unknown>)[name] = bodyValue;
    } else if (headerValue !== null) {
      (identity as Record<string, unknown>)[name] = headerValue;
    }
  };
  read("projectId", "x-eden-eve-project-id");
  read("sourceDigest", "x-eden-eve-source-digest");
  read("generationId", "x-eden-eve-generation-id");
  read("deploymentId", "x-eden-eve-deployment-id");
  read("environment", "x-eden-eve-environment");
  read("name", "x-eden-eve-name");
  read("accountId", "x-eden-eve-account-id");
  read("workersDevSubdomain", "x-eden-eve-workers-dev-subdomain");
  read("stableWorkersDevOrigin", "x-eden-eve-public-origin");
  read("workerName", "x-eden-eve-worker-name");
  read("containerApplicationName", "x-eden-eve-container-application");
  read("stableContainerInstanceName", "x-eden-eve-container-instance");
  read("containerImage", "x-eden-eve-container-image");
  return identity;
}

function defaultHealthRunner(): EveDeploymentHealthRunner {
  return async (request) => {
    const attempts = 12;
    const perAttemptTimeoutMs = 20_000;
    const retryDelayMs = 5_000;
    let sawResponse = false;
    let lastReason = "The public Eve health request did not complete.";
    const wait = async (): Promise<void> => {
      // Executor form: the CLI lib target predates Promise.withResolvers.
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${request.origin}/eve/v1/health`, {
          method: "GET",
          signal: AbortSignal.timeout(perAttemptTimeoutMs),
        });
        sawResponse = true;
      } catch {
        lastReason =
          "The public Eve health request did not complete before the bounded deadline (cold Container boot may still be starting).";
        await wait();
        continue;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const ready = response.ok &&
        typeof body === "object" &&
        body !== null &&
        (
          (body as Record<string, unknown>).status === "ready" ||
          (body as Record<string, unknown>).state === "ready" ||
          (body as Record<string, unknown>).ready === true
        );
      if (ready) {
        return {
          status: "ready",
          identity: responseIdentity(response, body),
        };
      }
      lastReason =
        "The public Eve health route did not report ready before the bounded deadline.";
      await wait();
    }
    return {
      status: sawResponse ? "failed" : "indeterminate",
      reason: lastReason,
    };
  };
}

interface EveTargetLock {
  readonly path: string;
  readonly serialized: string;
}

async function acquireEveTargetLock(
  projectRoot: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<EveTargetLock> {
  const lockRoot = join(projectRoot, ".eden", "eve-deploy", "locks");
  await mkdir(lockRoot, { recursive: true });
  const lockPath = join(
    lockRoot,
    `${environment}-${name}.lock`,
  );
  const serialized = `${JSON.stringify({
    kind: "eden.eve.deploy.lock",
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    environment,
    name,
  })}\n`;
  try {
    await writeFile(lockPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error: unknown) {
    const code = error as NodeJS.ErrnoException;
    if (code.code === "EEXIST") {
      throw new EveCliError({
        code: "EVE_DEPLOY_BUSY",
        message:
          "Another Eve deployment owns the exact target; retry after it finishes.",
        source: "deployment-lock",
      });
    }
    throw error;
  }
  return { path: lockPath, serialized };
}

async function releaseEveTargetLock(lock: EveTargetLock): Promise<boolean> {
  const observed = await readFile(lock.path, "utf8").catch(() => undefined);
  if (observed === undefined) return false;
  if (observed !== lock.serialized) return false;
  await rm(lock.path, { force: true });
  return (await lstat(lock.path).catch(() => undefined)) === undefined;
}

async function promoteEveTargetPointer(
  deploymentRoot: string,
  targetKey: string,
  generationRoot: string,
): Promise<string> {
  const targetRoot = join(deploymentRoot, "targets", targetKey);
  const artifactBoundary = await realpath(dirname(deploymentRoot)).catch(
    () => undefined,
  );
  const generationCanonical = await realpath(generationRoot).catch(
    () => undefined,
  );
  if (
    artifactBoundary === undefined ||
    generationCanonical === undefined ||
    (
      generationCanonical !== artifactBoundary &&
      !generationCanonical.startsWith(`${artifactBoundary}/`)
    )
  ) {
    throw new EveCliError({
      code: "EVE_DEPLOY_PROMOTION_FAILED",
      message: "The immutable Eve generation escaped the Eden artifact boundary.",
      source: "generation",
    });
  }
  const generationDetails = await lstat(generationRoot).catch(() => undefined);
  if (
    generationDetails === undefined ||
    !generationDetails.isDirectory() ||
    generationDetails.isSymbolicLink()
  ) {
    throw new EveCliError({
      code: "EVE_DEPLOY_PROMOTION_FAILED",
      message: "The immutable Eve generation was unavailable for promotion.",
      source: relative(deploymentRoot, generationRoot),
    });
  }
  await mkdir(targetRoot, { recursive: true });
  const targetRootCanonical = await realpath(targetRoot).catch(() => undefined);
  if (targetRootCanonical === undefined || targetRootCanonical !== targetRoot) {
    throw new EveCliError({
      code: "EVE_DEPLOY_PROMOTION_FAILED",
      message: "The Eve target pointer directory could not be verified safely.",
      source: targetKey,
    });
  }
  const currentPath = join(targetRoot, "CURRENT");
  const stagePath = join(
    targetRoot,
    `.CURRENT-${process.pid}-${randomUUID()}`,
  );
  await symlink(
    relative(targetRoot, generationRoot),
    stagePath,
  );
  try {
    await rename(stagePath, currentPath);
  } finally {
    await rm(stagePath, { force: true }).catch(() => undefined);
  }
  const resolved = await realpath(currentPath).catch(() => undefined);
  if (resolved !== generationCanonical) {
    throw new EveCliError({
      code: "EVE_DEPLOY_PROMOTION_FAILED",
      message: "The Eve target pointer did not resolve to the promoted generation.",
      source: targetKey,
    });
  }
  return currentPath;
}

async function writeEveDeploymentRecord(
  candidate: EveProjectBuildCandidate,
  identity: EveDeploymentIdentity,
  hostConfig: EveHostConfig,
  status: EveDeploymentStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(candidate.generationRoot, "deployment.json"),
    `${JSON.stringify({
      version: 1,
      status,
      identity: safeIdentity(identity),
      worker: hostConfig.worker,
      container: hostConfig.container,
      ...extra,
    }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
}

async function writeEveIndeterminateEvidence(
  candidate: EveProjectBuildCandidate,
  evidence: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(candidate.generationRoot, "deployment-attempt.json"),
    `${JSON.stringify({
      version: 1,
      status: "indeterminate",
      generationId: candidate.generationId,
      sourceDigest: candidate.sourceDigest,
      outputDigest: candidate.generatedOutput.outputDigest,
      evidence: safeText(evidence),
      ...extra,
    }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
}

function deploymentMetadata(
  identity: EveDeploymentIdentity,
  targetKey: string,
  status: EveDeploymentStatus,
): EveDeploymentMetadata {
  return {
    status,
    targetKey,
    deploymentId: identity.deploymentId,
    workerName: identity.workerName,
    containerApplicationName: identity.containerApplicationName,
    stableContainerInstanceName: identity.stableContainerInstanceName,
    stableWorkersDevOrigin: identity.stableWorkersDevOrigin,
    imageReference: identity.containerImage,
    runtimeVariableNames: identity.runtimeVariableNames,
    evidenceRetained: true,
  };
}

function deploymentFailure(
  code: string,
  message: string,
): EveCliError {
  return new EveCliError({
    code,
    message: safeText(message),
    source: "eve deploy",
  });
}

async function runEveDeployment(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions,
  collected: EvePreflightCollection,
): Promise<EvePreflightResult> {
  const candidate = collected.candidate;
  const cloudflare = collected.cloudflare;
  const runtimeEvidence = collected.runtimeEvidence;
  if (
    candidate === undefined ||
    cloudflare === undefined ||
    runtimeEvidence === undefined ||
    collected.projectId === undefined
  ) {
    throw deploymentFailure(
      "EVE_DEPLOY_CHECKS_FAILED",
      "The inline Eve deploy checks did not return a complete immutable candidate.",
    );
  }

  const accountId = cloudflare.accountId ??
    cloudflare.target.identity?.accountId;
  const workersDevSubdomain = cloudflare.workersDevSubdomain ??
    cloudflare.target.identity?.workersDevSubdomain;
  if (accountId === undefined || workersDevSubdomain === undefined) {
    throw deploymentFailure(
      "EVE_ORIGIN_UNAVAILABLE",
      "The authenticated Cloudflare account and workers.dev subdomain were not returned by the read-only resolver.",
    );
  }
  let stableWorkersDevOrigin: string;
  try {
    const { resolveStableWorkersDevOrigin } = await import(
      "@moinulmoin/eden-runtime-cloudflare"
    );
    stableWorkersDevOrigin = resolveStableWorkersDevOrigin({
      workerName: request.name,
      workersDevSubdomain,
    });
  } catch (error: unknown) {
    throw deploymentFailure(
      "EVE_ORIGIN_UNAVAILABLE",
      error instanceof Error
        ? error.message
        : "The exact workers.dev origin could not be resolved.",
    );
  }
  if (
    cloudflare.stableWorkersDevOrigin !== undefined &&
    cloudflare.stableWorkersDevOrigin !== stableWorkersDevOrigin
  ) {
    throw deploymentFailure(
      "EVE_ORIGIN_UNAVAILABLE",
      "The authenticated stable workers.dev origin did not match the exact Worker target.",
    );
  }

  const imageDigest = runtimeEvidence.imageDigest;
  if (imageDigest === undefined || !/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) {
    throw deploymentFailure(
      "EVE_IMAGE_IDENTITY_UNAVAILABLE",
      "The deploy candidate did not provide an immutable runtime image digest.",
    );
  }

  const targetKey = stableDeploymentKey(
    collected.projectId,
    accountId,
    request.environment,
    request.name,
  );
  let imageReference = options.containerImageReference;
  if (imageReference !== undefined) {
    if (imageDigestFromReference(imageReference) !== imageDigest) {
      throw deploymentFailure(
        "EVE_IMAGE_IDENTITY_MISMATCH",
        "The exact Container image reference did not match the verified local image digest.",
      );
    }
  } else {
    const localImageReference = runtimeEvidence.imageReference;
    if (localImageReference === undefined || localImageReference.length === 0) {
      throw deploymentFailure(
        "EVE_IMAGE_IDENTITY_UNAVAILABLE",
        "The deploy candidate did not return an exact local image handle for publication.",
      );
    }
    const imageRepository =
      `eden-eve-${targetKey}-${candidate.generationId}`;
    const imageTag = `${imageRepository}:candidate`;
    const targetImageReference =
      `registry.cloudflare.com/${accountId}/${imageRepository}@${imageDigest}`;
    const imagePublication = await (options.publishImage ??
      defaultImagePublicationRunner)({
      accountId,
      targetImageReference,
      localImageReference,
      localImageTag: imageTag,
      generationRoot: candidate.generationRoot,
    });
    if (imagePublication.status === "indeterminate") {
      await writeEveIndeterminateEvidence(
        candidate,
        imagePublication.reason,
        {
          accountId,
          targetKey,
          imageRepository,
          imageDigest,
        },
      );
      throw deploymentFailure(
        "DEPLOY_INDETERMINATE",
        imagePublication.reason,
      );
    }
    const publishedRepo = imagePublication.imageReference.split("@")[0];
    const expectedRepo = targetImageReference.split("@")[0];
    if (
      publishedRepo !== expectedRepo ||
      imageDigestFromReference(imagePublication.imageReference) !==
        imagePublication.imageDigest
    ) {
      await writeEveIndeterminateEvidence(
        candidate,
        "The published image did not match the exact target repository and digest identity.",
        {
          accountId,
          targetKey,
          imageRepository,
          imageDigest,
        },
      );
      throw deploymentFailure(
        "DEPLOY_INDETERMINATE",
        "The published image did not match the exact target repository and digest identity.",
      );
    }
    imageReference = imagePublication.imageReference;
  }
  if (imageReference === undefined) {
    throw deploymentFailure(
      "EVE_IMAGE_IDENTITY_UNAVAILABLE",
      "The deploy candidate did not resolve an immutable registry image reference.",
    );
  }
  let runtimeInjection: EveRuntimeInjection | undefined;
  if (collected.runtimeConfig !== undefined) {
    try {
      runtimeInjection = await prepareEveRuntimeInjection(
        collected.runtimeConfig,
        {
          mode: "deploy",
          targetId: targetKey,
          protectedStore: options.protectedStore ??
            defaultProtectedStore(request.name),
        },
      );
    } catch (error: unknown) {
      const reason = error instanceof Error
        ? error.message
        : "protected runtime injection failed before Worker publication";
      await writeEveIndeterminateEvidence(candidate, reason, {
        accountId,
        targetKey,
        imageReference,
        imageDigest,
      });
      throw deploymentFailure("DEPLOY_INDETERMINATE", reason);
    }
  }
  const deploymentId = `eve-deploy-${randomUUID()}`;
  const containerApplicationName = boundedResourceName(request.name, "container");
  const stableContainerInstanceName = boundedResourceName(request.name, "instance");
  const runtimeVariableNames = candidate.runtimeVariableNames;
  const identity: EveDeploymentIdentity = {
    projectId: collected.projectId,
    sourceDigest: candidate.sourceDigest,
    generationId: candidate.generationId,
    deploymentId,
    environment: request.environment,
    name: request.name,
    accountId,
    workersDevSubdomain,
    stableWorkersDevOrigin,
    workerName: request.name,
    containerApplicationName,
    stableContainerInstanceName,
    containerImage: imageReference,
    runtimeVariableNames,
    ...(runtimeInjection?.protectedHandle === undefined
      ? {}
      : { runtimeRevisionHandle: runtimeInjection.protectedHandle }),
  };
  let hostConfig: EveHostConfig;
  try {
    const {
      createEveHostConfig,
    } = await import("@moinulmoin/eden-runtime-cloudflare");
    hostConfig = createEveHostConfig({
      accountId,
      workerName: identity.workerName,
      containerApplicationName: identity.containerApplicationName,
      containerClassName: "EveHostContainer",
      containerBindingName: "EVE_CONTAINER",
      stableContainerInstanceName: identity.stableContainerInstanceName,
      deploymentId: identity.deploymentId,
      generationId: identity.generationId,
      stableWorkersDevOrigin: identity.stableWorkersDevOrigin,
      containerImage: identity.containerImage,
      runtimeVariableNames: identity.runtimeVariableNames,
      ...(identity.runtimeRevisionHandle === undefined
        ? {}
        : { runtimeRevisionHandle: identity.runtimeRevisionHandle }),
    });
  } catch (error: unknown) {
    throw deploymentFailure(
      "EVE_HOST_CONFIG_INVALID",
      error instanceof Error
        ? error.message
        : "The exact Eve Worker/Container host configuration was invalid.",
    );
  }
  const { generateEveHostWorkerSource } = await import(
    "@moinulmoin/eden-runtime-cloudflare"
  );
  const workerSource = generateEveHostWorkerSource({ config: hostConfig });
  const paths = await writeEveDeploymentArtifacts(
    candidate,
    hostConfig,
    workerSource,
  );
  const publicationRequest: EveDeploymentPublicationRequest = {
    identity,
    hostConfig,
    workerSource,
    ...paths,
    ...(runtimeInjection === undefined ? {} : { runtimeInjection }),
  };
  let publication: EveDeploymentPublicationResult;
  try {
    publication = await (options.publish ?? defaultPublicationRunner())(
      publicationRequest,
    );
  } catch {
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "indeterminate",
      { evidence: "publication-threw-before-terminal-result" },
    );
    const deployment = deploymentMetadata(identity, targetKey, "indeterminate");
    return {
      ...collected.result,
      ok: false,
      deployment,
    };
  }
  if (publication.status === "indeterminate") {
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "indeterminate",
      { evidence: safeText(publication.reason) },
    );
    return {
      ...collected.result,
      ok: false,
      deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
    };
  }
  if (
    publication.status === "failed" ||
    !identityMatches(identity, publication.identity)
  ) {
    if (
      publication.status === "failed" &&
      publication.createdByAttempt === true &&
      publication.ownershipProven !== true
    ) {
      await writeEveDeploymentRecord(
        candidate,
        identity,
        hostConfig,
        "indeterminate",
        { evidence: "publication-created-resource-ownership-unproven" },
      );
      return {
        ...collected.result,
        ok: false,
        deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
      };
    }
    if (
      publication.status === "failed" &&
      publication.createdByAttempt === true &&
      publication.ownershipProven === true &&
      options.compensate === undefined
    ) {
      await writeEveDeploymentRecord(
        candidate,
        identity,
        hostConfig,
        "indeterminate",
        { evidence: "exact-compensation-runner-unavailable" },
      );
      return {
        ...collected.result,
        ok: false,
        deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
      };
    }
    if (
      publication.status === "failed" &&
      publication.createdByAttempt === true &&
      publication.ownershipProven === true &&
      options.compensate !== undefined
    ) {
      try {
        await options.compensate({
          identity,
          publication,
        });
      } catch {
        await writeEveDeploymentRecord(
          candidate,
          identity,
          hostConfig,
          "indeterminate",
          { evidence: "exact-compensation-not-proven" },
        );
        return {
          ...collected.result,
          ok: false,
          deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
        };
      }
    }
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "failed",
      {
        evidence:
          publication.status === "failed"
            ? safeText(publication.reason)
            : "publication identity did not match the immutable candidate",
      },
    );
    return {
      ...collected.result,
      ok: false,
      deployment: deploymentMetadata(identity, targetKey, "failed"),
    };
  }

  let health: EveDeploymentHealthResult;
  try {
    health = await (options.health ?? defaultHealthRunner())({
      identity,
      origin: stableWorkersDevOrigin,
    });
  } catch {
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "indeterminate",
      { evidence: "health-threw-before-terminal-result" },
    );
    return {
      ...collected.result,
      ok: false,
      deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
    };
  }
  if (health.status === "indeterminate") {
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "indeterminate",
      { evidence: safeText(health.reason) },
    );
    return {
      ...collected.result,
      ok: false,
      deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
    };
  }
  const observedHealthIdentity = health.status === "ready"
    ? {
      ...publication.identity,
      ...health.identity,
    }
    : undefined;
  if (
    health.status === "failed" ||
    !transportIdentityMatches(identity, observedHealthIdentity)
  ) {
    if (
      publication.createdByAttempt === true &&
      publication.ownershipProven !== true
    ) {
      await writeEveDeploymentRecord(
        candidate,
        identity,
        hostConfig,
        "indeterminate",
        { evidence: "health-failure-ownership-unproven" },
      );
      return {
        ...collected.result,
        ok: false,
        deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
      };
    }
    if (
      publication.createdByAttempt === true &&
      publication.ownershipProven === true &&
      options.compensate === undefined
    ) {
      await writeEveDeploymentRecord(
        candidate,
        identity,
        hostConfig,
        "indeterminate",
        { evidence: "exact-compensation-runner-unavailable-after-health" },
      );
      return {
        ...collected.result,
        ok: false,
        deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
      };
    }
    if (
      publication.createdByAttempt === true &&
      publication.ownershipProven === true &&
      options.compensate !== undefined
    ) {
      try {
        await options.compensate({ identity, publication });
      } catch {
        await writeEveDeploymentRecord(
          candidate,
          identity,
          hostConfig,
          "indeterminate",
          { evidence: "exact-compensation-not-proven-after-health" },
        );
        return {
          ...collected.result,
          ok: false,
          deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
        };
      }
    }
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "failed",
      {
        evidence:
          health.status === "failed"
            ? safeText(health.reason)
            : "health identity did not match the immutable candidate",
      },
    );
    return {
      ...collected.result,
      ok: false,
      deployment: deploymentMetadata(identity, targetKey, "failed"),
    };
  }

  try {
    await revalidateEveRuntimeCandidate(candidate);
    await revalidateEveProjectCandidateInputs(
      candidate,
      runtimeConfigExclusion(collected.runtimeConfig),
    );
  } catch (error: unknown) {
    if (
      publication.createdByAttempt === true &&
      publication.ownershipProven === true &&
      options.compensate !== undefined
    ) {
      try {
        await options.compensate({ identity, publication });
      } catch {
        await writeEveDeploymentRecord(
          candidate,
          identity,
          hostConfig,
          "indeterminate",
          { evidence: "post-health-input-race-compensation-unproven" },
        );
        return {
          ...collected.result,
          ok: false,
          deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
        };
      }
      await writeEveDeploymentRecord(
        candidate,
        identity,
        hostConfig,
        "failed",
        {
          evidence: error instanceof Error
            ? safeText(error.message)
            : "candidate inputs changed after health",
        },
      );
      return {
        ...collected.result,
        ok: false,
        deployment: deploymentMetadata(identity, targetKey, "failed"),
      };
    }
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "indeterminate",
      {
        evidence: error instanceof Error
          ? safeText(error.message)
          : "candidate inputs changed after health without exact compensation",
      },
    );
    return {
      ...collected.result,
      ok: false,
      deployment: deploymentMetadata(identity, targetKey, "indeterminate"),
    };
  }
  await writeEveDeploymentRecord(
    candidate,
    identity,
    hostConfig,
    "deployed",
    {
      evidence: {
        publication: "published",
        health: "ready",
        identity: "exact",
      },
    },
  );
  await promoteEveTargetPointer(
    join(request.projectRoot, ".eden", "eve-deploy"),
    targetKey,
    candidate.generationRoot,
  );
  await options.afterPromotion?.();
  let runtimeImageCleanup: EvePreflightCheck | undefined;
  if (runtimeEvidence.cleanup.imageRetained) {
    if (options.retainRuntimeImage === true) {
      runtimeImageCleanup = check(
        "VAL-CROSS-004",
        "skipped",
        "The exact local runtime image was intentionally retained by the programmatic caller.",
      );
    } else {
      let discarded = false;
      try {
        discarded = await (options.discardRuntimeImage ??
          discardEveRuntimeImage)({
          imageId: imageDigest,
          generationId: candidate.generationId,
          generationRoot: candidate.generationRoot,
        });
      } catch {
        discarded = false;
      }
      runtimeImageCleanup = discarded
        ? check(
          "VAL-CROSS-004",
          "passed",
          "The exact local runtime image and its publication tags were removed after the healthy deployment was promoted.",
        )
        : check(
          "VAL-CROSS-004",
          "failed",
          "The remote deployment is healthy, but exact local runtime-image cleanup could not be verified.",
          `Remove only the recorded image ${imageDigest}; do not retry or run broad Docker cleanup.`,
        );
    }
  }
  return {
    ...collected.result,
    ok: runtimeImageCleanup?.status !== "failed",
    ...(runtimeImageCleanup === undefined
      ? {}
      : { checks: [...collected.result.checks, runtimeImageCleanup] }),
    deployment: deploymentMetadata(identity, targetKey, "deployed"),
  };
}

async function collectEvePreflight(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions,
): Promise<EvePreflightCollection> {
  let runtimeConfig: EveRuntimeConfig | undefined;
  const checks: EvePreflightCheck[] = [];
  try {
    if (request.envFile === undefined) {
      checks.push(
        check(
          "VAL-SEC-001",
          "skipped",
          "No explicit --env-file was supplied; no implicit project environment source was read.",
        ),
        check(
          "VAL-SEC-002",
          "skipped",
          "No explicit runtime names were supplied; reserved host-name validation was not needed.",
        ),
      );
    } else if (options.runtimeConfigLoader === undefined) {
      checks.push(
        check(
          "VAL-SEC-001",
          "blocked",
          "The explicit environment path was received, but no deployment-safety runtime-config loader was configured.",
          "Pass the opaque --env-file path to the deployment-safety runtime-config seam; the control plane never parses its contents.",
        ),
      );
    } else {
      runtimeConfig = await options.runtimeConfigLoader(
        request.envFile,
        request.cwd,
      );
      checks.push(
        check(
          "VAL-SEC-001",
          "passed",
          "The explicit environment file passed the deployment-safety opaque UTF-8 KEY=VALUE grammar.",
        ),
        check(
          "VAL-SEC-002",
          "passed",
          "The explicit environment file contains no reserved Eve host-variable collision.",
        ),
      );
    }
  } catch (error: unknown) {
    checks.push(
      check(
        "VAL-SEC-001",
        "failed",
        error instanceof EveRuntimeConfigError
          ? error.message
          : "The explicit environment file could not be validated safely.",
        "Fix the explicit environment file through the documented opaque grammar, then retry.",
      ),
      blockedAfterFailure(
        "VAL-SEC-002",
        "Reserved-name validation was blocked because explicit environment validation failed.",
      ),
      blockedAfterFailure(
        "VAL-CLI-004",
        "Project and Eve build checks were blocked by explicit environment validation.",
      ),
      blockedAfterFailure(
        "VAL-BUILD-005",
        "Image, Eve-start, and health checks were blocked by explicit environment validation.",
      ),
      blockedAfterFailure(
        "VAL-CLI-007-CLOUDFLARE-ACCESS",
        "Cloudflare access checks were blocked before any remote read.",
      ),
      blockedAfterFailure(
        "VAL-CLI-007-TARGET-CONFLICT",
        "Exact target conflict checks were blocked before any remote read.",
      ),
    );
    return {
      result: {
        command: request.command === "deploy" ? "eve deploy" : "eve preflight",
        ok: false,
        environment: request.environment,
        name: request.name,
        checks,
        candidate: null,
      },
      runtimeConfig,
    };
  }

  const nodeImage = options.nodeImage ?? DEFAULT_EVE_NODE_IMAGE;
  const artifactRoot = options.artifactRoot ??
    join(
      request.projectRoot,
      ".eden",
      "eve-deploy",
      "generations",
      `preflight-${randomUUID()}`,
    );
  let packaging: EveProjectPackagingResult;
  const builder = options.builder ??
    createDockerEveProjectBuilder({ nodeImage });
  try {
    const baseSnapshotOptions = {
      projectRoot: request.projectRoot,
      artifactRoot,
      builder,
      nodeImage,
    } satisfies Parameters<typeof buildEveProjectSnapshot>[0];
    const runtimeExclusion = runtimeConfigExclusion(runtimeConfig);
    packaging = runtimeExclusion === undefined
      ? await buildEveProjectSnapshot(baseSnapshotOptions)
      : await buildEveProjectSnapshot({
        ...baseSnapshotOptions,
        runtimeConfig: runtimeExclusion,
      });
  } catch {
    packaging = {
      schemaVersion: 1,
      worker: "eve-packaging-worker",
      operation: "local-package",
      status: "blocked",
      returnCode: "ROOT_INVALID",
      deployable: false,
      project: null,
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
      checks: [],
      candidateImageId: null,
      candidateImageRetainedLocally: false,
      writtenPaths: [],
      error: null,
    };
  }
  checks.push(...packaging.checks.map(mapPackagingCheck));
  const discardPackagingImage = async (): Promise<void> => {
    if (
      packaging.candidateImageId === null ||
      builder.discard === undefined
    ) {
      return;
    }
    const result = {
      imageId: packaging.candidateImageId,
      ...(packaging.image?.imageReference === null ||
        packaging.image?.imageReference === undefined
        ? {}
        : { imageReference: packaging.image.imageReference }),
      ...(packaging.image?.imageDigest === null ||
        packaging.image?.imageDigest === undefined
        ? {}
        : { imageDigest: packaging.image.imageDigest }),
      imagePlatform: "linux/amd64" as const,
    };
    try {
      await builder.discard(result);
    } catch {
      checks.push(
        check(
          "VAL-CROSS-004",
          "failed",
          "The intermediate local Eve image could not be removed with exact identity proof.",
          "Inspect only the recorded candidate image identity; do not run broad Docker cleanup.",
        ),
      );
    }
  };
  if (!packaging.deployable || packaging.candidate === null) {
    checks.push(
      blockedAfterFailure(
        "VAL-BUILD-005",
        "Linux/amd64 image, official Eve-start boot, and real health checks were blocked because no immutable candidate was produced.",
      ),
      blockedAfterFailure(
        "VAL-CLI-007-CLOUDFLARE-ACCESS",
        "Cloudflare access checks were blocked before any remote read.",
      ),
      blockedAfterFailure(
        "VAL-CLI-007-TARGET-CONFLICT",
        "Exact target conflict checks were blocked before any remote read.",
      ),
    );
    return {
      result: {
        command: request.command === "deploy" ? "eve deploy" : "eve preflight",
        ok: false,
        environment: request.environment,
        name: request.name,
        checks,
        candidate: null,
      },
      runtimeConfig,
    };
  }

  const candidate = packaging.candidate;
  let cloudflare: EveCloudflareReadResult | undefined;
  let publicOrigin: string | undefined;
  if (request.command === "deploy") {
    try {
      cloudflare = await readEveCloudflareTarget(
        {
          projectId: packaging.project?.projectId ?? "unknown-project",
          sourceDigest: candidate.sourceDigest,
          environment: request.environment,
          name: request.name,
        },
        options,
      );
    } catch {
      await discardPackagingImage();
      checks.push(
        check(
          "VAL-CLI-007-CLOUDFLARE-ACCESS",
          "failed",
          "The exact read-only Cloudflare adapter failed without a safe result.",
          "Retry with an authenticated read-only account, Container, and exact-target adapter; no remote mutation was attempted.",
        ),
        blockedAfterFailure(
          "VAL-CLI-007-TARGET-CONFLICT",
          "The exact target conflict read was blocked because the read-only Cloudflare adapter failed.",
        ),
      );
      return {
        result: {
          command: "eve deploy",
          ok: false,
          environment: request.environment,
          name: request.name,
          checks,
          candidate: candidateMetadata(candidate, undefined),
        },
        runtimeConfig,
      };
    }
    checks.push(...cloudflareChecks(cloudflare));
    publicOrigin = await resolvedCloudflareOrigin(cloudflare, request.name);
    if (publicOrigin === undefined) {
      checks.push(
        check(
          "VAL-HOST-006",
          "failed",
          "The authenticated Cloudflare read did not prove the exact workers.dev origin before Eve initialization.",
          "Return one authenticated account ID, one workers.dev subdomain, and the exact Worker-origin binding.",
        ),
      );
    }
    if (!allChecksClear(checks)) {
      await discardPackagingImage();
      return {
        result: {
          command: "eve deploy",
          ok: false,
          environment: request.environment,
          name: request.name,
          checks,
          candidate: candidateMetadata(candidate, undefined),
        },
        runtimeConfig,
      };
    }
  }
  let hostRequirements: EveHostRequirements | undefined;
  let hostRequirementsValid = false;
  try {
    if (options.hostRequirements !== undefined) {
      hostRequirements = typeof options.hostRequirements === "function"
        ? await options.hostRequirements(candidate)
        : options.hostRequirements;
    }
  } catch {
    checks.push(
      check(
        "VAL-BUILD-007",
        "failed",
        "The Eve host-capability adapter failed without a verified result.",
        "Return an explicit provider-neutral Linux/amd64, World, sandbox, process, network, and disposable-storage result.",
      ),
    );
  }
  if (hostRequirements === undefined) {
    checks.push(
      check(
        "VAL-BUILD-007",
        "blocked",
        "Eve host capabilities were not proven for this preflight invocation.",
        "Provide an explicit host-capability result; unknown World, sandbox, architecture, device, kernel, network, or durable-storage requirements fail closed.",
      ),
    );
  } else {
    try {
      validateEveHostRequirements(hostRequirements);
      hostRequirementsValid = true;
    } catch (error: unknown) {
      checks.push(
        check(
          "VAL-BUILD-007",
          "failed",
          error instanceof Error
            ? error.message
            : "The Eve host-capability result was not supported by the hosting contract.",
          "Use only the documented Linux/amd64, disposable-process, outbound-network, sandbox, World, and non-durable-storage capabilities.",
        ),
      );
      hostRequirements = undefined;
    }
  }

  let runtimeEvidence: EvePreflightRuntimeEvidence | undefined;
  let runtimeInjection: EveRuntimeInjection | undefined;
  if (hostRequirements !== undefined && hostRequirementsValid) {
    try {
      if (runtimeConfig !== undefined && request.command === "preflight") {
        runtimeInjection = await prepareEveRuntimeInjection(runtimeConfig, {
          mode: "preflight",
        });
      }
      const runtimeRunner = options.runtimeRunner ?? defaultRuntimeRunner;
      runtimeEvidence = await runtimeRunner({
        candidate,
        nodeImage,
        healthPort: options.healthPort ?? await findAvailableEveHealthPort(),
        hostRequirements,
        ...(publicOrigin === undefined ? {} : { publicOrigin }),
        retainImage: request.command === "deploy",
        ...(runtimeInjection === undefined ? {} : { runtimeInjection }),
      });
      checks.push(...runtimeEvidence.checks);
      const requiredRuntimeChecks = [
        "VAL-BUILD-005",
        "VAL-BUILD-006",
        "VAL-BUILD-007",
      ] as const;
      const runtimeProofComplete = requiredRuntimeChecks.every((id) =>
        runtimeEvidence?.checks.some((value) =>
          value.id === id && value.status === "passed"
        )
      );
      const runtimeImageIdentityValid =
        /^sha256:[0-9a-f]{64}$/u.test(runtimeEvidence.imageDigest ?? "");
      if (!runtimeProofComplete) {
        checks.push(
          check(
            "VAL-BUILD-005",
            "failed",
            "The runtime seam did not return complete proof of Linux/amd64 image construction, official Eve-start boot, and real health.",
            "Return passed VAL-BUILD-005, VAL-BUILD-006, and VAL-BUILD-007 checks from the disposable runtime runner.",
          ),
        );
      }
      if (!runtimeImageIdentityValid) {
        checks.push(
          check(
            "VAL-BUILD-005",
            "failed",
            "The runtime seam did not return an exact immutable Linux/amd64 image digest.",
            "Return the verified sha256 image identity from the disposable runtime runner.",
          ),
        );
      }
      if (!runtimeEvidence.ok && runtimeProofComplete) {
        checks.push(
          check(
            "VAL-BUILD-005",
            "failed",
            "The local Eve runtime runner did not prove a deployable Linux/amd64 candidate.",
            "Inspect the project-local Eve start supervisor, sandbox prewarm, Workflow World startup, and real health route.",
          ),
        );
      }
      if (
        !runtimeEvidence.cleanup.bootContainerRemoved ||
        (
          request.command === "preflight" &&
          runtimeEvidence.cleanup.imageRetained
        ) ||
        runtimeEvidence.cleanup.imageIdentity !== "exact" ||
        !runtimeEvidence.cleanup.verified
      ) {
        checks.push(
          check(
            "VAL-CROSS-004",
            "failed",
            "The disposable Eve runtime did not return verified exact cleanup evidence.",
            "Remove and verify only the task-owned runtime image and boot container before retrying; never use broad Docker cleanup.",
          ),
        );
      }
      await revalidateEveRuntimeCandidate(candidate);
      await revalidateEveProjectCandidateInputs(
        candidate,
        runtimeConfigExclusion(runtimeConfig),
      );
    } catch (error: unknown) {
      checks.push(
        check(
          error instanceof EveRuntimeConfigError
            ? "VAL-SEC-003"
            : error instanceof EvePackagingError && error.code === "SOURCE_RACE"
              ? "VAL-CROSS-004"
              : "VAL-BUILD-005",
          "failed",
          error instanceof Error
            ? error.message
            : "The local Linux/amd64 Eve runtime candidate failed without a safe diagnostic.",
          "Inspect the owned candidate and retry after fixing the project-local Eve start, sandbox, World, and health path.",
        ),
      );
    }
  } else {
    checks.push(
      blockedAfterFailure(
        "VAL-BUILD-005",
        "Image, Eve-start, and real health checks were blocked because host capability was not proven.",
      ),
    );
  }

  const candidateResult = candidateMetadata(
    candidate,
    runtimeEvidence?.imageDigest,
  );
  if (!allChecksClear(checks)) {
    await discardPackagingImage();
    checks.push(
      blockedAfterFailure(
        "VAL-CLI-007-CLOUDFLARE-ACCESS",
        "Cloudflare access checks were blocked because local Eve candidate checks did not complete successfully.",
      ),
      blockedAfterFailure(
        "VAL-CLI-007-TARGET-CONFLICT",
        "Exact target conflict checks were blocked because local Eve candidate checks did not complete successfully.",
      ),
    );
    return {
      result: {
        command: request.command === "deploy" ? "eve deploy" : "eve preflight",
        ok: false,
        environment: request.environment,
        name: request.name,
        checks,
        candidate: candidateResult,
      },
      runtimeConfig,
    };
  }

  if (cloudflare === undefined) {
    try {
      cloudflare = await readEveCloudflareTarget(
        {
          projectId: packaging.project?.projectId ?? "unknown-project",
          sourceDigest: candidate.sourceDigest,
          environment: request.environment,
          name: request.name,
        },
        options,
      );
    } catch {
      await discardPackagingImage();
      checks.push(
        check(
          "VAL-CLI-007-CLOUDFLARE-ACCESS",
          "failed",
          "The exact read-only Cloudflare adapter failed without a safe result.",
          "Retry with an authenticated read-only account, Container, and exact-target adapter; no remote mutation was attempted.",
        ),
        blockedAfterFailure(
          "VAL-CLI-007-TARGET-CONFLICT",
          "The exact target conflict read was blocked because the read-only Cloudflare adapter failed.",
        ),
      );
      return {
        result: {
          command: "eve preflight",
          ok: false,
          environment: request.environment,
          name: request.name,
          checks,
          candidate: candidateResult,
        },
        runtimeConfig,
      };
    }
    checks.push(...cloudflareChecks(cloudflare));
  }
  await discardPackagingImage();
  return {
    result: {
      command: request.command === "deploy" ? "eve deploy" : "eve preflight",
      ok: allChecksClear(checks),
      environment: request.environment,
      name: request.name,
      checks,
      candidate: candidateResult,
    },
    runtimeConfig,
    candidate,
    ...(packaging.project?.projectId === undefined
      ? {}
      : { projectId: packaging.project.projectId }),
    ...(runtimeEvidence === undefined ? {} : { runtimeEvidence }),
    cloudflare,
  };
}

export async function runEveControlPlane(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions = {},
): Promise<void> {
  const lock = request.command === "deploy"
    ? await acquireEveTargetLock(
      request.projectRoot,
      request.environment,
      request.name,
    )
    : undefined;
  let collected: EvePreflightCollection | undefined;
  let primaryError: unknown;
  let failed = false;
  let lockReleased = true;
  try {
    collected = await collectEvePreflight(request, options);
    if (!collected.result.ok) {
      (options.stdout ?? (() => undefined))(
        redactEveRuntimeOutput(JSON.stringify(collected.result)),
      );
      throw new EveCliError({
        code: request.command === "deploy"
          ? "EVE_DEPLOY_CHECKS_FAILED"
          : "EVE_PREFLIGHT_FAILED",
        message:
          request.command === "deploy"
            ? "The inline Eve deploy checks failed; no remote mutation was attempted."
            : "The Eve preflight checks failed; no remote mutation or active-state promotion was attempted.",
      });
    }
    if (request.command === "preflight") {
      (options.stdout ?? (() => undefined))(
        redactEveRuntimeOutput(JSON.stringify(collected.result)),
      );
    } else {
      const deploymentResult = await runEveDeployment(
        request,
        options,
        collected,
      );
      (options.stdout ?? (() => undefined))(
        redactEveRuntimeOutput(JSON.stringify(deploymentResult)),
      );
      if (!deploymentResult.ok) {
        const status = deploymentResult.deployment?.status;
        throw new EveCliError({
          code: status === "indeterminate"
            ? "DEPLOY_INDETERMINATE"
            : status === "deployed"
              ? "EVE_RUNTIME_IMAGE_CLEANUP_FAILED"
              : "EVE_DEPLOYMENT_FAILED",
          message:
            status === "indeterminate"
              ? "The Eve deployment outcome is indeterminate; inspect the retained exact ownership evidence before retrying."
              : status === "deployed"
                ? "The Eve deployment is healthy and promoted, but exact local runtime-image cleanup failed; do not retry the deployment."
              : "The Eve deployment failed before exact target promotion.",
        });
      }
    }
  } catch (error: unknown) {
    failed = true;
    primaryError = error;
  } finally {
    collected?.runtimeConfig?.dispose();
    lockReleased = lock === undefined || await releaseEveTargetLock(lock);
  }
  if (!lockReleased) {
    throw new EveCliError({
      code: "EVE_DEPLOY_LOCK_RELEASE_UNPROVEN",
      message:
        "The Eve deployment lock could not be released with exact ownership proof; local residue was retained.",
      source: "deployment-lock",
    });
  }
  if (failed) {
    throw primaryError;
  }
}

export interface EveDestroyOutcome {
  readonly ok: boolean;
  readonly status: "destroyed" | "absent" | "failed" | "indeterminate";
  readonly environment: EveCliEnvironment;
  readonly name: string;
  readonly checks: readonly EvePreflightCheck[];
}

interface EveDestroyRecord {
  readonly identity: {
    readonly workerName?: unknown;
    readonly containerApplicationName?: unknown;
    readonly stableContainerInstanceName?: unknown;
    readonly accountId?: unknown;
    readonly environment?: unknown;
    readonly name?: unknown;
  };
}

type VerifiedEveDestroyIdentity = {
  readonly workerName: string;
  readonly containerApplicationName: string;
  readonly stableContainerInstanceName: string;
  readonly accountId: string;
  readonly environment: string;
  readonly name: string;
};

async function readEveDestroyRecord(
  projectRoot: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<
  | {
    readonly recordPath: string;
    readonly generationRoot: string;
    readonly identity: VerifiedEveDestroyIdentity;
  }
  | undefined
> {
  const targetsRoot = join(
    projectRoot,
    ".eden",
    "eve-deploy",
    "targets",
    `${environment}-${name}`,
  );
  const current = await lstat(join(targetsRoot, "CURRENT")).catch(
    () => undefined,
  );
  if (current === undefined || !current.isSymbolicLink()) {
    return readEveDestroyRecordFromGenerations(
      projectRoot,
      environment,
      name,
    );
  }
  const generationRoot = await realpath(join(targetsRoot, "CURRENT")).catch(
    () => undefined,
  );
  if (generationRoot === undefined) {
    return readEveDestroyRecordFromGenerations(
      projectRoot,
      environment,
      name,
    );
  }
  const parsed = await parseEveDestroyRecord(
    join(generationRoot, "deployment.json"),
    environment,
    name,
  );
  return parsed === undefined
    ? undefined
    : { ...parsed, generationRoot };
}

async function readEveDestroyRecordFromGenerations(
  projectRoot: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<
  | {
    readonly recordPath: string;
    readonly generationRoot: string;
    readonly identity: VerifiedEveDestroyIdentity;
  }
  | undefined
> {
  const generationsRoot = join(
    projectRoot,
    ".eden",
    "eve-deploy",
    "generations",
  );
  const entries = await readdir(generationsRoot).catch(() => []);
  const withRecords: {
    readonly generationRoot: string;
    readonly modifiedAt: number;
  }[] = [];
  for (const entry of entries) {
    const generationRoot = join(generationsRoot, entry);
    const details = await lstat(generationRoot).catch(() => undefined);
    if (details === undefined || !details.isDirectory()) continue;
    const recordDetails = await lstat(
      join(generationRoot, "deployment.json"),
    ).catch(() => undefined);
    if (recordDetails !== undefined && recordDetails.isFile()) {
      withRecords.push({
        generationRoot,
        modifiedAt: recordDetails.mtimeMs,
      });
    }
  }
  withRecords.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const { generationRoot } of withRecords) {
    const parsed = await parseEveDestroyRecord(
      join(generationRoot, "deployment.json"),
      environment,
      name,
    );
    if (parsed !== undefined) {
      return { ...parsed, generationRoot };
    }
  }
  return undefined;
}

async function parseEveDestroyRecord(
  recordPath: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<{
  readonly recordPath: string;
  readonly identity: VerifiedEveDestroyIdentity;
} | undefined> {
  let raw: string;
  try {
    raw = await readFile(recordPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as EveDestroyRecord & { readonly status?: unknown };
  if (record.status !== undefined && typeof record.status !== "string") {
    return undefined;
  }
  const identity = record.identity ?? {};
  const required = [
    "workerName",
    "containerApplicationName",
    "stableContainerInstanceName",
    "accountId",
    "environment",
    "name",
  ] as const;
  for (const key of required) {
    if (typeof identity[key] !== "string" || identity[key].length === 0) {
      return undefined;
    }
  }
  if (identity.environment !== environment || identity.name !== name) {
    return undefined;
  }
  return {
    recordPath,
    identity: identity as VerifiedEveDestroyIdentity,
  };
}

async function defaultDestroyTargetRead(
  request: EveDestroyCloudflareReadRequest,
): Promise<EveDestroyTargetRead> {
  const account = await readWranglerJson(["whoami", "--json"]);
  const deployments = await readWranglerJson([
    "deployments",
    "list",
    "--name",
    request.workerName,
    "--json",
  ]);
  const containers = await readWranglerJson([
    "containers",
    "list",
    "--json",
    "--per-page",
    "100",
  ]);
  const accountId = authenticatedAccountId(account.value);
  const workerExists = !deployments.failed &&
    (exactDeploymentEntries(deployments.value)?.length ?? 0) > 0;
  const entries = exactContainerEntries(
    containers.value,
    request.containerApplicationName,
  );
  const firstContainer = entries === undefined ? undefined : entries[0];
  return {
    workerExists,
    ...(firstContainer === undefined
      ? {}
      : { containerApplicationId: firstContainer.id }),
    ...(accountId === undefined ? {} : { accountId }),
  };
}

async function defaultWorkerDelete(
  request: { readonly name: string },
): Promise<"deleted" | "absent" | "indeterminate"> {
  const result = await runWranglerWithInput(
    ["delete", "--name", request.name, "--force"],
    process.cwd(),
    "y\n",
  );
  if (result.exitCode === 0) return "deleted";
  if (/(?:does not exist|not found|10007)/iu.test(result.stderr)) {
    return "absent";
  }
  return "indeterminate";
}

async function defaultContainerDelete(
  request: { readonly applicationId: string },
): Promise<"deleted" | "absent" | "indeterminate"> {
  const result = await runWranglerWithInput(
    ["containers", "delete", request.applicationId],
    process.cwd(),
  );
  if (result.exitCode === 0) return "deleted";
  if (/(?:does not exist|not found|not supported|10007)/iu.test(result.stderr)) {
    return "absent";
  }
  return "indeterminate";
}

async function verifyEveAbsence(
  request: EveDestroyCloudflareReadRequest,
  options: EvePreflightOptions,
): Promise<boolean> {
  const reader = options.destroyCloudflareRead ?? defaultDestroyTargetRead;
  const observed = await reader({
    workerName: request.workerName,
    containerApplicationName: request.containerApplicationName,
  });
  return !observed.workerExists &&
    observed.containerApplicationId === undefined;
}

export async function runEveDestroy(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions = {},
): Promise<void> {
  const checks: EvePreflightCheck[] = [];
  const emit = (outcome: EveDestroyOutcome): void => {
    (options.stdout ?? (() => undefined))(
      redactEveRuntimeOutput(JSON.stringify(outcome)),
    );
  };
  const fail = (code: string, message: string): never => {
    throw new EveCliError({ code, message, source: "eve destroy" });
  };

  let lockReleased = false;
  try {
    const lock = await acquireEveTargetLock(
      request.projectRoot,
      request.environment,
      request.name,
    );
    try {
      await runEveDestroyLocked(request, options, checks, emit, fail);
    } finally {
      lockReleased = await releaseEveTargetLock(lock);
    }
  } catch (error: unknown) {
    if (error instanceof EveCliError) throw error;
    if (error instanceof EveRuntimeConfigError) throw error;
    throw new EveCliError({
      code: "EVE_DESTROY_FAILED",
      message: "The eve destroy operation failed.",
      source: "eve destroy",
    });
  }
  if (!lockReleased) {
    fail(
      "EVE_DEPLOY_LOCK_RELEASE_UNPROVEN",
      "The Eve destroy lock could not be released with exact ownership proof; local residue was retained.",
    );
  }
}

async function runEveDestroyLocked(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions,
  checks: EvePreflightCheck[],
  emit: (outcome: EveDestroyOutcome) => void,
  fail: (code: string, message: string) => never,
): Promise<void> {
    const found = await readEveDestroyRecord(
      request.projectRoot,
      request.environment,
      request.name,
    );
    if (found === undefined) {
      fail(
        "EVE_DESTROY_RECORD_UNPROVEN",
        "No immutable deployed record matched the exact target; destroy refuses to guess or broaden cleanup.",
      );
    }
    const record = found as NonNullable<typeof found>;
    const expectedWorker: string = record.identity.workerName;
    const expectedContainer: string = record.identity.containerApplicationName;
    if (
      expectedWorker !== request.name ||
      typeof record.identity.accountId !== "string"
    ) {
      fail(
        "EVE_DESTROY_RECORD_MISMATCH",
        "The immutable deployment record does not match the selected target.",
      );
    }
    checks.push(
      check(
        "VAL-LIFE-006-RECORD",
        "passed",
        "The immutable deployment record matched the exact target selectors.",
      ),
    );

    const reader = options.destroyCloudflareRead ?? defaultDestroyTargetRead;
    const before = await reader({
      workerName: expectedWorker,
      containerApplicationName: expectedContainer,
    });
    if (
      before.accountId !== record.identity.accountId
    ) {
      fail(
        "EVE_DESTROY_OWNERSHIP_UNPROVEN",
        "The authenticated account does not own the recorded deployment account.",
      );
    }
    if (!before.workerExists && before.containerApplicationId === undefined) {
      emit({
        ok: true,
        status: "absent",
        environment: request.environment,
        name: request.name,
        checks: [
          ...checks,
          check(
            "VAL-LIFE-006",
            "passed",
            "The exact target is already absent; destroy is idempotent without touching siblings.",
          ),
        ],
      });
      return;
    }

    const deleteWorker = options.deleteWorker ?? defaultWorkerDelete;
    if (before.workerExists) {
      const workerResult = await deleteWorker({ name: expectedWorker });
      if (workerResult === "indeterminate") {
        emit({
          ok: false,
          status: "indeterminate",
          environment: request.environment,
          name: request.name,
          checks: [
            ...checks,
            check(
              "VAL-LIFE-006",
              "failed",
              "The exact Worker deletion did not complete with a terminal result; no broad cleanup was attempted.",
              "Inspect the retained deployment record and Cloudflare inventory, then retry the exact target.",
            ),
          ],
        });
        fail("EVE_DESTROY_INDETERMINATE", "The Worker deletion outcome was indeterminate.");
      }
      checks.push(
        check(
          "VAL-LIFE-006-WORKER",
          "passed",
          workerResult === "deleted"
            ? "The exact owned Worker was deleted."
            : "The exact Worker was already absent.",
        ),
      );
    }

    const deleteContainer = options.deleteContainer ?? defaultContainerDelete;
    if (before.containerApplicationId !== undefined) {
      const containerResult = await deleteContainer({
        applicationId: before.containerApplicationId,
      });
      if (containerResult === "indeterminate") {
        emit({
          ok: false,
          status: "indeterminate",
          environment: request.environment,
          name: request.name,
          checks: [
            ...checks,
            check(
              "VAL-LIFE-006",
              "failed",
              "The exact Container application deletion did not complete with a terminal result; no broad cleanup was attempted.",
              "Inspect the retained deployment record and Cloudflare inventory, then retry the exact target.",
            ),
          ],
        });
        fail(
          "EVE_DESTROY_INDETERMINATE",
          "The Container deletion outcome was indeterminate.",
        );
      }
      checks.push(
        check(
          "VAL-LIFE-006-CONTAINER",
          "passed",
          containerResult === "deleted"
            ? "The exact owned Container application was deleted."
            : "The exact Container application was already absent.",
        ),
      );
    }

    const absent = await verifyEveAbsence(
      {
        workerName: expectedWorker,
        containerApplicationName: expectedContainer,
      },
      options,
    );
    if (!absent) {
      emit({
        ok: false,
        status: "failed",
        environment: request.environment,
        name: request.name,
        checks: [
          ...checks,
          check(
            "VAL-LIFE-006",
            "failed",
            "Bounded absence verification failed; CURRENT remains unchanged and no broad delete was attempted.",
            "Inspect the exact target inventory, then retry destroy after the provider state settles.",
          ),
        ],
      });
      fail(
        "EVE_DESTROY_ABSENCE_UNPROVEN",
        "The exact target could not be proven absent after deletion.",
      );
    }
    checks.push(
      check(
        "VAL-LIFE-006",
        "passed",
        "Exact absence was verified; clearing this target's CURRENT pointer only.",
      ),
    );

    const currentPath = join(
      request.projectRoot,
      ".eden",
      "eve-deploy",
      "targets",
      `${request.environment}-${request.name}`,
      "CURRENT",
    );
    await rm(currentPath, { force: true });
    const gone = await lstat(currentPath).catch(() => undefined);
    if (gone !== undefined) {
      fail(
        "EVE_DESTROY_POINTER_UNCLEARED",
        "The target CURRENT pointer could not be cleared after verified absence.",
      );
    }
    emit({
      ok: true,
      status: "destroyed",
      environment: request.environment,
      name: request.name,
      checks,
    });
}

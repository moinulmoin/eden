import { setTimeout as waitForActivation } from "node:timers/promises";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
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
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  homedir,
  tmpdir,
} from "node:os";
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
  EVE_NAME_PATTERN,
  type EveCliEnvironment,
  type EveCliExecutionRequest,
} from "./eve.js";
import {
  buildEveProjectSnapshot,
  checkEveSandboxProvider,
  checkEveVersion,
  createDockerEveProjectBuilder,
  parseEveRelease,
  revalidateEveProjectCandidateInputs,
  EvePackagingError,
  IMAGE_ID_PATTERN,
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
import {
  EDEN_AFFINITY_CONTRACT,
  callDeploymentControlRpc,
  createEveHostConfig,
  generateEveHostWorkerSource,
  parseEveScheduleCron,
  resolveStableWorkersDevOrigin,
  type EveDurableBinding,
  type EveDurableMigration,
  type EveHostConfig,
  type EveScheduleCronEntry,
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

export const DEFAULT_EVE_NODE_IMAGE: EveNodeImage = Object.freeze({
  reference: "node:24.17.0-bookworm-slim",
  digest: "sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532",
});

/** The single tag Eden pushes to the managed Cloudflare registry per generation. */
const EVE_REGISTRY_IMAGE_TAG = "candidate";


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
  readonly reason?: string;
  readonly evidenceLocation?: string;
  /**
   * `create` is a first deploy onto an absent target; `update` is an
   * in-place redeploy of a provably Eden-owned target that keeps the Worker,
   * Durable Object classes, and durable state.
   */
  readonly operation: "create" | "update";
  readonly targetKey: string;
  readonly deploymentId: string;
  readonly workerName: string;
  readonly containerApplicationName: string;
  readonly stableContainerInstanceName: string;
  readonly stableWorkersDevOrigin: string;
  readonly imageReference: string;
  /** Present on updates: the superseded generation and its registry image. */
  readonly supersededGenerationId?: string;
  readonly supersededImageReference?: string;
  readonly runtimeVariableNames: readonly string[];
  readonly evidenceRetained: true;
}
export interface EvePreflightWarning {
  readonly id: string;
  readonly message: string;
  readonly remediation?: string;
}

interface EveOutcomeError {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly source: string;
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly source?: string }[];
}

/**
 * A failed retirement stays in the promoted record as pending. A later
 * healthy deploy runs it again, unless that deploy makes the pending version
 * current. A deploy publishes a new image, so none is worth making for the
 * cleanup alone.
 */
const RETIREMENT_PENDING_REMEDIATION =
  "Do not redeploy for this. The deployment is live. A later successful deploy retries cleanup for versions still pending retirement. Some retired resources may remain.";

function eveOutcomeError(error: unknown, source: string): EveOutcomeError {
  const failure = error instanceof EveCliError ? error : new EveCliError({
    code: error instanceof EveRuntimeConfigError ? error.code : "EVE_EXECUTION_FAILED",
    message: error instanceof Error ? error.message : "The Eve operation failed.",
    source: error instanceof EveRuntimeConfigError ? error.source ?? source : source,
    ...(error instanceof EveRuntimeConfigError
      ? { remediation: error.remediation }
      : {}),
  });
  return {
    code: failure.code,
    message: safeText(failure.message),
    remediation: failure.remediation,
    source: failure.source ?? source,
    diagnostics: failure.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: safeText(diagnostic.message),
    })),
  };
}

export interface EvePreflightResult {
  readonly command: "eden preflight" | "eden deploy";
  readonly ok: boolean;
  readonly environment: EveCliEnvironment;
  readonly name: string;
  readonly checks: readonly EvePreflightCheck[];
  readonly warnings: readonly EvePreflightWarning[];
  /** On deploy, with `EVE_REGISTRY_OBJECTS_KEPT`: what Cloudflare's registry still lists after Eden's delete. */
  readonly registryObjectsKept?: readonly EveRegistryObjectKept[];
  readonly candidate: EvePreflightCandidate | null;
  readonly deployment?: EveDeploymentMetadata | (
    Partial<EveDeploymentMetadata> & {
      readonly status: "indeterminate";
      readonly reason: string;
      readonly evidenceRetained: true;
      readonly evidenceLocation: string;
    }
  );
  readonly error?: EveOutcomeError;
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
  readonly projectRoot: string;
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
    /**
     * Which exact resources the read observed. `undefined` means the
     * inventory could not be proven; `worker`/`container` booleans mean the
     * exact names were present or absent without any ownership claim.
     */
    readonly observed?: {
      readonly worker: boolean;
      readonly container: boolean;
    };
    /**
     * Provider-backed facts about the live target, read through the
     * Cloudflare API (not self-asserted response headers, which any Worker
     * can forge): the Container application's Durable Object namespace and
     * the `EDEN_EVE_DEPLOYMENT_ID` and `EDEN_EVE_RELEASE_ID` plain-text vars
     * Eden stamps into every Worker it publishes. `settingsReadable` tells
     * the ownership resolver whether a missing var is evidence of a foreign
     * Worker or just an unreadable settings call.
     */
    readonly providerEvidence?: {
      readonly containerApplicationId?: string;
      readonly containerSchedulingPolicy?: string;
      readonly containerNamespaceId?: string;
      readonly workerDeploymentId?: string;
      readonly workerReleaseId?: string;
      readonly workerContainerNamespaceId?: string;
      readonly settingsReadable?: boolean;
    };
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
  readonly hostRequirements: EveHostRequirements;
  readonly publicOrigin?: string;
  readonly runtimeInjection?: EveRuntimeInjection;
  readonly retainImage?: boolean;
  readonly workflowWorld?: string;
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
  readonly releaseId?: string;
  readonly eveVersion?: string;
  readonly affinityContract?: number;
  readonly retainedDeployments?: Readonly<Record<string, EveAffinityDeployment>>;
  readonly pendingRetirements?: Readonly<Record<string, EveAffinityDeployment>>;
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

export type EveDeploymentIdentityProof = Partial<EveDeploymentIdentity> & {
  /** The deployment the serving Container verifiably started under; set only by a deployed Eden host that proves its running image before stamping. */
  readonly startedDeploymentId?: string;
};

export interface EveAffinityDeployment {
  readonly image: string;
  readonly generationId: string;
  readonly runtimeRevisionHandle?: string;
  readonly eveVersion?: string;
  readonly affinityContract?: number;
  readonly releaseId?: string;
  readonly worldRpcAuth?: boolean;
}

export interface EveDeploymentDrainState {
  readonly liveRuns: number;
  readonly liveSessions: number;
  readonly pendingMessages: number;
  readonly unfinishedTransfers: number;
  readonly drained: boolean;
}

export type EveDeploymentRpcRunner = (request: {
  readonly origin: string;
  readonly operation: "deployments.drainState" | "deployments.retire";
  readonly deploymentIds: readonly string[];
  readonly controlToken: string;
}) => Promise<unknown>;

function validateDeploymentDrainStates(
  value: unknown,
  ids: readonly string[],
): Record<string, EveDeploymentDrainState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw deploymentFailure("EVE_AFFINITY_DRAIN_UNPROVEN", "The authenticated World did not return deployment drain states.");
  }
  const states = value as Record<string, EveDeploymentDrainState>;
  for (const id of ids) {
    const state = states[id];
    if (typeof state !== "object" || state === null ||
        typeof state.drained !== "boolean" ||
        [state.liveRuns, state.liveSessions, state.pendingMessages, state.unfinishedTransfers]
          .some((count) => !Number.isSafeInteger(count) || count < 0) ||
        state.drained !== (state.liveRuns + state.liveSessions + state.pendingMessages + state.unfinishedTransfers === 0)) {
      throw deploymentFailure("EVE_AFFINITY_DRAIN_UNPROVEN", `The authenticated World returned an invalid drain state for ${id}.`);
    }
  }
  return states;
}

const defaultDeploymentRpc: EveDeploymentRpcRunner = async (request) => {
  // A successful Cloudflare secret write creates an active deployment, but
  // existing stateless Worker isolates may briefly serve the preceding secret.
  // Only the first read-only drain call following our own rotation may wait
  // for that exact in-memory credential. All other failures remain terminal.
  const activationRead = request.operation === "deployments.drainState";
  const deadline = Date.now() + 60_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw deploymentFailure("EVE_AFFINITY_CONTROL_ACTIVATION_TIMEOUT",
        "The freshly rotated deployment-control credential did not activate within 60 seconds; publication was refused.");
    }
    try {
      return await callDeploymentControlRpc({
        origin: request.origin,
        token: request.controlToken,
        operation: request.operation,
        args: [{ deploymentIds: request.deploymentIds }],
        signal: AbortSignal.timeout(remaining),
      });
    } catch (error: unknown) {
      if (!activationRead || typeof error !== "object" || error === null ||
          !("status" in error) || error.status !== 401) throw error;
      const delay = Math.min(1_000, deadline - Date.now());
      if (delay > 0) await waitForActivation(delay);
    }
  }
};

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
    /** Wrangler uploaded the Worker version, then failed at the Container application settings. */
    readonly containerSettingsUnapplied?: true;
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
  /**
   * The name of the generation directory to create under
   * .eden/eve-deploy/generations, the only place deploy and destroy keep
   * records. A random one when omitted.
   */
  readonly generationId?: string;
  readonly hostRequirements?:
    | EveHostRequirements
    | ((
      candidate: EveProjectBuildCandidate,
    ) => EveHostRequirements | Promise<EveHostRequirements>);
  /**
   * The default runtime runner passes env-file values only through the
   * deployment-safety protected local injection seam; callers may supply one.
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
  readonly deploymentRpc?: EveDeploymentRpcRunner;
  readonly compensate?: EveDeploymentCompensationRunner;
  readonly health?: EveDeploymentHealthRunner;
  readonly afterPromotion?: () => void | Promise<void>;
  readonly discardRuntimeImage?: EveRuntimeImageDiscardRunner;
  readonly retainRuntimeImage?: boolean;
  readonly stdout?: (line: string) => void;
  /**
   * "human" prints short progress lines and a summary; "json" prints only the
   * machine-readable result object. Programmatic callers default to "json";
   * the CLI passes "human" unless --json was supplied.
   */
  readonly outputFormat?: "human" | "json";
  /**
   * Destroy seams. Defaults use the immutable local deployment record,
   * Wrangler, and direct registry requests; tests may inject exact fakes.
   */
  readonly destroyCloudflareRead?: EveDestroyCloudflareReadRunner;
  readonly deleteWorker?: EveWorkerDeleteRunner;
  readonly deleteContainer?: EveContainerDeleteRunner;
  readonly deleteRegistryRepository?: EveRegistryRepositoryDeleteRunner;
}

export interface EveDestroyTargetRead {
  readonly workerExists: boolean;
  readonly inventoryComplete?: boolean;
  readonly providerEvidence?: EveCloudflareReadResult["target"]["providerEvidence"];
  readonly containerApplicationId?: string;
  readonly accountId?: string;
  /**
   * Every ref the managed registry itself lists for the request's owned
   * repositories: `repository:tag` for a tag, including the
   * `rootfs-snapshot-*`/`rootfs-set-*` tags container snapshots create, and
   * `repository@sha256:…` for each manifest's own entry. `undefined` means
   * the reader could not read the listing in full; destroy then fails, because
   * no delete outcome proves that nothing is left.
   */
  readonly registryTagsPresent?: readonly string[];
}

export type EveDestroyCloudflareReadRunner = (
  request: EveDestroyCloudflareReadRequest,
) => EveDestroyTargetRead | Promise<EveDestroyTargetRead>;

export type EveWorkerDeleteRunner = (
  request: { readonly name: string; readonly accountId: string },
) => "deleted" | "absent" | "indeterminate" | Promise<
  "deleted" | "absent" | "indeterminate"
>;

export type EveContainerDeleteRunner = (
  request: { readonly applicationId: string; readonly accountId: string },
) => "deleted" | "absent" | "indeterminate" | Promise<
  "deleted" | "absent" | "indeterminate"
>;

/**
 * One object Cloudflare's registry still lists after Eden's delete, with the
 * registry's own answer for that object.
 */
export interface EveRegistryObjectKept {
  /** `repository:tag`, or `repository@sha256:…` for a manifest's own entry. */
  readonly ref: string;
  /**
   * `refused-snapshot`: the registry refused the delete because the object is
   * a container snapshot. `refused-singleton-artifact`: it refused with
   * `SINGLETON_ARTIFACT_EXISTS`. `accepted-still-listed`: it accepted the
   * delete and still listed the object after the wait.
   */
  readonly class: "refused-snapshot" | "refused-singleton-artifact" | "accepted-still-listed";
}

/**
 * The object form: each `kept` object is still listed, with the registry's
 * own answer for it. Everything else is gone, unless `unproven` is set: then
 * the runner could not show that.
 */
export type EveRegistryRepositoryDeleteOutcome =
  | "deleted"
  | "absent"
  | "indeterminate"
  | { readonly kept: readonly EveRegistryObjectKept[]; readonly unproven?: true };

export type EveRegistryRepositoryDeleteRunner = (
  request: { readonly repository: string; readonly accountId: string },
) => EveRegistryRepositoryDeleteOutcome | Promise<EveRegistryRepositoryDeleteOutcome>;


export type EveRuntimeConfigLoader = (
  path: string,
  cwd: string,
) => EveRuntimeConfig | Promise<EveRuntimeConfig>;

export interface EveDestroyCloudflareReadRequest {
  /** The account the deployment record names; nothing is read from any other. */
  readonly accountId: string;
  readonly workerName: string;
  readonly containerApplicationName: string;
  /** Registry repository names this target provably owns. */
  readonly registryRepositories?: readonly string[];
}

interface EvePreflightCollection {
  readonly result: EvePreflightResult;
  readonly runtimeConfig: EveRuntimeConfig | undefined;
  readonly candidate?: EveProjectBuildCandidate;
  readonly projectId?: string;
  readonly runtimeEvidence?: EvePreflightRuntimeEvidence;
  readonly cloudflare?: EveCloudflareReadResult;
  /** The immutable record of the live deployment, present when the exact target is provably Eden-owned. */
  readonly priorDeployment?: EveDeploymentRecord;
  readonly schedules?: readonly EveScheduleCronEntry[];
  readonly workflowWorld?: string;
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
      case "EVE_SANDBOX_PROVIDER":
        return value.id;
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

/**
 * Path, inside the built snapshot, of the manifest `eve build` writes with the
 * resolved agent configuration. `config.experimental.workflow.world` is the
 * field Eve itself resolves at build time; absent/`local`/
 * `@workflow/world-local` mean Eve's container-local default World.
 */
const EVE_COMPILED_MANIFEST_PATH =
  ".output/.eve/compile/compiled-agent-manifest.json";

async function readCompiledWorldSpecifier(
  candidate: EveProjectBuildCandidate,
): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await readFile(
        join(candidate.snapshotRoot, EVE_COMPILED_MANIFEST_PATH),
        "utf8",
      ),
    ) as unknown;
    const world = (
      manifest as {
        readonly config?: {
          readonly experimental?: {
            readonly workflow?: { readonly world?: unknown };
          };
        };
      } | null
    )?.config?.experimental?.workflow?.world;
    return typeof world === "string" ? world : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads authored schedules out of the compiled manifest `eve build` writes.
 * Root `schedules` covers file and extension-mounted schedules; declared
 * subagents cannot carry schedules, so only the root array is consulted.
 */
async function readCompiledSchedules(
  candidate: EveProjectBuildCandidate,
): Promise<readonly EveScheduleCronEntry[]> {
  try {
    const manifest = JSON.parse(
      await readFile(
        join(candidate.snapshotRoot, EVE_COMPILED_MANIFEST_PATH),
        "utf8",
      ),
    ) as unknown;
    const schedules = (
      manifest as {
        readonly schedules?: readonly {
          readonly name?: unknown;
          readonly cron?: unknown;
        }[];
      } | null
    )?.schedules;
    if (!Array.isArray(schedules)) return [];
    return schedules.flatMap((schedule) =>
      typeof schedule.name === "string" && typeof schedule.cron === "string"
        ? [{ name: schedule.name, cron: schedule.cron }]
        : []);
  } catch {
    return [];
  }
}

/**
 * Mirrors Eve's own `assertWorkflowWorldCompatibility`
 * (dist/src/internal/workflow/world-compatibility.js): Eve derives the
 * expected Workflow line from its installed manifest's `@workflow/core`
 * dependency, reads the selected World's manifest for a `@workflow/core` or
 * `@workflow/world` dependency, and fails only on a definite line mismatch —
 * different major, or both prerelease tags present and different.
 */
function parseWorkflowVersionLine(
  range: string,
): { readonly major: number; readonly prereleaseTag?: string } | undefined {
  const match =
    /(\d+)\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/u.exec(
      range.trim(),
    );
  if (match === null) return undefined;
  const major = Number(match[1]);
  if (!Number.isInteger(major)) return undefined;
  return {
    major,
    ...(match[2] === undefined
      ? {}
      : { prereleaseTag: match[2].split(".")[0] }),
  };
}

async function readInstalledManifest(
  snapshotRoot: string,
  packageName: string,
): Promise<
  | {
    readonly version?: string;
    readonly eden?: { readonly capabilities?: { readonly deploymentAffinity?: boolean; readonly worldRpcAuth?: boolean; readonly atomicStartHook?: boolean } };
    readonly devDependencies?: Readonly<Record<string, string>>;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
  }
  | undefined
> {
  try {
    return JSON.parse(
      await readFile(
        join(snapshotRoot, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    ) as {
      readonly version?: string;
      readonly eden?: { readonly capabilities?: { readonly deploymentAffinity?: boolean; readonly worldRpcAuth?: boolean; readonly atomicStartHook?: boolean } };
      readonly devDependencies?: Readonly<Record<string, string>>;
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly peerDependencies?: Readonly<Record<string, string>>;
    };
  } catch {
    return undefined;
  }
}

/**
 * Eve `1.0.0-rc.6` and later refuse to start a session unless the World
 * admits start Hooks atomically; earlier prereleases of 1.0.0 do not ask.
 */
function eveRequiresAtomicStartHook(version: unknown): boolean {
  const release = parseEveRelease(version);
  if (release === null) return false;
  const [major, minor, patch, prerelease] = release;
  if (major !== 1 || minor !== 0 || patch !== 0) return major >= 1;
  if (prerelease === undefined) return true;
  const rc = /^rc\.(\d+)$/u.exec(prerelease);
  return rc !== null && Number(rc[1]) >= 6;
}

/**
 * The Cloudflare World declares the capability in its manifest. The Postgres
 * World needs 5.1.1 or later, as Eve's own error says: 5.1.0 admits
 * `start({ hook })`, but Eve passes `experimental_hook`. An unreadable
 * version is left to Eve, the runtime authority.
 */
function worldAdmitsAtomicStartHook(
  world: string,
  manifest: { readonly version?: string; readonly eden?: { readonly capabilities?: { readonly atomicStartHook?: boolean } } },
): boolean {
  if (world === "@moinulmoin/eden-world-cloudflare") {
    return manifest.eden?.capabilities?.atomicStartHook === true;
  }
  const match = typeof manifest.version === "string"
    ? /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/u.exec(manifest.version)
    : null;
  if (match === null) return true;
  const order = Number(match[1]) - 5 || Number(match[2]) - 1 || Number(match[3]) - 1;
  return order > 0 || (order === 0 && match[4] === undefined);
}

/**
 * Fails deploy/preflight when a known durable World would trip Eve's runtime
 * World-compatibility rejection. Unreadable manifests
 * mirror Eve's own behavior (skip); Eve is the runtime authority.
 */
async function checkEveWorldPairing(
  candidate: EveProjectBuildCandidate,
  world: string | undefined,
): Promise<EvePreflightCheck | undefined> {
  if (world !== "@workflow/world-postgres" &&
      world !== "@moinulmoin/eden-world-cloudflare") return undefined;
  const eveManifest = await readInstalledManifest(
    candidate.snapshotRoot,
    "eve",
  );
  const worldManifest = await readInstalledManifest(
    candidate.snapshotRoot,
    world,
  );
  if (
    world === "@moinulmoin/eden-world-cloudflare" &&
    worldManifest?.eden?.capabilities?.worldRpcAuth !== true
  ) {
    return check(
      "EVE_WORLD_PAIRING",
      "failed",
      "The installed Cloudflare World lets the agent's sandbox read and change every session's workflow state.",
      "Install @moinulmoin/eden-world-cloudflare@0.11.2 or later; see docs/troubleshooting.md.",
    );
  }
  if (
    worldManifest !== undefined &&
    eveRequiresAtomicStartHook(eveManifest?.version) &&
    !worldAdmitsAtomicStartHook(world, worldManifest)
  ) {
    const minimum = world === "@workflow/world-postgres" ? "5.1.1" : "0.11.2";
    return check(
      "EVE_WORLD_PAIRING",
      "failed",
      `Eve ${eveManifest?.version} needs a World with atomic start hooks, and the installed ${world} ${worldManifest.version ?? "(unknown version)"} does not have them; every new session would fail with HTTP 500.`,
      `Install ${world}@${minimum} or later; see docs/troubleshooting.md.`,
    );
  }
  const expectedRange = eveManifest === undefined
    ? undefined
    : [
      eveManifest.devDependencies,
      eveManifest.dependencies,
      eveManifest.peerDependencies,
    ]
      .map((deps) => deps?.["@workflow/core"])
      .find((value): value is string =>
        typeof value === "string" && value.trim().length > 0
      );
  if (expectedRange === undefined) return undefined;
  const declared = worldManifest === undefined
    ? undefined
    : ["@workflow/core", "@workflow/world"]
      .map(
        (name) => ({
          packageName: name,
          range: worldManifest.dependencies?.[name] ??
            worldManifest.peerDependencies?.[name],
        }),
      )
      .find(
        (entry): entry is { packageName: string; range: string } =>
          typeof entry.range === "string" && entry.range.trim().length > 0,
      );
  if (declared === undefined) return undefined;
  const declaredLine = parseWorkflowVersionLine(declared.range);
  const expectedLine = parseWorkflowVersionLine(expectedRange);
  if (declaredLine === undefined || expectedLine === undefined) {
    return undefined;
  }
  const mismatch = declaredLine.major !== expectedLine.major ||
    (declaredLine.prereleaseTag !== undefined &&
      expectedLine.prereleaseTag !== undefined &&
      declaredLine.prereleaseTag !== expectedLine.prereleaseTag);
  if (mismatch) {
    return check(
      "EVE_WORLD_PAIRING",
      "failed",
      `The installed ${world} targets ${declared.packageName} ${declared.range}, but the project's Eve bundles @workflow/core ${expectedRange}; Eve rejects this World at runtime.`,
      `Install the ${world} release whose ${declared.packageName} dependency matches the Eve-bundled @workflow/core ${expectedRange} line; see docs/deploy.md.`,
    );
  }
  return check(
    "EVE_WORLD_PAIRING",
    "passed",
    `The installed ${world} ${declared.packageName} dependency ${declared.range} pairs with the Eve-bundled @workflow/core ${expectedRange}.`,
  );
}

/**
 * Returns a generic reason when the URL targets a transaction-mode pooler.
 * Never returns URL content; only a safe classification of the host/port.
 */
function pooledPostgresReason(
  connectionString: string | undefined,
): string | undefined {
  if (connectionString === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }
  if (url.hostname.includes("-pooler")) {
    return "a transaction-mode pooler host";
  }
  if (url.port === "6543") {
    return "a transaction-mode pooler port";
  }
  return undefined;
}

const EVE_WORLD_LOCAL_REMEDIATION =
  'For durable state without a database, add @moinulmoin/eden-world-cloudflare and set experimental: { workflow: { world: "@moinulmoin/eden-world-cloudflare" } } in agent.ts; sessions survive Eve upgrades. Alternatively, add @workflow/world-postgres, select it as the workflow world, and put WORKFLOW_POSTGRES_URL with a direct, unpooled Postgres URL in --env-file.';

/** Static, dynamic, side-effect, or require imports of @vercel/connect or a subpath. */
function importsVercelConnect(source: string): boolean {
  return /\b(?:from|import|require)\s*\(?\s*["']@vercel\/connect(?:\/[^"']*)?["']/u
    .test(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, ""));
}

async function vercelConnectSourcePaths(projectRoot: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(join(projectRoot, path), { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) {
        const source = await readFile(join(projectRoot, child), "utf8").catch(() => "");
        if (importsVercelConnect(source)) paths.push(child);
      }
    }
  };
  await visit("agent");
  await visit("agents");
  return paths.sort();
}

function eveGatewayKeyWarning(source: string): EvePreflightWarning {
  return {
    id: "EVE_AI_GATEWAY_KEY_MISSING",
    message: `The model in ${source} routes through Vercel AI Gateway, but --env-file has no non-blank AI_GATEWAY_API_KEY. Cloudflare has no Vercel OIDC project identity, so model calls fail.`,
    remediation: 'Add AI_GATEWAY_API_KEY from https://vercel.com/dashboard/ai/api-keys to your --env-file, or use a direct provider such as openai("gpt-5") from @ai-sdk/openai with OPENAI_API_KEY in that file.',
  };
}

function gatewayKeySupplied(runtimeConfig: EveRuntimeConfig | undefined): boolean {
  return runtimeConfig?.withProtectedValues((values) =>
    (values.AI_GATEWAY_API_KEY?.trim().length ?? 0) > 0) === true;
}

/** Eve persists its compile-time routing decision, including its default model. */
async function collectEveGatewayWarnings(
  candidate: EveProjectBuildCandidate,
  runtimeConfig: EveRuntimeConfig | undefined,
): Promise<EvePreflightWarning[]> {
  if (gatewayKeySupplied(runtimeConfig)) return [];
  try {
    const manifest = JSON.parse(await readFile(
      join(candidate.snapshotRoot, EVE_COMPILED_MANIFEST_PATH), "utf8",
    )) as {
      config?: {
        model?: { routing?: { kind?: unknown } };
        source?: { logicalPath?: unknown };
      };
    } | null;
    if (manifest?.config?.model?.routing?.kind !== "gateway") return [];
    const source = typeof manifest.config.source?.logicalPath === "string"
      ? manifest.config.source.logicalPath
      : "agent/agent.ts";
    return [eveGatewayKeyWarning(source)];
  } catch {
    // Unknown or older compiled formats are not evidence of Gateway routing.
    return [];
  }
}

/**
 * Recognizes the generated channel, not arbitrary user authentication policies.
 * The calls below match the Eve 0.82 initializer's agent/channels/eve.ts.
 */
async function collectEveSetupWarnings(
  projectRoot: string,
  gatewayKeyMissing: boolean,
): Promise<EvePreflightWarning[]> {
  const warnings: EvePreflightWarning[] = [];
  const source = async (path: string): Promise<string> => {
    try {
      return await readFile(join(projectRoot, path), "utf8");
    } catch {
      return "";
    }
  };
  const connectPaths = await vercelConnectSourcePaths(projectRoot);
  if (connectPaths.length > 0) {
    warnings.push({
      id: "EVE_VERCEL_CONNECT",
      message: `Vercel Connect imports in ${connectPaths.join(", ")} get credentials using a Vercel project identity (OIDC) that only Vercel injects; these connections fail on Cloudflare.`,
      remediation: "Put each service's own API key or bot token in --env-file and replace connect(...) in the connection with auth: { getToken: async () => ({ token: process.env.SERVICE_TOKEN! }) }. For per-user sign-in, use defineInteractiveAuthorization from eve/connections with your own OAuth app.",
    });
  }
  const channel = (await source("agent/channels/eve.ts"))
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "")
    .replace(/\s+/gu, "");
  if (
    /exportdefaulteveChannel\(\{auth:\[vercelOidc\(\),localDev\(\),placeholderAuth\(\),?\],?\}\);?$/u
      .test(channel)
  ) {
    warnings.push({
      id: "EVE_AUTH_SCAFFOLD",
      message: "Eve's generated channel auth does not grant Cloudflare callers access.",
      remediation: "Replace agent/channels/eve.ts auth with your app's authenticator; put credentials in --env-file.",
    });
  }
  try {
    const manifest = JSON.parse(await source("package.json")) as {
      dependencies?: Record<string, unknown>;
      packageManager?: string;
    };
    const agent = await source("agent/agent.ts");
    if (/export\s+default\s+defineAgent\s*\(\s*\{\s*model\s*:\s*["'][^"']+["']\s*,\s*reasoning\s*:\s*["'][^"']+["']\s*,?\s*\}\s*\)/u.test(agent)) {
      warnings.push({
        id: "EVE_WORLD_LOCAL",
        message: "Local World stores memory on container disk; updates or a lost sleep snapshot reset sessions and approvals.",
        remediation: EVE_WORLD_LOCAL_REMEDIATION,
      });
    }
    // A string model routes through AI Gateway; the compiled manifest confirms it after the build.
    if (
      gatewayKeyMissing &&
      /\bmodel\s*:\s*["'`][^"'`]+["'`]/u.test(agent.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, ""))
    ) {
      warnings.push(eveGatewayKeyWarning("agent/agent.ts"));
    }
    if (
      manifest.dependencies?.["just-bash"] === undefined &&
      agent.length > 0 &&
      !/\bsandbox\s*:/u.test(agent)
    ) {
      const command = manifest.packageManager?.startsWith("pnpm@")
        ? "pnpm add just-bash"
        : "npm install just-bash";
      warnings.push({
        id: "EVE_JUST_BASH_MISSING",
        message: "Eve's default sandbox needs the just-bash production dependency in Eden's builder.",
        remediation: `Run ${command}, commit the updated manifest and lockfile, then retry.`,
      });
    }
    if (!manifest.packageManager?.startsWith("pnpm@")) {
      const lockText = await source("package-lock.json");
      // Same trust level as the manifest above: npm wrote it; packaging validates it.
      const lock = JSON.parse(lockText === "" ? "{}" : lockText) as {
        packages?: Record<string, {
          hasInstallScript?: boolean;
          dev?: boolean;
          optional?: boolean;
          devOptional?: boolean;
        }>;
      };
      const entries = lock.packages ?? {};
      const skipped = new Set<string>();
      for (const [path, entry] of Object.entries(entries)) {
        const at = path.lastIndexOf("node_modules/");
        if (
          at !== -1 &&
          entry.hasInstallScript === true &&
          entry.dev !== true &&
          entry.optional !== true &&
          entry.devOptional !== true
        ) {
          skipped.add(path.slice(at + "node_modules/".length));
        }
      }
      if (skipped.size > 0) {
        warnings.push({
          id: "EVE_NPM_INSTALL_SCRIPTS_SKIPPED",
          message: `Eden's npm install skips dependency install scripts; these production dependencies have one and may fail at runtime: ${[...skipped].sort().join(", ")}.`,
          remediation: "Use packages that need no install script, or switch to exact-pinned pnpm and list them under allowBuilds in pnpm-workspace.yaml.",
        });
      }
    }
  } catch {
    // Packaging reports invalid manifests; setup hints must not mask that result.
  }
  return warnings;
}

async function collectEveWorldWarnings(
  candidate: EveProjectBuildCandidate | undefined,
  runtimeConfig: EveRuntimeConfig | undefined,
): Promise<EvePreflightWarning[]> {
  const warnings: EvePreflightWarning[] = [];
  if (candidate !== undefined) {
    const world = await readCompiledWorldSpecifier(candidate);
    if (
      world === undefined ||
      world === "local" ||
      world === "@workflow/world-local"
    ) {
      warnings.push({
        id: "EVE_WORLD_LOCAL",
        message:
          "Local World stores memory on container disk; updates or a lost sleep snapshot reset sessions and approvals.",
        remediation: EVE_WORLD_LOCAL_REMEDIATION,
      });
    }
  }
  if (runtimeConfig !== undefined) {
    const pooledReason = runtimeConfig.withProtectedValues((values) =>
      pooledPostgresReason(
        values.WORKFLOW_POSTGRES_URL ?? values.DATABASE_URL,
      )
    );
    if (pooledReason !== undefined) {
      warnings.push({
        id: "EVE_WORLD_POSTGRES_POOLED",
        message:
          `The configured Postgres connection uses ${pooledReason}; transaction-mode poolers accept LISTEN but never deliver notifications, so live session streaming hangs.`,
        remediation:
          "Use the direct, unpooled Postgres URL for WORKFLOW_POSTGRES_URL (on Neon, the unpooled host without -pooler); see docs/deploy.md#durable-state-postgres-world.",
      });
    }
  }
  return warnings;
}

/** True when the caller asked for the human progress/summary output. */
function humanOutput(options: EvePreflightOptions): boolean {
  return options.outputFormat === "human";
}

function emitLine(options: EvePreflightOptions, line: string): void {
  (options.stdout ?? (() => undefined))(redactEveRuntimeOutput(line));
}

/** Short stage markers so a multi-minute run shows what it is doing. */
function eveProgress(options: EvePreflightOptions, stage: string): void {
  if (humanOutput(options)) emitLine(options, `... ${stage}`);
}


function eveCheckLines(
  checks: readonly EvePreflightCheck[],
): readonly string[] {
  const lines: string[] = [];
  for (const value of checks) {
    const glyph = value.status === "passed"
      ? "✓"
      : value.status === "skipped"
        ? "-"
        : "✗";
    lines.push(`${glyph} ${value.id} — ${value.message}`);
    if (
      (value.status === "failed" || value.status === "blocked") &&
      value.remediation !== undefined
    ) {
      lines.push(`  → ${value.remediation}`);
    }
  }
  return lines;
}

function formatEveElapsed(startedAt: number): string {
  const elapsed = (Date.now() - startedAt) / 1000;
  return `${elapsed.toFixed(elapsed < 10 ? 1 : 0)}s`;
}



/**
 * Human summary lines for a preflight or deploy result: every check with a
 * status glyph, then a compact tail with the outcome.
 */
function humanEveResultLines(
  result: EvePreflightResult,
  startedAt: number,
  eveVersion: string | undefined,
): readonly string[] {
  const lines: string[] = [...eveCheckLines(result.checks)];
  for (const warning of result.warnings) {
    lines.push(`! ${warning.id} — ${safeText(warning.message)}`);
    if (warning.remediation !== undefined) {
      lines.push(`  → ${safeText(warning.remediation)}`);
    }
  }
  for (const object of result.registryObjectsKept ?? []) {
    lines.push(`  kept: ${safeText(object.ref)} (${object.class})`);
  }
  const elapsed = formatEveElapsed(startedAt);
  const commandLabel = result.command === "eden deploy" ? "deploy" : "preflight";
  if (result.ok) {
    if (result.command === "eden deploy") {
      const url = result.deployment?.stableWorkersDevOrigin;
      lines.push(
        "",
        `✓ ${result.deployment?.operation === "update" ? "updated" : "deployed"} ${result.name} (${result.environment})` +
          (eveVersion === undefined ? "" : ` · eve ${eveVersion}`),
      );
      if (url !== undefined) lines.push(url);
      lines.push(`done in ${elapsed}`);
    } else {
      lines.push(
        "",
        `✓ ${result.name} (${result.environment}) — preflight passed in ${elapsed}`,
      );
    }
    return lines;
  }
  const firstFailure = result.checks.find((value) =>
    value.status === "failed" || value.status === "blocked"
  );
  if (result.deployment !== undefined) {
    lines.push(
      "",
      `✗ ${commandLabel} ${result.deployment.status === "deployed" ? "deployed; cleanup failed" : result.deployment.status}`,
      `  → ${result.deployment.status === "indeterminate"
        ? "The outcome is indeterminate; inspect the retained ownership evidence before retrying the same exact target."
        : result.deployment.status === "deployed"
          ? "The deployment is live; cleanup failed, so do not retry the deployment."
          : "The deployment failed before promotion; the exact target was not claimed."
      }`,
    );
  } else if (firstFailure !== undefined) {
    lines.push(
      "",
      `✗ ${commandLabel} failed — first failing check: ${firstFailure.id}`,
    );
  } else {
    lines.push("", `✗ ${commandLabel} failed`);
  }
  lines.push(`stopped after ${elapsed}`);
  return lines;
}

function emitEveResult(
  options: EvePreflightOptions,
  result: EvePreflightResult,
  startedAt: number,
  eveVersion: string | undefined,
): void {
  if (humanOutput(options)) {
    for (const line of humanEveResultLines(result, startedAt, eveVersion)) {
      emitLine(options, line);
    }
    return;
  }
  (options.stdout ?? (() => undefined))(JSON.stringify(result, (_key, value: unknown) =>
    typeof value === "string" ? redactEveRuntimeOutput(value) : value
  ));
}

/**
 * Human summary lines for a destroy outcome: removed resources, anything
 * retained, and the outcome tail.
 */
function humanEveDestroyLines(
  outcome: EveDestroyOutcome,
  startedAt: number,
): readonly string[] {
  const lines = [...eveCheckLines(outcome.checks)];
  for (const warning of outcome.warnings ?? []) {
    lines.push(`! ${warning.id} — ${safeText(warning.message)}`);
    if (warning.remediation !== undefined) {
      lines.push(`  → ${safeText(warning.remediation)}`);
    }
  }
  for (const object of outcome.registryObjectsKept ?? []) {
    lines.push(`  kept: ${safeText(object.ref)} (${object.class})`);
  }
  const elapsed = formatEveElapsed(startedAt);
  if (outcome.ok) {
    lines.push(
      "",
      outcome.status === "absent"
        ? `✓ ${outcome.name} (${outcome.environment}) is already absent — nothing removed`
        : `✓ destroyed ${outcome.name} (${outcome.environment}) in ${elapsed}`,
      "  retained: local deployment records under .eden/eve-deploy",
    );
    return lines;
  }
  const firstFailure = outcome.checks.find((value) =>
    value.status === "failed" || value.status === "blocked"
  );
  lines.push(
    "",
    `✗ destroy ${outcome.name} ${outcome.status}` +
      (firstFailure === undefined ? "" : ` — first failing check: ${firstFailure.id}`),
  );
  return lines;
}

function emitEveDestroyOutcome(
  options: EvePreflightOptions,
  outcome: EveDestroyOutcome,
  startedAt: number,
): void {
  if (humanOutput(options)) {
    for (const line of humanEveDestroyLines(outcome, startedAt)) {
      emitLine(options, line);
    }
    return;
  }
  (options.stdout ?? (() => undefined))(JSON.stringify({ command: "eden destroy", ...outcome }, (_key, value: unknown) =>
    typeof value === "string" ? redactEveRuntimeOutput(value) : value
  ));
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

function safeWranglerEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    ...safeDockerEnvironment(),
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    WRANGLER_CACHE_DIR: join(cwd, "cache"),
    CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
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
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH,
    DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
  };
}

interface WranglerJsonResult {
  readonly value?: unknown;
  readonly failed: boolean;
  readonly stderr?: string;
}

async function withWranglerDirectory<T>(
  operation: (cwd: string) => Promise<T>,
): Promise<T> {
  // An explicit --config and WRANGLER_CACHE_DIR inside this private folder
  // stop Wrangler from searching its (possibly shared) parent directories.
  const cwd = await mkdtemp(join(tmpdir(), "eden-wrangler-"));
  try {
    await writeFile(join(cwd, "wrangler.json"), "{}\n", { mode: 0o600 });
    return await operation(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function readWranglerJson(
  args: readonly string[],
  /** Makes Wrangler read this account or fail. Only whoami, which names the account, runs without it. */
  accountId?: string,
): Promise<WranglerJsonResult> {
  try {
    const result = await withWranglerDirectory((cwd) => execFileAsync(
      process.execPath,
      [wranglerEntrypoint, ...args, "--config", join(cwd, "wrangler.json")],
      {
        env: {
          ...safeWranglerEnvironment(cwd),
          ...(accountId === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: accountId }),
        },
        cwd,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
    ));
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
  complete: boolean = false,
): readonly {
  readonly id: string;
  readonly name: string;
}[] | undefined {
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
    const entryName = (entry as { readonly name: string }).name;
    if (entryName === name) {
      entries.push({
        id: (entry as { readonly id: string }).id,
        name: entryName,
      });
    }
  }
  // Without proven pagination, a full page that lacks the name proves nothing.
  if (entries.length === 0 && !complete && collection.length >= 100) {
    return undefined;
  }
  return entries;
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
    !("id" in account) ||
    typeof account.id !== "string"
  ) {
    return undefined;
  }
  const selectedAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (selectedAccount && selectedAccount !== account.id) {
    return undefined;
  }
  return account.id;
}

async function readWranglerOAuthToken(): Promise<string | undefined> {
  const legacyRoot = join(homedir(), ".wrangler");
  const legacyExists = (await lstat(legacyRoot).catch(() => undefined))?.isDirectory();
  const configHome = process.env.XDG_CONFIG_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Preferences")
      : join(homedir(), ".config"));
  const root = process.env.WRANGLER_HOME ??
    (legacyExists ? legacyRoot : join(configHome, ".wrangler"));
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
        redirect: "error",
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
        EVE_NAME_PATTERN.test(subdomain)
      ? subdomain
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Container applications in the account that belong to this exact target.
 * Eden names a target's Container application `<name>-container`; containers
 * owned by anything else in the account never count.
 */
export function exactTargetContainerEntries(
  value: unknown,
  name: string,
): readonly { readonly id: string; readonly name: string }[] | undefined {
  return exactContainerEntries(value, boundedResourceName(name, "container"));
}

/**
 * One read of Cloudflare's API: the status and the body as sent. Undefined
 * without a token or without an answer. A redirect is refused, so an answer
 * is the API's own for this exact URL.
 */
async function readCloudflareApi(
  url: URL,
): Promise<{ readonly status: number; readonly body: string } | undefined> {
  const token = process.env.CLOUDFLARE_API_TOKEN || await readWranglerOAuthToken();
  if (!token) return undefined;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
}

async function readTargetContainers(accountId: string, name: string): Promise<WranglerJsonResult> {
  // Unlike `containers list --json`, this endpoint supports an exact name
  // filter and exposes result_info.next_page_token. No per_page means all.
  const entries: unknown[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  try {
    do {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/containers/applications`,
      );
      url.searchParams.set("name", name);
      if (pageToken !== undefined) url.searchParams.set("page_token", pageToken);
      const response = await readCloudflareApi(url);
      if (response?.status !== 200) return { failed: true };
      // Every page is read the same way, whether it lists the application
      // or not: the API's answer, read on 2026-11-19, has status 200, success
      // true, and an empty errors list, and a body that names a field twice
      // is no answer.
      const body: unknown = JSON.parse(response.body);
      if (typeof body !== "object" || body === null ||
        !("success" in body) || body.success !== true ||
        !("errors" in body) || !Array.isArray(body.errors) || body.errors.length > 0 ||
        !("result" in body) || !Array.isArray(body.result) ||
        namesFieldTwice(response.body)) return { failed: true };
      const info = "result_info" in body ? body.result_info : undefined;
      if (info !== undefined &&
        (typeof info !== "object" || info === null || Array.isArray(info))) {
        return { failed: true };
      }
      const next = info !== undefined && "next_page_token" in info
        ? info.next_page_token
        : undefined;
      if (next !== undefined && next !== null && typeof next !== "string") {
        return { failed: true };
      }
      // Missing pagination metadata on a full page cannot prove absence.
      if (info === undefined && body.result.length >= 100) return { failed: true };
      entries.push(...body.result);
      pageToken = typeof next === "string" && next.length > 0 ? next : undefined;
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) return { failed: true };
        seenTokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return { failed: false, value: entries };
  } catch {
    return { failed: true };
  }
}

/**
 * The exact Worker in the account: "deployed" or "undeployed" when the API
 * lists its deployments (status 200), "absent" only for the API's own answer
 * that it does not exist. That answer, read on 2026-11-19, is status 404
 * with success false, a null result, and one error whose code is 10007.
 * Undefined for anything else, which proves nothing either way: no answer,
 * a redirect, another status or error, a body that names a field twice, or
 * one that says 10007 beside anything that contradicts it.
 */
async function readWorkerPresence(
  accountId: string,
  workerName: string,
): Promise<"deployed" | "undeployed" | "absent" | undefined> {
  const response = await readCloudflareApi(new URL(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
  ));
  if (response === undefined) return undefined;
  if (response.status === 200) {
    let listed: unknown;
    try {
      listed = JSON.parse(response.body);
    } catch {
      return undefined;
    }
    // Each deployment the API lists has an id; read on 2026-11-19.
    return typeof listed === "object" && listed !== null && "success" in listed && listed.success === true &&
        "result" in listed && typeof listed.result === "object" && listed.result !== null &&
        "deployments" in listed.result && Array.isArray(listed.result.deployments) &&
        listed.result.deployments.every((entry: unknown) =>
          typeof entry === "object" && entry !== null && "id" in entry &&
          typeof entry.id === "string" && entry.id.length > 0
        ) && !namesFieldTwice(response.body)
      ? listed.result.deployments.length > 0 ? "deployed" : "undeployed"
      : undefined;
  }
  // Absence is read strictly: a body that names a field twice is no answer.
  const body = exactJson(response.body);
  if (typeof body !== "object" || body === null || !("success" in body) || !("result" in body)) return undefined;
  const errors = "errors" in body ? body.errors : undefined;
  const error: unknown = Array.isArray(errors) && errors.length === 1 ? errors[0] : undefined;
  return response.status === 404 && body.success === false && body.result === null &&
      typeof error === "object" && error !== null && "code" in error && error.code === 10007
    ? "absent"
    : undefined;
}

/**
 * The exact Worker and Container application, both read from the one
 * account the caller verified. Either is undefined when its read proved
 * nothing.
 */
async function readExactTargetInventory(
  accountId: string | undefined,
  workerName: string,
  containerApp: string,
) {
  if (accountId === undefined) return { containerEntries: undefined, worker: undefined };
  const containers = await readTargetContainers(accountId, containerApp);
  return {
    containerEntries: containers.failed ? undefined : exactContainerEntries(containers.value, containerApp, true),
    worker: await readWorkerPresence(accountId, workerName),
  };
}

async function defaultCloudflareRead(
  request: EveCloudflareReadRequest,
): Promise<EveCloudflareReadResult> {
  const account = await readWranglerJson(["whoami", "--json"]);
  const accountId = authenticatedAccountId(account.value);
  const { containerEntries, worker } = await readExactTargetInventory(
    accountId,
    request.name,
    boundedResourceName(request.name, "container"),
  );
  const accountAccess = account.failed || accountId === undefined
    ? "unavailable"
    : "available";
  const containerAccess = containerEntries === undefined
    ? "unavailable"
    : "available";
  const workersDevSubdomain = await readWorkersDevSubdomain(accountId);
  if (
    accountAccess === "unavailable" ||
    containerAccess === "unavailable" ||
    worker === undefined
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
    worker === "absent" &&
    containerEntries?.length === 0
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
  const workerPresent = worker !== "absent";
  const containerPresent = (containerEntries?.length ?? 0) > 0;
  const providerEvidence = await readProviderEvidence(
    request.name,
    accountId,
    workerPresent,
    containerPresent ? containerEntries?.[0] : undefined,
  );
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
      // The read-only inventory proves the exact target exists but cannot
      // prove who created it; Eden's immutable deployment record resolves
      // ownership next.
      state: "unowned",
      observed: { worker: workerPresent, container: containerPresent },
      ...(providerEvidence === undefined ? {} : { providerEvidence }),
      message:
        "The exact Worker or Container target already exists, and the read-only inventory cannot prove Eden owns it.",
      remediation:
        "Deploy under a different --name or remove the conflicting Worker/Container yourself; Eden never adopts or replaces resources it cannot prove it created.",
    },
  };
}

/**
 * Reads provider-backed facts about the live target: the Container
 * application's identity from `wrangler containers list` plus `containers
 * info` (scheduling policy and Durable Object namespace), and the
 * `EDEN_EVE_DEPLOYMENT_ID` plain-text var plus the `EVE_CONTAINER` Durable
 * Object namespace Eden stamps into every Worker it publishes (from the
 * script settings API). All are provider state — a foreign Worker can forge
 * `x-eden-*` response headers but cannot set vars or namespaces Eden
 * recorded at publish time. The ownership proof is the Container
 * application's Durable Object namespace matching the Worker's binding
 * namespace.
 */
async function readProviderEvidence(
  workerName: string,
  accountId: string | undefined,
  workerPresent: boolean,
  containerEntry:
    | { readonly id: string; readonly name: string }
    | undefined,
): Promise<NonNullable<EveCloudflareReadResult["target"]["providerEvidence"]> | undefined> {
  const evidence: {
    containerApplicationId?: string;
    containerSchedulingPolicy?: string;
    containerNamespaceId?: string;
    workerDeploymentId?: string;
    workerReleaseId?: string;
    workerContainerNamespaceId?: string;
    settingsReadable?: boolean;
  } = {
    ...(containerEntry === undefined
      ? {}
      : { containerApplicationId: containerEntry.id }),
  };
  if (containerEntry !== undefined) {
    const info = await readWranglerJson([
      "containers",
      "info",
      containerEntry.id,
      "--json",
    ], accountId);
    if (!info.failed && typeof info.value === "object" && info.value !== null) {
      const infoRecord = info.value as {
        readonly scheduling_policy?: unknown;
        readonly durable_objects?: {
          readonly namespace_id?: unknown;
        };
      };
      if (typeof infoRecord.scheduling_policy === "string") {
        evidence.containerSchedulingPolicy = infoRecord.scheduling_policy;
      }
      const namespaceId = infoRecord.durable_objects?.namespace_id;
      if (typeof namespaceId === "string") {
        evidence.containerNamespaceId = namespaceId;
      }
    }
  }
  if (workerPresent && accountId !== undefined) {
    const token = process.env.CLOUDFLARE_API_TOKEN ??
      (await readWranglerOAuthToken());
    if (token !== undefined) {
      try {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
          {
            headers: { authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (response.ok) {
          evidence.settingsReadable = true;
          const parsed = (await response.json()) as {
            readonly result?: {
              readonly bindings?: readonly {
                readonly type?: string;
                readonly name?: string;
                readonly text?: string;
                readonly namespace_id?: string;
              }[];
            };
          };
          const bindings = parsed.result?.bindings ?? [];
          const deploymentBinding = bindings.find(
            (value) =>
              value.type === "plain_text" &&
              value.name === "EDEN_EVE_DEPLOYMENT_ID",
          );
          if (typeof deploymentBinding?.text === "string") {
            evidence.workerDeploymentId = deploymentBinding.text;
          }
          const releaseBinding = bindings.find(
            (value) =>
              value.type === "plain_text" &&
              value.name === "EDEN_EVE_RELEASE_ID",
          );
          if (typeof releaseBinding?.text === "string") {
            evidence.workerReleaseId = releaseBinding.text;
          }
          const containerBinding = bindings.find(
            (value) =>
              value.type === "durable_object_namespace" &&
              value.name === "EVE_CONTAINER",
          );
          if (typeof containerBinding?.namespace_id === "string") {
            evidence.workerContainerNamespaceId = containerBinding.namespace_id;
          }
        } else if (response.status !== 404) {
          evidence.settingsReadable = false;
        }
      } catch {
        evidence.settingsReadable = false;
      }
    }
  }
  return evidence;
}


/**
 * Resolves local deployment history against authenticated provider state.
 * This detects name reuse and stale records, but deployment IDs are public:
 * a malicious forged local record is not an independent ownership proof.
 */
async function resolveEveTargetOwnership(
  request: EveCloudflareReadRequest,
  result: EveCloudflareReadResult,
): Promise<EveCloudflareReadResult> {
  if (result.target.state !== "unowned") return result;
  const record = await readEveDeploymentRecord(
    request.projectRoot,
    request.environment,
    request.name,
    result.accountId,
    request.projectId === "unknown-project" ? undefined : request.projectId,
  );
  if (
    record === undefined ||
    record.identity.workerName !== request.name ||
    record.identity.accountId !== result.accountId ||
    (
      request.projectId !== "unknown-project" &&
      record.identity.projectId !== undefined &&
      record.identity.projectId !== request.projectId
    ) ||
    (
      result.target.observed?.container === true &&
      record.identity.containerApplicationName !==
        boundedResourceName(request.name, "container")
    )
  ) {
    return result;
  }
  // Remote proof must come from provider state. A foreign Worker can echo
  // `x-eden-*` response headers, but it cannot plant the plain-text var Eden
  // publishes into script settings or claim the Durable Object namespace the
  // Worker's EVE_CONTAINER binding resolves to. The Worker is proven only by
  // its own settings: unreadable settings fail closed.
  const evidence = result.target.providerEvidence;
  const recordedDeploymentIds = new Set(record.deploymentIds);
  // Every Eden project on the same Eve version publishes the same affinity
  // deployment ID, so the per-publish release ID is what tells a same-name
  // Worker from another project apart. Workers from before release IDs
  // existed used the release ID as their deployment ID.
  const recordedReleaseIds = new Set(record.releaseIds);
  const workerReleaseId = evidence?.workerReleaseId ?? evidence?.workerDeploymentId;
  const workerProven = result.target.observed?.worker !== true ||
    (
      evidence?.settingsReadable === true &&
      evidence.workerDeploymentId !== undefined &&
      recordedDeploymentIds.has(evidence.workerDeploymentId) &&
      workerReleaseId !== undefined &&
      recordedReleaseIds.has(workerReleaseId)
    );
  // The Container proof is the application running the durable_object
  // scheduling policy with a namespace that matches the Worker binding's
  // namespace; anything else fails closed.
  const containerProven = result.target.observed?.container !== true ||
    (
      evidence?.containerSchedulingPolicy === "durable_object" &&
      evidence.containerNamespaceId !== undefined &&
      evidence.workerContainerNamespaceId !== undefined &&
      evidence.containerNamespaceId === evidence.workerContainerNamespaceId
    );
  const remoteProven = evidence !== undefined && workerProven && containerProven;
  if (!remoteProven) {
    const failures: string[] = [];
    if (evidence === undefined) failures.push("provider evidence unavailable");
    if (result.target.observed?.worker === true) {
      if (evidence?.settingsReadable !== true) failures.push("Worker settings unreadable");
      else if (evidence.workerDeploymentId === undefined) failures.push("Worker deployment stamp absent");
      else if (!recordedDeploymentIds.has(evidence.workerDeploymentId)) failures.push("Worker deployment stamp differs from recorded identities");
      else if (workerReleaseId === undefined || !recordedReleaseIds.has(workerReleaseId)) failures.push("Worker release stamp differs from recorded releases");
    }
    if (result.target.observed?.container === true) {
      if (evidence?.containerSchedulingPolicy !== "durable_object") failures.push("Container scheduling policy unproven");
      if (evidence?.containerNamespaceId === undefined) failures.push("Container namespace unreadable");
      if (evidence?.workerContainerNamespaceId === undefined) failures.push("Worker Container binding namespace unreadable");
      if (evidence?.containerNamespaceId !== undefined && evidence.workerContainerNamespaceId !== undefined &&
          evidence.containerNamespaceId !== evidence.workerContainerNamespaceId) failures.push("Container and Worker binding namespaces differ");
    }
    return {
      ...result,
      target: {
        ...result.target,
        message:
          `The exact Worker or Container target exists, and although a local Eden record matches, provider state cannot prove it is the one Eden deployed — the target may have been recreated outside Eden. Unproven: ${failures.join("; ")}.`,
        remediation:
          "Inspect the Worker at its workers.dev origin and the recorded deployment history before redeploying; if it is not Eden's, deploy under a different --name or delete it yourself.",
      },
    };
  }
  const priorIdentity: EveDeploymentIdentityProof = {
    workerName: record.identity.workerName,
    containerApplicationName: record.identity.containerApplicationName,
    stableContainerInstanceName: record.identity.stableContainerInstanceName,
    accountId: record.identity.accountId,
    environment: request.environment,
    name: request.name,
    ...(record.identity.projectId === undefined
      ? {}
      : { projectId: record.identity.projectId }),
    ...(record.identity.generationId === undefined
      ? {}
      : { generationId: record.identity.generationId }),
    ...(record.identity.containerImage === undefined
      ? {}
      : { containerImage: record.identity.containerImage }),
  };
  return {
    ...result,
    target: {
      state: "owned",
      identity: priorIdentity,
      ...(result.target.observed === undefined
        ? {}
        : { observed: result.target.observed }),
      message:
        "The immutable deployment record proves Eden owns the exact target; deploy proceeds as an in-place update.",
    },
  };
}

async function readEveCloudflareTarget(
  request: EveCloudflareReadRequest,
  options: EvePreflightOptions,
): Promise<EveCloudflareReadResult> {
  const result = options.cloudflareRead === undefined
    ? await defaultCloudflareRead(request)
    : await options.cloudflareRead(request);
  return resolveEveTargetOwnership(request, result);
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

async function defaultRuntimeRunner(
  request: EvePreflightRuntimeRunnerRequest,
): Promise<EvePreflightRuntimeEvidence> {
  let result: Awaited<ReturnType<typeof buildEveRuntimeImage>>;
  try {
    const imageRequest: EveRuntimeImageRequest = {
      candidate: request.candidate,
      nodeImage: request.nodeImage,
      hostRequirements: request.hostRequirements,
      ...(request.publicOrigin === undefined
        ? {}
        : { publicOrigin: request.publicOrigin }),
      ...(request.runtimeInjection === undefined
        ? {}
        : { runtimeInjection: request.runtimeInjection }),
      ...(request.workflowWorld === undefined
        ? {}
        : { workflowWorld: request.workflowWorld }),
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

type EveCloudflareAccess = Pick<
  EveCloudflareReadResult,
  "accountAccess" | "containerAccess"
>;

/** The login and Container read that need no build, so they run before it. */
async function defaultCloudflareAccess(name: string): Promise<EveCloudflareAccess> {
  const account = await readWranglerJson(["whoami", "--json"]);
  const accountId = authenticatedAccountId(account.value);
  if (account.failed || accountId === undefined) {
    return { accountAccess: "unavailable", containerAccess: "unavailable" };
  }
  const containers = await readTargetContainers(accountId, boundedResourceName(name, "container"));
  return {
    accountAccess: "available",
    containerAccess: containers.failed ? "unavailable" : "available",
  };
}

function cloudflareAccessBlocked(result: EveCloudflareAccess): EvePreflightCheck {
  return check(
    "VAL-CLI-007-CLOUDFLARE-ACCESS",
    "blocked",
    "Authenticated Cloudflare account and Container access could not be verified without a mutating operation.",
    result.accountAccess === "available"
      ? "Wrangler is logged in, but the account's Containers could not be read. Confirm that the account npx wrangler@4.147.0 whoami shows is on the Workers Paid plan, or switch accounts with npx wrangler@4.147.0 login, then retry."
      : "Run npx wrangler@4.147.0 login, confirm the account with npx wrangler@4.147.0 whoami, then retry.",
  );
}

function cloudflareChecks(
  result: EveCloudflareReadResult,
): readonly EvePreflightCheck[] {
  const target = result.target;
  const targetPasses =
    target.state === "absent" || target.state === "owned";
  const targetMessage = targetPasses
    ? target.state === "absent"
      ? "The exact target read is absent and is eligible without claiming ownership."
      : target.message ??
        "The exact target is provably Eden-owned; deploy proceeds as an in-place update."
    : target.message ??
      "The exact target read is unowned, mismatched, cross-environment, or ambiguous.";
  const targetRemediation = targetPasses
    ? undefined
    : target.remediation ??
      "Inspect only the exact target and resolve ownership or identity ambiguity before deploy; do not broaden the target.";
  return [
    result.accountAccess === "available" &&
      result.containerAccess === "available"
      ? check(
        "VAL-CLI-007-CLOUDFLARE-ACCESS",
        "passed",
        "Authenticated account and Container access were verified through the read-only adapter.",
      )
      : cloudflareAccessBlocked(result),
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

/**
 * The one spelling of an image that Eden pushes, deploys and cleans up:
 * `registry.cloudflare.com/<account>/<repository>@sha256:<digest>` for the
 * proved account. Anything else is undefined, including another spelling of
 * the same host, so no comparison ever sees two names for one repository.
 */
function managedImage(
  reference: string | undefined,
  accountId: string,
): { readonly repository: string; readonly digest: string } | undefined {
  const match = /^registry\.cloudflare\.com\/([A-Za-z0-9_-]{1,64})\/([a-z0-9]+(?:[._-]+[a-z0-9]+)*)@(sha256:[0-9a-f]{64})$/u
    .exec(reference ?? "");
  return match === null || match[1] !== accountId
    ? undefined
    : { repository: match[2] as string, digest: match[3] as string };
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
  ];
  if (!required.every((key) => observed[key] === expected[key])) {
    return false;
  }
  const expectedInstance = expected.retainedDeployments === undefined ||
      expected.deploymentId === "eden-cloudflare"
    ? expected.stableContainerInstanceName
    : `${expected.stableContainerInstanceName}:${expected.deploymentId}`;
  if (observed.stableContainerInstanceName !== expectedInstance ||
      observed.releaseId !== expected.releaseId) return false;
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
    "releaseId",
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
    releaseId: identity.releaseId,
    eveVersion: identity.eveVersion,
    affinityContract: identity.affinityContract,
    retainedDeployments: identity.retainedDeployments,
    pendingRetirements: identity.pendingRetirements,
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

/** Deadline for Wrangler secret writes and deletions. */
const WRANGLER_OPERATION_TIMEOUT_MS = 120_000;
/** Deadline for the image push and `wrangler deploy`; either can take minutes on a slow registry or uplink. */
const WRANGLER_PUBLICATION_TIMEOUT_MS = 600_000;

async function runWranglerWithInput(
  args: readonly string[],
  /** Makes Wrangler act on this account or fail, whatever its login resolves to. */
  accountId: string,
  input?: string,
  timeoutMs: number = WRANGLER_OPERATION_TIMEOUT_MS,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Read from all of stderr, before it is cut for display. */
  readonly containerSettingsUnapplied: boolean;
}> {
  // The project's TypeScript lib predates Promise.withResolvers.
  return withWranglerDirectory((cwd) => new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      [wranglerEntrypoint, ...args, ...(args.includes("--config")
        ? []
        : ["--config", join(cwd, "wrangler.json")])],
      {
        cwd,
        env: { ...safeWranglerEnvironment(cwd), CLOUDFLARE_ACCOUNT_ID: accountId },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    // Decoded whole: a character can arrive split across two chunks.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finish = (result: {
      readonly exitCode: number;
      readonly stdout?: string;
      readonly stderr: string;
      /** True when Wrangler itself exited with this code. */
      readonly exited?: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: result.exitCode,
        stdout: safeText(result.stdout ?? Buffer.concat(stdoutChunks).toString()),
        stderr: safeText(result.stderr),
        containerSettingsUnapplied: result.exited === true && result.exitCode !== 0 &&
          WRANGLER_CONTAINER_SETTINGS_UNAPPLIED.test(result.stderr.replace(TERMINAL_COLOR, "")),
      });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ exitCode: 1, stderr: "The bounded Wrangler operation timed out." });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timeout);
      finish({ exitCode: 1, stderr: "Wrangler could not be started." });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      finish({
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderrChunks).toString(),
        exited: code !== null,
      });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  }));
}

function defaultProtectedStore(
  workerName: string,
  accountId: string,
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
          accountId,
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
      request.accountId,
      undefined,
      WRANGLER_PUBLICATION_TIMEOUT_MS,
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

/**
 * The whole error Wrangler 4.147.0 prints, on a line of its own, when it
 * uploaded the Worker version and then failed while setting up the
 * Container application, whatever the cause.
 */
const WRANGLER_CONTAINER_SETTINGS_UNAPPLIED =
  /(?:^|\n)✘ \[ERROR\] The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings\. Re-run the same `wrangler deploy` command to retry and finish deployment\.[ \t]*(?:\r?\n|$)/u;
const TERMINAL_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
const CONTAINER_SETTINGS_UNAPPLIED_INSPECTION =
  "Eden did not run the publish again. Check the deployment URL's /eve/v1/health and inspect the Worker, the Container application, and the retained .eden evidence. Keep the .eden folder.";
/** Only for a target this project never promoted; run on Cloudflare on 2026-11-20. */
const CONTAINER_SETTINGS_UNAPPLIED_FIRST_DEPLOY =
  " This was the target's first deploy. It can leave a Worker without its Container application, which eden deploy refuses with VAL-CLI-007-TARGET-CONFLICT. Run eden destroy with the same --project, --env, and --name, again after a minute if it answers EVE_DESTROY_OWNERSHIP_UNPROVEN. Run eden deploy only after destroy ends destroyed or absent.";
/** The remediation of each deployment whose publish stopped at the Container application settings. */
const containerSettingsUnapplied = new WeakMap<object, string>();

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
      ],
      // The config Eden wrote names the same account, and Wrangler reads it first.
      request.identity.accountId,
      undefined,
      WRANGLER_PUBLICATION_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      // A timeout replaces stderr, so it never matches.
      const unapplied = result.containerSettingsUnapplied;
      return {
        status: "indeterminate",
        reason: unapplied
          ? "Wrangler uploaded the Worker version but did not finish applying its Container application settings."
          : "The exact Cloudflare publication did not return a terminal success result.",
        ownershipEvidenceRetained: true,
        ...(unapplied ? { containerSettingsUnapplied: true } : {}),
      };
    }
    const { containerEntries, worker } = await readExactTargetInventory(
      request.identity.accountId,
      request.identity.workerName,
      request.hostConfig.container.applicationName,
    );
    // A script with no deployment serves nothing, so it is not a publication.
    if (containerEntries?.length !== 1 || worker !== "deployed") {
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
  read("releaseId", "x-eden-eve-release-id");
  read("environment", "x-eden-eve-environment");
  read("name", "x-eden-eve-name");
  read("accountId", "x-eden-eve-account-id");
  read("workersDevSubdomain", "x-eden-eve-workers-dev-subdomain");
  read("stableWorkersDevOrigin", "x-eden-eve-public-origin");
  read("workerName", "x-eden-eve-worker-name");
  read("containerApplicationName", "x-eden-eve-container-application");
  read("stableContainerInstanceName", "x-eden-eve-container-instance");
  const started = response.headers.get("x-eden-eve-started-deployment");
  if (started !== null) {
    (identity as Record<string, unknown>)["startedDeploymentId"] = started;
  }
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
        const observedIdentity = responseIdentity(response, body);
        // A Worker activates before its image rollout completes; promotion
        // must wait until the *served container* verifiably runs this
        // generation's image (the host stamps the header only after
        // inspecting the running instance).
        if (
          observedIdentity.startedDeploymentId !== (request.identity.releaseId ?? request.identity.deploymentId)
        ) {
          lastReason =
            "The served Container has not verifiably started this deployment's image yet; waiting for the rollout to land.";
          await wait();
          continue;
        }
        return {
          status: "ready",
          identity: observedIdentity,
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

/**
 * Atomically re-points the target's CURRENT symlink at a promoted immutable
 * generation. The pointer key is `<environment>-<name>` — the same path
 * `destroy` clears and the update ownership resolver reads.
 */
async function promoteEveTargetPointer(
  deploymentRoot: string,
  pointerKey: string,
  generationRoot: string,
): Promise<string> {
  const targetRoot = join(deploymentRoot, "targets", pointerKey);
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
      source: pointerKey,
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
      source: pointerKey,
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
  filename = "deployment.json",
): Promise<void> {
  await writeFile(
    join(candidate.generationRoot, filename),
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

async function deploymentRecordPath(generationRoot: string): Promise<string> {
  const path = join(generationRoot, "deployment.json");
  return await lstat(path).then(() => path, () => join(generationRoot, "deployment-intent.json"));
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
  operation: "create" | "update",
  superseded?: {
    readonly generationId?: string | undefined;
    readonly containerImage?: string | undefined;
  },
  outcome?: { readonly reason: string; readonly evidenceLocation: string },
): EveDeploymentMetadata {
  return {
    status,
    ...outcome,
    operation,
    targetKey,
    deploymentId: identity.deploymentId,
    workerName: identity.workerName,
    containerApplicationName: identity.containerApplicationName,
    stableContainerInstanceName: identity.stableContainerInstanceName,
    stableWorkersDevOrigin: identity.stableWorkersDevOrigin,
    imageReference: identity.containerImage,
    ...(superseded?.generationId === undefined
      ? {}
      : { supersededGenerationId: superseded.generationId }),
    ...(superseded?.containerImage === undefined
      ? {}
      : { supersededImageReference: superseded.containerImage }),
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
    source: "eden deploy",
  });
}

async function runEveDeployment(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions,
  collected: EvePreflightCollection,
  onPromotion: (result: EvePreflightResult) => void,
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

  const isUpdate = cloudflare.target.state === "owned";
  const operation = isUpdate ? "update" as const : "create" as const;
  const prior = collected.priorDeployment;
  if (isUpdate && prior === undefined) {
    throw deploymentFailure(
      "EVE_UPDATE_RECORD_UNAVAILABLE",
      "The exact target is provably Eden-owned, but its immutable deployment record is unreadable; refusing to update without the recorded Durable Object history.",
    );
  }
  if (isUpdate && prior?.durableObjects === undefined) {
    throw deploymentFailure(
      "EVE_UPDATE_RECORD_UNAVAILABLE",
      "The prior deployment record does not carry a readable Durable Object history; refusing to update because replacing it could emit a divergent migration list.",
    );
  }
  const priorIdentity = prior?.identity;
  const priorDurableObjects = prior?.durableObjects;
  const worldManifest = collected.workflowWorld === "@moinulmoin/eden-world-cloudflare"
    ? await readInstalledManifest(candidate.snapshotRoot, collected.workflowWorld)
    : undefined;
  const affinityEnabled = worldManifest?.eden?.capabilities?.deploymentAffinity === true;
  const worldRpcAuth = worldManifest?.eden?.capabilities?.worldRpcAuth === true;
  if (!affinityEnabled && priorIdentity?.retainedDeployments !== undefined) {
    throw deploymentFailure("EVE_AFFINITY_REQUIRED", "This target retains affinity deployments; install a World package declaring deploymentAffinity before updating it.");
  }
  const superseded = isUpdate
    ? {
      generationId: priorIdentity?.generationId,
      containerImage: priorIdentity?.containerImage,
    } as const
    : undefined;
  const resultWarnings =
    collected.result.warnings as EvePreflightWarning[];
  if (isUpdate) {
    const world = collected.workflowWorld;
    const durableWorld = world !== undefined &&
      world !== "local" &&
      world !== "@workflow/world-local";
    if (durableWorld) {
      resultWarnings.push({
        id: "EVE_UPDATE_IN_FLIGHT",
        message:
          affinityEnabled
            ? "This update retains pinned deployments until their sessions, queue messages, and transfers drain."
            : "This update replaces the running Container; an Eve version change can strand existing sessions because the installed World does not declare deployment affinity.",
        remediation:
          affinityEnabled
            ? "End old sessions to allow their deployment images to retire."
            : "Let sessions settle before changing Eve versions, or install an affinity-capable World package.",
      });
    }
    if (
      prior?.worldCloudflare !==
        (world === "@moinulmoin/eden-world-cloudflare")
    ) {
      resultWarnings.push({
        id: "EVE_UPDATE_WORLD_SWITCH",
        message:
          "The compiled Workflow World changed since the last deploy; existing sessions and pending approvals stay in the previous World and do not migrate to the new one.",
        remediation:
          "Existing Durable Object data is preserved (classes and bindings are never removed), but runs started before this update remain where they were created.",
      });
    }
    eveProgress(
      options,
      "update: Durable Object data is preserved; the running Container restarts on its next request to serve the new image",
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
  if (imageDigest === undefined || !IMAGE_ID_PATTERN.test(imageDigest)) {
    throw deploymentFailure(
      "EVE_IMAGE_IDENTITY_UNAVAILABLE",
      "The deploy candidate did not provide an immutable runtime image digest.",
    );
  }
  // A supplied image reference is refused here, before anything on the target changes.
  if (options.containerImageReference !== undefined) {
    const supplied = managedImage(options.containerImageReference, accountId);
    if (supplied === undefined) {
      throw deploymentFailure(
        "EVE_IMAGE_IDENTITY_MISMATCH",
        "The Container image reference is not registry.cloudflare.com/<account>/<repository>@sha256:<digest> for the authenticated account.",
      );
    }
    if (supplied.digest !== imageDigest) {
      throw deploymentFailure(
        "EVE_IMAGE_IDENTITY_MISMATCH",
        "The exact Container image reference did not match the verified local image digest.",
      );
    }
  }

  const targetKey = stableDeploymentKey(
    collected.projectId,
    accountId,
    request.environment,
    request.name,
  );
  const releaseId = `eve-deploy-${randomUUID()}`;
  let previousEveVersion = priorIdentity?.eveVersion;
  if (previousEveVersion === undefined && prior !== undefined) {
    previousEveVersion = (await readInstalledManifest(join(prior.generationRoot, "container/snapshot"), "eve"))?.version;
  }
  const retainedDeployments: Record<string, EveAffinityDeployment> = {
    ...priorIdentity?.retainedDeployments,
  };
  if (affinityEnabled && priorIdentity?.retainedDeployments === undefined &&
      priorIdentity?.containerImage !== undefined && priorIdentity.generationId !== undefined) {
    retainedDeployments["eden-cloudflare"] = {
      image: priorIdentity.containerImage,
      generationId: priorIdentity.generationId,
      ...(previousEveVersion === undefined ? {} : { eveVersion: previousEveVersion }),
      affinityContract: EDEN_AFFINITY_CONTRACT,
      ...(priorIdentity.runtimeRevisionHandle === undefined ? {} : { runtimeRevisionHandle: priorIdentity.runtimeRevisionHandle }),
    };
  }
  const matchingDeployment = Object.entries(retainedDeployments).find(([, entry]) =>
    entry.worldRpcAuth === true && entry.eveVersion === candidate.eveVersion && entry.affinityContract === EDEN_AFFINITY_CONTRACT
  )?.[0];
  const affinityDeploymentId = `eden-affinity-${createHash("sha256").update(`${candidate.eveVersion}:${EDEN_AFFINITY_CONTRACT}`).digest("hex").slice(0, 24)}`;
  const deploymentId = !affinityEnabled ? releaseId : matchingDeployment ??
    (affinityDeploymentId in retainedDeployments ? `${affinityDeploymentId}-${randomUUID().slice(0, 8)}` : affinityDeploymentId);
  const retiringDeployments: Record<string, EveAffinityDeployment> = { ...priorIdentity?.pendingRetirements };
  delete retiringDeployments[deploymentId];
  if (priorIdentity?.deploymentId !== undefined) delete retiringDeployments[priorIdentity.deploymentId];
  for (const id of prior?.protectedDeploymentIds ?? []) delete retiringDeployments[id];
  // Old containers can access every session's World without authentication.
  // Drop their routes even when live sessions or transfers would prevent drain.
  const insecureRetirements = affinityEnabled
    ? Object.entries(retainedDeployments).filter(([id, entry]) => id !== deploymentId && entry.worldRpcAuth !== true)
    : [];
  for (const [id, entry] of insecureRetirements) {
    retiringDeployments[id] = entry;
    delete retainedDeployments[id];
  }
  if (insecureRetirements.length > 0) {
    resultWarnings.push({
      id: "EVE_UNAUTHENTICATED_VERSIONS_RETIRED",
      message: `${insecureRetirements.length} kept version${insecureRetirements.length === 1 ? " was" : "s were"} retired because World RPC was unauthenticated; their sessions ended.`,
      remediation: 'Old sessions now fail; Eve may report "Failed to send the session message." Start new sessions on the current deployment.',
    });
  }
  const hasRetainedNoncurrentDeployments = priorIdentity?.retainedDeployments !== undefined &&
    Object.keys(retainedDeployments).some((id) => id !== priorIdentity.deploymentId);
  const controlToken = `${randomUUID()}${randomUUID()}`;
  if (affinityEnabled && (hasRetainedNoncurrentDeployments || Object.keys(retiringDeployments).length > 0)) {
    await (options.protectedStore ?? defaultProtectedStore(request.name, accountId)).put({
      targetId: targetKey, revision: `eve-affinity-control-${randomUUID()}`,
      inputIdentity: {
        token: `eve-affinity-control-input-${randomUUID()}`,
        byteLength: Buffer.byteLength(controlToken),
        digest: createHash("sha256").update(controlToken).digest("hex"),
      },
      variableNames: ["EDEN_EVE_CONTROL_TOKEN"], values: { EDEN_EVE_CONTROL_TOKEN: controlToken },
    });
  }
  if (affinityEnabled && hasRetainedNoncurrentDeployments) {
    const ids = Object.keys(retainedDeployments);
    const raw = await (options.deploymentRpc ?? defaultDeploymentRpc)({
      origin: stableWorkersDevOrigin, operation: "deployments.drainState", deploymentIds: ids,
      controlToken,
    });
    const states = validateDeploymentDrainStates(raw, ids);
    const eligible = ids.filter((id) =>
      id !== deploymentId && id !== priorIdentity.deploymentId &&
      !prior?.protectedDeploymentIds?.includes(id) && states[id]?.drained === true
    );
    const remainingCount = ids.length - eligible.length + (deploymentId in retainedDeployments ? 0 : 1);
    if (remainingCount <= 10 && eligible.length > 0) {
      // Drain snapshots are not fences. Retire only noncurrent targets, and
      // obtain the World's durable admission fence before dropping routes.
      const retired = await (options.deploymentRpc ?? defaultDeploymentRpc)({
        origin: stableWorkersDevOrigin, operation: "deployments.retire",
        deploymentIds: eligible, controlToken,
      });
      if (typeof retired !== "object" || retired === null || !("retired" in retired) ||
          !Array.isArray(retired.retired) ||
          eligible.some((id) => !(retired.retired as unknown[]).includes(id))) {
        throw deploymentFailure("EVE_AFFINITY_RETIRE_UNPROVEN", "The World did not prove the noncurrent deployments durably fenced for retirement.");
      }
      for (const id of eligible) {
        retiringDeployments[id] = retainedDeployments[id]!;
        delete retainedDeployments[id];
      }
    }
    if (Object.keys(retainedDeployments).length + (deploymentId in retainedDeployments ? 0 : 1) > 10) {
      const blockers = Object.entries(states).filter(([id]) => id in retainedDeployments)
        .map(([id, state]) => `${id}: ${state.liveSessions} live sessions, ${state.liveRuns} live runs, ${state.pendingMessages} pending messages, ${state.unfinishedTransfers} unfinished transfers`);
      throw deploymentFailure("EVE_AFFINITY_LIMIT", `Deployment refused before image/code publication: at most 10 affinity deployments may be retained. Blocking deployments: ${blockers.join("; ")}`);
    }
  }
  let imageReference = options.containerImageReference;
  if (imageReference === undefined) {
    eveProgress(options, "pushing container image to the Cloudflare registry");
    const localImageReference = runtimeEvidence.imageReference;
    if (localImageReference === undefined || localImageReference.length === 0) {
      throw deploymentFailure(
        "EVE_IMAGE_IDENTITY_UNAVAILABLE",
        "The deploy candidate did not return an exact local image handle for publication.",
      );
    }
    const imageRepository =
      `eden-eve-${targetKey}-${affinityEnabled ? deploymentId : candidate.generationId}`;
    const imageTag = `${imageRepository}:${EVE_REGISTRY_IMAGE_TAG}`;
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
    eveProgress(options, "registering runtime variables");
    try {
      runtimeInjection = await prepareEveRuntimeInjection(
        collected.runtimeConfig,
        {
          mode: "deploy",
          targetId: targetKey,
          protectedStore: options.protectedStore ??
            defaultProtectedStore(request.name, accountId),
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
  const containerApplicationName = boundedResourceName(request.name, "container");
  const stableContainerInstanceName = boundedResourceName(request.name, "instance");
  const runtimeVariableNames = candidate.runtimeVariableNames;
  const identity: EveDeploymentIdentity = {
    projectId: collected.projectId,
    sourceDigest: candidate.sourceDigest,
    generationId: candidate.generationId,
    deploymentId,
    releaseId,
    eveVersion: candidate.eveVersion,
    ...(affinityEnabled ? {
      affinityContract: EDEN_AFFINITY_CONTRACT,
      retainedDeployments: {
        ...retainedDeployments,
        [deploymentId]: {
          image: imageReference,
          generationId: candidate.generationId,
          eveVersion: candidate.eveVersion,
          affinityContract: EDEN_AFFINITY_CONTRACT,
          releaseId,
          worldRpcAuth,
          ...(runtimeInjection?.protectedHandle === undefined ? {} : { runtimeRevisionHandle: runtimeInjection.protectedHandle }),
        },
      },
      pendingRetirements: retiringDeployments,
    } : {}),
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
  const baseConfigRequest = {
    accountId,
    workerName: identity.workerName,
    containerApplicationName: identity.containerApplicationName,
    stableContainerInstanceName: identity.stableContainerInstanceName,
    deploymentId: identity.deploymentId,
    worldRpcAuth,
    ...(identity.releaseId === undefined ? {} : { releaseId: identity.releaseId }),
    ...(identity.eveVersion === undefined ? {} : { eveVersion: identity.eveVersion }),
    ...(identity.affinityContract === undefined ? {} : { affinityContract: identity.affinityContract }),
    ...(identity.retainedDeployments === undefined ? {} : { retainedDeployments: identity.retainedDeployments }),
    generationId: identity.generationId,
    stableWorkersDevOrigin: identity.stableWorkersDevOrigin,
    containerImage: identity.containerImage,
    runtimeVariableNames: identity.runtimeVariableNames,
    ...(identity.runtimeRevisionHandle === undefined
      ? {}
      : { runtimeRevisionHandle: identity.runtimeRevisionHandle }),
    schedules: collected.schedules ?? [],
    ...(collected.workflowWorld === undefined
      ? {}
      : { workflowWorld: collected.workflowWorld }),
    // In-place updates carry the prior Durable Object bindings and
    // migration history forward verbatim: classes are append-only and are
    // never silently re-declared or removed.
    ...(isUpdate && priorDurableObjects !== undefined
      ? { durableObjects: priorDurableObjects }
      : {}),
    ...(process.env.EDEN_EVE_CONTAINER_SLEEP_AFTER === undefined
      ? {}
      : { containerSleepAfter: process.env.EDEN_EVE_CONTAINER_SLEEP_AFTER }),
  };
  let hostConfig: EveHostConfig;
  try {
    hostConfig = createEveHostConfig({
      ...baseConfigRequest,
    });
  } catch (error: unknown) {
    throw deploymentFailure(
      "EVE_HOST_CONFIG_INVALID",
      error instanceof Error
        ? error.message
        : "The exact Eve Worker/Container host configuration was invalid.",
    );
  }
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
  /** Publishes one wrangler config; returns its terminal result. */
  const publishOne = async (
    request: EveDeploymentPublicationRequest,
  ): Promise<EveDeploymentPublicationResult> =>
    (options.publish ?? defaultPublicationRunner())(request);
  let publication: EveDeploymentPublicationResult;
  const writeFailureRecord = async (
    status: EveDeploymentStatus,
    evidence: string,
  ): Promise<void> => {
    try {
      await writeEveDeploymentRecord(candidate, identity, hostConfig, status, {
        evidence,
      });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };
  await writeEveDeploymentRecord(candidate, identity, hostConfig, "indeterminate",
    { evidence: "publication-intent" }, "deployment-intent.json");
  try {
    eveProgress(options, "publishing Worker and Container application");
    publication = await publishOne(publicationRequest);
  } catch (error: unknown) {
    const reason = error instanceof Error ? safeText(error.message) : "Publication threw before a terminal result.";
    await writeFailureRecord("indeterminate", reason);
    const deployment = deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason, evidenceLocation: candidate.generationRoot });
    return {
      ...collected.result,
      ok: false,
      deployment,
    };
  }
  if (publication.status === "indeterminate") {
    await writeFailureRecord("indeterminate", safeText(publication.reason));
    const deployment = deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: safeText(publication.reason), evidenceLocation: candidate.generationRoot });
    if (publication.containerSettingsUnapplied === true) {
      // A first deploy: Cloudflare had no such target, and this project never
      // promoted one. A CURRENT that exists or cannot be checked is not that.
      const neverPromoted = operation === "create" && await lstat(
        join(request.projectRoot, ".eden", "eve-deploy", "targets", `${request.environment}-${request.name}`, "CURRENT"),
      ).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      containerSettingsUnapplied.set(deployment, CONTAINER_SETTINGS_UNAPPLIED_INSPECTION +
        (neverPromoted ? CONTAINER_SETTINGS_UNAPPLIED_FIRST_DEPLOY : ""));
    }
    return {
      ...collected.result,
      ok: false,
      deployment,
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
        deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: safeText(publication.reason) + " Resource ownership is unproven.", evidenceLocation: candidate.generationRoot }),
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
        deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: safeText(publication.reason) + " Exact compensation is unavailable.", evidenceLocation: candidate.generationRoot }),
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
          deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: safeText(publication.reason) + " Exact compensation was not proven.", evidenceLocation: candidate.generationRoot }),
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
      deployment: deploymentMetadata(identity, targetKey, "failed", operation, superseded, { reason: publication.status === "failed" ? safeText(publication.reason) : "Publication identity did not match the immutable candidate.", evidenceLocation: candidate.generationRoot }),
    };
  }

  let health: EveDeploymentHealthResult;
  try {
    eveProgress(options, `verifying health at ${stableWorkersDevOrigin}`);
    health = await (options.health ?? defaultHealthRunner())({
      identity,
      origin: stableWorkersDevOrigin,
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? safeText(error.message) : "Health verification threw before a terminal result.";
    await writeEveDeploymentRecord(
      candidate,
      identity,
      hostConfig,
      "indeterminate",
      { evidence: reason },
    );
    return {
      ...collected.result,
      ok: false,
      deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason, evidenceLocation: candidate.generationRoot }),
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
      deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: safeText(health.reason), evidenceLocation: candidate.generationRoot }),
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
        deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: (health.status === "failed" ? safeText(health.reason) : "Health identity did not match the immutable candidate.") + " Resource ownership is unproven.", evidenceLocation: candidate.generationRoot }),
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
        deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: (health.status === "failed" ? safeText(health.reason) : "Health identity did not match the immutable candidate.") + " Exact compensation is unavailable.", evidenceLocation: candidate.generationRoot }),
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
          deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: (health.status === "failed" ? safeText(health.reason) : "Health identity did not match the immutable candidate.") + " Exact compensation was not proven.", evidenceLocation: candidate.generationRoot }),
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
      deployment: deploymentMetadata(identity, targetKey, "failed", operation, superseded, { reason: health.status === "failed" ? safeText(health.reason) : "Health identity did not match the immutable candidate.", evidenceLocation: candidate.generationRoot }),
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
          deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: (error instanceof Error ? safeText(error.message) : "Candidate inputs changed after health.") + " Exact compensation was not proven.", evidenceLocation: candidate.generationRoot }),
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
        deployment: deploymentMetadata(identity, targetKey, "failed", operation, superseded, { reason: error instanceof Error ? safeText(error.message) : "Candidate inputs changed after health.", evidenceLocation: candidate.generationRoot }),
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
      deployment: deploymentMetadata(identity, targetKey, "indeterminate", operation, superseded, { reason: error instanceof Error ? safeText(error.message) : "Candidate inputs changed after health without exact compensation.", evidenceLocation: candidate.generationRoot }),
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
    `${request.environment}-${request.name}`,
    candidate.generationRoot,
  );
  onPromotion({
    ...collected.result,
    deployment: deploymentMetadata(identity, targetKey, "deployed", operation, superseded, {
      reason: "The deployment is healthy and promoted.",
      evidenceLocation: candidate.generationRoot,
    }),
  });
  await options.afterPromotion?.();
  let supersededImageCleanup: EvePreflightCheck | undefined;
  const registryObjectsKept: EveRegistryObjectKept[] = [];
  // Cleanup deletes every manifest of a repository, so it must never run on
  // a repository that the promoted image, or a version still kept, lives in.
  // An image that Eden cannot place in a repository protects them all.
  const holdsLiveImage = (repository: string): boolean =>
    [identity.containerImage, ...Object.values(identity.retainedDeployments ?? {}).map((kept) => kept.image)]
      .some((image) => (managedImage(image, accountId)?.repository ?? repository) === repository);
  if (affinityEnabled && Object.keys(retiringDeployments).length > 0) {
    const ids = Object.keys(retiringDeployments);
    const completedRetirements: string[] = [];
    try {
      const result = await (options.deploymentRpc ?? defaultDeploymentRpc)({
        origin: stableWorkersDevOrigin, operation: "deployments.retire", deploymentIds: ids,
        controlToken,
      });
      if (typeof result !== "object" || result === null ||
          !("retired" in result) || !Array.isArray(result.retired) ||
          ids.some((id) => !(result.retired as unknown[]).includes(id))) throw new Error("Retirement was not proven.");
      const deleteRegistryRepository = options.deleteRegistryRepository ?? registryRepositoryDeleter();
      const held: string[] = [];
      for (const [id, retained] of Object.entries(retiringDeployments)) {
        const repository = ownedRegistryRepository({
          ...identity, deploymentId: id, containerImage: retained.image, generationId: retained.generationId,
        }, request.environment, request.name, accountId);
        if (repository !== undefined) {
          if (holdsLiveImage(repository)) {
            // This retirement stays pending; the others still get their cleanup.
            held.push(repository);
            continue;
          }
          const deleted = await deleteRegistryRepository({ repository, accountId });
          if (typeof deleted === "object") registryObjectsKept.push(...deleted.kept);
          if (deleted === "indeterminate" || (typeof deleted === "object" && deleted.unproven === true)) {
            throw new Error(`Repository deletion was not proven: ${repository}`);
          }
        }
        completedRetirements.push(id);
      }
      if (held.length > 0) {
        throw new Error(held.map((repository) =>
          `Repository ${repository} holds an image that is still deployed; nothing in it was deleted.`
        ).join(" "));
      }
      supersededImageCleanup = check("VAL-LIFE-007", "passed", registryObjectsKept.length === 0
        ? "Retired deployment instances and their owned registry repositories were removed."
        : "Retired deployment instances were removed, and everything else in their owned registry repositories. Cloudflare's registry still lists some of their objects; see EVE_REGISTRY_OBJECTS_KEPT.");
    } catch (error: unknown) {
      const reason = error instanceof Error ? safeText(error.message) : "Unknown retirement failure.";
      supersededImageCleanup = check("VAL-LIFE-007", "failed", `The deployment is healthy, but resource retirement was not proven: ${reason} Exact pending retirement records were retained for retry.`, RETIREMENT_PENDING_REMEDIATION);
    }
    if (completedRetirements.length > 0) {
      // Keep the immutable deployment record as evidence, but exclude proven
      // cleanup from the next deploy's active retry set.
      await writeFile(join(candidate.generationRoot, "completed-retirements.json"),
        `${JSON.stringify(completedRetirements)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }
  if (isUpdate && !affinityEnabled) {
    // The superseded generation's registry repository is generation-scoped
    // and no longer referenced once CURRENT promotes this generation; only
    // then is it safe to delete. Every tag and manifest digest the registry
    // lists in it is deleted; objects Cloudflare keeps are reported.
    const previousRepository = priorIdentity === undefined
      ? undefined
      : ownedRegistryRepository(
        priorIdentity,
        request.environment,
        request.name,
        accountId,
      );
    if (previousRepository !== undefined && holdsLiveImage(previousRepository)) {
      supersededImageCleanup = check(
        "VAL-LIFE-007",
        "skipped",
        `The superseded generation's registry repository ${previousRepository} also holds the promoted image, so nothing in it was deleted.`,
      );
    } else if (previousRepository !== undefined) {
      eveProgress(
        options,
        `deleting superseded registry repository ${previousRepository}`,
      );
      let deleted: EveRegistryRepositoryDeleteOutcome = "indeterminate";
      try {
        deleted = await (options.deleteRegistryRepository ??
          registryRepositoryDeleter())({ repository: previousRepository, accountId });
      } catch {
        deleted = "indeterminate";
      }
      if (typeof deleted === "object") {
        registryObjectsKept.push(...deleted.kept);
        if (deleted.unproven === true) deleted = "indeterminate";
      }
      supersededImageCleanup = deleted === "indeterminate"
        ? check(
          "VAL-LIFE-007",
          "failed",
          `The update is healthy and promoted, but the superseded registry repository ${previousRepository} could not be proven deleted.`,
          `Remove only what the registry still lists in the recorded repository ${previousRepository}, tags and sha256: entries; see VAL-LIFE-007 in docs/troubleshooting.md. Do not retry or run broad registry cleanup.`,
        )
        : check(
          "VAL-LIFE-007",
          "passed",
          deleted === "deleted"
            ? "Everything the registry listed in the superseded generation's registry repository was deleted after promotion."
            : deleted === "absent"
            ? "The superseded generation's registry repository was already absent."
            : "Everything else in the superseded generation's registry repository was deleted after promotion. Cloudflare's registry still lists some of its objects; see EVE_REGISTRY_OBJECTS_KEPT.",
        );
    }
  }
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
  const postPromotionChecks = [
    ...(supersededImageCleanup === undefined ? [] : [supersededImageCleanup]),
    ...(runtimeImageCleanup === undefined ? [] : [runtimeImageCleanup]),
  ];
  return {
    ...collected.result,
    ...(registryObjectsKept.length === 0 ? {} : {
      warnings: [...collected.result.warnings, registryObjectsKeptWarning(registryObjectsKept)],
      registryObjectsKept,
    }),
    ok: runtimeImageCleanup?.status !== "failed" &&
      supersededImageCleanup?.status !== "failed",
    ...(postPromotionChecks.length === 0
      ? {}
      : { checks: [...collected.result.checks, ...postPromotionChecks] }),
    deployment: deploymentMetadata(identity, targetKey, "deployed", operation, superseded, { reason: postPromotionChecks.some((value) => value.status === "failed") ? "The deployment is live, but post-promotion cleanup failed." : "The deployment is healthy and promoted.", evidenceLocation: candidate.generationRoot }),
  };
}

async function collectEvePreflight(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions,
): Promise<EvePreflightCollection> {
  let runtimeConfig: EveRuntimeConfig | undefined;
  let envFileRead = true;
  const warnings: EvePreflightWarning[] = [];
  const checks: EvePreflightCheck[] = [];
  if (request.envFile !== undefined) {
    eveProgress(options, "validating environment file");
  }
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
      warnings.push(
        ...(await collectEveWorldWarnings(undefined, runtimeConfig)),
      );
    }
  } catch (error: unknown) {
    envFileRead = false;
    checks.push(
      error instanceof EveRuntimeConfigError
        ? check(
          "VAL-SEC-001",
          "failed",
          `${error.code}: ${error.message}`,
          error.remediation,
        )
        : check(
          "VAL-SEC-001",
          "failed",
          "The explicit environment file could not be validated safely.",
          "Fix the explicit environment file through the documented opaque grammar, then retry.",
        ),
      blockedAfterFailure(
        "VAL-SEC-002",
        "Reserved-name validation was blocked because explicit environment validation failed.",
      ),
    );
  }

  // Everything Eden can know without building is reported in this one run.
  const sandboxProvider = await checkEveSandboxProvider(request.projectRoot);
  for (const failure of [await checkEveVersion(request.projectRoot), sandboxProvider]) {
    if (failure !== undefined) {
      checks.push(check(
        failure.code,
        "failed",
        failure.message,
        failure.remediation,
      ));
    }
  }
  warnings.push(
    ...(await collectEveSetupWarnings(
      request.projectRoot,
      envFileRead && !gatewayKeySupplied(runtimeConfig),
    )).filter((warning) =>
      // The failed sandbox check already says to install just-bash.
      sandboxProvider === undefined || warning.id !== "EVE_JUST_BASH_MISSING"
    ),
  );
  if (options.cloudflareRead === undefined) {
    eveProgress(options, "checking Cloudflare access");
    const access = await defaultCloudflareAccess(request.name);
    if (
      access.accountAccess === "unavailable" ||
      access.containerAccess === "unavailable"
    ) {
      checks.push(cloudflareAccessBlocked(access));
    }
  }
  if (!allChecksClear(checks)) {
    return {
      result: {
        command: request.command === "deploy" ? "eden deploy" : "eden preflight",
        ok: false,
        environment: request.environment,
        name: request.name,
        checks,
        warnings,
        candidate: null,
      },
      runtimeConfig,
    };
  }

  eveProgress(
    options,
    "packaging project — snapshot, frozen install, eve build",
  );

  const nodeImage = options.nodeImage ?? DEFAULT_EVE_NODE_IMAGE;
  const artifactRoot = join(
    request.projectRoot,
    ".eden",
    "eve-deploy",
    "generations",
    options.generationId ?? `preflight-${randomUUID()}`,
  );
  let packaging: EveProjectPackagingResult;
  const builder = options.builder ??
    createDockerEveProjectBuilder({ nodeImage });
  try {
    // One plain directory name that can also be part of an image repository
    // name: anything else would put the record where destroy does not look.
    if (options.generationId !== undefined && !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(options.generationId)) {
      throw new Error("The generation id must be a single plain directory name.");
    }
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
        "The Cloudflare access check after the build was blocked because no immutable candidate was produced.",
      ),
      blockedAfterFailure(
        "VAL-CLI-007-TARGET-CONFLICT",
        "Exact target conflict checks were blocked because no immutable candidate was produced.",
      ),
    );
    return {
      result: {
        command: request.command === "deploy" ? "eden deploy" : "eden preflight",
        ok: false,
        environment: request.environment,
        name: request.name,
        checks,
        warnings,
        candidate: null,
      },
      runtimeConfig,
    };
  }

  const candidate = packaging.candidate;
  const workflowWorld = await readCompiledWorldSpecifier(candidate);
  if (workflowWorld === "@moinulmoin/eden-world-cloudflare") {
    checks.push(check("EVE-WORLD", "passed", "world: Cloudflare Durable Object"));
  }
  // Compiled configuration supersedes the early source hints.
  for (const id of ["EVE_WORLD_LOCAL", "EVE_AI_GATEWAY_KEY_MISSING"]) {
    const hint = warnings.findIndex((warning) => warning.id === id);
    if (hint !== -1) warnings.splice(hint, 1);
  }
  warnings.push(
    ...(await collectEveWorldWarnings(candidate, undefined)),
  );
  warnings.push(...await collectEveGatewayWarnings(candidate, runtimeConfig));
  const schedules = await readCompiledSchedules(candidate);
  const expressible = schedules.filter(
    (schedule) => parseEveScheduleCron(schedule.cron) !== undefined,
  );
  const unexpressible = schedules.filter(
    (schedule) => parseEveScheduleCron(schedule.cron) === undefined,
  );
  if (unexpressible.length > 0) {
    warnings.push({
      id: "EVE_SCHEDULE_UNSUPPORTED",
      message:
        `Schedule ${unexpressible.map((schedule) => schedule.name).join(", ")} uses a cron expression Cloudflare wake triggers cannot evaluate, so it only fires while the Container is already awake.`,
      remediation:
        "Use a standard 5-field cron expression (minute hour day-of-month month day-of-week) for schedules that must fire while the Container sleeps.",
    });
  }
  if (expressible.length > 0) {
    checks.push(
      check(
        "EVE-SCHEDULES",
        "passed",
        `schedules: ${expressible.length} (wake via Cloudflare Cron)`,
      ),
    );
  }
  const worldPairing = await checkEveWorldPairing(candidate, workflowWorld);
  if (worldPairing !== undefined) checks.push(worldPairing);
  if (!allChecksClear(checks)) {
    await discardPackagingImage();
    return {
      result: {
        command: request.command === "deploy" ? "eden deploy" : "eden preflight",
        ok: false,
        environment: request.environment,
        name: request.name,
        checks,
        warnings,
        candidate: candidateMetadata(candidate, undefined),
      },
      runtimeConfig,
    };
  }
  let cloudflare: EveCloudflareReadResult | undefined;
  let publicOrigin: string | undefined;
  let priorDeployment: EveDeploymentRecord | undefined;
  if (request.command === "deploy") {
    eveProgress(options, "checking Cloudflare access and exact target");
    try {
      cloudflare = await readEveCloudflareTarget(
        {
          projectId: packaging.project?.projectId ?? "unknown-project",
          sourceDigest: candidate.sourceDigest,
          projectRoot: request.projectRoot,
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
          "Confirm the account with npx wrangler@4.147.0 whoami, then retry; nothing was changed on Cloudflare.",
        ),
        blockedAfterFailure(
          "VAL-CLI-007-TARGET-CONFLICT",
          "The exact target conflict read was blocked because the read-only Cloudflare adapter failed.",
        ),
      );
      return {
        result: {
          command: "eden deploy",
          ok: false,
          environment: request.environment,
          name: request.name,
          checks,
          warnings,
          candidate: candidateMetadata(candidate, undefined),
        },
        runtimeConfig,
      };
    }
    checks.push(...cloudflareChecks(cloudflare));
    // An owned target also requires its immutable record so the update can
    // carry the published Durable Object history forward append-only.
    if (cloudflare.target.state === "owned") {
      const record = await readEveDeploymentRecord(
        request.projectRoot,
        request.environment,
        request.name,
        cloudflare.accountId,
        packaging.project?.projectId === "unknown-project"
          ? undefined
          : packaging.project?.projectId,
      );
      priorDeployment = record ?? undefined;
      if (record === undefined || record.durableObjects === undefined) {
        checks.push(
          check(
            "VAL-CLI-007-TARGET-CONFLICT",
            "failed",
            "The exact target is Eden-owned, but its immutable deployment record does not carry a readable Durable Object history.",
            "Re-run the last successful deploy generation or destroy the exact target; updating without the recorded migration history could diverge Durable Object declarations.",
          ),
        );
      }
    }
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
          command: "eden deploy",
          ok: false,
          environment: request.environment,
          name: request.name,
          checks,
          warnings,
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
    eveProgress(
      options,
      "building linux/amd64 runtime image, booting eve, checking health",
    );
    try {
      if (runtimeConfig !== undefined) {
        runtimeInjection = await prepareEveRuntimeInjection(runtimeConfig, {
          mode: "preflight",
        });
      }
      const runtimeRunner = options.runtimeRunner ?? defaultRuntimeRunner;
      runtimeEvidence = await runtimeRunner({
        candidate,
        nodeImage,
        hostRequirements,
        ...(publicOrigin === undefined ? {} : { publicOrigin }),
        retainImage: request.command === "deploy",
        ...(runtimeInjection === undefined ? {} : { runtimeInjection }),
        ...(workflowWorld === undefined ? {} : { workflowWorld }),
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
        IMAGE_ID_PATTERN.test(runtimeEvidence.imageDigest ?? "");
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
        command: request.command === "deploy" ? "eden deploy" : "eden preflight",
        ok: false,
        environment: request.environment,
        name: request.name,
        checks,
        warnings,
        candidate: candidateResult,
      },
      runtimeConfig,
    };
  }

  if (cloudflare === undefined) {
    eveProgress(options, "checking Cloudflare access and exact target");
    try {
      cloudflare = await readEveCloudflareTarget(
        {
          projectId: packaging.project?.projectId ?? "unknown-project",
          sourceDigest: candidate.sourceDigest,
          projectRoot: request.projectRoot,
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
          "Confirm the account with npx wrangler@4.147.0 whoami, then retry; nothing was changed on Cloudflare.",
        ),
        blockedAfterFailure(
          "VAL-CLI-007-TARGET-CONFLICT",
          "The exact target conflict read was blocked because the read-only Cloudflare adapter failed.",
        ),
      );
      return {
        result: {
          command: "eden preflight",
          ok: false,
          environment: request.environment,
          name: request.name,
          checks,
          warnings,
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
      command: request.command === "deploy" ? "eden deploy" : "eden preflight",
      ok: allChecksClear(checks),
      environment: request.environment,
      name: request.name,
      checks,
      warnings,
      candidate: candidateResult,
    },
    runtimeConfig,
    candidate,
    ...(packaging.project?.projectId === undefined
      ? {}
      : { projectId: packaging.project.projectId }),
    ...(runtimeEvidence === undefined ? {} : { runtimeEvidence }),
    // Only expressible schedules are wired into wake triggers; the rest were
    // reported as EVE_SCHEDULE_UNSUPPORTED and fire only while awake.
    schedules: expressible,
    cloudflare,
    ...(priorDeployment === undefined ? {} : { priorDeployment }),
    ...(workflowWorld === undefined ? {} : { workflowWorld }),
  };
}

export async function runEveControlPlane(
  callerRequest: EveCliExecutionRequest,
  callerOptions: EvePreflightOptions = {},
): Promise<void> {
  // The caller's callbacks run while Eden awaits and can change these objects.
  const request = Object.freeze({ ...callerRequest });
  const options = Object.freeze({ ...callerOptions });
  const startedAt = Date.now();
  if (humanOutput(options)) {
    emitLine(
      options,
      `eden ${request.command} — ${request.name} (${request.environment})`,
    );
  }
  let lock: EveTargetLock | undefined;
  let collected: EvePreflightCollection | undefined;
  let result: EvePreflightResult = {
    command: request.command === "deploy" ? "eden deploy" : "eden preflight",
    ok: false,
    environment: request.environment,
    name: request.name,
    checks: [],
    warnings: [],
    candidate: null,
  };
  let primaryError: unknown;
  let failed = false;
  let lockReleased = true;
  try {
    lock = request.command === "deploy"
      ? await acquireEveTargetLock(request.projectRoot, request.environment, request.name)
      : undefined;
    collected = await collectEvePreflight(request, options);
    result = collected.result;
    if (!result.ok) {
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
    if (request.command === "deploy") {
      const deploymentResult = await runEveDeployment(request, options, collected, (promoted) => {
        result = promoted;
      });
      result = deploymentResult;
      if (!deploymentResult.ok) {
        const status = deploymentResult.deployment?.status;
        const failedCleanup = deploymentResult.checks.filter((value) => value.status === "failed");
        const retirementPending = status === "deployed" &&
          failedCleanup.some((value) => value.remediation === RETIREMENT_PENDING_REMEDIATION);
        throw new EveCliError({
          // One instruction: the failed checks' own, so none contradicts another.
          ...(retirementPending
            ? { remediation: failedCleanup.flatMap((value) => value.remediation ?? []).join(" ") }
            : deploymentResult.deployment !== undefined && containerSettingsUnapplied.has(deploymentResult.deployment)
              ? { remediation: containerSettingsUnapplied.get(deploymentResult.deployment) as string }
              : {}),
          code: status === "indeterminate"
            ? "DEPLOY_INDETERMINATE"
            : status === "deployed"
              ? "EVE_RUNTIME_IMAGE_CLEANUP_FAILED"
              : "EVE_DEPLOYMENT_FAILED",
          message:
            status === "indeterminate"
              ? deploymentResult.deployment?.reason ?? "The Eve deployment outcome is indeterminate; inspect the retained exact ownership evidence before retrying."
              : retirementPending
                ? "The Eve deployment is healthy and promoted, but retiring old versions was not proven. A later successful deploy retries cleanup for versions still pending retirement; do not retry the deployment for this."
              : status === "deployed"
                ? "The Eve deployment is healthy and promoted, but exact image cleanup failed; do not retry the deployment."
              : deploymentResult.deployment?.reason ?? "The Eve deployment failed before exact target promotion.",
        });
      }
    }
  } catch (error: unknown) {
    failed = true;
    primaryError = error;
  } finally {
    try {
      collected?.runtimeConfig?.dispose();
    } catch (error: unknown) {
      if (!failed) primaryError = error;
      failed = true;
    }
    try {
      lockReleased = lock === undefined || await releaseEveTargetLock(lock);
    } catch (error: unknown) {
      if (!failed) primaryError = error;
      failed = true;
      lockReleased = false;
    }
  }
  if (!lockReleased) {
    primaryError = new EveCliError({
      code: "EVE_DEPLOY_LOCK_RELEASE_UNPROVEN",
      message:
        "The Eve deployment lock could not be released with exact ownership proof; local residue was retained.",
      source: "deployment-lock",
    });
    failed = true;
  }
  if (result !== undefined) {
    if (failed) {
      const error = eveOutcomeError(primaryError, `eden ${request.command}`);
      result = {
        ...result,
        ok: false,
        error,
        ...(error.code === "DEPLOY_INDETERMINATE" && result.deployment === undefined
          ? { deployment: {
            status: "indeterminate" as const,
            reason: error.message,
            evidenceRetained: true as const,
            evidenceLocation: collected?.candidate?.generationRoot ?? join(request.projectRoot, ".eden"),
          } }
          : {}),
      };
    }
    emitEveResult(options, result, startedAt, collected?.candidate?.eveVersion);
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
  /** Present with `EVE_REGISTRY_OBJECTS_KEPT` when Cloudflare kept registry objects. */
  readonly warnings?: readonly EvePreflightWarning[];
  /** What Cloudflare's registry still lists after Eden's delete. */
  readonly registryObjectsKept?: readonly EveRegistryObjectKept[];
  readonly error?: EveOutcomeError;
}

interface EveDestroyRecord {
  readonly identity: {
    readonly projectId?: unknown;
    readonly generationId?: unknown;
    readonly workerName?: unknown;
    readonly containerApplicationName?: unknown;
    readonly stableContainerInstanceName?: unknown;
    readonly containerImage?: unknown;
    readonly deploymentId?: unknown;
    readonly eveVersion?: unknown;
    readonly affinityContract?: unknown;
    readonly releaseId?: unknown;
    readonly retainedDeployments?: unknown;
    readonly pendingRetirements?: unknown;
    readonly runtimeRevisionHandle?: unknown;
    readonly accountId?: unknown;
    readonly environment?: unknown;
    readonly name?: unknown;
  };
}

type VerifiedEveDestroyIdentity = {
  readonly projectId?: string;
  readonly generationId?: string;
  readonly workerName: string;
  readonly containerApplicationName: string;
  readonly stableContainerInstanceName: string;
  readonly containerImage?: string;
  readonly deploymentId?: string;
  readonly eveVersion?: string;
  readonly affinityContract?: number;
  readonly releaseId?: string;
  readonly runtimeRevisionHandle?: string;
  readonly retainedDeployments?: Readonly<Record<string, EveAffinityDeployment>>;
  readonly pendingRetirements?: Readonly<Record<string, EveAffinityDeployment>>;
  readonly accountId: string;
  readonly environment: string;
  readonly name: string;
};

/**
 * What a target's CURRENT is right now: which file, and where it points.
 * Undefined when there is none. Two reads that return the same value saw
 * the same file.
 */
async function readEveTargetPointer(targetRoot: string): Promise<string | undefined> {
  const path = join(targetRoot, "CURRENT");
  const details = await lstat(path, { bigint: true }).catch(() => undefined);
  if (details === undefined) return undefined;
  const link = details.isSymbolicLink() ? await readlink(path).catch(() => "") : "";
  return `${details.dev}:${details.ino}:${details.ctimeNs}:${link}`;
}

const DESTROY_RECORD_OUTSIDE_PROJECT =
  "The target's deployment record is not inside this project's own .eden folder: a folder on the way to it is a symlink or could not be checked. Destroy does not follow it; nothing was read from or changed on Cloudflare.";

/**
 * True when the folders destroy reads and writes for a target are this
 * project's own: none is reached through a symlink. A folder that does not
 * exist yet passes; one that cannot be checked does not.
 */
async function eveDestroyFoldersLocal(
  projectRoot: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<boolean> {
  const deploymentRoot = join(projectRoot, ".eden", "eve-deploy");
  for (
    const directory of [
      dirname(deploymentRoot),
      deploymentRoot,
      join(deploymentRoot, "locks"),
      join(deploymentRoot, "targets", `${environment}-${name}`),
      join(deploymentRoot, "generations"),
    ]
  ) {
    const canonical = await realpath(directory).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? directory : undefined
    );
    if (canonical !== directory) return false;
  }
  return true;
}

/**
 * The target's deployment record, with CURRENT as it was when the record was
 * read. "outside-project" when a folder on the way to it, or the generation
 * CURRENT names, is reached through a symlink that leaves this project's
 * .eden folder: that record is not this project's, whatever it says.
 */
async function readEveDestroyRecord(
  projectRoot: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<
  | {
    readonly recordPath: string;
    readonly generationRoot: string;
    readonly identity: VerifiedEveDestroyIdentity;
    readonly pointer: string | undefined;
    /** True when CURRENT is the symlink that named this record. */
    readonly namedByPointer: boolean;
  }
  | "outside-project"
  | undefined
> {
  const deploymentRoot = join(projectRoot, ".eden", "eve-deploy");
  const targetRoot = join(deploymentRoot, "targets", `${environment}-${name}`);
  const generationsRoot = join(deploymentRoot, "generations");
  if (!await eveDestroyFoldersLocal(projectRoot, environment, name)) return "outside-project";
  const pointer = await readEveTargetPointer(targetRoot);
  const current = await lstat(join(targetRoot, "CURRENT")).catch(
    () => undefined,
  );
  const generationRoot = current?.isSymbolicLink()
    ? await realpath(join(targetRoot, "CURRENT")).catch(() => undefined)
    : undefined;
  if (generationRoot === undefined) {
    const found = await readEveDestroyRecordFromGenerations(
      projectRoot,
      environment,
      name,
    );
    // A CURRENT that is no symlink to a generation did not name this record.
    return found === undefined ? undefined : { ...found, pointer, namedByPointer: false };
  }
  if (dirname(generationRoot) !== generationsRoot) return "outside-project";
  const parsed = await parseEveDestroyRecord(
    await deploymentRecordPath(generationRoot),
    environment,
    name,
  );
  return parsed === undefined
    ? undefined
    : { ...parsed, generationRoot, pointer, namedByPointer: true };
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
      await deploymentRecordPath(generationRoot),
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
      await deploymentRecordPath(generationRoot),
      environment,
      name,
    );
    if (parsed !== undefined) {
      return { ...parsed, generationRoot };
    }
  }
  return undefined;
}

/**
 * The text of a deployment evidence file, only when it is a regular file in
 * a generation directory that is itself a real directory. A symlink at
 * either place could stand another project's record in for this one's.
 */
async function readEvidenceFile(path: string): Promise<string | undefined> {
  const [directory, file] = await Promise.all([
    lstat(dirname(path)).catch(() => undefined),
    lstat(path).catch(() => undefined),
  ]);
  if (directory?.isDirectory() !== true || file?.isFile() !== true) return undefined;
  return readFile(path, "utf8").catch(() => undefined);
}

async function parseEveDestroyRecord(
  recordPath: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<{
  readonly recordPath: string;
  readonly identity: VerifiedEveDestroyIdentity;
} | undefined> {
  const raw = await readEvidenceFile(recordPath);
  if (raw === undefined) return undefined;
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
  const metadata: Partial<VerifiedEveDestroyIdentity> = {};
  for (const key of ["deploymentId", "eveVersion", "releaseId", "runtimeRevisionHandle"] as const) {
    if (typeof identity[key] === "string") Object.assign(metadata, { [key]: identity[key] });
  }
  if (typeof identity.affinityContract === "number") Object.assign(metadata, { affinityContract: identity.affinityContract });
  for (const key of ["retainedDeployments", "pendingRetirements"] as const) {
    const value = identity[key];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    for (const [id, deployment] of Object.entries(value)) {
      if (!/^(?:eden-cloudflare|eden-affinity-[a-f0-9]{24}(?:-[a-f0-9]{8})?)$/u.test(id) ||
          typeof deployment !== "object" || deployment === null ||
          typeof deployment.image !== "string" || imageDigestFromReference(deployment.image) === undefined ||
          typeof deployment.generationId !== "string" ||
          (deployment.eveVersion !== undefined && typeof deployment.eveVersion !== "string") ||
          (deployment.affinityContract !== undefined && typeof deployment.affinityContract !== "number") ||
          (deployment.releaseId !== undefined && typeof deployment.releaseId !== "string") ||
          (deployment.worldRpcAuth !== undefined && typeof deployment.worldRpcAuth !== "boolean") ||
          (deployment.runtimeRevisionHandle !== undefined && typeof deployment.runtimeRevisionHandle !== "string")) return undefined;
    }
    Object.assign(metadata, { [key]: value });
  }
  const verified: VerifiedEveDestroyIdentity = {
    ...metadata,
    workerName: identity.workerName as string,
    containerApplicationName: identity.containerApplicationName as string,
    stableContainerInstanceName:
      identity.stableContainerInstanceName as string,
    accountId: identity.accountId as string,
    environment,
    name,
    ...(typeof identity.projectId === "string" && identity.projectId.length > 0
      ? { projectId: identity.projectId }
      : {}),
    ...(typeof identity.generationId === "string" &&
        identity.generationId.length > 0
      ? { generationId: identity.generationId }
      : {}),
    ...(typeof identity.containerImage === "string" &&
        identity.containerImage.length > 0
      ? { containerImage: identity.containerImage }
      : {}),
  };
  return {
    recordPath,
    identity: verified,
  };
}

/**
 * The immutable deployment record an in-place update reads back: the exact
 * identity plus the published Worker's Durable Object bindings, migration
 * history, and whether the previous generation selected the Cloudflare World.
 */
interface EveDeploymentRecord {
  readonly recordPath: string;
  readonly generationRoot: string;
  readonly identity: VerifiedEveDestroyIdentity;
  readonly status: EveDeploymentStatus | undefined;
  /** Every deploymentId this target's records have ever published, used to prove a live remote Worker is one Eden deployed. */
  readonly deploymentIds: readonly string[];
  /** Every per-publish release ID this target's records hold (the deploymentId for records that predate release IDs). */
  readonly releaseIds: readonly string[];
  readonly protectedDeploymentIds?: readonly string[];
  /** True when the recorded Worker carried `EDEN_EVE_WORLD_CLOUDFLARE`. */
  readonly worldCloudflare: boolean;
  /**
   * The Durable Object bindings and migration history of the newest record
   * that carries them — even a `failed`/`indeterminate` one. A failed update
   * may already have published its migration tags before health failed, so
   * the next update must never regress to an older, CURRENT-pinned history
   * (wrangler rejects old_tag > new_tag and would re-emit
   * `new_sqlite_classes` for a live class). `undefined` means no record
   * carries a readable history; the update then fails closed.
   */
  readonly durableObjects:
    | {
      readonly bindings: readonly EveDurableBinding[];
      readonly migrations: readonly EveDurableMigration[];
    }
    | undefined;
}

/**
 * Reads the immutable records for this target. The live identity comes from
 * CURRENT first, then the newest `deployed` record, then the newest record
 * of any status; the Durable Object history comes from the newest record
 * that carries one, healthy or not, so a failed update's published tags are
 * never dropped.
 */
async function readEveDeploymentRecord(
  projectRoot: string,
  environment: EveCliEnvironment,
  name: string,
  accountId?: string,
  projectId?: string,
): Promise<EveDeploymentRecord | undefined> {
  const targetsRoot = join(
    projectRoot,
    ".eden",
    "eve-deploy",
    "targets",
    `${environment}-${name}`,
  );
  const generationsRoot = join(
    projectRoot,
    ".eden",
    "eve-deploy",
    "generations",
  );
  const entries = await readdir(generationsRoot).catch(() => []);
  const scanned: {
    readonly record: Omit<
      EveDeploymentRecord,
      "generationRoot" | "deploymentIds" | "releaseIds"
    > & { readonly deploymentId?: string | undefined };
    readonly generationRoot: string;
    readonly modifiedAt: number;
  }[] = [];
  const deploymentIds = new Set<string>();
  const releaseIds = new Set<string>();
  for (const entry of entries) {
    const generationRoot = join(generationsRoot, entry);
    const recordPath = await deploymentRecordPath(generationRoot);
    const details = await lstat(recordPath).catch(() => undefined);
    if (details === undefined || !details.isFile()) continue;
    const parsed = await parseEveDeploymentRecord(
      recordPath,
      environment,
      name,
    );
    if (parsed !== undefined) {
      // Only records for this account and (when known) this project may
      // arbitrate ownership or supply migration history.
      if (
        (accountId !== undefined && parsed.identity.accountId !== accountId) ||
        (projectId !== undefined && parsed.identity.projectId !== projectId)
      ) {
        continue;
      }
      scanned.push({
        record: parsed,
        generationRoot,
        modifiedAt: details.mtimeMs,
      });
      const deploymentId = parsed.deploymentId;
      if (deploymentId !== undefined) deploymentIds.add(deploymentId);
      const releaseId = parsed.identity.releaseId ?? deploymentId;
      if (releaseId !== undefined) releaseIds.add(releaseId);
    }
  }
  scanned.sort((left, right) => right.modifiedAt - left.modifiedAt);

  const current = await lstat(join(targetsRoot, "CURRENT")).catch(
    () => undefined,
  );
  let live = scanned.find(
    (entry) => entry.record.status === "deployed",
  ) ?? scanned[0];
  if (current !== undefined && current.isSymbolicLink()) {
    const generationRoot = await realpath(join(targetsRoot, "CURRENT")).catch(
      () => undefined,
    );
    if (generationRoot !== undefined) {
      const pinned = scanned.find(
        (entry) => entry.generationRoot === generationRoot,
      );
      if (pinned !== undefined) {
        live = pinned;
      } else {
        const parsed = await parseEveDeploymentRecord(
          await deploymentRecordPath(generationRoot),
          environment,
          name,
        );
        if (
          parsed !== undefined &&
          !(
            (accountId !== undefined &&
              parsed.identity.accountId !== accountId) ||
            (projectId !== undefined &&
              parsed.identity.projectId !== projectId)
          )
        ) {
          live = { record: parsed, generationRoot, modifiedAt: 0 };
        }
      }
    }
  }
  if (live === undefined) return undefined;
  // Newest record carrying a usable DO history wins, regardless of its
  // deployment outcome: a tag it published must never be replayed.
  const historySource = scanned.find(
    (entry) => entry.record.durableObjects !== undefined,
  );
  // CURRENT is only a health/promotion pointer. A newer uncertain publication
  // may already serve sessions; preserve every such image until a later deploy
  // can prove it drained, never infer absence from a failed health check.
  const unresolved = scanned.filter((entry) => entry.modifiedAt > live.modifiedAt);
  const retainedDeployments = { ...live.record.identity.retainedDeployments };
  const pendingRetirements = { ...live.record.identity.pendingRetirements };
  const protectedDeploymentIds = new Set<string>();
  if (live.record.identity.retainedDeployments === undefined) {
    protectedDeploymentIds.add("eden-cloudflare");
  }
  for (const entry of unresolved.slice().reverse()) {
    Object.assign(retainedDeployments, entry.record.identity.retainedDeployments);
    Object.assign(pendingRetirements, entry.record.identity.pendingRetirements);
    if (entry.record.deploymentId !== undefined) protectedDeploymentIds.add(entry.record.deploymentId);
  }
  return {
    recordPath: live.record.recordPath,
    generationRoot: live.generationRoot,
    identity: {
      ...live.record.identity,
      ...(Object.keys(retainedDeployments).length === 0 ? {} : { retainedDeployments }),
      ...(Object.keys(pendingRetirements).length === 0 ? {} : { pendingRetirements }),
    },
    protectedDeploymentIds: [...protectedDeploymentIds],
    status: live.record.status,
    deploymentIds: [...deploymentIds],
    releaseIds: [...releaseIds],
    worldCloudflare: live.record.worldCloudflare,
    durableObjects: historySource?.record.durableObjects,
  };
}

async function parseEveDeploymentRecord(
  recordPath: string,
  environment: EveCliEnvironment,
  name: string,
): Promise<(Omit<
  EveDeploymentRecord,
  "generationRoot" | "deploymentIds" | "releaseIds"
> & { readonly deploymentId?: string | undefined }) | undefined> {
  const base = await parseEveDestroyRecord(recordPath, environment, name);
  if (base === undefined) return undefined;
  let identity = base.identity;
  try {
    const completed: unknown = JSON.parse(await readFile(join(dirname(recordPath), "completed-retirements.json"), "utf8"));
    if (Array.isArray(completed) && completed.every((id) => typeof id === "string")) {
      const pendingRetirements = { ...identity.pendingRetirements };
      for (const id of completed) delete pendingRetirements[id];
      identity = { ...identity, pendingRetirements };
    }
  } catch {
    // Missing or unreadable cleanup evidence must not suppress a retry.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as {
    readonly status?: unknown;
    readonly worker?: unknown;
  };
  const identityRaw = (parsed as { readonly identity?: unknown }).identity;
  const deploymentId = typeof identityRaw === "object" &&
      identityRaw !== null &&
      typeof (identityRaw as { readonly deploymentId?: unknown })
        .deploymentId === "string"
    ? (identityRaw as { readonly deploymentId: string }).deploymentId
    : undefined;
  const status = typeof record.status === "string" &&
    ["deployed", "failed", "indeterminate"].includes(record.status)
    ? record.status as EveDeploymentStatus
    : undefined;
  const worker = typeof record.worker === "object" && record.worker !== null
    ? record.worker
    : undefined;
  const rawBindings = worker !== undefined && "durable_objects" in worker &&
      typeof worker.durable_objects === "object" &&
      worker.durable_objects !== null &&
      "bindings" in worker.durable_objects
    ? (worker.durable_objects as { readonly bindings: unknown }).bindings
    : undefined;
  const rawMigrations = worker !== undefined && "migrations" in worker
    ? worker.migrations
    : undefined;
  const rawVars = worker !== undefined && "vars" in worker &&
      typeof worker.vars === "object" && worker.vars !== null
    ? worker.vars as { readonly EDEN_EVE_WORLD_CLOUDFLARE?: unknown }
    : undefined;
  const bindings: EveDurableBinding[] = [];
  const migrations: EveDurableMigration[] = [];
  const durableObjectsValid = Array.isArray(rawBindings) &&
    Array.isArray(rawMigrations);
  const invalidHistory = () => ({
    recordPath,
    identity,
    status,
    deploymentId,
    worldCloudflare: rawVars?.EDEN_EVE_WORLD_CLOUDFLARE === true,
    durableObjects: undefined,
  });
  if (durableObjectsValid) {
    for (const binding of rawBindings as readonly unknown[]) {
      if (
        typeof binding !== "object" || binding === null ||
        typeof (binding as EveDurableBinding).name !== "string" ||
        typeof (binding as EveDurableBinding).class_name !== "string"
      ) {
        return invalidHistory();
      }
      bindings.push(binding as EveDurableBinding);
    }
    for (const migration of rawMigrations as readonly unknown[]) {
      if (
        typeof migration !== "object" || migration === null ||
        typeof (migration as EveDurableMigration).tag !== "string" ||
        !Array.isArray(
          (migration as EveDurableMigration).new_sqlite_classes,
        ) ||
        ((migration as EveDurableMigration).new_sqlite_classes ?? []).some(
          (className: unknown) => typeof className !== "string",
        )
      ) {
        return invalidHistory();
      }
      migrations.push(migration as EveDurableMigration);
    }
  }
  return {
    recordPath,
    identity,
    status,
    deploymentId,
    worldCloudflare: rawVars?.EDEN_EVE_WORLD_CLOUDFLARE === true,
    durableObjects: durableObjectsValid ? { bindings, migrations } : undefined,
  };
}

async function defaultDestroyTargetRead(
  request: EveDestroyCloudflareReadRequest,
  registry: CloudflareRegistry,
): Promise<EveDestroyTargetRead> {
  const account = await readWranglerJson(["whoami", "--json"]);
  const accountId = authenticatedAccountId(account.value);
  if (accountId !== undefined && accountId !== request.accountId) {
    // A login for another account: nothing is read, and the caller refuses on the account.
    return { workerExists: false, accountId };
  }
  const { containerEntries: entries, worker } =
    await readExactTargetInventory(accountId, request.workerName, request.containerApplicationName);
  const workerExists = worker === "deployed" || worker === "undeployed";
  const firstContainer = entries === undefined ? undefined : entries[0];
  let registryTagsPresent: string[] | undefined;
  if (accountId !== undefined && (request.registryRepositories?.length ?? 0) > 0) {
    registryTagsPresent = [];
    for (const repository of request.registryRepositories ?? []) {
      const listed = await registry.list(accountId, repository);
      if (listed === undefined) {
        registryTagsPresent = undefined;
        break;
      }
      registryTagsPresent.push(...listed.map((entry) => registryRef(repository, entry)));
    }
  }
  return {
    workerExists,
    inventoryComplete: !account.failed && accountId !== undefined &&
      entries !== undefined && entries.length <= 1 && worker !== undefined,
    providerEvidence: await readProviderEvidence(
      request.workerName, accountId, workerExists, firstContainer,
    ),
    ...(firstContainer === undefined
      ? {}
      : { containerApplicationId: firstContainer.id }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(registryTagsPresent === undefined
      ? {}
      : { registryTagsPresent }),
  };
}

async function defaultWorkerDelete(
  request: { readonly name: string; readonly accountId: string },
): Promise<"deleted" | "absent" | "indeterminate"> {
  const result = await runWranglerWithInput(
    ["delete", "--name", request.name, "--force"],
    request.accountId,
    "y\n",
  );
  if (result.exitCode === 0) return "deleted";
  if (/(?:does not exist|not found|10007)/iu.test(result.stderr)) {
    return "absent";
  }
  return "indeterminate";
}

async function defaultContainerDelete(
  request: { readonly applicationId: string; readonly accountId: string },
): Promise<"deleted" | "absent" | "indeterminate"> {
  const result = await runWranglerWithInput(
    ["containers", "delete", request.applicationId],
    request.accountId,
  );
  if (result.exitCode === 0) return "deleted";
  if (/(?:does not exist|not found|not supported|10007)/iu.test(result.stderr)) {
    return "absent";
  }
  return "indeterminate";
}


const SNAPSHOT_RETENTION_DAYS = 30;
const CLOUDFLARE_REGISTRY_HOST = "registry.cloudflare.com";
/** The registry's answer to deleting a container snapshot, observed on 2026-11-18. */
const SNAPSHOT_DELETE_REFUSAL = "snapshot manifests cannot be deleted through this API";
/** The longest one command waits, in total, on registry requests that get no answer. */
const REGISTRY_UNANSWERED_BUDGET_MS = 60_000;
/** How long each accepted delete is given to leave the listing; a repository's cleanup can take longer. */
const REGISTRY_REMOVAL_WAIT_MS = 30_000;
/** How many times one repository's cleanup deletes entries it has not tried yet. */
const REGISTRY_DELETE_PASSES = 3;
/** How many entries Eden asks for in one page of a listing. */
const REGISTRY_PAGE_ENTRIES = 1_000;
/** A tag, or the `sha256:` entry the registry lists for each manifest. */
const REGISTRY_ENTRY = /^(?:sha256:[0-9a-f]{64}|[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/u;

/**
 * The value of a JSON text Cloudflare sent, or undefined when the text is
 * not that value written out again, spacing aside. `JSON.parse` keeps only
 * the last of two fields with one name, so a text that says a thing twice
 * would otherwise be read as saying it once.
 */
/**
 * True when an object in this JSON text names a field twice. JSON.parse
 * keeps only the last of the two, so such a text says two things at once.
 * The text must already have parsed.
 */
function namesFieldTwice(text: string): boolean {
  const objects: (Set<string> | undefined)[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "{") objects.push(new Set());
    else if (char === "[") objects.push(undefined);
    else if (char === "}" || char === "]") objects.pop();
    else if (char === '"') {
      const start = at;
      for (at += 1; text[at] !== '"'; at += 1) if (text[at] === "\\") at += 1;
      const names = objects.at(-1);
      let next = at + 1;
      while (" \t\n\r".includes(text[next] ?? "x")) next += 1;
      if (names === undefined || text[next] !== ":") continue;
      const name = JSON.parse(text.slice(start, at + 1)) as string;
      if (names.has(name)) return true;
      names.add(name);
    }
  }
  return false;
}

function exactJson(text: string): unknown {
  const squeezed = (value: string): string => value.replace(/\s/gu, "");
  try {
    const value: unknown = JSON.parse(text);
    return squeezed(JSON.stringify(value)) === squeezed(text) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The entries of one page of the registry's listing of a repository, read
 * from the answer to a GET of `path`. Empty for the page that ends the
 * listing. Undefined unless the answer is exactly what Cloudflare's registry
 * was seen to send on 2026-11-18:
 * - status 200 and the body `{"name":"<account>/<repository>","tags":[…]}`,
 *   with nothing else in it and neither field twice;
 * - each entry a tag or a `sha256:` digest, in ascending order, and after
 *   `after`, the last entry of the page before;
 * - a Link header that is the request's own URL with `?n=<n>&last=<cursor>`
 *   appended and `; rel=next`, where the cursor is this page's last entry,
 *   and empty exactly when the page is empty.
 * Every reader of the listing goes through this, so an answer that says
 * anything else, or contradicts itself, is never taken as a listing.
 */
function registryListingPage(
  response: { readonly status: number; readonly body: string; readonly link?: string } | undefined,
  path: string,
  name: string,
  after: string | undefined,
): readonly string[] | undefined {
  if (response?.status !== 200) return undefined;
  const listing = exactJson(response.body);
  if (typeof listing !== "object" || listing === null || Object.keys(listing).sort().join() !== "name,tags") {
    return undefined;
  }
  const { name: listed, tags } = listing as { readonly name: unknown; readonly tags: unknown };
  if (listed !== name || !Array.isArray(tags)) return undefined;
  let previous = after;
  for (const tag of tags as readonly unknown[]) {
    if (typeof tag !== "string" || !REGISTRY_ENTRY.test(tag) || (previous !== undefined && tag <= previous)) {
      return undefined;
    }
    previous = tag;
  }
  const next = `${path}?n=${REGISTRY_PAGE_ENTRIES}&last=${tags.length === 0 ? "" : previous}; rel=next`;
  return response.link === next || response.link === `https://${CLOUDFLARE_REGISTRY_HOST}${next}`
    ? tags as readonly string[]
    : undefined;
}

/** `repository:tag`, or `repository@sha256:…` for a manifest's own entry. */
function registryRef(repository: string, entry: string): string {
  return `${repository}${entry.startsWith("sha256:") ? "@" : ":"}${entry}`;
}

/**
 * The warning for registry objects Cloudflare still lists after Eden's
 * delete. Each object's class is the registry's own answer for that object.
 */
function registryObjectsKeptWarning(kept: readonly EveRegistryObjectKept[]): EvePreflightWarning {
  const counted = ([
    ["refused-snapshot", "it refused to delete as snapshots"],
    ["refused-singleton-artifact", "it refused to delete with SINGLETON_ARTIFACT_EXISTS"],
    ["accepted-still-listed", `whose delete it accepted and which it still listed at least ${REGISTRY_REMOVAL_WAIT_MS / 1_000} seconds later`],
  ] as const).flatMap(([name, answer]) => {
    const count = kept.filter((object) => object.class === name).length;
    return count === 0 ? [] : [`${count} ${answer} (${name})`];
  });
  return {
    id: "EVE_REGISTRY_OBJECTS_KEPT",
    message: `Cloudflare's registry still lists ${kept.length} object(s) that Eden tried to delete: ${counted.join("; ")}. Cloudflare documents that it removes a snapshot ${SNAPSHOT_RETENTION_DAYS} days after it was created or last restored. Eden does not know when Cloudflare removes the other objects, or whether any of them counts toward the account's image storage limit.`,
    remediation: "Eden reports the registry's answer to its delete of each of these objects; it does not know whether a later delete would be answered differently. A kept snapshot still holds the container's files until Cloudflare removes it. To see what the registry lists later, follow the EVE_REGISTRY_OBJECTS_KEPT entry in docs/troubleshooting.md.",
  };
}

/** True only for the registry's structured refusal to delete a snapshot manifest. */
function isSnapshotDeleteRefusal(status: number, body: string): boolean {
  if (status !== 403) return false;
  const parsed = exactJson(body);
  const errors = typeof parsed === "object" && parsed !== null
    ? (parsed as { readonly errors?: unknown }).errors
    : undefined;
  if (!Array.isArray(errors) || errors.length !== 1) return false;
  const error = errors[0] as { readonly code?: unknown; readonly message?: unknown } | null;
  return typeof error === "object" && error !== null &&
    error.code === "DENIED" && error.message === SNAPSHOT_DELETE_REFUSAL;
}

/**
 * True only for the registry's structured refusal to delete a chain
 * artifact, observed on 2026-11-18. The answer names the artifact type and
 * two digests. Neither digest is known to be the one in the request, so
 * this ties the refusal to the request it answered and to nothing else.
 */
function isSingletonArtifactRefusal(status: number, body: string): boolean {
  if (status !== 409) return false;
  const parsed = exactJson(body);
  if (typeof parsed !== "object" || parsed === null) return false;
  const refusal = parsed as Record<string, unknown>;
  return refusal.code === "SINGLETON_ARTIFACT_EXISTS" &&
    refusal.artifactType === "application/vnd.cloudchamber.btrfs-chain.v1" &&
    [refusal.subjectDigest, refusal.committedDigest].every((digest) =>
      typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest)
    );
}

/**
 * One request to Cloudflare's registry on a connection of its own: no proxy,
 * certificate verification on, no redirect followed, `timeoutMs` (a whole
 * number) for the whole exchange. Whatever the process-wide proxy or TLS
 * settings are, the credential goes only to the registry. The body is read
 * only for a status in `bodyFor`, and only up to `maxBytes`; any other
 * answer resolves at its headers.
 */
function registryRequest(
  method: "GET" | "DELETE",
  path: string,
  authorization: string,
  timeoutMs: number,
  bodyFor: readonly number[],
  maxBytes: number,
): Promise<{ readonly status: number; readonly body: string; readonly link?: string } | undefined> {
  return new Promise((resolve) => {
    const request = httpsRequest({
      host: CLOUDFLARE_REGISTRY_HOST,
      port: 443,
      method,
      path,
      headers: { Authorization: authorization, Accept: "application/json" },
      agent: new HttpsAgent({ keepAlive: false }),
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (!bodyFor.includes(status)) {
        resolve({ status, body: "" });
        request.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy();
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status,
        body: Buffer.concat(chunks).toString("utf8"),
        ...(typeof response.headers.link === "string" ? { link: response.headers.link } : {}),
      }));
      response.on("close", () => resolve(undefined));
    });
    request.on("error", () => resolve(undefined));
    request.end();
  });
}

interface CloudflareRegistry {
  /**
   * Every entry the registry lists for one repository: its tags, and one
   * `sha256:` entry per manifest, which Wrangler's image list leaves out.
   * Empty for a repository the registry does not know. Undefined when the
   * listing could not be read in full: any page that is not exactly what
   * `registryListingPage` accepts, or no end within 100 pages.
   */
  readonly list: (accountId: string, repository: string) => Promise<readonly string[] | undefined>;
  /**
   * The registry's answer to deleting one entry: it accepted the delete, or
   * it refused in one of the two ways Cloudflare keeps an object. Undefined
   * for any other answer and for none.
   */
  readonly delete: (
    accountId: string,
    repository: string,
    entry: string,
  ) => Promise<"accepted" | "refused-snapshot" | "refused-singleton-artifact" | undefined>;
}

/**
 * Eden's own requests to Cloudflare's registry for one command.
 *
 * It reuses one registry credential, for the account it was checked
 * against, until four minutes have passed since it asked for it; the
 * credential lives five. It drops a credential the
 * registry answers with 401, and asks for no other when that was the
 * credential's first use. Requests that get no answer may take
 * REGISTRY_UNANSWERED_BUDGET_MS in total; after that it sends none, so what
 * is left is unproven and the caller fails.
 */
function cloudflareRegistry(): CloudflareRegistry {
  let credential: {
    readonly accountId: string;
    readonly authorization: string;
    readonly requestedAt: number;
    used: boolean;
  } | undefined;
  let credentialUnavailable = false;
  let unansweredMs = 0;
  const send = async (
    method: "GET" | "DELETE",
    accountId: string,
    repository: string,
    rest: string,
    bodyFor: readonly number[],
    maxBytes: number,
  ): Promise<{ readonly status: number; readonly body: string; readonly link?: string } | undefined> => {
    if (
      credentialUnavailable ||
      Math.floor(REGISTRY_UNANSWERED_BUDGET_MS - unansweredMs) < 1 ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(accountId) ||
      !/^[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/u.test(repository)
    ) return undefined;
    if (
      credential === undefined || credential.accountId !== accountId ||
      performance.now() - credential.requestedAt >= 4 * 60_000
    ) {
      const requestedAt = performance.now();
      const minted = await readWranglerJson([
        "containers", "registries", "credentials", CLOUDFLARE_REGISTRY_HOST,
        "--push", "--pull", "--expiration-minutes", "5", "--json",
      ], accountId);
      const value = minted.failed || typeof minted.value !== "object" || minted.value === null
        ? {}
        : minted.value as Record<string, unknown>;
      if (
        value.account_id !== accountId || value.registry_host !== CLOUDFLARE_REGISTRY_HOST ||
        typeof value.username !== "string" || typeof value.password !== "string"
      ) {
        credentialUnavailable = true;
        return undefined;
      }
      credential = {
        accountId,
        authorization: `Basic ${Buffer.from(`${value.username}:${value.password}`).toString("base64")}`,
        requestedAt,
        used: false,
      };
    }
    const sentAt = performance.now();
    const response = await registryRequest(
      method,
      `/v2/${accountId}/${repository}/${rest}`,
      credential.authorization,
      Math.floor(Math.min(30_000, REGISTRY_UNANSWERED_BUDGET_MS - unansweredMs)),
      bodyFor,
      maxBytes,
    );
    if (response === undefined) {
      unansweredMs += performance.now() - sentAt;
      return undefined;
    }
    if (response.status === 401) {
      credentialUnavailable = !credential.used;
      credential = undefined;
      return undefined;
    }
    credential.used = true;
    return response;
  };
  return {
    list: async (accountId, repository) => {
      const entries: string[] = [];
      // The registry pages by the last entry of the page before and ends with an empty page.
      for (let page = 0; page < 100; page += 1) {
        const last = entries.at(-1);
        const rest = `tags/list?n=${REGISTRY_PAGE_ENTRIES}${last === undefined ? "" : `&last=${encodeURIComponent(last)}`}`;
        const read = registryListingPage(
          await send("GET", accountId, repository, rest, [200], 1_048_576),
          `/v2/${accountId}/${repository}/${rest}`,
          `${accountId}/${repository}`,
          last,
        );
        if (read === undefined) return undefined;
        if (read.length === 0) return entries;
        entries.push(...read);
      }
      return undefined;
    },
    delete: async (accountId, repository, entry) => {
      if (!REGISTRY_ENTRY.test(entry)) return undefined;
      const response = await send(
        "DELETE", accountId, repository, `manifests/${entry}`, [403, 409], 4_096,
      );
      if (response === undefined) return undefined;
      // 204 is what the registry answered; 202 is what the OCI specification names.
      if (response.status === 202 || response.status === 204) return "accepted";
      if (isSnapshotDeleteRefusal(response.status, response.body)) return "refused-snapshot";
      return isSingletonArtifactRefusal(response.status, response.body)
        ? "refused-singleton-artifact"
        : undefined;
    },
  };
}

/**
 * Returns a runner that deletes everything Cloudflare's registry lists for
 * an owned repository: every tag (the `candidate` tag Eden pushed, and the
 * tags Cloudflare added for container snapshots) and every `sha256:` entry,
 * which the registry lists for each manifest, tagged or not. A tag gets its
 * own Wrangler delete, which also collects unreferenced layers. A `sha256:`
 * entry gets Eden's delete by digest, because Wrangler lists and deletes
 * tags only.
 *
 * Cloudflare keeps some objects (observed on 2026-11-18), and each is kept
 * only on the registry's own answer to the delete of that object; a name is
 * never evidence:
 * - `refused-snapshot`: the registry refuses to delete a snapshot. Wrangler
 *   prints only `403 Forbidden` for a tag, so when the registry answered
 *   Wrangler's DELETE with 403, the runner repeats the delete for that tag
 *   against the registry and reads the answer. Any other Wrangler failure
 *   gets no request of Eden's own.
 * - `refused-singleton-artifact`: the registry refuses the delete by digest
 *   with `SINGLETON_ARTIFACT_EXISTS` for a chain artifact.
 * - `accepted-still-listed`: the registry accepted the delete by digest, and
 *   a listing begun at least REGISTRY_REMOVAL_WAIT_MS after that answer still
 *   has the entry. Every accepted delete gets that wait of its own.
 *
 * An entry that shows up in a later listing gets its own delete, for
 * REGISTRY_DELETE_PASSES passes in all. Whatever is listed at the end with
 * none of these answers is unproven, and the caller fails.
 */
function registryRepositoryDeleter(
  registry: CloudflareRegistry = cloudflareRegistry(),
): EveRegistryRepositoryDeleteRunner {
  return async ({ repository, accountId }) => {
    const list = async (): Promise<{ readonly at: number; readonly entries: readonly string[] | undefined }> => ({
      at: performance.now(),
      entries: await registry.list(accountId, repository),
    });
    let listing = await list();
    if (listing.entries === undefined) return "indeterminate";
    if (listing.entries.length === 0) return "absent";
    // One answer per attempted entry: a refusal, the time its delete was accepted, or none.
    const answers = new Map<
      string,
      | "refused-snapshot"
      | "refused-singleton-artifact"
      | { readonly acceptedAt: number; readonly byDigest: boolean }
      | undefined
    >();
    const untagged = (entry: string): boolean => entry.startsWith("sha256:");
    let passes = 0;
    while (listing.entries !== undefined) {
      const { at, entries } = listing;
      if (entries.some((entry) => !answers.has(entry))) {
        if (passes === REGISTRY_DELETE_PASSES) break;
        passes += 1;
        // Tags first, in the listing's order, then the manifests' own entries.
        for (
          const entry of entries.filter((listed) => !answers.has(listed))
            .sort((a, b) => Number(untagged(a)) - Number(untagged(b)))
        ) {
          // Whatever goes wrong while asking, the entry is unproven and the loop goes on.
          const ask = () => registry.delete(accountId, repository, entry).catch(() => undefined);
          const wrangler = untagged(entry) ? undefined : await runWranglerWithInput(
            ["containers", "images", "delete", `${repository}:${entry}`, "--skip-confirmation"],
            accountId,
          );
          const answer = wrangler === undefined
            ? await ask()
            : wrangler.exitCode === 0
            ? "accepted"
            // Wrangler 4.147.0 prints this only when the registry answered its own DELETE with 403.
            : /^[^)\s]+\): 403 /u.test(
                wrangler.stderr.split(`Failed to delete ${repository}:${entry} (digest: `)[1] ?? "",
              )
            ? await ask()
            : undefined;
          answers.set(
            entry,
            answer === "accepted"
              ? { acceptedAt: performance.now(), byDigest: untagged(entry) }
              // The singleton refusal was only ever seen for a digest.
              : answer === "refused-singleton-artifact" && !untagged(entry)
              ? undefined
              : answer,
          );
        }
      } else if (
        // A tagged image left the listing about 15 seconds after its tag was deleted.
        entries.some((entry) => {
          const answer = answers.get(entry);
          return typeof answer === "object" && at - answer.acceptedAt < REGISTRY_REMOVAL_WAIT_MS;
        })
      ) {
        await waitForActivation(5_000);
      } else {
        break;
      }
      listing = await list();
    }
    const { at, entries } = listing;
    if (entries?.length === 0) {
      return [...answers.values()].some((answer) => typeof answer === "object") ? "deleted" : "absent";
    }
    // A refusal is reported even when the last listing could not be read or
    // holds something unproven, so the caller's own final listing can clear
    // it. An accepted delete counts only with a listing that still has the
    // entry after the entry's own full wait.
    const classOf = (entry: string): EveRegistryObjectKept["class"] | undefined => {
      const answer = answers.get(entry);
      if (typeof answer !== "object") return answer;
      return answer.byDigest && entries !== undefined && at - answer.acceptedAt >= REGISTRY_REMOVAL_WAIT_MS
        ? "accepted-still-listed"
        : undefined;
    };
    const kept = [...answers.keys()].flatMap((entry) => {
      const answer = classOf(entry);
      return answer === undefined || entries?.includes(entry) === false
        ? []
        : [{ ref: registryRef(repository, entry), class: answer }];
    });
    if (kept.length === 0) return "indeterminate";
    return {
      kept,
      ...(entries?.every((entry) => classOf(entry) !== undefined) === true ? {} : { unproven: true as const }),
    };
  };
}

/**
 * The registry repository this generation's deployment record proves Eden
 * pushed to, or undefined. Ownership holds only when the recorded digest
 * reference points at the repository derived from the same identity that
 * produced it; a digest-bearing reference to any other repository was
 * published outside Eden's push and is never owned here.
 */
function ownedRegistryRepository(
  identity: VerifiedEveDestroyIdentity,
  environment: EveCliEnvironment,
  name: string,
  accountId: string,
): string | undefined {
  if (
    identity.projectId === undefined ||
    identity.generationId === undefined ||
    identity.containerImage === undefined ||
    identity.accountId !== accountId
  ) {
    return undefined;
  }
  const prefix = `eden-eve-${stableDeploymentKey(identity.projectId, identity.accountId, environment, name)}-`;
  const suffixes = [identity.generationId];
  if (identity.retainedDeployments !== undefined && identity.deploymentId !== undefined) suffixes.push(identity.deploymentId);
  const repository = managedImage(identity.containerImage, accountId)?.repository;
  return suffixes.map((suffix) => `${prefix}${suffix}`).find((owned) => owned === repository);
}

/**
 * The registry repository an indeterminate deploy attempt provably pushed.
 * The retained attempt evidence names the target's repository; the account
 * and target key must match the verified destroy record.
 */
async function attemptRegistryRepository(
  attemptPath: string,
  accountId: string,
  targetKey: string,
): Promise<string | undefined> {
  const raw = await readEvidenceFile(attemptPath);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const prefix = `eden-eve-${targetKey}-`;
  if ("imageRepository" in parsed &&
      typeof parsed.imageRepository === "string" &&
      parsed.imageRepository.startsWith(prefix) &&
      (!("targetKey" in parsed) || parsed.targetKey === targetKey) &&
      "accountId" in parsed &&
      parsed.accountId === accountId) {
    return parsed.imageRepository;
  }
  if ("imageReference" in parsed && typeof parsed.imageReference === "string") {
    const repository = managedImage(parsed.imageReference, accountId)?.repository;
    if (repository?.startsWith(prefix) === true && (!("targetKey" in parsed) || parsed.targetKey === targetKey)) {
      return repository;
    }
  }
  return undefined;
}

/**
 * Every registry repository this exact target provably owns: the recorded
 * digest references in matching deployment records plus the repository
 * evidence retained by indeterminate pushes. Never derived by prefix-matching
 * the registry; each repository is computed from the immutable generation
 * records.
 */
async function collectEveDestroyRegistryRepositories(
  projectRoot: string,
  environment: EveCliEnvironment,
  name: string,
  record: VerifiedEveDestroyIdentity,
): Promise<readonly string[]> {
  const generationsRoot = join(
    projectRoot,
    ".eden",
    "eve-deploy",
    "generations",
  );
  const entries = await readdir(generationsRoot).catch(() => []);
  const repositories = new Set<string>();
  const addRetained = (identity: VerifiedEveDestroyIdentity): void => {
    for (const [id, retained] of Object.entries({
      ...identity.retainedDeployments, ...identity.pendingRetirements,
    })) {
      const repository = ownedRegistryRepository({
        ...identity, deploymentId: id, containerImage: retained.image, generationId: retained.generationId,
      }, environment, name, record.accountId);
      if (repository !== undefined) repositories.add(repository);
    }
  };
  addRetained(record);
  const targetKey = record.projectId === undefined
    ? undefined
    : stableDeploymentKey(
      record.projectId,
      record.accountId,
      environment,
      name,
    );
  for (const entry of entries) {
    const generationRoot = join(generationsRoot, entry);
    const parsed = await parseEveDestroyRecord(
      await deploymentRecordPath(generationRoot),
      environment,
      name,
    );
    const deployedRepository = parsed === undefined
      ? undefined
      : ownedRegistryRepository(
        parsed.identity,
        environment,
        name,
        record.accountId,
      );
    if (deployedRepository !== undefined) repositories.add(deployedRepository);
    if (parsed !== undefined) addRetained(parsed.identity);
    if (targetKey === undefined) continue;
    const attemptRepository = await attemptRegistryRepository(
      join(generationRoot, "deployment-attempt.json"),
      record.accountId,
      targetKey,
    );
    if (attemptRepository !== undefined) repositories.add(attemptRepository);
  }
  return [...repositories];
}

export async function runEveDestroy(
  callerRequest: EveCliExecutionRequest,
  callerOptions: EvePreflightOptions = {},
): Promise<void> {
  // The caller's callbacks run while Eden awaits and can change these objects.
  const request = Object.freeze({ ...callerRequest });
  const options = Object.freeze({ ...callerOptions });
  const startedAt = Date.now();
  if (humanOutput(options)) {
    emitLine(
      options,
      `eden destroy — ${request.name} (${request.environment})`,
    );
  }
  const checks: EvePreflightCheck[] = [];
  let result: EveDestroyOutcome | undefined;
  const emit = (outcome: EveDestroyOutcome): void => {
    result = outcome;
  };
  const fail = (code: string, message: string, remediation?: string): never => {
    throw new EveCliError({
      code,
      message,
      source: "eden destroy",
      ...(remediation === undefined ? {} : { remediation }),
    });
  };

  let primaryError: unknown;
  let lockReleased = true;
  try {
    // Checked before the lock, which is itself a write under .eden.
    if (!await eveDestroyFoldersLocal(request.projectRoot, request.environment, request.name)) {
      fail("EVE_DESTROY_RECORD_UNPROVEN", DESTROY_RECORD_OUTSIDE_PROJECT);
    }
    const lock = await acquireEveTargetLock(
      request.projectRoot,
      request.environment,
      request.name,
    );
    lockReleased = false;
    try {
      await runEveDestroyLocked(request, options, checks, emit, fail);
    } finally {
      lockReleased = await releaseEveTargetLock(lock);
    }
  } catch (error: unknown) {
    primaryError = error instanceof EveCliError || error instanceof EveRuntimeConfigError
      ? error
      : new EveCliError({
        code: "EVE_DESTROY_FAILED",
        message: "The eden destroy operation failed.",
        source: "eden destroy",
      });
  }
  if (!lockReleased) {
    primaryError = new EveCliError({
      code: "EVE_DEPLOY_LOCK_RELEASE_UNPROVEN",
      message: "The Eve destroy lock could not be released with exact ownership proof; local residue was retained.",
      source: "deployment-lock",
    });
  }
  if (primaryError !== undefined) {
    const error = eveOutcomeError(primaryError, "eden destroy");
    result = {
      ...(result ?? {
        status: error.code === "EVE_DESTROY_INDETERMINATE" ? "indeterminate" as const : "failed" as const,
        environment: request.environment,
        name: request.name,
        checks,
      }),
      ok: false,
      error,
    };
  }
  if (result !== undefined) emitEveDestroyOutcome(options, result, startedAt);
  if (primaryError !== undefined) throw primaryError;
}

async function runEveDestroyLocked(
  request: EveCliExecutionRequest,
  options: EvePreflightOptions,
  checks: EvePreflightCheck[],
  emit: (outcome: EveDestroyOutcome) => void,
  fail: (code: string, message: string, remediation?: string) => never,
): Promise<void> {
    const found = await readEveDestroyRecord(
      request.projectRoot,
      request.environment,
      request.name,
    );
    if (found === "outside-project") {
      fail("EVE_DESTROY_RECORD_UNPROVEN", DESTROY_RECORD_OUTSIDE_PROJECT);
    }
    if (found === undefined) {
      fail(
        "EVE_DESTROY_RECORD_UNPROVEN",
        "No immutable deployed record matched the exact target; destroy refuses to guess or broaden cleanup.",
      );
    }
    const record = found as Exclude<typeof found, "outside-project" | undefined>;
    const expectedWorker: string = record.identity.workerName;
    const expectedContainer: string = record.identity.containerApplicationName;
    if (
      expectedWorker !== request.name ||
      expectedContainer !== boundedResourceName(request.name, "container") ||
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

    eveProgress(options, "verifying the immutable ownership record");
    const ownedRegistryRepositories = await collectEveDestroyRegistryRepositories(
      request.projectRoot,
      request.environment,
      request.name,
      record.identity,
    );

    const readTarget = (): Promise<EveDestroyTargetRead> =>
      Promise.resolve(reader({
        accountId: record.identity.accountId,
        workerName: expectedWorker,
        containerApplicationName: expectedContainer,
        registryRepositories: ownedRegistryRepositories,
      }));
    const registry = cloudflareRegistry();
    const reader = options.destroyCloudflareRead ??
      ((read: EveDestroyCloudflareReadRequest) => defaultDestroyTargetRead(read, registry));
    eveProgress(options, "reading the exact remote inventory");
    const before = await readTarget();
    if (before.inventoryComplete === false) {
      fail("EVE_DESTROY_INDETERMINATE", "The exact remote inventory could not be read completely; nothing was deleted. Retry the read. If Wrangler returned a full Container page without the exact target, inspect and delete only the named Container application in the Cloudflare dashboard, then retry destroy.");
    }
    if (
      before.accountId !== record.identity.accountId
    ) {
      fail(
        "EVE_DESTROY_OWNERSHIP_UNPROVEN",
        "The authenticated account does not own the recorded deployment account.",
      );
    }
    if (
      !before.workerExists &&
      before.containerApplicationId === undefined &&
      (ownedRegistryRepositories.length === 0 ||
        (before.registryTagsPresent !== undefined &&
          before.registryTagsPresent.length === 0))
    ) {
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
    if (before.workerExists) {
      const ownership = await resolveEveTargetOwnership({
        projectRoot: request.projectRoot,
        environment: request.environment,
        name: request.name,
        projectId: record.identity.projectId ?? "unknown-project",
        sourceDigest: "unknown",
      }, {
        accountAccess: "available",
        containerAccess: "available",
        accountId: before.accountId,
        target: {
          state: "unowned",
          observed: { worker: true, container: before.containerApplicationId !== undefined },
          ...(before.providerEvidence === undefined ? {} : { providerEvidence: before.providerEvidence }),
        },
      });
      if (ownership.target.state !== "owned") {
        fail("EVE_DESTROY_OWNERSHIP_UNPROVEN", "Live provider settings do not match the recorded Worker and Container identity; nothing was deleted.");
      }
    }

    const deleteWorker = options.deleteWorker ?? defaultWorkerDelete;
    if (before.workerExists) {
      eveProgress(options, `deleting Worker ${expectedWorker}`);
      const workerResult = await deleteWorker({ name: expectedWorker, accountId: record.identity.accountId });
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
      eveProgress(options, `deleting Container application ${expectedContainer}`);
      const containerResult = await deleteContainer({
        accountId: record.identity.accountId,
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
    const repositoryDeletes = new Map<string, EveRegistryRepositoryDeleteOutcome>();
    if (ownedRegistryRepositories.length > 0) {
      const deleteRegistryRepository =
        options.deleteRegistryRepository ?? registryRepositoryDeleter(registry);
      // Everything the registry lists inside an owned repository is deleted:
      // every tag and every manifest's own entry. Each repository is listed
      // again here, so an entry that appeared after the first read is not
      // skipped; absence verification below reads the listing once more.
      eveProgress(
        options,
        `deleting ${ownedRegistryRepositories.length} registry repositor${
          ownedRegistryRepositories.length === 1 ? "y" : "ies"
        }`,
      );
      for (const repository of ownedRegistryRepositories) {
        repositoryDeletes.set(
          repository,
          await deleteRegistryRepository({ repository, accountId: record.identity.accountId }),
        );
      }
    }

    eveProgress(options, "verifying the exact target is absent");
    const after = await readTarget();
    if (after.inventoryComplete === false || after.accountId !== record.identity.accountId) {
      fail("EVE_DESTROY_INDETERMINATE", "The exact remote inventory could not be read completely after deletion; absence is unproven.");
    }
    if (after.workerExists || after.containerApplicationId !== undefined) {
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
    const presentAfter = after.registryTagsPresent;
    // Only the exact objects for which the registry gave one of the kept
    // answers may remain. Anything else that is still listed fails the
    // destroy, whatever its name and whenever it appeared. Without a
    // complete final listing nothing is proven absent, whatever the deletes
    // answered.
    const answered = new Map(
      [...repositoryDeletes.values()].flatMap((outcome) =>
        typeof outcome === "object" ? outcome.kept.map((object) => [object.ref, object] as const) : []
      ),
    );
    const registryObjectsKept = (presentAfter ?? []).flatMap((ref) => answered.get(ref) ?? []);
    const retainedRepositories = ownedRegistryRepositories.filter(
      (repository) =>
        presentAfter === undefined ||
        presentAfter.some((ref) =>
          (ref.startsWith(`${repository}:`) || ref.startsWith(`${repository}@`)) && !answered.has(ref)
        ),
    );
    if (ownedRegistryRepositories.length > 0) {
      checks.push(
        retainedRepositories.length === 0
          ? check(
            "VAL-LIFE-006-REGISTRY",
            "passed",
            registryObjectsKept.length === 0
              ? "Everything the registry listed for this exact target was deleted or proven absent."
              : `Everything else the registry listed for this exact target was deleted or proven absent. Cloudflare's registry still lists ${registryObjectsKept.length} object(s); see EVE_REGISTRY_OBJECTS_KEPT.`,
          )
          : check(
            "VAL-LIFE-006-REGISTRY",
            "failed",
            `The registry still lists objects of the exact target that it gave no kept answer for, or its listing could not be read: ${retainedRepositories.join(", ")}.`,
            "Retry eden destroy with the same selectors: it deletes what the registry still lists, verifies the registry, and clears the target's CURRENT pointer. A retry that finds nothing left reports absent; nothing more is needed then. Deleting tags by hand with wrangler containers images delete removes no sha256: entry, so retry eden destroy afterwards. An object with one of the three kept answers (refused-snapshot, refused-singleton-artifact, accepted-still-listed) is reported as EVE_REGISTRY_OBJECTS_KEPT and does not count here. Eden reads the registry's listing and each answer with direct requests to registry.cloudflare.com and never uses a proxy for them; if this machine cannot reach the registry directly, retry from one that can.",
          ),
      );
    }
    if (retainedRepositories.length > 0) {
      emit({
        ok: false,
        status: "failed",
        environment: request.environment,
        name: request.name,
        checks,
      });
      fail(
        "EVE_DESTROY_IMAGES_RETAINED",
        `The exact Worker and Container are absent, but registry objects remain, or could not be listed, in: ${retainedRepositories.join(", ")}.`,
      );
    }
    checks.push(
      check(
        "VAL-LIFE-006",
        "passed",
        "Exact absence was verified; clearing this target's CURRENT pointer only.",
      ),
    );

    const targetRoot = join(
      request.projectRoot,
      ".eden",
      "eve-deploy",
      "targets",
      `${request.environment}-${request.name}`,
    );
    const currentPath = join(targetRoot, "CURRENT");
    // Only the CURRENT that named the record just destroyed is cleared. A
    // check and an unlink are two steps, so a writer outside Eden's lock can
    // still slip between them; see docs/how-it-works.md.
    if (
      await realpath(targetRoot).catch(() => targetRoot) !== targetRoot ||
      await readEveTargetPointer(targetRoot) !== record.pointer
    ) {
      fail(
        "EVE_DESTROY_POINTER_UNCLEARED",
        "The target's CURRENT pointer changed while destroy ran, so it was left in place. Destroy finished its deletes for the record it read at the start; the checks list them.",
        "CURRENT now names another deployment record. Open .eden/eve-deploy/targets/<env>-<name>/CURRENT and confirm that deployment is one you mean to remove. Only then rerun eden destroy with the same --project, --env, and --name; it destroys what that record names.",
      );
    }
    // A file at CURRENT that did not name the record is not Eden's to remove.
    if (record.namedByPointer) await rm(currentPath, { force: true });
    const gone = await lstat(currentPath).catch(() => undefined);
    if (record.namedByPointer && gone !== undefined) {
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
      ...(registryObjectsKept.length === 0 ? {} : {
        warnings: [registryObjectsKeptWarning(registryObjectsKept)],
        registryObjectsKept,
      }),
    });
}

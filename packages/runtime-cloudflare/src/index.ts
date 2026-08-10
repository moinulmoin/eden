import type {
  EdenEvent,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export {
  configureEdenArtifact,
  readConfiguredEdenArtifact,
} from "./artifact-runtime.js";
export type {
  EdenArtifactGenerationMetadata,
  EdenConfiguredArtifact,
  EdenRuntimeAgentArtifact,
} from "./artifact-runtime.js";

export type {
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export {
  createOpaqueSessionId,
  createOpaqueMessageId,
  createOpaqueTurnId,
  createSessionObjectName,
  isOpaqueMessageId,
  isOpaqueSessionId,
  isOpaqueTurnId,
  sessionIdFromObjectName,
} from "./session-identity.js";
export {
  SESSION_SCHEMA_MIGRATIONS,
  SESSION_SCHEMA_TABLES,
  SESSION_SCHEMA_VERSION,
} from "./session-schema.js";
export type { SessionMigration } from "./session-schema.js";
export {
  commitSessionTransaction,
  createOpaqueEventId,
  readJournalEvents,
  readLatestJournalCursor,
} from "./session-journal.js";
export type {
  AppendJournalEventInput,
  CompleteEffectInput,
  EdenSessionStorage,
  EdenJobStatus,
  EdenSqlCursor,
  EdenSqlStorage,
  EdenSqlValue,
  FailEffectInput,
  InsertMessageInput,
  InsertJobInput,
  InsertStepInput,
  InsertTurnInput,
  JournalTransaction,
  RecordErrorInput,
  RequestEffectInput,
  StartEffectInput,
  UpdateJobInput,
  UpdateMessageInput,
  UpdateStepInput,
  UpdateTurnInput,
} from "./session-journal.js";
export {
  createEffectIdempotencyKey,
  createStableEffectIdempotencyKey,
  MAX_CHECKPOINT_ATTEMPTS,
  markCheckpointRetryable,
  prepareCheckpointAttempt,
  commitCheckpointResult,
  reenterCheckpoint,
} from "./session-checkpoint.js";
export type {
  CheckpointCommitResult,
  CheckpointPreparation,
  CheckpointRequest,
  PreparedCheckpoint,
  StableEffectIdentity,
} from "./session-checkpoint.js";
export {
  enqueueRecoveryJob,
  inspectRecoveryJobs,
  MAX_RECOVERY_JOB_ATTEMPTS,
  MAX_RECOVERY_JOBS_PER_ALARM,
  nextRecoveryJobDueAt,
  processRecoveryJobs,
  RECOVERY_RETRY_DELAY_MS,
  recoverRecoveryJob,
  sanitizeRecoveryError,
} from "./session-jobs.js";
export type {
  RecoveryJobEnqueueResult,
  RecoveryJobExecutionOptions,
  RecoveryJobInput,
  RecoveryJobInspection,
  RecoveryJobProcessingResult,
  RecoveryJobRecord,
  RecoveryJobRecoveryResult,
  RecoveryJobStorage,
  RecoveryJobStatus,
} from "./session-jobs.js";
export { readSessionRehydratedState } from "./session-state.js";
export type {
  EdenEffectState,
  EdenErrorState,
  EdenJobState,
  EdenMessageState,
  EdenProjectionState,
  EdenSessionMetaState,
  EdenSessionRehydratedState,
  EdenStepState,
  EdenTurnState,
} from "./session-state.js";
export {
  createModelAdapter,
  normalizeEdenJsonValue,
  normalizeModelFailure,
  normalizeModelMessages,
  normalizeModelResult,
} from "./model-adapter.js";
export type {
  EdenModelAdapter,
  EdenModelCorrelation,
  EdenModelFailure,
  EdenModelFailureCode,
  EdenModelFinishReason,
  EdenModelMessage,
  EdenModelMessagePart,
  EdenModelOptions,
  EdenModelOutcome,
  EdenModelAdapterCall,
  EdenModelAdapterRequest,
  EdenModelRequest,
  EdenModelResult,
  EdenModelRole,
  EdenModelToolCall,
  EdenModelToolChoice,
  EdenModelToolDefinition,
  EdenModelToolResult,
  EdenModelUsage,
} from "./model-adapter.js";
export { executeTypedTool } from "./tool-harness.js";
export type {
  EdenToolFailure,
  EdenToolFailureCode,
  EdenToolHarnessRequest,
  EdenToolHarnessResult,
} from "./tool-harness.js";
export { MAX_BOUNDED_TURN_ATTEMPTS } from "./turn-runner-types.js";
export { runBoundedTurn } from "./turn-runner.js";
export type {
  EdenBoundedTurnRequest,
  EdenBoundedTurnResult,
  EdenTurnFailure,
  EdenTurnFailureCode,
} from "./turn-runner.js";

export interface EdenRuntimeConfiguration {
  readonly versions: EdenVersionSet;
}

export interface EdenSessionStore {
  createSession(): Promise<EdenSessionSnapshot>;
  readEvents(
    sessionId: string,
    startIndex?: number,
  ): Promise<readonly EdenEvent<EdenEventType>[]>;
}

export interface EdenRuntime {
  readonly configuration: EdenRuntimeConfiguration;
  readonly sessions: EdenSessionStore;
}

export function createRuntime(
  configuration: EdenRuntimeConfiguration,
  sessions: EdenSessionStore,
): EdenRuntime {
  return { configuration, sessions };
}

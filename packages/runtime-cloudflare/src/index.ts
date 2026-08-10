import type {
  EdenEvent,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export type {
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export {
  createOpaqueSessionId,
  createSessionObjectName,
  isOpaqueSessionId,
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
  EdenSqlCursor,
  EdenSqlStorage,
  EdenSqlValue,
  FailEffectInput,
  InsertMessageInput,
  InsertStepInput,
  InsertTurnInput,
  JournalTransaction,
  RecordErrorInput,
  RequestEffectInput,
  StartEffectInput,
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

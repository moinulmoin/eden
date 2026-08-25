import type {
  EdenEvent,
  EdenEventType,
  EdenJsonValue,
  EdenSessionStatus,
  EdenStepPhase,
  EdenTurnStatus,
  EdenVersionSet,
} from "@moinulmoin/eden-definitions";

import type { EdenSqlStorage } from "./session-journal.js";
import { readJournalEvents, readLatestJournalCursor } from "./session-journal.js";
import { readAppliedSessionSchemaVersion } from "./session-schema.js";

interface SessionMetaRow {
  readonly [key: string]: string | number | null;
  readonly session_id: string;
  readonly owner_principal: string;
  readonly status: EdenSessionStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly runtime_version: string;
  readonly agent_bundle_version: string;
  readonly manifest_version: string;
  readonly protocol_version: string;
  readonly schema_version: number;
  readonly artifact_schema_version: number;
}

interface TurnRow {
  readonly [key: string]: string | number | null;
  readonly turn_id: string;
  readonly status: EdenTurnStatus;
  readonly accepted_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly failed_at: string | null;
  readonly error_id: string | null;
}

interface StepRow {
  readonly [key: string]: string | number | null;
  readonly step_id: string;
  readonly turn_id: string;
  readonly logical_key: string;
  readonly phase: EdenStepPhase;
  readonly status: "pending" | "running" | "completed" | "retryable" | "failed";
  readonly attempt_count: number;
  readonly result_ref: string | null;
  readonly error_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface MessageRow {
  readonly [key: string]: string | number | null;
  readonly message_id: string;
  readonly turn_id: string | null;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly created_at: string;
  readonly completed_at: string | null;
}

interface ProjectionRow {
  readonly [key: string]: string | number | null;
  readonly projection_key: string;
  readonly projection_json: string;
  readonly updated_at: string;
}

interface EffectRow {
  readonly [key: string]: string | number | null;
  readonly effect_id: string;
  readonly turn_id: string;
  readonly step_id: string;
  readonly call_id: string;
  readonly tool_name: string;
  readonly idempotency_key: string;
  readonly status: "requested" | "running" | "completed" | "failed";
  readonly input_json: string;
  readonly output_json: string | null;
  readonly error_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface JobRow {
  readonly [key: string]: string | number | null;
  readonly job_id: string;
  readonly kind: string;
  readonly status: "pending" | "running" | "completed" | "retryable" | "dead";
  readonly due_at: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly last_error: string | null;
  readonly recovery_action: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
}

interface ErrorRow {
  readonly [key: string]: string | number | null;
  readonly error_id: string;
  readonly turn_id: string | null;
  readonly step_id: string | null;
  readonly code: string;
  readonly message: string;
  readonly retryable: number;
  readonly status: "open" | "resolved";
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export interface EdenSessionMetaState {
  readonly sessionId: string;
  readonly ownerPrincipal: string;
  readonly status: EdenSessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly versions: EdenVersionSet;
  readonly sqliteSchemaVersion: number;
}

export interface EdenTurnState {
  readonly turnId: string;
  readonly status: EdenTurnStatus;
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly errorId: string | null;
}

export interface EdenStepState {
  readonly stepId: string;
  readonly turnId: string;
  readonly logicalKey: string;
  readonly phase: EdenStepPhase;
  readonly status: StepRow["status"];
  readonly attemptCount: number;
  readonly resultRef: string | null;
  readonly errorId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface EdenMessageState {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly role: MessageRow["role"];
  readonly content: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface EdenProjectionState {
  readonly projectionKey: string;
  readonly value: EdenJsonValue;
  readonly updatedAt: string;
}

export interface EdenEffectState {
  readonly effectId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly idempotencyKey: string;
  readonly status: EffectRow["status"];
  readonly input: EdenJsonValue;
  readonly output: EdenJsonValue | null;
  readonly error: EdenJsonValue | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface EdenJobState {
  readonly jobId: string;
  readonly kind: string;
  readonly status: JobRow["status"];
  readonly dueAt: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly recoveryAction: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface EdenErrorState {
  readonly errorId: string;
  readonly turnId: string | null;
  readonly stepId: string | null;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly status: ErrorRow["status"];
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface EdenSessionRehydratedState {
  readonly sessionMeta: EdenSessionMetaState | null;
  readonly latestCursor: number;
  readonly events: readonly EdenEvent<EdenEventType>[];
  readonly turns: readonly EdenTurnState[];
  readonly steps: readonly EdenStepState[];
  readonly messages: readonly EdenMessageState[];
  readonly projections: readonly EdenProjectionState[];
  readonly effects: readonly EdenEffectState[];
  readonly jobs: readonly EdenJobState[];
  readonly errors: readonly EdenErrorState[];
}

function jsonValue(value: string): EdenJsonValue {
  return JSON.parse(value) as EdenJsonValue;
}

function readMeta(
  sql: EdenSqlStorage,
  sessionId: string,
): EdenSessionMetaState | null {
  const row = sql
    .exec<SessionMetaRow>(
      `SELECT session_id, owner_principal, status, created_at, updated_at,
        runtime_version, agent_bundle_version, manifest_version,
        protocol_version, schema_version, artifact_schema_version
       FROM session_meta
       WHERE session_id = ?`,
      sessionId,
    )
    .toArray()[0];
  if (row === undefined) return null;

  return {
    sessionId: row.session_id,
    ownerPrincipal: row.owner_principal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versions: {
      runtime: row.runtime_version,
      agentBundle: row.agent_bundle_version,
      manifest: row.manifest_version,
      protocol: row.protocol_version,
      schema: row.artifact_schema_version,
    },
    sqliteSchemaVersion: readAppliedSessionSchemaVersion(sql),
  };
}

export function readSessionRehydratedState(
  sql: EdenSqlStorage,
  sessionId: string,
): EdenSessionRehydratedState {
  const turns = sql
    .exec<TurnRow>(
      `SELECT turn_id, status, accepted_at, started_at, completed_at,
        failed_at, error_id
       FROM turns
       WHERE session_id = ?
       ORDER BY accepted_at ASC, turn_id ASC`,
      sessionId,
    )
    .toArray()
    .map(
      (row): EdenTurnState => ({
        turnId: row.turn_id,
        status: row.status,
        acceptedAt: row.accepted_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        failedAt: row.failed_at,
        errorId: row.error_id,
      }),
    );

  const steps = sql
    .exec<StepRow>(
      `SELECT step_id, turn_id, logical_key, phase, status, attempt_count,
        result_ref, error_id, created_at, updated_at, completed_at
       FROM steps
       WHERE session_id = ?
       ORDER BY created_at ASC, step_id ASC`,
      sessionId,
    )
    .toArray()
    .map(
      (row): EdenStepState => ({
        stepId: row.step_id,
        turnId: row.turn_id,
        logicalKey: row.logical_key,
        phase: row.phase,
        status: row.status,
        attemptCount: row.attempt_count,
        resultRef: row.result_ref,
        errorId: row.error_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
      }),
    );

  const messages = sql
    .exec<MessageRow>(
      `SELECT message_id, turn_id, role, content, created_at, completed_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC, message_id ASC`,
      sessionId,
    )
    .toArray()
    .map(
      (row): EdenMessageState => ({
        messageId: row.message_id,
        turnId: row.turn_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      }),
    );

  const projections = sql
    .exec<ProjectionRow>(
      `SELECT projection_key, projection_json, updated_at
       FROM projections
       WHERE session_id = ?
       ORDER BY projection_key ASC`,
      sessionId,
    )
    .toArray()
    .map(
      (row): EdenProjectionState => ({
        projectionKey: row.projection_key,
        value: jsonValue(row.projection_json),
        updatedAt: row.updated_at,
      }),
    );

  const effects = sql
    .exec<EffectRow>(
      `SELECT effect_id, turn_id, step_id, call_id, tool_name,
        idempotency_key, status, input_json, output_json, error_json,
        created_at, updated_at, completed_at
       FROM effects
       WHERE session_id = ?
       ORDER BY created_at ASC, effect_id ASC`,
      sessionId,
    )
    .toArray()
    .map(
      (row): EdenEffectState => ({
        effectId: row.effect_id,
        turnId: row.turn_id,
        stepId: row.step_id,
        callId: row.call_id,
        toolName: row.tool_name,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        input: jsonValue(row.input_json),
        output: row.output_json === null ? null : jsonValue(row.output_json),
        error: row.error_json === null ? null : jsonValue(row.error_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
      }),
    );

  const jobs = sql
    .exec<JobRow>(
      `SELECT job_id, kind, status, due_at, attempts, max_attempts,
        last_error, recovery_action, created_at, updated_at, completed_at
       FROM jobs
       WHERE session_id = ?
       ORDER BY due_at ASC, job_id ASC`,
      sessionId,
    )
    .toArray()
    .map(
      (row): EdenJobState => ({
        jobId: row.job_id,
        kind: row.kind,
        status: row.status,
        dueAt: row.due_at,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        lastError: row.last_error,
        recoveryAction: row.recovery_action,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
      }),
    );

  const errors = sql
    .exec<ErrorRow>(
      `SELECT error_id, turn_id, step_id, code, message, retryable,
        status, created_at, resolved_at
       FROM errors
       WHERE session_id = ?
       ORDER BY created_at ASC, error_id ASC`,
      sessionId,
    )
    .toArray()
    .map(
      (row): EdenErrorState => ({
        errorId: row.error_id,
        turnId: row.turn_id,
        stepId: row.step_id,
        code: row.code,
        message: row.message,
        retryable: row.retryable === 1,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      }),
    );

  return {
    sessionMeta: readMeta(sql, sessionId),
    latestCursor: readLatestJournalCursor(sql, sessionId),
    events: readJournalEvents(sql, sessionId, 0),
    turns,
    steps,
    messages,
    projections,
    effects,
    jobs,
    errors,
  };
}

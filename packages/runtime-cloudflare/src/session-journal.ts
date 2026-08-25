/*
 * Modified derivative of portable Eve concepts. Eve 0.31.3 reference commit:
 * 0b102bc90e7cf2c3e294f6ca3af86c307d449b1a. See repository NOTICE and LICENSE.
 */

import type {
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenJsonValue,
  EdenStepPhase,
  EdenTurnStatus,
} from "@moinulmoin/eden-definitions";

const MAX_EVENT_PAYLOAD_BYTES = 131_072;
const EVENT_ID_BYTES = 16;
export const MAX_JOURNAL_EVENTS_PER_PAGE = 256;
const EDEN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.started",
  "turn.started",
  "message.received",
  "step.started",
  "actions.requested",
  "action.result",
  "message.completed",
  "step.completed",
  "turn.completed",
  "session.waiting",
  "step.failed",
  "turn.failed",
  "session.failed",
]);

export type EdenSqlValue = ArrayBuffer | string | number | null;

export interface EdenSqlCursor<
  TRow extends Record<string, EdenSqlValue>,
> {
  toArray(): TRow[];
}

export interface EdenSqlStorage {
  exec<TRow extends Record<string, EdenSqlValue>>(
    query: string,
    ...bindings: EdenSqlValue[]
  ): EdenSqlCursor<TRow>;
}

export interface EdenSessionStorage {
  readonly sql: EdenSqlStorage;
  transactionSync<T>(closure: () => T): T;
}

interface EventRow {
  readonly [key: string]: string | number | null;
  readonly stream_index: number;
  readonly event_id: string;
  readonly type: EdenEventType;
  readonly payload_json: string;
  readonly committed_at: string;
}

export interface AppendJournalEventInput<TType extends EdenEventType> {
  readonly type: TType;
  readonly data: EdenEventDataByType[TType];
  readonly turnId?: string;
  readonly stepId?: string;
  readonly committedAt?: string;
}

export interface InsertTurnInput {
  readonly turnId: string;
  readonly status: EdenTurnStatus;
  readonly acceptedAt: string;
  readonly startedAt?: string;
}

export interface UpdateTurnInput {
  readonly turnId: string;
  readonly status: EdenTurnStatus;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly failedAt?: string | null;
  readonly errorId?: string | null;
}

export interface InsertStepInput {
  readonly stepId: string;
  readonly turnId: string;
  readonly logicalKey: string;
  readonly phase: EdenStepPhase;
  readonly status: "pending" | "running" | "completed" | "retryable" | "failed";
  readonly attemptCount?: number;
  readonly resultRef?: string;
  readonly errorId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface UpdateStepInput {
  readonly stepId: string;
  readonly status: "pending" | "running" | "completed" | "retryable" | "failed";
  readonly attemptCount?: number;
  readonly resultRef?: string | null;
  readonly errorId?: string | null;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
}

export interface InsertMessageInput {
  readonly messageId: string;
  readonly turnId?: string;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface UpdateMessageInput {
  readonly messageId: string;
  readonly content?: string;
  readonly completedAt?: string | null;
}

export interface RequestEffectInput {
  readonly effectId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly idempotencyKey: string;
  readonly input: EdenJsonValue;
  readonly createdAt: string;
}

export interface CompleteEffectInput {
  readonly effectId: string;
  readonly output: EdenJsonValue;
  readonly completedAt: string;
}

export interface StartEffectInput {
  readonly effectId: string;
  readonly updatedAt: string;
}

export interface FailEffectInput {
  readonly effectId: string;
  readonly error: EdenJsonValue;
  readonly updatedAt: string;
}

export interface RecordErrorInput {
  readonly errorId: string;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly createdAt: string;
}

export type EdenJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "retryable"
  | "dead";

export interface InsertJobInput {
  readonly jobId: string;
  readonly kind: string;
  readonly status?: EdenJobStatus;
  readonly dueAt: number;
  readonly attempts?: number;
  readonly maxAttempts?: number;
  readonly lastError?: string;
  readonly recoveryAction?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly completedAt?: string;
}

export interface UpdateJobInput {
  readonly jobId: string;
  readonly status: EdenJobStatus;
  readonly dueAt?: number;
  readonly attempts?: number;
  readonly lastError?: string | null;
  readonly recoveryAction?: string | null;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
}

export interface JournalTransaction {
  appendEvent<TType extends EdenEventType>(
    input: AppendJournalEventInput<TType>,
  ): EdenEvent<TType>;
  setSessionStatus(
    status: "new" | "running" | "waiting" | "failed" | "completed",
    updatedAt?: string,
  ): void;
  insertTurn(input: InsertTurnInput): void;
  updateTurn(input: UpdateTurnInput): void;
  insertStep(input: InsertStepInput): void;
  updateStep(input: UpdateStepInput): void;
  insertMessage(input: InsertMessageInput): void;
  updateMessage(input: UpdateMessageInput): void;
  upsertProjection(
    projectionKey: string,
    value: EdenJsonValue,
    updatedAt?: string,
  ): void;
  requestEffect(input: RequestEffectInput): void;
  startEffect(input: StartEffectInput): void;
  completeEffect(input: CompleteEffectInput): void;
  failEffect(input: FailEffectInput): void;
  recordError(input: RecordErrorInput): void;
  insertJob(input: InsertJobInput): void;
  updateJob(input: UpdateJobInput): void;
}

export function createOpaqueEventId(): string {
  const bytes = new Uint8Array(EVENT_ID_BYTES);
  crypto.getRandomValues(bytes);

  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `evt_${hex}`;
}

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Journal values must be JSON-compatible");
  }
  return serialized;
}

function assertPayloadSize(payload: string): void {
  const byteLength = new TextEncoder().encode(payload).byteLength;
  if (byteLength > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error("Journal event payload exceeds the 128 KiB limit");
  }
}

function optional(value: string | undefined): string | null {
  return value ?? null;
}

function requireRow(
  sql: EdenSqlStorage,
  query: string,
  ...bindings: EdenSqlValue[]
): void {
  const rows = sql
    .exec<{ present: number }>(query, ...bindings)
    .toArray();
  if (rows[0]?.present !== 1) {
    throw new Error("Journal transition referenced a missing durable row");
  }
}

interface RelatedJournalRows {
  readonly turnId?: string;
  readonly stepId?: string;
}

function requireRelatedRows(
  sql: EdenSqlStorage,
  sessionId: string,
  rows: RelatedJournalRows,
): void {
  if (rows.turnId !== undefined && rows.stepId !== undefined) {
    requireRow(
      sql,
      `SELECT EXISTS (
         SELECT 1
         FROM turns
         INNER JOIN steps
           ON steps.session_id = turns.session_id
          AND steps.turn_id = turns.turn_id
         WHERE turns.session_id = ?
           AND turns.turn_id = ?
           AND steps.step_id = ?
       ) AS present`,
      sessionId,
      rows.turnId,
      rows.stepId,
    );
    return;
  }

  if (rows.turnId !== undefined) {
    requireRow(
      sql,
      "SELECT EXISTS (SELECT 1 FROM turns WHERE turn_id = ? AND session_id = ?) AS present",
      rows.turnId,
      sessionId,
    );
  }
  if (rows.stepId !== undefined) {
    requireRow(
      sql,
      "SELECT EXISTS (SELECT 1 FROM steps WHERE step_id = ? AND session_id = ?) AS present",
      rows.stepId,
      sessionId,
    );
  }
}

function createJournal(
  sql: EdenSqlStorage,
  sessionId: string,
): JournalTransaction {
  return {
    appendEvent<TType extends EdenEventType>(
      input: AppendJournalEventInput<TType>,
    ): EdenEvent<TType> {
      if (!EDEN_EVENT_TYPES.has(input.type)) {
        throw new Error(`Unknown Eden event type: ${String(input.type)}`);
      }
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
        sessionId,
      );
      requireRelatedRows(sql, sessionId, input);
      const payload = json(input.data);
      assertPayloadSize(payload);
      const eventId = createOpaqueEventId();
      const committedAt = input.committedAt ?? now();
      const streamIndex = readLatestJournalCursor(sql, sessionId) + 1;
      const envelope = json({
        streamIndex,
        eventId,
        type: input.type,
        data: input.data,
        committedAt,
      });
      assertPayloadSize(envelope);

      sql.exec(
        `INSERT INTO events (
          stream_index, event_id, session_id, turn_id, step_id, type,
          payload_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        streamIndex,
        eventId,
        sessionId,
        optional(input.turnId),
        optional(input.stepId),
        input.type,
        payload,
        committedAt,
      );

      return {
        streamIndex,
        eventId,
        type: input.type,
        data: input.data,
        committedAt,
      };
    },

    setSessionStatus(status, updatedAt = now()): void {
      sql.exec(
        "UPDATE session_meta SET status = ?, updated_at = ? WHERE session_id = ?",
        status,
        updatedAt,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
        sessionId,
      );
    },

    insertTurn(input): void {
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
        sessionId,
      );
      sql.exec(
        `INSERT INTO turns (
          turn_id, session_id, status, accepted_at, started_at,
          completed_at, failed_at, error_id
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        input.turnId,
        sessionId,
        input.status,
        input.acceptedAt,
        optional(input.startedAt),
      );
    },

    updateTurn(input): void {
      const assignments = ["status = ?"];
      const bindings: EdenSqlValue[] = [input.status];
      if (input.startedAt !== undefined) {
        assignments.push("started_at = ?");
        bindings.push(input.startedAt);
      }
      if (input.completedAt !== undefined) {
        assignments.push("completed_at = ?");
        bindings.push(input.completedAt);
      }
      if (input.failedAt !== undefined) {
        assignments.push("failed_at = ?");
        bindings.push(input.failedAt);
      }
      if (input.errorId !== undefined) {
        assignments.push("error_id = ?");
        bindings.push(input.errorId);
      }
      sql.exec(
        `UPDATE turns SET ${assignments.join(", ")}
         WHERE turn_id = ? AND session_id = ?`,
        ...bindings,
        input.turnId,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM turns WHERE turn_id = ? AND session_id = ?) AS present",
        input.turnId,
        sessionId,
      );
    },

    insertStep(input): void {
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM turns WHERE turn_id = ? AND session_id = ?) AS present",
        input.turnId,
        sessionId,
      );
      sql.exec(
        `INSERT INTO steps (
          step_id, session_id, turn_id, logical_key, phase, status,
          attempt_count, result_ref, error_id, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.stepId,
        sessionId,
        input.turnId,
        input.logicalKey,
        input.phase,
        input.status,
        input.attemptCount ?? 0,
        optional(input.resultRef),
        optional(input.errorId),
        input.createdAt,
        input.updatedAt,
        optional(input.completedAt),
      );
    },

    updateStep(input): void {
      const assignments = ["status = ?", "updated_at = ?"];
      const bindings: EdenSqlValue[] = [input.status, input.updatedAt];
      if (input.attemptCount !== undefined) {
        assignments.push("attempt_count = ?");
        bindings.push(input.attemptCount);
      }
      if (input.resultRef !== undefined) {
        assignments.push("result_ref = ?");
        bindings.push(input.resultRef);
      }
      if (input.errorId !== undefined) {
        assignments.push("error_id = ?");
        bindings.push(input.errorId);
      }
      if (input.completedAt !== undefined) {
        assignments.push("completed_at = ?");
        bindings.push(input.completedAt);
      }
      sql.exec(
        `UPDATE steps SET ${assignments.join(", ")}
         WHERE step_id = ? AND session_id = ?`,
        ...bindings,
        input.stepId,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM steps WHERE step_id = ? AND session_id = ?) AS present",
        input.stepId,
        sessionId,
      );
    },

    insertMessage(input): void {
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
        sessionId,
      );
      if (input.turnId !== undefined) {
        requireRow(
          sql,
          "SELECT EXISTS (SELECT 1 FROM turns WHERE turn_id = ? AND session_id = ?) AS present",
          input.turnId,
          sessionId,
        );
      }
      sql.exec(
        `INSERT INTO messages (
          message_id, session_id, turn_id, role, content, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.messageId,
        sessionId,
        optional(input.turnId),
        input.role,
        input.content,
        input.createdAt,
        optional(input.completedAt),
      );
    },

    updateMessage(input): void {
      const assignments: string[] = [];
      const bindings: EdenSqlValue[] = [];
      if (input.content !== undefined) {
        assignments.push("content = ?");
        bindings.push(input.content);
      }
      if (input.completedAt !== undefined) {
        assignments.push("completed_at = ?");
        bindings.push(input.completedAt);
      }
      if (assignments.length === 0) {
        throw new Error("Message update must change at least one field");
      }
      sql.exec(
        `UPDATE messages SET ${assignments.join(", ")}
         WHERE message_id = ? AND session_id = ?`,
        ...bindings,
        input.messageId,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM messages WHERE message_id = ? AND session_id = ?) AS present",
        input.messageId,
        sessionId,
      );
    },

    upsertProjection(projectionKey, value, updatedAt = now()): void {
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
        sessionId,
      );
      const projection = json(value);
      sql.exec(
        `INSERT INTO projections (
          session_id, projection_key, projection_json, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (session_id, projection_key) DO UPDATE SET
          projection_json = excluded.projection_json,
          updated_at = excluded.updated_at`,
        sessionId,
        projectionKey,
        projection,
        updatedAt,
      );
    },

    requestEffect(input): void {
      requireRelatedRows(sql, sessionId, input);
      const effectInput = json(input.input);
      sql.exec(
        `INSERT INTO effects (
          effect_id, session_id, turn_id, step_id, call_id, tool_name,
          idempotency_key, status, input_json, output_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, NULL, NULL, ?, ?, NULL)`,
        input.effectId,
        sessionId,
        input.turnId,
        input.stepId,
        input.callId,
        input.toolName,
        input.idempotencyKey,
        effectInput,
        input.createdAt,
        input.createdAt,
      );
    },

    startEffect(input): void {
      sql.exec(
        `UPDATE effects SET status = 'running', updated_at = ?
         WHERE effect_id = ? AND session_id = ? AND status = 'requested'`,
        input.updatedAt,
        input.effectId,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM effects WHERE effect_id = ? AND session_id = ?) AS present",
        input.effectId,
        sessionId,
      );
    },

    completeEffect(input): void {
      const output = json(input.output);
      const existing = sql
        .exec<{ status: string; output_json: string | null }>(
          "SELECT status, output_json FROM effects WHERE effect_id = ? AND session_id = ?",
          input.effectId,
          sessionId,
        )
        .toArray()[0];
      if (existing === undefined) {
        throw new Error("Journal transition referenced a missing durable row");
      }
      if (existing.status === "completed") {
        if (existing.output_json !== output) {
          throw new Error("Journal effect is already completed with different output");
        }
        return;
      }
      if (existing.status === "failed") {
        throw new Error("Journal effect is already failed");
      }
      sql.exec(
        `UPDATE effects SET
          status = 'completed',
          output_json = ?,
          error_json = NULL,
          updated_at = ?,
          completed_at = ?
        WHERE effect_id = ? AND session_id = ?`,
        output,
        input.completedAt,
        input.completedAt,
        input.effectId,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM effects WHERE effect_id = ? AND session_id = ?) AS present",
        input.effectId,
        sessionId,
      );
    },

    failEffect(input): void {
      const error = json(input.error);
      const existing = sql
        .exec<{ status: string; error_json: string | null }>(
          "SELECT status, error_json FROM effects WHERE effect_id = ? AND session_id = ?",
          input.effectId,
          sessionId,
        )
        .toArray()[0];
      if (existing === undefined) {
        throw new Error("Journal transition referenced a missing durable row");
      }
      if (existing.status === "failed") {
        if (existing.error_json !== error) {
          throw new Error("Journal effect is already failed with different error");
        }
        return;
      }
      if (existing.status === "completed") {
        return;
      }
      sql.exec(
        `UPDATE effects SET
          status = 'failed',
          output_json = NULL,
          error_json = ?,
          updated_at = ?
        WHERE effect_id = ? AND session_id = ?`,
        error,
        input.updatedAt,
        input.effectId,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM effects WHERE effect_id = ? AND session_id = ?) AS present",
        input.effectId,
        sessionId,
      );
    },

    recordError(input): void {
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
        sessionId,
      );
      requireRelatedRows(sql, sessionId, input);
      sql.exec(
        `INSERT INTO errors (
          error_id, session_id, turn_id, step_id, code, message, retryable,
          status, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
        input.errorId,
        sessionId,
        optional(input.turnId),
        optional(input.stepId),
        input.code,
        input.message,
        input.retryable ? 1 : 0,
        input.createdAt,
      );
    },

    insertJob(input): void {
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM session_meta WHERE session_id = ?) AS present",
        sessionId,
      );
      sql.exec(
        `INSERT INTO jobs (
          job_id, session_id, kind, status, due_at, attempts, max_attempts,
          last_error, recovery_action, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.jobId,
        sessionId,
        input.kind,
        input.status ?? "pending",
        input.dueAt,
        input.attempts ?? 0,
        input.maxAttempts ?? 3,
        optional(input.lastError),
        optional(input.recoveryAction),
        input.createdAt,
        input.updatedAt ?? input.createdAt,
        optional(input.completedAt),
      );
    },

    updateJob(input): void {
      const assignments = ["status = ?", "updated_at = ?"];
      const bindings: EdenSqlValue[] = [input.status, input.updatedAt];
      if (input.dueAt !== undefined) {
        assignments.push("due_at = ?");
        bindings.push(input.dueAt);
      }
      if (input.attempts !== undefined) {
        assignments.push("attempts = ?");
        bindings.push(input.attempts);
      }
      if (input.lastError !== undefined) {
        assignments.push("last_error = ?");
        bindings.push(input.lastError);
      }
      if (input.recoveryAction !== undefined) {
        assignments.push("recovery_action = ?");
        bindings.push(input.recoveryAction);
      }
      if (input.completedAt !== undefined) {
        assignments.push("completed_at = ?");
        bindings.push(input.completedAt);
      }
      sql.exec(
        `UPDATE jobs SET ${assignments.join(", ")}
         WHERE job_id = ? AND session_id = ?`,
        ...bindings,
        input.jobId,
        sessionId,
      );
      requireRow(
        sql,
        "SELECT EXISTS (SELECT 1 FROM jobs WHERE job_id = ? AND session_id = ?) AS present",
        input.jobId,
        sessionId,
      );
    },
  };
}

export function commitSessionTransaction<T>(
  storage: EdenSessionStorage,
  sessionId: string,
  transition: (journal: JournalTransaction) => T,
): T {
  return storage.transactionSync(() =>
    transition(createJournal(storage.sql, sessionId)),
  );
}

function parseEvent(row: EventRow): EdenEvent {
  return {
    streamIndex: row.stream_index,
    eventId: row.event_id,
    type: row.type,
    data: JSON.parse(row.payload_json) as EdenEvent["data"],
    committedAt: row.committed_at,
  } as EdenEvent;
}

export interface JournalEventPageOptions {
  readonly endIndex?: number;
  readonly limit?: number;
}

export function readJournalEventsPage(
  sql: EdenSqlStorage,
  sessionId: string,
  startIndex = 0,
  options: JournalEventPageOptions = {},
): readonly EdenEvent[] {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new Error("Journal start index must be a non-negative safe integer");
  }
  const endIndex = options.endIndex;
  if (
    endIndex !== undefined &&
    (!Number.isSafeInteger(endIndex) || endIndex < 0)
  ) {
    throw new Error("Journal end index must be a non-negative safe integer");
  }
  const limit = options.limit ?? MAX_JOURNAL_EVENTS_PER_PAGE;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_JOURNAL_EVENTS_PER_PAGE
  ) {
    throw new Error("Journal page limit is invalid");
  }
  if (endIndex !== undefined && endIndex <= startIndex) return [];

  const conditions = ["session_id = ?", "stream_index > ?"];
  const bindings: EdenSqlValue[] = [sessionId, startIndex];
  if (endIndex !== undefined) {
    conditions.push("stream_index <= ?");
    bindings.push(endIndex);
  }

  const rows = sql
    .exec<EventRow>(
      `SELECT stream_index, event_id, type, payload_json, committed_at
       FROM events
       WHERE ${conditions.join(" AND ")}
       ORDER BY stream_index ASC
       LIMIT ?`,
      ...bindings,
      limit,
    )
    .toArray();
  return rows.map((row) => parseEvent(row));
}

export function readJournalEvents(
  sql: EdenSqlStorage,
  sessionId: string,
  startIndex = 0,
): readonly EdenEvent[] {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    throw new Error("Journal start index must be a non-negative safe integer");
  }

  const highWater = readLatestJournalCursor(sql, sessionId);
  const events: EdenEvent[] = [];
  let cursor = startIndex;
  while (cursor < highWater) {
    const page = readJournalEventsPage(sql, sessionId, cursor, {
      endIndex: highWater,
    });
    if (page.length === 0) break;
    events.push(...page);
    cursor = page[page.length - 1]?.streamIndex ?? cursor;
  }
  return events;
}

export function readLatestJournalCursor(
  sql: EdenSqlStorage,
  sessionId: string,
): number {
  const rows = sql
    .exec<{ stream_index: number | null }>(
      "SELECT MAX(stream_index) AS stream_index FROM events WHERE session_id = ?",
      sessionId,
    )
    .toArray();
  return rows[0]?.stream_index ?? 0;
}

import type {
  EdenEvent,
  EdenEventType,
  EdenJsonValue,
} from "@eden/definitions";

import type { EdenModelResult } from "./model-adapter.js";
import {
  commitSessionTransaction,
  readJournalEvents,
  readLatestJournalCursor,
  type EdenSessionStorage,
  type EdenSqlStorage,
} from "./session-journal.js";
import {
  MAX_BOUNDED_TURN_ATTEMPTS,
  finalResponseStepId,
  modelProjectionKey,
  modelToolStepId,
  now,
  type BeginTurnResult,
  type EdenBoundedTurnRequest,
  type ErrorRow,
  type MessageRow,
  type ProjectionRow,
  type StepPreparation,
  type StepRow,
  type StoredFailure,
  type TurnIdentity,
  type TurnMessageIdentity,
  type TurnRow,
} from "./turn-runner-types.js";

function readTurn(
  sql: EdenSqlStorage,
  sessionId: string,
  turnId: string,
): TurnRow | undefined {
  return sql
    .exec<TurnRow>(
      `SELECT turn_id, status, error_id
       FROM turns
       WHERE session_id = ? AND turn_id = ?`,
      sessionId,
      turnId,
    )
    .toArray()[0];
}

function readAssistantMessage(
  sql: EdenSqlStorage,
  sessionId: string,
  turnId: string,
): MessageRow | undefined {
  return sql
    .exec<MessageRow>(
      `SELECT message_id, role, content, completed_at
       FROM messages
       WHERE session_id = ? AND turn_id = ? AND role = 'assistant'
       ORDER BY created_at DESC, message_id DESC
       LIMIT 1`,
      sessionId,
      turnId,
    )
    .toArray()[0];
}

function readStep(
  sql: EdenSqlStorage,
  sessionId: string,
  stepId: string,
): StepRow | undefined {
  return sql
    .exec<StepRow>(
      `SELECT step_id, turn_id, logical_key, phase, status, attempt_count,
        error_id
       FROM steps
       WHERE session_id = ? AND step_id = ?`,
      sessionId,
      stepId,
    )
    .toArray()[0];
}

function readError(
  sql: EdenSqlStorage,
  sessionId: string,
  errorId: string | null,
): ErrorRow | undefined {
  if (errorId === null) return undefined;
  return sql
    .exec<ErrorRow>(
      `SELECT error_id, code, message, retryable
       FROM errors
       WHERE session_id = ? AND error_id = ?`,
      sessionId,
      errorId,
    )
    .toArray()[0];
}

function storedFailureForStep(
  sql: EdenSqlStorage,
  sessionId: string,
  step: StepRow,
): StoredFailure {
  const error = readError(sql, sessionId, step.error_id);
  if (error !== undefined) {
    return {
      code: error.code as StoredFailure["code"],
      message: error.message,
      retryable: error.retryable === 1,
      stepId: step.step_id,
    };
  }
  return {
    code: "turn_runner_invalid",
    message: "Turn step failed.",
    retryable: false,
    stepId: step.step_id,
  };
}

export function readProjection(
  sql: EdenSqlStorage,
  sessionId: string,
  key: string,
): EdenModelResult | undefined {
  const row = sql
    .exec<ProjectionRow>(
      `SELECT projection_json
       FROM projections
       WHERE session_id = ? AND projection_key = ?`,
      sessionId,
      key,
    )
    .toArray()[0];
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.projection_json) as EdenModelResult;
  } catch {
    return undefined;
  }
}

export async function deliverNewEvents(
  storage: EdenSessionStorage,
  sessionId: string,
  cursor: number,
  onEvent:
    | ((event: EdenEvent<EdenEventType>) => void | Promise<void>)
    | undefined,
): Promise<number> {
  if (onEvent === undefined) {
    return readLatestJournalCursor(storage.sql, sessionId);
  }
  const events = readJournalEvents(storage.sql, sessionId, cursor);
  for (const event of events) {
    await onEvent(event);
  }
  return readLatestJournalCursor(storage.sql, sessionId);
}

export function beginTurn<TInput, TOutput extends EdenJsonValue>(
  storage: EdenSessionStorage,
  request: EdenBoundedTurnRequest<TInput, TOutput>,
): BeginTurnResult {
  return commitSessionTransaction(storage, request.sessionId, (journal) => {
    const finalStepId = finalResponseStepId(request.turnId);
    const turn = readTurn(storage.sql, request.sessionId, request.turnId);
    if (turn?.status === "completed") {
      const assistant = readAssistantMessage(
        storage.sql,
        request.sessionId,
        request.turnId,
      );
      if (assistant?.completed_at !== null && assistant !== undefined) {
        return {
          status: "completed",
          messageId: assistant.message_id,
          content: assistant.content,
        };
      }
      return {
        status: "failed",
        failure: {
          code: "turn_runner_invalid",
          message: "Completed turn has no final message.",
          retryable: false,
          stepId: finalStepId,
        },
      };
    }

    if (turn?.status === "failed") {
      const stored = readError(storage.sql, request.sessionId, turn.error_id);
      if (stored !== undefined && stored.retryable === 0) {
        return {
          status: "failed",
          failure: {
            code: stored.code as StoredFailure["code"],
            message: stored.message,
            retryable: false,
            ...(stored.error_id.includes(finalStepId)
              ? { stepId: finalStepId }
              : {}),
          },
        };
      }
      journal.updateTurn({
        turnId: request.turnId,
        status: "running",
        startedAt: now(),
        failedAt: null,
        errorId: null,
      });
      journal.setSessionStatus("running");
      return { status: "continue" };
    }

    if (turn !== undefined) {
      journal.updateTurn({
        turnId: request.turnId,
        status: "running",
        startedAt: now(),
      });
      journal.setSessionStatus("running");
      return { status: "continue" };
    }

    const timestamp = now();
    const hasSessionStarted = storage.sql
      .exec<{ readonly present: number }>(
        `SELECT EXISTS (
           SELECT 1 FROM events
           WHERE session_id = ? AND type = 'session.started'
         ) AS present`,
        request.sessionId,
      )
      .toArray()[0]?.present === 1;
    if (!hasSessionStarted) {
      const version = storage.sql
        .exec<{
          readonly runtime_version: string;
          readonly agent_bundle_version: string;
          readonly manifest_version: string;
          readonly protocol_version: string;
          readonly artifact_schema_version: number;
        }>(
          `SELECT runtime_version, agent_bundle_version, manifest_version,
            protocol_version, artifact_schema_version
           FROM session_meta
           WHERE session_id = ?`,
          request.sessionId,
        )
        .toArray()[0];
      if (version === undefined) {
        throw new Error("Turn session is not initialized");
      }
      journal.appendEvent({
        type: "session.started",
        data: {
          sessionId: request.sessionId,
          status: "new",
          versions: {
            runtime: version.runtime_version,
            agentBundle: version.agent_bundle_version,
            manifest: version.manifest_version,
            protocol: version.protocol_version,
            schema: version.artifact_schema_version,
          },
        },
        committedAt: timestamp,
      });
    }

    journal.insertTurn({
      turnId: request.turnId,
      status: "running",
      acceptedAt: timestamp,
      startedAt: timestamp,
    });
    journal.insertMessage({
      messageId: request.messageId,
      turnId: request.turnId,
      role: "user",
      content: request.message,
      createdAt: timestamp,
    });
    journal.setSessionStatus("running", timestamp);
    journal.appendEvent({
      type: "turn.started",
      turnId: request.turnId,
      data: { turnId: request.turnId },
      committedAt: timestamp,
    });
    journal.appendEvent({
      type: "message.received",
      turnId: request.turnId,
      data: { messageId: request.messageId, role: "user" },
      committedAt: timestamp,
    });
    return { status: "continue" };
  });
}

export function ensureModelToolStep(
  storage: EdenSessionStorage,
  request: TurnIdentity,
): void {
  commitSessionTransaction(storage, request.sessionId, (journal) => {
    const stepId = modelToolStepId(request.turnId);
    const existing = readStep(storage.sql, request.sessionId, stepId);
    if (existing !== undefined) return;
    const timestamp = now();
    journal.insertStep({
      stepId,
      turnId: request.turnId,
      logicalKey: "tool:bounded-turn",
      phase: "model-tool",
      status: "running",
      attemptCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    journal.appendEvent({
      type: "step.started",
      turnId: request.turnId,
      stepId,
      data: { stepId, phase: "model-tool" },
      committedAt: timestamp,
    });
  });
}

export function prepareModelAttempt(
  storage: EdenSessionStorage,
  request: TurnIdentity,
): StepPreparation {
  const stored = readProjection(
    storage.sql,
    request.sessionId,
    modelProjectionKey(request.turnId),
  );
  if (stored !== undefined) {
    return { status: "replayed", result: stored };
  }

  return commitSessionTransaction(storage, request.sessionId, (journal) => {
    const stepId = modelToolStepId(request.turnId);
    const step = readStep(storage.sql, request.sessionId, stepId);
    if (step === undefined) {
      throw new Error("Model/tool step is missing");
    }
    if (step.status === "failed") {
      return {
        status: "failed",
        failure: storedFailureForStep(storage.sql, request.sessionId, step),
      };
    }
    if (step.attempt_count >= MAX_BOUNDED_TURN_ATTEMPTS) {
      return {
        status: "failed",
        failure: {
          code: "model_call_failed",
          message: "Model call retry limit reached.",
          retryable: false,
          stepId,
        },
      };
    }
    const timestamp = now();
    const attemptCount = step.attempt_count + 1;
    journal.updateStep({
      stepId,
      status: "running",
      attemptCount,
      errorId: null,
      updatedAt: timestamp,
    });
    return { status: "execute", attemptCount };
  });
}

export function commitModelProjection(
  storage: EdenSessionStorage,
  request: TurnIdentity,
  attemptCount: number,
  result: EdenModelResult,
): boolean {
  return commitSessionTransaction(storage, request.sessionId, (journal) => {
    const stepId = modelToolStepId(request.turnId);
    const step = readStep(storage.sql, request.sessionId, stepId);
    if (
      step === undefined ||
      step.status !== "running" ||
      step.attempt_count !== attemptCount
    ) {
      return (
        readProjection(
          storage.sql,
          request.sessionId,
          modelProjectionKey(request.turnId),
        ) !== undefined
      );
    }
    journal.upsertProjection(
      modelProjectionKey(request.turnId),
      result as unknown as EdenJsonValue,
    );
    return true;
  });
}

export function recordStepFailure(
  storage: EdenSessionStorage,
  request: TurnIdentity,
  stepId: string,
  input: StoredFailure,
): { readonly failure: StoredFailure; readonly stepWasAlreadyFailed: boolean } {
  return commitSessionTransaction(storage, request.sessionId, (journal) => {
    const step = readStep(storage.sql, request.sessionId, stepId);
    if (step === undefined) {
      throw new Error("Failed step is missing");
    }
    if (step.status === "failed") {
      return {
        failure: storedFailureForStep(storage.sql, request.sessionId, step),
        stepWasAlreadyFailed: true,
      };
    }
    if (step.status === "completed") {
      return {
        failure: input,
        stepWasAlreadyFailed: true,
      };
    }

    const retryable =
      input.retryable && step.attempt_count < MAX_BOUNDED_TURN_ATTEMPTS;
    const status = retryable ? "retryable" : "failed";
    const timestamp = now();
    const errorId = `err_${stepId}_${step.attempt_count}`;
    const persisted: StoredFailure = {
      ...input,
      retryable,
      stepId,
    };
    journal.updateStep({
      stepId,
      status,
      errorId,
      updatedAt: timestamp,
      ...(status === "failed" ? { completedAt: timestamp } : {}),
    });
    journal.recordError({
      errorId,
      turnId: request.turnId,
      stepId,
      code: persisted.code,
      message: persisted.message,
      retryable: persisted.retryable,
      createdAt: timestamp,
    });
    journal.appendEvent({
      type: "step.failed",
      turnId: request.turnId,
      stepId,
      data: {
        stepId,
        code: persisted.code,
        message: persisted.message,
        retryable: persisted.retryable,
      },
      committedAt: timestamp,
    });
    return { failure: persisted, stepWasAlreadyFailed: false };
  });
}

export function recordTurnFailure(
  storage: EdenSessionStorage,
  request: TurnIdentity,
  input: StoredFailure,
): void {
  commitSessionTransaction(storage, request.sessionId, (journal) => {
    const turn = readTurn(storage.sql, request.sessionId, request.turnId);
    if (turn === undefined) {
      throw new Error("Failed turn is missing");
    }
    if (turn.status === "completed") return;
    if (turn.status === "failed" && turn.error_id !== null) return;
    const timestamp = now();
    const errorId =
      turn.error_id ??
      `err_turn_${request.turnId}_${readLatestJournalCursor(
        storage.sql,
        request.sessionId,
      ) + 1}`;
    if (turn.error_id === null) {
      journal.recordError({
        errorId,
        turnId: request.turnId,
        ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
        code: input.code,
        message: input.message,
        retryable: input.retryable,
        createdAt: timestamp,
      });
    }
    journal.updateTurn({
      turnId: request.turnId,
      status: "failed",
      failedAt: timestamp,
      errorId,
    });
    journal.setSessionStatus("failed", timestamp);
    journal.appendEvent({
      type: "turn.failed",
      turnId: request.turnId,
      data: {
        turnId: request.turnId,
        code: input.code,
        message: input.message,
        retryable: input.retryable,
      },
      committedAt: timestamp,
    });
    journal.appendEvent({
      type: "session.failed",
      data: {
        code: input.code,
        message: input.message,
        retryable: input.retryable,
      },
      committedAt: timestamp,
    });
  });
}

export function completeModelToolStep(
  storage: EdenSessionStorage,
  request: TurnIdentity,
): void {
  commitSessionTransaction(storage, request.sessionId, (journal) => {
    const stepId = modelToolStepId(request.turnId);
    const alreadyCompleted = storage.sql
      .exec<{ readonly present: number }>(
        `SELECT EXISTS (
           SELECT 1 FROM events
           WHERE session_id = ? AND step_id = ? AND type = 'step.completed'
         ) AS present`,
        request.sessionId,
        stepId,
      )
      .toArray()[0]?.present === 1;
    if (alreadyCompleted) return;
    const step = readStep(storage.sql, request.sessionId, stepId);
    if (step?.status !== "completed") {
      throw new Error("Model/tool step did not complete");
    }
    journal.appendEvent({
      type: "step.completed",
      turnId: request.turnId,
      stepId,
      data: { stepId, phase: "model-tool" },
      committedAt: now(),
    });
  });
}

export function persistToolMessage(
  storage: EdenSessionStorage,
  request: TurnIdentity,
  call: { readonly callId: string },
  output: EdenJsonValue,
): void {
  commitSessionTransaction(storage, request.sessionId, (journal) => {
    const messageId = `msg_tool_${encodeURIComponent(request.turnId)}_${encodeURIComponent(call.callId)}`;
    const existing = storage.sql
      .exec<{ readonly message_id: string }>(
        `SELECT message_id
         FROM messages
         WHERE session_id = ? AND message_id = ?`,
        request.sessionId,
        messageId,
      )
      .toArray()[0];
    if (existing !== undefined) return;
    const timestamp = now();
    journal.insertMessage({
      messageId,
      turnId: request.turnId,
      role: "tool",
      content: JSON.stringify(output),
      createdAt: timestamp,
      completedAt: timestamp,
    });
  });
}

export function prepareFinalStep(
  storage: EdenSessionStorage,
  request: TurnIdentity,
): { readonly status: "execute"; readonly attemptCount: number } | {
  readonly status: "failed";
  readonly failure: StoredFailure;
} {
  return commitSessionTransaction(storage, request.sessionId, (journal) => {
    const stepId = finalResponseStepId(request.turnId);
    const existing = readStep(storage.sql, request.sessionId, stepId);
    if (existing?.status === "failed") {
      return {
        status: "failed",
        failure: storedFailureForStep(storage.sql, request.sessionId, existing),
      };
    }
    const timestamp = now();
    if (existing === undefined) {
      journal.insertStep({
        stepId,
        turnId: request.turnId,
        logicalKey: "final-response",
        phase: "final-response",
        status: "running",
        attemptCount: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      journal.appendEvent({
        type: "step.started",
        turnId: request.turnId,
        stepId,
        data: { stepId, phase: "final-response" },
        committedAt: timestamp,
      });
      return { status: "execute", attemptCount: 1 };
    }
    if (existing.status === "completed") {
      const assistant = readAssistantMessage(
        storage.sql,
        request.sessionId,
        request.turnId,
      );
      if (assistant?.completed_at !== null && assistant !== undefined) {
        throw new Error("Final response was already committed");
      }
    }
    if (existing.attempt_count >= MAX_BOUNDED_TURN_ATTEMPTS) {
      return {
        status: "failed",
        failure: {
          code: "final_response_failed",
          message: "Final response retry limit reached.",
          retryable: false,
          stepId,
        },
      };
    }
    const attemptCount = existing.attempt_count + 1;
    journal.updateStep({
      stepId,
      status: "running",
      attemptCount,
      errorId: null,
      updatedAt: timestamp,
      completedAt: null,
    });
    return { status: "execute", attemptCount };
  });
}

export function commitFinalResponse(
  storage: EdenSessionStorage,
  request: TurnMessageIdentity,
  content: string,
  attemptCount: number,
): void {
  commitSessionTransaction(storage, request.sessionId, (journal) => {
    const stepId = finalResponseStepId(request.turnId);
    const finalStep = readStep(storage.sql, request.sessionId, stepId);
    if (
      finalStep === undefined ||
      finalStep.status !== "running" ||
      finalStep.attempt_count !== attemptCount
    ) {
      const assistant = readAssistantMessage(
        storage.sql,
        request.sessionId,
        request.turnId,
      );
      if (assistant?.completed_at !== null && assistant !== undefined) return;
      throw new Error("Final response checkpoint is stale");
    }
    const timestamp = now();
    const assistant = readAssistantMessage(
      storage.sql,
      request.sessionId,
      request.turnId,
    );
    if (assistant === undefined) {
      journal.insertMessage({
        messageId: request.messageId,
        turnId: request.turnId,
        role: "assistant",
        content,
        createdAt: timestamp,
        completedAt: timestamp,
      });
    } else {
      journal.updateMessage({
        messageId: assistant.message_id,
        content,
        completedAt: timestamp,
      });
    }
    journal.upsertProjection(
      `turn:${request.turnId}:final-response`,
      content,
      timestamp,
    );
    journal.updateStep({
      stepId,
      status: "completed",
      attemptCount,
      updatedAt: timestamp,
      completedAt: timestamp,
    });
    journal.updateTurn({
      turnId: request.turnId,
      status: "completed",
      completedAt: timestamp,
      failedAt: null,
      errorId: null,
    });
    journal.setSessionStatus("waiting", timestamp);
    const messageId = assistant?.message_id ?? request.messageId;
    journal.appendEvent({
      type: "message.completed",
      turnId: request.turnId,
      stepId,
      data: { messageId, role: "assistant", content },
      committedAt: timestamp,
    });
    journal.appendEvent({
      type: "step.completed",
      turnId: request.turnId,
      stepId,
      data: { stepId, phase: "final-response" },
      committedAt: timestamp,
    });
    journal.appendEvent({
      type: "turn.completed",
      turnId: request.turnId,
      data: { turnId: request.turnId },
      committedAt: timestamp,
    });
    journal.appendEvent({
      type: "session.waiting",
      data: { status: "waiting" },
      committedAt: timestamp,
    });
  });
}

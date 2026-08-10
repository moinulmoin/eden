import type {
  EdenJsonValue,
  EdenStepPhase,
} from "@eden/definitions";

import {
  commitSessionTransaction,
  type EdenSessionStorage,
  type EdenSqlStorage,
} from "./session-journal.js";

export const MAX_CHECKPOINT_ATTEMPTS = 3;

export interface StableEffectIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly logicalStep: string;
  readonly callId: string;
  readonly toolName: string;
  readonly bundleIdentity: string;
}

export function createStableEffectIdempotencyKey(
  identity: StableEffectIdentity,
): string {
  const fields = [
    identity.sessionId,
    identity.turnId,
    identity.logicalStep,
    identity.callId,
    identity.toolName,
    identity.bundleIdentity,
  ];
  return `eden-effect-v1:${fields.map((field) => encodeURIComponent(field)).join(":")}`;
}

export const createEffectIdempotencyKey = createStableEffectIdempotencyKey;

export interface CheckpointRequest extends StableEffectIdentity {
  readonly stepId: string;
  readonly phase: EdenStepPhase;
  readonly effectId: string;
  readonly input: EdenJsonValue;
}

export interface PreparedCheckpoint {
  readonly request: CheckpointRequest;
  readonly idempotencyKey: string;
  readonly attemptCount: number;
}

export type CheckpointPreparation =
  | {
      readonly status: "execute";
      readonly prepared: PreparedCheckpoint;
      readonly attemptCount: number;
    }
  | {
      readonly status: "replayed";
      readonly output: EdenJsonValue;
    }
  | {
      readonly status: "exhausted";
      readonly attemptCount: number;
    };

export type CheckpointCommitResult =
  | {
      readonly status: "committed" | "replayed";
      readonly output: EdenJsonValue;
    }
  | {
      readonly status: "stale";
    }
  | {
      readonly status: "exhausted";
    };

interface StepCheckpointRow {
  readonly [key: string]: string | number | null;
  readonly step_id: string;
  readonly turn_id: string;
  readonly logical_key: string;
  readonly phase: EdenStepPhase;
  readonly status: "pending" | "running" | "completed" | "retryable" | "failed";
  readonly attempt_count: number;
  readonly result_ref: string | null;
}

interface EffectCheckpointRow {
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
}

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Checkpoint values must be JSON-compatible");
  }
  return serialized;
}

function readStep(
  sql: EdenSqlStorage,
  request: CheckpointRequest,
): StepCheckpointRow | undefined {
  return sql
    .exec<StepCheckpointRow>(
      `SELECT step_id, turn_id, logical_key, phase, status, attempt_count,
        result_ref
       FROM steps
       WHERE session_id = ? AND step_id = ?`,
      request.sessionId,
      request.stepId,
    )
    .toArray()[0];
}

function readEffect(
  sql: EdenSqlStorage,
  request: CheckpointRequest,
  idempotencyKey: string,
): EffectCheckpointRow | undefined {
  const byKey = sql
    .exec<EffectCheckpointRow>(
      `SELECT effect_id, turn_id, step_id, call_id, tool_name,
        idempotency_key, status, input_json, output_json
       FROM effects
       WHERE session_id = ? AND idempotency_key = ?`,
      request.sessionId,
      idempotencyKey,
    )
    .toArray()[0];
  if (byKey !== undefined) return byKey;

  return sql
    .exec<EffectCheckpointRow>(
      `SELECT effect_id, turn_id, step_id, call_id, tool_name,
        idempotency_key, status, input_json, output_json
       FROM effects
       WHERE session_id = ? AND effect_id = ?`,
      request.sessionId,
      request.effectId,
    )
    .toArray()[0];
}

function assertIdentity(
  request: CheckpointRequest,
  idempotencyKey: string,
  step: StepCheckpointRow | undefined,
  effect: EffectCheckpointRow | undefined,
): void {
  if (
    step !== undefined &&
    (step.turn_id !== request.turnId ||
      step.logical_key !== request.logicalStep ||
      step.phase !== request.phase)
  ) {
    throw new Error("Checkpoint step identity conflicts with durable state");
  }
  if (
    effect !== undefined &&
    (effect.effect_id !== request.effectId ||
      effect.turn_id !== request.turnId ||
      effect.step_id !== request.stepId ||
      effect.call_id !== request.callId ||
      effect.tool_name !== request.toolName ||
      effect.idempotency_key !== idempotencyKey ||
      effect.input_json !== json(request.input))
  ) {
    throw new Error("Checkpoint effect identity conflicts with durable state");
  }
}

function readCompletedOutput(effect: EffectCheckpointRow): EdenJsonValue {
  if (effect.output_json === null) {
    throw new Error("Completed checkpoint effect has no durable result");
  }
  return JSON.parse(effect.output_json) as EdenJsonValue;
}

export function prepareCheckpointAttempt(
  storage: EdenSessionStorage,
  request: CheckpointRequest,
): CheckpointPreparation {
  const idempotencyKey = createStableEffectIdempotencyKey(request);

  return commitSessionTransaction(storage, request.sessionId, (journal) => {
    const step = readStep(storage.sql, request);
    const effect = readEffect(storage.sql, request, idempotencyKey);
    assertIdentity(request, idempotencyKey, step, effect);

    if (effect?.status === "completed") {
      const output = readCompletedOutput(effect);
      if (step?.status !== "completed" || step.result_ref !== effect.effect_id) {
        const timestamp = now();
        journal.updateStep({
          stepId: request.stepId,
          status: "completed",
          resultRef: effect.effect_id,
          completedAt: timestamp,
          updatedAt: timestamp,
        });
      }
      return { status: "replayed", output };
    }
    if (effect?.status === "failed") {
      throw new Error("Checkpoint effect is durably failed");
    }
    if (step?.status === "failed") {
      throw new Error("Checkpoint step is durably failed");
    }

    if (step !== undefined && step.attempt_count >= MAX_CHECKPOINT_ATTEMPTS) {
      const timestamp = now();
      const errorId = `err_checkpoint_${request.stepId}`;
      const error = {
        code: "checkpoint_attempts_exhausted",
        message: "Checkpoint retry limit reached",
        retryable: false,
      } as const;
      if (effect !== undefined) {
        journal.failEffect({
          effectId: request.effectId,
          error,
          updatedAt: timestamp,
        });
      }
      journal.updateStep({
        stepId: request.stepId,
        status: "failed",
        errorId,
        resultRef: null,
        updatedAt: timestamp,
      });
      journal.recordError({
        errorId,
        turnId: request.turnId,
        stepId: request.stepId,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        createdAt: timestamp,
      });
      journal.appendEvent({
        type: "step.failed",
        turnId: request.turnId,
        stepId: request.stepId,
        data: {
          stepId: request.stepId,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
        committedAt: timestamp,
      });
      return {
        status: "exhausted",
        attemptCount: step.attempt_count,
      };
    }

    const timestamp = now();
    const attemptCount = (step?.attempt_count ?? 0) + 1;
    if (step === undefined) {
      journal.insertStep({
        stepId: request.stepId,
        turnId: request.turnId,
        logicalKey: request.logicalStep,
        phase: request.phase,
        status: "running",
        attemptCount,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } else {
      journal.updateStep({
        stepId: request.stepId,
        status: "running",
        attemptCount,
        errorId: null,
        updatedAt: timestamp,
      });
    }

    if (effect === undefined) {
      journal.requestEffect({
        effectId: request.effectId,
        turnId: request.turnId,
        stepId: request.stepId,
        callId: request.callId,
        toolName: request.toolName,
        idempotencyKey,
        input: request.input,
        createdAt: timestamp,
      });
      journal.startEffect({
        effectId: request.effectId,
        updatedAt: timestamp,
      });
      journal.appendEvent({
        type: "actions.requested",
        turnId: request.turnId,
        stepId: request.stepId,
        data: {
          stepId: request.stepId,
          actions: [
            {
              callId: request.callId,
              toolName: request.toolName,
              input: request.input,
            },
          ],
        },
        committedAt: timestamp,
      });
    } else {
      storage.sql.exec(
        `UPDATE effects
         SET status = 'running', updated_at = ?, error_json = NULL
         WHERE session_id = ? AND effect_id = ?
           AND status IN ('requested', 'running')`,
        timestamp,
        request.sessionId,
        request.effectId,
      );
    }

    return {
      status: "execute",
      prepared: {
        request,
        idempotencyKey,
        attemptCount,
      },
      attemptCount,
    };
  });
}

export function commitCheckpointResult(
  storage: EdenSessionStorage,
  prepared: PreparedCheckpoint,
  output: EdenJsonValue,
  completedAt = now(),
): CheckpointCommitResult {
  return commitSessionTransaction(
    storage,
    prepared.request.sessionId,
    (journal) => {
      const step = readStep(storage.sql, prepared.request);
      const effect = readEffect(
        storage.sql,
        prepared.request,
        prepared.idempotencyKey,
      );
      assertIdentity(
        prepared.request,
        prepared.idempotencyKey,
        step,
        effect,
      );
      if (effect === undefined || step === undefined) {
        throw new Error("Checkpoint durable state is missing");
      }
      if (effect.status === "completed") {
        const existingOutput = readCompletedOutput(effect);
        return JSON.stringify(existingOutput) === JSON.stringify(output)
          ? { status: "replayed", output: existingOutput }
          : { status: "stale" };
      }
      if (
        step.attempt_count !== prepared.attemptCount ||
        step.status !== "running" ||
        effect.status !== "running"
      ) {
        return { status: "stale" };
      }

      journal.completeEffect({
        effectId: prepared.request.effectId,
        output,
        completedAt,
      });
      journal.updateStep({
        stepId: prepared.request.stepId,
        status: "completed",
        attemptCount: prepared.attemptCount,
        resultRef: prepared.request.effectId,
        completedAt,
        updatedAt: completedAt,
      });
      journal.appendEvent({
        type: "action.result",
        turnId: prepared.request.turnId,
        stepId: prepared.request.stepId,
        data: {
          stepId: prepared.request.stepId,
          callId: prepared.request.callId,
          toolName: prepared.request.toolName,
          output,
        },
        committedAt: completedAt,
      });
      return { status: "committed", output };
    },
  );
}

export function markCheckpointRetryable(
  storage: EdenSessionStorage,
  prepared: PreparedCheckpoint,
  updatedAt = now(),
): boolean {
  return storage.transactionSync(() => {
    const step = readStep(storage.sql, prepared.request);
    const effect = readEffect(
      storage.sql,
      prepared.request,
      prepared.idempotencyKey,
    );
    if (
      step === undefined ||
      effect === undefined ||
      effect.status === "completed" ||
      effect.status === "failed" ||
      step.attempt_count !== prepared.attemptCount ||
      step.status !== "running"
    ) {
      return false;
    }
    storage.sql.exec(
      `UPDATE steps
       SET status = 'retryable', updated_at = ?
       WHERE session_id = ? AND step_id = ? AND attempt_count = ?`,
      updatedAt,
      prepared.request.sessionId,
      prepared.request.stepId,
      prepared.attemptCount,
    );
    return true;
  });
}

export async function reenterCheckpoint<TOutput extends EdenJsonValue>(
  storage: EdenSessionStorage,
  request: CheckpointRequest,
  execute: (prepared: PreparedCheckpoint) => TOutput | Promise<TOutput>,
): Promise<CheckpointCommitResult> {
  const prepared = prepareCheckpointAttempt(storage, request);
  if (prepared.status === "replayed") return prepared;
  if (prepared.status === "exhausted") return prepared;

  let output: TOutput;
  try {
    output = await execute(prepared.prepared);
  } catch (error) {
    markCheckpointRetryable(storage, prepared.prepared);
    throw error;
  }

  return commitCheckpointResult(storage, prepared.prepared, output);
}

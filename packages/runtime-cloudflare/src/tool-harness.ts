import type {
  EdenJsonValue,
  EdenStandardSchemaIssue,
  EdenStandardSchemaResult,
  EdenStandardSchemaV1,
  EdenToolContext,
  EdenToolDefinition,
} from "@moinulmoin/eden-definitions";
import { normalizeEdenJsonValue } from "./model-normalizers.js";

import {
  commitCheckpointResult,
  createStableEffectIdempotencyKey,
  markCheckpointRetryable,
  prepareCheckpointAttempt,
  type CheckpointRequest,
  type CheckpointPreparation,
  type PreparedCheckpoint,
} from "./session-checkpoint.js";
import {
  commitSessionTransaction,
  type EdenSessionStorage,
} from "./session-journal.js";

export interface EdenToolHarnessRequest<
  TInput,
  TOutput extends EdenJsonValue = EdenJsonValue,
> extends Omit<CheckpointRequest, "input"> {
  readonly input: EdenJsonValue;
  readonly tool: EdenToolDefinition<TInput, TOutput>;
  readonly signal?: AbortSignal;
}

export type EdenToolFailureCode =
  | "tool_input_invalid"
  | "tool_output_invalid";

export interface EdenToolFailure {
  readonly code: EdenToolFailureCode;
  readonly message: string;
  readonly retryable: false;
}

export type EdenToolHarnessResult<
  TOutput extends EdenJsonValue = EdenJsonValue,
> =
  | {
      readonly status: "committed" | "replayed";
      readonly output: TOutput;
      readonly idempotencyKey: string;
      readonly attemptCount: number;
    }
  | {
      readonly status: "failed";
      readonly error: EdenToolFailure;
      readonly idempotencyKey: string;
      readonly attemptCount: number;
    }
  | {
      readonly status: "stale" | "exhausted";
      readonly idempotencyKey: string;
      readonly attemptCount: number;
    };

const TOOL_INPUT_FAILURE: EdenToolFailure = Object.freeze({
  code: "tool_input_invalid",
  message: "Tool input failed schema validation.",
  retryable: false,
});

const TOOL_OUTPUT_FAILURE: EdenToolFailure = Object.freeze({
  code: "tool_output_invalid",
  message: "Tool output was not JSON-compatible.",
  retryable: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validIssuePath(value: unknown): value is readonly (string | number)[] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (segment) => typeof segment === "string" || typeof segment === "number",
      ))
  );
}

function validIssue(value: unknown): value is EdenStandardSchemaIssue {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    validIssuePath(value.path)
  );
}

function parseSchemaResult<TOutput>(
  value: unknown,
): EdenStandardSchemaResult<TOutput> | undefined {
  if (!isRecord(value)) return undefined;
  const hasValue = hasOwn(value, "value");
  const hasIssues = hasOwn(value, "issues");
  if (hasValue && !hasIssues) {
    return { value: value.value as TOutput };
  }
  if (
    !hasValue &&
    hasIssues &&
    Array.isArray(value.issues) &&
    value.issues.length > 0 &&
    value.issues.every(validIssue)
  ) {
    return {
      issues: value.issues as readonly EdenStandardSchemaIssue[],
    };
  }
  return undefined;
}

async function validateToolInput<TInput>(
  schema: EdenStandardSchemaV1<TInput>,
  input: unknown,
): Promise<{ readonly status: "valid"; readonly value: TInput } | {
  readonly status: "invalid";
}> {
  const descriptor = schema?.["~standard"];
  if (
    descriptor === undefined ||
    descriptor.version !== 1 ||
    typeof descriptor.vendor !== "string" ||
    descriptor.vendor.trim().length === 0 ||
    typeof descriptor.validate !== "function"
  ) {
    return { status: "invalid" };
  }

  let rawResult: unknown;
  try {
    rawResult = await descriptor.validate(input);
  } catch {
    return { status: "invalid" };
  }

  const result = parseSchemaResult<TInput>(rawResult);
  if (result === undefined || "issues" in result) {
    return { status: "invalid" };
  }
  return { status: "valid", value: result.value };
}

function contextFor<TInput, TOutput extends EdenJsonValue>(
  request: EdenToolHarnessRequest<TInput, TOutput>,
  prepared: PreparedCheckpoint,
): EdenToolContext {
  return Object.freeze({
    sessionId: request.sessionId,
    turnId: request.turnId,
    callId: request.callId,
    toolName: request.toolName,
    idempotencyKey: prepared.idempotencyKey,
    signal: request.signal ?? new AbortController().signal,
  });
}

function now(): string {
  return new Date().toISOString();
}

function failTool<TInput, TOutput extends EdenJsonValue>(
  storage: EdenSessionStorage,
  request: EdenToolHarnessRequest<TInput, TOutput>,
  prepared: PreparedCheckpoint,
  toolFailure: EdenToolFailure,
): EdenToolHarnessResult<TOutput> {
  const committed = commitSessionTransaction(
    storage,
    request.sessionId,
    (journal) => {
      const timestamp = now();
      const errorId =
        toolFailure.code === "tool_input_invalid"
          ? `err_tool_input_${request.stepId}`
          : `err_tool_output_${request.stepId}`;
      const step = storage.sql
        .exec<{
          readonly status: string;
          readonly attempt_count: number;
        }>(
          `SELECT status, attempt_count
           FROM steps
           WHERE session_id = ? AND step_id = ?`,
          request.sessionId,
          request.stepId,
        )
        .toArray()[0];
      const effect = storage.sql
        .exec<{
          readonly status: string;
        }>(
          `SELECT status
           FROM effects
           WHERE session_id = ? AND effect_id = ?`,
          request.sessionId,
          request.effectId,
        )
        .toArray()[0];
      if (
        step === undefined ||
        effect === undefined ||
        step.status !== "running" ||
        step.attempt_count !== prepared.attemptCount ||
        effect.status !== "running"
      ) {
        return false;
      }

      journal.failEffect({
        effectId: request.effectId,
        error: {
          code: toolFailure.code,
          message: toolFailure.message,
          retryable: toolFailure.retryable,
        },
        updatedAt: timestamp,
      });
      journal.updateStep({
        stepId: request.stepId,
        status: "failed",
        attemptCount: prepared.attemptCount,
        resultRef: null,
        errorId,
        updatedAt: timestamp,
        completedAt: timestamp,
      });
      journal.recordError({
        errorId,
        turnId: request.turnId,
        stepId: request.stepId,
        code: toolFailure.code,
        message: toolFailure.message,
        retryable: toolFailure.retryable,
        createdAt: timestamp,
      });
      journal.appendEvent({
        type: "step.failed",
        turnId: request.turnId,
        stepId: request.stepId,
        data: {
          stepId: request.stepId,
          code: toolFailure.code,
          message: toolFailure.message,
          retryable: toolFailure.retryable,
        },
        committedAt: timestamp,
      });
      return true;
    },
  );

  if (!committed) {
    return {
      status: "stale",
      idempotencyKey: prepared.idempotencyKey,
      attemptCount: prepared.attemptCount,
    };
  }

  return {
    status: "failed",
    error: toolFailure,
    idempotencyKey: prepared.idempotencyKey,
    attemptCount: prepared.attemptCount,
  };
}

function resultFromPreparation<TOutput extends EdenJsonValue>(
  storage: EdenSessionStorage,
  request: Pick<EdenToolHarnessRequest<never, TOutput>, "sessionId" | "stepId">,
  preparation: CheckpointPreparation,
  idempotencyKey: string,
): EdenToolHarnessResult<TOutput> | undefined {
  if (preparation.status === "replayed") {
    const row = storage.sql
      .exec<{ readonly attempt_count: number }>(
        `SELECT attempt_count
         FROM steps
         WHERE session_id = ? AND step_id = ?`,
        request.sessionId,
        request.stepId,
      )
      .toArray()[0];
    return {
      status: "replayed",
      output: preparation.output as TOutput,
      idempotencyKey,
      attemptCount: row?.attempt_count ?? 0,
    };
  }
  if (preparation.status === "exhausted") {
    return {
      status: "exhausted",
      idempotencyKey,
      attemptCount: preparation.attemptCount,
    };
  }
  return undefined;
}

export async function executeTypedTool<
  TInput,
  TOutput extends EdenJsonValue = EdenJsonValue,
>(
  storage: EdenSessionStorage,
  request: EdenToolHarnessRequest<TInput, TOutput>,
): Promise<EdenToolHarnessResult<TOutput>> {
  const idempotencyKey = createStableEffectIdempotencyKey(request);
  const preparation = prepareCheckpointAttempt(storage, request);
  const preparedResult = resultFromPreparation<TOutput>(
    storage,
    request,
    preparation,
    idempotencyKey,
  );
  if (preparedResult !== undefined) return preparedResult;
  if (preparation.status !== "execute") {
    throw new Error("Tool checkpoint preparation was incomplete");
  }

  const validated = await validateToolInput(
    request.tool.inputSchema,
    request.input,
  );
  if (validated.status === "invalid") {
    return failTool(
      storage,
      request,
      preparation.prepared,
      TOOL_INPUT_FAILURE,
    );
  }

  let output: TOutput;
  try {
    output = await request.tool.execute(
      validated.value,
      contextFor(request, preparation.prepared),
    );
  } catch (error) {
    markCheckpointRetryable(storage, preparation.prepared);
    throw error;
  }

  const normalizedOutput = normalizeEdenJsonValue(output);
  if (normalizedOutput === undefined) {
    return failTool(
      storage,
      request,
      preparation.prepared,
      TOOL_OUTPUT_FAILURE,
    );
  }

  const committed = commitCheckpointResult(
    storage,
    preparation.prepared,
    normalizedOutput,
  );
  if (committed.status === "committed" || committed.status === "replayed") {
    return {
      status: committed.status,
      output: committed.output as TOutput,
      idempotencyKey,
      attemptCount: preparation.attemptCount,
    };
  }
  return {
    status: committed.status,
    idempotencyKey,
    attemptCount: preparation.attemptCount,
  };
}

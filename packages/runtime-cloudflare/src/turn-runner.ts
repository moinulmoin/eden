import type {
  EdenJsonValue,
} from "@moinulmoin/eden-definitions";

import {
  executeTypedTool,
  type EdenToolHarnessResult,
} from "./tool-harness.js";
import {
  readLatestJournalCursor,
  type EdenSessionStorage,
} from "./session-journal.js";
import {
  normalizeEdenJsonValue,
  type EdenModelFailure,
  type EdenModelMessage,
  type EdenModelResult,
} from "./model-adapter.js";
import {
  assistantMessageId,
  bytes,
  finalResponseStepId,
  modelProjectionKey,
  modelToolStepId,
  type EdenBoundedTurnRequest,
  type EdenBoundedTurnResult,
  type EdenTurnFailure,
  type StoredFailure,
  type TurnIdentity,
} from "./turn-runner-types.js";
import {
  beginTurn,
  commitFinalResponse,
  commitModelProjection,
  completeModelToolStep,
  deliverNewEvents,
  ensureModelToolStep,
  persistToolMessage,
  prepareFinalStep,
  prepareModelAttempt,
  readProjection,
  recordStepFailure,
  recordTurnFailure,
} from "./turn-runner-storage.js";
export type {
  EdenBoundedTurnRequest,
  EdenBoundedTurnResult,
  EdenTurnFailure,
  EdenTurnFailureCode,
} from "./turn-runner-types.js";

function failure(
  request: TurnIdentity,
  input: StoredFailure,
): EdenTurnFailure {
  return {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    sessionId: request.sessionId,
    turnId: request.turnId,
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
  };
}

function invalidRequest(
): StoredFailure {
  return {
    code: "turn_runner_invalid",
    message: "Turn request is invalid.",
    retryable: false,
  };
}

function modelFailure(
  modelError: EdenModelFailure,
  stepId: string,
): StoredFailure {
  return {
    code: modelError.code,
    message: modelError.message,
    retryable: modelError.retryable,
    stepId,
  };
}

function invalidModelResult(
  stepId: string,
  message = "Model result did not contain one valid tool call.",
): StoredFailure {
  return {
    code: "model_result_invalid",
    message,
    retryable: false,
    stepId,
  };
}

function finalFailure(
  modelError: EdenModelFailure,
  stepId: string,
): StoredFailure {
  const invalid = modelError.code === "model_result_invalid";
  return {
    code: invalid ? "final_response_invalid" : "final_response_failed",
    message: invalid
      ? "Final response was invalid."
      : "Final response generation failed.",
    retryable: invalid ? false : modelError.retryable,
    stepId,
  };
}

function finalInvalidResult(stepId: string): StoredFailure {
  return {
    code: "final_response_invalid",
    message: "Final response was invalid.",
    retryable: false,
    stepId,
  };
}

function failureResult(
  request: TurnIdentity,
  input: StoredFailure,
): EdenBoundedTurnResult {
  return {
    status: "failed",
    sessionId: request.sessionId,
    turnId: request.turnId,
    error: failure(request, input),
  };
}

function modelDefinition<TInput, TOutput extends EdenJsonValue>(
  request: EdenBoundedTurnRequest<TInput, TOutput>,
): {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: EdenJsonValue;
} {
  return {
    name: request.toolName,
    description: request.tool.description,
    inputSchema: request.toolInputSchema,
  };
}

function firstToolCall(
  result: EdenModelResult,
  toolName: string,
  stepId: string,
): { readonly callId: string; readonly input: EdenJsonValue } | StoredFailure {
  if (
    result.calls.length !== 1 ||
    result.calls[0] === undefined ||
    result.calls[0].toolName !== toolName
  ) {
    return invalidModelResult(stepId);
  }
  return {
    callId: result.calls[0].callId,
    input: result.calls[0].input,
  };
}

function toolFailure(
  result: EdenToolHarnessResult,
  stepId: string,
): StoredFailure | undefined {
  if (result.status === "failed") {
    return {
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.retryable,
      stepId,
    };
  }
  return undefined;
}

function finalContent(result: EdenModelResult): string | undefined {
  if (result.calls.length > 0 || result.results.length > 0) return undefined;
  const normalized = normalizeEdenJsonValue(result.text);
  return typeof normalized === "string" ? normalized : undefined;
}

function buildFinalMessages(
  request: {
    readonly message: string;
    readonly toolName: string;
    readonly systemPrompt?: string;
  },
  call: { readonly callId: string; readonly input: EdenJsonValue },
  output: EdenJsonValue,
): readonly EdenModelMessage[] {
  return [
    ...(request.systemPrompt === undefined
      ? []
      : [{ role: "system" as const, content: request.systemPrompt }]),
    { role: "user", content: request.message },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          callId: call.callId,
          toolName: request.toolName,
          input: call.input,
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          callId: call.callId,
          toolName: request.toolName,
          output,
        },
      ],
    },
  ];
}

function asFailure(
  request: TurnIdentity,
  stored: StoredFailure,
): EdenBoundedTurnResult {
  return failureResult(request, stored);
}

export async function runBoundedTurn<
  TInput,
  TOutput extends EdenJsonValue = EdenJsonValue,
>(
  storage: EdenSessionStorage,
  request: EdenBoundedTurnRequest<TInput, TOutput>,
): Promise<EdenBoundedTurnResult> {
  if (
    request.message.trim().length === 0 ||
    bytes(request.message) > 16_384 ||
    request.toolName.trim().length === 0 ||
    request.bundleIdentity.trim().length === 0
  ) {
    return asFailure(request, invalidRequest());
  }

  const modelStepId = modelToolStepId(request.turnId);
  const finalStepId = finalResponseStepId(request.turnId);
  let cursor = readLatestJournalCursor(storage.sql, request.sessionId);
  const deliver = async (): Promise<void> => {
    cursor = await deliverNewEvents(
      storage,
      request.sessionId,
      cursor,
      request.onEvent,
    );
  };

  const begun = beginTurn(storage, request);
  await deliver();
  if (begun.status === "completed") {
    return {
      status: "completed",
      sessionId: request.sessionId,
      turnId: request.turnId,
      messageId: begun.messageId,
      content: begun.content,
    };
  }
  if (begun.status === "failed") {
    return asFailure(request, begun.failure);
  }

  ensureModelToolStep(storage, request);
  await deliver();

  let modelResult: EdenModelResult;
  const modelPreparation = prepareModelAttempt(storage, request);
  if (modelPreparation.status === "failed") {
    recordTurnFailure(storage, request, modelPreparation.failure);
    await deliver();
    return asFailure(request, modelPreparation.failure);
  }
  if (modelPreparation.status === "replayed") {
    modelResult = modelPreparation.result;
  } else {
    const modelOutcome = await request.model.call({
      ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
      messages: [
        ...(request.systemPrompt === undefined
          ? []
          : [{ role: "system" as const, content: request.systemPrompt }]),
        { role: "user", content: request.message },
      ],
      tools: [modelDefinition(request)],
      toolChoice: "required",
      ...(request.modelOptions === undefined
        ? {}
        : { options: request.modelOptions }),
      correlation: {
        requestId: `req_${request.turnId}_model_tool_${modelPreparation.attemptCount}`,
        sessionId: request.sessionId,
        turnId: request.turnId,
        stepId: modelStepId,
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (modelOutcome.status === "error") {
      const modelError = modelFailure(modelOutcome.error, modelStepId);
      const failed = recordStepFailure(
        storage,
        request,
        modelStepId,
        modelError,
      );
      if (!failed.stepWasAlreadyFailed) await deliver();
      recordTurnFailure(storage, request, failed.failure);
      await deliver();
      return asFailure(request, failed.failure);
    }
    modelResult = modelOutcome.result;
    const call = firstToolCall(modelResult, request.toolName, modelStepId);
    if ("code" in call) {
      const failed = recordStepFailure(
        storage,
        request,
        modelStepId,
        call,
      );
      if (!failed.stepWasAlreadyFailed) await deliver();
      recordTurnFailure(storage, request, failed.failure);
      await deliver();
      return asFailure(request, failed.failure);
    }
    if (!commitModelProjection(storage, request, modelPreparation.attemptCount, modelResult)) {
      const replayed = readProjection(
        storage.sql,
        request.sessionId,
        modelProjectionKey(request.turnId),
      );
      if (replayed === undefined) {
        const stale: StoredFailure = {
          code: "model_call_failed",
          message: "Model checkpoint became stale.",
          retryable: true,
          stepId: modelStepId,
        };
        recordTurnFailure(storage, request, stale);
        await deliver();
        return asFailure(request, stale);
      }
      modelResult = replayed;
    }
  }

  const call = firstToolCall(modelResult, request.toolName, modelStepId);
  if ("code" in call) {
    const failed = recordStepFailure(
      storage,
      request,
      modelStepId,
      call,
    );
    if (!failed.stepWasAlreadyFailed) await deliver();
    recordTurnFailure(storage, request, failed.failure);
    await deliver();
    return asFailure(request, failed.failure);
  }

  let toolResult: EdenToolHarnessResult<TOutput>;
  try {
    toolResult = await executeTypedTool(storage, {
      sessionId: request.sessionId,
      turnId: request.turnId,
      stepId: modelStepId,
      logicalStep: "tool:bounded-turn",
      phase: "model-tool",
      effectId: `effect_${request.turnId}_tool`,
      callId: call.callId,
      toolName: request.toolName,
      bundleIdentity: request.bundleIdentity,
      input: call.input,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      tool: request.tool,
    });
  } catch {
    const toolError: StoredFailure = {
      code: "tool_execution_failed",
      message: "Tool execution failed.",
      retryable: true,
      stepId: modelStepId,
    };
    const failed = recordStepFailure(
      storage,
      request,
      modelStepId,
      toolError,
    );
    if (!failed.stepWasAlreadyFailed) await deliver();
    recordTurnFailure(storage, request, failed.failure);
    await deliver();
    return asFailure(request, failed.failure);
  }
  await deliver();

  const toolError = toolFailure(toolResult, modelStepId);
  if (toolError !== undefined) {
    recordTurnFailure(storage, request, toolError);
    await deliver();
    return asFailure(request, toolError);
  }
  if (toolResult.status === "stale" || toolResult.status === "exhausted") {
    const bounded: StoredFailure = {
      code: "tool_execution_failed",
      message:
        toolResult.status === "exhausted"
          ? "Tool execution retry limit reached."
          : "Tool checkpoint became stale.",
      retryable: toolResult.status === "stale",
      stepId: modelStepId,
    };
    recordTurnFailure(storage, request, bounded);
    await deliver();
    return asFailure(request, bounded);
  }
  if (toolResult.status !== "committed" && toolResult.status !== "replayed") {
    const invalid: StoredFailure = {
      code: "tool_output_invalid",
      message: "Tool output was not JSON-compatible.",
      retryable: false,
      stepId: modelStepId,
    };
    recordTurnFailure(storage, request, invalid);
    await deliver();
    return asFailure(request, invalid);
  }

  persistToolMessage(storage, request, call, toolResult.output);
  completeModelToolStep(storage, request);
  await deliver();

  const finalStep = prepareFinalStep(storage, request);
  await deliver();
  if (finalStep.status === "failed") {
    recordTurnFailure(storage, request, finalStep.failure);
    await deliver();
    return asFailure(request, finalStep.failure);
  }

  const finalOutcome = await request.model.call({
    ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
    messages: buildFinalMessages(request, call, toolResult.output),
    ...(request.modelOptions === undefined
      ? {}
      : { options: request.modelOptions }),
    correlation: {
      requestId: `req_${request.turnId}_final_${finalStep.attemptCount}`,
      sessionId: request.sessionId,
      turnId: request.turnId,
      stepId: finalStepId,
    },
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (finalOutcome.status === "error") {
    const finalError = finalFailure(finalOutcome.error, finalStepId);
    const failed = recordStepFailure(
      storage,
      request,
      finalStepId,
      finalError,
    );
    if (!failed.stepWasAlreadyFailed) await deliver();
    recordTurnFailure(storage, request, failed.failure);
    await deliver();
    return asFailure(request, failed.failure);
  }

  const content = finalContent(finalOutcome.result);
  if (content === undefined) {
    const failed = recordStepFailure(
      storage,
      request,
      finalStepId,
      finalInvalidResult(finalStepId),
    );
    if (!failed.stepWasAlreadyFailed) await deliver();
    recordTurnFailure(storage, request, failed.failure);
    await deliver();
    return asFailure(request, failed.failure);
  }

  try {
    commitFinalResponse(
      storage,
      {
        sessionId: request.sessionId,
        turnId: request.turnId,
        messageId: assistantMessageId(request.turnId),
      },
      content,
      finalStep.attemptCount,
    );
  } catch {
    const stale: StoredFailure = {
      code: "final_response_failed",
      message: "Final response checkpoint became stale.",
      retryable: true,
      stepId: finalStepId,
    };
    recordTurnFailure(storage, request, stale);
    await deliver();
    return asFailure(request, stale);
  }
  await deliver();

  return {
    status: "completed",
    sessionId: request.sessionId,
    turnId: request.turnId,
    messageId: assistantMessageId(request.turnId),
    content,
  };
}

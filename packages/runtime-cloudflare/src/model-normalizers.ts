/*
 * Modified derivative of portable Eve concepts. Eve 0.31.3 reference commit:
 * 0b102bc90e7cf2c3e294f6ca3af86c307d449b1a. See repository NOTICE and LICENSE.
 */

import type { EdenJsonValue } from "@eden/definitions";
import type {
  EdenModelCorrelation,
  EdenModelFailure,
  EdenModelFailureCode,
  EdenModelFinishReason,
  EdenModelMessage,
  EdenModelMessagePart,
  EdenModelResult,
  EdenModelToolCall,
  EdenModelToolResult,
  EdenModelUsage,
} from "./model-contracts.js";

const MAX_MODEL_STRING_BYTES = 65_536;
const MAX_MODEL_JSON_DEPTH = 32;
const MAX_MODEL_CALLS = 32;
const MAX_NORMALIZED_JSON_BYTES = 65_536;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (new TextEncoder().encode(value).byteLength > MAX_MODEL_STRING_BYTES) {
    return undefined;
  }
  return value;
}

function safeIdentifier(value: unknown): string | undefined {
  const identifier = boundedString(value);
  if (identifier === undefined || identifier.trim().length === 0) {
    return undefined;
  }
  return identifier;
}

function normalizeCorrelation(
  correlation: EdenModelCorrelation,
): EdenModelCorrelation {
  const requestId = safeIdentifier(correlation.requestId) ?? "unknown";
  const sessionId = safeIdentifier(correlation.sessionId);
  const turnId = safeIdentifier(correlation.turnId);
  const stepId = safeIdentifier(correlation.stepId);
  return {
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(stepId === undefined ? {} : { stepId }),
  };
}

function normalizeJsonValue(
  value: unknown,
  depth = 0,
  active = new WeakSet<object>(),
): EdenJsonValue | undefined {
  if (depth > MAX_MODEL_JSON_DEPTH) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") {
    return boundedString(value) === undefined && typeof value === "string"
      ? undefined
      : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) return undefined;
    active.add(value);
    try {
      const output: EdenJsonValue[] = [];
      for (const item of value) {
        const normalized = normalizeJsonValue(item, depth + 1, active);
        if (normalized === undefined) return undefined;
        output.push(normalized);
      }
      return output;
    } finally {
      active.delete(value);
    }
  }
  if (!isRecord(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (active.has(value)) return undefined;
  active.add(value);
  try {
    const output: Record<string, EdenJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeJsonValue(item, depth + 1, active);
      if (normalized === undefined) return undefined;
      output[key] = normalized;
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function parseJsonValue(value: unknown): EdenJsonValue | undefined {
  if (typeof value !== "string") return normalizeJsonValue(value);
  try {
    return normalizeJsonValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function normalizeEdenJsonValue(
  value: unknown,
): EdenJsonValue | undefined {
  const normalized = normalizeJsonValue(value);
  if (normalized === undefined) return undefined;
  const serialized = JSON.stringify(normalized);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_NORMALIZED_JSON_BYTES
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeToolCall(value: unknown): EdenModelToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const callId = safeIdentifier(value.callId ?? value.toolCallId ?? value.id);
  const toolName = safeIdentifier(value.toolName ?? value.name);
  const rawInput =
    "input" in value
      ? value.input
      : "args" in value
        ? value.args
        : value.arguments;
  const input = parseJsonValue(rawInput);
  if (callId === undefined || toolName === undefined || input === undefined) {
    return undefined;
  }
  return { callId, toolName, input };
}

function normalizeToolOutput(value: unknown): EdenJsonValue | undefined {
  if (isRecord(value) && typeof value.type === "string") {
    if (value.type === "execution-denied") {
      return {
        error: {
          code: "tool_execution_denied",
          message: "Tool execution was denied.",
        },
      };
    }
    if (value.type === "text") {
      const text = boundedString(value.value);
      if (text === undefined) return undefined;
      return text;
    }
    if (value.type === "error-text") {
      return {
        error: {
          code: "tool_result_error",
          message: "Tool result was not available.",
        },
      };
    }
    if (value.type === "json") return parseJsonValue(value.value);
    if (value.type === "error-json") {
      return {
        error: {
          code: "tool_result_error",
          message: "Tool result was not available.",
        },
      };
    }
    if (value.type === "content") return parseJsonValue(value.value);
    return undefined;
  }
  return parseJsonValue(value);
}

function normalizeToolResult(value: unknown): EdenModelToolResult | undefined {
  if (!isRecord(value)) return undefined;
  const callId = safeIdentifier(value.callId ?? value.toolCallId ?? value.id);
  const toolName = safeIdentifier(value.toolName ?? value.name);
  const rawOutput = "output" in value ? value.output : value.result;
  const output = normalizeToolOutput(rawOutput);
  if (callId === undefined || toolName === undefined || output === undefined) {
    return undefined;
  }
  return { callId, toolName, output };
}

function contentParts(value: unknown): readonly UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function normalizeMessagePart(
  value: UnknownRecord,
): EdenModelMessagePart | undefined {
  if (value.type === "text") {
    const text = boundedString(value.text);
    return text === undefined ? undefined : { type: "text", text };
  }
  if (value.type === "tool-call") {
    const call = normalizeToolCall(value);
    return call === undefined ? undefined : { type: "tool-call", ...call };
  }
  if (value.type === "tool-result") {
    const result = normalizeToolResult(value);
    return result === undefined ? undefined : { type: "tool-result", ...result };
  }
  return undefined;
}

function normalizeMessage(value: unknown): EdenModelMessage | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role;
  if (
    role !== "system" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool"
  ) {
    return undefined;
  }

  if (typeof value.content === "string") {
    const content = boundedString(value.content);
    return content === undefined ? undefined : { role, content };
  }

  const parts = contentParts(value.content)
    .map(normalizeMessagePart)
    .filter((part): part is EdenModelMessagePart => part !== undefined)
    .slice(0, MAX_MODEL_CALLS);
  if (role === "tool") {
    return { role, content: parts.filter((part) => part.type === "tool-result") };
  }
  if (role === "system" || role === "user") {
    const text = parts
      .filter((part): part is Extract<EdenModelMessagePart, { type: "text" }> =>
        part.type === "text",
      )
      .map((part) => part.text)
      .join("");
    return { role, content: text };
  }
  return { role, content: parts };
}

export function normalizeModelMessages(
  messages: readonly unknown[],
): readonly EdenModelMessage[] {
  return messages
    .map(normalizeMessage)
    .filter((message): message is EdenModelMessage => message !== undefined);
}

function normalizeUsage(value: unknown): EdenModelUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens =
    safeTokenCount(value.inputTokens) ??
    safeTokenCount(value.promptTokens) ??
    safeTokenCount(value.inputTokenCount);
  const outputTokens =
    safeTokenCount(value.outputTokens) ??
    safeTokenCount(value.completionTokens) ??
    safeTokenCount(value.outputTokenCount);
  const totalTokens =
    safeTokenCount(value.totalTokens) ??
    safeTokenCount(value.totalTokenCount) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function normalizeFinishReason(
  value: unknown,
  hasCalls: boolean,
  hasText: boolean,
): EdenModelFinishReason {
  const rawValue =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.unified === "string"
        ? value.unified
        : undefined;
  const raw =
    rawValue === "tool_calls"
      ? "tool-calls"
      : rawValue === "content_filter"
        ? "content-filter"
        : rawValue === "max_tokens"
          ? "length"
          : rawValue;
  switch (raw) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "other":
      return raw;
    default:
      return hasCalls ? "tool-calls" : hasText ? "stop" : "other";
  }
}

function resultContentParts(value: UnknownRecord): readonly UnknownRecord[] {
  return contentParts(value.content);
}

function uniqueCalls(
  values: readonly EdenModelToolCall[],
): readonly EdenModelToolCall[] {
  const seen = new Set<string>();
  const unique: EdenModelToolCall[] = [];
  for (const value of values) {
    if (seen.has(value.callId)) continue;
    seen.add(value.callId);
    unique.push(value);
    if (unique.length >= MAX_MODEL_CALLS) break;
  }
  return unique;
}

function uniqueResults(
  values: readonly EdenModelToolResult[],
): readonly EdenModelToolResult[] {
  const seen = new Set<string>();
  const unique: EdenModelToolResult[] = [];
  for (const value of values) {
    if (seen.has(value.callId)) continue;
    seen.add(value.callId);
    unique.push(value);
    if (unique.length >= MAX_MODEL_CALLS) break;
  }
  return unique;
}

function normalizedToolCalls(
  value: unknown,
  field: string,
): readonly EdenModelToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Model ${field} is invalid`);
  }
  return value.map((item) => {
    const call = normalizeToolCall(item);
    if (call === undefined) {
      throw new Error(`Model ${field} contains an invalid tool call`);
    }
    return call;
  });
}

function normalizedToolResults(
  value: unknown,
  field: string,
): readonly EdenModelToolResult[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Model ${field} is invalid`);
  }
  return value.map((item) => {
    const result = normalizeToolResult(item);
    if (result === undefined) {
      throw new Error(`Model ${field} contains an invalid tool result`);
    }
    return result;
  });
}

export function normalizeModelResult(
  providerResult: unknown,
  correlation: EdenModelCorrelation,
): EdenModelResult {
  if (!isRecord(providerResult)) {
    throw new Error("Model result is not an object");
  }

  const parts = resultContentParts(providerResult);
  let text: string;
  if (providerResult.text !== undefined) {
    if (typeof providerResult.text !== "string") {
      throw new Error("Model text is invalid");
    }
    const normalizedText = boundedString(providerResult.text);
    if (normalizedText === undefined) {
      throw new Error("Model text exceeds the bounded output limit");
    }
    text = normalizedText;
  } else {
    const textParts = parts.filter((part) => part.type === "text");
    const normalizedTextParts = textParts.map((part) => {
      if (typeof part.text !== "string") {
        throw new Error("Model text part is invalid");
      }
      const normalizedText = boundedString(part.text);
      if (normalizedText === undefined) {
        throw new Error("Model text exceeds the bounded output limit");
      }
      return normalizedText;
    });
    const joinedText = normalizedTextParts.join("");
    if (boundedString(joinedText) === undefined) {
      throw new Error("Model text exceeds the bounded output limit");
    }
    text = joinedText;
  }

  const calls = uniqueCalls([
    ...normalizedToolCalls(providerResult.toolCalls, "tool calls"),
    ...normalizedToolCalls(providerResult.calls, "calls"),
    ...parts
      .filter((part) => part.type === "tool-call")
      .map((part) => {
        const call = normalizeToolCall(part);
        if (call === undefined) {
          throw new Error("Model content contains an invalid tool call");
        }
        return call;
      }),
  ]);

  const results = uniqueResults([
    ...normalizedToolResults(providerResult.toolResults, "tool results"),
    ...normalizedToolResults(providerResult.results, "results"),
    ...parts
      .filter((part) => part.type === "tool-result")
      .map((part) => {
        const result = normalizeToolResult(part);
        if (result === undefined) {
          throw new Error("Model content contains an invalid tool result");
        }
        return result;
      }),
  ]);
  const usage = normalizeUsage(providerResult.usage);

  return {
    text,
    calls,
    results,
    finishReason: normalizeFinishReason(
      providerResult.finishReason ?? providerResult.rawFinishReason,
      calls.length > 0,
      text.length > 0,
    ),
    ...(usage === undefined ? {} : { usage }),
    correlation: normalizeCorrelation(correlation),
  };
}

function statusCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.statusCode ?? value.status;
  return typeof candidate === "number" && Number.isSafeInteger(candidate)
    ? candidate
    : undefined;
}

function isRetryableStatus(value: number | undefined): boolean {
  return (
    value === 408 ||
    value === 425 ||
    value === 429 ||
    (value !== undefined && value >= 500 && value <= 599)
  );
}

function isRetryableError(error: unknown, status: number | undefined): boolean {
  if (isRecord(error) && typeof error.isRetryable === "boolean") {
    return error.isRetryable;
  }
  return isRetryableStatus(status);
}

export function normalizeModelFailure(
  error: unknown,
  correlation: EdenModelCorrelation,
  code: EdenModelFailureCode = "model_call_failed",
): EdenModelFailure {
  const status = statusCode(error);
  return {
    code,
    message:
      code === "model_call_aborted"
        ? "Model call was aborted."
        : code === "model_result_invalid"
          ? "Model result was invalid."
          : "Model call failed.",
    retryable:
      code === "model_result_invalid" ? false : isRetryableError(error, status),
    correlation: normalizeCorrelation(correlation),
  };
}

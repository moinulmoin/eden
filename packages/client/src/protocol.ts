/*
 * Modified derivative of portable Eve concepts. Eve 0.31.3 reference commit:
 * 0b102bc90e7cf2c3e294f6ca3af86c307d449b1a. See repository NOTICE and LICENSE.
 */

import type {
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenJsonValue,
  EdenSessionStatus,
  EdenStepPhase,
} from "@eden/definitions";

const MAX_EVENT_LINE_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 32;
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_-]+$/u;
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]+$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

const EVENT_TYPES: ReadonlySet<string> = new Set([
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

export type EdenProtocolErrorCode =
  | "invalid_content_type"
  | "malformed_json"
  | "invalid_event"
  | "invalid_event_id"
  | "invalid_cursor"
  | "cursor_gap"
  | "cursor_regression"
  | "cursor_conflict"
  | "event_id_conflict"
  | "invalid_state"
  | "truncated_ndjson";

export class EdenClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EdenClientError";
    this.code = code;
  }
}

export class EdenProtocolError extends EdenClientError {
  override readonly code: EdenProtocolErrorCode;

  constructor(code: EdenProtocolErrorCode, message: string) {
    super(code, message);
    this.name = "EdenProtocolError";
    this.code = code;
  }
}

export type EdenHttpErrorCode =
  | "http_error"
  | "invalid_response"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "internal_error";

export class EdenHttpError extends EdenClientError {
  override readonly code: EdenHttpErrorCode | string;
  readonly status: number;

  constructor(
    status: number,
    code: EdenHttpErrorCode | string = "http_error",
  ) {
    super(code, `Eden request failed with HTTP status ${status}.`);
    this.name = "EdenHttpError";
    this.status = status;
    this.code = code;
  }
}

export class EdenTransportError extends EdenClientError {
  constructor(message = "The Eden transport could not deliver the request.") {
    super("transport_error", message);
    this.name = "EdenTransportError";
  }
}

export class EdenClientConfigurationError extends EdenClientError {
  constructor(message: string) {
    super("invalid_configuration", message);
    this.name = "EdenClientConfigurationError";
  }
}

export function isOpaqueSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isOpaqueEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasString(
  value: Record<string, unknown>,
  key: string,
): value is Record<string, unknown> & Record<typeof key, string> {
  return typeof value[key] === "string" && value[key].length > 0;
}

function isJsonValue(value: unknown, depth = 0): value is EdenJsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null) return true;
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isVersionSet(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasString(value, "runtime") &&
    hasString(value, "agentBundle") &&
    hasString(value, "manifest") &&
    hasString(value, "protocol") &&
    typeof value.schema === "number" &&
    Number.isSafeInteger(value.schema) &&
    value.schema >= 0
  );
}

function isSessionStatus(value: unknown): value is EdenSessionStatus {
  return (
    value === "new" ||
    value === "running" ||
    value === "waiting" ||
    value === "failed" ||
    value === "completed"
  );
}

function isStepPhase(value: unknown): value is EdenStepPhase {
  return value === "model-tool" || value === "final-response";
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isFailureData(value: unknown, idKey: string): boolean {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [idKey, "code", "message", "retryable"]) &&
    isOpaqueId(value[idKey]) &&
    hasString(value, "code") &&
    hasString(value, "message") &&
    typeof value.retryable === "boolean"
  );
}

function isEventData(type: EdenEventType, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (type) {
    case "session.started":
      return (
        hasOnlyKeys(value, ["sessionId", "status", "versions"]) &&
        isOpaqueSessionId(value.sessionId) &&
        isSessionStatus(value.status) &&
        isVersionSet(value.versions)
      );
    case "turn.started":
      return (
        hasOnlyKeys(value, ["turnId"]) &&
        isOpaqueId(value.turnId)
      );
    case "message.received":
      return (
        hasOnlyKeys(value, ["messageId", "role"]) &&
        isOpaqueId(value.messageId) &&
        value.role === "user"
      );
    case "step.started":
    case "step.completed":
      return (
        hasOnlyKeys(value, ["stepId", "phase"]) &&
        isOpaqueId(value.stepId) &&
        isStepPhase(value.phase)
      );
    case "actions.requested":
      return (
        hasOnlyKeys(value, ["stepId", "actions"]) &&
        isOpaqueId(value.stepId) &&
        Array.isArray(value.actions) &&
        value.actions.every((action) => {
          if (!isRecord(action)) return false;
          return (
            hasOnlyKeys(action, ["callId", "toolName", "input"]) &&
            isOpaqueId(action.callId) &&
            hasString(action, "toolName") &&
            isJsonValue(action.input)
          );
        })
      );
    case "action.result":
      return (
        hasOnlyKeys(value, ["stepId", "callId", "toolName", "output"]) &&
        isOpaqueId(value.stepId) &&
        isOpaqueId(value.callId) &&
        hasString(value, "toolName") &&
        isJsonValue(value.output)
      );
    case "message.completed":
      return (
        hasOnlyKeys(value, ["messageId", "role", "content"]) &&
        isOpaqueId(value.messageId) &&
        value.role === "assistant" &&
        typeof value.content === "string"
      );
    case "turn.completed":
      return (
        hasOnlyKeys(value, ["turnId"]) &&
        isOpaqueId(value.turnId)
      );
    case "session.waiting":
      return hasOnlyKeys(value, ["status"]) && value.status === "waiting";
    case "step.failed":
      return isFailureData(value, "stepId");
    case "turn.failed":
      return isFailureData(value, "turnId");
    case "session.failed":
      return (
        hasOnlyKeys(value, ["code", "message", "retryable"]) &&
        hasString(value, "code") &&
        hasString(value, "message") &&
        typeof value.retryable === "boolean"
      );
  }
}

function protocolFailure(
  code: EdenProtocolErrorCode,
  message: string,
): EdenProtocolError {
  return new EdenProtocolError(code, message);
}

export function parseEdenEvent(value: unknown): EdenEvent<EdenEventType> {
  if (!isRecord(value)) {
    throw protocolFailure("invalid_event", "An Eden event must be a JSON object.");
  }
  if (
    typeof value.streamIndex !== "number" ||
    !Number.isSafeInteger(value.streamIndex) ||
    value.streamIndex < 1
  ) {
    throw protocolFailure(
      "invalid_cursor",
      "An Eden event must have a positive absolute cursor.",
    );
  }
  if (!isOpaqueEventId(value.eventId)) {
    throw protocolFailure(
      "invalid_event_id",
      "An Eden event must have a stable opaque event identifier.",
    );
  }
  if (
    typeof value.type !== "string" ||
    !EVENT_TYPES.has(value.type) ||
    typeof value.committedAt !== "string" ||
    value.committedAt.length === 0 ||
    !isJsonValue(value.data)
  ) {
    throw protocolFailure(
      "invalid_event",
      "An Eden event has an unregistered type or invalid envelope fields.",
    );
  }

  const type = value.type as EdenEventType;
  if (!isEventData(type, value.data)) {
    throw protocolFailure(
      "invalid_event",
      "An Eden event has data that does not match its registered type.",
    );
  }

  return {
    streamIndex: value.streamIndex,
    eventId: value.eventId,
    type,
    data: value.data as EdenEventDataByType[EdenEventType],
    committedAt: value.committedAt,
  };
}

export function parseEdenNdjson(
  text: string,
): readonly EdenEvent<EdenEventType>[] {
  const records: EdenEvent<EdenEventType>[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.length === 0) {
      throw protocolFailure("malformed_json", "NDJSON contains an empty record.");
    }
    if (new TextEncoder().encode(normalized).byteLength > MAX_EVENT_LINE_BYTES) {
      throw protocolFailure("invalid_event", "An Eden event exceeds the size limit.");
    }
    let value: unknown;
    try {
      value = JSON.parse(normalized) as unknown;
    } catch {
      throw protocolFailure("malformed_json", "NDJSON contains malformed JSON.");
    }
    records.push(parseEdenEvent(value));
  }
  return records;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function eventFingerprint(
  event: EdenEvent<EdenEventType>,
): string {
  return canonicalJson({
    streamIndex: event.streamIndex,
    eventId: event.eventId,
    type: event.type,
    data: event.data,
    committedAt: event.committedAt,
  });
}

export function assertValidState(
  value: unknown,
): { readonly sessionId: string; readonly streamIndex: number } | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, ["sessionId", "streamIndex"]) ||
    !isOpaqueSessionId(value.sessionId) ||
    typeof value.streamIndex !== "number" ||
    !Number.isSafeInteger(value.streamIndex) ||
    value.streamIndex < 0
  ) {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    streamIndex: value.streamIndex,
  };
}

export const EDEN_EVENT_LINE_LIMIT = MAX_EVENT_LINE_BYTES;

const SESSION_ID_PATTERN = /^sess_[a-f0-9]{32}$/u;
const TURN_ID_PATTERN = /^turn_[a-f0-9]{32}$/u;
const MESSAGE_ID_PATTERN = /^msg_[a-f0-9]{32}$/u;
const SESSION_OBJECT_PREFIX = "eden-session:";

function randomOpaqueId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return `${prefix}${hex}`;
}

export function createOpaqueSessionId(): string {
  return randomOpaqueId("sess_");
}

export function createOpaqueTurnId(): string {
  return randomOpaqueId("turn_");
}

export function createOpaqueMessageId(): string {
  return randomOpaqueId("msg_");
}

export function isOpaqueSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function isOpaqueTurnId(value: string): boolean {
  return TURN_ID_PATTERN.test(value);
}

export function isOpaqueMessageId(value: string): boolean {
  return MESSAGE_ID_PATTERN.test(value);
}

export function createSessionObjectName(sessionId: string): string {
  if (!isOpaqueSessionId(sessionId)) {
    throw new Error("Invalid opaque session identifier");
  }
  return `${SESSION_OBJECT_PREFIX}${sessionId}`;
}

export function sessionIdFromObjectName(objectName: string): string | null {
  if (!objectName.startsWith(SESSION_OBJECT_PREFIX)) {
    return null;
  }

  const sessionId = objectName.slice(SESSION_OBJECT_PREFIX.length);
  return isOpaqueSessionId(sessionId) ? sessionId : null;
}

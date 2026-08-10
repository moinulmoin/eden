const SESSION_ID_PATTERN = /^sess_[a-f0-9]{32}$/u;
const SESSION_OBJECT_PREFIX = "eden-session:";

export function createOpaqueSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return `sess_${hex}`;
}

export function isOpaqueSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
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

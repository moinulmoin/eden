import {
  EDEN_VERSIONS,
  type EdenCommandRequest,
} from "@eden/definitions";

import {
  createOpaqueMessageId,
  createOpaqueSessionId,
  createOpaqueTurnId,
  createSessionObjectName,
  isOpaqueSessionId,
} from "./session-identity.js";
import { readConfiguredEdenArtifact } from "./artifact-runtime.js";
import { SESSION_SCHEMA_VERSION } from "./session-schema.js";

const HEALTH_PATH = "/eden/v1/health";
const INFO_PATH = "/eden/v1/info";
const SESSION_PATH = "/eden/v1/session";
const STREAM_SUFFIX = "/stream";
const MAX_CREATE_BODY_BYTES = 1_024;
const MAX_COMMAND_BODY_BYTES = 32 * 1_024;
const MAX_MESSAGE_BYTES = 16 * 1_024;
const MAX_JSON_DEPTH = 32;
const FIXED_PRINCIPAL = "principal:test";
const UNSUPPORTED_IDENTITY_HEADERS = new Set([
  "x-eden-principal",
  "x-eden-tenant",
  "x-eden-identity",
  "x-eden-session-id",
  "x-eden-object-name",
  "x-durable-object-id",
]);

export interface EdenWorkerEnvironment {
  readonly EDEN_BEARER_SECRET?: string;
  readonly EDEN_SESSIONS?: DurableObjectNamespace;
}

interface RequestBodyResult {
  readonly status: "ok" | "invalid" | "too_large";
  readonly value?: unknown;
}

interface StreamQuery {
  readonly startIndex: number;
  readonly follow: boolean;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function errorResponse(
  code: string,
  status: number,
): Response {
  return jsonResponse(
    {
      code,
      message:
        code === "unauthorized"
          ? "Authorization is required."
          : code === "not_found"
            ? "Resource was not found."
            : code === "conflict"
              ? "The session cannot accept this operation."
              : code === "internal_error"
                ? "The request could not be completed."
                : "The request is invalid.",
    },
    status,
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function isAuthorized(
  request: Request,
  configuredBearer: string | undefined,
): boolean {
  if (configuredBearer === undefined || configuredBearer.length === 0) {
    return false;
  }
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return false;
  const bearer = header.slice("Bearer ".length);
  if (bearer.length === 0 || bearer.includes(" ")) return false;
  return constantTimeEqual(bearer, configuredBearer);
}

function hasUnsupportedIdentityHeader(request: Request): boolean {
  let unsupported = false;
  request.headers.forEach((_value, key) => {
    if (UNSUPPORTED_IDENTITY_HEADERS.has(key.toLowerCase())) {
      unsupported = true;
    }
  });
  return unsupported;
}

function contentTypeIsJson(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<RequestBodyResult> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
    ) {
      return { status: "too_large" };
    }
  }

  const reader = request.body?.getReader();
  if (reader === undefined) {
    return { status: "invalid" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return { status: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { status: "invalid" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      status: "ok",
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { status: "invalid" };
  }
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function exceedsJsonDepth(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): boolean {
  if (depth > MAX_JSON_DEPTH) return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some((item) => exceedsJsonDepth(item, depth + 1, seen));
    }
    return Object.values(value).some((item) =>
      exceedsJsonDepth(item, depth + 1, seen),
    );
  } finally {
    // Keep cycle tracking path-local so repeated references in separate
    // branches remain valid JSON while true cycles still fail closed.
    seen.delete(value);
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateCreateBody(value: unknown): boolean {
  const body = parseObject(value);
  return body !== undefined && Object.keys(body).length === 0;
}

function validateCommandBody(
  value: unknown,
): value is EdenCommandRequest {
  const body = parseObject(value);
  if (
    body === undefined ||
    !hasOnlyKeys(body, ["message"]) ||
    typeof body.message !== "string"
  ) {
    return false;
  }
  return (
    body.message.trim().length > 0 &&
    new TextEncoder().encode(body.message).byteLength <= MAX_MESSAGE_BYTES
  );
}

function readStreamQuery(url: URL): StreamQuery | undefined {
  const allowed = new Set(["startIndex", "follow"]);
  const queryKeys: string[] = [];
  url.searchParams.forEach((_value, key) => queryKeys.push(key));
  for (const key of queryKeys) {
    if (!allowed.has(key)) return undefined;
  }

  const startValues = url.searchParams.getAll("startIndex");
  if (startValues.length > 1) return undefined;
  const rawStartIndex = startValues[0] ?? "0";
  const startIndex = Number(rawStartIndex);
  if (
    !Number.isSafeInteger(startIndex) ||
    startIndex < 0 ||
    rawStartIndex !== String(startIndex)
  ) {
    return undefined;
  }

  const followValues = url.searchParams.getAll("follow");
  if (followValues.length > 1) return undefined;
  const rawFollow = followValues[0];
  if (rawFollow !== undefined && rawFollow !== "true" && rawFollow !== "false") {
    return undefined;
  }
  return {
    startIndex,
    follow: rawFollow !== "false",
  };
}

function hasQuery(url: URL): boolean {
  let present = false;
  url.searchParams.forEach(() => {
    present = true;
  });
  return present;
}

function sessionIdFromPath(
  pathname: string,
): string | undefined {
  if (!pathname.startsWith(`${SESSION_PATH}/`)) return undefined;
  const suffix = pathname.slice(`${SESSION_PATH}/`.length);
  if (suffix.length === 0 || suffix.includes("/")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(suffix);
  } catch {
    return undefined;
  }
  return isOpaqueSessionId(decoded) ? decoded : undefined;
}

function sessionStub(
  env: EdenWorkerEnvironment,
  sessionId: string,
): DurableObjectStub | undefined {
  if (env.EDEN_SESSIONS === undefined) return undefined;
  return env.EDEN_SESSIONS.get(
    env.EDEN_SESSIONS.idFromName(createSessionObjectName(sessionId)),
  );
}

async function initializeSession(
  env: EdenWorkerEnvironment,
  sessionId: string,
): Promise<boolean> {
  const stub = sessionStub(env, sessionId);
  if (stub === undefined) return false;
  const response = await stub.fetch("https://eden/_eden/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ownerPrincipal: FIXED_PRINCIPAL,
      versions: EDEN_VERSIONS,
    }),
  });
  await response.arrayBuffer();
  return response.status === 200 || response.status === 201;
}

async function acceptCommand(
  env: EdenWorkerEnvironment,
  sessionId: string,
  request: EdenCommandRequest,
  turnId: string,
  messageId: string,
): Promise<Response> {
  const stub = sessionStub(env, sessionId);
  if (stub === undefined) return errorResponse("internal_error", 500);

  let response: Response;
  try {
    response = await stub.fetch("https://eden/_eden/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        ownerPrincipal: FIXED_PRINCIPAL,
        turnId,
        messageId,
        message: request.message,
      }),
    });
  } catch {
    return errorResponse("internal_error", 500);
  }

  const status = response.status;
  await response.arrayBuffer();
  if (status === 200 || status === 202) {
    return jsonResponse(
      { sessionId, turnId, status: "accepted" },
      202,
    );
  }
  if (status === 404) return errorResponse("not_found", 404);
  if (status === 409) return errorResponse("conflict", 409);
  if (status === 400) return errorResponse("invalid_request", 400);
  return errorResponse("internal_error", 500);
}

async function streamEvents(
  env: EdenWorkerEnvironment,
  sessionId: string,
  query: StreamQuery,
): Promise<Response> {
  const stub = sessionStub(env, sessionId);
  if (stub === undefined) return errorResponse("internal_error", 500);

  let response: Response;
  try {
    response = await stub.fetch("https://eden/_eden/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        ownerPrincipal: FIXED_PRINCIPAL,
        startIndex: query.startIndex,
        follow: query.follow,
      }),
    });
  } catch {
    return errorResponse("internal_error", 500);
  }
  if (response.status === 404) {
    await response.arrayBuffer();
    return errorResponse("not_found", 404);
  }
  if (response.status !== 200) {
    await response.arrayBuffer();
    return errorResponse("internal_error", 500);
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleCreate(
  request: Request,
  env: EdenWorkerEnvironment,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("not_found", 404);
  }
  if (hasQuery(new URL(request.url))) {
    return errorResponse("invalid_request", 400);
  }
  if (!contentTypeIsJson(request)) return errorResponse("invalid_request", 400);
  const body = await readBoundedBody(request, MAX_CREATE_BODY_BYTES);
  if (
    body.status !== "ok" ||
    exceedsJsonDepth(body.value) ||
    !validateCreateBody(body.value)
  ) {
    return errorResponse(
      body.status === "too_large" ? "request_too_large" : "invalid_request",
      400,
    );
  }

  const sessionId = createOpaqueSessionId();
  if (!(await initializeSession(env, sessionId))) {
    return errorResponse("internal_error", 500);
  }
  return jsonResponse(
    {
      sessionId,
      status: "new",
      versions: EDEN_VERSIONS,
      sqliteSchemaVersion: SESSION_SCHEMA_VERSION,
    },
    201,
  );
}

async function handleCommand(
  request: Request,
  env: EdenWorkerEnvironment,
  sessionId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("not_found", 404);
  }
  if (hasQuery(new URL(request.url))) {
    return errorResponse("invalid_request", 400);
  }
  if (!contentTypeIsJson(request)) return errorResponse("invalid_request", 400);
  const body = await readBoundedBody(request, MAX_COMMAND_BODY_BYTES);
  if (
    body.status !== "ok" ||
    exceedsJsonDepth(body.value) ||
    !validateCommandBody(body.value)
  ) {
    return errorResponse(
      body.status === "too_large" ? "request_too_large" : "invalid_request",
      400,
    );
  }

  return acceptCommand(
    env,
    sessionId,
    body.value,
    createOpaqueTurnId(),
    createOpaqueMessageId(),
  );
}

async function handleStream(
  request: Request,
  env: EdenWorkerEnvironment,
  sessionId: string,
): Promise<Response> {
  if (request.method !== "GET") return errorResponse("not_found", 404);
  const query = readStreamQuery(new URL(request.url));
  if (query === undefined) return errorResponse("invalid_request", 400);
  return streamEvents(env, sessionId, query);
}

export async function handleEdenRequest(
  request: Request,
  env: EdenWorkerEnvironment,
): Promise<Response> {
  if (!isAuthorized(request, env.EDEN_BEARER_SECRET)) {
    return errorResponse("unauthorized", 401);
  }
  if (hasUnsupportedIdentityHeader(request)) {
    return errorResponse("invalid_request", 400);
  }

  const url = new URL(request.url);
  if (url.pathname === HEALTH_PATH) {
    return request.method === "GET"
      ? jsonResponse({ status: "ok" })
      : errorResponse("not_found", 404);
  }
  if (url.pathname === INFO_PATH) {
    const generation = readConfiguredEdenArtifact()?.generation;
    return request.method === "GET"
      ? jsonResponse({
          service: "eden",
          protocol: EDEN_VERSIONS.protocol,
          versions: EDEN_VERSIONS,
          sqliteSchemaVersion: SESSION_SCHEMA_VERSION,
          ...(generation === undefined
            ? {}
            : {
                generation: {
                  generationId: generation.generationId,
                  bundleDigest: generation.bundleDigest,
                  manifestVersion: generation.manifestVersion,
                  runtimeVersion: generation.runtimeVersion,
                  agentBundleVersion: generation.agentBundleVersion,
                  protocolVersion: generation.protocolVersion,
                  schemaVersion: generation.schemaVersion,
                  toolNames: generation.toolNames,
                },
              }),
        })
      : errorResponse("not_found", 404);
  }
  if (url.pathname === SESSION_PATH) {
    return handleCreate(request, env);
  }

  if (url.pathname.endsWith(STREAM_SUFFIX)) {
    const basePath = url.pathname.slice(0, -STREAM_SUFFIX.length);
    const streamSessionId = sessionIdFromPath(basePath);
    if (streamSessionId === undefined) {
      return errorResponse("not_found", 404);
    }
    return handleStream(request, env, streamSessionId);
  }
  const sessionId = sessionIdFromPath(url.pathname);
  if (sessionId === undefined) return errorResponse("not_found", 404);
  return handleCommand(request, env, sessionId);
}
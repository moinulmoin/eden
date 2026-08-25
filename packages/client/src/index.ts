import type {
  EdenCommandRequest,
  EdenEvent,
  EdenEventType,
  EdenSessionAcceptance,
  EdenSessionSnapshot,
} from "@moinulmoin/eden-definitions";

export type {
  EdenCommandRequest,
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenSessionAcceptance,
  EdenSessionSnapshot,
} from "@moinulmoin/eden-definitions";

import {
  assertValidState,
  EdenClientConfigurationError,
  EdenClientError,
  EdenHttpError,
  EdenProtocolError,
  EdenTransportError,
  replayEvidenceFingerprint,
  isOpaqueEventId,
  isReplayEvidenceFingerprint,
  isOpaqueSessionId,
  parseEdenEvent,
  type EdenProtocolErrorCode,
} from "./protocol.js";

export {
  EDEN_EVENT_LINE_LIMIT,
  EdenClientConfigurationError,
  EdenClientError,
  EdenHttpError,
  EdenProtocolError,
  EdenTransportError,
  isOpaqueEventId,
  isOpaqueSessionId,
  parseEdenEvent,
  parseEdenNdjson,
} from "./protocol.js";
export type { EdenHttpErrorCode, EdenProtocolErrorCode } from "./protocol.js";

export interface EdenClientOptions {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly getBearerToken?: () => string | Promise<string>;
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface EdenClientSessionState {
  readonly sessionId: string;
  readonly streamIndex: number;
}

export type EdenClientState = EdenClientSessionState;

export interface EdenClientReplayEvidence {
  readonly eventId: string;
  readonly streamIndex: number;
  readonly fingerprint: string;
}

export interface EdenEventStore {
  load(): Promise<EdenClientState | undefined>;
  save(state: EdenClientState): Promise<void>;
  loadReplayEvidence(
    sessionId: string,
  ): Promise<readonly EdenClientReplayEvidence[]>;
  saveReplayEvidence(
    sessionId: string,
    evidence: readonly EdenClientReplayEvidence[],
  ): Promise<void>;
}

export class EdenMemoryEventStore implements EdenEventStore {
  private state: EdenClientState | undefined;
  private readonly replayEvidenceBySession = new Map<
    string,
    readonly EdenClientReplayEvidence[]
  >();

  constructor(initialState?: EdenClientState) {
    if (initialState !== undefined) {
      const valid = assertValidState(initialState);
      if (valid === undefined) {
        throw new EdenProtocolError(
          "invalid_state",
          "Persisted Eden client state must contain only sessionId and streamIndex.",
        );
      }
      this.state = Object.freeze({ ...valid });
    }
  }

  async load(): Promise<EdenClientState | undefined> {
    return this.state === undefined ? undefined : { ...this.state };
  }

  async save(state: EdenClientState): Promise<void> {
    const valid = assertValidState(state);
    if (valid === undefined) {
      throw new EdenProtocolError(
        "invalid_state",
        "Persisted Eden client state must contain only sessionId and streamIndex.",
      );
    }
    this.state = Object.freeze({ ...valid });
  }

  async loadReplayEvidence(
    sessionId: string,
  ): Promise<readonly EdenClientReplayEvidence[]> {
    validateSessionId(sessionId);
    return (this.replayEvidenceBySession.get(sessionId) ?? []).map((entry) => ({
      ...entry,
    }));
  }

  async saveReplayEvidence(
    sessionId: string,
    evidence: readonly EdenClientReplayEvidence[],
  ): Promise<void> {
    validateSessionId(sessionId);
    const valid = validateReplayEvidence(evidence);
    this.replayEvidenceBySession.set(
      sessionId,
      valid.map((entry) => ({ ...entry })),
    );
  }

  snapshot(): EdenClientState | undefined {
    return this.state === undefined ? undefined : { ...this.state };
  }

  serialize(): string {
    return JSON.stringify({
      state: this.state,
      replayEvidence: Object.fromEntries(
        [...this.replayEvidenceBySession.entries()].map(
          ([sessionId, evidence]) => [sessionId, evidence],
        ),
      ),
    });
  }

  static fromSerialized(serialized: string): EdenMemoryEventStore {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch {
      throw new EdenProtocolError(
        "invalid_state",
        "Serialized Eden client state must be valid JSON.",
      );
    }
    if (!isRecord(parsed)) {
      throw new EdenProtocolError(
        "invalid_state",
        "Serialized Eden client state must be an object.",
      );
    }
    const state = parsed.state === undefined
      ? undefined
      : assertValidState(parsed.state);
    if (parsed.state !== undefined && state === undefined) {
      throw new EdenProtocolError(
        "invalid_state",
        "Serialized Eden client state contains an invalid session cursor.",
      );
    }
    const evidenceBySession = parsed.replayEvidence;
    if (!isRecord(evidenceBySession)) {
      throw new EdenProtocolError(
        "invalid_state",
        "Serialized Eden replay evidence must be session-scoped.",
      );
    }
    const store = new EdenMemoryEventStore(state);
    for (const [sessionId, evidence] of Object.entries(evidenceBySession)) {
      if (!isOpaqueSessionId(sessionId) || !Array.isArray(evidence)) {
        throw new EdenProtocolError(
          "invalid_state",
          "Serialized Eden replay evidence has an invalid session scope.",
        );
      }
      store.replayEvidenceBySession.set(
        sessionId,
        validateReplayEvidence(evidence),
      );
    }
    return store;
  }
}

export interface EdenEventIteratorOptions {
  readonly startIndex?: number;
  readonly follow?: boolean;
  readonly signal?: AbortSignal;
}

export interface EdenClientSession {
  readonly sessionId: string;
  sendMessage(request: EdenCommandRequest): Promise<EdenSessionAcceptance>;
  events(
    options?: EdenEventIteratorOptions,
  ): AsyncIterable<EdenEvent<EdenEventType>>;
  stream(
    options?: EdenEventIteratorOptions,
  ): AsyncIterable<EdenEvent<EdenEventType>>;
}

export interface EdenClient {
  createSession(): Promise<EdenSessionSnapshot>;
  attach(
    sessionId: string,
    store?: EdenEventStore,
  ): EdenClientSession;
  attachSession(
    sessionId: string,
    store?: EdenEventStore,
  ): EdenClientSession;
  sendMessage(
    sessionId: string,
    request: EdenCommandRequest,
  ): Promise<EdenSessionAcceptance>;
  events(
    sessionId: string,
    startIndexOrOptions?: number | EdenEventIteratorOptions,
  ): AsyncIterable<EdenEvent<EdenEventType>>;
  stream(
    sessionId: string,
    options?: EdenEventIteratorOptions,
  ): AsyncIterable<EdenEvent<EdenEventType>>;
}

export type { EdenClientOptions as EdenClientConfiguration };

interface InternalEventRecord {
  readonly fingerprint: string;
  readonly streamIndex: number;
}

type InternalReplayEvidence = EdenClientReplayEvidence;

interface InternalSession {
  readonly sessionId: string;
  readonly store?: EdenEventStore;
}

interface LoadedCursor {
  readonly cursor: number;
  readonly persistedCursor: number;
  readonly replayEvidence: readonly InternalReplayEvidence[];
}

const DEFAULT_FOLLOW = true;
const ACCEPTED_JSON_CONTENT_TYPE = "application/json";
const ACCEPTED_NDJSON_CONTENT_TYPE = "application/x-ndjson";
const MAX_INTERNAL_REPLAY_EVIDENCE = 256;

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

function isSessionStatus(value: unknown): value is EdenSessionSnapshot["status"] {
  return (
    value === "new" ||
    value === "running" ||
    value === "waiting" ||
    value === "failed" ||
    value === "completed"
  );
}

function isVersionSet(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.runtime === "string" &&
    typeof value.agentBundle === "string" &&
    typeof value.manifest === "string" &&
    typeof value.protocol === "string" &&
    typeof value.schema === "number" &&
    Number.isSafeInteger(value.schema)
  );
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value)
  );
}

function invalidResponse(message: string): never {
  throw new EdenClientError("invalid_response", message);
}

function responseMediaType(response: Response): string {
  return (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

function protocolError(
  code: EdenProtocolErrorCode,
  message: string,
): EdenProtocolError {
  return new EdenProtocolError(code, message);
}

function validateReplayEvidence(
  value: unknown,
): readonly InternalReplayEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_INTERNAL_REPLAY_EVIDENCE) {
    throw protocolError(
      "invalid_state",
      "Persisted Eden replay evidence exceeds its bounded format.",
    );
  }
  const seenEventIds = new Set<string>();
  const seenCursors = new Set<number>();
  const normalized = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["eventId", "streamIndex", "fingerprint"]) ||
      !isOpaqueEventId(entry.eventId) ||
      !isReplayEvidenceFingerprint(entry.fingerprint) ||
      typeof entry.streamIndex !== "number" ||
      !Number.isSafeInteger(entry.streamIndex) ||
      entry.streamIndex < 1 ||
      seenEventIds.has(entry.eventId) ||
      seenCursors.has(entry.streamIndex)
    ) {
      throw protocolError(
        "invalid_state",
        "Persisted Eden replay evidence is malformed or duplicated.",
      );
    }
    seenEventIds.add(entry.eventId);
    seenCursors.add(entry.streamIndex);
    return {
      eventId: entry.eventId,
      streamIndex: entry.streamIndex,
      fingerprint: entry.fingerprint,
    };
  });
  return normalized.sort((left, right) => left.streamIndex - right.streamIndex);
}

function buildReplayEvidence(
  cursors: ReadonlyMap<
    number,
    { readonly eventId: string; readonly fingerprint: string }
  >,
): readonly InternalReplayEvidence[] {
  return [...cursors.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-MAX_INTERNAL_REPLAY_EVIDENCE)
    .map(([streamIndex, value]) => ({
      eventId: value.eventId,
      streamIndex,
      fingerprint: value.fingerprint,
    }));
}

async function loadPersistedReplayEvidence(
  store: EdenEventStore | undefined,
  sessionId: string,
): Promise<readonly InternalReplayEvidence[]> {
  if (store === undefined) return [];
  return validateReplayEvidence(await store.loadReplayEvidence(sessionId));
}

function trimReplayEvidence(
  known: Map<string, InternalEventRecord>,
  cursors: Map<
    number,
    { readonly eventId: string; readonly fingerprint: string }
  >,
): void {
  if (cursors.size <= MAX_INTERNAL_REPLAY_EVIDENCE) return;
  const retainedCursors = new Set(
    [...cursors.keys()]
      .sort((left, right) => left - right)
      .slice(-MAX_INTERNAL_REPLAY_EVIDENCE),
  );
  for (const [streamIndex, value] of cursors) {
    if (!retainedCursors.has(streamIndex)) {
      cursors.delete(streamIndex);
      known.delete(value.eventId);
    }
  }
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EdenClientConfigurationError("The Eden base URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EdenClientConfigurationError(
      "The Eden base URL must use HTTP or HTTPS.",
    );
  }
  return url;
}

function validateCursor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError(
      "invalid_cursor",
      `${field} must be a non-negative safe integer.`,
    );
  }
}

function validateSessionId(sessionId: string): void {
  if (!isOpaqueSessionId(sessionId)) {
    throw protocolError(
      "invalid_state",
      "The Eden session identifier is not an opaque session ID.",
    );
  }
}

function validateState(
  value: unknown,
): EdenClientState | undefined {
  const valid = assertValidState(value);
  if (valid === undefined) {
    throw protocolError(
      "invalid_state",
      "Persisted Eden client state must contain only sessionId and streamIndex.",
    );
  }
  return valid;
}

function parseJsonBody(
  text: string,
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    invalidResponse("Eden returned malformed JSON.");
  }
}

function responseErrorCode(value: unknown): string {
  if (!isRecord(value) || typeof value.code !== "string") {
    return "http_error";
  }
  return /^[A-Za-z0-9_.-]{1,64}$/u.test(value.code)
    ? value.code
    : "http_error";
}

async function readResponseJson(
  response: Response,
): Promise<unknown> {
  const body = await response.text();
  if (body.length === 0) return undefined;
  return parseJsonBody(body);
}

function eventLineParser(
  line: string,
): EdenEvent<EdenEventType> {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (normalized.length === 0) {
    throw protocolError("malformed_json", "NDJSON contains an empty record.");
  }
  if (new TextEncoder().encode(normalized).byteLength > 128 * 1024) {
    throw protocolError("invalid_event", "An Eden event exceeds the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(normalized) as unknown;
  } catch {
    throw protocolError("malformed_json", "NDJSON contains malformed JSON.");
  }
  return parseEdenEvent(value);
}

async function* responseEvents(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<EdenEvent<EdenEventType>> {
  if (responseMediaType(response) !== ACCEPTED_NDJSON_CONTENT_TYPE) {
    throw protocolError(
      "invalid_content_type",
      "Eden event streams must use application/x-ndjson.",
    );
  }
  const body = response.body;
  if (body === null) {
    throw protocolError(
      "truncated_ndjson",
      "Eden returned an empty event stream body.",
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const abortReader = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error: unknown) {
        if (signal?.aborted) return;
        const message = error instanceof Error
          ? error.message
          : "The Eden event stream could not be read.";
        throw new EdenTransportError(message);
      }
      if (next.done) break;
      try {
        buffer += decoder.decode(next.value, { stream: true });
      } catch {
        throw protocolError(
          "malformed_json",
          "Eden returned invalid UTF-8 in the event stream.",
        );
      }
      const lastNewline = buffer.lastIndexOf("\n");
      const pendingLine = buffer.slice(lastNewline + 1);
      if (new TextEncoder().encode(pendingLine).byteLength > 128 * 1024) {
        throw protocolError("invalid_event", "An Eden event exceeds the size limit.");
      }

      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (signal?.aborted) return;
        yield eventLineParser(line);
      }
    }

    try {
      buffer += decoder.decode();
    } catch {
      throw protocolError(
        "malformed_json",
        "Eden returned invalid UTF-8 in the event stream.",
      );
    }
    if (buffer.length > 0) {
      if (signal?.aborted) return;
      yield eventLineParser(buffer);
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
    await reader.cancel().catch(() => undefined);
  }
}

class EdenClientImplementation implements EdenClient {
  private readonly baseUrl: URL;
  private readonly bearerToken: string | undefined;
  private readonly getBearerToken:
    | (() => string | Promise<string>)
    | undefined;
  private readonly fetcher: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly knownEvents = new Map<
    string,
    Map<string, InternalEventRecord>
  >();
  private readonly knownCursors = new Map<
    string,
    Map<number, { readonly eventId: string; readonly fingerprint: string }>
  >();

  constructor(options: EdenClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.bearerToken = options.bearerToken;
    this.getBearerToken = options.getBearerToken;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async createSession(): Promise<EdenSessionSnapshot> {
    const response = await this.request("/eden/v1/session", {
      method: "POST",
      headers: {
        "content-type": ACCEPTED_JSON_CONTENT_TYPE,
        accept: ACCEPTED_JSON_CONTENT_TYPE,
      },
      body: "{}",
    });
    if (response.status !== 200 && response.status !== 201) {
      await this.throwHttpError(response);
    }
    const value = await this.readJsonSuccess(response);
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, [
        "sessionId",
        "status",
        "versions",
        "sqliteSchemaVersion",
      ]) ||
      !isOpaqueSessionId(value.sessionId) ||
      !isSessionStatus(value.status) ||
      !isVersionSet(value.versions) ||
      typeof value.sqliteSchemaVersion !== "number" ||
      !Number.isSafeInteger(value.sqliteSchemaVersion) ||
      value.sqliteSchemaVersion < 0
    ) {
      invalidResponse("Eden returned an invalid session snapshot.");
    }
    return {
      sessionId: value.sessionId,
      status: value.status,
      versions: value.versions as EdenSessionSnapshot["versions"],
      sqliteSchemaVersion: value.sqliteSchemaVersion,
    };
  }

  attach(
    sessionId: string,
    store?: EdenEventStore,
  ): EdenClientSession {
    validateSessionId(sessionId);
    const internal: InternalSession = { sessionId, ...(store === undefined ? {} : { store }) };
    return {
      sessionId,
      sendMessage: (request) => this.sendMessage(sessionId, request),
      events: (options) => this.eventsForSession(internal, options),
      stream: (options) => this.eventsForSession(internal, options),
    };
  }

  attachSession(
    sessionId: string,
    store?: EdenEventStore,
  ): EdenClientSession {
    return this.attach(sessionId, store);
  }

  async sendMessage(
    sessionId: string,
    request: EdenCommandRequest,
  ): Promise<EdenSessionAcceptance> {
    validateSessionId(sessionId);
    if (
      !isRecord(request) ||
      !hasOnlyKeys(request, ["message"]) ||
      typeof request.message !== "string" ||
      request.message.trim().length === 0
    ) {
      throw protocolError(
        "invalid_state",
        "An Eden command must contain a non-empty message.",
      );
    }
    const response = await this.request(`/eden/v1/session/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: {
        "content-type": ACCEPTED_JSON_CONTENT_TYPE,
        accept: ACCEPTED_JSON_CONTENT_TYPE,
      },
      body: JSON.stringify(request),
    });
    if (response.status !== 200 && response.status !== 202) {
      await this.throwHttpError(response);
    }
    const value = await this.readJsonSuccess(response);
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["sessionId", "turnId", "status"]) ||
      value.sessionId !== sessionId ||
      !isOpaqueId(value.turnId) ||
      value.status !== "accepted"
    ) {
      invalidResponse("Eden returned an invalid command acceptance.");
    }
    return {
      sessionId: value.sessionId,
      turnId: value.turnId,
      status: "accepted",
    };
  }

  events(
    sessionId: string,
    startIndexOrOptions: number | EdenEventIteratorOptions = {},
  ): AsyncIterable<EdenEvent<EdenEventType>> {
    return this.eventsForSession(
      { sessionId },
      typeof startIndexOrOptions === "number"
        ? { startIndex: startIndexOrOptions }
        : startIndexOrOptions,
    );
  }

  stream(
    sessionId: string,
    options: EdenEventIteratorOptions = {},
  ): AsyncIterable<EdenEvent<EdenEventType>> {
    return this.eventsForSession({ sessionId }, options);
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    const token = await this.resolveBearerToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetcher(
        new URL(path, this.baseUrl),
        { ...init, headers },
      );
    } catch (error: unknown) {
      if (error instanceof EdenClientError) throw error;
      const message = error instanceof Error
        ? error.message
        : "The Eden transport could not deliver the request.";
      throw new EdenTransportError(message);
    }
    return response;
  }

  private async resolveBearerToken(): Promise<string> {
    let token: string | undefined;
    try {
      token = this.getBearerToken === undefined
        ? this.bearerToken
        : await this.getBearerToken();
    } catch {
      throw new EdenClientConfigurationError(
        "An Eden bearer credential could not be resolved.",
      );
    }
    if (token === undefined || token.length === 0 || /\s/u.test(token)) {
      throw new EdenClientConfigurationError(
        "An Eden bearer credential is required.",
      );
    }
    return token;
  }

  private async readJsonSuccess(response: Response): Promise<unknown> {
    if (responseMediaType(response) !== ACCEPTED_JSON_CONTENT_TYPE) {
      throw protocolError(
        "invalid_content_type",
        "Eden JSON responses must use application/json.",
      );
    }
    return readResponseJson(response);
  }

  private async throwHttpError(response: Response): Promise<never> {
    const value = await readResponseJson(response).catch(() => undefined);
    throw new EdenHttpError(response.status, responseErrorCode(value));
  }

  private async loadCursor(
    session: InternalSession,
    requestedStart: number | undefined,
  ): Promise<LoadedCursor> {
    if (requestedStart !== undefined) validateCursor(requestedStart, "startIndex");
    const loaded = session.store === undefined
      ? undefined
      : await session.store.load();
    const stored = loaded === undefined ? undefined : validateState(loaded);
    if (
      stored !== undefined &&
      stored.sessionId !== session.sessionId
    ) {
      throw protocolError(
        "invalid_state",
        "Persisted Eden client state belongs to a different session.",
      );
    }
    const requested = requestedStart ?? 0;
    const persistedCursor = stored?.streamIndex ?? 0;
    const replayEvidence = stored === undefined
      ? []
      : (await loadPersistedReplayEvidence(session.store, session.sessionId))
        .filter((entry) => entry.streamIndex <= persistedCursor);
    return {
      cursor: Math.max(requested, persistedCursor),
      persistedCursor,
      replayEvidence,
    };
  }

  private async *eventsForSession(
    session: InternalSession,
    options: EdenEventIteratorOptions = {},
  ): AsyncGenerator<EdenEvent<EdenEventType>> {
    validateSessionId(session.sessionId);
    const signal = options.signal;
    if (signal?.aborted) return;
    const loadedCursor = await this.loadCursor(session, options.startIndex);
    if (signal?.aborted) return;
    const cursor = loadedCursor.cursor;
    const persistedCursor = loadedCursor.persistedCursor;
    const follow = options.follow ?? DEFAULT_FOLLOW;
    const requestInit: RequestInit = {
      method: "GET",
      headers: { accept: ACCEPTED_NDJSON_CONTENT_TYPE },
      ...(signal === undefined ? {} : { signal }),
    };
    let response: Response;
    try {
      response = await this.request(
        `/eden/v1/session/${encodeURIComponent(session.sessionId)}/stream?startIndex=${cursor}&follow=${follow ? "true" : "false"}`,
        requestInit,
      );
    } catch (error: unknown) {
      if (signal?.aborted) return;
      throw error;
    }
    if (response.status !== 200) {
      await this.throwHttpError(response);
    }

    let acceptedCursor = cursor;
    let known = this.knownEvents.get(session.sessionId);
    if (known === undefined) {
      known = new Map<string, InternalEventRecord>();
      this.knownEvents.set(session.sessionId, known);
    }
    let cursors = this.knownCursors.get(session.sessionId);
    if (cursors === undefined) {
      cursors = new Map<
        number,
        { readonly eventId: string; readonly fingerprint: string }
      >();
      this.knownCursors.set(session.sessionId, cursors);
    }
    for (const evidence of loadedCursor.replayEvidence) {
      known.set(evidence.eventId, {
        fingerprint: evidence.fingerprint,
        streamIndex: evidence.streamIndex,
      });
      cursors.set(evidence.streamIndex, {
        eventId: evidence.eventId,
        fingerprint: evidence.fingerprint,
      });
    }
    trimReplayEvidence(known, cursors);

    const acceptCursor = async (
      event: EdenEvent<EdenEventType>,
      fingerprint: string,
    ): Promise<void> => {
      const previousAcceptedCursor = acceptedCursor;
      known?.set(event.eventId, {
        fingerprint,
        streamIndex: event.streamIndex,
      });
      cursors?.set(event.streamIndex, {
        eventId: event.eventId,
        fingerprint,
      });
      acceptedCursor = event.streamIndex;
      const replayEvidence = buildReplayEvidence(cursors);
      if (session.store !== undefined) {
        try {
          await session.store.saveReplayEvidence(
            session.sessionId,
            replayEvidence,
          );
          await session.store.save({
            sessionId: session.sessionId,
            streamIndex: acceptedCursor,
          });
        } catch {
          known?.delete(event.eventId);
          cursors?.delete(event.streamIndex);
          acceptedCursor = previousAcceptedCursor;
          throw new EdenClientError(
            "state_persistence_failed",
            "The Eden client could not persist the accepted event cursor.",
          );
        }
      }
      trimReplayEvidence(known, cursors);
    };

    for await (const event of responseEvents(response, signal)) {
      if (signal?.aborted) return;
      if (
        event.type === "session.started" &&
        event.data.sessionId !== session.sessionId
      ) {
        throw protocolError(
          "invalid_event",
          "The session.started event belongs to a different Eden session.",
        );
      }
      const fingerprint = replayEvidenceFingerprint(event);
      const previous = known.get(event.eventId);
      if (previous !== undefined) {
        if (previous.streamIndex !== event.streamIndex) {
          throw protocolError(
            "cursor_conflict",
            `Event ID "${event.eventId}" was replayed at a different cursor.`,
          );
        }
        if (previous.fingerprint !== fingerprint) {
          throw protocolError(
            "event_id_conflict",
            `Event ID "${event.eventId}" was replayed with different committed data.`,
          );
        }
        if (event.streamIndex > acceptedCursor) {
          if (event.streamIndex !== acceptedCursor + 1) {
            throw protocolError(
              "cursor_gap",
              `Eden returned cursor ${event.streamIndex} after cursor ${acceptedCursor}.`,
            );
          }
          await acceptCursor(event, fingerprint);
        }
        continue;
      }

      if (event.streamIndex <= acceptedCursor) {
        const previousCursor = cursors.get(event.streamIndex);
        if (
          previousCursor !== undefined &&
          (previousCursor.eventId !== event.eventId ||
            previousCursor.fingerprint !== fingerprint)
        ) {
          throw protocolError(
            "cursor_conflict",
            `Eden returned different data for already accepted cursor ${event.streamIndex}.`,
          );
        }
        if (
          previousCursor === undefined &&
          event.streamIndex <= persistedCursor
        ) {
          throw protocolError(
            "cursor_conflict",
            `Eden returned an unverified event at already accepted cursor ${event.streamIndex}.`,
          );
        }
        throw protocolError(
          event.streamIndex < acceptedCursor
            ? "cursor_regression"
            : "cursor_conflict",
          `Eden returned an event at cursor ${event.streamIndex} after cursor ${acceptedCursor}.`,
        );
      }
      if (event.streamIndex !== acceptedCursor + 1) {
        throw protocolError(
          "cursor_gap",
          `Eden returned cursor ${event.streamIndex} after cursor ${acceptedCursor}.`,
        );
      }

      await acceptCursor(event, fingerprint);
      yield event;
    }
  }
}

export function createEdenClient(
  options: EdenClientOptions,
): EdenClient {
  return new EdenClientImplementation(options);
}

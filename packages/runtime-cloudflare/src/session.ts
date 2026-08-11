import { DurableObject } from "cloudflare:workers";
import type { SqlStorage } from "@cloudflare/workers-types";
import type {
  EdenAgentDefinition,
  EdenEvent,
  EdenEventType,
  EdenJsonValue,
  EdenSessionStatus,
  EdenToolDefinition,
  EdenTurnStatus,
  EdenVersionSet,
} from "@eden/definitions";

import { readConfiguredEdenArtifact } from "./artifact-runtime.js";
import { createWorkersAIModelAdapter } from "./model-adapter-internal.js";
import { readConfiguredEdenTestModel } from "./test-execution.js";
import {
  applySessionMigrations,
  readAppliedSessionSchemaVersion,
  SESSION_SCHEMA_TABLES,
} from "./session-schema.js";
import {
  isOpaqueMessageId,
  isOpaqueTurnId,
  sessionIdFromObjectName,
} from "./session-identity.js";
import {
  commitSessionTransaction,
  readJournalEventsPage,
  readLatestJournalCursor,
} from "./session-journal.js";
import {
  enqueueRecoveryJob,
  inspectRecoveryJobs,
  MAX_RECOVERY_JOBS_PER_ALARM,
  nextRecoveryJobDueAt,
  processRecoveryJobs,
  recoverRecoveryJob,
  type RecoveryJobInspectionOptions,
  type RecoveryJobRecord,
  type RecoveryJobEnqueueResult,
  type RecoveryJobInput,
  type RecoveryJobInspection,
  type RecoveryJobRecoveryResult,
} from "./session-jobs.js";
import { runBoundedTurn } from "./turn-runner.js";

export interface EdenSessionEnvironment {
  readonly [key: string]: unknown;
  readonly AI?: unknown;
}

type EdenSessionState = ConstructorParameters<typeof DurableObject>[0];

export interface EdenSessionInitialization {
  readonly sessionId: string;
  readonly ownerPrincipal: string;
  readonly versions: EdenVersionSet;
}

interface SessionMetaRow {
  readonly [key: string]: string | number | null;
  readonly session_id: string;
  readonly owner_principal: string;
  readonly status: EdenSessionStatus;
  readonly runtime_version: string;
  readonly agent_bundle_version: string;
  readonly manifest_version: string;
  readonly protocol_version: string;
  readonly schema_version: number;
  readonly artifact_schema_version: number;
}

interface SessionMetaResponse {
  readonly sessionId: string;
  readonly ownerPrincipal: string;
  readonly status: EdenSessionStatus;
  readonly runtimeVersion: string;
  readonly agentBundleVersion: string;
  readonly manifestVersion: string;
  readonly protocolVersion: string;
  readonly schemaVersion: number;
  readonly artifactSchemaVersion: number;
}

interface MigrationRow {
  readonly [key: string]: string | number | null;
  readonly version: number;
  readonly name: string;
}

interface AcceptedTurnRow {
  readonly [key: string]: string | number | null;
  readonly turn_id: string;
  readonly message_id: string;
  readonly message: string;
}

interface EventStreamRequest {
  readonly sessionId: string;
  readonly ownerPrincipal: string;
  readonly startIndex: number;
  readonly follow: boolean;
}

const BOUNDED_TURN_JOB_KIND = "bounded-turn";
const BOUNDED_TURN_RECOVERY_ACTION = "run-bounded-turn";
const BOUNDED_TURN_START_DELAY_MS = 100;
const MAX_EVENT_LINE_BYTES = 131_072;

interface ConfiguredTurn {
  readonly agent: EdenAgentDefinition;
  readonly instructions: string;
  readonly generation: {
    readonly executionMode: "local" | "remote";
  };
  readonly toolName: string;
  readonly tool: EdenToolDefinition;
  readonly toolInputSchema: EdenJsonValue;
  readonly bundleIdentity: string;
}

function configuredTurn(): ConfiguredTurn | undefined {
  const configured = readConfiguredEdenArtifact();
  if (configured === undefined) return undefined;
  const toolName = configured.generation.toolNames[0];
  if (toolName === undefined) return undefined;
  const tool = configured.artifact.tools[toolName];
  if (tool === undefined) return undefined;
  const toolInputSchema = configured.artifact.toolSchemas[toolName];
  if (toolInputSchema === undefined) return undefined;
  return {
    agent: configured.artifact.agent,
    instructions: configured.artifact.instructions,
    generation: configured.generation,
    toolName,
    tool,
    toolInputSchema,
    bundleIdentity: configured.generation.generationId,
  };
}

function isTerminalEvent(type: EdenEventType): boolean {
  return type === "session.waiting" || type === "session.failed";
}

function eventLine(event: EdenEvent<EdenEventType>): Uint8Array {
  const serialized = `${JSON.stringify(event)}\n`;
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > MAX_EVENT_LINE_BYTES) {
    throw new Error("Stream event exceeds the 128 KiB limit");
  }
  return bytes;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isVersionSet(value: unknown): value is EdenVersionSet {
  const object = parseObject(value);
  return (
    object !== null &&
    typeof object.runtime === "string" &&
    typeof object.agentBundle === "string" &&
    typeof object.manifest === "string" &&
    typeof object.protocol === "string" &&
    typeof object.schema === "number" &&
    Number.isSafeInteger(object.schema)
  );
}

function versionResponse(
  row: SessionMetaRow,
  installedSchemaVersion: number,
): SessionMetaResponse {
  return {
    sessionId: row.session_id,
    ownerPrincipal: row.owner_principal,
    status: row.status,
    runtimeVersion: row.runtime_version,
    agentBundleVersion: row.agent_bundle_version,
    manifestVersion: row.manifest_version,
    protocolVersion: row.protocol_version,
    schemaVersion: installedSchemaVersion,
    artifactSchemaVersion: row.artifact_schema_version,
  };
}

function artifactVersionsFromMeta(row: SessionMetaRow): EdenVersionSet {
  return {
    runtime: row.runtime_version,
    agentBundle: row.agent_bundle_version,
    manifest: row.manifest_version,
    protocol: row.protocol_version,
    schema: row.artifact_schema_version,
  };
}

function readSessionMeta(sql: SqlStorage): SessionMetaRow | null {
  const rows = sql
    .exec<SessionMetaRow>(
      `SELECT session_id, owner_principal, status, runtime_version,
        agent_bundle_version, manifest_version, protocol_version, schema_version,
        artifact_schema_version
       FROM session_meta
       LIMIT 1`,
    )
    .toArray();
  return rows[0] ?? null;
}

function readTables(sql: SqlStorage): readonly string[] {
  const placeholders = SESSION_SCHEMA_TABLES.map(() => "?").join(", ");
  const rows = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${placeholders})
       ORDER BY name`,
      ...SESSION_SCHEMA_TABLES,
    )
    .toArray();
  return rows.map((row) => row.name);
}

function readMigrations(sql: SqlStorage): readonly MigrationRow[] {
  return sql
    .exec<MigrationRow>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    )
    .toArray();
}

function readInitialization(
  request: Request,
): Promise<EdenSessionInitialization | null> {
  return request
    .json()
    .then((value: unknown) => {
      const object = parseObject(value);
      if (
        object === null ||
        typeof object.sessionId !== "string" ||
        typeof object.ownerPrincipal !== "string" ||
        !isVersionSet(object.versions)
      ) {
        return null;
      }
      return {
        sessionId: object.sessionId,
        ownerPrincipal: object.ownerPrincipal,
        versions: object.versions,
      };
    })
    .catch(() => null);
}

function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  return request
    .json()
    .then(parseObject)
    .catch(() => null);
}

function readEventStreamRequest(
  request: Request,
): Promise<EventStreamRequest | null> {
  return readJsonObject(request).then((body) => {
    if (
      body === null ||
      !hasOnlyKeys(body, [
        "sessionId",
        "ownerPrincipal",
        "startIndex",
        "follow",
      ]) ||
      typeof body.sessionId !== "string" ||
      typeof body.ownerPrincipal !== "string" ||
      typeof body.startIndex !== "number" ||
      !Number.isSafeInteger(body.startIndex) ||
      body.startIndex < 0 ||
      typeof body.follow !== "boolean"
    ) {
      return null;
    }
    return {
      sessionId: body.sessionId,
      ownerPrincipal: body.ownerPrincipal,
      startIndex: body.startIndex,
      follow: body.follow,
    };
  });
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function readOwnerPrincipal(
  body: Record<string, unknown>,
): string | null {
  return typeof body.ownerPrincipal === "string"
    ? body.ownerPrincipal
    : null;
}

function isRecoveryJobInput(
  value: unknown,
): value is RecoveryJobInput {
  const object = parseObject(value);
  return (
    object !== null &&
    typeof object.jobId === "string" &&
    typeof object.kind === "string" &&
    typeof object.dueAt === "number" &&
    typeof object.recoveryAction === "string" &&
    (object.maxAttempts === undefined || typeof object.maxAttempts === "number")
  );
}

function jsonJobResponse(
  body: RecoveryJobEnqueueResult | RecoveryJobRecoveryResult,
  status = 200,
): Response {
  return jsonResponse(body, status);
}

export class EdenSession extends DurableObject<EdenSessionEnvironment> {
  private readonly initialized: Promise<void>;

  constructor(
    ctx: EdenSessionState,
    env: EdenSessionEnvironment,
  ) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      applySessionMigrations(ctx.storage);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;

    const url = new URL(request.url);
    if (url.pathname === "/_eden/schema" && request.method === "GET") {
      return this.schemaResponse();
    }
    if (url.pathname === "/_eden/events" && request.method === "GET") {
      return this.eventsResponse(url);
    }
    if (
      url.pathname === "/_eden/read-events" &&
      request.method === "POST"
    ) {
      return this.readEventsResponse(request);
    }
    if (url.pathname === "/_eden/stream" && request.method === "POST") {
      return this.streamEventsResponse(request);
    }
    if (url.pathname === "/_eden/accept" && request.method === "POST") {
      return this.acceptCommandResponse(request);
    }
    if (url.pathname === "/_eden/jobs" && request.method === "GET") {
      return this.recoveryJobsResponse(url);
    }
    if (url.pathname === "/_eden/jobs" && request.method === "POST") {
      return this.enqueueRecoveryJobResponse(request);
    }
    const recoverPrefix = "/_eden/jobs/";
    if (
      url.pathname.startsWith(recoverPrefix) &&
      url.pathname.endsWith("/recover") &&
      request.method === "POST"
    ) {
      let jobId: string;
      try {
        jobId = decodeURIComponent(
          url.pathname.slice(recoverPrefix.length, -"/recover".length),
        );
      } catch {
        return jsonResponse(
          { code: "invalid_recovery_operation", message: "Invalid recovery operation" },
          400,
        );
      }
      return this.recoverRecoveryJobResponse(request, jobId);
    }
    if (
      url.pathname === "/_eden/initialize" &&
      request.method === "POST"
    ) {
      return this.initialize(request);
    }
    return jsonResponse({ code: "not_found", message: "Not found" }, 404);
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    if (sessionId === null) return;

    try {
      await processRecoveryJobs(
        this.ctx.storage,
        sessionId,
        async (job) => this.executeRecoveryJob(job),
        {
          limit: MAX_RECOVERY_JOBS_PER_ALARM,
        },
      );
    } finally {
      await this.rearmRecoveryAlarm(sessionId);
    }
  }

  async enqueueRecoveryJob(
    input: RecoveryJobInput,
  ): Promise<RecoveryJobEnqueueResult> {
    await this.initialized;
    const sessionId = this.requireSessionId();
    const result = enqueueRecoveryJob(this.ctx.storage, sessionId, input);
    await this.rearmRecoveryAlarm(sessionId);
    return result;
  }

  inspectRecoveryJobs(
    options: RecoveryJobInspectionOptions = {},
  ): RecoveryJobInspection {
    const sessionId = this.requireSessionId();
    return inspectRecoveryJobs(this.ctx.storage.sql, sessionId, options);
  }

  async recoverRecoveryJob(
    jobId: string,
    input: {
      readonly recoveryAction?: string;
      readonly dueAt?: number;
    } = {},
  ): Promise<RecoveryJobRecoveryResult> {
    await this.initialized;
    const sessionId = this.requireSessionId();
    const result = recoverRecoveryJob(
      this.ctx.storage,
      sessionId,
      jobId,
      input.recoveryAction,
      input.dueAt,
    );
    await this.rearmRecoveryAlarm(sessionId);
    return result;
  }

  private schemaResponse(): Response {
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    if (sessionId === null) {
      return jsonResponse(
        { code: "session_mapping_invalid", message: "Session mapping unavailable" },
        500,
      );
    }

    const sql = this.ctx.storage.sql;
    const meta = readSessionMeta(sql);
    const installedSchemaVersion = readAppliedSessionSchemaVersion(sql);
    return jsonResponse({
      sessionId,
      tables: readTables(sql),
      appliedMigrations: readMigrations(sql),
      installedSchemaVersion,
      sessionMeta:
        meta === null ? null : versionResponse(meta, installedSchemaVersion),
    });
  }

  private eventsResponse(url: URL): Response {
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    if (sessionId === null) {
      return jsonResponse(
        { code: "session_mapping_invalid", message: "Session mapping unavailable" },
        500,
      );
    }

    const rawStartIndex = url.searchParams.get("startIndex") ?? "0";
    const startIndex = Number(rawStartIndex);
    if (
      !Number.isSafeInteger(startIndex) ||
      startIndex < 0 ||
      rawStartIndex !== String(startIndex)
    ) {
      return jsonResponse(
        { code: "invalid_start_index", message: "Invalid event start index" },
        400,
      );
    }

    const latestCursor = readLatestJournalCursor(this.ctx.storage.sql, sessionId);
    const events = readJournalEventsPage(
      this.ctx.storage.sql,
      sessionId,
      startIndex,
      { endIndex: latestCursor },
    );
    return jsonResponse({
      sessionId,
      startIndex,
      latestCursor,
      nextCursor:
        events.at(-1)?.streamIndex !== undefined &&
        (events.at(-1)?.streamIndex ?? latestCursor) < latestCursor
          ? events.at(-1)?.streamIndex ?? null
          : null,
      events,
    });
  }

  private async initialize(request: Request): Promise<Response> {
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    const input = await readInitialization(request);
    if (sessionId === null || input === null || input.sessionId !== sessionId) {
      return jsonResponse(
        { code: "invalid_session_initialization", message: "Invalid session initialization" },
        400,
      );
    }

    const sql = this.ctx.storage.sql;
    const installedSchemaVersion = readAppliedSessionSchemaVersion(sql);
    const existing = readSessionMeta(sql);
    if (existing !== null) {
      if (
        existing.owner_principal !== input.ownerPrincipal ||
        existing.runtime_version !== input.versions.runtime ||
        existing.agent_bundle_version !== input.versions.agentBundle ||
        existing.manifest_version !== input.versions.manifest ||
        existing.protocol_version !== input.versions.protocol ||
        existing.schema_version !== installedSchemaVersion ||
        existing.artifact_schema_version !== input.versions.schema
      ) {
        return jsonResponse(
          { code: "session_initialization_conflict", message: "Session already initialized" },
          409,
        );
      }
      return jsonResponse({
        sessionId,
        status: existing.status,
        versions: artifactVersionsFromMeta(existing),
      });
    }

    const timestamp = new Date().toISOString();
    try {
      commitSessionTransaction(this.ctx.storage, sessionId, (journal) => {
        sql.exec(
          `INSERT INTO session_meta (
            session_id, owner_principal, status, created_at, updated_at,
            runtime_version, agent_bundle_version, manifest_version,
            protocol_version, schema_version, artifact_schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionId,
          input.ownerPrincipal,
          "new",
          timestamp,
          timestamp,
          input.versions.runtime,
          input.versions.agentBundle,
          input.versions.manifest,
          input.versions.protocol,
          installedSchemaVersion,
          input.versions.schema,
        );
        journal.appendEvent({
          type: "session.started",
          data: {
            sessionId,
            status: "new",
            versions: input.versions,
          },
          committedAt: timestamp,
        });
      });
    } catch (error) {
      const durable = readSessionMeta(sql);
      if (durable !== null) {
        return jsonResponse({
          sessionId,
          status: durable.status,
          versions: artifactVersionsFromMeta(durable),
        });
      }
      throw error;
    }

    return jsonResponse(
      {
        sessionId,
        status: "new",
        versions: input.versions,
      },
      201,
    );
  }

  private async acceptCommandResponse(request: Request): Promise<Response> {
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    const body = await readJsonObject(request);
    if (
      sessionId === null ||
      body === null ||
      !hasOnlyKeys(body, [
        "sessionId",
        "ownerPrincipal",
        "turnId",
        "messageId",
        "message",
      ]) ||
      body.sessionId !== sessionId ||
      readOwnerPrincipal(body) === null ||
      typeof body.turnId !== "string" ||
      !isOpaqueTurnId(body.turnId) ||
      typeof body.messageId !== "string" ||
      !isOpaqueMessageId(body.messageId) ||
      typeof body.message !== "string"
    ) {
      return jsonResponse(
        { code: "invalid_command", message: "Invalid session command" },
        400,
      );
    }
    const message = body.message;
    if (
      message.trim().length === 0 ||
      new TextEncoder().encode(message).byteLength > 16 * 1024
    ) {
      return jsonResponse(
        { code: "invalid_command", message: "Invalid session command" },
        400,
      );
    }

    const sql = this.ctx.storage.sql;
    const meta = readSessionMeta(sql);
    if (meta === null || meta.owner_principal !== body.ownerPrincipal) {
      return jsonResponse(
        { code: "session_not_found", message: "Session was not found" },
        404,
      );
    }

    const existing = sql
      .exec<{
        readonly turn_id: string;
        readonly status: EdenTurnStatus;
        readonly message_id: string | null;
        readonly message: string | null;
      }>(
        `SELECT turns.turn_id, turns.status, messages.message_id,
                messages.content AS message
         FROM turns
         LEFT JOIN messages
           ON messages.turn_id = turns.turn_id
          AND messages.role = 'user'
         WHERE turns.session_id = ? AND turns.turn_id = ?
         LIMIT 1`,
        sessionId,
        body.turnId,
      )
      .toArray()[0];
    if (existing !== undefined) {
      if (
        existing.status === "accepted" &&
        existing.message_id === body.messageId &&
        existing.message === message
      ) {
        return jsonResponse(
          {
            sessionId,
            turnId: body.turnId,
            messageId: body.messageId,
            status: "accepted",
          },
          202,
        );
      }
      return jsonResponse(
        { code: "session_conflict", message: "Session command conflicts with durable state" },
        409,
      );
    }

    const timestamp = new Date().toISOString();
    try {
      commitSessionTransaction(this.ctx.storage, sessionId, (journal) => {
        journal.insertTurn({
          turnId: body.turnId as string,
          status: "accepted",
          acceptedAt: timestamp,
        });
        journal.insertMessage({
          messageId: body.messageId as string,
          turnId: body.turnId as string,
          role: "user",
          content: message,
          createdAt: timestamp,
        });
        journal.setSessionStatus("running", timestamp);
        journal.appendEvent({
          type: "turn.started",
          turnId: body.turnId as string,
          data: { turnId: body.turnId as string },
          committedAt: timestamp,
        });
        journal.appendEvent({
          type: "message.received",
          turnId: body.turnId as string,
          data: {
            messageId: body.messageId as string,
            role: "user",
          },
          committedAt: timestamp,
        });
        journal.insertJob({
          jobId: `turn:${body.turnId as string}`,
          kind: BOUNDED_TURN_JOB_KIND,
          dueAt: Date.now() + BOUNDED_TURN_START_DELAY_MS,
          recoveryAction: BOUNDED_TURN_RECOVERY_ACTION,
          createdAt: timestamp,
        });
      });
    } catch {
      const durable = sql
        .exec<{
          readonly status: EdenTurnStatus;
          readonly message_id: string | null;
          readonly message: string | null;
        }>(
          `SELECT turns.status, messages.message_id,
                  messages.content AS message
           FROM turns
           LEFT JOIN messages
             ON messages.turn_id = turns.turn_id
            AND messages.role = 'user'
           WHERE turns.session_id = ? AND turns.turn_id = ?
           LIMIT 1`,
          sessionId,
          body.turnId,
        )
        .toArray()[0];
      if (
        durable?.status === "accepted" &&
        durable.message_id === body.messageId &&
        durable.message === message
      ) {
        return jsonResponse(
          {
            sessionId,
            turnId: body.turnId,
            messageId: body.messageId,
            status: "accepted",
          },
          202,
        );
      }
      return jsonResponse(
        { code: "session_conflict", message: "Session command could not be accepted" },
        409,
      );
    }

    await this.rearmRecoveryAlarm(sessionId);
    return jsonResponse(
      {
        sessionId,
        turnId: body.turnId,
        messageId: body.messageId,
        status: "accepted",
      },
      202,
    );
  }

  private async readEventsResponse(request: Request): Promise<Response> {
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    const body = await readJsonObject(request);
    if (
      sessionId === null ||
      body === null ||
      !hasOnlyKeys(body, [
        "sessionId",
        "ownerPrincipal",
        "startIndex",
        "follow",
      ]) ||
      body.sessionId !== sessionId ||
      readOwnerPrincipal(body) === null ||
      typeof body.startIndex !== "number" ||
      !Number.isSafeInteger(body.startIndex) ||
      body.startIndex < 0 ||
      typeof body.follow !== "boolean"
    ) {
      return jsonResponse(
        { code: "invalid_event_read", message: "Invalid event read" },
        400,
      );
    }

    const meta = readSessionMeta(this.ctx.storage.sql);
    if (meta === null || meta.owner_principal !== body.ownerPrincipal) {
      return jsonResponse(
        { code: "session_not_found", message: "Session was not found" },
        404,
      );
    }

    const latestCursor = readLatestJournalCursor(this.ctx.storage.sql, sessionId);
    const events = readJournalEventsPage(
      this.ctx.storage.sql,
      sessionId,
      body.startIndex,
      { endIndex: latestCursor },
    );
    return jsonResponse({
      sessionId,
      startIndex: body.startIndex,
      latestCursor,
      nextCursor:
        events.at(-1)?.streamIndex !== undefined &&
        (events.at(-1)?.streamIndex ?? latestCursor) < latestCursor
          ? events.at(-1)?.streamIndex ?? null
          : null,
      events,
    });
  }

  private async streamEventsResponse(request: Request): Promise<Response> {
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    const body = await readEventStreamRequest(request);
    if (
      sessionId === null ||
      body === null ||
      body.sessionId !== sessionId
    ) {
      return jsonResponse(
        { code: "invalid_event_read", message: "Invalid event read" },
        400,
      );
    }

    const meta = readSessionMeta(this.ctx.storage.sql);
    if (meta === null || meta.owner_principal !== body.ownerPrincipal) {
      return jsonResponse(
        { code: "session_not_found", message: "Session was not found" },
        404,
      );
    }

    const sql = this.ctx.storage.sql;
    const highWater = body.follow ? null : readLatestJournalCursor(sql, sessionId);
    let cursor = body.startIndex;
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const pump = async (): Promise<void> => {
          try {
            while (!cancelled) {
              const events = readJournalEventsPage(sql, sessionId, cursor, {
                ...(highWater === null ? {} : { endIndex: highWater }),
              });
              let emitted = false;
              for (const event of events) {
                controller.enqueue(eventLine(event));
                cursor = event.streamIndex;
                emitted = true;
                if (body.follow && isTerminalEvent(event.type)) {
                  controller.close();
                  return;
                }
              }

              if (!body.follow) {
                if (cursor >= (highWater ?? cursor)) {
                  controller.close();
                  return;
                }
              } else if (!emitted) {
                const current = readSessionMeta(sql);
                if (
                  current?.status === "waiting" ||
                  current?.status === "failed" ||
                  current?.status === "completed"
                ) {
                  controller.close();
                  return;
                }
              }

              await delay(10);
            }
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        };
        this.ctx.waitUntil(pump());
      },
      cancel: () => {
        cancelled = true;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private requireSessionId(): string {
    const sessionId = sessionIdFromObjectName(this.ctx.id.name ?? "");
    if (sessionId === null) {
      throw new Error("Session mapping unavailable");
    }
    return sessionId;
  }

  private async recoveryJobsResponse(url: URL): Promise<Response> {
    const allowed = new Set(["cursor", "limit"]);
    let hasUnknownQuery = false;
    url.searchParams.forEach((_value, key) => {
      if (!allowed.has(key)) hasUnknownQuery = true;
    });
    if (hasUnknownQuery) {
      return jsonResponse(
        { code: "invalid_recovery_inspection", message: "Invalid recovery inspection" },
        400,
      );
    }
    const rawLimit = url.searchParams.get("limit");
    const rawCursor = url.searchParams.get("cursor");
    let limitValue: number | undefined;
    let cursorValue: string | undefined;
    if (rawLimit !== null) {
      const limit = Number(rawLimit);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        rawLimit !== String(limit)
      ) {
        return jsonResponse(
          { code: "invalid_recovery_inspection", message: "Invalid recovery inspection" },
          400,
        );
      }
      limitValue = limit;
    }
    if (rawCursor !== null) {
      if (rawCursor.length === 0) {
        return jsonResponse(
          { code: "invalid_recovery_inspection", message: "Invalid recovery inspection" },
          400,
        );
      }
      cursorValue = rawCursor;
    }
    try {
      const options: RecoveryJobInspectionOptions = {
        ...(limitValue === undefined ? {} : { limit: limitValue }),
        ...(cursorValue === undefined ? {} : { cursor: cursorValue }),
      };
      return jsonResponse(this.inspectRecoveryJobs(options));
    } catch {
      return jsonResponse(
        { code: "invalid_recovery_inspection", message: "Invalid recovery inspection" },
        400,
      );
    }
  }

  private async enqueueRecoveryJobResponse(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    if (!isRecoveryJobInput(body)) {
      return jsonResponse(
        { code: "invalid_recovery_job", message: "Invalid recovery job" },
        400,
      );
    }
    try {
      const result = await this.enqueueRecoveryJob(body);
      return jsonJobResponse(result, result.status === "scheduled" ? 201 : 200);
    } catch {
      return jsonResponse(
        {
          code: "invalid_recovery_job",
          message: "Invalid recovery job",
        },
        400,
      );
    }
  }

  private async recoverRecoveryJobResponse(
    request: Request,
    jobId: string,
  ): Promise<Response> {
    const body = await readJsonObject(request);
    if (body === null) {
      return jsonResponse(
        { code: "invalid_recovery_operation", message: "Invalid recovery operation" },
        400,
      );
    }
    if (
      body.recoveryAction !== undefined &&
      typeof body.recoveryAction !== "string"
    ) {
      return jsonResponse(
        { code: "invalid_recovery_operation", message: "Invalid recovery operation" },
        400,
      );
    }
    if (
      body.dueAt !== undefined &&
      (typeof body.dueAt !== "number" || !Number.isSafeInteger(body.dueAt))
    ) {
      return jsonResponse(
        { code: "invalid_recovery_operation", message: "Invalid recovery operation" },
        400,
      );
    }
    try {
      const result =
        await this.recoverRecoveryJob(jobId, {
          ...(body.recoveryAction === undefined
            ? {}
            : { recoveryAction: body.recoveryAction as string }),
          ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt as number }),
        });
      return jsonJobResponse(result);
    } catch {
      return jsonResponse(
        {
          code: "invalid_recovery_operation",
          message: "Invalid recovery operation",
        },
        400,
      );
    }
  }

  private async rearmRecoveryAlarm(sessionId: string): Promise<void> {
    const nextDueAt = nextRecoveryJobDueAt(this.ctx.storage.sql, sessionId);
    if (nextDueAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(nextDueAt);
  }

  private async executeRecoveryJob(job: RecoveryJobRecord): Promise<void> {
    switch (job.recoveryAction) {
      case "mark-complete":
        if (job.kind === BOUNDED_TURN_JOB_KIND) {
          throw new Error("Bounded turn recovery action is invalid");
        }
        return;
      case "always-fail":
      case "fail":
        if (job.kind === BOUNDED_TURN_JOB_KIND) {
          throw new Error("Bounded turn recovery action is invalid");
        }
        throw new Error("Configured recovery action failed");
      case BOUNDED_TURN_RECOVERY_ACTION:
        if (job.kind !== BOUNDED_TURN_JOB_KIND) {
          throw new Error("Bounded turn recovery action is invalid");
        }
        await this.executeBoundedTurnJob(job);
        return;
      default:
        throw new Error("Unknown recovery action");
    }
  }

  private async executeBoundedTurnJob(
    job: RecoveryJobRecord,
  ): Promise<void> {
    const sessionId = this.requireSessionId();
    if (job.recoveryAction !== BOUNDED_TURN_RECOVERY_ACTION) {
      throw new Error("Bounded turn recovery action is invalid");
    }
    const turn = this.ctx.storage.sql
      .exec<AcceptedTurnRow>(
        `SELECT turns.turn_id, messages.message_id, messages.content AS message
         FROM turns
         INNER JOIN messages
           ON messages.session_id = turns.session_id
          AND messages.turn_id = turns.turn_id
          AND messages.role = 'user'
         WHERE turns.session_id = ? AND turns.turn_id = ?
         LIMIT 1`,
        sessionId,
        job.jobId.slice("turn:".length),
      )
      .toArray()[0];
    if (turn === undefined) {
      throw new Error("Bounded turn input is missing");
    }

    const configured = configuredTurn();
    if (configured === undefined) {
      throw new Error("Configured agent artifact is unavailable");
    }
    const runtimeEnvironment = this.env as EdenSessionEnvironment;
    const liveModel =
      runtimeEnvironment.AI !== undefined
        ? createWorkersAIModelAdapter({
            binding: runtimeEnvironment.AI,
            modelId: configured.agent.model,
            gatewayId: "eden-dev",
          })
        : undefined;
    const testModel =
      configured.generation.executionMode === "local"
        ? readConfiguredEdenTestModel()
        : undefined;
    const model = testModel ?? liveModel;
    if (model === undefined) {
      throw new Error("Configured model binding is unavailable");
    }

    await runBoundedTurn(this.ctx.storage, {
      sessionId,
      turnId: turn.turn_id,
      messageId: turn.message_id,
      message: turn.message,
      model,
      modelId: configured.agent.model,
      ...(configured.agent.options === undefined
        ? {}
        : { modelOptions: configured.agent.options }),
      systemPrompt: configured.instructions,
      toolName: configured.toolName,
      tool: configured.tool,
      toolInputSchema: configured.toolInputSchema,
      bundleIdentity: configured.bundleIdentity,
    });
  }
}

import { DurableObject } from "cloudflare:workers";
import type { SqlStorage } from "@cloudflare/workers-types";
import type {
  EdenSessionStatus,
  EdenVersionSet,
} from "@eden/definitions";

import {
  applySessionMigrations,
  SESSION_SCHEMA_TABLES,
} from "./session-schema.js";
import { sessionIdFromObjectName } from "./session-identity.js";

export interface EdenSessionEnvironment {
  readonly [key: string]: unknown;
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
}

interface MigrationRow {
  readonly [key: string]: string | number | null;
  readonly version: number;
  readonly name: string;
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

function versionResponse(row: SessionMetaRow): SessionMetaResponse {
  return {
    sessionId: row.session_id,
    ownerPrincipal: row.owner_principal,
    status: row.status,
    runtimeVersion: row.runtime_version,
    agentBundleVersion: row.agent_bundle_version,
    manifestVersion: row.manifest_version,
    protocolVersion: row.protocol_version,
    schemaVersion: row.schema_version,
  };
}

function readSessionMeta(sql: SqlStorage): SessionMetaRow | null {
  const rows = sql
    .exec<SessionMetaRow>(
      `SELECT session_id, owner_principal, status, runtime_version,
        agent_bundle_version, manifest_version, protocol_version, schema_version
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
    if (
      url.pathname === "/_eden/initialize" &&
      request.method === "POST"
    ) {
      return this.initialize(request);
    }
    return jsonResponse({ code: "not_found", message: "Not found" }, 404);
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
    return jsonResponse({
      sessionId,
      tables: readTables(sql),
      appliedMigrations: readMigrations(sql),
      sessionMeta: meta === null ? null : versionResponse(meta),
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
    const existing = readSessionMeta(sql);
    if (existing !== null) {
      if (
        existing.owner_principal !== input.ownerPrincipal ||
        existing.runtime_version !== input.versions.runtime ||
        existing.agent_bundle_version !== input.versions.agentBundle ||
        existing.manifest_version !== input.versions.manifest ||
        existing.protocol_version !== input.versions.protocol ||
        existing.schema_version !== input.versions.schema
      ) {
        return jsonResponse(
          { code: "session_initialization_conflict", message: "Session already initialized" },
          409,
        );
      }
      return jsonResponse({
        sessionId,
        status: existing.status,
        versions: {
          runtime: existing.runtime_version,
          agentBundle: existing.agent_bundle_version,
          manifest: existing.manifest_version,
          protocol: existing.protocol_version,
          schema: existing.schema_version,
        },
      });
    }

    const timestamp = new Date().toISOString();
    try {
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO session_meta (
            session_id, owner_principal, status, created_at, updated_at,
            runtime_version, agent_bundle_version, manifest_version,
            protocol_version, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionId,
          input.ownerPrincipal,
          "new",
          timestamp,
          timestamp,
          input.versions.runtime,
          input.versions.agentBundle,
          input.versions.manifest,
          input.versions.protocol,
          input.versions.schema,
        );
      });
    } catch (error) {
      if (readSessionMeta(sql) !== null) {
        return jsonResponse({
          sessionId,
          status: "new",
          versions: input.versions,
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
}

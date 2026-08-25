import { env } from "cloudflare:workers";
import {
  listDurableObjectIds,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { EDEN_VERSIONS } from "@moinulmoin/eden-definitions";
import {
  createOpaqueSessionId,
  createSessionObjectName,
} from "../src/session-identity.js";
import {
  applySessionMigrations,
  SESSION_SCHEMA_MIGRATIONS,
  SESSION_SCHEMA_VERSION,
} from "../src/session-schema.js";

interface SessionResponse {
  readonly sessionId: string;
  readonly status: string;
  readonly versions: typeof EDEN_VERSIONS;
}

interface SchemaResponse {
  readonly sessionId: string;
  readonly tables: readonly string[];
  readonly installedSchemaVersion: number;
  readonly appliedMigrations: readonly {
    readonly version: number;
    readonly name: string;
  }[];
  readonly sessionMeta: {
    readonly sessionId: string;
    readonly ownerPrincipal: string;
    readonly runtimeVersion: string;
    readonly agentBundleVersion: string;
    readonly manifestVersion: string;
    readonly protocolVersion: string;
    readonly schemaVersion: number;
    readonly artifactSchemaVersion: number;
  } | null;
}

function sessionStub(sessionId: string): DurableObjectStub {
  const name = createSessionObjectName(sessionId);
  return env.EDEN_SESSIONS.getByName(name);
}

async function initializeSession(
  stub: DurableObjectStub,
  sessionId: string,
  ownerPrincipal = "principal:test",
): Promise<Response> {
  return stub.fetch("https://session/_eden/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ownerPrincipal,
      versions: EDEN_VERSIONS,
    }),
  });
}

async function readSchema(stub: DurableObjectStub): Promise<SchemaResponse> {
  const response = await stub.fetch("https://session/_eden/schema");
  expect(response.status).toBe(200);
  return (await response.json()) as SchemaResponse;
}

describe("EdenSession SQLite foundation", () => {
  test("maps one opaque session to one named Durable Object and persists every domain", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);

    expect(sessionId).toMatch(/^sess_[a-zA-Z0-9_-]+$/u);
    expect(createSessionObjectName(sessionId)).not.toContain(
      "DurableObjectId",
    );
    expect(createSessionObjectName(sessionId)).toBe(
      createSessionObjectName(sessionId),
    );

    const initialize = await initializeSession(stub, sessionId);
    expect(initialize.status).toBe(201);
    expect(await initialize.json()).toEqual({
      sessionId,
      status: "new",
      versions: EDEN_VERSIONS,
    } satisfies SessionResponse);

    const schema = await readSchema(stub);
    expect(schema.sessionId).toBe(sessionId);
    expect(schema.installedSchemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(schema.sessionMeta).toMatchObject({
      sessionId,
      ownerPrincipal: "principal:test",
      runtimeVersion: EDEN_VERSIONS.runtime,
      agentBundleVersion: EDEN_VERSIONS.agentBundle,
      manifestVersion: EDEN_VERSIONS.manifest,
      protocolVersion: EDEN_VERSIONS.protocol,
      schemaVersion: SESSION_SCHEMA_VERSION,
      artifactSchemaVersion: EDEN_VERSIONS.schema,
    });
    expect(schema.tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "session_meta",
        "turns",
        "steps",
        "events",
        "messages",
        "projections",
        "effects",
        "jobs",
        "errors",
        "stream_chunks",
      ]),
    );
    expect(schema.appliedMigrations).toEqual(
      SESSION_SCHEMA_MIGRATIONS.map(({ version, name }) => ({
        version,
        name,
      })),
    );

    const ids = await listDurableObjectIds(env.EDEN_SESSIONS);
    expect(ids).toHaveLength(1);
    expect(ids[0]?.equals(env.EDEN_SESSIONS.idFromName(createSessionObjectName(sessionId)))).toBe(
      true,
    );
  });

  test("is idempotent across concurrent initialization and object eviction", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => initializeSession(stub, sessionId)),
    );
    await Promise.all(responses.map((response) => response.json()));
    expect(responses.map((response) => response.status)).toEqual(
      expect.arrayContaining([201, 200]),
    );
    expect(responses.every((response) => [200, 201].includes(response.status)))
      .toBe(true);

    const before = await readSchema(stub);
    expect(before.appliedMigrations).toHaveLength(
      SESSION_SCHEMA_MIGRATIONS.length,
    );
    expect(before.sessionMeta?.ownerPrincipal).toBe("principal:test");

    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(stub);

    const after = await readSchema(stub);
    expect(after.appliedMigrations).toEqual(before.appliedMigrations);
    expect(after.sessionMeta).toEqual(before.sessionMeta);
  }, 15_000);

  test("derives installed schema version from the migration ledger, not artifact metadata", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    const artifactVersions = {
      ...EDEN_VERSIONS,
      schema: 999,
    } as const;

    const initialize = await stub.fetch("https://session/_eden/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        ownerPrincipal: "principal:test",
        versions: artifactVersions,
      }),
    });
    expect(initialize.status).toBe(201);
    expect(await initialize.json()).toEqual({
      sessionId,
      status: "new",
      versions: artifactVersions,
    });

    const firstSchema = await readSchema(stub);
    expect(firstSchema.sessionMeta).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION,
      artifactSchemaVersion: artifactVersions.schema,
    });
    expect(firstSchema.appliedMigrations.at(-1)?.version).toBe(
      SESSION_SCHEMA_VERSION,
    );
    const durableVersions = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{
            readonly schema_version: number;
            readonly artifact_schema_version: number;
          }>(
            "SELECT schema_version, artifact_schema_version FROM session_meta",
          )
          .toArray(),
    );
    expect(durableVersions).toEqual([{
      schema_version: SESSION_SCHEMA_VERSION,
      artifact_schema_version: artifactVersions.schema,
    }]);

    const initializeAgain = await stub.fetch(
      "https://session/_eden/initialize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          ownerPrincipal: "principal:test",
          versions: artifactVersions,
        }),
      },
    );
    expect(initializeAgain.status).toBe(200);
    expect(await initializeAgain.json()).toEqual({
      sessionId,
      status: "new",
      versions: artifactVersions,
    });

    const artifactConflict = await stub.fetch(
      "https://session/_eden/initialize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          ownerPrincipal: "principal:test",
          versions: {
            ...artifactVersions,
            schema: artifactVersions.schema + 1,
          },
        }),
      },
    );
    expect(artifactConflict.status).toBe(409);
    await artifactConflict.arrayBuffer();

    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(stub);

    const afterEviction = await readSchema(stub);
    expect(afterEviction.sessionMeta).toMatchObject({
      schemaVersion: SESSION_SCHEMA_VERSION,
      artifactSchemaVersion: artifactVersions.schema,
    });
  }, 15_000);

  test("rolls back a failed additive migration without a partial schema", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    await expect(
      runInDurableObject(stub, async (_instance, state) => {
        await applySessionMigrations(state.storage, [
          {
            version: 99,
            name: "test-partial-migration",
            statements: [
              "CREATE TABLE partial_migration_probe (id INTEGER PRIMARY KEY)",
              "INSERT INTO table_that_does_not_exist (id) VALUES (1)",
            ],
          },
        ]);
      }),
    ).rejects.toThrow();

    const schema = await readSchema(stub);
    expect(schema.tables).not.toContain("partial_migration_probe");
    expect(schema.appliedMigrations).toEqual(
      SESSION_SCHEMA_MIGRATIONS.map(({ version, name }) => ({
        version,
        name,
      })),
    );
  });
});

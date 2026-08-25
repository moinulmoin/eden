import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { EDEN_VERSIONS } from "@moinulmoin/eden-definitions";
import {
  commitSessionTransaction,
} from "../src/session-journal.js";
import {
  commitCheckpointResult,
  createStableEffectIdempotencyKey,
  MAX_CHECKPOINT_ATTEMPTS,
  prepareCheckpointAttempt,
  reenterCheckpoint,
} from "../src/session-checkpoint.js";
import {
  readSessionRehydratedState,
} from "../src/session-state.js";
import {
  createOpaqueSessionId,
  createSessionObjectName,
} from "../src/session-identity.js";
import { SESSION_SCHEMA_VERSION } from "../src/session-schema.js";

function sessionStub(sessionId: string): DurableObjectStub {
  return env.EDEN_SESSIONS.getByName(createSessionObjectName(sessionId));
}

async function initializeSession(
  stub: DurableObjectStub,
  sessionId: string,
): Promise<void> {
  const response = await stub.fetch("https://session/_eden/initialize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ownerPrincipal: "principal:test",
      versions: EDEN_VERSIONS,
    }),
  });
  expect(response.status).toBe(201);
  await response.arrayBuffer();
}

const checkpointRequest = (sessionId: string) => ({
  sessionId,
  turnId: "turn_recovery",
  stepId: "step_recovery",
  logicalStep: "tool:lookup",
  phase: "model-tool" as const,
  effectId: "effect_recovery",
  callId: "call_recovery",
  toolName: "lookup",
  bundleIdentity: "bundle-digest-a",
  input: { value: "request" } as const,
  committedAt: "2026-08-10T00:00:01.000Z",
});

describe("EdenSession checkpoint recovery", () => {
  test("rehydrates every durable domain without recreating lifecycle events", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    const before = await runInDurableObject(stub, async (_instance, state) => {
      const timestamp = "2026-08-10T00:00:01.000Z";
      commitSessionTransaction(state.storage, sessionId, (journal) => {
        journal.insertTurn({
          turnId: "turn_rehydrated",
          status: "completed",
          acceptedAt: timestamp,
          startedAt: timestamp,
        });
        journal.insertStep({
          stepId: "step_rehydrated",
          turnId: "turn_rehydrated",
          logicalKey: "tool:lookup",
          phase: "model-tool",
          status: "completed",
          attemptCount: 2,
          resultRef: "effect_rehydrated",
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp,
        });
        journal.insertMessage({
          messageId: "msg_rehydrated",
          turnId: "turn_rehydrated",
          role: "assistant",
          content: "durable result",
          createdAt: timestamp,
          completedAt: timestamp,
        });
        journal.upsertProjection(
          "checkpoint",
          { stepId: "step_rehydrated", status: "completed" },
          timestamp,
        );
        journal.requestEffect({
          effectId: "effect_rehydrated",
          turnId: "turn_rehydrated",
          stepId: "step_rehydrated",
          callId: "call_rehydrated",
          toolName: "lookup",
          idempotencyKey: "test-coordinate-rehydrated",
          input: { value: "request" },
          createdAt: timestamp,
        });
        journal.completeEffect({
          effectId: "effect_rehydrated",
          output: { value: "result" },
          completedAt: timestamp,
        });
        journal.recordError({
          errorId: "error_rehydrated",
          turnId: "turn_rehydrated",
          stepId: "step_rehydrated",
          code: "recoverable",
          message: "safe durable error",
          retryable: true,
          createdAt: timestamp,
        });
        journal.setSessionStatus("waiting", timestamp);
        journal.appendEvent({
          type: "turn.completed",
          turnId: "turn_rehydrated",
          data: { turnId: "turn_rehydrated" },
          committedAt: timestamp,
        });
        state.storage.sql.exec(
          `INSERT INTO jobs (
            job_id, session_id, kind, status, due_at, attempts, max_attempts,
            last_error, recovery_action, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "job_rehydrated",
          sessionId,
          "checkpoint",
          "retryable",
          Date.now() + 60_000,
          1,
          3,
          "safe job error",
          "retry-checkpoint",
          timestamp,
          timestamp,
          null,
        );
      });
      return readSessionRehydratedState(state.storage.sql, sessionId);
    });
    const schemaBeforeEviction = await stub.fetch("https://session/_eden/schema");
    expect(schemaBeforeEviction.status).toBe(200);
    await schemaBeforeEviction.arrayBuffer();

    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(stub);

    const after = await runInDurableObject(stub, async (_instance, state) =>
      readSessionRehydratedState(state.storage.sql, sessionId),
    );

    expect(after).toEqual(before);
    expect(after.sessionMeta?.status).toBe("waiting");
    expect(after.sessionMeta?.versions.schema).toBe(EDEN_VERSIONS.schema);
    expect(after.sessionMeta?.sqliteSchemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(after.turns).toHaveLength(1);
    expect(after.steps[0]).toMatchObject({
      status: "completed",
      attemptCount: 2,
      resultRef: "effect_rehydrated",
    });
    expect(after.effects[0]).toMatchObject({
      status: "completed",
      output: { value: "result" },
    });
    expect(after.jobs[0]).toMatchObject({
      jobId: "job_rehydrated",
      status: "retryable",
    });
    expect(after.errors[0]).toMatchObject({
      errorId: "error_rehydrated",
      retryable: true,
    });

    const initializeAgain = await stub.fetch(
      "https://session/_eden/initialize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          ownerPrincipal: "principal:test",
          versions: EDEN_VERSIONS,
        }),
      },
    );
    expect(initializeAgain.status).toBe(200);

    const events = await stub.fetch(
      "https://session/_eden/events?startIndex=0",
    );
    const body = (await events.json()) as {
      readonly latestCursor: number;
      readonly events: readonly { readonly type: string }[];
    };
    expect(body.latestCursor).toBe(before.latestCursor);
    expect(body.events.filter(({ type }) => type === "session.started")).toHaveLength(1);
  }, 15_000);

  test("reuses completed effects, retries interrupted work, and rejects stale completion", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    await runInDurableObject(stub, async (_instance, state) =>
      commitSessionTransaction(state.storage, sessionId, (journal) => {
        journal.insertTurn({
          turnId: "turn_recovery",
          status: "running",
          acceptedAt: "2026-08-10T00:00:00.000Z",
          startedAt: "2026-08-10T00:00:00.000Z",
        });
      }),
    );

    const request = checkpointRequest(sessionId);
    const first = await runInDurableObject(stub, async (_instance, state) =>
      prepareCheckpointAttempt(state.storage, request),
    );
    expect(first).toMatchObject({ status: "execute", attemptCount: 1 });
    if (first.status !== "execute") {
      throw new Error("expected first checkpoint attempt to execute");
    }

    const second = await runInDurableObject(stub, async (_instance, state) =>
      prepareCheckpointAttempt(state.storage, request),
    );
    expect(second).toMatchObject({ status: "execute", attemptCount: 2 });
    if (second.status !== "execute") {
      throw new Error("expected second checkpoint attempt to execute");
    }

    expect(second.prepared.idempotencyKey).toBe(first.prepared.idempotencyKey);
    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(stub);

    const stale = await runInDurableObject(stub, async (_instance, state) =>
      commitCheckpointResult(state.storage, first.prepared, {
        value: "stale",
      }, "2026-08-10T00:00:02.000Z"),
    );
    expect(stale).toEqual({ status: "stale" });

    const committed = await runInDurableObject(stub, async (_instance, state) =>
      commitCheckpointResult(state.storage, second.prepared, {
        value: "current",
      }, "2026-08-10T00:00:03.000Z"),
    );
    expect(committed).toEqual({
      status: "committed",
      output: { value: "current" },
    });

    await evictDurableObject(stub);
    let replayInvocations = 0;
    const replayed = await runInDurableObject(stub, async (_instance, state) =>
      reenterCheckpoint(state.storage, request, async () => {
        replayInvocations += 1;
        return { value: "must-not-run" };
      }),
    );
    expect(replayed).toEqual({
      status: "replayed",
      output: { value: "current" },
    });
    expect(replayInvocations).toBe(0);

    const interruptedRequest = {
      ...request,
      stepId: "step_interrupted",
      logicalStep: "tool:lookup:interrupted",
      effectId: "effect_interrupted",
      callId: "call_interrupted",
    };
    let executions = 0;
    await expect(
      runInDurableObject(stub, async (_instance, state) =>
        reenterCheckpoint(state.storage, interruptedRequest, async () => {
          executions += 1;
          throw new Error("interrupted before result commit");
        }),
      ),
    ).rejects.toThrow("interrupted before result commit");

    const recovered = await runInDurableObject(stub, async (_instance, state) =>
      reenterCheckpoint(state.storage, interruptedRequest, async () => {
        executions += 1;
        return ["retried", 2] as const;
      }),
    );
    expect(recovered).toEqual({
      status: "committed",
      output: ["retried", 2],
    });
    expect(executions).toBe(2);

    const rows = await runInDurableObject(stub, async (_instance, state) => ({
      step: state.storage.sql
        .exec<{ status: string; attempt_count: number; result_ref: string | null }>(
          "SELECT status, attempt_count, result_ref FROM steps WHERE step_id = ?",
          "step_interrupted",
        )
        .toArray(),
      effect: state.storage.sql
        .exec<{ status: string; output_json: string | null }>(
          "SELECT status, output_json FROM effects WHERE effect_id = ?",
          "effect_interrupted",
        )
        .toArray(),
    }));
    expect(rows).toEqual({
      step: [{
        status: "completed",
        attempt_count: 2,
        result_ref: "effect_interrupted",
      }],
      effect: [{
        status: "completed",
        output_json: '["retried",2]',
      }],
    });

    const boundedRequest = {
      ...request,
      stepId: "step_bounded",
      logicalStep: "tool:lookup:bounded",
      effectId: "effect_bounded",
      callId: "call_bounded",
    };
    let boundedExecutions = 0;
    for (let attempt = 0; attempt < MAX_CHECKPOINT_ATTEMPTS; attempt += 1) {
      await expect(
        runInDurableObject(stub, async (_instance, state) =>
          reenterCheckpoint(state.storage, boundedRequest, async () => {
            boundedExecutions += 1;
            throw new Error("bounded interruption");
          }),
        ),
      ).rejects.toThrow("bounded interruption");
    }
    const exhausted = await runInDurableObject(stub, async (_instance, state) =>
      reenterCheckpoint(state.storage, boundedRequest, async () => {
        boundedExecutions += 1;
        return { phantom: true };
      }),
    );
    expect(exhausted).toEqual({
      status: "exhausted",
      attemptCount: MAX_CHECKPOINT_ATTEMPTS,
    });
    expect(boundedExecutions).toBe(MAX_CHECKPOINT_ATTEMPTS);
  });

  test("derives stable effect coordinates only from executable identity", () => {
    const base = {
      sessionId: "sess_00000000000000000000000000000000",
      turnId: "turn_01",
      logicalStep: "tool:lookup",
      callId: "call_01",
      toolName: "lookup",
      bundleIdentity: "bundle-digest-a",
    };

    const first = createStableEffectIdempotencyKey(base);
    const second = createStableEffectIdempotencyKey({
      ...base,
      attemptCount: 3,
      timestamp: "2026-08-10T00:00:00.000Z",
      credential: "sentinel-secret",
      binding: "sentinel-binding",
    } as typeof base & Record<string, unknown>);

    expect(second).toBe(first);
    expect(first).not.toContain("sentinel");
    expect(first).not.toContain("2026");
    expect(createStableEffectIdempotencyKey({
      ...base,
      bundleIdentity: "bundle-digest-b",
    })).not.toBe(first);
    expect(createStableEffectIdempotencyKey({
      ...base,
      logicalStep: "tool:other",
    })).not.toBe(first);
  });
});

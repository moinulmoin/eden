import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { EDEN_VERSIONS } from "@eden/definitions";
import {
  commitSessionTransaction,
  readJournalEvents,
} from "../src/session-journal.js";
import {
  createOpaqueSessionId,
  createSessionObjectName,
} from "../src/session-identity.js";

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
}

describe("EdenSession journal transactions", () => {
  test("commits lifecycle events with related rows and monotonic opaque cursors", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    const committed = await runInDurableObject(stub, async (_instance, state) =>
      commitSessionTransaction(state.storage, sessionId, (journal) => {
        const turnId = "turn_test_01";
        const stepId = "step_test_01";
        journal.insertTurn({
          turnId,
          status: "running",
          acceptedAt: "2026-08-10T00:00:00.000Z",
          startedAt: "2026-08-10T00:00:00.000Z",
        });
        journal.insertStep({
          stepId,
          turnId,
          logicalKey: "model-tool",
          phase: "model-tool",
          status: "running",
          attemptCount: 1,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        });
        journal.insertMessage({
          messageId: "msg_test_01",
          turnId,
          role: "user",
          content: "redacted test message",
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        journal.upsertProjection(
          "turn-status",
          { turnId, status: "running" },
          "2026-08-10T00:00:00.000Z",
        );
        journal.requestEffect({
          effectId: "effect_test_01",
          turnId,
          stepId,
          callId: "call_test_01",
          toolName: "lookup",
          idempotencyKey: "idem_test_01",
          input: { value: 1 },
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        return journal.appendEvent({
          type: "turn.started",
          turnId,
          data: { turnId },
          committedAt: "2026-08-10T00:00:00.000Z",
        });
      }),
    );

    expect(committed.streamIndex).toBe(2);
    expect(committed.eventId).toMatch(/^evt_[a-f0-9]{32}$/u);
    expect(committed.type).toBe("turn.started");

    const second = await runInDurableObject(stub, async (_instance, state) =>
      commitSessionTransaction(state.storage, sessionId, (journal) =>
        journal.appendEvent({
          type: "step.started",
          turnId: "turn_test_01",
          stepId: "step_test_01",
          data: { stepId: "step_test_01", phase: "model-tool" },
          committedAt: "2026-08-10T00:00:01.000Z",
        }),
      ),
    );

    expect(second.streamIndex).toBe(3);
    expect(second.eventId).not.toBe(committed.eventId);

    const events = await runInDurableObject(stub, async (_instance, state) =>
      readJournalEvents(state.storage.sql, sessionId, 0),
    );
    expect(events.map((event) => event.streamIndex)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.eventId)).toEqual([
      expect.stringMatching(/^evt_[a-f0-9]{32}$/u),
      committed.eventId,
      second.eventId,
    ]);

    const rows = await runInDurableObject(stub, async (_instance, state) => ({
      turn: state.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM turns WHERE turn_id = ?",
          "turn_test_01",
        )
        .toArray(),
      step: state.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM steps WHERE step_id = ?",
          "step_test_01",
        )
        .toArray(),
      message: state.storage.sql
        .exec<{ content: string }>(
          "SELECT content FROM messages WHERE message_id = ?",
          "msg_test_01",
        )
        .toArray(),
      projection: state.storage.sql
        .exec<{ projection_json: string }>(
          "SELECT projection_json FROM projections WHERE projection_key = ?",
          "turn-status",
        )
        .toArray(),
      effect: state.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM effects WHERE effect_id = ?",
          "effect_test_01",
        )
        .toArray(),
    }));

    expect(rows).toEqual({
      turn: [{ status: "running" }],
      step: [{ status: "running" }],
      message: [{ content: "redacted test message" }],
      projection: [{ projection_json: '{"turnId":"turn_test_01","status":"running"}' }],
      effect: [{ status: "requested" }],
    });

    const delivered = await stub.fetch(
      "https://session/_eden/events?startIndex=1",
    );
    expect(delivered.status).toBe(200);
    const deliveredBody = (await delivered.json()) as {
      readonly latestCursor: number;
      readonly events: readonly {
        readonly streamIndex: number;
        readonly eventId: string;
        readonly type: string;
        readonly data: unknown;
      }[];
    };
    expect(deliveredBody.latestCursor).toBe(3);
    expect(deliveredBody.events).toEqual([
      expect.objectContaining({
        streamIndex: 2,
        eventId: committed.eventId,
        type: committed.type,
        data: committed.data,
      }),
      expect.objectContaining({
        streamIndex: 3,
        eventId: second.eventId,
        type: second.type,
        data: second.data,
      }),
    ]);
  });

  test("rolls back related rows and events when a transition faults before commit", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    await expect(
      runInDurableObject(stub, async (_instance, state) =>
        commitSessionTransaction(state.storage, sessionId, (journal) => {
          journal.insertTurn({
            turnId: "turn_rollback",
            status: "accepted",
            acceptedAt: "2026-08-10T00:00:00.000Z",
          });
          journal.appendEvent({
            type: "turn.started",
            turnId: "turn_rollback",
            data: { turnId: "turn_rollback" },
            committedAt: "2026-08-10T00:00:00.000Z",
          });
          throw new Error("pre-commit fault");
        }),
      ),
    ).rejects.toThrow("pre-commit fault");

    const state = await runInDurableObject(stub, async (_instance, durableState) => ({
      turns: durableState.storage.sql
        .exec<{ turn_id: string }>(
          "SELECT turn_id FROM turns WHERE turn_id = ?",
          "turn_rollback",
        )
        .toArray(),
      events: durableState.storage.sql
        .exec<{ type: string }>(
          "SELECT type FROM events WHERE turn_id = ?",
          "turn_rollback",
        )
        .toArray(),
    }));

    expect(state).toEqual({ turns: [], events: [] });
  });

  test("replays the same committed event after a post-commit delivery fault", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    const committed = await runInDurableObject(stub, async (_instance, state) =>
      commitSessionTransaction(state.storage, sessionId, (journal) =>
        journal.appendEvent({
          type: "session.waiting",
          data: { status: "waiting" },
          committedAt: "2026-08-10T00:00:00.000Z",
        }),
      ),
    );

    let observedBeforeDeliveryFault:
      | readonly [number, string, string, unknown]
      | undefined;
    await expect(
      runInDurableObject(stub, async (_instance, state) => {
        const event = readJournalEvents(state.storage.sql, sessionId, 1)[0];
        if (event === undefined) {
          throw new Error("committed event was not readable");
        }
        observedBeforeDeliveryFault = [
          event.streamIndex,
          event.eventId,
          event.type,
          event.data,
        ];
        throw new Error("delivery fault");
      }),
    ).rejects.toThrow("delivery fault");

    const replayed = await runInDurableObject(stub, async (_instance, state) =>
      readJournalEvents(state.storage.sql, sessionId, 1),
    );
    expect(observedBeforeDeliveryFault).toEqual([
      committed.streamIndex,
      committed.eventId,
      committed.type,
      committed.data,
    ]);
    expect(replayed).toHaveLength(1);
    expect([
      replayed[0]?.streamIndex,
      replayed[0]?.eventId,
      replayed[0]?.type,
      replayed[0]?.data,
    ]).toEqual(observedBeforeDeliveryFault);
  });

  test("commits tool result before step advancement in one transaction", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    await runInDurableObject(stub, async (_instance, state) =>
      commitSessionTransaction(state.storage, sessionId, (journal) => {
        journal.insertTurn({
          turnId: "turn_effect",
          status: "running",
          acceptedAt: "2026-08-10T00:00:00.000Z",
        });
        journal.insertStep({
          stepId: "step_effect",
          turnId: "turn_effect",
          logicalKey: "tool:lookup",
          phase: "model-tool",
          status: "running",
          attemptCount: 1,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        });
        journal.requestEffect({
          effectId: "effect_result",
          turnId: "turn_effect",
          stepId: "step_effect",
          callId: "call_result",
          toolName: "lookup",
          idempotencyKey: "idem_result",
          input: { value: "input" },
          createdAt: "2026-08-10T00:00:00.000Z",
        });
        journal.appendEvent({
          type: "actions.requested",
          turnId: "turn_effect",
          stepId: "step_effect",
          data: {
            stepId: "step_effect",
            actions: [
              { callId: "call_result", toolName: "lookup", input: { value: "input" } },
            ],
          },
          committedAt: "2026-08-10T00:00:00.000Z",
        });
      }),
    );

    const resultEvent = await runInDurableObject(stub, async (_instance, state) =>
      commitSessionTransaction(state.storage, sessionId, (journal) => {
        journal.completeEffect({
          effectId: "effect_result",
          output: { value: "output" },
          completedAt: "2026-08-10T00:00:01.000Z",
        });
        journal.updateStep({
          stepId: "step_effect",
          status: "completed",
          resultRef: "effect_result",
          completedAt: "2026-08-10T00:00:01.000Z",
          updatedAt: "2026-08-10T00:00:01.000Z",
        });
        return journal.appendEvent({
          type: "action.result",
          turnId: "turn_effect",
          stepId: "step_effect",
          data: {
            stepId: "step_effect",
            callId: "call_result",
            toolName: "lookup",
            output: { value: "output" },
          },
          committedAt: "2026-08-10T00:00:01.000Z",
        });
      }),
    );

    const rows = await runInDurableObject(stub, async (_instance, state) => ({
      effect: state.storage.sql
        .exec<{ status: string; output_json: string | null }>(
          "SELECT status, output_json FROM effects WHERE effect_id = ?",
          "effect_result",
        )
        .toArray(),
      step: state.storage.sql
        .exec<{ status: string; result_ref: string | null }>(
          "SELECT status, result_ref FROM steps WHERE step_id = ?",
          "step_effect",
        )
        .toArray(),
    }));

    expect(resultEvent.type).toBe("action.result");
    expect(rows).toEqual({
      effect: [{ status: "completed", output_json: '{"value":"output"}' }],
      step: [{ status: "completed", result_ref: "effect_result" }],
    });
  });

  test("rejects cross-turn step linkage before effects, events, or errors mutate", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    await runInDurableObject(stub, async (_instance, state) =>
      commitSessionTransaction(state.storage, sessionId, (journal) => {
        const timestamp = "2026-08-10T00:00:00.000Z";
        journal.insertTurn({
          turnId: "turn_link_a",
          status: "running",
          acceptedAt: timestamp,
        });
        journal.insertTurn({
          turnId: "turn_link_b",
          status: "running",
          acceptedAt: timestamp,
        });
        journal.insertStep({
          stepId: "step_link_b",
          turnId: "turn_link_b",
          logicalKey: "tool:lookup",
          phase: "model-tool",
          status: "running",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }),
    );

    await expect(
      runInDurableObject(stub, async (_instance, state) =>
        commitSessionTransaction(state.storage, sessionId, (journal) =>
          journal.requestEffect({
            effectId: "effect_cross_turn",
            turnId: "turn_link_a",
            stepId: "step_link_b",
            callId: "call_cross_turn",
            toolName: "lookup",
            idempotencyKey: "idem_cross_turn",
            input: { value: "cross-turn" },
            createdAt: "2026-08-10T00:00:01.000Z",
          }),
        ),
      ),
    ).rejects.toThrow("Journal transition referenced a missing durable row");

    await expect(
      runInDurableObject(stub, async (_instance, state) =>
        commitSessionTransaction(state.storage, sessionId, (journal) =>
          journal.appendEvent({
            type: "step.started",
            turnId: "turn_link_a",
            stepId: "step_link_b",
            data: { stepId: "step_link_b", phase: "model-tool" },
            committedAt: "2026-08-10T00:00:02.000Z",
          }),
        ),
      ),
    ).rejects.toThrow("Journal transition referenced a missing durable row");

    await expect(
      runInDurableObject(stub, async (_instance, state) =>
        commitSessionTransaction(state.storage, sessionId, (journal) =>
          journal.recordError({
            errorId: "error_cross_turn",
            turnId: "turn_link_a",
            stepId: "step_link_b",
            code: "cross_turn",
            message: "cross-turn linkage",
            retryable: false,
            createdAt: "2026-08-10T00:00:03.000Z",
          }),
        ),
      ),
    ).rejects.toThrow("Journal transition referenced a missing durable row");

    const rows = await runInDurableObject(stub, async (_instance, state) => ({
      effects: state.storage.sql
        .exec<{ effect_id: string }>(
          "SELECT effect_id FROM effects WHERE effect_id = ?",
          "effect_cross_turn",
        )
        .toArray(),
      events: state.storage.sql
        .exec<{ type: string }>(
          "SELECT type FROM events WHERE turn_id = ? OR step_id = ?",
          "turn_link_a",
          "step_link_b",
        )
        .toArray(),
      errors: state.storage.sql
        .exec<{ error_id: string }>(
          "SELECT error_id FROM errors WHERE error_id = ?",
          "error_cross_turn",
        )
        .toArray(),
    }));

    expect(rows).toEqual({
      effects: [],
      events: [],
      errors: [],
    });
  });
});

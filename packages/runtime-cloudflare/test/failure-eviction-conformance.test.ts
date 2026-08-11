import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { createSessionObjectName } from "../src/session-identity.js";

const BEARER = "eden-unit-auth";
const DISCONNECT_CURSOR = 5;

type PublicEvent = {
  readonly streamIndex: number;
  readonly eventId: string;
  readonly type: string;
  readonly data?: Record<string, unknown>;
};

type DurableSnapshot = {
  readonly sessionStatus: string | undefined;
  readonly turnStatus: string | undefined;
  readonly steps: readonly {
    readonly step_id: string;
    readonly status: string;
    readonly attempt_count: number;
    readonly result_ref: string | null;
  }[];
  readonly effects: readonly {
    readonly effect_id: string;
    readonly status: string;
    readonly output_json: string | null;
  }[];
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly retryable: number;
  }[];
  readonly assistantMessages: readonly { readonly message_id: string }[];
  readonly durableRecords: readonly string[];
};

function authenticated(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${BEARER}`,
    },
  };
}

function streamRequest(
  sessionId: string,
  startIndex: number,
  follow: boolean,
): Request {
  return new Request(
    `https://eden/eden/v1/session/${sessionId}/stream?startIndex=${startIndex}&follow=${follow}`,
    authenticated(),
  );
}

async function readNdjson(response: Response): Promise<readonly PublicEvent[]> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PublicEvent);
}

async function createSession(): Promise<string> {
  const response = await SELF.fetch(
    new Request(
      "https://eden/eden/v1/session",
      authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { readonly sessionId: string };
  return body.sessionId;
}

async function acceptCommand(sessionId: string, message: string): Promise<void> {
  const response = await SELF.fetch(
    new Request(
      `https://eden/eden/v1/session/${sessionId}`,
      authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      }),
    ),
  );
  expect(response.status).toBe(202);
  await response.arrayBuffer();
}

async function readTestToolInvocationCount(sessionId: string): Promise<number> {
  const response = await SELF.fetch(
    new Request(
      `https://eden/__test/tool-invocations/${sessionId}`,
      authenticated(),
    ),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly count?: unknown };
  expect(body.count).toEqual(expect.any(Number));
  return body.count as number;
}

async function readDisconnectedPrefix(
  response: Response,
  cursor: number,
): Promise<readonly PublicEvent[]> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  if (reader === undefined) return [];

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  const events: PublicEvent[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        events.push(JSON.parse(line) as PublicEvent);
        if ((events.at(-1)?.streamIndex ?? 0) >= cursor) {
          return events.filter((event) => event.streamIndex <= cursor);
        }
      }
    }
    throw new Error("The public failure flow ended before the saved cursor.");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function readAfterCursor(
  sessionId: string,
  startIndex: number,
): Promise<readonly PublicEvent[]> {
  let cursor = startIndex;
  const events: PublicEvent[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await SELF.fetch(
      streamRequest(sessionId, cursor, false),
    );
    expect(response.status).toBe(200);
    const batch = await readNdjson(response);
    for (const event of batch) {
      expect(event.streamIndex).toBeGreaterThan(cursor);
      cursor = event.streamIndex;
      events.push(event);
    }
    if (
      events.at(-1)?.type === "session.failed" ||
      events.at(-1)?.type === "session.waiting"
    ) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The public failure flow did not reach a durable terminal state.");
}

async function readDurableSnapshot(sessionId: string): Promise<DurableSnapshot> {
  const stub = env.EDEN_SESSIONS.getByName(createSessionObjectName(sessionId));
  return runInDurableObject(stub, async (_instance, state) => ({
    sessionStatus: state.storage.sql
      .exec<{ readonly status: string }>(
        "SELECT status FROM session_meta WHERE session_id = ?",
        sessionId,
      )
      .toArray()[0]?.status,
    turnStatus: state.storage.sql
      .exec<{ readonly status: string }>(
        "SELECT status FROM turns WHERE session_id = ? ORDER BY accepted_at DESC LIMIT 1",
        sessionId,
      )
      .toArray()[0]?.status,
    steps: state.storage.sql
      .exec<DurableSnapshot["steps"][number]>(
        `SELECT step_id, status, attempt_count, result_ref
         FROM steps
         WHERE session_id = ?
         ORDER BY step_id`,
        sessionId,
      )
      .toArray(),
    effects: state.storage.sql
      .exec<DurableSnapshot["effects"][number]>(
        `SELECT effect_id, status, output_json
         FROM effects
         WHERE session_id = ?
         ORDER BY effect_id`,
        sessionId,
      )
      .toArray(),
    errors: state.storage.sql
      .exec<DurableSnapshot["errors"][number]>(
        "SELECT code, message, retryable FROM errors WHERE session_id = ? ORDER BY created_at, error_id",
        sessionId,
      )
      .toArray(),
    assistantMessages: state.storage.sql
      .exec<DurableSnapshot["assistantMessages"][number]>(
        "SELECT message_id FROM messages WHERE session_id = ? AND role = 'assistant'",
        sessionId,
      )
      .toArray(),
    durableRecords: [
      ...state.storage.sql
        .exec<{ readonly payload_json: string }>(
          "SELECT payload_json FROM events WHERE session_id = ? ORDER BY stream_index",
          sessionId,
        )
        .toArray()
        .map((row) => row.payload_json),
      ...state.storage.sql
        .exec<{
          readonly input_json: string;
          readonly output_json: string | null;
          readonly error_json: string | null;
        }>(
          `SELECT input_json, output_json, error_json
           FROM effects
           WHERE session_id = ?
           ORDER BY effect_id`,
          sessionId,
        )
        .toArray()
        .flatMap((row) => [
          row.input_json,
          row.output_json ?? "",
          row.error_json ?? "",
        ]),
      ...state.storage.sql
        .exec<{ readonly content: string }>(
          "SELECT content FROM messages WHERE session_id = ? ORDER BY message_id",
          sessionId,
        )
        .toArray()
        .map((row) => row.content),
      ...state.storage.sql
        .exec<{ readonly projection_json: string }>(
          "SELECT projection_json FROM projections WHERE session_id = ? ORDER BY projection_key",
          sessionId,
        )
        .toArray()
        .map((row) => row.projection_json),
      ...state.storage.sql
        .exec<{ readonly last_error: string | null }>(
          "SELECT last_error FROM jobs WHERE session_id = ? ORDER BY job_id",
          sessionId,
        )
        .toArray()
        .map((row) => row.last_error ?? ""),
      ...state.storage.sql
        .exec<{ readonly payload_json: string }>(
          "SELECT payload_json FROM stream_chunks WHERE session_id = ? ORDER BY stream_index",
          sessionId,
        )
        .toArray()
        .map((row) => row.payload_json),
      ...state.storage.sql
        .exec<{ readonly message: string }>(
          "SELECT message FROM errors WHERE session_id = ? ORDER BY created_at, error_id",
          sessionId,
        )
        .toArray()
        .map((row) => row.message),
    ],
  }));
}

async function runPublicScenario(
  message: string,
  options: { readonly waitForCompletedEffect?: boolean } = {},
): Promise<{
  readonly prefix: readonly PublicEvent[];
  readonly beforeEviction: readonly PublicEvent[];
  readonly resumed: readonly PublicEvent[];
  readonly fullAfterEviction: readonly PublicEvent[];
  readonly snapshot: DurableSnapshot;
  readonly invocationCounts: {
    readonly beforeDisconnect: number;
    readonly afterDisconnect: number;
    readonly afterEviction: number;
    readonly afterReconnect: number;
  };
}> {
  const sessionId = await createSession();
  await acceptCommand(sessionId, message);
  const invocationCountBeforeDisconnect = await readTestToolInvocationCount(sessionId);

  const initial = await SELF.fetch(
    streamRequest(sessionId, 0, true),
  );
  expect(initial.status).toBe(200);
  const prefix = await readDisconnectedPrefix(initial, DISCONNECT_CURSOR);
  expect(prefix.map((event) => event.streamIndex)).toEqual([1, 2, 3, 4, 5]);
  const invocationCountAfterDisconnect = await readTestToolInvocationCount(sessionId);

  const beforeEviction = options.waitForCompletedEffect
    ? await readAfterCursor(sessionId, DISCONNECT_CURSOR)
    : [];
  const stub = env.EDEN_SESSIONS.getByName(createSessionObjectName(sessionId));
  const { evictDurableObject } = await import("cloudflare:test");
  await evictDurableObject(stub);
  const invocationCountAfterEviction = await readTestToolInvocationCount(sessionId);

  const resumed = await readAfterCursor(sessionId, DISCONNECT_CURSOR);
  const invocationCountAfterReconnect = await readTestToolInvocationCount(sessionId);
  const replay = await readAfterCursor(sessionId, DISCONNECT_CURSOR);
  expect(replay).toEqual(resumed);

  const fullResponse = await SELF.fetch(
    streamRequest(sessionId, 0, false),
  );
  expect(fullResponse.status).toBe(200);
  const fullAfterEviction = await readNdjson(fullResponse);
  const snapshot = await readDurableSnapshot(sessionId);

  expect(fullAfterEviction).toEqual([
    ...prefix,
    ...resumed,
  ]);
  expect(JSON.stringify(fullAfterEviction)).not.toContain(message);

  return {
    prefix,
    beforeEviction,
    resumed,
    fullAfterEviction,
    snapshot,
    invocationCounts: {
      beforeDisconnect: invocationCountBeforeDisconnect,
      afterDisconnect: invocationCountAfterDisconnect,
      afterEviction: invocationCountAfterEviction,
      afterReconnect: invocationCountAfterReconnect,
    },
  };
}

describe("public deterministic failure and recovery conformance", () => {
  test("keeps invalid tool input failed after disconnect, eviction, and reconnect", async () => {
    const run = await runPublicScenario("conformance-invalid-input");

    expect(run.resumed.map((event) => event.type)).toEqual([
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    expect(run.fullAfterEviction.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    expect(run.fullAfterEviction.some((event) => event.type === "action.result")).toBe(
      false,
    );
    expect(run.fullAfterEviction.some((event) => event.type === "message.completed")).toBe(
      false,
    );
    expect(run.fullAfterEviction.some((event) => event.type === "turn.completed")).toBe(
      false,
    );
    expect(run.fullAfterEviction.some((event) => event.type === "session.waiting")).toBe(
      false,
    );
    expect(run.resumed.find((event) => event.type === "step.failed")?.data).toMatchObject({
      code: "tool_input_invalid",
      retryable: false,
    });
    expect(run.snapshot).toMatchObject({
      sessionStatus: "failed",
      turnStatus: "failed",
      steps: [
        {
          status: "failed",
          attempt_count: expect.any(Number),
          result_ref: null,
        },
      ],
      effects: [{ status: "failed", output_json: null }],
      assistantMessages: [],
    });
    expect(run.snapshot.steps[0]?.attempt_count).toBeGreaterThanOrEqual(1);
    expect(run.snapshot.steps[0]?.attempt_count).toBeLessThanOrEqual(3);
    expect(
      run.snapshot.errors.some(
        (error) => error.code === "tool_input_invalid" && error.retryable === 0,
      ),
    ).toBe(true);
  }, 15_000);

  test("keeps invalid tool invocation count at zero before and after eviction and reconnect", async () => {
    const run = await runPublicScenario("conformance-invalid-input");

    expect(run.invocationCounts).toEqual({
      beforeDisconnect: 0,
      afterDisconnect: 0,
      afterEviction: 0,
      afterReconnect: 0,
    });
  }, 15_000);

  test("keeps interrupted uncommitted work inspectably retryable after eviction", async () => {
    const run = await runPublicScenario("conformance-interrupted");

    expect(run.resumed.map((event) => event.type)).toEqual([
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    expect(run.fullAfterEviction.some((event) => event.type === "action.result")).toBe(
      false,
    );
    expect(run.fullAfterEviction.some((event) => event.type === "message.completed")).toBe(
      false,
    );
    expect(run.fullAfterEviction.some((event) => event.type === "turn.completed")).toBe(
      false,
    );
    expect(run.fullAfterEviction.some((event) => event.type === "session.waiting")).toBe(
      false,
    );
    expect(run.resumed.find((event) => event.type === "step.failed")?.data).toMatchObject({
      code: "tool_execution_failed",
      message: "Tool execution failed.",
      retryable: true,
    });
    expect(run.snapshot).toMatchObject({
      sessionStatus: "failed",
      turnStatus: "failed",
      steps: [
        {
          status: "retryable",
          attempt_count: expect.any(Number),
          result_ref: null,
        },
      ],
      effects: [{ status: "running", output_json: null }],
      assistantMessages: [],
    });
    expect(run.snapshot.steps[0]?.attempt_count).toBeGreaterThanOrEqual(1);
    expect(run.snapshot.steps[0]?.attempt_count).toBeLessThanOrEqual(3);
    expect(
      run.snapshot.errors.some(
        (error) =>
          error.code === "tool_execution_failed" &&
          error.message === "Tool execution failed." &&
          error.retryable === 1,
      ),
    ).toBe(true);
  }, 15_000);

  test("redacts deterministic interruption text from public events and durable state", async () => {
    const run = await runPublicScenario("conformance-interrupted");
    const serialized = JSON.stringify({
      events: run.fullAfterEviction,
      snapshot: run.snapshot,
    });

    expect(serialized).not.toContain("deterministic uncommitted interruption");
    expect(serialized).not.toContain("provider secret sentinel");
    expect(serialized).not.toContain("sentinel-binding");
    expect(run.snapshot.durableRecords.join("\n")).not.toContain(
      "deterministic uncommitted interruption",
    );
    expect(run.snapshot.durableRecords.join("\n")).not.toContain(
      "provider secret sentinel",
    );
    expect(run.snapshot.durableRecords.join("\n")).not.toContain(
      "sentinel-binding",
    );
    expect(
      run.snapshot.errors.some(
        (error) =>
          error.code === "tool_execution_failed" &&
          error.message === "Tool execution failed." &&
          error.retryable === 1,
      ),
    ).toBe(true);
  }, 15_000);

  test("replays a completed effect after eviction without another execution", async () => {
    const run = await runPublicScenario("conformance-completed-replay", {
      waitForCompletedEffect: true,
    });

    expect(run.beforeEviction.map((event) => event.type)).toEqual([
      "action.result",
      "step.completed",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(run.beforeEviction.find((event) => event.type === "action.result")?.data).toMatchObject({
      output: {
        query: "replay",
        executionCount: 1,
      },
    });
    expect(run.resumed.map((event) => event.type)).toEqual([
      "action.result",
      "step.completed",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(run.resumed).toEqual(run.beforeEviction);
    const actionResults = run.fullAfterEviction.filter(
      (event) => event.type === "action.result",
    );
    expect(actionResults).toHaveLength(1);
    expect(actionResults[0]?.data).toMatchObject({
      output: {
        query: "replay",
        executionCount: 1,
      },
    });
    expect(run.snapshot).toMatchObject({
      sessionStatus: "waiting",
      turnStatus: "completed",
      effects: [
        {
          status: "completed",
          output_json: expect.stringContaining('"executionCount":1'),
        },
      ],
      assistantMessages: [{ message_id: expect.any(String) }],
    });
    const modelToolStep = run.snapshot.steps.find((step) =>
      step.step_id.endsWith("_model_tool"),
    );
    const finalResponseStep = run.snapshot.steps.find((step) =>
      step.step_id.endsWith("_final_response"),
    );
    expect(modelToolStep).toMatchObject({
      status: "completed",
      attempt_count: expect.any(Number),
    });
    expect(modelToolStep?.attempt_count).toBeLessThanOrEqual(3);
    expect(finalResponseStep).toMatchObject({
      status: "completed",
      attempt_count: expect.any(Number),
    });
    expect(finalResponseStep?.attempt_count).toBeLessThanOrEqual(3);
  }, 15_000);
});

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  EDEN_VERSIONS,
  type EdenEvent,
  type EdenJsonValue,
  type EdenToolDefinition,
} from "@eden/definitions";
import {
  createModelAdapter,
  type EdenModelAdapter,
  type EdenModelCorrelation,
} from "../src/model-adapter.js";
import {
  createOpaqueSessionId,
  createSessionObjectName,
} from "../src/session-identity.js";
import { readJournalEvents } from "../src/session-journal.js";
import { runBoundedTurn } from "../src/turn-runner.js";

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

const toolInputSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "bounded-turn-fixture",
    validate(value: unknown) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        typeof (value as { readonly query?: unknown }).query !== "string"
      ) {
        return {
          issues: [{ message: "query must be a string", path: ["query"] }],
        };
      }
      return {
        value: {
          query: (value as { readonly query: string }).query.trim(),
        },
      };
    },
  },
} as const;

type ToolOutputFixture = {
  readonly label: string;
  readonly value: EdenJsonValue;
};

function fixtureTool(
  output: EdenJsonValue,
  onExecute: () => void,
): EdenToolDefinition<{ readonly query: string }> {
  return {
    description: "Return a deterministic fixture value.",
    inputSchema: toolInputSchema,
    execute(input, context) {
      onExecute();
      expect(input).toEqual({ query: "eden" });
      expect(Object.keys(context)).toEqual([
        "sessionId",
        "turnId",
        "callId",
        "toolName",
        "idempotencyKey",
        "signal",
      ]);
      return output;
    },
  };
}

function correlation(
  requestId: string,
  sessionId: string,
  turnId: string,
  stepId: string,
): EdenModelCorrelation {
  return { requestId, sessionId, turnId, stepId };
}

function deterministicAdapter(
  sessionId: string,
  turnId: string,
  output: EdenJsonValue,
  options: {
    readonly finalFailure?: boolean;
    readonly finalMultipart?: boolean;
    readonly invalidInput?: boolean;
    readonly firstFailure?: boolean;
  } = {},
): {
  readonly adapter: EdenModelAdapter;
  readonly calls: { readonly requestCount: () => number };
} {
  let requestCount = 0;
  const adapter = createModelAdapter(async (request) => {
    requestCount += 1;
    const stepId =
      requestCount === 1 ? "step_model_tool" : "step_final_response";
    const requestCorrelation = correlation(
      `request_${requestCount}`,
      sessionId,
      turnId,
      stepId,
    );

    if (options.firstFailure && requestCount === 1) {
      throw {
        message: "provider secret sentinel",
        statusCode: 503,
        binding: "sentinel-binding",
      };
    }
    if (options.finalFailure && requestCount === 2) {
      throw {
        message: "final provider secret sentinel",
        statusCode: 503,
        binding: "sentinel-binding",
      };
    }

    if (requestCount === 1) {
      return {
        toolCalls: [
          {
            toolCallId: "call_lookup",
            toolName: "lookup",
            input: options.invalidInput
              ? { query: 42 }
              : { query: " eden " },
          },
        ],
        finishReason: "tool-calls",
        correlation: requestCorrelation,
      };
    }

    const toolResult = request.messages
      .flatMap((message) =>
        typeof message.content === "string" ? [] : message.content,
      )
      .find((part) => part.type === "tool-result");
    expect(toolResult).toMatchObject({
      type: "tool-result",
      callId: "call_lookup",
      toolName: "lookup",
      output,
    });

    if (options.finalMultipart) {
      return {
        content: [
          { type: "text", text: "é".repeat(32 * 1024) },
          { type: "text", text: "b" },
        ],
        finishReason: "stop",
      };
    }

    return {
      text: `final:${JSON.stringify(output)}`,
      finishReason: "stop",
      correlation: requestCorrelation,
    };
  });

  return {
    adapter,
    calls: { requestCount: () => requestCount },
  };
}

async function runFixture(
  output: EdenJsonValue,
  options: {
    readonly finalFailure?: boolean;
    readonly finalMultipart?: boolean;
    readonly invalidInput?: boolean;
    readonly firstFailure?: boolean;
  } = {},
): Promise<{
  readonly sessionId: string;
  readonly turnId: string;
  readonly result: Awaited<ReturnType<typeof runBoundedTurn>>;
  readonly events: readonly EdenEvent[];
  readonly delivered: readonly EdenEvent[];
  readonly modelCalls: () => number;
  readonly toolExecutions: () => number;
}> {
  const sessionId = createOpaqueSessionId();
  const turnId = `turn_${sessionId.slice(-12)}`;
  const stub = sessionStub(sessionId);
  await initializeSession(stub, sessionId);

  let executions = 0;
  const model = deterministicAdapter(sessionId, turnId, output, options);
  const tool = fixtureTool(output, () => {
    executions += 1;
  });
  const delivered: EdenEvent[] = [];

  const result = await runInDurableObject(stub, async (_instance, state) =>
    runBoundedTurn(state.storage, {
      sessionId,
      turnId,
      messageId: `msg_${sessionId.slice(-12)}`,
      message: "Find the fixture answer.",
      toolName: "lookup",
      tool,
      model: model.adapter,
      toolInputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      bundleIdentity: "bundle-turn-fixture",
      onEvent(event) {
        delivered.push(event);
        if (event.type === "message.completed") {
          const row = state.storage.sql
            .exec<{ content: string; completed_at: string | null }>(
              "SELECT content, completed_at FROM messages WHERE message_id = ?",
              event.data.messageId,
            )
            .toArray()[0];
          expect(row).toMatchObject({
            content: event.data.content,
            completed_at: expect.any(String),
          });
        }
      },
    }),
  );

  const events = await runInDurableObject(stub, async (_instance, state) =>
    readJournalEvents(state.storage.sql, sessionId, 0),
  );

  return {
    sessionId,
    turnId,
    result,
    events,
    delivered,
    modelCalls: model.calls.requestCount,
    toolExecutions: () => executions,
  };
}

describe("Eden bounded turn runner", () => {
  test.each<ToolOutputFixture>([
    { label: "primitive", value: 7 },
    { label: "object", value: { answer: "object" } },
    { label: "array", value: ["array", 2] },
  ])(
    "normalizes, persists, and feeds $label tool output before waiting",
    async ({ value }) => {
      const run = await runFixture(value);

      expect(run.result).toEqual({
        status: "completed",
        sessionId: run.sessionId,
        turnId: run.turnId,
        messageId: `msg_assistant_${run.turnId}`,
        content: `final:${JSON.stringify(value)}`,
      });
      expect(run.events.map((event) => event.type)).toEqual([
        "session.started",
        "turn.started",
        "message.received",
        "step.started",
        "actions.requested",
        "action.result",
        "step.completed",
        "step.started",
        "message.completed",
        "step.completed",
        "turn.completed",
        "session.waiting",
      ]);
      expect(run.delivered.map((event) => event.type)).toEqual(
        run.events.map((event) => event.type).slice(1),
      );
      expect(run.events.find((event) => event.type === "action.result")).toMatchObject({
        data: { output: value },
      });
      expect(run.events.find((event) => event.type === "message.completed")).toMatchObject({
        data: { content: `final:${JSON.stringify(value)}` },
      });
      expect(run.result.status).toBe("completed");
      expect(run.modelCalls()).toBe(2);
      expect(run.toolExecutions()).toBe(1);
      expect(JSON.stringify(run.events)).not.toContain("sentinel");
    },
  );

  test("isolates throwing and rejected delivery callbacks from accepted execution", async () => {
    const sessionId = createOpaqueSessionId();
    const turnId = `turn_${sessionId.slice(-12)}`;
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    const model = createModelAdapter(async (request) => {
      if (request.messages.some((message) => message.role === "tool")) {
        return { text: "delivery-safe completion", finishReason: "stop" };
      }
      return {
        toolCalls: [
          {
            toolCallId: "call_lookup",
            toolName: "lookup",
            input: { query: "eden" },
          },
        ],
        finishReason: "tool-calls",
      };
    });
    const tool = fixtureTool({ answer: "delivery-safe" }, () => undefined);
    const delivered: EdenEvent[] = [];
    let throwOnce = true;

    const result = await runInDurableObject(stub, async (_instance, state) =>
      runBoundedTurn(state.storage, {
        sessionId,
        turnId,
        messageId: `msg_${sessionId.slice(-12)}`,
        message: "Continue after delivery failure.",
        toolName: "lookup",
        tool,
        model,
        toolInputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        bundleIdentity: "bundle-delivery-fixture",
        onEvent(event) {
          if (throwOnce) {
            throwOnce = false;
            throw new Error("transport secret sentinel");
          }
          if (event.type === "session.waiting") {
            return Promise.reject(new Error("rejected binding sentinel"));
          }
          delivered.push(event);
        },
      }),
    );

    expect(result).toEqual({
      status: "completed",
      sessionId,
      turnId,
      messageId: `msg_assistant_${turnId}`,
      content: "delivery-safe completion",
    });
    expect(delivered.at(-1)?.type).toBe("turn.completed");

    const durable = await runInDurableObject(stub, async (_instance, state) => ({
      status: state.storage.sql
        .exec<{ readonly status: string }>(
          "SELECT status FROM session_meta WHERE session_id = ?",
          sessionId,
        )
        .toArray()[0]?.status,
      events: readJournalEvents(state.storage.sql, sessionId, 0),
    }));

    expect(durable.status).toBe("waiting");
    expect(durable.events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "action.result",
      "step.completed",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(JSON.stringify(result)).not.toContain("sentinel");

    const savedCursor = delivered.at(-1)?.streamIndex ?? 0;
    const replayed = await runInDurableObject(stub, async (_instance, state) =>
      readJournalEvents(state.storage.sql, sessionId, savedCursor),
    );
    expect(replayed.map((event) => event.type)).toEqual(["session.waiting"]);
    expect(replayed[0]?.streamIndex).toBe(savedCursor + 1);
    expect(JSON.stringify(replayed)).not.toContain("sentinel");
  });

  test("rejects unsupported output before successful advancement", async () => {
    const unsupported = { answer: undefined } as unknown as EdenJsonValue;
    const run = await runFixture(unsupported);

    expect(run.result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_output_invalid",
        message: "Tool output was not JSON-compatible.",
        retryable: false,
      },
    });
    expect(run.modelCalls()).toBe(1);
    expect(run.toolExecutions()).toBe(1);
    expect(run.events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    expect(run.events.some((event) => event.type === "action.result")).toBe(false);
    expect(run.events.some((event) => event.type === "message.completed")).toBe(false);
    expect(JSON.stringify(run.events)).not.toContain("sentinel");
  });

  test("normalizes provider failure without exposing provider data", async () => {
    const run = await runFixture({ answer: "never" }, { firstFailure: true });

    expect(run.result).toMatchObject({
      status: "failed",
      error: {
        code: "model_call_failed",
        message: "Model call failed.",
        retryable: true,
      },
    });
    expect(run.modelCalls()).toBe(1);
    expect(run.toolExecutions()).toBe(0);
    expect(run.events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    expect(JSON.stringify(run.events)).not.toContain("sentinel");
    expect(JSON.stringify(run.result)).not.toContain("sentinel");
  });

  test("rejects aggregate final content before committing an assistant message", async () => {
    const run = await runFixture(
      { answer: "aggregate" },
      { finalMultipart: true },
    );

    expect(run.result).toMatchObject({
      status: "failed",
      error: {
        code: "final_response_invalid",
        message: "Final response was invalid.",
        retryable: false,
      },
    });
    expect(run.modelCalls()).toBe(2);
    expect(run.toolExecutions()).toBe(1);
    expect(run.events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "action.result",
      "step.completed",
      "step.started",
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    expect(run.events.some((event) => event.type === "message.completed")).toBe(
      false,
    );
    expect(run.events.some((event) => event.type === "turn.completed")).toBe(false);
    expect(run.events.some((event) => event.type === "session.waiting")).toBe(false);

    const assistantMessages = await runInDurableObject(
      sessionStub(run.sessionId),
      async (_instance, state) =>
        state.storage.sql
          .exec<{ readonly message_id: string }>(
            `SELECT message_id
             FROM messages
             WHERE session_id = ? AND turn_id = ? AND role = 'assistant'`,
            run.sessionId,
            run.turnId,
          )
          .toArray(),
    );
    expect(assistantMessages).toEqual([]);
  });

  test("durably records invalid input without invoking the tool", async () => {
    const run = await runFixture(
      { answer: "invalid" },
      { invalidInput: true },
    );

    expect(run.result).toMatchObject({
      status: "failed",
      error: {
        code: "tool_input_invalid",
        retryable: false,
      },
    });
    expect(run.modelCalls()).toBe(1);
    expect(run.toolExecutions()).toBe(0);
    expect(run.events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
  });

  test("bounds tool execution failures and retries the uncommitted effect", async () => {
    const sessionId = createOpaqueSessionId();
    const turnId = `turn_${sessionId.slice(-12)}`;
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    let toolExecutions = 0;
    let shouldFail = true;
    const model = createModelAdapter(async (request) => {
      if (request.messages.some((message) => message.role === "tool")) {
        return { text: "tool recovered", finishReason: "stop" };
      }
      return {
        toolCalls: [
          {
            toolCallId: "call_lookup",
            toolName: "lookup",
            input: { query: "eden" },
          },
        ],
        finishReason: "tool-calls",
      };
    });
    const tool = fixtureTool({ value: "tool result" }, () => {
      toolExecutions += 1;
      if (shouldFail) {
        shouldFail = false;
        throw new Error("tool secret sentinel");
      }
    });
    const request = {
      sessionId,
      turnId,
      messageId: `msg_${sessionId.slice(-12)}`,
      message: "Retry the tool.",
      toolName: "lookup",
      tool,
      model,
      toolInputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      bundleIdentity: "bundle-tool-retry-fixture",
    } as const;

    const first = await runInDurableObject(stub, async (_instance, state) =>
      runBoundedTurn(state.storage, request),
    );
    expect(first).toMatchObject({
      status: "failed",
      error: {
        code: "tool_execution_failed",
        message: "Tool execution failed.",
        retryable: true,
      },
    });
    expect(toolExecutions).toBe(1);

    const second = await runInDurableObject(stub, async (_instance, state) =>
      runBoundedTurn(state.storage, request),
    );
    expect(second).toMatchObject({
      status: "completed",
      content: "tool recovered",
    });
    expect(toolExecutions).toBe(2);

    const events = await runInDurableObject(stub, async (_instance, state) =>
      readJournalEvents(state.storage.sql, sessionId, 0),
    );
    expect(events.filter((event) => event.type === "action.result")).toHaveLength(1);
    expect(events.filter((event) => event.type === "message.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("tool secret sentinel");
  });

  test("bounds tool and final-response failures, then replays committed effects", async () => {
    const sessionId = createOpaqueSessionId();
    const turnId = `turn_${sessionId.slice(-12)}`;
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    let toolExecutions = 0;
    let finalAttempts = 0;
    const model = createModelAdapter(async (request) => {
      if (request.messages.some((message) => message.role === "tool")) {
        finalAttempts += 1;
        if (finalAttempts === 1) {
          throw {
            message: "final provider secret sentinel",
            statusCode: 503,
            binding: "sentinel-binding",
          };
        }
        return {
          text: "recovered final",
          finishReason: "stop",
        };
      }
      return {
        toolCalls: [
          {
            toolCallId: "call_lookup",
            toolName: "lookup",
            input: { query: "eden" },
          },
        ],
        finishReason: "tool-calls",
      };
    });
    const tool = fixtureTool({ value: "committed" }, () => {
      toolExecutions += 1;
    });
    const request = {
      sessionId,
      turnId,
      messageId: `msg_${sessionId.slice(-12)}`,
      message: "Retry the final response.",
      toolName: "lookup",
      tool,
      model,
      toolInputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      bundleIdentity: "bundle-retry-fixture",
    } as const;

    const first = await runInDurableObject(stub, async (_instance, state) =>
      runBoundedTurn(state.storage, request),
    );
    expect(first).toMatchObject({
      status: "failed",
      error: {
        code: "final_response_failed",
        message: "Final response generation failed.",
        retryable: true,
      },
    });
    expect(toolExecutions).toBe(1);

    const second = await runInDurableObject(stub, async (_instance, state) =>
      runBoundedTurn(state.storage, request),
    );
    expect(second).toMatchObject({
      status: "completed",
      content: "recovered final",
    });
    expect(toolExecutions).toBe(1);
    expect(finalAttempts).toBe(2);

    const events = await runInDurableObject(stub, async (_instance, state) =>
      readJournalEvents(state.storage.sql, sessionId, 0),
    );
    expect(events.filter((event) => event.type === "action.result")).toHaveLength(1);
    expect(events.filter((event) => event.type === "message.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("sentinel");
  });

  test("keeps checkpoint identities distinct across turns in one session", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);

    let toolExecutions = 0;
    const model = createModelAdapter(async (request) => {
      if (request.messages.some((message) => message.role === "tool")) {
        return { text: "turn complete", finishReason: "stop" };
      }
      return {
        toolCalls: [
          {
            toolCallId: "call_lookup",
            toolName: "lookup",
            input: { query: "eden" },
          },
        ],
        finishReason: "tool-calls",
      };
    });
    const tool = fixtureTool({ value: "same output" }, () => {
      toolExecutions += 1;
    });
    const baseRequest = {
      sessionId,
      message: "Run another turn.",
      toolName: "lookup",
      tool,
      model,
      toolInputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      bundleIdentity: "bundle-multi-turn-fixture",
    } as const;

    const first = await runInDurableObject(stub, async (_instance, state) =>
      runBoundedTurn(state.storage, {
        ...baseRequest,
        turnId: "turn_first",
        messageId: "msg_first_user",
      }),
    );
    const second = await runInDurableObject(stub, async (_instance, state) =>
      runBoundedTurn(state.storage, {
        ...baseRequest,
        turnId: "turn_second",
        messageId: "msg_second_user",
      }),
    );

    expect(first).toMatchObject({ status: "completed", content: "turn complete" });
    expect(second).toMatchObject({ status: "completed", content: "turn complete" });
    expect(toolExecutions).toBe(2);

    const rows = await runInDurableObject(stub, async (_instance, state) => ({
      turns: state.storage.sql
        .exec<{ readonly turn_id: string; readonly status: string }>(
          "SELECT turn_id, status FROM turns ORDER BY turn_id",
        )
        .toArray(),
      steps: state.storage.sql
        .exec<{ readonly step_id: string; readonly turn_id: string; readonly status: string }>(
          "SELECT step_id, turn_id, status FROM steps ORDER BY turn_id, step_id",
        )
        .toArray(),
      effects: state.storage.sql
        .exec<{ readonly effect_id: string; readonly turn_id: string; readonly status: string }>(
          "SELECT effect_id, turn_id, status FROM effects ORDER BY turn_id",
        )
        .toArray(),
    }));
    expect(rows.turns).toEqual([
      { turn_id: "turn_first", status: "completed" },
      { turn_id: "turn_second", status: "completed" },
    ]);
    expect(rows.steps).toHaveLength(4);
    expect(rows.effects).toEqual([
      { effect_id: "effect_turn_first_tool", turn_id: "turn_first", status: "completed" },
      { effect_id: "effect_turn_second_tool", turn_id: "turn_second", status: "completed" },
    ]);
  });
});

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  EDEN_VERSIONS,
  type EdenToolContext,
  type EdenToolDefinition,
} from "@eden/definitions";
import {
  commitSessionTransaction,
  readJournalEvents,
} from "../src/session-journal.js";
import { createOpaqueSessionId, createSessionObjectName } from "../src/session-identity.js";
import { executeTypedTool } from "../src/tool-harness.js";

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

async function insertTurn(
  stub: DurableObjectStub,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    commitSessionTransaction(state.storage, sessionId, (journal) => {
      journal.insertTurn({
        turnId,
        status: "running",
        acceptedAt: "2026-08-10T00:00:00.000Z",
        startedAt: "2026-08-10T00:00:00.000Z",
      });
    });
  });
}

function inputSchema(): EdenToolDefinition["inputSchema"] {
  return {
    "~standard": {
      version: 1,
      vendor: "tool-harness-fixture",
      validate(value: unknown) {
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          typeof (value as { readonly name?: unknown }).name !== "string"
        ) {
          return {
            issues: [{ message: "name must be a string", path: ["name"] }],
          };
        }
        return {
          value: {
            name: (value as { readonly name: string }).name.trim().toUpperCase(),
          },
        };
      },
    },
  };
}

describe("Eden typed tool harness", () => {
  test("validates and passes transformed input with only explicit Eden context", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);
    await insertTurn(stub, sessionId, "turn_harness_valid");

    let observedInput: unknown;
    let observedContext: EdenToolContext | undefined;
    const abortController = new AbortController();
    const tool: EdenToolDefinition<{ readonly name: string }> = {
      description: "Transform a name.",
      inputSchema: inputSchema(),
      execute(input, context) {
        observedInput = input;
        observedContext = context;
        return { greeting: `Hello ${input.name}` };
      },
    };

    const result = await runInDurableObject(stub, async (_instance, state) =>
      executeTypedTool(state.storage, {
        sessionId,
        turnId: "turn_harness_valid",
        stepId: "step_harness_valid",
        logicalStep: "tool:greet",
        phase: "model-tool",
        effectId: "effect_harness_valid",
        callId: "call_harness_valid",
        toolName: "greet",
        bundleIdentity: "bundle-harness",
        input: { name: "  eden  " },
        signal: abortController.signal,
        tool,
      }),
    );

    expect(result).toMatchObject({
      status: "committed",
      output: { greeting: "Hello EDEN" },
    });
    expect(observedInput).toEqual({ name: "EDEN" });
    expect(observedContext).toBeDefined();
    expect(Object.keys(observedContext ?? {})).toEqual([
      "sessionId",
      "turnId",
      "callId",
      "toolName",
      "idempotencyKey",
      "signal",
    ]);
    expect(observedContext).toMatchObject({
      sessionId,
      turnId: "turn_harness_valid",
      callId: "call_harness_valid",
      toolName: "greet",
      idempotencyKey: expect.stringContaining("eden-effect-v1"),
      signal: abortController.signal,
    });
    expect(JSON.stringify(observedContext)).not.toContain("binding");
    expect(JSON.stringify(observedContext)).not.toContain("credential");
  });

  test("durably fails invalid input without invoking the tool", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = sessionStub(sessionId);
    await initializeSession(stub, sessionId);
    await insertTurn(stub, sessionId, "turn_harness_invalid");

    let executions = 0;
    const tool: EdenToolDefinition<{ readonly name: string }> = {
      description: "Reject invalid input.",
      inputSchema: inputSchema(),
      execute() {
        executions += 1;
        return { shouldNot: "run" };
      },
    };

    const result = await runInDurableObject(stub, async (_instance, state) =>
      executeTypedTool(state.storage, {
        sessionId,
        turnId: "turn_harness_invalid",
        stepId: "step_harness_invalid",
        logicalStep: "tool:greet",
        phase: "model-tool",
        effectId: "effect_harness_invalid",
        callId: "call_harness_invalid",
        toolName: "greet",
        bundleIdentity: "bundle-harness",
        input: { name: 42 },
        tool,
      }),
    );

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "tool_input_invalid",
        message: "Tool input failed schema validation.",
        retryable: false,
      },
      idempotencyKey: expect.stringContaining("eden-effect-v1"),
      attemptCount: 1,
    });
    expect(executions).toBe(0);

    const durable = await runInDurableObject(stub, async (_instance, state) => ({
      step: state.storage.sql
        .exec<{ status: string; error_id: string | null }>(
          "SELECT status, error_id FROM steps WHERE step_id = ?",
          "step_harness_invalid",
        )
        .toArray(),
      effect: state.storage.sql
        .exec<{ status: string; error_json: string | null }>(
          "SELECT status, error_json FROM effects WHERE effect_id = ?",
          "effect_harness_invalid",
        )
        .toArray(),
      events: readJournalEvents(state.storage.sql, sessionId, 0).map((event) => ({
        type: event.type,
        data: event.data,
      })),
    }));

    expect(durable.step).toEqual([
      { status: "failed", error_id: "err_tool_input_step_harness_invalid" },
    ]);
    expect(durable.effect).toEqual([
      {
        status: "failed",
        error_json: '{"code":"tool_input_invalid","message":"Tool input failed schema validation.","retryable":false}',
      },
    ]);
    expect(durable.events).toEqual([
      expect.objectContaining({ type: "session.started" }),
      expect.objectContaining({ type: "actions.requested" }),
      expect.objectContaining({
        type: "step.failed",
        data: {
          stepId: "step_harness_invalid",
          code: "tool_input_invalid",
          message: "Tool input failed schema validation.",
          retryable: false,
        },
      }),
    ]);
  });
});

import { describe, expect, test } from "vitest";

import {
  createModelAdapter,
  normalizeEdenJsonValue,
  normalizeModelFailure,
  normalizeModelMessages,
  type EdenModelRequest,
} from "../src/model-adapter.js";
import { createWorkersAIModelAdapter } from "../src/model-adapter-internal.js";

const correlation = {
  requestId: "req_fixture_01",
  sessionId: "sess_00000000000000000000000000000000",
  turnId: "turn_fixture_01",
  stepId: "step_fixture_01",
} as const;

const request: EdenModelRequest = {
  correlation,
  messages: [
    { role: "system", content: "Use the lookup tool." },
    { role: "user", content: "Find the answer." },
  ],
  tools: [
    {
      name: "lookup",
      description: "Look up a value.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: "required",
  signal: new AbortController().signal,
};

describe("Eden model adapter", () => {
  test("accepts shared JSON branches while rejecting true cycles", () => {
    const shared = { value: "shared" };
    const sharedBranches = {
      left: shared,
      right: [shared],
    };

    expect(normalizeEdenJsonValue(sharedBranches)).toEqual({
      left: { value: "shared" },
      right: [{ value: "shared" }],
    });

    const sharedArray = ["shared", { value: 2 }];
    expect(
      normalizeEdenJsonValue({
        left: sharedArray,
        right: { nested: sharedArray },
      }),
    ).toEqual({
      left: ["shared", { value: 2 }],
      right: { nested: ["shared", { value: 2 }] },
    });

    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    expect(normalizeEdenJsonValue(cyclicObject)).toBeUndefined();

    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(normalizeEdenJsonValue(cyclicArray)).toBeUndefined();
  });

  test("normalizes provider-shaped messages, tool calls, results, and safe correlation", async () => {
    const adapter = createModelAdapter(async (providerRequest) => {
      expect(providerRequest).toEqual({
        messages: [
          { role: "system", content: "Use the lookup tool." },
          { role: "user", content: "Find the answer." },
        ],
        tools: [
          {
            name: "lookup",
            description: "Look up a value.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
        toolChoice: "required",
        signal: request.signal,
      });

      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "call_fixture_01",
            toolName: "lookup",
            input: '{"query":"eden"}',
          },
        ],
        toolCalls: [
          {
            toolCallId: "call_fixture_01",
            toolName: "lookup",
            input: '{"query":"eden"}',
          },
        ],
        toolResults: [
          {
            toolCallId: "call_fixture_01",
            toolName: "lookup",
            output: {
              type: "json",
              value: { answer: "deterministic" },
            },
          },
        ],
        finishReason: { unified: "tool-calls", raw: "provider-secret" },
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
        },
        response: {
          id: "provider-secret-response-id",
          headers: { authorization: "sentinel-secret" },
        },
        providerMetadata: {
          workersai: { rawBinding: "sentinel-binding" },
        },
      };
    });

    const outcome = await adapter.call(request);

    expect(outcome).toEqual({
      status: "ok",
      result: {
        text: "",
        calls: [
          {
            callId: "call_fixture_01",
            toolName: "lookup",
            input: { query: "eden" },
          },
        ],
        results: [
          {
            callId: "call_fixture_01",
            toolName: "lookup",
            output: { answer: "deterministic" },
          },
        ],
        finishReason: "tool-calls",
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
        },
        correlation,
      },
    });

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("sentinel-secret");
    expect(serialized).not.toContain("sentinel-binding");
    expect(serialized).not.toContain("workersai");
  });

  test("normalizes provider-shaped message parts without preserving provider metadata", () => {
    expect(
      normalizeModelMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will look." },
            {
              type: "tool-call",
              toolCallId: "call_message_01",
              toolName: "lookup",
              input: { query: "eden" },
              providerOptions: { workersai: { secret: "sentinel-secret" } },
            },
          ],
          providerOptions: { workersai: { binding: "sentinel-binding" } },
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_message_01",
              toolName: "lookup",
              output: { type: "json", value: { answer: "deterministic" } },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will look." },
          {
            type: "tool-call",
            callId: "call_message_01",
            toolName: "lookup",
            input: { query: "eden" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            callId: "call_message_01",
            toolName: "lookup",
            output: { answer: "deterministic" },
          },
        ],
      },
    ]);
  });

  test("rejects multipart model text whose joined UTF-8 content exceeds the bound", async () => {
    const firstPart = "é".repeat(32 * 1024);
    const secondPart = "b";
    const adapter = createModelAdapter(async () => ({
      content: [
        { type: "text", text: firstPart },
        { type: "text", text: secondPart },
      ],
      finishReason: "stop",
    }));

    await expect(
      adapter.call({
        ...request,
        tools: undefined,
        toolChoice: undefined,
      }),
    ).resolves.toEqual({
      status: "error",
      error: {
        code: "model_result_invalid",
        message: "Model result was invalid.",
        retryable: false,
        correlation,
      },
    });
  });

  test("normalizes in-bound multipart model text without provider metadata", async () => {
    const adapter = createModelAdapter(async () => ({
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "from Eden." },
      ],
      finishReason: "stop",
      providerMetadata: {
        workersai: { binding: "sentinel-binding" },
      },
    }));

    await expect(
      adapter.call({
        ...request,
        tools: undefined,
        toolChoice: undefined,
      }),
    ).resolves.toEqual({
      status: "ok",
      result: {
        text: "Hello from Eden.",
        calls: [],
        results: [],
        finishReason: "stop",
        correlation,
      },
    });
  });

  test("returns bounded Eden failures for provider-shaped failures and invalid results", async () => {
    const failed = normalizeModelFailure(
      {
        name: "ProviderSpecificError",
        message: "provider secret sentinel-secret",
        statusCode: 503,
        responseBody: "binding sentinel-binding",
      },
      correlation,
    );
    expect(failed).toEqual({
      code: "model_call_failed",
      message: "Model call failed.",
      retryable: true,
      correlation,
    });

    const failedAdapter = createModelAdapter(async () => {
      throw {
        message: "provider secret sentinel-secret",
        statusCode: 503,
        responseBody: "binding sentinel-binding",
      };
    });
    await expect(failedAdapter.call(request)).resolves.toEqual({
      status: "error",
      error: failed,
    });

    const invalidAdapter = createModelAdapter(async () => ({
      text: "not valid",
      toolCalls: [
        {
          toolCallId: "call_invalid",
          toolName: "lookup",
          input: undefined,
        },
      ],
    }));
    await expect(
      invalidAdapter.call({
        ...request,
        tools: undefined,
        toolChoice: undefined,
      }),
    ).resolves.toEqual({
      status: "error",
      error: {
        code: "model_result_invalid",
        message: "Model result was invalid.",
        retryable: false,
        correlation,
      },
    });
  });

  test("keeps Workers AI, gateway, and AI SDK wiring behind the internal adapter", async () => {
    const runs: unknown[] = [];
    const adapter = createWorkersAIModelAdapter({
      binding: {
        run: async (...args: unknown[]) => {
          runs.push(args);
          return {
            choices: [
              {
                message: { role: "assistant", content: "fixture response" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
            },
          };
        },
      },
      modelId: "@cf/zai-org/glm-4.7-flash",
      gatewayId: "eden-dev",
    });

    const outcome = await adapter.call({
      correlation,
      messages: [{ role: "user", content: "fixture prompt" }],
      options: { thinking: false, maxOutputTokens: 32 },
    });

    expect(outcome).toEqual({
      status: "ok",
      result: {
        text: "fixture response",
        calls: [],
        results: [],
        finishReason: "stop",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
        },
        correlation,
      },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual([
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [{ role: "user", content: "fixture prompt" }],
        max_tokens: 32,
        reasoning_effort: null,
      },
      expect.objectContaining({
        gateway: { id: "eden-dev" },
      }),
    ]);
    expect(JSON.stringify(outcome)).not.toContain("eden-dev");
  });

  test("maps typed tool requests and binding tool calls", async () => {
    const runs: unknown[] = [];
    const adapter = createWorkersAIModelAdapter({
      binding: {
        run: async (...args: unknown[]) => {
          runs.push(args);
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_lookup_01",
                      type: "function",
                      function: {
                        name: "lookup",
                        arguments: '{"query":"eden"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          };
        },
      },
      modelId: "@cf/zai-org/glm-4.7-flash",
      gatewayId: "eden-dev",
    });

    const outcome = await adapter.call(request);

    expect(outcome).toEqual({
      status: "ok",
      result: {
        text: "",
        calls: [
          {
            callId: "call_lookup_01",
            toolName: "lookup",
            input: { query: "eden" },
          },
        ],
        results: [],
        finishReason: "tool-calls",
        correlation,
      },
    });
    expect(runs[0]).toEqual([
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          { role: "system", content: "Use the lookup tool." },
          { role: "user", content: "Find the answer." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value.",
              parameters: request.tools?.[0]?.inputSchema,
            },
          },
        ],
        tool_choice: "required",
      },
      expect.objectContaining({
        gateway: { id: "eden-dev" },
        signal: request.signal,
      }),
    ]);
  });
});

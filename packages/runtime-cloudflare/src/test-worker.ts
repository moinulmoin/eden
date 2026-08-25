import type {
  EdenJsonValue,
  EdenToolDefinition,
} from "@moinulmoin/eden-definitions";
import { EdenSession } from "./session.js";
import { handleEdenRequest, type EdenWorkerEnvironment } from "./http-host.js";
import {
  createModelAdapter,
  type EdenModelAdapter,
} from "./model-adapter.js";
import "./model-adapter-internal.js";
import { configureEdenTestModel } from "./test-execution.js";
import {
  configureEdenArtifact,
  readConfiguredEdenArtifact,
} from "./artifact-runtime.js";
import { isOpaqueSessionId } from "./session-identity.js";

export { EdenSession };
export {
  readConfiguredEdenArtifact,
} from "./artifact-runtime.js";
export { configureEdenArtifact };

const TEST_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies EdenJsonValue;

const TEST_TOOL_STANDARD_SCHEMA = {
  "~standard": {
    version: 1 as const,
    vendor: "eden-test-configured-artifact",
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

const testToolExecutionCounts = new Map<string, number>();
const testToolInvocationCounts = new Map<string, number>();
const TEST_INVOCATION_PATH = "/__test/tool-invocations/";

function testJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function readTestBearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return undefined;
  const value = header.slice("Bearer ".length);
  return value.length === 0 || value.includes(" ") ? undefined : value;
}

function constantTimeTestBearerEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function testInvocationResponse(
  request: Request,
  env: EdenWorkerEnvironment,
): Response | undefined {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(TEST_INVOCATION_PATH)) return undefined;
  if (request.method !== "GET") {
    return testJsonResponse(
      { code: "not_found", message: "Resource was not found." },
      404,
    );
  }
  const bearer = readTestBearer(request);
  if (
    env.EDEN_BEARER_SECRET === undefined ||
    bearer === undefined ||
    !constantTimeTestBearerEqual(bearer, env.EDEN_BEARER_SECRET)
  ) {
    return testJsonResponse(
      { code: "unauthorized", message: "Authorization is required." },
      401,
    );
  }
  const sessionId = url.pathname.slice(TEST_INVOCATION_PATH.length);
  if (!isOpaqueSessionId(sessionId) || sessionId.includes("/")) {
    return testJsonResponse(
      { code: "not_found", message: "Resource was not found." },
      404,
    );
  }
  return testJsonResponse({
    sessionId,
    count: testToolInvocationCounts.get(sessionId) ?? 0,
  });
}

const TEST_TOOL: EdenToolDefinition<
  { readonly query: string },
  { readonly source: string; readonly query: string; readonly executionCount?: number }
> = {
  description: "Return the configured test-worker artifact result.",
  inputSchema: TEST_TOOL_STANDARD_SCHEMA,
  execute(input, context) {
    testToolInvocationCounts.set(
      context.sessionId,
      (testToolInvocationCounts.get(context.sessionId) ?? 0) + 1,
    );
    if (input.query === "interrupted") {
      throw new Error(
        "deterministic uncommitted interruption: provider secret sentinel binding sentinel-binding",
      );
    }
    const executionCount =
      input.query === "replay"
        ? (testToolExecutionCounts.get(context.idempotencyKey) ?? 0) + 1
        : undefined;
    if (executionCount !== undefined) {
      testToolExecutionCounts.set(context.idempotencyKey, executionCount);
    }
    return {
      source: "test-worker-configured-artifact",
      query: input.query,
      ...(executionCount === undefined ? {} : { executionCount }),
    };
  },
};

// This deterministic model is injected only by the Workers test entrypoint.
// Remote generated wrappers select the Workers AI adapter instead.
const TEST_MODEL: EdenModelAdapter = createModelAdapter(async (request) => {
  const configured = readConfiguredEdenArtifact();
  const toolName = configured?.generation.toolNames[0];
  const tool =
    toolName === undefined
      ? undefined
      : configured?.artifact.tools[toolName];
  const toolInputSchema =
    toolName === undefined
      ? undefined
      : configured?.artifact.toolSchemas[toolName];

  if (request.messages.some((message) => message.role === "tool")) {
    const toolResult = request.messages
      .flatMap((message) =>
        typeof message.content === "string" ? [] : message.content,
      )
      .find((part) => part.type === "tool-result");
    if (
      toolResult?.type !== "tool-result" ||
      toolName === undefined ||
      toolResult.toolName !== toolName ||
      toolResult.output === undefined
    ) {
      throw new Error("Configured test artifact result was not provided");
    }
    return {
      text: "configured-artifact-final-response: ✓",
      finishReason: "stop",
    };
  }

  const requestedTool = request.tools?.[0];
  if (
    configured === undefined ||
    request.messages[0]?.role !== "system" ||
    request.messages[0]?.content !== configured.artifact.instructions ||
    request.modelId !== configured.artifact.agent.model ||
    request.options?.thinking !== configured.artifact.agent.options?.thinking ||
    request.options?.maxOutputTokens !==
      configured.artifact.agent.options?.maxOutputTokens ||
    toolName === undefined ||
    tool === undefined ||
    requestedTool?.name !== toolName ||
    requestedTool.description !== tool.description ||
    JSON.stringify(requestedTool.inputSchema) !== JSON.stringify(toolInputSchema)
  ) {
    throw new Error("Configured artifact did not reach the bounded model runner");
  }
  return {
    toolCalls: [
      {
        toolCallId: `call_${toolName}`,
        toolName,
        input:
          toolName === "greet"
            ? { name: " Eden " }
            : request.messages.some(
                (message) =>
                  message.role === "user" &&
                  typeof message.content === "string" &&
                  message.content.includes("invalid"),
              )
              ? { query: 42 }
              : request.messages.some(
                    (message) =>
                      message.role === "user" &&
                      typeof message.content === "string" &&
                      message.content.includes("interrupted"),
                  )
                ? { query: " interrupted " }
                : request.messages.some(
                      (message) =>
                        message.role === "user" &&
                        typeof message.content === "string" &&
                        message.content.includes("completed-replay"),
                    )
                  ? { query: " replay " }
                  : { query: " eden " },
      },
    ],
    finishReason: "tool-calls",
  };
});

const TEST_ARTIFACT = Object.freeze({
  agent: Object.freeze({
    model: "test/configured-model",
    options: Object.freeze({
      maxOutputTokens: 321,
      thinking: false,
    }),
  }),
  instructions: "Configured test-worker instructions.\n",
  tools: Object.freeze({
    configured_lookup: TEST_TOOL as unknown as EdenToolDefinition,
  }),
  toolSchemas: Object.freeze({
    configured_lookup: TEST_TOOL_INPUT_SCHEMA,
  }),
});

configureEdenArtifact(TEST_ARTIFACT, {
  generationId: "configured-test-generation",
  bundleDigest: "configured-test-bundle",
  manifestVersion: "configured-test-manifest",
  runtimeVersion: "configured-test-runtime",
  agentBundleVersion: "configured-test-agent-bundle",
  protocolVersion: "configured-test-protocol",
  schemaVersion: 1,
  toolNames: ["configured_lookup"],
  executionMode: "local",
});
configureEdenTestModel(TEST_MODEL);

export default {
  fetch(
    request: Request,
    env: EdenWorkerEnvironment,
  ): Promise<Response> {
    const testInvocation = testInvocationResponse(request, env);
    if (testInvocation !== undefined) return Promise.resolve(testInvocation);
    return handleEdenRequest(request, env);
  },
};

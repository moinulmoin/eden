import { generateText, jsonSchema } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import {
  createModelAdapter,
  type EdenModelAdapter,
  type EdenModelAdapterCall,
} from "./model-adapter.js";
import type {
  EdenModelAdapterRequest,
  EdenModelMessage,
  EdenModelMessagePart,
  EdenModelToolDefinition,
} from "./model-contracts.js";

interface InternalWorkersAIOptions {
  readonly binding: unknown;
  readonly modelId: string;
  readonly gatewayId: string;
}

type InternalWorkersAIProvider = {
  readonly call: EdenModelAdapterCall;
};

type InternalGenerateText = (options: Record<string, unknown>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerMessagePart(
  part: EdenModelMessagePart,
): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.callId,
        toolName: part.toolName,
        input: part.input,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: part.callId,
        toolName: part.toolName,
        output: { type: "json", value: part.output },
      };
  }
}

function providerMessage(message: EdenModelMessage): Record<string, unknown> {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map(providerMessagePart),
  };
}

function providerTools(
  tools: readonly EdenModelToolDefinition[] | undefined,
): Record<string, unknown> | undefined {
  if (tools === undefined) return undefined;
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema(
          (isRecord(tool.inputSchema)
            ? tool.inputSchema
            : { type: "object", properties: {} }) as Record<string, unknown>,
        ),
      },
    ]),
  );
}

function toProviderOptions(
  options: InternalWorkersAIOptions,
  request: EdenModelAdapterRequest,
): Record<string, unknown> {
  const modelId = request.modelId ?? options.modelId;
  const generationOptions = request.options;
  const tools = providerTools(request.tools);
  return {
    modelId,
    ...(generationOptions?.temperature === undefined
      ? {}
      : { temperature: generationOptions.temperature }),
    ...(generationOptions?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: generationOptions.maxOutputTokens }),
    ...(generationOptions?.thinking === false ? { reasoning: "none" } : {}),
    ...(generationOptions?.thinking === true
      ? { reasoning: "provider-default" }
      : {}),
    messages: request.messages.map(providerMessage),
    ...(tools === undefined ? {} : { tools }),
    ...(request.toolChoice === undefined
      ? {}
      : { toolChoice: request.toolChoice }),
    ...(request.signal === undefined
      ? {}
      : { abortSignal: request.signal }),
    maxRetries: 0,
  };
}

function createWorkersAIProvider(
  options: InternalWorkersAIOptions,
): InternalWorkersAIProvider {
  const workersAI = createWorkersAI(
    {
      binding: options.binding,
      gateway: { id: options.gatewayId },
    } as unknown as Parameters<typeof createWorkersAI>[0],
  );
  const runGenerateText = generateText as unknown as InternalGenerateText;

  return {
    call: async (request) => {
      const providerOptions = toProviderOptions(options, request);
      return runGenerateText({
        model: workersAI(
          String(providerOptions.modelId),
          request.options?.thinking === false
            ? { reasoning_effort: null }
            : {},
        ),
        messages: providerOptions.messages,
        ...(providerOptions.tools === undefined
          ? {}
          : { tools: providerOptions.tools }),
        ...(providerOptions.toolChoice === undefined
          ? {}
          : { toolChoice: providerOptions.toolChoice }),
        ...(providerOptions.temperature === undefined
          ? {}
          : { temperature: providerOptions.temperature }),
        ...(providerOptions.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: providerOptions.maxOutputTokens }),
        ...(providerOptions.reasoning === undefined
          ? {}
          : { reasoning: providerOptions.reasoning }),
        ...(providerOptions.abortSignal === undefined
          ? {}
          : { abortSignal: providerOptions.abortSignal }),
        maxRetries: 0,
      });
    },
  };
}

/** Internal only. The public runtime contract never accepts a binding. */
export function createWorkersAIModelProvider(
  options: InternalWorkersAIOptions,
): EdenModelAdapterCall {
  return createWorkersAIProvider(options).call;
}

/** Internal only. The public runtime contract never accepts a binding. */
export function createWorkersAIModelAdapter(
  options: InternalWorkersAIOptions,
): EdenModelAdapter {
  return createModelAdapter(createWorkersAIModelProvider(options));
}

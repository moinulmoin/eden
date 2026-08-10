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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerMessage(
  message: EdenModelMessage,
): Record<string, unknown> {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  if (message.role === "assistant") {
    const text = message.content
      .filter((part): part is Extract<EdenModelMessagePart, { type: "text" }> =>
        part.type === "text",
      )
      .map((part) => part.text)
      .join("");
    const toolCalls = message.content
      .filter((part): part is Extract<EdenModelMessagePart, { type: "tool-call" }> =>
        part.type === "tool-call",
      )
      .map((part) => ({
        id: part.callId,
        type: "function",
        function: {
          name: part.toolName,
          arguments: JSON.stringify(part.input),
        },
      }));
    return {
      role: message.role,
      content: text.length === 0 ? null : text,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content
        .filter((part): part is Extract<EdenModelMessagePart, { type: "tool-result" }> =>
          part.type === "tool-result",
        )
        .map((part) => JSON.stringify(part.output))
        .join("\n"),
      tool_call_id: message.content.find(
        (part): part is Extract<EdenModelMessagePart, { type: "tool-result" }> =>
          part.type === "tool-result",
      )?.callId,
    };
  }
  return {
    role: message.role,
    content: message.content
      .filter((part): part is Extract<EdenModelMessagePart, { type: "text" }> =>
        part.type === "text",
      )
      .map((part) => part.text)
      .join(""),
  };
}

function providerTools(
  tools: readonly EdenModelToolDefinition[] | undefined,
): readonly Record<string, unknown>[] | undefined {
  if (tools === undefined) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: isRecord(tool.inputSchema)
        ? tool.inputSchema
        : { type: "object", properties: {} },
    },
  }));
}

function providerToolChoice(
  choice: EdenModelAdapterRequest["toolChoice"],
): unknown {
  if (choice === undefined || choice === "auto" || choice === "none") {
    return choice;
  }
  if (choice === "required") return "required";
  return {
    type: "function",
    function: { name: choice.toolName },
  };
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function normalizeWorkersAIResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter(isRecord)
        .map((call, index) => {
          const functionValue = isRecord(call.function) ? call.function : {};
          return {
            callId: typeof call.id === "string" ? call.id : `call_${index + 1}`,
            toolName: typeof functionValue.name === "string"
              ? functionValue.name
              : "",
            input: parseToolInput(functionValue.arguments),
          };
        })
    : [];
  const usage = isRecord(value.usage)
    ? {
        ...(typeof value.usage.prompt_tokens === "number"
          ? { inputTokens: value.usage.prompt_tokens }
          : typeof value.usage.input_tokens === "number"
            ? { inputTokens: value.usage.input_tokens }
            : {}),
        ...(typeof value.usage.completion_tokens === "number"
          ? { outputTokens: value.usage.completion_tokens }
          : typeof value.usage.output_tokens === "number"
            ? { outputTokens: value.usage.output_tokens }
            : {}),
        ...(typeof value.usage.total_tokens === "number"
          ? { totalTokens: value.usage.total_tokens }
          : {}),
      }
    : undefined;
  return {
    text: typeof message.content === "string" ? message.content : "",
    calls: toolCalls,
    results: [],
    finishReason: choice.finish_reason,
    ...(usage === undefined ? {} : { usage }),
  };
}

function createWorkersAIProvider(
  options: InternalWorkersAIOptions,
): InternalWorkersAIProvider {
  return {
    call: async (request) => {
      const modelId = request.modelId ?? options.modelId;
      const generationOptions = request.options;
      const tools = providerTools(request.tools);
      const inputs: Record<string, unknown> = {
        messages: request.messages.map(providerMessage),
        ...(tools === undefined
          ? {}
          : { tools }),
        ...(request.toolChoice === undefined
          ? {}
          : { tool_choice: providerToolChoice(request.toolChoice) }),
        ...(generationOptions?.temperature === undefined
          ? {}
          : { temperature: generationOptions.temperature }),
        ...(generationOptions?.maxOutputTokens === undefined
          ? {}
          : { max_tokens: generationOptions.maxOutputTokens }),
        ...(generationOptions?.thinking === false
          ? { reasoning_effort: null }
          : {}),
      };
      const binding = options.binding as {
        run: (
          model: string,
          inputs: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      const response = await binding.run(modelId, inputs, {
        gateway: { id: options.gatewayId },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (response instanceof Response) {
        return normalizeWorkersAIResult(await response.json());
      }
      return normalizeWorkersAIResult(response);
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

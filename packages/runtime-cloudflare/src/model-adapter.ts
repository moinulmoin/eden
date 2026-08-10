import type {
  EdenModelOutcome,
  EdenModelAdapterRequest,
  EdenModelRequest,
  EdenModelResult,
  EdenModelToolDefinition,
} from "./model-contracts.js";
import {
  normalizeModelFailure,
  normalizeModelMessages,
  normalizeModelResult,
} from "./model-normalizers.js";

export type {
  EdenModelCorrelation,
  EdenModelFailure,
  EdenModelFailureCode,
  EdenModelFinishReason,
  EdenModelMessage,
  EdenModelMessagePart,
  EdenModelOptions,
  EdenModelOutcome,
  EdenModelAdapterRequest,
  EdenModelRequest,
  EdenModelResult,
  EdenModelRole,
  EdenModelToolCall,
  EdenModelToolChoice,
  EdenModelToolDefinition,
  EdenModelToolResult,
  EdenModelUsage,
} from "./model-contracts.js";

export {
  normalizeEdenJsonValue,
  normalizeModelFailure,
  normalizeModelMessages,
  normalizeModelResult,
} from "./model-normalizers.js";

export type EdenModelAdapterCall = (
  request: EdenModelAdapterRequest,
) => Promise<unknown>;

export interface EdenModelAdapter {
  readonly call: (request: EdenModelRequest) => Promise<EdenModelOutcome>;
}

function normalizeToolDefinition(
  tool: EdenModelToolDefinition,
): EdenModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function providerRequest(
  request: EdenModelRequest,
): EdenModelAdapterRequest {
  const messages = normalizeModelMessages(request.messages);
  const tools =
    request.tools === undefined
      ? undefined
      : request.tools.map(normalizeToolDefinition);
  return {
    messages,
    ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
    ...(tools === undefined ? {} : { tools }),
    ...(request.toolChoice === undefined
      ? {}
      : { toolChoice: request.toolChoice }),
    ...(request.options === undefined ? {} : { options: request.options }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

export function createModelAdapter(
  provider: EdenModelAdapterCall,
): EdenModelAdapter {
  return {
    async call(request): Promise<EdenModelOutcome> {
      const correlation = request.correlation;
      try {
        const value = await provider(providerRequest(request));
        let result: EdenModelResult;
        try {
          result = normalizeModelResult(value, correlation);
        } catch (error) {
          return {
            status: "error",
            error: normalizeModelFailure(
              error,
              correlation,
              "model_result_invalid",
            ),
          };
        }
        return { status: "ok", result };
      } catch (error) {
        const code = request.signal?.aborted
          ? "model_call_aborted"
          : "model_call_failed";
        return {
          status: "error",
          error: normalizeModelFailure(error, correlation, code),
        };
      }
    },
  };
}

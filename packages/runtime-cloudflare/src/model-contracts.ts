import type {
  EdenJsonValue,
  EdenModelOptions,
} from "@moinulmoin/eden-definitions";

export type { EdenModelOptions } from "@moinulmoin/eden-definitions";

export type EdenModelRole = "system" | "user" | "assistant" | "tool";

export interface EdenModelCorrelation {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly stepId?: string;
}

export interface EdenModelToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: EdenJsonValue;
}

export interface EdenModelToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly output: EdenJsonValue;
}

export type EdenModelMessagePart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly toolName: string;
      readonly input: EdenJsonValue;
    }
  | {
      readonly type: "tool-result";
      readonly callId: string;
      readonly toolName: string;
      readonly output: EdenJsonValue;
    };

export interface EdenModelMessage {
  readonly role: EdenModelRole;
  readonly content: string | readonly EdenModelMessagePart[];
}

export interface EdenModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: EdenJsonValue;
}

export type EdenModelToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      readonly type: "tool";
      readonly toolName: string;
    };

export interface EdenModelAdapterRequest {
  readonly modelId?: string;
  readonly messages: readonly EdenModelMessage[];
  readonly tools?: readonly EdenModelToolDefinition[];
  readonly toolChoice?: EdenModelToolChoice;
  readonly options?: EdenModelOptions;
  readonly signal?: AbortSignal;
}

export interface EdenModelRequest {
  readonly modelId?: string;
  readonly messages: readonly EdenModelMessage[];
  readonly tools?: readonly EdenModelToolDefinition[];
  readonly toolChoice?: EdenModelToolChoice;
  readonly options?: EdenModelOptions;
  readonly correlation: EdenModelCorrelation;
  readonly signal?: AbortSignal;
}

export type EdenModelFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

export interface EdenModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface EdenModelResult {
  readonly text: string;
  readonly calls: readonly EdenModelToolCall[];
  readonly results: readonly EdenModelToolResult[];
  readonly finishReason: EdenModelFinishReason;
  readonly usage?: EdenModelUsage;
  readonly correlation: EdenModelCorrelation;
}

export type EdenModelFailureCode =
  | "model_call_aborted"
  | "model_call_failed"
  | "model_result_invalid";

export interface EdenModelFailure {
  readonly code: EdenModelFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlation: EdenModelCorrelation;
}

export type EdenModelOutcome =
  | {
      readonly status: "ok";
      readonly result: EdenModelResult;
    }
  | {
      readonly status: "error";
      readonly error: EdenModelFailure;
    };

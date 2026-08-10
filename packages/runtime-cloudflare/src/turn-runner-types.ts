import type {
  EdenEvent,
  EdenEventType,
  EdenJsonValue,
  EdenModelOptions,
  EdenToolDefinition,
} from "@eden/definitions";

import type {
  EdenModelAdapter,
  EdenModelResult,
} from "./model-adapter.js";

import { MAX_CHECKPOINT_ATTEMPTS } from "./session-checkpoint.js";

export const MAX_BOUNDED_TURN_ATTEMPTS = MAX_CHECKPOINT_ATTEMPTS;

export type EdenTurnFailureCode =
  | "turn_runner_invalid"
  | "model_call_aborted"
  | "model_call_failed"
  | "model_result_invalid"
  | "tool_input_invalid"
  | "tool_output_invalid"
  | "tool_execution_failed"
  | "final_response_invalid"
  | "final_response_failed";

export interface EdenTurnFailure {
  readonly code: EdenTurnFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId?: string;
}

export type EdenBoundedTurnResult =
  | {
      readonly status: "completed";
      readonly sessionId: string;
      readonly turnId: string;
      readonly messageId: string;
      readonly content: string;
    }
  | {
      readonly status: "failed";
      readonly sessionId: string;
      readonly turnId: string;
      readonly error: EdenTurnFailure;
    };

export interface EdenBoundedTurnRequest<
  TInput,
  TOutput extends EdenJsonValue = EdenJsonValue,
> {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly message: string;
  readonly systemPrompt?: string;
  readonly model: EdenModelAdapter;
  readonly modelId?: string;
  readonly modelOptions?: EdenModelOptions;
  readonly toolName: string;
  readonly tool: EdenToolDefinition<TInput, TOutput>;
  readonly toolInputSchema: EdenJsonValue;
  readonly bundleIdentity: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (
    event: EdenEvent<EdenEventType>,
  ) => void | Promise<void>;
}

export interface TurnIdentity {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface TurnMessageIdentity extends TurnIdentity {
  readonly messageId: string;
}

export interface StoredFailure {
  readonly code: EdenTurnFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly stepId?: string;
}

export type BeginTurnResult =
  | { readonly status: "continue" }
  | {
      readonly status: "completed";
      readonly messageId: string;
      readonly content: string;
    }
  | {
      readonly status: "failed";
      readonly failure: StoredFailure;
    };

export type StepPreparation =
  | {
      readonly status: "execute";
      readonly attemptCount: number;
    }
  | {
      readonly status: "replayed";
      readonly result: EdenModelResult;
    }
  | {
      readonly status: "failed";
      readonly failure: StoredFailure;
    };

export interface SqlRow {
  readonly [key: string]: string | number | null;
}

export interface TurnRow extends SqlRow {
  readonly turn_id: string;
  readonly status: "accepted" | "running" | "completed" | "failed";
  readonly error_id: string | null;
}

export interface MessageRow extends SqlRow {
  readonly message_id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly completed_at: string | null;
}

export interface StepRow extends SqlRow {
  readonly step_id: string;
  readonly turn_id: string;
  readonly logical_key: string;
  readonly phase: "model-tool" | "final-response";
  readonly status: "pending" | "running" | "completed" | "retryable" | "failed";
  readonly attempt_count: number;
  readonly error_id: string | null;
}

export interface ErrorRow extends SqlRow {
  readonly error_id: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: number;
}

export interface ProjectionRow extends SqlRow {
  readonly projection_json: string;
}

export function modelToolStepId(turnId: string): string {
  return `step_${encodeURIComponent(turnId)}_model_tool`;
}

export function finalResponseStepId(turnId: string): string {
  return `step_${encodeURIComponent(turnId)}_final_response`;
}

export function modelProjectionKey(turnId: string): string {
  return `turn:${turnId}:model-tool`;
}

export function assistantMessageId(turnId: string): string {
  return `msg_assistant_${turnId}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
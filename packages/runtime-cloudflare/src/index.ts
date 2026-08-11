import type {
  EdenEvent,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export {
  configureEdenArtifact,
  readConfiguredEdenArtifact,
} from "./artifact-runtime.js";
export type {
  EdenArtifactGenerationMetadata,
  EdenConfiguredArtifact,
  EdenRuntimeAgentArtifact,
} from "./artifact-runtime.js";

export type {
  EdenEvent,
  EdenEventDataByType,
  EdenEventType,
  EdenSessionSnapshot,
  EdenVersionSet,
} from "@eden/definitions";

export {
  createModelAdapter,
  normalizeEdenJsonValue,
  normalizeModelFailure,
  normalizeModelMessages,
  normalizeModelResult,
} from "./model-adapter.js";
export type {
  EdenModelAdapter,
  EdenModelCorrelation,
  EdenModelFailure,
  EdenModelFailureCode,
  EdenModelFinishReason,
  EdenModelMessage,
  EdenModelMessagePart,
  EdenModelOptions,
  EdenModelOutcome,
  EdenModelAdapterCall,
  EdenModelAdapterRequest,
  EdenModelRequest,
  EdenModelResult,
  EdenModelRole,
  EdenModelToolCall,
  EdenModelToolChoice,
  EdenModelToolDefinition,
  EdenModelToolResult,
  EdenModelUsage,
} from "./model-adapter.js";

export interface EdenRuntimeConfiguration {
  readonly versions: EdenVersionSet;
}

export interface EdenSessionStore {
  createSession(): Promise<EdenSessionSnapshot>;
  readEvents(
    sessionId: string,
    startIndex?: number,
  ): Promise<readonly EdenEvent<EdenEventType>[]>;
}

export interface EdenRuntime {
  readonly configuration: EdenRuntimeConfiguration;
  readonly sessions: EdenSessionStore;
}

export function createRuntime(
  configuration: EdenRuntimeConfiguration,
  sessions: EdenSessionStore,
): EdenRuntime {
  return { configuration, sessions };
}

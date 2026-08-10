/**
 * Eden-owned contracts shared by the compiler, Worker runtime, client, CLI,
 * and authored examples. Platform and provider types intentionally stop at
 * package-private adapters.
 */

export const EDEN_PACKAGE_VERSION = "0.1.0" as const;
export const EDEN_RUNTIME_VERSION = "eden-runtime-1" as const;
export const EDEN_AGENT_BUNDLE_VERSION = "eden-agent-bundle-1" as const;
export const EDEN_MANIFEST_VERSION = "eden-manifest-1" as const;
export const EDEN_PROTOCOL_VERSION = "eden-protocol-1" as const;
export const EDEN_SCHEMA_VERSION = 1 as const;

export interface EdenVersionSet {
  readonly runtime: string;
  readonly agentBundle: string;
  readonly manifest: string;
  readonly protocol: string;
  readonly schema: number;
}

export const EDEN_VERSIONS: EdenVersionSet = Object.freeze({
  runtime: EDEN_RUNTIME_VERSION,
  agentBundle: EDEN_AGENT_BUNDLE_VERSION,
  manifest: EDEN_MANIFEST_VERSION,
  protocol: EDEN_PROTOCOL_VERSION,
  schema: EDEN_SCHEMA_VERSION,
});

export type EdenJsonPrimitive = string | number | boolean | null;
export type EdenJsonValue =
  | EdenJsonPrimitive
  | readonly EdenJsonValue[]
  | { readonly [key: string]: EdenJsonValue };

export type EdenSchemaPathSegment = string | number;

export interface EdenStandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly EdenSchemaPathSegment[];
}

export type EdenStandardSchemaResult<TOutput> =
  | { readonly value: TOutput }
  | { readonly issues: readonly EdenStandardSchemaIssue[] };

export interface EdenStandardSchemaV1<TOutput = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | EdenStandardSchemaResult<TOutput>
      | Promise<EdenStandardSchemaResult<TOutput>>;
  };
}

export interface EdenModelOptions {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly thinking?: boolean;
}

export interface EdenAgentDefinition {
  readonly model: string;
  readonly options?: EdenModelOptions;
}

export interface EdenToolContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface EdenToolDefinition<
  TInput = unknown,
  TOutput extends EdenJsonValue = EdenJsonValue,
> {
  readonly description: string;
  readonly inputSchema: EdenStandardSchemaV1<TInput>;
  readonly execute: (
    input: TInput,
    context: EdenToolContext,
  ) => TOutput | Promise<TOutput>;
}

export interface EdenSourceReference {
  readonly relativePath: string;
  readonly sha256: string;
}

export interface EdenInstructionManifest {
  readonly source: EdenSourceReference;
  readonly content: string;
  readonly sha256: string;
}

export interface EdenToolManifest {
  readonly name: string;
  readonly description: string;
  readonly source: EdenSourceReference;
  readonly module: string;
  readonly schema: {
    readonly vendor: string;
    readonly version: number;
  };
}

export interface EdenManifest {
  readonly kind: "eden.manifest";
  readonly version: typeof EDEN_MANIFEST_VERSION;
  readonly runtimeVersion: typeof EDEN_RUNTIME_VERSION;
  readonly agentBundleVersion: typeof EDEN_AGENT_BUNDLE_VERSION;
  readonly protocolVersion: typeof EDEN_PROTOCOL_VERSION;
  readonly schemaVersion: typeof EDEN_SCHEMA_VERSION;
  readonly agent: {
    readonly source: EdenSourceReference;
    readonly model: string;
    readonly options?: EdenModelOptions;
  };
  readonly instructions: EdenInstructionManifest;
  readonly tools: readonly EdenToolManifest[];
  readonly bundleDigest: string;
}

export interface EdenDiscoveryRecord {
  readonly agent: EdenSourceReference;
  readonly instructions: EdenSourceReference;
  readonly tools: readonly EdenSourceReference[];
}

export interface EdenDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  readonly severity: "error" | "warning" | "info";
}

export interface EdenBuildMetadata {
  readonly generationId: string;
  readonly createdAt: string;
  readonly bundleDigest: string;
  readonly manifestVersion: typeof EDEN_MANIFEST_VERSION;
}

export interface EdenArtifactSet {
  readonly discovery: EdenDiscoveryRecord;
  readonly diagnostics: readonly EdenDiagnostic[];
  readonly manifest: EdenManifest;
  readonly bundle: string;
  readonly buildMetadata: EdenBuildMetadata;
}

export type EdenSessionStatus =
  | "new"
  | "running"
  | "waiting"
  | "failed"
  | "completed";

export type EdenTurnStatus = "accepted" | "running" | "completed" | "failed";

export type EdenStepPhase = "model-tool" | "final-response";

export type EdenEventType =
  | "session.started"
  | "turn.started"
  | "message.received"
  | "step.started"
  | "actions.requested"
  | "action.result"
  | "message.completed"
  | "step.completed"
  | "turn.completed"
  | "session.waiting"
  | "step.failed"
  | "turn.failed"
  | "session.failed";

export interface EdenEventDataByType {
  "session.started": {
    readonly sessionId: string;
    readonly status: EdenSessionStatus;
    readonly versions: EdenVersionSet;
  };
  "turn.started": { readonly turnId: string };
  "message.received": {
    readonly messageId: string;
    readonly role: "user";
  };
  "step.started": {
    readonly stepId: string;
    readonly phase: EdenStepPhase;
  };
  "actions.requested": {
    readonly stepId: string;
    readonly actions: readonly {
      readonly callId: string;
      readonly toolName: string;
      readonly input: EdenJsonValue;
    }[];
  };
  "action.result": {
    readonly stepId: string;
    readonly callId: string;
    readonly toolName: string;
    readonly output: EdenJsonValue;
  };
  "message.completed": {
    readonly messageId: string;
    readonly role: "assistant";
    readonly content: string;
  };
  "step.completed": {
    readonly stepId: string;
    readonly phase: EdenStepPhase;
  };
  "turn.completed": { readonly turnId: string };
  "session.waiting": { readonly status: "waiting" };
  "step.failed": {
    readonly stepId: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  "turn.failed": {
    readonly turnId: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  "session.failed": {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface EdenEvent<TType extends EdenEventType = EdenEventType> {
  readonly streamIndex: number;
  readonly eventId: string;
  readonly type: TType;
  readonly data: EdenEventDataByType[TType];
  readonly committedAt: string;
}

export interface EdenSessionSnapshot {
  readonly sessionId: string;
  readonly status: EdenSessionStatus;
  readonly versions: EdenVersionSet;
}

export interface EdenTurnSnapshot {
  readonly turnId: string;
  readonly status: EdenTurnStatus;
}

export interface EdenSessionCreateRequest {
  readonly [key: string]: never;
}

export interface EdenCommandRequest {
  readonly message: string;
}

export interface EdenSessionAcceptance {
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: "accepted";
}

export interface EdenError {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
}

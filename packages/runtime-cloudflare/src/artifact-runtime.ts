import type {
  EdenAgentDefinition,
  EdenJsonValue,
  EdenToolDefinition,
} from "@moinulmoin/eden-definitions";

export interface EdenArtifactGenerationMetadata {
  readonly generationId: string;
  readonly bundleDigest: string;
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly agentBundleVersion: string;
  readonly protocolVersion: string;
  /** Generated artifact/schema-contract version, not the installed SQLite level. */
  readonly schemaVersion: number;
  readonly toolNames: readonly string[];
  readonly executionMode: "local" | "remote";
}

export interface EdenRuntimeAgentArtifact {
  readonly agent: EdenAgentDefinition;
  readonly instructions: string;
  readonly tools: Readonly<Record<string, EdenToolDefinition>>;
  readonly toolSchemas: Readonly<Record<string, EdenJsonValue>>;
  readonly moduleMap?: unknown;
}

export interface EdenConfiguredArtifact {
  readonly artifact: EdenRuntimeAgentArtifact;
  readonly generation: EdenArtifactGenerationMetadata;
}

let configuredArtifact: EdenConfiguredArtifact | undefined;

export function configureEdenArtifact(
  artifact: EdenRuntimeAgentArtifact,
  generation: EdenArtifactGenerationMetadata,
): void {
  configuredArtifact = Object.freeze({
    artifact,
    generation: Object.freeze({
      ...generation,
      toolNames: Object.freeze([...generation.toolNames]),
    }),
  });
}

export function readConfiguredEdenArtifact(): EdenConfiguredArtifact | undefined {
  return configuredArtifact;
}

import type {
  EdenArtifactSet,
  EdenDiagnostic,
  EdenManifest,
  EdenSourceReference,
} from "@eden/definitions";

export {
  EDEN_AGENT_BUNDLE_VERSION,
  EDEN_MANIFEST_VERSION,
  EDEN_PROTOCOL_VERSION,
  EDEN_RUNTIME_VERSION,
  EDEN_SCHEMA_VERSION,
} from "@eden/definitions";
export type {
  EdenArtifactSet,
  EdenBuildMetadata,
  EdenDiagnostic,
  EdenDiscoveryRecord,
  EdenInstructionManifest,
  EdenManifest,
  EdenSourceReference,
  EdenToolManifest,
} from "@eden/definitions";

export interface EdenCompilerOptions {
  readonly projectRoot: string;
  readonly outputDirectory?: string;
}

export interface EdenCompilerResult {
  readonly artifacts: EdenArtifactSet;
  readonly diagnostics: readonly EdenDiagnostic[];
}

export interface EdenCompiler {
  readonly version: string;
  build(options: EdenCompilerOptions): Promise<EdenCompilerResult>;
}

export class EdenCompilerError extends Error {
  readonly diagnostics: readonly EdenDiagnostic[];

  constructor(message: string, diagnostics: readonly EdenDiagnostic[] = []) {
    super(message);
    this.name = "EdenCompilerError";
    this.diagnostics = diagnostics;
  }
}

export function createSourceReference(
  relativePath: string,
  sha256: string,
): EdenSourceReference {
  return { relativePath, sha256 };
}

export function createManifest(
  manifest: EdenManifest,
): EdenManifest {
  return manifest;
}

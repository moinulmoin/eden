import type { EdenModelAdapter } from "./model-adapter.js";

let configuredTestModel: EdenModelAdapter | undefined;

/**
 * Deterministic model injection is intentionally test-worker-only.
 * Production wrappers must use the Workers AI binding instead.
 */
export function configureEdenTestModel(model: EdenModelAdapter): void {
  configuredTestModel = model;
}

export function readConfiguredEdenTestModel(): EdenModelAdapter | undefined {
  return configuredTestModel;
}

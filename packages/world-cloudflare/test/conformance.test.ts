import { createTestSuite } from "@workflow/world-testing";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

process.env.CBOR_NATIVE_ACCELERATION_DISABLED = "true";
const previousDeploymentId = process.env.EDEN_EVE_DEPLOYMENT_ID;
process.env.EDEN_EVE_DEPLOYMENT_ID = "eden-affinity-conformance";
afterAll(() => {
  if (previousDeploymentId === undefined) delete process.env.EDEN_EVE_DEPLOYMENT_ID;
  else process.env.EDEN_EVE_DEPLOYMENT_ID = previousDeploymentId;
});
const preload = fileURLToPath(new URL("./preload.mjs", import.meta.url));
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`;
createTestSuite(fileURLToPath(new URL("../dist/index.js", import.meta.url)));

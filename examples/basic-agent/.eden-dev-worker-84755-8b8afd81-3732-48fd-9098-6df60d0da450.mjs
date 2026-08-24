import runtimeWorker, { EdenSession, configureEdenArtifact } from "../../packages/runtime-cloudflare/dist/test-worker.js";
import agentArtifact from "./.eden/generations/gen_179836662c7c2456018b6c1664fbbaacea66ab7c9c00787be03f027ad7a65d65/agent-bundle.mjs";

configureEdenArtifact(agentArtifact, {"generationId":"gen_179836662c7c2456018b6c1664fbbaacea66ab7c9c00787be03f027ad7a65d65","bundleDigest":"e2cfdb44cc6611892c0be4a69e6ab9dfa8aab3faaa1e5d5eaacfffcb2d445c1f","manifestVersion":"eden-manifest-1","runtimeVersion":"eden-runtime-1","agentBundleVersion":"eden-agent-bundle-1","protocolVersion":"eden-protocol-1","schemaVersion":1,"toolNames":["greet"],"executionMode":"local"});
export { EdenSession };
export default runtimeWorker;

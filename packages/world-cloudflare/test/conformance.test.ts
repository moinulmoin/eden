import { createTestSuite } from "@workflow/world-testing";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, vi } from "vitest";
import { ulid } from "ulid";
import type { World } from "@workflow/world";
import { atomicStartHookConformance } from "../node_modules/@workflow/world/dist/test-support/atomic-start-hook-conformance.js";
import { createWorld } from "../dist/index.js";
import { startWorldServer } from "./server.mjs";

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

describe("Cloudflare World atomic start Hooks over RPC", () => {
  let server: { url: string; close(): Promise<void> };
  let world: World;
  let secondWorld: World;
  const realNow = Date.now.bind(Date);

  beforeEach(async () => {
    // Fake only Date: HTTP and the server's timers must keep running. Installing
    // it before the core is constructed also controls its captured clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    server = await startWorldServer();
    world = createWorld({ url: server.url });
    secondWorld = createWorld({ url: server.url });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await world?.close?.();
    await secondWorld?.close?.();
    await server?.close();
  });

  atomicStartHookConformance({
    name: "Cloudflare World client RPC",
    storage: () => world,
    capabilities: () => world.capabilities,
    newRunId: () => `wrun_${ulid(Date.now())}`,
    secondEvents: () => secondWorld.events,
    advanceClock: (ms) => vi.setSystemTime(realNow() + ms),
    retentionReadsAdvanceClock: true,
    // No orphan staging: admission, Hook, and run commit in one transaction.
  });
});

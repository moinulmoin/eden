import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import {
  LOCAL_RECOVERY_FIXTURES,
  PUBLIC_FAILURE_CASES,
  PUBLIC_FAILURE_FIXTURE,
  runLocalConformance,
} from "../scripts/local-conformance.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("completes the clean-room local first-use flow and reconnects from a saved cursor", async () => {
  const result = await runLocalConformance({
    repositoryRoot,
  });

  expect(result.lifecycle).toEqual([
    "session.started",
    "turn.started",
    "message.received",
    "step.started",
    "actions.requested",
    "action.result",
    "step.completed",
    "step.started",
    "message.completed",
    "step.completed",
    "turn.completed",
    "session.waiting",
  ]);
  expect(result.disconnectedCursor).toBe(5);
  expect(result.reconnectedCursors).toEqual([6, 7, 8, 9, 10, 11, 12]);
  expect(result.cleanup).toEqual({
    projectRemoved: true,
    workerPortFree: true,
    inspectorPortFree: true,
    processStopped: true,
  });
  const publicFailure = result.recoveryResults.find(
    (entry) => entry.fixture === PUBLIC_FAILURE_FIXTURE,
  );
  expect(publicFailure?.publicFailureCases).toEqual(PUBLIC_FAILURE_CASES);
  expect(publicFailure?.passedTests).toEqual(PUBLIC_FAILURE_CASES);
}, 30_000);

test("keeps invalid-input and interrupted-step fixtures in the serial conformance gate", async () => {
  expect(LOCAL_RECOVERY_FIXTURES).toEqual([
    "packages/runtime-cloudflare/test/turn-runner.test.ts",
    "packages/runtime-cloudflare/test/tool-harness.test.ts",
    "packages/runtime-cloudflare/test/session-recovery.test.ts",
    "packages/runtime-cloudflare/test/failure-eviction-conformance.test.ts",
    "packages/runtime-cloudflare/test/session-journal.test.ts",
    "packages/runtime-cloudflare/test/stream-lifecycle.test.ts",
    "packages/runtime-cloudflare/test/http-host.test.ts",
    "packages/client/test/stream.test.ts",
  ]);

  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  expect(readme).toContain("corepack pnpm run conformance:local");
  expect(readme).toMatch(/disconnects after committed cursor `5`/i);
  expect(readme).toMatch(/`startIndex=5`/i);
  expect(readme).toMatch(/invalid tool input/i);
  expect(readme).toMatch(/interrupted/i);
});

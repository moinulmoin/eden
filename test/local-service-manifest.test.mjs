import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("checks in isolated preview and production Wrangler targets for basic-agent", async () => {
  const config = JSON.parse(
    await readFile(
      join(repositoryRoot, "examples/basic-agent/wrangler.jsonc"),
      "utf8",
    ),
  );

  expect(config.main).toBe(".eden/agent-bundle.mjs");
  expect(config.compatibility_date).toBe("2026-04-01");
  expect(config.ai).toEqual({ binding: "AI" });
  expect(config.durable_objects).toEqual({
    bindings: [
      {
        name: "EDEN_SESSIONS",
        class_name: "EdenSession",
      },
    ],
  });

  const environments = [config.env?.preview, config.env?.production];
  expect(environments).toHaveLength(2);
  expect(config.env.preview.name).not.toBe(config.env.production.name);
  for (const environment of environments) {
    expect(environment.ai).toEqual({ binding: "AI" });
    expect(environment.durable_objects).toEqual(config.durable_objects);
    expect(environment.migrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: ["EdenSession"],
      },
    ]);
  }
});

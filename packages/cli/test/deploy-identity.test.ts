import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { readArtifactGeneration } from "@eden/compiler";
import {
  runEdenCli,
  type EdenCliRemoteCommandRequest,
} from "../src/index.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-deploy-identity-"));
  roots.push(root);
  return root;
}

async function initRoot(root: string): Promise<void> {
  await expect(
    runEdenCli(["init", "--project", root], { cwd: root }),
  ).resolves.toBe(0);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("eden source and deployment identity binding", () => {
  test("fingerprints a contained .eden helper during compatibility validation", async () => {
    const root = await createRoot();
    const helperPath = join(root, ".eden-helper.ts");
    const agentPath = join(root, "agent/agent.ts");

    await initRoot(root);
    await writeFile(
      helperPath,
      'export const model = "@cf/zai-org/glm-4.7-flash";\n',
      "utf8",
    );
    await writeFile(
      agentPath,
      `import { model } from "../.eden-helper.js";
import type { EdenAgentDefinition } from "@eden/definitions";

const agent: EdenAgentDefinition = {
  model,
  options: {
    maxOutputTokens: 512,
    thinking: false,
  },
};

export default agent;
`,
      "utf8",
    );

    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).resolves.toBe(0);
    const before = await readArtifactGeneration(join(root, ".eden"));

    const errors: string[] = [];
    await expect(
      runEdenCli(["build", "--project", root], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => {
          await writeFile(
            helperPath,
            'export const model = "@cf/zai-org/glm-4.7-flash-mutated";\n',
            "utf8",
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBe(1);

    const after = await readArtifactGeneration(join(root, ".eden"));
    expect(after.artifacts.buildMetadata.generationId).toBe(
      before.artifacts.buildMetadata.generationId,
    );
    expect(errors.join("\n")).toMatch(/\\.eden-helper\\.ts|source|configuration|changed/i);
  });

  test("binds deploy validation to the fingerprint captured before build", async () => {
    const root = await createRoot();
    const sourcePath = join(root, "agent/tools/greet.ts");
    const remoteCommands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let dryRunCount = 0;

    await initRoot(root);
    const originalSource = await readFile(sourcePath, "utf8");

    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-identity-binding",
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => {
            dryRunCount += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          buildPublicationHook: async (boundary) => {
            if (boundary === "after-current-promotion") {
              await writeFile(
                sourcePath,
                originalSource.replace(
                  "Greet a person by name.",
                  "Changed after generation promotion.",
                ),
                "utf8",
              );
            }
          },
          remoteCommandRunner: async (request) => {
            remoteCommands.push(request);
            return {
              exitCode: 0,
              stdout: "https://eden-identity-binding.example.workers.dev\n",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "identity-binding-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(dryRunCount).toBe(2);
    expect(remoteCommands).toEqual([]);
    expect(errors.join("\n")).toMatch(/source|configuration|changed|stale/i);
  });
});

import {
  mkdir,
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

  test("rejects selected dependency mutation before remote secret provisioning", async () => {
    const root = await createRoot();
    const dependencyDirectory = join(
      root,
      "node_modules/selected-schema-fixture",
    );
    const toolPath = join(root, "agent/tools/greet.ts");
    const remoteCommands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let dryRunCount = 0;

    await initRoot(root);
    await mkdir(dependencyDirectory, { recursive: true });
    await writeFile(
      join(dependencyDirectory, "package.json"),
      JSON.stringify({
        name: "selected-schema-fixture",
        type: "module",
        exports: "./index.js",
      }),
      "utf8",
    );
    await writeFile(
      join(dependencyDirectory, "index.js"),
      `export const inputSchema = {
  "~standard": {
    version: 1,
    vendor: "selected-dependency",
    validate(value) {
      return { value };
    },
  },
};
`,
      "utf8",
    );
    await writeFile(
      toolPath,
      `import { inputSchema } from "selected-schema-fixture";
import type { EdenToolDefinition } from "@eden/definitions";

const greet: EdenToolDefinition<unknown, { readonly greeting: string }> = {
  description: "Greet using a selected dependency.",
  inputSchema,
  execute() {
    return { greeting: "hello" };
  },
};

export default greet;
`,
      "utf8",
    );

    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-selected-dependency",
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => {
            dryRunCount += 1;
            if (dryRunCount === 2) {
              await writeFile(
                join(dependencyDirectory, "index.js"),
                `export const inputSchema = {
  "~standard": {
    version: 1,
    vendor: "mutated-selected-dependency",
    validate(value) {
      return { value };
    },
  },
};
`,
                "utf8",
              );
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          remoteCommandRunner: async (request) => {
            remoteCommands.push(request);
            return {
              exitCode: 0,
              stdout: "https://eden-selected-dependency.example.workers.dev\n",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "selected-dependency-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(dryRunCount).toBe(2);
    expect(remoteCommands).toEqual([]);
    expect(errors.join("\n")).toMatch(/selected-schema-fixture|source|changed|stale/i);
  });

  test("rejects authored temporary-looking paths instead of trusting their names", async () => {
    const root = await createRoot();
    const helperDirectory = join(
      root,
      ".eden-build-candidate-1234-deadbeef",
    );
    const helperPath = join(helperDirectory, "model.ts");
    const agentPath = join(root, "agent/agent.ts");
    const remoteCommands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let dryRunCount = 0;

    await initRoot(root);
    await mkdir(helperDirectory, { recursive: true });
    await writeFile(
      helperPath,
      'export const model = "@cf/zai-org/glm-4.7-flash";\n',
      "utf8",
    );
    await writeFile(
      agentPath,
      `import { model } from "../.eden-build-candidate-1234-deadbeef/model.js";
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
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-authored-temporary",
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => {
            dryRunCount += 1;
            if (dryRunCount === 2) {
              await writeFile(
                helperPath,
                'export const model = "@cf/zai-org/glm-4.7-flash-mutated";\n',
                "utf8",
              );
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          remoteCommandRunner: async (request) => {
            remoteCommands.push(request);
            return {
              exitCode: 0,
              stdout: "https://eden-authored-temporary.example.workers.dev\n",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "authored-temporary-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(dryRunCount).toBe(2);
    expect(remoteCommands).toEqual([]);
    expect(errors.join("\n")).toMatch(
      /\.eden-build-candidate-1234-deadbeef|source|changed|stale/i,
    );
  });
});

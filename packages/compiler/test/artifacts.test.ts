import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import {
  EdenCompilerError,
  buildProject,
  createArtifactIdentity,
} from "../src/index.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function createProject(
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-artifacts-"));
  temporaryRoots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

const agentSource = `
  export default {
    model: "@cf/zai-org/glm-4.7-flash",
    options: { maxOutputTokens: 512, thinking: false }
  };
`;

const toolSource = `
  const inputSchema = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate(value) {
        if (!value || typeof value !== "object" || typeof value.name !== "string") {
          return { issues: [{ message: "name must be a string" }] };
        }
        return { value: { name: value.name.trim() } };
      }
    },
    jsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  };

  export default {
    description: "Greet a person.",
    inputSchema,
    execute(input) {
      return { greeting: "Hello " + input.name };
    }
  };
`;

async function readGeneration(root: string) {
  const outputDirectory = join(root, ".eden");
  const [discovery, diagnostics, manifest, moduleMap, buildMetadata, bundle] =
    await Promise.all([
      readFile(join(outputDirectory, "discovery.json"), "utf8"),
      readFile(join(outputDirectory, "diagnostics.json"), "utf8"),
      readFile(join(outputDirectory, "manifest.json"), "utf8"),
      readFile(join(outputDirectory, "module-map.json"), "utf8"),
      readFile(join(outputDirectory, "build-metadata.json"), "utf8"),
      readFile(join(outputDirectory, "agent-bundle.mjs"), "utf8"),
    ]);
  return {
    discovery: JSON.parse(discovery) as unknown,
    diagnostics: JSON.parse(diagnostics) as unknown,
    manifest: JSON.parse(manifest) as {
      bundleDigest: string;
      tools: readonly { name: string; module: string }[];
    },
    moduleMap: JSON.parse(moduleMap) as {
      tools: readonly { name: string; module: string }[];
    },
    buildMetadata: JSON.parse(buildMetadata) as {
      generationId: string;
      createdAt: string;
      bundleDigest: string;
    },
    bundle,
  };
}

describe("artifact generation", () => {
  test("publishes one coherent generation and executes without the source tree", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "# Artifact fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    const result = await buildProject({ projectRoot: root });
    const generation = await readGeneration(root);
    const bundleDigest = createHash("sha256")
      .update(generation.bundle)
      .digest("hex");

    expect(result.artifacts.diagnostics).toEqual([]);
    expect(generation.diagnostics).toEqual([]);
    expect(generation.manifest.bundleDigest).toBe(bundleDigest);
    expect(generation.buildMetadata.bundleDigest).toBe(bundleDigest);
    expect(generation.bundle).not.toMatch(
      /\b(?:node:|node_modules|chokidar|wrangler|@eden\/compiler|process\.env|Buffer|require\s*\(|__dirname|__filename)\b/u,
    );
    expect(generation.manifest.tools).toEqual([
      expect.objectContaining({ name: "greet", module: "tool:greet" }),
    ]);
    expect(generation.moduleMap.tools).toEqual([
      expect.objectContaining({ name: "greet", module: "tool:greet" }),
    ]);
    expect(createArtifactIdentity(result.artifacts)).toBe(
      generation.buildMetadata.generationId,
    );

    await rm(join(root, "agent"), { recursive: true, force: true });
    const bundle = await import(
      `${join(root, ".eden", "agent-bundle.mjs")}?artifact-only`
    );
    const artifact = bundle.default as {
      toolSchemas: Record<string, unknown>;
      tools: Record<
        string,
        {
          inputSchema: {
            "~standard": {
              validate(value: unknown): unknown;
            };
          };
          execute(
            input: unknown,
            context: {
              sessionId: string;
              turnId: string;
              callId: string;
              toolName: string;
              idempotencyKey: string;
              signal: AbortSignal;
            },
          ): unknown;
        }
      >;
    };

    expect(artifact.toolSchemas.greet).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    });
    const tool = artifact.tools.greet;
    const validated = await tool.inputSchema["~standard"].validate({
      name: " Eden ",
    });
    expect(validated).toEqual({ value: { name: "Eden" } });
    expect(
      await Promise.resolve(
        tool.execute(
          { name: "Eden" },
          {
            sessionId: "sess",
            turnId: "turn",
            callId: "call",
            toolName: "greet",
            idempotencyKey: "effect",
            signal: new AbortController().signal,
          },
        ),
      ),
    ).toEqual({ greeting: "Hello Eden" });
  });

  test("keeps executable identity stable while timestamps remain diagnostic", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "stable\n",
      "agent/tools/greet.ts": toolSource,
    });

    const first = await buildProject({ projectRoot: root });
    const firstMetadata = first.artifacts.buildMetadata;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await buildProject({ projectRoot: root });
    const secondMetadata = second.artifacts.buildMetadata;

    expect(second.artifacts.bundle).toBe(first.artifacts.bundle);
    expect(second.artifacts.manifest).toEqual(first.artifacts.manifest);
    expect(secondMetadata.generationId).toBe(firstMetadata.generationId);
    expect(secondMetadata.bundleDigest).toBe(firstMetadata.bundleDigest);
    expect(secondMetadata.createdAt).not.toBe(firstMetadata.createdAt);
  });

  test("preserves the last coherent generation after a failed build", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "stable\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const before = await readGeneration(root);
    await writeFile(
      join(root, "agent/tools/greet.ts"),
      `
        import { readFile } from "node:fs/promises";
        export default {
          description: "invalid",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute() { return { value: typeof readFile }; }
        };
      `,
      "utf8",
    );

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      name: "EdenCompilerError",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_IMPORT_UNSUPPORTED",
          source: "agent/tools/greet.ts",
        }),
      ]),
    } satisfies Partial<EdenCompilerError>);

    const after = await readGeneration(root);
    expect(after.bundle).toBe(before.bundle);
    expect(after.manifest).toEqual(before.manifest);
    expect(after.moduleMap).toEqual(before.moduleMap);
    expect(after.buildMetadata).toEqual(before.buildMetadata);
  });

  test("compiles every artifact from the captured source snapshot", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "snapshot instructions\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const changedToolSource = toolSource.replace(
      "Greet a person.",
      "Changed after snapshot.",
    );
    const changedDuringValidation = toolSource.replace(
      "Greet a person.",
      "Changed during validation.",
    );
    const result = await buildProject({
      projectRoot: root,
      hooks: {
        afterSourceSnapshot: async () => {
          await writeFile(
            join(root, "agent/tools/greet.ts"),
            changedToolSource,
            "utf8",
          );
        },
        onPublicationBoundary: async (boundary) => {
          if (boundary === "after-stage-write") {
            await writeFile(
              join(root, "agent/tools/greet.ts"),
              changedDuringValidation,
              "utf8",
            );
          }
        },
      },
    });

    const generation = await readGeneration(root);
    const liveSourceHash = createHash("sha256")
      .update(await readFile(join(root, "agent/tools/greet.ts")))
      .digest("hex");

    expect(result.artifacts.manifest.tools[0]?.description).toBe(
      "Greet a person.",
    );
    expect(generation.manifest.tools[0]?.description).toBe(
      "Greet a person.",
    );
    expect(generation.bundle).toContain("Greet a person.");
    expect(generation.bundle).not.toContain("Changed after snapshot.");
    expect(generation.bundle).not.toContain("Changed during validation.");
    expect(generation.manifest.tools[0]?.source.sha256).not.toBe(
      liveSourceHash,
    );
    expect(generation.manifest.bundleDigest).toBe(
      createHash("sha256").update(generation.bundle).digest("hex"),
    );
  });

  test.each([
    "before-stage-write",
    "after-stage-write",
    "before-current-promotion",
  ] as const)(
    "keeps the prior current generation across %s interruption",
    async (boundary) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "publication instructions\n",
        "agent/tools/greet.ts": toolSource,
      });

      await buildProject({ projectRoot: root });
      const before = await readGeneration(root);
      const beforeCurrent = await lstat(join(root, ".eden", "CURRENT"));
      expect(beforeCurrent.isSymbolicLink()).toBe(true);

      await writeFile(
        join(root, "agent/tools/greet.ts"),
        toolSource.replace("Greet a person.", "New generation."),
        "utf8",
      );

      await expect(
        buildProject({
          projectRoot: root,
          hooks: {
            onPublicationBoundary: (currentBoundary) => {
              if (currentBoundary === boundary) {
                throw new Error(`injected ${boundary} interruption`);
              }
            },
          },
        }),
      ).rejects.toThrow(`injected ${boundary} interruption`);

      const after = await readGeneration(root);
      const afterCurrent = await lstat(join(root, ".eden", "CURRENT"));
      expect(afterCurrent.isSymbolicLink()).toBe(true);
      expect(after.bundle).toBe(before.bundle);
      expect(after.manifest).toEqual(before.manifest);
      expect(after.moduleMap).toEqual(before.moduleMap);
      expect(after.buildMetadata).toEqual(before.buildMetadata);
    },
  );

  test("publishes a complete new generation after the final promotion boundary", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "publication instructions\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const before = await readGeneration(root);
    await writeFile(
      join(root, "agent/tools/greet.ts"),
      toolSource.replace("Greet a person.", "New generation."),
      "utf8",
    );

    await expect(
      buildProject({
        projectRoot: root,
        hooks: {
          onPublicationBoundary: (boundary) => {
            if (boundary === "after-current-promotion") {
              throw new Error("injected after-current-promotion interruption");
            }
          },
        },
      }),
    ).rejects.toThrow("injected after-current-promotion interruption");

    const after = await readGeneration(root);
    const current = await lstat(join(root, ".eden", "CURRENT"));
    expect(current.isSymbolicLink()).toBe(true);
    expect(after.bundle).not.toBe(before.bundle);
    expect(after.manifest.tools[0]?.description).toBe("New generation.");
    expect(after.buildMetadata.generationId).not.toBe(
      before.buildMetadata.generationId,
    );
  });

  test(
    "passes a Wrangler dry-run with only generated Worker inputs",
    async () => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "Wrangler fixture\n",
        "agent/tools/greet.ts": toolSource,
        "wrangler.jsonc": JSON.stringify({
          name: "eden-artifact-fixture",
          main: ".eden/agent-bundle.mjs",
          compatibility_date: "2026-04-01",
        }),
      });

      await buildProject({ projectRoot: root });
      const wranglerPath = join(
        process.cwd(),
        "node_modules/.bin/wrangler",
      );
      const result = await execFileAsync(
        wranglerPath,
        ["deploy", "--dry-run", "--config", join(root, "wrangler.jsonc")],
        { cwd: root },
      );

      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /Total Upload|dry-run|Successfully built/u,
      );
    },
    15_000,
  );

  test("rejects ambient bindings before publishing a Worker artifact", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Ambient fixture\n",
      "agent/tools/ambient.ts": toolSource.replace(
        'return { greeting: "Hello " + input.name };',
        'return { greeting: process.env.EDEN ?? input.name };',
      ),
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/ambient.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
    await expect(
      readFile(join(root, ".eden", "manifest.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects undeclared identifiers with source locations", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Undeclared fixture\n",
      "agent/tools/undeclared.ts": toolSource.replace(
        'return { greeting: "Hello " + input.name };',
        'return { greeting: missingAmbientBinding(input.name) };',
      ),
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_UNDECLARED_IDENTIFIER",
          source: "agent/tools/undeclared.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("rejects secret-like and environment identifiers semantically", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Secret fixture\n",
      "agent/tools/secret.ts": toolSource.replace(
        'return { greeting: "Hello " + input.name };',
        'return { greeting: EDEN_API_KEY ?? runtimeEnvironment };',
      ),
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_UNDECLARED_IDENTIFIER",
          source: "agent/tools/secret.ts",
          message: expect.stringContaining("EDEN_API_KEY"),
        }),
        expect.objectContaining({
          code: "MODULE_UNDECLARED_IDENTIFIER",
          source: "agent/tools/secret.ts",
          message: expect.stringContaining("runtimeEnvironment"),
        }),
      ]),
    });
  });

  test("rejects ambient property access through supported Worker globals", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Ambient property fixture\n",
      "agent/tools/ambient-property.ts": toolSource.replace(
        'return { greeting: "Hello " + input.name };',
        "return { greeting: globalThis.EDEN_API_KEY };",
      ),
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/ambient-property.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("reports top-level undeclared identifiers before module evaluation", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource.replace(
        '"@cf/zai-org/glm-4.7-flash"',
        "undeclaredModel",
      ),
      "agent/instructions.md": "Top-level fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_UNDECLARED_IDENTIFIER",
          source: "agent/agent.ts",
          message: expect.stringContaining("undeclaredModel"),
        }),
      ]),
    });
  });

  test("allows supported JavaScript and Worker globals", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Supported globals fixture\n",
      "agent/tools/globals.ts": toolSource.replace(
        'return { greeting: "Hello " + input.name };',
        `
          const values = [Math.max(1, 2), JSON.stringify(input), Number.isFinite(1)];
          const argumentCount = arguments.length;
          return {
            greeting: String(values.length + argumentCount),
            workerGlobals: [
              typeof TextEncoder,
              typeof Request,
              typeof Response,
              typeof crypto,
              typeof fetch,
              typeof globalThis,
            ],
          };
        `,
      ),
    });

    const result = await buildProject({ projectRoot: root });
    expect(result.artifacts.manifest.tools).toEqual([
      expect.objectContaining({ name: "globals" }),
    ]);
  });

  test("rejects bare imports supplied only by the compiler caller during bundling", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "caller dependency bundling\n",
      "agent/tools/caller-zod.ts": `
        import { z } from "zod";
        export default {
          description: "Must not use the caller's Zod.",
          inputSchema: z.object({ name: z.string() }),
          execute(input) {
            return { greeting: input.name };
          }
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          source: "agent/tools/caller-zod.ts",
          code: "MODULE_LOAD_FAILED",
        }),
      ]),
    });
  });

  test("bundles dependencies installed in the selected project", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "selected dependency bundling\n",
      "agent/tools/selected-dependency.ts": `
        import { inputSchema } from "selected-schema-fixture";
        export default {
          description: "Uses the selected project's dependency.",
          inputSchema,
          execute(input) {
            return { value: input };
          }
        };
      `,
      "node_modules/selected-schema-fixture/package.json": JSON.stringify({
        name: "selected-schema-fixture",
        type: "module",
        exports: "./index.js",
      }),
      "node_modules/selected-schema-fixture/index.js": `
        export const inputSchema = {
          "~standard": {
            version: 1,
            vendor: "selected-project",
            validate(value) { return { value }; }
          }
        };
      `,
    });

    const result = await buildProject({ projectRoot: root });
    expect(result.artifacts.bundle).toContain("selected-project");
    expect(result.artifacts.manifest.tools).toEqual([
      expect.objectContaining({
        name: "selected-dependency",
        module: "tool:selected-dependency",
      }),
    ]);
  });
});

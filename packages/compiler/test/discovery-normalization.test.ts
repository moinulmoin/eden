import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  EdenCompilerError,
  discoverProject,
  normalizeProject,
  resolveContainedProjectPath,
  validateStandardSchema,
} from "../src/index.js";

const temporaryRoots: string[] = [];

async function writeProject(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
}

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-discovery-"));
  temporaryRoots.push(root);
  await writeProject(root, files);

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

const standardSchemaTool = `
  const inputSchema = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate(value: { name?: string }) {
        if (!value || typeof value !== "object" || typeof value.name !== "string") {
          return { issues: [{ message: "name must be a string", path: ["name"] }] };
        }
        return { value: { name: value.name.trim() } };
      }
    }
  };

  export default {
    description: "Trim a name.",
    inputSchema,
    execute(input) {
      return { greeting: "Hello " + input.name };
    }
  };
`;

describe("project discovery", () => {
  test("discovers required files and direct tools in stable path order", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "# Fixture instructions\n",
      "agent/tools/zeta.ts": standardSchemaTool,
      "agent/tools/alpha.ts": standardSchemaTool.replace(
        "Trim a name.",
        "Trim another name.",
      ),
    });

    const first = await discoverProject({ projectRoot: root });
    const second = await discoverProject({ projectRoot: root });

    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(first.discovery.tools.map((source) => source.relativePath)).toEqual([
      "agent/tools/alpha.ts",
      "agent/tools/zeta.ts",
    ]);
    expect(first.discovery).toEqual(second.discovery);
    expect(first.discovery.agent.relativePath).toBe("agent/agent.ts");
    expect(first.discovery.instructions.relativePath).toBe(
      "agent/instructions.md",
    );
  });

  test("normalizes instructions, model options, tool metadata, and transformed values", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "# Keep this byte-for-byte\n\n  \n",
      "agent/tools/trim-name.ts": standardSchemaTool,
    });

    const normalized = await normalizeProject({ projectRoot: root });
    const instructions = await readFile(
      join(root, "agent/instructions.md"),
      "utf8",
    );
    const tool = normalized.tools[0];

    expect(normalized.agent.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(normalized.agent.options).toEqual({
      maxOutputTokens: 512,
      thinking: false,
    });
    expect(normalized.instructions.content).toBe(instructions);
    expect(normalized.instructions.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tool.name).toBe("trim-name");
    expect(tool.description).toBe("Trim a name.");
    expect(tool.schema).toEqual({ vendor: "fixture", version: 1 });
    await expect(
      validateStandardSchema(tool.inputSchema, { name: "  Eden  " }),
    ).resolves.toEqual({ name: "Eden" });
    const transformed = await validateStandardSchema(tool.inputSchema, {
      name: "  Eden  ",
    });
    await expect(
      tool.execute(transformed, {
        sessionId: "sess",
        turnId: "turn",
        callId: "call",
        toolName: "trim-name",
        idempotencyKey: "effect",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ greeting: "Hello Eden" });
  });

  test("fails with source-oriented diagnostics for invalid authoring", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "instructions",
      "agent/tools/BadName.ts": standardSchemaTool,
      "agent/tools/with.identity.ts": standardSchemaTool,
      "agent/tools/duplicate.ts": standardSchemaTool.replace(
        "description:",
        'name: "wrong", id: "also-wrong", description:',
      ),
      "agent/tools/nested/child.ts": standardSchemaTool,
    });

    const result = await discoverProject({ projectRoot: root });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "TOOL_NAME_INVALID",
        "TOOL_NESTED_UNSUPPORTED",
      ]),
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.source === "agent/tools/BadName.ts" &&
          diagnostic.message.includes("lowercase"),
      ),
    ).toBe(true);

    await expect(normalizeProject({ projectRoot: root })).rejects.toMatchObject({
      name: "EdenCompilerError",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ source: "agent/tools/duplicate.ts" }),
      ]),
    });
  });

  test("rejects missing files, root escapes, and outside symlink targets", async () => {
    const root = await createProject({
      "agent/tools/valid.ts": standardSchemaTool,
    });
    const outsideRoot = await mkdtemp(join(tmpdir(), "eden-outside-"));
    temporaryRoots.push(outsideRoot);
    await writeFile(join(outsideRoot, "outside.ts"), standardSchemaTool, "utf8");
    await symlink(
      join(outsideRoot, "outside.ts"),
      join(root, "agent/tools/escape.ts"),
    );

    const result = await discoverProject({ projectRoot: root });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_MISSING",
          source: "agent/agent.ts",
        }),
        expect.objectContaining({
          code: "SOURCE_MISSING",
          source: "agent/instructions.md",
        }),
        expect.objectContaining({
          code: "PATH_OUTSIDE_PROJECT",
          source: "agent/tools/escape.ts",
        }),
      ]),
    );
    await expect(
      resolveContainedProjectPath(root, "../outside.ts"),
    ).rejects.toBeInstanceOf(EdenCompilerError);
  });

  test("rejects authored identity fields and canonical-path aliases", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "instructions",
      "agent/tools/first.ts": standardSchemaTool,
    });
    await symlink(
      join(root, "agent/tools/first.ts"),
      join(root, "agent/tools/second.ts"),
    );

    const result = await discoverProject({ projectRoot: root });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TOOL_CANONICAL_COLLISION",
          source: "agent/tools/second.ts",
        }),
      ]),
    );

    const duplicateRoot = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "instructions",
      "agent/tools/duplicate.ts": standardSchemaTool.replace(
        "description:",
        'id: "authored-id", description:',
      ),
    });
    await expect(normalizeProject({ projectRoot: duplicateRoot })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "TOOL_IDENTITY_FIELD",
          source: "agent/tools/duplicate.ts",
        }),
      ]),
    });
  });

  test("supports Zod and async Standard Schema validation without exposing vendor types", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "instructions",
      "agent/tools/async-transform.ts": `
        const inputSchema = {
          "~standard": {
            version: 1,
            vendor: "async-fixture",
            async validate(value: unknown) {
              await Promise.resolve();
              if (typeof value !== "string") {
                return { issues: [{ message: "expected a string" }] };
              }
              return { value: value.trim().toUpperCase() };
            }
          }
        };
        export default {
          description: "Async transform.",
          inputSchema,
          execute(input) {
            return { value: input };
          }
        };
      `,
      "agent/tools/zod-transform.ts": `
        import { z } from "zod";
        const inputSchema = z.object({
          name: z.string().transform((value) => value.trim())
        });
        export default {
          description: "Zod transform.",
          inputSchema,
          execute(input) {
            return { value: input.name };
          }
        };
      `,
    });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(
      join(process.cwd(), "node_modules/zod"),
      join(root, "node_modules/zod"),
    );

    const normalized = await normalizeProject({ projectRoot: root });
    const asyncTool = normalized.tools.find(
      (tool) => tool.name === "async-transform",
    );
    const zodTool = normalized.tools.find((tool) => tool.name === "zod-transform");
    expect(asyncTool?.schema).toEqual({ vendor: "async-fixture", version: 1 });
    expect(zodTool?.schema.vendor).toBe("zod");
    await expect(
      validateStandardSchema(asyncTool?.inputSchema as never, "  async  "),
    ).resolves.toBe("ASYNC");
    await expect(
      validateStandardSchema(zodTool?.inputSchema as never, { name: "  Eden " }),
    ).resolves.toEqual({ name: "Eden" });
    expect(normalized.tools.map((tool) => tool.name)).toEqual([
      "async-transform",
      "zod-transform",
    ]);
  });

  test("rejects malformed schema results and non-JSON tool outputs", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "instructions",
      "agent/tools/malformed.ts": `
        const inputSchema = {
          "~standard": {
            version: 1,
            vendor: "malformed",
            validate() { return { issues: [] }; }
          }
        };
        export default {
          description: "Malformed result.",
          inputSchema,
          execute() { return { value: undefined }; }
        };
      `,
    });

    const normalized = await normalizeProject({ projectRoot: root });
    const tool = normalized.tools[0];
    await expect(validateStandardSchema(tool.inputSchema, "input")).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_RESULT_INVALID" }),
      ]),
    });
    await expect(
      tool.execute("input", {
        sessionId: "sess",
        turnId: "turn",
        callId: "call",
        toolName: "malformed",
        idempotencyKey: "effect",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "TOOL_OUTPUT_INVALID" }),
      ]),
    });
  });

  test("rejects unsupported Node and root-escaping authored imports", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "instructions",
      "agent/tools/node-only.ts": `
        import { readFile } from "node:fs/promises";
        export default {
          description: "Node only.",
          inputSchema: {
            "~standard": {
              version: 1,
              vendor: "fixture",
              validate(value) { return { value }; }
            }
          },
          execute() { return { value: typeof readFile }; }
        };
      `,
    });
    const outsideRoot = await mkdtemp(join(tmpdir(), "eden-import-outside-"));
    temporaryRoots.push(outsideRoot);
    const outsideFile = join(outsideRoot, "outside.ts");
    await writeFile(
      outsideFile,
      "export default 'outside';\n",
      "utf8",
    );
    await writeFile(
      join(root, "agent/tools/escape-import.ts"),
      `
        import outside from "${relative(join(root, "agent/tools"), outsideFile).replaceAll("\\\\", "/")}";
        export default {
          description: "Escaping import.",
          inputSchema: {
            "~standard": {
              version: 1,
              vendor: "fixture",
              validate(value) { return { value }; }
            }
          },
          execute() { return { value: outside }; }
        };
      `,
      "utf8",
    );

    await expect(normalizeProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_IMPORT_UNSUPPORTED",
          source: "agent/tools/node-only.ts",
        }),
        expect.objectContaining({
          code: "MODULE_LOAD_FAILED",
          source: "agent/tools/escape-import.ts",
        }),
      ]),
    });
  });

  test("does not resolve bare imports from the compiler caller directory", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "caller dependency isolation\n",
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

    await expect(
      normalizeProject({ projectRoot: root, cwd: process.cwd() }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          source: "agent/tools/caller-zod.ts",
          code: "MODULE_LOAD_FAILED",
        }),
      ]),
    });
  });

  test("resolves dependencies installed in the selected project", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "selected dependency\n",
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

    const normalized = await normalizeProject({
      projectRoot: root,
      cwd: process.cwd(),
    });
    expect(normalized.tools[0]?.schema).toEqual({
      vendor: "selected-project",
      version: 1,
    });
  });

  test("rejects bare imports resolved from a selected project's parent", async () => {
    const container = await mkdtemp(join(tmpdir(), "eden-parent-"));
    temporaryRoots.push(container);
    const root = join(container, "project");
    await writeProject(root, {
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "parent dependency\n",
      "agent/tools/parent-dependency.ts": `
        import { inputSchema } from "parent-schema-fixture";
        export default {
          description: "Must not use a parent dependency.",
          inputSchema,
          execute(input) {
            return { value: input };
          }
        };
      `,
    });
    await mkdir(join(container, "node_modules/parent-schema-fixture"), {
      recursive: true,
    });
    await writeFile(
      join(container, "node_modules/parent-schema-fixture/package.json"),
      JSON.stringify({
        name: "parent-schema-fixture",
        type: "module",
        exports: "./index.js",
      }),
      "utf8",
    );
    await writeFile(
      join(container, "node_modules/parent-schema-fixture/index.js"),
      `
        export const inputSchema = {
          "~standard": {
            version: 1,
            vendor: "parent-project",
            validate(value) { return { value }; }
          }
        };
      `,
      "utf8",
    );

    await expect(normalizeProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          source: "agent/tools/parent-dependency.ts",
          code: "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
        }),
      ]),
    });
  });

  test("attributes transitive dependency escapes to the authored import source", async () => {
    const container = await mkdtemp(join(tmpdir(), "eden-transitive-parent-"));
    temporaryRoots.push(container);
    const root = join(container, "project");
    await writeProject(root, {
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "transitive dependency\n",
      "agent/tools/transitive-dependency.ts": `
        import { inputSchema } from "selected-schema-fixture";
        export default {
          description: "Uses a transitive dependency.",
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
        import { escapedValue } from "outside-schema-fixture";
        export const inputSchema = {
          "~standard": {
            version: 1,
            vendor: escapedValue,
            validate(value) { return { value }; }
          }
        };
      `,
    });
    await writeProject(join(container, "node_modules/outside-schema-fixture"), {
      "package.json": JSON.stringify({
        name: "outside-schema-fixture",
        type: "module",
        exports: "./index.js",
      }),
      "index.js": "export const escapedValue = 'outside';\n",
    });

    await expect(normalizeProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_DEPENDENCY_OUTSIDE_PROJECT",
          source: "agent/tools/transitive-dependency.ts",
          message: expect.stringContaining("selected project"),
        }),
      ]),
    });
  });

  test("normalizes the checked-in Zod-authored example tool", async () => {
    const normalized = await normalizeProject(
      join(process.cwd(), "examples/basic-agent"),
    );

    expect(normalized.agent.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(normalized.tools.map((tool) => tool.name)).toEqual(["greet"]);
    expect(normalized.tools[0]?.schema).toEqual({ vendor: "zod", version: 1 });
    await expect(
      validateStandardSchema(normalized.tools[0]?.inputSchema as never, {
        name: "  Eden  ",
      }),
    ).resolves.toEqual({ name: "Eden" });
  });
});

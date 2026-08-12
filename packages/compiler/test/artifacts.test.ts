import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { EdenArtifactSet } from "@eden/definitions";

import {
  EdenCompilerError,
  buildProject,
  createArtifactIdentity,
  readArtifactGeneration,
} from "../src/index.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const artifactNames = [
  "discovery.json",
  "diagnostics.json",
  "manifest.json",
  "module-map.json",
  "agent-bundle.mjs",
  "build-metadata.json",
] as const;

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
  const generation = await readArtifactGeneration(outputDirectory);
  return {
    directory: generation.directory,
    ...generation.artifacts,
  };
}

type JsonPathSegment = string | number;

function setJsonPath(
  value: unknown,
  path: readonly JsonPathSegment[],
  replacement: unknown,
): void {
  if (path.length === 0) {
    throw new Error("A JSON mutation path must not be empty.");
  }
  let cursor = value;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    const isLast = index === path.length - 1;
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) {
        throw new Error("A JSON mutation path expected an array.");
      }
      if (isLast) {
        cursor[segment] = replacement;
      } else {
        cursor = cursor[segment];
      }
      continue;
    }
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      Array.isArray(cursor)
    ) {
      throw new Error("A JSON mutation path expected an object.");
    }
    const record = cursor as Record<string, unknown>;
    if (isLast) {
      record[segment] = replacement;
    } else {
      cursor = record[segment];
    }
  }
}

function deleteJsonPath(
  value: unknown,
  path: readonly JsonPathSegment[],
): void {
  if (path.length === 0) {
    throw new Error("A JSON mutation path must not be empty.");
  }
  let cursor = value;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) {
        throw new Error("A JSON mutation path expected an array.");
      }
      cursor = cursor[segment];
    } else {
      if (
        typeof cursor !== "object" ||
        cursor === null ||
        Array.isArray(cursor)
      ) {
        throw new Error("A JSON mutation path expected an object.");
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  const finalSegment = path[path.length - 1];
  if (typeof finalSegment === "number") {
    if (!Array.isArray(cursor)) {
      throw new Error("A JSON mutation path expected an array.");
    }
    cursor.splice(finalSegment, 1);
  } else {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      Array.isArray(cursor)
    ) {
      throw new Error("A JSON mutation path expected an object.");
    }
    delete (cursor as Record<string, unknown>)[finalSegment];
  }
}

function diagnosticRecordWith(
  field: string,
  replacement: unknown,
): (value: unknown) => unknown {
  return (value) => {
    if (!Array.isArray(value)) {
      throw new Error("Diagnostic corruption fixtures require an array.");
    }
    value[0] = {
      code: "FIXTURE_DIAGNOSTIC",
      message: "fixture diagnostic",
      severity: "warning",
      [field]: replacement,
    };
    return value;
  };
}

function mutateJsonDocument(
  contents: string,
  mutate: (value: unknown) => unknown,
): string {
  return JSON.stringify(mutate(JSON.parse(contents)));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function replaceBundleCoherently(
  contents: Record<(typeof artifactNames)[number], string>,
  bundle: string,
): Record<(typeof artifactNames)[number], string> {
  const manifest = {
    ...(JSON.parse(contents["manifest.json"]) as Record<string, unknown>),
    bundleDigest: sha256Text(bundle),
  };
  const moduleMap = JSON.parse(contents["module-map.json"]) as EdenArtifactSet["moduleMap"];
  const buildMetadata = {
    ...(JSON.parse(contents["build-metadata.json"]) as Record<string, unknown>),
    bundleDigest: sha256Text(bundle),
    generationId: createArtifactIdentity({
      manifest: manifest as EdenArtifactSet["manifest"],
      moduleMap,
      bundle,
    }),
  };
  return {
    ...contents,
    "manifest.json": JSON.stringify(manifest),
    "agent-bundle.mjs": bundle,
    "build-metadata.json": JSON.stringify(buildMetadata),
  };
}

function replaceBundleDefault(
  bundle: string,
  expression: string,
  declarations = "",
): string {
  const marker =
    "var eden_artifact_entry_default = Object.freeze({ agent, instructions, tools, toolSchemas, moduleMap });";
  expect(bundle).toContain(marker);
  return bundle.replace(
    marker,
    `${declarations}\nvar eden_artifact_entry_default = ${expression};`,
  );
}

const closedBundleGrammarCases = [
  {
    name: "unknown object spread",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "Object.freeze({ agent, instructions, tools, toolSchemas, moduleMap, ...unknownOverride })",
        'const unknownOverride = globalThis["edenRuntimeOverride"];',
      ),
  },
  {
    name: "computed object key",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "Object.freeze({ agent, instructions, tools, toolSchemas, moduleMap, [computedKey]: null })",
        'const computedKey = "unvalidated";',
      ),
  },
  {
    name: "post-construction mutation",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "edenArtifact",
        `const edenArtifact = { agent, instructions, tools, toolSchemas, moduleMap };
edenArtifact.agent.model = "tampered-after-construction";`,
      ),
  },
  {
    name: "class execute callable",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "Object.freeze({ agent, instructions, tools: classTools, toolSchemas, moduleMap })",
        `const classTools = Object.freeze(Object.fromEntries([
  ["greet", {
    description: "Greet a person.",
    inputSchema: {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate(value) { return { value }; }
      }
    },
    execute: class Execute {}
  }]
]));`,
      ),
  },
  {
    name: "class Standard Schema validate callable",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "Object.freeze({ agent, instructions, tools: classValidateTools, toolSchemas, moduleMap })",
        `const classValidateTools = Object.freeze(Object.fromEntries([
  ["greet", {
    description: "Greet a person.",
    inputSchema: {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: class Validate {}
      }
    },
    execute(input) { return input; }
  }]
]));`,
      ),
  },
  {
    name: "unverified schema factory",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "Object.freeze({ agent, instructions, tools: forgedTools, toolSchemas, moduleMap })",
        `const forged_exports = {
  object() {
    return {
      "~standard": {
        version: 1,
        vendor: "forged",
        validate(value) { return { value }; }
      }
    };
  }
};
const forgedTools = Object.freeze(Object.fromEntries([
  ["greet", {
    description: "Greet a person.",
    inputSchema: forged_exports.object({}),
    execute(input) { return input; }
  }]
]));`,
      ),
  },
  {
    name: "positive Infinity in JSON metadata",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "Object.freeze({ agent, instructions, tools, toolSchemas: nonFiniteSchemas, moduleMap })",
        `const nonFinite = 1e999;
const nonFiniteSchemas = Object.freeze(Object.fromEntries([
  ["greet", { type: "object", minimum: nonFinite }]
]));`,
      ),
  },
  {
    name: "negative Infinity in JSON metadata",
    mutate: (bundle: string) =>
      replaceBundleDefault(
        bundle,
        "Object.freeze({ agent, instructions, tools, toolSchemas: nonFiniteSchemas, moduleMap })",
        `const nonFinite = -1e999;
const nonFiniteSchemas = Object.freeze(Object.fromEntries([
  ["greet", { type: "object", minimum: nonFinite }]
]));`,
      ),
  },
] as const;

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
      `${generation.directory}/agent-bundle.mjs?artifact-only`
    );
    const artifact = bundle.default as {
      agent: {
        model: string;
        options: { maxOutputTokens: number; thinking: boolean };
      };
      instructions: string;
      toolSchemas: Record<string, unknown>;
      tools: Record<
        string,
        {
          description: string;
          inputSchema: {
            "~standard": {
              version: number;
              vendor: string;
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

    expect(artifact.agent).toEqual({
      model: "@cf/zai-org/glm-4.7-flash",
      options: { maxOutputTokens: 512, thinking: false },
    });
    expect(artifact.instructions).toBe("# Artifact fixture\n");
    expect(artifact.tools.greet).toMatchObject({
      description: "Greet a person.",
      execute: expect.any(Function),
    });
    expect(artifact.tools.greet.inputSchema["~standard"]).toMatchObject({
      version: 1,
      vendor: "fixture",
      validate: expect.any(Function),
    });
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

  test("rejects a coherent but runtime-invalid bundle before legacy migration", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "runtime bundle legacy fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const previous = await readArtifactGeneration(join(root, ".eden"));
    const legacyContents = Object.fromEntries(
      await Promise.all(
        artifactNames.map(async (name) => [
          name,
          await readFile(join(previous.directory, name), "utf8"),
        ] as const),
      ),
    ) as Record<(typeof artifactNames)[number], string>;
    const invalidContents = replaceBundleCoherently(
      legacyContents,
      "export default null; /* agent:default instructions:default tool:greet */\n",
    );

    await rm(join(root, ".eden"), { recursive: true, force: true });
    await mkdir(join(root, ".eden"), { recursive: true });
    await Promise.all(
      artifactNames.map((name) =>
        writeFile(join(root, ".eden", name), invalidContents[name], "utf8"),
      ),
    );

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      name: "EdenCompilerError",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OUTPUT_INVALID" }),
      ]),
    } satisfies Partial<EdenCompilerError>);
    await expect(lstat(join(root, ".eden", "CURRENT"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(join(root, ".eden", "generations"))).resolves.toEqual(
      [],
    );
  });

  test("rejects a runtime-invalid CURRENT bundle through authoritative reads", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "runtime bundle reader fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const current = await readArtifactGeneration(join(root, ".eden"));
    const contents = Object.fromEntries(
      await Promise.all(
        artifactNames.map(async (name) => [
          name,
          await readFile(join(current.directory, name), "utf8"),
        ] as const),
      ),
    ) as Record<(typeof artifactNames)[number], string>;
    const invalidContents = replaceBundleCoherently(
      contents,
      "export default { agent: null, instructions: [], tools: null, toolSchemas: null }; /* agent:default instructions:default tool:greet */\n",
    );
    await Promise.all(
      artifactNames.map((name) =>
        writeFile(join(current.directory, name), invalidContents[name], "utf8"),
      ),
    );

    await expect(readArtifactGeneration(join(root, ".eden"))).rejects.toMatchObject({
      name: "EdenCompilerError",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OUTPUT_INVALID" }),
      ]),
    } satisfies Partial<EdenCompilerError>);
  });

  test("rejects a runtime-invalid same-identity candidate before CURRENT promotion", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "runtime bundle reuse fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const previous = await readArtifactGeneration(join(root, ".eden"));
    await writeFile(
      join(root, "agent/tools/greet.ts"),
      toolSource.replace("Greet a person.", "runtime-invalid candidate"),
      "utf8",
    );
    await expect(
      buildProject({
        projectRoot: root,
        hooks: {
          onPublicationBoundary: (boundary) => {
            if (boundary === "before-current-promotion") {
              throw new Error("leave runtime-invalid candidate uncurrent");
            }
          },
        },
      }),
    ).rejects.toThrow("leave runtime-invalid candidate uncurrent");

    const candidateId = (
      await readdir(join(root, ".eden", "generations"))
    ).find(
      (name) =>
        name.startsWith("gen_") &&
        name !== previous.artifacts.buildMetadata.generationId,
    );
    expect(candidateId).toBeDefined();
    const candidateDirectory = join(
      root,
      ".eden",
      "generations",
      candidateId as string,
    );
    const candidateContents = Object.fromEntries(
      await Promise.all(
        artifactNames.map(async (name) => [
          name,
          await readFile(join(candidateDirectory, name), "utf8"),
        ] as const),
      ),
    ) as Record<(typeof artifactNames)[number], string>;
    const invalidContents = replaceBundleCoherently(
      candidateContents,
      "export default null; /* agent:default instructions:default tool:greet */\n",
    );
    await Promise.all(
      artifactNames.map((name) =>
        writeFile(join(candidateDirectory, name), invalidContents[name], "utf8"),
      ),
    );

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      name: "EdenCompilerError",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OUTPUT_INVALID" }),
      ]),
    } satisfies Partial<EdenCompilerError>);
    const after = await readArtifactGeneration(join(root, ".eden"));
    expect(after.artifacts.buildMetadata.generationId).toBe(
      previous.artifacts.buildMetadata.generationId,
    );
    expect(after.artifacts.bundle).toBe(previous.artifacts.bundle);
  });

  test.each(closedBundleGrammarCases)(
    "rejects $name through authoritative reads",
    async ({ mutate }) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "closed bundle grammar reader fixture\n",
        "agent/tools/greet.ts": toolSource,
      });

      await buildProject({ projectRoot: root });
      const current = await readArtifactGeneration(join(root, ".eden"));
      const contents = Object.fromEntries(
        await Promise.all(
          artifactNames.map(async (name) => [
            name,
            await readFile(join(current.directory, name), "utf8"),
          ] as const),
        ),
      ) as Record<(typeof artifactNames)[number], string>;
      const invalidContents = replaceBundleCoherently(
        contents,
        mutate(contents["agent-bundle.mjs"]),
      );
      await Promise.all(
        artifactNames.map((name) =>
          writeFile(join(current.directory, name), invalidContents[name], "utf8"),
        ),
      );

      await expect(readArtifactGeneration(join(root, ".eden"))).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "OUTPUT_INVALID" }),
        ]),
      } satisfies Partial<EdenCompilerError>);
    },
  );

  test.each(closedBundleGrammarCases)(
    "rejects $name through legacy migration",
    async ({ mutate }) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "closed bundle grammar legacy fixture\n",
        "agent/tools/greet.ts": toolSource,
      });

      await buildProject({ projectRoot: root });
      const previous = await readArtifactGeneration(join(root, ".eden"));
      const contents = Object.fromEntries(
        await Promise.all(
          artifactNames.map(async (name) => [
            name,
            await readFile(join(previous.directory, name), "utf8"),
          ] as const),
        ),
      ) as Record<(typeof artifactNames)[number], string>;
      const invalidContents = replaceBundleCoherently(
        contents,
        mutate(contents["agent-bundle.mjs"]),
      );

      await rm(join(root, ".eden"), { recursive: true, force: true });
      await mkdir(join(root, ".eden"), { recursive: true });
      await Promise.all(
        artifactNames.map((name) =>
          writeFile(join(root, ".eden", name), invalidContents[name], "utf8"),
        ),
      );
      expect(
        await lstat(join(root, ".eden", "CURRENT")).catch(() => undefined),
      ).toBeUndefined();

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "OUTPUT_INVALID" }),
        ]),
      } satisfies Partial<EdenCompilerError>);
      await expect(lstat(join(root, ".eden", "CURRENT"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test.each(closedBundleGrammarCases)(
    "rejects $name from a same-identity candidate before CURRENT promotion",
    async ({ mutate }) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "closed bundle grammar reuse fixture\n",
        "agent/tools/greet.ts": toolSource,
      });

      await buildProject({ projectRoot: root });
      const previous = await readArtifactGeneration(join(root, ".eden"));
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        toolSource.replace("Greet a person.", "new generation"),
        "utf8",
      );
      await expect(
        buildProject({
          projectRoot: root,
          hooks: {
            onPublicationBoundary: (boundary) => {
              if (boundary === "before-current-promotion") {
                throw new Error("leave closed grammar candidate uncurrent");
              }
            },
          },
        }),
      ).rejects.toThrow("leave closed grammar candidate uncurrent");

      const generationNames = await readdir(join(root, ".eden", "generations"));
      const candidateId = generationNames.find(
        (name) =>
          name.startsWith("gen_") &&
          name !== previous.artifacts.buildMetadata.generationId,
      );
      expect(candidateId).toBeDefined();
      const candidateDirectory = join(
        root,
        ".eden",
        "generations",
        candidateId as string,
      );
      const contents = Object.fromEntries(
        await Promise.all(
          artifactNames.map(async (name) => [
            name,
            await readFile(join(candidateDirectory, name), "utf8"),
          ] as const),
        ),
      ) as Record<(typeof artifactNames)[number], string>;
      const invalidContents = replaceBundleCoherently(
        contents,
        mutate(contents["agent-bundle.mjs"]),
      );
      await Promise.all(
        artifactNames.map((name) =>
          writeFile(join(candidateDirectory, name), invalidContents[name], "utf8"),
        ),
      );

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "OUTPUT_INVALID" }),
        ]),
      } satisfies Partial<EdenCompilerError>);
      const after = await readArtifactGeneration(join(root, ".eden"));
      expect(after.artifacts.buildMetadata.generationId).toBe(
        previous.artifacts.buildMetadata.generationId,
      );
    },
  );

  test("keeps a resolved generation stable when CURRENT flips during reads", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Stable reader fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const first = await readArtifactGeneration(join(root, ".eden"));

    await writeFile(
      join(root, "agent/tools/greet.ts"),
      toolSource.replace("Greet a person.", "Second generation."),
      "utf8",
    );
    await buildProject({ projectRoot: root });
    const second = await readArtifactGeneration(join(root, ".eden"));
    expect(second.directory).not.toBe(first.directory);

    const currentPointer = join(root, ".eden", "CURRENT");
    const outputRoot = await realpath(join(root, ".eden"));
    await rm(currentPointer, { force: true });
    await symlink(
      relative(outputRoot, first.directory),
      currentPointer,
    );
    for (const artifactName of [
      "discovery.json",
      "diagnostics.json",
      "manifest.json",
      "module-map.json",
      "agent-bundle.mjs",
      "build-metadata.json",
    ]) {
      const alias = join(outputRoot, artifactName);
      await rm(alias, { force: true });
      await symlink(
        relative(outputRoot, join(second.directory, artifactName)),
        alias,
      );
    }

    const resolved = await readArtifactGeneration(join(root, ".eden"), {
      afterCurrentResolution: async () => {
        await rm(currentPointer, { force: true });
        await symlink(
          relative(outputRoot, second.directory),
          currentPointer,
        );
      },
    });

    expect(resolved.directory).toBe(first.directory);
    expect(resolved.artifacts.buildMetadata.generationId).toBe(
      first.artifacts.buildMetadata.generationId,
    );
    expect(resolved.artifacts.manifest.tools[0]?.description).toBe(
      "Greet a person.",
    );
    expect(resolved.artifacts.bundle).toContain("Greet a person.");
    expect(resolved.artifacts.bundle).not.toContain("Second generation.");
  });

  test("validates and migrates a coherent legacy set before creating CURRENT", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "legacy migration fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const previous = await readArtifactGeneration(join(root, ".eden"));
    const legacyContents = await Promise.all(
      artifactNames.map(async (name) => [
        name,
        await readFile(join(previous.directory, name)),
      ] as const),
    );
    await rm(join(root, ".eden"), { recursive: true, force: true });
    await mkdir(join(root, ".eden"), { recursive: true });
    await Promise.all(
      legacyContents.map(([name, contents]) =>
        writeFile(join(root, ".eden", name), contents),
      ),
    );

    let currentAtStageBoundary: boolean | undefined;
    await buildProject({
      projectRoot: root,
      hooks: {
        onPublicationBoundary: async (boundary) => {
          if (boundary !== "before-stage-write") return;
          currentAtStageBoundary =
            await lstat(join(root, ".eden", "CURRENT"))
              .then(() => true)
              .catch(() => false);
        },
      },
    });

    expect(currentAtStageBoundary).toBe(false);
    const migrated = await readArtifactGeneration(join(root, ".eden"));
    expect(migrated.artifacts.buildMetadata.generationId).toBe(
      previous.artifacts.buildMetadata.generationId,
    );
    expect(migrated.directory).toBe(
      await realpath(
        join(
          root,
          ".eden",
          "generations",
          previous.artifacts.buildMetadata.generationId,
        ),
      ),
    );
  });

  test.each(artifactNames)(
    "rejects a legacy set missing %s before creating CURRENT",
    async (missingArtifact) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "legacy incomplete fixture\n",
        "agent/tools/greet.ts": toolSource,
      });

      await buildProject({ projectRoot: root });
      const previous = await readArtifactGeneration(join(root, ".eden"));
      const legacyContents = await Promise.all(
        artifactNames.map(async (name) => [
          name,
          await readFile(join(previous.directory, name)),
        ] as const),
      );
      await rm(join(root, ".eden"), { recursive: true, force: true });
      await mkdir(join(root, ".eden"), { recursive: true });
      await Promise.all(
        artifactNames
          .filter((name) => name !== missingArtifact)
          .map((name) =>
            writeFile(
              join(root, ".eden", name),
              legacyContents.find(([candidate]) => candidate === name)?.[1] ??
                new Uint8Array(),
            ),
          ),
      );

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "OUTPUT_INVALID" }),
        ]),
      } satisfies Partial<EdenCompilerError>);
      await expect(
        lstat(join(root, ".eden", "CURRENT")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readdir(join(root, ".eden", "generations")),
      ).resolves.toEqual([]);
      for (const name of artifactNames) {
        const details = await lstat(join(root, ".eden", name)).catch(
          () => undefined,
        );
        expect(details?.isSymbolicLink() ?? false).toBe(false);
      }
    },
  );

  test.each(artifactNames)(
    "rejects a legacy set with tampered %s before creating CURRENT",
    async (tamperedArtifact) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "legacy tamper fixture\n",
        "agent/tools/greet.ts": toolSource,
      });

      await buildProject({ projectRoot: root });
      const previous = await readArtifactGeneration(join(root, ".eden"));
      const legacyContents = await Promise.all(
        artifactNames.map(async (name) => [
          name,
          await readFile(join(previous.directory, name)),
        ] as const),
      );
      await rm(join(root, ".eden"), { recursive: true, force: true });
      await mkdir(join(root, ".eden"), { recursive: true });
      await Promise.all(
        artifactNames.map(async (name) => {
          const contents =
            name === tamperedArtifact
              ? name === "agent-bundle.mjs"
                ? Buffer.from("tampered bundle", "utf8")
                : Buffer.from("{}", "utf8")
              : legacyContents.find(([candidate]) => candidate === name)?.[1] ??
                new Uint8Array();
          await writeFile(join(root, ".eden", name), contents);
        }),
      );

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.stringMatching(/^(?:OUTPUT_INVALID|ARTIFACT_)/u),
          }),
        ]),
      } satisfies Partial<EdenCompilerError>);
      await expect(
        lstat(join(root, ".eden", "CURRENT")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readdir(join(root, ".eden", "generations")),
      ).resolves.toEqual([]);
      for (const name of artifactNames) {
        const details = await lstat(join(root, ".eden", name)).catch(
          () => undefined,
        );
        expect(details?.isSymbolicLink() ?? false).toBe(false);
      }
    },
  );

  test("repairs every stale compatibility alias to the exact current regular file", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "alias repair fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const first = await readArtifactGeneration(join(root, ".eden"));
    await writeFile(
      join(root, "agent/tools/greet.ts"),
      toolSource.replace("Greet a person.", "Second generation."),
      "utf8",
    );
    await buildProject({ projectRoot: root });
    const second = await readArtifactGeneration(join(root, ".eden"));
    expect(second.directory).not.toBe(first.directory);

    const outputRoot = await realpath(join(root, ".eden"));
    for (const name of artifactNames) {
      const alias = join(outputRoot, name);
      await rm(alias, { force: true });
      await symlink(
        relative(outputRoot, join(first.directory, name)),
        alias,
      );
    }

    await buildProject({ projectRoot: root });

    for (const name of artifactNames) {
      const alias = join(outputRoot, name);
      await expect(readlink(alias)).resolves.toBe(join("CURRENT", name));
      await expect(realpath(alias)).resolves.toBe(
        join(second.directory, name),
      );
      await expect(lstat(await realpath(alias))).resolves.toSatisfy(
        (details) => details.isFile() && !details.isSymbolicLink(),
      );
    }
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

  test.each([
    "discovery.json",
    "diagnostics.json",
    "manifest.json",
    "module-map.json",
    "agent-bundle.mjs",
    "build-metadata.json",
  ])(
    "does not reuse a same-identity generation missing %s",
    async (missingArtifact) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "generation reuse fixture\n",
        "agent/tools/greet.ts": toolSource,
      });

      await buildProject({ projectRoot: root });
      const before = await readGeneration(root);
      await writeFile(
        join(root, "agent/tools/greet.ts"),
        toolSource.replace("Greet a person.", "Second generation."),
        "utf8",
      );

      await expect(
        buildProject({
          projectRoot: root,
          hooks: {
            onPublicationBoundary: (boundary) => {
              if (boundary === "before-current-promotion") {
                throw new Error("leave second generation uncurrent");
              }
            },
          },
        }),
      ).rejects.toThrow("leave second generation uncurrent");

      const generationNames = await readdir(
        join(root, ".eden", "generations"),
      );
      const candidate = generationNames.find(
        (name) =>
          name.startsWith("gen_") &&
          name !== before.buildMetadata.generationId,
      );
      expect(candidate).toBeDefined();
      await rm(
        join(root, ".eden", "generations", candidate as string, missingArtifact),
        { force: true },
      );

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "OUTPUT_INVALID" }),
        ]),
      } satisfies Partial<EdenCompilerError>);

      const after = await readGeneration(root);
      expect(after.bundle).toBe(before.bundle);
      expect(after.manifest).toEqual(before.manifest);
      expect(after.moduleMap).toEqual(before.moduleMap);
      expect(after.buildMetadata).toEqual(before.buildMetadata);
    },
  );

  test("rejects tampered discovery metadata before reusing a generation", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "generation coherence fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    const first = await buildProject({ projectRoot: root });
    const generationDirectory = join(
      root,
      ".eden",
      "generations",
      first.artifacts.buildMetadata.generationId,
    );
    await writeFile(
      join(generationDirectory, "discovery.json"),
      JSON.stringify({
        ...first.artifacts.discovery,
        agent: {
          ...first.artifacts.discovery.agent,
          relativePath: "agent/tampered.ts",
        },
      }),
      "utf8",
    );

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      name: "EdenCompilerError",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "OUTPUT_INVALID",
        }),
      ]),
    } satisfies Partial<EdenCompilerError>);
  });

  test.each([
    "generations",
    join("generations", "pre-existing-escape"),
  ])(
    "fails closed for a pre-existing symlinked generated path: %s",
    async (relativePath) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "symlink publication fixture\n",
        "agent/tools/greet.ts": toolSource,
      });
      const outside = await mkdtemp(join(tmpdir(), "eden-publish-outside-"));
      temporaryRoots.push(outside);
      await mkdir(join(root, ".eden"), { recursive: true });
      if (relativePath.includes("/")) {
        await mkdir(join(root, ".eden", "generations"), {
          recursive: true,
        });
      }
      await symlink(
        outside,
        join(root, ".eden", relativePath),
        "dir",
      );

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.stringMatching(/OUTPUT_(?:INVALID|OUTSIDE_PROJECT)/u),
          }),
        ]),
      } satisfies Partial<EdenCompilerError>);

      await expect(readdir(outside)).resolves.toEqual([]);
      await expect(
        readFile(join(root, ".eden", "CURRENT"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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
      readArtifactGeneration(join(root, ".eden")),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OUTPUT_INVALID" }),
      ]),
    });
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
          const fetcher = globalThis.fetch;
          const dynamicSafeProperty = "fetch";
          const safeFetcher = globalThis[dynamicSafeProperty];
          return {
            greeting: String(values.length + argumentCount),
            workerGlobals: [
              typeof TextEncoder,
              typeof Request,
              typeof Response,
              typeof crypto,
              typeof fetch,
              typeof globalThis,
              typeof fetcher,
              typeof safeFetcher,
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

  test.each([
    [
      "globalThis alias",
      `
        const runtime = globalThis;
        export default {
          description: "Global alias.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: runtime.EDEN_API_KEY ?? input.name }; }
        };
      `,
    ],
    [
      "self destructuring",
      `
        const { EDEN_API_KEY: apiKey } = self;
        export default {
          description: "Destructured global.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: apiKey ?? input.name }; }
        };
      `,
    ],
    [
      "computed global property",
      `
        const property = "EDEN_API_KEY";
        export default {
          description: "Computed global.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: globalThis[property] ?? input.name }; }
        };
      `,
    ],
    [
      "template global property",
      `
        const property = \`EDEN_\${"API_KEY"}\`;
        export default {
          description: "Template global.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: self[property] ?? input.name }; }
        };
      `,
    ],
    [
      "assigned global alias",
      `
        let runtime;
        runtime = self;
        export default {
          description: "Assigned global alias.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: runtime["EDEN_API_KEY"] ?? input.name }; }
        };
      `,
    ],
    [
      "destructuring assignment",
      `
        let apiKey;
        ({ EDEN_API_KEY: apiKey } = globalThis);
        export default {
          description: "Destructuring assignment.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: apiKey ?? input.name }; }
        };
      `,
    ],
  ])("rejects %s used to reach ambient globals", async (_name, source) => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Ambient alias fixture\n",
      "agent/tools/ambient-alias.ts": source,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/ambient-alias.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("traces awaited async and function-returned global aliases", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Awaited alias fixture\n",
      "agent/tools/awaited-alias.ts": `
        async function getGlobal() {
          return globalThis;
        }
        function getSelf() {
          return self;
        }
        export default {
          description: "Awaited and returned globals.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          async execute(input) {
            const runtime = await getGlobal();
            const worker = getSelf();
            return {
              value: runtime.EDEN_API_KEY ?? worker.EDEN_API_KEY ?? input.name,
            };
          }
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/awaited-alias.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("traces awaited returns through imported helper modules", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Imported awaited alias fixture\n",
      "agent/runtime.ts": `
        export async function getRuntime() {
          return globalThis;
        }
      `,
      "agent/tools/imported-awaited-alias.ts": `
        import { getRuntime } from "../runtime.js";
        export default {
          description: "Imported awaited global.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          async execute(input) {
            const runtime = await getRuntime();
            return { value: runtime.EDEN_API_KEY ?? input.name };
          }
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: expect.stringMatching(
            /agent\/(?:runtime|tools\/imported-awaited-alias)\.ts/u,
          ),
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("rejects ambient aliases returned by object methods and inline property calls", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Callable return fixture\n",
      "agent/tools/callable-returns.ts": `
        const objectMethod = {
          async getRuntime() {
            return globalThis;
          },
        };
        const propertyCall = {
          getRuntime: () => self,
        };
        const methodName = "getRuntime";
        export default {
          description: "Callable returns must not hide ambient aliases.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          async execute(input) {
            const fromObjectMethod = await objectMethod.getRuntime();
            const fromPropertyCall = await propertyCall.getRuntime();
            const fromComputedProperty = await propertyCall[methodName]();
            const fromInlineProperty = await (
              { getRuntime: () => globalThis }
            ).getRuntime();
            const fromInlineCall = await (async () => globalThis)();
            return {
              value:
                fromObjectMethod.EDEN_API_KEY ??
                fromPropertyCall.EDEN_API_KEY ??
                fromComputedProperty.EDEN_API_KEY ??
                fromInlineProperty.EDEN_API_KEY ??
                fromInlineCall.EDEN_API_KEY ??
                input.name,
            };
          },
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/callable-returns.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("rejects computed and destructured callable returns before publication", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Computed callable return fixture\n",
      "agent/tools/computed-callable-return.ts": `
        const methodName = "getRuntime";
        const methods = {
          [methodName]() {
            return globalThis;
          },
        };
        const { [methodName]: getRuntime } = methods;
        const runtime = getRuntime();
        export default {
          description: "Computed callable returns must remain conservative.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) {
            return { value: runtime.EDEN_API_KEY ?? input.name };
          },
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/computed-callable-return.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("rejects unresolved computed object-method returns conservatively", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Unknown computed callable fixture\n",
      "agent/tools/unknown-computed-callable.ts": `
        const helpers = {
          async getRuntime() {
            return globalThis;
          },
        };
        export default {
          description: "Unknown computed methods must not hide ambient returns.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          async execute(input) {
            const runtime = await helpers[input.name]();
            return { value: runtime.EDEN_API_KEY ?? input.name };
          },
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/unknown-computed-callable.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("rejects computed callable aliases before their ambient return is used", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Computed callable alias fixture\n",
      "agent/tools/computed-callable-alias.ts": `
        const helpers = {
          getRuntime() {
            return globalThis;
          },
        };
        export default {
          description: "Computed callable aliases must fail closed.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) {
            const getRuntime = helpers[input.name];
            const runtime = getRuntime();
            return { value: runtime.EDEN_API_KEY ?? input.name };
          },
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: "agent/tools/computed-callable-alias.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test.each([
    [
      "globalThis Reflect alias",
      `
        const reflect = globalThis.Reflect;
        const read = reflect.get(globalThis, "EDEN_API_KEY");
        export default {
          description: "Reflect aliases must preserve ambient identity.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: read ?? input.name }; },
        };
      `,
      "MODULE_AMBIENT_BINDING",
    ],
    [
      "destructured Reflect alias",
      `
        const { Reflect: reflect } = self;
        const read = reflect["get"](self, "EDEN_API_KEY");
        export default {
          description: "Destructured Reflect aliases must preserve ambient identity.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: read ?? input.name }; },
        };
      `,
      "MODULE_AMBIENT_BINDING",
    ],
    [
      "chained Reflect alias",
      `
        const get = globalThis["Reflect"]["get"];
        const create = get(globalThis, "Function");
        export default {
          description: "Chained Reflect aliases must preserve dynamic-code identity.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: create(input.name) }; },
        };
      `,
      "MODULE_DYNAMIC_CODE_UNSUPPORTED",
    ],
    [
      "computed Reflect alias",
      `
        const key = "Reflect";
        const reflect = globalThis[key];
        const read = reflect.get(globalThis, "EDEN_API_KEY");
        export default {
          description: "Computed Reflect aliases must preserve ambient identity.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: read ?? input.name }; },
        };
      `,
      "MODULE_AMBIENT_BINDING",
    ],
    [
      "chained Reflect call alias",
      `
        const reflect = Reflect.get(globalThis, "Reflect");
        const read = reflect.get(globalThis, "EDEN_API_KEY");
        export default {
          description: "Chained Reflect calls must preserve ambient identity.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: read ?? input.name }; },
        };
      `,
      "MODULE_AMBIENT_BINDING",
    ],
    [
      "Reflect get alias from destructured global",
      `
        const { Reflect: reflect } = globalThis;
        const { get } = reflect;
        const read = get(globalThis, "EDEN_API_KEY");
        export default {
          description: "Reflect get aliases from global destructuring stay reflective.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: read ?? input.name }; },
        };
      `,
      "MODULE_AMBIENT_BINDING",
    ],
    [
      "globalThis Reflect constructor chain",
      `
        const reflect = globalThis.Reflect;
        const create = reflect.get(Object, "constructor");
        export default {
          description: "Reflective constructor retrieval must fail closed.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: create(input.name) }; },
        };
      `,
      "MODULE_DYNAMIC_CODE_UNSUPPORTED",
    ],
    [
      "self Reflect constructor chain",
      `
        const reflect = self["Reflect"];
        const create = reflect["get"](Object, "constructor");
        export default {
          description: "Reflective constructor retrieval must fail closed.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: create(input.name) }; },
        };
      `,
      "MODULE_DYNAMIC_CODE_UNSUPPORTED",
    ],
    [
      "destructured Reflect constructor chain",
      `
        const { Reflect: reflect } = self;
        const { get } = reflect;
        const create = get(Object, "constructor");
        export default {
          description: "Destructured reflective constructor retrieval must fail closed.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) { return { value: create(input.name) }; },
        };
      `,
      "MODULE_DYNAMIC_CODE_UNSUPPORTED",
    ],
  ])("rejects %s reflective identity bypasses", async (_name, source, code) => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Reflect alias fixture\n",
      "agent/tools/reflect-alias.ts": source,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code,
          source: "agent/tools/reflect-alias.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("rejects computed and reflective dynamic Function constructor retrieval", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Reflective constructor fixture\n",
      "agent/tools/reflective-constructor.ts": toolSource.replace(
        'execute(input) {\n      return { greeting: "Hello " + input.name };\n    }',
        `
          execute(input) {
            const computed = Object[input.name];
            const reflected = Reflect.get(Object, input.name);
            const bracketed = Reflect["get"](Object, input.name);
            return {
              value:
                computed(input.name) ||
                reflected(input.name) ||
                bracketed(input.name),
            };
          }
        `,
      ),
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_DYNAMIC_CODE_UNSUPPORTED",
          source: "agent/tools/reflective-constructor.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test.each([
    [
      "Object.constructor",
      `execute(input) { return { value: Object.constructor(input.name) }; }`,
    ],
    [
      "globalThis Object constructor chain",
      `execute(input) { return { value: globalThis.Object.constructor(input.name) }; }`,
    ],
    [
      "aliased Object constructor chain",
      `
        execute(input) {
          const object = Object;
          const create = object.constructor;
          return { value: create(input.name) };
        }
      `,
    ],
    [
      "computed Object constructor chain",
      `
        execute(input) {
          const create = globalThis["Object"]["constructor"];
          return { value: create(input.name) };
        }
      `,
    ],
  ])("rejects %s dynamic code construction", async (_name, executeSource) => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Constructor chain fixture\n",
      "agent/tools/constructor-chain.ts": toolSource.replace(
        'execute(input) {\n      return { greeting: "Hello " + input.name };\n    }',
        executeSource,
      ),
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_DYNAMIC_CODE_UNSUPPORTED",
          source: "agent/tools/constructor-chain.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test.each(["globalThis", "self"])(
    "rejects unknown properties on %s",
    async (globalName) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "Unknown global property fixture\n",
        "agent/tools/unknown-global-property.ts": toolSource.replace(
          'return { greeting: "Hello " + input.name };',
          `return { greeting: ${globalName}.EDEN_UNSUPPORTED_PROPERTY ?? input.name };`,
        ),
      });

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "MODULE_AMBIENT_BINDING",
            source: "agent/tools/unknown-global-property.ts",
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        ]),
      });
    },
  );

  test.each([
    [
      "direct eval",
      `execute(input) { return { value: eval(input.name) }; }`,
    ],
    [
      "indirect eval alias",
      `execute(input) { const run = eval; return { value: run(input.name) }; }`,
    ],
    [
      "globalThis eval",
      `execute(input) { return { value: globalThis["eval"](input.name) }; }`,
    ],
    [
      "Function constructor",
      `execute(input) { const create = Function; return { value: create(input.name) }; }`,
    ],
    [
      "new Function constructor",
      `execute(input) { return { value: new Function(input.name)() }; }`,
    ],
    [
      "destructured Function constructor",
      `execute(input) { const { Function: create } = self; return { value: create(input.name) }; }`,
    ],
  ])("rejects %s before publication", async (_name, executeSource) => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Dynamic code fixture\n",
      "agent/tools/dynamic-code.ts": toolSource.replace(
        'execute(input) {\n      return { greeting: "Hello " + input.name };\n    }',
        executeSource,
      ),
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_DYNAMIC_CODE_UNSUPPORTED",
          source: "agent/tools/dynamic-code.ts",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("accepts legitimate WebAssembly usage", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "WebAssembly fixture\n",
      "agent/tools/wasm.ts": toolSource.replace(
        'return { greeting: "Hello " + input.name };',
        `
          const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
          const module = new WebAssembly.Module(bytes);
          return { greeting: String(module instanceof WebAssembly.Module) };
        `,
      ),
    });

    const result = await buildProject({ projectRoot: root });
    expect(result.artifacts.manifest.tools).toEqual([
      expect.objectContaining({ name: "wasm" }),
    ]);
  });

  test("follows ambient aliases through authored helper modules", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Cross-module ambient fixture\n",
      "agent/runtime.ts": `
        export const runtime = globalThis;
        export const getRuntime = () => self;
      `,
      "agent/tools/cross-module.ts": `
        import { getRuntime, runtime } from "../runtime.js";
        const read = () => getRuntime()[\`EDEN_\${"API_KEY"}\`];
        export default {
          description: "Cross-module ambient access.",
          inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
          execute(input) {
            const { EDEN_API_KEY: apiKey } = runtime;
            return { value: apiKey ?? read() ?? input.name };
          }
        };
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_AMBIENT_BINDING",
          source: expect.stringMatching(/agent\/(?:runtime|tools\/cross-module)\.ts/u),
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("ignores blocked-looking strings and comments", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "False-positive fixture\n",
      "agent/tools/strings-comments.ts": toolSource.replace(
        'return { greeting: "Hello " + input.name };',
        `
          // globalThis.EDEN_API_KEY self["TOKEN"] process.env.SECRET eval Function
          const blockedText = "globalThis.EDEN_API_KEY self['TOKEN'] process.env.SECRET eval Function import('node:fs')";
          return { greeting: blockedText + input.name };
        `,
      ),
    });

    const result = await buildProject({ projectRoot: root });
    expect(result.artifacts.manifest.tools).toEqual([
      expect.objectContaining({ name: "strings-comments" }),
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

  test("accepts the pinned legitimate Zod dependency by verified integrity", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Pinned Zod fixture\n",
      "agent/tools/zod-valid.ts": `
        import { z } from "zod";
        export default {
          description: "Uses the pinned Zod Standard Schema implementation.",
          inputSchema: z.object({ name: z.string() }),
          execute(input) {
            return { value: input.name };
          },
        };
      `,
    });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(
      join(process.cwd(), "node_modules/zod"),
      join(root, "node_modules/zod"),
    );

    const result = await buildProject({ projectRoot: root });
    expect(result.artifacts.manifest.tools).toEqual([
      expect.objectContaining({ name: "zod-valid" }),
    ]);
  });

  test("does not trust a path-only Zod dependency exemption", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "Untrusted Zod fixture\n",
      "agent/tools/untrusted-zod.ts": `
        import { getRuntime, inputSchema } from "zod";
        export default {
          description: "A package that only pretends to be the pinned Zod.",
          inputSchema,
          async execute(input) {
            const runtime = await getRuntime();
            return { value: runtime.EDEN_API_KEY ?? input.name };
          },
        };
      `,
      "node_modules/zod/package.json": JSON.stringify({
        name: "zod",
        version: "4.4.3",
        type: "module",
        exports: "./index.js",
      }),
      "node_modules/zod/index.js": `
        export const inputSchema = {
          "~standard": {
            version: 1,
            vendor: "zod",
            validate(value) { return { value }; },
          },
        };
        export async function getRuntime() {
          return Reflect.get(globalThis, "EDEN_API_KEY");
        }
      `,
    });

    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "MODULE_DYNAMIC_CODE_UNSUPPORTED",
          source: "node_modules/zod/index.js",
          line: expect.any(Number),
          column: expect.any(Number),
        }),
      ]),
    });
  });

  test("rejects every malformed published artifact field before reuse", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "runtime artifact schema fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const previous = await readGeneration(root);
    await writeFile(
      join(root, "agent/tools/greet.ts"),
      toolSource.replace("Greet a person.", "Second generation."),
      "utf8",
    );
    await expect(
      buildProject({
        projectRoot: root,
        hooks: {
          onPublicationBoundary: (boundary) => {
            if (boundary === "before-current-promotion") {
              throw new Error("leave schema candidate uncurrent");
            }
          },
        },
      }),
    ).rejects.toThrow("leave schema candidate uncurrent");

    const generationNames = await readdir(
      join(root, ".eden", "generations"),
    );
    const candidateId = generationNames.find(
      (name) =>
        name.startsWith("gen_") &&
        name !== previous.buildMetadata.generationId,
    );
    expect(candidateId).toBeDefined();
    const candidateDirectory = join(
      root,
      ".eden",
      "generations",
      candidateId as string,
    );
    const pristine = Object.fromEntries(
      await Promise.all(
        artifactNames.map(async (name) => [
          name,
          await readFile(join(candidateDirectory, name), "utf8"),
        ] as const),
      ),
    ) as Record<(typeof artifactNames)[number], string>;

    const corruptions: readonly {
      readonly name: string;
      readonly artifact: (typeof artifactNames)[number];
      readonly mutate: (value: unknown) => unknown;
    }[] = [
      {
        name: "discovery.agent",
        artifact: "discovery.json",
        mutate: (value) => {
          setJsonPath(value, ["agent"], "not a source reference");
          return value;
        },
      },
      {
        name: "discovery.agent.relativePath",
        artifact: "discovery.json",
        mutate: (value) => {
          setJsonPath(value, ["agent", "relativePath"], 42);
          return value;
        },
      },
      {
        name: "discovery.agent.sha256",
        artifact: "discovery.json",
        mutate: (value) => {
          setJsonPath(value, ["agent", "sha256"], "bad");
          return value;
        },
      },
      {
        name: "discovery.instructions missing",
        artifact: "discovery.json",
        mutate: (value) => {
          deleteJsonPath(value, ["instructions"]);
          return value;
        },
      },
      {
        name: "discovery.tools",
        artifact: "discovery.json",
        mutate: (value) => {
          setJsonPath(value, ["tools"], {});
          return value;
        },
      },
      {
        name: "discovery.tools[0].relativePath",
        artifact: "discovery.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "relativePath"], null);
          return value;
        },
      },
      {
        name: "diagnostics root",
        artifact: "diagnostics.json",
        mutate: () => ({}),
      },
      {
        name: "diagnostics.code",
        artifact: "diagnostics.json",
        mutate: diagnosticRecordWith("code", 42),
      },
      {
        name: "diagnostics.message",
        artifact: "diagnostics.json",
        mutate: diagnosticRecordWith("message", null),
      },
      {
        name: "diagnostics.severity enum",
        artifact: "diagnostics.json",
        mutate: diagnosticRecordWith("severity", "debug"),
      },
      {
        name: "diagnostics.line range",
        artifact: "diagnostics.json",
        mutate: diagnosticRecordWith("line", 0),
      },
      {
        name: "diagnostics.column range",
        artifact: "diagnostics.json",
        mutate: diagnosticRecordWith("column", -1),
      },
      {
        name: "manifest.kind",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["kind"], "wrong");
          return value;
        },
      },
      {
        name: "manifest.version",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["version"], 1);
          return value;
        },
      },
      {
        name: "manifest.runtimeVersion",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["runtimeVersion"], null);
          return value;
        },
      },
      {
        name: "manifest.schemaVersion enum",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["schemaVersion"], 0);
          return value;
        },
      },
      {
        name: "manifest.agent missing",
        artifact: "manifest.json",
        mutate: (value) => {
          deleteJsonPath(value, ["agent"]);
          return value;
        },
      },
      {
        name: "manifest.agent.model",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["agent", "model"], 42);
          return value;
        },
      },
      {
        name: "manifest.agent.options.temperature",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["agent", "options", "temperature"], "hot");
          return value;
        },
      },
      {
        name: "manifest.instructions.content",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["instructions", "content"], 42);
          return value;
        },
      },
      {
        name: "manifest.instructions.sha256",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["instructions", "sha256"], "bad");
          return value;
        },
      },
      {
        name: "manifest.tools",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["tools"], {});
          return value;
        },
      },
      {
        name: "manifest.tool.name",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "name"], 42);
          return value;
        },
      },
      {
        name: "manifest.tool.description missing",
        artifact: "manifest.json",
        mutate: (value) => {
          deleteJsonPath(value, ["tools", 0, "description"]);
          return value;
        },
      },
      {
        name: "manifest.tool.source",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "source"], []);
          return value;
        },
      },
      {
        name: "manifest.tool.module",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "module"], false);
          return value;
        },
      },
      {
        name: "manifest.tool.schema.vendor",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "schema", "vendor"], 42);
          return value;
        },
      },
      {
        name: "manifest.tool.schema.version range",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "schema", "version"], 0);
          return value;
        },
      },
      {
        name: "manifest.bundleDigest",
        artifact: "manifest.json",
        mutate: (value) => {
          setJsonPath(value, ["bundleDigest"], "bad");
          return value;
        },
      },
      {
        name: "moduleMap.kind",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["kind"], "wrong");
          return value;
        },
      },
      {
        name: "moduleMap.version",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["version"], 1);
          return value;
        },
      },
      {
        name: "moduleMap.agent.name",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["agent", "name"], 42);
          return value;
        },
      },
      {
        name: "moduleMap.agent.module",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["agent", "module"], "wrong");
          return value;
        },
      },
      {
        name: "moduleMap.instructions missing",
        artifact: "module-map.json",
        mutate: (value) => {
          deleteJsonPath(value, ["instructions"]);
          return value;
        },
      },
      {
        name: "moduleMap.tools",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["tools"], {});
          return value;
        },
      },
      {
        name: "moduleMap.tool.name",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "name"], null);
          return value;
        },
      },
      {
        name: "moduleMap.tool.module",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "module"], 42);
          return value;
        },
      },
      {
        name: "moduleMap.tool.source",
        artifact: "module-map.json",
        mutate: (value) => {
          setJsonPath(value, ["tools", 0, "source"], "wrong");
          return value;
        },
      },
      {
        name: "bundle empty",
        artifact: "agent-bundle.mjs",
        mutate: () => "",
      },
      {
        name: "bundle syntax invalid",
        artifact: "agent-bundle.mjs",
        mutate: () => "export default {",
      },
      {
        name: "buildMetadata.generationId",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["generationId"], 42);
          return value;
        },
      },
      {
        name: "buildMetadata.createdAt",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["createdAt"], 42);
          return value;
        },
      },
      {
        name: "buildMetadata.bundleDigest",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["bundleDigest"], null);
          return value;
        },
      },
      {
        name: "buildMetadata.manifestVersion missing",
        artifact: "build-metadata.json",
        mutate: (value) => {
          deleteJsonPath(value, ["manifestVersion"]);
          return value;
        },
      },
      {
        name: "buildMetadata.runtimeVersion",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["runtimeVersion"], 42);
          return value;
        },
      },
      {
        name: "buildMetadata.agentBundleVersion",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["agentBundleVersion"], null);
          return value;
        },
      },
      {
        name: "buildMetadata.protocolVersion",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["protocolVersion"], 42);
          return value;
        },
      },
      {
        name: "buildMetadata.schemaVersion enum",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["schemaVersion"], -1);
          return value;
        },
      },
      {
        name: "buildMetadata.moduleMapDigest",
        artifact: "build-metadata.json",
        mutate: (value) => {
          setJsonPath(value, ["moduleMapDigest"], "bad");
          return value;
        },
      },
    ];

    for (const corruption of corruptions) {
      const original = pristine[corruption.artifact];
      const mutated =
        corruption.artifact === "agent-bundle.mjs"
          ? corruption.mutate(original)
          : mutateJsonDocument(original, corruption.mutate);
      await writeFile(
        join(candidateDirectory, corruption.artifact),
        mutated,
        "utf8",
      );

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        name: "EdenCompilerError",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: expect.stringMatching(
              /^(?:OUTPUT_INVALID|ARTIFACT_|PUBLISHED_)/u,
            ),
          }),
        ]),
      } satisfies Partial<EdenCompilerError>);

      const current = await readGeneration(root);
      expect(current.buildMetadata.generationId, corruption.name).toBe(
        previous.buildMetadata.generationId,
      );
      expect(current.bundle, corruption.name).toBe(previous.bundle);
      await writeFile(
        join(candidateDirectory, corruption.artifact),
        original,
        "utf8",
      );
    }
  });

  test("accepts valid warning and info diagnostics during migration and reuse", async () => {
    const root = await createProject({
      "agent/agent.ts": agentSource,
      "agent/instructions.md": "diagnostic metadata fixture\n",
      "agent/tools/greet.ts": toolSource,
    });

    await buildProject({ projectRoot: root });
    const previous = await readGeneration(root);
    const warningAndInfo = [
      {
        code: "FIXTURE_WARNING",
        message: "A non-fatal warning is inspectable metadata.",
        source: "agent/tools/greet.ts",
        line: 1,
        column: 1,
        severity: "warning",
      },
      {
        code: "FIXTURE_INFO",
        message: "A non-fatal info record is inspectable metadata.",
        severity: "info",
      },
    ];
    const legacyContents = await Promise.all(
      artifactNames.map(async (name) => [
        name,
        name === "diagnostics.json"
          ? JSON.stringify(warningAndInfo)
          : await readFile(join(previous.directory, name), "utf8"),
      ] as const),
    );
    await rm(join(root, ".eden"), { recursive: true, force: true });
    await mkdir(join(root, ".eden"), { recursive: true });
    await Promise.all(
      legacyContents.map(([name, contents]) =>
        writeFile(join(root, ".eden", name), contents, "utf8"),
      ),
    );

    await expect(buildProject({ projectRoot: root })).resolves.toBeDefined();
    const migrated = await readGeneration(root);
    expect(migrated.diagnostics).toEqual(warningAndInfo);

    await expect(buildProject({ projectRoot: root })).resolves.toBeDefined();
    const reused = await readGeneration(root);
    expect(reused.diagnostics).toEqual(warningAndInfo);

    await writeFile(
      join(reused.directory, "diagnostics.json"),
      JSON.stringify([
        {
          code: "FIXTURE_ERROR",
          message: "An error diagnostic blocks publication.",
          severity: "error",
        },
      ]),
      "utf8",
    );
    await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
      name: "EdenCompilerError",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "OUTPUT_INVALID" }),
      ]),
    } satisfies Partial<EdenCompilerError>);
  });

  test.each([
    [
      "ambient binding",
      `export const read = () => globalThis.EDEN_API_KEY;\n`,
      "MODULE_AMBIENT_BINDING",
    ],
    [
      "constructor-indirected dynamic code",
      `export const read = () => Object.constructor("return 1");\n`,
      "MODULE_DYNAMIC_CODE_UNSUPPORTED",
    ],
  ])(
    "validates selected dependency %s with Worker semantics",
    async (_name, dependencySource, diagnosticCode) => {
      const root = await createProject({
        "agent/agent.ts": agentSource,
        "agent/instructions.md": "Selected dependency semantic fixture\n",
        "agent/tools/selected-semantic-dependency.ts": `
          import { read } from "selected-semantic-fixture";
          export default {
            description: "Uses a selected dependency.",
            inputSchema: { "~standard": { version: 1, vendor: "fixture", validate(value) { return { value }; } } },
            execute(input) {
              return { value: read() ?? input.name };
            }
          };
        `,
        "node_modules/selected-semantic-fixture/package.json": JSON.stringify({
          name: "selected-semantic-fixture",
          type: "module",
          exports: "./index.js",
        }),
        "node_modules/selected-semantic-fixture/index.js": dependencySource,
      });

      await expect(buildProject({ projectRoot: root })).rejects.toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: diagnosticCode,
            source: "node_modules/selected-semantic-fixture/index.js",
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        ]),
      });
    },
  );
});

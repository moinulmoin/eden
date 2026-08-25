import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(repositoryRoot, "packages/runtime-cloudflare");
const runtimeDist = join(runtimeRoot, "dist");
const definitionsRoot = join(repositoryRoot, "packages/definitions");
const temporaryRoots = [];

async function createConsumerProject() {
  const root = await mkdtemp(join(tmpdir(), "eden-runtime-public-boundary-"));
  temporaryRoots.push(root);

  const runtimePackageRoot = join(
    root,
    "node_modules/@moinulmoin/eden-runtime-cloudflare",
  );
  const definitionsPackageRoot = join(
    root,
    "node_modules/@moinulmoin/eden-definitions",
  );
  await mkdir(runtimePackageRoot, { recursive: true });
  await mkdir(definitionsPackageRoot, { recursive: true });
  await cp(runtimeDist, join(runtimePackageRoot, "dist"), { recursive: true });
  await cp(join(runtimeRoot, "package.json"), join(runtimePackageRoot, "package.json"));
  await cp(join(definitionsRoot, "dist"), join(definitionsPackageRoot, "dist"), {
    recursive: true,
  });
  await cp(
    join(definitionsRoot, "package.json"),
    join(definitionsPackageRoot, "package.json"),
  );

  await writeFile(
    join(root, "consumer.ts"),
    `import {
  createRuntime,
  type EdenEvent,
  type EdenEventType,
  type EdenModelResult,
  type EdenRuntime,
} from "@moinulmoin/eden-runtime-cloudflare";

const runtime: EdenRuntime = createRuntime(
  {
    versions: {
      runtime: "runtime",
      agentBundle: "bundle",
      manifest: "manifest",
      protocol: "protocol",
      schema: 1,
    },
  },
  {
    async createSession() {
      return {
        sessionId: "ses_public",
        status: "new",
        versions: {
          runtime: "runtime",
          agentBundle: "bundle",
          manifest: "manifest",
          protocol: "protocol",
          schema: 1,
        },
        sqliteSchemaVersion: 3,
      };
    },
    async readEvents() {
      return [] as readonly EdenEvent<EdenEventType>[];
    },
  },
);

const result: EdenModelResult = {
  text: "ok",
  calls: [],
  results: [],
  finishReason: "stop",
  correlation: { requestId: "req_public" },
};

void runtime;
void result;
`,
    "utf8",
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
      },
      files: ["consumer.ts"],
    }),
    "utf8",
  );
  return root;
}

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("the root declaration contract typechecks without Worker or provider packages", async () => {
  const root = await createConsumerProject();
  const tsc = join(repositoryRoot, "node_modules/.bin/tsc");
  await expect(
    execFileAsync(tsc, ["-p", join(root, "tsconfig.json"), "--pretty", "false"], {
      cwd: root,
    }),
  ).resolves.toEqual(expect.objectContaining({ stdout: "" }));
});

test("public declarations do not re-export internal Worker implementation modules", async () => {
  const packageJson = JSON.parse(
    await readFile(join(runtimeRoot, "package.json"), "utf8"),
  );
  const rootDeclaration = await readFile(join(runtimeDist, "index.d.ts"), "utf8");
  const schemaDeclaration = await readFile(
    join(runtimeDist, "session-schema.d.ts"),
    "utf8",
  );

  expect(Object.keys(packageJson.exports)).toEqual(["."]);
  expect(rootDeclaration).not.toMatch(
    /session-(?:schema|journal|checkpoint|jobs|state)|turn-runner|tool-harness|session\.js|http-host/,
  );
  expect(rootDeclaration).not.toMatch(
    /\bEdenSession\b|EdenWorkerEnvironment|DurableObject/,
  );
  expect(schemaDeclaration).not.toMatch(
    /@cloudflare\/workers-types|SqlStorage|DurableObject/,
  );
  expect(schemaDeclaration).toMatch(/interface SessionSchemaSql/);

  const require = createRequire(import.meta.url);
  for (const subpath of [
    "session",
    "http-host",
    "test-worker",
    "session-schema",
    "session-journal",
  ]) {
    expect(() =>
      require.resolve(`@moinulmoin/eden-runtime-cloudflare/${subpath}`),
    ).toThrow(
      /not exported|not defined by ["']exports["']|package path .* is not exported/i,
    );
  }
});

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectories = [
  "packages/definitions",
  "packages/compiler",
  "packages/runtime-cloudflare",
  "packages/client",
  "packages/cli",
  "examples/basic-agent",
];

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"));
}

test("the repository declares the six Eden workspaces and root quality scripts", async () => {
  const rootPackage = await readJson("package.json");
  const workspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const lockfile = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");

  expect(rootPackage.packageManager).toBe("pnpm@11.21.0");
  expect(rootPackage.scripts).toEqual({
    build: "pnpm --recursive --if-present run build",
    typecheck: "pnpm exec tsc -b --pretty false",
    lint: "pnpm exec eslint . --max-warnings 0",
    test: "pnpm exec vitest run --maxWorkers=1",
    "conformance:local": "node scripts/local-conformance.mjs",
  });
  expect(lockfile).toMatch(/lockfileVersion: ['"]9\.0['"]/);
  expect(workspace).toMatch(/packages\/\*/);
  expect(workspace).toMatch(/examples\/\*/);
  expect(JSON.stringify(rootPackage)).not.toMatch(/turbo/i);

  for (const directory of workspaceDirectories) {
    const packageJson = await readJson(join(directory, "package.json"));
    expect(typeof packageJson.name).toBe("string");
    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.module).toBe("./dist/index.js");
    expect(typeof packageJson.exports).toBe("object");
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(typeof packageJson.scripts.build).toBe("string");
    expect(typeof packageJson.scripts.typecheck).toBe("string");
    expect(typeof packageJson.scripts.lint).toBe("string");
    expect(typeof packageJson.scripts.test).toBe("string");
  }
});

test("workspace dependencies and project references form an acyclic declaration graph", async () => {
  const packageNames = new Set();
  const packages = new Map();

  for (const directory of workspaceDirectories) {
    const packageJson = await readJson(join(directory, "package.json"));
    packageNames.add(packageJson.name);
    packages.set(packageJson.name, packageJson);
    const tsconfig = await readJson(join(directory, "tsconfig.json"));
    expect(Array.isArray(tsconfig.references), `${directory} must declare references`).toBe(true);
    expect(await readFile(join(repositoryRoot, directory, "src/index.ts"), "utf8")).toMatch(/export/);
  }

  const graph = new Map();
  for (const [packageName, packageJson] of packages) {
    const dependencies = Object.entries({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })
      .filter(([name, version]) => packageNames.has(name) && version === "workspace:*")
      .map(([name]) => name);
    graph.set(packageName, dependencies);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (packageName) => {
    expect(visiting.has(packageName), `workspace dependency cycle includes ${packageName}`).toBe(false);
    if (visited.has(packageName)) return;
    visiting.add(packageName);
    for (const dependency of graph.get(packageName) ?? []) visit(dependency);
    visiting.delete(packageName);
    visited.add(packageName);
  };
  for (const packageName of packageNames) visit(packageName);
});

test("public source contracts do not expose platform or provider types", async () => {
  const sourceFiles = [
    "packages/definitions/src/index.ts",
    "packages/compiler/src/index.ts",
    "packages/runtime-cloudflare/src/index.ts",
    "packages/client/src/index.ts",
    "packages/cli/src/index.ts",
    "examples/basic-agent/src/index.ts",
  ];
  for (const file of sourceFiles) {
    const source = await readFile(join(repositoryRoot, file), "utf8");
    expect(source).not.toMatch(/from ["'](?:cloudflare|ai|workers-ai-provider|wrangler|zod|node:)/);
    expect(source).not.toMatch(/\b(?:Cloudflare|DurableObject|Workflow|AI SDK|WorkersAI|Wrangler)\b/);
  }
});

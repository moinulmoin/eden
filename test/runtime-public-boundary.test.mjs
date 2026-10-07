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
const temporaryRoots = [];

async function createConsumerProject() {
  const root = await mkdtemp(join(tmpdir(), "eden-runtime-public-boundary-"));
  temporaryRoots.push(root);

  const runtimePackageRoot = join(
    root,
    "node_modules/@moinulmoin/eden-runtime-cloudflare",
  );
  await mkdir(runtimePackageRoot, { recursive: true });
  await cp(runtimeDist, join(runtimePackageRoot, "dist"), { recursive: true });
  await cp(join(runtimeRoot, "package.json"), join(runtimePackageRoot, "package.json"));

  await writeFile(
    join(root, "consumer.ts"),
    `import {
  createEveHostConfig,
  generateEveHostWorkerSource,
  resolveStableWorkersDevOrigin,
  type EveHostConfig,
  type EveScheduleCronEntry,
} from "@moinulmoin/eden-runtime-cloudflare";

const origin: string = resolveStableWorkersDevOrigin({
  workerName: "eden-eve-preview",
  workersDevSubdomain: "account",
});

const config: EveHostConfig = createEveHostConfig({
  workerName: "eden-eve-preview",
  containerApplicationName: "eden-eve-preview-container",
  stableContainerInstanceName: "eden-eve-preview-instance",
  deploymentId: "dep-public",
  generationId: "gen-public",
  stableWorkersDevOrigin: origin,
  containerImage:
    "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

const source: string = generateEveHostWorkerSource({ config });
const schedule: EveScheduleCronEntry | undefined = undefined;

void source;
void schedule;
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

  expect(Object.keys(packageJson.exports)).toEqual(["."]);
  expect(rootDeclaration).not.toMatch(
    /eve-host-runtime|@cloudflare\/containers|cloudflare:workers|DurableObject/,
  );

  const require = createRequire(import.meta.url);
  for (const subpath of ["eve-host-runtime", "eve-host"]) {
    expect(() =>
      require.resolve(`@moinulmoin/eden-runtime-cloudflare/${subpath}`),
    ).toThrow(
      /not exported|not defined by ["']exports["']|package path .* is not exported/i,
    );
  }
});

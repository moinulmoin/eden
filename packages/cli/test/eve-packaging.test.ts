import {
  createHash,
} from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildEveProjectSnapshot,
  createDockerEveProjectBuilder,
  type EveProjectBuilder,
  type EveProjectBuilderRequest,
} from "../src/eve-packaging.js";

const roots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeProject(
  root: string,
  options: {
    readonly packageManager?: string;
    readonly lockfile?: string;
    readonly packageJson?: string;
  } = {},
): Promise<void> {
  await writeFile(
    join(root, "package.json"),
    options.packageJson ??
      JSON.stringify({
        name: "eve-fixture",
        private: true,
        packageManager: options.packageManager ?? "pnpm@11.21.0",
      }),
    "utf8",
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    options.lockfile ?? "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n",
    "utf8",
  );
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/index.ts"), "export const value = 1;\n", "utf8");
}

function fakeBuilder(
  configure: (request: EveProjectBuilderRequest) => Promise<void>,
): {
  readonly builder: EveProjectBuilder;
  readonly requests: EveProjectBuilderRequest[];
} {
  const requests: EveProjectBuilderRequest[] = [];
  return {
    requests,
    builder: {
      async build(request) {
        requests.push(request);
        await configure(request);
        return {
          eveVersion: "0.31.3",
          imageId: `sha256:${"1".repeat(64)}`,
          imagePlatform: "linux/amd64",
          imageReference: "eve-fixture-image",
        };
      },
    },
  };
}

async function writeSuccessfulBuild(
  request: EveProjectBuilderRequest,
): Promise<void> {
  const eveDirectory = join(request.snapshotRoot, "node_modules/eve");
  await mkdir(join(eveDirectory, "bin"), { recursive: true });
  await writeFile(
    join(eveDirectory, "package.json"),
    JSON.stringify({ name: "eve", version: "0.31.3", bin: "bin/eve.js" }),
    "utf8",
  );
  await writeFile(join(eveDirectory, "bin/eve.js"), "#!/usr/bin/env node\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  await mkdir(join(request.snapshotRoot, "node_modules/.bin"), {
    recursive: true,
  });
  await symlink(
    "../eve/bin/eve.js",
    join(request.snapshotRoot, "node_modules/.bin/eve"),
  );
  await mkdir(join(request.snapshotRoot, ".output/server"), {
    recursive: true,
  });
  await writeFile(
    join(request.snapshotRoot, ".output/server/index.mjs"),
    "export default {};\n",
    "utf8",
  );
}

async function writeFakeDockerCommand(
  root: string,
): Promise<{ readonly command: string; readonly log: string }> {
  const command = join(root, "fake-docker.cjs");
  const log = join(root, "docker-args.jsonl");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const removedMarker = ${JSON.stringify(`${log}.removed`)};
if (args[0] === "version") process.stdout.write("29.4.0\\n");
else if (args[0] === "build") {
  const iidfile = args[args.indexOf("--iidfile") + 1];
  fs.writeFileSync(iidfile, "sha256:${"2".repeat(64)}\\n");
} else if (args[0] === "image" && args[1] === "inspect") {
  if (fs.existsSync(removedMarker)) {
    process.stderr.write("No such object: image\\n");
    process.exitCode = 1;
  }
  else process.stdout.write("sha256:${"2".repeat(64)} linux amd64\\n");
} else if (args[0] === "image" && args[1] === "rm") {
  fs.writeFileSync(removedMarker, "removed\\n");
} else if (args[0] === "create") {
  process.stdout.write("abcdef123456\\n");
} else if (args[0] === "cp") {
  const source = args[1];
  const destination = args[2];
  if (source.endsWith(":/app/.output")) {
    fs.mkdirSync(path.join(destination, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(destination, "server/index.mjs"),
      "export default {};\\n",
    );
  } else if (source.endsWith(":/app/node_modules")) {
    const eve = path.join(destination, "eve");
    fs.mkdirSync(path.join(eve, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(eve, "package.json"),
      JSON.stringify({ name: "eve", version: "0.31.3" }),
    );
    fs.writeFileSync(path.join(eve, "bin/eve.js"), "#!/usr/bin/env node\\n");
    fs.chmodSync(path.join(eve, "bin/eve.js"), 0o755);
    fs.mkdirSync(path.join(destination, ".bin"), { recursive: true });
    fs.symlinkSync("../eve/bin/eve.js", path.join(destination, ".bin/eve"));
  }
} else if (args[0] === "container" && args[1] === "inspect") {
  process.stderr.write("No such object: container\\n");
  process.exitCode = 1;
}
`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(command, 0o700);
  return { command, log };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Eve project snapshot/build boundary", () => {
  test("accepts the canonical pinned-pnpm project and selects project-local Eve", async () => {
    const root = await createRoot("eden-eve-package-valid-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "ready",
      returnCode: "EVE_PACKAGE_READY",
      deployable: true,
      toolchain: {
        packageManager: "pnpm",
        packageManagerVersion: "11.21.0",
        installCommand: ["corepack", "pnpm", "install", "--frozen-lockfile"],
        buildCommand: ["./node_modules/.bin/eve", "build"],
        eveExecutable: "node_modules/.bin/eve",
        eveVersion: "0.31.3",
      },
      snapshot: {
        includedFileCount: 3,
        sourceRaceChecked: true,
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      packageManagerVersion: "11.21.0",
      installCommand: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      buildCommand: ["./node_modules/.bin/eve", "build"],
      platform: "linux/amd64",
      buildContext: "immutable-snapshot",
    });
  });

  test("creates an Eden-owned generation under a missing external artifact parent", async () => {
    const root = await createRoot("eden-eve-package-artifact-parent-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(writeSuccessfulBuild);
    const artifactRoot = join(artifacts, "deep", "nested", "generation-one");

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot,
      builder,
    });

    expect(result.status).toBe("ready");
    expect(result.snapshot?.path).toContain(
      `${join("deep", "nested", "generation-one")}/container/snapshot`,
    );
  });

  test.each([
    ["missing root", "missing"],
    ["root symlink", "symlink"],
    ["root file", "file"],
  ] as const)("rejects an invalid explicit project root (%s)", async (_name, kind) => {
    const parent = await createRoot("eden-eve-package-root-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    const root = join(parent, "project");
    if (kind === "symlink") {
      const target = join(parent, "target");
      await mkdir(target);
      await symlink(target, root, "dir");
    } else if (kind === "file") {
      await writeFile(root, "not a directory\n", "utf8");
    }
    const { builder } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: kind === "missing" ? root : root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "ROOT_INVALID",
      deployable: false,
    });
    expect(builder).toBeDefined();
  });

  test.each([
    ["missing package manager", undefined, "UNSUPPORTED_TOOLCHAIN"],
    ["npm package manager", "npm@10.0.0", "UNSUPPORTED_TOOLCHAIN"],
    ["range package manager", "pnpm^11.21.0", "UNSUPPORTED_TOOLCHAIN"],
    ["malformed package manager", "pnpm@latest", "UNSUPPORTED_TOOLCHAIN"],
  ] as const)(
    "rejects unsupported or non-exact package manager declarations (%s)",
    async (_name, packageManager, expectedCode) => {
      const root = await createRoot("eden-eve-package-manager-");
      const artifacts = await createRoot("eden-eve-package-artifacts-");
      await writeProject(root, {
        packageJson: JSON.stringify({
          name: "eve-fixture",
          ...(packageManager === undefined ? {} : { packageManager }),
        }),
      });
      const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

      const result = await buildEveProjectSnapshot({
        projectRoot: root,
        artifactRoot: join(artifacts, "generation-one"),
        builder,
      });

      expect(result).toMatchObject({
        status: "blocked",
        returnCode: expectedCode,
        deployable: false,
      });
      expect(requests).toHaveLength(0);
    },
  );

  test("reports an unsupported manager before requiring a pnpm lockfile", async () => {
    const root = await createRoot("eden-eve-package-manager-no-lock-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root, {
      packageManager: "npm@10.0.0",
    });
    await rm(join(root, "pnpm-lock.yaml"));
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "UNSUPPORTED_TOOLCHAIN",
      deployable: false,
    });
    expect(requests).toHaveLength(0);
  });

  test.each([
    ["symlinked lockfile", "symlink"],
    ["competing npm lockfile", "npm"],
    ["mismatched lockfile version", "mismatch"],
  ] as const)(
    "rejects ambiguous or conflicting lockfile inputs (%s)",
    async (_name, mode) => {
      const root = await createRoot("eden-eve-package-lock-");
      const artifacts = await createRoot("eden-eve-package-artifacts-");
      await writeProject(root, {
        lockfile: mode === "mismatch"
          ? "lockfileVersion: '6.0'\n"
          : "lockfileVersion: '9.0'\n",
      });
      if (mode === "symlink") {
        const lockfile = join(root, "pnpm-lock.yaml");
        const target = join(root, "lock-target.yaml");
        await rm(lockfile);
        await writeFile(target, "lockfileVersion: '9.0'\n", "utf8");
        await symlink(target, lockfile);
      }
      if (mode === "npm") {
        await writeFile(join(root, "package-lock.json"), "{}\n", "utf8");
      }
      const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

      const result = await buildEveProjectSnapshot({
        projectRoot: root,
        artifactRoot: join(artifacts, "generation-one"),
        builder,
      });

      expect(result).toMatchObject({
        status: "blocked",
        returnCode: "DEPENDENCY_AMBIGUITY",
        deployable: false,
      });
      expect(requests).toHaveLength(0);
    },
  );

  test("runs the frozen install and literal project-local build from the snapshot", async () => {
    const root = await createRoot("eden-eve-package-commands-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result.status).toBe("ready");
    expect(requests[0]?.installCommand).toEqual([
      "corepack",
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
    expect(requests[0]?.buildCommand).toEqual([
      "./node_modules/.bin/eve",
      "build",
    ]);
    expect(requests[0]?.snapshotRoot).not.toBe(root);
    expect(requests[0]?.snapshotRoot).toContain("generation-one");
  });

  test("returns a typed build candidate before image assembly or health checks", async () => {
    const root = await createRoot("eden-eve-package-candidate-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const requests: EveProjectBuilderRequest[] = [];
    const builder: EveProjectBuilder = {
      async build(request) {
        requests.push(request);
        await writeSuccessfulBuild(request);
        return { eveVersion: "0.31.3" };
      },
    };

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "ready",
      returnCode: "EVE_PACKAGE_READY",
      deployable: true,
      candidate: {
        packageManagerVersion: "11.21.0",
        eveVersion: "0.31.3",
        buildCommand: ["./node_modules/.bin/eve", "build"],
        generatedOutput: {
          entrypointPath: ".output/server/index.mjs",
          regularFile: true,
        },
      },
      image: null,
      runtime: null,
      candidateImageId: null,
      candidateImageRetainedLocally: false,
    });
    expect(requests).toHaveLength(1);
  });

  test("rejects a global-only Eve executable and never produces a candidate", async () => {
    const root = await createRoot("eden-eve-package-global-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      await mkdir(join(request.snapshotRoot, "node_modules"), { recursive: true });
      await mkdir(join(request.snapshotRoot, ".output/server"), {
        recursive: true,
      });
      await writeFile(
        join(request.snapshotRoot, ".output/server/index.mjs"),
        "export default {};\n",
        "utf8",
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "DEPENDENCY_AMBIGUITY",
      deployable: false,
      candidateImageId: null,
    });
    expect(
      await readdir(join(artifacts, "generation-one")),
    ).not.toContain("candidate.json");
  });

  test("rejects an executable whose package is not Eve", async () => {
    const root = await createRoot("eden-eve-package-wrong-cli-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(
        join(request.snapshotRoot, "node_modules/eve/package.json"),
        JSON.stringify({ name: "not-eve", version: "0.31.3", bin: "bin/eve.js" }),
        "utf8",
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "DEPENDENCY_AMBIGUITY",
      deployable: false,
    });
  });

  test("rejects a project-local Eve link that escapes the snapshot", async () => {
    const root = await createRoot("eden-eve-package-eve-escape-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      await mkdir(join(request.snapshotRoot, "node_modules/.bin"), {
        recursive: true,
      });
      const outside = join(artifacts, "outside-eve");
      await writeFile(outside, "#!/usr/bin/env node\n", {
        encoding: "utf8",
        mode: 0o755,
      });
      await symlink(
        outside,
        join(request.snapshotRoot, "node_modules/.bin/eve"),
      );
      await mkdir(join(request.snapshotRoot, ".output/server"), {
        recursive: true,
      });
      await writeFile(
        join(request.snapshotRoot, ".output/server/index.mjs"),
        "export default {};\n",
        "utf8",
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "DEPENDENCY_AMBIGUITY",
      deployable: false,
    });
  });

  test("captures an immutable snapshot without generated state or runtime env files", async () => {
    const root = await createRoot("eden-eve-package-snapshot-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    await writeFile(join(root, ".env"), "RUNTIME_SECRET=do-not-copy\n", "utf8");
    await writeFile(
      join(root, "runtime.secret"),
      "RUNTIME_SECRET=do-not-copy\n",
      "utf8",
    );
    await mkdir(join(root, ".eden/generations/old"), { recursive: true });
    await writeFile(join(root, ".eden/generations/old/CURRENT"), "old\n", "utf8");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "node_modules/host.txt"), "generated\n", "utf8");
    const { builder } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      runtimeConfig: {
        envFilePath: join(root, "runtime.secret"),
        inputIdentity: "runtime-input-v1",
        redactionRegistered: true,
      },
      builder,
    });

    expect(result.status).toBe("ready");
    const snapshotPath = result.snapshot?.path as string;
    expect(await readFile(join(snapshotPath, "package.json"), "utf8")).toContain(
      "eve-fixture",
    );
    await expect(readFile(join(snapshotPath, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(snapshotPath, "runtime.secret"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(snapshotPath, "node_modules/host.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const manifest = await readFile(
      result.project?.inputManifestPath as string,
      "utf8",
    );
    expect(manifest).not.toContain("RUNTIME_SECRET");
    expect(manifest).not.toContain("do-not-copy");
    expect(result.snapshot?.excludedCategories).toEqual(
      expect.arrayContaining(["generated-state", "runtime-env", "node_modules"]),
    );
  });

  test("requires redaction registration before a runtime-configured build", async () => {
    const root = await createRoot("eden-eve-package-redaction-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      runtimeConfig: {
        inputIdentity: "runtime-input-v1",
        variableNames: ["MODEL_API_KEY"],
      },
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SECRET_EXCLUSION_FAILED",
      deployable: false,
    });
    expect(requests).toHaveLength(0);
  });

  test("requires a deployment-safety identity for an explicit environment file", async () => {
    const root = await createRoot("eden-eve-package-env-identity-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const envFile = join(root, "runtime.env");
    await writeFile(envFile, "RUNTIME_SECRET=opaque\n", "utf8");
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      runtimeConfig: {
        envFilePath: envFile,
        redactionRegistered: true,
      },
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SECRET_EXCLUSION_FAILED",
      deployable: false,
    });
    expect(requests).toHaveLength(0);
  });

  test("rejects invalid or duplicate runtime variable names before snapshot creation", async () => {
    const root = await createRoot("eden-eve-package-variable-names-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      runtimeConfig: {
        inputIdentity: "runtime-input-v1",
        variableNames: ["MODEL_API_KEY", "MODEL_API_KEY", "not-valid"],
        redactionRegistered: true,
      },
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SECRET_EXCLUSION_FAILED",
      deployable: false,
    });
    expect(requests).toHaveLength(0);
    await expect(readdir(artifacts)).resolves.toEqual([]);
  });

  test("fails closed on a source mutation after the project-local build", async () => {
    const root = await createRoot("eden-eve-package-race-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const sourcePath = join(root, "src/index.ts");
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(sourcePath, "export const value = 2;\n", "utf8");
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SOURCE_RACE",
      deployable: false,
      candidateImageId: null,
    });
    expect(await readFile(sourcePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("fails closed when the deployment-safety environment identity changes", async () => {
    const root = await createRoot("eden-eve-package-env-race-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    let identity = "runtime-input-v1";
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      identity = "runtime-input-v2";
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      runtimeConfig: {
        inputIdentity: "runtime-input-v1",
        readInputIdentity: () => identity,
        variableNames: ["MODEL_API_KEY"],
        redactionRegistered: true,
      },
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SOURCE_RACE",
      deployable: false,
    });
  });

  test("fails closed when the immutable snapshot is modified during the build", async () => {
    const root = await createRoot("eden-eve-package-snapshot-race-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(
        join(request.snapshotRoot, "src/index.ts"),
        "export const value = 99;\n",
        "utf8",
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SOURCE_RACE",
      deployable: false,
    });
    expect(await readFile(join(root, "src/index.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
  });

  test("fails closed when the builder adds an untracked authored-tree file", async () => {
    const root = await createRoot("eden-eve-package-added-file-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(
        join(request.snapshotRoot, "src/generated-config.ts"),
        "export const generated = true;\n",
        "utf8",
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SOURCE_RACE",
      deployable: false,
      candidateImageId: null,
    });
  });

  test("generates a pinned Linux/amd64 multi-stage context without runtime values", async () => {
    const root = await createRoot("eden-eve-package-dockerfile-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(writeSuccessfulBuild);
    const digest = `sha256:${"0".repeat(64)}`;

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      runtimeConfig: {
        inputIdentity: "runtime-input-v1",
        variableNames: ["MODEL_API_KEY"],
        redactionRegistered: true,
      },
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest,
      },
      builder,
    });

    expect(result.status).toBe("ready");
    const dockerfile = await readFile(
      join(artifacts, "generation-one/container/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("FROM --platform=linux/amd64 node:24.17.0-bookworm-slim@");
    expect(dockerfile).toContain("corepack pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("corepack pnpm prune --prod");
    expect(dockerfile).toContain("COPY --from=runtime-deps /workspace/node_modules /app/node_modules");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["./node_modules/.bin/eve", "start", "--host", "0.0.0.0", "--port", "8080"]',
    );
    expect(dockerfile).not.toContain("MODEL_API_KEY");
    expect(result.secrets.redactionRegisteredBeforeChildren).toBe(true);
  });

  test("builds through an exact iidfile image identity without a reusable tag", async () => {
    const root = await createRoot("eden-eve-package-docker-builder-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts);
    const builder = createDockerEveProjectBuilder({
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest: `sha256:${"0".repeat(64)}`,
      },
      dockerCommand: fakeDocker.command,
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "ready",
      candidateImageId: `sha256:${"2".repeat(64)}`,
      image: {
        imageId: `sha256:${"2".repeat(64)}`,
        imageReference: `sha256:${"2".repeat(64)}`,
        imageDigest: `sha256:${"2".repeat(64)}`,
      },
    });
    const commands = (await readFile(fakeDocker.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const buildArgs = commands.find((args) => args[0] === "build");
    expect(buildArgs).toEqual(expect.arrayContaining([
      "--platform=linux/amd64",
      "--iidfile",
    ]));
    expect(buildArgs).not.toContain("--tag");
    expect(commands).toContainEqual([
      "create",
      `sha256:${"2".repeat(64)}`,
    ]);
  });

  test("fails without a deployable candidate when Eve output is absent", async () => {
    const root = await createRoot("eden-eve-package-output-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      const eveDirectory = join(request.snapshotRoot, "node_modules/eve");
      await mkdir(join(eveDirectory, "bin"), { recursive: true });
      await writeFile(
        join(eveDirectory, "package.json"),
        JSON.stringify({ name: "eve", version: "0.31.3", bin: "bin/eve.js" }),
        "utf8",
      );
      await writeFile(join(eveDirectory, "bin/eve.js"), "#!/usr/bin/env node\n", {
        encoding: "utf8",
        mode: 0o755,
      });
      await mkdir(join(request.snapshotRoot, "node_modules/.bin"), {
        recursive: true,
      });
      await symlink(
        "../eve/bin/eve.js",
        join(request.snapshotRoot, "node_modules/.bin/eve"),
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "UNSUPPORTED_EVE_OUTPUT",
      deployable: false,
      candidateImageId: null,
    });
  });

  test("rejects an invalid generated Nitro entrypoint", async () => {
    const root = await createRoot("eden-eve-package-invalid-output-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(
        join(request.snapshotRoot, ".output/server/index.mjs"),
        "export default {;\n",
        "utf8",
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "UNSUPPORTED_EVE_OUTPUT",
      deployable: false,
    });
  });

  test("rejects credentials that appear in the generated runtime closure", async () => {
    const root = await createRoot("eden-eve-package-closure-secret-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(
        join(request.snapshotRoot, "node_modules/.npmrc"),
        "registry=https://registry.example.invalid\n",
        "utf8",
      );
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "SECRET_EXCLUSION_FAILED",
      deployable: false,
      candidateImageId: null,
    });
  });

  test("preserves the prior generation when a new snapshot build races", async () => {
    const root = await createRoot("eden-eve-package-prior-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const prior = join(artifacts, "prior-generation");
    await mkdir(prior, { recursive: true });
    const priorBytes = "prior generation bytes\n";
    await writeFile(join(prior, "CURRENT"), priorBytes, "utf8");
    const priorDigest = createHash("sha256").update(priorBytes).digest("hex");
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(join(root, "src/index.ts"), "export const value = 9;\n", "utf8");
    });

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "new-generation"),
      builder,
    });

    expect(result.returnCode).toBe("SOURCE_RACE");
    expect(createHash("sha256").update(await readFile(join(prior, "CURRENT"))).digest("hex"))
      .toBe(priorDigest);
  });
});

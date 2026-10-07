import {
  createHash,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
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
  dirname,
  join,
} from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildEveProjectSnapshot,
  createDockerEveProjectBuilder,
  EVE_JUST_BASH_RESUME_ORIGINAL,
  EVE_SANDBOX_RESUME_PATCHED,
  EVE_SANDBOX_RESUME_PATCH_HELPERS,
  EVE_SANDBOX_RESUME_PATCH_KNOWN_SHA256,
  EVE_SANDBOX_RESUME_PATCH_SCRIPT,
  EVE_SANDBOX_RESUME_PATCH_SIGNATURE,
  jsonBytes,
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
  options: {
    readonly buildStderr?: string;
    readonly sandboxCache?: "present" | "absent" | "escaping-symlink" | "special-file";
  } = {},
): Promise<{ readonly command: string; readonly log: string }> {
  const command = join(root, "fake-docker.cjs");
  const log = join(root, "docker-args.jsonl");
  const sandboxCacheMode = options.sandboxCache ?? "present";
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
  const buildStderr = ${JSON.stringify(options.buildStderr ?? "")};
  if (buildStderr.length > 0) {
    process.stderr.write(buildStderr);
    process.exitCode = 1;
    return;
  }
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
  const sandboxCacheMode = ${JSON.stringify(sandboxCacheMode)};
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
  } else if (source.endsWith(":/app/.eve/sandbox-cache")) {
    if (sandboxCacheMode === "absent") {
      process.stderr.write("Error response from daemon: Could not find the file /app/.eve/sandbox-cache in container abcdef123456: file does not exist\\n");
      process.exitCode = 1;
    } else {
      const template = path.join(
        destination,
        "just-bash/templates/7bc778099a3b436ce4ad98ba",
      );
      fs.mkdirSync(path.join(template, "fs/workspace"), { recursive: true });
      fs.writeFileSync(
        path.join(template, "metadata.json"),
        JSON.stringify({ templateKey: "7bc778099a3b436ce4ad98ba" }) + "\\n",
      );
      if (sandboxCacheMode === "escaping-symlink") {
        fs.symlinkSync("/etc/hostname", path.join(template, "fs/escape"));
      } else if (sandboxCacheMode === "special-file") {
        require("node:child_process").execSync(
          "mkfifo " + JSON.stringify(path.join(template, "fs/pipe")),
        );
      }
    }
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
    expect(dockerfile).toContain(
      "corepack pnpm install --frozen-lockfile --prod --config.node-linker=hoisted",
    );
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

  test("copies the project pnpm workspace policy into the image before both frozen installs", async () => {
    const root = await createRoot("eden-eve-package-workspace-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "minimumReleaseAgeExclude:\n  - eve@0.66.3\n",
      "utf8",
    );
    const { builder } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest: `sha256:${"0".repeat(64)}`,
      },
      builder,
    });

    expect(result.status).toBe("ready");
    const dockerfile = await readFile(
      join(artifacts, "generation-one/container/Dockerfile"),
      "utf8",
    );
    const firstInstall = dockerfile.indexOf(
      "corepack pnpm install --frozen-lockfile --config.node-linker=hoisted",
    );
    const policyCopy = dockerfile.indexOf(
      'COPY ["package.json","pnpm-lock.yaml","pnpm-workspace.yaml","./"]',
    );
    expect(firstInstall).toBeGreaterThan(-1);
    expect(policyCopy).toBeGreaterThan(-1);
    expect(policyCopy).toBeLessThan(firstInstall);
    const secondInstall = dockerfile.indexOf(
      "corepack pnpm install --frozen-lockfile --prod --config.node-linker=hoisted",
    );
    expect(secondInstall).toBeGreaterThan(firstInstall);
  });

  test("omits the workspace policy source when the project has no pnpm-workspace.yaml", async () => {
    const root = await createRoot("eden-eve-package-no-workspace-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const { builder } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest: `sha256:${"0".repeat(64)}`,
      },
      builder,
    });

    expect(result.status).toBe("ready");
    const dockerfile = await readFile(
      join(artifacts, "generation-one/container/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      'COPY ["package.json","pnpm-lock.yaml","./"]',
    );
    expect(dockerfile).not.toContain("pnpm-workspace.yaml");
  });

  test("carries the validated authored source closure into the runtime stage", async () => {
    const root = await createRoot("eden-eve-package-source-closure-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    await mkdir(join(root, "agent/tools"), { recursive: true });
    await writeFile(join(root, "agent/agent.ts"), "export default {};\n", "utf8");
    await writeFile(join(root, "agent/tools/echo.ts"), "export default {};\n", "utf8");
    await mkdir(join(root, "agents/worker"), { recursive: true });
    await writeFile(join(root, "agents/worker/agent.ts"), "export default {};\n", "utf8");
    await writeFile(join(root, ".env"), "RUNTIME_SECRET=do-not-copy\n", "utf8");
    await writeFile(join(root, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
    await mkdir(join(root, ".eve"), { recursive: true });
    await writeFile(join(root, ".eve/state.json"), "{}\n", "utf8");
    const { builder } = fakeBuilder(writeSuccessfulBuild);

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
        digest: `sha256:${"0".repeat(64)}`,
      },
      builder,
    });

    expect(result.status).toBe("ready");
    const dockerfile = await readFile(
      join(artifacts, "generation-one/container/Dockerfile"),
      "utf8",
    );
    for (const entry of [
      "agent",
      "agents",
      "src",
      "package.json",
      "pnpm-lock.yaml",
    ]) {
      expect(dockerfile).toContain(
        `COPY --from=builder ["/workspace/${entry}","/app/${entry}"]`,
      );
    }
    expect(dockerfile).not.toContain('"/app/.env"');
    expect(dockerfile).not.toContain('"/app/deploy.pem"');
    // Authored `.eve` is never copied as source; only the builder-generated
    // sandbox-template subtree ships, via the explicit builder-stage copy.
    expect(dockerfile).not.toContain('"/app/.eve"');
    expect(dockerfile).toContain("mkdir -p .eve/sandbox-cache");
    expect(dockerfile).toContain(
      "COPY --from=builder /workspace/.eve/sandbox-cache /app/.eve/sandbox-cache",
    );
    expect(dockerfile).not.toContain('"/app/node_modules"');
    const snapshotPath = result.snapshot?.path as string;
    await expect(readFile(join(snapshotPath, ".eve/state.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("extracts the prepared sandbox template into the generation snapshot", async () => {
    const root = await createRoot("eden-eve-package-sandbox-extract-");
    const artifacts = await createRoot("eden-eve-package-sandbox-artifacts-");
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

    expect(result.status).toBe("ready");
    const snapshotPath = result.snapshot?.path as string;
    const templateKey = "7bc778099a3b436ce4ad98ba";
    const metadataRelativePath =
      `.eve/sandbox-cache/just-bash/templates/${templateKey}/metadata.json`;
    const metadataBytes = await readFile(join(snapshotPath, metadataRelativePath));
    expect(await readdir(join(snapshotPath, ".eve"))).toEqual(["sandbox-cache"]);
    const commands = (await readFile(fakeDocker.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(commands).toContainEqual([
      "cp",
      `abcdef123456:/app/.eve/sandbox-cache`,
      join(snapshotPath, ".eve/sandbox-cache"),
    ]);
    expect(result.candidate?.sandboxCache).toEqual({
      present: true,
      root: ".eve/sandbox-cache",
      outputDigest: createHash("sha256").update(jsonBytes([
        {
          relativePath: metadataRelativePath,
          sha256: createHash("sha256").update(metadataBytes).digest("hex"),
          byteLength: metadataBytes.byteLength,
        },
      ])).digest("hex"),
      fileCount: 1,
      totalBytes: metadataBytes.byteLength,
    });
    const runtimeManifest = JSON.parse(
      await readFile(
        join(artifacts, "generation-one/runtime-manifest.json"),
        "utf8",
      ),
    ) as { readonly sandboxCache?: unknown };
    expect(runtimeManifest.sandboxCache).toEqual(result.candidate?.sandboxCache);
  });

  test("ships no sandbox cache when the builder prepared no template", async () => {
    const root = await createRoot("eden-eve-package-sandbox-absent-");
    const artifacts = await createRoot("eden-eve-package-sandbox-absent-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      sandboxCache: "absent",
    });
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

    expect(result.status).toBe("ready");
    expect(result.candidate?.sandboxCache).toBeNull();
    const snapshotPath = result.snapshot?.path as string;
    await expect(lstat(join(snapshotPath, ".eve"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects a symbolic link inside the extracted sandbox template", async () => {
    const root = await createRoot("eden-eve-package-sandbox-link-");
    const artifacts = await createRoot("eden-eve-package-sandbox-link-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      sandboxCache: "escaping-symlink",
    });
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
      status: "blocked",
      returnCode: "UNSUPPORTED_EVE_OUTPUT",
      deployable: false,
      candidate: null,
    });
    expect(result.error?.subject).toBe(
      ".eve/sandbox-cache/just-bash/templates/7bc778099a3b436ce4ad98ba/fs/escape",
    );
  });

  test("rejects a special file inside the extracted sandbox template", async () => {
    const root = await createRoot("eden-eve-package-sandbox-fifo-");
    const artifacts = await createRoot("eden-eve-package-sandbox-fifo-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      sandboxCache: "special-file",
    });
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
      status: "blocked",
      returnCode: "UNSUPPORTED_EVE_OUTPUT",
      deployable: false,
      candidate: null,
    });
    expect(result.error?.subject).toContain(
      ".eve/sandbox-cache/just-bash/templates/7bc778099a3b436ce4ad98ba/fs/pipe",
    );
  });

  test("surfaces the pnpm release-age policy failure instead of lockfile ambiguity", async () => {
    const root = await createRoot("eden-eve-package-release-age-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      buildStderr:
        "ERROR: process \"/bin/sh -c corepack pnpm install --frozen-lockfile\" did not complete: " +
        "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  eve@0.66.3 was published at " +
        "2026-09-24T20:43:44.000Z, within the minimumReleaseAge cutoff\n",
    });
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
      status: "blocked",
      returnCode: "DEPENDENCY_AMBIGUITY",
      deployable: false,
    });
    expect(result.error?.subject).toBe("ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION");
    expect(result.error?.reason).toContain("minimumReleaseAge");
    expect(result.error?.remediation).toContain("minimumReleaseAgeExclude");
    expect(result.error?.remediation).not.toContain("Regenerate pnpm-lock.yaml");
  });

  test("reports the actual pnpm error code when the frozen install fails", async () => {
    const root = await createRoot("eden-eve-package-pnpm-error-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      buildStderr:
        "ERROR: process \"/bin/sh -c corepack pnpm install --frozen-lockfile\" did not complete: " +
        "ERR_PNPM_UNEXPECTED_STORE  Unexpected store location\n",
    });
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
      status: "blocked",
      returnCode: "DEPENDENCY_AMBIGUITY",
      deployable: false,
    });
    expect(result.error?.subject).toBe("ERR_PNPM_UNEXPECTED_STORE");
    expect(result.error?.reason).toContain("ERR_PNPM_UNEXPECTED_STORE");
    expect(result.error?.reason).not.toContain("changing or bypassing the lockfile");
  });

  test("classifies a failing eve build step as Eve build failure, not pnpm install", async () => {
    const root = await createRoot("eden-eve-package-eve-build-step-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      buildStderr:
        '#14 [builder 4/7] RUN corepack enable   && corepack prepare pnpm@11.21.0 --activate   && test "$(corepack pnpm --version)" = "11.21.0"   && corepack pnpm install --frozen-lockfile --config.node-linker=hoisted\n' +
        "#14 CACHED\n" +
        "#16 [builder 7/7] RUN test -x ./node_modules/.bin/eve   && ./node_modules/.bin/eve build\n" +
        "#16 0.512 Error: Cannot find package 'just-bash' imported from /workspace/node_modules/eve/dist/src/sandbox/providers/default.js\n" +
        '#16 ERROR: process "/bin/sh -c test -x ./node_modules/.bin/eve   && ./node_modules/.bin/eve build" did not complete successfully: exit code: 1\n' +
        '------\n > [builder 7/7] RUN test -x ./node_modules/.bin/eve   && ./node_modules/.bin/eve build:\n------\n' +
        'ERROR: process "/bin/sh -c test -x ./node_modules/.bin/eve   && ./node_modules/.bin/eve build" did not complete successfully: exit code: 1\n',
    });
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
      status: "blocked",
      returnCode: "EVE_BUILD_FAILED",
      deployable: false,
    });
    expect(result.error?.subject).toBe("eve build");
    expect(result.error?.reason).toContain("just-bash");
    expect(result.error?.remediation).toContain("just-bash");
    expect(result.error?.remediation).toContain("production dependency");
  });

  test("classifies a frozen-lockfile mismatch inside the install step", async () => {
    const root = await createRoot("eden-eve-package-lockfile-mismatch-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      buildStderr:
        '#14 [builder 4/7] RUN corepack enable   && corepack prepare pnpm@11.21.0 --activate   && test "$(corepack pnpm --version)" = "11.21.0"   && corepack pnpm install --frozen-lockfile --config.node-linker=hoisted\n' +
        '#14 1.102 ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json\n' +
        '#14 ERROR: process "/bin/sh -c corepack enable   && corepack prepare pnpm@11.21.0 --activate   && test \\"$(corepack pnpm --version)\\" = \\"11.21.0\\"   && corepack pnpm install --frozen-lockfile --config.node-linker=hoisted" did not complete successfully: exit code: 1\n' +
        'ERROR: process "/bin/sh -c corepack enable   && corepack prepare pnpm@11.21.0 --activate   && test \\"$(corepack pnpm --version)\\" = \\"11.21.0\\"   && corepack pnpm install --frozen-lockfile --config.node-linker=hoisted" did not complete successfully: exit code: 1\n',
    });
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
      status: "blocked",
      returnCode: "DEPENDENCY_AMBIGUITY",
      deployable: false,
    });
    expect(result.error?.subject).toBe("frozen pnpm install");
    expect(result.error?.remediation).toContain("Regenerate pnpm-lock.yaml");
  });

  test("surfaces the ignored-builds pnpm policy failure with its own remediation", async () => {
    const root = await createRoot("eden-eve-package-ignored-builds-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      buildStderr:
        '#21 [runtime-deps 2/2] RUN rm -rf node_modules   && corepack pnpm install --frozen-lockfile --prod --config.node-linker=hoisted\n' +
        "#21 2.040 ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: @mongodb-js/zstd, node-liblzma.\n" +
        '#21 ERROR: process "/bin/sh -c rm -rf node_modules   && corepack pnpm install --frozen-lockfile --prod --config.node-linker=hoisted" did not complete successfully: exit code: 1\n',
    });
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
      status: "blocked",
      returnCode: "DEPENDENCY_AMBIGUITY",
      deployable: false,
    });
    expect(result.error?.subject).toBe("ERR_PNPM_IGNORED_BUILDS");
    expect(result.error?.remediation).toContain("allowBuilds");
    expect(result.error?.remediation).toContain("pnpm-workspace.yaml");
  });
});

describe("Eve sandbox-resume patch (eve#4440)", () => {
  const bindingRelativePath =
    "node_modules/eve/dist/src/execution/sandbox/bindings/just-bash.js";

  /** A minimal but parseable module embedding the known resume text. */
  function fixtureModule(resumeText: string): string {
    return [
      `import{dirname,join}from"node:path";`,
      `const t={};`,
      `function requirePreparedJustBashArtifact(){return{templateRootPath:"/tmp/template"}}`,
      `const provider={${resumeText}};`,
      `export{provider};`,
    ].join("\n");
  }

  function patcherScriptWithHash(expectedSha256: string): string {
    const knownLiteral = JSON.stringify(EVE_SANDBOX_RESUME_PATCH_KNOWN_SHA256);
    expect(
      EVE_SANDBOX_RESUME_PATCH_SCRIPT.split(knownLiteral).length - 1,
    ).toBe(1);
    return EVE_SANDBOX_RESUME_PATCH_SCRIPT.replace(
      knownLiteral,
      JSON.stringify(expectedSha256),
    );
  }

  async function writeEveFixture(
    root: string,
    bindingSource: string,
  ): Promise<string> {
    const packageRoot = join(root, "project/node_modules/eve");
    const bindingPath = join(
      packageRoot,
      "dist/src/execution/sandbox/bindings/just-bash.js",
    );
    await mkdir(dirname(bindingPath), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "eve", version: "0.72.1", type: "module" }),
      "utf8",
    );
    await writeFile(bindingPath, bindingSource, "utf8");
    return bindingPath;
  }

  async function runPatcher(
    projectRoot: string,
    script: string,
  ): Promise<{ readonly status: number | null; readonly output: string }> {
    const scriptPath = join(projectRoot, "..", "patcher.cjs");
    await writeFile(scriptPath, script, "utf8");
    const run = spawnSync(process.execPath, [scriptPath], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    return {
      status: run.status,
      output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
    };
  }

  test("applies once against a known binding and produces parseable JavaScript", async () => {
    const root = await createRoot("eden-eve-patch-apply-");
    const fixture = fixtureModule(EVE_JUST_BASH_RESUME_ORIGINAL);
    const bindingPath = await writeEveFixture(root, fixture);
    const script = patcherScriptWithHash(
      createHash("sha256").update(fixture).digest("hex"),
    );

    const first = await runPatcher(join(root, "project"), script);
    expect(first.status).toBe(0);
    expect(first.output).toContain(
      "eden-eve-sandbox-resume-patch: applied",
    );

    const patched = await readFile(bindingPath, "utf8");
    expect(patched).not.toContain(EVE_JUST_BASH_RESUME_ORIGINAL);
    expect(patched.split(EVE_SANDBOX_RESUME_PATCHED).length - 1).toBe(1);
    expect(patched.split(EVE_SANDBOX_RESUME_PATCH_SIGNATURE).length - 1)
      .toBeGreaterThan(0);
    expect(spawnSync(process.execPath, ["--check", bindingPath], {
      encoding: "utf8",
    }).status).toBe(0);
    const temporaryFiles = (await readdir(dirname(bindingPath)))
      .filter((name) => name.includes(".tmp.js"));
    expect(temporaryFiles).toEqual([]);

    const second = await runPatcher(join(root, "project"), script);
    expect(second.status).toBe(0);
    expect(second.output).toContain("eden-eve-sandbox-resume-patch: applied");
    expect(second.output).toContain("already patched");
  });

  test("skips an unknown binding and leaves every project file untouched", async () => {
    const root = await createRoot("eden-eve-patch-skip-");
    const mutatedResume = EVE_JUST_BASH_RESUME_ORIGINAL.replace(
      "version:1",
      "version:2",
    );
    expect(mutatedResume).not.toBe(EVE_JUST_BASH_RESUME_ORIGINAL);
    const bindingPath = await writeEveFixture(root, fixtureModule(mutatedResume));
    const otherSource = join(root, "project/src/index.ts");
    await mkdir(dirname(otherSource), { recursive: true });
    await writeFile(otherSource, "export const value = 1;\n", "utf8");

    const run = await runPatcher(
      join(root, "project"),
      EVE_SANDBOX_RESUME_PATCH_SCRIPT,
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("eden-eve-sandbox-resume-patch: skipped");
    expect(await readFile(bindingPath, "utf8")).toBe(
      fixtureModule(mutatedResume),
    );
    expect(await readFile(otherSource, "utf8")).toBe(
      "export const value = 1;\n",
    );
  });

  test("reports absent when the eve build has no just-bash binding", async () => {
    const root = await createRoot("eden-eve-patch-absent-");
    await writeEveFixture(root, "export const provider = {};\n");
    await rm(join(root, "project", bindingRelativePath));

    const run = await runPatcher(
      join(root, "project"),
      EVE_SANDBOX_RESUME_PATCH_SCRIPT,
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("eden-eve-sandbox-resume-patch: absent");
  });

  test("runs the patch step in the builder and the production reinstall stages", async () => {
    const root = await createRoot("eden-eve-patch-dockerfile-");
    const artifacts = await createRoot("eden-eve-patch-dockerfile-artifacts-");
    await writeProject(root);
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);

    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
      nodeImage: {
        reference: "node:24.17.0-bookworm",
        digest: `sha256:${"a".repeat(64)}`,
      },
    });

    expect(result.status).toBe("ready");
    const dockerfilePath = requests[0]?.dockerfilePath;
    expect(dockerfilePath).toBeDefined();
    const dockerfile = await readFile(dockerfilePath ?? "", "utf8");
    const step = "RUN node /tmp/eden-eve-sandbox-resume-patch.cjs";
    expect(dockerfile.split(step).length - 1).toBe(2);
    expect(dockerfile.split("COPY <<'EDEN_EVE_PATCH_EOF'").length - 1).toBe(2);
    const installIndex = dockerfile.indexOf(
      "corepack pnpm install --frozen-lockfile",
    );
    const prodInstallIndex = dockerfile.indexOf(
      "corepack pnpm install --frozen-lockfile --prod",
    );
    const firstStep = dockerfile.indexOf(step);
    const secondStep = dockerfile.indexOf(step, firstStep + 1);
    expect(firstStep).toBeGreaterThan(installIndex);
    expect(firstStep).toBeLessThan(prodInstallIndex);
    expect(secondStep).toBeGreaterThan(prodInstallIndex);
    expect(dockerfile.indexOf("./node_modules/.bin/eve build")).toBeGreaterThan(
      firstStep,
    );
    // The heredoc delimiter is quoted, so the script never sees shell expansion.
    expect(dockerfile).toContain("EDEN_EVE_PATCH_EOF");
  });

  test("reports the shipped binding as the patch outcome", async () => {
    const root = await createRoot("eden-eve-patch-detect-");
    const artifacts = await createRoot("eden-eve-patch-detect-artifacts-");
    await writeProject(root);
    const applied = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await mkdir(dirname(join(request.snapshotRoot, bindingRelativePath)), {
        recursive: true,
      });
      await writeFile(
        join(request.snapshotRoot, bindingRelativePath),
        fixtureModule(EVE_SANDBOX_RESUME_PATCHED),
        "utf8",
      );
    });
    const appliedResult = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder: applied.builder,
    });
    expect(appliedResult.sandboxResumePatch).toBe("applied");
    expect(appliedResult.checks).toContainEqual({
      id: "EVE_SANDBOX_RESUME_PATCH",
      status: "pass",
      subject: "eve-sandbox-resume",
      reason: "applied temporary fix for eve#4440",
      remediation: null,
    });

    const skipped = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await mkdir(dirname(join(request.snapshotRoot, bindingRelativePath)), {
        recursive: true,
      });
      await writeFile(
        join(request.snapshotRoot, bindingRelativePath),
        fixtureModule(EVE_JUST_BASH_RESUME_ORIGINAL),
        "utf8",
      );
    });
    const skippedResult = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-two"),
      builder: skipped.builder,
    });
    expect(skippedResult.sandboxResumePatch).toBe("skipped");
    expect(
      skippedResult.checks.some((value) =>
        value.id === "EVE_SANDBOX_RESUME_PATCH"
      ),
    ).toBe(false);
  });

  interface ResumeFixture {
    readonly templateRoot: string;
    readonly sessionsDir: string;
    readonly sessionRoot: string;
    resume(
      context: { readonly sessionsDir: string },
      artifact: { readonly templateRootPath: string; readonly generation: string },
      state: { readonly generation: string; readonly rootPath: string },
    ): Promise<unknown>;
    readonly openCalls: string[];
  }

  async function createResumeFixture(
    root: string,
  ): Promise<ResumeFixture> {
    const templateRoot = join(root, "template");
    const sessionsDir = join(root, "sessions");
    const sessionRoot = join(sessionsDir, "session-1");
    const openCalls: string[] = [];
    const harness = new Function(
      "requirePreparedJustBashArtifact",
      "requireJustBashSessionState",
      "createSandboxProviderIdentity",
      "sessionRootPath",
      "pathExists",
      "ensureSessionRoot",
      "openHandle",
      "dirname",
      "join",
      "rm",
      "readdir",
      "copyDirectoryAtomically",
      "t",
      `${EVE_SANDBOX_RESUME_PATCH_HELPERS}\nreturn { ${EVE_SANDBOX_RESUME_PATCHED} };`,
    );
    const scope = harness(
      (artifact: { readonly templateRootPath: string }) => artifact,
      (state: { readonly generation: string; readonly rootPath: string }) =>
        state,
      ({ artifact }: {
        readonly artifact: { readonly generation: string };
      }) => artifact.generation,
      (
        context: { readonly sessionsDir: string },
        artifact: { readonly sessionId: string },
      ) => join(context.sessionsDir, artifact.sessionId),
      async (path: string) =>
        await access(path).then(() => true, () => false),
      async (
        artifact: { readonly templateRootPath: string },
        rootPath: string,
      ) => {
        if (
          await access(rootPath).then(() => true, () => false)
        ) return;
        await mkdir(dirname(rootPath), { recursive: true });
        await cp(artifact.templateRootPath, rootPath, { recursive: true });
      },
      async (
        _context: unknown,
        rootPath: string,
        options: unknown,
      ) => {
        openCalls.push(rootPath);
        return { opened: rootPath, options };
      },
      dirname,
      join,
      rm,
      readdir,
      async (from: string, to: string) => {
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { recursive: true });
      },
      { autoInstall: false },
    );
    return {
      templateRoot,
      sessionsDir,
      sessionRoot,
      resume: scope.resume as ResumeFixture["resume"],
      openCalls,
    };
  }

  async function writeTemplateFixture(templateRoot: string): Promise<void> {
    await mkdir(join(templateRoot, "fs/.agents/skills/greet"), {
      recursive: true,
    });
    await mkdir(join(templateRoot, "fs/workspace"), { recursive: true });
    await writeFile(
      join(templateRoot, "fs/.agents/skills/greet/SKILL.md"),
      "---\nname: greet\n---\n\nSay hello (v2).\n",
      "utf8",
    );
    await writeFile(
      join(templateRoot, "fs/workspace/seed.txt"),
      "seed\n",
      "utf8",
    );
  }

  /** Seeds an existing session root with stale skills and user data. */
  async function writeSessionFixture(sessionRoot: string): Promise<void> {
    await mkdir(join(sessionRoot, "fs/.agents/skills/old"), {
      recursive: true,
    });
    await mkdir(join(sessionRoot, "fs/workspace"), { recursive: true });
    await writeFile(
      join(sessionRoot, "fs/.agents/skills/old/SKILL.md"),
      "stale\n",
      "utf8",
    );
  }

  test("reopens a session after the template changed and refreshes only its skills", async () => {
    const root = await createRoot("eden-eve-patch-resume-");
    const fixture = await createResumeFixture(root);
    await writeTemplateFixture(fixture.templateRoot);
    await writeSessionFixture(fixture.sessionRoot);
    await writeFile(
      join(fixture.sessionRoot, "fs/workspace/notes.txt"),
      "user data\n",
      "utf8",
    );

    await fixture.resume(
      { sessionsDir: fixture.sessionsDir },
      { templateRootPath: fixture.templateRoot, generation: "gen-2", sessionId: "session-1" },
      { generation: "gen-1", rootPath: fixture.sessionRoot },
    );

    expect(fixture.openCalls).toEqual([fixture.sessionRoot]);
    expect(
      await readFile(
        join(fixture.sessionRoot, "fs/.agents/skills/greet/SKILL.md"),
        "utf8",
      ),
    ).toContain("Say hello (v2)");
    await expect(
      access(join(fixture.sessionRoot, "fs/.agents/skills/old")),
    ).rejects.toThrow();
    expect(
      await readFile(
        join(fixture.sessionRoot, "fs/workspace/notes.txt"),
        "utf8",
      ),
    ).toBe("user data\n");
    await expect(
      access(join(fixture.sessionRoot, "fs/workspace/seed.txt")),
    ).rejects.toThrow();
  });

  test("recreates a missing session from the current template", async () => {
    const root = await createRoot("eden-eve-patch-resume-missing-");
    const fixture = await createResumeFixture(root);
    await writeTemplateFixture(fixture.templateRoot);

    await fixture.resume(
      { sessionsDir: fixture.sessionsDir },
      { templateRootPath: fixture.templateRoot, generation: "gen-2", sessionId: "session-1" },
      { generation: "gen-1", rootPath: fixture.sessionRoot },
    );

    expect(fixture.openCalls).toEqual([fixture.sessionRoot]);
    expect(
      await readFile(
        join(fixture.sessionRoot, "fs/.agents/skills/greet/SKILL.md"),
        "utf8",
      ),
    ).toContain("Say hello (v2)");
  });

  test("keeps throwing for a session root outside the sessions directory", async () => {
    const root = await createRoot("eden-eve-patch-resume-escape-");
    const fixture = await createResumeFixture(root);
    await writeTemplateFixture(fixture.templateRoot);
    const escapedRoot = join(root, "elsewhere", "session-1");

    await expect(
      fixture.resume(
        { sessionsDir: fixture.sessionsDir },
        { templateRootPath: fixture.templateRoot, generation: "gen-2", sessionId: "session-1" },
        { generation: "gen-1", rootPath: escapedRoot },
      ),
    ).rejects.toThrow("incompatible with this environment");
    expect(fixture.openCalls).toEqual([]);
  });

  test("reopens an unchanged session as-is and recreates a missing one", async () => {
    const root = await createRoot("eden-eve-patch-resume-same-");
    const fixture = await createResumeFixture(root);
    await writeTemplateFixture(fixture.templateRoot);
    await writeSessionFixture(fixture.sessionRoot);

    await fixture.resume(
      { sessionsDir: fixture.sessionsDir },
      { templateRootPath: fixture.templateRoot, generation: "gen-1", sessionId: "session-1" },
      { generation: "gen-1", rootPath: fixture.sessionRoot },
    );
    expect(fixture.openCalls).toEqual([fixture.sessionRoot]);
    expect(
      await readFile(
        join(fixture.sessionRoot, "fs/.agents/skills/old/SKILL.md"),
        "utf8",
      ),
    ).toBe("stale\n");

    const gone = join(fixture.sessionsDir, "gone");
    await fixture.resume(
      { sessionsDir: fixture.sessionsDir },
      { templateRootPath: fixture.templateRoot, generation: "gen-1", sessionId: "session-1" },
      { generation: "gen-1", rootPath: gone },
    );
    expect(fixture.openCalls).toEqual([fixture.sessionRoot, gone]);
    await expect(access(gone)).resolves.toBeUndefined();
  });

  test("leaves session skills untouched when the template has none", async () => {
    const root = await createRoot("eden-eve-patch-resume-noskills-");
    const fixture = await createResumeFixture(root);
    await mkdir(join(fixture.templateRoot, "fs/workspace"), {
      recursive: true,
    });
    await writeSessionFixture(fixture.sessionRoot);

    await fixture.resume(
      { sessionsDir: fixture.sessionsDir },
      { templateRootPath: fixture.templateRoot, generation: "gen-2", sessionId: "session-1" },
      { generation: "gen-1", rootPath: fixture.sessionRoot },
    );
    expect(fixture.openCalls).toEqual([fixture.sessionRoot]);
    expect(
      await readFile(
        join(fixture.sessionRoot, "fs/.agents/skills/old/SKILL.md"),
        "utf8",
      ),
    ).toBe("stale\n");
  });
});

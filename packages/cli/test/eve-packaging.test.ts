import {
  createHash,
} from "node:crypto";
import {
  access,
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
  checkEveSandboxProvider,
  createDockerEveProjectBuilder,
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
  await mkdir(join(root, "agent"), { recursive: true });
  await writeFile(join(root, "agent/sandbox.ts"),
    "import { defineSandbox } from 'eve/sandbox';\nimport { JustBashSandbox } from 'eve/sandbox/just-bash';\nexport const environment = JustBashSandbox.environment();\nexport default defineSandbox(() => environment.open());\n");
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
          eveVersion: "0.91.0",
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
    JSON.stringify({ name: "eve", version: "0.91.0", bin: "bin/eve.js" }),
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
  const template = join(request.snapshotRoot, ".eve/sandbox-cache/just-bash/templates/7bc778099a3b436ce4ad98ba");
  await mkdir(join(template, "fs/workspace"), { recursive: true });
  await writeFile(join(template, "metadata.json"), JSON.stringify({
    version: 1, templateKey: "7bc778099a3b436ce4ad98ba", env: { HOME: "/home/agent" },
  }) + "\n");
}

async function writeFakeDockerCommand(
  root: string,
  options: {
    readonly buildStderr?: string;
    readonly eveVersion?: string;
    readonly sandboxCache?: "present" | "absent" | "escaping-symlink" | "special-file" | "unsupported-provider";
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
      JSON.stringify({ name: "eve", version: ${JSON.stringify(options.eveVersion ?? "0.91.0")} }),
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
        sandboxCacheMode === "unsupported-provider"
          ? "docker/templates/7bc778099a3b436ce4ad98ba"
          : "just-bash/templates/7bc778099a3b436ce4ad98ba",
      );
      fs.mkdirSync(path.join(template, "fs/workspace"), { recursive: true });
      fs.writeFileSync(
        path.join(template, "metadata.json"),
        JSON.stringify({ version: 1, templateKey: "7bc778099a3b436ce4ad98ba", env: { HOME: "/home/agent" } }) + "\\n",
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
  test.each([
    { version: "0.91.0", provider: undefined, failed: true },
    { version: "0.91.0", provider: "DefaultSandbox", failed: true },
    { version: "1.0.0", provider: undefined, failed: true },
    { version: "0.91.0", provider: "DockerSandbox", failed: true },
    { version: "0.91.0", provider: "JustBashSandbox", failed: false },
  ])("gates Eve $version with $provider at the explicit-provider boundary", async ({ provider, failed }) => {
    const root = await createRoot("eden-eve-sandbox-provider-");
    await writeProject(root);
    await rm(join(root, "agent"), { recursive: true, force: true });
    if (provider !== undefined) {
      await mkdir(join(root, "agent/sandbox"), { recursive: true });
      const specifier = provider === "JustBashSandbox" ? "eve/sandbox/just-bash" : "eve/sandbox";
      await writeFile(join(root, "agent/sandbox/sandbox.ts"),
        `import { ${provider} } from '${specifier}';\nexport const environment = ${provider}.environment();\nexport default defineSandbox(() => environment.open());\n`);
    }
    const error = await checkEveSandboxProvider(root);
    expect(error?.code).toBe(failed ? "EVE_SANDBOX_PROVIDER" : undefined);
    if (failed) expect(error?.remediation).toContain("pnpm add just-bash");
  });


  test.each([undefined, "npm@11.13.0"])("packages npm locks without converting source (%s)", async (packageManager) => {
    const root = await createRoot("eden-eve-package-npm-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root, { packageJson: JSON.stringify({
      name: "eve-fixture", ...(packageManager === undefined ? {} : { packageManager }),
    }) });
    await rm(join(root, "pnpm-lock.yaml"));
    const lock = JSON.stringify({ name: "eve-fixture", lockfileVersion: 3, packages: { "": { name: "eve-fixture" } } });
    await writeFile(join(root, "package-lock.json"), lock);
    await writeFile(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=excluded\n");
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);
    const result = await buildEveProjectSnapshot({
      projectRoot: root,
      artifactRoot: join(artifacts, "generation-one"),
      builder,
      nodeImage: { reference: "node:24.17.0-bookworm-slim", digest: `sha256:${"0".repeat(64)}` },
    });
    expect(result.status).toBe("ready");
    expect(result.toolchain).toMatchObject({
      packageManager: "npm", packageManagerVersion: "11.13.0",
      installCommand: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      lockfileUnchanged: true,
    });
    expect(result.project?.lockfile.path).toBe("package-lock.json");
    expect(await readFile(join(root, "package-lock.json"), "utf8")).toBe(lock);
    expect(await readFile(join(requests[0]!.snapshotRoot, "package-lock.json"), "utf8")).toBe(lock);
    await expect(access(join(requests[0]!.snapshotRoot, ".npmrc"))).rejects.toThrow();
    const dockerfile = await readFile(join(artifacts, "generation-one/container/Dockerfile"), "utf8");
    expect(dockerfile).toContain("npm install --global npm@11.13.0 --ignore-scripts");
    expect(dockerfile).toContain("npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/");
    expect(dockerfile).toContain("--omit=dev");
    expect(dockerfile.match(/sha256sum package-lock.json/gu)?.length).toBe(5);
    expect(dockerfile).not.toContain("corepack pnpm");
  });

  test("rejects npm lock mutation by an isolated builder", async () => {
    const root = await createRoot("eden-eve-package-npm-mutation-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root, { packageJson: JSON.stringify({ name: "eve-fixture" }) });
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    const { builder } = fakeBuilder(async (request) => {
      await writeSuccessfulBuild(request);
      await writeFile(join(request.snapshotRoot, "package-lock.json"), "{}");
    });
    const result = await buildEveProjectSnapshot({
      projectRoot: root, artifactRoot: join(artifacts, "generation-one"), builder,
    });
    expect(result.error).toMatchObject({ code: "SOURCE_RACE", subject: "package-lock.json" });
  });

  test.each([
    ["invalid lock", "{}"],
    ["private registry", JSON.stringify({ lockfileVersion: 3, packages: {
      "": {}, "node_modules/private": { resolved: "https://private.example/package.tgz" },
    } })],
  ])("rejects unsupported npm inputs: %s", async (_name, lock) => {
    const root = await createRoot("eden-eve-package-npm-invalid-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root, { packageJson: JSON.stringify({ name: "eve-fixture" }) });
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, "package-lock.json"), lock);
    const { builder, requests } = fakeBuilder(writeSuccessfulBuild);
    const result = await buildEveProjectSnapshot({
      projectRoot: root, artifactRoot: join(artifacts, "generation-one"), builder,
    });
    expect(result.error?.code).toBe("DEPENDENCY_AMBIGUITY");
    expect(requests).toHaveLength(0);
  });

  test("classifies npm ci failures without relabeling Eve builds", async () => {
    const root = await createRoot("eden-eve-package-npm-failure-");
    const artifacts = await createRoot("eden-eve-package-artifacts-");
    await writeProject(root, { packageJson: JSON.stringify({ name: "eve-fixture" }) });
    await rm(join(root, "pnpm-lock.yaml"));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      buildStderr: 'ERROR: process "/bin/sh -c npm ci --ignore-scripts" did not complete: npm error code EUSAGE\n',
    });
    const builder = createDockerEveProjectBuilder({
      dockerCommand: fakeDocker.command,
      nodeImage: { reference: "node:24.17.0-bookworm-slim", digest: `sha256:${"0".repeat(64)}` },
    });
    const result = await buildEveProjectSnapshot({
      projectRoot: root, artifactRoot: join(artifacts, "generation-one"), builder,
    });
    expect(result.error).toMatchObject({ code: "DEPENDENCY_AMBIGUITY", subject: "npm EUSAGE" });
    expect(result.error?.remediation).toContain("package-lock.json");
  });

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
        eveVersion: "0.91.0",
      },
      snapshot: {
        includedFileCount: 4,
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
        return { eveVersion: "0.91.0" };
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
        eveVersion: "0.91.0",
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
        JSON.stringify({ name: "not-eve", version: "0.91.0", bin: "bin/eve.js" }),
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
      "--load",
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
        JSON.stringify({ name: "eve", version: "0.91.0", bin: "bin/eve.js" }),
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

  test.each(["0.91.0"])("extracts the prepared JustBash sandbox template for Eve %s into the generation snapshot", async (eveVersion) => {
    const root = await createRoot("eden-eve-package-sandbox-extract-");
    const artifacts = await createRoot("eden-eve-package-sandbox-artifacts-");
    await writeProject(root);
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "agent/sandbox.ts"),
      `import { defineSandbox } from 'eve/sandbox';
import { JustBashSandbox } from 'eve/sandbox/just-bash';
export const environment = JustBashSandbox.environment();
export default defineSandbox(() => environment.open());
`);
    const fakeDocker = await writeFakeDockerCommand(artifacts, { eveVersion });
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


  test("blocks a build that prepared no just-bash template though the sandbox module passed the source check", async () => {
    const root = await createRoot("eden-eve-package-sandbox-unresolved-");
    const artifacts = await createRoot("eden-eve-package-sandbox-unresolved-artifacts-");
    await writeProject(root);
    await mkdir(join(root, "agent"), { recursive: true });
    // The provider hides in a helper, so only the build output shows what Eve selected.
    await writeFile(join(root, "agent/sandbox.ts"), `import { defineSandbox } from 'eve/sandbox';
import { environment } from './sandbox-env';
export { environment };
export default defineSandbox(() => environment.open());
`);
    await writeFile(join(root, "agent/sandbox-env.ts"), `import { DefaultSandbox } from 'eve/sandbox';
export const environment = DefaultSandbox.environment();
`);
    const fakeDocker = await writeFakeDockerCommand(artifacts, { eveVersion: "0.91.0", sandboxCache: "absent" });
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
      returnCode: "EVE_SANDBOX_PROVIDER",
      candidate: null,
    });
  });

  test("rejects a prepared native provider template with JustBash remediation", async () => {
    const root = await createRoot("eden-eve-package-sandbox-provider-");
    const artifacts = await createRoot("eden-eve-package-sandbox-provider-artifacts-");
    await writeProject(root);
    const fakeDocker = await writeFakeDockerCommand(artifacts, {
      sandboxCache: "unsupported-provider",
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
      returnCode: "EVE_SANDBOX_PROVIDER",
      candidate: null,
      error: {
        subject: ".eve/sandbox-cache/docker",
        remediation: expect.stringContaining("explicit JustBash"),
      },
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


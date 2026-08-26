import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { expect, test } from "vitest";
import {
  ownedProcessReservationCount,
  ownedProcessReservationLabels,
  runOwnedProcess,
} from "./owned-process.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspacePackageDirectories = [
  "packages/definitions",
  "packages/compiler",
  "packages/runtime-cloudflare",
  "packages/client",
  "packages/cli",
  "examples/basic-agent",
];
// Six package-local processes run serially. Repeated cold runs measured
// 225.9s for this assertion and 96.0s for the separate compiler-filter
// assertion. A 300s budget leaves at least a 74.1s margin for the slower
// assertion while staying scoped to this portability regression instead of
// masking unrelated hangs globally.
const PACKAGE_TEST_SCRIPTS_TIMEOUT_MS =
  Number.parseInt(
    process.env.EDEN_PACKAGE_TEST_SCRIPTS_TIMEOUT_MS ?? "",
    10,
  ) || 300_000;
// The slowest observed compiler-filter child was 96.0s; retain a measured 54s
// cushion for cold starts and serial load while still bounding one hung child
// well inside the enclosing 300s assertion.
const PACKAGE_TEST_PROCESS_TIMEOUT_MS =
  Number.parseInt(process.env.EDEN_PACKAGE_TEST_TIMEOUT_MS ?? "", 10) ||
  150_000;
// Keep compiler output bounded while leaving a measured margin over the
// harness default for six serial package logs. This is intentionally finite;
// a noisy or stuck compiler must produce an explicit harness failure.
const PACKAGE_TEST_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return name;
}

function findExecutable(name) {
  const directories = (process.env.PATH ?? "").split(":");
  if (process.env.BUN_INSTALL !== undefined) {
    directories.push(join(process.env.BUN_INSTALL, "bin"));
  }
  if (process.env.HOME !== undefined) {
    directories.push(join(process.env.HOME, ".bun", "bin"));
  }
  for (const directory of directories) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH and standard Bun locations.
    }
  }
  return undefined;
}

const tarEntrypoint = resolveExecutable("tar");
const npmEntrypoint = findExecutable("npm");
const bunEntrypoint = findExecutable("bun");

const corepackEntrypoint = resolveExecutable("corepack");

async function runPnpm(args, cwd, options = {}) {
  const result = await runOwnedProcess({
    file: options.file ?? process.execPath,
    args:
      options.file === undefined
        ? [corepackEntrypoint, "pnpm", ...args]
        : args,
    cwd,
    timeoutMs: options.timeoutMs ?? PACKAGE_TEST_PROCESS_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? PACKAGE_TEST_MAX_BUFFER_BYTES,
    label: options.label ?? "package-test",
  });
  let cleanupRetry;
  let finalResult = result;
  if (result.unresolvedCleanup) {
    cleanupRetry = await result.retryCleanup();
    finalResult = {
      ...result,
      cleanupVerified: cleanupRetry.cleanupVerified,
      unresolvedCleanup: cleanupRetry.unresolvedCleanup,
      cleanupFailure: cleanupRetry.cleanupFailure,
      cleanupStatus: cleanupRetry.cleanupStatus,
      remainingPids: async () => cleanupRetry.remainingPids,
      ok:
        result.code === 0 &&
        result.signal === null &&
        result.error === undefined &&
        !result.timedOut &&
        !result.aborted &&
        !result.outputLimitExceeded &&
        !result.stdoutTruncated &&
        !result.stderrTruncated &&
        cleanupRetry.cleanupVerified,
    };
  }
  return {
    ...finalResult,
    initialCleanupFailure: result.unresolvedCleanup
      ? result.cleanupFailure
      : undefined,
    cleanupRetry,
  };
}

async function runNpm(args, cwd, options = {}) {
  return runPnpm(
    [
      "-e",
      [
        'const { spawnSync } = require("node:child_process");',
        "const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: \"inherit\" });",
        "if (result.error !== undefined) throw result.error;",
        "if (result.signal !== null) process.kill(process.pid, result.signal);",
        "process.exitCode = result.status ?? 1;",
      ].join("\n"),
      npmEntrypoint,
      ...args,
    ],
    cwd,
    { ...options, file: process.execPath },
  );
}

function outcomeDiagnostic(result, label) {
  return [
    `${label} failed`,
    `timedOut=${result.timedOut}`,
    `aborted=${result.aborted}`,
    `code=${result.code ?? "null"}`,
    `signal=${result.signal ?? "null"}`,
    `cleanupFailure=${result.cleanupFailure ?? "none"}`,
    `initialCleanupFailure=${result.initialCleanupFailure ?? "none"}`,
    `cleanupStatus=${result.cleanupStatus}`,
    `stdoutTruncated=${result.stdoutTruncated}`,
    `stderrTruncated=${result.stderrTruncated}`,
    `outputLimitExceeded=${result.outputLimitExceeded}`,
    `terminationReason=${result.terminationReason ?? "none"}`,
    `reservations=${JSON.stringify(ownedProcessReservationLabels())}`,
    `stdout=${result.stdout}`,
    `stderr=${result.stderr}`,
    `error=${result.error?.message ?? "none"}`,
  ].join(" ");
}

function expectNoReservations(label) {
  expect(
    ownedProcessReservationCount(),
    `${label} reservations=${JSON.stringify(ownedProcessReservationLabels())}`,
  ).toBe(0);
}

function expectSuccessfulPackageChild(result, label) {
  try {
    expect(result.ok, outcomeDiagnostic(result, label)).toBe(true);
    expect(result.timedOut, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.cleanupFailure, outcomeDiagnostic(result, label)).toBeUndefined();
    expect(result.unresolvedCleanup, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.stdoutTruncated, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.stderrTruncated, outcomeDiagnostic(result, label)).toBe(false);
    expect(result.outputLimitExceeded, outcomeDiagnostic(result, label)).toBe(false);
  } finally {
    expectNoReservations(label);
  }
}

const distributionPackages = [
  {
    directory: "packages/definitions",
    name: "@moinulmoin/eden-definitions",
    requiredDistFiles: ["dist/index.js", "dist/index.d.ts"],
  },
  {
    directory: "packages/compiler",
    name: "@moinulmoin/eden-compiler",
    requiredDistFiles: ["dist/index.js", "dist/index.d.ts"],
    dependencies: {
      "@moinulmoin/eden-definitions": "0.1.2",
    },
  },
  {
    directory: "packages/runtime-cloudflare",
    name: "@moinulmoin/eden-runtime-cloudflare",
    requiredDistFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/test-worker.js",
      "dist/eden-eve-host-worker.mjs",
    ],
    dependencies: {
      "@moinulmoin/eden-definitions": "0.1.2",
    },
  },
  {
    directory: "packages/cli",
    name: "@moinulmoin/eden",
    requiredDistFiles: ["dist/index.js", "dist/index.d.ts"],
    requiredRootFiles: ["README.md"],
    dependencies: {
      "@moinulmoin/eden-compiler": "0.1.2",
      "@moinulmoin/eden-runtime-cloudflare": "0.1.2",
    },
    bin: {
      eden: "./dist/index.js",
    },
  },
];

async function tarEntries(tarball, cwd, label) {
  const result = await runPnpm(
    ["-tzf", tarball],
    cwd,
    { file: tarEntrypoint, label },
  );
  expectSuccessfulPackageChild(result, label);
  return result.stdout.split(/\r?\n/u).filter((entry) => entry.length > 0);
}

async function tarMember(tarball, member, cwd, label) {
  const result = await runPnpm(
    ["-xOf", tarball, member],
    cwd,
    { file: tarEntrypoint, label },
  );
  expectSuccessfulPackageChild(result, label);
  return result.stdout;
}

async function packageBin(consumerRoot, label) {
  const binPath = join(consumerRoot, "node_modules", ".bin", "eden");
  const packageEntryPath = join(
    consumerRoot,
    "node_modules",
    "@moinulmoin",
    "eden",
    "dist",
    "index.js",
  );
  accessSync(binPath, constants.X_OK);
  accessSync(packageEntryPath, constants.R_OK);
  return { binPath, packageEntryPath, label };
}

async function runInstalledEden(
  consumerRoot,
  args,
  label,
  { nodeOwned = false } = {},
) {
  const { binPath, packageEntryPath } = await packageBin(consumerRoot, label);
  const result = await runPnpm(
    nodeOwned ? [packageEntryPath, ...args] : args,
    consumerRoot,
    {
      file: nodeOwned ? process.execPath : binPath,
      label,
    },
  );
  expectSuccessfulPackageChild(result, label);
  return result;
}
function localTarballSpecs(root, tarballs) {
  return Object.fromEntries(
    distributionPackages.map(({ name: packageName }) => [
      packageName,
      `file:${relative(root, tarballs.get(packageName)).replaceAll("\\", "/")}`,
    ]),
  );
}
async function writeTarballConsumerManifest(
  root,
  name,
  tarballs,
  {
    npmOverrides = false,
    localOverrides = false,
  } = {},
) {
  const dependencies = localTarballSpecs(root, tarballs);
  const manifest = {
    name,
    private: true,
    type: "module",
    dependencies,
    ...(npmOverrides || localOverrides
      ? {
          overrides: localOverrides
            ? dependencies
            : Object.fromEntries(
                Object.keys(dependencies).map((packageName) => [
                  packageName,
                  `$${packageName}`,
                ]),
              ),
        }
      : {}),
  };
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function writePnpmOverrides(root, tarballs) {
  const overrides = Object.entries(localTarballSpecs(root, tarballs))
    .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
    .join("\n");
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    `packages: []\noverrides:\n${overrides}\n`,
    "utf8",
  );
}

test.sequential(
  "workspace package test scripts run from their own directories",
  async () => {
    for (const directory of workspacePackageDirectories) {
      const packageJson = JSON.parse(
        await readFile(join(repositoryRoot, directory, "package.json"), "utf8"),
      );
      expect(packageJson.scripts.test).toContain("--maxWorkers=1");

      const result = await runPnpm(
        ["run", "test"],
        join(repositoryRoot, directory),
      );
      expectSuccessfulPackageChild(result, directory);
    }
  },
  PACKAGE_TEST_SCRIPTS_TIMEOUT_MS,
);

test.sequential(
  "the compiler test script works through a workspace filter",
  async () => {
    const result = await runPnpm(
      ["--filter", "@moinulmoin/eden-compiler", "run", "test"],
      repositoryRoot,
      { timeoutMs: PACKAGE_TEST_PROCESS_TIMEOUT_MS },
    );
    expectSuccessfulPackageChild(result, "@moinulmoin/eden-compiler filter");
  },
  PACKAGE_TEST_SCRIPTS_TIMEOUT_MS,
);

test("aborts a hung package child tree before the next package script", async () => {
  const result = await runPnpm(
    [
      "-e",
      [
        'const { spawn } = await import("node:child_process");',
        'process.on("SIGTERM", () => {});',
        'spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    repositoryRoot,
    {
      file: process.execPath,
      timeoutMs: 150,
      label: "package-hung-fixture",
    },
  );

  try {
    expect(result.ok, outcomeDiagnostic(result, "package hung fixture")).toBe(
      false,
    );
    expect(result.code).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.cleanupVerified).toBe(true);
    await expect(result.remainingPids()).resolves.toEqual([]);
  } finally {
    expectNoReservations("package hung fixture");
  }

  const followUp = await runPnpm(
    [
      "-e",
      'setTimeout(() => process.stdout.write("after-hung-package"), 100)',
    ],
    repositoryRoot,
    {
      file: process.execPath,
      timeoutMs: 2_000,
      label: "package-follow-up",
    },
  );
  expectSuccessfulPackageChild(followUp, "package follow-up");
  expect(followUp.stdout).toBe("after-hung-package");
});

test("treats a signal or null-code package child as a failure", async () => {
  const result = await runPnpm(
    [
      "-e",
      'setTimeout(() => process.kill(process.pid, "SIGTERM"), 500)',
    ],
    repositoryRoot,
    {
      file: process.execPath,
      timeoutMs: 2_000,
      label: "package-signal-fixture",
    },
  );

  try {
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.ok, outcomeDiagnostic(result, "package signal fixture")).toBe(
      false,
    );
    expect(result.cleanupVerified).toBe(true);
    await expect(result.remainingPids()).resolves.toEqual([]);
  } finally {
    expectNoReservations("package signal fixture");
  }
});

test.sequential(
  "release package tarballs install cleanly outside the workspace",
  async () => {
    const cleanRoom = await mkdtemp(join(tmpdir(), "eden-distribution-"));
    try {
      const tarballDirectory = join(cleanRoom, "tarballs");
      await mkdir(tarballDirectory);
      const tarballs = new Map();

      for (const packageSpec of distributionPackages) {
        const packageRoot = join(repositoryRoot, packageSpec.directory);
        const before = new Set(await readdir(tarballDirectory));
        const result = await runPnpm(
          ["pack", "--pack-destination", tarballDirectory],
          packageRoot,
          { label: `pack ${packageSpec.name}` },
        );
        expectSuccessfulPackageChild(result, `pack ${packageSpec.name}`);
        const newTarballs = (await readdir(tarballDirectory)).filter(
          (entry) => !before.has(entry) && entry.endsWith(".tgz"),
        );
        expect(newTarballs, `one tarball for ${packageSpec.name}`).toHaveLength(1);
        tarballs.set(packageSpec.name, join(tarballDirectory, newTarballs[0]));
      }

      const repositoryLicense = await readFile(
        join(repositoryRoot, "LICENSE"),
        "utf8",
      );
      const repositoryNotice = await readFile(
        join(repositoryRoot, "NOTICE"),
        "utf8",
      );
      for (const packageSpec of distributionPackages) {
        const tarball = tarballs.get(packageSpec.name);
        const label = `inspect ${packageSpec.name}`;
        const entries = await tarEntries(tarball, cleanRoom, `${label} manifest`);
        expect(new Set(entries).size, `${label} duplicate entries`).toBe(
          entries.length,
        );
        expect(entries).toEqual(
          expect.arrayContaining([
            "package/package.json",
            "package/LICENSE",
            "package/NOTICE",
            ...packageSpec.requiredDistFiles.map((file) => `package/${file}`),
            ...(packageSpec.requiredRootFiles ?? []).map(
              (file) => `package/${file}`,
            ),
          ]),
        );
        const unexpectedEntries = entries.filter((entry) => {
          if (
            entry === "package/" ||
            entry === "package/dist" ||
            entry === "package/LICENSE" ||
            entry === "package/NOTICE" ||
            entry === "package/README.md" ||
            entry === "package/package.json"
          ) {
            return false;
          }
          return !entry.startsWith("package/dist/");
        });
        expect(unexpectedEntries, `${label} package file allowlist`).toEqual([]);
        expect(
          entries.some((entry) =>
            /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.eden|\.wrangler)/u.test(
              entry,
            ),
          ),
          `${label} generated project files`,
        ).toBe(false);
        expect(
          entries.filter((entry) =>
            /\.map$|\.tsbuildinfo$|^package\/(?:src|test|node_modules)\//u.test(
              entry,
            ),
          ),
          `${label} generated/source exclusions`,
        ).toEqual([]);
        for (const file of packageSpec.requiredDistFiles) {
          const content = await tarMember(
            tarball,
            `package/${file}`,
            cleanRoom,
            `${label} ${file}`,
          );
          expect(content.length, `${label} ${file} content`).toBeGreaterThan(0);
        }

        const packageJson = JSON.parse(
          await tarMember(tarball, "package/package.json", cleanRoom, label),
        );
        expect(packageJson.name).toBe(packageSpec.name);
        expect(packageJson.version).toBe("0.1.2");
        expect(packageJson.private ?? false).toBe(false);
        expect(packageJson.license).toBe("Apache-2.0");
        expect(packageJson.bin).toEqual(packageSpec.bin);
        if (packageSpec.dependencies !== undefined) {
          expect(packageJson.dependencies).toMatchObject(packageSpec.dependencies);
        }
        for (const section of [
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
          "devDependencies",
        ]) {
          for (const [dependency, spec] of Object.entries(
            packageJson[section] ?? {},
          )) {
            expect(spec, `${label} ${section}.${dependency}`).toEqual(
              expect.any(String),
            );
            expect(
              spec,
              `${label} ${section}.${dependency} npm closure`,
            ).not.toMatch(/^(?:workspace:|file:|link:|\.{1,2}\/|\/)/u);
          }
        }
        await expect(
          tarMember(tarball, "package/LICENSE", cleanRoom, `${label} LICENSE`),
        ).resolves.toBe(repositoryLicense);
        await expect(
          tarMember(tarball, "package/NOTICE", cleanRoom, `${label} NOTICE`),
        ).resolves.toBe(repositoryNotice);
      }

      expect(npmEntrypoint, "npm is required for the installer proof").toBeDefined();
      const npmConsumer = await mkdtemp(join(cleanRoom, "npm-consumer-"));
      await writeTarballConsumerManifest(
        npmConsumer,
        "eden-distribution-npm-consumer",
        tarballs,
        { npmOverrides: true },
      );
      const npmInstall = await runNpm(
        ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
        npmConsumer,
        { label: "npm local tarball install" },
      );
      expectSuccessfulPackageChild(npmInstall, "npm local tarball install");
      const npmHelp = await runInstalledEden(
        npmConsumer,
        ["--help"],
        "npm installed eden help",
      );
      expect(npmHelp.stdout).toContain("Usage: eden <command>");
      const pnpmConsumer = await mkdtemp(join(cleanRoom, "pnpm-consumer-"));
      await writeTarballConsumerManifest(
        pnpmConsumer,
        "eden-distribution-pnpm-consumer",
        tarballs,
      );
      await writePnpmOverrides(pnpmConsumer, tarballs);
      const pnpmInstall = await runPnpm(
        ["install", "--prefer-offline", "--ignore-scripts"],
        pnpmConsumer,
        { label: "pnpm tarball install" },
      );
      expectSuccessfulPackageChild(pnpmInstall, "pnpm tarball install");
      const pnpmHelp = await runInstalledEden(
        pnpmConsumer,
        ["--help"],
        "pnpm installed eden help",
      );
      expect(pnpmHelp.stdout).toContain("Usage: eden <command>");
      const pnpmAgent = join(pnpmConsumer, "agent-project");
      await mkdir(pnpmAgent);
      const pnpmInit = await runInstalledEden(
        pnpmConsumer,
        ["agent", "init", "--project", pnpmAgent],
        "pnpm installed eden agent init",
        { nodeOwned: true },
      );
      expect(pnpmInit.stdout).toContain("Initialized Eden project");
      const pnpmBuild = await runInstalledEden(
        pnpmConsumer,
        ["agent", "build", "--project", pnpmAgent],
        "pnpm installed eden agent build",
        { nodeOwned: true },
      );
      expect(pnpmBuild.code).toBe(0);
      expect(await readdir(join(pnpmAgent, ".eden"))).toContain("CURRENT");

      expect(bunEntrypoint, "Bun is required for the installer proof").toBeDefined();
      const bunConsumer = await mkdtemp(join(cleanRoom, "bun-consumer-"));
      await writeTarballConsumerManifest(
        bunConsumer,
        "eden-distribution-bun-consumer",
        tarballs,
        { localOverrides: true },
      );
      const bunInstall = await runPnpm(
        ["install", "--no-progress", "--ignore-scripts"],
        bunConsumer,
        {
          file: bunEntrypoint,
          label: "bun local tarball install",
        },
      );
      expectSuccessfulPackageChild(bunInstall, "bun local tarball install");
      const bunHelp = await runInstalledEden(
        bunConsumer,
        ["--help"],
        "bun installed eden help",
      );
      expect(bunHelp.stdout).toContain("Usage: eden <command>");
    } finally {
      await rm(cleanRoom, { recursive: true, force: true });
      expectNoReservations("release package distribution");
    }
  },
  PACKAGE_TEST_SCRIPTS_TIMEOUT_MS,
);

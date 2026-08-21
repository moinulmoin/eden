import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  EDEN_CLI_COMMANDS,
  EveCliError,
  isEdenCliCommand,
  parseEveArguments,
  runEdenCli,
  type EveCliHelp,
} from "../src/index.js";
import type {
  EvePreflightRuntimeRunnerRequest,
} from "../src/index.js";
import type { EveProjectBuilderRequest } from "../src/eve-packaging.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-eve-namespace-"));
  roots.push(root);
  return root;
}

async function writeSuccessfulBuild(
  request: EveProjectBuilderRequest,
): Promise<void> {
  await mkdir(join(request.snapshotRoot, "node_modules/eve/bin"), {
    recursive: true,
  });
  await writeFile(
    join(request.snapshotRoot, "node_modules/eve/package.json"),
    JSON.stringify({ name: "eve", version: "0.31.3", bin: "bin/eve.js" }),
    "utf8",
  );
  await writeFile(
    join(request.snapshotRoot, "node_modules/eve/bin/eve.js"),
    "#!/usr/bin/env node\n",
    { encoding: "utf8", mode: 0o755 },
  );
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

function fakeBuilder(
  mutate?: (request: EveProjectBuilderRequest) => Promise<void>,
) {
  return {
    async build(request: EveProjectBuilderRequest) {
      await writeSuccessfulBuild(request);
      await mutate?.(request);
      return { eveVersion: "0.31.3" };
    },
  };
}

const runtimeCleanup = {
  bootContainerId: null,
  bootContainerRemoved: true,
  imageIdentity: "exact" as const,
  imageRetained: false,
  verified: true,
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("eden eve namespace", () => {
  test("keeps Native commands visible while adding a separate Eve namespace", async () => {
    const output: string[] = [];

    await expect(
      runEdenCli(["--help"], {
        stdout: (line) => output.push(line),
      }),
    ).resolves.toBe(0);

    expect(output.join("\n")).toMatch(/init|build|dev|deploy/u);
    expect(output.join("\n")).toMatch(/eve/u);
    expect(EDEN_CLI_COMMANDS).toEqual(["init", "dev", "build", "deploy"]);
    expect(isEdenCliCommand("eve")).toBe(false);
  });

  test.each([
    ["namespace", ["eve", "--help"], /preflight|deploy|destroy/u],
    ["preflight", ["eve", "preflight", "--help"], /--project|--env-file/u],
    ["deploy", ["eve", "deploy", "--help"], /--project|--env-file/u],
    ["destroy", ["eve", "destroy", "--help"], /--project|--name/u],
  ] as const)(
    "exposes actionable %s help without project side effects",
    async (_scope, args, expected) => {
      const missingProject = join(
        tmpdir(),
        "eden-eve-help-project-does-not-exist",
      );
      const before = await readdir(tmpdir());
      const output: string[] = [];
      const helpArgs = args[1] === "--help"
        ? args
        : [...args, "--project", missingProject];

      await expect(
        runEdenCli(helpArgs, {
          stdout: (line) => output.push(line),
          processRunner: {
            spawn() {
              throw new Error("help must not start a child");
            },
          },
          dryRunRunner: async () => {
            throw new Error("help must not run a Native dry-run");
          },
        }),
      ).resolves.toBe(0);

      expect(output.join("\n")).toMatch(expected);
      await expect(readdir(tmpdir())).resolves.toEqual(before);
    },
  );

  test("keeps Eve parsing separate from Native execution", async () => {
    const root = await createRoot();
    let nativeBuildInvoked = false;
    const errors: string[] = [];

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-namespace-test",
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => {
            nativeBuildInvoked = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).resolves.toBe(1);

    expect(nativeBuildInvoked).toBe(false);
    expect(errors.join("\n")).not.toMatch(/COMMAND_UNKNOWN/u);
  });

  test("passes only canonical selectors and an opaque env-file path to Eve", async () => {
    const root = await createRoot();
    const parent = join(root, "..");
    const requests: unknown[] = [];
    let nativeSpawned = false;
    let nativeDryRun = false;

    await expect(
      runEdenCli(
        [
          "eve",
          "deploy",
          "--project",
          join(parent, root.split("/").pop() as string),
          "--env",
          "production",
          "--name",
          "eve-opaque-path",
          "--env-file=/tmp/opaque-runtime.env",
        ],
        {
          cwd: parent,
          eveRunner: async (request) => {
            requests.push(request);
          },
          processRunner: {
            spawn() {
              nativeSpawned = true;
              throw new Error("Native process runner must not receive Eve work");
            },
          },
          dryRunRunner: async () => {
            nativeDryRun = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        command: "deploy",
        cwd: parent,
        projectRoot: await realpath(root),
        environment: "production",
        name: "eve-opaque-path",
        envFile: "/tmp/opaque-runtime.env",
      },
    ]);
    expect(nativeSpawned).toBe(false);
    expect(nativeDryRun).toBe(false);
  });

  test("redacts arbitrary Eve runner failures without Native fallback", async () => {
    const root = await createRoot();
    const errors: string[] = [];
    const secret = "eve-runner-secret-marker";

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-redacted-failure",
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          eveRunner: async () => {
            throw new Error(secret);
          },
        },
      ),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("EVE_EXECUTION_FAILED");
    expect(errors.join("\n")).not.toContain(secret);
  });

  test("routes a valid preflight through the concrete structured runner", async () => {
    const root = await createRoot();
    const output: string[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-concrete-preflight",
        ],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
        },
      ),
    ).resolves.toBe(1);

    expect(output.join("\n")).toContain('"command":"eve preflight"');
    expect(output.join("\n")).toContain('"checks"');
    expect(errors.join("\n")).toContain("EVE_PREFLIGHT_FAILED");
    expect(errors.join("\n")).not.toContain("EVE_EXECUTION_UNAVAILABLE");
  });

  test("produces a passing immutable candidate with exact read-only target evidence", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-control-plane-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
      "utf8",
    );
    const sourceBefore = await readFile(join(root, "package.json"));
    const lockfileBefore = await readFile(join(root, "pnpm-lock.yaml"));
    const output: string[] = [];
    const remoteReads: string[] = [];
    const runtimeRequests: EvePreflightRuntimeRunnerRequest[] = [];

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-read-only",
        ],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
            builder: fakeBuilder(),
            hostRequirements: {
              architecture: "linux/amd64",
              world: "supported",
              sandbox: "supported",
              privileged: false,
              devices: "none",
              kernel: "supported",
              network: "supported",
              durableLocalFilesystem: false,
            },
            runtimeRunner: async (request) => {
              runtimeRequests.push(request);
              return {
                ok: true,
                checks: [
                  {
                    id: "VAL-BUILD-005",
                    status: "passed",
                    message: "The immutable Linux/amd64 image candidate passed.",
                  },
                  {
                    id: "VAL-BUILD-006",
                    status: "passed",
                    message: "The official project-local Eve-start process passed.",
                  },
                  {
                    id: "VAL-BUILD-007",
                    status: "passed",
                    message: "The real Eve health and host-capability checks passed.",
                  },
                ],
                imageDigest: `sha256:${"a".repeat(64)}`,
                cleanup: runtimeCleanup,
              };
            },
            cloudflareRead: async (request) => {
              remoteReads.push(`${request.environment}:${request.name}`);
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly command: string;
      readonly ok: boolean;
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
      }[];
      readonly candidate: {
        readonly generationId: string;
        readonly imageDigest?: string;
      } | null;
    };
    expect(result.command).toBe("eve preflight");
    expect(result.ok).toBe(true);
    expect(result.candidate?.generationId).toBe("generation-one");
    expect(result.candidate?.imageDigest).toBe(`sha256:${"a".repeat(64)}`);
    expect(result.checks.map((value) => value.id)).toEqual(
      expect.arrayContaining([
        "VAL-CLI-004",
        "VAL-BUILD-001",
        "VAL-BUILD-002",
        "VAL-BUILD-003",
        "VAL-BUILD-004",
        "VAL-BUILD-005",
        "VAL-BUILD-006",
        "VAL-BUILD-007",
        "VAL-CLI-007-CLOUDFLARE-ACCESS",
        "VAL-CLI-007-TARGET-CONFLICT",
      ]),
    );
    expect(runtimeRequests).toHaveLength(1);
    expect(remoteReads).toEqual(["preview:eve-read-only"]);
    expect(await readFile(join(root, "package.json"))).toEqual(sourceBefore);
    expect(await readFile(join(root, "pnpm-lock.yaml"))).toEqual(lockfileBefore);
  });

  test("uses disposable local protected injection and redacts explicit runtime values", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-runtime-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const envFile = join(root, "runtime.env");
    const marker = "preflight-secret-marker-6f9a";
    await writeFile(envFile, `OPAQUE_RUNTIME=${marker}\n`, "utf8");
    const before = await readFile(envFile);
    const output: string[] = [];
    let injectedEnvironment: Readonly<Record<string, string>> | undefined;
    let remoteReadCount = 0;

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-runtime-read-only",
          "--env-file",
          envFile,
        ],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
            builder: fakeBuilder(),
            hostRequirements: {
              architecture: "linux/amd64",
              world: "supported",
              sandbox: "supported",
              privileged: false,
              devices: "none",
              kernel: "supported",
              network: "supported",
              durableLocalFilesystem: false,
            },
            runtimeRunner: async ({ runtimeInjection }) => {
              expect(runtimeInjection).toBeDefined();
              await runtimeInjection?.runLocal({
                cwd: root,
                hostEnvironment: {
                  HOST: "0.0.0.0",
                  NITRO_HOST: "0.0.0.0",
                  PORT: "8080",
                  NITRO_PORT: "8080",
                  NODE_ENV: "production",
                },
                run: (request) => {
                  injectedEnvironment = request.env;
                  throw new Error(`child output ${marker}`);
                },
              });
              return {
                ok: true,
                checks: [],
                cleanup: runtimeCleanup,
              };
            },
            cloudflareRead: async () => {
              remoteReadCount += 1;
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(injectedEnvironment?.OPAQUE_RUNTIME).toBe(marker);
    expect(output.join("\n")).not.toContain(marker);
    expect(await readFile(envFile)).toEqual(before);
    expect(remoteReadCount).toBe(0);
  });

  test("fails closed on an exact target conflict without a mutation seam", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-conflict-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const output: string[] = [];
    const operations: string[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "production",
          "--name",
          "eve-conflict",
        ],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
            builder: fakeBuilder(),
            hostRequirements: {
              architecture: "linux/amd64",
              world: "supported",
              sandbox: "supported",
              privileged: false,
              devices: "none",
              kernel: "supported",
              network: "supported",
              durableLocalFilesystem: false,
            },
            runtimeRunner: async () => ({
              ok: true,
              checks: [
                {
                  id: "VAL-BUILD-005",
                  status: "passed",
                  message: "Image passed.",
                },
                {
                  id: "VAL-BUILD-006",
                  status: "passed",
                  message: "Eve start passed.",
                },
                {
                  id: "VAL-BUILD-007",
                  status: "passed",
                  message: "Health passed.",
                },
              ],
              imageDigest: `sha256:${"b".repeat(64)}`,
              cleanup: runtimeCleanup,
            }),
            cloudflareRead: async () => {
              operations.push("exact-target-read");
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: {
                  state: "unowned",
                  message: "The exact target is owned by another system.",
                  remediation: "Choose a fresh exact target name.",
                },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
      }[];
    };
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "VAL-CLI-007-TARGET-CONFLICT",
      status: "failed",
    }));
    expect(errors.join("\n")).toContain("EVE_PREFLIGHT_FAILED");
    expect(operations).toEqual(["exact-target-read"]);
  });

  test("rejects a source race before any exact Cloudflare read", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-race-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const sourcePath = join(root, "source.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    let remoteReadCount = 0;

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-race",
        ],
        {
          cwd: root,
          eveControlPlane: {
            artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
            builder: fakeBuilder(async () => {
              await writeFile(sourcePath, "export const value = 2;\n", "utf8");
            }),
            hostRequirements: {
              architecture: "linux/amd64",
              world: "supported",
              sandbox: "supported",
              privileged: false,
              devices: "none",
              kernel: "supported",
              network: "supported",
              durableLocalFilesystem: false,
            },
            cloudflareRead: async () => {
              remoteReadCount += 1;
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(remoteReadCount).toBe(0);
    expect(await readFile(sourcePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("revalidates authored inputs after runtime health before any exact read", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-runtime-race-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const sourcePath = join(root, "source.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    let remoteReadCount = 0;

    await expect(
      runEdenCli(
        [
          "eve",
          "preflight",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-runtime-race",
        ],
        {
          cwd: root,
          eveControlPlane: {
            artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
            builder: fakeBuilder(),
            hostRequirements: {
              architecture: "linux/amd64",
              world: "supported",
              sandbox: "supported",
              privileged: false,
              devices: "none",
              kernel: "supported",
              network: "supported",
              durableLocalFilesystem: false,
            },
            runtimeRunner: async () => {
              await writeFile(sourcePath, "export const value = 2;\n", "utf8");
              return {
                ok: true,
                checks: [
                  {
                    id: "VAL-BUILD-005",
                    status: "passed",
                    message: "Image passed.",
                  },
                  {
                    id: "VAL-BUILD-006",
                    status: "passed",
                    message: "Eve start passed.",
                  },
                  {
                    id: "VAL-BUILD-007",
                    status: "passed",
                    message: "Health passed.",
                  },
                ],
                imageDigest: `sha256:${"c".repeat(64)}`,
                cleanup: runtimeCleanup,
              };
            },
            cloudflareRead: async () => {
              remoteReadCount += 1;
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(remoteReadCount).toBe(0);
    expect(await readFile(sourcePath, "utf8")).toBe("export const value = 2;\n");
  });

  test.each(["preflight", "deploy", "destroy"] as const)(
    "requires every explicit selector for %s",
    (command) => {
      const required = {
        project: ["--env", "preview", "--name", "eve-required"],
        env: ["--project", "/tmp/eve-project", "--name", "eve-required"],
        name: ["--project", "/tmp/eve-project", "--env", "preview"],
      } as const;

      for (const [missing, suffix] of Object.entries(required)) {
        let error: unknown;
        try {
          parseEveArguments(["eve", command, ...suffix]);
        } catch (caught: unknown) {
          error = caught;
        }
        expect(error).toBeInstanceOf(EveCliError);
        expect(error).toMatchObject({
          code: `EVE_${missing.toUpperCase()}_REQUIRED`,
        });
      }
    },
  );

  test("parses both environments and scopes env-file to preflight/deploy", () => {
    expect(
      parseEveArguments([
        "eve",
        "preflight",
        "--project",
        "/tmp/eve-project",
        "--env",
        "preview",
        "--name",
        "eve-preview",
        "--env-file=/tmp/eve.env",
      ]),
    ).toEqual({
      kind: "invocation",
      command: "preflight",
      projectRoot: "/tmp/eve-project",
      environment: "preview",
      name: "eve-preview",
      envFile: "/tmp/eve.env",
    });

    expect(
      parseEveArguments([
        "eve",
        "deploy",
        "--project=/tmp/eve-project",
        "--env=production",
        "--name=eve-production",
        "--env-file",
        "/tmp/eve.env",
      ]),
    ).toEqual({
      kind: "invocation",
      command: "deploy",
      projectRoot: "/tmp/eve-project",
      environment: "production",
      name: "eve-production",
      envFile: "/tmp/eve.env",
    });

    let error: unknown;
    try {
      parseEveArguments([
        "eve",
        "destroy",
        "--project",
        "/tmp/eve-project",
        "--env",
        "preview",
        "--name",
        "eve-preview",
        "--env-file",
        "/tmp/eve.env",
      ]);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EveCliError);
    expect(error).toMatchObject({ code: "EVE_ENV_FILE_UNSUPPORTED" });
  });

  test.each([
    [
      "invalid environment",
      ["--project", "/tmp/eve-project", "--env", "staging", "--name", "eve-preview"],
      "EVE_ENV_INVALID",
    ],
    [
      "repeated project",
      [
        "--project",
        "/tmp/one",
        "--project",
        "/tmp/two",
        "--env",
        "preview",
        "--name",
        "eve-preview",
      ],
      "EVE_PROJECT_REPEATED",
    ],
    [
      "missing option value",
      [
        "--project",
        "/tmp/eve-project",
        "--env",
        "preview",
        "--name",
        "eve-preview",
        "--env-file",
      ],
      "EVE_OPTION_VALUE_MISSING",
    ],
    [
      "malformed name",
      ["--project", "/tmp/eve-project", "--env", "preview", "--name", "Not_A_Worker"],
      "EVE_NAME_INVALID",
    ],
    [
      "unknown option",
      [
        "--project",
        "/tmp/eve-project",
        "--env",
        "preview",
        "--name",
        "eve-preview",
        "--unknown",
      ],
      "EVE_OPTION_UNKNOWN",
    ],
  ] as const)(
    "rejects %s before project resolution",
    (_description, suffix, expected) => {
      let error: unknown;
      try {
        parseEveArguments([
          "eve",
          "preflight",
          ...suffix,
        ]);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EveCliError);
      expect(error).toMatchObject({ code: expected });
    },
  );

  test("returns typed help markers for namespace and subcommands", () => {
    expect(parseEveArguments(["eve"])).toEqual<EveCliHelp>({
      kind: "help",
      scope: "namespace",
    });
    expect(parseEveArguments(["eve", "destroy", "--help"])).toEqual<EveCliHelp>({
      kind: "help",
      scope: "destroy",
    });
  });

  test("deploys one exact target, injects protected runtime values, and promotes only after health identity", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-deploy-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const envFile = join(root, "runtime.env");
    const marker = "deploy-secret-marker-1e9b";
    await writeFile(envFile, `OPAQUE_RUNTIME=${marker}\n`, "utf8");
    const output: string[] = [];
    const operations: string[] = [];
    let protectedPut = false;
    let promotedAfterHealth = false;
    const imageDigest = `sha256:${"d".repeat(64)}`;

    await expect(
      runEdenCli(
        [
          "eve",
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-deploy-fixture",
          "--env-file",
          envFile,
        ],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
            builder: fakeBuilder(),
            containerImageReference:
              `registry.example/eve@${imageDigest}`,
            hostRequirements: {
              architecture: "linux/amd64",
              world: "supported",
              sandbox: "supported",
              privileged: false,
              devices: "none",
              kernel: "supported",
              network: "supported",
              durableLocalFilesystem: false,
            },
            runtimeRunner: async ({ publicOrigin }) => {
              expect(publicOrigin).toBe(
                "https://eve-deploy-fixture.account.workers.dev",
              );
              return {
                ok: true,
                checks: [
                  {
                    id: "VAL-BUILD-005",
                    status: "passed",
                    message: "Image passed.",
                  },
                  {
                    id: "VAL-BUILD-006",
                    status: "passed",
                    message: "Eve start passed.",
                  },
                  {
                    id: "VAL-BUILD-007",
                    status: "passed",
                    message: "Health passed.",
                  },
                ],
                imageDigest,
                cleanup: {
                  ...runtimeCleanup,
                  imageRetained: true,
                },
              };
            },
            cloudflareRead: async () => ({
              accountAccess: "available",
              containerAccess: "available",
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: { state: "absent" },
            }),
            protectedStore: {
              async put(request) {
                protectedPut = true;
                expect(request.targetId).toContain("eve-deploy-fixture");
                expect(request.values.OPAQUE_RUNTIME).toBe(marker);
                return {
                  revision: "eve-runtime-revision-test",
                  handle: "eve-runtime-handle-test",
                };
              },
            },
            publish: async (request) => {
              operations.push("publish");
              expect(request.hostConfig.worker.name).toBe("eve-deploy-fixture");
              expect(request.hostConfig.worker.workers_dev).toBe(true);
              expect(request.hostConfig.worker.containers).toHaveLength(1);
              expect(request.hostConfig.worker.containers[0]?.max_instances).toBe(1);
              expect(request.hostConfig.worker.vars.EVE_PUBLIC_ORIGIN).toBe(
                "https://eve-deploy-fixture.account.workers.dev",
              );
              expect(
                request.hostConfig.worker.vars.EDEN_EVE_RUNTIME_REVISION,
              ).toBe("eve-runtime-handle-test");
              expect(request.workerSource).not.toContain(marker);
              return {
                status: "published",
                identity: request.identity,
                createdByAttempt: true,
                ownershipProven: true,
              };
            },
            health: async (request) => {
              operations.push("health");
              expect(request.identity.stableWorkersDevOrigin).toBe(
                "https://eve-deploy-fixture.account.workers.dev",
              );
              return {
                status: "ready",
                identity: request.identity,
              };
            },
            afterPromotion: () => {
              promotedAfterHealth = operations.includes("health");
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(protectedPut).toBe(true);
    expect(operations).toEqual(["publish", "health"]);
    expect(promotedAfterHealth).toBe(true);
    expect(output.join("\n")).not.toContain(marker);
    expect(output.join("\n")).toContain("eve deploy");
  });

  test("keeps deploy indeterminate and leaves the target pointer unchanged when publication outcome is ambiguous", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-indeterminate-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const errors: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        [
          "eve",
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-indeterminate-fixture",
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
            builder: fakeBuilder(),
            containerImageReference:
              `registry.example/eve@sha256:${"e".repeat(64)}`,
            hostRequirements: {
              architecture: "linux/amd64",
              world: "supported",
              sandbox: "supported",
              privileged: false,
              devices: "none",
              kernel: "supported",
              network: "supported",
              durableLocalFilesystem: false,
            },
            runtimeRunner: async () => ({
              ok: true,
              checks: [
                {
                  id: "VAL-BUILD-005",
                  status: "passed",
                  message: "Image passed.",
                },
                {
                  id: "VAL-BUILD-006",
                  status: "passed",
                  message: "Eve start passed.",
                },
                {
                  id: "VAL-BUILD-007",
                  status: "passed",
                  message: "Health passed.",
                },
              ],
              imageDigest: `sha256:${"e".repeat(64)}`,
              cleanup: runtimeCleanup,
            }),
            cloudflareRead: async () => ({
              accountAccess: "available",
              containerAccess: "available",
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: { state: "absent" },
            }),
            publish: async () => {
              operations.push("publish");
              return {
                status: "indeterminate",
                reason: "The publication response was lost.",
                ownershipEvidenceRetained: true,
              };
            },
            compensate: async () => {
              operations.push("compensate");
              throw new Error("ambiguous cleanup must not run");
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual(["publish"]);
    expect(errors.join("\n")).toContain("DEPLOY_INDETERMINATE");
    expect(errors.join("\n")).not.toContain("ambiguous cleanup");
  });
});

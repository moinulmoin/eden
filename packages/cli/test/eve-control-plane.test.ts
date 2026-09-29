import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  EDEN_CLI_COMMANDS,
  EveCliError,
  deriveEveTargetName,
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

describe("top-level Eden Deploy commands", () => {
  test("advertises the Deploy command surface", async () => {
    const output: string[] = [];

    await expect(
      runEdenCli(["--help"], {
        stdout: (line) => output.push(line),
      }),
    ).resolves.toBe(0);

    expect(output.join("\n")).toMatch(/preflight|deploy|destroy/u);
    expect(output.join("\n")).not.toMatch(/eden eve/u);
    expect(EDEN_CLI_COMMANDS).toEqual([
      "preflight",
      "deploy",
      "destroy",
    ]);
    expect(isEdenCliCommand("agent")).toBe(false);
    expect(isEdenCliCommand("eve")).toBe(false);
  });

  test.each([
    ["eve", "preflight"],
    ["native"],
    ["init"],
    ["build"],
    ["dev"],
  ] as const)("rejects obsolete root command path %j", async (...args) => {
    const errors: string[] = [];
    await expect(
      runEdenCli(args, {
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toMatch(/Unknown Eden command/u);
  });

  test.each([
    ["root", ["--help"], /preflight|deploy|destroy/u],
    ["preflight", ["preflight", "--help"], /--project|--env-file/u],
    ["deploy", ["deploy", "--help"], /--project|--env-file/u],
    ["destroy", ["destroy", "--help"], /--project|--name/u],
  ] as const)(
    "exposes actionable %s help without project side effects",
    async (_scope, args, expected) => {
      const before = await readdir(tmpdir());
      const output: string[] = [];
      const helpArgs = args;

      await expect(
        runEdenCli(helpArgs, {
          stdout: (line) => output.push(line),
        }),
      ).resolves.toBe(0);

      expect(output.join("\n")).toMatch(expected);
      await expect(readdir(tmpdir())).resolves.toEqual(before);
    },
  );


  test("passes only canonical selectors and an opaque env-file path to Eve", async () => {
    const root = await createRoot();
    const parent = join(root, "..");
    const requests: unknown[] = [];

    await expect(
      runEdenCli(
        ["deploy",
        "--project",
        join(parent, root.split("/").pop() as string),
        "--env",
        "production",
        "--name",
        "eve-opaque-path",
        "--env-file=/tmp/opaque-runtime.env",],
        {
          cwd: parent,
          eveRunner: async (request) => {
            requests.push(request);
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
  });

  test("redacts arbitrary Eve runner failures", async () => {
    const root = await createRoot();
    const errors: string[] = [];
    const secret = "eve-runner-secret-marker";

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-redacted-failure",],
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
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-concrete-preflight",
        "--json",],
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
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-read-only",
        "--json",],
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
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-runtime-read-only",
        "--env-file",
        envFile,],
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
        ["preflight",
        "--project",
        root,
        "--env",
        "production",
        "--name",
        "eve-conflict",
        "--json",],
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
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-race",],
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
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-runtime-race",],
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

  test("defaults preflight and deploy to cwd, preview, and a derived name", () => {
    for (const command of ["preflight", "deploy"] as const) {
      expect(parseEveArguments([command])).toEqual({
        kind: "invocation",
        command,
        projectRoot: ".",
        environment: "preview",
      });
    }
  });

  test.each(["destroy", "deploy --env production"] as const)(
    "requires an explicit --name for %s",
    (selection) => {
      const args = selection === "destroy"
        ? ["destroy"]
        : ["deploy", "--env", "production"];
      let error: unknown;
      try {
        parseEveArguments(args);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EveCliError);
      expect(error).toMatchObject({ code: "EVE_NAME_REQUIRED" });
    },
  );

  test("accepts destroy and production deploy with an explicit --name", () => {
    expect(parseEveArguments(["destroy", "--name", "eve-preview"]))
      .toEqual({
        kind: "invocation",
        command: "destroy",
        projectRoot: ".",
        environment: "preview",
        name: "eve-preview",
      });
    expect(
      parseEveArguments(
        ["deploy", "--env", "production", "--name", "eve-production"],
      ),
    ).toEqual({
      kind: "invocation",
      command: "deploy",
      projectRoot: ".",
      environment: "production",
      name: "eve-production",
    });
  });

  test("derives deterministic collision-safe Worker names", () => {
    expect(deriveEveTargetName("@my-org/My Eve_App"))
      .toBe(deriveEveTargetName("@my-org/My Eve_App"));
    const derived = deriveEveTargetName("@my-org/My Eve_App");
    expect(derived).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
    expect(derived.startsWith("my-org-my-eve-app-")).toBe(true);
    // Distinct raw names that sanitize to the same slug stay distinct.
    expect(deriveEveTargetName("my_app"))
      .not.toBe(deriveEveTargetName("my app"));
    expect(
      deriveEveTargetName(`${"a".repeat(80)}-eve-project`),
    ).toMatch(/^[a-z0-9-]{1,63}$/u);
    expect(() => deriveEveTargetName("!!!")).toThrowError(
      expect.objectContaining({ code: "EVE_NAME_DERIVATION_FAILED" }),
    );
  });

  test("no-flag deploy resolves the project name from package.json", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@my-org/My Eve_App", private: true }),
      "utf8",
    );
    let observed: { name?: string; projectRoot?: string; environment?: string } = {};
    await expect(
      runEdenCli(["deploy"], {
        cwd: root,
        eveRunner: async (request) => {
          observed = request;
        },
      }),
    ).resolves.toBe(0);
    expect(observed.environment).toBe("preview");
    expect(observed.projectRoot).toBe(await realpath(root));
    expect(observed.name).toBe(deriveEveTargetName("@my-org/My Eve_App"));
  });

  test("parses both environments and scopes env-file to preflight/deploy", () => {
    expect(
      parseEveArguments(["preflight",
      "--project",
      "/tmp/eve-project",
      "--env",
      "preview",
      "--name",
      "eve-preview",
      "--env-file=/tmp/eve.env",]),
    ).toEqual({
      kind: "invocation",
      command: "preflight",
      projectRoot: "/tmp/eve-project",
      environment: "preview",
      name: "eve-preview",
      envFile: "/tmp/eve.env",
    });

    expect(
      parseEveArguments(["deploy",
      "--project=/tmp/eve-project",
      "--env=production",
      "--name=eve-production",
      "--env-file",
      "/tmp/eve.env",]),
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
      parseEveArguments(["destroy",
      "--project",
      "/tmp/eve-project",
      "--env",
      "preview",
      "--name",
      "eve-preview",
      "--env-file",
      "/tmp/eve.env",]);
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
        parseEveArguments(["preflight",
        ...suffix,]);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EveCliError);
      expect(error).toMatchObject({ code: expected });
    },
  );

  test("returns typed subcommand help and rejects the obsolete namespace", () => {
    expect(parseEveArguments(["destroy", "--help"])).toEqual<EveCliHelp>({
      kind: "help",
      scope: "destroy",
    });
    expect(() => parseEveArguments(["eve"])).toThrowError(
      expect.objectContaining({ code: "EVE_COMMAND_UNKNOWN" }),
    );
  });

  test.each([
    { discarded: true, expectedExitCode: 0, expectedErrorCode: undefined },
    {
      discarded: false,
      expectedExitCode: 1,
      expectedErrorCode: "EVE_RUNTIME_IMAGE_CLEANUP_FAILED",
    },
  ] as const)(
    "deploys one exact target and reports exact runtime-image cleanup (discarded=$discarded)",
    async ({ discarded, expectedExitCode, expectedErrorCode }) => {
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
    const errors: string[] = [];
    const operations: string[] = [];
    let protectedPut = false;
    let promotedAfterHealth = false;
    const imageDigest = `sha256:${"d".repeat(64)}`;

    await expect(
      runEdenCli(
        ["deploy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-deploy-fixture",
        "--env-file",
        envFile,
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
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
              expect(request.hostConfig.worker.containers[0]?.instance_type).toBe(
                "basic",
              );
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
            discardRuntimeImage: async (request) => {
              operations.push("discard-runtime-image");
              expect(request.imageId).toBe(imageDigest);
              expect(request.generationId).toBe("generation-one");
              expect(request.generationRoot).toContain("generation-one");
              return discarded;
            },
            afterPromotion: () => {
              promotedAfterHealth = operations.includes("health");
            },
          },
        },
      ),
    ).resolves.toBe(expectedExitCode);

    expect(protectedPut).toBe(true);
    expect(operations).toEqual(["publish", "health", "discard-runtime-image"]);
    expect(promotedAfterHealth).toBe(true);
    expect(output.join("\n")).not.toContain(marker);
    expect(output.join("\n")).toContain("eve deploy");
    expect(output.join("\n")).toContain("VAL-CROSS-004");
    if (expectedErrorCode === undefined) {
      expect(errors).toEqual([]);
    } else {
      expect(errors.join("\n")).toContain(expectedErrorCode);
      expect(errors.join("\n")).toContain("do not retry");
    }
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
        ["deploy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-indeterminate-fixture",],
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

  test("parses --json on every command", () => {
    for (const command of ["preflight", "deploy", "destroy"] as const) {
      const parsed = parseEveArguments([
        command,
        "--name",
        "eve-json-mode",
        "--json",
      ]);
      expect(parsed).toMatchObject({
        kind: "invocation",
        command,
        json: true,
      });
    }
    expect(
      parseEveArguments(["preflight", "--name", "eve-plain"]),
    ).not.toHaveProperty("json");
  });

  test("prints a human preflight summary by default", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-human-preflight",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-human-preflight",],
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
              imageDigest: `sha256:${"f".repeat(64)}`,
              cleanup: runtimeCleanup,
            }),
            cloudflareRead: async () => ({
              accountAccess: "available",
              containerAccess: "available",
              target: { state: "absent" },
            }),
          },
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    expect(output[0]).toBe(
      "eden preflight — eve-human-preflight (preview)",
    );
    expect(text).toContain("... packaging project");
    expect(text).toContain("✓ VAL-CLI-004");
    expect(text).toContain("✓ eve-human-preflight (preview) — preflight passed");
    expect(text).not.toContain('"command"');
    expect(() => JSON.parse(text)).toThrow();
  });

  test("prints the failing check id, reason, and remediation on preflight failure", async () => {
    const root = await createRoot();
    const output: string[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-human-failure",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
        },
      ),
    ).resolves.toBe(1);

    const text = output.join("\n");
    expect(text).toContain("✗ VAL-");
    expect(text).toContain("→");
    expect(text).toContain("✗ preflight failed — first failing check:");
    expect(errors.join("\n")).toContain("EVE_PREFLIGHT_FAILED");
  });
});


const destroyTargetKey = (() => {
  const digest = createHash("sha256")
    .update("proj\naccount-test\npreview\neve-destroy-fixture", "utf8")
    .digest("hex")
    .slice(0, 24);
  return `preview-eve-destroy-fixture-${digest}`;
})();
const destroyRegistryImage =
  `eden-eve-${destroyTargetKey}-gen-destroy-1:candidate`;

describe("eden destroy", () => {
  async function createDeployedFixture(): Promise<{
    readonly root: string;
    readonly generationRoot: string;
  }> {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-destroy-fixture",
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
    const generationRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-destroy-1",
    );
    await mkdir(generationRoot, { recursive: true });
    const targetRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "targets",
      "preview-eve-destroy-fixture",
    );
    await mkdir(targetRoot, { recursive: true });
    await writeFile(
      join(generationRoot, "deployment.json"),
      JSON.stringify({
        version: 1,
        status: "deployed",
        identity: {
          projectId: "proj",
          sourceDigest: `sha256:${"a".repeat(64)}`,
          generationId: "gen-destroy-1",
          deploymentId: "eve-deploy-test",
          environment: "preview",
          name: "eve-destroy-fixture",
          accountId: "account-test",
          workersDevSubdomain: "account",
          stableWorkersDevOrigin:
            "https://eve-destroy-fixture.account.workers.dev",
          workerName: "eve-destroy-fixture",
          containerApplicationName: "eve-destroy-fixture-container",
          stableContainerInstanceName: "eve-destroy-fixture-instance",
          containerImage: `registry.cloudflare.com/account-test/eden-eve-${destroyTargetKey}-gen-destroy-1@sha256:${"b".repeat(64)}`,
          runtimeVariableNames: [],
        },
      }),
      "utf8",
    );
    await symlink(
      relative(targetRoot, generationRoot),
      join(targetRoot, "CURRENT"),
    );
    return { root, generationRoot };
  }

  test("fails closed without a matching immutable deployed record", async () => {
    const root = await createRoot();
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
        },
      ),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toContain("EVE_DESTROY_RECORD_UNPROVEN");
  });

  test("is idempotent when the exact target is already absent", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    let reads = 0;
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => {
              reads += 1;
              return {
                workerExists: false,
                containerApplicationId: undefined,
                registryImagesPresent: [],
                accountId: "account-test",
              };
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(reads).toBe(1);
    expect(output.join("\n")).toContain('"status":"absent"');
  });

  test("deletes only the recorded Worker, Container, and registry image, verifies absence, then clears CURRENT", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const operations: string[] = [];
    let exists = true;
    let containerId: string | undefined = "container-123";
    let imagePresent = true;
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: exists,
              ...(containerId === undefined
                ? {}
                : { containerApplicationId: containerId }),
              registryImagesPresent: imagePresent
                ? [destroyRegistryImage]
                : [],
              accountId: "account-test",
            }),
            deleteWorker: async ({ name }) => {
              operations.push(`worker:${name}`);
              exists = false;
              return "deleted";
            },
            deleteContainer: async ({ applicationId }) => {
              operations.push(`container:${applicationId}`);
              containerId = undefined;
              return "deleted";
            },
            deleteRegistryImage: async ({ image }) => {
              operations.push(`image:${image}`);
              imagePresent = false;
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(operations).toEqual([
      "worker:eve-destroy-fixture",
      "container:container-123",
      `image:${destroyRegistryImage}`,
    ]);
    expect(output.join("\n")).toContain('"status":"destroyed"');
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, ".eden/eve-deploy/generations/gen-destroy-1/deployment.json"), "utf8"),
    ).resolves.toContain("deployed");
  });

  test("deletes the aborted-push generation image recorded in indeterminate evidence", async () => {
    const { root } = await createDeployedFixture();
    const abortedRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-destroy-0",
    );
    await mkdir(abortedRoot, { recursive: true });
    const abortedImage = `eden-eve-${destroyTargetKey}-gen-destroy-0:candidate`;
    await writeFile(
      join(abortedRoot, "deployment-attempt.json"),
      JSON.stringify({
        version: 1,
        status: "indeterminate",
        generationId: "gen-destroy-0",
        accountId: "account-test",
        targetKey: destroyTargetKey,
        imageRepository: `eden-eve-${destroyTargetKey}-gen-destroy-0`,
        imageDigest: `sha256:${"c".repeat(64)}`,
      }),
      "utf8",
    );
    const output: string[] = [];
    const deletedImages: string[] = [];
    const presentImages = new Set([destroyRegistryImage, abortedImage]);
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: false,
              containerApplicationId: undefined,
              registryImagesPresent: [...presentImages],
              accountId: "account-test",
            }),
            deleteRegistryImage: async ({ image }) => {
              deletedImages.push(image);
              presentImages.delete(image);
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(new Set(deletedImages)).toEqual(
      new Set([destroyRegistryImage, abortedImage]),
    );
    expect(output.join("\n")).toContain('"status":"destroyed"');
    expect(output.join("\n")).toContain("VAL-LIFE-006-REGISTRY");
  });

  test("reports the recorded image left behind when registry deletion is indeterminate", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: false,
              containerApplicationId: undefined,
              accountId: "account-test",
            }),
            deleteRegistryImage: async () => "indeterminate",
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain('"status":"failed"');
    expect(output.join("\n")).toContain(destroyRegistryImage);
    expect(errors.join("\n")).toContain("EVE_DESTROY_IMAGES_RETAINED");
    expect(errors.join("\n")).toContain(destroyRegistryImage);
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).resolves.toBeDefined();
  });

  test("returns indeterminate without clearing CURRENT when the Worker deletion is ambiguous", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: true,
              containerApplicationId: undefined,
              accountId: "account-test",
            }),
            deleteWorker: async () => "indeterminate",
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain('"status":"indeterminate"');
    expect(errors.join("\n")).toContain("EVE_DESTROY_INDETERMINATE");
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).resolves.toBeDefined();
  });

  test("keeps CURRENT and fails when absence cannot be verified after deletion", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: true,
              containerApplicationId: "container-9",
              accountId: "account-test",
            }),
            deleteWorker: async () => "deleted",
            deleteContainer: async () => "deleted",
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain('"status":"failed"');
    expect(errors.join("\n")).toContain("EVE_DESTROY_ABSENCE_UNPROVEN");
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).resolves.toBeDefined();
  });

  test("prints a human destroy summary by default", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    let exists = true;
    let containerId: string | undefined = "container-123";
    let imagePresent = true;
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: exists,
              ...(containerId === undefined
                ? {}
                : { containerApplicationId: containerId }),
              registryImagesPresent: imagePresent
                ? [destroyRegistryImage]
                : [],
              accountId: "account-test",
            }),
            deleteWorker: async () => {
              exists = false;
              return "deleted";
            },
            deleteContainer: async () => {
              containerId = undefined;
              return "deleted";
            },
            deleteRegistryImage: async () => {
              imagePresent = false;
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    expect(output[0]).toBe(
      "eden destroy — eve-destroy-fixture (preview)",
    );
    expect(text).toContain("... deleting Worker eve-destroy-fixture");
    expect(text).toContain("✓ VAL-LIFE-006-WORKER");
    expect(text).toContain("✓ VAL-LIFE-006-CONTAINER");
    expect(text).toContain("✓ VAL-LIFE-006-REGISTRY");
    expect(output.filter((line) => line.startsWith("✓ VAL-LIFE-006 "))).toHaveLength(1);
    expect(text).toContain(
      "✓ destroyed eve-destroy-fixture (preview)",
    );
    expect(text).toContain("retained: local deployment records");
    expect(text).not.toContain('"status"');
    expect(() => JSON.parse(text)).toThrow();
  });
});

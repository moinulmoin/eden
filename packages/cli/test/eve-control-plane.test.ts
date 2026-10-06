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
  utimes,
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
  EveDeploymentHealthRequest,
  EveDeploymentPublicationRequest,
  EvePreflightRuntimeRunnerRequest,
} from "../src/index.js";
import type { EveProjectBuilderRequest } from "../src/eve-packaging.js";
import type { EveProjectBuilder } from "../src/eve-packaging.js";
import { exactTargetContainerEntries } from "../src/eve-control-plane.js";

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

  test.each(["preflight", "deploy"] as const)(
    "%s boot probe gets disposable protected injection and redacts explicit runtime values",
    async (command) => {
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
    const envFile = join(await createRoot(), "runtime.env");
    const marker = "preflight-secret-marker-6f9a";
    await writeFile(envFile, `OPAQUE_RUNTIME=${marker}\n`, "utf8");
    const before = await readFile(envFile);
    const output: string[] = [];
    let injectedEnvironment: Readonly<Record<string, string>> | undefined;
    let remoteReadCount = 0;

    await expect(
      runEdenCli(
        [command,
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
                accountId: "account-test",
                workersDevSubdomain: "account",
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
    if (command === "preflight") expect(remoteReadCount).toBe(0);
    },
  );

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
              expect(
                request.hostConfig.worker.containers[0]?.scheduling_policy,
              ).toBe("durable_object");
              expect(
                request.hostConfig.worker.containers[0]?.images.eve.image,
              ).toBe(request.identity.containerImage);
              expect(request.hostConfig.worker.compatibility_flags).toEqual([
                "enable_ctx_exports",
              ]);
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
const destroyRegistryRepository = `eden-eve-${destroyTargetKey}-gen-destroy-1`;
const destroyRegistryImage =
  `${destroyRegistryRepository}:candidate`;

describe("exact target Container inventory", () => {
  test("ignores the account's other Containers and matches only <name>-container", () => {
    const inventory = [
      { id: "c-other-app", name: "autoseopilot-container" },
      { id: "c-other-eden", name: "my-eve-agent-11111111-container" },
      { id: "c-bare-name", name: "my-eve-agent-9e510242" },
    ];

    expect(exactTargetContainerEntries(inventory, "my-eve-agent-9e510242")).toEqual([]);
    expect(
      exactTargetContainerEntries(
        [...inventory, { id: "c-target", name: "my-eve-agent-9e510242-container" }],
        "my-eve-agent-9e510242",
      ),
    ).toEqual([{ id: "c-target", name: "my-eve-agent-9e510242-container" }]);
  });

  test("stays unproven when a full page has no exact match", () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: `c-${index}`,
      name: `unrelated-${index}-container`,
    }));

    expect(exactTargetContainerEntries(fullPage, "my-eve-agent-9e510242")).toBeUndefined();
  });
});

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
                registryTagsPresent: [],
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
              registryTagsPresent: imagePresent
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
            deleteRegistryRepository: async ({ repository }) => {
              operations.push(`registry:${repository}`);
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
      `registry:${destroyRegistryRepository}`,
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
    const deletedRepositories: string[] = [];
    const presentTags = new Set([destroyRegistryImage, abortedImage]);
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
              registryTagsPresent: [...presentTags],
              accountId: "account-test",
            }),
            deleteRegistryRepository: async ({ repository }) => {
              deletedRepositories.push(repository);
              for (const tag of [...presentTags]) {
                if (tag.startsWith(`${repository}:`)) presentTags.delete(tag);
              }
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(new Set(deletedRepositories)).toEqual(
      new Set([
        destroyRegistryRepository,
        `eden-eve-${destroyTargetKey}-gen-destroy-0`,
      ]),
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
            deleteRegistryRepository: async () => "indeterminate",
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain('"status":"failed"');
    expect(output.join("\n")).toContain(destroyRegistryRepository);
    expect(errors.join("\n")).toContain("EVE_DESTROY_IMAGES_RETAINED");
    expect(errors.join("\n")).toContain(destroyRegistryRepository);
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
              registryTagsPresent: imagePresent
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
            deleteRegistryRepository: async () => {
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

describe("Workflow World warnings", () => {
  async function writeFixtureProject(root: string): Promise<void> {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-world-warning-fixture",
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
  }

  function passingControlPlane(root: string, builder = fakeBuilder()) {
    return {
      artifactRoot: join(root, ".eden", "eve-artifacts", "generation-one"),
      builder,
      hostRequirements: {
        architecture: "linux/amd64",
        world: "supported",
        sandbox: "supported",
        privileged: false,
        devices: "none",
        kernel: "supported",
        network: "supported",
        durableLocalFilesystem: false,
      } as const,
      runtimeRunner: async () => ({
        ok: true,
        checks: [
          { id: "VAL-BUILD-005", status: "passed" as const, message: "image ok" },
          { id: "VAL-BUILD-006", status: "passed" as const, message: "boot ok" },
          { id: "VAL-BUILD-007", status: "passed" as const, message: "health ok" },
        ],
        imageDigest: `sha256:${"a".repeat(64)}`,
        cleanup: runtimeCleanup,
      }),
      cloudflareRead: async () => ({
        accountAccess: "available" as const,
        containerAccess: "available" as const,
        target: { state: "absent" as const },
      }),
    };
  }

  test("warns when the compiled agent uses Eve's default local World", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-local", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(root),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_WORLD_LOCAL",
    );
  });

  test("prints the local World warning in human output", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-local-human"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(root),
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    expect(text).toContain("! EVE_WORLD_LOCAL");
    expect(text).toContain("durable-state-postgres-world");
    expect(text).toContain("preflight passed");
  });

  test("does not warn when the compiled agent selects a durable World", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-postgres", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: { world: "@workflow/world-postgres" },
                    },
                  },
                }),
                "utf8",
              );
            }),
          ),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).not.toContain(
      "EVE_WORLD_LOCAL",
    );
  });

  test("reports expressible schedules and warns for unsupported crons", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];
    let publishedTriggers: unknown;

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", "eve-scheduled", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...passingControlPlane(
              root,
              fakeBuilder(async (request) => {
                await mkdir(
                  join(request.snapshotRoot, ".output/.eve/compile"),
                  { recursive: true },
                );
                await writeFile(
                  join(
                    request.snapshotRoot,
                    ".output/.eve/compile/compiled-agent-manifest.json",
                  ),
                  JSON.stringify({
                    schedules: [
                      { name: "digest", cron: "0 9 * * 1-5" },
                      { name: "sweep", cron: "*/15 * * * *" },
                      { name: "bad", cron: "@daily" },
                    ],
                  }),
                  "utf8",
                );
              }),
            ),
            containerImageReference:
              `registry.example/eve@sha256:${"a".repeat(64)}`,
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: { state: "absent" as const },
            }),
            publish: async (request) => {
              publishedTriggers = request.hostConfig.worker.triggers;
              return {
                status: "published" as const,
                identity: request.identity,
                createdByAttempt: true,
                ownershipProven: true as const,
              };
            },
            health: async (request) => ({
              status: "ready" as const,
              identity: request.identity,
            }),
            discardRuntimeImage: async () => true,
          },
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly message: string }[];
      readonly warnings: readonly { readonly id: string }[];
      readonly ok: boolean;
    };
    expect(result.ok).toBe(true);
    expect(
      result.checks.find((value) => value.id === "EVE-SCHEDULES")?.message,
    ).toBe("schedules: 2 (wake via Cloudflare Cron)");
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_SCHEDULE_UNSUPPORTED",
    );
    expect(publishedTriggers).toEqual({ crons: ["* * * * *"] });
  });

  test("warns on a pooled Postgres URL without leaking it", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const envFile = join(await createRoot(), "runtime.env");
    const secret = "pg-pooled-secret-marker-31b7";
    await writeFile(
      envFile,
      `WORKFLOW_POSTGRES_URL=postgresql://eve:${secret}@ep-cool-pooler.eu-central-1.aws.neon.tech/eve\n`,
      "utf8",
    );
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-pooled", "--env-file", envFile, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: { world: "@workflow/world-postgres" },
                    },
                  },
                }),
                "utf8",
              );
            }),
          ),
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_WORLD_POSTGRES_POOLED",
    );
    expect(result.warnings.map((value) => value.id)).not.toContain(
      "EVE_WORLD_LOCAL",
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("ep-cool-pooler");
  });

  test("does not warn on a direct Postgres URL", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const envFile = join(await createRoot(), "runtime.env");
    await writeFile(
      envFile,
      "WORKFLOW_POSTGRES_URL=postgresql://db.internal.example.org:5432/eve\n",
      "utf8",
    );
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-direct", "--env-file", envFile, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(root),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).not.toContain(
      "EVE_WORLD_POSTGRES_POOLED",
    );
  });

  function postgresWorldBuilder(options: {
    readonly eveCore?: string;
    readonly worldRange?: string;
    readonly world?: string;
  }) {
    return fakeBuilder(async (request) => {
      await writeFile(
        join(request.snapshotRoot, "node_modules/eve/package.json"),
        JSON.stringify({
          name: "eve",
          version: "0.31.3",
          bin: "bin/eve.js",
          dependencies: { "@workflow/core": options.eveCore ?? "5.0.0-beta.57" },
        }),
        "utf8",
      );
      await mkdir(
        join(request.snapshotRoot, ".output/.eve/compile"),
        { recursive: true },
      );
      await writeFile(
        join(
          request.snapshotRoot,
          ".output/.eve/compile/compiled-agent-manifest.json",
        ),
        JSON.stringify({
          config: {
            experimental: {
              workflow: { world: options.world ?? "@workflow/world-postgres" },
            },
          },
        }),
        "utf8",
      );
      if (options.worldRange !== undefined) {
        await mkdir(
          join(request.snapshotRoot, "node_modules", options.world ?? "@workflow/world-postgres"),
          { recursive: true },
        );
        await writeFile(
          join(
            request.snapshotRoot,
            `node_modules/${options.world ?? "@workflow/world-postgres"}/package.json`,
          ),
          JSON.stringify({
            name: options.world ?? "@workflow/world-postgres",
            version: "5.0.0-beta.47",
            dependencies: { "@workflow/world": options.worldRange },
          }),
          "utf8",
        );
      }
    });
  }

  test.each(["@workflow/world-postgres", "@moinulmoin/eden-world-cloudflare"])("passes the pairing check for %s when the World line matches Eve's", async (world) => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-paired", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            postgresWorldBuilder({ world, worldRange: "5.0.0-beta.39" }),
          ),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
      }[];
      readonly warnings: readonly { readonly id: string }[];
    };
    const pairing = result.checks.find((value) =>
      value.id === "EVE_WORLD_PAIRING"
    );
    expect(pairing?.status).toBe("passed");
    expect(result.warnings.map((warning) => warning.id)).not.toContain("EVE_WORLD_LOCAL");
  });

  test.each(["@workflow/world-postgres", "@moinulmoin/eden-world-cloudflare"])("fails %s pre-checks when the World line does not pair with Eve", async (world) => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-mismatched", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            postgresWorldBuilder({ world, worldRange: "6.0.0-beta.1" }),
          ),
        },
      ),
    ).resolves.toBe(1);

    const result = JSON.parse(output[0] as string) as {
      readonly ok: boolean;
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
        readonly remediation?: string;
      }[];
    };
    expect(result.ok).toBe(false);
    const pairing = result.checks.find((value) =>
      value.id === "EVE_WORLD_PAIRING"
    );
    expect(pairing?.status).toBe("failed");
  });
});

describe("eden deploy in-place update", () => {
  const updateName = "eve-update-fixture";
  const updateTargetKey = (() => {
    const digest = createHash("sha256")
      .update(`${updateName}\naccount-test\npreview\n${updateName}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    return `preview-${updateName}-${digest}`;
  })();
  const priorImage = `eden-eve-${updateTargetKey}-gen-prior:candidate`;
  const priorImageReference =
    `registry.cloudflare.com/account-test/eden-eve-${updateTargetKey}-gen-prior@sha256:${"b".repeat(64)}`;

  async function writeProject(root: string): Promise<void> {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: updateName,
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }

  function priorWorkerConfig(options: { readonly worldCloudflare?: boolean }) {
    return {
      name: updateName,
      compatibility_date: "2026-04-01",
      compatibility_flags: ["enable_ctx_exports"],
      vars: options.worldCloudflare === true
        ? { EDEN_EVE_WORLD_CLOUDFLARE: true }
        : {},
      containers: [
        {
          name: `${updateName}-container`,
          class_name: "EveHostDurableContainer",
          scheduling_policy: "durable_object",
          images: {
            eve: { image: priorImageReference },
          },
        },
      ],
      durable_objects: {
        bindings: [
          { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
          ...(options.worldCloudflare === true
            ? [{ name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" }]
            : []),
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: options.worldCloudflare === true
            ? ["EveHostDurableContainer", "EdenWorldDurableObject"]
            : ["EveHostDurableContainer"],
        },
      ],
    };
  }

  /**
   * The immutable record a real update reads: generation dir plus the
   * CURRENT pointer at `targets/<env>-<name>/CURRENT`.
   */
  async function createOwnedTargetFixture(
    root: string,
    options: { readonly worldCloudflare?: boolean; readonly accountId?: string } = {},
  ): Promise<{ readonly generationRoot: string }> {
    const generationRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-prior",
    );
    await mkdir(generationRoot, { recursive: true });
    const targetRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "targets",
      `preview-${updateName}`,
    );
    await mkdir(targetRoot, { recursive: true });
    await writeFile(
      join(generationRoot, "deployment.json"),
      JSON.stringify({
        version: 1,
        status: "deployed",
        identity: {
          projectId: updateName,
          sourceDigest: `sha256:${"a".repeat(64)}`,
          generationId: "gen-prior",
          deploymentId: "eve-deploy-prior",
          environment: "preview",
          name: updateName,
          accountId: options.accountId ?? "account-test",
          workersDevSubdomain: "account",
          stableWorkersDevOrigin:
            `https://${updateName}.account.workers.dev`,
          workerName: updateName,
          containerApplicationName: `${updateName}-container`,
          stableContainerInstanceName: `${updateName}-instance`,
          containerImage: priorImageReference,
          runtimeVariableNames: [],
        },
        worker: priorWorkerConfig(options),
        container: {},
      }),
      "utf8",
    );
    await symlink(
      relative(targetRoot, generationRoot),
      join(targetRoot, "CURRENT"),
    );
    return { generationRoot };
  }

  function existingTargetRead() {
    return async () => ({
      accountAccess: "available" as const,
      containerAccess: "available" as const,
      accountId: "account-test",
      workersDevSubdomain: "account",
      target: {
        state: "unowned" as const,
        observed: { worker: true, container: true },
        providerEvidence: {
          containerSchedulingPolicy: "durable_object",
          containerNamespaceId: "namespace-do-test",
          workerContainerNamespaceId: "namespace-do-test",
          workerDeploymentId: "eve-deploy-prior",
          settingsReadable: true,
        },
      },
    });
  }

  function updateControlPlane(
    root: string,
    operations: string[],
    options: {
      readonly builder?: EveProjectBuilder;
      readonly onPublish?: (request: EveDeploymentPublicationRequest) => void;
    } = {},
  ) {
    const newDigest = `sha256:${"d".repeat(64)}`;
    return {
      artifactRoot: join(root, ".eden", "eve-artifacts", "generation-two"),
      builder: options.builder ?? fakeBuilder(),
      containerImageReference: `registry.example/eve@${newDigest}`,
      hostRequirements: {
        architecture: "linux/amd64",
        world: "supported",
        sandbox: "supported",
        privileged: false,
        devices: "none",
        kernel: "supported",
        network: "supported",
        durableLocalFilesystem: false,
      } as const,
      runtimeRunner: async () => ({
        ok: true,
        checks: [
          { id: "VAL-BUILD-005", status: "passed" as const, message: "image ok" },
          { id: "VAL-BUILD-006", status: "passed" as const, message: "boot ok" },
          { id: "VAL-BUILD-007", status: "passed" as const, message: "health ok" },
        ],
        imageDigest: newDigest,
        cleanup: { ...runtimeCleanup, imageRetained: true },
      }),
      cloudflareRead: existingTargetRead(),
      publish: async (request: EveDeploymentPublicationRequest) => {
        operations.push("publish");
        options.onPublish?.(request);
        return {
          status: "published" as const,
          identity: request.identity,
          createdByAttempt: true,
          ownershipProven: true as const,
        };
      },
      health: async (request: EveDeploymentHealthRequest) => {
        operations.push("health");
        return { status: "ready" as const, identity: request.identity };
      },
      deleteRegistryRepository: async ({
        repository,
      }: {
        readonly repository: string;
      }) => {
        operations.push(`delete-superseded-registry:${repository}`);
        return "deleted" as const;
      },
      discardRuntimeImage: async () => {
        operations.push("discard-runtime-image");
        return true;
      },
    };
  }

  test("updates an Eden-owned target in place: republishes, promotes, then deletes the superseded image", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const errors: string[] = [];
    const operations: string[] = [];
    let publishedMigrations: unknown;
    let publishedImage: unknown;

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            onPublish: (request) => {
              publishedMigrations = request.hostConfig.worker.migrations;
              publishedImage = request.identity.containerImage;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly ok: boolean;
      readonly deployment?: {
        readonly operation: string;
        readonly supersededGenerationId?: string;
        readonly supersededImageReference?: string;
      };
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.deployment?.operation).toBe("update");
    expect(result.deployment?.supersededGenerationId).toBe("gen-prior");
    expect(result.deployment?.supersededImageReference).toBe(priorImageReference);
    expect(publishedMigrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
    ]);
    expect(publishedImage).toBe(`registry.example/eve@sha256:${"d".repeat(64)}`);
    expect(operations).toEqual([
      "publish",
      "health",
      `delete-superseded-registry:${priorImage.replace(":candidate", "")}`,
      "discard-runtime-image",
    ]);
    const current = await realpath(
      join(
        root,
        ".eden",
        "eve-deploy",
        "targets",
        `preview-${updateName}`,
        "CURRENT",
      ),
    );
    expect(current).toContain("generation-two");
  });

  test("still fails VAL-CLI-007-TARGET-CONFLICT when the existing target has no Eden record", async () => {
    const root = await createRoot();
    await writeProject(root);
    const output: string[] = [];
    const errors: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: updateControlPlane(root, operations),
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly ok: boolean;
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
    expect(errors.join("\n")).toContain("EVE_DEPLOY_CHECKS_FAILED");
  });

  test("keeps migration history append-only and appends v2 when the World class is first introduced", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root, { worldCloudflare: false });
    const output: string[] = [];
    const operations: string[] = [];
    let publishedMigrations: unknown;
    let publishedBindings: unknown;
    let workerSource = "";

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            builder: fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: {
                        world: "@moinulmoin/eden-world-cloudflare",
                      },
                    },
                  },
                }),
                "utf8",
              );
            }),
            onPublish: (request) => {
              publishedMigrations = request.hostConfig.worker.migrations;
              publishedBindings = request.hostConfig.worker.durable_objects.bindings;
              workerSource = request.workerSource;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(publishedMigrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
      { tag: "v2", new_sqlite_classes: ["EdenWorldDurableObject"] },
    ]);
    expect(publishedBindings).toEqual([
      { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
      { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
    ]);
    expect(workerSource).toContain("export { EdenWorldDurableObject }");
    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toEqual(
      expect.arrayContaining(["EVE_UPDATE_IN_FLIGHT", "EVE_UPDATE_WORLD_SWITCH"]),
    );
  });

  test("keeps the World class binding and migration when the update switches away from the Durable Object World", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root, { worldCloudflare: true });
    const operations: string[] = [];
    const output: string[] = [];
    let publishedMigrations: unknown;
    let publishedBindings: unknown;
    let workerSource = "";

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            onPublish: (request) => {
              publishedMigrations = request.hostConfig.worker.migrations;
              publishedBindings = request.hostConfig.worker.durable_objects.bindings;
              workerSource = request.workerSource;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    // No new class: the v1 tag is carried verbatim and EdenWorldDurableObject
    // is never deleted — deleting the class would destroy its SQLite data.
    expect(publishedMigrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: [
          "EveHostDurableContainer",
          "EdenWorldDurableObject",
        ],
      },
    ]);
    expect(publishedBindings).toEqual([
      { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
      { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
    ]);
    expect(workerSource).toContain("export { EdenWorldDurableObject }");
    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_UPDATE_WORLD_SWITCH",
    );
  });

  test("prints 'updated' in the human summary for an in-place update", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations),
        },
      ),
    ).resolves.toBe(0);

    expect(output.join("\n")).toContain(`✓ updated ${updateName} (preview)`);
  });

  test("refuses to update when the live Worker's stamped identity is not Eden's", async () => {
    const root = await createRoot();
    await writeProject(root);
    // A stale local record still exists, but the remote Worker was recreated
    // by something else and does not stamp Eden's recorded identity.
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, operations),
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: {
                state: "unowned" as const,
                observed: { worker: true, container: true },
                providerEvidence: {
                  containerSchedulingPolicy: "durable_object",
                  containerNamespaceId: "namespace-do-test",
                  workerContainerNamespaceId: "namespace-do-test",
                  workerDeploymentId: "foreign-deploy-not-in-records",
                  settingsReadable: true,
                },
              },
            }),
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("refuses to update when the live Worker proves no Eden identity at all", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, operations),
            // A foreign Worker: no provider evidence matches the record.
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: {
                state: "unowned" as const,
                observed: { worker: true, container: true },
                providerEvidence: { settingsReadable: true },
              },
            }),
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("refuses to update when Worker settings are unreadable, even if the Container namespace matches", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, operations),
            // Eden's Container survives, but a same-name Worker replaced
            // Eden's and its settings can't be read: the Container proves
            // nothing about who owns the Worker.
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: {
                state: "unowned" as const,
                observed: { worker: true, container: true },
                providerEvidence: {
                  containerSchedulingPolicy: "durable_object",
                  containerNamespaceId: "namespace-do-test",
                  workerContainerNamespaceId: "namespace-do-test",
                  settingsReadable: false,
                },
              },
            }),
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("proves a durable-object Container by namespace identity and fails closed when it is unreadable", async () => {
    const namespaceId = "namespace-do-123";
    const operations: string[] = [];
    const buildRead = (
      providerEvidence: Record<string, unknown>,
    ) => async () => ({
      accountAccess: "available" as const,
      containerAccess: "available" as const,
      accountId: "account-test",
      workersDevSubdomain: "account",
      target: {
        state: "unowned" as const,
        observed: { worker: true, container: true },
        providerEvidence: {
          workerDeploymentId: "eve-deploy-prior",
          settingsReadable: true,
          ...providerEvidence,
        },
      },
    });

    // Matching app/binding namespaces prove the durable-object Container
    // even though `containers list` reports no image.
    const matchedRoot = await createRoot();
    await writeProject(matchedRoot);
    await createOwnedTargetFixture(matchedRoot);
    const matchedOutput: string[] = [];
    await expect(
      runEdenCli(
        ["deploy", "--project", matchedRoot, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: matchedRoot,
          stdout: (line) => matchedOutput.push(line),
          eveControlPlane: {
            ...updateControlPlane(matchedRoot, operations),
            cloudflareRead: buildRead({
              containerSchedulingPolicy: "durable_object",
              containerNamespaceId: namespaceId,
              workerContainerNamespaceId: namespaceId,
            }),
          },
        },
      ),
    ).resolves.toBe(0);
    expect(operations).toContain("publish");

    // A missing or mismatched namespace id fails closed.
    const mismatchedRoot = await createRoot();
    await writeProject(mismatchedRoot);
    await createOwnedTargetFixture(mismatchedRoot);
    const mismatchedOutput: string[] = [];
    const mismatchedOperations: string[] = [];
    await expect(
      runEdenCli(
        ["deploy", "--project", mismatchedRoot, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: mismatchedRoot,
          stdout: (line) => mismatchedOutput.push(line),
          eveControlPlane: {
            ...updateControlPlane(mismatchedRoot, mismatchedOperations),
            cloudflareRead: buildRead({
              containerSchedulingPolicy: "durable_object",
              containerNamespaceId: namespaceId,
              workerContainerNamespaceId: "namespace-foreign",
            }),
          },
        },
      ),
    ).resolves.toBe(1);
    expect(mismatchedOperations).toEqual([]);
    const result = JSON.parse(mismatchedOutput[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("a retry after a health-failed update keeps the already-published migration tag", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    // Simulate an update that published v2 (World class) but failed health:
    // CURRENT still points at the v1 record while a newer failed record
    // carries v2. The next update must emit v2's history, not regress to v1.
    const failedRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-failed-update",
    );
    await mkdir(failedRoot, { recursive: true });
    await writeFile(
      join(failedRoot, "deployment.json"),
      JSON.stringify({
        version: 1,
        status: "failed",
        identity: {
          projectId: updateName,
          sourceDigest: `sha256:${"c".repeat(64)}`,
          generationId: "gen-failed-update",
          deploymentId: "eve-deploy-failed",
          environment: "preview",
          name: updateName,
          accountId: "account-test",
          workersDevSubdomain: "account",
          stableWorkersDevOrigin:
            `https://${updateName}.account.workers.dev`,
          workerName: updateName,
          containerApplicationName: `${updateName}-container`,
          stableContainerInstanceName: `${updateName}-instance`,
          containerImage: priorImageReference,
          runtimeVariableNames: [],
        },
        worker: {
          name: updateName,
          compatibility_date: "2026-04-01",
          compatibility_flags: ["enable_ctx_exports"],
          vars: { EDEN_EVE_WORLD_CLOUDFLARE: true },
          containers: [
            {
              name: `${updateName}-container`,
              class_name: "EveHostDurableContainer",
              scheduling_policy: "durable_object",
              images: {
                eve: { image: priorImageReference },
              },
            },
          ],
          durable_objects: {
            bindings: [
              { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
              { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
            ],
          },
          migrations: [
            { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
            { tag: "v2", new_sqlite_classes: ["EdenWorldDurableObject"] },
          ],
        },
        container: {},
      }),
      "utf8",
    );
    // Deterministic ordering: the failed record must sort newer than the
    // CURRENT-pointed record without relying on wall-clock sleep.
    const failedRecordPath = join(failedRoot, "deployment.json");
    const priorRecordPath = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-prior",
      "deployment.json",
    );
    const priorStats = await lstat(priorRecordPath);
    const later = new Date(priorStats.mtimeMs + 60_000);
    await utimes(failedRecordPath, later, later);
    const output: string[] = [];
    const operations: string[] = [];
    let publishedMigrations: unknown;

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            builder: fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: {
                        world: "@moinulmoin/eden-world-cloudflare",
                      },
                    },
                  },
                }),
                "utf8",
              );
            }),
            onPublish: (request) => {
              publishedMigrations = request.hostConfig.worker.migrations;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    // v2 stays in the emitted history; the World class is never re-declared
    // under a replayed tag nor dropped from the list.
    expect(publishedMigrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
      { tag: "v2", new_sqlite_classes: ["EdenWorldDurableObject"] },
    ]);
  });
});


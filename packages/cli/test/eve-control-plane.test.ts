import {
  mkdtemp,
  readdir,
  realpath,
  rm,
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

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-eve-namespace-"));
  roots.push(root);
  return root;
}

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
});

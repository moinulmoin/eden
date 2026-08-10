import {
  mkdtemp,
  rm,
} from "fs/promises";
import {
  tmpdir,
} from "os";
import {
  join,
} from "path";

import { afterEach, describe, expect, test } from "vitest";

import {
  runEdenCli,
  type EdenCliDryRunRequest,
  type EdenCliRemoteCommandRequest,
  type EdenCliRemoteValidationRequest,
} from "../src/index.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-remote-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("eden remote deployment orchestration", () => {
  test("provisions the bearer through Wrangler and validates the selected generation", async () => {
    const root = await createRoot();
    const dryRuns: EdenCliDryRunRequest[] = [];
    const commands: EdenCliRemoteCommandRequest[] = [];
    const validations: EdenCliRemoteValidationRequest[] = [];

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["deploy", "--project", root, "--env", "preview", "--name", "eden-gate-preview"], {
        cwd: root,
        dryRunRunner: async (request) => {
          dryRuns.push(request);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        remoteCommandRunner: async (request) => {
          commands.push(request);
          return {
            exitCode: 0,
            stdout: request.kind === "deploy"
              ? "Deployed eden-gate-preview https://eden-gate-preview.example.workers.dev\n"
              : "",
            stderr: "",
          };
        },
        remoteValidationRunner: async (request) => {
          validations.push(request);
          return { ok: true };
        },
        remoteBearerSecret: "remote-test-secret",
      }),
    ).resolves.toBe(0);

    expect(dryRuns).toHaveLength(2);
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
    ]);
    expect(commands[0]?.args).toEqual(expect.arrayContaining([
      "secret",
      "put",
      "EDEN_BEARER_SECRET",
      "--name",
      "eden-gate-preview",
    ]));
    expect(commands[0]?.stdin).toBe("remote-test-secret\n");
    expect(commands[0]?.args.join(" ")).not.toContain("remote-test-secret");
    expect(commands[1]?.args).toEqual(expect.arrayContaining([
      "deploy",
      "--env",
      "preview",
      "--name",
      "eden-gate-preview",
    ]));
    expect(commands[1]?.args.join(" ")).not.toContain("remote-test-secret");
    expect(validations).toHaveLength(1);
    expect(validations[0]?.environment).toBe("preview");
    expect(validations[0]?.workerName).toBe("eden-gate-preview");
    expect(validations[0]?.url).toBe("https://eden-gate-preview.example.workers.dev");
    expect(validations[0]?.expectedGeneration.generationId).toMatch(/^gen_[a-f0-9]{64}$/u);
  });

  test("reports remote validation failure instead of claiming deployment success", async () => {
    const root = await createRoot();
    const errors: string[] = [];
    const commands: EdenCliRemoteCommandRequest[] = [];

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["deploy", "--project", root, "--name", "eden-gate-failure"], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        remoteCommandRunner: async (request) => {
          commands.push(request);
          return {
            exitCode: 0,
            stdout: "https://eden-gate-failure.example.workers.dev\n",
            stderr: "",
          };
        },
        remoteValidationRunner: async () => ({
          ok: false,
          code: "REMOTE_GENERATION_MISMATCH",
          message: "The reachable Worker exposed a stale generation.",
        }),
        remoteBearerSecret: "remote-test-secret",
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/generation|remote|validation/i);
    expect(errors.join("\n")).not.toMatch(/deployment succeeded/i);
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
      "secret-delete",
      "delete",
    ]);
    expect(commands[2]?.args).not.toContain("--force");
  });
});

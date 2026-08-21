import {
  readFile,
  mkdtemp,
  readdir,
  writeFile,
  rm,
} from "fs/promises";
import {
  tmpdir,
} from "os";
import {
  join,
} from "path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  runEdenCli,
  type EdenCliDryRunRequest,
  type EdenCliRemoteCommandHandle,
  type EdenCliRemoteCommandRequest,
  type EdenCliRemoteValidationRequest,
  type EdenCliProcess,
} from "../src/index.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-remote-"));
  roots.push(root);
  return root;
}

async function expectDeployLockRemoved(root: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
    { timeout: 5_000 },
  );
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
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "deploy", "--project", root, "--env", "preview", "--name", "eden-gate-preview"], {
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
    expect(dryRuns[1]?.args).toEqual(expect.arrayContaining(["--env", "preview", "--name", "eden-gate-preview"]));
    expect(commands.map((request) => request.kind)).toEqual(["secret-put", "deploy"]);
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

  test("prefers wrangler.json and preserves configured/shared targets", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    expect(await runEdenCli(["agent", "init", "--project", root], { cwd: root })).toBe(0);
    await writeFile(
      join(root, "wrangler.json"),
      `${JSON.stringify({
        name: "eden-json-wins",
        main: ".eden/agent-bundle.mjs",
        compatibility_date: "2026-04-01",
        env: { preview: { name: "eden-json-wins-preview" } },
      })}\n`,
      "utf8",
    );

    await expect(
      runEdenCli(["agent", "deploy", "--project", root, "--env", "preview"], {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        remoteCommandRunner: async (request) => {
          commands.push(request);
          return {
            exitCode: request.kind === "deploy" ? 1 : 0,
            stdout: "",
            stderr: request.kind === "deploy" ? "deployment fixture failed" : "",
          };
        },
        remoteBearerSecret: "configured-name-secret",
      }),
    ).resolves.toBe(1);

    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
    ]);
    expect(commands[0]?.args).toContain("eden-json-wins-preview");
    expect(commands[1]?.args).toContain("eden-json-wins-preview");
    expect(errors.join("\n")).toMatch(/REMOTE_CLEANUP_SKIPPED_UNOWNED/u);
    await expectDeployLockRemoved(root);
  });

  test("uses Wrangler JSONC overlay names for preview and production", async () => {
    const roots: [string, string] = [await createRoot(), await createRoot()];
    const commands: EdenCliRemoteCommandRequest[] = [];
    const config = `{
      // JSONC comments and trailing commas are valid.
      "name": "eden-overlay-base",
      "main": ".eden/agent-bundle.mjs",
      "env": { "preview": { "vars": {}, }, "production": { "name": "eden-overlay-production", }, },
    }\n`;
    for (const root of roots) {
      expect(await runEdenCli(["agent", "init", "--project", root], { cwd: root })).toBe(0);
      await writeFile(join(root, "wrangler.jsonc"), config, "utf8");
    }

    const remoteCommandRunner = async (request: EdenCliRemoteCommandRequest) => {
      commands.push(request);
      return { exitCode: 0, stdout: request.kind === "deploy" ? "https://overlay.example.workers.dev\n" : "", stderr: "" };
    };
    const deploy = (root: string, env: "preview" | "production") =>
      runEdenCli(["agent", "deploy", "--project", root, "--env", env], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        remoteCommandRunner,
        remoteValidationRunner: async () => ({ ok: true }),
        remoteBearerSecret: "overlay-secret",
      });
    await expect(deploy(roots[0], "preview")).resolves.toBe(0);
    await expect(deploy(roots[1], "production")).resolves.toBe(0);

    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
      "secret-put",
      "deploy",
    ]);
    expect(commands.map((request) => request.args[request.args.indexOf("--name") + 1]))
      .toEqual(["eden-overlay-base-preview", "eden-overlay-base-preview", "eden-overlay-production", "eden-overlay-production"]);
  });

  test("allows explicit secret cleanup without deleting an unattempted Worker", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    expect(await runEdenCli(["agent", "init", "--project", root], { cwd: root })).toBe(0);

    await expect(
      runEdenCli(["agent", "deploy", "--project", root, "--name", "eden-secret-only"], {
        cwd: root,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        remoteCommandRunner: async (request) => {
          commands.push(request);
          return {
            exitCode: request.kind === "secret-put" ? 1 : 0,
            stdout: "",
            stderr: request.kind === "secret-put" ? "secret fixture failed" : "",
          };
        },
        remoteBearerSecret: "secret-only-secret",
      }),
    ).resolves.toBe(1);

    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "secret-delete",
    ]);
    await expectDeployLockRemoved(root);
  });

  test("reports remote validation failure instead of claiming deployment success", async () => {
    const root = await createRoot();
    const errors: string[] = [];
    const commands: EdenCliRemoteCommandRequest[] = [];

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(["agent", "deploy", "--project", root, "--name", "eden-gate-failure"], {
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

  test("waits for pending mutating validation before compensation", async () => {
    const root = await createRoot();
    const stopController = new AbortController();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let validationStarted = false;
    let releaseValidation: (() => void) | undefined;
    const validationResult = new Promise<{ readonly ok: boolean }>((resolve) => {
      releaseValidation = () => resolve({ ok: false });
    });

    expect(await runEdenCli(["agent", "init", "--project", root], { cwd: root })).toBe(0);
    const deployPromise = runEdenCli(
      ["agent", "deploy", "--project", root, "--name", "eden-pending-validation"],
      {
        cwd: root,
        stopSignal: stopController.signal,
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        remoteCommandRunner: (request) => {
          commands.push(request);
          return {
            exitCode: 0,
            stdout: request.kind === "deploy"
              ? "https://eden-pending-validation.example.workers.dev\n"
              : "",
            stderr: "",
          };
        },
        remoteValidationRunner: async () => {
          validationStarted = true;
          queueMicrotask(() => stopController.abort());
          return validationResult;
        },
        remoteBearerSecret: "pending-validation-secret",
      },
    );

    await vi.waitFor(() => expect(validationStarted).toBe(true));
    await expect(deployPromise).resolves.toBe(1);
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
    ]);

    releaseValidation?.();
    await vi.waitFor(() => {
      expect(commands.map((request) => request.kind)).toEqual([
        "secret-put",
        "deploy",
        "secret-delete",
        "delete",
      ]);
    });
    await expectDeployLockRemoved(root);
  }, 12_000);

  test("does not start a remote mutation after deployment ownership is replaced", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".eden-deploy.lock");
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-cas-replacement",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          deploymentBoundaryHook: async (boundary) => {
            if (boundary !== "before-secret-provision") return;
            const current = JSON.parse(await readFile(lockPath, "utf8")) as {
              readonly kind: string;
              readonly version: number;
              readonly pid: number;
              readonly startedAt: string;
              readonly token: string;
            };
            await writeFile(
              lockPath,
              `${JSON.stringify({
                ...current,
                startedAt: "replacement-start",
                token: "replacement-token",
              })}\n`,
              "utf8",
            );
          },
          remoteCommandRunner: async (request) => {
            commands.push(request);
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          },
          remoteBearerSecret: "cas-replacement-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands).toEqual([]);
    expect(errors.join("\n")).toMatch(/ownership|lock|replaced|changed/i);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      "replacement-token",
    );
  });

  test("registers synchronous remote handles before signal cleanup", async () => {
    const root = await createRoot();
    const terminated: Array<{
      readonly kind: string;
      readonly signal: NodeJS.Signals | undefined;
    }> = [];
    let nextPid = 55_000;
    let signalScheduled = false;

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);

    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-remote-handle-signal",],
        {
          cwd: root,
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: ((request: EdenCliRemoteCommandRequest) => {
            let release: (() => void) | undefined;
            const result = new Promise<{
              readonly exitCode: number;
              readonly stdout: string;
              readonly stderr: string;
            }>((resolve) => {
              release = () => resolve({
                exitCode: 0,
                stdout: "",
                stderr: "",
              });
            });
            const processHandle: EdenCliProcess = {
              pid: nextPid++,
              startIdentity: `remote-handle-${request.kind}`,
              exited: result.then(() => ({ exitCode: 0, signal: null })),
              async terminate(signal?: NodeJS.Signals) {
                terminated.push({ kind: request.kind, signal });
                release?.();
              },
            };
            if (request.kind === "secret-put" && !signalScheduled) {
              signalScheduled = true;
              queueMicrotask(() => process.emit("SIGTERM"));
            }
            return { process: processHandle, result };
          }) as never,
          remoteBearerSecret: "remote-handle-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(terminated).toEqual(
      expect.arrayContaining([
        { kind: "secret-put", signal: "SIGTERM" },
      ]),
    );
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("starts secret cleanup after cancellation before deploy", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let releaseSecretPut: (() => void) | undefined;
    const secretPutResult = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseSecretPut = () =>
        resolve({ exitCode: 0, stdout: "", stderr: "" });
    });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-cancel-cleanup",],
        {
          cwd: root,
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: (request) => {
            commands.push(request);
            if (request.kind === "secret-put") {
              queueMicrotask(() => {
                process.emit("SIGTERM");
                releaseSecretPut?.();
              });
              return {
                process: {
                  pid: 55_200,
                  startIdentity: "cancel-cleanup-secret-put",
                  exited: secretPutResult.then(() => ({
                    exitCode: 0,
                    signal: null,
                  })),
                  async terminate() {
                    releaseSecretPut?.();
                  },
                },
                result: secretPutResult,
              };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          remoteBearerSecret: "cancel-cleanup-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "secret-delete",
    ]);
  });

  test("rejects a promise-returned remote handle before awaiting it", async () => {
    const root = await createRoot();
    let terminateCount = 0;
    const errors: string[] = [];
    let resolveResult: (() => void) | undefined;
    const result = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      resolveResult = () => resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-remote-late-handle",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: async () => ({
            process: {
              pid: 55_100,
              startIdentity: "late-remote-handle",
              exited: result.then(() => ({ exitCode: 0, signal: null })),
              async terminate() {
                terminateCount += 1;
                resolveResult?.();
              },
            },
            result,
          }),
          remoteBearerSecret: "late-remote-handle-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(terminateCount).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/REMOTE_COMMAND_HANDLE_UNSUPPORTED/u);
    expect(errors.join("\n")).not.toMatch(/REMOTE_CLEANUP_FAILED/u);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("isolates a source mutation during deploy from the remote candidate", async () => {
    const root = await createRoot();
    const sourcePath = join(root, "agent/tools/greet.ts");
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let validationCalled = false;
    let deployEntry = "";

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-source-cas",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: async (request) => {
            commands.push(request);
            if (request.kind === "deploy") {
              const configPath = request.args[
                request.args.indexOf("--config") + 1
              ] as string;
              deployEntry =
                /"main"\s*:\s*"([^"]+)"/u.exec(
                  await readFile(configPath, "utf8"),
                )?.[1] ?? "";
              await writeFile(
                sourcePath,
                (await readFile(sourcePath, "utf8")).replace(
                  "Greet a person by name.",
                  "Changed during the remote deploy action.",
                ),
                "utf8",
              );
            }
            return {
              exitCode: 0,
              stdout: request.kind === "deploy"
                ? "https://eden-source-cas.example.workers.dev\n"
                : "",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => {
            validationCalled = true;
            return { ok: true };
          },
          remoteBearerSecret: "source-cas-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
      "secret-delete",
      "delete",
    ]);
    expect(deployEntry).toMatch(/eden-dev-worker/u);
    expect(validationCalled).toBe(false);
    expect(errors.join("\n")).toMatch(/source|configuration|changed|stale/i);
  });

  test("rejects ownership mutation immediately before the remote runner starts", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".eden-deploy.lock");
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let mutated = false;

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-final-spawn-cas",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          deploymentBoundaryHook: async (boundary) => {
            if (boundary !== "before-remote-runner-invocation" || mutated) {
              return;
            }
            mutated = true;
            const current = JSON.parse(await readFile(lockPath, "utf8")) as {
              readonly kind: string;
              readonly version: number;
              readonly pid: number;
              readonly startedAt: string;
              readonly token: string;
            };
            await writeFile(
              lockPath,
              `${JSON.stringify({
                ...current,
                token: "final-spawn-replacement",
              })}\n`,
              "utf8",
            );
          },
          remoteCommandRunner: async (request) => {
            commands.push(request);
            return {
              exitCode: 0,
              stdout: request.kind === "deploy"
                ? "https://eden-final-spawn-cas.example.workers.dev\n"
                : "",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "final-spawn-cas-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands).toEqual([]);
    expect(errors.join("\n")).toMatch(/ownership|lock|replaced|changed/i);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      "final-spawn-replacement",
    );
  });

  test("revalidates ownership after final preflight before runner handoff", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".eden-deploy.lock");
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-post-preflight-cas",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          deploymentBoundaryHook: async (boundary) => {
            if (boundary !== "after-remote-runner-preflight") return;
            const current = JSON.parse(await readFile(lockPath, "utf8")) as {
              readonly kind: string;
              readonly version: number;
              readonly pid: number;
              readonly startedAt: string;
              readonly token: string;
            };
            await writeFile(
              lockPath,
              `${JSON.stringify({
                ...current,
                token: "post-preflight-replacement",
              })}\n`,
              "utf8",
            );
          },
          remoteCommandRunner: async (request) => {
            commands.push(request);
            return {
              exitCode: 0,
              stdout: request.kind === "deploy"
                ? "https://eden-post-preflight-cas.example.workers.dev\n"
                : "",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "post-preflight-cas-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands).toEqual([]);
    expect(errors.join("\n")).toMatch(/ownership|lock|replaced|changed/i);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      "post-preflight-replacement",
    );
  });

  test("rejects a lock replacement after the final read before the lease CAS", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".eden-deploy.lock");
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let replaced = false;

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-post-final-read-cas",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          deploymentBoundaryHook: async (boundary) => {
            if (String(boundary) !== "after-remote-final-read" || replaced) {
              return;
            }
            replaced = true;
            const current = JSON.parse(await readFile(lockPath, "utf8")) as {
              readonly kind: string;
              readonly version: number;
              readonly pid: number;
              readonly startedAt: string;
              readonly token: string;
            };
            await writeFile(
              lockPath,
              `${JSON.stringify({
                ...current,
                token: "post-final-read-replacement",
              })}\n`,
              "utf8",
            );
          },
          remoteCommandRunner: async (request) => {
            commands.push(request);
            return {
              exitCode: 0,
              stdout: request.kind === "deploy"
                ? "https://eden-post-final-read-cas.example.workers.dev\n"
                : "",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "post-final-read-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(replaced).toBe(true);
    expect(commands).toEqual([]);
    expect(errors.join("\n")).toMatch(/ownership|lock|replaced|changed/i);
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      "post-final-read-replacement",
    );
  });

  test("bounds a never-settling Promise returned by remote cleanup", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let releaseCleanup: (() => void) | undefined;
    const pendingCleanup = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseCleanup = () => resolve({ exitCode: 1, stdout: "", stderr: "" });
    });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const deployPromise = runEdenCli(
      ["agent", "deploy", "--project",
      root,
      "--env",
      "preview",
      "--name",
      "eden-pending-remote-cleanup",],
      {
        cwd: root,
        stderr: (line) => errors.push(line),
        dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        remoteCommandRunner: (request) => {
          commands.push(request);
          if (request.kind === "secret-delete") return pendingCleanup;
          if (request.kind === "deploy") {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "deploy fixture failed",
            };
          }
          return {
            exitCode: 0,
            stdout: request.kind === "deploy"
              ? "https://eden-pending-remote-cleanup.example.workers.dev\n"
              : "",
            stderr: "",
          };
        },
        remoteBearerSecret: "pending-remote-cleanup-secret",
      },
    );

    const observed = await Promise.race([
      deployPromise.then((code) => ({ settled: true, code })),
      new Promise<{ readonly settled: false }>((resolve) => {
        setTimeout(() => resolve({ settled: false }), 5_000);
      }),
    ]);
    expect(observed).toEqual({ settled: true, code: 1 });
    expect(errors.join("\n")).toMatch(/REMOTE_CLEANUP_TIMEOUT/u);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .resolves.toContain("eden.deploy.lock");
    await expect(readdir(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".eden-deploy-lease-"),
      ]),
    );
    releaseCleanup?.();
    await expect(deployPromise).resolves.toBe(1);
    expect(commands.map((request) => request.kind)).toContain("secret-delete");
    await vi.waitFor(async () => {
      await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 8_000);

  test("retains ownership when the remote runner throws synchronously", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-sync-throw",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: (request) => {
            commands.push(request);
            throw new Error("synchronous remote runner failure");
          },
          remoteBearerSecret: "sync-throw-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands.map((request) => request.kind)).toEqual(["secret-put"]);
    expect(errors.join("\n")).toMatch(/synchronous remote runner failure/u);
    expect(errors.join("\n")).toMatch(/REMOTE_CLEANUP_TIMEOUT/u);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .resolves.toContain("eden.deploy.lock");
    await expect(readdir(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".eden-deploy-lease-"),
      ]),
    );
  }, 8_000);

  test("compensates after a Promise-returned remote handle may have mutated", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let terminateCount = 0;
    const result = Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const handle = {
      process: {
        pid: 55_300,
        startIdentity: "promise-mutation-handle",
        exited: result.then(() => ({ exitCode: 0, signal: null })),
        async terminate() {
          terminateCount += 1;
        },
      },
      result,
    };

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-promise-mutation-compensation",],
        {
          cwd: root,
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: (request) => {
            commands.push(request);
            if (request.kind === "secret-put") {
              return Promise.resolve(handle);
            }
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          },
          remoteBearerSecret: "promise-mutation-compensation-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(terminateCount).toBeGreaterThan(0);
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "secret-delete",
    ]);
    await expect(readFile(join(root, ".eden-deploy.lock", "ignored"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retains stop-before-result ownership until a late remote rejection", async () => {
    const root = await createRoot();
    const stopController = new AbortController();
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    const unhandled: unknown[] = [];
    let rejectResult: ((reason?: unknown) => void) | undefined;
    const result = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((_, reject) => {
      rejectResult = reject;
    });
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(
        runEdenCli(["agent", "init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);
      const deployPromise = runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-stop-before-result",],
        {
          cwd: root,
          stopSignal: stopController.signal,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: (request) => {
            commands.push(request);
            if (request.kind === "secret-put") {
              queueMicrotask(() => stopController.abort());
              return result;
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          remoteBearerSecret: "stop-before-result-secret",
        },
      );

      await expect(deployPromise).resolves.toBe(1);
      expect(errors.join("\n")).toMatch(/cancel|remote/i);
      expect(commands.map((request) => request.kind)).toEqual(["secret-put"]);
      await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
        .resolves.toContain("eden.deploy.lock");

      rejectResult?.(new Error("late remote rejection"));
      await vi.waitFor(() => {
        expect(commands.map((request) => request.kind)).toEqual([
          "secret-put",
          "secret-delete",
        ]);
      });
      await expectDeployLockRemoved(root);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      rejectResult?.(new Error("late remote rejection cleanup"));
    }
  }, 12_000);

  test("holds failed remote ownership and its lease until result and exit are terminal", async () => {
    const root = await createRoot();
    const stopController = new AbortController();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let resolveDeployResult: ((result: {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }) => void) | undefined;
    let resolveDeployExit: (() => void) | undefined;
    const deployResult = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      resolveDeployResult = resolve;
    });
    const deployExited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      resolveDeployExit = () => resolve({ exitCode: 1, signal: null });
    });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const deployPromise = runEdenCli(
      ["agent", "deploy", "--project",
      root,
      "--env",
      "preview",
      "--name",
      "eden-held-failed-remote",],
      {
        cwd: root,
        stopSignal: stopController.signal,
        remoteCommandRunner: (request) => {
          commands.push(request);
          if (request.kind === "secret-put") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (request.kind === "deploy") {
            queueMicrotask(() => stopController.abort());
            return {
              process: {
                pid: 55_408,
                startIdentity: "held-failed-remote",
                exited: deployExited,
                async terminate() {},
              },
              result: deployResult,
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        remoteBearerSecret: "held-failed-remote-secret",
      },
    );

    await expect(deployPromise).resolves.toBe(1);
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
    ]);
    const leaseEntriesBeforeTerminal = await readdir(root);
    expect(
      leaseEntriesBeforeTerminal.some((entry) =>
        entry.startsWith(".eden-deploy-lease-")
      ),
    ).toBe(true);
    expect(
      leaseEntriesBeforeTerminal.some((entry) =>
        entry.startsWith(".eden-deploy-release-lease-")
      ),
    ).toBe(false);

    resolveDeployResult?.({
      exitCode: 1,
      stdout: "",
      stderr: "deployment fixture failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
    ]);
    const leaseEntriesBeforeExit = await readdir(root);
    expect(
      leaseEntriesBeforeExit.some((entry) =>
        entry.startsWith(".eden-deploy-lease-")
      ),
    ).toBe(true);

    resolveDeployExit?.();
    await vi.waitFor(() => {
      expect(commands.map((request) => request.kind)).toEqual([
        "secret-put",
        "deploy",
        "secret-delete",
        "delete",
      ]);
    });
    await expectDeployLockRemoved(root);
  }, 12_000);

  test("retains a remote lease when the result settles before child exit", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let releaseExit: (() => void) | undefined;
    const childExited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });
    let sawLeaseBeforeExit = false;

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-result-before-exit",],
        {
          cwd: root,
          remoteCommandRunner: (request) => {
            commands.push(request);
            if (request.kind === "secret-put") {
              queueMicrotask(() => {
                void readdir(root).then((entries) => {
                  sawLeaseBeforeExit = entries.some((entry) =>
                    entry.startsWith(".eden-deploy-lease-"),
                  );
                  releaseExit?.();
                });
              });
              return {
                process: {
                  pid: 55_400,
                  startIdentity: "result-before-exit",
                  exited: childExited,
                  async terminate() {
                    releaseExit?.();
                  },
                },
                result: Promise.resolve({
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                }),
              };
            }
            return {
              exitCode: 0,
              stdout: request.kind === "deploy"
                ? "https://eden-result-before-exit.example.workers.dev\n"
                : "",
              stderr: "",
            };
          },
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "result-before-exit-secret",
        },
      ),
    ).resolves.toBe(0);

    expect(sawLeaseBeforeExit).toBe(true);
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
    ]);
  });

  test("retains exit-before-result ownership until the handle result settles", async () => {
    const root = await createRoot();
    const stopController = new AbortController();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let resolveRunner: ((value: EdenCliRemoteCommandHandle) => void) | undefined;
    const runnerResult = new Promise<EdenCliRemoteCommandHandle>((resolve) => {
      resolveRunner = resolve;
    });
    let terminateCount = 0;
    let releaseLateResult: (() => void) | undefined;

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const deployPromise = runEdenCli(
      ["agent", "deploy", "--project",
      root,
      "--env",
      "preview",
      "--name",
      "eden-exit-before-result",],
      {
        cwd: root,
        stopSignal: stopController.signal,
        remoteCommandRunner: (request) => {
          commands.push(request);
          if (request.kind === "secret-put") {
            queueMicrotask(() => stopController.abort());
            return runnerResult;
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        remoteBearerSecret: "exit-before-result-secret",
      },
    );

    await expect(deployPromise).resolves.toBe(1);
    expect(commands.map((request) => request.kind)).toEqual(["secret-put"]);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .resolves.toContain("eden.deploy.lock");

    resolveRunner?.({
      process: {
        pid: 55_403,
        startIdentity: "late-exit-before-result",
        exited: Promise.resolve({ exitCode: 0, signal: null }),
        async terminate() {
          terminateCount += 1;
        },
      },
      result: new Promise((resolve) => {
        releaseLateResult = () =>
          resolve({ exitCode: 0, stdout: "", stderr: "" });
      }),
    });
    expect(commands.map((request) => request.kind)).toEqual(["secret-put"]);
    await vi.waitFor(() => {
      expect(terminateCount).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    expect(terminateCount).toBeGreaterThan(0);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .resolves.toContain("eden.deploy.lock");
    releaseLateResult?.();
    await vi.waitFor(() => {
      expect(commands.map((request) => request.kind)).toEqual([
        "secret-put",
        "secret-delete",
      ]);
    });
    await expectDeployLockRemoved(root);
  }, 12_000);

  test("retains a late child handle beyond the caller timeout before compensation finishes", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let resolveRunner: ((value: EdenCliRemoteCommandHandle) => void) | undefined;
    const runnerResult = new Promise<EdenCliRemoteCommandHandle>((resolve) => {
      resolveRunner = resolve;
    });
    let terminateCount = 0;

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const deployPromise = runEdenCli(
      ["agent", "deploy", "--project",
      root,
      "--env",
      "preview",
      "--name",
      "eden-late-child-after-timeout",],
      {
        cwd: root,
        remoteCommandRunner: (request) => {
          commands.push(request);
          if (request.kind === "secret-put") return runnerResult;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        remoteBearerSecret: "late-child-after-timeout-secret",
      },
    );

    await expect(deployPromise).resolves.toBe(1);
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .resolves.toContain("eden.deploy.lock");

    let releaseExit: (() => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null });
    });
    resolveRunner?.({
      process: {
        pid: 55_402,
        startIdentity: "late-child-after-timeout",
        exited,
        async terminate() {
          terminateCount += 1;
          releaseExit?.();
        },
      },
      result: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await vi.waitFor(() => {
      expect(terminateCount).toBeGreaterThan(0);
    }, { timeout: 5_000 });
    expect(terminateCount).toBeGreaterThan(0);
    await expectDeployLockRemoved(root);
    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "secret-delete",
    ]);
  }, 12_000);

  test("waits for cleanup child terminality before starting the next compensation", async () => {
    const root = await createRoot();
    const commands: EdenCliRemoteCommandRequest[] = [];
    let releaseCleanupExit: (() => void) | undefined;
    let deleteStarted = false;
    const cleanupExited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((resolve) => {
      releaseCleanupExit = () => resolve({ exitCode: 0, signal: null });
    });

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const deployPromise = runEdenCli(
      ["agent", "deploy", "--project",
      root,
      "--env",
      "preview",
      "--name",
      "eden-serialized-compensation",],
      {
        cwd: root,
        remoteCommandRunner: (request) => {
          commands.push(request);
          if (request.kind === "secret-put") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (request.kind === "deploy") {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "deployment fixture failed",
            };
          }
          if (request.kind === "secret-delete") {
            return {
              process: {
                pid: 55_405,
                startIdentity: "serialized-secret-delete",
                exited: cleanupExited,
                async terminate() {},
              },
              result: Promise.resolve({
                exitCode: 0,
                stdout: "",
                stderr: "",
              }),
            };
          }
          deleteStarted = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        remoteBearerSecret: "serialized-compensation-secret",
      },
    );

    await vi.waitFor(() => {
      expect(commands.map((request) => request.kind)).toContain("secret-delete");
    }, { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deleteStarted).toBe(false);

    releaseCleanupExit?.();
    await vi.waitFor(() => {
      expect(deleteStarted).toBe(true);
    });
    await expect(deployPromise).resolves.toBe(1);
  }, 12_000);

  test("preserves the primary error when compensation lease release fails", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".eden-deploy.lock");
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];
    let tamperedLease = "";

    expect(await runEdenCli(["agent", "init", "--project", root], { cwd: root })).toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project", root, "--name", "eden-compensation-lease"],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: async (request) => {
            commands.push(request);
            if (request.kind === "secret-delete") {
              const lease = (await readdir(root)).find((entry) =>
                entry.startsWith(".eden-deploy-lease-")
              );
              if (lease === undefined) throw new Error("missing cleanup lease");
              tamperedLease = join(root, lease);
              await rm(tamperedLease, { force: true });
              await writeFile(tamperedLease, "replacement lease\n", "utf8");
            }
            return {
              exitCode: request.kind === "deploy" ? 1 : 0,
              stdout: "",
              stderr: request.kind === "deploy"
                ? "primary deployment failure"
                : "",
            };
          },
          remoteBearerSecret: "compensation-lease-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands.map((request) => request.kind)).toEqual([
      "secret-put",
      "deploy",
      "secret-delete",
      "delete",
    ]);
    expect(errors.join("\n")).toMatch(/REMOTE_DEPLOY_FAILED/u);
    expect(errors.join("\n")).toMatch(/REMOTE_CLEANUP_LEASE_RETAINED/u);
    expect(tamperedLease).not.toBe("");
    await expect(readFile(tamperedLease, "utf8")).resolves.toBe(
      "replacement lease\n",
    );
    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      "eden.deploy.lock",
    );
    await expect(readdir(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining("eden-deploy-lease-"),
      ]),
    );
  }, 12_000);

  test("retains the lease and lock when identity-preserving lease release fails", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".eden-deploy.lock");
    const commands: EdenCliRemoteCommandRequest[] = [];
    let tamperedLease = "";
    let originalLockContents = "";

    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-retained-lease",],
        {
          cwd: root,
          remoteCommandRunner: async (request) => {
            commands.push(request);
            if (request.kind === "secret-put") {
              originalLockContents = await readFile(lockPath, "utf8");
              let releaseResult: (() => void) | undefined;
              const result = new Promise<{
                readonly exitCode: number;
                readonly stdout: string;
                readonly stderr: string;
              }>((resolve) => {
                releaseResult = () =>
                  resolve({ exitCode: 1, stdout: "", stderr: "" });
              });
              const exited = result.then(() => ({
                exitCode: 0,
                signal: null,
              }));
              queueMicrotask(() => {
                void readdir(root).then((entries) => {
                  const lease = entries.find((entry) =>
                    entry.startsWith(".eden-deploy-lease-")
                  );
                  if (lease !== undefined) {
                    tamperedLease = join(root, lease);
                    return writeFile(tamperedLease, "tampered lease\n", "utf8")
                      .then(() => releaseResult?.());
                  }
                  releaseResult?.();
                  return undefined;
                });
              });
              return {
                process: {
                  pid: 55_407,
                  startIdentity: "retained-lease",
                  exited,
                  async terminate() {
                    releaseResult?.();
                  },
                },
                result,
              };
            }
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          },
          remoteBearerSecret: "retained-lease-secret",
        },
      ),
    ).resolves.toBe(1);

    expect(commands.map((request) => request.kind)).toContain("secret-put");
    expect(tamperedLease).not.toBe("");
    await expect(readFile(tamperedLease, "utf8")).resolves.toBe(
      "tampered lease\n",
    );
    await expect(readFile(lockPath, "utf8"))
      .resolves.toBe("tampered lease\n");
    await expect(readdir(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.stringContaining("eden-deploy-lease-"),
      ]),
    );
    await writeFile(lockPath, originalLockContents, "utf8");
    await expectDeployLockRemoved(root);
  }, 12_000);

  test("reconciles orphaned lease-release residue and preserves unverified replacements", async () => {
    const root = await createRoot();
    const orphanedResidue = join(
      root,
      ".eden-deploy-release-lease-999999999-00000000-0000-4000-8000-000000000000",
    );
    const orphanedState = {
      kind: "eden.deploy.lock",
      version: 1,
      pid: 999_999_999,
      startedAt: "orphaned-deploy-start",
      token: "orphaned-deploy-token",
    };
    await expect(
      runEdenCli(["agent", "init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await writeFile(
      orphanedResidue,
      `${JSON.stringify(orphanedState)}\n`,
      "utf8",
    );
    await expect(
      runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-orphaned-lease-residue",],
        {
          cwd: root,
          dryRunRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          remoteCommandRunner: async (request) => ({
            exitCode: 0,
            stdout: request.kind === "deploy"
              ? "https://eden-orphaned-lease-residue.example.workers.dev\n"
              : "",
            stderr: "",
          }),
          remoteValidationRunner: async () => ({ ok: true }),
          remoteBearerSecret: "orphaned-lease-residue-secret",
        },
      ),
    ).resolves.toBe(0);
    await expect(readFile(orphanedResidue, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const unverifiedRoot = await createRoot();
    const unverifiedResidue = join(
      unverifiedRoot,
      ".eden-deploy-release-lease-999999999-00000000-0000-4000-8000-000000000001",
    );
    const unverifiedBytes = "replacement lease residue\n";
    await writeFile(unverifiedResidue, unverifiedBytes, "utf8");
    const errors: string[] = [];
    await expect(
      runEdenCli(["agent", "deploy", "--project", unverifiedRoot, "--name", "eden-unverified-residue"], {
        cwd: unverifiedRoot,
        stderr: (line) => errors.push(line),
        remoteBearerSecret: "unverified-residue-secret",
      }),
    ).resolves.toBe(1);
    await expect(readFile(unverifiedResidue, "utf8"))
      .resolves.toBe(unverifiedBytes);
    expect(errors.join("\n")).toMatch(/residue|identity|busy|verify/i);
  });

  test("does not treat a rejected child exit observation as terminal proof", async () => {
    const root = await createRoot();
    const stopController = new AbortController();
    const errors: string[] = [];
    const unhandled: unknown[] = [];
    let rejectExit: ((reason?: unknown) => void) | undefined;
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal: null;
    }>((_, reject) => {
      rejectExit = reject;
    });
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(
        runEdenCli(["agent", "init", "--project", root], { cwd: root }),
      ).resolves.toBe(0);
      const deployPromise = runEdenCli(
        ["agent", "deploy", "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-rejected-exit-observer",],
        {
          cwd: root,
          stopSignal: stopController.signal,
          stderr: (line) => errors.push(line),
          remoteCommandRunner: (request) => {
            if (request.kind !== "secret-put") {
              throw new Error("compensation must not start without terminal proof");
            }
            queueMicrotask(() => stopController.abort());
            return {
              process: {
                pid: 55_406,
                startIdentity: "rejected-exit-observer",
                exited,
                async terminate() {},
              },
              result: Promise.resolve({
                exitCode: 0,
                stdout: "",
                stderr: "",
              }),
            };
          },
          remoteBearerSecret: "rejected-exit-secret",
        },
      );

      await expect(deployPromise).resolves.toBe(1);
      await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
        .resolves.toContain("eden.deploy.lock");
      await expect(readdir(root)).resolves.toEqual(
        expect.arrayContaining([
          expect.stringContaining("eden-deploy-lease-"),
        ]),
      );
      rejectExit?.(new Error("exit observer rejected"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
      expect(errors.join("\n")).toMatch(/terminal|quiescence|cancel|remote/i);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      rejectExit?.(new Error("exit observer rejected cleanup"));
    }
  }, 12_000);
});

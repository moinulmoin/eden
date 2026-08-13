import {
  readFile,
  mkdtemp,
  type EdenCliProcess,
  writeFile,
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

  test("does not start a remote mutation after deployment ownership is replaced", async () => {
    const root = await createRoot();
    const lockPath = join(root, ".eden-deploy.lock");
    const commands: EdenCliRemoteCommandRequest[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-cas-replacement",
        ],
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);

    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-remote-handle-signal",
        ],
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

  test("starts remote cleanup commands even after deploy cancellation", async () => {
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-cancel-cleanup",
        ],
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
      "delete",
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-remote-late-handle",
        ],
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-source-cas",
        ],
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-final-spawn-cas",
        ],
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-post-preflight-cas",
        ],
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-post-final-read-cas",
        ],
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
    let releaseCleanup: (() => void) | undefined;
    const pendingCleanup = new Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve) => {
      releaseCleanup = () => resolve({ exitCode: 1, stdout: "", stderr: "" });
    });

    await expect(
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    const deployPromise = runEdenCli(
      [
        "deploy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eden-pending-remote-cleanup",
      ],
      {
        cwd: root,
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
        setTimeout(() => resolve({ settled: false }), 2_500);
      }),
    ]);
    expect(observed).toEqual({ settled: true, code: 1 });
    releaseCleanup?.();
    await expect(deployPromise).resolves.toBe(1);
    expect(commands.map((request) => request.kind)).toContain("secret-delete");
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
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
      runEdenCli(["init", "--project", root], { cwd: root }),
    ).resolves.toBe(0);
    await expect(
      runEdenCli(
        [
          "deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eden-promise-mutation-compensation",
        ],
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
      "delete",
    ]);
    await expect(readFile(join(root, ".eden-deploy.lock", "ignored"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".eden-deploy.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

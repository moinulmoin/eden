import {
  execFile,
} from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";
import {
  promisify,
} from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  EVE_RESERVED_HOST_VARIABLES,
  EVE_START_COMMAND,
  EveRuntimeConfigError,
  loadEveRuntimeConfig,
  parseEveRuntimeConfig,
  prepareEveRuntimeInjection,
  redactEveRuntimeOutput,
  readEveRuntimeConfig,
} from "../src/eve-runtime-config.js";
import {
  EveCliError,
  runEdenCli,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function createRoot(prefix = "eden-eve-runtime-config-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeEnv(root: string, contents: string | Uint8Array): Promise<string> {
  const path = join(root, "explicit-runtime.env");
  await writeFile(path, contents);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Eve runtime configuration", () => {
  test("parses the small opaque UTF-8 KEY=VALUE grammar literally", async () => {
    const root = await createRoot();
    const envPath = await writeEnv(
      root,
      [
        "",
        "  # leading whitespace comment",
        "# another comment",
        "PROVIDER_SHAPED=  value with spaces = and punctuation!$",
        "UNICODE=こんにちは世界",
        "EMPTY=",
        "SHELL_LOOKING=$(danger) \"quoted\" '$HOME'",
        "caseSensitive=lower-is-data",
        "CASeSENSITIVE=upper-is-data",
        "",
      ].join("\n"),
    );
    const config = await readEveRuntimeConfig(envPath);

    expect(config.seam).toMatchObject({
      supplied: true,
      variableNames: [
        "CASeSENSITIVE",
        "EMPTY",
        "PROVIDER_SHAPED",
        "SHELL_LOOKING",
        "UNICODE",
        "caseSensitive",
      ],
      excludedFromBuildInputs: true,
    });
    expect(config.seam.reservedHostNames).toEqual(EVE_RESERVED_HOST_VARIABLES);
    expect(JSON.stringify(config.seam)).not.toContain("こんにちは世界");
    expect(JSON.stringify(config.seam)).not.toContain("danger");

    const observed: Record<string, string> = {};
    config.withProtectedValues((values) => {
      Object.assign(observed, values);
    });
    expect(observed).toEqual({
      CASeSENSITIVE: "upper-is-data",
      EMPTY: "",
      PROVIDER_SHAPED: "  value with spaces = and punctuation!$",
      SHELL_LOOKING: "$(danger) \"quoted\" '$HOME'",
      UNICODE: "こんにちは世界",
      caseSensitive: "lower-is-data",
    });
    config.dispose();
  });

  test("rejects malformed, duplicate, and reserved assignments without exposing values", async () => {
    const cases = [
      ["missing equals", "MALFORMED", "EVE_ENV_FILE_MALFORMED"],
      ["invalid name", "NOT-VALID=value", "EVE_ENV_FILE_MALFORMED"],
      ["duplicate", "SAME=one\nSAME=two\n", "EVE_ENV_FILE_DUPLICATE"],
      [
        "reserved",
        "PORT=secret-port-marker\n",
        "EVE_ENV_RESERVED_VARIABLE",
      ],
    ] as const;
    for (const [label, contents, code] of cases) {
      const root = await createRoot(`eden-eve-runtime-config-${label}-`);
      const envPath = await writeEnv(root, contents);
      await expect(readEveRuntimeConfig(envPath)).rejects.toMatchObject({ code });
      try {
        await readEveRuntimeConfig(envPath);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(EveRuntimeConfigError);
        expect((error as Error).message).not.toContain("secret-port-marker");
      }
    }
  });

  test.each(EVE_RESERVED_HOST_VARIABLES)(
    "rejects exact reserved host variable %s but permits lower-case near misses",
    async (name) => {
      const root = await createRoot();
      const envPath = await writeEnv(root, `${name}=opaque-reserved-marker\n`);
      await expect(readEveRuntimeConfig(envPath)).rejects.toMatchObject({
        code: "EVE_ENV_RESERVED_VARIABLE",
        variableName: name,
      });
      const lowerPath = await writeEnv(root, `${name.toLowerCase()}=allowed\n`);
      await expect(readEveRuntimeConfig(lowerPath)).resolves.toBeDefined();
    },
  );

  test("rejects invalid UTF-8, missing paths, and non-regular paths as Eden-owned errors", async () => {
    const root = await createRoot();
    const invalidUtf8 = await writeEnv(root, Uint8Array.from([0xff, 0xfe]));
    await expect(readEveRuntimeConfig(invalidUtf8)).rejects.toMatchObject({
      code: "EVE_ENV_FILE_ENCODING",
    });
    await expect(
      readEveRuntimeConfig(join(root, "missing.env")),
    ).rejects.toMatchObject({
      code: "EVE_ENV_FILE_NOT_FOUND",
    });
    const directory = join(root, "directory.env");
    await writeFile(directory, "");
    await rm(directory);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
    await expect(readEveRuntimeConfig(directory)).rejects.toMatchObject({
      code: "EVE_ENV_FILE_INVALID",
    });
  });

  test("keeps ambient Native/control-plane credentials out of explicit runtime startup", async () => {
    const root = await createRoot();
    const marker = "explicit-runtime-marker-9f7c";
    const envPath = await writeEnv(
      root,
      `EDEN_BEARER_SECRET=${marker}\nPROJECT_AUTH=${marker}-auth\n`,
    );
    const previous = process.env.EDEN_BEARER_SECRET;
    process.env.EDEN_BEARER_SECRET = "ambient-control-plane-marker";
    try {
      const config = await parseEveRuntimeConfig(envPath);
      const injection = await prepareEveRuntimeInjection(config, {
        mode: "preflight",
      });
      let requestEnv: Readonly<Record<string, string>> | undefined;
      await injection.runLocal({
        cwd: root,
        hostEnvironment: {
          HOST: "0.0.0.0",
          NITRO_HOST: "0.0.0.0",
          PORT: "8080",
          NITRO_PORT: "8080",
          NODE_ENV: "production",
        },
        run: (request) => {
          requestEnv = request.env;
          expect(request.command).toBe("./node_modules/.bin/eve");
          expect(request.args).toEqual(EVE_START_COMMAND.slice(1));
        },
      });
      expect(requestEnv).toMatchObject({
        EDEN_BEARER_SECRET: marker,
        PROJECT_AUTH: `${marker}-auth`,
      });
      expect(requestEnv).not.toHaveProperty("ambient-control-plane-marker");
      expect(requestEnv).not.toHaveProperty("PATH");
      config.dispose();
    } finally {
      if (previous === undefined) delete process.env.EDEN_BEARER_SECRET;
      else process.env.EDEN_BEARER_SECRET = previous;
    }
  });

  test("uses local protected injection for preflight and never calls a remote store", async () => {
    const root = await createRoot();
    const marker = "preflight-only-marker-32c8";
    const envPath = await writeEnv(root, `OPAQUE_VALUE=${marker}\n`);
    const remoteCalls = 0;
    const config = await readEveRuntimeConfig(envPath);
    const injection = await prepareEveRuntimeInjection(config, {
      mode: "preflight",
    });
    await injection.runLocal({
      cwd: root,
      hostEnvironment: { NODE_ENV: "production" },
      run: (request) => {
        expect(request.env.OPAQUE_VALUE).toBe(marker);
        expect(request.env.NODE_ENV).toBe("production");
      },
    });
    expect(remoteCalls).toBe(0);
    expect(redactEveRuntimeOutput(`failure ${marker}`)).toBe(
      "failure [redacted]",
    );
    config.dispose();
  });

  test("redacts registered runtime values from CLI failure output", async () => {
    const root = await createRoot();
    const marker = "cli-failure-runtime-marker-c5b3";
    const envPath = await writeEnv(root, `OPAQUE_VALUE=${marker}\n`);
    const config = await readEveRuntimeConfig(envPath);
    const errors: string[] = [];
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
          "eve-redaction",
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          eveRunner: async () => {
            throw new EveCliError({
              code: "EVE_RUNTIME_FAILED",
              message: `child stderr included ${marker}`,
            });
          },
        },
      ),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toContain("EVE_RUNTIME_FAILED");
    expect(errors.join("\n")).not.toContain(marker);
    config.dispose();
  });

  test("uses a protected deploy store without putting values in argv or metadata", async () => {
    const root = await createRoot();
    const marker = "deploy-protected-marker-1a53";
    const envPath = await writeEnv(root, `OPAQUE_VALUE=${marker}\n`);
    const requests: Array<{
      readonly targetId: string;
      readonly revision: string;
      readonly variableNames: readonly string[];
      readonly values: Readonly<Record<string, string>>;
    }> = [];
    const config = await readEveRuntimeConfig(envPath);
    const injection = await prepareEveRuntimeInjection(config, {
      mode: "deploy",
      targetId: "exact-target",
      protectedStore: {
        async put(request) {
          requests.push(request);
          return {
            revision: request.revision,
            handle: `eve-runtime-handle-${"a".repeat(8)}-${"b".repeat(4)}-4ccc-8ddd-${"e".repeat(12)}`,
          };
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      targetId: "exact-target",
      inputIdentity: {
        byteLength: marker.length + "OPAQUE_VALUE=".length + 1,
      },
      variableNames: ["OPAQUE_VALUE"],
      values: { OPAQUE_VALUE: marker },
    });
    expect(JSON.stringify(injection.seam)).not.toContain(marker);
    expect(JSON.stringify(injection)).not.toContain(marker);
    await expect(
      injection.runLocal({
        cwd: root,
        hostEnvironment: {},
        run: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "EVE_RUNTIME_LOCAL_INJECTION_UNSUPPORTED",
    });
    config.dispose();
  });

  test("detects an explicit environment-file race before protected upload", async () => {
    const root = await createRoot();
    const envPath = await writeEnv(root, "OPAQUE_VALUE=before\n");
    const config = await readEveRuntimeConfig(envPath);
    await writeFile(envPath, "OPAQUE_VALUE=after\n");
    let storeCalled = false;
    await expect(
      prepareEveRuntimeInjection(config, {
        mode: "deploy",
        targetId: "exact-target",
        protectedStore: {
          async put() {
            storeCalled = true;
            return {
              revision: "eve-runtime-revision-00000000-0000-4000-8000-000000000000",
              handle: "eve-runtime-handle-00000000-0000-4000-8000-000000000000",
            };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "EVE_ENV_FILE_RACE" });
    expect(storeCalled).toBe(false);
    config.dispose();
  });

  test("uses a Node-option-safe executable launcher for application env-file arguments", async () => {
    const source = await readFile(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(source.split("\n", 1)[0]).toBe("#!/usr/bin/env -S node --");

    const root = await createRoot();
    const executable = join(root, "launcher.mjs");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env -S node --",
        "console.log(JSON.stringify({ args: process.argv.slice(2), marker: process.env.NODE_OPTION_MARKER ?? null }));",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const missing = await execFileAsync(executable, [
      "--env-file",
      join(root, "missing.env"),
    ]);
    expect(JSON.parse(missing.stdout.trim())).toEqual({
      args: ["--env-file", join(root, "missing.env")],
      marker: null,
    });
    const existingEnv = await writeEnv(root, "NODE_OPTION_MARKER=node-must-not-load\n");
    const separate = await execFileAsync(executable, [
      "--env-file",
      existingEnv,
    ]);
    expect(JSON.parse(separate.stdout.trim())).toEqual({
      args: ["--env-file", existingEnv],
      marker: null,
    });
    const equals = await execFileAsync(executable, [
      `--env-file=${existingEnv}`,
    ]);
    expect(JSON.parse(equals.stdout.trim())).toEqual({
      args: [`--env-file=${existingEnv}`],
      marker: null,
    });
  });

  test("forwards existing and missing env-file paths to Eden rather than Node", async () => {
    const root = await createRoot();
    const envPath = await writeEnv(root, "VALUE=opaque\n");
    const requests: string[] = [];
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
          "eve-env-file",
          "--env-file",
          envPath,
        ],
        {
          cwd: root,
          eveRunner: async (request) => {
            requests.push(request.envFile ?? "");
          },
        },
      ),
    ).resolves.toBe(0);
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
          "eve-missing-file",
          `--env-file=${join(root, "missing.env")}`,
        ],
        {
          cwd: root,
          eveRunner: async (request) => {
            requests.push(request.envFile ?? "");
          },
        },
      ),
    ).resolves.toBe(0);
    expect(requests).toEqual([envPath, join(root, "missing.env")]);
  });

  test("reports an Eden-owned error when a missing path is parsed", async () => {
    await expect(loadEveRuntimeConfig("/tmp/eden-env-file-that-is-not-present")).rejects.toMatchObject({
      code: "EVE_ENV_FILE_NOT_FOUND",
    });
  });

  test("renders parser failures with their Eden error code", async () => {
    const root = await createRoot();
    const missingPath = join(root, "missing.env");
    const errors: string[] = [];
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
          "eve-parser-error",
          "--env-file",
          missingPath,
        ],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          eveRunner: async (request) => {
            await loadEveRuntimeConfig(request.envFile ?? "");
          },
        },
      ),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toContain("EVE_ENV_FILE_NOT_FOUND");
    expect(errors.join("\n")).not.toContain(missingPath);
  });
});

import {
  createHash,
} from "node:crypto";
import {
  chmod,
  mkdir,
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

import { afterEach, describe, expect, test } from "vitest";

import {
  buildEveRuntimeImage,
  validateEveHostRequirements,
  type EveRuntimeImageRequest,
} from "../src/eve-runtime-image.js";

const roots: string[] = [];

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeCandidate(root: string): Promise<EveRuntimeImageRequest["candidate"]> {
  const generationRoot = join(root, "generation");
  const snapshotRoot = join(generationRoot, "container", "snapshot");
  await mkdir(join(snapshotRoot, ".output/server"), { recursive: true });
  await mkdir(join(snapshotRoot, "node_modules/eve/bin"), { recursive: true });
  await writeFile(
    join(snapshotRoot, ".output/server/index.mjs"),
    "export default {};\n",
    "utf8",
  );
  await writeFile(
    join(snapshotRoot, "node_modules/eve/package.json"),
    JSON.stringify({ name: "eve", version: "0.31.3", bin: "bin/eve.js" }),
    "utf8",
  );
  await writeFile(
    join(snapshotRoot, "node_modules/eve/bin/eve.js"),
    "#!/usr/bin/env node\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(join(snapshotRoot, "node_modules/eve/bin/eve.js"), 0o755);
  await mkdir(join(snapshotRoot, "node_modules/.bin"), { recursive: true });
  await writeFile(
    join(snapshotRoot, "node_modules/.bin/eve"),
    "#!/usr/bin/env node\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(join(snapshotRoot, "node_modules/.bin/eve"), 0o755);

  const entrypoint = await readFile(
    join(snapshotRoot, ".output/server/index.mjs"),
  );
  const outputSha256 = createHash("sha256").update(entrypoint).digest("hex");
  const outputDigest = createHash("sha256")
    .update(JSON.stringify([{
      relativePath: ".output/server/index.mjs",
      sha256: outputSha256,
      byteLength: entrypoint.byteLength,
    }]) + "\n")
    .digest("hex");
  return {
    generationId: "generation-one",
    generationRoot,
    snapshotRoot,
    inputManifestPath: join(generationRoot, "input-manifest.json"),
    packageManager: "pnpm",
    packageManagerVersion: "11.21.0",
    installCommand: ["corepack", "pnpm", "install", "--frozen-lockfile"],
    buildCommand: ["./node_modules/.bin/eve", "build"],
    eveExecutable: "node_modules/.bin/eve",
    eveVersion: "0.31.3",
    packageJsonSha256: "a".repeat(64),
    lockfileSha256: "b".repeat(64),
    sourceDigest: "c".repeat(64),
    snapshotDigest: "d".repeat(64),
    generatedOutput: {
      entrypointPath: ".output/server/index.mjs",
      sha256: outputSha256,
      regularFile: true,
      symlinkEscape: false,
      outputDigest,
      fileCount: 1,
    },
    runtimeVariableNames: [],
  };
}

async function writeFakeDocker(root: string, options: {
  readonly imageId?: string;
  readonly suppressImageIdentity?: boolean;
  readonly healthPort?: number;
  readonly healthReady?: boolean;
} = {}): Promise<{ readonly command: string; readonly log: string }> {
  const command = join(root, "fake-docker.cjs");
  const log = join(root, "docker-args.jsonl");
  const imageId = options.imageId ?? `sha256:${"1".repeat(64)}`;
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const imageId = ${JSON.stringify(imageId)};
const suppressImageIdentity = ${JSON.stringify(options.suppressImageIdentity ?? false)};
const removedImage = ${JSON.stringify(`${log}.image-removed`)};
const removedContainer = ${JSON.stringify(`${log}.container-removed`)};
if (args[0] === "version") {
  process.stdout.write("29.4.0\\n");
} else if (args[0] === "build") {
  const iidfile = args[args.indexOf("--iidfile") + 1];
  if (!suppressImageIdentity && iidfile !== undefined) {
    fs.writeFileSync(iidfile, imageId + "\\n");
  }
} else if (args[0] === "image" && args[1] === "inspect") {
  if (fs.existsSync(removedImage)) {
    process.stderr.write("No such object: image\\n");
    process.exitCode = 1;
  }
  else {
    const format = args[args.indexOf("--format") + 1] ?? "";
    if (format.includes(".Config.Entrypoint")) {
      process.stdout.write(JSON.stringify(["./node_modules/.bin/eve", "start", "--host", "0.0.0.0", "--port", "8080"]) + "\\n");
    } else if (format.includes(".Config.WorkingDir")) {
      process.stdout.write("/app\\n");
    } else if (format.includes(".Config.Env")) {
      process.stdout.write(JSON.stringify(["HOST=0.0.0.0", "NITRO_HOST=0.0.0.0", "PORT=8080", "NITRO_PORT=8080", "NODE_ENV=production"]) + "\\n");
    } else {
      process.stdout.write(imageId + " linux amd64\\n");
    }
  }
} else if (args[0] === "image" && args[1] === "ls") {
  if (!suppressImageIdentity && !fs.existsSync(removedImage)) process.stdout.write(imageId + "\\n");
} else if (args[0] === "image" && args[1] === "rm") {
  fs.writeFileSync(removedImage, "removed\\n");
} else if (args[0] === "run") {
  process.stdout.write("boot-container-1\\n");
} else if (args[0] === "inspect") {
  const format = args[args.indexOf("--format") + 1] ?? "";
  if (fs.existsSync(removedContainer)) {
    process.stderr.write("No such object: container\\n");
    process.exitCode = 1;
  }
  else if (format.includes(".Config.Entrypoint")) {
    process.stdout.write(JSON.stringify(["./node_modules/.bin/eve", "start", "--host", "0.0.0.0", "--port", "8080"]) + "\\n");
  } else if (format.includes(".Config.WorkingDir")) {
    process.stdout.write("/app\\n");
  } else if (format.includes(".Config.Env")) {
    process.stdout.write(JSON.stringify(["HOST=0.0.0.0", "NITRO_HOST=0.0.0.0", "PORT=8080", "NITRO_PORT=8080", "NODE_ENV=production"]) + "\\n");
  } else if (format.includes(".Config.Labels")) {
    process.stdout.write("generation-one\\n");
  } else {
    process.stdout.write("boot-container-1\\n");
  }
} else if (args[0] === "top") {
  process.stdout.write("PID COMMAND\\n1 ./node_modules/.bin/eve start --host 0.0.0.0 --port 8080\\n");
} else if (args[0] === "exec") {
  process.stdout.write("runtime closure verified\\n");
} else if (args[0] === "history") {
  process.stdout.write("COPY --from=candidate /candidate/.output /app/.output\\nCOPY --from=candidate /candidate/node_modules /app/node_modules\\n");
} else if (args[0] === "cp") {
  const destination = args[2];
  if (destination !== undefined) fs.mkdirSync(destination, { recursive: true });
} else if (args[0] === "stop") {
  process.stdout.write("boot-container-1\\n");
} else if (args[0] === "rm") {
  fs.writeFileSync(removedContainer, "removed\\n");
} else if (args[0] === "container" && args[1] === "inspect") {
  if (!fs.existsSync(removedContainer)) process.stdout.write("boot-container-1\\n");
  else {
    process.stderr.write("No such object: container\\n");
    process.exitCode = 1;
  }
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

describe("Eve runtime image boundary", () => {
  test("rejects unsupported World, sandbox, privilege, device, and durable-state requirements", () => {
    expect(() => validateEveHostRequirements({
      architecture: "linux/amd64",
      world: "unsupported",
      sandbox: "supported",
      privileged: false,
      devices: "none",
      kernel: "supported",
      network: "supported",
      durableLocalFilesystem: false,
    })).toThrow(/Workflow World/u);

    expect(() => validateEveHostRequirements({
      architecture: "linux/amd64",
      world: "supported",
      sandbox: "unknown",
      privileged: false,
      devices: "none",
      kernel: "supported",
      network: "supported",
      durableLocalFilesystem: false,
    })).toThrow(/sandbox/u);

    expect(() => validateEveHostRequirements({
      architecture: "linux/amd64",
      world: "supported",
      sandbox: "supported",
      privileged: true,
      devices: "none",
      kernel: "supported",
      network: "supported",
      durableLocalFilesystem: false,
    })).toThrow(/privileged/u);

    expect(() => validateEveHostRequirements({
      architecture: "linux/amd64",
      world: "supported",
      sandbox: "supported",
      privileged: false,
      devices: "required",
      kernel: "supported",
      network: "supported",
      durableLocalFilesystem: false,
    })).toThrow(/device/u);

    expect(() => validateEveHostRequirements({
      architecture: "linux/amd64",
      world: "supported",
      sandbox: "supported",
      privileged: false,
      devices: "none",
      kernel: "supported",
      network: "unknown",
      durableLocalFilesystem: false,
    })).toThrow(/network/u);

    expect(() => validateEveHostRequirements({
      architecture: "linux/amd64",
      world: "supported",
      sandbox: "supported",
      privileged: false,
      devices: "none",
      kernel: "supported",
      network: "supported",
      durableLocalFilesystem: true,
    })).toThrow(/durable/u);
  });

  test("boots the exact project-local Eve launcher and accepts only real ready health", async () => {
    const root = await createRoot("eden-eve-runtime-image-");
    const candidate = await writeCandidate(root);
    const fakeDocker = await writeFakeDocker(root);
    const healthUrls: string[] = [];
    let healthCalls = 0;

    const result = await buildEveRuntimeImage({
      candidate,
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest: `sha256:${"0".repeat(64)}`,
      },
      dockerCommand: fakeDocker.command,
      healthPort: 4310,
      healthTimeoutMs: 200,
      fetchHealth: async (url) => {
        healthUrls.push(url);
        healthCalls += 1;
        return new Response(
          healthCalls === 1
            ? JSON.stringify({ status: "starting" })
            : JSON.stringify({ status: "ready" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
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
    });
    expect(result).toMatchObject({
      status: "ready",
      returnCode: "EVE_PACKAGE_READY",
      image: {
        platform: "linux/amd64",
        launchCommand: [
          "./node_modules/.bin/eve",
          "start",
          "--host",
          "0.0.0.0",
          "--port",
          "8080",
        ],
      },
      runtime: {
        listenHost: "0.0.0.0",
        listenPort: 8080,
        healthPath: "/eve/v1/health",
        healthStatus: "ready",
        healthVerified: true,
        durableLocalFilesystemClaim: false,
      },
      cleanup: {
        bootContainerRemoved: true,
        imageRetained: true,
        verified: true,
      },
    });
    expect(healthUrls).toEqual(["http://127.0.0.1:4310/eve/v1/health", "http://127.0.0.1:4310/eve/v1/health"]);
    const dockerArgs = (await readFile(fakeDocker.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(dockerArgs.find((args) => args[0] === "build")).toEqual(
      expect.arrayContaining(["--platform=linux/amd64", "--iidfile"]),
    );
    expect(dockerArgs.find((args) => args[0] === "run")).toEqual(
      expect.arrayContaining(["--publish", "4310:8080"]),
    );
    expect(dockerArgs).toContainEqual(
      expect.arrayContaining(["top", "boot-container-1"]),
    );
    await expect(
      readFile(join(candidate.generationRoot, "container/runtime-context")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes the disposable runtime image when retention is disabled", async () => {
    const root = await createRoot("eden-eve-runtime-image-disposable-");
    const candidate = await writeCandidate(root);
    const fakeDocker = await writeFakeDocker(root);

    const result = await buildEveRuntimeImage({
      candidate,
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest: `sha256:${"0".repeat(64)}`,
      },
      dockerCommand: fakeDocker.command,
      healthPort: 4313,
      retainImage: false,
      fetchHealth: async () => new Response(
        JSON.stringify({ status: "ready" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
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
    });

    expect(result).toMatchObject({
      status: "ready",
      candidateImageRetainedLocally: false,
      cleanup: {
        bootContainerRemoved: true,
        imageIdentity: "exact",
        imageRetained: false,
        verified: true,
      },
    });
    const dockerArgs = (await readFile(fakeDocker.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(dockerArgs.some((args) =>
      args[0] === "image" && args[1] === "rm"
    )).toBe(true);
  });

  test("fails when the real Eve health route never reports ready", async () => {
    const root = await createRoot("eden-eve-runtime-image-health-");
    const candidate = await writeCandidate(root);
    const fakeDocker = await writeFakeDocker(root);

    const result = await buildEveRuntimeImage({
      candidate,
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest: `sha256:${"0".repeat(64)}`,
      },
      dockerCommand: fakeDocker.command,
      healthPort: 4312,
      healthTimeoutMs: 20,
      healthPollIntervalMs: 1,
      fetchHealth: async () => new Response("tcp-listener-only", { status: 200 }),
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
    });

    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "EVE_HEALTH_FAILED",
      cleanup: {
        bootContainerRemoved: true,
        imageRetained: false,
        verified: true,
      },
    });
    const dockerArgs = (await readFile(fakeDocker.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(dockerArgs.some((args) => args[0] === "image" && args[1] === "rm")).toBe(true);
  });

  test("reports indeterminate cleanup when the image identity cannot be recovered", async () => {
    const root = await createRoot("eden-eve-runtime-image-indeterminate-");
    const candidate = await writeCandidate(root);
    const fakeDocker = await writeFakeDocker(root, { suppressImageIdentity: true });

    const result = await buildEveRuntimeImage({
      candidate,
      nodeImage: {
        reference: "node:24.17.0-bookworm-slim",
        digest: `sha256:${"0".repeat(64)}`,
      },
      dockerCommand: fakeDocker.command,
      healthPort: 4311,
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
    });
    expect(result).toMatchObject({
      status: "blocked",
      returnCode: "CLEANUP_UNVERIFIED",
      candidateImageId: null,
      cleanup: {
        verified: false,
        imageIdentity: "indeterminate",
      },
    });
    const dockerArgs = (await readFile(fakeDocker.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(dockerArgs.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
  });
});

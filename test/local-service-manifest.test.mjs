import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout as delayTimer } from "node:timers/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const missionManifestPath = process.env.EDEN_SERVICES_MANIFEST ??
  (process.env.FACTORY_RUNTIME_SETTINGS_PATH === undefined
    ? undefined
    : join(dirname(process.env.FACTORY_RUNTIME_SETTINGS_PATH), "services.yaml"));

if (missionManifestPath === undefined) {
  throw new Error(
    "eden-local lifecycle validation requires EDEN_SERVICES_MANIFEST or " +
    "FACTORY_RUNTIME_SETTINGS_PATH pointing to the mission harness configuration.",
  );
}

function manifestCommands(source) {
  const lines = source.split(/\r?\n/u);
  const commands = {};
  for (const key of ["start", "stop", "healthcheck"]) {
    const marker = `    ${key}: >-`;
    const start = lines.indexOf(marker);
    if (start < 0) throw new Error(`services.yaml is missing eden-local.${key}.`);
    const body = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith("      ")) break;
      body.push(line.slice(6).trim());
    }
    commands[key] = body.join(" ");
  }
  return commands;
}

function runShell(command, env) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("exit", (code, signal) => resolve({
      code: code ?? 1,
      signal,
    }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
}

function startShell(command, env) {
  const processIdentity = `eden-manifest-${randomUUID()}`;
  const child = spawn("/bin/sh", ["-c", command], {
    argv0: processIdentity,
    cwd: repositoryRoot,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.processIdentity = processIdentity;
  return child;
}

function readProcessCommand(pid) {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "command="],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EDEN_BEARER_SECRET: undefined,
        },
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        const command = String(stdout).trim();
        resolve(command.length === 0 ? undefined : command);
      },
    );
  });
}

async function ownedServiceAlive(service) {
  if (service.exitCode !== null || service.pid === undefined) return false;
  const command = await readProcessCommand(service.pid);
  return command?.includes(service.processIdentity) === true;
}

function delay(milliseconds) {
  return delayTimer(milliseconds);
}

async function waitForHealth(command, env, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const result = await runShell(command, env);
    if (result.code === 0) return true;
    await delay(250);
  }
  return false;
}

async function waitForExit(child, timeout = 10_000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(timeout),
  ]);
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    const finish = (available) => {
      server.removeAllListeners();
      server.close(() => resolve(available));
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port }, () => finish(true));
  });
}

test("checks in isolated preview and production Wrangler targets for basic-agent", async () => {
  const config = JSON.parse(
    await readFile(
      join(repositoryRoot, "examples/basic-agent/wrangler.jsonc"),
      "utf8",
    ),
  );

  expect(config.main).toBe(".eden/agent-bundle.mjs");
  expect(config.compatibility_date).toBe("2026-04-01");
  expect(config.ai).toEqual({ binding: "AI" });
  expect(config.durable_objects).toEqual({
    bindings: [
      {
        name: "EDEN_SESSIONS",
        class_name: "EdenSession",
      },
    ],
  });

  const environments = [config.env?.preview, config.env?.production];
  expect(environments).toHaveLength(2);
  expect(config.env.preview.name).not.toBe(config.env.production.name);
  for (const environment of environments) {
    expect(environment.ai).toEqual({ binding: "AI" });
    expect(environment.durable_objects).toEqual(config.durable_objects);
    expect(environment.migrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: ["EdenSession"],
      },
    ]);
  }
});

test("executes the eden-local manifest lifecycle without disturbing a sentinel", async () => {
  const manifest = await readFile(missionManifestPath, "utf8");
  const commands = manifestCommands(manifest);
  expect(commands.start).toContain("packages/cli/dist/index.js dev");
  expect(commands.start).toContain("EDEN_PORT=8797");
  expect(commands.start).toContain("EDEN_INSPECTOR_PORT=9297");
  expect(commands.stop).toContain("stopEdenDev");
  expect(commands.healthcheck).toContain("printf");
  expect(commands.healthcheck).toContain("curl --config -");
  const secret = `manifest-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const env = {
    ...process.env,
    EDEN_BEARER_SECRET: secret,
  };
  const sentinel = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  const service = startShell(commands.start, env);
  let healthy = false;
  try {
    healthy = await waitForHealth(commands.healthcheck, env, service);
    expect(healthy).toBe(true);
    expect(sentinel.exitCode).toBeNull();

    const stopped = await runShell(commands.stop, env);
    expect(stopped.code).toBe(0);
    await waitForExit(service);
    expect(service.exitCode).not.toBeNull();
    await expect(portAvailable(8797)).resolves.toBe(true);
    await expect(portAvailable(9297)).resolves.toBe(true);
    expect(sentinel.exitCode).toBeNull();
  } finally {
    if (healthy || service.exitCode === null) {
      await runShell(commands.stop, env);
    }
    if (await ownedServiceAlive(service)) {
      if (process.platform !== "win32") {
        try {
          process.kill(-service.pid, "SIGTERM");
        } catch (error) {
          if (error?.code !== "ESRCH") service.kill("SIGKILL");
        }
      } else {
        service.kill("SIGTERM");
      }
      await waitForExit(service);
    }
    if (sentinel.exitCode === null) {
      sentinel.kill("SIGTERM");
      await waitForExit(sentinel);
    }
  }
}, 180_000);

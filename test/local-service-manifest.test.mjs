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
import {
  runOwnedProcess,
  ownedProcessReservationCount,
  ownedProcessReservationLabels,
  spawnOwnedProcess,
} from "./owned-process.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const missionManifestPath = process.env.EDEN_SERVICES_MANIFEST ??
  (process.env.FACTORY_RUNTIME_SETTINGS_PATH === undefined
    ? undefined
    : join(dirname(process.env.FACTORY_RUNTIME_SETTINGS_PATH), "services.yaml"));

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

function ownedShellArgs(command) {
  return [
    "-e",
    [
      'import { spawn } from "node:child_process";',
      `const child = spawn("/bin/sh", ["-c", ${JSON.stringify(command)}], { stdio: ["ignore", "inherit", "inherit"] });`,
      'child.once("error", () => { process.exitCode = 1; });',
      'child.once("exit", (code) => { process.exitCode = code ?? 1; });',
    ].join("\n"),
  ];
}

async function runShell(command, env) {
  const reservationsBefore = ownedProcessReservationCount();
  const result = await runOwnedProcess({
    file: process.execPath,
    args: ownedShellArgs(command),
    cwd: repositoryRoot,
    env,
    label: `manifest-command-${randomUUID()}`,
    timeoutMs: 60_000,
  });
  let cleanupRetry;
  let cleanupVerified = result.cleanupVerified;
  let cleanupFailure = result.cleanupFailure;
  let unresolvedCleanup = result.unresolvedCleanup;
  let ok = result.ok;
  if (result.unresolvedCleanup) {
    cleanupRetry = await result.retryCleanup();
    cleanupVerified = cleanupRetry.cleanupVerified;
    cleanupFailure = cleanupRetry.cleanupFailure;
    unresolvedCleanup = cleanupRetry.unresolvedCleanup;
    ok =
      result.code === 0 &&
      result.signal === null &&
      result.error === undefined &&
      !result.timedOut &&
      !result.aborted &&
      !result.outputLimitExceeded &&
      !result.stdoutTruncated &&
      !result.stderrTruncated &&
      cleanupVerified;
  }
  expect(
    ownedProcessReservationCount(),
    JSON.stringify(ownedProcessReservationLabels()),
  ).toBe(reservationsBefore);
  return {
    ...result,
    ok,
    code: ok ? 0 : result.code ?? 1,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    cleanupVerified,
    unresolvedCleanup,
    cleanupFailure,
    cleanupRetry,
    error: result.error?.message,
  };
}

function startShell(command, env) {
  const child = spawnOwnedProcess({
    file: process.execPath,
    args: ownedShellArgs(command),
    cwd: repositoryRoot,
    env,
    label: `manifest-${randomUUID()}`,
    stdio: ["ignore", "ignore", "ignore"],
  });
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
  if (service.exitCode !== null || service.signalCode !== null || service.pid === undefined) return false;
  const command = await readProcessCommand(service.pid);
  return command?.includes(service.processIdentity) === true;
}

function delay(milliseconds) {
  return delayTimer(milliseconds);
}

async function waitForHealth(command, env, child) {
  const identityReady = await child.identityReady;
  if (identityReady !== true) return false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const result = await runShell(command, env);
    if (result.code === 0) return true;
    await delay(250);
  }
  return false;
}

async function waitForExit(child, timeout = 10_000) {
  if (
    (child.exitCode !== null || child.signalCode !== null) &&
    child.closeObserved === true
  ) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
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

test("executes the authoritative eden-local manifest lifecycle without disturbing a sentinel", async () => {
  expect(
    missionManifestPath,
    "Authoritative local-service evidence requires EDEN_SERVICES_MANIFEST (or FACTORY_RUNTIME_SETTINGS_PATH pointing beside services.yaml).",
  ).toBeDefined();
  const manifest = await readFile(missionManifestPath, "utf8");
  const commands = manifestCommands(manifest);
  expect(commands.start).toContain("packages/cli/dist/index.js agent dev");
  expect(commands.start).toContain("EDEN_PORT=8797");
  expect(commands.start).toContain("EDEN_INSPECTOR_PORT=9297");
  expect(commands.stop).toContain("stopEdenDev");
  expect(commands.stop).toContain("env -u EDEN_BEARER_SECRET");
  expect(commands.healthcheck).toContain("printf");
  expect(commands.healthcheck).toContain("curl --config -");
  const secret = `manifest-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const env = {
    ...process.env,
    EDEN_BEARER_SECRET: secret,
  };
  const stopEnv = {
    ...env,
    EDEN_BEARER_SECRET: undefined,
  };
  const sentinel = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  const service = startShell(commands.start, env);
  let healthy = false;
  try {
    await expect(service.identityReady).resolves.toBe(true);
    healthy = await waitForHealth(commands.healthcheck, env, service);
    expect(healthy).toBe(true);
    expect(sentinel.exitCode).toBeNull();

    const stopped = await runShell(commands.stop, stopEnv);
    expect(
      stopped.ok,
      `${stopped.stderr || stopped.stdout} error=${stopped.error ?? "none"} signal=${stopped.signal ?? "none"} cleanup=${stopped.cleanupVerified} cleanupFailure=${stopped.cleanupFailure ?? "none"} outputLimitExceeded=${stopped.outputLimitExceeded}`,
    ).toBe(true);
    const [ownedTerminationVerified, duplicateTerminationVerified] =
      await Promise.all([service.terminateOwned(), service.terminateOwned()]);
    expect(ownedTerminationVerified).toBe(true);
    expect(duplicateTerminationVerified).toBe(true);
    await waitForExit(service);
    expect(service.exitCode !== null || service.signalCode !== null).toBe(true);
    await expect(ownedServiceAlive(service)).resolves.toBe(false);
    expect(
      ownedProcessReservationCount(),
      JSON.stringify(ownedProcessReservationLabels()),
    ).toBe(0);
    await expect(portAvailable(8797)).resolves.toBe(true);
    await expect(portAvailable(9297)).resolves.toBe(true);
    expect(sentinel.exitCode).toBeNull();
  } finally {
    if (
      healthy ||
      (service.exitCode === null && service.signalCode === null)
    ) {
      await runShell(commands.stop, stopEnv);
    }
    await service.terminateOwned();
    await waitForExit(service);
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      sentinel.kill("SIGTERM");
      await waitForExit(sentinel);
    }
  }
}, 180_000);

test(
  "repeats the authoritative manifest lifecycle without retaining reservations",
  async () => {
    expect(
      missionManifestPath,
      "Authoritative local-service evidence requires EDEN_SERVICES_MANIFEST (or FACTORY_RUNTIME_SETTINGS_PATH pointing beside services.yaml).",
    ).toBeDefined();
    const manifest = await readFile(missionManifestPath, "utf8");
    const commands = manifestCommands(manifest);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const secret = `manifest-repeat-${Date.now()}-${cycle}-${Math.random().toString(16).slice(2)}`;
      const env = {
        ...process.env,
        EDEN_BEARER_SECRET: secret,
      };
      const stopEnv = {
        ...env,
        EDEN_BEARER_SECRET: undefined,
      };
      const service = startShell(commands.start, env);
      try {
        await expect(service.identityReady).resolves.toBe(true);
        await expect(waitForHealth(commands.healthcheck, env, service)).resolves.toBe(
          true,
        );
        const stopped = await runShell(commands.stop, stopEnv);
        expect(
          stopped.ok,
          `${stopped.stderr || stopped.stdout} error=${stopped.error ?? "none"} signal=${stopped.signal ?? "none"} cleanup=${stopped.cleanupVerified} cleanupFailure=${stopped.cleanupFailure ?? "none"}`,
        ).toBe(true);
        await expect(service.terminateOwned()).resolves.toBe(true);
        await waitForExit(service);
        expect(service.exitCode !== null || service.signalCode !== null).toBe(
          true,
        );
        expect(ownedProcessReservationCount()).toBe(0);
        await expect(portAvailable(8797)).resolves.toBe(true);
        await expect(portAvailable(9297)).resolves.toBe(true);
      } finally {
        if (service.exitCode === null && service.signalCode === null) {
          await runShell(commands.stop, stopEnv);
        }
        await service.terminateOwned();
        await waitForExit(service);
        expect(
          ownedProcessReservationCount(),
          JSON.stringify(ownedProcessReservationLabels()),
        ).toBe(0);
      }
    }
  },
  180_000,
);

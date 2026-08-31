/* global console, fetch, process, setTimeout */

import { accessSync, constants as fsConstants } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runOwnedProcess,
  spawnOwnedProcess,
} from "../../test/owned-process.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "minimal");
const authToken = "eden-eve-compatibility-local";
const childEnvironment = {
  ...process.env,
  EVE_COMPAT_AUTH_TOKEN: authToken,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return name;
}

const corepack = resolveExecutable("corepack");

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object", "Could not reserve a local port.");
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  return port;
}

async function run(args, label, timeoutMs = 600_000, env = childEnvironment) {
  const result = await runOwnedProcess({
    file: process.execPath,
    args: [corepack, "pnpm", "--ignore-workspace", ...args],
    cwd: root,
    env,
    timeoutMs,
    label,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!result.ok) {
    throw new Error([
      `${label} failed.`,
      result.stdout,
      result.stderr,
      result.cleanupVerified ? "" : `Cleanup: ${result.cleanupFailure}`,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 60_000;
  let lastFailure = "not reachable";
  while (Date.now() < deadline) {
    assert(child.exitCode === null, `Eve exited before becoming healthy (${child.exitCode}).`);
    try {
      const response = await fetch(`${origin}/eve/v1/health`);
      const body = await response.json();
      if (
        response.ok &&
        body !== null &&
        typeof body === "object" &&
        body.ok === true &&
        body.status === "ready" &&
        typeof body.workflowId === "string" &&
        body.workflowId.length > 0
      ) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Eve health did not become ready: ${lastFailure}`);
}

async function assertAuth(origin) {
  const unauthenticated = await fetch(`${origin}/eve/v1/info`);
  assert(
    unauthenticated.status === 401,
    `Expected unauthenticated info to return 401, got ${unauthenticated.status}.`,
  );

  const authenticated = await fetch(`${origin}/eve/v1/info`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
  assert(
    authenticated.ok,
    `Expected authenticated info to succeed, got ${authenticated.status}.`,
  );
  const body = await authenticated.json();
  assert(
    body !== null && typeof body === "object" && body.version === 4,
    "Authenticated info did not return the Eve agent-info v4 contract.",
  );
}

await run(
  ["install", "--frozen-lockfile"],
  "eve-compat-install",
);
await run(["run", "typecheck"], "eve-compat-typecheck");
await run(["run", "build"], "eve-compat-build");

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const serverOutput = [];
const eve = spawnOwnedProcess({
  file: process.execPath,
  args: [
    corepack,
    "pnpm",
    "--ignore-workspace",
    "exec",
    "eve",
    "start",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  cwd: root,
  env: childEnvironment,
  label: "eve-compat-server",
  stdio: ["ignore", "pipe", "pipe"],
});
eve.stdout?.on("data", (chunk) => serverOutput.push(String(chunk)));
eve.stderr?.on("data", (chunk) => serverOutput.push(String(chunk)));

let failure;
try {
  assert(await eve.awaitIdentity(), "Could not establish Eve server process ownership.");
  await waitForHealth(origin, eve);
  await assertAuth(origin);

  if (process.env.AI_GATEWAY_API_KEY === undefined) {
    console.log("Eve 0.47.3 build, production boot, health, and bearer auth passed.");
    console.log("Model/tool eval skipped: AI_GATEWAY_API_KEY is not set.");
  } else {
    await run(
      ["exec", "eve", "eval", "--strict", "--url", origin],
      "eve-compat-eval",
      300_000,
      {
        ...childEnvironment,
        EVE_EVAL_AUTH_TOKEN: authToken,
      },
    );
    console.log("Eve 0.47.3 build, production boot, auth, and model/tool eval passed.");
  }
} catch (error) {
  failure = error;
} finally {
  const cleaned = await eve.terminateOwned();
  if (!cleaned && failure === undefined) {
    failure = new Error("Eve server cleanup could not be verified.");
  }
}

if (failure !== undefined) {
  const output = serverOutput.join("").slice(-16_384);
  throw new Error([
    failure instanceof Error ? failure.message : String(failure),
    output.length === 0 ? "" : `Eve output:\n${output}`,
  ].filter(Boolean).join("\n"));
}

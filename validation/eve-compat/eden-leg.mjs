/* global console, fetch, process, setTimeout */

// The Eden leg of the compatibility gate. For one pinned fixture it prepares
// the project the way skills/eden/SKILL.md tells a user to, with the
// Cloudflare World packed from this workspace, runs the locally built
// "eden preflight" on it, then starts a session in the image Eden builds.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturesRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixturesRoot, "..", "..");
const worldRoot = join(repositoryRoot, "packages", "world-cloudflare");
const worldName = "@moinulmoin/eden-world-cloudflare";
const worldInImage = "/workspace/node_modules/" + worldName;
const worldPort = 8789;
const authToken = "eden-eve-compatibility-local";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function command(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024, ...options });
  } catch (error) {
    throw new Error([
      file + " " + args.join(" ") + " failed.",
      error.stdout,
      error.stderr,
    ].filter(Boolean).join("\n"));
  }
}

const docker = (...args) => command("docker", args);
const pnpm = (cwd, ...args) => command("corepack", ["pnpm", ...args], { cwd });

/**
 * Eden installs a project from its lockfile inside a Docker build, so the
 * workspace World has to come from a URL that build can reach: the host's
 * loopback through OrbStack or Docker Desktop on macOS, the bridge gateway on
 * Linux.
 */
async function serveWorldTarball(directory) {
  await pnpm(worldRoot, "pack", "--pack-destination", directory);
  const [tarball] = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
  assert(tarball !== undefined, "pnpm pack did not write the Cloudflare World tarball.");
  const bytes = readFileSync(join(directory, tarball));
  const linux = process.platform === "linux";
  const bind = linux
    ? (await docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}")).stdout.trim()
    : "127.0.0.1";
  assert(bind.length > 0, "Could not read the Docker bridge gateway address.");
  const server = createServer((request, response) => {
    if (request.url !== "/" + tarball) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, bind, resolvePromise);
  });
  const { port } = server.address();
  return {
    // pnpm writes the lockfile on the host; Eden's build reads it in Docker.
    hostUrl: "http://" + bind + ":" + port + "/" + tarball,
    dockerUrl: "http://" + (linux ? bind : "host.docker.internal") + ":" + port + "/" + tarball,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

function prepareProject(fixture, project) {
  cpSync(join(fixturesRoot, fixture), project, {
    recursive: true,
    filter: (source) => ![".eden", ".eve", ".output", "node_modules"].includes(basename(source)),
  });
  const agentPath = join(project, "agent", "agent.ts");
  const agent = readFileSync(agentPath, "utf8");
  assert(agent.includes('"@workflow/world-postgres"'), fixture + ": agent/agent.ts does not select the Postgres World.");
  writeFileSync(agentPath, agent.replace('"@workflow/world-postgres"', JSON.stringify(worldName)));
}

async function installWorld(project, tarball) {
  const manifestPath = join(project, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.dependencies["@workflow/world-postgres"];
  delete manifest.dependencies.pg;
  manifest.dependencies[worldName] = tarball.hostUrl;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await pnpm(project, "install", "--lockfile-only");
  for (const path of [manifestPath, join(project, "pnpm-lock.yaml")]) {
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(tarball.hostUrl, tarball.dockerUrl));
  }
}

async function preflight(cli, fixture, project, envFile) {
  const output = [];
  await cli.runEdenCli(
    ["preflight", "--project", project, "--env-file", envFile, "--json"],
    {
      stdout: (line) => output.push(line),
      eveControlPlane: {
        // CI has no Cloudflare account. Preflight reports the two Cloudflare
        // checks as not passed; every other check has to pass.
        cloudflareRead: () => ({
          accountAccess: "unavailable",
          containerAccess: "unavailable",
          target: { state: "ambiguous" },
        }),
      },
    },
  );
  assert(output.length === 1, fixture + ": eden preflight --json printed " + output.length + " objects, expected one.");
  const result = JSON.parse(output[0]);
  const status = new Map(result.checks.map((check) => [check.id, check.status]));
  for (const check of result.checks) console.log("  " + check.status.padEnd(7) + " " + check.id);
  const failure = (message) => new Error(fixture + ": " + message + "\n" + JSON.stringify(result, null, 2));
  for (const id of ["001", "002", "003", "004", "005", "006", "007"].map((n) => "VAL-BUILD-" + n)) {
    if (status.get(id) !== "passed") throw failure("eden preflight did not pass " + id + ".");
  }
  if (status.get("EVE-WORLD") !== "passed") throw failure("eden preflight did not detect the Cloudflare World.");
  const unexpected = result.checks.filter((check) =>
    !check.id.startsWith("VAL-CLI-007-") && check.status !== "passed");
  if (unexpected.length > 0) throw failure("eden preflight checks did not pass: " + unexpected.map((check) => check.id).join(", ") + ".");
  const warnings = result.warnings.filter((warning) => warning.id !== "EVE_AI_GATEWAY_KEY_MISSING");
  if (warnings.length > 0) throw failure("eden preflight warned: " + warnings.map((warning) => warning.id).join(", ") + ".");
}

async function waitForHealth(origin, container) {
  const deadline = Date.now() + 120_000;
  let lastFailure = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin + "/eve/v1/health");
      const body = await response.json();
      if (response.ok && body?.ok === true && body.status === "ready") return;
      lastFailure = "HTTP " + response.status;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    const running = (await docker("inspect", container, "--format", "{{.State.Running}}")).stdout.trim();
    assert(running === "true", "The Eve container exited before becoming healthy.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Eve health in Eden's image did not become ready: " + lastFailure);
}

async function admitSession(fixture, image) {
  const container = "eden-compat-" + fixture + "-" + process.pid;
  await docker(
    "create", "--name", container,
    "--publish", "127.0.0.1::8080",
    "--env", "EVE_COMPAT_AUTH_TOKEN=" + authToken,
    "--env", "EDEN_WORLD_URL=http://127.0.0.1:" + worldPort + "/__eden/world/rpc",
    "--env", "EDEN_EVE_DEPLOYMENT_ID=eden-compat",
    "--env", "EDEN_EVE_RELEASE_ID=eden-compat",
    "--env", "CBOR_NATIVE_ACCELERATION_DISABLED=true",
    image,
  );
  try {
    // The image holds the World package but not its test server, which runs
    // the installed World core the way Eden's Durable Object does.
    await docker("start", container);
    await docker("exec", container, "mkdir", worldInImage + "/test");
    await docker("cp", join(worldRoot, "test", "server.mjs"), container + ":" + worldInImage + "/test/server.mjs");
    await docker(
      "exec", "--detach",
      "--env", "EDEN_WORLD_PORT=" + worldPort,
      "--env", "EDEN_WORLD_DELIVERY_ORIGIN=http://127.0.0.1:8080",
      container, "node", worldInImage + "/test/server.mjs",
    );
    await docker(
      "exec", container, "node", "-e",
      "const probe = (left) => fetch('http://127.0.0.1:" + worldPort + "/').then(() => process.exit(0), () => left === 0 ? process.exit(1) : setTimeout(probe, 250, left - 1)); probe(120);",
    );
    const address = (await docker("port", container, "8080/tcp")).stdout.trim().split("\n")[0];
    const origin = "http://" + address;
    await waitForHealth(origin, container);
    const unauthenticated = await fetch(origin + "/eve/v1/session", { method: "POST" });
    assert(unauthenticated.status === 401,
      "Expected unauthenticated session create to return 401, got " + unauthenticated.status + ".");
    const authenticated = await fetch(origin + "/eve/v1/session", {
      method: "POST",
      headers: { authorization: "Bearer " + authToken },
    });
    const text = await authenticated.text();
    assert(authenticated.status === 202, "Session admission failed: HTTP " + authenticated.status + ": " + text);
    const body = JSON.parse(text);
    assert(typeof body.sessionId === "string" && body.sessionId.startsWith("wrun_"),
      "Session admission did not return a wrun_ sessionId: " + text);
    console.log("Bodyless session admission: HTTP 202 " + body.sessionId);
  } catch (error) {
    const logs = await execFileAsync("docker", ["logs", "--tail", "200", container])
      .then((result) => result.stdout + result.stderr, () => "");
    throw new Error([
      error instanceof Error ? error.message : String(error),
      logs.length === 0 ? "" : "Eve output:\n" + logs.slice(-16_384),
    ].filter(Boolean).join("\n"));
  } finally {
    await docker("rm", "--force", "--volumes", container);
  }
}

export async function runEdenLeg(fixture) {
  const cliEntry = join(repositoryRoot, "packages", "cli", "dist", "index.js");
  assert(
    existsSync(cliEntry) && existsSync(join(worldRoot, "dist", "core", "index.js")),
    "Run pnpm run build first: the Eden leg tests the built CLI and Cloudflare World.",
  );
  const cli = await import(pathToFileURL(cliEntry).href);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "eden-compat-")));
  const project = join(scratch, "project");
  const envFile = join(scratch, "runtime.env");
  let tarball;
  let packaging;
  let image;
  const builder = cli.createDockerEveProjectBuilder({ nodeImage: cli.DEFAULT_EVE_NODE_IMAGE });
  try {
    tarball = await serveWorldTarball(scratch);
    prepareProject(fixture, project);
    await installWorld(project, tarball);
    writeFileSync(envFile, "EVE_COMPAT_AUTH_TOKEN=" + authToken + "\n", { mode: 0o600 });

    console.log(fixture + ": eden preflight with the workspace Cloudflare World");
    await preflight(cli, fixture, project, envFile);

    // Preflight removes the image it built. Build it again the same way, from
    // Docker's cache, and keep it for the session.
    packaging = await cli.buildEveProjectSnapshot({
      projectRoot: project,
      artifactRoot: join(project, ".eden", "eve-deploy", "generations", "compat-" + randomUUID()),
      builder,
      nodeImage: cli.DEFAULT_EVE_NODE_IMAGE,
    });
    assert(packaging.deployable && packaging.candidate !== null,
      fixture + ": Eden could not package the project again: " + JSON.stringify(packaging.error ?? packaging.checks));
    image = await cli.buildEveRuntimeImage({
      candidate: packaging.candidate,
      nodeImage: cli.DEFAULT_EVE_NODE_IMAGE,
      hostRequirements: cli.DEFAULT_EVE_HOST_REQUIREMENTS,
      workflowWorld: worldName,
      retainImage: true,
    });
    assert(image.deployable && image.image !== null,
      fixture + ": Eden could not build its runtime image again: " + JSON.stringify(image.error ?? image.checks));

    await admitSession(fixture, image.image.imageId);
    console.log(fixture + ": Eve " + packaging.candidate.eveVersion + " passed eden preflight build and boot checks, and admitted a session in Eden's linux/amd64 image on the workspace Cloudflare World.");
  } finally {
    await tarball?.close();
    if (image?.image != null) {
      const removed = await cli.discardEveRuntimeImage({
        imageId: image.image.imageId,
        generationId: packaging.candidate.generationId,
        generationRoot: packaging.candidate.generationRoot,
      });
      if (!removed) console.error(fixture + ": could not remove Eden's runtime image " + image.image.imageId);
    }
    if (packaging?.image?.imageReference != null) {
      await builder.discard({ imageReference: packaging.image.imageReference }).catch((error) => {
        console.error(fixture + ": could not remove Eden's build image: " + error.message);
      });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

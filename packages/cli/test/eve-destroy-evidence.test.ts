import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type * as Https from "node:https";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runEdenCli } from "../src/index.js";

/**
 * A stand-in for Cloudflare behind Eden's default destroy reader: Wrangler
 * (whoami, the registry credential, the deletes), the Cloudflare API
 * (Container applications, the Worker's deployments and settings), and the
 * registry. Resources live per account, so a read under another account
 * does not see them.
 */
const cloud = vi.hoisted(() => {
  type WorkerFailure = {
    /** What "wrangler deployments list" prints on stderr before it exits 1. */
    readonly stderr: string;
    /** What the API answers for the Worker: no answer, or a status and body. */
    readonly api: "network" | { readonly status: number; readonly body: string; readonly redirected?: boolean };
  };
  const state = {
    active: false,
    /** The account "wrangler whoami" names on its nth call, from 0. */
    whoami: (() => "account-test") as (nth: number) => string,
    whoamiCalls: 0,
    /** The account Wrangler's own commands act on: the one whoami named last. */
    wranglerAccount: "account-test",
    workers: new Set<string>(),
    containers: new Set<string>(),
    tags: [] as string[],
    workerFailure: undefined as WorkerFailure | undefined,
    /** Called before each read of the Worker, with the read's number from 0. */
    onWorkerRead: (() => undefined) as (nth: number) => unknown,
    workerReads: 0,
    /** How many deployments the API lists for a Worker that exists. */
    deployments: 1,
    /** When set, the deployments the API lists, whatever they are. */
    deploymentEntries: undefined as readonly unknown[] | undefined,
    /** When set, the API's whole answer to the Container applications read, given its true entries. */
    containerAnswer: undefined as ((entries: string) => string) | undefined,
    /** The status of the API's answer to the Container applications read. */
    containerStatus: 200,
    /** When set, the body of the API's 200 answer about a Worker that exists. */
    workerAnswer: undefined as ((deployments: string) => string) | undefined,
    /** The plain-text bindings of the Worker: what the last publish stamped. */
    stamps: [] as { readonly type: string; readonly name: string; readonly text: string }[],
    /** Called before each Wrangler command that changes the account. */
    onMutation: (() => undefined) as () => void,
    apiAccounts: [] as string[],
    /** CLOUDFLARE_ACCOUNT_ID as each changing Wrangler command received it. */
    pinned: [] as (string | undefined)[],
    /** The registry repositories whose listing was asked for. */
    listed: new Set<string>(),
    deleted: [] as string[],
  };
  return state;
});

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof Https>();
  return {
    ...actual,
    request: ((options: Https.RequestOptions, onResponse: (response: EventEmitter) => void) => {
      if (!cloud.active) return actual.request(options, onResponse as Parameters<typeof actual.request>[1]);
      const url = new URL(String(options.path), "https://registry.cloudflare.com");
      const [, , account = "", repository = ""] = url.pathname.split("/");
      cloud.listed.add(repository);
      const request = Object.assign(new EventEmitter(), {
        destroy: () => undefined,
        end: () => setImmediate(() => {
          const last = url.searchParams.get("last");
          const tags = cloud.tags.filter((tag) => last === null || tag > last);
          // The registry's own form: the request's URL, then a second query naming the cursor.
          const link = "https://registry.cloudflare.com" + String(options.path) + "?n=1000&last=" + (tags.at(-1) ?? "") + "; rel=next";
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { link } });
          onResponse(response);
          response.emit("data", Buffer.from(JSON.stringify({ name: account + "/" + repository, tags })));
          response.emit("end");
          response.emit("close");
        }),
      });
      return request;
    }) as unknown as typeof actual.request,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const execFile = ((...execArgs: Parameters<typeof actual.execFile>) =>
    actual.execFile(...execArgs)) as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: async (file: string, argv: readonly string[], options: object) => {
      if (!cloud.active || !/wrangler/u.test(argv[0] ?? "")) {
        return promisify(actual.execFile)(file, argv, options);
      }
      const args = argv.slice(1);
      if (args[0] === "whoami") {
        cloud.wranglerAccount = cloud.whoami(cloud.whoamiCalls++);
        return { stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: cloud.wranglerAccount }] }), stderr: "" };
      }
      if (args[0] === "deployments" && args[1] === "list") {
        await cloud.onWorkerRead(cloud.workerReads++);
        if (cloud.workerFailure !== undefined) {
          throw Object.assign(new Error("Wrangler failed."), { stderr: cloud.workerFailure.stderr });
        }
        if (cloud.workers.has(cloud.wranglerAccount + "/" + args[3])) {
          return { stdout: JSON.stringify([{ id: "deployment-1" }]), stderr: "" };
        }
        // Wrangler 4.147.0's answer for a Worker that does not exist, read on 2026-11-19.
        throw Object.assign(new Error("Wrangler failed."), {
          stderr: "\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mA request to the Cloudflare API (/accounts/" +
            cloud.wranglerAccount + "/workers/scripts/" + args[3] + "/deployments) failed.\u001b[0m\n\n  This Worker does not exist on your account. [code: 10007]\n",
        });
      }
      if (args[1] === "registries" && args[2] === "credentials") {
        return {
          stdout: JSON.stringify({
            account_id: "account-test",
            registry_host: "registry.cloudflare.com",
            username: "v1",
            password: "registry-password",
          }),
          stderr: "",
        };
      }
      if (args[0] === "containers" && args[1] === "info") {
        return {
          stdout: JSON.stringify({ scheduling_policy: "durable_object", durable_objects: { namespace_id: "namespace-test" } }),
          stderr: "",
        };
      }
      throw new Error("Unexpected Wrangler call: " + args.join(" "));
    },
  });
  return {
    ...actual,
    execFile,
    spawn: ((...spawnArgs: Parameters<typeof actual.spawn>) => {
      if (!cloud.active) return actual.spawn(...spawnArgs);
      const args = (spawnArgs[1] as readonly string[]).slice(1);
      cloud.onMutation();
      // Wrangler acts on CLOUDFLARE_ACCOUNT_ID when it is set, else on its login's account.
      const pinned = (spawnArgs[2] as { readonly env?: NodeJS.ProcessEnv }).env?.CLOUDFLARE_ACCOUNT_ID;
      cloud.pinned.push(pinned);
      const account = pinned || cloud.wranglerAccount;
      let exitCode = 1;
      if (args[0] === "deploy") {
        // What Wrangler would publish: the plain-text vars of the config Eden wrote.
        const config = JSON.parse(readFileSync(args[2] ?? "", "utf8")) as { readonly vars?: Readonly<Record<string, unknown>> };
        cloud.stamps = Object.entries(config.vars ?? {}).flatMap(([name, text]) =>
          typeof text === "string" ? [{ type: "plain_text", name, text }] : []
        );
        cloud.workers.add(account + "/" + args[4]);
        cloud.containers.add(account + "/" + args[4] + "-container#container-new");
        exitCode = 0;
      } else if (args[0] === "delete" && args[1] === "--name") {
        exitCode = cloud.workers.delete(account + "/" + args[2]) ? 0 : 1;
        if (exitCode === 0) cloud.deleted.push("worker:" + account + "/" + args[2]);
      } else if (args[0] === "containers" && args[1] === "delete") {
        for (const entry of [...cloud.containers]) {
          if (entry.endsWith("#" + args[2])) {
            cloud.containers.delete(entry);
            cloud.deleted.push("container:" + entry);
            exitCode = 0;
          }
        }
      } else if (args[0] === "containers" && args[1] === "images" && args[2] === "delete") {
        const tag = (args[3] ?? "").split(":")[1] ?? "";
        cloud.tags = cloud.tags.filter((present) => present !== tag);
        cloud.deleted.push("image:" + args[3]);
        exitCode = 0;
      }
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { end: () => undefined },
        kill: () => true,
      });
      setImmediate(() => child.emit("close", exitCode));
      return child;
    }) as unknown as typeof actual.spawn,
  };
});

const json = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

async function cloudflareApi(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const [, , , , account = "", ...rest] = url.pathname.split("/");
  cloud.apiAccounts.push(account);
  if (rest.join("/") === "containers/applications") {
    const name = url.searchParams.get("name");
    const entries = [...cloud.containers].flatMap((entry) => {
      const [owner, rest2 = ""] = entry.split("/");
      const [application, id] = rest2.split("#");
      return owner === account && application === name ? [{ id, name: application }] : [];
    });
    return json(cloud.containerStatus, cloud.containerAnswer?.(JSON.stringify(entries)) ??
      { success: true, errors: [], messages: [], result: entries, result_info: {} });
  }
  if (rest[0] === "workers" && rest[1] === "scripts" && rest[3] === "deployments") {
    await cloud.onWorkerRead(cloud.workerReads++);
    if (cloud.workerFailure?.api === "network") throw new TypeError("fetch failed");
    if (cloud.workerFailure !== undefined) {
      const answer = json(cloud.workerFailure.api.status, cloud.workerFailure.api.body);
      if (!cloud.workerFailure.api.redirected) return answer;
      // What fetch does with a redirect: refuse it when asked to, else return the page it led to.
      if (init?.redirect === "error") throw new TypeError("fetch failed");
      Object.defineProperty(answer, "redirected", { value: true });
      return answer;
    }
    if (cloud.workers.has(account + "/" + rest[2])) {
      const deployments = cloud.deploymentEntries ??
        Array.from({ length: cloud.deployments }, (_, nth) => ({ id: "deployment-" + nth }));
      return json(200, cloud.workerAnswer?.(JSON.stringify(deployments)) ??
        { success: true, errors: [], messages: [], result: { deployments } });
    }
  }
  if (rest[0] === "workers" && rest[1] === "scripts" && rest[3] === "settings" && cloud.workers.has(account + "/" + rest[2])) {
    return json(200, {
      success: true,
      result: {
        bindings: [
          ...cloud.stamps,
          { type: "durable_object_namespace", name: "EVE_CONTAINER", namespace_id: "namespace-test" },
        ],
      },
    });
  }
  // The API's answer for a Worker that does not exist, read on 2026-11-19.
  return json(404, {
    result: null,
    success: false,
    errors: [{ code: 10007, message: "This Worker does not exist on your account." }],
    messages: [],
  });
}

const roots: string[] = [];
const targetKey = "preview-eve-destroy-fixture-" + createHash("sha256")
  .update("proj\naccount-test\npreview\neve-destroy-fixture", "utf8").digest("hex").slice(0, 24);
const repository = "eden-eve-" + targetKey + "-gen-destroy-1";

/** A project with one deployed generation and CURRENT pointing at it. */
async function deployedProject(generation = "gen-destroy-1"): Promise<{
  readonly root: string;
  readonly targetRoot: string;
  readonly current: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eden-moi242-")));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "eve-destroy-fixture", private: true }), "utf8");
  const targetRoot = join(root, ".eden", "eve-deploy", "targets", "preview-eve-destroy-fixture");
  await mkdir(targetRoot, { recursive: true });
  await addGeneration(root, generation);
  await symlink(relative(targetRoot, join(root, ".eden", "eve-deploy", "generations", generation)), join(targetRoot, "CURRENT"));
  return { root, targetRoot, current: join(targetRoot, "CURRENT") };
}

async function addGeneration(root: string, generation: string): Promise<string> {
  const generationRoot = join(root, ".eden", "eve-deploy", "generations", generation);
  await mkdir(generationRoot, { recursive: true });
  await writeFile(
    join(generationRoot, "deployment.json"),
    JSON.stringify({
      version: 1,
      status: "deployed",
      identity: {
        projectId: "proj",
        sourceDigest: "sha256:" + "a".repeat(64),
        generationId: generation,
        deploymentId: "eve-deploy-test",
        environment: "preview",
        name: "eve-destroy-fixture",
        accountId: "account-test",
        workersDevSubdomain: "account",
        stableWorkersDevOrigin: "https://eve-destroy-fixture.account.workers.dev",
        workerName: "eve-destroy-fixture",
        containerApplicationName: "eve-destroy-fixture-container",
        stableContainerInstanceName: "eve-destroy-fixture-instance",
        containerImage: "registry.cloudflare.com/account-test/eden-eve-" + targetKey + "-" + generation + "@sha256:" + "b".repeat(64),
        runtimeVariableNames: [],
      },
    }),
    "utf8",
  );
  return generationRoot;
}

async function destroy(
  root: string,
  eveControlPlane?: NonNullable<Parameters<typeof runEdenCli>[1]>["eveControlPlane"],
): Promise<{ readonly exitCode: number; readonly result: Record<string, unknown> & { readonly error?: { readonly code?: string; readonly remediation?: string } } }> {
  const output: string[] = [];
  const exitCode = await runEdenCli(
    ["destroy", "--project", root, "--env", "preview", "--name", "eve-destroy-fixture", "--json"],
    { cwd: root, stdout: (line) => output.push(line), stderr: (line) => output.push(line), ...(eveControlPlane === undefined ? {} : { eveControlPlane }) },
  );
  expect(output).toHaveLength(1);
  return { exitCode, result: JSON.parse(output[0] ?? "") as Record<string, unknown> };
}

const worker = "account-test/eve-destroy-fixture";
const container = "account-test/eve-destroy-fixture-container#container-123";

beforeEach(() => {
  Object.assign(cloud, {
    active: true,
    whoami: () => "account-test",
    whoamiCalls: 0,
    wranglerAccount: "account-test",
    workers: new Set<string>(),
    containers: new Set<string>(),
    tags: [],
    workerFailure: undefined,
    onWorkerRead: () => undefined,
    workerReads: 0,
    deployments: 1,
    deploymentEntries: undefined,
    containerAnswer: undefined,
    containerStatus: 200,
    workerAnswer: undefined,
    stamps: [{ type: "plain_text", name: "EDEN_EVE_DEPLOYMENT_ID", text: "eve-deploy-test" }],
    onMutation: () => undefined,
    apiAccounts: [],
    pinned: [],
    listed: new Set<string>(),
    deleted: [],
  });
  // Keeps the reader away from this machine's Wrangler login.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubGlobal("fetch", cloudflareApi);
});

afterEach(async () => {
  cloud.active = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Failed Worker lookups. The stderr texts marked "captured" are Wrangler 4.147.0's own, read on 2026-11-19. */
const failures = {
  "a missing Wrangler configuration file": {
    stderr: "✘ [ERROR] Wrangler configuration file not found",
    api: { status: 200, body: "not json" },
  },
  "an authentication error on an account whose id contains 10007 (captured form)": {
    stderr: "✘ [ERROR] A request to the Cloudflare API (/accounts/ab10007cdef0123456789abcdef01234/workers/scripts/eve-destroy-fixture/deployments) failed.\n\n  Authentication error [code: 10000]\n",
    api: { status: 403, body: JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null }) },
  },
  "a gateway's 404 Not Found page": {
    stderr: "✘ [ERROR] Received a malformed response from the API\n\n  <html><head><title>404 Not Found</title></head></html>\n",
    api: { status: 404, body: "<html><head><title>404 Not Found</title></head></html>" },
  },
  "a server error that mentions a missing resource": {
    stderr: "✘ [ERROR] A request to the Cloudflare API failed.\n\n  upstream does not exist [code: 10013]\n",
    api: { status: 502, body: JSON.stringify({ success: false, errors: [{ code: 10013, message: "upstream does not exist" }], messages: [], result: null }) },
  },
  "a network failure (captured)": {
    stderr: "▲ [WARNING] A fetch request failed, likely due to a connectivity issue.\n\n✘ [ERROR] fetch failed\n",
    api: "network",
  },
  "an authentication error (captured)": {
    stderr: "✘ [ERROR] A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/workers/scripts/eve-destroy-fixture/deployments) failed.\n\n  Authentication error [code: 10000]\n",
    api: { status: 403, body: JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null }) },
  },
  "a 404 with another error code": {
    stderr: "✘ [ERROR] A request to the Cloudflare API failed.\n\n  No route for that URI [code: 10404]\n",
    api: { status: 404, body: JSON.stringify({ success: false, errors: [{ code: 10404, message: "No route for that URI" }], messages: [], result: null }) },
  },
  "code 10007 on a status other than 404": {
    stderr: "✘ [ERROR] A request to the Cloudflare API failed.\n\n  Bad gateway [code: 10007]\n",
    api: { status: 502, body: JSON.stringify({ success: false, errors: [{ code: 10007, message: "Bad gateway" }], messages: [], result: null }) },
  },
} as const;

const missingWorker = { code: 10007, message: "This Worker does not exist on your account." };
/** Answers that carry code 10007 and are still not the API's answer for a missing Worker. */
const contradictions = {
  "an error that names code 10000 and code 10007": {
    status: 404,
    body: '{"result":null,"success":false,"errors":[{"code":10000,"code":10007,"message":"Authentication error"}],"messages":[]}',
  },
  "a 10007 error beside a list of deployments": {
    status: 404,
    body: JSON.stringify({ result: { deployments: [{ id: "deployment-1" }] }, success: false, errors: [missingWorker], messages: [] }),
  },
  "a 10007 answer reached through a redirect": {
    status: 404,
    body: JSON.stringify({ result: null, success: false, errors: [missingWorker], messages: [] }),
    redirected: true,
  },
} as const;

/** A project that builds and boots, for a deploy whose publish step is Eden's own. */
async function deployableProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eden-moi242-")));
  roots.push(root);
  await mkdir(join(root, "agent"), { recursive: true });
  await writeFile(
    join(root, "agent/sandbox.ts"),
    "import { defineSandbox } from 'eve/sandbox';\nimport { JustBashSandbox } from 'eve/sandbox/just-bash';\nexport const environment = JustBashSandbox.environment();\nexport default defineSandbox(() => environment.open());\n",
    "utf8",
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "eve-deploy-fixture", private: true, packageManager: "pnpm@11.21.0" }), "utf8");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return root;
}

async function writeBuild(snapshotRoot: string): Promise<void> {
  const templateKey = "7bc778099a3b436ce4ad98ba";
  const files: Readonly<Record<string, string>> = {
    "node_modules/eve/package.json": JSON.stringify({ name: "eve", version: "0.91.0", bin: "bin/eve.js" }),
    "node_modules/eve/bin/eve.js": "#!/usr/bin/env node\n",
    ".output/server/index.mjs": "export default {};\n",
    [".eve/sandbox-cache/just-bash/templates/" + templateKey + "/metadata.json"]: JSON.stringify({ templateKey }),
    ".output/.eve/compile/sandbox-prepared-artifacts.json": JSON.stringify({
      entries: [{
        artifact: { templateRootPath: "/workspace/.eve/sandbox-cache/just-bash/templates/" + templateKey },
        nodeId: "__root__",
        providerName: "just-bash",
      }],
      kind: "eve-sandbox-prepared-artifacts",
      version: 2,
    }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(snapshotRoot, path, ".."), { recursive: true });
    await writeFile(join(snapshotRoot, path), content, { encoding: "utf8", mode: 0o755 });
  }
  await mkdir(join(snapshotRoot, ".eve/sandbox-cache/just-bash/templates", templateKey, "fs/workspace"), { recursive: true });
  await mkdir(join(snapshotRoot, "node_modules/.bin"), { recursive: true });
  await symlink("../eve/bin/eve.js", join(snapshotRoot, "node_modules/.bin/eve"));
}

/** A deploy that publishes through Eden's own Wrangler call and its own read afterwards. */
async function deploy(root: string, generationId = "generation-one"): Promise<{ readonly exitCode: number; readonly result: { readonly ok?: boolean; readonly error?: { readonly code?: string } } }> {
  const output: string[] = [];
  const imageDigest = "sha256:" + "d".repeat(64);
  const exitCode = await runEdenCli(
    ["deploy", "--project", root, "--env", "preview", "--name", "eve-deploy-fixture", "--json"],
    {
      cwd: root,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      eveControlPlane: {
        generationId,
        builder: { build: async (request) => { await writeBuild(request.snapshotRoot); return { eveVersion: "0.91.0" }; } },
        containerImageReference: "registry.cloudflare.com/account-test/eve@" + imageDigest,
        runtimeRunner: async () => ({
          ok: true,
          checks: ["VAL-BUILD-005", "VAL-BUILD-006", "VAL-BUILD-007"].map((id) => ({ id, status: "passed" as const, message: "Passed." })),
          imageDigest,
          cleanup: { bootContainerId: null, bootContainerRemoved: true, imageIdentity: "exact" as const, imageRetained: true, verified: true },
        }),
        cloudflareRead: async () => ({
          accountAccess: "available",
          containerAccess: "available",
          accountId: "account-test",
          workersDevSubdomain: "account",
          target: { state: "absent" },
        }),
        health: async (request) => ({ status: "ready", identity: request.identity }),
        discardRuntimeImage: async () => true,
      },
    },
  );
  return { exitCode, result: JSON.parse(output.at(-1) ?? "") as { readonly ok?: boolean; readonly error?: { readonly code?: string } } };
}

describe("eden destroy clears CURRENT only on strong evidence (MOI-242)", () => {
  test.each(Object.keys(failures) as (keyof typeof failures)[])(
    "a failed Worker lookup (%s) stops destroy and changes nothing",
    async (name) => {
      const { root, current } = await deployedProject();
      cloud.workers.add(worker);
      cloud.containers.add(container);
      cloud.tags = ["candidate"];
      cloud.workerFailure = failures[name];
      const before = await readlink(current);
      const { exitCode, result } = await destroy(root);
      expect({ exitCode, status: result.status, code: result.error?.code }).toEqual({
        exitCode: 1,
        status: "indeterminate",
        code: "EVE_DESTROY_INDETERMINATE",
      });
      expect(result.error?.remediation).toContain("rerun eden destroy");
      expect(cloud.deleted).toEqual([]);
      expect([...cloud.workers, ...cloud.containers, ...cloud.tags]).toEqual([worker, container, "candidate"]);
      await expect(readlink(current)).resolves.toBe(before);
    },
  );

  test.each(Object.keys(contradictions) as (keyof typeof contradictions)[])(
    "%s is not an absent Worker: destroy stops and changes nothing",
    async (name) => {
      const { root, current } = await deployedProject();
      cloud.workers.add(worker);
      cloud.containers.add(container);
      cloud.workerFailure = { stderr: "", api: contradictions[name] };
      const { exitCode, result } = await destroy(root);
      expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
      expect(cloud.deleted).toEqual([]);
      await expect(lstat(current)).resolves.toBeDefined();
    },
  );

  test("a Worker with no deployment still exists: destroy deletes it", async () => {
    const { root, current } = await deployedProject();
    cloud.workers.add(worker);
    cloud.containers.add(container);
    cloud.deployments = 0;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.deleted).toEqual(["worker:" + worker, "container:" + container]);
    await expect(lstat(current)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("every Wrangler delete is pinned to the recorded account, so a login that changes after the reads cannot move it", async () => {
    const { root } = await deployedProject();
    cloud.workers.add(worker).add("account-other/eve-destroy-fixture");
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.onMutation = () => { cloud.wranglerAccount = "account-other"; };
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.pinned).toEqual(["account-test", "account-test", "account-test"]);
    expect(cloud.deleted).toEqual(["worker:" + worker, "container:" + container, "image:" + repository + ":candidate"]);
    expect([...cloud.workers]).toEqual(["account-other/eve-destroy-fixture"]);
  });

  test("the API's own 10007 answer is an absent Worker: the rest is deleted and CURRENT is cleared", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.deleted).toEqual(["container:" + container, "image:" + repository + ":candidate"]);
    await expect(lstat(current)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a target with nothing left reports absent and keeps CURRENT", async () => {
    const { root, current } = await deployedProject();
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "absent" });
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("each read asks whoami once and sends every Cloudflare API read to that account", async () => {
    const { root } = await deployedProject();
    cloud.containers.add(container);
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    // Two reads: before the deletes and after them.
    expect(cloud.whoamiCalls).toBe(2);
    expect(cloud.apiAccounts).toEqual(Array(4).fill("account-test"));
  });

  test("a login that changes between whoami calls cannot move the Container read to another account", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.whoami = (nth) => nth % 2 === 0 ? "account-test" : "account-other";
    const { exitCode, result } = await destroy(root);
    // The first read sees the Container in the recorded account and deletes
    // it. The second whoami names another account: nothing is read there,
    // and absence is unproven.
    expect(cloud.deleted).toContain("container:" + container);
    expect(cloud.apiAccounts.every((account) => account === "account-test")).toBe(true);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a login for another account reads nothing and deletes nothing", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.whoami = () => "account-other";
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_OWNERSHIP_UNPROVEN" });
    expect({ api: cloud.apiAccounts, deleted: cloud.deleted }).toEqual({ api: [], deleted: [] });
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a CURRENT replaced while destroy runs is left in place", async () => {
    const { root, targetRoot, current } = await deployedProject();
    const replacement = await addGeneration(root, "gen-destroy-2");
    cloud.containers.add(container);
    // An actor outside the lock promotes another generation while destroy verifies absence.
    cloud.onWorkerRead = async (nth) => {
      if (nth !== 1) return;
      await rm(current);
      await symlink(relative(targetRoot, replacement), current);
    };
    const { exitCode, result } = await destroy(root);
    expect(cloud.workerReads).toBe(2);
    expect({ exitCode, status: result.status, code: result.error?.code }).toEqual({
      exitCode: 1,
      status: "failed",
      code: "EVE_DESTROY_POINTER_UNCLEARED",
    });
    expect(result.error?.remediation).toContain("rerun eden destroy");
    await expect(realpath(current)).resolves.toBe(replacement);
  });

  test("a CURRENT that appears while destroy runs is left in place", async () => {
    const { root, targetRoot, current } = await deployedProject();
    const generationRoot = await realpath(current);
    await rm(current);
    cloud.containers.add(container);
    cloud.onWorkerRead = async (nth) => {
      if (nth === 1) await symlink(relative(targetRoot, generationRoot), current);
    };
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_POINTER_UNCLEARED" });
    await expect(realpath(current)).resolves.toBe(generationRoot);
  });

  test.each([
    ["the target directory", "targets/preview-eve-destroy-fixture"],
    ["the generations directory", "generations"],
  ] as const)("a project whose %s is a symlink into another project is refused before any Cloudflare call", async (_name, path) => {
    const other = await deployedProject();
    const root = await realpath(await mkdtemp(join(tmpdir(), "eden-moi242-")));
    roots.push(root);
    await mkdir(join(root, ".eden", "eve-deploy", "targets"), { recursive: true });
    await symlink(join(other.root, ".eden", "eve-deploy", path), join(root, ".eden", "eve-deploy", path));
    cloud.containers.add(container);
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_RECORD_UNPROVEN" });
    expect(result.error?.remediation).toContain("eden destroy");
    expect({ whoami: cloud.whoamiCalls, api: cloud.apiAccounts, deleted: cloud.deleted }).toEqual({ whoami: 0, api: [], deleted: [] });
    await expect(lstat(other.current)).resolves.toBeDefined();
  });

  test("a record file that is a symlink to another project's record is not read", async () => {
    const other = await deployedProject();
    const { root, current } = await deployedProject();
    const record = join(root, ".eden", "eve-deploy", "generations", "gen-destroy-1", "deployment.json");
    await rm(record);
    await symlink(join(other.root, ".eden", "eve-deploy", "generations", "gen-destroy-1", "deployment.json"), record);
    cloud.containers.add(container);
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_RECORD_UNPROVEN" });
    expect({ whoami: cloud.whoamiCalls, deleted: cloud.deleted }).toEqual({ whoami: 0, deleted: [] });
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a generation directory that is a symlink into another project adds nothing to what destroy deletes", async () => {
    const other = await deployedProject("gen-destroy-9");
    const { root } = await deployedProject();
    await symlink(
      join(other.root, ".eden", "eve-deploy", "generations", "gen-destroy-9"),
      join(root, ".eden", "eve-deploy", "generations", "gen-destroy-9"),
    );
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    const { exitCode } = await destroy(root);
    expect(exitCode).toBe(0);
    expect([...cloud.listed]).toEqual([repository]);
    expect(cloud.deleted).toEqual(["container:" + container, "image:" + repository + ":candidate"]);
  });

  test("a project whose .eden is a symlink into another project is refused before the lock is written", async () => {
    const other = await deployedProject();
    const root = await realpath(await mkdtemp(join(tmpdir(), "eden-moi242-")));
    roots.push(root);
    await symlink(join(other.root, ".eden"), join(root, ".eden"));
    cloud.containers.add(container);
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_RECORD_UNPROVEN" });
    expect({ whoami: cloud.whoamiCalls, deleted: cloud.deleted }).toEqual({ whoami: 0, deleted: [] });
    await expect(lstat(join(other.root, ".eden", "eve-deploy", "locks"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(other.current)).resolves.toBeDefined();
  });

  test("a CURRENT that names another project's generation is refused before any Cloudflare call", async () => {
    const other = await deployedProject();
    const { root, current } = await deployedProject();
    await rm(current);
    await symlink(await realpath(other.current), current);
    cloud.containers.add(container);
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_RECORD_UNPROVEN" });
    expect({ whoami: cloud.whoamiCalls, deleted: cloud.deleted }).toEqual({ whoami: 0, deleted: [] });
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test.each([
    [0, 1, "DEPLOY_INDETERMINATE"],
    [1, 0, undefined],
  ] as const)("after publish, a Worker with %i deployment(s) ends the deploy with exit %i", async (deployments, expected, code) => {
    const root = await deployableProject();
    cloud.deployments = deployments;
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: expected, code });
    const promoted = await lstat(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT"))
      .then(() => true, () => false);
    expect(promoted).toBe(expected === 0);
  });

  test.each([
    ["an empty list", "[]"],
    ["another application", '[{"id":"container-999","name":"another-container"}]'],
  ] as const)("a Container answer that names result twice, the live application then %s, is no proof of absence", async (_name, second) => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.containerAnswer = (entries) => '{"success":true,"errors":[],"messages":[],"result":' + entries + ',"result":' + second + ',"result_info":{}}';
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a Container answer that turns ambiguous after the deletes leaves CURRENT in place", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.onMutation = () => {
      cloud.containerAnswer = (entries) => '{"success":true,"errors":[],"messages":[],"result":[{"id":"container-123","name":"eve-destroy-fixture-container"}],"result":' + entries + ',"result_info":{}}';
    };
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(cloud.deleted).toContain("container:" + container);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("after publish, a deployments list of [null] is not a publication", async () => {
    const root = await deployableProject();
    cloud.deploymentEntries = [null];
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
  });

  test("a deploy's record is one destroy accepts: deploy, then destroy, then absent", async () => {
    const root = await deployableProject();
    expect((await deploy(root)).exitCode).toBe(0);
    await expect(realpath(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT")))
      .resolves.toBe(join(root, ".eden", "eve-deploy", "generations", "generation-one"));
    const run = async (): Promise<{ readonly exitCode: number; readonly status: unknown }> => {
      const output: string[] = [];
      const exitCode = await runEdenCli(
        ["destroy", "--project", root, "--env", "preview", "--name", "eve-deploy-fixture", "--json"],
        { cwd: root, stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
      );
      return { exitCode, status: (JSON.parse(output.at(-1) ?? "") as { readonly status?: unknown }).status };
    };
    await expect(run()).resolves.toEqual({ exitCode: 0, status: "destroyed" });
    await expect(run()).resolves.toEqual({ exitCode: 0, status: "absent" });
  });

  test.each([
    ["status 206", 206, '{"success":true,"result":[],"errors":[],"messages":[],"result_info":{}}'],
    ["an authentication error beside success", 200, '{"success":true,"result":[],"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result_info":{}}'],
    ["no errors field", 200, '{"success":true,"result":[],"result_info":{}}'],
  ] as const)("an empty Container list with %s is no proof of absence", async (_name, status, body) => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.containerStatus = status;
    cloud.containerAnswer = () => body;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test.each(["", ".", "..", "/", "a/b", "Release-1"])("a generation id of %j is refused before anything is published", async (generationId) => {
    const root = await deployableProject();
    const { exitCode, result } = await deploy(root, generationId);
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 1, ok: false });
    expect(result.error?.code).toBe("EVE_DEPLOY_CHECKS_FAILED");
    expect(cloud.pinned).toEqual([]);
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["an authentication error", (entries: string) => '{"success":true,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result":' + entries + ',"result_info":{}}'],
    ["result named twice", (entries: string) => '{"success":true,"errors":[],"messages":[],"result":' + entries + ',"result":' + entries + ',"result_info":{}}'],
  ] as const)("a Container answer that lists the application beside %s names nothing to delete", async (_name, answer) => {
    const { root, current } = await deployedProject();
    cloud.workers.clear();
    cloud.containers.add(container);
    cloud.containerAnswer = answer;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a clean Container answer with escaped text and other fields still lets destroy finish", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.containerAnswer = (entries) => '{ "success": true, "errors": [], "messages": [], "result": ' +
      entries.replace('"name"', '"note":"a\\/b \\u0026 c","size":1.0,"name"') + ', "result_info": {} }';
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.deleted).toContain("container:" + container);
    await expect(lstat(current)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a regular file at CURRENT is not the pointer: destroy leaves it in place", async () => {
    const { root, current } = await deployedProject();
    await rm(current);
    await writeFile(current, "not a pointer");
    cloud.containers.add(container);
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect((await lstat(current)).isFile()).toBe(true);
  });

  test.each([
    ["an entry with no id", () => { cloud.deploymentEntries = [{}]; }],
    ["an entry that is a list", () => { cloud.deploymentEntries = [[]]; }],
    ["an entry with an empty id", () => { cloud.deploymentEntries = [{ id: "" }]; }],
    ["deployments named twice", () => { cloud.workerAnswer = (deployments) => '{"success":true,"errors":[],"messages":[],"result":{"deployments":[],"deployments":' + deployments + '}}'; }],
  ] as const)("after publish, a deployments answer with %s is not a publication", async (_name, arrange) => {
    const root = await deployableProject();
    arrange();
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
  });
});

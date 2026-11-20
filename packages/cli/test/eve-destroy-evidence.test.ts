import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type * as Https from "node:https";
import type * as TimersPromises from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runEdenCli } from "../src/index.js";

/**
 * A stand-in for Cloudflare behind Eden's default readers and writers: the
 * cf CLI (the login, the Worker and Container application reads, the
 * registry credential, the publish, the deletes) and the registry.
 * Resources live per account, so a command under another account does not
 * see them. cf's outputs are in the forms cf 1.0.0-rc.2 printed on
 * 2026-11-20.
 */
const cloud = vi.hoisted(() => {
  type CfResult = { readonly exitCode: number | null; readonly stdout?: string; readonly stderr?: string };
  const state = {
    active: false,
    /** The account "cf auth whoami" names on its nth call, from 0. */
    whoami: (() => "account-test") as (nth: number) => string,
    whoamiCalls: 0,
    /** When set, what "cf auth whoami" prints instead. */
    whoamiAnswer: undefined as unknown,
    /** The account cf's login names: the one whoami named last. */
    loginAccount: "account-test",
    workers: new Set<string>(),
    containers: new Set<string>(),
    tags: [] as string[],
    /** When set, what the API does with the read of the Worker's deployments: no answer, or a status and body. */
    workerFailure: undefined as "network" | { readonly status: number; readonly body: string; readonly redirected?: boolean } | undefined,
    /** When set, the API's answer to the read of the Worker itself. */
    workerGet: undefined as { readonly status: number; readonly body: string } | undefined,
    /** The token of cf's login, which cf sends to whatever API address it is given. */
    loginToken: "cf-login-token-0123456789abcdefghij",
    /** Whether cf sends its login's token when Eden asks. */
    tokenWithheld: false,
    /** The user agent cf asks under. */
    agent: "cf-cli/1.0.0-rc.2",
    /** Each "cf auth whoami" Eden ran against an API address of its own: that address. */
    captures: [] as string[],
    /** How many API reads answer 401 before the token is accepted. */
    rejectedReads: 0,
    /** Each API read: its URL and its Authorization header. */
    apiReads: [] as { readonly url: string; readonly authorization: string | null }[],
    /** How many API reads of the Worker's deployments answer that it does not exist before they show it. */
    hiddenReads: 0,
    /** Called before each read of the Worker's deployments, with the read's number from 0. */
    onWorkerRead: (() => undefined) as (nth: number) => unknown,
    workerReads: 0,
    /** How many deployments the API lists for a Worker that exists. */
    deployments: 1,
    /** When set, the deployments cf lists, whatever they are. */
    deploymentEntries: undefined as readonly unknown[] | undefined,
    /** When set, the API's whole answer to the Container applications read, given its true entries. */
    containerAnswer: undefined as ((entries: string) => string) | undefined,
    /** The status of the API's answer to the Container applications read. */
    containerStatus: 200,
    /** The plain-text bindings of the Worker: what the last publish stamped. */
    stamps: [] as { readonly type: string; readonly name: string; readonly text: string }[],
    /** Called before each cf command that changes the account. */
    onMutation: (() => undefined) as () => void,
    /** Called before each read other than whoami and the Worker's deployments. */
    onRead: (() => undefined) as () => void,
    /** The account each read ran against. */
    readAccounts: [] as string[],
    /** CLOUDFLARE_ACCOUNT_ID as each changing cf command received it. */
    pinned: [] as (string | undefined)[],
    /** The registry repositories whose listing was asked for. */
    listed: new Set<string>(),
    deleted: [] as string[],
    /** Each secret cf uploaded, as account/worker/name. */
    secrets: [] as string[],
    /** Each image cf pushed, as account/repository:tag. */
    pushed: [] as string[],
    /** How many times "cf workers triggers deploy" answers that the Worker does not exist. */
    triggerFailures: 0,
    /** When set, how "cf deploy" exits 1: before it uploads anything, or with the Worker version live and no Container application. */
    deployFailure: undefined as "before-upload" | "after-upload" | undefined,
    /** Text cf prints before its error box, inside it and after it when the deploy fails after the upload. */
    deployOutput: "",
    /** Whether "cf containers applications create" fails. */
    createFails: false,
    /** Whether "cf containers applications create" exits 0 and creates nothing. */
    createLost: false,
    /** When set, the ID Cloudflare gives a Container application that cf creates, in place of its namespace. */
    createdId: undefined as string | undefined,
    /** When set, what "cf containers applications get" prints for an application that exists, given its true answer. */
    application: undefined as ((real: Readonly<Record<string, unknown>>) => unknown) | undefined,
    /** Bindings of the Worker version beside its stamps and its Container binding. */
    moreBindings: [] as readonly unknown[],
    /** When set, the Worker the Container binding says its class is in. */
    bindingScript: undefined as string | undefined,
    /** Each Worker whose triggers cf deployed, as account/worker. */
    triggers: [] as string[],
    /** Each cf command: its arguments, the cloudflare.config.ts in its folder, and its environment. */
    runs: [] as { readonly args: readonly string[]; readonly cwd: string; readonly config: string | undefined; readonly env: NodeJS.ProcessEnv }[],
    /** The Durable Object namespace of the Container class, which is also its Container application's ID. */
    namespace: "abcdef0123456789abcdef0123456789",
    /** cf's error box for one Cloudflare API error. */
    apiError: (code: number, message: string, status: string, path: string): CfResult => ({
      exitCode: 1,
      stderr: "\n┌ APIError\n│ [" + code + "] " + message + "\n│ " + status + " · HTTP " + path + "\n└\n",
    }),
  };
  return state;
});

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof TimersPromises>();
  // Eden's waits between reads of Cloudflare end at once.
  return { ...actual, setTimeout: ((...waitArgs: Parameters<typeof actual.setTimeout>) => cloud.active ? Promise.resolve() : actual.setTimeout(...waitArgs)) as typeof actual.setTimeout };
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

/** What the fake cf does with one command, run in the folder and environment Eden gave it. */
async function cf(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ readonly exitCode: number | null; readonly stdout?: string; readonly stderr?: string }> {
  const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value, null, 2) + "\n" });
  const line = args.join(" ");
  if (line === "auth whoami" && (env.CLOUDFLARE_API_BASE_URL ?? "").startsWith("http://127.0.0.1:")) {
    // cf 1.0.0-rc.2 asked a local address for /accounts?page=1 first, with its login's token, on 2026-11-20.
    cloud.captures.push(env.CLOUDFLARE_API_BASE_URL ?? "");
    if (!cloud.tokenWithheld) {
      await new Promise<void>((done) => {
        httpRequest(String(env.CLOUDFLARE_API_BASE_URL) + "/accounts?page=1", {
          agent: false,
          headers: { authorization: "Bearer " + cloud.loginToken, "user-agent": cloud.agent },
        }, (response) => { response.resume(); response.on("close", done); }).on("error", () => done()).end();
      });
    }
    return ok({ authenticated: true, tokenValid: null, accounts: [] });
  }
  const command = [
    "auth whoami",
    "workers delete", "workers secrets bulk-edit", "workers triggers deploy", "containers applications create", "containers applications delete",
    "containers registries credentials", "containers images delete", "containers push", "deploy",
  ].find((known) => line === known || line.startsWith(known + " "));
  let config: string | undefined;
  try {
    config = readFileSync(join(cwd, "cloudflare.config.ts"), "utf8");
  } catch {
    config = undefined;
  }
  cloud.runs.push({ args, cwd, config, env });
  if (command === "auth whoami") {
    cloud.loginAccount = cloud.whoami(cloud.whoamiCalls++);
    if (cloud.whoamiAnswer !== undefined) return ok(cloud.whoamiAnswer);
    return ok({ authenticated: true, tokenValid: true, accounts: [{ id: cloud.loginAccount }] });
  }
  // cf acts on CLOUDFLARE_ACCOUNT_ID when it is set, else on its login's account.
  const pinned = env.CLOUDFLARE_ACCOUNT_ID || undefined;
  const flag = (name: string): string => args[args.indexOf(name) + 1] ?? "";
  if (command === "containers registries credentials") {
    cloud.onRead();
    const account = pinned ?? cloud.loginAccount;
    cloud.readAccounts.push(account);
    return ok({ account_id: account, registry_host: "registry.cloudflare.com", username: "v1", password: "registry-password" });
  }
  cloud.onMutation();
  cloud.pinned.push(pinned);
  const account = pinned ?? cloud.loginAccount;
  if (command === "deploy" || command === "workers triggers deploy") {
    const output = join(cwd, ".cloudflare/output/v1");
    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8")) as { readonly settings?: { readonly accountId?: string } };
    const worker = JSON.parse(readFileSync(join(output, "workers/default/worker.config.json"), "utf8")) as {
      readonly name: string;
      readonly env: Readonly<Record<string, { readonly type: string; readonly value?: unknown }>>;
    };
    // cf takes the Build Output's account before CLOUDFLARE_ACCOUNT_ID.
    const published = config.settings?.accountId ?? account;
    if (command === "workers triggers deploy") {
      // What cf 1.0.0-rc.2 printed on 2026-11-20, seconds after Cloudflare had shown the Worker's version.
      if (cloud.triggerFailures-- > 0) {
        return { exitCode: 1, stderr: "├  Deploy triggers\n\n┌ APIError\n│ [10007] This Worker does not exist on your account. [code: 10007]\n│ 404 Not Found\n└\n\n" };
      }
      cloud.triggers.push(published + "/" + worker.name);
      return { exitCode: 0 };
    }
    if (cloud.deployFailure === "before-upload") return { exitCode: 1, stderr: "\n┌ Error\n│ fetch failed\n└\n" };
    cloud.stamps = Object.entries(worker.env).flatMap(([name, binding]) =>
      binding.type === "text" ? [{ type: "plain_text", name, text: String(binding.value) }] : []
    );
    if (args.includes("--secrets-file")) {
      for (const name of Object.keys(JSON.parse(readFileSync(join(cwd, flag("--secrets-file")), "utf8")) as object)) {
        cloud.secrets.push(published + "/" + worker.name + "/" + name);
      }
    }
    cloud.workers.add(published + "/" + worker.name);
    if (cloud.deployFailure === "after-upload") {
      // What cf 1.0.0-rc.2 printed on 2026-11-20 when Cloudflare did not show the uploaded version in time.
      return {
        exitCode: 1,
        stderr: cloud.deployOutput + "\n┌ Error\n│ The Worker version was deployed, but its Durable Object-managed Container\n│ application settings were not fully applied. Re-run the same `cf deploy`\n│ command to retry and finish deployment." + cloud.deployOutput + "\n└\n" + cloud.deployOutput,
      };
    }
    cloud.containers.add(published + "/" + worker.name + "-container#" + (cloud.createdId ?? cloud.namespace));
    cloud.triggers.push(published + "/" + worker.name);
    return { exitCode: 0 };
  }
  if (command === "containers applications create") {
    if (cloud.createFails) return cloud.apiError(1000, "Internal error", "500 Internal Server Error", "/accounts/" + account + "/containers/applications");
    const body = JSON.parse(flag("--body")) as { readonly name: string; readonly durable_objects: { readonly namespace_id: string } };
    if (!cloud.createLost) cloud.containers.add(account + "/" + body.name + "#" + (cloud.createdId ?? body.durable_objects.namespace_id));
    return ok({ id: body.durable_objects.namespace_id, name: body.name });
  }
  if (command === "workers secrets bulk-edit") {
    for (const name of Object.keys(JSON.parse(readFileSync(join(cwd, flag("--secrets").slice(1)), "utf8")) as object)) {
      cloud.secrets.push(account + "/" + flag("--worker") + "/" + name);
    }
    return { exitCode: 0 };
  }
  if (command === "containers push") {
    cloud.pushed.push(account + "/" + flag("--tag"));
    return { exitCode: 0 };
  }
  if (command === "workers delete") {
    if (!cloud.workers.delete(account + "/" + args[2])) {
      return cloud.apiError(10007, "This Worker does not exist on your account.", "404 Not Found", "/accounts/" + account + "/workers/workers/" + args[2]);
    }
    cloud.deleted.push("worker:" + account + "/" + args[2]);
    return { exitCode: 0 };
  }
  if (command === "containers applications delete") {
    const entry = [...cloud.containers].find((present) => present.startsWith(account + "/") && present.endsWith("#" + args[3]));
    if (entry === undefined) {
      return cloud.apiError(1609, '{"error":"APPLICATION_NOT_FOUND"}', "404 Not Found", "/accounts/" + account + "/containers/applications/" + args[3]);
    }
    cloud.containers.delete(entry);
    cloud.deleted.push("container:" + entry);
    return ok({ message: "Application " + args[3] + " has been deleted." });
  }
  if (command === "containers images delete") {
    const tag = (args[3] ?? "").split(":")[1] ?? "";
    cloud.tags = cloud.tags.filter((present) => present !== tag);
    cloud.deleted.push("image:" + args[3]);
    return { exitCode: 0 };
  }
  return { exitCode: 1, stderr: "Unexpected cf call: " + args.join(" ") };
}

const json = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
/** The API's answer for an object that does not exist, read on 2026-11-20. */
const missing = (code: number, message: string): Response =>
  json(404, { result: null, success: false, errors: [{ code, message }], messages: [] });
const found = (result: unknown): Response => json(200, { result, success: true, errors: [], messages: [] });

/** Cloudflare's API as Eden reads it, in the shapes it answered with on 2026-11-20. */
async function cloudflareApi(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const authorization = new Headers(init?.headers).get("authorization");
  cloud.apiReads.push({ url: url.href, authorization });
  if (url.origin !== "https://api.cloudflare.com") throw new TypeError("fetch failed");
  if (
    cloud.rejectedReads-- > 0 ||
    authorization !== "Bearer " + (process.env.CLOUDFLARE_API_TOKEN || cloud.loginToken)
  ) return json(401, { result: null, success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [] });
  const [, , , , account = "", ...rest] = url.pathname.split("/");
  cloud.readAccounts.push(account);
  const path = rest.join("/");
  if (rest[0] === "workers" && rest[1] === "scripts" && rest[3] === "deployments") {
    await cloud.onWorkerRead(cloud.workerReads++);
    if (cloud.workerFailure === "network") throw new TypeError("fetch failed");
    if (cloud.workerFailure !== undefined) {
      const answer = json(cloud.workerFailure.status, cloud.workerFailure.body);
      if (!cloud.workerFailure.redirected) return answer;
      // What fetch does with a redirect: refuse it when asked to, else return the page it led to.
      if (init?.redirect === "error") throw new TypeError("fetch failed");
      Object.defineProperty(answer, "redirected", { value: true });
      return answer;
    }
    if (cloud.hiddenReads-- > 0 || !cloud.workers.has(account + "/" + rest[2])) {
      return missing(10007, "This Worker does not exist on your account.");
    }
    const deployments = cloud.deploymentEntries ?? Array.from({ length: cloud.deployments }, (_, nth) => ({
      id: "deployment-" + nth,
      source: "cf_cli",
      versions: [{ version_id: "00000000-0000-4000-8000-00000000000" + nth, percentage: 100 }],
      created_on: "2026-11-20T11:38:3" + nth + ".845435Z",
    }));
    return json(200, {
      result: { deployments },
      success: true,
      errors: [],
      messages: [],
      result_info: { page: 1, per_page: 10, count: deployments.length, total_count: deployments.length, total_pages: 1 },
    });
  }
  cloud.onRead();
  if (path === "workers/subdomain") return found({ subdomain: "account" });
  if (path === "containers/applications") {
    const entries = [...cloud.containers].flatMap((entry) => {
      const [owner, named = ""] = entry.split("/");
      const [application, id] = named.split("#");
      return owner === account && application === url.searchParams.get("name") ? [{ id, name: application }] : [];
    });
    return json(cloud.containerStatus, cloud.containerAnswer?.(JSON.stringify(entries)) ??
      { success: true, result: entries, errors: [], messages: [], result_info: {} });
  }
  if (rest[0] === "containers" && rest[1] === "applications") {
    const present = [...cloud.containers].find((entry) => entry.startsWith(account + "/") && entry.endsWith("#" + rest[2]));
    const real = { id: rest[2], name: present?.slice(account.length + 1).split("#")[0], scheduling_policy: "durable_object", durable_objects: { namespace_id: cloud.namespace } };
    return present !== undefined
      ? found(cloud.application?.(real) ?? real)
      : missing(1609, "Container application not found: " + String(rest[2]));
  }
  if (rest[0] === "workers" && rest[1] === "workers") {
    if (cloud.workerGet !== undefined) return json(cloud.workerGet.status, cloud.workerGet.body);
    return cloud.workers.has(account + "/" + rest[2])
      ? found({ id: "cd724573b14e43ca9353d42937113cf0", name: rest[2] })
      : missing(10007, "This Worker does not exist on your account.");
  }
  if (rest[0] === "workers" && rest[1] === "scripts" && rest[3] === "versions" && cloud.workers.has(account + "/" + rest[2])) {
    if (rest[4] === undefined) {
      // A successful list of versions has null errors and messages.
      return json(200, {
        result: { items: [{ id: "00000000-0000-4000-8000-000000000001", number: 1 }] },
        success: true,
        errors: null,
        messages: null,
        result_info: { page: 1, per_page: 10, count: 1, total_count: 1 },
      });
    }
    return found({
      id: rest[4],
      number: 1,
      resources: {
        bindings: [
          ...cloud.stamps,
          { type: "durable_object_namespace", name: "EVE_CONTAINER", class_name: "EveHostDurableContainer", ...(cloud.bindingScript === undefined ? {} : { script_name: cloud.bindingScript }), namespace_id: cloud.namespace },
          ...cloud.moreBindings,
        ],
      },
    });
  }
  return missing(10007, "This Worker does not exist on your account.");
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const execFile = ((...execArgs: Parameters<typeof actual.execFile>) =>
    actual.execFile(...execArgs)) as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: async (file: string, argv: readonly string[], options: object) => {
      if (cloud.active && file === "docker" && argv[0] === "tag") return { stdout: "", stderr: "" };
      if (cloud.active && file === "docker" && argv.includes("{{json .RepoDigests}}")) {
        // Docker names the registry path the push went to.
        const [account = "", image = ""] = (cloud.pushed.at(-1) ?? "").split("/");
        return {
          stdout: JSON.stringify(["registry.cloudflare.com/" + account + "/" + image.split(":")[0] + "@sha256:" + "d".repeat(64)]),
          stderr: "",
        };
      }
      return promisify(actual.execFile)(file, argv, options);
    },
  });
  return {
    ...actual,
    execFile,
    spawn: ((...spawnArgs: Parameters<typeof actual.spawn>) => {
      const argv = spawnArgs[1] as readonly string[];
      // Eden runs cf as `node <cf's bin/cf> ...args`.
      if (!cloud.active || !/[\\/]cf[\\/]bin[\\/]cf$/u.test(argv[0] ?? "")) return actual.spawn(...spawnArgs);
      const options = spawnArgs[2] as { readonly cwd: string; readonly env: NodeJS.ProcessEnv };
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      void cf(argv.slice(1), options.cwd, options.env).then((result) => {
        if (result.stdout !== undefined) child.stdout.emit("data", Buffer.from(result.stdout));
        if (result.stderr !== undefined) child.stderr.emit("data", Buffer.from(result.stderr));
        child.emit("close", result.exitCode);
      });
      return child;
    }) as unknown as typeof actual.spawn,
  };
});

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
  vi.stubGlobal("fetch", cloudflareApi);
  Object.assign(cloud, {
    active: true,
    whoami: () => "account-test",
    whoamiCalls: 0,
    whoamiAnswer: undefined,
    loginAccount: "account-test",
    workers: new Set<string>(),
    containers: new Set<string>(),
    tags: [],
    workerFailure: undefined,
    workerGet: undefined,
    loginToken: "cf-login-token-0123456789abcdefghij",
    tokenWithheld: false,
    agent: "cf-cli/1.0.0-rc.2",
    captures: [],
    rejectedReads: 0,
    apiReads: [],
    hiddenReads: 0,
    onWorkerRead: () => undefined,
    workerReads: 0,
    deployments: 1,
    deploymentEntries: undefined,
    containerAnswer: undefined,
    containerStatus: 200,
    stamps: [{ type: "plain_text", name: "EDEN_EVE_DEPLOYMENT_ID", text: "eve-deploy-test" }],
    onMutation: () => undefined,
    onRead: () => undefined,
    readAccounts: [],
    pinned: [],
    triggerFailures: 0,
    deployFailure: undefined,
    deployOutput: "",
    createFails: false,
    createLost: false,
    createdId: undefined,
    application: undefined,
    moreBindings: [],
    bindingScript: undefined,
    triggers: [],
    runs: [],
    listed: new Set<string>(),
    deleted: [],
    secrets: [],
    pushed: [],
  });
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
});

afterEach(async () => {
  cloud.active = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const missingWorker = { code: 10007, message: "This Worker does not exist on your account." };
const refused = (status: number, code: number, message: string) =>
  ({ status, body: JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }) });
/** Answers to the read of the Worker's deployments that are not the API's own answer that the Worker does not exist. */
const failures = {
  "a body that is not JSON": { status: 200, body: "not json" },
  "an authentication error": refused(403, 10000, "Authentication error"),
  "a gateway's 404 Not Found page": { status: 404, body: "<html><head><title>404 Not Found</title></head></html>" },
  "a server error that mentions a missing resource": refused(502, 10013, "upstream does not exist"),
  "a network failure": "network",
  "a 404 with another error code": refused(404, 10404, "No route for that URI"),
  "code 10007 on a status other than 404": refused(502, 10007, "Bad gateway"),
  "a partial answer (206) that lists no deployment": {
    status: 206,
    body: JSON.stringify({ result: { deployments: [] }, success: true, errors: [], messages: [] }),
  },
  "a list of deployments beside an error": {
    status: 200,
    body: JSON.stringify({ result: { deployments: [] }, success: true, errors: [missingWorker], messages: [] }),
  },
  "a list of deployments with result named twice": {
    status: 200,
    body: '{"result":{"deployments":[{"id":"deployment-1"}]},"result":{"deployments":[]},"success":true,"errors":[],"messages":[]}',
  },
} as const;

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
  "a 10007 error beside another error": {
    status: 404,
    body: JSON.stringify({ result: null, success: false, errors: [missingWorker, { code: 10000, message: "Authentication error" }], messages: [] }),
  },
  "code 10007 in a message and no error": {
    status: 404,
    body: JSON.stringify({ result: null, success: false, errors: [], messages: [missingWorker] }),
  },
  "a 10007 error beside a message": {
    status: 404,
    body: JSON.stringify({ result: null, success: false, errors: [missingWorker], messages: [{ code: 10000, message: "Authentication error" }] }),
  },
  "a 10007 error with success true": {
    status: 404,
    body: JSON.stringify({ result: null, success: true, errors: [missingWorker], messages: [] }),
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

type DeployResult = { readonly ok?: boolean; readonly error?: { readonly code?: string }; readonly checks?: readonly { readonly id: string; readonly status: string; readonly message?: string; readonly remediation?: string }[] };

/** A deploy that publishes through Eden's own cf calls and its own read afterwards. */
async function deploy(
  root: string,
  generationId = "generation-one",
  /** The account the check before the deploy proved, an env file to upload, and whether Eden pushes the image itself. */
  { account = "account-test", envFile, push = false, ownChecks = false, output = [] }: { readonly account?: string; readonly envFile?: string; readonly push?: boolean; /** Eden's own account checks run, not a supplied result. */ readonly ownChecks?: boolean; /** Receives every line Eden prints. */ readonly output?: string[] } = {},
): Promise<{ readonly exitCode: number; readonly result: DeployResult }> {
  const imageDigest = "sha256:" + "d".repeat(64);
  const exitCode = await runEdenCli(
    ["deploy", "--project", root, "--env", "preview", "--name", "eve-deploy-fixture", ...(envFile === undefined ? [] : ["--env-file", envFile]), "--json"],
    {
      cwd: root,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      eveControlPlane: {
        generationId,
        builder: { build: async (request) => { await writeBuild(request.snapshotRoot); return { eveVersion: "0.91.0" }; } },
        ...(push ? {} : { containerImageReference: "registry.cloudflare.com/" + account + "/eve@" + imageDigest }),
        runtimeRunner: async () => ({
          ok: true,
          ...(push ? { imageReference: "eden-local:candidate" } : {}),
          checks: ["VAL-BUILD-005", "VAL-BUILD-006", "VAL-BUILD-007"].map((id) => ({ id, status: "passed" as const, message: "Passed." })),
          imageDigest,
          cleanup: { bootContainerId: null, bootContainerRemoved: true, imageIdentity: "exact" as const, imageRetained: true, verified: true },
        }),
        ...(ownChecks ? {} : {
          cloudflareRead: async () => ({
            accountAccess: "available" as const,
            containerAccess: "available" as const,
            accountId: account,
            workersDevSubdomain: "account",
            target: { state: "absent" as const },
          }),
        }),
        health: async (request) => ({ status: "ready", identity: request.identity }),
        discardRuntimeImage: async () => true,
      },
    },
  );
  return { exitCode, result: JSON.parse(output.at(-1) ?? "") as DeployResult };
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
      cloud.workerFailure = contradictions[name];
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

  test("every cf delete is pinned to the recorded account, so a login that changes after the reads cannot move it", async () => {
    const { root } = await deployedProject();
    cloud.workers.add(worker).add("account-other/eve-destroy-fixture");
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.onMutation = () => { cloud.loginAccount = "account-other"; };
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.pinned).toEqual(["account-test", "account-test", "account-test"]);
    expect(cloud.deleted).toEqual(["worker:" + worker, "container:" + container, "image:" + repository + ":candidate"]);
    expect([...cloud.workers]).toEqual(["account-other/eve-destroy-fixture"]);
  });

  test("a login that changes after whoami cannot move a cf read to another account", async () => {
    const { root, current } = await deployedProject();
    cloud.workers.add(worker);
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.onRead = () => { cloud.loginAccount = "account-other"; };
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.deleted).toEqual(["worker:" + worker, "container:" + container, "image:" + repository + ":candidate"]);
    await expect(lstat(current)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("Cloudflare's own 10007 answer for this Worker is an absent Worker: the rest is deleted and CURRENT is cleared", async () => {
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

  test("each read asks whoami once and sends every cf read to that account", async () => {
    const { root } = await deployedProject();
    cloud.containers.add(container);
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    // Two reads: before the deletes and after them.
    expect(cloud.whoamiCalls).toBe(2);
    expect(cloud.readAccounts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cloud.readAccounts)).toEqual(new Set(["account-test"]));
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
    expect(cloud.readAccounts.every((account) => account === "account-test")).toBe(true);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a Worker that holds only secrets, as Eden 0.14's failed first deploy left one, is not deleted", async () => {
    const { root, current } = await deployedProject();
    cloud.workers.add(worker);
    cloud.stamps = [{ type: "secret_text", name: "MODEL_KEY" }];
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_OWNERSHIP_UNPROVEN" });
    expect(result.error?.remediation).toContain("docs/troubleshooting.md");
    expect({ deleted: cloud.deleted, workers: [...cloud.workers] }).toEqual({ deleted: [], workers: [worker] });
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a login for another account reads nothing and deletes nothing", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.whoami = () => "account-other";
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_OWNERSHIP_UNPROVEN" });
    expect({ reads: cloud.readAccounts, deleted: cloud.deleted }).toEqual({ reads: [], deleted: [] });
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
    expect({ whoami: cloud.whoamiCalls, reads: cloud.readAccounts, deleted: cloud.deleted }).toEqual({ whoami: 0, reads: [], deleted: [] });
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

  test("a deploy to production stops with EVE_DEPLOY_BUSY while a preview destroy of the same name runs", async () => {
    const { root } = await deployedProject();
    cloud.workers.add(worker);
    cloud.containers.add(container);
    let reached = (): void => undefined;
    let resume = (): void => undefined;
    const destroyReading = new Promise<void>((resolve) => { reached = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    cloud.onWorkerRead = async (nth) => {
      if (nth !== 0) return;
      reached();
      await paused;
    };
    const destroying = destroy(root);
    await destroyReading;
    const output: string[] = [];
    const exitCode = await runEdenCli(
      ["deploy", "--project", root, "--env", "production", "--name", "eve-destroy-fixture", "--json"],
      { cwd: root, stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
    );
    expect(output).toHaveLength(1);
    const result = JSON.parse(output[0] ?? "") as { readonly ok?: boolean; readonly error?: { readonly code?: string; readonly remediation?: string } };
    expect({ exitCode, ok: result.ok, code: result.error?.code }).toEqual({ exitCode: 1, ok: false, code: "EVE_DEPLOY_BUSY" });
    expect(result.error?.remediation).toContain("rerun the same eden command");
    expect(result.error?.remediation).toContain(".eden/eve-deploy/locks/<name>.lock");
    expect(cloud.deleted).toEqual([]);
    await expect(readdir(join(root, ".eden", "eve-deploy", "locks"))).resolves.toEqual(["eve-destroy-fixture.lock"]);
    resume();
    expect((await destroying).exitCode).toBe(0);
    await expect(readdir(join(root, ".eden", "eve-deploy", "locks"))).resolves.toEqual([]);
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

  const listed = (result: string, info = "{}") => '{"success":true,"errors":[],"messages":[],"result":' + result + ',"result_info":' + info + "}";
  test.each([
    ["result named twice, the second an empty list", 200, (entries: string) => '{"success":true,"errors":[],"messages":[],"result":' + entries + ',"result":[],"result_info":{}}'],
    ["result named twice, the second another application", 200, (entries: string) => '{"success":true,"errors":[],"messages":[],"result":' + entries + ',"result":[{"id":"container-999","name":"another-container"}],"result_info":{}}'],
    ["an empty list and status 206", 206, () => listed("[]")],
    ["an empty list beside an authentication error", 200, () => '{"success":true,"result":[],"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result_info":{}}'],
    ["an empty list and no errors field", 200, () => '{"success":true,"result":[],"result_info":{}}'],
    ["an authentication error", 403, () => '{"success":false,"result":null,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[]}'],
    ["an object instead of a list", 200, () => listed('{"result":[]}')],
    ["an empty list whose count is 1", 200, () => listed("[]", '{"count":1}')],
    ["an empty list whose total is 1", 200, () => listed("[]", '{"count":0,"total_count":1}')],
    ["the live application and a total of 2", 200, (entries: string) => listed(entries, '{"count":1,"total_count":2}')],
    ["paging facts that are a list", 200, () => listed("[]", "[]")],
    ["100 other applications and no paging facts", 200, () => '{"success":true,"errors":[],"messages":[],"result":' + JSON.stringify(Array.from({ length: 100 }, (_, nth) => ({ id: "other-" + nth, name: "another-container" }))) + "}"],
    ["100 other applications and empty paging facts", 200, () => listed(JSON.stringify(Array.from({ length: 100 }, (_, nth) => ({ id: "other-" + nth, name: "another-container" }))))],
    ["a body that is not JSON", 200, () => "<html>"],
  ] as const)("a Container answer of %s is no proof of absence and names nothing to delete", async (_name, status, answer) => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.containerStatus = status;
    cloud.containerAnswer = answer;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a Container listing that never ends is given up after twenty pages", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    let page = 0;
    cloud.containerAnswer = () => listed("[]", '{"next_page_token":"page-' + String(page += 1) + '"}');
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(page).toBe(20);
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test.each([
    ["a first page with a total of 1 and a last page with a total of 0", ['{"count":0,"total_count":1,"next_page_token":"page-2"}', '{"count":0,"total_count":0}']],
    ["a first page with a total of 1 and a last page with none", ['{"count":0,"total_count":1,"next_page_token":"page-2"}', "{}"]],
    ["a total that is not a number", ['{"count":0,"total_count":"0"}']],
  ] as const)("after the deletes, empty Container pages with %s leave CURRENT in place", async (_name, pages) => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.onMutation = () => {
      let page = 0;
      cloud.containerAnswer = () => listed("[]", pages[page++] ?? "{}");
    };
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
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

  test.each(["", ".", "..", "/", "a/b", "Release-1"])("a generation id of %j is refused before anything is published", async (generationId) => {
    const root = await deployableProject();
    const { exitCode, result } = await deploy(root, generationId);
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 1, ok: false });
    expect(result.error?.code).toBe("EVE_DEPLOY_CHECKS_FAILED");
    expect(cloud.pinned).toEqual([]);
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets"))).rejects.toMatchObject({ code: "ENOENT" });
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
  ] as const)("after publish, a deployments answer with %s is not a publication", async (_name, arrange) => {
    const root = await deployableProject();
    arrange();
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
  });
});

describe("eden deploy sends every cf write to the account it checked (MOI-254)", () => {
  const account = "1".repeat(32);
  /** A deploy with one runtime value, during which cf's login moves to another account before the first write. */
  const deployWhileTheLoginChanges = async (push: boolean) => {
    const root = await deployableProject();
    const envRoot = await mkdtemp(join(tmpdir(), "eden-moi254-"));
    roots.push(envRoot);
    await writeFile(join(envRoot, "runtime.env"), "MODEL_KEY=model-key-value\n", "utf8");
    cloud.loginAccount = account;
    cloud.onMutation = () => { cloud.loginAccount = "2".repeat(32); };
    return deploy(root, "generation-one", { account, envFile: join(envRoot, "runtime.env"), push });
  };

  test("the log of a failed publish that carried secrets holds what happened in Eden's words and nothing cf printed", async () => {
    const root = await deployableProject();
    const envRoot = await mkdtemp(join(tmpdir(), "eden-moi254-"));
    roots.push(envRoot);
    // A short value, one that JSON writes differently, and one long enough for cf to wrap.
    await writeFile(join(envRoot, "runtime.env"), "MODEL_KEY=k9\nQUOTED=say \"hi\"\nLONG=wrapped-first-half-wrapped-second-half\n", "utf8");
    cloud.deployFailure = "after-upload";
    cloud.createFails = true;
    cloud.deployOutput = "\n│ MODEL_KEY k9 QUOTED say \\\"hi\\\" and say \"hi\" LONG wrapped-first-half-\n│ wrapped-second-half";
    const { exitCode } = await deploy(root, "generation-one", { envFile: join(envRoot, "runtime.env") });
    expect(exitCode).toBe(1);
    const log = await readFile(join(root, ".eden", "eve-deploy", "generations", "generation-one", "worker", "cf-deploy.log"), "utf8");
    expect(log).toContain("cf deploy: exit 1\ncf said the Worker version was deployed and its Container application settings were not fully applied.");
    expect(log).toContain("cf containers applications create: exit 1");
    expect(log).not.toMatch(/k9|say|wrapped|half|MODEL_KEY/u);
  });

  test("a login that changes after the check cannot move a secret upload or the publish", async () => {
    const { exitCode, result } = await deployWhileTheLoginChanges(false);
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect(cloud.secrets).toEqual([account + "/eve-deploy-fixture/MODEL_KEY"]);
    expect([...cloud.workers]).toEqual([account + "/eve-deploy-fixture"]);
  });

  test("a login that names another account at the second check stops the deploy before any write", async () => {
    const root = await deployableProject();
    cloud.whoami = (nth) => nth === 0 ? account : "2".repeat(32);
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 1, ok: false });
    expect(result.checks?.find((check) => check.id === "VAL-CLI-007-CLOUDFLARE-ACCESS")).toMatchObject({
      status: "blocked",
      remediation: expect.stringContaining("whoami") as unknown,
    });
    expect({ pinned: cloud.pinned, pushed: cloud.pushed, secrets: cloud.secrets, workers: [...cloud.workers] })
      .toEqual({ pinned: [], pushed: [], secrets: [], workers: [] });
    expect(cloud.readAccounts.every((read) => read === account)).toBe(true);
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    // What cf 1.0.0-rc.2 printed for a token Cloudflare does not accept, on 2026-11-20.
    ["a token Cloudflare does not accept", { authenticated: true, tokenValid: null, accounts: [] }, { CLOUDFLARE_API_TOKEN: "not-a-token" }, /CLOUDFLARE_API_TOKEN is set.*Signing in again changes nothing/u],
    ["an account variable the login does not have", undefined, { CLOUDFLARE_ACCOUNT_ID: "2".repeat(32) }, /CLOUDFLARE_ACCOUNT_ID names an account this login does not have/u],
    ["a signed-out cf", { authenticated: false }, {}, /auth login --profile default, or set CLOUDFLARE_API_TOKEN/u],
    ["a signed-out cf with a named profile", { authenticated: false }, { CLOUDFLARE_AUTH_PROFILE: "work" }, /auth login --profile work, or set CLOUDFLARE_API_TOKEN.*auth whoami --profile work/u],
  ])("%s gets its own next step", async (_name, whoamiAnswer, env, remediation) => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    cloud.whoamiAnswer = whoamiAnswer;
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubEnv("HOME", root);
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect(exitCode).toBe(1);
    expect(result.checks?.find((check) => check.id === "VAL-CLI-007-CLOUDFLARE-ACCESS")).toMatchObject({
      status: "blocked",
      remediation: expect.stringMatching(remediation) as unknown,
    });
    expect({ pinned: cloud.pinned, workers: [...cloud.workers] }).toEqual({ pinned: [], workers: [] });
  });

  test("with Eden's own checks and a steady login, the deploy lands in the checked account", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect([...cloud.workers]).toEqual([account + "/eve-deploy-fixture"]);
  });

  test("a second Container application of the target's name stops the next deploy before it publishes", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    expect((await deploy(root, "generation-one", { account, push: true, ownChecks: true })).exitCode).toBe(0);
    const publishes = () => cloud.runs.filter((run) => run.args[0] === "deploy").length;
    expect(publishes()).toBe(1);
    cloud.containers.add(account + "/eve-deploy-fixture-container#" + "f".repeat(32));
    const { exitCode, result } = await deploy(root, "generation-two", { account, push: true, ownChecks: true });
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DEPLOY_CHECKS_FAILED" });
    expect(publishes()).toBe(1);
  });

  test("a login that changes after the check cannot move the image push", async () => {
    const { exitCode, result } = await deployWhileTheLoginChanges(true);
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect(cloud.pushed).toHaveLength(1);
    expect(cloud.pushed[0]).toMatch(new RegExp("^" + account + "/eden-eve-"));
    expect(cloud.secrets).toEqual([account + "/eve-deploy-fixture/MODEL_KEY"]);
  });
});

describe("eden finishes a publish cf left half done, and destroy removes one it could not finish (MOI-258, MOI-268)", () => {
  const worker = "account-test/eve-deploy-fixture";
  const destroyDeployed = async (root: string) => {
    const output: string[] = [];
    const exitCode = await runEdenCli(
      ["destroy", "--project", root, "--env", "preview", "--name", "eve-deploy-fixture", "--json"],
      { cwd: root, stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
    );
    return { exitCode, result: JSON.parse(output.at(-1) ?? "") as { readonly status?: string; readonly error?: { readonly code?: string } } };
  };

  test("when cf deploy fails after the Worker version is live, Eden creates the Container application and deploys the triggers itself", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect(cloud.runs.filter((run) => run.args[0] === "deploy")).toHaveLength(1);
    expect([...cloud.containers]).toEqual(["account-test/eve-deploy-fixture-container#" + cloud.namespace]);
    expect(cloud.triggers).toEqual([worker]);
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT"))).resolves.toBeDefined();
  });

  test("a Worker that Cloudflare shows only after several reads is still finished", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.hiddenReads = 6;
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect(cloud.triggers).toEqual([worker]);
  });

  test("triggers that Cloudflare refuses at first, saying the Worker does not exist, are applied again", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.triggerFailures = 3;
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect(cloud.triggers).toEqual([worker]);
  });

  test("a Worker that one of Cloudflare's two reads still shows is not absent: destroy stops", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add("account-test/eve-destroy-fixture-container#container-123");
    cloud.workerGet = { status: 200, body: JSON.stringify({ result: { id: "cd724573b14e43ca9353d42937113cf0", name: "eve-destroy-fixture" }, success: true, errors: [], messages: [] }) };
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("when cf deploy fails before it uploads, Eden creates nothing and ends DEPLOY_INDETERMINATE", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "before-upload";
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect({ workers: [...cloud.workers], containers: [...cloud.containers], triggers: cloud.triggers }).toEqual({ workers: [], containers: [], triggers: [] });
  });

  test("a Worker another release left in service is not finished: Eden creates nothing for it", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "before-upload";
    cloud.workers.add(worker);
    cloud.stamps = [{ type: "plain_text", name: "EDEN_EVE_RELEASE_ID", text: "eve-deploy-another" }];
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect({ containers: [...cloud.containers], triggers: cloud.triggers }).toEqual({ containers: [], triggers: [] });
  });

  test("a version Cloudflare holds but does not serve is not finished: Eden creates nothing for it", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.deployments = 0;
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect({ containers: [...cloud.containers], triggers: cloud.triggers }).toEqual({ containers: [], triggers: [] });
  });

  test.each([
    ["another ID", (real: Readonly<Record<string, unknown>>) => ({ ...real, id: "f".repeat(32) })],
    ["another namespace", (real: Readonly<Record<string, unknown>>) => ({ ...real, durable_objects: { namespace_id: "e".repeat(32) } })],
    ["another name", (real: Readonly<Record<string, unknown>>) => ({ ...real, name: "another-container" })],
    ["another scheduling policy", (real: Readonly<Record<string, unknown>>) => ({ ...real, scheduling_policy: "default" })],
  ] as const)("a Container application that answers with %s is not this publish's: no triggers, and the last deploy stays current", async (_name, application) => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.containers.add("account-test/eve-deploy-fixture-container#" + cloud.namespace);
    cloud.application = application;
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect(cloud.triggers).toEqual([]);
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["found before the publish", false, "after-upload"],
    ["created by Eden", true, "after-upload"],
    ["created by a publish cf called done", true, undefined],
  ] as const)("a Container application %s whose ID is not the namespace the release binds is not this publish's", async (_name, created, deployFailure) => {
    const root = await deployableProject();
    cloud.deployFailure = deployFailure;
    // Both of Cloudflare's reads of the application agree on the ID, and the ID is the wrong one.
    if (created) cloud.createdId = "f".repeat(32);
    else cloud.containers.add("account-test/eve-deploy-fixture-container#" + "f".repeat(32));
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    if (deployFailure !== undefined) expect(cloud.triggers).toEqual([]);
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["the Container application is read", "/containers/applications", false, 0],
    ["the Container application is found missing", "/containers/applications", true, 0],
    ["the triggers are refused once", undefined, false, 1],
  ] as const)("a release that another replaces while %s gets no further write from Eden", async (_name, at, absent, triggerFailures) => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.triggerFailures = triggerFailures;
    if (!absent) cloud.containers.add("account-test/eve-deploy-fixture-container#" + cloud.namespace);
    const replace = () => { cloud.stamps = [{ type: "plain_text", name: "EDEN_EVE_RELEASE_ID", text: "eve-deploy-another" }]; };
    let writes = 0;
    cloud.onRead = () => { if (at !== undefined && cloud.apiReads.at(-1)?.url.includes(at) === true) replace(); };
    // The publish itself is the first write; the one after it is Eden's.
    cloud.onMutation = () => { if ((writes += 1) === 2 && at === undefined) replace(); };
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect(cloud.triggers).toEqual([]);
    expect(writes).toBe(at === undefined ? 2 : 1);
  });

  test.each([
    ["a second binding of the Container class", { type: "durable_object_namespace", name: "OTHER", class_name: "EveHostDurableContainer", namespace_id: "e".repeat(32) }],
    ["a second binding with the Container's name", { type: "durable_object_namespace", name: "EVE_CONTAINER", class_name: "Other", namespace_id: "e".repeat(32) }],
    ["a second release stamp", { type: "plain_text", name: "EDEN_EVE_RELEASE_ID", text: "eve-deploy-another" }],
  ] as const)("a Worker version with %s is not finished: Eden creates nothing for it", async (_name, binding) => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.moreBindings = [binding];
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect({ containers: [...cloud.containers], triggers: cloud.triggers }).toEqual({ containers: [], triggers: [] });
  });

  test("a Container binding that names a class in another Worker is not finished", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.bindingScript = "another-worker";
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect({ containers: [...cloud.containers], triggers: cloud.triggers }).toEqual({ containers: [], triggers: [] });
  });

  test("a create that exits 0 and leaves no Container application is not finished: no triggers", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.createLost = true;
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect(cloud.triggers).toEqual([]);
  });

  test("after a publish cf called done, a Container application with another namespace is not a publication", async () => {
    const root = await deployableProject();
    cloud.application = (real) => ({ ...real, durable_objects: { namespace_id: "e".repeat(32) } });
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("after a publish cf called done, a release replaced while its Container application is read is not a publication", async () => {
    const root = await deployableProject();
    cloud.onRead = () => {
      // The read of the one application, by its ID, comes after the read of the release in service.
      if (cloud.apiReads.at(-1)?.url.endsWith("/containers/applications/" + cloud.namespace) === true) {
        cloud.stamps = [{ type: "plain_text", name: "EDEN_EVE_RELEASE_ID", text: "eve-deploy-another" }];
      }
    };
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("after a publish cf called done, a Worker serving another release is not a publication", async () => {
    const root = await deployableProject();
    cloud.onRead = () => {
      if (cloud.triggers.length > 0) cloud.stamps = [{ type: "plain_text", name: "EDEN_EVE_RELEASE_ID", text: "eve-deploy-another" }];
    };
    const { exitCode, result } = await deploy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
  });

  test("a Worker whose deployments vanish between destroy's two reads is not proven: destroy deletes nothing", async () => {
    const { root, current } = await deployedProject();
    cloud.workers.add("account-test/eve-destroy-fixture");
    cloud.containers.add("account-test/eve-destroy-fixture-container#container-123");
    cloud.onWorkerRead = (nth) => { cloud.deployments = nth === 0 ? 1 : 0; };
    const { exitCode } = await destroy(root);
    expect(exitCode).toBe(1);
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a publish deadline that passes during a read stops Eden before its next write", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    const real = performance.now.bind(performance);
    let skipped = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => real() + skipped);
    // The first read of the Worker version answers after the deadline.
    cloud.onRead = () => { skipped = 16 * 60_000; };
    const { exitCode, result } = await deploy(root).finally(() => clock.mockRestore());
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect({ containers: [...cloud.containers], triggers: cloud.triggers }).toEqual({ containers: [], triggers: [] });
    expect(cloud.runs.at(-1)?.args[0]).toBe("deploy");
    expect(cloud.apiReads.at(-1)?.url).toMatch(/\/versions\/[0-9a-f-]{36}$/u);
  });

  test("a publish cf called done after the deadline is not promoted, and Eden starts no other command", async () => {
    const root = await deployableProject();
    const real = performance.now.bind(performance);
    let skipped = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => real() + skipped);
    cloud.onMutation = () => { skipped = 16 * 60_000; };
    const { exitCode, result } = await deploy(root).finally(() => clock.mockRestore());
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect(cloud.runs.at(-1)?.args[0]).toBe("deploy");
    await expect(lstat(join(root, ".eden", "eve-deploy", "targets", "preview-eve-deploy-fixture", "CURRENT"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a publish Eden cannot finish names the next commands, and destroy then removes the Worker it left", async () => {
    const root = await deployableProject();
    cloud.deployFailure = "after-upload";
    cloud.createFails = true;
    const failed = await deploy(root);
    expect({ exitCode: failed.exitCode, code: failed.result.error?.code }).toEqual({ exitCode: 1, code: "DEPLOY_INDETERMINATE" });
    expect((failed.result.error as { readonly remediation?: string }).remediation).toMatch(/eden deploy again.*eden destroy/u);
    expect({ workers: [...cloud.workers], containers: [...cloud.containers] }).toEqual({ workers: [worker], containers: [] });
    const generations = join(root, ".eden", "eve-deploy", "generations");
    const [generation] = await readdir(generations);
    // What cf printed for the publish and for the command that failed is kept for the user.
    await expect(readFile(join(generations, generation ?? "", "worker", "cf-deploy.log"), "utf8"))
      .resolves.toMatch(/cf containers applications create: exit 1/u);
    const destroyed = await destroyDeployed(root);
    expect({ exitCode: destroyed.exitCode, status: destroyed.result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.deleted).toEqual(["worker:" + worker]);
    expect([...cloud.workers]).toEqual([]);
  });
});

describe("cf runs where nothing of the user's can choose the account or the credentials (MOI-254)", () => {
  test("every cf command of a deploy and a destroy gets a private folder, an empty config, and a fixed environment", async () => {
    const root = await deployableProject();
    await writeFile(join(root, "cloudflare.config.ts"), "throw new Error('the project config ran');\n", "utf8");
    await writeFile(join(root, ".env"), "CLOUDFLARE_ACCOUNT_ID=" + "9".repeat(32) + "\n", "utf8");
    vi.stubEnv("CLOUDFLARE_API_BASE_URL", "https://example.invalid/client/v4");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("EDEN_TEST_UNRELATED_SECRET", "unrelated-secret");
    vi.stubEnv("CLOUDFLARE_AUTH_PROFILE", "work");
    vi.stubEnv("CLOUDFLARE_AUTH_USE_KEYRING", "true");
    const account = "1".repeat(32);
    cloud.whoami = () => account;
    expect((await deploy(root, "generation-one", { account, push: true, ownChecks: true })).exitCode).toBe(0);
    expect(cloud.runs.length).toBeGreaterThan(3);
    for (const run of cloud.runs) {
      expect(run.cwd.startsWith(root)).toBe(false);
      expect(run.config).toBe("export default {};\n");
      expect(run.env.CLOUDFLARE_API_BASE_URL).toBe("https://api.cloudflare.com/client/v4");
      expect(run.env.EDEN_TEST_UNRELATED_SECRET).toBeUndefined();
      // The login is named in every command, so no folder's binding chooses another.
      expect({ profile: run.env.CLOUDFLARE_AUTH_PROFILE, keyring: run.env.CLOUDFLARE_AUTH_USE_KEYRING, delegation: run.env.CF_DELEGATION })
        .toEqual({ profile: "work", keyring: "true", delegation: "1" });
      // Only the login check runs without an account.
      expect(run.env.CLOUDFLARE_ACCOUNT_ID).toBe(run.args.join(" ") === "auth whoami" ? "" : account);
    }
  });

  test("the Build Output Eden publishes names the checked account", async () => {
    const root = await deployableProject();
    const account = "1".repeat(32);
    cloud.whoami = () => account;
    expect((await deploy(root, "generation-one", { account, push: true, ownChecks: true })).exitCode).toBe(0);
    const config = JSON.parse(await readFile(
      join(root, ".eden", "eve-deploy", "generations", "generation-one", "worker", ".cloudflare", "output", "v1", "config.json"),
      "utf8",
    )) as unknown;
    expect(config).toMatchObject({ settings: { accountId: account } });
  });
});

describe("Eden reads Cloudflare's API with the token of cf's login, or with CLOUDFLARE_API_TOKEN", () => {
  const account = "1".repeat(32);
  const access = (result: DeployResult) => result.checks?.find((check) => check.id === "VAL-CLI-007-CLOUDFLARE-ACCESS");

  test("a deploy takes the login's token from cf on 127.0.0.1 and sends it to api.cloudflare.com only", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    const output: string[] = [];
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true, output });
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect(cloud.captures.length).toBeGreaterThan(0);
    for (const address of cloud.captures) expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/client\/v4$/u);
    expect(cloud.apiReads.length).toBeGreaterThan(5);
    for (const read of cloud.apiReads) {
      expect(read.url.startsWith("https://api.cloudflare.com/client/v4/accounts/" + account + "/")).toBe(true);
      expect(read.authorization).toBe("Bearer " + cloud.loginToken);
    }
    // The token is in no cf command's arguments, files or environment, and in nothing Eden printed or kept.
    expect(JSON.stringify(cloud.runs) + output.join("\n")).not.toContain(cloud.loginToken);
    const kept = await readdir(join(root, ".eden"), { recursive: true, withFileTypes: true });
    for (const entry of kept.filter((file) => file.isFile())) {
      expect(await readFile(join(entry.parentPath, entry.name), "utf8")).not.toContain(cloud.loginToken);
    }
  });

  test("with CLOUDFLARE_API_TOKEN set, Eden reads with it and asks cf for nothing", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "an-api-token-from-the-environment");
    const { exitCode } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect(exitCode).toBe(0);
    expect(cloud.captures).toEqual([]);
    expect(new Set(cloud.apiReads.map((read) => read.authorization))).toEqual(new Set(["Bearer an-api-token-from-the-environment"]));
  });

  test.each([
    ["sends no token", () => { cloud.tokenWithheld = true; }],
    ["is not the cf version Eden pins", () => { cloud.agent = "cf-cli/9.9.9"; }],
    ["sends a token that is not a bearer token", () => { cloud.loginToken = "short"; }],
  ] as const)("a cf that %s stops the deploy at the access check, before any write", async (_name, arrange) => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    arrange();
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DEPLOY_CHECKS_FAILED" });
    expect(access(result)).toMatchObject({
      status: "blocked",
      remediation: expect.stringMatching(/could not take its login's token.*auth whoami --profile default.*set CLOUDFLARE_API_TOKEN/u) as unknown,
    });
    expect({ pinned: cloud.pinned, pushed: cloud.pushed, workers: [...cloud.workers], reads: cloud.readAccounts })
      .toEqual({ pinned: [], pushed: [], workers: [], reads: [] });
  });

  test("a cf that sends no token stops destroy with its own code, and nothing is deleted", async () => {
    const { root, current } = await deployedProject();
    cloud.workers.add("account-test/eve-destroy-fixture");
    cloud.tokenWithheld = true;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_CF_LOGIN_TOKEN_UNAVAILABLE" });
    expect(result.error?.remediation).toMatch(/set CLOUDFLARE_API_TOKEN/u);
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a login token Cloudflare stops accepting is taken from cf once more", async () => {
    const { root } = await deployedProject();
    cloud.workers.add("account-test/eve-destroy-fixture");
    cloud.containers.add("account-test/eve-destroy-fixture-container#container-123");
    cloud.rejectedReads = 1;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, status: result.status }).toEqual({ exitCode: 0, status: "destroyed" });
    expect(cloud.captures.length).toBeGreaterThanOrEqual(2);
  });

  test("an API token Cloudflare does not accept is not replaced by the login's: destroy stops", async () => {
    const { root, current } = await deployedProject();
    cloud.workers.add("account-test/eve-destroy-fixture");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "an-api-token-from-the-environment");
    cloud.rejectedReads = 100;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect({ captures: cloud.captures, deleted: cloud.deleted }).toEqual({ captures: [], deleted: [] });
    await expect(lstat(current)).resolves.toBeDefined();
  });
});

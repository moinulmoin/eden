import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    /** The account cf's login names: the one whoami named last. */
    loginAccount: "account-test",
    workers: new Set<string>(),
    containers: new Set<string>(),
    tags: [] as string[],
    /** When set, what "cf workers deployments list" prints and exits with. */
    workerFailure: undefined as CfResult | undefined,
    /** When set, what "cf workers get" prints and exits with. */
    workerGet: undefined as CfResult | undefined,
    /** How many reads of the Worker's deployments answer that it does not exist before they show it. */
    hiddenReads: 0,
    /** Called before each read of the Worker's deployments, with the read's number from 0. */
    onWorkerRead: (() => undefined) as (nth: number) => unknown,
    workerReads: 0,
    /** How many deployments cf lists for a Worker that exists. */
    deployments: 1,
    /** When set, the deployments cf lists, whatever they are. */
    deploymentEntries: undefined as readonly unknown[] | undefined,
    /** When set, what "cf containers applications list" prints and exits with, given its true entries. */
    containerAnswer: undefined as ((entries: string) => CfResult) | undefined,
    /** The plain-text bindings of the Worker: what the last publish stamped. */
    stamps: [] as { readonly type: string; readonly name: string; readonly text: string }[],
    /** Called before each cf command that changes the account. */
    onMutation: (() => undefined) as () => void,
    /** Called before each cf read other than whoami. */
    onRead: (() => undefined) as () => void,
    /** The account each cf read ran against. */
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
    /**
     * A stand-in for an account that has no Worker: "cf workers list" prints an
     * empty list. No such account was available to capture.
     */
    newAccount: false,
    /** A stand-in for an account with no workers.dev subdomain: a Worker's subdomain carries no URL. Not captured. */
    noSubdomain: false,
    /** Whether Cloudflare fails to delete the temporary Worker. */
    probeStays: false,
    /** Each temporary Worker cf deployed, as account/worker. */
    probes: [] as string[],
    /** When set, how "cf deploy" exits 1: before it uploads anything, or with the Worker version live and no Container application. */
    deployFailure: undefined as "before-upload" | "after-upload" | undefined,
    /** Whether "cf containers applications create" fails. */
    createFails: false,
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
  const command = [
    "auth whoami", "workers deployments list", "workers versions get", "workers versions list", "workers list", "workers get",
    "workers delete", "workers secrets bulk-edit", "workers triggers deploy", "containers applications list",
    "containers applications get", "containers applications create", "containers applications delete",
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
    return ok({ authenticated: true, tokenValid: true, accounts: [{ id: cloud.loginAccount }] });
  }
  // cf acts on CLOUDFLARE_ACCOUNT_ID when it is set, else on its login's account.
  const pinned = env.CLOUDFLARE_ACCOUNT_ID || undefined;
  const flag = (name: string): string => args[args.indexOf(name) + 1] ?? "";
  if (command === "workers deployments list") {
    const account = pinned ?? cloud.loginAccount;
    cloud.readAccounts.push(account);
    await cloud.onWorkerRead(cloud.workerReads++);
    if (cloud.workerFailure !== undefined) return cloud.workerFailure;
    if (cloud.hiddenReads-- > 0 || !cloud.workers.has(account + "/" + flag("--worker"))) {
      return cloud.apiError(10007, "This Worker does not exist on your account.", "404 Not Found", "/accounts/" + account + "/workers/scripts/" + flag("--worker") + "/deployments");
    }
    return ok({
      deployments: cloud.deploymentEntries ?? Array.from({ length: cloud.deployments }, (_, nth) => ({
        id: "deployment-" + nth,
        source: "cf_cli",
        versions: [{ version_id: "00000000-0000-4000-8000-00000000000" + nth, percentage: 100 }],
        created_on: "2026-11-20T11:38:3" + nth + ".845435Z",
      })),
    });
  }
  const reads = ["workers get", "workers versions get", "workers versions list", "containers applications list", "containers applications get", "workers list", "containers registries credentials"];
  if (reads.includes(command)) {
    cloud.onRead();
    const account = pinned ?? cloud.loginAccount;
    cloud.readAccounts.push(account);
    if (command === "workers get") {
      if (cloud.workerGet !== undefined) return cloud.workerGet;
      return cloud.workers.has(account + "/" + args[2])
        // The subdomain object as cf printed it for a Worker deployed with no URL on 2026-11-20.
        ? ok({
          name: args[2],
          subdomain: {
            enabled: false,
            previews_enabled: false,
            ...(cloud.noSubdomain ? {} : { url: "https://" + String(args[2]) + ".account.workers.dev" }),
          },
        })
        : cloud.apiError(10007, "This Worker does not exist on your account.", "404 Not Found", "/accounts/" + account + "/workers/workers/" + args[2]);
    }
    if (command === "workers versions get") {
      return ok({
        id: args[3],
        bindings: [...cloud.stamps, { type: "durable_object_namespace", name: "EVE_CONTAINER", class_name: "EveHostDurableContainer", namespace_id: cloud.namespace }],
      });
    }
    if (command === "workers versions list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ id: "00000000-0000-4000-8000-000000000001", number: 1 }]),
        stderr: 'result_info: {"page":1,"per_page":10,"count":1,"total_count":1}\n',
      };
    }
    if (command === "containers applications list") {
      const entries = [...cloud.containers].flatMap((entry) => {
        const [owner, rest = ""] = entry.split("/");
        const [application, id] = rest.split("#");
        return owner === account && application === flag("--name") ? [{ id, name: application }] : [];
      });
      return cloud.containerAnswer?.(JSON.stringify(entries)) ?? ok(entries);
    }
    if (command === "containers applications get") {
      return [...cloud.containers].some((entry) => entry.startsWith(account + "/") && entry.endsWith("#" + args[3]))
        ? ok({ id: args[3], scheduling_policy: "durable_object", durable_objects: { namespace_id: cloud.namespace } })
        : cloud.apiError(1609, "Container application not found: " + args[3], "404 Not Found", "/accounts/" + account + "/containers/applications/" + args[3]);
    }
    if (command === "workers list") {
      return ok(cloud.newAccount ? [] : [{ name: "another", subdomain: { enabled: true, url: "https://another.account.workers.dev" } }]);
    }
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
    if (worker.name.startsWith("eden-origin-probe-")) {
      cloud.probes.push(published + "/" + worker.name + (existsSync(join(cwd, "cloudflare.config.ts")) ? "" : " without an inert config"));
      cloud.workers.add(published + "/" + worker.name);
      return { exitCode: 0 };
    }
    if (command === "workers triggers deploy") {
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
        stderr: "\n┌ Error\n│ The Worker version was deployed, but its Durable Object-managed Container\n│ application settings were not fully applied. Re-run the same `cf deploy`\n│ command to retry and finish deployment.\n└\n",
      };
    }
    cloud.containers.add(published + "/" + worker.name + "-container#" + cloud.namespace);
    cloud.triggers.push(published + "/" + worker.name);
    return { exitCode: 0 };
  }
  if (command === "containers applications create") {
    if (cloud.createFails) return cloud.apiError(1000, "Internal error", "500 Internal Server Error", "/accounts/" + account + "/containers/applications");
    const body = JSON.parse(flag("--body")) as { readonly name: string; readonly durable_objects: { readonly namespace_id: string } };
    cloud.containers.add(account + "/" + body.name + "#" + body.durable_objects.namespace_id);
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
    if (cloud.probeStays && String(args[2]).startsWith("eden-origin-probe-")) {
      return cloud.apiError(10013, "An unknown error has occurred.", "500 Internal Server Error", "/accounts/" + account + "/workers/workers/" + args[2]);
    }
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
  Object.assign(cloud, {
    active: true,
    whoami: () => "account-test",
    whoamiCalls: 0,
    loginAccount: "account-test",
    workers: new Set<string>(),
    containers: new Set<string>(),
    tags: [],
    workerFailure: undefined,
    workerGet: undefined,
    hiddenReads: 0,
    onWorkerRead: () => undefined,
    workerReads: 0,
    deployments: 1,
    deploymentEntries: undefined,
    containerAnswer: undefined,
    stamps: [{ type: "plain_text", name: "EDEN_EVE_DEPLOYMENT_ID", text: "eve-deploy-test" }],
    onMutation: () => undefined,
    onRead: () => undefined,
    readAccounts: [],
    pinned: [],
    newAccount: false,
    noSubdomain: false,
    probeStays: false,
    probes: [],
    deployFailure: undefined,
    createFails: false,
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const deploymentsPath = "/accounts/account-test/workers/scripts/eve-destroy-fixture/deployments";
const missingWorker = cloud.apiError(10007, "This Worker does not exist on your account.", "404 Not Found", deploymentsPath);
/**
 * What cf can print for the Worker's deployments that is not Cloudflare's
 * own answer that this Worker does not exist. The authentication error is
 * the form cf 1.0.0-rc.2 printed on 2026-11-20.
 */
const failures = {
  "an authentication error (captured form)": {
    exitCode: 1,
    stderr: cloud.apiError(10000, "Authentication error", "403 Forbidden", deploymentsPath).stderr + "→ Check your API token permissions\n",
  },
  "an authentication error on an account whose id contains 10007": cloud.apiError(
    10000, "Authentication error", "403 Forbidden", "/accounts/ab10007cdef0123456789abcdef01234/workers/scripts/eve-destroy-fixture/deployments",
  ),
  "a 404 with another error code": cloud.apiError(10404, "No route for that URI", "404 Not Found", deploymentsPath),
  "code 10007 on a status other than 404": cloud.apiError(10007, "Bad gateway", "502 Bad Gateway", deploymentsPath),
  "the missing-Worker answer for another Worker's path": cloud.apiError(
    10007, "This Worker does not exist on your account.", "404 Not Found", "/accounts/account-test/workers/scripts/another/deployments",
  ),
  "the missing-Worker answer for another account's path": cloud.apiError(
    10007, "This Worker does not exist on your account.", "404 Not Found", "/accounts/account-other/workers/scripts/eve-destroy-fixture/deployments",
  ),
  "an error that names code 10000 and code 10007": {
    exitCode: 1,
    stderr: "\n┌ APIError\n│ [10000] Authentication error\n│ [10007] This Worker does not exist on your account.\n│ 404 Not Found · HTTP " + deploymentsPath + "\n└\n",
  },
  "the missing-Worker answer twice": { exitCode: 1, stderr: (missingWorker.stderr ?? "").repeat(2) },
  "the missing-Worker answer after a line cf never printed there": { exitCode: 1, stderr: "warning: using a cached answer\n" + (missingWorker.stderr ?? "") },
  "the missing-Worker answer beside a list of deployments": { exitCode: 1, stdout: '{"deployments":[{"id":"deployment-1"}]}', stderr: missingWorker.stderr },
  "the missing-Worker answer and exit code 2": { exitCode: 2, stderr: missingWorker.stderr },
  "the missing-Worker answer from a cf that was killed": { exitCode: null, stderr: missingWorker.stderr },
  "the missing-Worker answer and exit code 0": { exitCode: 0, stderr: missingWorker.stderr },
  "a network failure": { exitCode: 1, stderr: "\n┌ Error\n│ fetch failed\n└\n" },
  "a gateway's 404 Not Found page": { exitCode: 1, stderr: "\n┌ Error\n│ <html><head><title>404 Not Found</title></head></html>\n└\n" },
  "output that is not JSON": { exitCode: 0, stdout: "not json" },
  "no output at all": { exitCode: 1 },
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
  { account = "account-test", envFile, push = false, ownChecks = false }: { readonly account?: string; readonly envFile?: string; readonly push?: boolean; /** Eden's own account checks run, not a supplied result. */ readonly ownChecks?: boolean } = {},
): Promise<{ readonly exitCode: number; readonly result: DeployResult }> {
  const output: string[] = [];
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
    ["an authentication error", () => cloud.apiError(10000, "Authentication error", "403 Forbidden", "/accounts/account-test/containers/applications?name=eve-destroy-fixture-container")],
    ["an empty list and exit code 1", () => ({ exitCode: 1, stdout: "[]" })],
    ["an empty list from a cf that was killed", () => ({ exitCode: null, stdout: "[]" })],
    ["an object instead of a list", () => ({ exitCode: 0, stdout: '{"result":[]}' })],
    ["an empty list and paging facts cf printed twice", () => ({ exitCode: 0, stdout: "[]", stderr: 'result_info: {"count":0}\nresult_info: {"count":1}\n' })],
    ["an empty list and paging facts that are not JSON", () => ({ exitCode: 0, stdout: "[]", stderr: "result_info: <html>\n" })],
    ["100 other applications and no paging facts", () => ({ exitCode: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, nth) => ({ id: "other-" + nth, name: "another-container" }))) })],
    ["the live application and exit code 1", (entries: string) => ({ exitCode: 1, stdout: entries })],
  ] as const)("a Container answer of %s is no proof of absence and names nothing to delete", async (_name, answer) => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.tags = ["candidate"];
    cloud.containerAnswer = answer;
    const { exitCode, result } = await destroy(root);
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DESTROY_INDETERMINATE" });
    expect(cloud.deleted).toEqual([]);
    await expect(lstat(current)).resolves.toBeDefined();
  });

  test("a Container answer that cannot be read after the deletes leaves CURRENT in place", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add(container);
    cloud.onMutation = () => {
      cloud.containerAnswer = () => ({ exitCode: 1, stdout: "[]" });
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
    // The paging line is in the form cf printed on 2026-11-20.
    cloud.containerAnswer = (entries) => ({
      exitCode: 0,
      stdout: entries.replace('"name"', '"note":"a\\/b \\u0026 c","size":1.0,"name"'),
      stderr: 'result_info: {"page":1,"per_page":20,"count":1,"total_count":1}\n',
    });
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

  test("with Eden's own checks and a steady login, the deploy lands in the checked account", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect([...cloud.workers]).toEqual([account + "/eve-deploy-fixture"]);
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

  test("a Worker that one of Cloudflare's two reads still shows is not absent: destroy stops", async () => {
    const { root, current } = await deployedProject();
    cloud.containers.add("account-test/eve-destroy-fixture-container#container-123");
    cloud.workerGet = { exitCode: 0, stdout: '{"name":"eve-destroy-fixture"}' };
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
    const account = "1".repeat(32);
    cloud.whoami = () => account;
    expect((await deploy(root, "generation-one", { account, push: true, ownChecks: true })).exitCode).toBe(0);
    expect(cloud.runs.length).toBeGreaterThan(5);
    for (const run of cloud.runs) {
      expect(run.cwd.startsWith(root)).toBe(false);
      expect(run.config).toBe("export default {};\n");
      expect(run.env.CLOUDFLARE_API_BASE_URL).toBe("https://api.cloudflare.com/client/v4");
      expect(run.env.EDEN_TEST_UNRELATED_SECRET).toBeUndefined();
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

describe("the first deploy on a Cloudflare account that has no Worker yet", () => {
  const account = "1".repeat(32);
  const origin = (result: DeployResult) => result.checks?.find((check) => check.id === "VAL-HOST-006");

  test("deploys, after a temporary Worker with no URL showed the workers.dev subdomain and was deleted", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    cloud.newAccount = true;
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect({ exitCode, ok: result.ok }).toEqual({ exitCode: 0, ok: true });
    expect(cloud.probes).toEqual([expect.stringMatching(new RegExp("^" + account + "/eden-origin-probe-[0-9a-f]{8}$", "u"))]);
    expect(cloud.deleted).toEqual(["worker:" + String(cloud.probes[0])]);
    expect([...cloud.workers]).toEqual([account + "/eve-deploy-fixture"]);
    expect(cloud.stamps).toContainEqual({ type: "plain_text", name: "EVE_PUBLIC_ORIGIN", text: "https://eve-deploy-fixture.account.workers.dev" });
  });

  test("an account with no workers.dev subdomain stops the deploy with the page that registers one", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    cloud.newAccount = true;
    cloud.noSubdomain = true;
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    expect({ exitCode, code: result.error?.code }).toEqual({ exitCode: 1, code: "EVE_DEPLOY_CHECKS_FAILED" });
    expect(origin(result)).toMatchObject({
      status: "failed",
      message: "Cloudflare gave no workers.dev URL for a Worker of this account.",
      remediation: "Register the account's workers.dev subdomain at https://dash.cloudflare.com/" + account +
        "/workers/onboarding, then run the command again.",
    });
    expect({ workers: [...cloud.workers], pushed: cloud.pushed }).toEqual({ workers: [], pushed: [] });
  });

  test("a temporary Worker that Cloudflare does not delete is named with the command that deletes it", async () => {
    const root = await deployableProject();
    cloud.whoami = () => account;
    cloud.newAccount = true;
    cloud.probeStays = true;
    const { exitCode, result } = await deploy(root, "generation-one", { account, push: true, ownChecks: true });
    const name = String(cloud.probes[0]).split("/")[1];
    expect(exitCode).toBe(1);
    expect(origin(result)).toMatchObject({
      status: "failed",
      remediation: "Run npx cf@1.0.0-rc.2 workers delete " + String(name) + " --force, then run the command again.",
    });
    expect(cloud.pushed).toEqual([]);
  });
});

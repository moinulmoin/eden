import type * as ChildProcess from "node:child_process";
import type * as Https from "node:https";
import type * as TimersPromises from "node:timers/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  EVE_CLI_COMMANDS,
  EveCliError,
  deriveEveTargetName,
  parseEveArguments,
  runEdenCli,
  type EveCliHelp,
} from "../src/index.js";
import type {
  EveDeploymentHealthRequest,
  EveDeploymentPublicationRequest,
  EvePreflightRuntimeRunnerRequest,
} from "../src/index.js";
import type { EveProjectBuilderRequest } from "../src/eve-packaging.js";
import type { EveProjectBuilder } from "../src/eve-packaging.js";
import { exactTargetContainerEntries } from "../src/eve-control-plane.js";

const roots: string[] = [];

/**
 * cf is spawned as `node <cf's bin/cf> ...args`. While `intercept` is set,
 * each spawn is replaced by a child that gives the next answer, or exits 1
 * with no output, and the deadline armed immediately after each spawn is
 * recorded.
 */
const fakeCf = vi.hoisted(() => ({
  intercept: false,
  pending: undefined as readonly string[] | undefined,
  calls: [] as { readonly args: readonly string[]; readonly timeoutMs: unknown }[],
  /** What each spawn in turn prints and exits with. */
  answers: [] as { readonly exitCode: number | null; readonly stdout?: string; readonly stderr?: string }[],
}));

/**
 * A stand-in for Cloudflare's registry. While `active`, a request to the
 * registry lists `entries` or gets `answer(ref)` for a delete, and cf's
 * `containers images delete` and `containers registries credentials generate`
 * run against the same state. `auth whoami` names `whoamiAccountId()`, and
 * Cloudflare's API, read with CLOUDFLARE_API_TOKEN, reports the exact Worker
 * and Container application absent, in the forms it answered with on
 * 2026-11-20. Any other cf command fails.
 */
const fakeRegistry = vi.hoisted(() => {
  type Answer =
    | { readonly status: number; readonly body: string; readonly link?: string; readonly digest?: string; readonly leavesAfterMs?: number }
    | "error"
    | "stall";
  const state = {
    active: false,
    /** What the registry lists per repository: tags, and one `sha256:` entry per manifest. */
    entries: new Map<string, string[]>(),
    /** The digest the registry answers a HEAD for a listed `repository:tag` with; any other tag gets 404. */
    digests: new Map<string, string>(),
    pageSize: 1_000,
    /** Whether cf's delete of a tag succeeds; the tag then leaves the listing. */
    deletable: (() => true) as (ref: string) => boolean,
    /**
     * Whether cf's delete of a tag never exits, as cf 1.0.0-rc.2's did on
     * 2026-11-26 when the registry did not answer the request to collect
     * layers that cf sends after the tag delete: `after-delete` deletes the
     * tag first, `before-delete` deletes nothing.
     */
    cfHangs: undefined as "after-delete" | "before-delete" | undefined,
    /** Whether a cf that never exits stops when it is killed. */
    cfStopsOnKill: true,
    /** Set while a cf that never exits is running. */
    cfHanging: false,
    /** The registry's answer to a GET of a manifest; by default 200 for a listed entry, else MANIFEST_UNKNOWN. */
    manifestRead: (() => undefined) as (ref: string) => Answer | undefined,
    /** The registry's answer to Eden's own delete; `leavesAfterMs` takes the entry out of the listing that much later. */
    answer: (() => ({ status: 404, body: "" })) as (ref: string) => Answer,
    /**
     * Called for each page of a listing, with the listing's number from 0
     * and the cursor (`null` on the first page). It may change `entries`, or
     * return the page itself.
     */
    listing: (() => undefined) as (repository: string, nth: number, last: string | null) => Answer | undefined,
    whoamiAccountId: (() => "account-test") as () => string,
    /** Called when destroy reads the target, with the read's number from 0. */
    onRead: (() => undefined) as (nth: number) => void,
    reads: 0,
    cfFailure: ((ref) => `Failed to delete ${ref} (digest: sha256:${"0".repeat(64)}): 403 Forbidden`) as (
      ref: string,
    ) => string,
    credentialAccountId: "account-test",
    /** What `performance.now()` returns while a command runs against the fake registry. */
    clock: 0,
    leaving: [] as { readonly repository: string; readonly entry: string; readonly at: number }[],
    cfDeletes: [] as string[],
    credentialCalls: 0,
    listings: 0,
    registryRequests: [] as {
      readonly ref: string;
      readonly host: unknown;
      readonly method: unknown;
      readonly ownAgent: boolean;
      readonly verifiesPeer: boolean;
      readonly authorized: boolean;
    }[],
    ref: (repository: string, entry: string): string =>
      `${repository}${entry.startsWith("sha256:") ? "@" : ":"}${entry}`,
    /** What the registry lists for a repository now, in the registry's order. */
    listed: (repository: string): string[] => {
      for (const leave of state.leaving.filter((item) => state.clock >= item.at)) {
        state.entries.set(
          leave.repository,
          (state.entries.get(leave.repository) ?? []).filter((entry) => entry !== leave.entry),
        );
      }
      state.leaving = state.leaving.filter((item) => state.clock < item.at);
      return [...(state.entries.get(repository) ?? [])].sort();
    },
  };
  return state;
});

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof TimersPromises>();
  return {
    ...actual,
    // While the fake registry runs, a wait only moves its clock.
    setTimeout: ((...waitArgs: Parameters<typeof actual.setTimeout>) => {
      if (fakeCf.intercept) return Promise.resolve();
      if (!fakeRegistry.active) return actual.setTimeout(...waitArgs);
      fakeRegistry.clock += waitArgs[0] ?? 0;
      return Promise.resolve();
    }) as typeof actual.setTimeout,
  };
});

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof Https>();
  return {
    ...actual,
    request: ((options: Https.RequestOptions, onResponse: (response: EventEmitter) => void) => {
      if (!fakeRegistry.active) {
        return actual.request(options, onResponse as Parameters<typeof actual.request>[1]);
      }
      const url = new URL(String(options.path), "https://registry.cloudflare.com");
      const [, , account = "", repository = "", kind = "", entry = ""] = url.pathname.split("/");
      const ref = kind === "tags" ? repository : fakeRegistry.ref(repository, entry);
      fakeRegistry.registryRequests.push({
        ref,
        host: options.host,
        method: options.method,
        ownAgent: options.agent instanceof actual.Agent && options.agent !== actual.globalAgent,
        verifiesPeer: options.rejectUnauthorized === true,
        authorized: typeof (options.headers as Record<string, unknown>).Authorization === "string",
      });
      const request = Object.assign(new EventEmitter(), {
        destroy: () => undefined,
        end: () => setImmediate(() => {
          const last = url.searchParams.get("last");
          if (kind === "tags" && last === null) fakeRegistry.listings += 1;
          const named = fakeRegistry.listed(repository).includes(entry) ? fakeRegistry.digests.get(ref) : undefined;
          let answer = kind === "tags"
            ? fakeRegistry.listing(repository, fakeRegistry.listings - 1, last)
            : options.method === "HEAD"
            ? { status: named === undefined ? 404 : 200, body: "", ...(named === undefined ? {} : { digest: named }) }
            : options.method === "GET"
            ? fakeRegistry.manifestRead(ref) ?? (fakeRegistry.listed(repository).includes(entry)
              ? { status: 200, body: "{}" }
              // The registry's answer on 2026-11-26 for a tag or digest it does not know.
              : { status: 404, body: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown", detail: { Tag: entry } }] }) })
            : fakeRegistry.answer(ref);
          if (answer === undefined) {
            const tags = fakeRegistry.listed(repository)
              .filter((listed) => last === null || listed > last)
              .slice(0, Math.min(Number(url.searchParams.get("n")), fakeRegistry.pageSize));
            answer = {
              status: 200,
              body: JSON.stringify({ name: `${account}/${repository}`, tags }),
              // The form observed on 2026-11-18: the request's URL, then a second query.
              link: `https://registry.cloudflare.com${String(options.path)}?n=1000&last=${tags.at(-1) ?? ""}; rel=next`,
            };
          }
          if (answer === "error" || answer === "stall") {
            // A wait that ends on the deadline; the monotonic clock is not a whole number.
            if (answer === "stall") fakeRegistry.clock += 30_000.25;
            request.emit("error", new Error("The connection failed."));
            return;
          }
          if (answer.leavesAfterMs !== undefined) {
            fakeRegistry.leaving.push({ repository, entry, at: fakeRegistry.clock + answer.leavesAfterMs });
          }
          const response = Object.assign(new EventEmitter(), {
            statusCode: answer.status,
            headers: {
              ...(answer.link === undefined ? {} : { link: answer.link }),
              ...(answer.digest === undefined ? {} : { "docker-content-digest": answer.digest }),
            },
          });
          onResponse(response);
          response.emit("data", Buffer.from(answer.body));
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
  /** What cf prints and exits with while the fake registry runs. */
  const registryCf = (
    args: readonly string[],
  ): { readonly exitCode: number | undefined; readonly stdout?: string; readonly stderr?: string; readonly hangs?: true } => {
    const line = args.join(" ");
    if (line === "auth whoami") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ authenticated: true, tokenValid: true, accounts: [{ id: fakeRegistry.whoamiAccountId() }] }),
      };
    }
    if (line.startsWith("containers registries credentials generate ")) {
      fakeRegistry.credentialCalls += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          account_id: fakeRegistry.credentialAccountId,
          registry_host: "registry.cloudflare.com",
          username: "v1",
          password: "registry-password",
        }),
      };
    }
    if (line.startsWith("containers images delete ")) {
      const ref = args[3] ?? "";
      const [repository = "", tag = ""] = ref.split(":");
      fakeRegistry.cfDeletes.push(ref);
      if (fakeRegistry.cfHangs === "before-delete") return { exitCode: undefined, hangs: true };
      if (!fakeRegistry.deletable(ref)) {
        // cf prints its own errors on stderr in this form, a long message wrapped at spaces (read on 2026-11-20).
        const wrapped = fakeRegistry.cfFailure(ref).replaceAll(" (digest: ", "\n│ (digest:\n│ ").replace(/ Forbidden$/u, "\n│ Forbidden");
        return { exitCode: 1, stderr: "\n┌ Error\n│ " + wrapped + "\n└\n" };
      }
      fakeRegistry.entries.set(
        repository,
        (fakeRegistry.entries.get(repository) ?? []).filter((present) => present !== tag),
      );
      return fakeRegistry.cfHangs === "after-delete" ? { exitCode: undefined, hangs: true } : { exitCode: 0 };
    }
    return { exitCode: 1, stderr: `Unexpected cf call: ${line}` };
  };
  return {
    ...actual,
    spawn: ((...spawnArgs: Parameters<typeof actual.spawn>) => {
      const argv = spawnArgs[1] as readonly string[];
      if (
        !/[\\/]cf[\\/]bin[\\/]cf$/u.test(argv[0] ?? "") ||
        (!fakeRegistry.active && !fakeCf.intercept)
      ) return actual.spawn(...spawnArgs);
      const args = argv.slice(1);
      let answer: (typeof fakeCf.answers)[number] | ReturnType<typeof registryCf>;
      if (fakeCf.intercept) {
        fakeCf.pending = args;
        answer = fakeCf.answers.shift() ?? { exitCode: 1 };
      } else {
        answer = registryCf(args);
      }
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          if ("hangs" in answer && fakeRegistry.cfStopsOnKill) {
            setImmediate(() => {
              fakeRegistry.cfHanging = false;
              child.emit("exit", null, "SIGKILL");
              child.emit("close", null, "SIGKILL");
            });
          }
          return true;
        },
      });
      if ("hangs" in answer) {
        fakeRegistry.cfHanging = true;
        return child;
      }
      setImmediate(() => {
        if (answer.stdout !== undefined) child.stdout.emit("data", Buffer.from(answer.stdout));
        if (answer.stderr !== undefined) child.stderr.emit("data", Buffer.from(answer.stderr));
        child.emit("close", answer.exitCode);
      });
      return child;
    }) as unknown as typeof actual.spawn,
  };
});

const snapshotRefusal = JSON.stringify({
  errors: [{
    code: "DENIED",
    message: "snapshot manifests cannot be deleted through this API",
    detail: null,
  }],
});
const manifest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const singletonRefusal = JSON.stringify({
  code: "SINGLETON_ARTIFACT_EXISTS",
  subjectDigest: manifest("1"),
  artifactType: "application/vnd.cloudchamber.btrfs-chain.v1",
  committedDigest: manifest("2"),
});
const registryDeletes = (): readonly string[] =>
  fakeRegistry.registryRequests.filter((request) => request.method === "DELETE").map((request) => request.ref);

type FakeRegistrySetup = {
  readonly entries: Readonly<Record<string, readonly string[]>>;
  readonly pageSize?: number;
  readonly deletable?: typeof fakeRegistry.deletable;
  readonly answer?: typeof fakeRegistry.answer;
  readonly listing?: typeof fakeRegistry.listing;
  readonly whoamiAccountId?: typeof fakeRegistry.whoamiAccountId;
  readonly onRead?: typeof fakeRegistry.onRead;
  readonly cfFailure?: typeof fakeRegistry.cfFailure;
  readonly credentialAccountId?: string;
};

function startFakeRegistry(setup: FakeRegistrySetup): void {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "an-api-token");
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    if (!String(input).startsWith("https://api.cloudflare.com/client/v4/accounts/")) throw new TypeError("fetch failed");
    if (path.endsWith("/containers/applications")) {
      return new Response('{"success":true,"result":[],"errors":[],"messages":[],"result_info":{}}');
    }
    if (path.endsWith("/deployments")) fakeRegistry.onRead(fakeRegistry.reads++);
    return new Response(
      '{"result":null,"success":false,"errors":[{"code":10007,"message":"This Worker does not exist on your account."}],"messages":[]}',
      { status: 404 },
    );
  });
  Object.assign(fakeRegistry, {
    active: true,
    entries: new Map(Object.entries(setup.entries).map(([name, entries]) => [name, [...entries]])),
    digests: new Map(),
    pageSize: setup.pageSize ?? 1_000,
    deletable: setup.deletable ?? (() => true),
    cfHangs: undefined,
    cfStopsOnKill: true,
    cfHanging: false,
    manifestRead: () => undefined,
    answer: setup.answer ?? (() => ({ status: 404, body: "" })),
    listing: setup.listing ?? (() => undefined),
    whoamiAccountId: setup.whoamiAccountId ?? (() => "account-test"),
    onRead: setup.onRead ?? (() => undefined),
    reads: 0,
    cfFailure: setup.cfFailure ??
      ((ref: string) => `Failed to delete ${ref} (digest: sha256:${"0".repeat(64)}): 403 Forbidden`),
    credentialAccountId: setup.credentialAccountId ?? "account-test",
    clock: 0,
    leaving: [],
    cfDeletes: [],
    credentialCalls: 0,
    listings: 0,
    registryRequests: [],
  });
}

/** The time cf gets starts before its folder is written, so cf itself gets that time or a little under it. */
const about = (ms: number) => expect.toSatisfy((given: unknown) => typeof given === "number" && given <= ms && given > ms - 5_000);

async function withFakeCf(
  run: () => Promise<void>,
): Promise<readonly { readonly args: readonly string[]; readonly timeoutMs: unknown }[]> {
  const realSetTimeout = globalThis.setTimeout;
  const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(
    ((handler: () => void, timeoutMs?: number) => {
      if (fakeCf.pending !== undefined) {
        fakeCf.calls.push({ args: fakeCf.pending, timeoutMs });
        fakeCf.pending = undefined;
      }
      return realSetTimeout(handler, timeoutMs);
    }) as unknown as typeof setTimeout,
  );
  fakeCf.intercept = true;
  fakeCf.calls = [];
  try {
    await run();
    return fakeCf.calls;
  } finally {
    fakeCf.intercept = false;
    fakeCf.pending = undefined;
    fakeCf.answers = [];
    timers.mockRestore();
  }
}

/** Keeps a preflight that fails locally from running the real cf access check. */
const unreachedCloudflareRead = (): never => {
  throw new Error("The Cloudflare read must not run.");
};

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eden-cli-eve-namespace-"));
  roots.push(root);
  await mkdir(join(root, "agent"), { recursive: true });
  await writeFile(
    join(root, "agent/sandbox.ts"),
    "import { defineSandbox } from 'eve/sandbox';\nimport { JustBashSandbox } from 'eve/sandbox/just-bash';\nexport const environment = JustBashSandbox.environment();\nexport default defineSandbox(() => environment.open());\n",
    "utf8",
  );
  return root;
}

async function writeSuccessfulBuild(
  request: EveProjectBuilderRequest,
): Promise<void> {
  await mkdir(join(request.snapshotRoot, "node_modules/eve/bin"), {
    recursive: true,
  });
  await writeFile(
    join(request.snapshotRoot, "node_modules/eve/package.json"),
    JSON.stringify({ name: "eve", version: "0.91.0", bin: "bin/eve.js" }),
    "utf8",
  );
  await writeFile(
    join(request.snapshotRoot, "node_modules/eve/bin/eve.js"),
    "#!/usr/bin/env node\n",
    { encoding: "utf8", mode: 0o755 },
  );
  await mkdir(join(request.snapshotRoot, "node_modules/.bin"), {
    recursive: true,
  });
  await symlink(
    "../eve/bin/eve.js",
    join(request.snapshotRoot, "node_modules/.bin/eve"),
  );
  await mkdir(join(request.snapshotRoot, ".output/server"), {
    recursive: true,
  });
  await writeFile(
    join(request.snapshotRoot, ".output/server/index.mjs"),
    "export default {};\n",
    "utf8",
  );
  const templateKey = "7bc778099a3b436ce4ad98ba";
  const templateRoot = join(
    request.snapshotRoot,
    ".eve/sandbox-cache/just-bash/templates",
    templateKey,
  );
  await mkdir(join(templateRoot, "fs/workspace"), { recursive: true });
  await writeFile(
    join(templateRoot, "metadata.json"),
    JSON.stringify({ templateKey }),
    "utf8",
  );
  await mkdir(join(request.snapshotRoot, ".output/.eve/compile"), { recursive: true });
  await writeFile(
    join(request.snapshotRoot, ".output/.eve/compile/sandbox-prepared-artifacts.json"),
    JSON.stringify({
      entries: [{
        artifact: {
          templateRootPath: `/workspace/.eve/sandbox-cache/just-bash/templates/${templateKey}`,
        },
        nodeId: "__root__",
        providerName: "just-bash",
      }],
      kind: "eve-sandbox-prepared-artifacts",
      version: 2,
    }),
    "utf8",
  );
}

function fakeBuilder(
  mutate?: (request: EveProjectBuilderRequest) => Promise<void>,
) {
  return {
    async build(request: EveProjectBuilderRequest) {
      await writeSuccessfulBuild(request);
      await mutate?.(request);
      return { eveVersion: "0.91.0" };
    },
  };
}

const runtimeCleanup = {
  bootContainerId: null,
  bootContainerRemoved: true,
  imageIdentity: "exact" as const,
  imageRetained: false,
  verified: true,
};

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("top-level Eden Deploy commands", () => {
  test("advertises the Deploy command surface", async () => {
    const output: string[] = [];

    await expect(
      runEdenCli(["--help"], {
        stdout: (line) => output.push(line),
      }),
    ).resolves.toBe(0);

    expect(output.join("\n")).toMatch(/preflight|deploy|destroy/u);
    expect(output.join("\n")).not.toMatch(/eden eve/u);
    expect(EVE_CLI_COMMANDS).toEqual([
      "preflight",
      "deploy",
      "destroy",
    ]);
  });

  test.each([
    ["eve", "preflight"],
    ["native"],
    ["init"],
    ["build"],
    ["dev"],
  ] as const)("rejects obsolete root command path %j", async (...args) => {
    const errors: string[] = [];
    await expect(
      runEdenCli(args, {
        stderr: (line) => errors.push(line),
      }),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toMatch(/Unknown Eden command/u);
  });

  test.each([
    ["root", ["--help"], /preflight|deploy|destroy/u],
    ["preflight", ["preflight", "--help"], /--project|--env-file/u],
    ["deploy", ["deploy", "--help"], /--project|--env-file/u],
    ["destroy", ["destroy", "--help"], /--project|--name/u],
  ] as const)(
    "exposes actionable %s help without project side effects",
    async (_scope, args, expected) => {
      const before = await readdir(tmpdir());
      const output: string[] = [];
      const helpArgs = args;

      await expect(
        runEdenCli(helpArgs, {
          stdout: (line) => output.push(line),
        }),
      ).resolves.toBe(0);

      expect(output.join("\n")).toMatch(expected);
      await expect(readdir(tmpdir())).resolves.toEqual(before);
    },
  );


  test("passes only canonical selectors and an opaque env-file path to Eve", async () => {
    const root = await createRoot();
    const parent = join(root, "..");
    const requests: unknown[] = [];

    await expect(
      runEdenCli(
        ["deploy",
        "--project",
        join(parent, root.split("/").pop() as string),
        "--env",
        "production",
        "--name",
        "eve-opaque-path",
        "--env-file=/tmp/opaque-runtime.env",],
        {
          cwd: parent,
          eveRunner: async (request) => {
            requests.push(request);
          },
        },
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      {
        command: "deploy",
        cwd: parent,
        projectRoot: await realpath(root),
        environment: "production",
        name: "eve-opaque-path",
        envFile: "/tmp/opaque-runtime.env",
      },
    ]);
  });

  test("redacts arbitrary Eve runner failures", async () => {
    const root = await createRoot();
    const errors: string[] = [];
    const secret = "eve-runner-secret-marker";

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-redacted-failure",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          eveRunner: async () => {
            throw new Error(secret);
          },
        },
      ),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("EVE_EXECUTION_FAILED");
    expect(errors.join("\n")).not.toContain(secret);
  });

  test("routes a valid preflight through the concrete structured runner", async () => {
    const root = await createRoot();
    const output: string[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-concrete-preflight",
        "--json",],
        {
          cwd: root,
          eveControlPlane: { cloudflareRead: unreachedCloudflareRead },
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
        },
      ),
    ).resolves.toBe(1);

    expect(output.join("\n")).toContain('"command":"eden preflight"');
    expect(output.join("\n")).toContain('"checks"');
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      ok: false,
      error: { code: "EVE_PREFLIGHT_FAILED" },
    });
    expect(errors).toEqual([]);
    expect(output.join("\n")).not.toContain("EVE_EXECUTION_UNAVAILABLE");
  });

  test("produces a passing immutable candidate with exact read-only target evidence", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-control-plane-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
      "utf8",
    );
    const sourceBefore = await readFile(join(root, "package.json"));
    const lockfileBefore = await readFile(join(root, "pnpm-lock.yaml"));
    const output: string[] = [];
    const remoteReads: string[] = [];
    const runtimeRequests: EvePreflightRuntimeRunnerRequest[] = [];

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-read-only",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(),
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
            runtimeRunner: async (request) => {
              runtimeRequests.push(request);
              return {
                ok: true,
                checks: [
                  {
                    id: "VAL-BUILD-005",
                    status: "passed",
                    message: "The immutable Linux/amd64 image candidate passed.",
                  },
                  {
                    id: "VAL-BUILD-006",
                    status: "passed",
                    message: "The official project-local Eve-start process passed.",
                  },
                  {
                    id: "VAL-BUILD-007",
                    status: "passed",
                    message: "The real Eve health and host-capability checks passed.",
                  },
                ],
                imageDigest: `sha256:${"a".repeat(64)}`,
                cleanup: runtimeCleanup,
              };
            },
            cloudflareRead: async (request) => {
              remoteReads.push(`${request.environment}:${request.name}`);
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly command: string;
      readonly ok: boolean;
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
      }[];
      readonly candidate: {
        readonly generationId: string;
        readonly imageDigest?: string;
      } | null;
    };
    expect(result.command).toBe("eden preflight");
    expect(result.ok).toBe(true);
    expect(result.candidate?.generationId).toBe("generation-one");
    expect(result.candidate?.imageDigest).toBe(`sha256:${"a".repeat(64)}`);
    expect(result.checks.map((value) => value.id)).toEqual(
      expect.arrayContaining([
        "VAL-CLI-004",
        "VAL-BUILD-001",
        "VAL-BUILD-002",
        "VAL-BUILD-003",
        "VAL-BUILD-004",
        "VAL-BUILD-005",
        "VAL-BUILD-006",
        "VAL-BUILD-007",
        "VAL-CLI-007-CLOUDFLARE-ACCESS",
        "VAL-CLI-007-TARGET-CONFLICT",
      ]),
    );
    expect(runtimeRequests).toHaveLength(1);
    expect(remoteReads).toEqual(["preview:eve-read-only"]);
    expect(await readFile(join(root, "package.json"))).toEqual(sourceBefore);
    expect(await readFile(join(root, "pnpm-lock.yaml"))).toEqual(lockfileBefore);
  });

  test.each(["preflight", "deploy"] as const)(
    "%s boot probe gets disposable protected injection and redacts explicit runtime values",
    async (command) => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-runtime-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const envFile = join(await createRoot(), "runtime.env");
    const marker = "preflight-secret-marker-6f9a";
    await writeFile(envFile, `OPAQUE_RUNTIME=${marker}\n`, "utf8");
    const before = await readFile(envFile);
    const output: string[] = [];
    let injectedEnvironment: Readonly<Record<string, string>> | undefined;
    let remoteReadCount = 0;

    await expect(
      runEdenCli(
        [command,
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-runtime-read-only",
        "--env-file",
        envFile,],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(),
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
            runtimeRunner: async ({ runtimeInjection }) => {
              expect(runtimeInjection).toBeDefined();
              await runtimeInjection?.runLocal({
                cwd: root,
                hostEnvironment: {
                  HOST: "0.0.0.0",
                  NITRO_HOST: "0.0.0.0",
                  PORT: "8080",
                  NITRO_PORT: "8080",
                  NODE_ENV: "production",
                },
                run: (request) => {
                  injectedEnvironment = request.env;
                  throw new Error(`child output ${marker}`);
                },
              });
              return {
                ok: true,
                checks: [],
                cleanup: runtimeCleanup,
              };
            },
            cloudflareRead: async () => {
              remoteReadCount += 1;
              return {
                accountAccess: "available",
                containerAccess: "available",
                accountId: "account-test",
                workersDevSubdomain: "account",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(injectedEnvironment?.OPAQUE_RUNTIME).toBe(marker);
    expect(output.join("\n")).not.toContain(marker);
    expect(await readFile(envFile)).toEqual(before);
    if (command === "preflight") expect(remoteReadCount).toBe(0);
    },
  );

  test("fails closed on an exact target conflict without a mutation seam", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-conflict-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const output: string[] = [];
    const operations: string[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "production",
        "--name",
        "eve-conflict",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(),
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
            runtimeRunner: async () => ({
              ok: true,
              checks: [
                {
                  id: "VAL-BUILD-005",
                  status: "passed",
                  message: "Image passed.",
                },
                {
                  id: "VAL-BUILD-006",
                  status: "passed",
                  message: "Eve start passed.",
                },
                {
                  id: "VAL-BUILD-007",
                  status: "passed",
                  message: "Health passed.",
                },
              ],
              imageDigest: `sha256:${"b".repeat(64)}`,
              cleanup: runtimeCleanup,
            }),
            cloudflareRead: async () => {
              operations.push("exact-target-read");
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: {
                  state: "unowned",
                  message: "The exact target is owned by another system.",
                  remediation: "Choose a fresh exact target name.",
                },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
      }[];
    };
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "VAL-CLI-007-TARGET-CONFLICT",
      status: "failed",
    }));
    expect(JSON.parse(output[0] as string)).toMatchObject({
      error: { code: "EVE_PREFLIGHT_FAILED" },
    });
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(operations).toEqual(["exact-target-read"]);
  });

  test("rejects a source race before any exact Cloudflare read", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-race-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const sourcePath = join(root, "source.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    let remoteReadCount = 0;

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-race",],
        {
          cwd: root,
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(async () => {
              await writeFile(sourcePath, "export const value = 2;\n", "utf8");
            }),
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
            cloudflareRead: async () => {
              remoteReadCount += 1;
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(remoteReadCount).toBe(0);
    expect(await readFile(sourcePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("revalidates authored inputs after runtime health before any exact read", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-runtime-race-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const sourcePath = join(root, "source.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    let remoteReadCount = 0;

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-runtime-race",],
        {
          cwd: root,
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(),
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
            runtimeRunner: async () => {
              await writeFile(sourcePath, "export const value = 2;\n", "utf8");
              return {
                ok: true,
                checks: [
                  {
                    id: "VAL-BUILD-005",
                    status: "passed",
                    message: "Image passed.",
                  },
                  {
                    id: "VAL-BUILD-006",
                    status: "passed",
                    message: "Eve start passed.",
                  },
                  {
                    id: "VAL-BUILD-007",
                    status: "passed",
                    message: "Health passed.",
                  },
                ],
                imageDigest: `sha256:${"c".repeat(64)}`,
                cleanup: runtimeCleanup,
              };
            },
            cloudflareRead: async () => {
              remoteReadCount += 1;
              return {
                accountAccess: "available",
                containerAccess: "available",
                target: { state: "absent" },
              };
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(remoteReadCount).toBe(0);
    expect(await readFile(sourcePath, "utf8")).toBe("export const value = 2;\n");
  });

  test("defaults preflight and deploy to cwd, preview, and a derived name", () => {
    for (const command of ["preflight", "deploy"] as const) {
      expect(parseEveArguments([command])).toEqual({
        kind: "invocation",
        command,
        projectRoot: ".",
        environment: "preview",
      });
    }
  });

  test.each(["destroy", "deploy --env production"] as const)(
    "requires an explicit --name for %s",
    (selection) => {
      const args = selection === "destroy"
        ? ["destroy"]
        : ["deploy", "--env", "production"];
      let error: unknown;
      try {
        parseEveArguments(args);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EveCliError);
      expect(error).toMatchObject({ code: "EVE_NAME_REQUIRED" });
    },
  );

  test("accepts destroy and production deploy with an explicit --name", () => {
    expect(parseEveArguments(["destroy", "--name", "eve-preview"]))
      .toEqual({
        kind: "invocation",
        command: "destroy",
        projectRoot: ".",
        environment: "preview",
        name: "eve-preview",
      });
    expect(
      parseEveArguments(
        ["deploy", "--env", "production", "--name", "eve-production"],
      ),
    ).toEqual({
      kind: "invocation",
      command: "deploy",
      projectRoot: ".",
      environment: "production",
      name: "eve-production",
    });
  });

  test("derives deterministic collision-safe Worker names", () => {
    expect(deriveEveTargetName("@my-org/My Eve_App"))
      .toBe(deriveEveTargetName("@my-org/My Eve_App"));
    const derived = deriveEveTargetName("@my-org/My Eve_App");
    expect(derived).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);
    expect(derived.startsWith("my-org-my-eve-app-")).toBe(true);
    // Distinct raw names that sanitize to the same slug stay distinct.
    expect(deriveEveTargetName("my_app"))
      .not.toBe(deriveEveTargetName("my app"));
    expect(
      deriveEveTargetName(`${"a".repeat(80)}-eve-project`),
    ).toMatch(/^[a-z0-9-]{1,63}$/u);
    expect(() => deriveEveTargetName("!!!")).toThrowError(
      expect.objectContaining({ code: "EVE_NAME_DERIVATION_FAILED" }),
    );
  });

  test("no-flag deploy resolves the project name from package.json", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@my-org/My Eve_App", private: true }),
      "utf8",
    );
    let observed: { name?: string; projectRoot?: string; environment?: string } = {};
    await expect(
      runEdenCli(["deploy"], {
        cwd: root,
        eveRunner: async (request) => {
          observed = request;
        },
      }),
    ).resolves.toBe(0);
    expect(observed.environment).toBe("preview");
    expect(observed.projectRoot).toBe(await realpath(root));
    expect(observed.name).toBe(deriveEveTargetName("@my-org/My Eve_App"));
  });

  test("parses both environments and scopes env-file to preflight/deploy", () => {
    expect(
      parseEveArguments(["preflight",
      "--project",
      "/tmp/eve-project",
      "--env",
      "preview",
      "--name",
      "eve-preview",
      "--env-file=/tmp/eve.env",]),
    ).toEqual({
      kind: "invocation",
      command: "preflight",
      projectRoot: "/tmp/eve-project",
      environment: "preview",
      name: "eve-preview",
      envFile: "/tmp/eve.env",
    });

    expect(
      parseEveArguments(["deploy",
      "--project=/tmp/eve-project",
      "--env=production",
      "--name=eve-production",
      "--env-file",
      "/tmp/eve.env",]),
    ).toEqual({
      kind: "invocation",
      command: "deploy",
      projectRoot: "/tmp/eve-project",
      environment: "production",
      name: "eve-production",
      envFile: "/tmp/eve.env",
    });

    let error: unknown;
    try {
      parseEveArguments(["destroy",
      "--project",
      "/tmp/eve-project",
      "--env",
      "preview",
      "--name",
      "eve-preview",
      "--env-file",
      "/tmp/eve.env",]);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EveCliError);
    expect(error).toMatchObject({ code: "EVE_ENV_FILE_UNSUPPORTED" });
  });

  test.each([
    [
      "invalid environment",
      ["--project", "/tmp/eve-project", "--env", "staging", "--name", "eve-preview"],
      "EVE_ENV_INVALID",
    ],
    [
      "repeated project",
      [
        "--project",
        "/tmp/one",
        "--project",
        "/tmp/two",
        "--env",
        "preview",
        "--name",
        "eve-preview",
      ],
      "EVE_PROJECT_REPEATED",
    ],
    [
      "missing option value",
      [
        "--project",
        "/tmp/eve-project",
        "--env",
        "preview",
        "--name",
        "eve-preview",
        "--env-file",
      ],
      "EVE_OPTION_VALUE_MISSING",
    ],
    [
      "malformed name",
      ["--project", "/tmp/eve-project", "--env", "preview", "--name", "Not_A_Worker"],
      "EVE_NAME_INVALID",
    ],
    [
      "unknown option",
      [
        "--project",
        "/tmp/eve-project",
        "--env",
        "preview",
        "--name",
        "eve-preview",
        "--unknown",
      ],
      "EVE_OPTION_UNKNOWN",
    ],
  ] as const)(
    "rejects %s before project resolution",
    (_description, suffix, expected) => {
      let error: unknown;
      try {
        parseEveArguments(["preflight",
        ...suffix,]);
      } catch (caught: unknown) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EveCliError);
      expect(error).toMatchObject({ code: expected });
    },
  );

  test("returns typed subcommand help and rejects the obsolete namespace", () => {
    expect(parseEveArguments(["destroy", "--help"])).toEqual<EveCliHelp>({
      kind: "help",
      scope: "destroy",
    });
    expect(() => parseEveArguments(["eve"])).toThrowError(
      expect.objectContaining({ code: "EVE_COMMAND_UNKNOWN" }),
    );
  });

  test.each([
    { discarded: true, expectedExitCode: 0, expectedErrorCode: undefined },
    {
      discarded: false,
      expectedExitCode: 1,
      expectedErrorCode: "EVE_RUNTIME_IMAGE_CLEANUP_FAILED",
    },
  ] as const)(
    "deploys one exact target and reports exact runtime-image cleanup (discarded=$discarded)",
    async ({ discarded, expectedExitCode, expectedErrorCode }) => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-deploy-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const envFile = join(root, "runtime.env");
    const marker = "deploy-secret-marker-1e9b";
    await writeFile(envFile, `OPAQUE_RUNTIME=${marker}\n`, "utf8");
    const output: string[] = [];
    const errors: string[] = [];
    const operations: string[] = [];
    let protectedPut = false;
    let promotedAfterHealth = false;
    const imageDigest = `sha256:${"d".repeat(64)}`;

    await expect(
      runEdenCli(
        ["deploy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-deploy-fixture",
        "--env-file",
        envFile,
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(),
            containerImageReference:
              `registry.cloudflare.com/account-test/eve@${imageDigest}`,
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
            runtimeRunner: async ({ publicOrigin }) => {
              expect(publicOrigin).toBe(
                "https://eve-deploy-fixture.account.workers.dev",
              );
              return {
                ok: true,
                checks: [
                  {
                    id: "VAL-BUILD-005",
                    status: "passed",
                    message: "Image passed.",
                  },
                  {
                    id: "VAL-BUILD-006",
                    status: "passed",
                    message: "Eve start passed.",
                  },
                  {
                    id: "VAL-BUILD-007",
                    status: "passed",
                    message: "Health passed.",
                  },
                ],
                imageDigest,
                cleanup: {
                  ...runtimeCleanup,
                  imageRetained: true,
                },
              };
            },
            cloudflareRead: async () => ({
              accountAccess: "available",
              containerAccess: "available",
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: { state: "absent" },
            }),
            protectedStore: {
              async put(request) {
                protectedPut = true;
                expect(request.targetId).toContain("eve-deploy-fixture");
                expect(request.values.OPAQUE_RUNTIME).toBe(marker);
                return {
                  revision: "eve-runtime-revision-test",
                  handle: "eve-runtime-handle-test",
                };
              },
            },
            publish: async (request) => {
              operations.push("publish");
              expect(request.hostConfig.worker.name).toBe("eve-deploy-fixture");
              expect(request.hostConfig.worker.workers_dev).toBe(true);
              expect(request.hostConfig.worker.containers).toHaveLength(1);
              expect(
                request.hostConfig.worker.containers[0]?.scheduling_policy,
              ).toBe("durable_object");
              expect(
                request.hostConfig.worker.containers[0]?.images.eve.image,
              ).toBe(request.identity.containerImage);
              expect(request.hostConfig.worker.compatibility_flags).toEqual([
                "enable_ctx_exports",
              ]);
              expect(request.hostConfig.worker.vars.EVE_PUBLIC_ORIGIN).toBe(
                "https://eve-deploy-fixture.account.workers.dev",
              );
              expect(
                request.hostConfig.worker.vars.EDEN_EVE_RUNTIME_REVISION,
              ).toBe("eve-runtime-handle-test");
              expect(request.workerSource).not.toContain(marker);
              return {
                status: "published",
                identity: request.identity,
                createdByAttempt: true,
                ownershipProven: true,
              };
            },
            health: async (request) => {
              operations.push("health");
              expect(request.identity.stableWorkersDevOrigin).toBe(
                "https://eve-deploy-fixture.account.workers.dev",
              );
              return {
                status: "ready",
                identity: request.identity,
              };
            },
            discardRuntimeImage: async (request) => {
              operations.push("discard-runtime-image");
              expect(request.imageId).toBe(imageDigest);
              expect(request.generationId).toBe("generation-one");
              expect(request.generationRoot).toContain("generation-one");
              return discarded;
            },
            afterPromotion: () => {
              promotedAfterHealth = operations.includes("health");
            },
          },
        },
      ),
    ).resolves.toBe(expectedExitCode);

    expect(protectedPut).toBe(true);
    expect(operations).toEqual(["publish", "health", "discard-runtime-image"]);
    expect(promotedAfterHealth).toBe(true);
    expect(output.join("\n")).not.toContain(marker);
    expect(output.join("\n")).toContain("eden deploy");
    expect(output.join("\n")).toContain("VAL-CROSS-004");
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
    if (expectedErrorCode !== undefined) {
      expect(JSON.parse(output[0] as string)).toMatchObject({
        ok: false,
        error: { code: expectedErrorCode },
      });
      expect(output.join("\n")).toContain("do not retry");
    }
  });

  test("keeps deploy indeterminate and leaves the target pointer unchanged when publication outcome is ambiguous", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-indeterminate-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const errors: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-indeterminate-fixture",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(),
            containerImageReference:
              `registry.cloudflare.com/account-test/eve@sha256:${"e".repeat(64)}`,
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
            runtimeRunner: async () => ({
              ok: true,
              checks: [
                {
                  id: "VAL-BUILD-005",
                  status: "passed",
                  message: "Image passed.",
                },
                {
                  id: "VAL-BUILD-006",
                  status: "passed",
                  message: "Eve start passed.",
                },
                {
                  id: "VAL-BUILD-007",
                  status: "passed",
                  message: "Health passed.",
                },
              ],
              imageDigest: `sha256:${"e".repeat(64)}`,
              cleanup: runtimeCleanup,
            }),
            cloudflareRead: async () => ({
              accountAccess: "available",
              containerAccess: "available",
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: { state: "absent" },
            }),
            publish: async () => {
              operations.push("publish");
              return {
                status: "indeterminate",
                reason: "The publication response was lost.",
                ownershipEvidenceRetained: true,
              };
            },
            compensate: async () => {
              operations.push("compensate");
              throw new Error("ambiguous cleanup must not run");
            },
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual(["publish"]);
    expect(errors.join("\n")).toContain("DEPLOY_INDETERMINATE");
    expect(errors.join("\n")).not.toContain("ambiguous cleanup");
  });

  test("gives the default cf deploy publication a 600 second deadline", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-publish-deadline",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const errors: string[] = [];

    const calls = await withFakeCf(async () => {
      await expect(
        runEdenCli(
          ["deploy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-publish-deadline",],
          {
            cwd: root,
            stderr: (line) => errors.push(line),
            eveControlPlane: {
              generationId: "generation-one",
              builder: fakeBuilder(),
              containerImageReference:
                `registry.cloudflare.com/account-test/eve@sha256:${"e".repeat(64)}`,
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
              runtimeRunner: async () => ({
                ok: true,
                checks: [
                  {
                    id: "VAL-BUILD-005",
                    status: "passed",
                    message: "Image passed.",
                  },
                  {
                    id: "VAL-BUILD-006",
                    status: "passed",
                    message: "Eve start passed.",
                  },
                  {
                    id: "VAL-BUILD-007",
                    status: "passed",
                    message: "Health passed.",
                  },
                ],
                imageDigest: `sha256:${"e".repeat(64)}`,
                cleanup: runtimeCleanup,
              }),
              cloudflareRead: async () => ({
                accountAccess: "available",
                containerAccess: "available",
                accountId: "account-test",
                workersDevSubdomain: "account",
                target: { state: "absent" },
              }),
            },
          },
        ),
      ).resolves.toBe(1);
    });

    // The publish, then the reads that find no version of this publish to finish.
    expect(calls[0]).toEqual({ args: ["deploy", "--prebuilt"], timeoutMs: about(600_000) });
    // cf gives no login token here, so nothing of Cloudflare's API is read.
    expect(calls.slice(1)).toEqual([{ args: ["auth", "whoami"], timeoutMs: about(30_000) }]);
    expect(errors.join("\n")).toContain("DEPLOY_INDETERMINATE");
  });

  test.each(["preflight", "deploy", "destroy"])("eden %s on a Node older than 24.22 stops with the version it needs and the fix", async (command) => {
    const output: string[] = [];
    await expect(runEdenCli(
      [command, "--name", "eve-node-floor", "--json"],
      { stdout: (line) => output.push(line), nodeVersion: "24.21.0" },
    )).resolves.toBe(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      ok: false,
      error: {
        code: "EVE_NODE_UNSUPPORTED",
        message: "Eden needs Node 24.22.0 or newer on the 24 line, or 26.12.0 or newer on the 26 line, and is running on Node 24.21.0.",
        remediation: expect.stringContaining("Install Node 24.22.0 or newer") as unknown,
      },
    });
  });

  test.each([
    ["25.4.0", 1], ["26.11.0", 1], ["27.0.0", 1], ["24.22.0", 0], ["26.12.0", 0],
  ])("Node %s is checked against the lines cf declares", async (nodeVersion, stops) => {
    const output: string[] = [];
    await runEdenCli(["destroy", "--name", "eve-node-lines", "--json"], { stdout: (line) => output.push(line), nodeVersion, cfVersion: null });
    // A supported Node reaches the next check, which this run fails on purpose.
    expect((JSON.parse(output[0] as string) as { readonly error: { readonly code: string } }).error.code)
      .toBe(stops === 1 ? "EVE_NODE_UNSUPPORTED" : "EVE_CF_UNAVAILABLE");
  });

  test.each([
    [null, "Eden runs Cloudflare's cf CLI 1.0.0-rc.2, which is installed with Eden, and could not find it."],
    ["99.0.0", "Eden runs Cloudflare's cf CLI 1.0.0-rc.2 and found cf 99.0.0 installed in its place."],
  ])("a missing or different cf (%s) stops every command with one JSON error and how to reinstall", async (cfVersion, message) => {
    for (const command of ["preflight", "deploy", "destroy"]) {
      const output: string[] = [];
      await expect(runEdenCli([command, "--name", "eve-cf-pin", "--json"], { stdout: (line) => output.push(line), cfVersion }))
        .resolves.toBe(1);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0] as string)).toMatchObject({
        ok: false,
        error: { code: "EVE_CF_UNAVAILABLE", message, remediation: expect.stringContaining("Install @moinulmoin/eden again") as unknown },
      });
    }
    const help: string[] = [];
    await expect(runEdenCli(["--help"], { stdout: (line) => help.push(line), cfVersion })).resolves.toBe(0);
  });

  test("eden --help still prints on a Node older than 24.22", async () => {
    const output: string[] = [];
    await expect(runEdenCli(["--help"], { stdout: (line) => output.push(line), nodeVersion: "24.17.0" })).resolves.toBe(0);
    expect(output.join("\n")).toContain("preflight");
  });

  test("parses --json on every command", () => {
    for (const command of ["preflight", "deploy", "destroy"] as const) {
      const parsed = parseEveArguments([
        command,
        "--name",
        "eve-json-mode",
        "--json",
      ]);
      expect(parsed).toMatchObject({
        kind: "invocation",
        command,
        json: true,
      });
    }
    expect(
      parseEveArguments(["preflight", "--name", "eve-plain"]),
    ).not.toHaveProperty("json");
  });

  test("prints a human preflight summary by default", async () => {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-human-preflight",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-human-preflight",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            generationId: "generation-one",
            builder: fakeBuilder(),
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
            runtimeRunner: async () => ({
              ok: true,
              checks: [
                {
                  id: "VAL-BUILD-005",
                  status: "passed",
                  message: "Image passed.",
                },
                {
                  id: "VAL-BUILD-006",
                  status: "passed",
                  message: "Eve start passed.",
                },
                {
                  id: "VAL-BUILD-007",
                  status: "passed",
                  message: "Health passed.",
                },
              ],
              imageDigest: `sha256:${"f".repeat(64)}`,
              cleanup: runtimeCleanup,
            }),
            cloudflareRead: async () => ({
              accountAccess: "available",
              containerAccess: "available",
              target: { state: "absent" },
            }),
          },
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    expect(output[0]).toBe(
      "eden preflight — eve-human-preflight (preview)",
    );
    expect(text).toContain("... packaging project");
    expect(text).toContain("✓ VAL-CLI-004");
    expect(text).toContain("✓ eve-human-preflight (preview) — preflight passed");
    expect(text).not.toContain('"command"');
    expect(() => JSON.parse(text)).toThrow();
  });

  test("prints the failing check id, reason, and remediation on preflight failure", async () => {
    const root = await createRoot();
    const output: string[] = [];
    const errors: string[] = [];

    await expect(
      runEdenCli(
        ["preflight",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-human-failure",],
        {
          cwd: root,
          eveControlPlane: { cloudflareRead: unreachedCloudflareRead },
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
        },
      ),
    ).resolves.toBe(1);

    const text = output.join("\n");
    expect(text).toContain("✗ VAL-");
    expect(text).toContain("→");
    expect(text).toContain("✗ preflight failed — first failing check:");
    expect(errors.join("\n")).toContain("EVE_PREFLIGHT_FAILED");
  });
});


const destroyTargetKey = (() => {
  const digest = createHash("sha256")
    .update("proj\naccount-test\npreview\neve-destroy-fixture", "utf8")
    .digest("hex")
    .slice(0, 24);
  return `preview-eve-destroy-fixture-${digest}`;
})();
const destroyRegistryRepository = `eden-eve-${destroyTargetKey}-gen-destroy-1`;
const destroyRegistryImage =
  `${destroyRegistryRepository}:candidate`;

describe("exact target Container inventory", () => {
  test("ignores the account's other Containers and matches only <name>-container", () => {
    const inventory = [
      { id: "c-other-app", name: "autoseopilot-container" },
      { id: "c-other-eden", name: "my-eve-agent-11111111-container" },
      { id: "c-bare-name", name: "my-eve-agent-9e510242" },
    ];

    expect(exactTargetContainerEntries(inventory, "my-eve-agent-9e510242")).toEqual([]);
    expect(
      exactTargetContainerEntries(
        [...inventory, { id: "c-target", name: "my-eve-agent-9e510242-container" }],
        "my-eve-agent-9e510242",
      ),
    ).toEqual([{ id: "c-target", name: "my-eve-agent-9e510242-container" }]);
  });

  test("stays unproven when a full page has no exact match", () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: `c-${index}`,
      name: `unrelated-${index}-container`,
    }));

    expect(exactTargetContainerEntries(fullPage, "my-eve-agent-9e510242")).toBeUndefined();
  });
});

describe("eden destroy", () => {
  const destroyProviderEvidence = {
    settingsReadable: true,
    workerDeploymentId: "eve-deploy-test",
    containerSchedulingPolicy: "durable_object",
    containerNamespaceId: "namespace-test",
    workerContainerNamespaceId: "namespace-test",
  };
  async function createDeployedFixture(): Promise<{
    readonly root: string;
    readonly generationRoot: string;
  }> {
    const root = await createRoot();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-destroy-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
      "utf8",
    );
    const generationRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-destroy-1",
    );
    await mkdir(generationRoot, { recursive: true });
    const targetRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "targets",
      "preview-eve-destroy-fixture",
    );
    await mkdir(targetRoot, { recursive: true });
    await writeFile(
      join(generationRoot, "deployment.json"),
      JSON.stringify({
        version: 1,
        status: "deployed",
        identity: {
          projectId: "proj",
          sourceDigest: `sha256:${"a".repeat(64)}`,
          generationId: "gen-destroy-1",
          deploymentId: "eve-deploy-test",
          environment: "preview",
          name: "eve-destroy-fixture",
          accountId: "account-test",
          workersDevSubdomain: "account",
          stableWorkersDevOrigin:
            "https://eve-destroy-fixture.account.workers.dev",
          workerName: "eve-destroy-fixture",
          containerApplicationName: "eve-destroy-fixture-container",
          stableContainerInstanceName: "eve-destroy-fixture-instance",
          containerImage: `registry.cloudflare.com/account-test/eden-eve-${destroyTargetKey}-gen-destroy-1@sha256:${"b".repeat(64)}`,
          runtimeVariableNames: [],
        },
      }),
      "utf8",
    );
    await symlink(
      relative(targetRoot, generationRoot),
      join(targetRoot, "CURRENT"),
    );
    return { root, generationRoot };
  }

  test("fails closed without a matching immutable deployed record", async () => {
    const root = await createRoot();
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",],
        {
          cwd: root,
          stderr: (line) => errors.push(line),
        },
      ),
    ).resolves.toBe(1);
    expect(errors.join("\n")).toContain("EVE_DESTROY_RECORD_UNPROVEN");
  });

  test("is idempotent when the exact target is already absent", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    let reads = 0;
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => {
              reads += 1;
              return {
                workerExists: false,
                containerApplicationId: undefined,
                registryTagsPresent: [],
                accountId: "account-test",
              };
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(reads).toBe(1);
    expect(output.join("\n")).toContain('"status":"absent"');
  });

  test("deletes only the recorded Worker, Container, and registry image, verifies absence, then clears CURRENT", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const operations: string[] = [];
    let exists = true;
    let containerId: string | undefined = "container-123";
    let imagePresent = true;
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: exists,
              providerEvidence: destroyProviderEvidence,
              ...(containerId === undefined
                ? {}
                : { containerApplicationId: containerId }),
              registryTagsPresent: imagePresent
                ? [destroyRegistryImage]
                : [],
              accountId: "account-test",
            }),
            deleteWorker: async ({ name }) => {
              operations.push(`worker:${name}`);
              exists = false;
              return "deleted";
            },
            deleteContainer: async ({ applicationId }) => {
              operations.push(`container:${applicationId}`);
              containerId = undefined;
              return "deleted";
            },
            deleteRegistryRepository: async ({ repository }) => {
              operations.push(`registry:${repository}`);
              imagePresent = false;
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(operations).toEqual([
      "worker:eve-destroy-fixture",
      "container:container-123",
      `registry:${destroyRegistryRepository}`,
    ]);
    expect(output.join("\n")).toContain('"status":"destroyed"');
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, ".eden/eve-deploy/generations/gen-destroy-1/deployment.json"), "utf8"),
    ).resolves.toContain("deployed");
  });

  test("deletes the aborted-push generation image recorded in indeterminate evidence", async () => {
    const { root } = await createDeployedFixture();
    const abortedRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-destroy-0",
    );
    await mkdir(abortedRoot, { recursive: true });
    const abortedImage = `eden-eve-${destroyTargetKey}-gen-destroy-0:candidate`;
    await writeFile(
      join(abortedRoot, "deployment-attempt.json"),
      JSON.stringify({
        version: 1,
        status: "indeterminate",
        generationId: "gen-destroy-0",
        accountId: "account-test",
        targetKey: destroyTargetKey,
        imageRepository: `eden-eve-${destroyTargetKey}-gen-destroy-0`,
        imageDigest: `sha256:${"c".repeat(64)}`,
      }),
      "utf8",
    );
    const output: string[] = [];
    const deletedRepositories: string[] = [];
    const presentTags = new Set([destroyRegistryImage, abortedImage]);
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: false,
              containerApplicationId: undefined,
              registryTagsPresent: [...presentTags],
              accountId: "account-test",
            }),
            deleteRegistryRepository: async ({ repository }) => {
              deletedRepositories.push(repository);
              for (const tag of [...presentTags]) {
                if (tag.startsWith(`${repository}:`)) presentTags.delete(tag);
              }
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(0);
    expect(new Set(deletedRepositories)).toEqual(
      new Set([
        destroyRegistryRepository,
        `eden-eve-${destroyTargetKey}-gen-destroy-0`,
      ]),
    );
    expect(output.join("\n")).toContain('"status":"destroyed"');
    expect(output.join("\n")).toContain("VAL-LIFE-006-REGISTRY");
  });

  test("reports the recorded image left behind when registry deletion is indeterminate", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: false,
              containerApplicationId: undefined,
              accountId: "account-test",
            }),
            deleteRegistryRepository: async () => "indeterminate",
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain('"status":"failed"');
    expect(output.join("\n")).toContain(destroyRegistryRepository);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      error: { code: "EVE_DESTROY_IMAGES_RETAINED" },
    });
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).resolves.toBeDefined();
  });

  const secondRepository = `eden-eve-${destroyTargetKey}-gen-destroy-0`;

  /** Records an aborted push, so the target owns a second registry repository. */
  async function addSecondRepository(root: string): Promise<void> {
    const abortedRoot = join(root, ".eden", "eve-deploy", "generations", "gen-destroy-0");
    await mkdir(abortedRoot, { recursive: true });
    await writeFile(
      join(abortedRoot, "deployment-attempt.json"),
      JSON.stringify({
        version: 1,
        status: "indeterminate",
        generationId: "gen-destroy-0",
        accountId: "account-test",
        targetKey: destroyTargetKey,
        imageRepository: secondRepository,
        imageDigest: `sha256:${"c".repeat(64)}`,
      }),
      "utf8",
    );
  }

  const currentPointer = (root: string): string =>
    join(root, ".eden", "eve-deploy", "targets", "preview-eve-destroy-fixture", "CURRENT");
  /**
   * A page of the registry's listing as the registry sends it, in answer to
   * the request after `after` (null for the first page). `change` replaces the
   * name, or the cursor, which is otherwise the page's last entry.
   */
  const page = (
    tags: readonly string[] | null,
    after: string | null = null,
    change: { readonly name?: string | null; readonly cursor?: string } = {},
  ) => {
    const name = change.name === undefined ? `account-test/${destroyRegistryRepository}` : change.name;
    const asked = `/v2/account-test/${destroyRegistryRepository}/tags/list?n=1000${after === null ? "" : `&last=${encodeURIComponent(after)}`}`;
    return {
      status: 200,
      body: JSON.stringify({ ...(name === null ? {} : { name }), tags }),
      link: `${asked}?n=1000&last=${change.cursor ?? tags?.at(-1) ?? ""}; rel=next`,
    };
  };

  /** Runs destroy with the default registry cleanup against the fake registry. */
  async function destroyAgainstFakeRegistry(
    root: string,
    setup: FakeRegistrySetup & {
      readonly appearsAfterCleanup?: readonly string[];
      readonly goneAfterCleanup?: readonly string[];
      readonly json?: boolean;
    },
  ): Promise<{ readonly exitCode: number; readonly output: readonly string[] }> {
    startFakeRegistry({
      ...setup,
      // Destroy reads the target twice with its own reader: before it deletes, and at the end.
      onRead: (nth) => {
        setup.onRead?.(nth);
        if (nth !== 1) return;
        for (const [name, entries] of fakeRegistry.entries) {
          fakeRegistry.entries.set(name, [
            ...entries.filter((entry) => setup.goneAfterCleanup?.includes(fakeRegistry.ref(name, entry)) !== true),
            ...(setup.appearsAfterCleanup ?? []).flatMap((ref) =>
              [":", "@"].some((separator) => ref.startsWith(name + separator)) ? [ref.slice(name.length + 1)] : []
            ),
          ]);
        }
      },
    });
    const output: string[] = [];
    const clock = vi.spyOn(performance, "now").mockImplementation(() => fakeRegistry.clock);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    try {
      const exitCode = await runEdenCli(
        ["destroy", "--project", root, "--env", "preview", "--name", "eve-destroy-fixture",
        ...(setup.json === false ? [] : ["--json"])],
        { cwd: root, stdout: (line) => output.push(line), stderr: (line) => output.push(line) },
      );
      return { exitCode, output };
    } finally {
      fakeRegistry.active = false;
      clock.mockRestore();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  }

  test("attempts every entry of every repository and reports what the registry keeps, each with its own answer", async () => {
    const { root } = await createDeployedFixture();
    await addSecondRepository(root);
    const snapshot = `${destroyRegistryRepository}:rootfs-snapshot-aaa`;
    const [image, snapshotManifest, chain, earlierImage] = ["a", "b", "c", "d"].map((letter) =>
      `${destroyRegistryRepository}@${manifest(letter)}`
    ) as [string, string, string, string];
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: {
        [destroyRegistryRepository]: [
          "candidate", "rootfs-snapshot-aaa", manifest("a"), manifest("b"), manifest("c"), manifest("d"),
        ],
        [secondRepository]: ["candidate", "rootfs-set-custom"],
      },
      deletable: (ref) => ref !== snapshot,
      answer: (ref) => ref === snapshot || ref === snapshotManifest
        ? { status: 403, body: snapshotRefusal }
        : ref === chain
        ? { status: 409, body: singletonRefusal }
        // The image that held the tag leaves after 15 seconds; the earlier image stays.
        : { status: 204, body: "", ...(ref === image ? { leavesAfterMs: 15_000 } : {}) },
    });
    expect(exitCode).toBe(0);
    expect(output).toHaveLength(1);
    expect(new Set(fakeRegistry.cfDeletes)).toEqual(new Set([
      destroyRegistryImage,
      snapshot,
      `${secondRepository}:candidate`,
      `${secondRepository}:rootfs-set-custom`,
    ]));
    expect(fakeRegistry.credentialCalls).toBe(1);
    expect(registryDeletes()).toEqual([snapshot, image, snapshotManifest, chain, earlierImage]);
    for (const request of fakeRegistry.registryRequests) {
      expect(request).toMatchObject({
        host: "registry.cloudflare.com",
        ownAgent: true,
        verifiesPeer: true,
        authorized: true,
      });
    }
    // The wait for accepted deletes ends after 30 seconds.
    expect(fakeRegistry.clock).toBe(30_000);
    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string; readonly message: string }[];
      readonly registryObjectsKept: readonly unknown[];
    };
    expect(result).toMatchObject({ ok: true, status: "destroyed" });
    expect(result.registryObjectsKept).toHaveLength(4);
    expect(result.registryObjectsKept).toEqual(expect.arrayContaining([
      { ref: snapshot, class: "refused-snapshot" },
      { ref: snapshotManifest, class: "refused-snapshot" },
      { ref: chain, class: "refused-singleton-artifact" },
      { ref: earlierImage, class: "accepted-still-listed" },
    ]));
    expect(result.warnings.map((warning) => warning.id)).toEqual(["EVE_REGISTRY_OBJECTS_KEPT"]);
    expect(result.warnings[0]?.message).toContain("still lists 4 object(s)");
    expect(result.warnings[0]?.message).toContain("2 it refused to delete as snapshots (refused-snapshot)");
    expect(result.warnings[0]?.message).toContain("1 it refused to delete with SINGLETON_ARTIFACT_EXISTS (refused-singleton-artifact)");
    expect(result.warnings[0]?.message).toContain("1 whose delete it accepted and which it still listed at least 30 seconds later (accepted-still-listed)");
    expect(output[0]).not.toContain("retainedSnapshot");
    expect(output[0]).not.toContain("registry-password");
  });

  test("reports nothing for a manifest that leaves the listing after its delete was accepted", async () => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", manifest("a")] },
      answer: () => ({ status: 204, body: "", leavesAfterMs: 15_000 }),
    });
    expect(exitCode).toBe(0);
    expect(fakeRegistry.clock).toBe(15_000);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, status: "destroyed" });
    expect(result).not.toHaveProperty("warnings");
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test.each([
    ["a 409 with another code", { status: 409, body: JSON.stringify({ code: "MANIFEST_REFERENCED" }) }],
    ["a 409 page that only contains the code", { status: 409, body: "<p>SINGLETON_ARTIFACT_EXISTS</p>" }],
    ["a 403 with the body of the 409", { status: 403, body: singletonRefusal }],
    ["a 500 with the body of the 409", { status: 500, body: singletonRefusal }],
    ["a 409 with the code for another artifact type", { status: 409, body: JSON.stringify({ ...(JSON.parse(singletonRefusal) as object), artifactType: "application/vnd.example.other.v1" }) }],
    ["a 409 with the code and no digests", { status: 409, body: JSON.stringify({ code: "SINGLETON_ARTIFACT_EXISTS", artifactType: "application/vnd.cloudchamber.btrfs-chain.v1" }) }],
    ["a 409 with the code and a digest that is not one", { status: 409, body: JSON.stringify({ ...(JSON.parse(singletonRefusal) as object), committedDigest: "sha256:abc" }) }],
    ["a 409 that says another code before the refusal's", { status: 409, body: singletonRefusal.replace("{", "{\"code\":\"MANIFEST_REFERENCED\",") }],
    ["a 200 for a manifest that is still listed", { status: 200, body: "" }],
    ["a 404 for a manifest that is still listed", { status: 404, body: "" }],
    ["a failed or timed-out connection", "error"],
  ] as const)("does not keep a manifest on %s", async (_name, answer) => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", manifest("c")] },
      answer: () => answer,
    });
    expect(exitCode).toBe(1);
    expect(registryDeletes()).toEqual([`${destroyRegistryRepository}@${manifest("c")}`]);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test("gives an entry that appears during cleanup its own delete and its own answer", async () => {
    const { root } = await createDeployedFixture();
    const late = `${destroyRegistryRepository}:rootfs-snapshot-late`;
    const lateManifest = `${destroyRegistryRepository}@${manifest("e")}`;
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate"] },
      deletable: (ref) => ref !== late,
      answer: () => ({ status: 403, body: snapshotRefusal }),
      // A snapshot lands after the first pass has deleted what was listed.
      // Listing 0 is destroy's first read, and listing 1 starts the cleanup.
      listing: (repository, nth, last) => {
        if (nth === 2 && last === null) fakeRegistry.entries.get(repository)?.push("rootfs-snapshot-late", manifest("e"));
        return undefined;
      },
    });
    expect(exitCode).toBe(0);
    expect(fakeRegistry.cfDeletes).toEqual([destroyRegistryImage, late]);
    expect(registryDeletes()).toEqual([late, lateManifest]);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      ok: true,
      status: "destroyed",
      registryObjectsKept: [
        { ref: late, class: "refused-snapshot" },
        { ref: lateManifest, class: "refused-snapshot" },
      ],
    });
  });

  test("fails when new entries still appear after three passes", async () => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate"] },
      // Every listing after the one that starts the cleanup has one more tag.
      listing: (repository, nth, last) => {
        if (nth > 1 && last === null) fakeRegistry.entries.get(repository)?.push(`late-${nth - 1}`);
        return undefined;
      },
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toEqual([
      destroyRegistryImage,
      `${destroyRegistryRepository}:late-1`,
      `${destroyRegistryRepository}:late-2`,
    ]);
    await expect(lstat(currentPointer(root))).resolves.toBeDefined();
    expect(JSON.parse(output[0] as string)).toMatchObject({
      status: "failed",
      error: { code: "EVE_DESTROY_IMAGES_RETAINED" },
    });
  });

  test.each([
    ["answers 500", { status: 500, body: "" }],
    ["does not answer", "error"],
    ["answers with a page that is not JSON", { status: 200, body: "<html>" }],
    ["answers without a tags array", page(null)],
    ["lists an entry that is neither a tag nor a digest", page(["candidate", "../other/manifests/x"])],
    ["lists an entry twice", page(["candidate", "candidate"])],
    ["lists entries out of order", page(["rootfs-set-a", "candidate"])],
    ["is empty and has no name", page([], null, { name: null })],
    ["is empty and names another repository", page([], null, { name: `account-test/${secondRepository}` })],
    ["is empty and names another account", page([], null, { name: `another-account/${destroyRegistryRepository}` })],
    ["says its name twice, the first for another repository", { ...page([]), body: `{"name":"account-test/${secondRepository}","name":"account-test/${destroyRegistryRepository}","tags":[]}` }],
    ["lists a tag and then says tags a second time, empty", { ...page([]), body: `{"name":"account-test/${destroyRegistryRepository}","tags":["candidate"],"tags":[]}` }],
    ["is empty and has another field", { ...page([]), body: JSON.stringify({ ...(JSON.parse(page([]).body) as object), next: "" }) }],
    ["is empty and says another page follows an entry", page([], null, { cursor: manifest("f") })],
    ["has entries and says that no page follows", page(["candidate"], null, { cursor: "" })],
    ["has no Link header", { status: 200, body: page([]).body }],
    ["has a Link header in a form the registry was not seen to send", { ...page([]), link: `<${page([]).link.replace("; rel=next", "")}>; rel="next"` }],
    ["has a Link header for another repository", { ...page([]), link: page([]).link.replace(destroyRegistryRepository, secondRepository) }],
    ["has a Link header that is not one next page", { ...page([]), link: page([]).link.replace("rel=next", "rel=prev") }],
    ["has a Link header without a cursor", { ...page([]), link: page([]).link.replace("&last=; rel=next", "; rel=next") }],
  ] as const)("deletes nothing and fails when the registry's listing %s", async (_name, listing) => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate"] },
      listing: () => listing,
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toEqual([]);
    expect(registryDeletes()).toEqual([]);
    const result = JSON.parse(output[0] as string) as { readonly error: { readonly remediation: string } };
    expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    expect(result.error.remediation).toContain("direct requests to registry.cloudflare.com");
    await expect(lstat(currentPointer(root))).resolves.toBeDefined();
  });

  test.each([
    ["names a cursor that is not its last entry", (last: string | null) => last === null ? page(["candidate"], null, { cursor: "rootfs-set-a" }) : undefined, 3],
    // The registry still holds a manifest that this listing leaves out.
    ["has entries, says that no page follows, and then ends", (last: string | null) => last === null ? page(["candidate"], null, { cursor: "" }) : page([], last), 3],
    ["goes backwards on its second page", (last: string | null) => last === null ? page(["rootfs-set-a"]) : page(["candidate"], last), 6],
    ["fails on its second page", (last: string | null) => last === null ? undefined : { status: 500, body: "" }, 6],
    ["repeats its first page", (last: string | null) => page(["candidate"], last), 6],
    // Each page has one more tag, so the listing stops at its limit of 100 pages.
    ["never ends", (last: string | null) => page([`tag-${String(Number(last?.slice(4) ?? 0) + 1).padStart(4, "0")}`], last), 300],
  ] as const)("deletes nothing and fails when a listing %s", async (_name, answer, requests) => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate"] },
      listing: (_repository, _nth, last) => answer(last),
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toEqual([]);
    // Destroy's first read, the cleanup and the final read each give up on their own listing.
    expect(fakeRegistry.registryRequests.map((request) => request.method)).toEqual(Array(requests).fill("GET"));
    expect(JSON.parse(output[0] as string)).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    await expect(lstat(currentPointer(root))).resolves.toBeDefined();
  });

  test.each([
    ["answers 500", () => ({ status: 500, body: "" })],
    ["is empty and names another account", () => page([], null, { name: `another-account/${destroyRegistryRepository}` })],
    ["repeats an entry on its second page", (last: string | null) => last === null ? undefined : page([manifest("f")], last)],
  ] as const)("keeps the record and fails when the final listing %s", async (_name, answer) => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate"] },
      // The cleanup deletes the tag and reads an empty listing. A manifest
      // lands before the final read, whose listing cannot be read.
      onRead: (nth) => {
        if (nth === 1) fakeRegistry.entries.get(destroyRegistryRepository)?.push(manifest("f"));
      },
      listing: (_repository, _nth, last) => fakeRegistry.reads === 2 ? answer(last) : undefined,
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toEqual([destroyRegistryImage]);
    expect(registryDeletes()).toEqual([]);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      ok: false,
      status: "failed",
      error: { code: "EVE_DESTROY_IMAGES_RETAINED" },
    });
    await expect(lstat(currentPointer(root))).resolves.toBeDefined();
  });

  test("keeps the record and fails when the final read is for another account", async () => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate"] },
      // cf is signed in to another account by the time destroy verifies.
      whoamiAccountId: () => fakeRegistry.reads === 0 ? "account-test" : "another-account",
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toEqual([destroyRegistryImage]);
    // Nothing is read from the other account, so no second credential is asked for.
    expect(fakeRegistry.credentialCalls).toBe(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      ok: false,
      status: "indeterminate",
      error: { code: "EVE_DESTROY_INDETERMINATE" },
    });
    await expect(lstat(currentPointer(root))).resolves.toBeDefined();
  });

  test("gives a manifest whose delete was accepted late its own 30 seconds before reporting it", async () => {
    const { root } = await createDeployedFixture();
    const [early, late] = [manifest("a"), manifest("b")].map((entry) => `${destroyRegistryRepository}@${entry}`) as [string, string];
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", manifest("a")] },
      answer: () => ({ status: 204, body: "" }),
      // A second manifest lands 25 seconds into the wait for the first.
      listing: (repository, _nth, last) => {
        const entries = fakeRegistry.entries.get(repository) ?? [];
        if (last === null && fakeRegistry.clock === 25_000 && !entries.includes(manifest("b"))) entries.push(manifest("b"));
        return undefined;
      },
    });
    expect(exitCode).toBe(0);
    expect(registryDeletes()).toEqual([early, late]);
    // The second delete was accepted at 25 seconds, so its wait ends at 55.
    expect(fakeRegistry.clock).toBe(55_000);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      ok: true,
      status: "destroyed",
      registryObjectsKept: [
        { ref: early, class: "accepted-still-listed" },
        { ref: late, class: "accepted-still-listed" },
      ],
    });
  });

  test("does not report an accepted delete that never got its wait when the passes run out", async () => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: [manifest("a")] },
      answer: () => ({ status: 204, body: "" }),
      // Every listing of the cleanup after its first has one more tag, so the
      // cleanup stops at its third pass with no time passed.
      listing: (repository, nth, last) => {
        if (nth > 1 && last === null && fakeRegistry.reads === 1) fakeRegistry.entries.get(repository)?.push(`late-${nth - 1}`);
        return undefined;
      },
      // The tag that got no delete is gone by the final read; the manifest is not.
      goneAfterCleanup: [`${destroyRegistryRepository}:late-3`],
    });
    expect(fakeRegistry.clock).toBe(0);
    expect(exitCode).toBe(1);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    expect(result).not.toHaveProperty("registryObjectsKept");
    await expect(lstat(currentPointer(root))).resolves.toBeDefined();
  });

  test.each([
    ["fails when the other answer is not a kept one", { status: 500, body: "" }, 1],
    ["reports only the refused one when the other leaves", { status: 204, body: "", leavesAfterMs: 0 }, 0],
  ] as const)("a digest in two repositories gets a delete and an answer in each: %s", async (_name, otherAnswer, expectedExit) => {
    const { root } = await createDeployedFixture();
    await addSecondRepository(root);
    const [first, second] = [destroyRegistryRepository, secondRepository].map((repository) => `${repository}@${manifest("a")}`) as [string, string];
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: [manifest("a")], [secondRepository]: [manifest("a")] },
      answer: (ref) => ref === first ? { status: 409, body: singletonRefusal } : otherAnswer,
    });
    expect(exitCode).toBe(expectedExit);
    expect(new Set(registryDeletes())).toEqual(new Set([first, second]));
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    if (expectedExit === 0) {
      expect(result).toMatchObject({
        status: "destroyed",
        registryObjectsKept: [{ ref: first, class: "refused-singleton-artifact" }],
      });
    } else {
      expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
      expect(JSON.stringify(result.error)).toContain(secondRepository);
      expect(JSON.stringify(result.error)).not.toContain(destroyRegistryRepository);
      expect(result).not.toHaveProperty("registryObjectsKept");
    }
  });

  test("reads a listing whose 100th page is the empty one that ends it", async () => {
    const { root } = await createDeployedFixture();
    const tags = Array.from({ length: 99 }, (_unused, index) => `rootfs-set-${String(index).padStart(2, "0")}`);
    const { exitCode } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: tags },
      pageSize: 1,
    });
    expect(exitCode).toBe(0);
    expect(fakeRegistry.cfDeletes).toEqual(tags.map((tag) => `${destroyRegistryRepository}:${tag}`));
  });

  test("reads a listing that takes several pages", async () => {
    const { root } = await createDeployedFixture();
    const tags = ["candidate", "rootfs-set-a", "rootfs-set-b", "rootfs-set-c", "rootfs-set-d"];
    const { exitCode } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: tags },
      pageSize: 2,
    });
    expect(exitCode).toBe(0);
    expect(fakeRegistry.cfDeletes).toEqual(tags.map((tag) => `${destroyRegistryRepository}:${tag}`));
    // Three pages and the empty one that ends a listing, for destroy's first
    // read and again for the cleanup; then one empty listing after the
    // deletes and one for the final read.
    expect(fakeRegistry.registryRequests.map((request) => request.method)).toEqual(Array(10).fill("GET"));
  });

  test("fails when another repository's tag is refused with a different answer", async () => {
    const { root } = await createDeployedFixture();
    await addSecondRepository(root);
    const snapshot = `${destroyRegistryRepository}:rootfs-snapshot-aaa`;
    const other = `${secondRepository}:rootfs-set-custom`;
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: {
        [destroyRegistryRepository]: ["candidate", "rootfs-snapshot-aaa"],
        [secondRepository]: ["candidate", "rootfs-set-custom"],
      },
      deletable: (ref) => ref !== snapshot && ref !== other,
      answer: (ref) => ref === snapshot
        ? { status: 403, body: snapshotRefusal }
        : { status: 403, body: JSON.stringify({ errors: [{ code: "DENIED", message: "access denied" }] }) },
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toContain(other);
    expect(new Set(registryDeletes())).toEqual(new Set([snapshot, other]));
    expect(fakeRegistry.credentialCalls).toBe(1);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { code: "EVE_DESTROY_IMAGES_RETAINED" },
    });
    expect(JSON.stringify(result.error)).toContain(secondRepository);
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test("fails on a tag that appears after cleanup, whatever its name", async () => {
    const { root } = await createDeployedFixture();
    const snapshot = `${destroyRegistryRepository}:rootfs-snapshot-aaa`;
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", "rootfs-snapshot-aaa"] },
      deletable: (ref) => ref !== snapshot,
      answer: () => ({ status: 403, body: snapshotRefusal }),
      appearsAfterCleanup: [`${destroyRegistryRepository}:rootfs-snapshot-new`],
    });
    expect(exitCode).toBe(1);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: { code: "EVE_DESTROY_IMAGES_RETAINED" },
    });
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test.each([
    ["a 403 page that only contains the message", { status: 403, body: "<p>snapshot manifests cannot be deleted through this API</p>" }, undefined],
    ["a 403 with DENIED and a longer message", { status: 403, body: snapshotRefusal.replace("this API", "this API today") }, undefined],
    ["a 403 with the message under another code", { status: 403, body: snapshotRefusal.replace("DENIED", "UNAUTHORIZED") }, undefined],
    ["a 403 with a second error beside the refusal", { status: 403, body: JSON.stringify({ errors: [...(JSON.parse(snapshotRefusal) as { errors: unknown[] }).errors, { code: "UNKNOWN", message: "other" }] }) }, undefined],
    ["a 403 that says errors twice, the refusal last", { status: 403, body: snapshotRefusal.replace("{", "{\"errors\":[],") }, undefined],
    ["a 401 with the refusal body", { status: 401, body: snapshotRefusal }, undefined],
    ["a 500 with the refusal body", { status: 500, body: snapshotRefusal }, undefined],
    ["a 307 redirect with the refusal body", { status: 307, body: snapshotRefusal }, undefined],
    ["a refusal padded past 4 KiB", { status: 403, body: snapshotRefusal + " ".repeat(5_000) }, undefined],
    ["a failed or timed-out connection", "error", undefined],
    ["a credential for another account", { status: 403, body: snapshotRefusal }, "another-account"],
  ] as const)("does not treat %s as the snapshot refusal", async (_name, answer, credentialAccountId) => {
    const { root } = await createDeployedFixture();
    const snapshot = `${destroyRegistryRepository}:rootfs-snapshot-aaa`;
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", "rootfs-snapshot-aaa"] },
      deletable: (ref) => ref !== snapshot,
      answer: () => answer,
      ...(credentialAccountId === undefined ? {} : { credentialAccountId }),
    });
    expect(exitCode).toBe(1);
    // Without a credential for this account nothing is listed, so nothing is deleted.
    expect(fakeRegistry.cfDeletes).toEqual(credentialAccountId === undefined ? [destroyRegistryImage, snapshot] : []);
    expect(fakeRegistry.registryRequests.map((request) => request.method)).toEqual(
      // A listing is a page and the empty page that ends it: destroy's first
      // read and the cleanup's, then after the delete the cleanup's and the final read's.
      credentialAccountId === undefined
        ? ["GET", "GET", "GET", "GET", "DELETE", "GET", "GET", "GET", "GET"]
        : [],
    );
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test("sends no delete of its own when cf deletes every tag", async () => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", "rootfs-set-custom"] },
    });
    expect(exitCode).toBe(0);
    expect(fakeRegistry.cfDeletes).toHaveLength(2);
    expect(fakeRegistry.credentialCalls).toBe(1);
    expect(registryDeletes()).toEqual([]);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, status: "destroyed" });
    expect(result).not.toHaveProperty("warnings");
  });

  test.each([
    ["cf could not read the tag", (ref: string) => `Failed to retrieve info for ${ref}: 403 Forbidden`],
    ["the registry answered cf's delete with 500", (ref: string) => `Failed to delete ${ref} (digest: sha256:${"0".repeat(64)}): 500 Internal Server Error`],
    ["cf named another tag", () => `Failed to delete ${destroyRegistryRepository}:other (digest: sha256:${"0".repeat(64)}): 403 Forbidden`],
  ] as const)("sends no delete of its own when %s", async (_name, cfFailure) => {
    const { root } = await createDeployedFixture();
    const snapshot = `${destroyRegistryRepository}:rootfs-snapshot-aaa`;
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", "rootfs-snapshot-aaa"] },
      deletable: (ref) => ref !== snapshot,
      cfFailure,
      answer: () => ({ status: 403, body: snapshotRefusal }),
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toContain(snapshot);
    expect(registryDeletes()).toEqual([]);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      status: "failed",
      error: { code: "EVE_DESTROY_IMAGES_RETAINED" },
    });
  });

  test("stops asking the registry after 60 seconds without an answer, and still asks cf to delete every tag", async () => {
    const { root } = await createDeployedFixture();
    const snapshotTags = ["rootfs-snapshot-a", "rootfs-snapshot-b", "rootfs-snapshot-c", "rootfs-snapshot-d"];
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["a-first", ...snapshotTags, "z-last"] },
      deletable: (ref) => !ref.includes(":rootfs-snapshot-"),
      answer: () => "stall",
    });
    expect(exitCode).toBe(1);
    // The second wait starts with 29,999.75 ms left; the tags after it are still deleted.
    expect(fakeRegistry.cfDeletes).toHaveLength(6);
    expect(fakeRegistry.cfDeletes.at(-1)).toBe(`${destroyRegistryRepository}:z-last`);
    expect(registryDeletes()).toHaveLength(2);
    expect(fakeRegistry.entries.get(destroyRegistryRepository)).toEqual(snapshotTags);
    const result = JSON.parse(output[0] as string) as { readonly error: { readonly remediation: string } };
    expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    expect(result.error.remediation).toContain("direct requests to registry.cloudflare.com");
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test("fails when the registry stops answering after it confirmed one snapshot tag", async () => {
    const { root } = await createDeployedFixture();
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["rootfs-snapshot-a-ok", "rootfs-snapshot-b", "rootfs-snapshot-c", "rootfs-snapshot-d"] },
      deletable: () => false,
      answer: (ref) => ref.endsWith("-ok") ? { status: 403, body: snapshotRefusal } : "stall",
    });
    expect(exitCode).toBe(1);
    expect(fakeRegistry.cfDeletes).toHaveLength(4);
    expect(registryDeletes()).toHaveLength(3);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test("keeps the confirmed snapshot tag when another tag left by cleanup is gone from the final list", async () => {
    const { root } = await createDeployedFixture();
    const snapshot = `${destroyRegistryRepository}:rootfs-snapshot-aaa`;
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", "rootfs-snapshot-aaa"] },
      deletable: () => false,
      answer: (ref) => ref === snapshot
        ? { status: 403, body: snapshotRefusal }
        : { status: 500, body: "" },
      goneAfterCleanup: [destroyRegistryImage],
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      ok: true,
      status: "destroyed",
      registryObjectsKept: [{ ref: snapshot, class: "refused-snapshot" }],
    });
  });

  test("fails when a tag left by cleanup beside a confirmed snapshot tag is still in the final list", async () => {
    const { root } = await createDeployedFixture();
    const snapshot = `${destroyRegistryRepository}:rootfs-snapshot-aaa`;
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", "rootfs-snapshot-aaa"] },
      deletable: () => false,
      answer: (ref) => ref === snapshot
        ? { status: 403, body: snapshotRefusal }
        : { status: 500, body: "" },
    });
    expect(exitCode).toBe(1);
    const result = JSON.parse(output[0] as string) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "failed", error: { code: "EVE_DESTROY_IMAGES_RETAINED" } });
    expect(result).not.toHaveProperty("registryObjectsKept");
  });

  test("prints every kept object on its own line when a target has 200 of them", async () => {
    const { root } = await createDeployedFixture();
    const snapshotTags = Array.from(
      { length: 200 },
      (_, index) => `rootfs-snapshot-${String(index).padStart(64, "0")}`,
    );
    const { exitCode, output } = await destroyAgainstFakeRegistry(root, {
      entries: { [destroyRegistryRepository]: ["candidate", ...snapshotTags] },
      deletable: (ref) => ref === destroyRegistryImage,
      answer: () => ({ status: 403, body: snapshotRefusal }),
      json: false,
    });
    expect(exitCode).toBe(0);
    expect(fakeRegistry.cfDeletes).toHaveLength(201);
    expect(registryDeletes()).toHaveLength(200);
    expect(fakeRegistry.credentialCalls).toBe(1);
    const lines = output.join("\n").split("\n");
    for (const tag of snapshotTags) {
      expect(lines).toContain(`  kept: ${destroyRegistryRepository}:${tag} (refused-snapshot)`);
    }
    const warning = lines.find((line) => line.startsWith("! EVE_REGISTRY_OBJECTS_KEPT")) ?? "";
    expect(warning).toContain("still lists 200 object(s)");
    expect(warning.length).toBeLessThan(2_000);
    expect(lines.some((line) => line.startsWith("✓ destroyed eve-destroy-fixture (preview)"))).toBe(true);
  });

  test("returns indeterminate without clearing CURRENT when the Worker deletion is ambiguous", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: true,
              providerEvidence: destroyProviderEvidence,
              containerApplicationId: undefined,
              accountId: "account-test",
            }),
            deleteWorker: async () => "indeterminate",
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain('"status":"indeterminate"');
    expect(JSON.parse(output[0] as string)).toMatchObject({
      error: { code: "EVE_DESTROY_INDETERMINATE" },
    });
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).resolves.toBeDefined();
  });

  test("refuses to delete a same-name Worker that another project published with the same affinity deployment ID", async () => {
    const { root, generationRoot } = await createDeployedFixture();
    const recordPath = join(generationRoot, "deployment.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { identity: Record<string, unknown> };
    // Every project on the same Eve version publishes the same affinity ID;
    // only the per-publish release ID tells them apart.
    record.identity.deploymentId = "eden-affinity-shared";
    record.identity.releaseId = "eve-deploy-this-project";
    await writeFile(recordPath, JSON.stringify(record), "utf8");
    const errors: string[] = [];
    const output: string[] = [];
    const deleted: string[] = [];
    await expect(
      runEdenCli(
        ["destroy", "--project", root, "--env", "preview", "--name", "eve-destroy-fixture", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: true,
              providerEvidence: {
                ...destroyProviderEvidence,
                workerDeploymentId: "eden-affinity-shared",
                workerReleaseId: "eve-deploy-other-project",
              },
              containerApplicationId: undefined,
              accountId: "account-test",
            }),
            deleteWorker: async ({ name }) => {
              deleted.push(name);
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(1);
    expect(deleted).toEqual([]);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      error: { code: "EVE_DESTROY_OWNERSHIP_UNPROVEN" },
    });
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("keeps the default cf Worker deletion on the 120 second deadline", async () => {
    const { root } = await createDeployedFixture();
    const errors: string[] = [];
    const output: string[] = [];
    const calls = await withFakeCf(async () => {
      await expect(
        runEdenCli(
          ["destroy",
          "--project",
          root,
          "--env",
          "preview",
          "--name",
          "eve-destroy-fixture",
          "--json",],
          {
            cwd: root,
            stdout: (line) => output.push(line),
            stderr: (line) => errors.push(line),
            eveControlPlane: {
              destroyCloudflareRead: async () => ({
                workerExists: true,
                providerEvidence: destroyProviderEvidence,
                containerApplicationId: undefined,
                accountId: "account-test",
              }),
            },
          },
        ),
      ).resolves.toBe(1);
    });

    expect(calls).toEqual([
      {
        args: ["workers", "delete", "eve-destroy-fixture", "--force"],
        timeoutMs: about(120_000),
      },
      // The delete did not finish, so Eden asks Cloudflare's API whether the Worker is there, and needs cf's token for it.
      { args: ["auth", "whoami"], timeoutMs: about(30_000) },
    ]);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      error: { code: "EVE_DESTROY_INDETERMINATE" },
    });
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("keeps CURRENT and fails when absence cannot be verified after deletion", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    const errors: string[] = [];
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",
        "--json",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: true,
              providerEvidence: destroyProviderEvidence,
              containerApplicationId: "container-9",
              accountId: "account-test",
            }),
            deleteWorker: async () => "deleted",
            deleteContainer: async () => "deleted",
            deleteRegistryRepository: async () => "deleted",
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.join("\n")).toContain('"status":"failed"');
    expect(JSON.parse(output[0] as string)).toMatchObject({
      error: { code: "EVE_DESTROY_ABSENCE_UNPROVEN" },
    });
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
    await expect(
      lstat(
        join(
          root,
          ".eden",
          "eve-deploy",
          "targets",
          "preview-eve-destroy-fixture",
          "CURRENT",
        ),
      ),
    ).resolves.toBeDefined();
  });

  test("prints a human destroy summary by default", async () => {
    const { root } = await createDeployedFixture();
    const output: string[] = [];
    let exists = true;
    let containerId: string | undefined = "container-123";
    let imagePresent = true;
    await expect(
      runEdenCli(
        ["destroy",
        "--project",
        root,
        "--env",
        "preview",
        "--name",
        "eve-destroy-fixture",],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: exists,
              providerEvidence: destroyProviderEvidence,
              ...(containerId === undefined
                ? {}
                : { containerApplicationId: containerId }),
              registryTagsPresent: imagePresent
                ? [destroyRegistryImage]
                : [],
              accountId: "account-test",
            }),
            deleteWorker: async () => {
              exists = false;
              return "deleted";
            },
            deleteContainer: async () => {
              containerId = undefined;
              return "deleted";
            },
            deleteRegistryRepository: async () => {
              imagePresent = false;
              return "deleted";
            },
          },
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    expect(output[0]).toBe(
      "eden destroy — eve-destroy-fixture (preview)",
    );
    expect(text).toContain("... deleting Worker eve-destroy-fixture");
    expect(text).toContain("✓ VAL-LIFE-006-WORKER");
    expect(text).toContain("✓ VAL-LIFE-006-CONTAINER");
    expect(text).toContain("✓ VAL-LIFE-006-REGISTRY");
    expect(output.filter((line) => line.startsWith("✓ VAL-LIFE-006 "))).toHaveLength(1);
    expect(text).toContain(
      "✓ destroyed eve-destroy-fixture (preview)",
    );
    expect(text).toContain("retained: local deployment records");
    expect(text).not.toContain('"status"');
    expect(() => JSON.parse(text)).toThrow();
  });
});

describe("Workflow World warnings", () => {
  async function writeFixtureProject(root: string): Promise<void> {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "eve-world-warning-fixture",
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
      "utf8",
    );
  }

  function passingControlPlane(root: string, builder = fakeBuilder()) {
    return {
      generationId: "generation-one",
      builder,
      hostRequirements: {
        architecture: "linux/amd64",
        world: "supported",
        sandbox: "supported",
        privileged: false,
        devices: "none",
        kernel: "supported",
        network: "supported",
        durableLocalFilesystem: false,
      } as const,
      runtimeRunner: async () => ({
        ok: true,
        checks: [
          { id: "VAL-BUILD-005", status: "passed" as const, message: "image ok" },
          { id: "VAL-BUILD-006", status: "passed" as const, message: "boot ok" },
          { id: "VAL-BUILD-007", status: "passed" as const, message: "health ok" },
        ],
        imageDigest: `sha256:${"a".repeat(64)}`,
        cleanup: runtimeCleanup,
      }),
      cloudflareRead: async () => ({
        accountAccess: "available" as const,
        containerAccess: "available" as const,
        target: { state: "absent" as const },
      }),
    };
  }
  test("the usage event carries the Eve version and World the preflight resolved", async () => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", () => { bodies.push(body); response.writeHead(204).end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = await mkdtemp(join(tmpdir(), "eden-telemetry-config-"));
    roots.push(config);
    vi.stubEnv("EDEN_TELEMETRY", "");
    vi.stubEnv("DO_NOT_TRACK", "");
    vi.stubEnv("XDG_CONFIG_HOME", config);
    vi.stubEnv("EDEN_TELEMETRY_URL", "http://127.0.0.1:" + String((server.address() as AddressInfo).port) + "/v1/events");
    const root = await createRoot();
    await writeFixtureProject(root);
    const builder = fakeBuilder(async (request) => {
      await writeFile(
        join(request.snapshotRoot, ".output/.eve/compile/compiled-agent-manifest.json"),
        JSON.stringify({ config: { experimental: { workflow: { world: "@workflow/world-postgres" } } } }),
        "utf8",
      );
    });
    try {
      await runEdenCli(["preflight", "--project", root, "--name", "eve-telemetry", "--json"], {
        cwd: root,
        stdout: () => undefined,
        stderr: () => undefined,
        telemetry: true,
        eveControlPlane: passingControlPlane(root, builder),
      });
    } finally {
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    }
    expect(bodies.map((body) => JSON.parse(body) as Record<string, unknown>)).toMatchObject([
      { command: "preflight", eveVersion: "0.91.0", world: "postgres" },
    ]);
  });

  test("rejects installed Eve 0.90.x before building and accepts the 0.91.0 floor", async () => {
    for (const version of ["0.90.9", "0.91.0"]) {
      const root = await createRoot();
      await writeFixtureProject(root);
      await mkdir(join(root, "node_modules/eve"), { recursive: true });
      await writeFile(
        join(root, "node_modules/eve/package.json"),
        JSON.stringify({ name: "eve", version }),
        "utf8",
      );
      const output: string[] = [];
      const builder = fakeBuilder();
      const build = vi.spyOn(builder, "build");
      await expect(runEdenCli(
        ["preflight", "--project", root, "--name", "eve-version-floor", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(root, builder),
        },
      )).resolves.toBe(version === "0.90.9" ? 1 : 0);
      const result = JSON.parse(output[0] as string) as {
        checks: { id: string; status: string }[];
      };
      const failure = result.checks.find((check) =>
        check.id === "EVE_VERSION_UNSUPPORTED" && check.status === "failed"
      );
      if (version === "0.90.9") {
        expect(failure).toBeDefined();
        expect(build).not.toHaveBeenCalled();
      } else {
        expect(failure).toBeUndefined();
        expect(build).toHaveBeenCalledOnce();
      }
    }
  });


  test.each([
    { manager: "npm@11.11.1", custom: false },
    { manager: "pnpm@11.21.0", custom: false },
    { manager: "pnpm@11.21.0", custom: true },
  ])("reports generated setup hints for $manager (custom=$custom)", async ({ manager, custom }) => {
    const root = await createRoot();
    await writeFixtureProject(root);
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "eve-setup-fixture",
      private: true,
      packageManager: manager,
    }));
    await mkdir(join(root, "agent/channels"), { recursive: true });
    await writeFile(join(root, "agent/agent.ts"), custom
      ? 'export default defineAgent({ model: "test", sandbox: customSandbox });'
      : 'export default defineAgent({ model: "test", reasoning: "high" });');
    await writeFile(join(root, "agent/channels/eve.ts"), custom
      ? 'export default eveChannel({ auth: [myAuthenticator()] });'
      : `import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
export default eveChannel({
  auth: [
    // Eve 0.82 initializer defaults.
    vercelOidc(),
    localDev(),
    placeholderAuth(),
  ],
});`);
    const output: string[] = [];
    await runEdenCli(["preflight", "--project", root, "--name", "eve-setup", "--json"], {
      cwd: root,
      stdout: (line) => output.push(line),
      eveControlPlane: passingControlPlane(root),
    });
    const result = JSON.parse(output[0] as string) as {
      warnings: { id: string; remediation?: string }[];
    };
    const ids = result.warnings.map((warning) => warning.id);
    if (custom) {
      expect(ids).not.toContain("EVE_AUTH_SCAFFOLD");
      expect(ids).not.toContain("EVE_JUST_BASH_MISSING");
    } else {
      expect(ids).toContain("EVE_AUTH_SCAFFOLD");
      expect(ids).toContain("EVE_JUST_BASH_MISSING");
      expect(result.warnings.filter((warning) => warning.id === "EVE_WORLD_LOCAL")).toHaveLength(1);
    }
  });

  test.each([
    { command: "preflight", directory: false, provider: undefined },
    { command: "deploy", directory: true, provider: undefined },
    { command: "preflight", directory: false, provider: "DefaultSandbox" },
    { command: "preflight", directory: true, provider: "DockerSandbox" },
    { command: "deploy", directory: false, provider: "VercelSandbox" },
  ])("rejects unsupported sandbox before building or remote access ($command, $provider, directory=$directory)", async ({ command, directory, provider }) => {
    const root = await createRoot();
    await writeFixtureProject(root);
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "eve-sandbox-fixture",
      dependencies: { eve: "^0.91.0" },
    }));
    await rm(join(root, "agent/sandbox.ts"));
    const modulePath = directory ? "agent/sandbox/sandbox.ts" : "agent/sandbox.ts";
    await mkdir(join(root, directory ? "agent/sandbox" : "agent"), { recursive: true });
    if (provider !== undefined) {
      await writeFile(join(root, modulePath),
        `import { ${provider} } from "eve/sandbox";\nexport const environment = ${provider}.environment();\nexport default defineSandbox(() => environment.open());\n`);
    }
    const output: string[] = [];
    const build = vi.fn();
    const cloudflareRead = vi.fn();
    await expect(runEdenCli([command, "--project", root, "--name", "eve-sandbox", "--json"], {
      cwd: root,
      stdout: (line) => output.push(line),
      eveControlPlane: {
        ...passingControlPlane(root),
        builder: { build },
        cloudflareRead,
      },
    })).resolves.toBe(1);
    const result = JSON.parse(output[0] as string) as {
      ok: boolean;
      candidate: unknown;
      checks: { id: string; status: string; message: string; remediation: string }[];
    };
    const diagnostic = result.checks.find((value) => value.id === "EVE_SANDBOX_PROVIDER");
    expect(result.ok).toBe(false);
    expect(result.candidate).toBeNull();
    expect(diagnostic?.status).toBe("failed");
    expect(build).not.toHaveBeenCalled();
    expect(cloudflareRead).not.toHaveBeenCalled();
  });


  test("warns when the compiled agent uses Eve's default local World", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-local", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(root),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_WORLD_LOCAL",
    );
  });

  test("prints the local World warning in human output", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-local-human"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(root),
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    expect(text).toContain("! EVE_WORLD_LOCAL");
    expect(text).toContain("@moinulmoin/eden-world-cloudflare");
    expect(text).toContain("preflight passed");
  });


  test("does not warn when the compiled agent selects a durable World", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-postgres", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: { world: "@workflow/world-postgres" },
                    },
                  },
                }),
                "utf8",
              );
            }),
          ),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).not.toContain(
      "EVE_WORLD_LOCAL",
    );
  });

  test("reports expressible schedules and warns for unsupported crons", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];
    let publishedTriggers: unknown;

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", "eve-scheduled", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...passingControlPlane(
              root,
              fakeBuilder(async (request) => {
                await mkdir(
                  join(request.snapshotRoot, ".output/.eve/compile"),
                  { recursive: true },
                );
                await writeFile(
                  join(
                    request.snapshotRoot,
                    ".output/.eve/compile/compiled-agent-manifest.json",
                  ),
                  JSON.stringify({
                    schedules: [
                      { name: "digest", cron: "0 9 * * 1-5" },
                      { name: "sweep", cron: "*/15 * * * *" },
                      { name: "bad", cron: "@daily" },
                    ],
                  }),
                  "utf8",
                );
              }),
            ),
            containerImageReference:
              `registry.cloudflare.com/account-test/eve@sha256:${"a".repeat(64)}`,
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: { state: "absent" as const },
            }),
            publish: async (request) => {
              publishedTriggers = request.hostConfig.worker.triggers;
              return {
                status: "published" as const,
                identity: request.identity,
                createdByAttempt: true,
                ownershipProven: true as const,
              };
            },
            health: async (request) => ({
              status: "ready" as const,
              identity: request.identity,
            }),
            discardRuntimeImage: async () => true,
          },
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly message: string }[];
      readonly warnings: readonly { readonly id: string }[];
      readonly ok: boolean;
    };
    expect(result.ok).toBe(true);
    expect(
      result.checks.find((value) => value.id === "EVE-SCHEDULES")?.message,
    ).toBe("schedules: 2 (wake via Cloudflare Cron)");
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_SCHEDULE_UNSUPPORTED",
    );
    expect(publishedTriggers).toEqual({ crons: ["* * * * *"] });
  });

  test("warns on a pooled Postgres URL without leaking it", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const envFile = join(await createRoot(), "runtime.env");
    const secret = "pg-pooled-secret-marker-31b7";
    await writeFile(
      envFile,
      `WORKFLOW_POSTGRES_URL=postgresql://eve:${secret}@ep-cool-pooler.eu-central-1.aws.neon.tech/eve\n`,
      "utf8",
    );
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-pooled", "--env-file", envFile, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: { world: "@workflow/world-postgres" },
                    },
                  },
                }),
                "utf8",
              );
            }),
          ),
        },
      ),
    ).resolves.toBe(0);

    const text = output.join("\n");
    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_WORLD_POSTGRES_POOLED",
    );
    expect(result.warnings.map((value) => value.id)).not.toContain(
      "EVE_WORLD_LOCAL",
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("ep-cool-pooler");
  });

  test("does not warn on a direct Postgres URL", async () => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const envFile = join(await createRoot(), "runtime.env");
    await writeFile(
      envFile,
      "WORKFLOW_POSTGRES_URL=postgresql://db.internal.example.org:5432/eve\n",
      "utf8",
    );
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-direct", "--env-file", envFile, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(root),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).not.toContain(
      "EVE_WORLD_POSTGRES_POOLED",
    );
  });

  function postgresWorldBuilder(options: {
    readonly eveVersion?: string;
    readonly eveCore?: string;
    readonly worldVersion?: string;
    readonly worldRange?: string;
    readonly world?: string;
  }) {
    return fakeBuilder(async (request) => {
      await writeFile(
        join(request.snapshotRoot, "node_modules/eve/package.json"),
        JSON.stringify({
          name: "eve",
          version: options.eveVersion ?? "0.91.0",
          bin: "bin/eve.js",
          dependencies: { "@workflow/core": options.eveCore ?? "5.0.0-beta.57" },
        }),
        "utf8",
      );
      await mkdir(
        join(request.snapshotRoot, ".output/.eve/compile"),
        { recursive: true },
      );
      await writeFile(
        join(
          request.snapshotRoot,
          ".output/.eve/compile/compiled-agent-manifest.json",
        ),
        JSON.stringify({
          config: {
            experimental: {
              workflow: { world: options.world ?? "@workflow/world-postgres" },
            },
          },
        }),
        "utf8",
      );
      if (options.worldRange !== undefined) {
        await mkdir(
          join(request.snapshotRoot, "node_modules", options.world ?? "@workflow/world-postgres"),
          { recursive: true },
        );
        await writeFile(
          join(
            request.snapshotRoot,
            `node_modules/${options.world ?? "@workflow/world-postgres"}/package.json`,
          ),
          JSON.stringify({
            name: options.world ?? "@workflow/world-postgres",
            version: options.worldVersion ?? "5.0.0-beta.47",
            ...(options.world === "@moinulmoin/eden-world-cloudflare"
              ? { eden: { capabilities: { worldRpcAuth: true, atomicStartHook: true } } }
              : {}),
            dependencies: { "@workflow/world": options.worldRange },
          }),
          "utf8",
        );
      }
    });
  }

  test.each(["@workflow/world-postgres", "@moinulmoin/eden-world-cloudflare"])("passes the pairing check for %s when the World line matches Eve's", async (world) => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-paired", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            postgresWorldBuilder({ world, worldRange: "5.0.0-beta.39" }),
          ),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
      }[];
      readonly warnings: readonly { readonly id: string }[];
    };
    const pairing = result.checks.find((value) =>
      value.id === "EVE_WORLD_PAIRING"
    );
    expect(pairing?.status).toBe("passed");
    expect(result.warnings.map((warning) => warning.id)).not.toContain("EVE_WORLD_LOCAL");
  });

  test.each(["@workflow/world-postgres", "@moinulmoin/eden-world-cloudflare"])("fails %s pre-checks when the World line does not pair with Eve", async (world) => {
    const root = await createRoot();
    await writeFixtureProject(root);
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-mismatched", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            postgresWorldBuilder({ world, worldRange: "6.0.0-beta.1" }),
          ),
        },
      ),
    ).resolves.toBe(1);

    const result = JSON.parse(output[0] as string) as {
      readonly ok: boolean;
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
        readonly remediation?: string;
      }[];
    };
    expect(result.ok).toBe(false);
    const pairing = result.checks.find((value) =>
      value.id === "EVE_WORLD_PAIRING"
    );
    expect(pairing?.status).toBe("failed");
  });

  // Eve 1.0.0-rc.6 bundles @workflow/core 5.4.0 and refuses to start a
  // session on a World without atomic start hooks; its own error names
  // @workflow/world-postgres 5.1.1 as the first release that has them.
  test.each([
    { worldVersion: "5.0.5", worldRange: "5.0.5", exitCode: 1, status: "failed" },
    { worldVersion: "5.1.0", worldRange: "5.1.0", exitCode: 1, status: "failed" },
    { worldVersion: "5.1.1", worldRange: "5.1.0", exitCode: 0, status: "passed" },
  ])("on Eve 1.0.0-rc.6, @workflow/world-postgres $worldVersion pre-checks $status", async ({ worldVersion, worldRange, exitCode, status }) => {
    const root = await createRoot();
    await writeFixtureProject(root);
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(
      join(root, "agent/sandbox.ts"),
      "import { defineSandbox } from 'eve/sandbox';\nimport { JustBashSandbox } from 'eve/sandbox/just-bash';\nexport const environment = JustBashSandbox.environment();\nexport default defineSandbox(() => environment.open());\n",
    );
    const output: string[] = [];

    await expect(
      runEdenCli(
        ["preflight", "--project", root, "--env", "preview",
        "--name", "eve-world-postgres-rc6", "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: passingControlPlane(
            root,
            postgresWorldBuilder({
              eveVersion: "1.0.0-rc.6",
              eveCore: "5.4.0",
              worldVersion,
              worldRange,
            }),
          ),
        },
      ),
    ).resolves.toBe(exitCode);

    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "EVE_WORLD_PAIRING")?.status,
    ).toBe(status);
  });
});

describe("eden deploy in-place update", () => {
  const updateName = "eve-update-fixture";
  const updateTargetKey = (() => {
    const digest = createHash("sha256")
      .update(`${updateName}\naccount-test\npreview\n${updateName}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    return `preview-${updateName}-${digest}`;
  })();
  const priorImage = `eden-eve-${updateTargetKey}-gen-prior:candidate`;
  const priorImageReference =
    `registry.cloudflare.com/account-test/eden-eve-${updateTargetKey}-gen-prior@sha256:${"b".repeat(64)}`;

  async function writeProject(root: string): Promise<void> {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: updateName,
        private: true,
        packageManager: "pnpm@11.21.0",
      }),
      "utf8",
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }

  function priorWorkerConfig(options: { readonly worldCloudflare?: boolean }) {
    return {
      name: updateName,
      compatibility_date: "2026-04-01",
      compatibility_flags: ["enable_ctx_exports"],
      vars: options.worldCloudflare === true
        ? { EDEN_EVE_WORLD_CLOUDFLARE: true }
        : {},
      containers: [
        {
          name: `${updateName}-container`,
          class_name: "EveHostDurableContainer",
          scheduling_policy: "durable_object",
          images: {
            eve: { image: priorImageReference },
          },
        },
      ],
      durable_objects: {
        bindings: [
          { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
          ...(options.worldCloudflare === true
            ? [{ name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" }]
            : []),
        ],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: options.worldCloudflare === true
            ? ["EveHostDurableContainer", "EdenWorldDurableObject"]
            : ["EveHostDurableContainer"],
        },
      ],
    };
  }

  /**
   * The immutable record a real update reads: generation dir plus the
   * CURRENT pointer at `targets/<env>-<name>/CURRENT`.
   */
  async function createOwnedTargetFixture(
    root: string,
    options: { readonly worldCloudflare?: boolean; readonly accountId?: string } = {},
  ): Promise<{ readonly generationRoot: string }> {
    const generationRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-prior",
    );
    await mkdir(generationRoot, { recursive: true });
    const targetRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "targets",
      `preview-${updateName}`,
    );
    await mkdir(targetRoot, { recursive: true });
    await writeFile(
      join(generationRoot, "deployment.json"),
      JSON.stringify({
        version: 1,
        status: "deployed",
        identity: {
          projectId: updateName,
          sourceDigest: `sha256:${"a".repeat(64)}`,
          generationId: "gen-prior",
          deploymentId: "eve-deploy-prior",
          environment: "preview",
          name: updateName,
          accountId: options.accountId ?? "account-test",
          workersDevSubdomain: "account",
          stableWorkersDevOrigin:
            `https://${updateName}.account.workers.dev`,
          workerName: updateName,
          containerApplicationName: `${updateName}-container`,
          stableContainerInstanceName: `${updateName}-instance`,
          containerImage: priorImageReference,
          runtimeVariableNames: [],
        },
        worker: priorWorkerConfig(options),
        container: {},
      }),
      "utf8",
    );
    await symlink(
      relative(targetRoot, generationRoot),
      join(targetRoot, "CURRENT"),
    );
    return { generationRoot };
  }

  function existingTargetRead() {
    return async () => ({
      accountAccess: "available" as const,
      containerAccess: "available" as const,
      accountId: "account-test",
      workersDevSubdomain: "account",
      target: {
        state: "unowned" as const,
        observed: { worker: true, container: true },
        providerEvidence: {
          containerSchedulingPolicy: "durable_object",
          containerNamespaceId: "namespace-do-test",
          workerContainerNamespaceId: "namespace-do-test",
          workerDeploymentId: "eve-deploy-prior",
          settingsReadable: true,
        },
      },
    });
  }

  function updateControlPlane(
    root: string,
    operations: string[],
    options: {
      readonly builder?: EveProjectBuilder;
      readonly onPublish?: (request: EveDeploymentPublicationRequest) => void;
    } = {},
  ) {
    const newDigest = `sha256:${"d".repeat(64)}`;
    return {
      generationId: "generation-two",
      builder: options.builder ?? fakeBuilder(),
      containerImageReference: `registry.cloudflare.com/account-test/eve@${newDigest}`,
      hostRequirements: {
        architecture: "linux/amd64",
        world: "supported",
        sandbox: "supported",
        privileged: false,
        devices: "none",
        kernel: "supported",
        network: "supported",
        durableLocalFilesystem: false,
      } as const,
      runtimeRunner: async () => ({
        ok: true,
        checks: [
          { id: "VAL-BUILD-005", status: "passed" as const, message: "image ok" },
          { id: "VAL-BUILD-006", status: "passed" as const, message: "boot ok" },
          { id: "VAL-BUILD-007", status: "passed" as const, message: "health ok" },
        ],
        imageDigest: newDigest,
        cleanup: { ...runtimeCleanup, imageRetained: true },
      }),
      cloudflareRead: existingTargetRead(),
      publish: async (request: EveDeploymentPublicationRequest) => {
        operations.push("publish");
        options.onPublish?.(request);
        return {
          status: "published" as const,
          identity: request.identity,
          createdByAttempt: true,
          ownershipProven: true as const,
        };
      },
      health: async (request: EveDeploymentHealthRequest) => {
        operations.push("health");
        return { status: "ready" as const, identity: request.identity };
      },
      deleteRegistryRepository: async ({
        repository,
      }: {
        readonly repository: string;
      }) => {
        operations.push(`delete-superseded-registry:${repository}`);
        return "deleted" as const;
      },
      discardRuntimeImage: async () => {
        operations.push("discard-runtime-image");
        return true;
      },
    };
  }

  test("updates an Eden-owned target in place: republishes, promotes, then deletes the superseded image", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const errors: string[] = [];
    const operations: string[] = [];
    let publishedMigrations: unknown;
    let publishedImage: unknown;
    let publishedPreviousRelease: unknown;

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            onPublish: (request) => {
              publishedPreviousRelease = request.hostConfig.worker.vars.EDEN_EVE_PREVIOUS_RELEASE_ID;
              publishedMigrations = request.hostConfig.worker.migrations;
              publishedImage = request.identity.containerImage;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output[0] as string) as {
      readonly ok: boolean;
      readonly deployment?: {
        readonly operation: string;
        readonly supersededGenerationId?: string;
        readonly supersededImageReference?: string;
      };
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.deployment?.operation).toBe("update");
    expect(result.deployment?.supersededGenerationId).toBe("gen-prior");
    expect(result.deployment?.supersededImageReference).toBe(priorImageReference);
    expect(publishedMigrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
    ]);
    expect(publishedImage).toBe(`registry.cloudflare.com/account-test/eve@sha256:${"d".repeat(64)}`);
    // The published Worker names the release it replaces, so its object serves that release's Workers.
    expect(publishedPreviousRelease).toBe("eve-deploy-prior");
    expect(operations).toEqual([
      "publish",
      "health",
      `delete-superseded-registry:${priorImage.replace(":candidate", "")}`,
      "discard-runtime-image",
    ]);
    const current = await realpath(
      join(
        root,
        ".eden",
        "eve-deploy",
        "targets",
        `preview-${updateName}`,
        "CURRENT",
      ),
    );
    expect(current).toContain("generation-two");
  });

  test.each([
    ["deletes the rest and warns about what the registry keeps", true, 0],
    ["fails VAL-LIFE-007 when another tag is refused with a different answer", false, 1],
  ] as const)("after an update, cleanup of the superseded repository %s", async (_name, otherTagDeletable, expectedExit) => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const repository = priorImage.slice(0, -":candidate".length);
    const snapshot = `${repository}:rootfs-snapshot-aaa`;
    const other = `${repository}:rootfs-set-custom`;
    const chain = `${repository}@${manifest("c")}`;
    const controlPlane = updateControlPlane(root, []);
    Reflect.deleteProperty(controlPlane, "deleteRegistryRepository");
    startFakeRegistry({
      entries: { [repository]: ["candidate", "rootfs-snapshot-aaa", "rootfs-set-custom", manifest("c")] },
      deletable: (ref) => ref !== snapshot && (otherTagDeletable || ref !== other),
      answer: (ref) => ref === snapshot
        ? { status: 403, body: snapshotRefusal }
        : ref === chain
        ? { status: 409, body: singletonRefusal }
        : { status: 403, body: JSON.stringify({ errors: [{ code: "DENIED", message: "access denied" }] }) },
    });
    const output: string[] = [];
    try {
      await expect(
        runEdenCli(
          ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
          { cwd: root, stdout: (line) => output.push(line), eveControlPlane: controlPlane },
        ),
      ).resolves.toBe(expectedExit);
    } finally {
      fakeRegistry.active = false;
    }
    expect(new Set(fakeRegistry.cfDeletes)).toEqual(new Set([priorImage, snapshot, other]));
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
      readonly warnings: readonly { readonly id: string }[];
      readonly registryObjectsKept?: readonly unknown[];
    };
    // What the registry gave a kept answer for is reported either way; only the check differs.
    expect(result.checks.find((entry) => entry.id === "VAL-LIFE-007")?.status)
      .toBe(otherTagDeletable ? "passed" : "failed");
    expect(result.warnings.some((warning) => warning.id === "EVE_REGISTRY_OBJECTS_KEPT")).toBe(true);
    expect(result.registryObjectsKept).toEqual([
      { ref: snapshot, class: "refused-snapshot" },
      { ref: chain, class: "refused-singleton-artifact" },
    ]);
  });

  test.each([
    ["a trailing dot on the registry's name", "registry.cloudflare.com./account-test/REPOSITORY@DIGEST"],
    ["a port on the registry's name", "registry.cloudflare.com:443/account-test/REPOSITORY@DIGEST"],
    ["the registry's name in upper case", "REGISTRY.CLOUDFLARE.COM/account-test/REPOSITORY@DIGEST"],
    ["no registry name", "account-test/REPOSITORY@DIGEST"],
    ["another registry", "registry.example/account-test/REPOSITORY@DIGEST"],
    ["another account", "registry.cloudflare.com/another-account/REPOSITORY@DIGEST"],
    ["the account in upper case", "registry.cloudflare.com/ACCOUNT-TEST/REPOSITORY@DIGEST"],
    ["a repository inside a folder", "registry.cloudflare.com/account-test/eden/REPOSITORY@DIGEST"],
    ["a repository path that climbs", "registry.cloudflare.com/account-test/eve/../REPOSITORY@DIGEST"],
    ["a tag in place of the digest", "registry.cloudflare.com/account-test/REPOSITORY:candidate"],
    ["a tag before the digest", "registry.cloudflare.com/account-test/REPOSITORY:candidate@DIGEST"],
    ["the digest in upper case", `registry.cloudflare.com/account-test/REPOSITORY@sha256:${"D".repeat(64)}`],
    ["another digest algorithm", `registry.cloudflare.com/account-test/REPOSITORY@sha512:${"d".repeat(128)}`],
  ] as const)("refuses an image reference with %s before it publishes", async (_name, spelling) => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const repository = priorImage.slice(0, -":candidate".length);
    const operations: string[] = [];
    const controlPlane = {
      ...updateControlPlane(root, operations),
      containerImageReference: spelling.replace("REPOSITORY", repository).replace("DIGEST", manifest("d")),
    };
    Reflect.deleteProperty(controlPlane, "deleteRegistryRepository");
    startFakeRegistry({
      entries: { [repository]: ["candidate", manifest("b"), manifest("d")] },
      answer: () => ({ status: 204, body: "", leavesAfterMs: 0 }),
    });
    const output: string[] = [];
    try {
      await expect(
        runEdenCli(
          ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
          { cwd: root, stdout: (line) => output.push(line), eveControlPlane: controlPlane },
        ),
      ).resolves.toBe(1);
    } finally {
      fakeRegistry.active = false;
    }
    expect(JSON.parse(output[0] as string)).toMatchObject({ ok: false, error: { code: "EVE_IMAGE_IDENTITY_MISMATCH" } });
    expect(operations).toEqual([]);
    expect(fakeRegistry.cfDeletes).toEqual([]);
    expect(fakeRegistry.registryRequests).toEqual([]);
    const current = await realpath(join(root, ".eden", "eve-deploy", "targets", `preview-${updateName}`, "CURRENT"));
    expect(current).toContain("gen-prior");
  });

  test("deletes nothing from the superseded repository when the promoted image is in it", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const repository = priorImage.slice(0, -":candidate".length);
    const controlPlane = {
      ...updateControlPlane(root, []),
      // A programmatic caller names an image that it pushed to the prior generation's repository.
      containerImageReference: `registry.cloudflare.com/account-test/${repository}@${manifest("d")}`,
    };
    Reflect.deleteProperty(controlPlane, "deleteRegistryRepository");
    startFakeRegistry({
      entries: { [repository]: ["candidate", manifest("b"), manifest("d")] },
      answer: () => ({ status: 204, body: "", leavesAfterMs: 0 }),
    });
    const output: string[] = [];
    try {
      await expect(
        runEdenCli(
          ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
          { cwd: root, stdout: (line) => output.push(line), eveControlPlane: controlPlane },
        ),
      ).resolves.toBe(0);
    } finally {
      fakeRegistry.active = false;
    }
    expect(fakeRegistry.cfDeletes).toEqual([]);
    expect(fakeRegistry.registryRequests).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly deployment: { readonly imageReference: string };
      readonly checks: readonly { readonly id: string; readonly status: string; readonly message: string }[];
    };
    expect(result.deployment.imageReference).toBe(controlPlane.containerImageReference);
    expect(result.checks.find((entry) => entry.id === "VAL-LIFE-007")).toMatchObject({
      status: "skipped",
      message: expect.stringContaining("nothing in it was deleted") as unknown,
    });
  });

  /** Builds a project whose World declares deployment affinity. */
  const affinityWorldBuilder = () =>
    fakeBuilder(async (request) => {
      await mkdir(join(request.snapshotRoot, ".output/.eve/compile"), { recursive: true });
      await writeFile(
        join(request.snapshotRoot, ".output/.eve/compile/compiled-agent-manifest.json"),
        JSON.stringify({ config: { experimental: { workflow: { world: "@moinulmoin/eden-world-cloudflare" } } } }),
        "utf8",
      );
      const worldRoot = join(request.snapshotRoot, "node_modules/@moinulmoin/eden-world-cloudflare");
      await mkdir(worldRoot, { recursive: true });
      await writeFile(join(worldRoot, "package.json"), JSON.stringify({
        version: "0.11.1",
        eden: { capabilities: { worldRpcAuth: true, atomicStartHook: true, deploymentAffinity: true } },
      }));
    });

  test.each([
    ["an image reference in another spelling", `registry.cloudflare.com./account-test/eve@${manifest("d")}`],
    ["an image reference with another digest", `registry.cloudflare.com/account-test/eve@${manifest("e")}`],
  ] as const)("with deployment affinity, refuses %s before it changes the target", async (_name, containerImageReference) => {
    const root = await createRoot();
    await writeProject(root);
    const { generationRoot } = await createOwnedTargetFixture(root, { worldCloudflare: true });
    // The prior record keeps one version that has drained, so a deploy would retire it.
    const kept = `eden-affinity-${"2".repeat(24)}`;
    const recordPath = join(generationRoot, "deployment.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { identity: Record<string, unknown> };
    record.identity.retainedDeployments = {
      [kept]: {
        image: `registry.cloudflare.com/account-test/eden-eve-${updateTargetKey}-${kept}@${manifest("e")}`,
        generationId: "gen-kept",
        eveVersion: "0.90.0",
        worldRpcAuth: true,
      },
    };
    await writeFile(recordPath, JSON.stringify(record), "utf8");
    const operations: string[] = [];
    const output: string[] = [];
    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, operations, { builder: affinityWorldBuilder() }),
            containerImageReference,
            protectedStore: {
              put: async () => {
                operations.push("write-control-secret");
                return { revision: "revision-test", handle: "handle-test" };
              },
            },
            deploymentRpc: async (request: { readonly operation: string; readonly deploymentIds: readonly string[] }) => {
              operations.push(request.operation);
              return request.operation === "deployments.retire"
                ? { retired: request.deploymentIds }
                : Object.fromEntries(request.deploymentIds.map((id) => [id, {
                  liveRuns: 0, liveSessions: 0, pendingMessages: 0, unfinishedTransfers: 0, drained: true,
                }]));
            },
          },
        },
      ),
    ).resolves.toBe(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({ ok: false, error: { code: "EVE_IMAGE_IDENTITY_MISMATCH" } });
    // No control secret, no drain read, no retirement, no publication.
    expect(operations).toEqual([]);
  });

  test.each([
    ["sweeps each retired version's repository and records the retirements", "its own"],
    ["leaves one retirement pending while a kept version's image is in its repository, and finishes the other", "the retiring"],
    ["leaves every retirement pending while a kept version's image is spelled so that Eden cannot place it", "none"],
  ] as const)("with deployment affinity, cleanup %s", async (_name, keptIn) => {
    const root = await createRoot();
    await writeProject(root);
    const { generationRoot } = await createOwnedTargetFixture(root, { worldCloudflare: true });
    const [retiring, kept, other] = ["1", "2", "3"].map((digit) => `eden-affinity-${digit.repeat(24)}`) as [string, string, string];
    const repository = `eden-eve-${updateTargetKey}-${retiring}`;
    const otherRepository = `eden-eve-${updateTargetKey}-${other}`;
    const image = (name: string, letter: string): string => `registry.cloudflare.com/account-test/${name}@${manifest(letter)}`;
    // The prior record keeps one version that still has a session and owes two retirements.
    const recordPath = join(generationRoot, "deployment.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { identity: Record<string, unknown> };
    record.identity.retainedDeployments = {
      [kept]: {
        image: keptIn === "none"
          // The same registry, with a trailing dot on its name.
          ? image(repository, "e").replace("registry.cloudflare.com/", "registry.cloudflare.com./")
          : image(keptIn === "the retiring" ? repository : `eden-eve-${updateTargetKey}-${kept}`, "e"),
        generationId: "gen-kept",
        eveVersion: "0.90.0",
        worldRpcAuth: true,
      },
    };
    record.identity.pendingRetirements = {
      [retiring]: { image: image(repository, "c"), generationId: "gen-retiring" },
      [other]: { image: image(otherRepository, "f"), generationId: "gen-other" },
    };
    await writeFile(recordPath, JSON.stringify(record), "utf8");
    const rpc: string[] = [];
    const controlPlane = {
      ...updateControlPlane(root, [], { builder: affinityWorldBuilder() }),
      protectedStore: { put: async () => ({ revision: "revision-test", handle: "handle-test" }) },
      // A Worker with deployment affinity names its Container instance after the deployment.
      health: async (request: EveDeploymentHealthRequest) => ({
        status: "ready" as const,
        identity: {
          ...request.identity,
          stableContainerInstanceName: `${request.identity.stableContainerInstanceName}:${request.identity.deploymentId}`,
        },
      }),
      deploymentRpc: async (request: { readonly operation: string; readonly deploymentIds: readonly string[] }) => {
        rpc.push(`${request.operation}:${request.deploymentIds.join(",")}`);
        return request.operation === "deployments.retire"
          ? { retired: request.deploymentIds }
          : Object.fromEntries(request.deploymentIds.map((id) => [id, {
            liveRuns: 0, liveSessions: 1, pendingMessages: 0, unfinishedTransfers: 0, drained: false,
          }]));
      },
    };
    Reflect.deleteProperty(controlPlane, "deleteRegistryRepository");
    startFakeRegistry({
      entries: {
        [repository]: keptIn === "its own" ? [manifest("c")] : [manifest("c"), manifest("e")],
        [otherRepository]: [manifest("f")],
      },
      answer: () => ({ status: 204, body: "", leavesAfterMs: 0 }),
    });
    const output: string[] = [];
    try {
      await expect(
        runEdenCli(
          ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
          { cwd: root, stdout: (line) => output.push(line), eveControlPlane: controlPlane },
        ),
      ).resolves.toBe(keptIn === "its own" ? 0 : 1);
    } finally {
      fakeRegistry.active = false;
    }
    expect(rpc).toContain(`deployments.retire:${retiring},${other}`);
    expect(registryDeletes()).toEqual([
      ...(keptIn === "its own" ? [`${repository}@${manifest("c")}`] : []),
      ...(keptIn === "none" ? [] : [`${otherRepository}@${manifest("f")}`]),
    ]);
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string; readonly message: string }[];
    };
    const cleanup = result.checks.find((entry) => entry.id === "VAL-LIFE-007");
    expect(cleanup?.status).toBe(keptIn === "its own" ? "passed" : "failed");
    if (keptIn !== "its own") expect(cleanup?.message).toContain("holds an image that is still deployed; nothing in it was deleted");
    // A pending retirement gets one instruction, in the check and in the error: wait for the next deploy.
    if (keptIn !== "its own") {
      const failed = JSON.parse(output[0] as string) as {
        readonly checks: readonly { readonly id: string; readonly remediation?: string }[];
        readonly error: { readonly code: string; readonly message: string; readonly remediation: string };
      };
      expect(failed.error.code).toBe("EVE_RUNTIME_IMAGE_CLEANUP_FAILED");
      expect(failed.error.remediation).toContain("Do not redeploy for this");
      expect(failed.error.remediation).toBe(failed.checks.find((entry) => entry.id === "VAL-LIFE-007")?.remediation);
      expect(output[0]).not.toContain("Retry deploy");
      expect(output[0]).not.toContain("Rerun eden deploy");
    }
    // Only a proven cleanup is recorded as done, so the next deploy retries the other.
    const current = await realpath(join(root, ".eden", "eve-deploy", "targets", `preview-${updateName}`, "CURRENT"));
    const completed = await readFile(join(current, "completed-retirements.json"), "utf8").catch(() => undefined);
    expect(JSON.parse(completed ?? "[]")).toEqual(
      keptIn === "its own" ? [retiring, other] : keptIn === "the retiring" ? [other] : [],
    );
  });

  /**
   * A target on a World with deployment affinity, deployed twice or more on
   * one Eve version, so each update pushes into the repository of the image
   * it replaces. The registry behaves as Cloudflare's did on 2026-11-18: an
   * image leaves a few seconds after its tag is deleted, and one that no tag
   * names stays whatever the registry answers to its delete.
   */
  async function inPlaceUpdates(root: string) {
    await writeProject(root);
    await createOwnedTargetFixture(root, { worldCloudflare: true });
    let live: { deploymentId?: string; releaseId?: string } = { deploymentId: "eve-deploy-prior" };
    const state = {
      healthy: true, tagsDeletable: true, worldRetires: true, pushed: [] as string[],
      /** The release the live Worker reports, when a case rewrites the record's. */
      liveReleaseId: undefined as string | undefined,
    };
    startFakeRegistry({
      entries: {},
      deletable: (ref) => {
        const [repository = "", tag = ""] = ref.split(":");
        const image = images.get(ref);
        if (state.tagsDeletable && image !== undefined) {
          fakeRegistry.leaving.push({ repository, entry: image, at: fakeRegistry.clock + 5_000 });
        }
        return state.tagsDeletable && tag !== "";
      },
      answer: (ref) => ({ status: ref.includes("@") ? 204 : 500, body: "" }),
    });
    const images = fakeRegistry.digests;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => fakeRegistry.clock);
    const stop = (): void => {
      fakeRegistry.active = false;
      clock.mockRestore();
    };
    const read = existingTargetRead();
    const deploy = async (generation: string, digest: string) => {
      const output: string[] = [];
      let published: EveDeploymentPublicationRequest["identity"] | undefined;
      const base = updateControlPlane(root, [], { builder: affinityWorldBuilder(), onPublish: (request) => { published = request.identity; } });
      Reflect.deleteProperty(base, "deleteRegistryRepository");
      Reflect.deleteProperty(base, "containerImageReference");
      const code = await runEdenCli(
        ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...base,
            generationId: generation,
            runtimeRunner: async () => ({
              ...(await base.runtimeRunner()), imageDigest: digest, imageReference: "eden-local-image",
            }),
            publishImage: (request) => {
              const [repository = ""] = request.localImageTag.split(":");
              state.pushed.push(request.localImageTag);
              images.set(request.localImageTag, digest);
              fakeRegistry.entries.set(repository, [
                ...(fakeRegistry.entries.get(repository) ?? []), request.localImageTag.slice(repository.length + 1), digest,
              ]);
              return { status: "published" as const, imageReference: request.targetImageReference, imageDigest: digest };
            },
            cloudflareRead: async () => {
              const target = (await read()).target;
              return { ...(await read()), target: { ...target, providerEvidence: {
                ...target.providerEvidence, workerDeploymentId: live.deploymentId,
                workerReleaseId: state.liveReleaseId ?? live.releaseId,
              } } };
            },
            protectedStore: { put: async () => ({ revision: "revision-test", handle: "handle-test" }) },
            health: async (request: EveDeploymentHealthRequest) => state.healthy
              ? {
                status: "ready" as const,
                identity: {
                  ...request.identity,
                  stableContainerInstanceName: `${request.identity.stableContainerInstanceName}:${request.identity.deploymentId}`,
                },
              }
              : { status: "failed" as const, reason: "The new deployment did not become healthy." },
            // The first of these deploys retires the version from before it, which had no World RPC authentication.
            deploymentRpc: async (request: { readonly operation: string; readonly deploymentIds: readonly string[] }) =>
              request.operation === "deployments.retire"
                ? { retired: state.worldRetires ? request.deploymentIds : [] }
                : Object.fromEntries(request.deploymentIds.map((id) => [id, {
                  liveRuns: 0, liveSessions: 0, pendingMessages: 0, unfinishedTransfers: 0, drained: true,
                }])),
          },
        },
      );
      const result = JSON.parse(output[0] as string) as {
        readonly ok: boolean;
        readonly warnings: readonly { readonly id: string; readonly remediation: string }[];
        readonly checks: readonly { readonly id: string; readonly status: string; readonly message: string }[];
        readonly registryObjectsKept?: readonly unknown[];
      };
      if (result.ok && published !== undefined) live = published;
      return { code, result, repository: (state.pushed.at(-1) ?? "").split(":")[0] as string };
    };
    return { state, images, deploy, stop };
  }

  test.each([
    ["this build pushed under the tag of its own deploy is deleted", "own"],
    ["Eden 0.13.x pushed under the candidate tag is left tagged", "candidate"],
    ["an older record names no release for is left tagged, and the registry is not asked", "unrecorded"],
  ] as const)("an update of the same Eve version deletes the image it replaces only by a tag of its own: the image %s", async (_name, prior) => {
    const root = await createRoot();
    const { state, images, deploy, stop } = await inPlaceUpdates(root);
    try {
      const first = await deploy("generation-two", manifest("c"));
      expect(first.code).toBe(0);
      const repository = first.repository;
      // Each push has a tag of its own that Eden generated, whatever the generation is called.
      expect(state.pushed[0]).toMatch(new RegExp(`^${repository}:eve-deploy-[0-9a-f-]{36}$`, "u"));
      let priorTag = (state.pushed[0] as string).slice(repository.length + 1);
      if (prior === "unrecorded") {
        const recordPath = join(await realpath(join(root, ".eden", "eve-deploy", "targets", `preview-${updateName}`, "CURRENT")), "deployment.json");
        const record = JSON.parse(await readFile(recordPath, "utf8")) as { identity: Record<string, unknown> };
        record.identity.releaseId = "candidate";
        await writeFile(recordPath, JSON.stringify(record), "utf8");
        state.liveReleaseId = "candidate";
      }
      if (prior !== "own") {
        // What Eden 0.13.x left: the image under `candidate`, and an older one that lost that tag to it.
        priorTag = "candidate";
        images.set(`${repository}:candidate`, manifest("c"));
        fakeRegistry.entries.set(repository, ["candidate", manifest("c"), manifest("e")]);
      }
      const requestsBefore = fakeRegistry.registryRequests.length;
      const second = await deploy("generation-three", manifest("d"));
      expect(second.code).toBe(0);
      expect(second.result.ok).toBe(true);
      const promotedTag = (state.pushed[1] as string).slice(repository.length + 1);
      expect(promotedTag).toMatch(/^eve-deploy-[0-9a-f-]{36}$/u);
      expect(promotedTag).not.toBe(priorTag);
      if (prior !== "own") {
        // The older image keeps its tag, so destroy can still remove it. Nothing is deleted.
        expect(fakeRegistry.cfDeletes).toEqual([]);
        expect(registryDeletes()).toEqual([]);
        if (prior === "unrecorded") expect(fakeRegistry.registryRequests.slice(requestsBefore)).toEqual([]);
        expect(fakeRegistry.listed(repository)).toEqual(["candidate", promotedTag, manifest("c"), manifest("d"), manifest("e")]);
        expect(second.result.checks.find((entry) => entry.id === "VAL-LIFE-007")?.status).toBe("skipped");
      } else {
        // Every request of the cleanup: a listing, what the tag names, cf's delete of
        // that tag, and listings until the image has left. Eden sends no delete of its own.
        expect(fakeRegistry.cfDeletes).toEqual([`${repository}:${priorTag}`]);
        // A listing is two requests: its page, and the empty page that ends it.
        const listing = [`GET ${repository}`, `GET ${repository}`];
        expect(fakeRegistry.registryRequests.slice(requestsBefore).map((sent) => `${String(sent.method)} ${sent.ref}`)).toEqual([
          ...listing,
          `HEAD ${repository}:${priorTag}`,
          ...listing,
          ...listing,
        ]);
        expect(fakeRegistry.listed(repository)).toEqual([promotedTag, manifest("d")]);
        expect(second.result.checks.find((entry) => entry.id === "VAL-LIFE-007")).toMatchObject({
          status: "passed",
          message: "The superseded image was deleted from the registry by its tag after promotion.",
        });
      }
      expect(second.result.registryObjectsKept).toBeUndefined();
      expect(second.result.warnings.map((warning) => warning.id)).not.toContain("EVE_SUPERSEDED_IMAGE_NOT_DELETED");
    } finally {
      stop();
    }
  });

  test("an update that does not become healthy deletes nothing from the registry", async () => {
    const root = await createRoot();
    const { state, deploy, stop } = await inPlaceUpdates(root);
    try {
      const { repository } = await deploy("generation-two", manifest("c"));
      state.healthy = false;
      expect((await deploy("generation-three", manifest("d"))).code).not.toBe(0);
      expect(fakeRegistry.cfDeletes).toEqual([]);
      expect(registryDeletes()).toEqual([]);
      expect(fakeRegistry.listed(repository)).toEqual(
        [...state.pushed.map((pushed) => pushed.slice(repository.length + 1)), manifest("c"), manifest("d")].sort(),
      );
    } finally {
      stop();
    }
  });

  test("a superseded image that cannot be deleted does not fail the update", async () => {
    const root = await createRoot();
    const { state, deploy, stop } = await inPlaceUpdates(root);
    try {
      const { repository } = await deploy("generation-two", manifest("c"));
      state.tagsDeletable = false;
      const second = await deploy("generation-three", manifest("d"));
      expect(second.code).toBe(0);
      expect(second.result.ok).toBe(true);
      expect(second.result.checks.filter((entry) => entry.status === "failed")).toEqual([]);
      const warning = second.result.warnings.find((entry) => entry.id === "EVE_SUPERSEDED_IMAGE_NOT_DELETED");
      // It promises no retry by a later deploy; destroy and the version's retirement sweep the repository.
      expect(warning?.remediation).toContain("A later deploy does not try this image again. eden destroy tries to delete everything the registry lists for the target");
      expect(fakeRegistry.listed(repository)).toContain((state.pushed[0] as string).slice(repository.length + 1));
    } finally {
      stop();
    }
  });

  /** While a cf that never exits runs, its time limit, and the wait for an exit after a kill that fails, take no time. */
  function shortCfTimeouts(): () => void {
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: () => void, timeoutMs?: number) => realSetTimeout(
        handler,
        fakeRegistry.cfHanging && (timeoutMs === 120_000 || (timeoutMs === 2_000 && !fakeRegistry.cfStopsOnKill)) ? 0 : timeoutMs,
      )) as unknown as typeof setTimeout,
    );
    return () => timers.mockRestore();
  }

  test.each([
    ["cf ran out of time after its tag delete, and the registry knows neither the tag nor the digest", "unknown"],
    ["cf ran out of time and did not stop", "still-running"],
    ["cf ran out of time, and the listing omits the image while the registry still serves its manifest", "stale-listing"],
    ["cf ran out of time, and the registry's 404 for the tag says more than MANIFEST_UNKNOWN for it", "extra-field"],
    ["cf ran out of time before its tag delete", "not-deleted"],
  ] as const)("a same-version update whose cf delete never exits: %s", async (_name, scenario) => {
    const root = await createRoot();
    const { state, deploy, stop } = await inPlaceUpdates(root);
    const restore = shortCfTimeouts();
    try {
      const { repository } = await deploy("generation-two", manifest("c"));
      const prior = state.pushed[0] as string;
      const tag = prior.slice(repository.length + 1);
      fakeRegistry.cfHangs = scenario === "not-deleted" ? "before-delete" : "after-delete";
      fakeRegistry.cfStopsOnKill = scenario !== "still-running";
      if (scenario === "stale-listing") fakeRegistry.manifestRead = () => ({ status: 200, body: "{}" });
      if (scenario === "extra-field") {
        fakeRegistry.manifestRead = (ref) => ({
          status: 404,
          body: JSON.stringify({ errors: [{
            code: "MANIFEST_UNKNOWN", message: "manifest unknown", detail: { Tag: ref.slice(repository.length + 1) }, repository: "another-repository",
          }] }),
        });
      }
      const requestsBefore = fakeRegistry.registryRequests.length;
      const second = await deploy("generation-three", manifest("d"));
      expect(second.code).toBe(0);
      expect(second.result.ok).toBe(true);
      expect(fakeRegistry.cfDeletes).toEqual([prior]);
      const listing = [`GET ${repository}`, `GET ${repository}`];
      const sent = fakeRegistry.registryRequests.slice(requestsBefore).map((request) => `${String(request.method)} ${request.ref}`);
      const warning = second.result.warnings.find((entry) => entry.id === "EVE_SUPERSEDED_IMAGE_NOT_DELETED") as
        { readonly message?: string } | undefined;
      const lead = `The update is healthy and promoted, but Eden could not show that the superseded image ${repository}@${manifest("c")} left Cloudflare's registry. `;
      const stopped = " cf containers images delete ran out of time and was stopped.";
      if (scenario === "unknown") {
        // The listing, then the registry's own answer for the tag and for the digest.
        expect(sent).toEqual([...listing, `HEAD ${prior}`, ...listing, ...listing, `GET ${prior}`, `GET ${repository}@${manifest("c")}`]);
        expect(second.result.checks.find((entry) => entry.id === "VAL-LIFE-007")).toMatchObject({
          status: "passed",
          message: "The superseded image was deleted from the registry by its tag after promotion.",
        });
        expect(warning).toBeUndefined();
        return;
      }
      expect(second.result.checks.find((entry) => entry.id === "VAL-LIFE-007")?.status).not.toBe("passed");
      if (scenario === "still-running") {
        // Nothing is read while cf may still run.
        expect(sent).toEqual([...listing, `HEAD ${prior}`]);
        expect(warning?.message).toBe(lead + "cf containers images delete ran out of time and did not stop, so it may still run. Eden did not read the registry after it.");
      } else if (scenario === "stale-listing" || scenario === "extra-field") {
        expect(sent).toEqual([...listing, `HEAD ${prior}`, ...listing, ...listing, `GET ${prior}`]);
        expect(warning?.message).toBe(lead + `The listing no longer had the tag ${tag} or the image's sha256: entry, but the registry did not answer a manifest read for the tag with MANIFEST_UNKNOWN.` + stopped);
      } else {
        expect(sent.filter((request) => request.startsWith("GET ") && request.includes(":") && !request.endsWith(repository))).toEqual([]);
        expect(warning?.message).toBe(lead + `The registry still listed the tag ${tag} in a listing begun 30 seconds after cf returned.` + stopped);
      }
    } finally {
      restore();
      stop();
    }
  });

  test.each([
    ["cf reports a failure", "cf-fails"],
    ["the tag names no image", "unresolved"],
  ] as const)("the warning for a superseded image that was not deleted says which step failed: %s", async (_name, failure) => {
    const root = await createRoot();
    const { state, images, deploy, stop } = await inPlaceUpdates(root);
    try {
      const { repository } = await deploy("generation-two", manifest("c"));
      const prior = state.pushed[0] as string;
      const tag = prior.slice(repository.length + 1);
      if (failure === "unresolved") images.delete(prior);
      else state.tagsDeletable = false;
      const second = await deploy("generation-three", manifest("d"));
      expect(second.code).toBe(0);
      expect(second.result.ok).toBe(true);
      expect(fakeRegistry.cfDeletes).toEqual(failure === "unresolved" ? [] : [prior]);
      const warning = second.result.warnings.find((entry) => entry.id === "EVE_SUPERSEDED_IMAGE_NOT_DELETED") as
        { readonly message?: string } | undefined;
      expect(warning?.message).toBe(
        `The update is healthy and promoted, but Eden could not show that the superseded image ${repository}@${manifest("c")} left Cloudflare's registry. ` + {
          "cf-fails": `cf containers images delete exited 1: Failed to delete ${prior} (digest: sha256:${"0".repeat(64)}): 403 Forbidden`,
          unresolved: `The registry did not answer a HEAD for the tag ${tag} with one digest.`,
        }[failure],
      );
    } finally {
      stop();
    }
  });

  test("an update whose generation is named candidate keeps the tag of the image it just promoted", async () => {
    const root = await createRoot();
    const { state, deploy, stop } = await inPlaceUpdates(root);
    try {
      const { repository } = await deploy("generation-two", manifest("c"));
      expect((await deploy("candidate", manifest("d"))).code).toBe(0);
      const [, promotedTag = ""] = (state.pushed[1] as string).split(":");
      expect(promotedTag).not.toBe("candidate");
      expect(fakeRegistry.listed(repository)).toEqual([promotedTag, manifest("d")].sort());
    } finally {
      stop();
    }
  });

  test("an update deletes no tag that it cannot tie to the image it replaced", async () => {
    const root = await createRoot();
    const { images, deploy, stop } = await inPlaceUpdates(root);
    try {
      const { repository } = await deploy("generation-two", manifest("c"));
      // Another generation's folder in this project, and a tag of that name in the repository.
      await mkdir(join(root, ".eden", "eve-deploy", "generations", "other-generation"), { recursive: true });
      // A candidate tag that names some other image.
      images.set(`${repository}:other-generation`, manifest("e"));
      images.set(`${repository}:candidate`, manifest("e"));
      fakeRegistry.entries.set(repository, [...fakeRegistry.listed(repository), "candidate", "other-generation", manifest("e")]);
      expect((await deploy("generation-three", manifest("d"))).code).toBe(0);
      expect(fakeRegistry.listed(repository)).toEqual(expect.arrayContaining(["candidate", "other-generation", manifest("e")]));
      expect(fakeRegistry.listed(repository)).not.toContain(manifest("c"));
    } finally {
      stop();
    }
  });

  test("an update deletes nothing from a repository that holds an image whose retirement the World did not confirm", async () => {
    const root = await createRoot();
    const { state, images, deploy, stop } = await inPlaceUpdates(root);
    try {
      const { repository } = await deploy("generation-two", manifest("c"));
      // The record owes the retirement of a version whose image is in the same repository.
      const recordPath = join(await realpath(join(root, ".eden", "eve-deploy", "targets", `preview-${updateName}`, "CURRENT")), "deployment.json");
      const record = JSON.parse(await readFile(recordPath, "utf8")) as { identity: Record<string, unknown> };
      record.identity.pendingRetirements = {
        [`eden-affinity-${"9".repeat(24)}`]: {
          image: `registry.cloudflare.com/account-test/${repository}@${manifest("e")}`, generationId: "generation-pending",
        },
      };
      await writeFile(recordPath, JSON.stringify(record), "utf8");
      await mkdir(join(root, ".eden", "eve-deploy", "generations", "generation-pending"), { recursive: true });
      images.set(`${repository}:generation-pending`, manifest("e"));
      fakeRegistry.entries.set(repository, [...fakeRegistry.listed(repository), "generation-pending", manifest("e")]);
      state.worldRetires = false;
      const second = await deploy("generation-three", manifest("d"));
      expect(second.result.checks.find((entry) => entry.id === "VAL-LIFE-007")?.status).toBe("failed");
      expect(fakeRegistry.cfDeletes).toEqual([]);
      expect(registryDeletes()).toEqual([]);
      expect(fakeRegistry.listed(repository)).toEqual(expect.arrayContaining(["generation-pending", manifest("e"), manifest("c")]));
    } finally {
      stop();
    }
  });

  test("reads back the record of an update that gave a kept version a suffixed id", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root, { worldCloudflare: true });
    const currentPath = join(root, ".eden", "eve-deploy", "targets", `preview-${updateName}`, "CURRENT");
    // The Worker Cloudflare reports is the one the last successful deploy published.
    let live: { deploymentId?: string; releaseId?: string } = { deploymentId: "eve-deploy-prior" };
    const deploy = async (generation: string) => {
      const output: string[] = [];
      let published: EveDeploymentPublicationRequest["identity"] | undefined;
      const read = existingTargetRead();
      const code = await runEdenCli(
        ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, [], {
              // A World that declares deployment affinity and World RPC authentication.
              builder: fakeBuilder(async (request) => {
                await mkdir(join(request.snapshotRoot, ".output/.eve/compile"), { recursive: true });
                await writeFile(
                  join(request.snapshotRoot, ".output/.eve/compile/compiled-agent-manifest.json"),
                  JSON.stringify({ config: { experimental: { workflow: { world: "@moinulmoin/eden-world-cloudflare" } } } }),
                  "utf8",
                );
                const worldRoot = join(request.snapshotRoot, "node_modules/@moinulmoin/eden-world-cloudflare");
                await mkdir(worldRoot, { recursive: true });
                await writeFile(join(worldRoot, "package.json"), JSON.stringify({
                  version: "0.11.2",
                  eden: { capabilities: { worldRpcAuth: true, atomicStartHook: true, deploymentAffinity: true } },
                }));
              }),
              onPublish: (request) => { published = request.identity; },
            }),
            generationId: generation,
            cloudflareRead: async () => {
              const base = await read();
              return { ...base, target: { ...base.target, providerEvidence: {
                ...base.target.providerEvidence, workerDeploymentId: live.deploymentId, workerReleaseId: live.releaseId,
              } } };
            },
            protectedStore: { put: async () => ({ revision: "revision-test", handle: "handle-test" }) },
            health: async (request: EveDeploymentHealthRequest) => ({
              status: "ready" as const,
              identity: {
                ...request.identity,
                stableContainerInstanceName: `${request.identity.stableContainerInstanceName}:${request.identity.deploymentId}`,
              },
            }),
            deploymentRpc: async (request: { readonly operation: string; readonly deploymentIds: readonly string[] }) =>
              request.operation === "deployments.retire"
                ? { retired: request.deploymentIds }
                : Object.fromEntries(request.deploymentIds.map((id) => [id, {
                  liveRuns: 0, liveSessions: 0, pendingMessages: 0, unfinishedTransfers: 0, drained: true,
                }])),
          },
        },
      );
      const result = JSON.parse(output[0] as string) as {
        readonly ok: boolean;
        readonly warnings?: readonly { readonly id: string }[];
        readonly checks: readonly { readonly id: string; readonly status: string }[];
      };
      if (result.ok && published !== undefined) live = published;
      return { code, result, deploymentId: published?.deploymentId };
    };

    const first = await deploy("generation-two");
    expect(first.code).toBe(0);
    expect(first.deploymentId).toMatch(/^eden-affinity-[a-f0-9]{24}$/u);
    // Eden 0.11.0 and 0.11.1 kept a version like this one: its World had no RPC authentication.
    const recordPath = join(await realpath(currentPath), "deployment.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      identity: { retainedDeployments: Record<string, { worldRpcAuth: boolean }> };
    };
    (record.identity.retainedDeployments[first.deploymentId as string] as { worldRpcAuth: boolean }).worldRpcAuth = false;
    await writeFile(recordPath, JSON.stringify(record), "utf8");

    // The same Eve version again: the old version is retired, and the new one cannot reuse its id.
    const second = await deploy("generation-three");
    expect(second.code).toBe(0);
    expect(second.result.warnings?.map((warning) => warning.id)).toContain("EVE_UNAUTHENTICATED_VERSIONS_RETIRED");
    expect(second.deploymentId).toMatch(new RegExp(`^${first.deploymentId as string}-[a-f0-9]{8}$`, "u"));

    // The next update proves the Worker from that record and keeps the id.
    const third = await deploy("generation-four");
    expect(third.result.checks.filter((check) => check.status === "failed")).toEqual([]);
    expect(third.code).toBe(0);
    expect(third.deploymentId).toBe(second.deploymentId);

    // Destroy reads it too.
    const destroyed: string[] = [];
    await expect(
      runEdenCli(
        ["destroy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => destroyed.push(line),
          eveControlPlane: {
            destroyCloudflareRead: async () => ({
              workerExists: false,
              containerApplicationId: undefined,
              registryTagsPresent: [],
              accountId: "account-test",
            }),
          },
        },
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(destroyed[0] as string)).toMatchObject({ ok: true, status: "absent" });
  });

  test("still fails VAL-CLI-007-TARGET-CONFLICT when the existing target has no Eden record", async () => {
    const root = await createRoot();
    await writeProject(root);
    const output: string[] = [];
    const errors: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
          eveControlPlane: updateControlPlane(root, operations),
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly ok: boolean;
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
    expect(JSON.parse(output[0] as string)).toMatchObject({
      error: { code: "EVE_DEPLOY_CHECKS_FAILED" },
    });
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("keeps migration history append-only and appends v2 when the World class is first introduced", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root, { worldCloudflare: false });
    const output: string[] = [];
    const operations: string[] = [];
    let publishedMigrations: unknown;
    let publishedBindings: unknown;
    let workerSource = "";

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            builder: fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: {
                        world: "@moinulmoin/eden-world-cloudflare",
                      },
                    },
                  },
                }),
                "utf8",
              );
              const worldRoot = join(request.snapshotRoot, "node_modules/@moinulmoin/eden-world-cloudflare");
              await mkdir(worldRoot, { recursive: true });
              await writeFile(join(worldRoot, "package.json"), JSON.stringify({
                version: "0.11.1",
                eden: { capabilities: { worldRpcAuth: true, atomicStartHook: true } },
              }));
            }),
            onPublish: (request) => {
              publishedMigrations = request.hostConfig.worker.migrations;
              publishedBindings = request.hostConfig.worker.durable_objects.bindings;
              workerSource = request.workerSource;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    expect(publishedMigrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
      { tag: "v2", new_sqlite_classes: ["EdenWorldDurableObject"] },
    ]);
    expect(publishedBindings).toEqual([
      { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
      { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
    ]);
    expect(workerSource).toContain("export { EdenWorldDurableObject }");
    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string; readonly message: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toEqual(
      expect.arrayContaining(["EVE_UPDATE_IN_FLIGHT", "EVE_UPDATE_WORLD_SWITCH"]),
    );
    expect(result.warnings.find((value) => value.id === "EVE_UPDATE_IN_FLIGHT")?.message)
      .toContain("can strand existing sessions");
  });

  test("keeps the World class binding and migration when the update switches away from the Durable Object World", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root, { worldCloudflare: true });
    const operations: string[] = [];
    const output: string[] = [];
    let publishedMigrations: unknown;
    let publishedBindings: unknown;
    let workerSource = "";

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            onPublish: (request) => {
              publishedMigrations = request.hostConfig.worker.migrations;
              publishedBindings = request.hostConfig.worker.durable_objects.bindings;
              workerSource = request.workerSource;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    // No new class: the v1 tag is carried verbatim and EdenWorldDurableObject
    // is never deleted — deleting the class would destroy its SQLite data.
    expect(publishedMigrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: [
          "EveHostDurableContainer",
          "EdenWorldDurableObject",
        ],
      },
    ]);
    expect(publishedBindings).toEqual([
      { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
      { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
    ]);
    expect(workerSource).toContain("export { EdenWorldDurableObject }");
    const result = JSON.parse(output[0] as string) as {
      readonly warnings: readonly { readonly id: string }[];
    };
    expect(result.warnings.map((value) => value.id)).toContain(
      "EVE_UPDATE_WORLD_SWITCH",
    );
  });

  test("prints 'updated' in the human summary for an in-place update", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations),
        },
      ),
    ).resolves.toBe(0);

    expect(output.join("\n")).toContain(`✓ updated ${updateName} (preview)`);
  });

  test("refuses to update when the live Worker's stamped identity is not Eden's", async () => {
    const root = await createRoot();
    await writeProject(root);
    // A stale local record still exists, but the remote Worker was recreated
    // by something else and does not stamp Eden's recorded identity.
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, operations),
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: {
                state: "unowned" as const,
                observed: { worker: true, container: true },
                providerEvidence: {
                  containerSchedulingPolicy: "durable_object",
                  containerNamespaceId: "namespace-do-test",
                  workerContainerNamespaceId: "namespace-do-test",
                  workerDeploymentId: "foreign-deploy-not-in-records",
                  settingsReadable: true,
                },
              },
            }),
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("refuses to update when the live Worker proves no Eden identity at all", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, operations),
            // A foreign Worker: no provider evidence matches the record.
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: {
                state: "unowned" as const,
                observed: { worker: true, container: true },
                providerEvidence: { settingsReadable: true },
              },
            }),
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("refuses to update when Worker settings are unreadable, even if the Container namespace matches", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    const output: string[] = [];
    const operations: string[] = [];

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: {
            ...updateControlPlane(root, operations),
            // Eden's Container survives, but a same-name Worker replaced
            // Eden's and its settings can't be read: the Container proves
            // nothing about who owns the Worker.
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: {
                state: "unowned" as const,
                observed: { worker: true, container: true },
                providerEvidence: {
                  containerSchedulingPolicy: "durable_object",
                  containerNamespaceId: "namespace-do-test",
                  workerContainerNamespaceId: "namespace-do-test",
                  settingsReadable: false,
                },
              },
            }),
          },
        },
      ),
    ).resolves.toBe(1);

    expect(operations).toEqual([]);
    const result = JSON.parse(output[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("proves a durable-object Container by namespace identity and fails closed when it is unreadable", async () => {
    const namespaceId = "namespace-do-123";
    const operations: string[] = [];
    const buildRead = (
      providerEvidence: Record<string, unknown>,
    ) => async () => ({
      accountAccess: "available" as const,
      containerAccess: "available" as const,
      accountId: "account-test",
      workersDevSubdomain: "account",
      target: {
        state: "unowned" as const,
        observed: { worker: true, container: true },
        providerEvidence: {
          workerDeploymentId: "eve-deploy-prior",
          settingsReadable: true,
          ...providerEvidence,
        },
      },
    });

    // Matching app/binding namespaces prove the durable-object Container
    // even though `containers list` reports no image.
    const matchedRoot = await createRoot();
    await writeProject(matchedRoot);
    await createOwnedTargetFixture(matchedRoot);
    const matchedOutput: string[] = [];
    await expect(
      runEdenCli(
        ["deploy", "--project", matchedRoot, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: matchedRoot,
          stdout: (line) => matchedOutput.push(line),
          eveControlPlane: {
            ...updateControlPlane(matchedRoot, operations),
            cloudflareRead: buildRead({
              containerSchedulingPolicy: "durable_object",
              containerNamespaceId: namespaceId,
              workerContainerNamespaceId: namespaceId,
            }),
          },
        },
      ),
    ).resolves.toBe(0);
    expect(operations).toContain("publish");

    // A missing or mismatched namespace id fails closed.
    const mismatchedRoot = await createRoot();
    await writeProject(mismatchedRoot);
    await createOwnedTargetFixture(mismatchedRoot);
    const mismatchedOutput: string[] = [];
    const mismatchedOperations: string[] = [];
    await expect(
      runEdenCli(
        ["deploy", "--project", mismatchedRoot, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: mismatchedRoot,
          stdout: (line) => mismatchedOutput.push(line),
          eveControlPlane: {
            ...updateControlPlane(mismatchedRoot, mismatchedOperations),
            cloudflareRead: buildRead({
              containerSchedulingPolicy: "durable_object",
              containerNamespaceId: namespaceId,
              workerContainerNamespaceId: "namespace-foreign",
            }),
          },
        },
      ),
    ).resolves.toBe(1);
    expect(mismatchedOperations).toEqual([]);
    const result = JSON.parse(mismatchedOutput[0] as string) as {
      readonly checks: readonly { readonly id: string; readonly status: string }[];
    };
    expect(
      result.checks.find((value) => value.id === "VAL-CLI-007-TARGET-CONFLICT")
        ?.status,
    ).toBe("failed");
  });

  test("updates only the Worker whose release ID this project recorded, not another project's Worker sharing its affinity ID", async () => {
    const run = async (workerReleaseId: string) => {
      const root = await createRoot();
      await writeProject(root);
      const { generationRoot } = await createOwnedTargetFixture(root);
      const recordPath = join(generationRoot, "deployment.json");
      const record = JSON.parse(await readFile(recordPath, "utf8")) as { identity: Record<string, unknown> };
      record.identity.deploymentId = "eden-affinity-shared";
      record.identity.releaseId = "eve-deploy-this-project";
      await writeFile(recordPath, JSON.stringify(record), "utf8");
      const operations: string[] = [];
      const code = await runEdenCli(
        ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: () => undefined,
          eveControlPlane: {
            ...updateControlPlane(root, operations),
            cloudflareRead: async () => ({
              accountAccess: "available" as const,
              containerAccess: "available" as const,
              accountId: "account-test",
              workersDevSubdomain: "account",
              target: {
                state: "unowned" as const,
                observed: { worker: true, container: true },
                providerEvidence: {
                  containerSchedulingPolicy: "durable_object",
                  containerNamespaceId: "namespace-do-test",
                  workerContainerNamespaceId: "namespace-do-test",
                  workerDeploymentId: "eden-affinity-shared",
                  workerReleaseId,
                  settingsReadable: true,
                },
              },
            }),
          },
        },
      );
      return { code, operations };
    };

    const foreign = await run("eve-deploy-other-project");
    expect(foreign.code).toBe(1);
    expect(foreign.operations).toEqual([]);

    const own = await run("eve-deploy-this-project");
    expect(own.code).toBe(0);
    expect(own.operations).toContain("publish");
  });

  test("an update names the live Worker's release as the one it replaces, not the one the local pointer names", async () => {
    const root = await createRoot();
    await writeProject(root);
    const { generationRoot } = await createOwnedTargetFixture(root);
    // Another deploy published "eve-deploy-live"; its record is here, but
    // CURRENT still points at the older one.
    const record = JSON.parse(await readFile(join(generationRoot, "deployment.json"), "utf8")) as { identity: Record<string, unknown> };
    record.identity.generationId = "gen-live";
    record.identity.releaseId = "eve-deploy-live";
    await mkdir(join(generationRoot, "..", "gen-live"), { recursive: true });
    await writeFile(join(generationRoot, "..", "gen-live", "deployment.json"), JSON.stringify(record), "utf8");
    const read = existingTargetRead();
    let publishedPreviousRelease: unknown;
    const code = await runEdenCli(
      ["deploy", "--project", root, "--env", "preview", "--name", updateName, "--json"],
      {
        cwd: root,
        stdout: () => undefined,
        eveControlPlane: {
          ...updateControlPlane(root, [], {
            onPublish: (request) => {
              publishedPreviousRelease = request.hostConfig.worker.vars.EDEN_EVE_PREVIOUS_RELEASE_ID;
            },
          }),
          cloudflareRead: async () => {
            const live = await read();
            return {
              ...live,
              target: { ...live.target, providerEvidence: { ...live.target.providerEvidence, workerReleaseId: "eve-deploy-live" } },
            };
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(publishedPreviousRelease).toBe("eve-deploy-live");
  });

  test("a retry after a health-failed update keeps the already-published migration tag", async () => {
    const root = await createRoot();
    await writeProject(root);
    await createOwnedTargetFixture(root);
    // Simulate an update that published v2 (World class) but failed health:
    // CURRENT still points at the v1 record while a newer failed record
    // carries v2. The next update must emit v2's history, not regress to v1.
    const failedRoot = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-failed-update",
    );
    await mkdir(failedRoot, { recursive: true });
    await writeFile(
      join(failedRoot, "deployment.json"),
      JSON.stringify({
        version: 1,
        status: "failed",
        identity: {
          projectId: updateName,
          sourceDigest: `sha256:${"c".repeat(64)}`,
          generationId: "gen-failed-update",
          deploymentId: "eve-deploy-failed",
          environment: "preview",
          name: updateName,
          accountId: "account-test",
          workersDevSubdomain: "account",
          stableWorkersDevOrigin:
            `https://${updateName}.account.workers.dev`,
          workerName: updateName,
          containerApplicationName: `${updateName}-container`,
          stableContainerInstanceName: `${updateName}-instance`,
          containerImage: priorImageReference,
          runtimeVariableNames: [],
        },
        worker: {
          name: updateName,
          compatibility_date: "2026-04-01",
          compatibility_flags: ["enable_ctx_exports"],
          vars: { EDEN_EVE_WORLD_CLOUDFLARE: true },
          containers: [
            {
              name: `${updateName}-container`,
              class_name: "EveHostDurableContainer",
              scheduling_policy: "durable_object",
              images: {
                eve: { image: priorImageReference },
              },
            },
          ],
          durable_objects: {
            bindings: [
              { name: "EVE_CONTAINER", class_name: "EveHostDurableContainer" },
              { name: "EDEN_WORLD", class_name: "EdenWorldDurableObject" },
            ],
          },
          migrations: [
            { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
            { tag: "v2", new_sqlite_classes: ["EdenWorldDurableObject"] },
          ],
        },
        container: {},
      }),
      "utf8",
    );
    // Deterministic ordering: the failed record must sort newer than the
    // CURRENT-pointed record without relying on wall-clock sleep.
    const failedRecordPath = join(failedRoot, "deployment.json");
    const priorRecordPath = join(
      root,
      ".eden",
      "eve-deploy",
      "generations",
      "gen-prior",
      "deployment.json",
    );
    const priorStats = await lstat(priorRecordPath);
    const later = new Date(priorStats.mtimeMs + 60_000);
    await utimes(failedRecordPath, later, later);
    const output: string[] = [];
    const operations: string[] = [];
    let publishedMigrations: unknown;

    await expect(
      runEdenCli(
        ["deploy", "--project", root, "--env", "preview",
        "--name", updateName, "--json"],
        {
          cwd: root,
          stdout: (line) => output.push(line),
          eveControlPlane: updateControlPlane(root, operations, {
            builder: fakeBuilder(async (request) => {
              await mkdir(
                join(request.snapshotRoot, ".output/.eve/compile"),
                { recursive: true },
              );
              await writeFile(
                join(
                  request.snapshotRoot,
                  ".output/.eve/compile/compiled-agent-manifest.json",
                ),
                JSON.stringify({
                  config: {
                    experimental: {
                      workflow: {
                        world: "@moinulmoin/eden-world-cloudflare",
                      },
                    },
                  },
                }),
                "utf8",
              );
              const worldRoot = join(request.snapshotRoot, "node_modules/@moinulmoin/eden-world-cloudflare");
              await mkdir(worldRoot, { recursive: true });
              await writeFile(join(worldRoot, "package.json"), JSON.stringify({
                version: "0.11.1",
                eden: { capabilities: { worldRpcAuth: true, atomicStartHook: true } },
              }));
            }),
            onPublish: (request) => {
              publishedMigrations = request.hostConfig.worker.migrations;
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    // v2 stays in the emitted history; the World class is never re-declared
    // under a replayed tag nor dropped from the list.
    expect(publishedMigrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["EveHostDurableContainer"] },
      { tag: "v2", new_sqlite_classes: ["EdenWorldDurableObject"] },
    ]);
  });
});


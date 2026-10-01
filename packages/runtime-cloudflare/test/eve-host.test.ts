import { describe, expect, test } from "vitest";

import {
  EVE_HOST_DEFAULTS,
  createEveHostConfig,
  createEveHostProxy,
  createEveReadinessGate,
  createTrustedEveRequest,
  eveScheduleCronFiresWithin,
  expandEveCronField,
  generateEveHostWorkerSource,
  parseEveScheduleCron,
  resolveStableWorkersDevOrigin,
  type EveContainerTransport,
} from "../src/eve-host.js";
import {
  createEveHostWorker,
  EveHostContainer,
  routeEveOutboundRequest,
} from "../src/eve-host-runtime.js";

const IDENTITY = {
  workerName: "eden-eve-preview",
  containerApplicationName: "eden-eve-preview-container",
  containerClassName: "EveHostContainer",
  containerBindingName: "EVE_CONTAINER",
  stableContainerInstanceName: "eden-eve-preview-instance",
  deploymentId: "dep-test",
  generationId: "gen-test",
};

describe("generic Eve Cloudflare host", () => {
  test("builds one private named Worker/Container graph with one stable identity", () => {
    const config = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin: "https://eden-eve-preview.account.workers.dev",
      containerImage: "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      containerImageBuildContext: "./container",
      runtimeVariableNames: ["EVE_AUTH_SECRET", "WORKFLOW_API_URL"],
      runtimeRevisionHandle: "revision-1",
    });

    expect(config.worker.name).toBe(IDENTITY.workerName);
    expect(config.worker.workers_dev).toBe(true);
    expect(config.worker.route).toBeUndefined();
    expect(config.worker.routes).toBeUndefined();
    expect(config.worker.containers).toEqual([
      {
        name: IDENTITY.containerApplicationName,
        class_name: IDENTITY.containerClassName,
        image: config.worker.containers?.[0]?.image,
        image_build_context: "./container",
        instance_type: "basic",
        max_instances: 1,
      },
    ]);
    expect(config.worker.durable_objects?.bindings).toEqual([
      {
        name: IDENTITY.containerBindingName,
        class_name: IDENTITY.containerClassName,
      },
    ]);
    expect(config.worker.migrations).toEqual([
      {
        tag: "v1",
        new_sqlite_classes: [IDENTITY.containerClassName],
      },
    ]);
    expect(config.container.instanceName).toBe(
      IDENTITY.stableContainerInstanceName,
    );
    expect(config.container.port).toBe(EVE_HOST_DEFAULTS.internalPort);
    expect(config.container.publicOrigin).toBe(
      "https://eden-eve-preview.account.workers.dev",
    );
    expect(config.worker.vars).toEqual({
      EVE_PUBLIC_ORIGIN: "https://eden-eve-preview.account.workers.dev",
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EVE_CONTAINER_BINDING_NAME: IDENTITY.containerBindingName,
      EDEN_EVE_DEPLOYMENT_ID: IDENTITY.deploymentId,
      EDEN_EVE_GENERATION_ID: IDENTITY.generationId,
      EVE_RUNTIME_VARIABLE_NAMES: ["EVE_AUTH_SECRET", "WORKFLOW_API_URL"],
      EDEN_EVE_RUNTIME_REVISION: "revision-1",
    });
    const source = generateEveHostWorkerSource({ config });
    expect(source).toContain("EveHostContainer");
    expect(source).toContain(IDENTITY.stableContainerInstanceName);
    expect(source).not.toMatch(/EdenSession|handleEdenRequest|\/eden\/v1/u);
    expect(source).not.toContain("secret-value");

    const customConfig = createEveHostConfig({
      ...IDENTITY,
      containerClassName: "CustomEveContainer",
      containerBindingName: "CUSTOM_CONTAINER",
      stableWorkersDevOrigin: "https://eden-eve-preview.account.workers.dev",
      containerImage:
        "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const customSource = generateEveHostWorkerSource({ config: customConfig });
    expect(customSource).toContain(
      "export { ContainerProxy, EveHostContainer as CustomEveContainer };",
    );
    expect(customSource).toContain('"containerBindingName":"CUSTOM_CONTAINER"');
    expect(source).toContain("export { ContainerProxy, EveHostContainer };");
    expect(source).toContain(
      'EveHostContainer.outboundByHost = { "eden-eve-preview.account.workers.dev": routeEveOutboundRequest };',
    );
    expect(source).not.toMatch(/@moinulmoin\/eden-runtime-cloudflare|node:/u);
  });

  test("resolves only an explicit workers.dev account subdomain", () => {
    expect(
      resolveStableWorkersDevOrigin({
        workerName: "eden-eve-preview",
        workersDevSubdomain: "account",
      }),
    ).toBe("https://eden-eve-preview.account.workers.dev");

    expect(() =>
      resolveStableWorkersDevOrigin({
        workerName: "eden-eve-preview",
        workersDevSubdomain: "account.workers.dev",
      }),
    ).toThrow(/workers\.dev/u);
    expect(() =>
      resolveStableWorkersDevOrigin({
        workerName: "other worker",
        workersDevSubdomain: "account",
      }),
    ).toThrow(/worker/u);
    expect(() =>
      createEveHostConfig({
        ...IDENTITY,
        stableWorkersDevOrigin:
          "https://eden-eve-preview.attacker.account.workers.dev",
        containerImage:
          "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow(/provider-assigned/u);
  });

  test("strips spoofed host metadata while preserving application headers and bytes", async () => {
    const forwarded: Request[] = [];
    const transport: EveContainerTransport = {
      containerFetch: async (request) => {
        forwarded.push(request);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              queueMicrotask(() => {
                controller.enqueue(new TextEncoder().encode("-last"));
                controller.close();
              });
            },
          }),
          {
            status: 207,
            headers: {
              "content-type": "application/octet-stream",
              "x-eve-response": "preserved",
            },
          },
        );
      },
      fetch: async () => new Response("websocket path"),
    };
    const requestBody = new Uint8Array([0, 255, 1, 2, 3]);
    const request = new Request(
      "https://client.invalid/eve/%2Fencoded?tag=one&tag=two",
      {
        method: "PATCH",
        body: requestBody,
        headers: {
          authorization: "Bearer app-token",
          cookie: "eve=session",
          "content-type": "application/octet-stream",
          forwarded: "for=attacker;host=evil.invalid;proto=http",
          "x-forwarded-for": "198.51.100.9",
          "x-forwarded-host": "evil.invalid",
          "x-forwarded-proto": "http",
          "x-real-ip": "198.51.100.9",
          "cf-container-target-port": "9999",
          "x-eden-eve-deployment-id": "attacker-deployment",
          "x-eden-eve-generation-id": "attacker-generation",
          "x-eden-eve-public-origin": "https://evil.invalid",
        },
      },
    );
    const proxy = createEveHostProxy({
      transport,
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      correlationId: "corr-test",
      ensureReady: async () => undefined,
    });

    const response = await proxy(request);
    expect(response.status).toBe(207);
    expect(response.headers.get("x-eve-response")).toBe("preserved");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([...new TextEncoder().encode("first-last")]),
    );
    expect(forwarded).toHaveLength(1);
    const upstream = forwarded[0] as Request;
    expect(upstream.method).toBe("PATCH");
    expect(new URL(upstream.url).origin).toBe(
      "https://eden-eve-preview.account.workers.dev",
    );
    expect(new URL(upstream.url).pathname).toBe("/eve/%2Fencoded");
    expect(new URL(upstream.url).search).toBe("?tag=one&tag=two");
    expect(new Uint8Array(await upstream.arrayBuffer())).toEqual(requestBody);
    expect(upstream.headers.get("authorization")).toBe("Bearer app-token");
    expect(upstream.headers.get("cookie")).toBe("eve=session");
    expect(upstream.headers.get("x-forwarded-host")).toBe(
      "eden-eve-preview.account.workers.dev",
    );
    expect(upstream.headers.get("x-forwarded-proto")).toBe("https");
    expect(upstream.headers.get("x-real-ip")).toBeNull();
    expect(upstream.headers.get("cf-container-target-port")).toBeNull();
    expect(upstream.headers.get("x-eden-eve-deployment-id")).toBe(
      IDENTITY.deploymentId,
    );
    expect(upstream.headers.get("x-eden-eve-generation-id")).toBe(
      IDENTITY.generationId,
    );
    expect(upstream.headers.get("x-eden-eve-public-origin")).toBe(
      "https://eden-eve-preview.account.workers.dev",
    );
    expect(upstream.headers.get("forwarded")).toBe(
      "proto=https;host=eden-eve-preview.account.workers.dev",
    );
  });

  test("uses one readiness gate and never replays an application request", async () => {
    let readinessCalls = 0;
    let forwardedCalls = 0;
    let releaseReadiness: (() => void) | undefined;
    const readiness = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const proxy = createEveHostProxy({
      transport: {
        containerFetch: async () => {
          forwardedCalls += 1;
          return new Response("application", { status: 201 });
        },
        fetch: async () => new Response("websocket"),
      },
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      correlationId: "corr-readiness",
      ensureReady: async () => {
        readinessCalls += 1;
        await readiness;
      },
    });

    const request = new Request("https://client.invalid/callback", {
      method: "POST",
      body: "one-request",
    });
    const pending = proxy(request);
    releaseReadiness?.();
    const response = await pending;

    expect(response.status).toBe(201);
    expect(readinessCalls).toBe(1);
    expect(forwardedCalls).toBe(1);
  });

  test("dispatches WebSocket upgrades through fetch without downgrading them", async () => {
    const calls: string[] = [];
    const proxy = createEveHostProxy({
      transport: {
        containerFetch: async () => {
          calls.push("containerFetch");
          return new Response("http");
        },
        fetch: async (request) => {
          calls.push("fetch");
          expect(request.headers.get("upgrade")).toBe("websocket");
          return new Response("upgrade");
        },
      },
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      correlationId: "corr-websocket",
      ensureReady: async () => undefined,
    });

    const response = await proxy(
      new Request("https://client.invalid/live", {
        headers: { upgrade: "websocket", connection: "Upgrade" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("upgrade");
    expect(calls).toEqual(["fetch"]);
  });

  test("does not consume an aborted request while waiting for readiness", async () => {
    const controller = new AbortController();
    let forwarded = false;
    const proxy = createEveHostProxy({
      transport: {
        containerFetch: async () => {
          forwarded = true;
          return new Response("unexpected");
        },
        fetch: async () => new Response("unexpected"),
      },
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      correlationId: "corr-abort",
      ensureReady: async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    const pending = proxy(
      new Request("https://client.invalid/abort", {
        method: "POST",
        body: "must-not-replay",
        signal: controller.signal,
      }),
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "HOST_REQUEST_ABORTED",
    });
    expect(forwarded).toBe(false);
  });

  test("constructs a forwarding request without reading the application body", async () => {
    const request = new Request("https://client.invalid/root", {
      method: "POST",
      body: "opaque-body",
    });
    expect(request.bodyUsed).toBe(false);
    const forwarded = createTrustedEveRequest(request, {
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      correlationId: "corr-request",
    });
    expect(request.bodyUsed).toBe(false);
    expect(await forwarded.text()).toBe("opaque-body");
  });

  test("coalesces cold-start readiness and accepts only the real Eve ready contract", async () => {
    let starts = 0;
    let healthCalls = 0;
    const gate = createEveReadinessGate({
      startAndWaitForPorts: async ({ ports, cancellationOptions }) => {
        starts += 1;
        expect(ports).toBe(8080);
        expect(cancellationOptions.abort).toBeInstanceOf(AbortSignal);
        expect(cancellationOptions.instanceGetTimeoutMS).toBe(120_000);
      },
      healthFetch: async (request) => {
        healthCalls += 1;
        expect(request.method).toBe("GET");
        expect(new URL(request.url).pathname).toBe("/eve/v1/health");
        return new Response(
          JSON.stringify(healthCalls === 1 ? { status: "ready" } : { status: "ready" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const first = gate(new AbortController().signal);
    const second = gate(new AbortController().signal);
    const [firstEvidence, secondEvidence] = await Promise.all([first, second]);

    expect(firstEvidence.healthVerified).toBe(true);
    expect(secondEvidence.healthStatus).toBe("ready");
    expect(starts).toBe(1);
    expect(healthCalls).toBe(1);

    await gate(new AbortController().signal);
    expect(starts).toBe(1);
    expect(healthCalls).toBe(1);
  });

  test("keeps a shared cold start alive when the first caller aborts", async () => {
    let releaseHealth: (() => void) | undefined;
    const healthReady = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const gate = createEveReadinessGate({
      startAndWaitForPorts: async () => undefined,
      healthFetch: async () => {
        await healthReady;
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const firstController = new AbortController();
    const first = gate(firstController.signal);
    const second = gate(new AbortController().signal);
    firstController.abort();
    releaseHealth?.();

    await expect(first).rejects.toMatchObject({
      code: "HOST_REQUEST_ABORTED",
    });
    await expect(second).resolves.toMatchObject({ healthStatus: "ready" });
  });

  test("resets cached readiness only when the Container generation stops", async () => {
    let starts = 0;
    let healthCalls = 0;
    const gate = createEveReadinessGate({
      startAndWaitForPorts: async () => {
        starts += 1;
      },
      healthFetch: async () => {
        healthCalls += 1;
        return new Response(JSON.stringify({ status: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await gate(new AbortController().signal);
    await gate(new AbortController().signal);
    expect(starts).toBe(1);
    expect(healthCalls).toBe(1);
    gate.reset();
    await gate(new AbortController().signal);
    expect(starts).toBe(2);
    expect(healthCalls).toBe(2);
  });

  test("does not treat a listening port or synthetic response as Eve readiness", async () => {
    const gate = createEveReadinessGate({
      startAndWaitForPorts: async () => undefined,
      healthFetch: async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(gate(new AbortController().signal)).rejects.toMatchObject({
      code: "HOST_READINESS_UNPROVEN",
    });
  });

  test("bounds a health probe separately from port readiness", async () => {
    const gate = createEveReadinessGate({
      startAndWaitForPorts: async () => undefined,
      healthTimeoutMs: 5,
      healthFetch: async () => new Promise<Response>(() => {}),
    });

    await expect(gate(new AbortController().signal)).rejects.toMatchObject({
      code: "HOST_READINESS_UNPROVEN",
    });
  });

  test("records outer lifecycle transitions without starting a second Eve supervisor", async () => {
    const lifecycle = (
      await import("../src/eve-host.js")
    ).createEveHostLifecycleObserver(() => 42);
    lifecycle.record("start_requested");
    lifecycle.record("started");
    lifecycle.record("health_ready", "ready");
    lifecycle.record("replaced");
    lifecycle.record("stopped", "runtime_signal:0");

    expect(lifecycle.events).toEqual([
      { type: "start_requested", at: 42 },
      { type: "started", at: 42 },
      { type: "health_ready", at: 42, safeStatus: "ready" },
      { type: "replaced", at: 42 },
      { type: "stopped", at: 42, safeStatus: "runtime_signal:0" },
    ]);
    expect(EveHostContainer.prototype.fetch).toBeDefined();
  });

  test("refuses the Workflow queue-delivery subtree on the public Worker path", async () => {
    const forwardedUrls: string[] = [];
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      containerBindingName: IDENTITY.containerBindingName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
    });
    const env = {
      EVE_CONTAINER: {
        getByName: () => ({
          fetch: async (request: Request) => {
            forwardedUrls.push(request.url);
            return new Response("forwarded");
          },
        }),
      },
    };

    for (const path of [
      "/.well-known/workflow/v1/flow",
      "/.well-known/workflow/v1/flow?__health",
      "/.well-known/workflow/v1/step",
      "/.well-known/%77orkflow/v1/flow",
      "/.well-known/workflow/v1/%66low",
      "/.well-known/workflow/v1/FLOW/",
      "/.well-known//workflow/v1/flow",
    ]) {
      const response = await worker.fetch(
        new Request(`https://eden-eve-preview.account.workers.dev${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vqs-queue-name": "__wkf_workflow_",
            "x-vqs-message-id": "msg_forge",
            "x-vqs-message-attempt": "1",
          },
          body: "{}",
        }),
        env,
      );
      expect(response.status).toBe(404);
    }
    expect(forwardedUrls).toEqual([]);

    const webhook = await worker.fetch(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/webhook/token-123",
        { method: "POST", body: "{}" },
      ),
      env,
    );
    expect(webhook.status).toBe(200);
    expect(forwardedUrls).toEqual([
      "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/webhook/token-123",
    ]);
    const manifest = await worker.fetch(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/manifest.json",
      ),
      env,
    );
    expect(await manifest.text()).toBe("forwarded");

    const api = await worker.fetch(
      new Request("https://eden-eve-preview.account.workers.dev/eve/v1/info"),
      env,
    );
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("forwarded");
  });

  test("routes container egress to the public origin back through the container", async () => {
    const loopback: string[] = [];
    const env = {
      EVE_PUBLIC_ORIGIN: "https://eden-eve-preview.account.workers.dev",
      EVE_CONTAINER_INSTANCE_NAME: IDENTITY.stableContainerInstanceName,
      EVE_CONTAINER_BINDING_NAME: IDENTITY.containerBindingName,
      EDEN_EVE_DEPLOYMENT_ID: IDENTITY.deploymentId,
      EDEN_EVE_GENERATION_ID: IDENTITY.generationId,
      EVE_CONTAINER: {
        getByName: (name: string) => ({
          containerFetch: async (request: Request, port?: number) => {
            loopback.push(`${name}:${port}:${request.url}`);
            return new Response("delivered inside");
          },
        }),
      },
    };
    const container = new EveHostContainer(
      {
        container: { running: false },
        storage: {
          sql: { exec: () => [] },
          kv: { get: () => undefined },
        },
        blockConcurrencyWhile: (callback: () => Promise<void>) => {
          void callback().catch(() => {});
        },
      } as never,
      env,
    );
    expect(container.envVars?.WORKFLOW_LOCAL_BASE_URL).toBe(
      "https://eden-eve-preview.account.workers.dev",
    );
    expect(container.envVars?.NODE_EXTRA_CA_CERTS).toBe(
      "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    );
    const response = await routeEveOutboundRequest(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/flow",
        { method: "POST", body: "{}" },
      ),
      env as never,
    );
    expect(await response.text()).toBe("delivered inside");
    expect(loopback).toEqual([
      `${IDENTITY.stableContainerInstanceName}:8080:https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/flow`,
    ]);
  });
});

describe("Eve schedule wake triggers", () => {
  const SCHEDULED_ENV = {
    EVE_CONTAINER: {
      getByName: () => ({
        fetch: async (request: Request) =>
          new Response(`wake:${request.url}`),
      }),
    },
  };

  test("emits one every-minute cron trigger only when schedules exist", () => {
    const withSchedules = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin:
        "https://eden-eve-preview.account.workers.dev",
      containerImage:
        "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schedules: [
        { name: "digest", cron: "0 9 * * 1-5" },
        { name: "sweep", cron: "*/15 * * * *" },
      ],
    });
    expect(withSchedules.worker.triggers).toEqual({
      crons: ["* * * * *"],
    });
    expect(withSchedules.container.schedules).toHaveLength(2);
    const source = generateEveHostWorkerSource({ config: withSchedules });
    expect(source).toContain('"schedules"');
    expect(source).toContain('"0 9 * * 1-5"');

    const without = createEveHostConfig({
      ...IDENTITY,
      stableWorkersDevOrigin:
        "https://eden-eve-preview.account.workers.dev",
      containerImage:
        "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(without.worker.triggers).toBeUndefined();
    expect(without.container.schedules).toEqual([]);
    expect(generateEveHostWorkerSource({ config: without })).not.toContain(
      '"schedules"',
    );
  });

  test("rejects schedule crons the wake trigger cannot evaluate", () => {
    for (const cron of ["@daily", "*/30 * * * * *", "0 0 L * *"]) {
      expect(() =>
        createEveHostConfig({
          ...IDENTITY,
          stableWorkersDevOrigin:
            "https://eden-eve-preview.account.workers.dev",
          containerImage:
            "registry.example/eve@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          schedules: [{ name: "bad", cron }],
        }),
      ).toThrow(/cron expression/u);
      expect(parseEveScheduleCron(cron)).toBeUndefined();
    }
  });

  test("parses the standard 5-field subset with Vixie dom/dow semantics", () => {
    expect(expandEveCronField("*/15", 0)?.has(45)).toBe(true);
    expect(expandEveCronField("9-17", 1)?.has(12)).toBe(true);
    expect(expandEveCronField("mon-fri", 4)?.has(3)).toBe(true);
    expect(expandEveCronField("jan,jun", 3)?.has(6)).toBe(true);
    expect(expandEveCronField("7", 4)?.has(0)).toBe(true);
    expect(parseEveScheduleCron("0 9 * * 1-5")).not.toBeUndefined();

    const friday9 = Date.parse("2026-10-02T09:00:00Z");
    expect(eveScheduleCronFiresWithin("0 9 * * 1-5", friday9)).toBe(true);
    expect(
      eveScheduleCronFiresWithin(
        "0 9 * * 1-5",
        friday9 - 4 * 60_000,
      ),
    ).toBe(true);
    expect(
      eveScheduleCronFiresWithin(
        "0 9 * * 1-5",
        friday9 - 5 * 60_000,
      ),
    ).toBe(false);
    expect(
      eveScheduleCronFiresWithin("0 9 * * 1-5", friday9 + 120_000),
    ).toBe(false);
    expect(eveScheduleCronFiresWithin("*/5 * * * *", friday9)).toBe(true);
  });

  test("the scheduled handler wakes the container only inside the lead window", async () => {
    const wakeUrls: string[] = [];
    const env = {
      EVE_CONTAINER: {
        getByName: () => ({
          fetch: async (request: Request) => {
            wakeUrls.push(request.url);
            return new Response("ok");
          },
        }),
      },
    };
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      containerBindingName: IDENTITY.containerBindingName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      schedules: [{ name: "digest", cron: "0 9 * * 1-5" }],
    });
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (task: Promise<unknown>) => {
        waited.push(task);
      },
    };

    const farTick = Date.parse("2026-10-02T10:00:00Z");
    worker.scheduled?.(
      { cron: "* * * * *", scheduledTime: farTick },
      env,
      ctx,
    );
    expect(waited).toEqual([]);

    const nearTick = Date.parse("2026-10-02T08:57:00Z");
    worker.scheduled?.(
      { cron: "* * * * *", scheduledTime: nearTick },
      env,
      ctx,
    );
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(wakeUrls).toEqual([
      "https://eden-eve-preview.account.workers.dev/eve/v1/health",
    ]);
  });

  test("omits the scheduled handler when no schedules exist", () => {
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      containerBindingName: IDENTITY.containerBindingName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
    });
    expect(worker.scheduled).toBeUndefined();
    expect(SCHEDULED_ENV.EVE_CONTAINER.getByName).toBeTypeOf("function");
  });

  test("schedules do not loosen the internal-route refusal", async () => {
    const worker = createEveHostWorker({
      publicOrigin: "https://eden-eve-preview.account.workers.dev",
      workerName: IDENTITY.workerName,
      containerBindingName: IDENTITY.containerBindingName,
      stableContainerInstanceName: IDENTITY.stableContainerInstanceName,
      deploymentId: IDENTITY.deploymentId,
      generationId: IDENTITY.generationId,
      schedules: [{ name: "digest", cron: "*/5 * * * *" }],
    });
    const response = await worker.fetch(
      new Request(
        "https://eden-eve-preview.account.workers.dev/.well-known/workflow/v1/flow",
        { method: "POST", body: "{}" },
      ),
      {
        EVE_CONTAINER: {
          getByName: () => ({
            fetch: async () => new Response("forwarded"),
          }),
        },
      },
    );
    expect(response.status).toBe(404);
  });
});

import { describe, expect, test } from "vitest";

import {
  EVE_HOST_DEFAULTS,
  createEveHostConfig,
  createEveHostProxy,
  createEveReadinessGate,
  createTrustedEveRequest,
  generateEveHostWorkerSource,
  resolveStableWorkersDevOrigin,
  type EveContainerTransport,
} from "../src/eve-host.js";
import { EveHostContainer } from "../src/eve-host-runtime.js";

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
      "export { EveHostContainer as CustomEveContainer };",
    );
    expect(customSource).toContain('"containerBindingName":"CUSTOM_CONTAINER"');
    expect(source).toContain(
      'import { EveHostContainer, createEveHostWorker } from "./eden-eve-host-worker.mjs";',
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
});

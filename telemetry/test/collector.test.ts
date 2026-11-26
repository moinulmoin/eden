import { expect, test } from "vitest";

import worker, { MAX_BODY_BYTES } from "../src/index.js";

const event = {
  schema: 1,
  installId: "3f2b8c1e-6a4d-4f1b-9c2e-7d8a9b0c1d2e",
  command: "deploy",
  edenVersion: "0.16.0",
  exitCode: 1,
  failureCode: "EVE_DEPLOY_CHECKS_FAILED",
  duration: "1m-5m",
  os: "darwin",
  arch: "arm64",
  nodeMajor: 24,
  eveVersion: "1.3.0",
  world: "cloudflare",
  ci: false,
};

function collector() {
  const points: unknown[] = [];
  const env = { EVENTS: { writeDataPoint: (point: unknown) => { points.push(point); } } };
  const send = (body: string, init: { method?: string; path?: string; headers?: Record<string, string> } = {}) =>
    worker.fetch(new Request("https://telemetry.eden.ideaplexa.com" + (init.path ?? "/v1/events"), {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "user-agent": "planted-agent",
        "cf-connecting-ip": "203.0.113.7",
        ...init.headers,
      },
      ...(init.method === "GET" ? {} : { body }),
    }), env);
  return { points, send };
}

test("an event of the documented shape is accepted and written without the IP, headers, or user agent", async () => {
  const { points, send } = collector();
  const response = await send(JSON.stringify(event));
  expect(response.status).toBe(204);
  expect(points).toEqual([{
    indexes: [event.installId],
    blobs: [event.installId, "deploy", "0.16.0", "EVE_DEPLOY_CHECKS_FAILED", "1m-5m", "darwin", "arm64", "1.3.0", "cloudflare", "false"],
    doubles: [1, 24, 1],
  }]);
  expect(JSON.stringify(points)).not.toMatch(/203\.0\.113\.7|planted-agent/u);
});

test.each([
  ["an extra field", { ...event, project: "acme" }],
  ["a missing field", Object.fromEntries(Object.entries(event).filter(([key]) => key !== "world"))],
  ["a path in a version", { ...event, eveVersion: "file:/Users/someone/eve" }],
  ["an unknown command", { ...event, command: "login" }],
  ["a failure code with success", { ...event, exitCode: 0 }],
  ["a free-form failure code", { ...event, failureCode: "could not reach acme.example.com" }],
  ["an exact duration", { ...event, duration: 61_234 }],
  ["an install ID that is not a random UUID", { ...event, installId: "moinul" }],
])("an event with %s gets 400 and is not written", async (_case, body) => {
  const { points, send } = collector();
  expect((await send(JSON.stringify(body))).status).toBe(400);
  expect(points).toEqual([]);
});

test("anything but a small JSON POST to /v1/events is refused and not written", async () => {
  const { points, send } = collector();
  expect((await send("not json")).status).toBe(400);
  expect((await send(JSON.stringify(event), { path: "/" })).status).toBe(404);
  expect((await send("", { method: "GET" })).status).toBe(405);
  expect((await send(JSON.stringify(event), { headers: { "content-type": "text/plain" } })).status).toBe(415);
  const large = JSON.stringify({ ...event, padding: "x".repeat(MAX_BODY_BYTES) });
  expect((await send(large)).status).toBe(413);
  expect(points).toEqual([]);
});

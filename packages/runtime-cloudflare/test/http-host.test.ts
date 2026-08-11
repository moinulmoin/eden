import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { EDEN_VERSIONS } from "@eden/definitions";
import {
  createOpaqueSessionId,
  createSessionObjectName,
} from "../src/session-identity.js";
import { SESSION_SCHEMA_VERSION } from "../src/session-schema.js";

const BEARER = "eden-unit-auth";
const SENTINEL = "prompt-secret-sentinel";

function authenticated(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${BEARER}`,
    },
  };
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("Eden authenticated HTTP host", () => {
  test("serves safe authenticated health and version metadata", async () => {
    const health = await SELF.fetch(
      new Request("https://eden/eden/v1/health", authenticated()),
    );
    expect(health.status).toBe(200);
    expect(await jsonBody(health)).toEqual({ status: "ok" });

    const info = await SELF.fetch(
      new Request("https://eden/eden/v1/info", authenticated()),
    );
    expect(info.status).toBe(200);
    const body = await jsonBody(info);
    expect(body).toMatchObject({
      service: "eden",
      protocol: expect.any(String),
      versions: {
        runtime: expect.any(String),
        agentBundle: expect.any(String),
        manifest: expect.any(String),
        protocol: expect.any(String),
        schema: expect.any(Number),
      },
      sqliteSchemaVersion: SESSION_SCHEMA_VERSION,
    });
    expect(JSON.stringify(body)).not.toContain("EDEN_BEARER_SECRET");
    expect(JSON.stringify(body)).not.toContain("eden-session:");
  });

  test("fails closed before interpreting every implemented route", async () => {
    const requests = [
      new Request("https://eden/eden/v1/health"),
      new Request("https://eden/eden/v1/info"),
      new Request("https://eden/eden/v1/session", {
        method: "POST",
        body: `{ "principal": "${SENTINEL}" `,
      }),
      new Request(
        "https://eden/eden/v1/session/sess_00000000000000000000000000000000",
        {
          method: "POST",
          body: JSON.stringify({ message: SENTINEL }),
        },
      ),
      new Request(
        "https://eden/eden/v1/session/sess_00000000000000000000000000000000/stream?startIndex=not-a-number",
      ),
    ];

    for (const request of requests) {
      const response = await SELF.fetch(request);
      expect(response.status).toBe(401);
      const body = await jsonBody(response);
      expect(body).toMatchObject({
        code: "unauthorized",
        message: expect.any(String),
      });
      expect(JSON.stringify(body)).not.toContain(SENTINEL);
    }
  });

  test("creates and accepts an owned session with opaque public identifiers", async () => {
    const create = await SELF.fetch(
      new Request("https://eden/eden/v1/session", authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })),
    );
    expect(create.status).toBe(201);
    const created = await jsonBody(create);
    expect(created).toMatchObject({
      sessionId: expect.stringMatching(/^sess_[a-f0-9]{32}$/u),
      status: "new",
      versions: {
        runtime: expect.any(String),
        agentBundle: expect.any(String),
        manifest: expect.any(String),
        protocol: expect.any(String),
        schema: expect.any(Number),
      },
      sqliteSchemaVersion: SESSION_SCHEMA_VERSION,
    });
    expect(JSON.stringify(created)).not.toContain("eden-session:");

    const sessionId = created.sessionId as string;
    const rejected = await SELF.fetch(
      new Request(`https://eden/eden/v1/session/${sessionId}`, authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: SENTINEL,
          principal: "forged-principal",
        }),
      })),
    );
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await jsonBody(rejected))).not.toContain(SENTINEL);

    const command = await SELF.fetch(
      new Request(`https://eden/eden/v1/session/${sessionId}`, authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: SENTINEL }),
      })),
    );
    expect(command.status).toBe(202);
    const accepted = await jsonBody(command);
    expect(accepted).toMatchObject({
      sessionId,
      turnId: expect.stringMatching(/^turn_[a-f0-9]{32}$/u),
      status: "accepted",
    });
    expect(Object.keys(accepted).sort()).toEqual([
      "sessionId",
      "status",
      "turnId",
    ]);
    expect(JSON.stringify(accepted)).not.toContain(SENTINEL);

    const stream = await SELF.fetch(
      new Request(
        `https://eden/eden/v1/session/${sessionId}/stream?startIndex=0&follow=false`,
        authenticated(),
      ),
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const lines = (await stream.text()).trim().split("\n").filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
    ]);
    expect(events.map((event) => event.streamIndex)).toEqual([1, 2, 3]);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  });

  test("rejects unsupported query fields and unknown sessions without disclosure", async () => {
    const invalidQuery = await SELF.fetch(
      new Request(
        "https://eden/eden/v1/session/sess_00000000000000000000000000000000/stream?owner=forged",
        authenticated(),
      ),
    );
    expect(invalidQuery.status).toBe(400);
    expect(await jsonBody(invalidQuery)).toMatchObject({
      code: "invalid_request",
      message: expect.any(String),
    });

    const unknown = await SELF.fetch(
      new Request(
        "https://eden/eden/v1/session/sess_00000000000000000000000000000000",
        authenticated({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "hello" }),
        }),
      ),
    );
    expect(unknown.status).toBe(404);
    const body = await jsonBody(unknown);
    expect(body).toMatchObject({
      code: "not_found",
      message: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("eden-session:");
  });

  test("checks the durable owner before exposing an existing session", async () => {
    const sessionId = createOpaqueSessionId();
    const stub = env.EDEN_SESSIONS.getByName(createSessionObjectName(sessionId));
    const initialized = await stub.fetch("https://eden/_eden/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        ownerPrincipal: "principal:other",
        versions: EDEN_VERSIONS,
      }),
    });
    expect(initialized.status).toBe(201);
    await initialized.arrayBuffer();

    const command = await SELF.fetch(
      new Request(`https://eden/eden/v1/session/${sessionId}`, authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      })),
    );
    expect(command.status).toBe(404);
    expect(JSON.stringify(await jsonBody(command))).not.toContain(
      "principal:other",
    );

    const stream = await SELF.fetch(
      new Request(
        `https://eden/eden/v1/session/${sessionId}/stream?follow=false`,
        authenticated(),
      ),
    );
    expect(stream.status).toBe(404);
    expect(JSON.stringify(await jsonBody(stream))).not.toContain(
      "principal:other",
    );
  });
});

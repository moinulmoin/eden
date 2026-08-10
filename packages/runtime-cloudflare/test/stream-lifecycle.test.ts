import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { createSessionObjectName } from "../src/session-identity.js";

const BEARER = "eden-unit-auth";

function authenticated(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${BEARER}`,
    },
  };
}

async function readNdjson(response: Response): Promise<readonly Record<string, unknown>[]> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function createSession(): Promise<string> {
  const response = await SELF.fetch(
    new Request(
      "https://eden/eden/v1/session",
      authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { readonly sessionId: string };
  return body.sessionId;
}

async function acceptTurn(sessionId: string): Promise<void> {
  const response = await SELF.fetch(
    new Request(
      `https://eden/eden/v1/session/${sessionId}`,
      authenticated({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Find the durable answer." }),
      }),
    ),
  );
  expect(response.status).toBe(202);
  await response.arrayBuffer();
}

function streamRequest(
  sessionId: string,
  query: string,
): Request {
  return new Request(
    `https://eden/eden/v1/session/${sessionId}/stream?${query}`,
    authenticated(),
  );
}

describe("Eden durable NDJSON lifecycle stream", () => {
  test("follows the committed happy-path lifecycle in causal cursor order", async () => {
    const sessionId = await createSession();
    await acceptTurn(sessionId);

    const response = await SELF.fetch(
      streamRequest(sessionId, "startIndex=0&follow=true"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );

    const events = await readNdjson(response);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "actions.requested",
      "action.result",
      "step.completed",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(events.map((event) => event.streamIndex)).toEqual(
      Array.from({ length: 12 }, (_value, index) => index + 1),
    );
    expect(events.every((event) => /^evt_[a-f0-9]{32}$/u.test(String(event.eventId)))).toBe(
      true,
    );
    expect(
      (events.find((event) => event.type === "message.completed")?.data as {
        readonly content?: string;
      })?.content,
    ).toContain("✓");
  }, 15_000);

  test("captures a bounded high-water range and resumes strictly after a cursor", async () => {
    const sessionId = await createSession();
    await acceptTurn(sessionId);

    const initial = await SELF.fetch(
      streamRequest(sessionId, "startIndex=0&follow=false"),
    );
    const initialEvents = await readNdjson(initial);
    expect(initialEvents.map((event) => event.streamIndex)).toEqual([1, 2, 3]);

    const completed = await SELF.fetch(
      streamRequest(sessionId, "startIndex=0&follow=true"),
    );
    const completedEvents = await readNdjson(completed);
    expect(completedEvents.map((event) => event.streamIndex)).toEqual(
      Array.from({ length: 12 }, (_value, index) => index + 1),
    );

    const resumed = await SELF.fetch(
      streamRequest(sessionId, "startIndex=3&follow=false"),
    );
    const resumedEvents = await readNdjson(resumed);
    expect(resumedEvents.map((event) => event.streamIndex)).toEqual(
      Array.from({ length: 9 }, (_value, index) => index + 4),
    );
  }, 15_000);

  test("stops delivery on transport cancellation while accepted execution remains reconnectable", async () => {
    const sessionId = await createSession();
    await acceptTurn(sessionId);

    const response = await SELF.fetch(
      streamRequest(sessionId, "startIndex=0&follow=true"),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    const first = await reader.read();
    expect(first.done).toBe(false);
    const firstText = new TextDecoder("utf-8", { fatal: true }).decode(
      first.value,
    );
    const delivered = firstText
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { readonly streamIndex: number });
    const savedCursor = delivered.at(-1)?.streamIndex ?? 0;
    expect(savedCursor).toBeGreaterThan(0);
    await reader.cancel();

    await new Promise((resolve) => setTimeout(resolve, 250));

    const resumed = await SELF.fetch(
      streamRequest(sessionId, `startIndex=${savedCursor}&follow=false`),
    );
    const remaining = await readNdjson(resumed);
    expect(remaining.some((event) => event.type === "session.waiting")).toBe(true);
    expect(remaining.every((event) => Number(event.streamIndex) > savedCursor)).toBe(
      true,
    );
  }, 15_000);

  test("replays the same committed NDJSON journal after Durable Object eviction", async () => {
    const sessionId = await createSession();
    await acceptTurn(sessionId);

    const beforeResponse = await SELF.fetch(
      streamRequest(sessionId, "startIndex=0&follow=true"),
    );
    const before = await readNdjson(beforeResponse);

    const stub = env.EDEN_SESSIONS.getByName(createSessionObjectName(sessionId));
    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(stub);

    const afterResponse = await SELF.fetch(
      streamRequest(sessionId, "startIndex=0&follow=false"),
    );
    const after = await readNdjson(afterResponse);

    expect(after.map((event) => event.streamIndex)).toEqual(
      before.map((event) => event.streamIndex),
    );
    expect(after.map((event) => event.eventId)).toEqual(
      before.map((event) => event.eventId),
    );
    expect(after.map((event) => event.type)).toEqual(
      before.map((event) => event.type),
    );
  }, 15_000);
});

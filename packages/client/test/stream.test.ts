import { describe, expect, test } from "vitest";

import {
  EdenMemoryEventStore,
  EdenProtocolError,
  createEdenClient,
} from "../src/index.js";

const VERSIONS = {
  runtime: "eden-runtime-1",
  agentBundle: "eden-agent-bundle-1",
  manifest: "eden-manifest-1",
  protocol: "eden-protocol-1",
  schema: 1,
} as const;

function event(
  streamIndex: number,
  eventId: string,
  type: "session.started" | "session.waiting",
): Record<string, unknown> {
  return {
    streamIndex,
    eventId,
    type,
    data:
      type === "session.started"
        ? {
            sessionId: "sess_123",
            status: "new",
            versions: VERSIONS,
          }
        : { status: "waiting" },
    committedAt: "2026-08-10T00:00:00.000Z",
  };
}

function ndjson(
  ...records: readonly Record<string, unknown>[]
): Response {
  return new Response(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    },
  );
}

function snapshotResponse(): Response {
  return new Response(
    JSON.stringify({
      sessionId: "sess_123",
      status: "new",
      versions: VERSIONS,
    }),
    {
      status: 201,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

function acceptanceResponse(): Response {
  return new Response(
    JSON.stringify({
      sessionId: "sess_123",
      turnId: "turn_123",
      status: "accepted",
    }),
    {
      status: 202,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

describe("Eden typed client stream protocol", () => {
  test("creates and attaches sessions while persisting only the opaque cursor state", async () => {
    const requests: Request[] = [];
    const responses = [
      snapshotResponse(),
      acceptanceResponse(),
      ndjson(event(1, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session.started")),
      ndjson(event(2, "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "session.waiting")),
    ];
    const client = createEdenClient({
      baseUrl: "https://eden.example/",
      bearerToken: "do-not-persist-this",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return responses.shift() ?? new Response("unexpected", { status: 500 });
      },
    });
    const store = new EdenMemoryEventStore();

    const created = await client.createSession();
    const session = client.attach(created.sessionId, store);
    await expect(session.sendMessage({ message: "hello" })).resolves.toEqual({
      sessionId: "sess_123",
      turnId: "turn_123",
      status: "accepted",
    });
    const received = [];
    for await (const receivedEvent of session.events({ follow: false })) {
      received.push(receivedEvent);
    }
    for await (const receivedEvent of session.events({ follow: false })) {
      received.push(receivedEvent);
    }

    expect(received.map((receivedEvent) => receivedEvent.streamIndex)).toEqual([
      1,
      2,
    ]);
    expect(store.snapshot()).toEqual({
      sessionId: "sess_123",
      streamIndex: 2,
    });
    expect(Object.keys(store.snapshot() ?? {}).sort()).toEqual([
      "sessionId",
      "streamIndex",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer do-not-persist-this",
    );
    expect(requests[1]?.url).toBe(
      "https://eden.example/eden/v1/session/sess_123",
    );
    expect(requests[1]?.headers.get("authorization")).toBe(
      "Bearer do-not-persist-this",
    );
    expect(requests[1]?.headers.get("content-type")).toBe("application/json");
    expect(await requests[1]?.text()).toBe(JSON.stringify({ message: "hello" }));
    expect(requests[2]?.url).toBe(
      "https://eden.example/eden/v1/session/sess_123/stream?startIndex=0&follow=false",
    );
    expect(requests[3]?.url).toBe(
      "https://eden.example/eden/v1/session/sess_123/stream?startIndex=1&follow=false",
    );
  });

  test("deduplicates consistent overlap and rejects conflicting event IDs", async () => {
    const first = event(
      1,
      "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "session.started",
    );
    const second = event(
      2,
      "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "session.waiting",
    );
    const conflicting = {
      ...second,
      data: { status: "waiting", extra: true },
    };
    const responses = [
      ndjson(first, second, second),
      ndjson(conflicting),
    ];
    const client = createEdenClient({
      baseUrl: "https://eden.example",
      bearerToken: "secret",
      fetch: async () =>
        responses.shift() ?? new Response("unexpected", { status: 500 }),
    });
    const store = new EdenMemoryEventStore();
    const session = client.attach("sess_123", store);

    const received = [];
    for await (const receivedEvent of session.events({ follow: false })) {
      received.push(receivedEvent);
    }
    expect(received.map((receivedEvent) => receivedEvent.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);

    await expect(async () => {
      for await (const _receivedEvent of session.events({
        startIndex: 0,
        follow: false,
      })) {
        // Consume until the conflicting replay is observed.
        void _receivedEvent;
      }
    }).rejects.toBeInstanceOf(EdenProtocolError);
  });

  test("rejects malformed records and cursor inconsistencies as typed failures", async () => {
    const responses = [
      new Response("{not-json}\n", {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
      ndjson(event(2, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session.started")),
      ndjson(
        event(1, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session.started"),
        {
          ...event(1, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session.started"),
          data: {
            sessionId: "sess_other",
            status: "new",
            versions: VERSIONS,
          },
        },
      ),
    ];
    const client = createEdenClient({
      baseUrl: "https://eden.example",
      bearerToken: "secret",
      fetch: async () =>
        responses.shift() ?? new Response("unexpected", { status: 500 }),
    });
    const session = client.attach(
      "sess_123",
      new EdenMemoryEventStore(),
    );

    await expect(async () => {
      for await (const _receivedEvent of session.events({ startIndex: 0, follow: false })) {
        // A new event with a previously accepted cursor must fail.
        void _receivedEvent;
      }
    }).rejects.toBeInstanceOf(EdenProtocolError);

    await expect(async () => {
      for await (const _receivedEvent of session.events({ follow: false })) {
        // A fresh stream cannot skip the first absolute cursor.
        void _receivedEvent;
      }
    }).rejects.toBeInstanceOf(EdenProtocolError);

    await expect(async () => {
      for await (const _receivedEvent of session.events({ startIndex: 0, follow: false })) {
        // The first stream established a cursor, so this overlap is checked.
        void _receivedEvent;
      }
    }).rejects.toBeInstanceOf(EdenProtocolError);
  });

  test("local abort stops iteration without issuing a cancellation request", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    const client = createEdenClient({
      baseUrl: "https://eden.example",
      bearerToken: "secret",
      fetch: async () => {
        requestCount += 1;
        return ndjson(
          event(1, "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session.started"),
          event(2, "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "session.waiting"),
        );
      },
    });
    const session = client.attach("sess_123", new EdenMemoryEventStore());
    const iterator = session.events({
      follow: true,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.streamIndex).toBe(1);
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(requestCount).toBe(1);
  });
});

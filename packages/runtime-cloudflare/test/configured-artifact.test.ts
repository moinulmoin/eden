import { env, runInDurableObject, SELF } from "cloudflare:test";
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

describe("configured generated artifact execution", () => {
  test("runs the explicitly configured test-worker artifact through the public session", async () => {
    const create = await SELF.fetch(
      new Request(
        "https://eden/eden/v1/session",
        authenticated({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { readonly sessionId: string };

    const command = await SELF.fetch(
      new Request(
        `https://eden/eden/v1/session/${created.sessionId}`,
        authenticated({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Use the configured artifact." }),
        }),
      ),
    );
    expect(command.status).toBe(202);
    await command.arrayBuffer();

    const stream = await SELF.fetch(
      new Request(
        `https://eden/eden/v1/session/${created.sessionId}/stream?startIndex=0&follow=true`,
        authenticated(),
      ),
    );
    const events = await readNdjson(stream);
    const action = events.find((event) => event.type === "actions.requested");
    const actionResult = events.find((event) => event.type === "action.result");
    const finalMessage = events.find((event) => event.type === "message.completed");

    expect((action?.data as { readonly actions?: readonly Record<string, unknown>[] })
      ?.actions?.[0]).toMatchObject({
      toolName: "configured_lookup",
      input: { query: " eden " },
    });
    expect(actionResult?.data).toMatchObject({
      toolName: "configured_lookup",
      output: {
        source: "test-worker-configured-artifact",
        query: "eden",
      },
    });
    expect(finalMessage?.data).toMatchObject({
      content: "configured-artifact-final-response: ✓",
    });
    expect(events.some((event) => JSON.stringify(event).includes("lookup:"))).toBe(
      false,
    );

    const stub = env.EDEN_SESSIONS.getByName(
      createSessionObjectName(created.sessionId),
    );
    const effect = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<{ readonly idempotency_key: string }>(
          "SELECT idempotency_key FROM effects WHERE session_id = ?",
          created.sessionId,
        )
        .toArray()[0],
    );
    expect(effect?.idempotency_key).toContain("configured-test-generation");
  }, 15_000);
});

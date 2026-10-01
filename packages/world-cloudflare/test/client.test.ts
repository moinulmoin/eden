import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "vitest";
import { decode, encode } from "cbor-x";
import { createWorld } from "../src/index.js";

let server: Server | undefined;
let nextPoll = Promise.withResolvers<undefined>();
let cancelled = false;
const pollLog: string[] = [];

afterEach(async () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  nextPoll = promise;
  cancelled = false;
  pollLog.length = 0;
  if (server) server.close(resolve);
  server = undefined;
  await promise;
});

function startRpcStub(): Promise<string> {
  server = createServer((req, res) => {
    const { resolve } = Promise.withResolvers<void>();
    void (async () => {
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(c);
      const { op } = decode(Buffer.concat(parts));
      if (cancelled) pollLog.push(op);
      nextPoll.resolve(undefined);
      nextPoll = Promise.withResolvers<undefined>();
      res.end(encode({ ok: true, result: { chunks: [], done: false, nextIndex: 0, tailIndex: 0 } }));
      resolve();
    })();
  });
  const { promise, resolve } = Promise.withResolvers<string>();
  server.listen(0, "127.0.0.1", () => {
    const addr = server!.address();
    resolve(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
  });
  return promise;
}

test("streams.get stops polling after cancel", async () => {
  const url = await startRpcStub();
  const world = createWorld({ url, pollIntervalMs: 10 });
  const stream = await world.streams.get("run", "s", 0);
  const reader = stream.getReader();
  // Wait until at least one readChunks RPC has been issued, then cancel.
  await Promise.race([reader.read(), nextPoll.promise]);
  cancelled = true;
  await reader.cancel();
  // Real-time window is intentional: cancellation is time-based and a fake
  // timer cannot prove no further poll fires during the interval.
  const postCancel = Promise.withResolvers<"none" | "polled">();
  const timer = setTimeout(() => postCancel.resolve("none"), 150);
  void nextPoll.promise.then(() => {
    clearTimeout(timer);
    postCancel.resolve("polled");
  });
  assert.equal(await postCancel.promise, "none", `post-cancel polls: ${pollLog}`);
});

import * as errors from "@workflow/errors";
import { SPEC_VERSION_CURRENT, type MessageId, type World } from "@workflow/world";
import { createWorld as createLocalWorld } from "@workflow/world-local";
import { decode, encode } from "cbor-x";

export interface CloudflareWorldOptions {
  url?: string;
  pollIntervalMs?: number;
}

type RpcResult = { ok: true; result: unknown } | {
  ok: false;
  error: { name: string; message: string; [key: string]: unknown };
};

/** A Node-side World whose durable state lives in Eden's SQLite Durable Object. */
export function createWorld(options: CloudflareWorldOptions = {}): World {
  const url = options.url ?? process.env.EDEN_WORLD_URL;
  if (!url) throw new Error("EDEN_WORLD_URL must be set to the Eden World RPC URL");
  const endpoint = new URL(url).toString();
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  function deploymentId(): string {
    const id = process.env.EDEN_EVE_DEPLOYMENT_ID;
    if (!id) throw new Error("EDEN_EVE_DEPLOYMENT_ID must be set to the producer deployment identity");
    return id;
  }
  const local = createLocalWorld({ recoverActiveRuns: false });
  async function rpc(op: string, args: unknown[]): Promise<unknown> {
    if (op === "events.create" && args[2] && typeof args[2] === "object") {
      // Replay observers are process-local callbacks for streamed responses.
      // This transport returns a complete CBOR result, not a streamed replay.
      const params = { ...args[2] } as Record<string, unknown>;
      delete params.replayEventObserver;
      args = [args[0], args[1], params];
    }
    const body = new Uint8Array(encode({ op, args }));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/cbor",
        "x-eden-world-token": process.env.EDEN_WORLD_TOKEN ?? "",
      },
      body,
    });
    if (!response.ok) throw new Error(`Eden World RPC ${op} failed: HTTP ${response.status}`);
    const result = decode(new Uint8Array(await response.arrayBuffer())) as RpcResult;
    if (!result.ok) {
      const error = Object.assign(new Error(result.error.message), result.error);
      const constructor = (errors as unknown as Record<string, { prototype?: object }>)[result.error.name];
      if (constructor?.prototype) Object.setPrototypeOf(error, constructor.prototype);
      throw error;
    }
    return result.result;
  }
  function methods<T>(namespace: string, names: string[]): T {
    return Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => rpc(`${namespace}.${name}`, args)])) as T;
  }
  const streams = methods<World["streams"]>("streams", ["write", "writeMulti", "close", "list", "getChunks", "getInfo"]);
  streams.get = async (runId, name, startIndex = 0) => {
    let index = startIndex;
    if (index < 0) {
      const info = await streams.getInfo(runId, name);
      index = Math.max(0, info.tailIndex + 1 + index);
    }
    let cancelled = false;
    let wake: (() => void) | undefined;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (!cancelled) {
            const result = await rpc("streams.readChunks", [name, index, 100]) as {
              chunks: Uint8Array[]; done: boolean; nextIndex: number;
            };
            if (cancelled) return;
            index = result.nextIndex;
            for (const chunk of result.chunks) controller.enqueue(chunk);
            if (result.done) { controller.close(); return; }
            if (result.chunks.length) return;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, pollIntervalMs);
              wake = () => { clearTimeout(timer); resolve(); };
            });
            wake = undefined;
          }
        } catch (error) {
          if (!cancelled) controller.error(error);
        }
      },
      cancel() { cancelled = true; wake?.(); },
    });
  };
  return {
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { deploymentAffinity: true, hookForceClaim: true, hookRetention: { active: true } },
    runs: methods<World["runs"]>("runs", ["get", "getMany", "list", "experimentalSetAttributes"]),
    steps: methods<World["steps"]>("steps", ["get", "list"]),
    events: methods<World["events"]>("events", ["create", "get", "list", "listByCorrelationId"]),
    hooks: methods<World["hooks"]>("hooks", ["get", "getByToken", "list"]),
    streams,
    getDeploymentId: async () => deploymentId(),
    queue: (queueName, message, opts) => {
      const sourceDeploymentId = deploymentId();
      // Run invocations resolve their durable pin in World. Control messages
      // such as health probes have no run and address this producer explicitly.
      const hasRun = message && typeof message === "object" && "runId" in message && typeof message.runId === "string";
      return rpc("queue.enqueue", [
        queueName, message, { ...opts, deploymentId: opts?.deploymentId ?? (hasRun ? undefined : sourceDeploymentId), sourceDeploymentId },
      ]) as Promise<{ messageId: MessageId | null }>;
    },
    createQueueHandler: (prefix, handler) => local.createQueueHandler(prefix, async (message, metadata) => {
      let handlerFailed = false;
      let handlerError: unknown;
      let result: unknown;
      try {
        result = await handler(message, metadata);
      } catch (error) {
        handlerFailed = true;
        handlerError = error;
      }
      // This runs in the container process even if the HTTP consumer was
      // replaced or disconnected. Response EOF remains a redundant ack.
      try {
        await rpc("queue.deliverySettled", [metadata.messageId, metadata.attempt]);
      } catch (error) {
        if (handlerFailed) throw new AggregateError([handlerError, error], "Queue handler and delivery settlement failed", { cause: handlerError });
        throw error;
      }
      if (handlerFailed) throw handlerError;
      return result;
    }),
    start: async () => {},
    close: async () => { await local.close?.(); },
  };
}

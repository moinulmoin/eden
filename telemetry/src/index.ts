/**
 * Eden's telemetry collector. It accepts only the event the Eden CLI sends,
 * writes it to Workers Analytics Engine, and stores nothing about the request
 * itself: no IP address, headers, or user agent. See README.md#telemetry.
 */

import { EDEN_FAILURE_CODES } from "../../packages/cli/src/failure-codes.js";

interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface Env {
  readonly EVENTS: AnalyticsEngineDataset;
}

/** The largest body accepted. An event is about 300 bytes. */
export const MAX_BODY_BYTES = 1024;

/** The same bounded versions the CLI sends; it sends "other" for anything else. */
const VERSION = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?:-(?:alpha|beta|rc|canary|next|preview)(?:\.(?:0|[1-9]\d{0,2}))?)?$/u;

const oneOf = (...values: readonly unknown[]) => (value: unknown) => values.includes(value);
const version = (value: unknown) => value === "other" || (typeof value === "string" && VERSION.test(value));

/** Each field the CLI sends, in the order it sends them, and the only values each may hold. */
const FIELDS: readonly (readonly [string, (value: unknown) => boolean])[] = [
  ["schema", oneOf(1)],
  ["installId", (value) => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)],
  ["command", oneOf("preflight", "deploy", "destroy")],
  ["edenVersion", version],
  ["exitCode", oneOf(0, 1)],
  ["failureCode", (value) => value === null || value === "other" || (typeof value === "string" && EDEN_FAILURE_CODES.has(value))],
  ["duration", oneOf("<10s", "10s-1m", "1m-5m", "5m-15m", "15m-1h", ">1h")],
  ["os", oneOf("darwin", "linux", "win32", "other")],
  ["arch", oneOf("arm64", "x64", "other")],
  ["nodeMajor", (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 100],
  ["eveVersion", version],
  ["world", oneOf("cloudflare", "postgres", "local", "other")],
  ["ci", oneOf(true, false)],
];

type Event = {
  schema: 1;
  installId: string;
  command: string;
  edenVersion: string;
  exitCode: 0 | 1;
  failureCode: string | null;
  duration: string;
  os: string;
  arch: string;
  nodeMajor: number;
  eveVersion: string;
  world: string;
  ci: boolean;
};

function parseEvent(text: string): Event | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!FIELDS.every(([key, valid]) => Object.hasOwn(record, key) && valid(record[key]))) return undefined;
  // Exactly the CLI's serialization: every field once, in order, no extra keys or spacing.
  if (JSON.stringify(Object.fromEntries(FIELDS.map(([key]) => [key, record[key]]))) !== text) return undefined;
  const event = value as Event;
  if ((event.exitCode === 0) !== (event.failureCode === null)) return undefined;
  return event;
}

/** The body as text, or a status when it is larger than the cap or not the declared length. */
async function readBody(request: Request, declared: number): Promise<string | number> {
  if (request.body === null) return 400;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return 413;
    }
    chunks.push(value);
  }
  if (size !== declared) return 400;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const empty = (status: number): Response => new Response(null, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/v1/events") return empty(404);
    if (request.method !== "POST") return empty(405);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return empty(415);
    }
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isInteger(declared) || declared <= 0) return empty(411);
    if (declared > MAX_BODY_BYTES) return empty(413);
    let body: string | number;
    try {
      body = await readBody(request, declared);
    } catch {
      return empty(400);
    }
    if (typeof body === "number") return empty(body);
    const event = parseEvent(body);
    if (event === undefined) return empty(400);
    env.EVENTS.writeDataPoint({
      indexes: [event.installId],
      blobs: [
        event.installId,
        event.command,
        event.edenVersion,
        event.failureCode ?? "",
        event.duration,
        event.os,
        event.arch,
        event.eveVersion,
        event.world,
        String(event.ci),
      ],
      doubles: [event.exitCode, event.nodeMajor, event.schema],
    });
    return empty(204);
  },
};

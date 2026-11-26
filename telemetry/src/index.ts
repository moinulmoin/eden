/**
 * Eden's telemetry collector. It accepts only the event the Eden CLI sends,
 * writes it to Workers Analytics Engine, and stores nothing about the request
 * itself: no IP address, headers, or user agent. See README.md#telemetry.
 */

interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface Env {
  readonly EVENTS: AnalyticsEngineDataset;
}

/** The largest body accepted. An event is about 300 bytes. */
export const MAX_BODY_BYTES = 1024;

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Each field the CLI sends, and the only values it may hold. */
const FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  schema: (value) => value === 1,
  installId: (value) => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value),
  command: (value) => value === "preflight" || value === "deploy" || value === "destroy",
  edenVersion: (value) => typeof value === "string" && value.length <= 64 && VERSION.test(value),
  exitCode: (value) => value === 0 || value === 1,
  failureCode: (value) => value === null || (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)),
  duration: (value) => ["<10s", "10s-1m", "1m-5m", "5m-15m", "15m-1h", ">1h"].includes(value as string),
  os: (value) => ["darwin", "linux", "win32", "other"].includes(value as string),
  arch: (value) => ["arm64", "x64", "other"].includes(value as string),
  nodeMajor: (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 1000,
  eveVersion: (value) => value === null || (typeof value === "string" && value.length <= 64 && VERSION.test(value)),
  world: (value) => value === null || ["cloudflare", "postgres", "local", "other"].includes(value as string),
  ci: (value) => typeof value === "boolean",
};

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
  eveVersion: string | null;
  world: string | null;
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
  const entries = Object.entries(value);
  if (entries.length !== Object.keys(FIELDS).length) return undefined;
  if (!entries.every(([key, field]) => Object.hasOwn(FIELDS, key) && FIELDS[key]?.(field) === true)) return undefined;
  const event = value as Event;
  if ((event.exitCode === 0) !== (event.failureCode === null)) return undefined;
  return event;
}

const empty = (status: number): Response => new Response(null, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/v1/events") return empty(404);
    if (request.method !== "POST") return empty(405);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return empty(415);
    }
    const length = Number(request.headers.get("content-length"));
    if (!Number.isInteger(length) || length <= 0) return empty(411);
    if (length > MAX_BODY_BYTES) return empty(413);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return empty(413);
    const event = parseEvent(new TextDecoder().decode(body));
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
        event.eveVersion ?? "",
        event.world ?? "",
        String(event.ci),
      ],
      doubles: [event.exitCode, event.nodeMajor, event.schema],
    });
    return empty(204);
  },
};

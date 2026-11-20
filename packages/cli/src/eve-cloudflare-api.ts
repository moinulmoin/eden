import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { CF_VERSION, type CloudflareCliRunner } from "./eve-cloudflare-cli.js";

/** One answer of Cloudflare's API: the status and the body as sent. */
export interface CloudflareApiAnswer {
  readonly status: number;
  readonly body: string;
}

/**
 * One GET of Cloudflare's API under `/client/v4`, for a path such as
 * `/accounts/<id>/workers/subdomain`. Undefined without a token or without
 * an answer. A redirect is refused, so an answer is the API's own for this
 * exact URL.
 */
export type CloudflareApiRead = (
  path: string,
  query?: Readonly<Record<string, string>>,
  timeoutMs?: number,
) => Promise<CloudflareApiAnswer | undefined>;

/**
 * The token of cf's own login. The pinned cf has no command that prints it,
 * so Eden runs `cf auth whoami` once with the API address set to a listener
 * of its own and takes the bearer from the first request cf sends. The
 * listener is bound to 127.0.0.1 on a port the system picks, before cf
 * starts, under a path only this cf run is told. It takes one request, checks
 * that it is the pinned cf asking who it is, answers 401 without sending
 * anything on, and closes. The token is returned to the caller and written
 * nowhere.
 */
async function captureLoginToken(cf: CloudflareCliRunner): Promise<string | undefined> {
  const secret = randomBytes(16).toString("hex");
  let token: string | undefined;
  const server = createServer();
  server.once("request", (request, response) => {
    const bearer = /^Bearer ([\x21-\x7e]{20,})$/u.exec(request.headers.authorization ?? "")?.[1];
    if (
      request.method === "GET" &&
      new RegExp(`^/${secret}/client/v4/(?:accounts|memberships|user)(?:\\?|$)`, "u").test(request.url ?? "") &&
      request.headers["user-agent"] === `cf-cli/${CF_VERSION}`
    ) token = bearer;
    server.close();
    response.writeHead(401, { "content-type": "application/json", connection: "close" });
    response.end('{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result":null}', () =>
      server.closeAllConnections()
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) return undefined;
    await cf({
      args: ["auth", "whoami"],
      apiBaseUrl: `http://127.0.0.1:${address.port}/${secret}/client/v4`,
      timeoutMs: 30_000,
    });
  } catch {
    return undefined;
  } finally {
    server.close();
    server.closeAllConnections();
  }
  return token;
}

/**
 * Whether Eden has a token for Cloudflare's API: CLOUDFLARE_API_TOKEN is
 * set, or cf hands over its login's token when asked now. Used to say why a
 * read failed; the token is dropped.
 */
export async function cloudflareApiTokenArrives(cf: CloudflareCliRunner): Promise<boolean> {
  return (process.env.CLOUDFLARE_API_TOKEN ?? "").length > 0 || await captureLoginToken(cf) !== undefined;
}

/**
 * Reads of Cloudflare's API for one Eden command, with CLOUDFLARE_API_TOKEN
 * when it is set and with the token of cf's login otherwise. That token is
 * taken at the first read and kept in memory by this reader alone. When the
 * API answers 401 for it, it is taken once more, since a login's token
 * expires.
 */
export function cloudflareApiReader(cf: CloudflareCliRunner): CloudflareApiRead {
  let login: Promise<string | undefined> | undefined;
  return async (path, query = {}, timeoutMs = 30_000) => {
    const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const fromEnvironment = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const started = performance.now();
    for (let attempt = 0; ; attempt += 1) {
      const token = fromEnvironment.length > 0 ? fromEnvironment : await (login ??= captureLoginToken(cf));
      const left = timeoutMs - (performance.now() - started);
      if (token === undefined || left <= 0) return undefined;
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(Math.ceil(left)),
        });
        if (response.status === 401 && fromEnvironment.length === 0 && attempt === 0) {
          login = undefined;
          continue;
        }
        return { status: response.status, body: await response.text() };
      } catch {
        return undefined;
      }
    }
  };
}

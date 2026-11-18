/* global AbortSignal */

// What Cloudflare's registry catalog lists for one run's repositories. The
// live check reads it to verify eden destroy, so it shares nothing with the
// per-repository listing that the CLI reads.

import { Buffer } from "node:buffer";
import { Agent, request } from "node:https";

const REGISTRY_HOST = "registry.cloudflare.com";

// One GET to the registry on a connection of its own: no proxy, certificate
// verification on, no redirect followed, 30 seconds and 16 MiB at most.
function registryGet(path, authorization) {
  return new Promise((done, fail) => {
    const sent = request({
      host: REGISTRY_HOST,
      port: 443,
      method: "GET",
      path,
      headers: { Authorization: authorization, Accept: "application/json" },
      agent: new Agent({ keepAlive: false }),
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(30_000),
    }, (response) => {
      if (response.statusCode !== 200) {
        sent.destroy();
        fail(new Error("the registry catalog answered HTTP " + response.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          sent.destroy();
          fail(new Error("the registry catalog is larger than 16 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => done({ body: Buffer.concat(chunks).toString("utf8"), link: response.headers.link }));
      response.on("close", () => fail(new Error("the registry closed the connection before the catalog ended")));
    });
    // The error's own text is left out: it is the provider's, not this check's.
    sent.on("error", () => fail(new Error("the request to the registry catalog failed or timed out")));
    sent.end();
  });
}

/**
 * Every tag and `sha256:` entry the catalog lists under `account` for the
 * repositories whose name starts with `repositoryPrefix`, as
 * `repository:tag` and `repository@sha256:…`. `credential` is the JSON that
 * `wrangler containers registries credentials` printed. It throws unless the
 * credential is for `account` and the catalog is read to its end: at most 50
 * pages, each naming only `account`, no repository twice, and each Link
 * header one next page with a cursor that moves.
 */
export async function registryCatalogRefs({ account, repositoryPrefix, credential, get = registryGet }) {
  if (
    typeof account !== "string" ||
    credential?.account_id !== account || credential.registry_host !== REGISTRY_HOST ||
    typeof credential.username !== "string" || typeof credential.password !== "string"
  ) throw new Error("the registry credential is not for this run's account on " + REGISTRY_HOST);
  const authorization = "Basic " + Buffer.from(credential.username + ":" + credential.password).toString("base64");
  const refs = [];
  const seen = new Set();
  let last = "";
  for (let page = 0; page < 50; page += 1) {
    const { body, link } = await get(
      "/v2/_catalog?tags=true" + (last === "" ? "" : "&last=" + encodeURIComponent(last)),
      authorization,
    );
    let repositories;
    try {
      repositories = JSON.parse(body)?.repositories;
    } catch {
      repositories = undefined;
    }
    if (typeof repositories !== "object" || repositories === null || Array.isArray(repositories)) {
      throw new Error("the registry catalog has no repositories object");
    }
    for (const [name, entries] of Object.entries(repositories)) {
      if (
        !name.startsWith(account + "/") || seen.has(name) ||
        !Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")
      ) throw new Error("the registry catalog names another account, a repository twice, or entries that are not text");
      seen.add(name);
      const repository = name.slice(account.length + 1);
      if (repository.startsWith(repositoryPrefix)) {
        refs.push(...entries.map((entry) => repository + (entry.startsWith("sha256:") ? "@" : ":") + entry));
      }
    }
    // No Link header, or an empty cursor, ends the catalog. Anything else must name the next page.
    if (link === undefined) return refs;
    const cursor = typeof link !== "string"
      ? undefined
      : /^\s*<?[^<>;,]*[?&]last=([^&<>;,\s]*)>?\s*;\s*rel="?next"?\s*$/u.exec(link)?.[1];
    if (cursor === undefined) throw new Error("the registry catalog's Link header is not one next page");
    if (cursor === "") return refs;
    let next;
    try {
      next = decodeURIComponent(cursor);
    } catch {
      next = last;
    }
    if (next === last) throw new Error("the registry catalog's next page does not move its cursor");
    last = next;
  }
  throw new Error("the registry catalog did not end after 50 pages");
}

/* global AbortSignal */

// What Cloudflare's registry catalog lists for one run's repositories. The
// live check reads it to verify eden destroy, so it shares nothing with the
// per-repository listing that the CLI reads.

import { Buffer } from "node:buffer";
import { Agent, request } from "node:https";

const REGISTRY_HOST = "registry.cloudflare.com";
// How many entries one page of the catalog holds.
const PAGE_ENTRIES = 25;

// One GET to the registry on a connection of its own: no proxy, certificate
// verification on, no redirect followed, 60 seconds and 16 MiB at most.
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
      signal: AbortSignal.timeout(60_000),
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
 * `wrangler containers registries credentials` printed.
 *
 * The catalog is read as Cloudflare's registry served it on 2026-11-18. A
 * page holds a fixed number of entries, in the order of the
 * registry's keys, `<account>/<account>/<repository>/…`, and starts after
 * the key in `last`; a repository can go on from one page to the next. So
 * the read starts at the key just before this run's repositories and ends at
 * the first repository after them, or at a page with no Link header. It does
 * not read the whole catalog: from 23:00Z that day the registry answered
 * HTTP 500 for a read of the whole catalog and for its last page.
 *
 * The registry also answered HTTP 500, or nothing, for a page it served
 * seconds later, so each page gets four tries. It throws unless the
 * credential is for `account` and every page is in that form: names of
 * `account` only, in ascending order from the prefix on, no field and no
 * entry twice, and a Link header that names a later key. At most 50 pages.
 */
export async function registryCatalogRefs({ account, repositoryPrefix, credential, get = registryGet }) {
  if (
    typeof account !== "string" ||
    credential?.account_id !== account || credential.registry_host !== REGISTRY_HOST ||
    typeof credential.username !== "string" || typeof credential.password !== "string"
  ) throw new Error("the registry credential is not for this run's account on " + REGISTRY_HOST);
  const authorization = "Basic " + Buffer.from(credential.username + ":" + credential.password).toString("base64");
  const refs = new Set();
  const keys = account + "/" + account + "/";
  let last = keys + repositoryPrefix;
  let previous = repositoryPrefix;
  for (let page = 0; page < 50; page += 1) {
    const path = "/v2/_catalog?tags=true&n=" + PAGE_ENTRIES + "&last=" + encodeURIComponent(last);
    let answer;
    for (let attempt = 1; answer === undefined; attempt += 1) {
      try {
        answer = await get(path, authorization);
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    let repositories;
    try {
      const catalog = JSON.parse(answer.body);
      // JSON.parse keeps the last of two fields with one name, so a body that
      // lists a repository twice must not be read as listing it once.
      const squeezed = (text) => text.replace(/\s/gu, "");
      repositories = squeezed(JSON.stringify(catalog)) === squeezed(answer.body) ? catalog?.repositories : undefined;
    } catch {
      repositories = undefined;
    }
    if (typeof repositories !== "object" || repositories === null || Array.isArray(repositories)) {
      throw new Error("the registry catalog has no repositories object, or names a field twice");
    }
    let passed = false;
    for (const [name, entries] of Object.entries(repositories)) {
      const repository = name.startsWith(account + "/") ? name.slice(account.length + 1) : undefined;
      if (repository === undefined || !Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
        throw new Error("the registry catalog names another account, or entries that are not text");
      }
      // The same name again is a repository going on from the page before.
      if (repository < previous) throw new Error("the registry catalog's repositories are not in ascending order from this run's on");
      previous = repository;
      if (!repository.startsWith(repositoryPrefix)) {
        passed = true;
        continue;
      }
      for (const entry of entries) {
        const ref = repository + (entry.startsWith("sha256:") ? "@" : ":") + entry;
        if (refs.has(ref)) throw new Error("the registry catalog lists an entry twice");
        refs.add(ref);
      }
    }
    if (passed || answer.link === undefined) return [...refs];
    const next = typeof answer.link !== "string"
      ? undefined
      : /^https:\/\/registry\.cloudflare\.com\/v2\/_catalog\?n=(\d+)&last=([A-Za-z0-9._:/-]+)&tags=true; rel=next$/u.exec(answer.link);
    if (next === null || next === undefined || next[1] !== String(PAGE_ENTRIES) || !next[2].startsWith(keys)) {
      throw new Error("the registry catalog's Link header is not the next page of this account's catalog");
    }
    if (next[2] <= last) throw new Error("the registry catalog's next page does not move its cursor");
    last = next[2];
  }
  throw new Error("the registry catalog did not end after 50 pages");
}

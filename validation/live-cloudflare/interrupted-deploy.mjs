/* global console, process */

// eden deploy with one fault put in: cf deploy is sent through a local proxy
// that answers Cloudflare's read of the Worker version it just uploaded with
// "not found" (code 100146), every time. cf then gives up after the Worker is
// live and before its Container application exists, which is what a slow
// Cloudflare did to real deploys on 2026-11-19. Every other request, and
// every other cf command, reaches Cloudflare unchanged. Eden has to finish
// the publish by itself.
//
// Prints Eden's JSON result on stdout and one "interrupted-deploy: {...}"
// line on stderr with what cf was asked to do.

import http from "node:http";
import https from "node:https";

import { runEdenCli } from "../../packages/cli/dist/index.js";
import { cloudflareCliEnvironment, createCloudflareCliRunner, runCloudflareCli } from "../../packages/cli/dist/eve-cloudflare-cli.js";

let injected = 0;
const proxy = http.createServer((request, response) => {
  const versionRead = request.method === "GET" &&
    /\/workers\/scripts\/[^/]+\/versions\/[0-9a-f-]{36}$/u.test((request.url ?? "").split("?")[0]);
  if (versionRead) {
    injected += 1;
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, errors: [{ code: 100146, message: "Version not found (injected by Eden's live check)" }], messages: [], result: null }));
    return;
  }
  const upstream = https.request(
    { host: "api.cloudflare.com", path: request.url, method: request.method, headers: { ...request.headers, host: "api.cloudflare.com" } },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", () => {
    response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const throughProxy = createCloudflareCliRunner((accountId) => ({
  ...cloudflareCliEnvironment(accountId),
  CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:" + proxy.address().port + "/client/v4",
}));

const commands = [];
const exitCode = await runEdenCli(["deploy", ...process.argv.slice(2)], {
  eveControlPlane: {
    cloudflareCli: async (request) => {
      const result = await (request.args[0] === "deploy" ? throughProxy : runCloudflareCli)(request);
      commands.push({ command: request.args.filter((arg) => !arg.startsWith("{")).slice(0, 4).join(" "), exitCode: result.exitCode ?? null });
      return result;
    },
  },
});
proxy.close();
console.error("interrupted-deploy: " + JSON.stringify({ injected, commands }));
process.exitCode = exitCode;

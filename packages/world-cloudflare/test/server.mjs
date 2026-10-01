import { createServer } from 'node:http';
import { NodeSqliteAdapter } from '../dist/core/node-sqlite.js';
import { WorldCore } from '../dist/core/index.js';

export async function startWorldServer({ database = ':memory:', deliveryOrigin, port = 0 } = {}) {
  const db = new NodeSqliteAdapter(database);
  let timer;
  let running;
  const core = new WorldCore({ sql: db, scheduleAlarm(at) {
    clearTimeout(timer);
    if (at !== null) timer = setTimeout(() => {
      running = core.runAlarm().catch((error) => console.error('World alarm:', error));
    }, Math.max(0, at - Date.now()));
  }, delivery: { async deliver(msg) {
    const origin = typeof deliveryOrigin === 'function' ? deliveryOrigin() : deliveryOrigin;
    if (!origin) return { ok: false, retryAfterMs: 100 };
    const response = await fetch(`${origin}/.well-known/workflow/v1/${msg.path}`, {
      method: 'POST', body: msg.body,
      headers: { ...msg.headers, 'content-type': 'application/json', 'x-vqs-queue-name': msg.queueName,
        'x-vqs-message-id': msg.messageId, 'x-vqs-message-attempt': String(msg.attempt) },
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = {}; }
    if (response.ok && typeof result.timeoutSeconds === 'number') return { ok: false, retryAfterMs: result.timeoutSeconds * 1000 };
    return { ok: response.ok };
  } } });
  core.migrate();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/__eden/world/rpc') { res.writeHead(404).end(); return; }
    try {
      if (process.env.EDEN_WORLD_DEBUG) console.log('RPC', req.url, Date.now());
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await core.handleRpc(new Uint8Array(Buffer.concat(chunks)));
      res.writeHead(200, { 'content-type': 'application/cbor' }).end(result);
    } catch (error) { console.error(error); res.writeHead(500).end(String(error)); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { core, url: `http://127.0.0.1:${server.address().port}/__eden/world/rpc`, async close() {
    clearTimeout(timer); await running; await new Promise((resolve) => server.close(resolve)); db.close();
  } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = await startWorldServer({ port: Number(process.env.EDEN_WORLD_PORT ?? 8789), database: process.env.EDEN_WORLD_DATABASE ?? ':memory:', deliveryOrigin: process.env.EDEN_WORLD_DELIVERY_ORIGIN ?? 'http://127.0.0.1:3000' });
  console.log(`Eden World RPC ready ${server.url}`);
  process.on('SIGTERM', () => { void server.close().then(() => process.exit()); });
}

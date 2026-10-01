import { startWorldServer } from './server.mjs';
if (process.env.CONTROL_FD === '3') {
  const server = await startWorldServer({ deliveryOrigin: () => process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : undefined });
  process.env.EDEN_WORLD_URL = server.url;
  process.once('SIGTERM', () => { void server.close().then(() => process.exit()); });
}

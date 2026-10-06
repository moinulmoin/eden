export class DurableObject<Env = unknown> {
  declare readonly ctx: unknown;
  declare readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    Object.assign(this, { ctx, env });
  }
}

export class WorkerEntrypoint<Env = unknown> {
  declare readonly ctx: unknown;
  declare readonly env: Env;
  constructor(ctx?: unknown, env?: Env) {
    Object.assign(this, { ctx, env });
  }
}

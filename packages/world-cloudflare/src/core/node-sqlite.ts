import { DatabaseSync } from 'node:sqlite';
import type { SqlExec } from './index.js';

/** Node 24 adapter for exercising the same SQL engine as Durable Objects. */
export class NodeSqliteAdapter implements SqlExec {
  readonly database: DatabaseSync;
  private transactionDepth = 0;
  constructor(filename = ':memory:') { this.database = new DatabaseSync(filename); }
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } {
    const statement = this.database.prepare(query);
    const values = bindings as (null | number | bigint | string | Uint8Array)[];
    const rows = statement.all(...values) as Record<string, unknown>[];
    return { toArray: () => rows };
  }
  transactionSync<T>(callback: () => T): T {
    const name = `world_${this.transactionDepth++}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try { const result = callback(); this.database.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO SAVEPOINT ${name}`); this.database.exec(`RELEASE SAVEPOINT ${name}`); throw error; }
    finally { this.transactionDepth--; }
  }
  close(): void { this.database.close(); }
}

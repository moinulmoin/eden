// Storage semantics ported from @workflow/world-postgres (Apache-2.0).
import { decode, encode } from 'cbor-x';
import { monotonicFactory } from 'ulid';
import { EntityConflictError, HookForceClaimedError, HookNotFoundError, RunExpiredError, RunNotSupportedError, TooEarlyError, WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { EventSchema, HookSchema, StepSchema, WorkflowRunSchema, SPEC_VERSION_CURRENT, SPEC_VERSION_LEGACY, SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM, slotToEventId, eventIdToSlot, stripEventDataRefs, validateAttributeChanges, validateUlidTimestamp, isTerminalWorkflowRunStatus, isTerminalStepStatus, isChildEntityCreationEvent, isTerminalRunEventType, requiresNewerWorld, isLegacySpecVersion } from '@workflow/world';
import type { AnyEventRequest, CreateEventParams, Event, EventResult, Hook, Step, Wait, WorkflowRun, AttributeChange, EventsResolveData } from '@workflow/world';

export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  transactionSync?<T>(callback: () => T): T;
}
export interface QueueDelivery {
  deliver(msg: { queueName: string; messageId: string; attempt: number; body: Uint8Array; path: 'flow' | 'step'; headers?: Record<string, string>; deploymentId?: string; sourceDeploymentId?: string; sandboxSessionId?: string }): Promise<{ ok: boolean; retryAfterMs?: number; sandboxTransferCompleted?: boolean }>;
}
type Params = { resolveData?: 'all' | 'none'; pagination?: { limit?: number; cursor?: string | null; sortOrder?: 'asc' | 'desc' }; runId?: string; workflowName?: string; status?: string | string[]; correlationId?: string };
type EnqueueOptions = {deploymentId?:string;sourceDeploymentId?:string;idempotencyKey?:string;delaySeconds?:number;headers?:Record<string,string>};
export type DeploymentDrainState = {liveRuns:number;liveSessions:number;pendingMessages:number;unfinishedTransfers:number;drained:boolean};
type QueueMessage = {runId?:string;stepId?:string;runInput?:Extract<AnyEventRequest,{eventType:'run_created'}>['eventData'] & {specVersion?:number};specVersion?:number};
export async function callDeploymentControlRpc(options: {origin:string;token:string;operation:'deployments.drainState'|'deployments.retire';args:unknown[];signal?:AbortSignal}): Promise<unknown> {
  const response = await fetch(new URL('/__eden/world/rpc',options.origin),{
    method:'POST',
    headers:{'content-type':'application/cbor',authorization:`Bearer ${options.token}`},
    body:new Uint8Array(encode({op:options.operation,args:options.args})),
    ...(options.signal === undefined ? {} : {signal:options.signal}),
  });
  if (!response.ok) throw Object.assign(new Error(`Eden deployment control RPC ${options.operation} failed: HTTP ${response.status}`),{status:response.status});
  const envelope = decode(new Uint8Array(await response.arrayBuffer())) as {ok:boolean;result?:unknown;error?:{message?:string}};
  if (!envelope.ok) throw new Error(envelope.error?.message ?? `Eden deployment control RPC ${options.operation} failed`);
  return envelope.result;
}
const ulid = monotonicFactory();
// Same default as @workflow/world when WORKFLOW_MAX_EVENTS is unset.
const DEFAULT_MAX_EVENTS_PER_RUN = 25000;
const bytes = (v: string | Uint8Array) => typeof v === 'string' ? new TextEncoder().encode(v) : v;
function sqlBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('SQLite BLOB must be an ArrayBuffer or Uint8Array');
}
const unpack = <T>(row: Record<string, unknown> | undefined): T | undefined => row ? decode(sqlBytes(row.data)) as T : undefined;
const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)) as T;
function filterData<T extends WorkflowRun | Step>(value: T, params?: Params): T {
  return params?.resolveData === 'none' ? { ...value, input: undefined, output: undefined } : value;
}
function filterHook(hook: Hook, params?: Params): Hook { return params?.resolveData === 'none' ? { ...hook, metadata: undefined } : hook; }

export class WorldCore {
  private readonly sql: SqlExec;
  private readonly delivery: QueueDelivery;
  private readonly now: () => number;
  private readonly scheduleAlarm: (atMs: number | null) => void | Promise<void>;
  private readonly inFlight = new Set<string>();
  private readonly waitUntil: (promise: Promise<void>) => void;
  private readonly retireDeployment: ((deploymentId: string) => Promise<void>) | undefined;
  private readonly currentDeploymentId: string | undefined;
  constructor(opts: { sql: SqlExec; delivery: QueueDelivery; now?: () => number; scheduleAlarm: (atMs: number | null) => void | Promise<void>; waitUntil?: (promise: Promise<void>) => void; retireDeployment?: (deploymentId: string) => Promise<void>; currentDeploymentId?: string }) {
    this.sql = opts.sql; this.delivery = opts.delivery; this.now = opts.now ?? Date.now; this.scheduleAlarm = opts.scheduleAlarm; this.waitUntil = opts.waitUntil ?? (() => {}); this.retireDeployment = opts.retireDeployment; this.currentDeploymentId = opts.currentDeploymentId;
  }
  private rows(query: string, ...args: unknown[]) { return this.sql.exec(query, ...args).toArray(); }
  private atomic<T>(fn: () => T): T { return this.sql.transactionSync ? this.sql.transactionSync(fn) : fn(); }
  migrate(): void {
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, deployment_id TEXT NOT NULL, data BLOB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS workflow_runs_name ON workflow_runs(name)',
      'CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status)',
      'CREATE TABLE IF NOT EXISTS workflow_event_slots (run_id TEXT PRIMARY KEY)',
      'CREATE TABLE IF NOT EXISTS workflow_events (run_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, correlation_id TEXT, resume_id TEXT, resume_payload_digest TEXT, data BLOB NOT NULL, PRIMARY KEY(run_id,id))',
      'CREATE INDEX IF NOT EXISTS workflow_events_correlation ON workflow_events(correlation_id)',
      "CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_entity_creation_unique ON workflow_events(run_id,correlation_id,type) WHERE type IN ('step_created','hook_created','wait_created','attr_set')",
      "CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_hook_resume_unique ON workflow_events(run_id,resume_id) WHERE type = 'hook_received' AND resume_id IS NOT NULL",
      'CREATE TABLE IF NOT EXISTS workflow_steps (step_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, data BLOB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS workflow_steps_run ON workflow_steps(run_id)',
      'CREATE TABLE IF NOT EXISTS workflow_hooks (hook_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, token TEXT NOT NULL, data BLOB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS workflow_hooks_run ON workflow_hooks(run_id)',
      'CREATE INDEX IF NOT EXISTS workflow_hooks_token ON workflow_hooks(token)',
      // Routing tombstones outlive invocation-data retention; never store payloads here.
      'CREATE TABLE IF NOT EXISTS workflow_hook_disposals (run_id TEXT NOT NULL, hook_id TEXT NOT NULL, token TEXT NOT NULL, claimed_run_id TEXT NOT NULL, claimed_hook_id TEXT NOT NULL, PRIMARY KEY(run_id,hook_id))',
      'CREATE TABLE IF NOT EXISTS workflow_waits (wait_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data BLOB NOT NULL)',
      'CREATE TABLE IF NOT EXISTS workflow_stream_chunks (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, stream_id TEXT NOT NULL, run_id TEXT NOT NULL, data BLOB NOT NULL, eof INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(stream_id,id))',
      'CREATE INDEX IF NOT EXISTS workflow_stream_chunks_name ON workflow_stream_chunks(stream_id,sequence)',
      'CREATE INDEX IF NOT EXISTS workflow_stream_chunks_run ON workflow_stream_chunks(run_id)',
      'CREATE TABLE IF NOT EXISTS workflow_queue_messages (id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, body BLOB NOT NULL, path TEXT NOT NULL, due_at INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, completed INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT)',
      'CREATE UNIQUE INDEX IF NOT EXISTS workflow_queue_idempotency ON workflow_queue_messages(idempotency_key) WHERE idempotency_key IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS workflow_queue_due ON workflow_queue_messages(completed,due_at)',
      'CREATE TABLE IF NOT EXISTS workflow_sandbox_transfers (message_id TEXT PRIMARY KEY, source_deployment_id TEXT NOT NULL, deployment_id TEXT NOT NULL, session_id TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE IF NOT EXISTS workflow_retired_deployments (deployment_id TEXT PRIMARY KEY)',
      'CREATE TABLE IF NOT EXISTS workflow_delivery_claims (message_id TEXT NOT NULL, attempt INTEGER NOT NULL, deployment_id TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(message_id,attempt))',
      'CREATE INDEX IF NOT EXISTS workflow_delivery_claims_active ON workflow_delivery_claims(deployment_id,settled)',
    ]) this.sql.exec(statement);
    if (!this.rows('PRAGMA table_info(workflow_queue_messages)').some(row => row.name === 'headers')) this.sql.exec('ALTER TABLE workflow_queue_messages ADD COLUMN headers BLOB');
    for (const column of ['deployment_id','source_deployment_id']) if (!this.rows('PRAGMA table_info(workflow_queue_messages)').some(row => row.name === column)) this.sql.exec(`ALTER TABLE workflow_queue_messages ADD COLUMN ${column} TEXT`);
    if (!this.rows('PRAGMA table_info(workflow_queue_messages)').some(row => row.name === 'lease_until')) this.sql.exec('ALTER TABLE workflow_queue_messages ADD COLUMN lease_until INTEGER');
    if (!this.rows('PRAGMA table_info(workflow_delivery_claims)').some(row => row.name === 'legacy')) this.sql.exec('ALTER TABLE workflow_delivery_claims ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0');
    this.atomic(()=>{
      // Pre-protocol outstanding attempts cannot be declared stopped by a
      // replacement actor. Preserve their exact identity, and reserve a new
      // attempt number for recovery rather than reusing that old claim.
      for (const row of this.rows('SELECT * FROM workflow_queue_messages q WHERE completed=0 AND (lease_until IS NULL OR lease_until>0) AND NOT EXISTS (SELECT 1 FROM workflow_delivery_claims c WHERE c.message_id=q.id)')) {
        const deploymentId = this.queueTarget(this.queueMessage(sqlBytes(row.body)),row.deployment_id == null ? undefined : String(row.deployment_id));
        this.sql.exec('INSERT INTO workflow_delivery_claims(message_id,attempt,deployment_id,legacy) VALUES(?,?,?,1)',row.id,row.attempt,deploymentId);
        this.sql.exec('UPDATE workflow_queue_messages SET attempt=attempt+1 WHERE id=?',row.id);
      }
    });
    // A previously drained affinity key can become current again on rollback.
    // Only Worker publication metadata, never a caller's requested target,
    // authorizes reopening that key's admission fence.
    if (this.currentDeploymentId) this.sql.exec('DELETE FROM workflow_retired_deployments WHERE deployment_id=?',this.currentDeploymentId);
  }
  private run(id: string): WorkflowRun { const value = unpack<WorkflowRun>(this.rows('SELECT data FROM workflow_runs WHERE id = ?', id)[0]); if (!value) throw new WorkflowRunNotFoundError(id); return WorkflowRunSchema.parse(value); }
  private assertDeploymentActive(deploymentId: string): void {
    if (this.rows('SELECT deployment_id FROM workflow_retired_deployments WHERE deployment_id=?',deploymentId).length) throw new WorkflowWorldError(`Deployment ${deploymentId} has been retired`,{status:409});
  }
  deliverySettled(messageId: string, attempt: number): void {
    // Called by the receiving Container DO through the current World actor.
    // A different attempt's success never reconciles this execution.
    this.sql.exec('UPDATE workflow_delivery_claims SET settled=1 WHERE message_id=? AND attempt=?',messageId,attempt);
  }
  private reconcileDeliveryClaims(): void {
    for (const row of this.rows('SELECT c.message_id,c.attempt,c.legacy,q.body FROM workflow_delivery_claims c JOIN workflow_queue_messages q ON q.id=c.message_id WHERE c.settled=0')) {
      const message = this.queueMessage(sqlBytes(row.body));
      if (typeof message?.runId !== 'string') continue;
      if (typeof message.stepId !== 'string' && !Number(row.legacy)) continue;
      try {
        // Terminal step evidence proves a tool finished, even when its HTTP
        // response was lost. Legacy flows additionally use terminal-run
        // evidence; a running anchor alone never reconciles an unknown flow.
        const terminal = typeof message.stepId === 'string'
          ? isTerminalStepStatus(this.step(message.runId,message.stepId).status)
          : isTerminalWorkflowRunStatus(this.run(message.runId).status);
        if (terminal) this.deliverySettled(String(row.message_id),Number(row.attempt));
      } catch (error) {
        if (!(error instanceof WorkflowRunNotFoundError) && !(error instanceof WorkflowWorldError)) throw error;
      }
    }
  }
  deploymentActivity(deploymentId: string): {activeDeliveries:number;unfinishedTransfers:number} {
    this.reconcileDeliveryClaims();
    const activeDeliveries = Number(this.rows('SELECT COUNT(*) AS count FROM workflow_delivery_claims WHERE deployment_id=? AND settled=0',deploymentId)[0]?.count ?? 0);
    const unfinishedTransfers = Number(this.rows('SELECT COUNT(*) AS count FROM workflow_sandbox_transfers WHERE completed=0 AND (deployment_id=? OR source_deployment_id=?)',deploymentId,deploymentId)[0]?.count ?? 0);
    return {activeDeliveries,unfinishedTransfers};
  }
  private queueMessage(body: Uint8Array): QueueMessage {
    return JSON.parse(new TextDecoder().decode(body),(_key,value:unknown)=>{
      if (value && typeof value === 'object' && '__type' in value && value.__type === 'Uint8Array' && 'data' in value && typeof value.data === 'string') {
        return Uint8Array.from(atob(value.data),character=>character.charCodeAt(0));
      }
      return value;
    }) as QueueMessage;
  }
  private queueTarget(message: QueueMessage | null | undefined, explicit?: string): string {
    if (explicit) return explicit;
    if (typeof message?.runId === 'string') {
      try { return this.run(message.runId).deploymentId; }
      catch (error) { if (!(error instanceof WorkflowRunNotFoundError)) throw error; }
    }
    if (typeof message?.runInput?.deploymentId === 'string') return message.runInput.deploymentId;
    // Old clients never supplied routing metadata. Their unpinned probes and
    // pre-affinity messages belong to the original, unsuffixed container.
    return 'eden-cloudflare';
  }
  private sessionId(run: WorkflowRun): string | undefined {
    const visited = new Set<string>();
    let current: WorkflowRun | undefined = run;
    while (current && !visited.has(current.runId)) {
      visited.add(current.runId);
      const sessionId = current.attributes?.['$eve.session'];
      if (typeof sessionId === 'string' && sessionId) return sessionId;
      if (current.attributes?.['$eve.type'] === 'session') return current.runId;
      const parentId = current.attributes?.['$parentRunId'];
      if (typeof parentId !== 'string' || !parentId) return;
      try { current = this.run(parentId); }
      catch (error) { if (!(error instanceof WorkflowRunNotFoundError)) throw error; return; }
    }
  }
  private successorSandbox(message: QueueMessage): {sessionId:string;sourceDeploymentId:string} | undefined {
    if (!message?.runInput || typeof message.runId !== 'string') return;
    let run: WorkflowRun;
    try { run = this.run(message.runId); }
    catch (error) {
      if (!(error instanceof WorkflowRunNotFoundError)) throw error;
      // run_created races the initial queue write. Rebuild exactly the same
      // pending creation state instead of treating a missing row as no import.
      const now = new Date(this.now());
      run = WorkflowRunSchema.parse({...message.runInput,runId:message.runId,status:'pending',attributes:message.runInput.attributes ?? {},createdAt:now,updatedAt:now,specVersion:message.runInput.specVersion ?? message.specVersion ?? SPEC_VERSION_CURRENT});
    }
    if (run.status !== 'pending' || run.workflowName !== 'workflow//eve//workflowEntry' || run.attributes?.['$eve.session']) return;
    const parentId = run.attributes?.['$parentRunId'];
    if (typeof parentId !== 'string' || !parentId) return;
    // Missing parent metadata is retryable, never permission to start empty.
    const parent = this.run(parentId);
    if (parent.workflowName !== 'workflow//eve//workflowEntry') return;
    const sessionId = this.sessionId(parent);
    if (!sessionId) throw new WorkflowWorldError(`Cannot resolve sandbox session for successor ${run.runId}`);
    return {sessionId,sourceDeploymentId:parent.deploymentId};
  }
  private reconcileTerminalMessages(runId?: string): void {
    const terminalRuns = new Set(this.rows(
      `SELECT id FROM workflow_runs WHERE status IN ('completed','failed','cancelled')${runId === undefined ? '' : ' AND id=?'}`,
      ...(runId === undefined ? [] : [runId]),
    ).map(row=>String(row.id)));
    if (!terminalRuns.size) return;
    // A terminal run makes undelivered wakes obsolete, not active executions
    // or sandbox imports. Keep their durable ownership evidence untouched.
    for (const row of this.rows('SELECT q.id,q.body FROM workflow_queue_messages q WHERE q.completed=0 AND COALESCE(q.lease_until,0)<=? AND NOT EXISTS (SELECT 1 FROM workflow_delivery_claims c WHERE c.message_id=q.id AND c.settled=0) AND NOT EXISTS (SELECT 1 FROM workflow_sandbox_transfers t WHERE t.message_id=q.id AND t.completed=0)',this.now())) {
      if (this.inFlight.has(String(row.id))) continue;
      const message = this.queueMessage(sqlBytes(row.body));
      if (typeof message?.runId !== 'string' || !terminalRuns.has(message.runId)) continue;
      this.sql.exec('UPDATE workflow_queue_messages SET completed=1,idempotency_key=NULL,lease_until=0 WHERE id=?',row.id);
    }
  }
  private drainState(deploymentIds: string[]): Record<string, DeploymentDrainState> {
    this.reconcileDeliveryClaims();
    this.reconcileTerminalMessages();
    const result: Record<string, DeploymentDrainState> = Object.fromEntries(deploymentIds.map(id=>[id,{liveRuns:0,liveSessions:0,pendingMessages:0,unfinishedTransfers:0,drained:false}]));
    const sessions = new Map(deploymentIds.map(id=>[id,new Set<string>()]));
    for (const row of this.rows('SELECT data FROM workflow_runs')) {
      const run = WorkflowRunSchema.parse(unpack<WorkflowRun>(row));
      const state = result[run.deploymentId];
      if (!state || isTerminalWorkflowRunStatus(run.status)) continue;
      state.liveRuns++;
      const sessionId = this.sessionId(run);
      if (sessionId) sessions.get(run.deploymentId)!.add(sessionId);
    }
    for (const row of this.rows('SELECT * FROM workflow_queue_messages WHERE completed=0')) {
      const message = this.queueMessage(sqlBytes(row.body));
      const target = this.queueTarget(message,row.deployment_id == null ? undefined : String(row.deployment_id));
      if (result[target]) result[target]!.pendingMessages++;
      // An admitted successor retains its source even before its first alarm
      // has persisted a transfer journal entry.
      const sandbox = this.successorSandbox(message);
      const source = sandbox?.sourceDeploymentId;
      if (source && source !== target && !this.rows('SELECT message_id FROM workflow_sandbox_transfers WHERE message_id=?',row.id).length) {
        for (const id of [source,target]) if (result[id]) result[id]!.unfinishedTransfers++;
      }
    }
    for (const row of this.rows('SELECT source_deployment_id,deployment_id FROM workflow_sandbox_transfers WHERE completed=0')) {
      for (const id of new Set([String(row.source_deployment_id),String(row.deployment_id)])) if (result[id]) result[id]!.unfinishedTransfers++;
    }
    // A later retry completing the queue message does not settle an earlier
    // container execution whose response was lost. Keep those deliveries in
    // retirement accounting without double-counting still-pending messages.
    for (const row of this.rows('SELECT DISTINCT c.message_id,c.deployment_id FROM workflow_delivery_claims c LEFT JOIN workflow_queue_messages q ON q.id=c.message_id WHERE c.settled=0 AND (q.id IS NULL OR q.completed=1)')) {
      const state = result[String(row.deployment_id)];
      if (state) state.pendingMessages++;
    }
    for (const id of deploymentIds) {
      const state = result[id]!;
      state.liveSessions = sessions.get(id)!.size;
      state.drained = state.liveRuns === 0 && state.pendingMessages === 0 && state.unfinishedTransfers === 0;
    }
    return result;
  }
  private step(runId: string, id: string): Step { const value = unpack<Step>(this.rows('SELECT data FROM workflow_steps WHERE run_id = ? AND step_id = ?', runId, id)[0]); if (!value) throw new WorkflowWorldError(`Step not found: ${id}`); return StepSchema.parse(value); }
  private saveRun(run: WorkflowRun): void { this.sql.exec('INSERT INTO workflow_runs(id,name,status,deployment_id,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,deployment_id=excluded.deployment_id,data=excluded.data', run.runId, run.workflowName, run.status, run.deploymentId, encode(compact(run))); }
  private saveStep(step: Step): void { this.sql.exec('INSERT INTO workflow_steps(step_id,run_id,status,data) VALUES(?,?,?,?) ON CONFLICT(step_id) DO UPDATE SET status=excluded.status,data=excluded.data', step.stepId, step.runId, step.status, encode(compact(step))); }
  private saveHook(hook: Hook): void { this.sql.exec('INSERT INTO workflow_hooks(hook_id,run_id,token,data) VALUES(?,?,?,?) ON CONFLICT(hook_id) DO UPDATE SET token=excluded.token,data=excluded.data', hook.hookId, hook.runId, hook.token, encode(compact(hook))); }
  private hookAvailable(hook: Hook): boolean { let run: WorkflowRun; try { run = this.run(hook.runId); } catch { return true; } return !isTerminalWorkflowRunStatus(run.status) || (hook.tokenRetentionUntil?.getTime() ?? 0) > this.now(); }
  private findHook(id: string, token = false): Hook | undefined { const values = this.rows(`SELECT data FROM workflow_hooks WHERE ${token ? 'token' : 'hook_id'} = ?`, id); return values.map(row => HookSchema.parse(unpack<Hook>(row))).find(h => this.hookAvailable(h)); }
  private hook(id: string, token = false, params?: Params): Hook { const value = this.findHook(id, token); if (!value) throw new HookNotFoundError(id); return filterHook(value, params); }
  private event(runId: string, id: string, resolveData: EventsResolveData = 'all'): Event { const value = unpack<Event>(this.rows('SELECT data FROM workflow_events WHERE run_id=? AND id=?', runId, id)[0]); if (!value) throw new WorkflowWorldError(`Event not found: ${id}`); return stripEventDataRefs(EventSchema.parse(value), resolveData); }
  private prior(runId: string, correlationId: string | undefined, type: string): Event | undefined { if (!correlationId) return; return unpack<Event>(this.rows('SELECT data FROM workflow_events WHERE run_id=? AND correlation_id=? AND type=? LIMIT 1', runId, correlationId, type)[0]); }
  private insertEvent(runId: string, data: AnyEventRequest | Omit<Extract<Event, {eventType: 'hook_conflict'}>, 'eventId' | 'runId' | 'createdAt'>, resumeId?: string, digest?: string): Event {
    const slotted = this.rows('SELECT run_id FROM workflow_event_slots WHERE run_id=?', runId).length > 0;
    const last = this.rows('SELECT id FROM workflow_events WHERE run_id=? ORDER BY id DESC LIMIT 1', runId)[0];
    const eventId = slotted ? slotToEventId((last ? eventIdToSlot(String(last.id)) ?? 0 : 0) + 1) : `wevt_${ulid(this.now())}`;
    const event = EventSchema.parse(compact({ ...data, specVersion: data.specVersion ?? SPEC_VERSION_CURRENT, eventId, runId, createdAt: new Date(this.now()), resumeId }));
    try { this.sql.exec('INSERT INTO workflow_events(run_id,id,type,correlation_id,resume_id,resume_payload_digest,data) VALUES(?,?,?,?,?,?,?)', runId, eventId, data.eventType, data.correlationId ?? null, resumeId ?? null, digest ?? null, encode(event)); }
    catch (error) { if (String(error).includes('UNIQUE')) throw new EntityConflictError(`${data.eventType} for correlationId "${data.correlationId}" already exists in run "${runId}"`); throw error; }
    return event;
  }
  private listEvents(params: Params & { runId: string }, correlation = false, resolveData: EventsResolveData = 'all') {
    const limit = params.pagination?.limit ?? (correlation ? 100 : DEFAULT_MAX_EVENTS_PER_RUN);
    const args: unknown[] = [params.runId]; let where = 'run_id=?';
    const desc = params.pagination?.sortOrder === 'desc';
    if (correlation) { where += ' AND correlation_id=?'; args.push(params.correlationId); }
    if (params.pagination?.cursor) { where += ` AND id ${desc ? '<' : '>'} ?`; args.push(params.pagination.cursor); }
    const rows = this.rows(`SELECT data FROM workflow_events WHERE ${where} ORDER BY id ${desc ? 'DESC' : 'ASC'} LIMIT ?`, ...args, limit + 1);
    const data = rows.slice(0, limit).map(row => stripEventDataRefs(EventSchema.parse(unpack<Event>(row)), resolveData));
    return { data, cursor: data.at(-1)?.eventId ?? null, hasMore: rows.length > limit };
  }
  private attributes(runId: string, changes: AttributeChange[], options?: { allowReservedAttributes?: boolean }): WorkflowRun {
    const run = this.run(runId); validateAttributeChanges(changes, { existingKeys: Object.keys(run.attributes ?? {}), allowReservedAttributes: options?.allowReservedAttributes === true });
    const attributes = { ...run.attributes }; for (const { key, value } of changes) { if (value === null) delete attributes[key]; else attributes[key] = value; }
    const updated = { ...run, attributes, updatedAt: new Date(this.now()) }; this.saveRun(updated); return updated;
  }
  private forceRefusal(runId: string, hookId: string, token?: string): void {
    const marker = this.rows('SELECT token,claimed_run_id,claimed_hook_id FROM workflow_hook_disposals WHERE run_id=? AND hook_id=?',runId,hookId)[0];
    // Older deployments journaled the routing evidence only in the event log.
    const disposal = marker ? undefined : this.prior(runId, hookId, 'hook_disposed'); const data = disposal?.eventType === 'hook_disposed' ? disposal.eventData : undefined;
    const claimedBy = marker ? {runId:String(marker.claimed_run_id),hookId:String(marker.claimed_hook_id)} : data?.forceClaimedBy;
    if (claimedBy) { const routeToken = token ?? (marker ? String(marker.token) : data?.token) ?? ''; const successor = this.findHook(routeToken,true); throw new HookForceClaimedError(routeToken,successor?.runId ?? claimedBy.runId,successor?.hookId ?? claimedBy.hookId); }
    throw new HookNotFoundError(hookId);
  }
  private createRun(runId: string, data: Extract<AnyEventRequest, { eventType: 'run_created' }>): { run: WorkflowRun; event: Event } {
    if ((data.specVersion ?? SPEC_VERSION_CURRENT) > SPEC_VERSION_CURRENT) throw new RunNotSupportedError(data.specVersion!,SPEC_VERSION_CURRENT);
    if (this.rows('SELECT id FROM workflow_runs WHERE id=?', runId).length) throw new EntityConflictError(`Workflow run "${runId}" already exists`);
    const d = data.eventData; validateAttributeChanges(Object.entries(d.attributes ?? {}).map(([key,value]) => ({key,value})), { allowReservedAttributes: d.allowReservedAttributes === true });
    this.assertDeploymentActive(d.deploymentId);
    const now = new Date(this.now());
    const run = WorkflowRunSchema.parse(compact({ runId, ...d, status: 'pending', attributes: d.attributes ?? {}, createdAt: now, updatedAt: now, specVersion: data.specVersion ?? SPEC_VERSION_CURRENT }));
    this.saveRun(run); this.sql.exec('INSERT INTO workflow_event_slots(run_id) VALUES(?)', runId); const event = this.insertEvent(runId, data); return { run, event };
  }
  private async create(runId: string | null, request: AnyEventRequest, params?: CreateEventParams): Promise<EventResult> {
    const id = runId || (request.eventType === 'run_created' ? `wrun_${ulid(this.now())}` : ''); if (!id) throw new Error('runId is required for non-run_created events');
    if (request.eventType === 'run_created' && runId) { const error = validateUlidTimestamp(id, 'wrun_'); if (error) throw new WorkflowWorldError(error); }
    let digest: string | undefined;
    if (request.eventType === 'hook_received' && params?.resumeId) {
      const payload = request.eventData.payload; const input = payload instanceof Uint8Array ? payload : encode(payload);
      digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(input))), b => b.toString(16).padStart(2, '0')).join('');
      if (params.resumePayloadDigest && params.resumePayloadDigest !== digest) throw new WorkflowWorldError('Hook resume digest does not match its payload', { status: 422 });
    }
    return this.atomic(() => this.createSync(id, request, params, digest));
  }
  private createSync(id: string, request: AnyEventRequest, params?: CreateEventParams, digest?: string): EventResult {
    const now = new Date(this.now()); const specVersion = request.specVersion ?? SPEC_VERSION_CURRENT;
    let data = { ...request } as AnyEventRequest; let run: WorkflowRun | undefined; let step: Step | undefined; let hook: Hook | undefined; let wait: Wait | undefined; let event: Event | undefined; let stepCreated = false;
    const type = data.eventType; const correlationId = data.correlationId;
    if (type === 'run_created') { ({ run, event } = this.createRun(id, data as Extract<AnyEventRequest,{eventType:'run_created'}>)); }
    else {
      let current: WorkflowRun | undefined;
      try { current = this.run(id); } catch (error) { if (!(error instanceof WorkflowRunNotFoundError)) throw error; }
      if (!current && type === 'run_started' && 'eventData' in data && data.eventData) {
        const d = data.eventData as Extract<AnyEventRequest,{eventType:'run_created'}>['eventData'];
        if (d.deploymentId && d.workflowName && d.input !== undefined) current = this.createRun(id, { eventType: 'run_created', eventData: d, specVersion }).run;
      }
      if (!current && ['run_started','attr_set','hook_received'].includes(type)) throw new WorkflowRunNotFoundError(id);
      const validatesRunVersion = type !== 'step_completed' && type !== 'step_retrying';
      if (current && validatesRunVersion && (requiresNewerWorld(current.specVersion) || (current.specVersion ?? SPEC_VERSION_LEGACY) > SPEC_VERSION_CURRENT)) throw new RunNotSupportedError(current.specVersion!, SPEC_VERSION_CURRENT);
      if (current && validatesRunVersion && isLegacySpecVersion(current.specVersion)) {
        if (type === 'run_cancelled') { run = WorkflowRunSchema.parse({ ...current, status:'cancelled', completedAt:now, updatedAt:now }); this.saveRun(run); this.sql.exec('DELETE FROM workflow_hooks WHERE run_id=?',id); this.sql.exec('DELETE FROM workflow_waits WHERE run_id=?',id); this.reconcileTerminalMessages(id); return {run}; }
        if (!['wait_completed','hook_received'].includes(type)) throw new Error(`Event type '${type}' not supported for legacy runs (specVersion: ${current.specVersion || 'undefined'}). Please upgrade @workflow packages.`);
        if (type === 'hook_received' && isTerminalWorkflowRunStatus(current.status)) throw new RunExpiredError(`Workflow run "${id}" is already in terminal state "${current.status}"`);
        return {event:stripEventDataRefs(this.insertEvent(id,data),params?.resolveData ?? 'all')};
      }
      // A stale resolved delivery must follow a takeover even after the victim
      // finishes or purges its invocation data. Successful resumes still dedup below.
      if (type === 'hook_received' && !this.findHook(correlationId!) && !(params?.resumeId && this.rows("SELECT id FROM workflow_events WHERE run_id=? AND resume_id=? AND type='hook_received'",id,params.resumeId).length)) {
        try { this.forceRefusal(id,correlationId!,(data as Extract<AnyEventRequest,{eventType:'hook_received'}>).eventData.token); }
        catch (error) { if (error instanceof HookForceClaimedError) throw error; if (!(error instanceof HookNotFoundError)) throw error; }
      }
      if (type === 'hook_received' && params?.resumeId) {
        if (current?.expiredAt || (current && isTerminalWorkflowRunStatus(current.status) && current.attributes['$retention'] === '0')) throw new WorkflowWorldError('Invocation data has expired under the run retention policy',{status:410,code:'INVOCATION_DATA_EXPIRED'});
        const prior = this.rows("SELECT data,resume_payload_digest,correlation_id FROM workflow_events WHERE run_id=? AND resume_id=? AND type='hook_received'",id,params.resumeId)[0];
        if (prior) { const existing = unpack<Event>(prior)!; const incoming = data as Extract<AnyEventRequest,{eventType:'hook_received'}>; if (prior.correlation_id !== correlationId || prior.resume_payload_digest !== digest || existing.eventType !== 'hook_received' || existing.eventData?.token !== incoming.eventData.token) throw new WorkflowWorldError('Hook resume identity reused with different contents',{status:422}); return this.eventResult(id,{event:existing},params); }
      }
      const lazy = isChildEntityCreationEvent(data) && type === 'step_started';
      const terminal = current && isTerminalWorkflowRunStatus(current.status);
      if (terminal && current) {
        if (type === 'run_cancelled' && current.status === 'cancelled') { this.reconcileTerminalMessages(id); return {event:stripEventDataRefs(this.insertEvent(id,data),params?.resolveData ?? 'all'),run:current}; }
        if (type === 'run_started' || type === 'hook_received') throw new RunExpiredError(`Workflow run "${id}" is already in terminal state "${current.status}"`);
        if (isTerminalRunEventType(type) && !(type === 'run_cancelled' && current.status === 'cancelled')) throw new EntityConflictError(`Cannot transition run from terminal state "${current.status}"`);
        if (isChildEntityCreationEvent(data)) throw new EntityConflictError(`Cannot create new entities on run in terminal state "${current.status}"`);
        if (type === 'attr_set') throw new EntityConflictError(`Cannot set attributes on run in terminal state "${current.status}"`);
      }
      if (['step_created','hook_created','wait_created'].includes(type) || (data.eventType === 'attr_set' && data.eventData.writer.type === 'workflow')) {
        if (this.prior(id,correlationId,type)) throw new EntityConflictError(`${type} for correlationId "${correlationId}" already exists in run "${id}"`);
      }
      if (type.startsWith('run_')) {
        if (!current) throw new WorkflowRunNotFoundError(id);
        if (type === 'run_started') {
          if (current.status === 'running') return {run:current};
          run = WorkflowRunSchema.parse({...current,status:'running',startedAt:now,updatedAt:now}); data = compact({...data,eventData:undefined}) as AnyEventRequest;
        } else if (data.eventType === 'run_completed') run = WorkflowRunSchema.parse({...current,status:'completed',output:data.eventData.output,completedAt:now,updatedAt:now});
        else if (data.eventType === 'run_failed') { const d = data.eventData; run = WorkflowRunSchema.parse({...current,status:'failed',error:d.error,errorCode:d.errorCode,completedAt:now,updatedAt:now}); }
        else if (type === 'run_cancelled') run = WorkflowRunSchema.parse({...current,status:'cancelled',completedAt:current.completedAt ?? now,updatedAt:now});
        if (run) this.saveRun(run);
        if (isTerminalRunEventType(type)) { for (const row of this.rows('SELECT data FROM workflow_hooks WHERE run_id=?',id)) { const h = unpack<Hook>(row)!; if ((h.tokenRetentionUntil?.getTime() ?? 0) <= this.now()) this.sql.exec('DELETE FROM workflow_hooks WHERE hook_id=?',h.hookId); } this.sql.exec('DELETE FROM workflow_waits WHERE run_id=?',id); this.reconcileTerminalMessages(id); }
      }
      if (data.eventType === 'attr_set') { const d = data.eventData; run = this.attributes(id,d.changes,{allowReservedAttributes:d.allowReservedAttributes === true}); }
      if (type.startsWith('step_')) {
        const d = ('eventData' in data ? data.eventData : {}) as {stepName?: string; input?: Step['input']; result?: Step['output']; error?: Step['error']; retryAfter?: Date};
        let existing: Step | undefined; try { existing = this.step(id,correlationId!); } catch (error) { if (!(error instanceof WorkflowWorldError)) throw error; }
        if (type === 'step_created' || lazy) {
          if (lazy && existing) throw new EntityConflictError(`Step "${correlationId}" already created`);
          step = existing ?? StepSchema.parse(compact({runId:id,stepId:correlationId,stepName:d.stepName,input:d.input,status:'pending',attempt:0,createdAt:now,updatedAt:now,specVersion}));
          if (lazy) { this.insertEvent(id,{eventType:'step_created',correlationId:correlationId!,eventData:{stepName:d.stepName!,input:d.input!},specVersion}); stepCreated = true; }
        } else { if (!existing) throw new WorkflowWorldError(`Step "${correlationId}" not found`); step = existing; }
        if (type !== 'step_created') {
          if (isTerminalStepStatus(step.status)) throw new EntityConflictError(`Cannot modify step in terminal state "${step.status}"`);
          if (terminal && type === 'step_started') throw new RunExpiredError(`Cannot start step on run in terminal state "${current!.status}"`);
          if (type === 'step_started') {
            if (step.retryAfter && step.retryAfter.getTime() > this.now()) throw new TooEarlyError(`Cannot start step "${correlationId}": retryAfter timestamp has not been reached yet`,{retryAfter:Math.ceil((step.retryAfter.getTime()-this.now())/1000)});
            step = {...step,status:'running',attempt:step.attempt+1,startedAt:step.startedAt ?? now,retryAfter:undefined,updatedAt:now};
            if ('eventData' in data && data.eventData && 'input' in data.eventData) { const rest: Record<string, unknown> = { ...data.eventData }; delete rest.input; data = {...data,eventData:rest} as AnyEventRequest; }
          } else if (type === 'step_completed') step = {...step,status:'completed',output:d.result,completedAt:now,updatedAt:now};
          else if (type === 'step_failed') step = {...step,status:'failed',error:d.error,completedAt:now,updatedAt:now};
          else if (type === 'step_retrying') step = {...step,status:'pending',error:d.error,retryAfter:d.retryAfter,updatedAt:now};
        }
        this.saveStep(step);
      }
      if (type === 'hook_created') {
        const d = (data as Extract<AnyEventRequest,{eventType:'hook_created'}>).eventData;
        if (d.tokenRetentionUntil && d.tokenRetentionUntil.getTime() > this.now()+30*86400000) throw new WorkflowWorldError('Hook minimum retention cannot exceed 30 days in the Cloudflare World.',{status:400});
        const existing = this.findHook(d.token,true); let claimedFrom: Hook['claimedFrom'];
        if (existing && existing.runId === id && existing.hookId === correlationId) hook = existing;
        else if (existing) {
          const victim = this.run(existing.runId); const victimRunning = !isTerminalWorkflowRunStatus(victim.status);
          const refused = d.force === true && victimRunning && (victim.specVersion ?? SPEC_VERSION_LEGACY) < SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM;
          if (d.force !== true || refused) { const conflict = { eventType:'hook_conflict' as const, correlationId:correlationId!,eventData:{token:d.token,conflictingRunId:existing.runId,...(refused ? {forceRefusedReason:'victim-spec-version' as const}: {})},specVersion }; return {event:stripEventDataRefs(this.insertEvent(id,conflict),params?.resolveData ?? 'all')}; }
          claimedFrom = {runId:existing.runId,hookId:existing.hookId,...(victimRunning ? {workflowName:victim.workflowName,deploymentId:victim.deploymentId,runSpecVersion:victim.specVersion}: {})};
          if (victimRunning) this.insertEvent(existing.runId,{eventType:'hook_disposed',correlationId:existing.hookId,eventData:{token:d.token,forceClaimedBy:{runId:id,hookId:correlationId!}},specVersion:victim.specVersion ?? specVersion});
          this.sql.exec('INSERT INTO workflow_hook_disposals(run_id,hook_id,token,claimed_run_id,claimed_hook_id) VALUES(?,?,?,?,?)',existing.runId,existing.hookId,d.token,id,correlationId!);
          this.sql.exec('DELETE FROM workflow_hooks WHERE hook_id=?',existing.hookId);
          data = {...data,eventData:{...d,forceClaimedFrom:claimedFrom}} as AnyEventRequest;
        }
        if (!hook) hook = HookSchema.parse(compact({runId:id,hookId:correlationId,token:d.token,metadata:d.metadata,ownerId:'',projectId:'',environment:'',createdAt:now,specVersion,isWebhook:d.isWebhook ?? true,isSystem:d.isSystem ?? false,tokenRetentionUntil:d.tokenRetentionUntil,claimedFrom}));
        this.saveHook(hook);
      }
      if (type === 'hook_disposed' || type === 'hook_received') {
        hook = this.findHook(correlationId!);
        if (!hook) this.forceRefusal(id,correlationId!,type === 'hook_received' ? (data as Extract<AnyEventRequest,{eventType:'hook_received'}>).eventData.token : undefined);
        if (type === 'hook_received') { const token = (data as Extract<AnyEventRequest,{eventType:'hook_received'}>).eventData.token; if (hook!.runId !== id || (token !== undefined && token !== hook!.token)) throw new HookNotFoundError(correlationId!); }
        if (type === 'hook_disposed') this.sql.exec('DELETE FROM workflow_hooks WHERE hook_id=?',correlationId!);
        hook = undefined;
      }
      if (type === 'wait_created' || type === 'wait_completed') {
        const waitId = `${id}-${correlationId}`; const existing = unpack<Wait>(this.rows('SELECT data FROM workflow_waits WHERE wait_id=?',waitId)[0]);
        if (type === 'wait_created') { if (existing) throw new EntityConflictError(`Wait "${correlationId}" already exists`); wait = compact({waitId,runId:id,status:'waiting' as const,resumeAt:(data as Extract<AnyEventRequest,{eventType:'wait_created'}>).eventData.resumeAt,createdAt:now,updatedAt:now,specVersion}); }
        else { if (!existing) throw new WorkflowWorldError(`Wait "${correlationId}" not found`); if (existing.status === 'completed') throw new EntityConflictError(`Wait "${correlationId}" already completed`); wait = {...existing,status:'completed',completedAt:now,updatedAt:now}; }
        this.sql.exec('INSERT INTO workflow_waits(wait_id,run_id,data) VALUES(?,?,?) ON CONFLICT(wait_id) DO UPDATE SET data=excluded.data',waitId,id,encode(wait));
      }
      event = this.insertEvent(id,data,params?.resumeId,digest);
    }
    const result = this.eventResult(id,compact({event,run,step,hook,wait,...(stepCreated ? {stepCreated:true}: {})}) as EventResult,params,request.eventType === 'run_started');
    if (run && isTerminalWorkflowRunStatus(run.status) && run.attributes?.['$retention'] === '0') this.purge(id,now);
    return result;
  }
  private eventResult(id: string, result: EventResult, params?: CreateEventParams, preload = false): EventResult {
    const resolveData = params?.resolveData ?? 'all'; const original = result.event; if (original) result = {...result,event:stripEventDataRefs(original,resolveData)};
    if (typeof params?.sinceCursor === 'string') { const page = this.listEvents({runId:id,pagination:{cursor:params.sinceCursor,limit:100}},false,resolveData); return {...result,events:page.data,cursor:page.cursor,hasMore:page.hasMore}; }
    if (preload && !params?.skipPreload) {
      const events = this.rows('SELECT data FROM workflow_events WHERE run_id=? ORDER BY id',id).map(row=>stripEventDataRefs(EventSchema.parse(unpack<Event>(row)),resolveData));
      return {...result,events,cursor:events.at(-1)?.eventId ?? null,hasMore:false};
    }
    const slot = original ? eventIdToSlot(original.eventId) : null;
    if (params?.eventCount !== undefined && params.eventCount >= 1 && slot !== null && slot > params.eventCount+1) {
      const events = this.rows('SELECT data FROM workflow_events WHERE run_id=? AND id>? AND id<? ORDER BY id',id,slotToEventId(params.eventCount),original!.eventId).map(row => stripEventDataRefs(EventSchema.parse(unpack<Event>(row)),resolveData));
      return {...result,events,cursor:null,hasMore:events.length < slot-params.eventCount-1};
    }
    return result;
  }
  private purge(id: string, at: Date): void {
    const run = this.run(id); this.saveRun({...run,input:undefined,output:undefined,error:undefined,expiredAt:at});
    for (const row of this.rows('SELECT data FROM workflow_steps WHERE run_id=?',id)) { const step = unpack<Step>(row)!; this.saveStep({...step,input:undefined,output:undefined,error:undefined}); }
    for (const row of this.rows('SELECT data FROM workflow_events WHERE run_id=?',id)) {
      const event = unpack<Event>(row)!;
      // Promote pre-upgrade routing evidence before erasing event payloads.
      if (event.eventType === 'hook_disposed' && event.eventData?.forceClaimedBy) {
        const {token,forceClaimedBy} = event.eventData;
        this.sql.exec('INSERT OR IGNORE INTO workflow_hook_disposals(run_id,hook_id,token,claimed_run_id,claimed_hook_id) VALUES(?,?,?,?,?)',id,event.correlationId,token ?? '',forceClaimedBy.runId,forceClaimedBy.hookId);
      }
      this.sql.exec('UPDATE workflow_events SET data=?,resume_payload_digest=NULL WHERE run_id=? AND id=?',encode({...event,eventData:undefined}),id,event.eventId);
    }
    for (const row of this.rows('SELECT data FROM workflow_hooks WHERE run_id=?',id)) { const hook = unpack<Hook>(row)!; this.saveHook({...hook,metadata:undefined,resumeContext:undefined}); }
    this.sql.exec('UPDATE workflow_stream_chunks SET data=? WHERE run_id=?',new Uint8Array(),id);
    this.reconcileTerminalMessages(id);
  }
  private listRuns(params?: Params) {
    const args: unknown[] = []; const where: string[] = [];
    if (params?.pagination?.cursor) { where.push('id<?'); args.push(params.pagination.cursor); }
    if (params?.workflowName) { where.push('name=?'); args.push(params.workflowName); }
    if (params?.status) { const statuses = Array.isArray(params.status) ? params.status : [params.status]; where.push(`status IN (${statuses.map(()=>'?').join(',') || 'NULL'})`); args.push(...statuses); }
    const limit = params?.pagination?.limit ?? 20; const rows = this.rows(`SELECT data FROM workflow_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,...args,limit+1);
    const data = rows.slice(0,limit).map(row=>filterData(WorkflowRunSchema.parse(unpack<WorkflowRun>(row)),params)); return {data,cursor:data.at(-1)?.runId ?? null,hasMore:rows.length>limit};
  }
  private listSteps(params: Params & {runId:string}) {
    const limit = params.pagination?.limit ?? 20; const rows = this.rows(`SELECT data FROM workflow_steps WHERE run_id=? ${params.pagination?.cursor ? 'AND step_id<?' : ''} ORDER BY step_id DESC LIMIT ?`,params.runId,...(params.pagination?.cursor ? [params.pagination.cursor]:[]),limit+1);
    const data = rows.slice(0,limit).map(row=>filterData(StepSchema.parse(unpack<Step>(row)),params)); return {data,cursor:data.at(-1)?.stepId ?? null,hasMore:rows.length>limit};
  }
  private listHooks(params: Params) {
    const desc = params.pagination?.sortOrder === 'desc'; const where: string[] = []; const args: unknown[] = [];
    if (params.runId) {where.push('run_id=?');args.push(params.runId);} if(params.pagination?.cursor){where.push(`hook_id${desc?'<':'>'}?`);args.push(params.pagination.cursor);}
    const limit = params.pagination?.limit ?? 100; const values = this.rows(`SELECT data FROM workflow_hooks ${where.length ? `WHERE ${where.join(' AND ')}`:''} ORDER BY hook_id ${desc?'DESC':'ASC'}`,...args).map(row=>HookSchema.parse(unpack<Hook>(row))).filter(h=>this.hookAvailable(h));
    const data = values.slice(0,limit).map(h=>filterHook(h,params));return {data,cursor:data.at(-1)?.hookId ?? null,hasMore:values.length>limit};
  }
  private writeStream(runId: string,name: string,chunks: (string|Uint8Array)[],eof=false): void { this.atomic(()=>{for(const chunk of chunks)this.sql.exec('INSERT INTO workflow_stream_chunks(id,stream_id,run_id,data,eof,created_at) VALUES(?,?,?,?,?,?)',`chnk_${ulid(this.now())}`,name,runId,bytes(chunk),eof?1:0,this.now());}); }
  private streamRows(name: string, from = 0, limit = 100) { return this.rows('SELECT sequence,data FROM workflow_stream_chunks WHERE stream_id=? AND sequence < COALESCE((SELECT MIN(sequence) FROM workflow_stream_chunks WHERE stream_id=? AND eof=1),9223372036854775807) ORDER BY sequence LIMIT ? OFFSET ?',name,name,limit,from); }
  private streamCount(name: string): number { return Number(this.rows('SELECT COUNT(*) AS count FROM workflow_stream_chunks WHERE stream_id=? AND sequence < COALESCE((SELECT MIN(sequence) FROM workflow_stream_chunks WHERE stream_id=? AND eof=1),9223372036854775807)',name,name)[0]?.count ?? 0); }
  private streamDone(name: string): boolean { return this.rows('SELECT sequence FROM workflow_stream_chunks WHERE stream_id=? AND eof=1 LIMIT 1',name).length>0; }
  private readChunks(name: string, fromIndex=0, limit=100) {
    const count = this.streamCount(name); const start = fromIndex<0 ? Math.max(0,count+fromIndex):fromIndex;
    const chunks = this.streamRows(name,start,limit).map(row=>sqlBytes(row.data));
    return {chunks,nextIndex:start+chunks.length,done:this.streamDone(name)&&start+chunks.length>=count};
  }
  private getChunks(name: string,options?:{cursor?:string;limit?:number}) {
    let from=0;try { if(options?.cursor){const parsed=JSON.parse(atob(options.cursor)) as {i?:number};from=parsed.i ?? 0;} } catch { /* Invalid reference cursors start at the beginning. */ }
    const limit=options?.limit ?? 100;const rows=this.streamRows(name,from,limit+1);const page=rows.slice(0,limit);const hasMore=rows.length>limit;
    return {data:page.map((row,i)=>({index:from+i,data:sqlBytes(row.data)})),cursor:hasMore?btoa(JSON.stringify({i:from+page.length})):null,hasMore,done:this.streamDone(name)};
  }
  private async enqueue(queueName:string,message:unknown,opts?:EnqueueOptions) {
    if(opts?.idempotencyKey){const prior=this.rows('SELECT id FROM workflow_queue_messages WHERE idempotency_key=?',opts.idempotencyKey)[0];if(prior)return {messageId:String(prior.id)};}
    // World-local beta.48 uses the combined flow endpoint for steps and wakes.
    const id=`msg_${ulid(this.now())}`;const path='flow';
    const json = JSON.stringify(message, (_key, value: unknown) => {
      if (value instanceof Uint8Array) {
        let binary = ''; for (const byte of value) binary += String.fromCharCode(byte);
        return {__type:'Uint8Array',data:btoa(binary)};
      }
      return value;
    });
    const deploymentId = this.queueTarget(message as QueueMessage, opts?.deploymentId);
    this.assertDeploymentActive(deploymentId);
    const sandbox = this.successorSandbox(message as QueueMessage);
    const sourceDeploymentId = sandbox?.sourceDeploymentId ?? opts?.sourceDeploymentId;
    if (sourceDeploymentId && sourceDeploymentId !== deploymentId) this.assertDeploymentActive(sourceDeploymentId);
    this.atomic(()=>{
      this.sql.exec('INSERT INTO workflow_queue_messages(id,queue_name,body,path,due_at,idempotency_key,headers,deployment_id,source_deployment_id,lease_until) VALUES(?,?,?,?,?,?,?,?,?,0)',id,queueName,new TextEncoder().encode(json),path,this.now()+Math.max(0,opts?.delaySeconds ?? 0)*1000,opts?.idempotencyKey ?? null,opts?.headers ? encode(opts.headers) : null,deploymentId,sourceDeploymentId ?? null);
      if (sandbox && sourceDeploymentId && sourceDeploymentId !== deploymentId) this.sql.exec('INSERT INTO workflow_sandbox_transfers(message_id,source_deployment_id,deployment_id,session_id) VALUES(?,?,?,?)',id,sourceDeploymentId,deploymentId,sandbox.sessionId);
    });
    await this.reschedule();return {messageId:id};
  }
  private async reschedule():Promise<void>{const row=this.rows('SELECT MIN(due_at) AS due FROM workflow_queue_messages WHERE completed=0')[0];const due=row?.due === null || row?.due === undefined ? null:Number(row.due);await this.scheduleAlarm(this.inFlight.size ? Math.min(due ?? Infinity,this.now()+30000):due);}
  async runAlarm():Promise<void>{
    // Alarms cannot overlap on Cloudflare. Never keep one open on a delivery:
    // it would block every subsequent wake, and has a 15 minute wall-time limit.
    // Renew live deliveries before selecting due work. Their durable leases
    // recover a lost instance; the in-memory set, not elapsed time, owns a live
    // delivery. The 30 second heartbeat also keeps older compatibility dates
    // active, where pending RPCs/waitUntil alone do not prevent idle eviction.
    const leaseUntil = this.now()+60000;
    for(const id of this.inFlight)this.sql.exec('UPDATE workflow_queue_messages SET due_at=?,lease_until=? WHERE id=? AND completed=0',leaseUntil,leaseUntil,id);
    const due=this.rows('SELECT * FROM workflow_queue_messages WHERE completed=0 AND due_at<=? ORDER BY due_at,id LIMIT 50',this.now()).filter(row=>!this.inFlight.has(String(row.id)));
    for(const row of due){
      const id=String(row.id);
      const deploymentId = this.queueTarget(this.queueMessage(sqlBytes(row.body)),row.deployment_id == null ? undefined : String(row.deployment_id));
      this.atomic(()=>{
        this.sql.exec('INSERT INTO workflow_delivery_claims(message_id,attempt,deployment_id) VALUES(?,?,?)',id,row.attempt,deploymentId);
        this.sql.exec('UPDATE workflow_queue_messages SET due_at=?,lease_until=?,attempt=attempt+1,deployment_id=? WHERE id=?',leaseUntil,leaseUntil,deploymentId,id);
      });
      this.inFlight.add(id);
    }
    // Persist recovery before making external effects. A crash here leaves
    // every claimed message eligible again after its lease expires.
    try{await this.reschedule();}catch(error){for(const row of due){this.inFlight.delete(String(row.id));this.deliverySettled(String(row.id),Number(row.attempt));}throw error;}
    for(const row of due){
      const id=String(row.id);const attempt=Number(row.attempt);
      this.waitUntil((async()=>{
        try{
          let dispatched = false;
          let result:{ok:boolean;retryAfterMs?:number;sandboxTransferCompleted?:boolean};try{
            const body = sqlBytes(row.body); const message = this.queueMessage(body);
            const deploymentId = this.queueTarget(message,row.deployment_id == null ? undefined : String(row.deployment_id));
            this.assertDeploymentActive(deploymentId);
            this.sql.exec('UPDATE workflow_queue_messages SET deployment_id=? WHERE id=?',deploymentId,id);
            let transfer = this.rows('SELECT * FROM workflow_sandbox_transfers WHERE message_id=?',id)[0];
            const sandbox = transfer ? undefined : this.successorSandbox(message);
            const sourceDeploymentId = transfer ? String(transfer.source_deployment_id) : sandbox?.sourceDeploymentId ?? (row.source_deployment_id == null ? undefined : String(row.source_deployment_id));
            if (sandbox && sourceDeploymentId && sourceDeploymentId !== deploymentId) {
              this.assertDeploymentActive(sourceDeploymentId);
              this.sql.exec('UPDATE workflow_queue_messages SET source_deployment_id=? WHERE id=?',sourceDeploymentId,id);
              this.sql.exec('INSERT INTO workflow_sandbox_transfers(message_id,source_deployment_id,deployment_id,session_id) VALUES(?,?,?,?)',id,sourceDeploymentId,deploymentId,sandbox.sessionId);
              transfer = this.rows('SELECT * FROM workflow_sandbox_transfers WHERE message_id=?',id)[0];
            }
            const sandboxSessionId = transfer && !Number(transfer.completed) ? String(transfer.session_id) : undefined;
            dispatched = true;
            result=await this.delivery.deliver({queueName:String(row.queue_name),messageId:id,attempt,body,path:row.path as 'flow'|'step',...(row.headers ? {headers:decode(sqlBytes(row.headers)) as Record<string,string>} : {}),deploymentId,...(sourceDeploymentId === undefined ? {} : {sourceDeploymentId}),...(sandboxSessionId === undefined ? {} : {sandboxSessionId})});
            if (sandboxSessionId) {
              if (result.sandboxTransferCompleted) this.sql.exec('UPDATE workflow_sandbox_transfers SET completed=1 WHERE message_id=?',id);
              else result={ok:false,...(result.retryAfterMs === undefined ? {} : {retryAfterMs:result.retryAfterMs})};
            }
          }catch{if(!dispatched)this.deliverySettled(id,attempt);result={ok:false};}
          // Like world-local, deduplicate outstanding deliveries, not future wakes.
          if(result.ok && result.retryAfterMs === undefined)this.sql.exec('UPDATE workflow_queue_messages SET completed=1,idempotency_key=NULL,lease_until=0 WHERE id=?',id);
          else this.sql.exec('UPDATE workflow_queue_messages SET due_at=? WHERE id=?',this.now()+Math.max(1,result.retryAfterMs ?? Math.min(60000,1000*2**Math.min(attempt-1,6))),id);
        }finally{this.inFlight.delete(id);await this.reschedule();}
      })());
    }
  }
  async handleRpc(body:Uint8Array):Promise<Uint8Array>{
    try{const {op,args}=decode(body) as {op:string;args:unknown[]};const result=await this.dispatch(op,args);return encode({ok:true,result});}
    catch(error){const e=error instanceof Error ? error : new Error(String(error));return encode({ok:false,error:{...Object.fromEntries(Object.entries(e)),name:e.name,message:e.message}});}
  }
  async handleControlRpc(body:Uint8Array):Promise<Uint8Array>{
    try {
      const request = decode(body) as {op:string;args:unknown[]};
      if (request.op !== 'deployments.drainState' && request.op !== 'deployments.retire') throw new WorkflowWorldError('Operation is not available through deployment control RPC',{status:403});
      return encode({ok:true,result:await this.dispatch(request.op,request.args)});
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      return encode({ok:false,error:{...Object.fromEntries(Object.entries(e)),name:e.name,message:e.message}});
    }
  }
  private async dispatch(op:string,args:unknown[]):Promise<unknown>{
    switch(op){
      case 'deployments.drainState': {
        const request = args[0] as {deploymentIds:string[]};
        return this.drainState(request.deploymentIds);
      }
      case 'deployments.retire': {
        const request = args[0] as {deploymentIds:string[]};
        const ids = request.deploymentIds;
        if (this.currentDeploymentId && ids.includes(this.currentDeploymentId)) throw new WorkflowWorldError('Cannot retire the current deployment',{status:409});
        const states = this.drainState(ids);
        if (ids.some(id=>!states[id]!.drained)) throw new WorkflowWorldError('Cannot retire a deployment with live runs, queued messages, or unfinished transfers',{status:409});
        if (!this.retireDeployment) throw new WorkflowWorldError('Deployment retirement is unavailable',{status:501});
        // Drain and admission fencing are synchronous in the same DO turn.
        // Keep fences durable even if external deletion must be retried.
        this.atomic(()=>{for (const id of ids) this.sql.exec('INSERT OR IGNORE INTO workflow_retired_deployments(deployment_id) VALUES(?)',id);});
        for (const id of ids) await this.retireDeployment(id);
        return {retired:ids};
      }
      case 'runs.get':return filterData(this.run(args[0] as string),args[1] as Params);
      case 'runs.getMany':return (args[0] as string[]).map(id=>{try{return filterData(this.run(id),args[1] as Params);}catch(e){if(e instanceof WorkflowRunNotFoundError)return null;throw e;}});
      case 'runs.list':return this.listRuns(args[0] as Params);
      case 'runs.experimentalSetAttributes':return this.atomic(()=>({attributes:this.attributes(args[0] as string,args[1] as AttributeChange[],args[2] as {allowReservedAttributes?:boolean}).attributes}));
      case 'steps.get':return filterData(this.step(args[0] as string,args[1] as string),args[2] as Params);
      case 'steps.list':return this.listSteps(args[0] as Params & {runId:string});
      case 'events.create':return this.create(args[0] as string|null,args[1] as AnyEventRequest,args[2] as CreateEventParams);
      case 'events.get':return this.event(args[0] as string,args[1] as string,(args[2] as {resolveData?:EventsResolveData})?.resolveData);
      case 'events.list':return this.listEvents(args[0] as Params & {runId:string},false,(args[0] as {resolveData?:EventsResolveData})?.resolveData);
      case 'events.listByCorrelationId':return this.listEvents(args[0] as Params & {runId:string},true,(args[0] as {resolveData?:EventsResolveData})?.resolveData);
      case 'hooks.get':return this.hook(args[0] as string,false,args[1] as Params);
      case 'hooks.getByToken':return this.hook(args[0] as string,true,args[1] as Params);
      case 'hooks.list':return this.listHooks(args[0] as Params);
      case 'streams.write':return this.writeStream(args[0] as string,args[1] as string,[args[2] as string|Uint8Array]);
      case 'streams.writeMulti':return this.writeStream(args[0] as string,args[1] as string,args[2] as (string|Uint8Array)[]);
      case 'streams.close':return this.writeStream(args[0] as string,args[1] as string,[new Uint8Array()],true);
      case 'streams.list':return this.rows('SELECT DISTINCT stream_id FROM workflow_stream_chunks WHERE run_id=?',args[0]).map(row=>String(row.stream_id));
      case 'streams.readChunks':return this.readChunks(args[0] as string,args[1] as number,args[2] as number);
      case 'streams.getChunks':return this.getChunks(args[1] as string,args[2] as {cursor?:string;limit?:number});
      case 'streams.getInfo':return {tailIndex:this.streamCount(args[1] as string)-1,done:this.streamDone(args[1] as string)};
      case 'queue.enqueue':return this.enqueue(args[0] as string,args[1],args[2] as EnqueueOptions);
      case 'queue.deliverySettled':return this.deliverySettled(args[0] as string,args[1] as number);
      case 'queue.enqueueBatch':return Promise.all((args[1] as {message:unknown;opts?:EnqueueOptions}[]).map(async item=>{try{return await this.enqueue(args[0] as string,item.message,item.opts);}catch(e){return {messageId:null,error:String(e),retryable:true};}}));
      default:throw new WorkflowWorldError(`Unknown Eden World RPC operation: ${op}`,{status:400});
    }
  }
}

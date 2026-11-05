import { describe, it, expect } from 'vitest';
import { encode, decode } from 'cbor-x';
import { slotToEventId } from '@workflow/world';
import { WorldCore } from '../src/core/index.js';
import { NodeSqliteAdapter } from '../src/core/node-sqlite.js';

function setup(arrayBuffers: boolean) {
  const sql = new NodeSqliteAdapter(); let now = Date.now(); const alarms: (number|null)[] = []; const deliveries: {messageId:string;attempt:number}[] = []; let fail = false;
  const storage = {
    exec(query: string,...bindings:unknown[]) {
      const rows = sql.exec(query,...bindings).toArray();
      if(arrayBuffers) for(const row of rows) for(const [key,value] of Object.entries(row)) if(value instanceof Uint8Array) row[key] = value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);
      return {toArray:()=>rows};
    },
    transactionSync: sql.transactionSync.bind(sql),
  };
  const core: WorldCore = new WorldCore({sql:storage,now:()=>now,scheduleAlarm:at=>{alarms.push(at);},delivery:{async deliver(msg){deliveries.push(msg);if(!fail)core.deliverySettled(msg.messageId,msg.attempt);return {ok:!fail};}}}); core.migrate();
  async function rpc(op:string,...args:unknown[]) { const response = decode(await core.handleRpc(encode({op,args}))); if(!response.ok) throw Object.assign(new Error(response.error.message),response.error);return response.result; }
  async function controlRpc(op:string,...args:unknown[]) { const response = decode(await core.handleControlRpc(encode({op,args}))); if(!response.ok) throw Object.assign(new Error(response.error.message),response.error);return response.result; }
  return {sql,core,rpc,controlRpc,alarms,deliveries,now:()=>now,advance(ms:number){now+=ms;},setFailure(value:boolean){fail=value;}};
}
describe.each([false,true])('WorldCore (ArrayBuffer BLOBs: %s)',(arrayBuffers)=>{
  it('allocates dense slots, reports intervening events, and does not burn slots on dedup',async()=>{
    const s=setup(arrayBuffers);try{
      const created=await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}});const id=created.run.runId;
      await s.rpc('events.create',id,{eventType:'step_created',correlationId:'step_a',eventData:{stepName:'a',input:[]}});
      await expect(s.rpc('events.create',id,{eventType:'step_created',correlationId:'step_a',eventData:{stepName:'a',input:[]}})).rejects.toMatchObject({name:'EntityConflictError'});
      const bumped=await s.rpc('events.create',id,{eventType:'step_started',correlationId:'step_a'},{eventCount:1});
      expect(bumped.event.eventId).toBe(slotToEventId(3));expect(bumped.events.map((e:{eventId:string})=>e.eventId)).toEqual([slotToEventId(2)]);expect(bumped.cursor).toBeNull();expect(bumped.hasMore).toBe(false);
      const page=await s.rpc('events.list',{runId:id});expect(page.data.map((e:{eventId:string})=>e.eventId)).toEqual([1,2,3].map(slotToEventId));
    }finally{s.sql.close();}
  });
  it('deduplicates hook resumes after disposal and rejects changed payload',async()=>{
    const s=setup(arrayBuffers);try{
      const created=await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}});const id=created.run.runId;
      await s.rpc('events.create',id,{eventType:'hook_created',correlationId:'hook_a',eventData:{token:'token',metadata:[]}});
      const request={eventType:'hook_received',correlationId:'hook_a',eventData:{token:'token',payload:new Uint8Array([1,2])}};
      const first=await s.rpc('events.create',id,request,{resumeId:'resume_1'});await s.rpc('events.create',id,{eventType:'hook_disposed',correlationId:'hook_a'});
      const retry=await s.rpc('events.create',id,request,{resumeId:'resume_1'});expect(retry.event.eventId).toBe(first.event.eventId);
      await expect(s.rpc('events.create',id,{...request,eventData:{token:'token',payload:new Uint8Array([3])}},{resumeId:'resume_1'})).rejects.toMatchObject({status:422});
    }finally{s.sql.close();}
  });
  it('retries durable queue delivery with stable identity and delayed backoff',async()=>{
    const s=setup(arrayBuffers);try{
      const run=(await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'old',workflowName:'test',input:[]}})).run;
      const first=await s.rpc('queue.enqueue','__wkf_workflow_test',{runId:run.runId},{idempotencyKey:'key',sourceDeploymentId:'new'});const duplicate=await s.rpc('queue.enqueue','__wkf_workflow_test',{runId:run.runId},{idempotencyKey:'key',deploymentId:'wrong'});expect(duplicate).toEqual(first);
      expect(await s.controlRpc('deployments.drainState',{deploymentIds:['old','new']})).toMatchObject({old:{liveRuns:1,pendingMessages:1,drained:false},new:{liveRuns:0,pendingMessages:0,drained:true}});
      s.setFailure(true);await s.core.runAlarm();expect(s.deliveries).toMatchObject([{messageId:first.messageId,attempt:1,deploymentId:'old',sourceDeploymentId:'new'}]);
      await s.core.runAlarm();expect(s.deliveries).toHaveLength(1);s.advance(1000);s.setFailure(false);await s.core.runAlarm();expect(s.deliveries).toMatchObject([{attempt:1},{attempt:2,messageId:first.messageId,deploymentId:'old',sourceDeploymentId:'new'}]);
      expect(s.alarms.at(-1)).toBeNull();await s.core.runAlarm();expect(s.deliveries).toHaveLength(2);
      const wake=await s.rpc('queue.enqueue','__wkf_workflow_test',{runId:run.runId},{idempotencyKey:'key'});
      expect(wake.messageId).not.toBe(first.messageId);await s.core.runAlarm();
      expect(s.deliveries[2]).toMatchObject({messageId:wake.messageId,attempt:1,deploymentId:'old'});
      await s.rpc('events.create',run.runId,{eventType:'run_completed',eventData:{output:[]}});
      expect(await s.controlRpc('deployments.drainState',{deploymentIds:['old']})).toMatchObject({old:{pendingMessages:1,drained:false}});
      s.core.deliverySettled(first.messageId,1);
      expect(await s.controlRpc('deployments.drainState',{deploymentIds:['old']})).toEqual({old:{liveRuns:0,liveSessions:0,pendingMessages:0,unfinishedTransfers:0,drained:true}});
    }finally{s.sql.close();}
  });
  it('bounds streams at the first EOF and closes readers past the tail',async()=>{
    const s=setup(arrayBuffers);try{await s.rpc('streams.writeMulti','run','stream',['a','b']);await s.rpc('streams.close','run','stream');await s.rpc('streams.write','run','stream','c');
      const info=await s.rpc('streams.getInfo','run','stream');expect(info).toEqual({tailIndex:1,done:true});const tail=await s.rpc('streams.readChunks','stream',-1,100);expect(tail.chunks.map((v:Uint8Array)=>new TextDecoder().decode(v))).toEqual(['b']);expect(tail.done).toBe(true);expect(await s.rpc('streams.readChunks','stream',99,100)).toEqual({chunks:[],nextIndex:99,done:true});
    }finally{s.sql.close();}
  });
  it('claims a lazy step exactly once and preserves dense synthetic ordering',async()=>{
    const s=setup(arrayBuffers);try{
      const created=await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}});const id=created.run.runId;
      const request={eventType:'step_started',correlationId:'lazy',eventData:{stepName:'lazy',input:[3]}};
      const first=await s.rpc('events.create',id,request);expect(first.stepCreated).toBe(true);expect(first.step.attempt).toBe(1);
      await expect(s.rpc('events.create',id,request)).rejects.toMatchObject({name:'EntityConflictError'});
      const log=await s.rpc('events.list',{runId:id});expect(log.data.map((e:{eventType:string})=>e.eventType)).toEqual(['run_created','step_created','step_started']);
      expect(log.data[1].eventData.input).toEqual([3]);expect(log.data[2].eventData.input).toBeUndefined();
    }finally{s.sql.close();}
  });
  it('purges zero-retention payloads while preserving stream identity and EOF',async()=>{
    const s=setup(arrayBuffers);try{
      const created=await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:['secret'],attributes:{'$retention':'0'},allowReservedAttributes:true}});const id=created.run.runId;
      await s.rpc('streams.write',id,'retained-stream','secret');await s.rpc('streams.close',id,'retained-stream');
      await s.rpc('events.create',id,{eventType:'run_completed',eventData:{output:'secret'}});
      const run=await s.rpc('runs.get',id);expect(run.expiredAt).toBeInstanceOf(Date);expect(run.input).toBeUndefined();expect(run.output).toBeUndefined();
      expect(await s.rpc('streams.list',id)).toEqual(['retained-stream']);const chunks=await s.rpc('streams.readChunks','retained-stream',0,100);expect(chunks.done).toBe(true);expect(chunks.chunks[0]).toEqual(new Uint8Array());
    }finally{s.sql.close();}
  });
  it('force-claims a live token and redirects an in-flight resume with the same identity',async()=>{
    const s=setup(arrayBuffers);try{
      const create=async()=> (await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}})).run.runId;
      const old=await create();const next=await create();
      await s.rpc('events.create',old,{eventType:'hook_created',correlationId:'old-hook',eventData:{token:'handoff'}});
      const acceptedRequest={eventType:'hook_received',correlationId:'old-hook',eventData:{token:'handoff',payload:[0]}};
      const accepted=await s.rpc('events.create',old,acceptedRequest,{resumeId:'accepted'});
      const claimed=await s.rpc('events.create',next,{eventType:'hook_created',correlationId:'next-hook',eventData:{token:'handoff',force:true}});
      expect(claimed.hook.claimedFrom).toMatchObject({runId:old,hookId:'old-hook',workflowName:'test',deploymentId:'local'});
      expect(claimed.event.eventData.forceClaimedFrom).toEqual(claimed.hook.claimedFrom);
      expect((await s.rpc('hooks.getByToken','handoff')).runId).toBe(next);
      expect((await s.rpc('events.create',old,acceptedRequest,{resumeId:'accepted'})).event.eventId).toBe(accepted.event.eventId);
      await expect(s.rpc('events.create',old,{eventType:'hook_received',correlationId:'old-hook',eventData:{token:'handoff',payload:[1]}},{resumeId:'delivery'})).rejects.toMatchObject({name:'HookForceClaimedError',claimedByRunId:next,claimedByHookId:'next-hook'});
      const request={eventType:'hook_received',correlationId:'next-hook',eventData:{token:'handoff',payload:[1]}};
      const delivered=await s.rpc('events.create',next,request,{resumeId:'delivery'});
      expect((await s.rpc('events.create',next,request,{resumeId:'delivery'})).event.eventId).toBe(delivered.event.eventId);
      const log=await s.rpc('events.list',{runId:old});expect(log.data.at(-1)).toMatchObject({eventType:'hook_disposed',eventData:{forceClaimedBy:{runId:next,hookId:'next-hook'}}});
    }finally{s.sql.close();}
  });
  it.each([false,true])('redirects a taken-over owner after terminal cleanup (zero retention: %s)',async(zeroRetention)=>{
    const s=setup(arrayBuffers);try{
      const create=async()=> (await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[],...(zeroRetention?{attributes:{'$retention':'0'},allowReservedAttributes:true}:{})}})).run.runId;
      const old=await create();const next=await create();const latest=await create();
      await s.rpc('events.create',old,{eventType:'hook_created',correlationId:'old-hook',eventData:{token:'chain'}});
      await s.rpc('events.create',next,{eventType:'hook_created',correlationId:'next-hook',eventData:{token:'chain',force:true}});
      await s.rpc('events.create',old,{eventType:'run_completed',eventData:{output:[]}});
      await s.rpc('events.create',latest,{eventType:'hook_created',correlationId:'latest-hook',eventData:{token:'chain',force:true}});
      await expect(s.rpc('events.create',old,{eventType:'hook_received',correlationId:'old-hook',eventData:{token:'chain',payload:[1]}},{resumeId:'late'})).rejects.toMatchObject({name:'HookForceClaimedError',claimedByRunId:latest,claimedByHookId:'latest-hook'});
    }finally{s.sql.close();}
  });
  it('refuses competing non-forced and stale forced claims without moving the token',async()=>{
    const s=setup(arrayBuffers);try{
      const create=async()=> (await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}})).run.runId;
      const old=await create();const next=await create();const rival=await create();
      const claim={eventType:'hook_created',correlationId:'old-hook',eventData:{token:'race',force:true}};
      await s.rpc('events.create',old,claim);
      expect((await s.rpc('events.create',rival,{eventType:'hook_created',correlationId:'rival-hook',eventData:{token:'race'}})).event.eventType).toBe('hook_conflict');
      await s.rpc('events.create',next,{eventType:'hook_created',correlationId:'next-hook',eventData:{token:'race',force:true}});
      await expect(s.rpc('events.create',old,claim)).rejects.toMatchObject({name:'EntityConflictError'});
      expect((await s.rpc('hooks.getByToken','race')).runId).toBe(next);
    }finally{s.sql.close();}
  });
  it('retains terminal hooks until expiry and redirects a terminal retained token takeover',async()=>{
    const s=setup(arrayBuffers);try{
      const create=async()=> (await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}})).run.runId;
      const old=await create();const next=await create();const expires=new Date(s.now()+10000);
      await s.rpc('events.create',old,{eventType:'hook_created',correlationId:'retained-hook',eventData:{token:'retained',tokenRetentionUntil:expires}});
      await s.rpc('events.create',old,{eventType:'hook_created',correlationId:'expires-hook',eventData:{token:'expires',tokenRetentionUntil:expires}});
      await s.rpc('events.create',old,{eventType:'run_completed',eventData:{output:[]}});
      expect((await s.rpc('hooks.getByToken','retained')).runId).toBe(old);
      await expect(s.rpc('events.create',old,{eventType:'hook_received',correlationId:'retained-hook',eventData:{token:'retained',payload:[]}})).rejects.toMatchObject({name:'RunExpiredError'});
      const claim=await s.rpc('events.create',next,{eventType:'hook_created',correlationId:'next-hook',eventData:{token:'retained',force:true}});
      expect(claim.hook.claimedFrom).toEqual({runId:old,hookId:'retained-hook'});
      await expect(s.rpc('events.create',old,{eventType:'hook_received',correlationId:'retained-hook',eventData:{token:'retained',payload:[]}},{resumeId:'late'})).rejects.toMatchObject({name:'HookForceClaimedError',claimedByRunId:next});
      s.advance(10001);await expect(s.rpc('hooks.getByToken','expires')).rejects.toMatchObject({name:'HookNotFoundError'});
    }finally{s.sql.close();}
  });
  it('refuses forced takeover of a live pre-force-claim reader but allows it once terminal',async()=>{
    const s=setup(arrayBuffers);try{
      const old=(await s.rpc('events.create',null,{eventType:'run_created',specVersion:6,eventData:{deploymentId:'local',workflowName:'test',input:[]}})).run.runId;
      const next=(await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}})).run.runId;
      await s.rpc('events.create',old,{eventType:'hook_created',specVersion:6,correlationId:'old-hook',eventData:{token:'legacy',tokenRetentionUntil:new Date(Date.now()+10000)}});
      const refused=await s.rpc('events.create',next,{eventType:'hook_created',correlationId:'refused-hook',eventData:{token:'legacy',force:true}});
      expect(refused.event).toMatchObject({eventType:'hook_conflict',eventData:{conflictingRunId:old,forceRefusedReason:'victim-spec-version'}});
      expect((await s.rpc('hooks.getByToken','legacy')).runId).toBe(old);
      expect((await s.rpc('events.list',{runId:old})).data).toHaveLength(2);
      await s.rpc('events.create',old,{eventType:'run_completed',specVersion:6,eventData:{output:[]}});
      expect((await s.rpc('events.create',next,{eventType:'hook_created',correlationId:'allowed-hook',eventData:{token:'legacy',force:true}})).hook.runId).toBe(next);
    }finally{s.sql.close();}
  });
  it('rejects a resume addressed to a different run even without resumeId',async()=>{
    const s=setup(arrayBuffers);try{
      const create=async()=> (await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}})).run.runId;
      const owner=await create();const other=await create();
      await s.rpc('events.create',owner,{eventType:'hook_created',correlationId:'owned-hook',eventData:{token:'owned'}});
      await expect(s.rpc('events.create',other,{eventType:'hook_received',correlationId:'owned-hook',eventData:{token:'owned',payload:[]}})).rejects.toMatchObject({name:'HookNotFoundError'});
      await expect(s.rpc('events.create',owner,{eventType:'hook_received',correlationId:'owned-hook',eventData:{token:'wrong',payload:[]}})).rejects.toMatchObject({name:'HookNotFoundError'});
    }finally{s.sql.close();}
  });
  it('does not create spec 9 runs without the in-band fence',async()=>{
    const s=setup(arrayBuffers);try{
      await expect(s.rpc('events.create',null,{eventType:'run_created',specVersion:9,eventData:{deploymentId:'local',workflowName:'test',input:[]}})).rejects.toMatchObject({name:'RunNotSupportedError'});
      expect((await s.rpc('runs.list')).data).toEqual([]);
    }finally{s.sql.close();}
  });
  it('preserves pre-upgrade takeover routing when zero-retention data expires',async()=>{
    const s=setup(arrayBuffers);try{
      const old=(await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[],attributes:{'$retention':'0'},allowReservedAttributes:true}})).run.runId;
      const next=(await s.rpc('events.create',null,{eventType:'run_created',eventData:{deploymentId:'local',workflowName:'test',input:[]}})).run.runId;
      await s.rpc('events.create',old,{eventType:'hook_created',correlationId:'old-hook',eventData:{token:'upgrade'}});
      await s.rpc('events.create',next,{eventType:'hook_created',correlationId:'next-hook',eventData:{token:'upgrade',force:true}});
      // Persisted 0.9.0 storage has the disposal event, but no routing table.
      s.sql.exec('DROP TABLE workflow_hook_disposals');s.core.migrate();
      await s.rpc('events.create',old,{eventType:'run_completed',eventData:{output:[]}});
      await expect(s.rpc('events.create',old,{eventType:'hook_received',correlationId:'old-hook',eventData:{token:'upgrade',payload:[]}},{resumeId:'after-upgrade'})).rejects.toMatchObject({name:'HookForceClaimedError',claimedByRunId:next,claimedByHookId:'next-hook'});
    }finally{s.sql.close();}
  });
});

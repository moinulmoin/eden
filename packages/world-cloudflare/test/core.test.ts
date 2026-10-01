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
  const core = new WorldCore({sql:storage,now:()=>now,scheduleAlarm:at=>{alarms.push(at);},delivery:{async deliver(msg){deliveries.push(msg);return {ok:!fail};}}}); core.migrate();
  async function rpc(op:string,...args:unknown[]) { const response = decode(await core.handleRpc(encode({op,args}))); if(!response.ok) throw Object.assign(new Error(response.error.message),response.error);return response.result; }
  return {sql,core,rpc,alarms,deliveries,advance(ms:number){now+=ms;},setFailure(value:boolean){fail=value;}};
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
      const first=await s.rpc('queue.enqueue','__wkf_workflow_test',{runId:'run'},{idempotencyKey:'key'});const duplicate=await s.rpc('queue.enqueue','__wkf_workflow_test',{runId:'run'},{idempotencyKey:'key'});expect(duplicate).toEqual(first);
      s.setFailure(true);await s.core.runAlarm();expect(s.deliveries).toMatchObject([{messageId:first.messageId,attempt:1}]);
      await s.core.runAlarm();expect(s.deliveries).toHaveLength(1);s.advance(1000);s.setFailure(false);await s.core.runAlarm();expect(s.deliveries).toMatchObject([{attempt:1},{attempt:2,messageId:first.messageId}]);
      expect(s.alarms.at(-1)).toBeNull();await s.core.runAlarm();expect(s.deliveries).toHaveLength(2);
      const wake=await s.rpc('queue.enqueue','__wkf_workflow_test',{runId:'run'},{idempotencyKey:'key'});
      expect(wake.messageId).not.toBe(first.messageId);await s.core.runAlarm();
      expect(s.deliveries[2]).toMatchObject({messageId:wake.messageId,attempt:1});
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
});

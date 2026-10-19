import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { createPrisma } from '../src/db/prisma.ts';
import { dashboardEvents, historyFilters, serviceHistory } from '../src/history/queries.ts';
import { prismaHistoryDatabase, reconcileServiceHistory, recordAvailabilityObservation } from '../src/history/recording.ts';
import { withPostgres } from './postgres.ts';

test('service details retrieve selected events and paginate outages independently', {timeout:120_000}, async t => {
  await withPostgres(async url => {
    await bootstrapDatabase(url);
    const prisma=createPrisma(url);
    const start=new Date(Date.now()-3_600_000);
    const at=(seconds:number)=>new Date(start.getTime()+seconds*1000);
    try {
      const dashboard=await prisma.dashboard.create({data:{name:'Details',createdAt:start,updatedAt:start,historyStartedAt:start}});
      const create=async(name:string,states:string[])=>{
        const service=await prisma.service.create({data:{dashboardId:dashboard.id,name,host:'example.test',http:true,https:true,createdAt:start,updatedAt:start,historyStartedAt:start}});
        const configuration=await prisma.serviceConfiguration.create({data:{serviceId:service.id,revision:1,host:service.host,port:0,http:true,https:true,httpPath:'/health'}});
        const ids=states.map(()=>randomUUID());
        await prisma.availabilityInterval.createMany({data:states.map((state,index)=>({id:ids[index],serviceId:service.id,configurationId:configuration.id,startedAt:at(index),endedAt:at(index+1),lastObservedAt:at(index),state,
          httpState:state==='down'||(state==='degraded'&&index%2)?'down':'up',httpsState:state==='up'||(state==='degraded'&&index%2)?'up':'down',
          httpStatus:state==='down'||(state==='degraded'&&index%2)?503:200,httpsStatus:state==='up'||(state==='degraded'&&index%2)?200:503,httpError:`Diagnostic ${index}`,eventKind:state}))});
        return {...service,ids};
      };
      const continuous=await create('One continuous outage',Array(110).fill('degraded'));
      const filters=historyFilters({from:start.toISOString(),to:at(110).toISOString()},at(110));

      await t.test('a second diagnostic page still includes the one continuous outage',async()=>{
        const first=await serviceHistory(prisma,dashboard.id,continuous.id,filters);
        const second=await serviceHistory(prisma,dashboard.id,continuous.id,{...filters,page:2});
        assert.equal(first.intervals.length,100); assert.equal(second.intervals.length,10);
        assert.deepEqual(second.outages,first.outages);
        assert.deepEqual(second.outage_pagination,{page:1,limit:100,total:1,total_pages:1});
      });

      await t.test('an event outside the latest 100 intervals returns its exact diagnostics',async()=>{
        const detail=await serviceHistory(prisma,dashboard.id,continuous.id,{...filters,eventId:continuous.ids[5],page:2});
        assert.equal(detail.intervals.length,1);
        assert.equal(detail.intervals[0].id,continuous.ids[5]);
        assert.equal(detail.intervals[0].http_error,'Diagnostic 5');
        assert.equal(detail.selected_event?.id,continuous.ids[5]);
        assert.equal(detail.selected_event?.at,at(5).toISOString());
        assert.equal(detail.pagination.total,1); assert.equal(detail.pagination.page,1);
      });

      const flapping=await create('Many outages',Array.from({length:205},(_,i)=>i%2?'down':'up'));
      await t.test('outages have their own bounded pages and total count',async()=>{
        const own={...filters,to:at(205),now:at(205),outagePage:2};
        const detail=await serviceHistory(prisma,dashboard.id,flapping.id,own);
        assert.equal(detail.intervals.length,100); assert.equal(detail.pagination.page,1);
        assert.equal(detail.outages.length,2);
        assert.deepEqual(detail.outage_pagination,{page:2,limit:100,total:102,total_pages:2});
        const observations=await serviceHistory(prisma,dashboard.id,flapping.id,{...own,page:2});
        assert.equal(observations.intervals.length,100);
        assert.deepEqual(observations.outages,detail.outages);
      });

      await t.test('missing, other-service and pruned events never substitute unrelated diagnostics',async()=>{
        for(const eventId of [randomUUID(),flapping.ids[5]]) {
          const detail=await serviceHistory(prisma,dashboard.id,continuous.id,{...filters,eventId});
          assert.equal(detail.selected_event,null); assert.deepEqual(detail.intervals,[]);
        }
        await prisma.service.update({where:{id:continuous.id},data:{availabilityPrunedBefore:at(10)}});
        const detail=await serviceHistory(prisma,dashboard.id,continuous.id,{...filters,eventId:continuous.ids[5]});
        assert.equal(detail.selected_event,null); assert.equal(detail.pagination.total,0);
      });

      await t.test('a projected monitoring-gap link still resolves after the worker materializes it',async()=>{
        const service=await prisma.service.create({data:{dashboardId:dashboard.id,name:'Gap',host:'gap.test',http:true,https:false,createdAt:start,updatedAt:start,historyStartedAt:start}});
        await prisma.$transaction(tx=>recordAvailabilityObservation(prismaHistoryDatabase(tx),service.id,{http:{up:true,status:200,error:null,durationMs:10},https:null},start));
        const own={...filters,to:at(600),now:at(600),serviceIds:[service.id]};
        const projected=(await dashboardEvents(prisma,dashboard.id,own)).events.find(event=>event.kind==='gap')!;
        assert.ok(projected.id.endsWith(':gap'));
        const before=await serviceHistory(prisma,dashboard.id,service.id,{...own,eventId:projected.id});
        assert.equal(before.selected_event?.at,at(180).toISOString());
        await prisma.$transaction(tx=>reconcileServiceHistory(prismaHistoryDatabase(tx),service.id,at(300)));
        const after=await serviceHistory(prisma,dashboard.id,service.id,{...own,eventId:projected.id});
        assert.equal(after.selected_event?.at,before.selected_event?.at);
        assert.equal(after.intervals.length,1); assert.equal(after.intervals[0].state,'unknown');
        assert.ok(!after.selected_event?.id.endsWith(':gap'));
      });
    } finally {await prisma.$disconnect();}
  });
});

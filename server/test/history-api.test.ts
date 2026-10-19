import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { createPrisma } from '../src/db/prisma.ts';
import { createApp } from '../src/app.ts';
import { bootstrapUser } from '../src/auth/accounts.ts';
import { prismaHistoryDatabase, reconcileServiceHistory, recordAvailabilityObservation } from '../src/history/recording.ts';
import { dashboardHistory, dashboardEvents, serviceHistory, historyFilters, statistics } from '../src/history/queries.ts';
import { csvCell } from '../src/history/routes.ts';
import { withPostgres } from './postgres.ts';
import type { SessionDto } from '@stakeout/core';
import type { Prisma, PrismaClient } from '@prisma/client';

async function close(server: Server) {
  server.closeIdleConnections();
  await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
}

test('history input validation and safe spreadsheet CSV values', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(historyFilters({},now).from.toISOString(),'2026-10-18T12:00:00.000Z');
  for (const query of [{from:'invalid'},{from:'2026-10-19T11:00:00'},{page:'0'},{outage_page:'0'},{event_id:'invalid'},{limit:'101'},{state:'fine'},{to:'2026-10-20T00:00:00Z'},{from:['2026-10-18']}]) assert.throws(() => historyFilters(query,now));
  assert.equal(csvCell('=IMPORTXML("url")'),'"\'=IMPORTXML(""url"")"');
  assert.equal(csvCell('line1\nline2'),'"line1\nline2"');
  assert.equal(statistics({up_ms:10,down_ms:10,total_ms:40}).uptime_percent,50);
  assert.equal(statistics({up_ms:10,down_ms:10,total_ms:40}).coverage_percent,50);
});

test('history API reports exact intervals, bounded charts, lifecycle changes and public demand safely', {timeout:180_000}, async () => {
  await withPostgres(async databaseUrl => {
    await bootstrapDatabase(databaseUrl);
    const prisma = createPrisma(databaseUrl);
    const start = new Date(Date.now()-3_600_000);
    const at = (seconds:number) => new Date(start.getTime()+seconds*1000);
    const dashboard = await prisma.dashboard.create({data:{name:'History',createdAt:start,updatedAt:start,historyStartedAt:start}});
    const service = await prisma.service.create({data:{dashboardId:dashboard.id,name:'=Dangerous, "CSV"',host:'example.test',http:true,https:true,createdAt:start,updatedAt:start,historyStartedAt:start}});
    const observe = async (seconds:number,http:boolean,https:boolean) => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Dashboard" WHERE id=${dashboard.id}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM "Service" WHERE id=${service.id}::uuid FOR UPDATE`;
      return recordAvailabilityObservation(prismaHistoryDatabase(tx),service.id,{http:{up:http,status:http?200:503,error:null,durationMs:10},https:{up:https,status:https?200:503,error:null,durationMs:20}},at(seconds));
    });
    try {
      await prisma.$transaction(tx => reconcileServiceHistory(prismaHistoryDatabase(tx),service.id,start));
      await observe(0,true,true);
      await observe(60,true,true);
      await observe(120,true,false);
      await observe(121,false,false);
      await observe(122,true,true);
      const query = historyFilters({from:start.toISOString(),to:at(180).toISOString()},at(180));
      const history = await dashboardHistory(prisma,dashboard.id,query);
      assert.equal(history.pagination.total,1);
      assert.equal(history.summary.up_ms,178_000);
      assert.equal(history.summary.degraded_ms,1_000);
      assert.equal(history.summary.down_ms,1_000);
      assert.equal(history.summary.outage_count,1);
      assert.equal(history.summary.coverage_percent,100);
      assert.ok(history.services[0].timeline.length<=240);
      assert.ok(history.services[0].timeline.some(bucket=>bucket.states.includes('down')),'brief outages remain visible in coarse buckets');
      assert.equal(history.services[0].performance.http.count,5);
      assert.equal(history.services[0].performance.https.average_ms,20);
      assert.equal(history.current_counts?.up,1);
      assert.equal((await dashboardHistory(prisma,dashboard.id,{...query,sort:'response_ms'})).services.length,1);
      const detail = await serviceHistory(prisma,dashboard.id,service.id,query);
      assert.equal(detail.outages.length,1);
      assert.equal(detail.outages[0].from,at(120).toISOString());
      assert.equal(detail.outages[0].to,at(122).toISOString());
      assert.equal(detail.intervals[0].configuration.host,'example.test');
      const partialOutage=await serviceHistory(prisma,dashboard.id,service.id,{...query,from:at(121)});
      assert.equal(partialOutage.outages[0].from,at(120).toISOString(),'an outage keeps its original start when the filter begins during a later bad-protocol interval');
      assert.ok(detail.performance_buckets.length<=240);
      const gap = await dashboardHistory(prisma,dashboard.id,historyFilters({from:start.toISOString(),to:at(600).toISOString()},at(600)));
      assert.equal(gap.services[0].current_state,'unknown');
      assert.equal(gap.summary.unknown_ms,298_000);
      assert.equal(gap.summary.up_ms,300_000);
      const gapEvents = await dashboardEvents(prisma,dashboard.id,historyFilters({from:at(300).toISOString(),to:at(600).toISOString(),state:'unknown'},at(600)));
      assert.equal(gapEvents.events[0].kind,'gap');
      assert.equal(gapEvents.events[0].at,at(302).toISOString());
      await prisma.service.update({where:{id:service.id},data:{availabilityPrunedBefore:at(60)}});
      const pruned=await dashboardHistory(prisma,dashboard.id,query);
      assert.equal(pruned.summary.up_ms,118_000);
      assert.equal(pruned.services[0].timeline[0].state,'not_retained');
      const retainedEvents=await dashboardEvents(prisma,dashboard.id,{...query,from:at(60)});
      assert.ok(retainedEvents.events.every(event=>event.at!==at(60).toISOString()),'retention boundaries do not manufacture transitions');
      await prisma.service.update({where:{id:service.id},data:{availabilityPrunedBefore:null}});
      const beforeMonitoring=await dashboardHistory(prisma,dashboard.id,{...query,from:at(-60)});
      assert.equal(beforeMonitoring.services[0].timeline[0].state,'not_monitored');

      await bootstrapUser(prisma,{bootstrapUsername:'admin',bootstrapPassword:'history-password'});
      const app=createApp({prisma,config:{production:false,corsOrigin:'http://localhost:4200',trustProxy:false}});
      const server=app.listen(0,'127.0.0.1');
      await new Promise<void>(resolve=>server.once('listening',resolve));
      const address=server.address();assert.ok(address&&typeof address!=='string');
      const origin=`http://127.0.0.1:${address.port}`;
      const request=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(`${origin}${path}`,{method,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
      try {
        assert.equal((await request(`/dashboards/${dashboard.id}/screenshot-demand`,'POST',{})).status,200);
        assert.ok((await prisma.dashboard.findUniqueOrThrow({where:{id:dashboard.id}})).screenshotDemandUntil!>new Date());
        assert.equal((await request(`/dashboards/${dashboard.id}/screenshot-demand`,'POST',{},{Origin:'https://hostile.test'})).status,403);
        assert.equal((await request(`/dashboards/${dashboard.id}`,'PATCH',{dashboard:{monitoring_enabled:false}})).status,401);
        const login=await request('/auth/login','POST',{username:'admin',password:'history-password'});
        const cookie=login.headers.get('set-cookie')!.split(';')[0];
        const csrf=((await login.json())as SessionDto).csrfToken;
        const auth={Cookie:cookie,'X-CSRF-Token':csrf};
        const lastCheck=new Date();
        await prisma.service.update({where:{id:service.id},data:{checkedAt:lastCheck}});
        await prisma.serviceCheckJob.create({data:{serviceId:service.id,availableAt:new Date(Date.now()+60_000)}});
        assert.equal((await request(`/dashboards/${dashboard.id}`,'PATCH',{dashboard:{check_interval_seconds:300}},auth)).status,200);
        const requested=await prisma.service.findUniqueOrThrow({where:{id:service.id}});
        assert.equal(requested.checkedAt?.getTime(),lastCheck.getTime(),'requesting a check preserves the last observation');
        assert.ok(requested.availabilityCheckRequestedAt);
        assert.ok((await prisma.serviceCheckJob.findFirstOrThrow({where:{serviceId:service.id,kind:'availability'}})).availableAt<=new Date());
        const before=await prisma.service.findUniqueOrThrow({where:{id:service.id}});
        assert.equal((await request(`/dashboards/${dashboard.id}/services/${service.id}`,'PATCH',{service:{name:'Renamed'}},auth)).status,200);
        assert.equal((await prisma.service.findUniqueOrThrow({where:{id:service.id}})).configRevision,before.configRevision);
        assert.equal((await request(`/dashboards/${dashboard.id}/services/${service.id}`,'PATCH',{service:{host:'new.example.test'}},auth)).status,200);
        assert.equal((await prisma.service.findUniqueOrThrow({where:{id:service.id}})).configRevision,before.configRevision+1);
        assert.equal(await prisma.serviceConfiguration.count({where:{serviceId:service.id}}),2);
        const paused=await request(`/dashboards/${dashboard.id}`,'PATCH',{dashboard:{monitoring_enabled:false,hourly_retention_days:null,daily_retention_days:30}},auth);
        assert.equal(paused.status,200);
        assert.equal(((await paused.json())as Record<string,unknown>).hourly_retention_days,null);
        const current=await prisma.availabilityInterval.findFirstOrThrow({where:{serviceId:service.id,endedAt:null}});
        assert.equal(current.state,'paused');
        assert.equal((await request(`/dashboards/${dashboard.id}`,'PATCH',{dashboard:{hourly_retention_days:0}},auth)).status,422);
        const csv=await request(`/dashboards/${dashboard.id}/history/export.csv?from=${encodeURIComponent(query.from.toISOString())}&to=${encodeURIComponent(query.to.toISOString())}`,'GET',undefined,{Accept:'text/csv'});
        assert.equal(csv.status,200);assert.match(csv.headers.get('content-type')??'',/text\/csv/);assert.match(await csv.text(),/Uptime/);
        assert.equal((await request(`/dashboards/${dashboard.id}/events?limit=101`)).status,400);
        assert.equal((await request(`/dashboards/${dashboard.id}/services/${dashboard.id}/history`)).status,404);
        assert.equal((await request(`/dashboards/${dashboard.id}`,'DELETE',undefined,auth)).status,200);
        assert.equal(await prisma.availabilityInterval.count({where:{serviceId:service.id}}),0);
        assert.equal(await prisma.performanceAggregate.count({where:{serviceId:service.id}}),0);
      } finally {await close(server);}
    } finally {await prisma.$disconnect();}
  });
});

test('1,000-service history summary covers all rows while timeline and paging stay bounded', {timeout:180_000},async()=>{
  await withPostgres(async databaseUrl=>{
    await bootstrapDatabase(databaseUrl);
    const prisma=createPrisma(databaseUrl);
    const start=new Date(Date.now()-3_600_000),end=new Date(start.getTime()+60_000);
    try {
      const dashboard=await prisma.dashboard.create({data:{name:'Large',createdAt:start,updatedAt:start,historyStartedAt:start}});
      await prisma.service.createMany({data:Array.from({length:1000},(_,i)=>({dashboardId:dashboard.id,name:`Service ${String(i).padStart(4,'0')}`,host:'example.test',createdAt:start,updatedAt:start,historyStartedAt:start}))});
      await prisma.$executeRaw`INSERT INTO "ServiceConfiguration" ("serviceId",revision,host,port,http,https,"httpPath") SELECT id,1,host,port,true,false,'' FROM "Service" WHERE "dashboardId"=${dashboard.id}::uuid`;
      await prisma.$executeRaw`INSERT INTO "AvailabilityInterval" ("serviceId","configurationId","startedAt","lastObservedAt",state,"httpState","eventKind","checkIntervalSeconds") SELECT s.id,c.id,${start},${start},'up','up','recovery',60 FROM "Service" s JOIN "ServiceConfiguration" c ON c."serviceId"=s.id WHERE s."dashboardId"=${dashboard.id}::uuid`;
      const filters=historyFilters({from:start.toISOString(),to:end.toISOString()},end);
      const page=await dashboardHistory(prisma,dashboard.id,filters);
      assert.equal(page.pagination.total,1000);assert.equal(page.services.length,100);assert.equal(page.summary.up_ms,60_000_000);
      assert.ok(page.services.every(row=>row.timeline.length<=240));
      const last=await dashboardHistory(prisma,dashboard.id,{...filters,page:10});assert.equal(last.services.length,100);assert.notEqual(last.services[0].service_id,page.services[0].service_id);
      const events=await dashboardEvents(prisma,dashboard.id,filters);assert.equal(events.pagination.total,1000);assert.equal(events.events.length,100);
      assert.equal(await prisma.availabilityInterval.count(),1000);
      const selected=page.services[0].service_id;
      const chartFrom=new Date(start.getTime()-500*3_600_000+30*60_000);
      await prisma.dashboard.update({where:{id:dashboard.id},data:{hourlyRetentionDays:null,historyStartedAt:new Date(chartFrom.getTime()-3_600_000)}});
      await prisma.$executeRaw`INSERT INTO "PerformanceAggregate" ("serviceId",resolution,"bucketStart","httpCount","httpResponseCount","httpDurationSum","httpDurationMin","httpDurationMax") SELECT ${selected}::uuid,'hour',${start}::timestamptz-n*interval '1 hour',1,1,10,10,10 FROM generate_series(0,500) n`;
      const chart=await serviceHistory(prisma,dashboard.id,selected,{...filters,from:chartFrom});
      assert.ok(chart.performance_buckets.length<=240);
    } finally {await prisma.$disconnect();}
  });
});

test('performance uses actual retained hourly/daily evidence after retention policy changes', {timeout:180_000}, async()=>{
  await withPostgres(async databaseUrl=>{
    await bootstrapDatabase(databaseUrl);
    const prisma=createPrisma(databaseUrl);
    const start=new Date('2026-01-01T00:00:00Z'),to=new Date('2026-01-05T00:00:00Z');
    try {
      const dashboard=await prisma.dashboard.create({data:{name:'Retained performance',createdAt:start,updatedAt:start,historyStartedAt:start,hourlyRetentionDays:1}});
      const service=await prisma.service.create({data:{dashboardId:dashboard.id,name:'Site',host:'example.test',createdAt:start,updatedAt:start,historyStartedAt:start}});
      const bucket=(day:number,hour=0)=>new Date(start.getTime()+(day*24+hour)*3_600_000);
      const data=(resolution:string,day:number,hour:number,count:number,httpsCount=count)=>({serviceId:service.id,resolution,bucketStart:bucket(day,hour),httpCount:count,httpResponseCount:count,httpDurationSum:count*10,httpDurationMin:10,httpDurationMax:10,httpsCount,httpsResponseCount:httpsCount,httpsDurationSum:httpsCount*20,httpsDurationMin:20,httpsDurationMax:20});
      await prisma.performanceAggregate.createMany({data:[
        // All hourly evidence for day zero has already been pruned.
        data('day',0,0,24),
        // Day one retains just the final hour; daily evidence is more complete.
        data('day',1,0,24),data('hour',1,23,1),
        // Daily retention was shorter: keep partial hours when its daily row is absent.
        data('hour',2,23,1),
        // A sparse monitoring day still has complete hourly evidence; prefer its detail.
        data('day',3,0,2),data('hour',3,0,1),data('hour',3,1,1),
      ]});
      const filters=historyFilters({from:start.toISOString(),to:to.toISOString()},to);
      for (const retention of [1,30,null]) {
        await prisma.dashboard.update({where:{id:dashboard.id},data:{hourlyRetentionDays:retention}});
        const summary=await dashboardHistory(prisma,dashboard.id,{...filters,sort:'response_ms'});
        assert.equal(summary.services[0].performance.http.count,51,`retention ${retention} preserves daily evidence without duplicates`);
        const detail=await serviceHistory(prisma,dashboard.id,service.id,filters);
        assert.equal(detail.performance_resolution,'mixed');
        assert.equal(detail.performance_buckets.reduce((sum,row)=>sum+row.http.count,0),51);
        assert.ok(detail.performance_buckets.some(row=>row.from===bucket(2,23).toISOString()),'retained hours remain visible when daily data is absent');
        assert.ok(detail.performance_buckets.some(row=>row.from===bucket(3,1).toISOString()),'sparse but complete hourly data keeps its detail');
      }
      const partial=await dashboardHistory(prisma,dashboard.id,{...filters,from:bucket(3,1),to:bucket(3,2)});
      assert.equal(partial.services[0].performance.http.count,1,'whole-day completeness is checked before filtering the requested hour');
      // Completeness is evaluated independently for HTTP and HTTPS.
      await prisma.performanceAggregate.update({where:{serviceId_resolution_bucketStart:{serviceId:service.id,resolution:'day',bucketStart:bucket(3)}},data:{httpsCount:3,httpsResponseCount:3,httpsDurationSum:60}});
      const incompleteProtocol=await dashboardHistory(prisma,dashboard.id,filters);
      assert.equal(incompleteProtocol.services[0].performance.https.count,52);
    } finally {await prisma.$disconnect();}
  });
});

test('CSV state-filter pagination retains one snapshot while monitoring changes between pages', {timeout:180_000},async()=>{
  await withPostgres(async databaseUrl=>{
    await bootstrapDatabase(databaseUrl);
    const prisma=createPrisma(databaseUrl);
    const start=new Date(Date.now()-60_000),observed=new Date();
    let server:Server|undefined;
    try {
      const dashboard=await prisma.dashboard.create({data:{name:'Snapshot export',createdAt:start,updatedAt:start,historyStartedAt:start}});
      await prisma.service.createMany({data:Array.from({length:101},(_,i)=>({dashboardId:dashboard.id,name:`Service ${String(i).padStart(3,'0')}`,host:'example.test',createdAt:start,updatedAt:start,historyStartedAt:start}))});
      await prisma.$executeRaw`INSERT INTO "ServiceConfiguration" ("serviceId",revision,host,port,http,https,"httpPath") SELECT id,1,host,port,true,false,'' FROM "Service" WHERE "dashboardId"=${dashboard.id}::uuid`;
      await prisma.$executeRaw`INSERT INTO "AvailabilityInterval" ("serviceId","configurationId","startedAt","lastObservedAt",state,"httpState","eventKind","checkIntervalSeconds") SELECT s.id,c.id,${start},${observed},'up','up','recovery',60 FROM "Service" s JOIN "ServiceConfiguration" c ON c."serviceId"=s.id WHERE s."dashboardId"=${dashboard.id}::uuid`;
      const first=await prisma.service.findFirstOrThrow({where:{dashboardId:dashboard.id},orderBy:{name:'asc'}});
      const last=await prisma.service.findFirstOrThrow({where:{dashboardId:dashboard.id},orderBy:{name:'desc'}});
      let changed=false;
      const watched=new Proxy(prisma,{
        get(target,property,receiver){
          if(property!=='$transaction')return Reflect.get(target,property,receiver);
          return (callback:(tx:Prisma.TransactionClient)=>Promise<unknown>,options:{isolationLevel?:Prisma.TransactionIsolationLevel;timeout?:number;maxWait?:number})=>target.$transaction(async transaction=>{
            const intercepted=new Proxy(transaction,{
              get(client,key,txReceiver){
                if(key!=='$queryRaw')return Reflect.get(client,key,txReceiver);
                return async(query:Prisma.Sql)=>{
                  const result=await client.$queryRaw(query);
                  if(!changed&&query.sql.includes('SELECT * FROM stats')){
                    changed=true;
                    // A separate connection commits the ordinary monitoring
                    // transition after page one is read, before page two.
                    await prisma.availabilityInterval.updateMany({where:{serviceId:first.id,endedAt:null},data:{state:'down',httpState:'down'}});
                  }
                  return result;
                };
              },
            });
            return callback(intercepted);
          },options);
        },
      }) as PrismaClient;
      server=createApp({prisma:watched,config:{production:false,corsOrigin:'http://localhost:4200',trustProxy:false}}).listen(0,'127.0.0.1');
      await new Promise<void>(resolve=>server!.once('listening',resolve));
      const address=server.address();assert.ok(address&&typeof address!=='string');
      const response=await fetch(`http://127.0.0.1:${address.port}/dashboards/${dashboard.id}/history/export.csv?state=up`,{headers:{Accept:'text/csv'}});
      assert.equal(response.status,200);
      const csv=await response.text();
      assert.equal(changed,true,'the inter-page monitoring transition occurred');
      assert.equal(await prisma.availabilityInterval.count({where:{state:'up'}}),100);
      assert.equal(csv.trim().split('\r\n').length,102,'header plus all 101 matching rows from the original snapshot');
      assert.equal(csv.split(last.id).length-1,1,'the final service is included exactly once');
      assert.equal(csv.split(first.id).length-1,1,'the transitioned service keeps its snapshot membership');
    } finally {if(server)await close(server);await prisma.$disconnect();}
  });
});

test('an outage continuing beyond a historical window remains ongoing at the selected end', {timeout:180_000},async()=>{
  await withPostgres(async databaseUrl=>{
    await bootstrapDatabase(databaseUrl);
    const prisma=createPrisma(databaseUrl);
    const start=new Date('2026-10-01T00:00:00Z'),selectedEnd=new Date('2026-10-02T00:00:00Z'),recovered=new Date('2026-10-03T00:00:00Z');
    try {
      const dashboard=await prisma.dashboard.create({data:{name:'Historical outage',createdAt:start,updatedAt:start,historyStartedAt:start}});
      const service=await prisma.service.create({data:{dashboardId:dashboard.id,name:'Site',host:'example.test',createdAt:start,updatedAt:start,historyStartedAt:start}});
      const configuration=await prisma.serviceConfiguration.create({data:{serviceId:service.id,revision:1,createdAt:start,host:service.host,port:0,http:true,https:false,httpPath:''}});
      await prisma.availabilityInterval.createMany({data:[
        {serviceId:service.id,configurationId:configuration.id,startedAt:start,endedAt:recovered,lastObservedAt:new Date(recovered.getTime()-60_000),state:'down',httpState:'down',eventKind:'down'},
        {serviceId:service.id,configurationId:configuration.id,startedAt:recovered,lastObservedAt:new Date(),state:'up',httpState:'up',eventKind:'recovery'},
      ]});
      const detail=await serviceHistory(prisma,dashboard.id,service.id,historyFilters({from:start.toISOString(),to:selectedEnd.toISOString()}));
      assert.equal(detail.outages.length,1);
      assert.equal(detail.outages[0].to,selectedEnd.toISOString());
      assert.equal(detail.outages[0].ongoing,true,'a later recovery must not look like recovery at the historical window boundary');
      assert.equal(detail.outages[0].interrupted_by,null);
      const completed=await serviceHistory(prisma,dashboard.id,service.id,historyFilters({from:start.toISOString(),to:new Date(recovered.getTime()+60_000).toISOString()}));
      assert.equal(completed.outages[0].to,recovered.toISOString());
      assert.equal(completed.outages[0].ongoing,false);
    } finally {await prisma.$disconnect();}
  });
});

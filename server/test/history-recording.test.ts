import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { withPostgres } from './postgres.ts';
import { pruneHistory, reconcileServiceHistory, recordAvailabilityObservation, type AvailabilityObservation } from '../src/history/recording.ts';

const good = { up: true,status: 200,error: null,durationMs: 20 };
const bad = { up: false,status: 503,error: 'HTTP 503',durationMs: 50 };
const observation = (http = good, https: typeof good | null = null): AvailabilityObservation => ({ http,https });

test('compact availability recording and configurable pruning', { timeout: 120_000 }, async t => {
  await withPostgres(async url => {
    await bootstrapDatabase(url);
    const pool = new Pool({ connectionString: url,options: '-c timezone=UTC' });
    const start = new Date('2026-10-01T00:00:00Z');
    let dashboardId: string;
    let serviceId: string;
    const reset = async (https = false) => {
      await pool.query('DELETE FROM "Service"');
      await pool.query('DELETE FROM "Dashboard"');
      dashboardId = (await pool.query(`INSERT INTO "Dashboard" (name,"createdAt","updatedAt","historyStartedAt")
        VALUES ('History',now(),now(),$1) RETURNING id`, [start])).rows[0].id;
      serviceId = (await pool.query(`INSERT INTO "Service" ("dashboardId",name,host,http,https,"createdAt","updatedAt","historyStartedAt")
        VALUES ($1,'Example','example.test',true,$2,now(),now(),$3) RETURNING id`, [dashboardId,https,start])).rows[0].id;
    };
    const transaction = async (action: (client: PoolClient) => Promise<void>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM "Dashboard" WHERE id=$1 FOR UPDATE', [dashboardId]);
        await client.query('SELECT id FROM "Service" WHERE id=$1 FOR UPDATE', [serviceId]);
        await action(client);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    };
    const record = async (offset: number, value = observation()) => transaction(async client => {
      await recordAvailabilityObservation(client,serviceId,value,new Date(start.getTime()+offset));
    });
    const intervals = async () => (await pool.query(`SELECT * FROM "AvailabilityInterval" WHERE "serviceId"=$1 ORDER BY "startedAt",id`, [serviceId])).rows;
    try {
      await t.test('unchanged checks update one interval and aggregate counters without sample rows', async () => {
        await reset();
        for (let i=0;i<120;i++) await record(i*1000);
        const rows = await intervals();
        assert.equal(rows.length,2,'initial unknown and one continuing up interval');
        assert.equal(rows.filter(row => row.endedAt === null).length,1);
        assert.equal(rows.find(row => row.state==='up').lastObservedAt.toISOString(),'2026-10-01T00:01:59.000Z');
        const stats = (await pool.query('SELECT * FROM "PerformanceAggregate" WHERE "serviceId"=$1', [serviceId])).rows;
        assert.equal(stats.length,2,'one hourly and one daily row');
        assert.ok(stats.every(row => row.httpCount===120 && row.httpDurationSum===2400 && row.httpDurationMin===20));
        assert.equal((await pool.query('SELECT count(*)::integer AS n FROM "ServiceConfiguration"')).rows[0].n,1);
        await record(119000);
        assert.equal((await pool.query(`SELECT "httpCount" FROM "PerformanceAggregate" WHERE resolution='hour'`)).rows[0].httpCount,120);
      });

      await t.test('protocol changes split intervals even when aggregate state remains degraded', async () => {
        await reset(true);
        await record(0,observation(good,bad));
        await record(60_000,observation(bad,good));
        await record(120_000,observation(bad,bad));
        await record(180_000,observation(good,good));
        const rows = (await intervals()).filter(row => row.state!=='unknown');
        assert.deepEqual(rows.map(row=>row.state),['degraded','degraded','down','up']);
        assert.deepEqual(rows.map(row=>row.httpState),['up','down','down','up']);
        assert.equal(rows[2].httpStatus,503);
        assert.equal(rows[2].httpError,'HTTP 503');
        assert.equal(rows[1].endedAt.getTime()-rows[1].startedAt.getTime(),60_000);
      });

      await t.test('network errors carry no response time; changed diagnostics do not split an outage', async () => {
        await reset();
        await record(0,{ http: { up:false,status:null,error:'DNS lookup failed',durationMs:null },https:null });
        await record(60_000,{ http: { up:false,status:null,error:'TLS handshake failed',durationMs:null },https:null });
        const down = (await intervals()).filter(row=>row.state==='down');
        assert.equal(down.length,1);
        assert.equal(down[0].httpError,'TLS handshake failed');
        const stats=(await pool.query(`SELECT * FROM "PerformanceAggregate" WHERE resolution='hour'`)).rows[0];
        assert.equal(stats.httpCount,2);
        assert.equal(stats.httpFailures,2);
        assert.equal(stats.httpResponseCount,0);
        assert.equal(stats.httpDurationMin,null);
      });

      await t.test('restart materializes an unknown gap at the old observation deadline', async () => {
        await reset();
        await record(0);
        await record(600_000,observation(bad));
        const rows = (await intervals()).filter(row=>row.startedAt.getTime()>start.getTime() || row.state==='up');
        assert.deepEqual(rows.map(row=>row.state),['up','unknown','down']);
        assert.equal(rows[0].endedAt.getTime()-start.getTime(),180_000);
        assert.equal(rows[1].startedAt.getTime()-start.getTime(),180_000);
        assert.equal(rows[1].endedAt.getTime()-start.getTime(),600_000);
      });

      await t.test('pausing and resuming produce no artificial availability', async () => {
        await reset();
        await record(0);
        await transaction(async client => {
          await client.query('UPDATE "Dashboard" SET "monitoringEnabled"=false WHERE id=$1', [dashboardId]);
          await reconcileServiceHistory(client,serviceId,new Date(start.getTime()+60_000));
          await recordAvailabilityObservation(client,serviceId,observation(bad),new Date(start.getTime()+120_000));
          await client.query('UPDATE "Dashboard" SET "monitoringEnabled"=true WHERE id=$1', [dashboardId]);
          await reconcileServiceHistory(client,serviceId,new Date(start.getTime()+240_000));
        });
        await record(300_000);
        const rows=(await intervals()).filter(row=>row.startedAt.getTime()>start.getTime() || row.state==='up');
        assert.deepEqual(rows.map(row=>row.state),['up','paused','unknown','up']);
        assert.equal(rows[1].endedAt.getTime()-rows[1].startedAt.getTime(),180_000);
        assert.equal((await pool.query(`SELECT "httpCount" FROM "PerformanceAggregate" WHERE resolution='hour'`)).rows[0].httpCount,2);
      });

      await t.test('observations older than a materialized gap cannot rewrite its boundary or counters', async () => {
        await reset();
        await record(0);
        await transaction(async client => {
          await reconcileServiceHistory(client,serviceId,new Date(start.getTime()+200_000));
        });
        await record(179_000,observation(bad));
        const open=(await intervals()).find(row=>row.endedAt===null);
        assert.equal(open.state,'unknown');
        assert.equal(open.startedAt.getTime()-start.getTime(),180_000);
        assert.equal((await pool.query(`SELECT "httpCount" FROM "PerformanceAggregate" WHERE resolution='hour'`)).rows[0].httpCount,1);
      });

      await t.test('target revisions preserve old configuration and interrupt old state', async () => {
        await reset();
        await record(0,observation(bad));
        await transaction(async client => {
          await client.query(`UPDATE "Service" SET host='replacement.test',"configRevision"="configRevision"+1 WHERE id=$1`, [serviceId]);
          await reconcileServiceHistory(client,serviceId,new Date(start.getTime()+60_000));
        });
        await record(120_000);
        const configs=(await pool.query('SELECT host,revision FROM "ServiceConfiguration" ORDER BY revision')).rows;
        assert.deepEqual(configs,[{host:'example.test',revision:1},{host:'replacement.test',revision:2}]);
        const rows=await intervals();
        assert.equal(rows.find(row=>row.eventKind==='target_changed').reason,'awaiting_check');
        assert.notEqual(rows.find(row=>row.state==='down').configurationId,rows.find(row=>row.state==='up').configurationId);
      });

      await t.test('paused unconfigured services remain one stable interval under repeated maintenance', async () => {
        await reset();
        await pool.query('UPDATE "Dashboard" SET "monitoringEnabled"=false WHERE id=$1',[dashboardId]);
        await pool.query('UPDATE "Service" SET http=false,https=false WHERE id=$1',[serviceId]);
        for(let n=0;n<5;n++) await transaction(async client => {
          await reconcileServiceHistory(client,serviceId,new Date(start.getTime()+n*60_000));
        });
        const rows=await intervals();
        assert.equal(rows.length,1);
        assert.equal(rows[0].state,'paused');
      });

      await t.test('transaction rollback restores intervals and all counters together', async () => {
        await reset();
        await record(0);
        await assert.rejects(transaction(async client => {
          await recordAvailabilityObservation(client,serviceId,observation(bad),new Date(start.getTime()+60_000));
          throw new Error('simulated lost completion');
        }),/simulated/);
        assert.equal((await intervals()).filter(row=>row.state==='down').length,0);
        assert.equal((await pool.query(`SELECT "httpCount" FROM "PerformanceAggregate" WHERE resolution='hour'`)).rows[0].httpCount,1);
      });

      await t.test('pruning is bounded and preserves open and crossing intervals', async () => {
        await reset();
        const now=new Date();
        const days=(n:number)=>new Date(now.getTime()-n*86_400_000);
        await pool.query(`UPDATE "Dashboard" SET "availabilityRetentionDays"=7,"hourlyRetentionDays"=2,"dailyRetentionDays"=NULL WHERE id=$1`, [dashboardId]);
        await pool.query('UPDATE "Dashboard" SET "historyStartedAt"=$2 WHERE id=$1',[dashboardId,days(30)]);
        await pool.query('UPDATE "Service" SET "historyStartedAt"=$2 WHERE id=$1',[serviceId,days(30)]);
        // Keep observations close enough within each interval to avoid a monitoring gap.
        await pool.query('UPDATE "Dashboard" SET "checkIntervalSeconds"=864000 WHERE id=$1', [dashboardId]);
        await transaction(async client => {
          await recordAvailabilityObservation(client,serviceId,observation(),days(20));
          await recordAvailabilityObservation(client,serviceId,observation(bad),days(10));
          await recordAvailabilityObservation(client,serviceId,observation(),days(3));
        });
        for(let i=0;i<8;i++) await pruneHistory(pool,1);
        const rows=await intervals();
        assert.equal(rows.filter(row=>row.endedAt && row.endedAt<days(7)).length,0);
        assert.ok(rows.some(row=>row.state==='down' && row.startedAt<days(7) && row.endedAt>days(7)));
        assert.equal(rows.filter(row=>row.endedAt===null).length,1);
        assert.equal((await pool.query(`SELECT count(*)::integer n FROM "PerformanceAggregate" WHERE resolution='hour'`)).rows[0].n,0);
        assert.equal((await pool.query(`SELECT count(*)::integer n FROM "PerformanceAggregate" WHERE resolution='day'`)).rows[0].n,3);
        const cutoff=(await pool.query('SELECT "availabilityPrunedBefore" FROM "Service" WHERE id=$1',[serviceId])).rows[0].availabilityPrunedBefore;
        await pool.query('UPDATE "Dashboard" SET "availabilityRetentionDays"=NULL WHERE id=$1',[dashboardId]);
        await pruneHistory(pool,1);
        assert.equal((await pool.query('SELECT "availabilityPrunedBefore" FROM "Service" WHERE id=$1',[serviceId])).rows[0].availabilityPrunedBefore.getTime(),cutoff.getTime());
      });

      await t.test('service deletion cascades all history and snapshots', async () => {
        await reset();
        await record(0);
        await pool.query('DELETE FROM "Service" WHERE id=$1',[serviceId]);
        for(const table of ['AvailabilityInterval','ServiceConfiguration','PerformanceAggregate']) {
          assert.equal((await pool.query(`SELECT count(*)::integer n FROM "${table}"`)).rows[0].n,0);
        }
      });

      await t.test('small pruning batches advance fairly across all services', async () => {
        await reset();
        await pool.query('UPDATE "Dashboard" SET "availabilityRetentionDays"=1 WHERE id=$1',[dashboardId]);
        await pool.query(`INSERT INTO "Service" ("dashboardId",name,host,"createdAt","updatedAt")
          SELECT $1,'Extra '||n,'example.test',now(),now() FROM generate_series(1,2) n`,[dashboardId]);
        await pool.query(`INSERT INTO "ServiceConfiguration" ("serviceId",revision,host,port,http,https,"httpPath")
          SELECT id,1,host,port,true,false,'' FROM "Service" WHERE "dashboardId"=$1`,[dashboardId]);
        await pool.query(`INSERT INTO "AvailabilityInterval" ("serviceId","configurationId","startedAt","endedAt",state)
          SELECT "serviceId",id,now()-interval '5 days',now()-interval '3 days','up' FROM "ServiceConfiguration"`);
        for(let n=0;n<6;n++) await pruneHistory(pool,1);
        assert.equal((await pool.query('SELECT count(*)::integer n FROM "Service" WHERE "availabilityPrunedBefore" IS NOT NULL')).rows[0].n,3);
        assert.equal((await pool.query('SELECT count(*)::integer n FROM "AvailabilityInterval"')).rows[0].n,0);
      });
    } finally { await pool.end(); }
  });
});

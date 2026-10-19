// Author: Preston Lee

import { readConfig } from './config.ts';
import { assertDatabaseReady } from './bootstrap.ts';
import { configureJobDatabase, closeJobDatabase, enqueueStaleServiceChecks, jobDatabase } from './jobs/queue.ts';
import { fetchScreenshot, SCREENSHOT_TIMEOUT_MS } from './jobs/checkService.ts';

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (!(command === 'check' && ['1', '5'].includes(argument ?? '') || command === 'verify' && ['chrome', 'queue'].includes(argument ?? ''))) {
    throw new Error('Usage: cli.ts check <1|5> | verify <chrome|queue>');
  }
  const config = readConfig();
  if (command === 'verify' && argument === 'chrome') {
    const screenshot = await fetchScreenshot('about:blank', config, AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS));
    if (!screenshot) throw new Error('Chrome verification failed: Browserless did not return a PNG screenshot.');
    console.info('Chrome verification: Browserless returned PNG (OK)');
    return;
  }
  await assertDatabaseReady(config.databaseUrl);
  configureJobDatabase(config.databaseUrl);
  try {
    if (command === 'check') {
      const count = await enqueueStaleServiceChecks(Number(argument) * 60_000);
      console.info(`Scheduled ${count} missing availability jobs older than ${argument} minute(s), respecting dashboard monitoring and check intervals.`);
    } else {
      const { rows } = await jobDatabase().query<{ kind: string; status: string; count: string }>('SELECT kind, status, count(*)::text AS count FROM "ServiceCheckJob" GROUP BY kind, status ORDER BY kind, status');
      console.info('Queue verification: PostgreSQL connection OK');
      for (const row of rows) console.info(`  ${row.kind} ${row.status}: ${row.count}`);
      if (!rows.length) console.info('  Queue is empty.');
    }
  } finally {
    await closeJobDatabase();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });

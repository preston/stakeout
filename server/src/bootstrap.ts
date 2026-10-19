import { pathToFileURL } from 'node:url';
import { readConfig } from './config.ts';
import { bootstrapDatabase } from './db/migrate.ts';

export { bootstrapDatabase, assertDatabaseReady, DatabaseNotReadyError } from './db/migrate.ts';

export async function bootstrap(): Promise<void> {
  await bootstrapDatabase(readConfig().databaseUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().then(() => console.log('Stakeout database is ready.')).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

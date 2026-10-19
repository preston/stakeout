// Author: Preston Lee

import { readConfig } from './config.ts';
import { bootstrapDatabase } from './bootstrap.ts';
import { createPrisma } from './db/prisma.ts';
import { bootstrapUser } from './auth/accounts.ts';
import { createApp } from './app.ts';
import { configureJobDatabase, closeJobDatabase, enqueueDashboardChecks } from './jobs/queue.ts';

async function main(): Promise<void> {
  const config = readConfig();
  await bootstrapDatabase(config.databaseUrl);
  const prisma = createPrisma(config.databaseUrl);
  try { await bootstrapUser(prisma, config); }
  catch (error) { await prisma.$disconnect(); throw error; }
  configureJobDatabase(config.databaseUrl);
  const app = createApp({ prisma, config, enqueueDashboardChecks });
  const server = app.listen(config.port, '0.0.0.0', () => console.info(`Stakeout API listening on port ${config.port}`));
  const shutdown = () => {
    server.close(() => {
      Promise.all([prisma.$disconnect(), closeJobDatabase()]).then(() => process.exit(0), error => {
        console.error('Shutdown failed', error); process.exit(1);
      });
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => { console.error('Stakeout startup failed', error); process.exitCode = 1; });

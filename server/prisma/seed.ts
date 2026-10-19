// Author: Preston Lee

import { readConfig } from '../src/config.ts';
import { bootstrapDatabase } from '../src/bootstrap.ts';
import { createPrisma } from '../src/db/prisma.ts';

async function main(): Promise<void> {
  const config = readConfig();
  await bootstrapDatabase(config.databaseUrl);
  const prisma = createPrisma(config.databaseUrl);
  try {
    await prisma.$transaction(async transaction => {
      const now = new Date();
      for (const definition of [
        { name: 'Example', services: [
          { name: 'Google', host: 'www.google.com', https: true },
          { name: 'ASU', host: 'www.asu.edu', https: true },
          { name: 'NIH', host: 'nih.gov', https: false },
          { name: 'New York Times', host: 'nytimes.com', https: false },
          { name: 'BBC', host: 'bbc.com', https: false },
        ], cloud: false },
        { name: 'Cloud Services', services: [
          ...Array.from({ length: 4 }, (_, index) => ({ name: `Controller ${index + 1}`, host: `controller0${index + 1}.example.com`, https: false })),
          ...Array.from({ length: 4 }, (_, index) => ({ name: `Node ${index + 1}`, host: `node0${index + 1}.example.com`, https: false })),
        ], cloud: true },
      ]) {
        const dashboard = await transaction.dashboard.upsert({ where: { name: definition.name },
          create: { name: definition.name, created_at: now, updated_at: now }, update: {} });
        for (const service of definition.services) {
          await transaction.service.upsert({ where: { dashboard_id_name: { dashboard_id: dashboard.id, name: service.name } },
            create: { ...service, dashboard_id: dashboard.id, http: !definition.cloud, http_preview: !definition.cloud,
              created_at: now, updated_at: now }, update: {} });
        }
      }
    });
    console.info('Example dashboards and services are available. Existing records were preserved.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => { console.error('Seed failed', error); process.exitCode = 1; });

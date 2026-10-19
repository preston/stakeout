import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { readCatalog } from '../src/db/catalog.ts';
import { withPostgres } from '../test/postgres.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrationsPath = join(root, 'prisma/migrations');
const catalogsPath = join(root, 'prisma/catalogs');
const migrations = (await readdir(migrationsPath, { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
if (!migrations.length) throw new Error('No committed migration SQL files were found');

// Replay only in the isolated PostgreSQL 18 database supplied by the test helper.
// Never read deployment DATABASE_URL / STAKEOUT_SERVER_DATABASE_URL credentials.
const catalogs = await withPostgres(async databaseUrl => {
  const client = new Client({ connectionString: databaseUrl, options: '-c timezone=UTC' });
  await client.connect();
  const results = new Map<string, string>();
  try {
    for (const name of migrations) {
      await client.query(await readFile(join(migrationsPath, name, 'migration.sql'), 'utf8'));
      results.set(name, `${JSON.stringify(await readCatalog(client), null, 2)}\n`);
    }
    return results;
  } finally {
    await client.end();
  }
});

// Do not change any manifests until every migration has replayed successfully.
await mkdir(catalogsPath, { recursive: true });
for (const [name, catalog] of catalogs) {
  await writeFile(join(catalogsPath, `${name}.json`), catalog);
}
console.log(`Refreshed ${catalogs.size} schema catalogs using isolated PostgreSQL 18.`);

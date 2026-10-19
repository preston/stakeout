import { defineConfig } from 'prisma/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Generation is intentionally possible without deployment credentials.
    url: process.env.STAKEOUT_SERVER_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
});

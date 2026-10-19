import { loadEnvFile } from 'node:process';
import { writeFile } from 'node:fs/promises';
try { loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const values = {
  STAKEOUT_UI_SERVER_URL: process.env.STAKEOUT_UI_SERVER_URL ?? 'http://localhost:3000',
  STAKEOUT_UI_TITLE: process.env.STAKEOUT_UI_TITLE ?? 'My Stakeout',
};
await writeFile(new URL('../src/assets/configuration.js', import.meta.url),
  `(function(window) { Object.assign(window, ${JSON.stringify(values)}); })(window);\n`);

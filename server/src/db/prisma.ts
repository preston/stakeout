import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { readConfig } from '../config.ts';

export function createPrisma(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl, options: '-c timezone=UTC' });
  return new PrismaClient({ adapter });
}

let singleton: PrismaClient | undefined;

// Importing the app for builds/tests does not require a configured live database.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    singleton ??= createPrisma(readConfig().databaseUrl);
    const value = Reflect.get(singleton, property);
    return typeof value === 'function' ? value.bind(singleton) : value;
  },
});

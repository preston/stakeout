// Author: Preston Lee

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient, Session, User } from '@prisma/client';
import { DEFAULT_PREFERENCES, type SessionDto, type UserDto, type UserPreferences } from '@stakeout/core';
import { ApiError } from '../api/errors.ts';

export const SESSION_COOKIE = 'stakeout_session';
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const USERS_LOCK = 68456111302026n;
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, { message: 'A JSON object is required.' });
  return value as Record<string, unknown>;
}

export function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.trim().toLowerCase())) {
    throw new ApiError(422, { username: ['Use 1–64 letters, numbers, dots, hyphens or underscores, starting with a letter or number.'] });
  }
  return value.trim().toLowerCase();
}

export function displayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new ApiError(422, { displayName: ['Enter a display name of up to 200 characters.'] });
  return value.trim();
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw new ApiError(422, { password: ['Use between 12 and 1024 characters.'] });
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const actual = await derive(password, Buffer.from(match[1], 'hex'));
  return timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function userDto(user: User): UserDto {
  return { id: user.id, username: user.username, displayName: user.displayName, isActive: user.isActive,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null, createdAt: user.createdAt.toISOString(), updatedAt: user.updatedAt.toISOString() };
}

export function preferences(user: User): UserPreferences {
  return Object.fromEntries(Object.keys(DEFAULT_PREFERENCES).map(key => [key, user[key as keyof User]])) as unknown as UserPreferences;
}

export function sessionDto(session: Session & { user: User }): SessionDto {
  return { user: userDto(session.user), preferences: preferences(session.user), csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() };
}

export function preferencePatch(value: unknown, current: User): UserPreferences {
  const patch = record(value);
  const next = { ...preferences(current) };
  const choices: Partial<Record<keyof UserPreferences, readonly unknown[]>> = {
    themePreferred: ['automatic', 'light', 'dark'], displayMode: ['overlay', 'wide'],
    dashboardOrder: ['asc', 'desc'], serviceSort: ['name', 'updatedAt'], serviceOrder: ['asc', 'desc'],
    refreshIntervalMs: [0, 5000, 60000, 900000, 3600000],
  };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_PREFERENCES) || !Object.hasOwn(DEFAULT_PREFERENCES, key)) throw new ApiError(422, { [key]: ['Unknown preference.'] });
    const field = key as keyof UserPreferences;
    if (choices[field] ? !choices[field]!.includes(value) : typeof value !== 'boolean') throw new ApiError(422, { [key]: ['Invalid preference value.'] });
    Object.assign(next, { [key]: value });
  }
  if (!next.developer && next.refreshIntervalMs === 5000) next.refreshIntervalMs = 60000;
  return next;
}

export async function usersTransaction<T>(prisma: PrismaClient, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${USERS_LOCK}::bigint)::text`;
    return action(tx);
  });
}

export async function createSession(tx: Prisma.TransactionClient, userId: string) {
  const token = randomBytes(32).toString('hex');
  const session = await tx.session.create({ data: {
    userId, tokenHash: tokenHash(token), csrfToken: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + SESSION_MS),
  }, include: { user: true } });
  return { token, session };
}

export async function bootstrapUser(prisma: PrismaClient, config: { bootstrapUsername: string; bootstrapPassword: string }): Promise<void> {
  const { bootstrapUsername, bootstrapPassword } = config;
  if (Boolean(bootstrapUsername) !== Boolean(bootstrapPassword)) throw new Error('Set STAKEOUT_SERVER_BOOTSTRAP_USERNAME and STAKEOUT_SERVER_BOOTSTRAP_PASSWORD together.');
  if (!bootstrapUsername) {
    if (!await prisma.user.count()) throw new Error('No users exist. Set STAKEOUT_SERVER_BOOTSTRAP_USERNAME and STAKEOUT_SERVER_BOOTSTRAP_PASSWORD to create the first account.');
    return;
  }
  const name = username(bootstrapUsername);
  if (await prisma.user.findUnique({ where: { username: name } })) return;
  const passwordHash = await hashPassword(bootstrapPassword);
  await usersTransaction(prisma, tx => tx.user.upsert({ where: { username: name }, update: {},
    create: { username: name, displayName: bootstrapUsername.trim(), passwordHash } }));
}

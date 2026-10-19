// Author: Preston Lee

import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { PrismaClient, Session, User } from '@prisma/client';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, notFound, requireUuid } from '../api/errors.ts';
import { SESSION_COOKIE, SESSION_MS, createSession, displayName, hashPassword, preferencePatch, preferences, record,
  sessionDto, tokenHash, userDto, username, usersTransaction, verifyPassword } from './accounts.ts';

export interface AuthenticationConfig {
  corsOrigin: string;
  production: boolean;
}

declare global {
  namespace Express {
    interface Request { stakeoutSession?: Session & { user: User }; }
  }
}

export function cookieOptions(config: AuthenticationConfig) {
  return { httpOnly: true, secure: config.production, sameSite: config.production ? 'none' as const : 'lax' as const, path: '/' };
}

export const requireAuth: RequestHandler = (request, _response, next) => {
  if (!request.stakeoutSession) throw new ApiError(401, { message: 'Sign in to continue.' });
  next();
};

export function authentication(prisma: PrismaClient, config: AuthenticationConfig): RequestHandler {
  return async (request, response, next) => {
    const token: unknown = request.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
      const session = await prisma.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
      if (session && session.expiresAt.getTime() > Date.now() && session.user.isActive) request.stakeoutSession = session;
      else {
        response.clearCookie(SESSION_COOKIE, cookieOptions(config));
        if (session) await prisma.session.deleteMany({ where: { id: session.id } });
      }
    }
    next();
  };
}

export function mutations(config: AuthenticationConfig): RequestHandler {
  const allowed = new Set(config.corsOrigin.split(',').map(s => s.trim()));
  return (request, _response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const origin = request.get('origin');
    if (origin && !allowed.has(origin) && origin !== `${request.protocol}://${request.host}`) throw new ApiError(403, { message: 'This origin is not allowed.' });
    if (request.path === '/auth/login') {
      if (!request.is('application/json')) throw new ApiError(415, { message: 'Use application/json.' });
      return next();
    }
    if (request.path === '/auth/logout' && !request.stakeoutSession) return next();
    if (!request.stakeoutSession) throw new ApiError(401, { message: 'Sign in to continue.' });
    const csrf = request.get('x-csrf-token') ?? '';
    const expected = request.stakeoutSession.csrfToken;
    if (!/^[a-f0-9]{64}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))) throw new ApiError(403, { message: 'Invalid CSRF token.' });
    next();
  };
}

let dummyPassword: Promise<string> | undefined;
export function accountRouter(prisma: PrismaClient, config: AuthenticationConfig) {
  const router = Router();
  router.use(['/auth', '/users', '/admin'], (_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  const loginSourceLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false, identifier: 'login-source',
    keyGenerator: request => ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? 'unknown'),
    message: { message: 'Too many sign-in attempts. Try again later.' } });
  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
    standardHeaders: 'draft-8', legacyHeaders: false, identifier: 'login-username',
    keyGenerator: request => typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase().slice(0, 64) : '<invalid>',
    message: { message: 'Too many sign-in attempts. Try again later.' } });
  const setSession = (response: Response, token: string) => response.cookie(SESSION_COOKIE, token, { ...cookieOptions(config), maxAge: SESSION_MS });
  const invalid = () => new ApiError(401, { message: 'Invalid username or password.' });

  router.post('/auth/login', loginSourceLimit, loginLimit, async (request, response) => {
    const input = record(request.body);
    const name = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const user = await prisma.user.findUnique({ where: { username: name } });
    dummyPassword ??= hashPassword('unused-dummy-password');
    const valid = await verifyPassword(input.password, user?.passwordHash ?? await dummyPassword);
    if (!user?.isActive || !valid) throw invalid();
    const issued = await usersTransaction(prisma, async tx => {
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current?.isActive || current.passwordHash !== user.passwordHash) throw invalid();
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await tx.session.deleteMany({ where: { OR: [{ expiresAt: { lte: new Date() } }, ...(request.stakeoutSession ? [{ id: request.stakeoutSession.id }] : [])] } });
      return createSession(tx, user.id);
    });
    setSession(response, issued.token);
    response.json(sessionDto(issued.session));
  });
  router.get('/auth/session', requireAuth, (request, response) => response.json(sessionDto(request.stakeoutSession!)));
  router.post('/auth/logout', async (request, response) => {
    if (request.stakeoutSession) await prisma.session.deleteMany({ where: { id: request.stakeoutSession.id } });
    response.clearCookie(SESSION_COOKIE, cookieOptions(config)).status(204).end();
  });
  router.use(['/users', '/admin'], requireAuth);
  router.get('/users/me', (request, response) => response.json(userDto(request.stakeoutSession!.user)));
  router.patch('/users/me', async (request, response) => {
    const name = displayName(record(request.body).displayName);
    const user = await prisma.user.update({ where: { id: request.stakeoutSession!.userId }, data: { displayName: name } });
    response.json(userDto(user));
  });
  router.get('/users/me/settings', (request, response) => response.json(preferences(request.stakeoutSession!.user)));
  router.patch('/users/me/settings', async (request, response) => {
    const user = await usersTransaction(prisma, async tx => {
      const current = await tx.user.findUniqueOrThrow({ where: { id: request.stakeoutSession!.userId } });
      return tx.user.update({ where: { id: current.id }, data: preferencePatch(request.body, current) });
    });
    response.json(preferences(user));
  });
  router.post('/users/me/password', async (request, response) => {
    const input = record(request.body);
    const user = request.stakeoutSession!.user;
    if (!await verifyPassword(input.currentPassword, user.passwordHash)) throw new ApiError(422, { currentPassword: ['Current password is incorrect.'] });
    const passwordHash = await hashPassword(input.password as string);
    const issued = await usersTransaction(prisma, async tx => {
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!current.isActive || current.passwordHash !== user.passwordHash) throw invalid();
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      return createSession(tx, user.id);
    });
    setSession(response, issued.token);
    response.json(sessionDto(issued.session));
  });
  router.get('/admin/users', async (_request, response) => {
    response.json((await prisma.user.findMany({ orderBy: { username: 'asc' } })).map(userDto));
  });
  router.get('/admin/users/:id', async (request, response) => {
    const user = await prisma.user.findUnique({ where: { id: requireUuid(String(request.params.id)) } });
    if (!user) notFound();
    response.json(userDto(user));
  });
  router.post('/admin/users', async (request, response) => {
    const input = record(request.body);
    const name = username(input.username);
    const label = displayName(input.displayName);
    if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new ApiError(422, { isActive: ['Use a boolean.'] });
    const passwordHash = await hashPassword(input.password as string);
    const user = await usersTransaction(prisma, tx => tx.user.create({ data: { username: name, displayName: label, passwordHash, isActive: input.isActive as boolean | undefined } }));
    response.location(`/admin/users/${user.id}`).status(201).json(userDto(user));
  });
  router.patch('/admin/users/:id', async (request, response) => {
    const input = record(request.body);
    const id = requireUuid(String(request.params.id));
    if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new ApiError(422, { isActive: ['Use a boolean.'] });
    const data = { ...(input.username === undefined ? {} : { username: username(input.username) }),
      ...(input.displayName === undefined ? {} : { displayName: displayName(input.displayName) }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive as boolean }) };
    const user = await usersTransaction(prisma, async tx => {
      const current = await tx.user.findUnique({ where: { id } });
      if (!current) notFound();
      if (current.isActive && data.isActive === false && await tx.user.count({ where: { isActive: true } }) <= 1) throw new ApiError(422, { isActive: ['The last active user cannot be disabled.'] });
      const updated = await tx.user.update({ where: { id }, data });
      if (!updated.isActive) await tx.session.deleteMany({ where: { userId: id } });
      return updated;
    });
    response.json(userDto(user));
  });
  router.delete('/admin/users/:id', async (request, response) => {
    const id = requireUuid(String(request.params.id));
    await usersTransaction(prisma, async tx => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) notFound();
      if (user.isActive && await tx.user.count({ where: { isActive: true } }) <= 1) throw new ApiError(422, { message: 'The last active user cannot be deleted.' });
      await tx.user.delete({ where: { id } });
    });
    response.status(204).end();
  });
  router.post('/admin/users/:id/password', async (request, response) => {
    const id = requireUuid(String(request.params.id));
    const passwordHash = await hashPassword(record(request.body).password as string);
    await usersTransaction(prisma, async tx => {
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: id } });
    });
    response.status(204).end();
  });
  return router;
}

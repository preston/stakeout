// Author: Preston Lee

import type { ValidationErrors } from '@stakeout/core';

export class ApiError extends Error {
  readonly status: number;
  readonly body: { message: string } | ValidationErrors;

  constructor(status: number, body: { message: string } | ValidationErrors) {
    super('message' in body && typeof body.message === 'string' ? body.message : 'Validation failed');
    this.status = status;
    this.body = body;
  }
}

export function notFound(): never {
  throw new ApiError(404, { message: 'Record not found.' });
}

export function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) notFound();
  return value;
}

export function attributes(body: unknown, key: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || !(key in body)) {
    throw new ApiError(400, { message: `param is missing or the value is empty: ${key}` });
  }
  const value: unknown = (body as Record<string, unknown>)[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new ApiError(400, { message: `param is missing or the value is empty: ${key}` });
  }
  return value as Record<string, unknown>;
}

export function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : undefined;
}

export function railsBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined || typeof value === 'object' && value !== null) return undefined;
  if (value === null || value === '') return null;
  return ![false, 0, '0', 'f', 'F', 'false', 'FALSE', 'off', 'OFF'].includes(value as string | number | boolean);
}

export function validatePresence(values: Record<string, unknown>): void {
  const errors: ValidationErrors = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || typeof value === 'string' && value.trim().length === 0) {
      errors[key] = ["can't be blank"];
    }
  }
  if (Object.keys(errors).length > 0) throw new ApiError(422, errors);
}

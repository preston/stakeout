// Author: Preston Lee

export function apiErrorMessage(error: unknown): string {
  const body = (error as { error?: unknown })?.error;
  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    const fields = Object.entries(body).filter(([, value]) => Array.isArray(value));
    if (fields.length) return fields.map(([key, value]) => `${key}: ${(value as string[]).join(', ')}`).join(' ');
  }
  return 'The request failed. Check your connection and try again.';
}

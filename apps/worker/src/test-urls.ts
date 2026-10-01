import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const envPath = resolve(fileURLToPath(import.meta.url), '../../../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
process.env.SENDER_CREDENTIAL_KEY ??= 'c'.repeat(64);

function postgresUrl(user: string, password: string): string {
  return `postgresql://${user}:${password}@${process.env.EOW_POSTGRES_BIND ?? '127.0.0.1'}:${process.env.EOW_POSTGRES_PORT ?? '55432'}/${process.env.EOW_POSTGRES_DB ?? 'eow'}`;
}

export function testOwnerDatabaseUrl(): string {
  const password = process.env.EOW_POSTGRES_PASSWORD;
  if (!password) throw new Error('EOW_POSTGRES_PASSWORD is required for worker fixture setup.');
  return postgresUrl(process.env.EOW_POSTGRES_USER ?? 'eow', password);
}

export function testAppDatabaseUrl(): string {
  const password = process.env.EOW_POSTGRES_APP_PASSWORD;
  if (!password) throw new Error('EOW_POSTGRES_APP_PASSWORD is required for worker runtime tests.');
  return postgresUrl('eow_app', password);
}

export function testRedisUrl(): string {
  const password = process.env.EOW_REDIS_PASSWORD;
  if (!password) throw new Error('EOW_REDIS_PASSWORD is required for worker integration tests.');
  return `redis://:${encodeURIComponent(password)}@${process.env.EOW_REDIS_BIND ?? '127.0.0.1'}:${process.env.EOW_REDIS_PORT ?? '56379'}/0`;
}

import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const validEnv = {
  DATABASE_URL: 'postgresql://eow:secret@postgres:5432/eow',
  REDIS_URL: 'redis://:secret@redis:6379/0',
  SESSION_SECRET: 'a'.repeat(64),
  SENDER_CREDENTIAL_KEY: 'b'.repeat(64),
};

describe('validateEnv', () => {
  it('parses a complete environment and applies documented defaults', () => {
    const env = validateEnv(validEnv);

    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.API_PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NOTIFICATION_RETENTION_DAYS).toBe(90);
  });

  it('fails fast and names the missing required variable', () => {
    const { DATABASE_URL, ...withoutDatabaseUrl } = validEnv;
    void DATABASE_URL;

    expect(() => validateEnv(withoutDatabaseUrl)).toThrowError(/DATABASE_URL/);
  });

  it('rejects a SESSION_SECRET shorter than 32 bytes / 64 hex chars', () => {
    expect(() => validateEnv({ ...validEnv, SESSION_SECRET: 'too-short' })).toThrowError(/SESSION_SECRET/);
  });

  it('rejects a malformed sender credential encryption key', () => {
    expect(() => validateEnv({ ...validEnv, SENDER_CREDENTIAL_KEY: 'too-short' })).toThrowError(/SENDER_CREDENTIAL_KEY/);
  });

  it('rejects an out-of-range API_PORT', () => {
    expect(() => validateEnv({ ...validEnv, API_PORT: '70000' })).toThrowError(/API_PORT/);
  });

  it('rejects a notification retention period outside the supported range', () => {
    expect(() => validateEnv({ ...validEnv, NOTIFICATION_RETENTION_DAYS: '0' })).toThrowError(/NOTIFICATION_RETENTION_DAYS/);
  });

  it('defaults the history event retention window to 365 days', () => {
    expect(validateEnv(validEnv).HISTORY_EVENT_RETENTION_DAYS).toBe(365);
  });

  it('rejects a history retention window inside the 30-day floor', () => {
    expect(() => validateEnv({ ...validEnv, HISTORY_EVENT_RETENTION_DAYS: '29' })).toThrowError(/HISTORY_EVENT_RETENTION_DAYS/);
  });

  it('D-111: treats an empty-string PROVIDER_WEBHOOK_SECRET the same as unset -- compose.yaml\'s ${VAR:-} expands to "", not an absent key', () => {
    expect(() => validateEnv({ ...validEnv, PROVIDER_WEBHOOK_SECRET: '' })).not.toThrow();
    expect(validateEnv({ ...validEnv, PROVIDER_WEBHOOK_SECRET: '' }).PROVIDER_WEBHOOK_SECRET).toBeUndefined();
  });

  it('still rejects a PROVIDER_WEBHOOK_SECRET that is set but too short', () => {
    expect(() => validateEnv({ ...validEnv, PROVIDER_WEBHOOK_SECRET: 'too-short' })).toThrowError(/PROVIDER_WEBHOOK_SECRET/);
  });

  it('accepts a well-formed PROVIDER_WEBHOOK_SECRET', () => {
    const secret = 'a'.repeat(32);
    expect(validateEnv({ ...validEnv, PROVIDER_WEBHOOK_SECRET: secret }).PROVIDER_WEBHOOK_SECRET).toBe(secret);
  });
});

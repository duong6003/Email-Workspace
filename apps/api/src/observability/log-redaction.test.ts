import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, createNestLogger } from './logger.js';

function serialize(value: unknown): string {
  const lines: string[] = [];
  const destination = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  createLogger({ destination }).info(value as object, 'redaction-probe');
  return lines.join('');
}

describe('log redaction', () => {
  it('BR-SEC-003: redacts secrets by key at any depth', () => {
    const line = serialize({
      secret: 'plaintext', password: 'p', smtp: { secret: 'x', username: 'u' },
      headers: { cookie: 'eow_session=abc', 'x-csrf-token': 't' },
      config: { secretRef: 'EOW_SENDER_SECRET_AB12' },
    });
    expect(line).not.toContain('plaintext');
    expect(line).not.toContain('eow_session=abc');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('EO••••12');
  });

  it('BR-SEC-003: drops email content and keeps sizes and hashes', () => {
    const line = serialize({ html: '<p>Dear Alice, your invoice</p>', text: 'Dear Alice', subject: 'Invoice' });
    expect(line).not.toContain('Dear Alice');
    expect(line).not.toContain('Invoice');
    expect(line).toMatch(/"html_bytes":\d+/);
    expect(line).toMatch(/"html_sha256":"[a-f0-9]{64}"/);
  });

  it('BR-SEC-003: drops recipient custom values but keeps field names', () => {
    const line = serialize({ customData: { plan: 'enterprise', ssn: '123-45-6789' } });
    expect(line).not.toContain('enterprise');
    expect(line).not.toContain('123-45-6789');
    expect(line).toContain('plan');
    expect(line).toContain('ssn');
  });

  it('BR-SEC-003: keeps operational identifiers', () => {
    const line = serialize({ campaignId: 'c1', tenantId: 't1', executionId: 'e1', recipientId: 'r1', jobId: 'j1' });
    for (const id of ['c1', 't1', 'e1', 'r1', 'j1']) expect(line).toContain(id);
  });

  it('BR-SEC-003: redacts an email address under an unknown future key', () => {
    expect(serialize({ someFutureField: 'alice@example.test' })).not.toContain('alice@example.test');
  });

  it('BR-SEC-003: never emits raw Error messages or stacks', () => {
    const line = serialize({ err: new Error('PLANT-ERROR-SECRET') });
    expect(line).not.toContain('PLANT-ERROR-SECRET');
    expect(line).toContain('[REDACTED]');
  });

  /**
   * Added by the review session at merge 4 (EXECPLAN D-170).
   *
   * These two assertions pull in opposite directions and both must hold. The
   * merged tree briefly failed the second one: a blanket [REDACTED] over every
   * Error message satisfied BR-SEC-003 by making a misconfigured deployment
   * undebuggable, breaking env.ts's documented "names it in the thrown error"
   * contract, both of boot.test.ts's assertions, and DEPLOY-001's operator
   * acceptance. Keeping them adjacent is deliberate: neither may be relaxed to
   * fix the other.
   */
  it('BR-SEC-003 + DEPLOY-001: a boot configuration error keeps its variable name, an arbitrary error does not', () => {
    const boot = serialize({ err: new Error('Invalid environment configuration: DATABASE_URL: Required') });
    expect(boot).toContain('DATABASE_URL');

    const arbitrary = serialize({ err: new Error('connection failed for PLANT-ARBITRARY-DETAIL') });
    expect(arbitrary).not.toContain('PLANT-ARBITRARY-DETAIL');
    expect(arbitrary).toContain('[REDACTED]');
  });

  it('BR-SEC-003: an allowlisted boot message is still scrubbed of value-shaped secrets', () => {
    const line = serialize({
      err: new Error('Invalid environment configuration: DATABASE_URL: bad url postgresql://eow:hunter2@db:5432/eow'),
    });
    expect(line).toContain('DATABASE_URL');
    expect(line).not.toContain('hunter2');
  });

  it('BR-SEC-003: Nest error messages use a safe fixed log message', () => {
    const lines: string[] = [];
    const destination = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    createNestLogger(createLogger({ destination })).error(new Error('PLANT-NEST-ERROR-SECRET'));
    expect(lines.join('')).not.toContain('PLANT-NEST-ERROR-SECRET');
  });
});

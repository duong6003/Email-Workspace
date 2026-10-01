import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';
import { runWithRequestContext } from '../../src/observability/request-context.js';

function destination(lines: string[]): Writable {
  return new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
}

describe('TC-SEC-003 log redaction integration', () => {
  it('captures real Pino output without planted secret, token, custom value or body', () => {
    const planted = {
      smtpSecret: `PLANT-SMTP-${randomUUID()}`,
      customValue: `PLANT-CUSTOM-${randomUUID()}`,
      emailBody: `PLANT-BODY-${randomUUID()}`,
      sessionToken: `PLANT-SESSION-${randomUUID()}`,
    };
    const lines: string[] = [];
    const logger = createLogger({ destination: destination(lines) });
    runWithRequestContext({ traceId: randomUUID(), tenantId: randomUUID() }, () => {
      logger.info({ smtp: { password: planted.smtpSecret } }, 'sender-probe');
      logger.info({ customData: { tier: planted.customValue } }, 'recipient-probe');
      logger.error({ html: planted.emailBody, headers: { cookie: planted.sessionToken } }, 'delivery-probe');
    });
    const captured = lines.join('\n');
    expect(lines.length).toBe(3);
    expect(captured).toContain('"trace_id"');
    for (const value of Object.values(planted)) expect(captured).not.toContain(value);
  });

  it('negative control proves the capture harness sees a deliberate raw leak', () => {
    const canary = `CANARY-${randomUUID()}`;
    const lines: string[] = [];
    destination(lines).write(`${canary}\n`);
    expect(lines.join('')).toContain(canary);
  });
});

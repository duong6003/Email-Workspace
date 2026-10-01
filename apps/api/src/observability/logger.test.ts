import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { runWithRequestContext } from './request-context.js';

function captureStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
}

describe('structured logger', () => {
  it('BR-SEND-013: injects trace_id and tenant_id from ambient context', () => {
    const lines: string[] = [];
    runWithRequestContext({ traceId: 'trace-9', tenantId: 'tenant-9', module: 'probe' }, () => {
      createLogger({ level: 'info', destination: captureStream(lines) }).info({ event: 'probe' }, 'probe');
    });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.trace_id).toBe('trace-9');
    expect(parsed.tenant_id).toBe('tenant-9');
    expect(parsed.module).toBe('probe');
    expect(parsed.event).toBe('probe');
  });

  it('BR-SEND-013: emits boot-time lines with null ambient identifiers', () => {
    const lines: string[] = [];
    createLogger({ level: 'info', destination: captureStream(lines) }).info({ event: 'boot' }, 'up');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.trace_id).toBeNull();
    expect(parsed.tenant_id).toBeNull();
  });

  it('honours LOG_LEVEL', () => {
    const lines: string[] = [];
    createLogger({ level: 'warn', destination: captureStream(lines) }).info({}, 'suppressed');
    expect(lines).toHaveLength(0);
  });
});

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runWithJobContext } from './job-context.js';
import { createWorkerLogger } from './logger.js';

describe('worker job context', () => {
  it('BR-SEND-013: worker logs under the inherited trace id', () => {
    const lines: string[] = [];
    const destination = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
    runWithJobContext({ traceId: 'inherited-trace', tenantId: 'tenant-1', jobName: 'campaign-send-scan', jobId: 'job-1' }, () => {
      createWorkerLogger(destination).info({ event: 'job.started' }, 'job.started');
    });
    const line = JSON.parse(lines[0]!);
    expect(line.trace_id).toBe('inherited-trace');
    expect(line.trace_id).not.toMatch(/^dispatcher:/);
  });
});

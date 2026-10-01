import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testAppDatabaseUrl, testRedisUrl } from '../test-urls.js';

const QUEUE = 'campaign-execution';
const JOB = 'm7-s4-restart-probe';
const RESTART_REDIS_DB = 14;
const workerEntry = resolve(process.cwd(), 'dist/restart-probe-worker.js');
let connection: Redis;
let queue: Queue;
let events: QueueEvents;

function isolatedRedisUrl(): string {
  const url = new URL(testRedisUrl());
  url.pathname = `/${RESTART_REDIS_DB}`;
  return url.toString();
}

async function waitForCompleted(jobId: string, timeout: number): Promise<unknown> {
  const job = await queue.getJob(jobId);
  if (!job) throw new Error(`Missing job ${jobId}`);
  return job.waitUntilFinished(events, timeout);
}

describe('TC-SEND-018: BullMQ worker restart durability', () => {
  beforeAll(async () => {
    connection = new Redis(isolatedRedisUrl(), { maxRetriesPerRequest: null });
    await connection.flushdb();
    queue = new Queue(QUEUE, { connection });
    events = new QueueEvents(QUEUE, { connection });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await Promise.all([events.close(), queue.close(), connection.quit()]);
  });

  it('SIGKILLed active work is stalled and redelivered rather than lost or completed twice', async () => {
    await queue.pause();
    await queue.drain(true);
    await queue.clean(0, 1000, 'completed');
    await queue.clean(0, 1000, 'failed');
    const probeKey = `m7s4:${randomUUID()}`;
    const jobId = `m7-s4-${randomUUID()}`;
    const job = await queue.add(JOB, { probeKey, holdMs: 60_000 }, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: false,
      removeOnFail: false,
    });
    const env = {
      ...process.env,
      REDIS_URL: isolatedRedisUrl(),
      DATABASE_URL: testAppDatabaseUrl(),
      M7_S4_RESTART_PROBE: '1',
    };
    const killed = fork(workerEntry, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    await queue.resume();
    await once(killed, 'message');
    killed.kill('SIGKILL');
    await once(killed, 'exit');

    const restarted = fork(workerEntry, { env: { ...env, M7_S4_PROBE_HOLD_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const result = await waitForCompleted(job.id!, 120_000) as { probeKey: string; processCount: number };
    restarted.kill('SIGTERM');
    await once(restarted, 'exit');

    expect(result.probeKey).toBe(probeKey);
    expect(result.processCount).toBe(2);
    const completed = await queue.getJob(job.id!);
    expect(await completed?.getState()).toBe('completed');
    expect(completed?.attemptsMade).toBe(1);
  }, 150_000);
});

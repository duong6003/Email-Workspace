import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const worker = new Worker('campaign-execution', async (job) => {
  if (job.name !== 'm7-s4-restart-probe') return { ignored: job.name };
  const probeKey = String(job.data.probeKey);
  const processCount = await connection.incr(probeKey);
  if (process.send) process.send({ active: true, processCount });
  const holdMs = Number(process.env.M7_S4_PROBE_HOLD_MS ?? job.data.holdMs ?? 0);
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  return { probeKey, processCount };
}, {
  connection,
  concurrency: 1,
  lockDuration: 10_000,
  stalledInterval: 2_000,
  maxStalledCount: 2,
});

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

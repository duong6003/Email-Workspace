import './observability/instrumentation.js';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { schedulerLogger } from './observability/logger.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest:null });
const queue = new Queue('campaign-execution', { connection });
const tickMs = Math.max(5_000, Number(process.env.SCHEDULER_TICK_MS ?? 60_000));
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  const bucket = Math.floor(Date.now() / tickMs);
  try {
    schedulerLogger.debug({ bucket }, 'scheduler.tick');
    await Promise.all([
      queue.add('campaign-misfire-scan', { bucket }, { jobId:`campaign-misfire-scan-${bucket}`, attempts:3, backoff:{type:'exponential',delay:1000}, removeOnComplete:100, removeOnFail:500 }),
      queue.add('campaign-send-scan', { bucket }, { jobId:`campaign-send-scan-${bucket}`, attempts:3, backoff:{type:'exponential',delay:1000}, removeOnComplete:100, removeOnFail:500 }),
      queue.add('outbox-publish', { bucket }, { jobId:`outbox-publish-${bucket}`, attempts:3, backoff:{type:'exponential',delay:1000}, removeOnComplete:100, removeOnFail:500 }),
      queue.add('progress-reconcile', { bucket }, { jobId:`progress-reconcile-${bucket}`, attempts:3, backoff:{type:'exponential',delay:1000}, removeOnComplete:100, removeOnFail:500 }),
      queue.add('export-scan', { bucket }, { jobId:`export-scan-${bucket}`, attempts:3, backoff:{type:'exponential',delay:1000}, removeOnComplete:100, removeOnFail:500 }),
      queue.add('history-purge-scan', { bucket }, { jobId:`history-purge-scan-${bucket}`, attempts:3, backoff:{type:'exponential',delay:1000}, removeOnComplete:100, removeOnFail:500 }),
      queue.add('export-artifact-purge-scan', { bucket }, { jobId:`export-artifact-purge-scan-${bucket}`, attempts:3, backoff:{type:'exponential',delay:1000}, removeOnComplete:100, removeOnFail:500 }),
    ]);
  } finally {
    ticking = false;
  }
}

await tick();
const timer = setInterval(() => void tick(), tickMs);
const shutdown=async()=>{clearInterval(timer);await queue.close();await connection.quit();process.exit(0);};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);

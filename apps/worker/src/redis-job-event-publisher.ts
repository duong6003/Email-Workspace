import type { Redis } from 'ioredis';
import type { JobEventPublisher } from './import-processor.js';

export function jobChannel(jobId: string): string {
  return `eow:job:${jobId}`;
}

export function createRedisJobEventPublisher(connection: Redis): JobEventPublisher {
  return async (event) => {
    const jobId = typeof event.aggregate_id === 'string' ? event.aggregate_id : null;
    if (!jobId) throw new Error('Job realtime event requires aggregate_id.');
    await connection.publish(jobChannel(jobId), JSON.stringify(event));
  };
}

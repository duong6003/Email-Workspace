import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { ReadinessService, REDIS_READINESS_CLIENT } from './readiness.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    ReadinessService,
    {
      provide: REDIS_READINESS_CLIENT,
      useFactory: () => {
        const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          maxRetriesPerRequest: 1,
          connectTimeout: 2_000,
          lazyConnect: true,
        });
        client.on('error', () => undefined);
        return client;
      },
    },
  ],
})
export class HealthModule {}

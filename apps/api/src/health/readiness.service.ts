import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { ReadinessCheckDto, ReadinessResponseDto } from './dto/readiness.dto.js';

export const REDIS_READINESS_CLIENT = Symbol('REDIS_READINESS_CLIENT');
export type RedisReadinessClient = { ping(): Promise<string> };

const CHECK_TIMEOUT_MS = 2_000;

async function timedCheck(check: () => Promise<unknown>): Promise<ReadinessCheckDto> {
  const started = performance.now();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('readiness check timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  } catch {
    return { ok: false, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

@Injectable()
export class ReadinessService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS_READINESS_CLIENT) private readonly redis: RedisReadinessClient,
  ) {}

  async check(): Promise<ReadinessResponseDto> {
    const [database, redis] = await Promise.all([
      timedCheck(() => this.dataSource.query('SELECT 1')),
      timedCheck(() => this.redis.ping()),
    ]);
    return {
      status: database.ok && redis.ok ? 'ready' : 'unready',
      checks: { database, redis },
    };
  }
}

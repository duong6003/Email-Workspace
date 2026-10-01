import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { HealthService } from './health.service.js';
import { ReadinessService } from './readiness.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly readinessService: ReadinessService,
  ) {}

  @Get()
  @Public()
  health() {
    return this.healthService.status();
  }

  @Get('ready')
  @Public()
  @HttpCode(200)
  async readiness(@Res({ passthrough: true }) response: Response) {
    const result = await this.readinessService.check();
    if (result.status === 'unready') response.status(503);
    return result;
  }
}

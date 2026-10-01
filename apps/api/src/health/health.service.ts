import { Injectable } from '@nestjs/common';
import type { HealthResponseDto } from './dto/health.dto.js';

@Injectable()
export class HealthService {
  status(): HealthResponseDto {
    return { status: 'ready', service: 'api', time: new Date().toISOString() };
  }
}

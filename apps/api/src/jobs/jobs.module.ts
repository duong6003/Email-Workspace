import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyService } from '../common/idempotency.service.js';
import { ImportJobEntity } from '../database/entities/import-job.entity.js';
import { ImportJobRowEntity } from '../database/entities/import-job-row.entity.js';
import { BulkJobEntity } from '../database/entities/bulk-job.entity.js';
import { BulkJobRowEntity } from '../database/entities/bulk-job-row.entity.js';
import { RecipientEntity } from '../database/entities/recipient.entity.js';
import { JobsController } from './jobs.controller.js';
import { BulkJobsController } from './bulk-jobs.controller.js';
import { ImportJobsService } from './import-jobs.service.js';
import { BulkJobsService } from './bulk-jobs.service.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([ImportJobEntity, ImportJobRowEntity, BulkJobEntity, BulkJobRowEntity, RecipientEntity]), CustomFieldsModule],
  controllers: [JobsController, BulkJobsController],
  providers: [IdempotencyService, ImportJobsService, BulkJobsService],
})
export class JobsModule {}

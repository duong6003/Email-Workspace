import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { RecipientsController } from './recipients.controller.js';
import { RecipientsService } from './recipients.service.js';

// RecipientsRepository is a plain class (not a DI provider) constructed
// per-call by RecipientsService -- see recipients.repository.ts's class
// comment for why (a real, reproduced NestJS request-scope + global-guard
// ordering hazard). CustomFieldsModule is imported (its CustomFieldsService
// is a singleton, so no such hazard applies to it) so M2-S3's typed
// custom_data validation (BR-CF-002) can run on every recipient
// create/update.
@Module({
  imports: [CustomFieldsModule],
  controllers: [RecipientsController],
  providers: [RecipientsService],
})
export class RecipientsModule {}

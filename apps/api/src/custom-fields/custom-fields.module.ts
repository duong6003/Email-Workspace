import { Module } from '@nestjs/common';
import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';

// CustomFieldsRepository is a plain class (not a DI provider), same reason
// as RecipientsModule -- see custom-fields.repository.ts's class comment.
@Module({
  imports: [],
  controllers: [CustomFieldsController],
  providers: [CustomFieldsService],
  exports: [CustomFieldsService],
})
export class CustomFieldsModule {}

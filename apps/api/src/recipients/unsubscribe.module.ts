import { Module } from '@nestjs/common';
import { UnsubscribeController } from './unsubscribe.controller.js';
import { UnsubscribeService } from './unsubscribe.service.js';

/**
 * ADR-049. Its own module rather than a pair of extra providers on
 * `RecipientsModule`, for two reasons that point the same way:
 *
 * - `ARCH-MODULE` requires every controller to have a module beside it, and
 *   this is the check saying so.
 * - This is the only public, unauthenticated, state-changing surface in the
 *   API. Keeping it in one small module makes "what can a stranger reach"
 *   answerable by reading one file, instead of by auditing the recipients
 *   module for which of its routes are guarded.
 */
@Module({
  controllers: [UnsubscribeController],
  providers: [UnsubscribeService],
})
export class UnsubscribeModule {}

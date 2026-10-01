import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { WebhooksService } from './webhooks.service.js';
import type { ProviderWebhookResult } from './dto/provider-webhook.dto.js';

/**
 * Inbound provider delivery callbacks (BR-SEND-008). @Public(): no session
 * exists on this route -- the request is authenticated by its HMAC
 * signature (webhook-signature.ts), verified server-side, never by hiding
 * the URL. No CsrfGuard: that guard exists for session-cookie-authenticated
 * browser requests, which this route by definition never receives.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('providers/:provider')
  @HttpCode(200)
  @Public()
  async ingest(
    @Param('provider') provider: string,
    @Headers('x-eow-signature') signatureHeader: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<ProviderWebhookResult> {
    return this.webhooks.ingest(provider, req.rawBody, signatureHeader, new Date());
  }
}

import { Controller, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { getOrCreateTraceId } from '../common/trace-id.js';
import { UnsubscribeService } from './unsubscribe.service.js';

/**
 * ADR-049 -- the one route a recipient, not a user, is meant to reach.
 *
 * Both routes are `@Public()`: the click comes from a mail client with none of
 * our cookies, exactly like the asset serving route (ADR-043 §2). The
 * capability is the signature in the token, checked in `UnsubscribeService`
 * before anything touches the database.
 *
 * **No `CsrfGuard`, and that is deliberate rather than overlooked.** CSRF
 * protection defends a session against a third-party page acting as the
 * logged-in user; there is no session here and nothing to ride on. The token
 * is per-recipient and unguessable, so the only party who can trigger this for
 * someone is one who already holds that person's link -- and the honest reading
 * of a recipient's own link being used is that the recipient used it.
 *
 * **GET describes, POST acts.** Not a style preference: mail security scanners
 * and link-preview fetchers issue GETs against every URL in a message, so a GET
 * that unsubscribed would quietly unsubscribe recipients whose mail server
 * scanned the mail. The same reason RFC 8058 one-click uses POST.
 */
@Controller('unsubscribe')
export class UnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  /**
   * What the confirmation page needs. A bad token and an unknown recipient both
   * produce 404 with the same body -- answering differently would turn this
   * route into an oracle for which recipient ids exist.
   */
  @Public() @Get(':token')
  async describe(@Param('token') token: string) {
    const target = await this.unsubscribe.describe(token);
    if (!target) throw new NotFoundException('This unsubscribe link is not valid.');
    return { email: target.email, alreadyUnsubscribed: target.alreadyUnsubscribed };
  }

  @Public() @Post(':token') @HttpCode(200)
  async redeem(@Param('token') token: string, @Req() request: Request) {
    const target = await this.unsubscribe.redeem(token, getOrCreateTraceId(request));
    if (!target) throw new NotFoundException('This unsubscribe link is not valid.');
    return { email: target.email, alreadyUnsubscribed: target.alreadyUnsubscribed };
  }
}

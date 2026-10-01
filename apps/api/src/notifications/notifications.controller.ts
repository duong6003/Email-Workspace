import { Body, Controller, Get, HttpCode, Param, Patch, Put, Query, Req, UseGuards } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { PERMISSIONS } from '../common/permissions.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { NotificationsService } from './notifications.service.js';
import { notificationListQuerySchema, updateActionStateSchema, updatePreferenceSchema, type NotificationListQueryDto, type UpdateActionStateDto, type UpdatePreferenceDto } from './dto/notification.dto.js';
function auth(req: AuthenticatedRequest) { if (!req.auth) throw new Error('Not authenticated.'); return req.auth; }
@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get('notifications') @RequirePermission(PERMISSIONS.NOTIFICATION_READ) list(@Query(new ZodValidationPipe(notificationListQuerySchema)) query: NotificationListQueryDto, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.notifications.list(a.tenantId, a.userId, query); }
  @Get('notifications/:id/deep-link') @RequirePermission(PERMISSIONS.NOTIFICATION_READ) deepLink(@Param('id') id: string, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.notifications.resolveDeepLink(a.tenantId, a.userId, a.permissions, id); }
  @Put('notifications/:id/read') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.NOTIFICATION_READ) @HttpCode(204) read(@Param('id') id: string, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.notifications.markRead(a.tenantId, a.userId, id); }
  @Put('notifications/read-all') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.NOTIFICATION_READ) @HttpCode(204) readAll(@Req() req: AuthenticatedRequest) { const a = auth(req); return this.notifications.markAllRead(a.tenantId, a.userId); }
  @Patch('notifications/:id/action-state') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.NOTIFICATION_READ) @HttpCode(204) action(@Param('id') id: string, @Body(new ZodValidationPipe(updateActionStateSchema)) body: UpdateActionStateDto, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.notifications.updateActionState(a.tenantId, a.userId, id, body); }
  @Get('notification-preferences') @RequirePermission(PERMISSIONS.NOTIFICATION_READ) preferences(@Req() req: AuthenticatedRequest) { const a = auth(req); return this.notifications.preferences(a.tenantId, a.userId); }
  @Put('notification-preferences') @UseGuards(CsrfGuard) @RequirePermission(PERMISSIONS.NOTIFICATION_READ) updatePreferences(@Body(new ZodValidationPipe(updatePreferenceSchema)) body: UpdatePreferenceDto, @Req() req: AuthenticatedRequest) { const a = auth(req); return this.notifications.updatePreference(a.tenantId, a.userId, body); }
}

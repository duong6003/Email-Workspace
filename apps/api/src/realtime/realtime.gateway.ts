import { InjectDataSource } from '@nestjs/typeorm';
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { Redis } from 'ioredis';
import { parse as parseCookie } from 'cookie';
import type { DataSource } from 'typeorm';
import { AppUserEntity } from '../database/entities/app-user.entity.js';
import { PERMISSIONS } from '../common/permissions.js';
import { PermissionsService } from '../auth/permissions.service.js';
import { SessionService } from '../auth/session.service.js';
import { parseSessionToken } from '../auth/session-token.js';
import { requestedJobIds } from './realtime-job-rooms.js';
import { requestedCampaignIds } from './realtime-campaign-rooms.js';
import { setTenantContext } from '../database/tenant-transaction.js';

const JOB_CHANNEL_PREFIX = 'eow:job:';
const CAMPAIGN_CHANNEL_PREFIX = 'eow:campaign:';
const USER_CHANNEL_PREFIX = 'eow:user:';
const ORG_CHANNEL_PREFIX = 'eow:org:';

@WebSocketGateway({ namespace:'/realtime', cors:{ origin:process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials:true } })
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private subscriber!: Redis;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null, lazyConnect: true });
    this.subscriber.on('error', () => undefined);
    await this.subscriber.connect();
    await this.subscriber.psubscribe(`${JOB_CHANNEL_PREFIX}*`, `${CAMPAIGN_CHANNEL_PREFIX}*`, `${USER_CHANNEL_PREFIX}*`, `${ORG_CHANNEL_PREFIX}*`);
    this.subscriber.on('pmessage', (_pattern, channel, payload) => {
      const room = this.roomForChannel(channel);
      if (!room) return;
      try {
        const event = JSON.parse(payload) as { event_type?: string };
        if (typeof event.event_type === 'string') this.server.to(room).emit(event.event_type, event);
      } catch {
        // A malformed cross-process message is ignored rather than crashing the gateway.
      }
    });
  }

  /**
   * campaign.progress publishes to eow:campaign:{id} -> room campaign:{id}
   * (every viewer of that campaign). rt.resync_required publishes to
   * eow:user:{userId} -> room user:{userId} (M6-S2 will also target this
   * room for notification.created/updated/read) -- a resync affects
   * specific users, not everyone watching a campaign, so it cannot reuse
   * the campaign channel/room.
   */
  private roomForChannel(channel: string): string | null {
    if (channel.startsWith(CAMPAIGN_CHANNEL_PREFIX)) {
      const id = channel.slice(CAMPAIGN_CHANNEL_PREFIX.length);
      return id ? `campaign:${id}` : null;
    }
    if (channel.startsWith(USER_CHANNEL_PREFIX)) {
      const id = channel.slice(USER_CHANNEL_PREFIX.length);
      return id ? `user:${id}` : null;
    }
    if (channel.startsWith(JOB_CHANNEL_PREFIX)) {
      const id = channel.slice(JOB_CHANNEL_PREFIX.length);
      return id ? `job:${id}` : null;
    }
    if (channel.startsWith(ORG_CHANNEL_PREFIX)) {
      const id = channel.slice(ORG_CHANNEL_PREFIX.length);
      return id ? `org:${id}` : null;
    }
    return null;
  }

  async onModuleDestroy(): Promise<void> { if (this.subscriber.status !== 'wait') await this.subscriber.quit(); }

  /**
   * Shared auth chain for every room type (cookie -> session -> active user
   * -> tenant context -> permission -> ownership), the template
   * realtime-job-rooms' own precedent already established. Resolves the
   * session/user/tenant exactly once per connection regardless of which
   * room type (if any) was requested, so a client that requests no
   * job/campaign room still authenticates and can join its own `user:{id}`
   * (rt.resync_required's own target, M6-S1/M6-S2, and the baseline
   * connection AppShell/HistoryScreen/NotificationPopover open just to
   * receive that room -- M6-GATE CP6, D-137's own follow-up). Returns null
   * for any invalid/expired/inactive session so every connection is
   * authenticated up front, with no path that skips it.
   */
  private async authenticate(client: Socket): Promise<{ userId: string; tenantId: string } | null> {
    const cookie = parseCookie(client.handshake.headers.cookie ?? '');
    const token = parseSessionToken(cookie.eow_session);
    if (!token) return null;
    return this.dataSource.transaction(async (manager) => {
      const validation = await this.sessions.validate(manager, token.sessionId, token.secret);
      if (!validation) return null;
      const user = await manager.getRepository(AppUserEntity).findOne({ where: { id: validation.session.userId } });
      if (!user || user.status !== 'active') return null;
      return { userId: user.id, tenantId: user.tenantId };
    });
  }

  async handleConnection(client:Socket): Promise<void> {
    const authenticated = await this.authenticate(client);
    if (!authenticated) { client.disconnect(true); return; }
    const { userId, tenantId } = authenticated;

    const jobIds = requestedJobIds(client.handshake.auth);
    if (jobIds.length > 0) {
      const owns = await this.checkJobPermissionAndOwnership(tenantId, userId, jobIds);
      if (!owns) { client.disconnect(true); return; }
      for (const jobId of jobIds) client.join(`job:${jobId}`);
    }

    const campaignIds = requestedCampaignIds(client.handshake.auth);
    if (campaignIds.length > 0) {
      const owns = await this.checkCampaignPermissionAndOwnership(tenantId, userId, campaignIds);
      if (!owns) { client.disconnect(true); return; }
      for (const campaignId of campaignIds) client.join(`campaign:${campaignId}`);
    }

    client.join(`user:${userId}`);
    client.join(`org:${tenantId}`);

    client.emit('rt.connection.ready', { event_id:crypto.randomUUID(), event_type:'rt.connection.ready', occurred_at:new Date().toISOString(), tenant_id:tenantId, aggregate_id:userId, version:1, data:{ resume:true } });
  }

  private async checkJobPermissionAndOwnership(tenantId: string, userId: string, jobIds: string[]): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      await setTenantContext(manager, tenantId);
      const permissions = await this.permissions.getPermissionsForUser(manager, userId);
      if (!permissions.includes(PERMISSIONS.RECIPIENT_READ)) return false;
      const belongsToTenant = await manager.query(
        `SELECT id::text FROM import_job WHERE id = ANY($1::uuid[]) AND tenant_id = $2
         UNION ALL
         SELECT id::text FROM bulk_job WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [jobIds, tenantId],
      );
      return belongsToTenant.length === jobIds.length;
    });
  }

  private async checkCampaignPermissionAndOwnership(tenantId: string, userId: string, campaignIds: string[]): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      await setTenantContext(manager, tenantId);
      const permissions = await this.permissions.getPermissionsForUser(manager, userId);
      if (!permissions.includes(PERMISSIONS.CAMPAIGN_READ)) return false;
      const owned = await manager.query(
        `SELECT id::text FROM campaign WHERE id = ANY($1::uuid[]) AND tenant_id = $2`,
        [campaignIds, tenantId],
      );
      return owned.length === campaignIds.length;
    });
  }
  publish(room:string, eventType:string, envelope:unknown) { this.server.to(room).emit(eventType, envelope); }
}

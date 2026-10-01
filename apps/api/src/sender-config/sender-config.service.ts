import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { ValidatedEnv } from '../config/env.js';
import { appendAuditLog } from '../common/audit-writer.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { runInTenantContext } from '../database/tenant-transaction.js';
import { SenderConfigEntity } from '../database/entities/sender-config.entity.js';
import { SendingPolicyEntity } from '../database/entities/sending-policy.entity.js';
import { SenderCredentialStore } from './sender-credential.store.js';
import { maskSecretReference } from './secret-store.js';
import { SmtpProviderAdapter } from './smtp-provider.adapter.js';
import { SenderConfigRepository, SendingPolicyRepository } from './sender-config.repository.js';
import type { CreateSenderDto, PolicyDto, UpdateSenderDto } from './dto/sender-config.dto.js';

export type SenderActor = { actorId: string; traceId: string };

function response(row: SenderConfigEntity, credentialConfigured: boolean) {
  return {
    id: row.id,
    name: row.name,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    provider: row.provider,
    host: row.host,
    port: row.port,
    username: row.username,
    secretRef: maskSecretReference(row.secretRef),
    credentialConfigured,
    status: row.status,
    verifiedAt: row.verifiedAt,
    lastTestedAt: row.lastTestedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function validateReply(fromEmail: string, replyTo?: string | null) {
  if (replyTo && !/^\S+@\S+\.\S+$/.test(replyTo)) throw new BadRequestException({ code: 'INVALID_REPLY_TO' });
  if (!/^\S+@\S+\.\S+$/.test(fromEmail)) throw new BadRequestException({ code: 'INVALID_FROM' });
}

@Injectable()
export class SenderConfigService {
  private readonly credentials: SenderCredentialStore;
  private readonly smtp = new SmtpProviderAdapter();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
    config: ConfigService<ValidatedEnv, true>,
  ) {
    this.credentials = new SenderCredentialStore(config.get('SENDER_CREDENTIAL_KEY', { infer: true }));
  }

  list(tenantId: string, usableOnly = false) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const rows = await new SenderConfigRepository(manager, tenantId).list();
      const configuredReferences = await this.credentials.configuredReferences(manager, tenantId, rows.map((row) => row.secretRef));
      return {
        items: rows
          .filter((row) => !usableOnly || (row.status === 'verified' && (!row.username || configuredReferences.has(row.secretRef))))
          .map((row) => response(row, configuredReferences.has(row.secretRef))),
      };
    });
  }

  get(tenantId: string, id: string) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const row = await new SenderConfigRepository(manager, tenantId).findActiveById(id);
      if (!row) throw new NotFoundException('Sender configuration not found.');
      return response(row, await this.credentials.has(manager, tenantId, row.secretRef));
    });
  }

  create(tenantId: string, body: CreateSenderDto, actor: SenderActor) {
    validateReply(body.fromEmail, body.replyTo);
    const secretRef = `EOW_SENDER_SECRET_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const row = await new SenderConfigRepository(manager, tenantId).save({
        name: body.name,
        fromName: body.fromName,
        fromEmail: body.fromEmail.toLowerCase(),
        replyTo: body.replyTo ?? null,
        host: body.host,
        port: body.port,
        username: body.username,
        secretRef,
        status: 'pending',
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
        verifiedAt: null,
        lastTestedAt: null,
        deletedAt: null,
      });
      if (body.secret) await this.credentials.put(manager, tenantId, secretRef, body.secret);
      const credentialConfigured = Boolean(body.secret);
      await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'sender_config.created', entityType: 'sender_config', entityId: row.id, traceId: actor.traceId, metadata: { provider: row.provider, status: row.status, credentialConfigured } });
      return response(row, credentialConfigured);
    });
  }

  update(tenantId: string, id: string, body: UpdateSenderDto, actor: SenderActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const repository = new SenderConfigRepository(manager, tenantId);
      const row = await repository.findActiveById(id);
      if (!row) throw new NotFoundException('Sender configuration not found.');
      validateReply(body.fromEmail ?? row.fromEmail, body.replyTo === undefined ? row.replyTo : body.replyTo);
      const effectiveUsername = body.username ?? row.username;
      let storedSecret: string | undefined;
      try {
        storedSecret = await this.credentials.resolve(manager, tenantId, row.secretRef);
      } catch {
        storedSecret = undefined;
      }
      if (effectiveUsername.trim() && !(body.secret || storedSecret)) {
        throw new BadRequestException({ code: 'SECRET_UNAVAILABLE', fieldErrors: { secret: 'Nhập mật khẩu/token cho tài khoản SMTP này.' } });
      }
      const connectionChanged = ['fromEmail', 'host', 'port', 'username', 'secret'].some((field) => body[field as keyof UpdateSenderDto] !== undefined);
      Object.assign(row, {
        ...body,
        ...(body.fromEmail ? { fromEmail: body.fromEmail.toLowerCase() } : {}),
        updatedBy: actor.actorId,
      });
      if (body.secret) await this.credentials.put(manager, tenantId, row.secretRef, body.secret);
      if (connectionChanged) {
        row.status = 'pending';
        row.verifiedAt = null;
      }
      delete (row as unknown as Record<string, unknown>).secret;
      const saved = await repository.save(row);
      const credentialConfigured = await this.credentials.has(manager, tenantId, saved.secretRef);
      await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'sender_config.updated', entityType: 'sender_config', entityId: id, traceId: actor.traceId, metadata: { status: saved.status, credentialConfigured } });
      return response(saved, credentialConfigured);
    });
  }

  disable(tenantId: string, id: string, actor: SenderActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const row = await new SenderConfigRepository(manager, tenantId).findActiveById(id);
      if (!row) throw new NotFoundException('Sender configuration not found.');
      row.status = 'disabled';
      row.updatedBy = actor.actorId;
      await manager.getRepository(SenderConfigEntity).save(row);
      const [notification] = await manager.query(`INSERT INTO notification (tenant_id, type, severity, title, body, entity_type, entity_id) VALUES ($1, 'sender_disabled', 'warning', 'Cấu hình gửi đã tắt', 'Cấu hình gửi đã bị tắt và không thể dùng cho chiến dịch mới.', 'sender_config', $2) RETURNING id`, [tenantId, id]);
      await manager.query(`INSERT INTO user_notification (tenant_id, notification_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [tenantId, notification.id, row.createdBy ?? actor.actorId]);
      await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'sender_config.disabled', entityType: 'sender_config', entityId: id, traceId: actor.traceId, metadata: { status: row.status, ownerNotified: true } });
    });
  }

  testConnection(tenantId: string, id: string, candidateSecret: string | undefined, actor: SenderActor, key: string) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const idempotent = await this.idempotency.run(manager, tenantId, key, 'sender_connection_test', { senderConfigId: id, candidateSecretProvided: Boolean(candidateSecret) }, async () => {
        const row = await new SenderConfigRepository(manager, tenantId).findActiveById(id);
        if (!row) throw new NotFoundException('Sender configuration not found.');
        const secret = candidateSecret ?? await this.credentials.resolve(manager, tenantId, row.secretRef);
        if (row.username && !secret) throw new BadRequestException({ code: 'SECRET_UNAVAILABLE', message: 'Mật khẩu/token SMTP chưa được lưu. Hãy cập nhật cấu hình trước khi kiểm tra.' });
        const result = await this.smtp.testConnection({ host: row.host, port: row.port, username: row.username, secret: secret ?? '', fromEmail: row.fromEmail });
        if (result.ok && candidateSecret) await this.credentials.put(manager, tenantId, row.secretRef, candidateSecret);
        row.lastTestedAt = new Date();
        row.status = result.ok ? 'verified' : 'failed';
        row.verifiedAt = result.ok ? new Date() : null;
        await manager.getRepository(SenderConfigEntity).save(row);
        await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'sender_config.connection_tested', entityType: 'sender_config', entityId: id, traceId: actor.traceId, metadata: { ok: result.ok, code: result.ok ? 'OK' : result.code, classification: result.ok ? undefined : result.classification } });
        return { id: randomUUID(), ...(result.ok ? { ok: true, status: row.status } : { ok: false, code: result.code, classification: result.classification, reason: result.reason }) };
      });
      return { ...idempotent.value, idempotencyReplayed: idempotent.replayed };
    });
  }

  getPolicy(tenantId: string) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      const row = await new SendingPolicyRepository(manager, tenantId).get();
      return row ? { defaultSenderConfigId: row.defaultSenderConfigId, replyTo: row.replyTo, batchSize: row.batchSize, maxAttempts: row.maxAttempts, tenantRateLimitPerMinute: row.tenantRateLimitPerMinute, defaultTimezone: row.defaultTimezone ?? null } : { defaultSenderConfigId: null, replyTo: null, batchSize: 100, maxAttempts: 5, tenantRateLimitPerMinute: 600, defaultTimezone: null };
    });
  }

  putPolicy(tenantId: string, body: PolicyDto, actor: SenderActor) {
    return runInTenantContext(this.dataSource, tenantId, async (manager) => {
      let row = await new SendingPolicyRepository(manager, tenantId).get();
      if (!row) row = manager.getRepository(SendingPolicyEntity).create({ tenantId });
      // Only a *change* of default sender is gated. The settings form resubmits
      // every field, the stored id included, so gating any non-null value locked
      // the entire screen the moment the saved default stopped being `verified`:
      // nothing on it could be saved, not even fields with no bearing on sending
      // -- the tenant's default timezone now shares this row. Resubmitting a
      // value the server itself supplied is not the operator choosing an
      // unusable sender.
      //
      // The rule this used to enforce is not lost. Sending through a sender that
      // is not `verified` is refused at send time by CampaignsService, which is
      // where it decides anything.
      if (body.defaultSenderConfigId && body.defaultSenderConfigId !== row.defaultSenderConfigId) {
        const sender = await new SenderConfigRepository(manager, tenantId).findActiveById(body.defaultSenderConfigId);
        if (!sender || sender.status !== 'verified') throw new ConflictException({ code: 'SENDER_NOT_USABLE' });
      }
      row.defaultSenderConfigId = body.defaultSenderConfigId;
      row.replyTo = body.replyTo ?? null;
      row.batchSize = body.batchSize;
      row.maxAttempts = body.maxAttempts;
      row.tenantRateLimitPerMinute = body.tenantRateLimitPerMinute;
      row.defaultTimezone = body.defaultTimezone ?? null;
      row.updatedBy = actor.actorId;
      const saved = await manager.getRepository(SendingPolicyEntity).save(row);
      await appendAuditLog(manager, { tenantId, actorId: actor.actorId, action: 'sending_policy.updated', entityType: 'sending_policy', entityId: saved.id, traceId: actor.traceId, metadata: { defaultSenderConfigId: saved.defaultSenderConfigId, batchSize: saved.batchSize, maxAttempts: saved.maxAttempts, tenantRateLimitPerMinute: saved.tenantRateLimitPerMinute, defaultTimezone: saved.defaultTimezone } });
      return { defaultSenderConfigId: saved.defaultSenderConfigId, replyTo: saved.replyTo, batchSize: saved.batchSize, maxAttempts: saved.maxAttempts, tenantRateLimitPerMinute: saved.tenantRateLimitPerMinute, defaultTimezone: saved.defaultTimezone ?? null };
    });
  }
}

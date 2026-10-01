import { describe, expect, it } from 'vitest';
import { campaignBulkSchema } from './dto/bulk.dto.js';
import { bulkPrecondition, requiredBulkPermission, type CampaignBulkAction } from './campaign-bulk.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('campaignBulkSchema', () => {
  it('accepts a delete request', () => {
    expect(campaignBulkSchema.parse({ action: 'delete', campaignIds: [id] })).toEqual({ action: 'delete', campaignIds: [id] });
  });

  it('accepts every supported action', () => {
    for (const action of ['delete', 'duplicate', 'cancel'] as const) {
      expect(campaignBulkSchema.parse({ action, campaignIds: [id] }).action).toBe(action);
    }
  });

  it('rejects an unknown action', () => {
    expect(() => campaignBulkSchema.parse({ action: 'archive', campaignIds: [id] })).toThrow();
  });

  it('rejects an empty selection', () => {
    expect(() => campaignBulkSchema.parse({ action: 'delete', campaignIds: [] })).toThrow();
  });

  /** Bounded because each row runs its own transaction; an unbounded list holds the request open for an unbounded time. */
  it('rejects more than 100 campaigns', () => {
    expect(() => campaignBulkSchema.parse({ action: 'delete', campaignIds: Array(101).fill(id) })).toThrow();
    expect(campaignBulkSchema.parse({ action: 'delete', campaignIds: Array(100).fill(id) }).campaignIds).toHaveLength(100);
  });

  it('rejects a non-uuid campaign id', () => {
    expect(() => campaignBulkSchema.parse({ action: 'delete', campaignIds: ['nope'] })).toThrow();
  });

  it('rejects an unknown key', () => {
    expect(() => campaignBulkSchema.parse({ action: 'delete', campaignIds: [id], force: true })).toThrow();
  });
});

describe('bulkPrecondition', () => {
  it('allows delete only for drafts', () => {
    expect(bulkPrecondition('delete', 'draft')).toEqual({ allowed: true });
    expect(bulkPrecondition('delete', 'sending')).toEqual({ allowed: false, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' });
    expect(bulkPrecondition('delete', 'completed')).toEqual({ allowed: false, code: 'CAMPAIGN_NOT_DRAFT', message: 'Only a draft campaign can be deleted.' });
  });

  it('allows cancel from the three in-flight statuses', () => {
    for (const status of ['scheduled', 'queued', 'sending'] as const) {
      expect(bulkPrecondition('cancel', status)).toEqual({ allowed: true });
    }
  });

  it('refuses cancel from every other status', () => {
    for (const status of ['draft', 'blocked', 'missed', 'validating', 'paused', 'completed', 'partial_failed', 'failed', 'cancelled'] as const) {
      expect(bulkPrecondition('cancel', status)).toEqual({ allowed: false, code: 'CAMPAIGN_NOT_CANCELLABLE', message: 'Campaign is not scheduled, queued or sending.' });
    }
  });

  it('allows duplicate from any status', () => {
    for (const status of ['draft', 'sending', 'completed', 'cancelled'] as const) {
      expect(bulkPrecondition('duplicate', status)).toEqual({ allowed: true });
    }
  });
});

describe('requiredBulkPermission', () => {
  it('maps each action to the permission the single-row route already requires', () => {
    const cases: Array<[CampaignBulkAction, string]> = [
      ['delete', 'content:manage'],
      ['duplicate', 'content:manage'],
      ['cancel', 'campaign:manage'],
    ];
    for (const [action, permission] of cases) expect(requiredBulkPermission(action)).toBe(permission);
  });
});

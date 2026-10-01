import { describe, expect, it } from 'vitest';
import type { CampaignDraft, CampaignScheduleValidationReport } from '../../api/campaigns.js';
import { localComposeValidation, preflightBlockers } from './compose-validation.js';

const draft = {
  id: 'draft-1', name: '', subject: '', templateId: null, templateVersionId: null, sender: {}, audience: {}, settings: {},
  status: 'draft', scheduledAtUtc: null, scheduledTimezone: null, scheduleLockWindowSeconds: 300,
  version: 0, completeness: 0, ownerId: 'owner-1', createdAt: '', updatedAt: '',
} as CampaignDraft;

describe('compose validation', () => {
  it('names every missing send requirement instead of leaving a disabled button unexplained', () => {
    expect(localComposeValidation(draft, 0).errors).toEqual(expect.objectContaining({
      name: expect.stringContaining('tên chiến dịch'), subject: expect.stringContaining('tiêu đề'),
      sender: expect.stringContaining('cấu hình gửi'), audience: expect.stringContaining('người nhận'),
      template: expect.stringContaining('template'),
    }));
  });

  it('turns authoritative preflight reasons into user-facing blockers', () => {
    const report = {
      blocking: true, name: { valid: true }, subject: { valid: true }, sender: { valid: false, reason: 'SENDER_NOT_VERIFIED' }, template: { valid: true },
      audience: { valid: false, totalUnique: 0, reason: 'AUDIENCE_EMPTY' },
      variables: { valid: true, missingCount: 0, waiverStatus: 'none' },
      quota: { valid: true, limit: null, used: 0, requested: 0 }, content: { valid: true, warnings: [] }, domain: { valid: true, warnings: [] },
    } as CampaignScheduleValidationReport;
    expect(preflightBlockers(report)).toEqual(['Cấu hình gửi chưa được xác thực.', 'Chưa có người nhận đủ điều kiện.']);
  });
});

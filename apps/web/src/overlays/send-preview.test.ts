import { describe, expect, it } from 'vitest';
import { buildPreviewMergeData, pickPreviewRecipient } from './send-preview.js';
import type { AudienceResolution } from '../api/campaigns.js';

describe('pickPreviewRecipient', () => {
  const actionable: AudienceResolution['sample'][number] = { recipientId: 'r2', normalizedEmail: 'b@x.test', displayName: 'B', subscriptionStatus: 'active', skipReason: null };
  const skipped: AudienceResolution['sample'][number] = { recipientId: 'r1', normalizedEmail: 'a@x.test', displayName: 'A', subscriptionStatus: 'unsubscribed', skipReason: 'status_unsubscribed' };

  it('returns the first sample entry with no skip reason, even when it is not first in the array', () => {
    expect(pickPreviewRecipient([skipped, actionable])?.recipientId).toBe('r2');
  });

  it('returns null when every sampled entry is skipped -- resolveAudience does not sort actionable-first, so an all-skipped sample is possible even when the full audience has actionable recipients beyond the sample limit', () => {
    expect(pickPreviewRecipient([skipped])).toBeNull();
  });

  it('returns null for an empty sample', () => {
    expect(pickPreviewRecipient([])).toBeNull();
  });
});

describe('buildPreviewMergeData (BR-CMP-005/008 preview parity with recipient-variable-context.ts)', () => {
  const recipient = { id: 'r1', email: 'minh.an@acme.vn', firstName: 'Minh An', lastName: null as string | null, customData: { department: 'Sales' } };

  it('carries a campaign override through for a key the recipient has no value for -- the defect this work fixes (ComposePreviewPanel never passed variableOverrides at all)', () => {
    const merged = buildPreviewMergeData(recipient, { cta_label: 'Đăng ký ngay' }, 'https://app.example.test');
    expect(merged.cta_label).toBe('Đăng ký ngay');
  });

  it("lets the recipient's own data win over a campaign override on a colliding key -- apps/api/src/campaigns/recipient-variable-context.ts spreads configuredValues (which includes overrides) first and customData last, so the recipient wins at real send time and the preview must match", () => {
    const merged = buildPreviewMergeData(recipient, { department: 'Marketing (giá trị mặc định)' }, 'https://app.example.test');
    expect(merged.department).toBe('Sales');
  });

  it('includes email and first_name, and omits last_name entirely when the recipient has none -- matching recipientVariableContext, so the renderer sees it as genuinely missing rather than the literal string "null"', () => {
    const merged = buildPreviewMergeData(recipient, {}, 'https://app.example.test');
    expect(merged.email).toBe('minh.an@acme.vn');
    expect(merged.first_name).toBe('Minh An');
    expect('last_name' in merged).toBe(false);
  });

  it('builds unsubscribe_url from the given web origin and recipient id, trimming a trailing slash the same way unsubscribeUrlFor does', () => {
    expect(buildPreviewMergeData(recipient, {}, 'https://app.example.test/').unsubscribe_url).toBe('https://app.example.test/unsubscribe/r1');
  });
});

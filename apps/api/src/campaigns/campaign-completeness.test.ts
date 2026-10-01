import { describe, expect, it } from 'vitest';
import { campaignCompleteness } from './campaign-completeness.js';

const completeDraft = {
  name: 'August renewal',
  subject: 'Your renewal is ready',
  templateVersionId: 'd76d3ac3-3ff3-47ae-a4a8-753038f902fe',
  sender: { fromEmail: 'ops@example.com' },
  audience: { listIds: ['d49dd83c-3fa8-4127-88c7-ec4de50e7ef6'] },
};

describe('campaignCompleteness', () => {
  it.each([
    ['a non-blank name', { ...completeDraft, name: '' }],
    ['a non-blank subject', { ...completeDraft, subject: '   ' }],
    ['a template version', { ...completeDraft, templateVersionId: null }],
    ['a sender', { ...completeDraft, sender: {} }],
    ['an audience definition', { ...completeDraft, audience: {} }],
  ])('removes exactly 20 points when missing %s', (_label, draft) => {
    expect(campaignCompleteness(draft)).toBe(80);
  });

  it('scores a name-only draft at 20', () => {
    expect(campaignCompleteness({ name: 'Internal campaign', subject: '', templateVersionId: null, sender: {}, audience: {} })).toBe(20);
  });

  it('scores all five independent components at 100', () => {
    expect(campaignCompleteness(completeDraft)).toBe(100);
  });

  it('treats every audience selector as sufficient without resolving it', () => {
    expect(campaignCompleteness({ ...completeDraft, audience: { tagIds: ['80326a7d-bf0e-4454-998d-96f32fbb149e'] } })).toBe(100);
    expect(campaignCompleteness({ ...completeDraft, audience: { recipientIds: ['c17f105e-a6aa-45ae-a6aa-6d462374be37'] } })).toBe(100);
  });

  it('accepts a sender config reference without resolving it', () => {
    expect(campaignCompleteness({ ...completeDraft, sender: { senderConfigId: '995e8f5b-a4f8-4568-a457-8b6f7cbd84a6' } })).toBe(100);
  });
});

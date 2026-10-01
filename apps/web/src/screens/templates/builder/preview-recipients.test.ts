import { describe, expect, it } from 'vitest';
import type { Recipient } from '../../../api/recipients.js';
import { PREVIEW_SYSTEM_SAMPLE, recipientCaption, recipientInitial, recipientLabel, recipientMergeData } from './preview-recipients.js';

/**
 * ADR-044 Task SV-5, MC-UI-008. The prototype's preview sheet is titled "Xem
 * trước bằng người nhận thật" and draws a recipient column beside the inbox
 * (`v3-preview-work` + `v3-inbox`) -- but backs it with three hard-coded
 * names, because a prototype has no tenant. EOW does, and `listRecipients`
 * has been there since S1, so the column lists real people and the preview
 * renders each one's own data.
 *
 * That makes `missingKeys` (BR-TPL-005) mean something for the first time in
 * the builder: with one fixed sample every template missed the same keys.
 */

const recipientOf = (over: Partial<Recipient> = {}): Recipient => ({
  id: 'r1',
  email: 'thu.ha@acme.vn',
  firstName: 'Thu Hà',
  lastName: 'Nguyễn',
  phone: null,
  department: 'Nhân sự',
  title: null,
  location: null,
  subscriptionStatus: 'active',
  customData: {},
  unsubscribedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
} as Recipient);

describe('recipientMergeData', () => {
  it('supplies the three keys the server itself maps from a recipient row', () => {
    expect(recipientMergeData(recipientOf())).toMatchObject({ email: 'thu.ha@acme.vn', first_name: 'Thu Hà', last_name: 'Nguyễn' });
  });

  it('omits a name the recipient does not have, so the preview can report it as missing', () => {
    expect(recipientMergeData(recipientOf({ firstName: null }))).not.toHaveProperty('first_name');
  });

  it('passes custom field values through under their own keys', () => {
    expect(recipientMergeData(recipientOf({ customData: { ma_nhan_vien: 'NV-0417' } }))).toMatchObject({ ma_nhan_vien: 'NV-0417' });
  });

  it('does not invent a variable out of department, which the send does not merge either', () => {
    expect(recipientMergeData(recipientOf({ department: 'Nhân sự' }))).not.toHaveProperty('department');
  });

  it('keeps a sample for the keys the send always generates, so they are not reported missing', () => {
    expect(recipientMergeData(recipientOf())).toMatchObject({ unsubscribe_url: PREVIEW_SYSTEM_SAMPLE.unsubscribe_url });
  });

  it('renders every value as a string, since merge data is substituted into text', () => {
    const merged = recipientMergeData(recipientOf({ customData: { so_ngay_phep: 12 } }));
    expect(merged.so_ngay_phep).toBe('12');
  });

  it('skips a custom value with nothing in it rather than merging an empty string', () => {
    expect(recipientMergeData(recipientOf({ customData: { ghi_chu: null } }))).not.toHaveProperty('ghi_chu');
  });
});

describe('recipientLabel', () => {
  it('reads family name first, the way Vietnamese names are written', () => {
    expect(recipientLabel(recipientOf())).toBe('Nguyễn Thu Hà');
  });

  it('falls back to the email when the row carries no name at all', () => {
    expect(recipientLabel(recipientOf({ firstName: null, lastName: null }))).toBe('thu.ha@acme.vn');
  });
});

describe('recipientInitial', () => {
  it('is the first letter of the displayed name, uppercased', () => {
    expect(recipientInitial(recipientOf())).toBe('N');
  });
});

describe('recipientCaption', () => {
  it('shows the department under the name', () => {
    expect(recipientCaption(recipientOf())).toBe('Nhân sự');
  });

  it('falls back to the em dash the prototype uses for someone with no department', () => {
    expect(recipientCaption(recipientOf({ department: null }))).toBe('—');
  });
});

import { describe, expect, it } from 'vitest';
import { notificationListQuerySchema } from './notification.dto.js';

/**
 * Regression for the "all" filter tab silently behaving as unread-only:
 * z.coerce.boolean() ran `Boolean(value)` on the raw query string, so the
 * literal string "false" (as sent by `GET /notifications?unread=false`)
 * coerced to `true`. Every real HTTP call passes strings, never JS booleans,
 * so this must be asserted against string input, not `{ unread: false }`.
 */
describe('notificationListQuerySchema', () => {
  it('parses the literal query string "false" as false', () => {
    expect(notificationListQuerySchema.parse({ unread: 'false' }).unread).toBe(false);
  });
  it('parses the literal query string "true" as true', () => {
    expect(notificationListQuerySchema.parse({ unread: 'true' }).unread).toBe(true);
  });
  it('defaults to false when unread is omitted', () => {
    expect(notificationListQuerySchema.parse({}).unread).toBe(false);
  });
});

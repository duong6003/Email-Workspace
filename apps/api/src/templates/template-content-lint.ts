/**
 * ADR-051. A runtime array the union is DERIVED from, not the other way
 * round -- the same fix `document.ts`'s `KINDS` gave block kinds. Before this,
 * `TemplateLintIssue['code']` was a bare literal union hand-copied into three
 * more places (`apps/web/src/api/templates.ts`, `contracts/openapi.yaml`,
 * `publish-readiness.ts`'s `LINT_ORDER`) with nothing checking they agreed,
 * and `LINT_ORDER` in particular is a plain array a new code can be added to
 * this file without ever touching -- it would compile, warn nowhere in the
 * publish sheet, and stay green. `ARCH-LINT-CODES`
 * (`packages/architecture-tests/src/mailcraft-fidelity.test.ts`) reads this
 * array to assert `LINT_ORDER` matches it exactly.
 */
export const LINT_CODES = ['HTML_SIZE_LARGE', 'HTML_SIZE_GMAIL_CLIP', 'TEXT_BODY_EMPTY', 'IMAGE_ALT_MISSING', 'LINK_TARGET_MISSING', 'LINK_PLACEHOLDER', 'LINK_INVALID', 'HEADING_ORDER_INVALID'] as const;
export type TemplateLintCode = (typeof LINT_CODES)[number];

export type TemplateLintIssue = {
  code: TemplateLintCode;
  severity: 'warning';
  count: number;
  field: 'html' | 'textBody';
};

const LARGE_HTML_WARNING_BYTES = 512 * 1024;
/**
 * ADR-051. Gmail clips a message past ~102KB of HTML AND hides everything
 * after the clip point -- including an unsubscribe link placed near the
 * footer, per the audit backlog §5. Mutually exclusive with
 * `HTML_SIZE_LARGE` below rather than both firing on the same oversized
 * email: past 512KB, "may be cut in some inboxes" already covers it, and a
 * second warning saying the same thing with a different number would read as
 * noise, not two facts.
 */
const GMAIL_CLIP_BYTES = 102 * 1024;

function linkTarget(tag: string): string | null {
  return tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i)?.[2]?.trim() ?? null;
}

function isValidLinkTarget(target: string): boolean {
  if (/^\{\{[a-z][a-z0-9_]{0,63}\}\}$/i.test(target)) return true;
  if (/^(?:mailto:|tel:)/i.test(target)) return target.length > target.indexOf(':') + 1;
  if (!/^https?:\/\//i.test(target)) return false;
  try {
    const parsed = new URL(target);
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * ADR-043 §8 (S6 Task 40). An image needs a description, or an explicit mark
 * saying it carries no information. The mark is `alt=""` together with
 * `role="presentation"` (or the equivalent `role="none"`), which is exactly
 * what `mark_decorative` emits -- both halves, because an empty alt on its own
 * reads the same to a screen reader whether it was deliberate or forgotten.
 *
 * The earlier rule only looked for a missing attribute, which meant it could
 * never fire on a builder document: the emitter always writes an alt, so an
 * undescribed image arrived as `alt=""` and passed. The inspector warned about
 * that image and this did not -- two answers to one question. §2.8 fixes the
 * SET of six codes; making one of them accurate does not add a seventh.
 */
function imageAltMissing(tag: string): boolean {
  const alt = /\balt\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2];
  if (alt === undefined) return true;
  if (alt.trim().length > 0) return false;
  return !/\brole\s*=\s*(["'])\s*(?:presentation|none)\s*\1/i.test(tag);
}

/**
 * ADR-051. Two distinct structural defects, one code -- both are "the
 * heading sequence is not a real outline" and both point at the same fix
 * (adjust `headingLevel`), unlike `LINK_TARGET_MISSING`/`LINK_PLACEHOLDER`/
 * `LINK_INVALID`'s three-way split (three different fixes). `count` is the
 * number of violations found, so an email with a missing H1 AND one skip
 * reports 2, not 1.
 *
 * Reads the HTML tag sequence directly, the same route every other code
 * here takes -- not the builder's `Doc` tree (`content-review.ts`'s
 * `locate()` cannot name a node for it, same as `HTML_SIZE_LARGE`). That is
 * what lets this fire on an `origin: 'imported'` template too, which never
 * had a tree at all.
 *
 * "No H1" only counts when there is at least one heading tag to begin with
 * -- a short promotional email built from a banner image and a button has
 * nothing to structure, and flagging that would be telling an author to add
 * a heading their design does not want.
 */
function headingOrderViolations(html: string): number {
  const levels = [...html.matchAll(/<h([1-4])\b/gi)].map((match) => Number(match[1]));
  if (levels.length === 0) return 0;
  let violations = levels.includes(1) ? 0 : 1; // no H1 ANYWHERE -- counts once, not once per heading beneath it
  for (let index = 1; index < levels.length; index += 1) {
    if (levels[index]! - levels[index - 1]! > 1) violations += 1;
  }
  return violations;
}

export function lintTemplateContent(input: { html: string; textBody: string }): TemplateLintIssue[] {
  const issues: TemplateLintIssue[] = [];
  const htmlBytes = Buffer.byteLength(input.html, 'utf8');
  if (htmlBytes > LARGE_HTML_WARNING_BYTES) issues.push({ code: 'HTML_SIZE_LARGE', severity: 'warning', count: 1, field: 'html' });
  else if (htmlBytes > GMAIL_CLIP_BYTES) issues.push({ code: 'HTML_SIZE_GMAIL_CLIP', severity: 'warning', count: 1, field: 'html' });
  if (input.textBody.trim().length === 0) issues.push({ code: 'TEXT_BODY_EMPTY', severity: 'warning', count: 1, field: 'textBody' });

  const headingViolations = headingOrderViolations(input.html);
  if (headingViolations > 0) issues.push({ code: 'HEADING_ORDER_INVALID', severity: 'warning', count: headingViolations, field: 'html' });

  const images = input.html.match(/<img\b[^>]*>/gi) ?? [];
  const imagesWithoutAlt = images.filter(imageAltMissing).length;
  if (imagesWithoutAlt > 0) issues.push({ code: 'IMAGE_ALT_MISSING', severity: 'warning', count: imagesWithoutAlt, field: 'html' });

  const links = input.html.match(/<a\b[^>]*>/gi) ?? [];
  const linksWithoutTarget = links.filter((tag) => linkTarget(tag) === null).length;
  if (linksWithoutTarget > 0) issues.push({ code: 'LINK_TARGET_MISSING', severity: 'warning', count: linksWithoutTarget, field: 'html' });
  const placeholderLinks = links.filter((tag) => /\bhref\s*=\s*(["'])\s*(?:#|javascript:void\(0\)|https?:\/\/(?:example\.com|example\.test)\/?)\s*\1/i.test(tag)).length;
  if (placeholderLinks > 0) issues.push({ code: 'LINK_PLACEHOLDER', severity: 'warning', count: placeholderLinks, field: 'html' });
  const invalidLinks = links.filter((tag) => {
    const target = linkTarget(tag);
    return target !== null && !/^\s*(?:#|javascript:void\(0\)|https?:\/\/(?:example\.com|example\.test)\/?)\s*$/i.test(target) && !isValidLinkTarget(target);
  }).length;
  if (invalidLinks > 0) issues.push({ code: 'LINK_INVALID', severity: 'warning', count: invalidLinks, field: 'html' });
  return issues;
}

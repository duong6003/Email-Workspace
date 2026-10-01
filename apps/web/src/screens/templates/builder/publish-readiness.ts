import { LINT_MESSAGE } from '../lint-messages.js';
import type { TemplateAnalysis } from '../../../api/templates.js';
import { assetSizeLabel } from './assets.js';
import { defaultTheme, type Doc, type Node } from './document.js';
import { lowContrastNodeIds } from './content-contrast.js';

/**
 * S9 Task 52's pre-publish readiness sheet -- the calculation behind it, not
 * the screen. The author clicks "Xuất bản", sees an inventory of what blocks
 * and what only warns, then confirms; a subagent working `ComposeDraftScreen`
 * wires the display, this file only decides the verdict.
 *
 * **Who decides what, continued from `content-review.ts`.** That module
 * already drew the line for the review panel: the server counts
 * (`analysis.lint`, `analysis.unknownVariables`, `analysis.validation`), this
 * layer decides which of those stop the publish click. §2.9 makes that line
 * explicit for one of them -- an unknown variable blocks, a lint warning never
 * does, because every `lint` row is typed `severity: 'warning'` at the
 * contract level and none of the six codes is an error. The server ALREADY
 * enforces `UNKNOWN_VARIABLE` at `templates.service.ts` publish time; this
 * only surfaces the same refusal before the click instead of after a 4xx.
 *
 * **Two rules the server enforces or half-defines but never states as a
 * pre-flight.** The 5 MB ceiling is real -- `template-html-sanitizer.ts`
 * (`MAX_TEMPLATE_HTML_BYTES`) throws past it on save -- but nothing told the
 * author before they clicked.
 *
 * **ADR-050 adds a second legal pre-flight, checked against the tree rather
 * than the rendered markup.** BR-TPL-008 has a real token to regex for
 * (`{{unsubscribe_url}}`); CAN-SPAM's physical-address requirement does not --
 * the address is real author-entered content, not a variable, so there is no
 * marker to sniff reliably out of arbitrary HTML. `hasPostalAddress` below
 * reads `draft.doc` instead, the same tree `freezeSummary` already takes as a
 * parameter, and checks the one field the law requires (`footer.address`) on
 * a VISIBLE `footer` node -- a hidden one renders nothing (`emitNode` drops
 * `visible: false`), so it must not satisfy the law either.
 *
 * BR-TPL-008 (missing `unsubscribe_url`) BLOCKS since ADR-049, and the reason
 * it used to warn is worth keeping because it was wrong in a specific,
 * checkable way. This comment said: "the failure it prevents happens at SEND,
 * not at publish, so blocking publish over it would stop the wrong step", and
 * the warning told the author the send "sẽ bị chặn khi gửi". Measured
 * 2026-09-11: **nothing blocks that send.** There is no such gate anywhere in
 * `apps/api` or `apps/worker`. The step this was deferring to did not exist,
 * so deferring to it meant nobody checked at all -- and the message stated a
 * guarantee the product did not offer.
 *
 * It can block now because ADR-049 also built the thing that makes the
 * requirement meaningful: a template without the token is one whose recipients
 * have no way to opt out, and publish is the last point at which that is still
 * cheap to fix.
 *
 * **What this module does NOT re-implement.** `HTML_SIZE_LARGE` (>=512 KB)
 * and `TEXT_BODY_EMPTY` already arrive as lint codes from the server
 * (`template-content-lint.ts`); re-deriving either one locally would risk a
 * second opinion that disagrees with the server's, which is worse than not
 * checking at all. Both simply flow through the same lint-to-warning mapping
 * as the other four codes.
 */

export type PublishItemLevel = 'blocking' | 'warning';

export type PublishReadinessItem = {
  /** Stable across re-analysis of the same draft -- a React key and an e2e selector both need it to hold still. */
  id: string;
  level: PublishItemLevel;
  /** Vietnamese, shown to the author verbatim. */
  message: string;
};

export type PublishReadiness = {
  /** What the screen needs first: whether the confirm button may be pressed at all, without the caller re-counting `blocking`. */
  canPublish: boolean;
  /** Every row, in the module's fixed priority order -- see `publishReadiness` below. */
  items: PublishReadinessItem[];
  blocking: PublishReadinessItem[];
  warnings: PublishReadinessItem[];
};

/** The three fields `BuilderScreen.publish()` already guards with `requiredText`, brought forward so the sheet can say the same thing before the click lands on a disabled button. */
export type PublishDraft = {
  name: string;
  subject: string;
  html: string;
  textBody: string;
  /** ADR-050. `hasPostalAddress` reads this tree; the caller already has it (see `freezeSummary` below, which takes the same `Doc`). */
  doc: Doc;
};

/** Only the three `TemplateAnalysis` fields this module reads, so a caller (or a test) can pass a stub without inventing a sanitized document or a variable catalogue. */
export type PublishAnalysisInput = Pick<TemplateAnalysis, 'validation' | 'unknownVariables' | 'lint'>;

type LintCode = TemplateAnalysis['lint'][number]['code'];

/**
 * `MAX_TEMPLATE_HTML_BYTES` in `apps/api/src/templates/template-html-sanitizer.ts`.
 * Duplicated, not imported: `apps/web` and `apps/api` are separate deployable
 * packages, the same reason `template-thumbnail.ts` duplicates the server's
 * 512 KB constant rather than reaching across the boundary for it.
 */
const MAX_HTML_BYTES = 5 * 1024 * 1024;

/**
 * ADR-050. Walks the WHOLE tree, not just top-level nodes -- a footer sits
 * inside a section/column in real documents, the same reason `countNodes`
 * below recurses. `node.visible === false` is excluded on purpose: an
 * invisible footer emits nothing (`emitNode`), so a recipient never receives
 * the address it names and the requirement is not actually met.
 */
function hasPostalAddress(nodes: readonly Node[]): boolean {
  return nodes.some((node) => {
    if (node.visible === false) return false;
    if (node.kind === 'footer' && node.footer?.address?.trim()) return true;
    return hasPostalAddress(node.children ?? []);
  });
}

/** Byte length, not string length -- a multi-byte character (Vietnamese diacritics included) is more than one UTF-16 code unit but the sanitizer's ceiling is a wire-size limit, not a character count. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Presence only, matching how `parseTemplateVariableTokens` accepts the token: `{{unsubscribe_url}}` or `{{ unsubscribe_url }}` with either amount of internal whitespace. */
const UNSUBSCRIBE_TOKEN = /\{\{\s*unsubscribe_url\s*\}\}/;

/**
 * Canonical order for the lint codes, independent of whatever order
 * `analysis.lint` happens to arrive in. Matches `LINT_MESSAGE`'s own key
 * order for the original six (spec §2.8 listing order); ADR-051's two are
 * appended beside the code they extend (`HEADING_ORDER_INVALID` next to the
 * other structural/accessibility code, `HTML_SIZE_GMAIL_CLIP` next to the
 * other size code, since `template-content-lint.ts` never emits both size
 * codes for the same email).
 *
 * NOT compiler-enforced against `LINT_CODES`
 * (`apps/api/src/templates/template-content-lint.ts`) the way `LINT_MESSAGE`
 * is -- `ARCH-LINT-CODES` (`mailcraft-fidelity.test.ts`) is the mechanized
 * check that this array cannot silently fall out of sync with it. Exported
 * only so that gate can read it; nothing else outside this module should
 * need the order.
 */
export const LINT_ORDER: readonly LintCode[] = ['IMAGE_ALT_MISSING', 'HEADING_ORDER_INVALID', 'LINK_TARGET_MISSING', 'LINK_PLACEHOLDER', 'LINK_INVALID', 'TEXT_BODY_EMPTY', 'HTML_SIZE_LARGE', 'HTML_SIZE_GMAIL_CLIP'];

/**
 * The pre-publish verdict. Order is a fixed priority, never the incoming
 * arrays' own order, so two analyses that report the same facts in a
 * different array order produce byte-identical output:
 *
 * 1. the three required fields (name, subject, html) -- cheapest to fix, and
 *    the same three `BuilderScreen.publish()` already checks;
 * 2. the 5 MB hard ceiling -- computed from the draft directly, so it applies
 *    even before any analysis has returned;
 * 3. either "analysis pending" (analysis === null) OR, once an analysis has
 *    arrived, its unknown variables and then its validation errors -- the two
 *    facts that cannot be known before the round trip completes;
 * 4. the lint warnings, in `LINT_ORDER`;
 * 5. the BR-TPL-008 check, computed from the draft directly like the size
 *    ceiling, so it too does not wait on the analysis. Blocking since ADR-049;
 *    it is pushed onto `blocking` and therefore reads before the lint warnings
 *    in `items`, despite being computed last.
 * 6. the ADR-050 postal-address check, computed from `draft.doc` directly for
 *    the same reason as 5 -- it too does not wait on the analysis, and it too
 *    reads before the lint warnings despite being computed last.
 */
export function publishReadiness(draft: PublishDraft, analysis: PublishAnalysisInput | null): PublishReadiness {
  const blocking: PublishReadinessItem[] = [];
  const warnings: PublishReadinessItem[] = [];

  if (!draft.name.trim()) blocking.push({ id: 'MISSING_NAME', level: 'blocking', message: 'Nhập tên template để lưu bản nháp.' });
  if (!draft.subject.trim()) blocking.push({ id: 'MISSING_SUBJECT', level: 'blocking', message: 'Nhập tiêu đề email trước khi xuất bản.' });
  if (!draft.html.trim()) blocking.push({ id: 'MISSING_HTML', level: 'blocking', message: 'Thêm nội dung trước khi xuất bản.' });

  if (utf8ByteLength(draft.html) > MAX_HTML_BYTES) {
    blocking.push({ id: 'HTML_TOO_LARGE', level: 'blocking', message: `HTML vượt quá giới hạn ${assetSizeLabel(MAX_HTML_BYTES)} — rút gọn nội dung hoặc ảnh nhúng trước khi xuất bản.` });
  }

  if (!analysis) {
    blocking.push({ id: 'ANALYSIS_PENDING', level: 'blocking', message: 'Đang phân tích nội dung, vui lòng chờ trước khi xuất bản.' });
  } else {
    // One row per KEY, not per occurrence -- the same undeclared
    // `{{ten_sep}}` written four times is one thing to fix, matching
    // `content-review.ts`'s `reviewIssues`.
    const unknownKeys = [...new Set(analysis.unknownVariables.map((occurrence) => occurrence.key))];
    for (const key of unknownKeys) {
      blocking.push({ id: `unknown:${key}`, level: 'blocking', message: `Biến {{${key}}} chưa được khai báo — đây là biến lạ, máy chủ sẽ từ chối xuất bản nếu không sửa (§2.9).` });
    }

    analysis.validation.errors.forEach((message, index) => {
      blocking.push({ id: `validation:${index}`, level: 'blocking', message });
    });

    const byCode = new Map(analysis.lint.map((issue) => [issue.code, issue]));
    for (const code of LINT_ORDER) {
      const issue = byCode.get(code);
      if (issue) warnings.push({ id: `lint:${code}`, level: 'warning', message: LINT_MESSAGE[code](issue.count) });
    }
  }

  if (!UNSUBSCRIBE_TOKEN.test(draft.html) && !UNSUBSCRIBE_TOKEN.test(draft.textBody)) {
    blocking.push({
      id: 'MISSING_UNSUBSCRIBE_URL',
      level: 'blocking',
      message: 'Thiếu {{unsubscribe_url}} trong nội dung — người nhận sẽ không có cách nào tự hủy đăng ký. Chèn biến này vào email (thường đặt ở chân thư) trước khi xuất bản (BR-TPL-008).',
    });
  }

  // ADR-050, computed from the tree directly like the check above, so it too
  // does not wait on the analysis round trip.
  if (!hasPostalAddress(draft.doc.nodes)) {
    blocking.push({
      id: 'MISSING_POSTAL_ADDRESS',
      level: 'blocking',
      message: 'Thiếu địa chỉ bưu chính trong chân thư — luật chống thư rác (CAN-SPAM) đòi email thương mại phải có địa chỉ vật lý thật. Thêm khối "Chân thư" và điền địa chỉ trước khi xuất bản.',
    });
  }

  // ADR-051. Client-computed, like the two checks above -- but a WARNING, not
  // a blocking row: low contrast makes an email harder to read, it does not
  // make it illegal or non-functional the way a missing opt-out does. Not a
  // server lint code either (`analysis.lint` never carries it): contrast
  // needs the effective background a node inherits from its ancestors, which
  // only the tree can answer -- the same "tree, not regex" reasoning
  // `hasPostalAddress`'s own doc comment gives.
  const lowContrast = lowContrastNodeIds(draft.doc.nodes, (draft.doc.theme ?? defaultTheme).contentBg);
  if (lowContrast.length > 0) {
    warnings.push({
      id: 'LOW_CONTRAST_TEXT',
      level: 'warning',
      message: `${lowContrast.length} khối có màu chữ tương phản thấp với nền (dưới chuẩn WCAG AA) — khó đọc trong ánh sáng mạnh hoặc với người khiếm thị màu.`,
    });
  }

  return { canPublish: blocking.length === 0, items: [...blocking, ...warnings], blocking, warnings };
}

export type FreezeSummary = {
  /** The version number publish is about to create. A template that has never published has `currentVersion: 0`, so this reads 1 -- publish always creates version 1 first, never version 0. */
  nextVersion: number;
  /** Distinct variable keys, not occurrences -- the same key used ten times is one thing to have configured, not ten. */
  variableCount: number;
  /** Human-readable, same formatting `assets.ts` already uses for the asset library so the two don't teach the reader two different size conventions. */
  htmlSizeLabel: string;
  /** Every node in the document, containers included -- the count the structure tree would list one row per. */
  blockCount: number;
};

function countNodes(nodes: readonly Node[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children ?? []), 0);
}

/**
 * The "what is about to be frozen" strip the user settled on 2026-09-06: four
 * boxes carrying real EOW facts (next version, variable count, HTML size,
 * block count) in place of the prototype's "Provider: mailcraft / Resource:
 * email_template" -- a model that has no counterpart anywhere in EOW.
 *
 * Every input is a parameter on purpose: this module does not call the API.
 * The caller (the screen wiring this in) already has the current version
 * number, the document, the emitted HTML and the variable keys from whatever
 * analysis it already ran.
 */
export function freezeSummary(input: { currentVersion: number; doc: Doc; html: string; variableKeys: readonly string[] }): FreezeSummary {
  return {
    nextVersion: input.currentVersion + 1,
    variableCount: new Set(input.variableKeys).size,
    htmlSizeLabel: assetSizeLabel(utf8ByteLength(input.html)),
    blockCount: countNodes(input.doc.nodes),
  };
}

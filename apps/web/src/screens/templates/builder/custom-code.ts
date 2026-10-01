/**
 * The live feedback behind MC-UI-011's code panel -- `v3-pipeline`,
 * `v3-code-result` and the two tabs of `v3-code-tabs` (ADR-044 Task SV-5).
 *
 * **This is a pre-flight, never the verdict.** The sanitizer on the server is
 * the only thing that decides what reaches a recipient (spec §2.12: no bypass
 * for `origin: 'builder'`), and `CustomHtmlEditor`'s "Xác thực" button already
 * calls it. What the prototype adds, and S4 had no equivalent for, is that the
 * panel reacts while the author TYPES: a `<script>` tag turns the banner red
 * on the keystroke, not on a round trip. So these rules deliberately screen
 * for a subset of what the server strips -- the four constructs that make a
 * fragment unusable outright -- and say so, rather than pretending to be a
 * second sanitizer that could drift out of step with the real one.
 *
 * **One divergence from the prototype, and why.** `studio.tsx` renders the
 * pipeline strip with two states only: every step "done", or step 1 "active"
 * when blocked -- because nothing there validates anything, the strip is
 * decoration over a regex. EOW has a real server validation behind the button,
 * so the strip reports where the content actually is: blocked at Sanitize,
 * waiting at Validate, or through to Preview. Same four labels, same DOM, same
 * classes; the states behind them mean something. ADR-044 clause 3 is about
 * DOM and class names, and both are ported verbatim.
 */

export type CodeTab = 'html' | 'css';

export type CodeScreen = {
  /** True when a construct is present that the sanitizer removes outright, so applying it would silently lose content. */
  blocked: boolean;
  /** One line per blocking construct, each naming the tab it is in. */
  reasons: string[];
  /** Email-deliverability advice. Never blocks -- the fragment is valid, just unwise. */
  warnings: string[];
};

export type PipelineStatus = 'done' | 'active' | 'pending';
export type PipelineStep = { label: string; status: PipelineStatus };

/** The prototype's four stages, verbatim and in order. */
export const CODE_PIPELINE_LABELS = ['Parse', 'Sanitize', 'Validate', 'Preview'] as const;

/** Executable markup: script/form elements, `on*=` handlers, `javascript:` targets -- the prototype's own screen, split per construct so the banner can name what it found. */
const HTML_BLOCKERS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /<script\b/i, reason: 'HTML: thẻ <script> sẽ bị loại bỏ hoàn toàn.' },
  { pattern: /<form\b/i, reason: 'HTML: thẻ <form> sẽ bị loại bỏ — hộp thư không gửi biểu mẫu.' },
  { pattern: /\son\w+\s*=/i, reason: 'HTML: thuộc tính sự kiện (onclick, onload…) sẽ bị loại bỏ.' },
  { pattern: /javascript:/i, reason: 'HTML: liên kết javascript: sẽ bị loại bỏ.' },
];

const CSS_BLOCKERS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /@import/i, reason: 'CSS: @import kéo tệp ngoài, sẽ bị loại bỏ.' },
  { pattern: /expression\s*\(/i, reason: 'CSS: expression() là mã thực thi, sẽ bị loại bỏ.' },
];

export function screenCustomCode({ html, css }: { html: string; css: string }): CodeScreen {
  const reasons = [
    ...HTML_BLOCKERS.filter((rule) => rule.pattern.test(html)).map((rule) => rule.reason),
    ...CSS_BLOCKERS.filter((rule) => rule.pattern.test(css)).map((rule) => rule.reason),
  ];

  // An empty editor is not a mistake -- the author has simply not started.
  // Warning about a missing <table> in an empty box would train them to ignore
  // the banner before they have written anything for it to be about.
  const warnings = html.trim()
    ? [
        !/<table\b/i.test(html) ? 'Nên dùng <table> cho bố cục email — Outlook bỏ qua phần lớn bố cục bằng div.' : '',
        /href=["']#["']/i.test(html) ? 'Còn liên kết mẫu href="#" chưa thay bằng địa chỉ thật.' : '',
      ].filter(Boolean)
    : [];

  return { blocked: reasons.length > 0, reasons, warnings };
}

/**
 * @param validated whether the server has validated the content in its CURRENT
 * state. Any edit resets it, which is what re-opens the Validate step -- a
 * strip still reading "done" after the author typed would be reporting on
 * content that no longer exists.
 */
export function codePipeline(screen: CodeScreen, validated: boolean): PipelineStep[] {
  const statuses: PipelineStatus[] = screen.blocked
    ? ['done', 'active', 'pending', 'pending']
    : validated
      ? ['done', 'done', 'done', 'done']
      : ['done', 'done', 'active', 'pending'];
  return CODE_PIPELINE_LABELS.map((label, index) => ({ label, status: statuses[index] as PipelineStatus }));
}

export function codeResult(screen: CodeScreen): { level: 'ok' | 'warn' | 'error'; message: string } {
  if (screen.blocked) return { level: 'error', message: `⊘ ${screen.reasons.join(' ')}` };
  if (screen.warnings.length > 0) return { level: 'warn', message: `⚠ ${screen.warnings.join(' ')}` };
  return { level: 'ok', message: '✓ Mã sẵn sàng áp dụng.' };
}

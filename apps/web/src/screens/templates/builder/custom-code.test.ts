import { describe, expect, it } from 'vitest';
import { CODE_PIPELINE_LABELS, codePipeline, codeResult, screenCustomCode } from './custom-code.js';

/**
 * ADR-044 Task SV-5, MC-UI-011. The prototype's code panel carries a four-step
 * pipeline strip (`v3-pipeline`), a two-tab switcher (`v3-code-tabs`) and a
 * verdict banner (`v3-code-result`) that all react as the author types. S4
 * shipped the editor and a server "Xác thực" button but none of that
 * feedback, so this is the arithmetic behind it.
 */

describe('screenCustomCode', () => {
  it('passes ordinary email markup', () => {
    const screen = screenCustomCode({ html: '<table><tr><td>Xin chào</td></tr></table>', css: 'td{color:#173f33}' });
    expect(screen.blocked).toBe(false);
    expect(screen.reasons).toEqual([]);
  });

  it('blocks a script tag', () => {
    expect(screenCustomCode({ html: '<script>alert(1)</script>', css: '' }).blocked).toBe(true);
  });

  it('blocks an inline event handler', () => {
    expect(screenCustomCode({ html: '<p onclick="x()">Bấm</p>', css: '' }).blocked).toBe(true);
  });

  it('blocks a javascript: target', () => {
    expect(screenCustomCode({ html: '<a href="javascript:x()">Bấm</a>', css: '' }).blocked).toBe(true);
  });

  it('blocks a form, which no mailbox will submit anyway', () => {
    expect(screenCustomCode({ html: '<form><input></form>', css: '' }).blocked).toBe(true);
  });

  it('blocks @import in the css tab', () => {
    expect(screenCustomCode({ html: '<p>Xin chào</p>', css: '@import url(https://evil.test/x.css);' }).blocked).toBe(true);
  });

  it('names every reason it blocked on, so the banner can say which tab to fix', () => {
    const screen = screenCustomCode({ html: '<script>a</script>', css: 'a{b:expression(c)}' });
    expect(screen.reasons).toHaveLength(2);
    expect(screen.reasons.join(' ')).toMatch(/HTML/);
    expect(screen.reasons.join(' ')).toMatch(/CSS/);
  });

  it('warns about layout without a table, without blocking it', () => {
    const screen = screenCustomCode({ html: '<div>Xin chào</div>', css: '' });
    expect(screen.blocked).toBe(false);
    expect(screen.warnings.join(' ')).toMatch(/table/i);
  });

  it('warns about a leftover placeholder link', () => {
    expect(screenCustomCode({ html: '<table><tr><td><a href="#">Bấm</a></td></tr></table>', css: '' }).warnings.join(' ')).toMatch(/#/);
  });

  it('says nothing about an empty editor -- an author who has typed nothing has done nothing wrong', () => {
    const screen = screenCustomCode({ html: '', css: '' });
    expect(screen.blocked).toBe(false);
    expect(screen.warnings).toEqual([]);
  });
});

describe('codePipeline', () => {
  it('names the prototype\'s four stages in order', () => {
    expect(CODE_PIPELINE_LABELS).toEqual(['Parse', 'Sanitize', 'Validate', 'Preview']);
  });

  it('stops at Sanitize while the content is blocked', () => {
    const steps = codePipeline(screenCustomCode({ html: '<script>a</script>', css: '' }), false);
    expect(steps.map((step) => step.status)).toEqual(['done', 'active', 'pending', 'pending']);
  });

  it('waits on Validate until the server has actually been asked', () => {
    const steps = codePipeline(screenCustomCode({ html: '<table><tr><td>Hi</td></tr></table>', css: '' }), false);
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'active', 'pending']);
  });

  it('completes once the server has validated clean content', () => {
    const steps = codePipeline(screenCustomCode({ html: '<table><tr><td>Hi</td></tr></table>', css: '' }), true);
    expect(steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('re-opens Validate when the content is edited after a validation', () => {
    const steps = codePipeline(screenCustomCode({ html: '<div>Đã sửa</div>', css: '' }), false);
    expect(steps[2]?.status).toBe('active');
  });
});

describe('codeResult', () => {
  it('is an error, naming the reason, when blocked', () => {
    const result = codeResult(screenCustomCode({ html: '<script>a</script>', css: '' }));
    expect(result.level).toBe('error');
    expect(result.message).toMatch(/HTML/);
  });

  it('is a warning that carries the warnings themselves', () => {
    const result = codeResult(screenCustomCode({ html: '<div>Xin chào</div>', css: '' }));
    expect(result.level).toBe('warn');
    expect(result.message).toMatch(/table/i);
  });

  it('is ok for clean content', () => {
    expect(codeResult(screenCustomCode({ html: '<table><tr><td>Hi</td></tr></table>', css: '' })).level).toBe('ok');
  });

  it('prefers the error over the warnings when both are present', () => {
    expect(codeResult(screenCustomCode({ html: '<div onclick="x()">Hi</div>', css: '' })).level).toBe('error');
  });
});

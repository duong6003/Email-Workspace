import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read } from './repo.js';

/**
 * ARCH-RBAC: every HTTP route must declare its access posture explicitly —
 * either @Public() or @RequirePermission(...). BR-AUTH-004 ("API kiểm quyền
 * phía server, không dựa vào việc ẩn nút trên UI") and DEC-026's deny-by-default
 * decision.
 *
 * PermissionGuard already denies an undeclared route at runtime, so this test is
 * not the safety net — it is the feedback loop. Without it, forgetting a
 * decorator surfaces as a confusing 403 the first time someone exercises the
 * endpoint (possibly in a later milestone, possibly in manual QA), instead of a
 * named failure at `pnpm check` time in the same edit that introduced it.
 */
const ROUTE_DECORATOR = /@(Get|Post|Patch|Put|Delete)\s*\(/g;

describe('ARCH-RBAC: every route declares its access posture (BR-AUTH-004, DEC-026)', () => {
  it('has no controller route missing both @Public() and @RequirePermission()', () => {
    const controllers = listFiles('apps/api/src', ['.ts']).filter(
      (file) => read(file).includes('@Controller') && !file.endsWith('.test.ts'),
    );
    expect(controllers.length, 'no controllers found — the scanner path is probably wrong').toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of controllers) {
      const source = read(file);
      const lines = source.split(/\r?\n/);

      lines.forEach((line, index) => {
        ROUTE_DECORATOR.lastIndex = 0;
        if (!ROUTE_DECORATOR.test(line)) return;

        // Decorators stack in any order around the handler — in this codebase
        // @Public()/@RequirePermission() sits *below* @Post(...), so the block
        // must be scanned in both directions, not just upward.
        const isDecoratorOrTrivia = (value: string): boolean =>
          value.startsWith('@') || value.startsWith('//') || value.startsWith('*') || value.startsWith('/*') || value === '';

        let start = index;
        while (start - 1 >= 0 && isDecoratorOrTrivia(lines[start - 1]!.trim())) start -= 1;
        let end = index;
        while (end + 1 < lines.length && isDecoratorOrTrivia(lines[end + 1]!.trim())) end += 1;

        const block = lines.slice(start, end + 1).join('\n');
        const declared = block.includes('@Public(') || block.includes('@RequirePermission(');

        if (!declared) violations.push(`${file}:${index + 1}  ${line.trim().slice(0, 80)}`);
      });
    }

    expect(
      violations,
      `Route(s) declare neither @Public() nor @RequirePermission(). Deny-by-default means these are ` +
        `rejected at runtime, which is safe but silent — declare the intent explicitly:${describeViolations(violations)}`,
    ).toEqual([]);
  });
});

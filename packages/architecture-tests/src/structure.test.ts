import { basename, dirname, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read, REPO_ROOT } from './repo.js';

describe('repository structure', () => {
  it('ARCH-NO-LOOSE-FEATURES keeps API features out of the src root', () => {
    const violations = listFiles('apps/api/src', ['.ts']).filter((file) => {
      if (dirname(file).replaceAll('\\', '/') !== 'apps/api/src') return false;
      return /\.(controller|service|gateway)\.ts$/.test(file);
    });
    expect(violations, `Loose API feature files:${describeViolations(violations)}`).toEqual([]);
  });

  it('ARCH-MODULE gives every controller a module, service and dto directory', () => {
    const controllers = listFiles('apps/api/src', ['.controller.ts']);
    const allFiles = new Set(listFiles('apps/api/src', ['.ts']));
    const violations: string[] = [];
    for (const controller of controllers) {
      if (controller.includes('/auth/')) continue;
      const dir = dirname(controller).replaceAll('\\', '/');
      const stem = basename(controller, '.controller.ts');
      const moduleStem = dir.endsWith('/jobs') ? 'jobs' : stem;
      const hasModule = allFiles.has(`${dir}/${moduleStem}.module.ts`);
      const hasService = [...allFiles].some((file) => file.startsWith(`${dir}/`) && file.endsWith('.service.ts'));
      const hasDto = [...allFiles].some((file) => file.startsWith(`${dir}/dto/`));
      if (!hasModule || !hasService || !hasDto) violations.push(`${controller} module=${hasModule} service=${hasService} dto=${hasDto}`);
    }
    expect(violations, `Incomplete API modules:${describeViolations(violations)}`).toEqual([]);
  });

  it('ARCH-LAYERING keeps database entities out of controllers', () => {
    const violations = listFiles('apps/api/src', ['.controller.ts'])
      .filter((file) => /database\/entities\//.test(read(file)));
    expect(violations, `Controllers importing database entities:${describeViolations(violations)}`).toEqual([]);
  });

  it('ARCH-WEB-STRUCTURE keeps only the web entry point at src root', () => {
    const allowed = new Set(['apps/web/src/main.tsx']);
    const violations = listFiles('apps/web/src', ['.ts', '.tsx', '.css']).filter(
      (file) => dirname(file).replaceAll('\\', '/') === 'apps/web/src' && !allowed.has(file),
    );
    expect(violations, `Loose web source files:${describeViolations(violations)}`).toEqual([]);
  });

  it('ARCH-NO-ORPHANS reaches every production web module from main.tsx', () => {
    const files = listFiles('apps/web/src', ['.ts', '.tsx']).filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.d.ts'));
    const sourceSet = new Set(files);
    const reached = new Set<string>();
    const visit = (file: string): void => {
      if (reached.has(file)) return;
      reached.add(file);
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      const specs: string[] = [];
      const collect = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text);
        ts.forEachChild(node, collect);
      };
      collect(source);
      for (const spec of specs.filter((value) => value.startsWith('.'))) {
        const base = posix.normalize(posix.join(dirname(file).replaceAll('\\', '/'), spec));
        const withoutExtension = base.replace(/\.(js|ts|tsx)$/, '');
        const candidates = [withoutExtension, `${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${withoutExtension}/index.ts`, `${withoutExtension}/index.tsx`];
        const resolved = candidates.find((candidate) => sourceSet.has(candidate));
        if (resolved) visit(resolved);
      }
    };
    visit('apps/web/src/main.tsx');
    const violations = files.filter((file) => !reached.has(file));
    expect(violations, `Orphan web modules:${describeViolations(violations)}`).toEqual([]);
    expect(REPO_ROOT.length).toBeGreaterThan(0);
  });
});

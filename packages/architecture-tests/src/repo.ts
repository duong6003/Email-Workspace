import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, sep } from 'node:path';

/** Repository root, resolved from this file rather than cwd so the suite is runnable from anywhere. */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.wrangler', '.vinext', '.openai']);

/** Recursively lists files under `dir` (repo-relative), skipping build output and vendored trees. */
export function listFiles(dir: string, extensions: readonly string[]): string[] {
  const absolute = resolve(REPO_ROOT, dir);
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return; // A directory that does not exist yet is not a violation.
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = resolve(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.endsWith(extension))) out.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  walk(absolute);
  return out.sort();
}

export function read(repoRelativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, repoRelativePath), 'utf8');
}

/** Formats violations so a failing assertion names every offending file, not just a count. */
export function describeViolations(violations: readonly string[]): string {
  return `\n  - ${violations.join('\n  - ')}\n`;
}

import { describe, expect, it } from 'vitest';
import { describeViolations, read } from './repo.js';

/**
 * ARCH-VARIABLE-FORMAT-TOKENS (ADR-036).
 *
 * The date patterns a settings form offers live in apps/web; the parser that
 * decides whether a pattern is usable lives in apps/api. apps/web cannot import
 * apps/api (rootDir "src", no shared workspace package between them), so the
 * two are coupled only by convention -- the same arrangement ARCH-EXPORT-PARITY
 * guards for the export renderer.
 *
 * The failure this prevents is quiet and user-facing in the worst way: a preset
 * spelled with a token the API does not recognise (`DD`, `YYYY` -- the moment.js
 * habit the API deliberately rejects) makes the save button return a 400 the
 * author cannot act on, and a preset the API *does* accept but that means
 * something else puts a wrong date in a real email.
 */
const API_FILE = 'apps/api/src/templates/variable-value-format.ts';
const WEB_FILE = 'apps/web/src/api/variable-formatting.ts';

function apiTokens(): string[] {
  const source = read(API_FILE);
  const declaration = /const DATE_FORMAT_TOKENS = \[([^\]]*)\]/.exec(source);
  if (!declaration) throw new Error(`DATE_FORMAT_TOKENS not found in ${API_FILE}`);
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function webPresets(): Array<{ value: string; sample: string }> {
  const source = read(WEB_FILE);
  const declaration = /const DATE_FORMAT_PRESETS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  if (!declaration) throw new Error(`DATE_FORMAT_PRESETS not found in ${WEB_FILE}`);
  return [...declaration[1].matchAll(/\{\s*value:\s*'([^']+)',\s*sample:\s*'([^']+)'\s*\}/g)]
    .map((match) => ({ value: match[1], sample: match[2] }));
}

/** Consumes the pattern the way the API's own scanner does: longest token first, everything else literal. */
function unrecognizedLetters(pattern: string, tokens: readonly string[]): string[] {
  const ordered = [...tokens].sort((left, right) => right.length - left.length);
  const offenders: string[] = [];
  let index = 0;
  while (index < pattern.length) {
    const token = ordered.find((candidate) => pattern.startsWith(candidate, index));
    if (token) {
      index += token.length;
      continue;
    }
    const word = /^[A-Za-z]+/.exec(pattern.slice(index));
    if (word) {
      offenders.push(word[0]);
      index += word[0].length;
      continue;
    }
    index += 1;
  }
  return offenders;
}

describe('ARCH-VARIABLE-FORMAT-TOKENS: the web format presets stay inside the API grammar (ADR-036)', () => {
  it('finds both halves of the coupling', () => {
    expect(apiTokens().length).toBeGreaterThan(0);
    expect(webPresets().length).toBeGreaterThan(0);
  });

  it('each file names the other, so an editor of one is pointed at the other', () => {
    expect(read(WEB_FILE)).toContain(API_FILE);
    expect(read(API_FILE)).toContain('ADR-036');
  });

  it('every offered preset uses only tokens the API recognises', () => {
    const tokens = apiTokens();
    const violations = webPresets()
      .map((preset) => ({ preset, offenders: unrecognizedLetters(preset.value, tokens) }))
      .filter((entry) => entry.offenders.length > 0)
      .map((entry) => `${entry.preset.value} -> unknown ${entry.offenders.join(', ')}`);

    expect(
      violations,
      `A preset in ${WEB_FILE} uses a token ${API_FILE} does not recognise, so saving it returns a 400 the ` +
        `author cannot act on. Recognised tokens: ${tokens.join(', ')}.${describeViolations(violations)}`,
    ).toEqual([]);
  });

  it('every preset carries at least one date token, so none is pure punctuation', () => {
    const tokens = apiTokens();
    const violations = webPresets()
      .filter((preset) => !tokens.some((token) => preset.value.includes(token)))
      .map((preset) => preset.value);

    expect(violations, `Preset(s) with no date token:${describeViolations(violations)}`).toEqual([]);
  });
});

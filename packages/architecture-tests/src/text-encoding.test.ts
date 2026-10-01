import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read } from './repo.js';

/**
 * ARCH-ENCODING: every text file this repository owns is UTF-8, and stays UTF-8
 * when an agent rewrites it.
 *
 * This rule exists because the same corruption has now happened three separate
 * times, each time silently:
 *
 *   1. apps/web/e2e/visual-capture.spec.ts — six em dashes in new test names.
 *   2. .agents/runs/.../state.json — 23 em dashes, 10 stray U+00C2, and four
 *      mangled Vietnamese sequences inside recorded evidence.
 *   3. .agents/runs/.../EXECPLAN.md — 288, 38 and 20 of the same, starting at
 *      the document's own title line.
 *
 * The mechanism is always identical: a tool reads UTF-8 bytes, decodes them as
 * Windows-1252, and writes the result back. U+2014 (an em dash) becomes the
 * three characters U+00E2 U+20AC U+201D. Vietnamese text suffers worse, because
 * every accented character expands into two or three Latin-1 characters.
 *
 * Note that this file deliberately spells its own examples as \u escapes. A
 * literal corrupted sequence here would make the rule report itself, and the
 * obvious workaround — excluding this path from the scan — would leave a
 * permanent blind spot in exactly the file that must not have one.
 *
 * Nothing caught any of the three. The workspace check passed, and
 * validate_plan.py passed, because both verify structure — sections present,
 * JSON parseable, rules mapped — and corrupted text is still structurally
 * valid text. On Windows the damage is also nearly invisible in a terminal,
 * since the console codepage renders the corruption back as something
 * plausible-looking.
 *
 * The check is deliberately mechanical rather than a spell-check: it decodes
 * each candidate run as Windows-1252 bytes and asks whether the result is valid
 * UTF-8 that differs from the input. Only mojibake satisfies that. Legitimate
 * accented text does not: "café" encodes to a lone 0xE9, which is not a valid
 * UTF-8 sequence, so it is never flagged.
 */

/**
 * Windows-1252 code points for bytes 0x80-0x9F. Every other byte maps to the
 * identical code point, as in Latin-1. U+FFFD marks the five byte values the
 * codepage leaves undefined.
 *
 * This table is written out rather than obtained from
 * `new TextDecoder('windows-1252')` because that decoder, in this Node build,
 * returns the C1 control characters for 0x80-0x9F instead of the codepage's
 * typographic block -- it behaves as Latin-1. Verified directly: decoding 0x80
 * yields U+0080, so a lookup for U+20AC finds nothing and the rule silently
 * matches no corruption at all. That failure mode is exactly what this rule
 * exists to prevent, so the table is explicit and self-tested below.
 */
const CP1252_HIGH =
  '\u20AC\uFFFD\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\uFFFD\u017D\uFFFD' +
  '\uFFFD\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\uFFFD\u017E\u0178';

function characterForByte(byte: number): string {
  return byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : String.fromCharCode(byte);
}

/**
 * Both renderings of a byte are accepted, because the tools that cause this
 * damage disagree about 0x80-0x9F. A true Windows-1252 reader maps 0x94 to
 * U+201D and leaves 0x9D undefined; a Latin-1 reader maps them to the C1
 * control characters U+0094 and U+009D. Real corruption in this repository
 * contains both flavours: U+1EDD was found corrupted to a sequence ending in
 * U+009D, which the codepage table alone cannot reverse. C1 control characters
 * never occur in legitimate source or prose, so accepting them adds no false
 * positives.
 */
function charactersForByte(byte: number): string[] {
  const codepage = characterForByte(byte);
  const latin1 = String.fromCharCode(byte);
  if (codepage === '\uFFFD') return [latin1];
  return codepage === latin1 ? [codepage] : [codepage, latin1];
}

const BYTE_OF_CHARACTER = new Map<string, number>();
for (let byte = 0x80; byte <= 0xff; byte += 1) {
  for (const character of charactersForByte(byte)) {
    if (!BYTE_OF_CHARACTER.has(character)) BYTE_OF_CHARACTER.set(character, byte);
  }
}

function charactersForByteRange(from: number, to: number): ReadonlySet<string> {
  const out = new Set<string>();
  for (let byte = from; byte <= to; byte += 1) for (const character of charactersForByte(byte)) out.add(character);
  return out;
}

/** A UTF-8 lead byte (0xC2-0xF4) and continuation byte (0x80-0xBF), as a mis-decoder would render them. */
const LEAD = charactersForByteRange(0xc2, 0xf4);
const CONTINUATION = charactersForByteRange(0x80, 0xbf);

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/** Inverse of the corruption: reads the run's characters back as bytes and decodes them as UTF-8. */
function repaired(run: string): string | null {
  const bytes = new Uint8Array(run.length);
  for (let index = 0; index < run.length; index += 1) {
    const byte = BYTE_OF_CHARACTER.get(run[index]!);
    if (byte === undefined) return null;
    bytes[index] = byte;
  }
  try {
    const decoded = UTF8_STRICT.decode(bytes);
    return decoded === run ? null : decoded;
  } catch {
    return null; // Not valid UTF-8, so this was genuine text and not corruption.
  }
}

/**
 * Finds corrupted runs without a regex, so no character class has to be escaped
 * and a multi-byte sequence is matched at its true length: the longest run that
 * decodes wins, since a 3-byte sequence also has a valid 2-byte prefix.
 */
function findCorruption(source: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!LEAD.has(source[index]!)) continue;
    let best: string | null = null;
    for (let length = 4; length >= 2; length -= 1) {
      const run = source.slice(index, index + length);
      if (run.length < length) continue;
      if (![...run.slice(1)].every((character) => CONTINUATION.has(character))) continue;
      if (repaired(run) !== null) {
        best = run;
        break;
      }
    }
    if (best !== null) {
      found.push(best);
      index += best.length - 1;
    }
  }
  return found;
}

const SCANNED: ReadonlyArray<{ dir: string; extensions: readonly string[] }> = [
  { dir: 'apps', extensions: ['.ts', '.tsx', '.css', '.json', '.md', '.yaml', '.yml'] },
  { dir: 'packages', extensions: ['.ts', '.tsx', '.json', '.md', '.yaml', '.yml'] },
  { dir: 'database', extensions: ['.sql', '.json', '.sh'] },
  { dir: 'contracts', extensions: ['.yaml', '.yml'] },
  { dir: 'catalog', extensions: ['.csv', '.json', '.yaml'] },
  { dir: 'docs', extensions: ['.md', '.yaml', '.yml'] },
  { dir: 'scripts', extensions: ['.py', '.mjs'] },
  { dir: '.agents', extensions: ['.json', '.md', '.yaml', '.yml', '.csv', '.py'] },
];

/**
 * design-reference/ holds the approved handoff verbatim and is not ours to
 * rewrite; deploy-backups/ and evidence artifacts are generated output.
 */
const EXCLUDED = /^(design-reference|deploy-backups)\//;

describe('ARCH-ENCODING: repository text stays UTF-8 (AGENTS.md §5)', () => {
  it('has no Windows-1252 mojibake in any owned text file', () => {
    const files = SCANNED.flatMap((scan) => listFiles(scan.dir, scan.extensions)).filter((file) => !EXCLUDED.test(file));
    expect(files.length, 'no files found — scanner paths are wrong').toBeGreaterThan(100);

    const violations: string[] = [];
    for (const file of files) {
      const source = read(file);
      const found = new Map<string, number>();
      for (const run of findCorruption(source)) {
        const key = `${JSON.stringify(run)} -> ${JSON.stringify(repaired(run))}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
      if (found.size === 0) continue;
      const total = [...found.values()].reduce((sum, count) => sum + count, 0);
      const samples = [...found.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([key, count]) => `${count}x ${key}`)
        .join(', ');
      violations.push(`${file}  (${total} occurrence(s): ${samples})`);
    }

    expect(
      violations,
      `UTF-8 text was rewritten through Windows-1252. Repair the file by reading its characters back as ` +
        `windows-1252 bytes and decoding them as UTF-8, then write it out with an explicit utf-8 encoding. ` +
        `On Windows this usually means passing -Encoding utf8 to Out-File/Set-Content, or encoding='utf-8' ` +
        `in Python — the default codepage is the cause:${describeViolations(violations)}`,
    ).toEqual([]);
  });

  it('detects the corruption it exists to prevent', () => {
    // A self-test, so the rule cannot silently rot into one that matches nothing.
    expect(repaired('\u00e2\u20ac\u201d')).toBe('\u2014'); // corrupted em dash -> em dash
    expect(repaired('\u00e1\u00bb\u00ad')).toBe('\u1eed'); // corrupted Vietnamese -> U+1EED
    // Genuine accented text must never be flagged.
    expect(repaired('\u00e9')).toBeNull(); // e-acute
    expect(repaired('\u00e0')).toBeNull(); // a-grave
  });
});

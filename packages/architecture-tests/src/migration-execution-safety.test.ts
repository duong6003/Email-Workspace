import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read, REPO_ROOT } from './repo.js';

const PSQL_META_COMMAND = /^\s*\\\S+/;
const UNSAFE_TRANSACTION_CONTROL = /^(?:abort|begin|commit|end|rollback|start\s+transaction|savepoint|release|prepare\s+transaction)\b/i;

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && (/[A-Za-z_]/.test(char) || char.codePointAt(0)! >= 0x80);
}

function isIdentifierContinuation(char: string | undefined): boolean {
  return char !== undefined && (/[A-Za-z0-9_$]/.test(char) || char.codePointAt(0)! >= 0x80);
}

function isDollarTagContinuation(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char) || char.codePointAt(0)! >= 0x80;
}

function dollarDelimiterAt(source: string, index: number): string | undefined {
  if (source[index] !== '$' || isIdentifierContinuation(source[index - 1])) return undefined;
  const closingDollar = source.indexOf('$', index + 1);
  if (closingDollar === -1) return undefined;
  const tag = source.slice(index + 1, closingDollar);
  if (tag !== '' && (!isIdentifierStart(tag[0]) || [...tag.slice(1)].some((char) => !isDollarTagContinuation(char)))) {
    return undefined;
  }
  return source.slice(index, closingDollar + 1);
}

function isPsqlMetaCommand(source: string): boolean {
  return PSQL_META_COMMAND.test(source);
}

function isCopyFromStdin(statement: string): boolean {
  return /^copy\s+[^()]+(?:\s*\([^;]*\))?\s+from\s+stdin(?:\s|\(|$)/i.test(statement.trim());
}

/** Replaces comments and quoted SQL text with spaces while preserving newlines. */
function maskNonExecutableSql(source: string): string {
  let masked = '';
  let index = 0;
  let blockCommentDepth = 0;
  let dollarQuote: string | undefined;
  let quote: "'" | '"' | undefined;
  let escapeString = false;
  let consecutiveBackslashes = 0;

  const mask = (value: string): void => {
    masked += value.replace(/[^\r\n]/g, ' ');
  };

  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index];

    if (dollarQuote !== undefined) {
      if (rest.startsWith(dollarQuote)) {
        mask(dollarQuote);
        index += dollarQuote.length;
        dollarQuote = undefined;
      } else {
        mask(char);
        index += 1;
      }
      continue;
    }

    if (quote !== undefined) {
      const escapedQuote = quote === "'" && escapeString && char === quote && consecutiveBackslashes % 2 === 1;
      if (escapedQuote) {
        mask(char);
        index += 1;
        consecutiveBackslashes = 0;
      } else if (char === quote && source[index + 1] === quote) {
        mask(source.slice(index, index + 2));
        index += 2;
        consecutiveBackslashes = 0;
      } else {
        mask(char);
        index += 1;
        if (char === quote) {
          quote = undefined;
          escapeString = false;
        }
        if (char === '\\') consecutiveBackslashes += 1;
        else consecutiveBackslashes = 0;
      }
      continue;
    }

    if (blockCommentDepth > 0) {
      if (rest.startsWith('/*')) {
        mask('/*');
        index += 2;
        blockCommentDepth += 1;
      } else if (rest.startsWith('*/')) {
        mask('*/');
        index += 2;
        blockCommentDepth -= 1;
      } else {
        mask(char);
        index += 1;
      }
      continue;
    }

    if (rest.startsWith('--')) {
      const lineEnd = source.indexOf('\n', index);
      const commentEnd = lineEnd === -1 ? source.length : lineEnd;
      mask(source.slice(index, commentEnd));
      index = commentEnd;
      continue;
    }
    if (rest.startsWith('/*')) {
      mask('/*');
      index += 2;
      blockCommentDepth = 1;
      continue;
    }
    if ((char === 'E' || char === 'e') && source[index + 1] === "'" && !isIdentifierContinuation(source[index - 1])) {
      mask(source.slice(index, index + 2));
      index += 2;
      quote = "'";
      escapeString = true;
      consecutiveBackslashes = 0;
      continue;
    }
    if (char === "'" || char === '"') {
      mask(char);
      index += 1;
      quote = char;
      escapeString = false;
      consecutiveBackslashes = 0;
      continue;
    }

    const dollarDelimiter = dollarDelimiterAt(source, index);
    if (dollarDelimiter !== undefined) {
      mask(dollarDelimiter);
      index += dollarDelimiter.length;
      dollarQuote = dollarDelimiter;
      continue;
    }

    masked += char;
    index += 1;
  }

  return masked;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * DEPLOY-005: included migrations execute inside migrate.sh's outer transaction.
 * Top-level psql commands or transaction control could escape that boundary and
 * separate migration DDL from its schema_migrations ledger record. Comments and
 * SQL string, identifier, and dollar-quoted routine bodies are ignored first.
 */
function unsafeTopLevelLines(source: string): string[] {
  const masked = maskNonExecutableSql(source);
  const violations = new Map<number, string>();
  const lines = source.match(/.*(?:\r\n|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const maskedLines = masked.match(/.*(?:\r\n|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  let copyData = false;
  let lineStart = 0;
  let statementStart = 0;

  for (const [lineIndex, physicalLine] of maskedLines.entries()) {
    const lineEndingLength = physicalLine.endsWith('\r\n') ? 2 : physicalLine.endsWith('\n') ? 1 : 0;
    const line = physicalLine.slice(0, physicalLine.length - lineEndingLength);
    const sourceLine = lines[lineIndex].slice(0, lines[lineIndex].length - lineEndingLength);

    if (copyData) {
      if (sourceLine === '\\.') {
        copyData = false;
        statementStart = lineStart + physicalLine.length;
      }
      lineStart += physicalLine.length;
      continue;
    }

    let segmentStart = 0;
    for (const statementEnd of [...line.matchAll(/;/g)].map((match) => match.index ?? 0)) {
      const statement = masked.slice(statementStart, lineStart + statementEnd);
      const firstToken = statement.search(/\S/);
      if (firstToken >= 0 && UNSAFE_TRANSACTION_CONTROL.test(statement.slice(firstToken))) {
        const location = statementStart + firstToken;
        violations.set(location, `${lineNumberAt(source, location)}  ${source.slice(location, lineStart + statementEnd).trim()}`);
      }
      for (const match of line.slice(segmentStart, statementEnd).matchAll(/\\\S+/g)) {
        const commandOffset = segmentStart + (match.index ?? 0);
        const location = lineStart + commandOffset;
        violations.set(location, `${lineIndex + 1}  ${sourceLine.slice(commandOffset).trim()}`);
      }
      if (isCopyFromStdin(statement)) copyData = true;
      statementStart = lineStart + statementEnd + 1;
      segmentStart = statementEnd + 1;
    }

    if (!copyData) {
      const executableSegment = line.slice(segmentStart);
      for (const match of executableSegment.matchAll(/\\\S+/g)) {
        const command = match[0];
        const commandOffset = segmentStart + (match.index ?? 0);
        const location = lineStart + commandOffset;
        if (isPsqlMetaCommand(command)) {
          violations.set(location, `${lineIndex + 1}  ${sourceLine.slice(commandOffset).trim()}`);
        }
      }
    }

    lineStart += physicalLine.length;
  }

  if (copyData) {
    const lineNumber = lines.length;
    const location = source.length;
    violations.set(location, `${lineNumber}  COPY data is missing its exact \\. terminator`);
  } else {
    const statement = masked.slice(statementStart);
    const firstToken = statement.search(/\S/);
    if (firstToken >= 0 && UNSAFE_TRANSACTION_CONTROL.test(statement.slice(firstToken))) {
      const location = statementStart + firstToken;
      violations.set(location, `${lineNumberAt(source, location)}  ${source.slice(location).trim()}`);
    }
  }

  return [...violations.entries()].sort(([left], [right]) => left - right).map(([, violation]) => violation);
}

describe('ARCH-MIGRATION: included migrations preserve runner transaction (DEPLOY-005)', () => {
  it.each([
    ['ignores transaction-like text in line comments', '-- COMMIT;\nSELECT 1;', []],
    ['ignores transaction-like text in block comments', '/*\nROLLBACK;\n*/\nSELECT 1;', []],
    ['ignores transaction-like text in quoted SQL literals', "SELECT 'BEGIN;';\nSELECT 'COMMIT;';", []],
    ['ignores transaction-like text in dollar-quoted bodies', 'DO $$\nBEGIN\n  COMMIT;\nEND;\n$$;', []],
    ['reports top-level transaction control', 'COMMIT;', ['1  COMMIT']],
    ['reports ABORT transaction control', 'ABORT;', ['1  ABORT']],
    ['reports transaction control after a prior statement', 'SELECT 1; COMMIT;', ['1  COMMIT']],
    ['reports unterminated transaction control', 'SELECT 1;\nCOMMIT', ['2  COMMIT']],
    ['reports top-level psql meta-commands', '\\set unsafe value', ['1  \\set unsafe value']],
    ['reports a semicolon-terminated psql meta-command once', '\\q;', ['1  \\q;']],
    ['reports a psql meta-command after a statement on the same line', 'SELECT 1; \\q', ['1  \\q']],
    ['reports an inline query-ending psql meta-command', "SELECT 'COMMIT' \\gexec", ['1  \\gexec']],
    ['reports a CRLF meta-command once', 'SELECT 1;\r\n\\q;', ['2  \\q;']],
    ['does not let an escaped E-string apostrophe mask an inline meta-command', String.raw`SELECT E'foo\''; SELECT 'COMMIT' \gexec`, ['1  \\gexec']],
    ['rejects a standalone terminator outside COPY data', '\\.', ['1  \\.']],
    ['rejects a terminator after a non-COPY statement', 'SELECT 1; \\.', ['1  \\.']],
    ['treats whitespace around a COPY terminator as payload', 'COPY cp(v) FROM STDIN;\n1\n \\.\n\\. \n\\.\nSELECT 1;', []],
    ['ignores SQL and psql-looking COPY payload lines until the exact terminator', 'COPY cp(v) FROM STDIN;\nCOMMIT\n\\q\n\\.\nSELECT 1;', []],
    ['reports transaction control after COPY TO query text mentioning FROM STDIN', 'COPY (SELECT value FROM stdin AS source) TO STDOUT;\nCOMMIT;', ['2  COMMIT']],
    ['reports transaction control after COPY TO query text mentioning a FROM STDIN function', 'COPY (SELECT value FROM stdin()) TO STDOUT;\nCOMMIT;', ['2  COMMIT']],
    ['reports transaction control after COPY TO query text mentioning a FROM STDIN function with options', 'COPY (SELECT value FROM stdin()) TO STDOUT (FORMAT csv);\nCOMMIT;', ['2  COMMIT']],
    ['accepts legacy CSV COPY data', 'COPY cp(v) FROM STDIN CSV;\nCOMMIT\n\\q\n\\.\nSELECT 1;', []],
    ['accepts compact COPY options', 'COPY cp(v) FROM STDIN(FORMAT csv);\nCOMMIT\n\\q\n\\.\nSELECT 1;', []],
    ['treats CRLF COPY payload and its exact terminator like LF input', 'COPY cp(v) FROM STDIN;\r\nCOMMIT\r\n\\q\r\n\\.\r\nSELECT 1;', []],
    ['rejects an unterminated COPY payload at EOF', 'COPY cp(v) FROM STDIN;\nCOMMIT', ['2  COPY data is missing its exact \\. terminator']],
    ['rejects a dot-prefixed psql command', '\\.foo', ['1  \\.foo']],
    ['rejects a dot-prefixed psql command after a statement', 'SELECT 1; \\.foo', ['1  \\.foo']],
    ['ignores a meta-command inside an E-prefixed escape string', String.raw`SELECT E'escaped\' apostrophe; \\q';`, []],
    ['ignores a meta-command inside a lowercase e-prefixed escape string', String.raw`SELECT e'escaped\' apostrophe; \\q';`, []],
    ['closes an E-prefixed escape string after an even backslash run', String.raw`SELECT E'even\\'; \q`, ['1  \\q']],
    ['keeps an E-prefixed escape string open after an odd backslash run', String.raw`SELECT E'odd\\\'; \q';`, []],
    ['does not apply escape-string rules to an ordinary string', String.raw`SELECT 'ordinary\'; \q`, ['1  \\q']],
    ['does not apply escape-string rules to a quoted identifier', String.raw`SELECT "identifier\"; \q`, ['1  \\q']],
    ['does not mask a meta-command after a dollar-tagged identifier', 'CREATE TABLE cp_audit$sentinel$ (id integer PRIMARY KEY);\n\\q', ['2  \\q']],
    ['preserves valid dollar-quoted routine masking', 'DO $body$\nBEGIN\n  COMMIT;\nEND;\n$body$;', []],
    ['preserves non-ASCII dollar-quoted routine masking', 'DO $é$\nBEGIN\n  COMMIT;\nEND;\n$é$;', []],
    ['does not accept a digit-starting dollar tag', 'SELECT 1; COMMIT $1tag$ hidden $1tag$;', ['1  COMMIT $1tag$ hidden $1tag$']],
    ['does not accept punctuation inside a dollar tag', 'SELECT 1; COMMIT $bad-tag$ hidden $bad-tag$;', ['1  COMMIT $bad-tag$ hidden $bad-tag$']],
    ['does not accept whitespace inside a dollar tag', 'SELECT 1; COMMIT $bad tag$ hidden $bad tag$;', ['1  COMMIT $bad tag$ hidden $bad tag$']],
  ])('%s', (_name, source, expected) => {
    expect(unsafeTopLevelLines(source)).toEqual(expected);
  });

  it('keeps COPY parity fixtures byte-distinct but logically identical across LF and CRLF', () => {
    const lf = read('packages/architecture-tests/fixtures/migration-runner/999_cp1_runner_copy_payload_probe.sql');
    const crlf = readFileSync(resolve(REPO_ROOT, 'packages/architecture-tests/fixtures/migration-runner/999_cp1_runner_copy_payload_crlf_probe.sql'));
    const crlfText = crlf.toString('utf8');

    expect(crlf.includes(Buffer.from('\r\n'))).toBe(true);
    expect(crlfText.replace(/\r\n/g, '')).not.toContain('\n');
    expect(crlfText.replaceAll('_crlf_probe', '_probe').replace(/\r\n/g, '\n')).toBe(lf);
  });

  it('keeps post-terminator fixtures byte-distinct but logically identical across LF and CRLF', () => {
    const lf = read('packages/architecture-tests/fixtures/migration-runner/999_cp1_runner_copy_post_terminator_probe.sql');
    const crlf = readFileSync(resolve(REPO_ROOT, 'packages/architecture-tests/fixtures/migration-runner/999_cp1_runner_copy_post_terminator_crlf_probe.sql'));
    const crlfText = crlf.toString('utf8');

    expect(crlf.includes(Buffer.from('\r\n'))).toBe(true);
    expect(crlfText.replace(/\r\n/g, '')).not.toContain('\n');
    expect(crlfText.replaceAll('_crlf_probe', '_probe').replace(/\r\n/g, '\n')).toBe(lf);
  });

  it('contains no top-level psql meta-commands or transaction control', () => {
    const violations = listFiles('database/migrations', ['.sql']).flatMap((file) =>
      unsafeTopLevelLines(read(file)).map((line) => `${file}:${line}`),
    );

    expect(
      violations,
      `Included migration(s) could escape migrate.sh's outer transaction:${describeViolations(violations)}`,
    ).toEqual([]);
  });
});

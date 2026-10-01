import { describe, expect, it } from 'vitest';
import { describeViolations, listFiles, read } from './repo.js';

/**
 * ARCH-CSV-SHAPE: every row of a delivery CSV has exactly as many fields as its
 * header.
 *
 * These four files are load-bearing rather than decorative. traceability.csv is
 * the authority on whether a business rule is closed; catalog/ba-rules.csv,
 * test-cases.csv and business-gaps.csv are the sources those closures are
 * checked against. Every consumer reads them positionally, so one unquoted
 * comma silently shifts every field after it: a row can report another column's
 * text as its `status` and still look completely ordinary.
 *
 * That is not hypothetical. BR-IMP-002 was written with an unquoted comma in
 * `log_or_metric_or_audit` (15 fields against a 14-field header) and BR-IMP-003
 * was written with `deploy_case_ids` missing entirely (13 fields) — both in the
 * same commit that closed them, so the two rows most likely to be read were the
 * two that lied.
 *
 * `validate_plan.py` passed at 0 errors throughout, because it checks that rules
 * are present and mapped, not that the file it reads them from is well formed.
 * A CSV with a shifted row parses without complaint; that is exactly what makes
 * this worth a mechanical check rather than review attention.
 *
 * The parser below is deliberately a real RFC 4180 parser, not `split(',')`.
 * A rule that cannot tell a quoted comma from a field separator would report
 * every correctly-escaped row as a violation and would be deleted within a day.
 */

/** Splits one CSV record into fields, honouring quotes and doubled escape quotes. */
function parseRecord(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character !== '"') field += character;
      else if (line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      fields.push(field);
      field = '';
    } else field += character;
  }
  fields.push(field);
  return fields;
}

/**
 * Splits a file into records. A quoted field may legally contain newlines, so
 * records are accumulated until quotes balance rather than split on every line.
 */
function parseRecords(source: string): Array<{ line: number; fields: string[] }> {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const records: Array<{ line: number; fields: string[] }> = [];
  let buffer = '';
  let startLine = 1;
  lines.forEach((line, index) => {
    if (buffer === '') startLine = index + 1;
    buffer = buffer === '' ? line : `${buffer}\n${line}`;
    const quoteCount = (buffer.match(/"/g) ?? []).length;
    if (quoteCount % 2 !== 0) return; // Inside a quoted field; keep accumulating.
    if (buffer.trim() !== '') records.push({ line: startLine, fields: parseRecord(buffer) });
    buffer = '';
  });
  if (buffer.trim() !== '') records.push({ line: startLine, fields: parseRecord(buffer) });
  return records;
}

const CSV_DIRECTORIES = ['catalog', '.agents/runs'];

describe('ARCH-CSV-SHAPE: delivery CSVs are well formed (AGENTS.md §2)', () => {
  it('has no row whose field count differs from its header', () => {
    const files = CSV_DIRECTORIES.flatMap((directory) => listFiles(directory, ['.csv']));
    expect(files.length, 'no CSV files found — scanner paths are wrong').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const records = parseRecords(read(file).replace(/^﻿/, ''));
      if (records.length === 0) continue;
      const expected = records[0]!.fields.length;
      for (const record of records.slice(1)) {
        if (record.fields.length === expected) continue;
        violations.push(
          `${file}:${record.line}  ${record.fields.length} fields, header has ${expected}` +
            ` (starts "${record.fields[0]?.slice(0, 24) ?? ''}")`,
        );
      }
    }

    expect(
      violations,
      `A CSV row does not match its header. Every consumer reads these files positionally, so a row with the ` +
        `wrong field count reports another column's value as its own — a rule can appear closed, or appear ` +
        `open, purely from an unquoted comma. Wrap any field containing a comma in double quotes, and emit ` +
        `every column even when empty:${describeViolations(violations)}`,
    ).toEqual([]);
  });

  it('parses quoted commas, escaped quotes and embedded newlines rather than splitting on every comma', () => {
    // A self-test: without this the rule could "pass" by being unable to parse anything correctly.
    expect(parseRecord('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseRecord('a,"b,still b",c')).toEqual(['a', 'b,still b', 'c']);
    expect(parseRecord('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
    expect(parseRecord('a,,c')).toEqual(['a', '', 'c']);
    expect(parseRecords('h1,h2\n"line\nbreak",second').map((record) => record.fields)).toEqual([
      ['h1', 'h2'],
      ['line\nbreak', 'second'],
    ]);
  });
});

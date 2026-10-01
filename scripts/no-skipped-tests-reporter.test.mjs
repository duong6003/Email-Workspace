import assert from 'node:assert/strict';
import test from 'node:test';
import Reporter from './no-skipped-tests-reporter.mjs';

const moduleWith = (tests) => ({ children: { allTests: function* () { yield* tests; } } });

test('accepts a run with no skipped tests', () => {
  assert.doesNotThrow(() => new Reporter().onTestRunEnd([moduleWith([])]));
});

test('rejects skipped tests with their module and full name', () => {
  const skipped = { module: { relativeModuleId: 'example.test.ts' }, fullName: 'suite > skipped case' };
  assert.throws(
    () => new Reporter().onTestRunEnd([moduleWith([skipped])]),
    /Skipped\/todo tests are forbidden \(1\).*example\.test\.ts > suite > skipped case/s,
  );
});

/**
 * A skipped test is either committed `.skip`/`.todo` (forbidden here) or a test
 * that never ran because its hook failed — vitest reports both as "skipped".
 * The second case is the common one under CPU contention (see vitest.shared.ts),
 * so the message must carry the hook error or the reader chases the wrong bug.
 */
export default class NoSkippedTestsReporter {
  onTestRunEnd(testModules) {
    const skipped = testModules.flatMap((module) => [...module.children.allTests('skipped')]);
    if (skipped.length === 0) return;
    const names = skipped.map((test) => `  - ${test.module.relativeModuleId} > ${test.fullName}`).join('\n');
    const failures = testModules.flatMap((module) => [
      ...(module.errors?.() ?? []),
      ...[...(module.children.allSuites?.() ?? [])].flatMap((suite) => suite.errors?.() ?? []),
    ]).map((error) => `  ! ${error?.message ?? String(error)}`);
    const cause = failures.length > 0
      ? `\n\nA hook or collection step failed, so these tests never ran. Fix this first:\n${failures.join('\n')}`
      : '\n\nNo hook error was reported. If this run was under heavy load, re-run before investigating: a timed-out beforeAll also surfaces as skipped (see vitest.shared.ts).';
    throw new Error(`Skipped/todo tests are forbidden (${skipped.length}):\n${names}${cause}`);
  }
}

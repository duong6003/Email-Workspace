/**
 * Last-write-wins for debounced requests: responses may arrive out of order, so
 * a result is only applied while its token is still the newest one issued.
 */
export function createSequenceGuard() {
  let latest = 0;
  return {
    issue: () => ++latest,
    isCurrent: (token: number) => token === latest,
  };
}

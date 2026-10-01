export type QuotaPeriod = 'day' | 'month';

export function periodKeyFor(now: Date, period: QuotaPeriod): string {
  const iso = now.toISOString();
  return period === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

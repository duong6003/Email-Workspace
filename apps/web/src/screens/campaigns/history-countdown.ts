/**
 * BR-HIS-004: "countdown dùng server time" -- the client's own clock is
 * never consulted here. `serverTime` comes from the history list
 * response's own top-level field; the remainder is always computed as an
 * offset against it, never against `Date.now()`.
 */
export function countdownFrom(serverTime: string, scheduledAtUtc: string): string {
  const remainingMs = new Date(scheduledAtUtc).getTime() - new Date(serverTime).getTime();
  if (remainingMs <= 0) return 'Sắp gửi';

  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 60) return `Còn ${totalMinutes} phút`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `Còn ${hours} giờ ${minutes} phút`;
}

export type LockCountdown = { locked: boolean; label: string };

/**
 * BR-SCH-005: once inside the lock window, "Đổi giờ"/"Hủy lịch" must not be
 * offered -- the server would 409 -- so the client needs this boundary
 * ahead of time, not just reactively after a failed request (M5-S2 CP6,
 * plan SS3.6/A20).
 */
export function computeLockCountdown(scheduledAtUtc: Date, lockWindowSeconds: number, now: Date): LockCountdown {
  const lockAtMs = scheduledAtUtc.getTime() - lockWindowSeconds * 1000;
  const remainingMs = lockAtMs - now.getTime();
  if (remainingMs <= 0) return { locked: true, label: 'Đã trong thời gian khóa lịch — không thể đổi giờ hoặc hủy lịch' };

  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const label = minutes > 0 ? `Khóa lịch sau ${minutes} phút ${seconds} giây` : `Khóa lịch sau ${seconds} giây`;
  return { locked: false, label };
}

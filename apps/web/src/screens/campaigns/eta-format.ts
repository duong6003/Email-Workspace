import type { CampaignEtaEstimate } from '../../api/campaigns.js';

/**
 * BR-SEND-005: "biến mất khi complete" is a disappearance, not a number --
 * null means "render no ETA row at all", never "0 giây" or an empty string.
 */
export function formatEta(eta: CampaignEtaEstimate): string | null {
  if (eta === null) return null;
  if (eta.state === 'estimating') return 'Đang ước tính…';
  const minutes = Math.floor(eta.secondsRemaining / 60);
  const seconds = eta.secondsRemaining % 60;
  if (minutes <= 0) return `Còn khoảng ${seconds} giây`;
  return `Còn khoảng ${minutes} phút ${seconds} giây`;
}

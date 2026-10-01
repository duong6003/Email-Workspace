import type { SenderConfig, SenderInput } from '../../api/senderConfigs.js';
import { requiredText, validEmail, validPort, type FieldValidationErrors } from '../../api/frontend-validation.js';

export type SenderFormState = Omit<SenderInput, 'replyTo'> & { replyTo: string };

export type SmtpPortPreset = { port: number; label: string; hint: string };
/** How the port control is being driven: a picked preset, or a hand-typed number. */
export type SmtpPortMode = 'preset' | 'custom';

/** Convenience shortcuts only -- `validPort` stays the authoritative 1..65535 rule, because the API accepts any port. */
export const SMTP_PORT_PRESETS: readonly SmtpPortPreset[] = [
  { port: 587, label: 'Submission + STARTTLS', hint: 'Lựa chọn thông thường; hầu hết nhà cung cấp đều mở cổng này cho tài khoản gửi.' },
  { port: 465, label: 'TLS ngầm định (SMTPS)', hint: 'Chọn khi nhà cung cấp yêu cầu TLS ngay từ đầu kết nối; hệ thống tự bắt tay theo kiểu này khi cổng là 465.' },
  { port: 25, label: 'Relay', hint: 'Cổng relay truyền thống, thường bị nhà cung cấp cloud và nhà mạng gia đình chặn.' },
  { port: 2525, label: 'Submission thay thế', hint: 'Cổng dự phòng của một số nhà cung cấp khi 587 bị chặn.' },
  { port: 1025, label: 'Mail catcher nội bộ (dev)', hint: 'Chỉ dùng cho môi trường phát triển (mailpit); không gửi được thư ra ngoài.' },
];
export const SMTP_PORT_DEFAULT = 587;
export const SMTP_PORT_CUSTOM = 'custom';

export function findSmtpPortPreset(port: number): SmtpPortPreset | null {
  return SMTP_PORT_PRESETS.find((preset) => preset.port === port) ?? null;
}

export function smtpPortOptionLabel(preset: SmtpPortPreset): string {
  return `${preset.port} · ${preset.label}`;
}

export function smtpPortModeFor(port: number): SmtpPortMode {
  return findSmtpPortPreset(port) ? 'preset' : 'custom';
}

/**
 * The mode is state, not a derivation of the port: someone who picked "Khác" and
 * then typed 587 by hand must keep the free input open instead of having the
 * select snap back onto the preset row underneath them.
 */
export function smtpPortSelectValue(port: number, mode: SmtpPortMode): string {
  return mode === 'preset' && findSmtpPortPreset(port) ? String(port) : SMTP_PORT_CUSTOM;
}

export function selectSmtpPort(option: string, currentPort: number): { mode: SmtpPortMode; port: number } {
  const preset = findSmtpPortPreset(Number(option));
  return preset ? { mode: 'preset', port: preset.port } : { mode: 'custom', port: currentPort };
}

export function smtpPortHint(port: number, mode: SmtpPortMode): string {
  const preset = mode === 'preset' ? findSmtpPortPreset(port) : null;
  return preset?.hint ?? 'Nhập cổng SMTP từ 1 đến 65535 theo hướng dẫn của nhà cung cấp.';
}

export function smtpPortSummary(port: number): string {
  const preset = findSmtpPortPreset(port);
  return preset ? smtpPortOptionLabel(preset) : String(port);
}

export function senderFormInitial(sender?: SenderConfig | null): SenderFormState {
  return {
    name: sender?.name ?? '',
    fromName: sender?.fromName ?? '',
    fromEmail: sender?.fromEmail ?? '',
    replyTo: sender?.replyTo ?? '',
    host: sender?.host ?? 'mailpit',
    port: sender?.port ?? SMTP_PORT_DEFAULT,
    username: sender?.username ?? '',
    secret: '',
  };
}

export function senderUpdatePayload(initial: SenderFormState, current: SenderFormState): Partial<SenderInput> {
  return Object.fromEntries(Object.entries(current).flatMap(([key, value]) => {
    if (key === 'secret') return value ? [[key, value]] : [];
    if (value === initial[key as keyof SenderFormState]) return [];
    return [[key, key === 'replyTo' && !String(value).trim() ? null : value]];
  }));
}

export function validateSenderForm(form: SenderFormState, options: { requireSecret: boolean }): FieldValidationErrors {
  const usernameRequiresSecret = Boolean(form.username.trim()) && options.requireSecret;
  return Object.fromEntries([
    ['name', requiredText(form.name, 'Nhập tên cấu hình để nhận biết trong danh sách.')],
    ['fromEmail', validEmail(form.fromEmail, true)],
    ['replyTo', validEmail(form.replyTo, false)],
    ['host', requiredText(form.host, 'Nhập máy chủ SMTP.')],
    ['port', validPort(form.port)],
    ['secret', usernameRequiresSecret ? requiredText(form.secret, 'Máy chủ có tên đăng nhập nên cần mật khẩu hoặc token SMTP.') : null],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
}

export function filterSenderConfigs(items: SenderConfig[], query: string): SenderConfig[] {
  const normalized = query.trim().toLocaleLowerCase('vi');
  if (!normalized) return items;
  return items.filter((item) => [item.name, item.fromName, item.fromEmail, item.host, item.status]
    .some((value) => value.toLocaleLowerCase('vi').includes(normalized)));
}

export function senderConnectionFailureMessage(result: { code?: string; classification?: string; reason?: string | null }): string {
  const reason = result.reason?.trim() ?? '';
  if (/not logged in|authenticat|login required/i.test(reason) || result.classification === 'auth') {
    return 'SMTP chưa xác thực tài khoản gửi. Kiểm tra tên đăng nhập, mật khẩu/token và quyền dùng email người gửi.';
  }
  return reason || `Không thể xác thực SMTP (${result.code ?? 'UNKNOWN'}).`;
}

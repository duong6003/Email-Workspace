import { describe, expect, it } from 'vitest';
import type { SenderConfig } from '../../api/senderConfigs.js';
import { validPort } from '../../api/frontend-validation.js';
import {
  filterSenderConfigs, findSmtpPortPreset, selectSmtpPort, senderConnectionFailureMessage, senderFormInitial, senderUpdatePayload,
  smtpPortHint, smtpPortModeFor, smtpPortOptionLabel, smtpPortSelectValue, smtpPortSummary, validateSenderForm,
  SMTP_PORT_CUSTOM, SMTP_PORT_DEFAULT, SMTP_PORT_PRESETS,
} from './sender-settings.js';

const sender: SenderConfig = {
  id: 'sender-1', name: 'SMTP công ty', fromName: 'People Team', fromEmail: 'people@example.test', replyTo: null,
  provider: 'smtp', host: 'smtp.example.test', port: 587, username: 'people@example.test', secretRef: '••••ABC',
  credentialConfigured: true, status: 'verified', verifiedAt: null, lastTestedAt: null, createdAt: '', updatedAt: '',
};

describe('sender settings helpers', () => {
  it('never hydrates the stored secret into an edit form', () => {
    expect(senderFormInitial(sender)).toMatchObject({ fromEmail: 'people@example.test', secret: '' });
  });

  it('sends only changed fields and omits a blank rotation secret', () => {
    const initial = senderFormInitial(sender);
    expect(senderUpdatePayload(initial, { ...initial, fromName: 'People Operations' })).toEqual({ fromName: 'People Operations' });
  });

  it('clears reply-to explicitly when the unlocked field is emptied', () => {
    const initial = { ...senderFormInitial(sender), replyTo: 'reply@example.test' };
    expect(senderUpdatePayload(initial, { ...initial, replyTo: '' })).toEqual({ replyTo: null });
  });

  it('filters by sender identity and status', () => {
    expect(filterSenderConfigs([sender], 'verified')).toHaveLength(1);
    expect(filterSenderConfigs([sender], 'finance')).toHaveLength(0);
  });

  it('returns field-specific create and edit validation errors', () => {
    const invalid = { ...senderFormInitial(), host: '', port: 0, fromEmail: 'invalid', username: 'smtp-user' };
    expect(validateSenderForm(invalid, { requireSecret: true })).toEqual(expect.objectContaining({ name: expect.any(String), fromEmail: expect.any(String), host: expect.any(String), port: expect.any(String), secret: expect.any(String) }));
    expect(validateSenderForm({ ...senderFormInitial(sender), replyTo: 'invalid' }, { requireSecret: false })).toEqual({ replyTo: expect.any(String) });
  });

  it('explains SMTP not-logged-in failures with credential actions', () => {
    expect(senderConnectionFailureMessage({ code: 'EENVELOPE', classification: 'auth', reason: '553 5.7.1 Sender address rejected: not logged in' })).toContain('mật khẩu/token');
  });
});

describe('SMTP port presets', () => {
  it('starts a new configuration on submission/STARTTLS rather than the dev mail catcher', () => {
    expect(SMTP_PORT_DEFAULT).toBe(587);
    expect(senderFormInitial().port).toBe(587);
    expect(senderFormInitial(sender).port).toBe(sender.port);
  });

  it('offers the common submission ports, each labelled with what it is for', () => {
    expect(SMTP_PORT_PRESETS.map((preset) => preset.port)).toEqual([587, 465, 25, 2525, 1025]);
    expect(SMTP_PORT_PRESETS.every((preset) => preset.label.trim() && preset.hint.trim())).toBe(true);
    expect(smtpPortOptionLabel(SMTP_PORT_PRESETS[0])).toContain('587');
    expect(findSmtpPortPreset(1025)?.hint).toMatch(/dev|mailpit/i);
    expect(findSmtpPortPreset(2020)).toBeNull();
  });

  it('keeps validPort authoritative: every preset passes it and it still accepts ports we do not list', () => {
    for (const preset of SMTP_PORT_PRESETS) expect(validPort(preset.port)).toBeNull();
    expect(validPort(2020)).toBeNull();
    expect(validPort(65536)).toBeTruthy();
  });

  it('opens on the preset row for a known port and on the custom row for anything else', () => {
    expect(smtpPortModeFor(587)).toBe('preset');
    expect(smtpPortModeFor(2020)).toBe('custom');
    expect(smtpPortSelectValue(465, 'preset')).toBe('465');
    expect(smtpPortSelectValue(2020, 'custom')).toBe(SMTP_PORT_CUSTOM);
  });

  it('adopts the port when a preset is picked and keeps the typed one when switching to custom', () => {
    expect(selectSmtpPort('465', 1025)).toEqual({ mode: 'preset', port: 465 });
    expect(selectSmtpPort(SMTP_PORT_CUSTOM, 587)).toEqual({ mode: 'custom', port: 587 });
  });

  it('stays on the custom row when a hand-typed port happens to match a preset', () => {
    const chosen = selectSmtpPort(SMTP_PORT_CUSTOM, 2020);
    expect(smtpPortSelectValue(587, chosen.mode)).toBe(SMTP_PORT_CUSTOM);
  });

  it('never leaves the select without a matching option when the port is not a preset', () => {
    expect(smtpPortSelectValue(2020, 'preset')).toBe(SMTP_PORT_CUSTOM);
  });

  it('explains the chosen preset and falls back to the 1..65535 rule for custom ports', () => {
    expect(smtpPortHint(25, 'preset')).toMatch(/chặn/i);
    expect(smtpPortHint(2020, 'custom')).toContain('65535');
    expect(smtpPortHint(587, 'custom')).toContain('65535');
  });

  it('summarises a port for the locked detail view', () => {
    expect(smtpPortSummary(587)).toBe(smtpPortOptionLabel(SMTP_PORT_PRESETS[0]));
    expect(smtpPortSummary(2020)).toBe('2020');
  });
});

import { SmtpProviderAdapter } from '../sender-config/smtp-provider.adapter.js';
import type { EmailProviderAdapter } from '../sender-config/provider-adapter.js';

/**
 * BR-CFG's provider vocabulary is `CHECK (provider IN ('smtp'))`
 * (020_sender_config.sql) -- this registry mirrors that, deliberately. An
 * unregistered `{provider}` path segment is a 404, not an attempt to guess
 * at an adapter this deployment has no configuration for (M5-S4-WEBHOOK-PLAN.md
 * SS1 non-goals: "no second provider").
 */
const REGISTRY: Readonly<Record<string, EmailProviderAdapter>> = {
  smtp: new SmtpProviderAdapter(),
};

export function resolveProviderAdapter(provider: string): EmailProviderAdapter | undefined {
  return REGISTRY[provider];
}

# ADR-030: Encrypted shared sender credentials

## Status

Accepted — August 20, 2026.

## Context

Sender configuration previously stored a generated secret reference in PostgreSQL while keeping the submitted SMTP secret only in an API-process `Map`. The worker resolved only environment variables. A credential therefore disappeared after an API restart and was never shared with the worker, allowing a connection probe to look successful while delivery failed with provider responses such as `553 5.7.1 Sender address rejected: not logged in`.

## Decision

Store SMTP credentials as AES-256-GCM ciphertext in a tenant-scoped, RLS-protected `sender_credential` table. Bind authenticated encryption to `tenant_id` and `secret_ref`. API and worker use the same externally supplied 256-bit `SENDER_CREDENTIAL_KEY`; plaintext is never returned, logged or written to audit metadata. Existing environment-backed references remain a compatibility fallback.

Changing host, port, username, sender address or credential invalidates prior verification. Connection testing verifies the SMTP session and submits one test message to the configured sender address so authentication and `MAIL FROM` authorization are checked before the sender becomes usable.

## Consequences

- Saved credentials survive restarts and are readable by both API and worker.
- Deployments must provide the same 64-hex-character key to API and worker.
- Key rotation requires decrypt-and-re-encrypt migration or credential re-entry.
- The UI reports credential availability without hydrating the secret value.
- A connection test intentionally creates one test email addressed to the sender mailbox.

# Security baseline

Secure HttpOnly SameSite cookies; CSRF protection for state changes; server-side RBAC and
tenant guards; parameterized queries; output encoding and sanitized email HTML; secret
rotation; signed provider webhooks; encryption in transit and managed encryption at rest.

Never log tokens, recipient custom values or email bodies. Audit authentication, role,
sender, template publish, audience, schedule/send/cancel, bulk update and export actions.
Define retention and erasure workflows before production data is admitted.

## TLS policy

- Production traffic must terminate at a managed edge or organization-approved reverse proxy. The single-host Nginx container on port 8080 is an internal HTTP origin and is not a production TLS terminator.
- The edge must allow TLS 1.2 or newer, prefer TLS 1.3, reject SSL and TLS 1.0/1.1, and use an organization-approved certificate with automated renewal.
- HTTPS is mandatory for browser and API traffic outside a developer workstation. HTTP may exist only between controlled internal hops after the edge.
- The edge must forward the original scheme as `X-Forwarded-Proto`. `WEB_ORIGIN` must use `https://` for an HTTPS deployment so session and CSRF cookies carry `Secure`; session cookies also remain `HttpOnly` and `SameSite=Lax`.
- HSTS is enabled at the public edge only after every production hostname is HTTPS-ready. Use at least `max-age=31536000; includeSubDomains`; add `preload` only through the organization's domain-ownership review.
- Certificate expiry, handshake failures and downgrade/configuration drift require monitoring. Emergency rollback removes the faulty edge configuration or certificate while keeping the application origin private; it never exposes the HTTP origin publicly.

At-rest encryption for PostgreSQL volumes, object storage and backups belongs to the managed infrastructure boundary. Application secrets must be referenced, not serialized into API responses, errors or audit metadata. Sender SMTP credentials are encrypted with AES-256-GCM in the tenant-scoped `sender_credential` table; API and worker share `EOW_SENDER_CREDENTIAL_KEY`, while legacy explicit environment references remain readable during migration. The encryption key must be held outside PostgreSQL and rotated only through a reviewed re-encryption procedure.

Dead-letter inspection and controlled replay procedures are documented in `docs/operations/dlq-runbook.md`.

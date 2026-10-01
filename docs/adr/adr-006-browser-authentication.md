# ADR-006: Browser authentication

Status: Accepted

## Decision

Short-lived access session and rotated refresh token in Secure HttpOnly SameSite cookies; server-side RBAC/tenant guards.

## Rationale

Avoid exposing long-lived tokens to browser JavaScript.

## Alternatives

localStorage bearer tokens

# Connector and identity UI

## 1. Content Provider screen

EOW owns this screen. Mailcraft is displayed as a provider, not as a manually configured SMTP-like connection.

### Embedded provider card

| Field | Example |
|---|---|
| Provider | Mailcraft |
| Mode | Embedded |
| Status | Connected / Degraded / Unavailable |
| Contract | EOW Content Provider v1 |
| Resource types | Email template |
| Capabilities | HTML, plain text, variables, preview, immutable versions |
| Last event | Template published · time |
| Queue | Pending / failed events |
| Actions | View details, test internal adapter, retry failed |

There is no endpoint, client ID or client secret form for embedded mode.

### Remote provider mode

Only visible when an administrator changes deployment mode:

- base URL;
- discovery/capabilities endpoint;
- authentication mode;
- client identifier;
- secret reference managed by the backend vault;
- allowed scopes;
- timeout and retry policy;
- test connection.

Secrets are write-only and never returned to the browser after storage.

## 2. Provider detail layout

Tabs:

1. Overview — health, version and capability compatibility.
2. Resources — recently registered templates and versions.
3. Events — correlation ID, attempt, status and retry.
4. Configuration — embedded/remote adapter settings.
5. Audit — who changed provider settings.

## 3. Identity Provider UI

Identity is a separate EOW administration area.

Fields:

- display name;
- issuer URL;
- discovery status;
- client ID;
- secret reference;
- allowed tenant(s);
- requested OIDC scopes;
- claim mapping;
- enabled/disabled;
- last validation time.

Validation must check exact issuer match, HTTPS metadata, supported Authorization Code flow, PKCE support, JWKS availability and allowed redirect URIs.

## 4. Permission model

Use a permission matrix rather than OAuth scope controls in the editor:

| Role | View | Edit draft | Import | Publish | Manage provider |
|---|---:|---:|---:|---:|---:|
| Viewer | Yes | No | No | No | No |
| Editor | Yes | Yes | Yes | No | No |
| Publisher | Yes | Yes | Yes | Yes | No |
| EOW Admin | Yes | Optional | Optional | Optional | Yes |

# UI component and host contracts

## Host bridge

~~~ts
export type MailcraftHostContext = {
  user: {
    id: string;
    displayName: string;
  };
  tenant: {
    id: string;
  };
  locale: "vi" | "en";
  permissions: string[];
  navigation: {
    back(): void;
    openTemplateList(): void;
  };
  document: {
    templateId?: string;
    draftId?: string;
  };
};
~~~

The host bridge exposes normalized application data only. It does not expose raw cookies, ID Tokens, refresh tokens or IdP configuration.

## Shared components

EOW-owned:

- application shell;
- account menu;
- tenant switcher;
- global notification system;
- identity/provider administration;
- permission-denied and session-expired surfaces.

Mailcraft-owned:

- editor canvas;
- insert and structure tools;
- element inspector;
- reusable block library;
- HTML import report;
- email preview and content validation.

Shared design-system primitives:

- Button, IconButton, Input, Select, Dialog;
- Tabs, Tooltip, Toast, Badge;
- EmptyState, ErrorState, Skeleton;
- tokens for typography, radius, spacing, elevation and focus.

## Editor package API

~~~ts
export type MailcraftEditorProps = {
  host: MailcraftHostContext;
  api: MailcraftApi;
  onDirtyChange?(dirty: boolean): void;
  onPublished?(result: {
    templateId: string;
    version: number;
    contentHash: string;
  }): void;
};
~~~

The package must be mountable in EOW and in a standalone test harness. This is the primary UI extraction seam.

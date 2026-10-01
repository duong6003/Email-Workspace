# Interaction and error states

## Document state

~~~mermaid
stateDiagram-v2
    [*] --> Clean
    Clean --> Dirty: edit
    Dirty --> Saving: autosave/manual save
    Saving --> Clean: success
    Saving --> SaveFailed: failure
    SaveFailed --> Saving: retry
    Dirty --> Conflict: stale revision
    Conflict --> Dirty: resolve or reload
    Clean --> Publishing: publish
    Publishing --> Published: success
    Publishing --> PublishFailed: failure
~~~

## Required UI treatments

| State | Treatment | Allowed action |
|---|---|---|
| Saving | Header spinner and “Saving…” | Continue editing |
| Saved | Timestamp or subtle check | Normal |
| Save failed | Persistent header banner | Retry, inspect detail |
| Revision conflict | Blocking resolution dialog | Reload, duplicate draft, compare |
| Offline | Read-only/degraded banner | Retry connection |
| Permission lost | Lock editor and preserve local changes | Copy/export draft, request access |
| Publish validation failed | Grouped blocking issues | Jump to element |
| Event registration failed | Template remains published, EOW registration pending | Retry safely |

## Import state

~~~mermaid
flowchart TD
    A["Upload HTML or ZIP"] --> B["Preflight"]
    B --> C["Analyze structure"]
    C --> D["Resolve assets"]
    D --> E["Review conversion report"]
    E --> F["Create editable draft"]
~~~

The import UI reports four result groups:

- converted to native elements;
- partially converted;
- preserved as custom fallback;
- blocked or missing.

Analysis failure never discards the uploaded source. The user can download the report or retry with another strategy.

## Destructive actions

Deleting a reusable block, asset or draft uses a confirmation dialog showing impact. Published versions referenced by campaigns cannot be hard-deleted from normal UI.

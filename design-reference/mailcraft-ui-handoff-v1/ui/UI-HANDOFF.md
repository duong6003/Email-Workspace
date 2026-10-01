# Mailcraft UI/UX handoff for EOW

## 1. Product model

Mailcraft appears as an EOW content-authoring capability, but keeps its own focused visual identity and editing workspace.

Use two UI modes:

| Mode | EOW shell | Mailcraft surface | Purpose |
|---|---|---|---|
| Management | Full EOW navigation | Template list, imports, assets, versions | Browse and manage |
| Focus editor | Compact EOW header | Full Mailcraft canvas workspace | Create without losing context |

The editor must not be embedded in an iframe. It is mounted as a route-level frontend package and receives navigation, identity and permissions through a host bridge.

## 2. Focus editor layout

| Region | Default width | Content |
|---|---:|---|
| EOW compact header | full width, 56px high | Back, document title, save state, preview, publish |
| Mailcraft tool rail | 56px | Insert, Structure, Reusable blocks, Assets |
| Workspace panel | 320px, expandable to 480px | Active library/tree/tool |
| Canvas | flexible | Email document and device preview |
| Inspector | 336px, expandable to 480px | Properties of the selected node |

All tool panels use one workspace shell with the same header, search region, scroll behavior, footer/actions and compact/expanded modes. This prevents Topic, Template library, Assets and Structure from opening at unrelated sizes.

## 3. Navigation hierarchy

~~~mermaid
flowchart TD
    A["EOW / Content"] --> B["Mailcraft templates"]
    B --> C["Create blank"]
    B --> D["Import HTML"]
    B --> E["Open template"]
    E --> F["Focus editor"]
    F --> G["Preview"]
    F --> H["Publish"]
    H --> I["EOW published resource"]
~~~

The Back action follows this order:

1. close the active modal or expanded tool;
2. exit preview;
3. return from focus editor to Mailcraft template management;
4. return to the prior EOW route.

Dirty changes trigger a Save draft / Discard / Stay confirmation. Back never silently deletes a draft.

## 4. Editor responsibilities

### Left side

- Insert only atomic elements and structural layouts.
- Structure shows the component tree with expand/collapse per node and expand/collapse all.
- Reusable Block Library is separate from Insert.
- Assets manages images, logos and replacement mapping.

### Canvas

- Root document accepts Section insertion.
- Section accepts Row or a single element wrapped by an automatic one-column Row.
- Row accepts Column layouts.
- Column accepts content elements and nested layout where supported.
- Drop targets must highlight exactly one destination and stop event propagation after acceptance.

### Inspector

Inspector content is derived from the selected node type:

- Document: theme, width, global background, default typography.
- Section/Column: spacing, surface, border, radius, gradient and safe fallback.
- Text/Heading: content, typography and responsive overrides.
- Image/Logo: source, alt, size, link and decorative mode.
- Button: label, URL, alignment, padding and email-safe style.
- Custom HTML: sanitized code editor and validation report.

## 5. Visual direction

Mailcraft keeps its independent brand tone while reusing EOW interaction conventions.

Primary colors:

- primary/icon: #173F33;
- deep wordmark/ink: #18342C;
- warm application background: #F3F1ED;
- canvas background: #E9E7E2;
- white surface: #FFFFFF.

Use green for selected/editor state, not for every container. Keep canvas surfaces neutral so email designs retain visual priority.

## 6. Responsive policy

The full editor targets desktop widths of 1280px and above.

- 1024–1279px: only one side panel open at a time.
- Below 1024px: management and preview remain available; full drag/drop editing displays an unsupported-width explanation.
- Tool panels use overlay mode on constrained widths.

## 7. Accessibility baseline

- All icon-only actions have accessible names and tooltips.
- Keyboard focus remains visible.
- Tree navigation supports arrow keys, Enter and Space.
- Drag/drop actions have equivalent Add/move commands.
- Color is not the only dirty/error/selection indicator.
- Modal focus is trapped and restored to its trigger.

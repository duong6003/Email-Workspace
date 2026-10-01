# Visual acceptance

For every migrated screen, capture the handoff baseline and the production render at:

- Desktop: 1440 × 900
- Tablet: 768 × 1024
- Mobile: 390 × 844

Verify layout, typography, color, spacing, assets, copy, focus order, keyboard operation,
responsive behavior and all applicable loading, empty, error, success, permission-denied and
reconnecting states. A pixel difference is not automatically a defect when caused by dynamic
data or browser rasterization, but every material difference requires an explicit explanation.

Trace each screen to its business-rule IDs, API operations, realtime events and automated
tests. Store generated screenshots in the run evidence directory, not in the handoff source.

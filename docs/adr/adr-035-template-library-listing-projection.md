# ADR-035: Content projection on the template library endpoint

Status: Accepted

Supersedes nothing. Narrows the response of `GET /templates` under AGENTS.md section 5,
which requires an ADR for any removal from a published contract. Template storage,
sanitisation, versioning and the draft/publish lifecycle are untouched — this is a
response-shape decision only.

## Context

`GET /templates` returned the full `Template` schema for every row, including `html` and
`textBody`. A template's `html` is accepted up to 5 MB (`TemplateImportOverlay` enforces
the same ceiling client-side), and all three callers of the endpoint request
`limit: 100`. The listing therefore scaled with total content size rather than with row
count: a hundred large templates moved hundreds of megabytes to render a grid whose cards
display only `name`, `subject`, `status` and `updatedAt`.

That was tolerable while the cards were decorative mockups, because nothing rendered the
content. It stopped being tolerable when the library cards began showing each template's
own HTML as a thumbnail
(`docs/superpowers/specs/2026-08-26-template-editor-layout-and-thumbnails-design.md` §1.2,
§5): the thumbnail needs content for the handful of cards actually on screen, not for
every row in the tenant.

## Decision

`GET /templates` returns a new `TemplateSummary` schema — `Template` minus `html` and
`textBody`. Every other field is preserved verbatim, including `validation` and the
nullable `latestVersionId`, because the grid and its overflow menu read them.

Content is fetched per template from the existing `GET /templates/{id}`, driven by an
`IntersectionObserver` so only cards entering the viewport pay for it. The API side is
`TemplateSummaryResponse = Omit<TemplateResponse, 'html' | 'textBody'>` with a
`templateSummaryResponse()` mapper, mirroring the existing `TemplateVersionSummary` split
that already keeps content out of `GET /templates/{id}/versions`. The two list endpoints
now follow one rule: **lists carry metadata, detail routes carry content.**

`Template` itself is left unchanged and still backs `GET /templates/{id}`, `POST`,
`PATCH` and the publish routes. No caller loses access to content; it moves one request
away.

## Consequences

- **`contracts:compat-check` does not flag this change, and that is a gap, not an
  endorsement.** The script compares schemas by name and never resolves `$ref`
  (`scripts/openapi-compat-check.mjs`): `Template` is untouched, `TemplateSummary` is a
  new name with no baseline, and `TemplateListResponse.required` is still `[items]`.
  A response narrowed by repointing a `$ref` at a smaller schema is invisible to it.
  This ADR is the record the gate could not produce. A future agent must not read a clean
  compat-check as proof that a listing response is unchanged.
- The web client's `listTemplates` returns `EmailTemplateSummary`. TypeScript — not the
  contract gate — was what actually caught the two callers holding listed rows in
  `EmailTemplate[]` state (`TemplatePickerOverlay`, `TemplatesScreen`); both were narrowed
  rather than widened back. The overlays reached from the grid take `EmailTemplateSummary`
  props, which is sound because each fetches its own content through the preview and
  test-send routes.
- Any future consumer that needs content for a whole page of templates must add a
  purpose-built endpoint or an explicit opt-in parameter. Restoring `html` to the default
  listing would reintroduce the size coupling this decision exists to remove.
- A card whose detail fetch fails, times out, or exceeds the 512 KB thumbnail ceiling
  falls back to the previous decorative poster, so removing content from the listing
  cannot leave the grid blank.

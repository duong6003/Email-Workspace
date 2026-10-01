import { createElement, Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { autosaveReducer, type AutosaveAction, type AutosaveState } from '../../../api/autosave-reducer.js';
import { ApiError } from '../../../api/problem.js';
import { createSequenceGuard } from '../../../api/sequence-guard.js';
import { analyzeTemplate, getTemplate, listTemplates, listTemplateVersions, previewTemplateDraft, publishTemplate, restoreTemplateVersion, updateTemplate, type EmailTemplate, type EmailTemplateSummary, type TemplateAnalysis, type TemplatePatch, type TemplatePreview, type TemplateVariableCatalogueItem, type TemplateVersion, type TemplateVersionSummary } from '../../../api/templates.js';
import { useSetFocusHeader } from '../../../app/focus-header-context.js';
import { UiIcon } from '../../../app/ui-icons.js';
import { ModalFrame } from '../../../components/ModalFrame.js';
import { useSession } from '../../../auth/use-session.js';
import { TEMPLATE_CONFLICT_FIELD_LABEL, TEMPLATE_PREVIEW_SAMPLE, groupTemplateCatalogue, insertTemplateVariable, templateConflictExcerpt, templateContentIsReadOnly, templateLoadFailure } from '../template-editor.js';
import { LINT_MESSAGE } from '../lint-messages.js';
import { TemplateCodeView } from '../TemplateCodeView.js';
import { createEmailEditorEngine, type Asset, type AssetProvider, type VariableProvider } from '../editor-ports.js';
import { defaultTheme, IMAGE_BEARING_KINDS, SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABEL, type ContactBlock, type Doc, type EmailTheme, type FooterBlock, type InlineMark, type InlineMarkKind, type Node, type SocialLink, type TableBlock } from './document.js';
import { socialGlyph } from './emitter.js';
import { backNavigationAction } from './back-navigation.js';
import { BLOCK_CATALOG, BLOCK_GROUP_LABEL, INSERT_PANEL, type BlockGroup } from './blocks.js';
import { ancestorsOf, defaultInsertTarget, describeInsert, findNode, planInsert, requiredParentKind, type DropEdge, type InsertDestination, type InsertPlan } from './tree-ops.js';
import { dropEdge } from './drop-position.js';
import { createReusableBlock, deleteReusableBlock, getReusableBlock, listReusableBlocks, renameReusableBlock, type ReusableBlockSummary } from '../../../api/reusable-blocks.js';
import { filterReusableBlocks, foldVietnamese, reusableBlockAuthorLabel } from './reusable-blocks.js';
import { columnGrow, isActiveRowLayout, matchingRowLayouts } from './row-layouts.js';
import { leafTextStyle, nodeSurfaceStyle } from './canvas-style.js';
import { diffEdit, inlineMarkCovers, inlineSegments, segmentTagNames, shiftInlineMarks, toggleInlineMark } from './inline.js';
import { archiveAsset, listAssets, replaceAsset, updateAssetKind, uploadAsset, type AssetKind } from '../../../api/assets.js';
import { assetSizeLabel, assetUploaderLabel, missingAssetNodes, type MissingAsset } from './assets.js';
import { imageAltMissing, inspectorFieldsForNode, type InspectorField, type InspectorTab } from './inspector-fields.js';
import { nodeLowContrast } from './content-contrast.js';
import { INSPECTOR_PANEL_WIDTH, otherPanelSize, RAIL_DESTINATIONS, railDestination as railEntryFor, WORKSPACE_PANEL_WIDTH, type PanelSize, type RailDestination, type RailEntry, type RailPanelId } from './workspace-shell.js';
import { clampBaseFontSize, THEME_FONT_OPTIONS, THEME_FONT_SIZE_RANGE, THEME_WIDTHS, themePreview } from './theme-sheet.js';
import { codePipeline, codeResult, screenCustomCode, type CodeTab } from './custom-code.js';
import { filterReviewIssues, readinessPercent, reviewCounts, reviewIssues, type ReviewFilter } from './content-review.js';
import { freezeSummary, publishReadiness } from './publish-readiness.js';
import { recipientCaption, recipientInitial, recipientLabel, recipientMergeData } from './preview-recipients.js';
import { listRecipients, type Recipient } from '../../../api/recipients.js';
import { filterLibraryTemplates, TEMPLATE_LIBRARY_FILTERS, templateThumbTone, type TemplateLibraryFilter } from './template-library.js';
import { TemplateVersionHistory } from '../TemplateVersionHistory.js';
import { collapseAllIds, expandAllIds, leftKeyResult, moveFocus, rightKeyResult, toggleExpanded, visibleTreeRows, type TreeRow } from './structure-tree.js';

type BuilderState = AutosaveState<EmailTemplate, TemplatePatch>;
type BuilderAction = AutosaveAction<EmailTemplate, TemplatePatch>;

/** Same loaded/unloaded split TemplateEditorScreen uses -- the generic autosave reducer needs a draft to start from. */
function builderReducer(state: BuilderState | null, action: BuilderAction): BuilderState | null {
  if (state) return autosaveReducer(state, action);
  return action.type === 'saved' ? { draft: action.draft, pending: null, inFlight: null, status: 'saved' } : state;
}

function blankDoc(): Doc {
  return { title: '', nodes: [], variables: [], theme: defaultTheme };
}

/**
 * The variable panel's scope tabs (`v3-scope-tabs`, ADR-044 Task SV-5). The
 * prototype's five scopes are `all` plus recipient/shared/system/template;
 * EOW's catalogue names the middle one `global`, and `groupTemplateCatalogue`
 * already groups by that key -- so the tabs filter the groups that exist
 * rather than introducing a sixth vocabulary for the same four things.
 */
type VariableScope = 'all' | 'system' | 'global' | 'recipient' | 'template';
const VARIABLE_SCOPES: ReadonlyArray<{ id: VariableScope; label: string }> = [
  { id: 'all', label: 'Tất cả' },
  { id: 'recipient', label: 'Người nhận' },
  { id: 'global', label: 'Dùng chung' },
  { id: 'system', label: 'Hệ thống' },
  { id: 'template', label: 'Template' },
];

/** One rail icon per destination (UI-HANDOFF §2). Reuses the existing icon set rather than adding new glyphs -- `plus` (insert), `template` (a document's own structure), `copy` (duplicate/reuse), `upload` (asset library, matching the catalog's own `upload` action name). */
/** One icon per rail destination. The prototype draws its own glyphs (`v3-icon`); EOW has an icon set already, and ADR-044 ports DOM and class names, not artwork. */
const RAIL_ICON: Record<RailDestination, Parameters<typeof UiIcon>[0]['name']> = {
  templates: 'mail', insert: 'plus', reusable: 'copy', structure: 'template', theme: 'settings',
  variables: 'edit', assets: 'upload', review: 'check', history: 'refresh',
};

/** The inspector's three tabs (`v3-tabs`), ADR-044 Task SV-2. */
const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'content', label: 'Nội dung' },
  { id: 'design', label: 'Thiết kế' },
  { id: 'advanced', label: 'Nâng cao' },
];

/**
 * ADR-044 Task SV-2. Written out per kind rather than built as
 * `v3-${node.kind}`: ARCH-MAILCRAFT-DOM reads class names out of the source
 * text, so an interpolated name is a ported class the gate cannot see -- it
 * would read as un-ported forever and the register would carry a row for work
 * that was already done. Same lesson as the `\b` false match SV-3 found, from
 * the other direction.
 */
const CONTAINER_CLASS: Record<'section' | 'row' | 'column', string> = { section: 'v3-section', row: 'v3-row', column: 'v3-column' };

/**
 * `studio.tsx`'s `nodeName()`, kind for kind. It is a DIFFERENT list from the
 * Insert panel's labels and the prototype keeps them different on purpose --
 * the panel offers a "Section trống", the tag on the canvas just says
 * "Section". Six of these had drifted (Khối, Văn bản, Khoảng trắng, Bảng,
 * Thông tin liên hệ, HTML tuỳ chỉnh), so the name on a block did not match the
 * name of the button that made it.
 */
const NODE_LABEL: Record<Node['kind'], string> = {
  section: 'Section', row: 'Hàng', column: 'Cột', heading: 'Tiêu đề', text: 'Đoạn văn', list: 'Danh sách', button: 'Nút bấm', image: 'Hình ảnh', divider: 'Đường ngăn', spacer: 'Khoảng cách',
  banner: 'Banner', logo: 'Logo', social: 'Mạng xã hội', table: 'Bảng dữ liệu', contact: 'Liên hệ', footer: 'Chân thư', preheader: 'Preheader', customHtml: 'HTML/CSS',
};

/** One glyph per catalog kind, `v3-block-scroll section>button>i` (studio.tsx's own `blocks` array icons, extended for `row`/`column` which have no prototype entry -- ADR-044 clause 2, and for `footer` which has no prototype entry either -- ADR-050). */
const BLOCK_ICON: Record<Node['kind'], string> = {
  text: 'T', heading: 'H', list: '☰', image: '▧', banner: '▰', logo: 'A', button: '↗', social: '◎',
  section: '▱', row: '▬', column: '❘', table: '▤', divider: '—', spacer: '↕',
  contact: '@', footer: '⎯', preheader: 'P', customHtml: '</>',
};

/** Insert panel group order, matching the prototype's `blocks` array (studio.tsx). */
const BLOCK_GROUP_ORDER: readonly BlockGroup[] = ['content', 'media', 'action', 'layout', 'email'];

/**
 * MC-UI-003's tree (Task 19). Roving tabindex (WAI-ARIA treeview pattern):
 * only the selected row is in the tab order, arrow keys move both focus and
 * selection together (structure-tree.ts's `moveFocus`/`rightKeyResult`/
 * `leftKeyResult`) so the inspector on the right updates the same way a
 * canvas click already does. The disclosure chevron is mouse-only
 * (`tabIndex={-1}`) -- keyboard expand/collapse goes through ArrowRight/Left
 * on the row itself, which is the one thing in the tab order.
 */
function StructureTreeView({ rows, selectedId, expandedIds, readOnly, onSelect, onToggleExpand, onToggleVisible, onToggleLocked, onRename, onKeyDown }: {
  rows: TreeRow[];
  selectedId: string | null;
  expandedIds: ReadonlySet<string>;
  readOnly: boolean;
  onSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onToggleLocked: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onKeyDown: (event: { key: string; preventDefault: () => void }, id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  // Roving tabindex moves the *candidate* tab stop on every render (above),
  // but the browser never shifts actual DOM focus by itself -- without this,
  // ArrowDown updates which row *would* receive Tab, while the key events
  // keep firing on the row the user physically focused first.
  useEffect(() => {
    if (selectedId) containerRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [selectedId]);
  if (rows.length === 0) return <p className="builder-node-empty" data-mc-state="MC-UI-003.empty">Canvas trống — chưa có gì để hiện trong cây cấu trúc.</p>;
  return <div ref={containerRef} role="tree" aria-label="Cấu trúc tài liệu" className="builder-structure-tree v3-layer-scroll" data-mc-state="MC-UI-003.success">
    {rows.map((row) => {
      const expanded = row.hasChildren ? expandedIds.has(row.id) : undefined;
      const selected = row.id === selectedId;
      return <div
        key={row.id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={expanded}
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        className={`v3-layer builder-structure-row${selected ? ' active builder-structure-row-selected' : ''}`}
        style={{ paddingLeft: `${row.depth * 16 + 8}px` }}
        onClick={(event) => { event.stopPropagation(); onSelect(row.id); }}
        onKeyDown={(event) => onKeyDown(event, row.id)}
      >
        {row.hasChildren
          ? <button type="button" aria-label={expanded ? 'Thu gọn' : 'Mở rộng'} tabIndex={-1} className="v3-layer-toggle" onClick={(event) => { event.stopPropagation(); onToggleExpand(row.id); }}>{expanded ? '▾' : '▸'}</button>
          : <span className="v3-layer-dot" aria-hidden="true">·</span>}
        {/* ADR-044: `studio.tsx`'s `nodeName(n, l)` is `n.name || <default for the kind>`.
            EOW only ever had the fallback half, so nine columns read as nine identical
            rows. Double-click renames, which is where the prototype's Layers panel puts
            it and where the reusable-block list already puts its own rename. */}
        {renamingNodeId === row.id
          ? <input
              className="v3-layer-rename" autoFocus defaultValue={row.name ?? ''} maxLength={60}
              placeholder={NODE_LABEL[row.kind]}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => { onRename(row.id, event.currentTarget.value); setRenamingNodeId(null); }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') { onRename(row.id, event.currentTarget.value); setRenamingNodeId(null); }
                else if (event.key === 'Escape') setRenamingNodeId(null);
              }}
            />
          : <span className="v3-layer-select" onDoubleClick={() => { if (!readOnly) setRenamingNodeId(row.id); }} title={row.name ? `${row.name} (${NODE_LABEL[row.kind]}) — bấm đúp để đổi tên` : 'Bấm đúp để đặt tên'}>
              <b>{row.name ?? NODE_LABEL[row.kind]}</b>
            </span>}
        {/* ADR-044 restoration (Task SV-3): per-row visibility and lock, lost when the tree became a flat DOM port -- studio.tsx's `Layers`/`LayerNodes` (`patch(id, {visible: ...})` / `patch(id, {locked: ...})`). */}
        <button type="button" tabIndex={-1} disabled={readOnly} title={row.visible ? 'Ẩn khỏi email' : 'Hiện lại trong email'} aria-label={row.visible ? 'Ẩn khỏi email' : 'Hiện lại trong email'} onClick={(event) => { event.stopPropagation(); onToggleVisible(row.id); }}>{row.visible ? '◉' : '○'}</button>
        <button type="button" tabIndex={-1} disabled={readOnly} title={row.locked ? 'Mở khoá' : 'Khoá chỉnh sửa'} aria-label={row.locked ? 'Mở khoá' : 'Khoá chỉnh sửa'} onClick={(event) => { event.stopPropagation(); onToggleLocked(row.id); }}>{row.locked ? '◆' : '◇'}</button>
      </div>;
    })}
  </div>;
}

/** `{{key}}` highlighted on the canvas the way spec §2.9 asks (a pale-yellow `<mark>`) -- an approximation of the final email, not a second renderer: the sanitized HTML the server produces is still `emitDoc`'s job alone. ADR-044 Task SV-5 puts the prototype's own `v3-var` chip class on it; `studio.tsx` draws the same idea with a `<span>`, and the `<mark>` element is kept because it says "highlighted" to a screen reader where a span says nothing. */
function highlightVariables(content: string): ReactNode[] {
  // `<i>` is the prototype's own marker on a variable chip (studio.tsx's
  // `renderInline`). Not decoration: the chip is otherwise distinguished by its
  // green background alone, and UI-HANDOFF section 7 asks for a second signal.
  // `aria-hidden` keeps the glyph out of the block's accessible name.
  return content.split(/(\{\{[a-z][a-z0-9_]{0,63}\}\})/g).map((part, index) => (/^\{\{.*\}\}$/.test(part) ? <mark className="v3-var" key={index}>{part}<i aria-hidden="true">◇</i></mark> : part));
}

/**
 * ADR-046: the canvas half of inline rich text.
 *
 * Reads `inlineSegments` -- the same function `emitter.ts` serializes for the
 * mail -- and builds React ELEMENTS from it. Never `dangerouslySetInnerHTML`:
 * the canvas is handed a checked structure, not a string it would have to
 * trust, which is why the client boundary needs no sanitizer of its own
 * (ADR-046 decision 3). It is also what the prototype does (`renderInline`,
 * studio.tsx:828).
 *
 * A block with no marks takes the same path it always did, so an unformatted
 * paragraph renders through exactly the code it rendered through yesterday.
 *
 * `href` is deliberately NOT put on the canvas anchor. The canvas is the
 * click-to-select surface (Task 17) and a live link there would navigate away
 * from the editor mid-edit; `emitter.ts` is what puts the real destination in
 * the mail. The element is still an `<a>` so the author sees link styling.
 */
function renderInlineContent(node: Node): ReactNode[] {
  const segments = inlineSegments(node.content ?? '', node.inline);
  if (segments.length === 0) return [];
  if (segments.every((segment) => segment.marks.length === 0)) return highlightVariables(node.content ?? '');
  return segments.map((segment, index) => {
    const inner: ReactNode = highlightVariables(segment.text);
    // Innermost first, so the outermost tag ends up outermost -- the same
    // nesting order `INLINE_MARK_ORDER` gives the emitter.
    const wrapped = [...segmentTagNames(segment)].reverse().reduce<ReactNode>(
      (child, tag) => createElement(tag, tag === 'a' ? { title: segment.href } : {}, child),
      inner,
    );
    return <Fragment key={index}>{wrapped}</Fragment>;
  });
}

/**
 * What a leaf block looks like on the canvas.
 *
 * ADR-044 Task SV-5 (scope decision, 2026-09-05): the prototype's `Preview`
 * draws each leaf for real -- a styled anchor, the actual image, a real
 * `<table>` -- while S4 drew several of them as a sentence ("Bảng 3×3",
 * "Chưa bật liên kết mạng xã hội nào"). Six kinds now render for real behind
 * the prototype's own `v3-p-*` and `v3-table` classes.
 *
 * `customHtml` is the deliberate exception and keeps its summary chip. Drawing
 * it would mean `dangerouslySetInnerHTML` on the canvas -- the one thing
 * ADR-044 names as somewhere this repo is AHEAD of the prototype, having put
 * the preview inside `<iframe sandbox="">`. Un-sandboxed markup here to match a
 * picture would trade that away, so `v3-custom` stays an addressed exclusion in
 * `ARCH-MAILCRAFT-DOM` rather than a port.
 *
 * This is still not the email. The canvas is the click-to-select surface
 * (Task 17); the pixel-accurate render is the server's, behind the "Xem trước"
 * toggle. What changed is that the approximation now looks like the thing.
 */
function CanvasLeafPreview({ node }: { node: Node }) {
  // `v3-p-heading` / `v3-p-text` (studio.tsx's `Preview`, which passes the class
  // straight to `Rich`). Ported for the metrics the author cannot set --
  // line-height and letter-spacing -- while size, weight and family stay inline
  // from the block's own properties and the email theme, because those are what
  // `emitter.ts` puts in the mail. A canvas drawn in the prototype's fixed
  // Georgia 28px would be a preview of an email that does not exist.
  if (node.kind === 'heading' || node.kind === 'text') {
    return <span className={`v3-p-${node.kind}`} style={leafTextStyle(node)}>
      {node.content ? renderInlineContent(node) : <em>Trống</em>}
    </span>;
  }
  /**
   * ADR-048. Drawn as a real list rather than a sentence, for the reason Task
   * SV-5 gave for the other six kinds: the canvas should look like the thing.
   * The item split is the emitter's own rule -- one line, one item -- so what
   * the author counts here is what the email carries.
   */
  if (node.kind === 'list') {
    const items = (node.content ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (items.length === 0) return <span className="v3-p-text"><em>Danh sách trống</em></span>;
    const ListTag = node.ordered ? 'ol' : 'ul';
    return <ListTag className="v3-p-list" style={{ ...leafTextStyle(node), display: 'block', listStyleType: node.listStyle, paddingLeft: node.paddingLeft ?? 24, margin: 0 }}>
      {items.map((item, index) => <li key={index}>{highlightVariables(item)}</li>)}
    </ListTag>;
  }
  if (node.kind === 'button') {
    // A real anchor with the variant's own colours, but `preventDefault` --
    // the canvas is for selecting a block, and a click that navigated away
    // would lose the draft the author is editing.
    const accent = node.accent ?? '#173f33';
    return <div className={`v3-p-button width-${node.buttonWidth ?? 'auto'}`} style={{ textAlign: node.align ?? 'left' }}>
      <a
        href={node.href || undefined}
        className={`${node.buttonVariant ?? 'solid'} ${node.buttonSize ?? 'md'}`}
        onClick={(event) => event.preventDefault()}
        style={{
          background: node.buttonVariant === 'solid' || !node.buttonVariant ? accent : node.buttonVariant === 'soft' ? `${accent}18` : 'transparent',
          color: node.buttonVariant === 'solid' || !node.buttonVariant ? (node.textColor ?? '#ffffff') : accent,
          borderColor: accent,
          borderRadius: node.radius ?? 6,
        }}
      >{node.content ? highlightVariables(node.content) : 'Nút bấm'}</a>
      {!node.href?.trim() && <small>⚠ Chưa có địa chỉ liên kết</small>}
    </div>;
  }
  if (node.kind === 'image' || node.kind === 'banner') return node.src
    ? <div className={`v3-p-image ${node.kind}`} style={{ maxWidth: `${node.maxWidth ?? 100}%` }}>
        <img src={node.src} alt={node.alt ?? ''} style={{ borderRadius: node.radius, width: '100%' }} />
        {node.caption && node.kind === 'image' && <p>{node.caption}</p>}
        {/* The same finding `IMAGE_ALT_MISSING` reports, said where the block is. */}
        {!node.alt?.trim() && !node.decorative && <small>⚠ Thiếu mô tả ảnh</small>}
      </div>
    // studio.tsx renders this as `<button><span>▧</span><b>Chọn hình ảnh</b>...`.
    // The icon and the label are ported; the button is not. It sits inside a
    // node that is already `role="button"`, and a real button nested in one is
    // an interactive control inside an interactive control -- the prototype has
    // no roles on its nodes, so the question never came up there. Opening the
    // asset library stays where the rail put it.
    : <span className="builder-node-empty v3-media-empty">
        <span aria-hidden="true">▧</span>
        <b>{node.kind === 'banner' ? 'Chưa có ảnh banner' : 'Chưa có URL ảnh'}</b>
      </span>;
  if (node.kind === 'divider') return <hr style={{ border: 0, borderTop: `${node.height ?? 1}px solid ${node.accent ?? '#dcd8d0'}` }} />;
  if (node.kind === 'spacer') return <div className="v3-p-spacer" style={{ height: node.height ?? 32 }}><span>{node.height ?? 32}px</span></div>;
  if (node.kind === 'logo') return <div className="v3-p-logo" style={{ fontSize: node.height ?? 36, color: node.accent, textAlign: node.align ?? 'left' }}>
    {node.src
      ? <img src={node.src} alt={node.alt || node.content || 'Logo'} style={{ height: node.height ?? 36, width: 'auto' }} />
      : <b>{node.content || 'Logo'}</b>}
  </div>;
  if (node.kind === 'social') {
    const links = (node.social ?? []).filter((link) => link.enabled);
    // ADR-052: the shape class was always in globals.css (`.v3-p-social.circle/.square/.text`,
    // vendored verbatim by ARCH-HANDOFF) with nothing ever appending it -- restored here,
    // and the glyph comes from the same `socialGlyph` the emitted email uses, so canvas and
    // email cannot show two different somethings for the same link (the ADR-042 lesson).
    const shape = node.socialStyle ?? 'circle';
    const size = node.socialSize ?? 32;
    return links.length > 0
      ? <div className={`v3-p-social ${shape}`} style={{ justifyContent: node.align ?? 'left', gap: 8 }}>
          {links.map((link) => <a
            key={link.id}
            className={link.url.trim() ? '' : 'missing'}
            href={link.url.trim() || undefined}
            title={link.label || SOCIAL_PLATFORM_LABEL[link.platform]}
            aria-label={link.label || SOCIAL_PLATFORM_LABEL[link.platform]}
            onClick={(event) => event.preventDefault()}
            style={{ width: shape === 'text' ? 'auto' : size, height: shape === 'text' ? 'auto' : size, lineHeight: shape === 'text' ? undefined : `${size}px`, color: node.accent }}
          >{socialGlyph(link)}{!link.url.trim() && <small>!</small>}</a>)}
        </div>
      : <span className="builder-node-empty">Chưa bật liên kết mạng xã hội nào</span>;
  }
  if (node.kind === 'table' && node.table) {
    const table = node.table;
    return <div className="v3-table" style={{ borderRadius: node.radius }}>
      <table>
        {table.caption && <caption>{table.caption}</caption>}
        <tbody>
          {table.cells.map((row, rowIndex) => <tr key={rowIndex}>
            {row.map((cell, cellIndex) => {
              const Cell = table.header && rowIndex === 0 ? 'th' : 'td';
              return <Cell
                key={cellIndex}
                style={{
                  padding: table.cellPadding,
                  textAlign: table.align,
                  borderColor: table.borderColor,
                  background: table.header && rowIndex === 0 ? table.headerBg : table.zebra && rowIndex % 2 === 0 ? table.altBg : table.rowBg,
                  color: table.header && rowIndex === 0 ? table.headerColor : undefined,
                }}
              >{highlightVariables(cell)}</Cell>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>;
  }
  // `v3-p-preheader`: the prototype gives this its own dashed box because a
  // preheader is text that never appears in the email body, and the box is what
  // says so. It was rendering in the generic `builder-node-empty` italic, which
  // says "nothing here" about a block that may well have content.
  if (node.kind === 'preheader') return <div className="v3-p-preheader">{node.content ? highlightVariables(node.content) : <em>Preheader trống</em>}</div>;
  // See the doc comment: drawing this needs dangerouslySetInnerHTML on the
  // canvas, which is the protection ADR-044 records as this repo's own.
  // A Thông tin liên hệ block had no branch here at all, so `CanvasLeafPreview`
  // fell through to `return null` and the block was an empty box on the canvas
  // -- selectable, emitted into the mail, and invisible to the person writing
  // it. Assembled the way `emitContact` assembles it, so the canvas and the
  // mail drop the same empty fields instead of showing "· ·".
  if (node.kind === 'contact') {
    const card = node.contact;
    const who = [card?.name, card?.role].filter(Boolean).join(' · ');
    const reach = [card?.email, card?.phone].filter(Boolean).join(' · ');
    const lines = [who, reach, card?.address].filter(Boolean) as string[];
    return <div className="v3-p-contact" style={{ fontSize: `${node.fontSize ?? 14}px`, color: node.textColor, textAlign: node.align ?? 'left' }}>
      {lines.length > 0
        ? lines.map((line, index) => <span key={index} style={{ display: 'block' }}>{highlightVariables(line)}</span>)
        : <em>Chưa điền thông tin liên hệ</em>}
    </div>;
  }
  // ADR-050. Same reason `contact` has a branch and the same shape:
  // `emitFooter` assembles company name then address lines, dropping empty
  // pieces, so the canvas drops the same ones instead of showing a stray
  // separator or an empty box nobody can select meaningfully.
  if (node.kind === 'footer') {
    const f = node.footer;
    const lines = [f?.companyName, ...(f?.address ?? '').split('\n')].map((line) => line?.trim()).filter(Boolean) as string[];
    return <div className="v3-p-footer" style={{ fontSize: `${node.fontSize ?? 12}px`, color: node.textColor, textAlign: node.align ?? 'center' }}>
      {lines.length > 0
        ? lines.map((line, index) => <span key={index} style={{ display: 'block' }}>{highlightVariables(line)}</span>)
        : <em>Chưa điền địa chỉ bưu chính</em>}
    </div>;
  }
  if (node.kind === 'customHtml') return node.html?.trim()
    ? <code className="builder-custom-html-chip">{node.html.length} ký tự HTML{node.css?.trim() ? ` · ${node.css.trim().length} ký tự CSS` : ''}</code>
    : <span className="builder-node-empty">Chưa có mã HTML</span>;
  return null;
}

/** The MIME type a library button's drag payload carries -- a block kind, nothing else (Task 20 is insert-by-drag only; reordering already has a keyboard-equivalent in the inspector's up/down buttons, so dragging an existing node is out of scope here). */
export const DRAG_BLOCK_KIND_TYPE = 'application/x-mailcraft-block';
/**
 * The second drag payload, and the one the port never had: a node already on
 * the canvas, being moved rather than created. The prototype carries the same
 * split (`mc/block` vs `mc/node`, studio.tsx:554) because the two drops do
 * different things -- one mints a node, the other relocates one -- and the
 * receiving handler has to be able to tell them apart before it acts.
 */
export const DRAG_NODE_ID_TYPE = 'application/x-mailcraft-node';
/**
 * The third payload, matching the prototype's `mc/saved` (studio.tsx:762): a
 * block from the reusable library. It carries an id rather than a tree because
 * the tree lives on the server -- `getReusableBlock` fetches it, and the drag
 * starts that fetch so the indicator can show the real thing rather than a
 * placeholder.
 */
export const DRAG_REUSABLE_ID_TYPE = 'application/x-mailcraft-reusable';
const DRAG_TYPES = [DRAG_BLOCK_KIND_TYPE, DRAG_NODE_ID_TYPE, DRAG_REUSABLE_ID_TYPE];
const carriesBlock = (transfer: DataTransfer): boolean => DRAG_TYPES.some((type) => transfer.types.includes(type));

type DropAt = { id: string; edge: DropEdge };

type CanvasNodeProps = {
  node: Node;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * Where the drop will land, resolved by `planInsert` -- the same call
   * `insertNode` makes. Passing the PLAN rather than the hovered node is the
   * whole fix: the indicator used to draw beside whatever the cursor was over,
   * which is only the destination for leaf kinds. A Row dropped on a text leaf
   * lands beside that leaf's Row, two levels up, and the line was drawn inside
   * the Column regardless.
   */
  dropPlan: InsertPlan | null;
  /** The block being dragged -- a catalog node when creating, the node itself when moving -- so the indicator shows the real thing rather than a placeholder. */
  ghost: Node | null;
  /** The node being moved, if this drag is a move. Its own subtree is dimmed: it is about to leave. */
  movingId: string | null;
  onNodeDragStart: (id: string, event: ReactDragEvent) => void;
  onNodeDragOver: (id: string, event: ReactDragEvent) => void;
  onNodeDrop: (id: string, event: ReactDragEvent) => void;
  onDragFinished: () => void;
};

/**
 * Where the block will land, drawn between the two blocks it will land between.
 *
 * Before this, `dragOverId` outlined the block under the cursor and
 * `insertNode` appended to the end of that block's container -- so the outline
 * marked a position the block would not take. Measured: dropping on the first,
 * middle or last child of a column all produced `[a, b, c, new]`. The line is
 * only honest now because `insertNode` takes the edge as well.
 *
 * The ghost is the block's real canvas rendering (`CanvasLeafPreview`, the same
 * component the canvas uses), not a grey rectangle: what you see under the
 * cursor is what the drop produces. Containers have no leaf preview, so they
 * show their label alone rather than an empty box pretending to be content.
 */
function DropIndicator({ ghost }: { ghost: Node | null }) {
  const isContainer = ghost !== null && (ghost.kind === 'section' || ghost.kind === 'row' || ghost.kind === 'column');
  return <div className="builder-drop-indicator" aria-hidden="true">
    <span className="builder-drop-line" />
    {ghost && <div className="builder-node v3-node v3-leaf builder-node-ghost">
      <span className="builder-node-tag v3-tag">{NODE_LABEL[ghost.kind]}</span>
      {!isContainer && <CanvasLeafPreview node={ghost} />}
    </div>}
  </div>;
}

/** One node in the structural canvas (Task 17) -- not a pixel-accurate email preview (that is `PreviewService`, wired through the existing "Xem trước" toggle); this is the click-to-select (and, Task 20, drop-to-insert) surface. */
function CanvasNodeView({ node, selectedId, onSelect, dropPlan, ghost, movingId, onNodeDragStart, onNodeDragOver, onNodeDrop, onDragFinished }: CanvasNodeProps) {
  if (node.visible === false) return null;
  const selected = node.id === selectedId;
  // Two ways this node can be the destination: the block lands NEXT to it, or
  // it lands INSIDE it at the end. The second is what a drop on a container --
  // or on something the plan could not position precisely -- really does, and
  // drawing it at the container's foot says so instead of implying a slot.
  const besideMe = dropPlan?.at === 'beside' && dropPlan.anchorId === node.id ? dropPlan.edge : null;
  const insideMe = dropPlan?.at === 'end' && dropPlan.containerId === node.id;
  // The container that will actually change. The dashed outline says "this is
  // the block you are positioning against", which is a different sentence and
  // was the only one being said -- so a drag showed where the block would sit
  // and never which column was about to gain it.
  const receivingMe = dropPlan !== null && dropPlan !== undefined && dropPlan.containerId === node.id;
  const isContainer = node.kind === 'section' || node.kind === 'row' || node.kind === 'column';
  const children = node.children ?? [];
  return <>
    {besideMe === 'before' && <DropIndicator ghost={ghost} />}
    <div
    // ADR-044: the node/leaf selection-chrome classes are the prototype's
    // hover outline and active ring (Task SV-3, studio.tsx's CanvasNode),
    // tied to structure-tree selection sync (MC-UI-003). Task SV-2 adds the
    // per-kind layout classes beside them -- `v3-row` is the one that earns
    // its keep, `grid-auto-flow:column` is what finally puts a row's columns
    // side by side on the canvas instead of stacked.
    className={`builder-node builder-node-${node.kind} v3-node${isContainer ? ` ${CONTAINER_CLASS[node.kind as 'section' | 'row' | 'column']}` : ' v3-leaf'}${selected ? ' active builder-node-selected' : ''}${besideMe ? ' builder-node-drop-target' : ''}${receivingMe ? ' builder-node-drop-container' : ''}${node.id === movingId ? ' builder-node-moving' : ''}`}
    // The column's share of its row, handed to CSS rather than applied here, so
    // it only takes effect for a column that is actually inside a row -- the
    // rule is scoped `.builder-node-row>.builder-node-children>`. `.v3-row`'s
    // own `grid-auto-flow:column` never reached these: the children go through
    // a `.builder-node-children` wrapper, which is the single grid item the row
    // really has. See `columnGrow`.
    // The container's own surface -- padding, background, border, corners -- read
    // from `emitter.ts`'s helpers, so the canvas and the mail cannot disagree.
    // Eleven controls on a Section and a Column changed the email and left this
    // screen identical before.
    style={isContainer
      ? { ...(node.kind === 'column' ? { '--mc-col-grow': columnGrow(node.width) } : {}), ...(node.kind === 'row' ? {} : nodeSurfaceStyle(node)) } as CSSProperties
      : undefined}
    role="button"
    tabIndex={0}
    aria-pressed={selected}
    onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelect(node.id); } }}
    // decision 2 / Task 20: exactly one drop target lit at a time -- stopping
    // propagation means only the innermost node under the cursor ever calls
    // back, so a container never lights up behind the child it contains.
    // Leaves are drag SOURCES as well as targets (studio.tsx:822 does the same,
    // for leaves only). Containers stay targets: a draggable Section would
    // start a drag from anywhere inside it, including the text you meant to
    // click.
    draggable={!isContainer && node.locked !== true}
    onDragStart={(event) => { event.stopPropagation(); onNodeDragStart(node.id, event); }}
    onDragEnd={onDragFinished}
    onDragOver={(event) => { if (carriesBlock(event.dataTransfer)) { event.preventDefault(); event.stopPropagation(); onNodeDragOver(node.id, event); } }}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onNodeDrop(node.id, event); }}
  >
    {/* Not color alone (UI-HANDOFF §7): the checkmark is the real selected-state signal, the border is reinforcement. */}
    <span className="builder-node-tag v3-tag">{selected && '✓ '}{NODE_LABEL[node.kind]}</span>
    {isContainer
      ? <div className="builder-node-children">
          {children.map((child) => <CanvasNodeView key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} dropPlan={dropPlan} ghost={ghost} movingId={movingId} onNodeDragStart={onNodeDragStart} onNodeDragOver={onNodeDragOver} onNodeDrop={onNodeDrop} onDragFinished={onDragFinished} />)}
          {/* ADR-044 (Task SV-3): `v3-empty-col`/`v3-empty-section` -- the prototype gives Section and Column their own empty-state hint (studio.tsx's `CanvasNode`); an empty Row renders none there, so this repo-specific kind gets no v3- class either, matching that exactly. */}
          {/* B8. One generic sentence for both told the author nothing about
              which level accepts what. The prototype uses this exact spot to
              teach the rule ("Thả một bố cục vào Section" vs "Thả thành phần
              vào đây"), which is cheaper than any tooltip because it is already
              where the cursor is going. An empty Row still renders none, as in
              studio.tsx. */}
          {children.length === 0 && <span className={`builder-node-empty${node.kind === 'section' ? ' v3-empty-section' : node.kind === 'column' ? ' v3-empty-col' : ''}`}>
            {node.kind === 'section' ? '＋ Thả một bố cục (Hàng) vào Khối' : node.kind === 'column' ? '＋ Thả thành phần vào đây' : 'Trống — chèn khối vào đây'}
          </span>}
          {insideMe && <DropIndicator ghost={ghost} />}
        </div>
      : <CanvasLeafPreview node={node} />}
    </div>
    {besideMe === 'after' && <DropIndicator ghost={ghost} />}
  </>;
}

/**
 * The prototype's four inspector/sheet primitives (ADR-044 Task SV-2):
 * studio.tsx's own `Group`, `Field`, `Segment` and `Color`. Ported as
 * components rather than inlined so the theme sheet and the inspector cannot
 * drift apart -- which is exactly how EOW ended up with a flat field list in
 * the first place.
 */
function V3Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="v3-group"><h3>{title}</h3>{children}</section>;
}

function V3Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="v3-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function V3Segment({ values, value, set, label }: { values: ReadonlyArray<string>; value: string; set: (next: string) => void; label: string }) {
  return <div className="v3-segment" role="group" aria-label={label}>
    {values.map((option) => <button key={option} type="button" className={value === option ? 'active' : ''} aria-pressed={value === option} onClick={() => set(option)}>{option}</button>)}
  </div>;
}

/** The colour pair: a swatch and the hex beside it, both writing the same value. */
function V3Color({ value, set, label }: { value: string; set: (next: string) => void; label: string }) {
  return <div className="v3-color">
    <input type="color" value={value} aria-label={`${label} — chọn màu`} onChange={(event) => set(event.target.value)} />
    <input value={value} aria-label={`${label} — mã màu`} onChange={(event) => set(event.target.value)} />
  </div>;
}

/**
 * MC-UI-007 in the shape decision 2 chose: the prototype's `v3-sheet`, with a
 * live `v3-theme-preview` beside a two-column `v3-theme-grid`. The widgets are
 * the prototype's too -- a Segment for the three widths, a 12..18 slider for
 * the base size, a four-option select for the font -- replacing the generic
 * select/number/text controls S4 rendered from `inspectorFieldsForDocument`.
 *
 * The action ids are unchanged, so `ARCH-MAILCRAFT-FIDELITY` still holds:
 * change_width is `width`, change_typography is `fontFamily`/`baseFontSize`,
 * change_surface is `outerBg`/`contentBg`.
 */
function ThemeSheet({ theme, readOnly, expanded, onToggleExpanded, onPatch, onClose }: {
  theme: EmailTheme;
  readOnly: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPatch: (key: string, value: unknown) => void;
  onClose: () => void;
}) {
  const preview = themePreview(theme);
  return <div
    className={`v3-sheet-bg sheet-theme ${expanded ? 'workspace-expanded' : ''}`}
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <aside className="v3-sheet" role="dialog" aria-modal="true" aria-label="Chủ đề toàn email">
      <header>
        <span className="v3-sheet-icon" aria-hidden="true">◐</span>
        <div><b>Chủ đề toàn email</b><small>Một nguồn thiết lập cho canvas, bản xem trước và HTML xuất ra</small></div>
        <button type="button" className="v3-workspace-size" aria-pressed={expanded} title={expanded ? 'Thu về kích thước chuẩn' : 'Mở rộng không gian làm việc'} onClick={onToggleExpanded}>{expanded ? '↘' : '↗'}</button>
        <button type="button" aria-label="Đóng" onClick={onClose}>×</button>
      </header>
      <div className="v3-sheet-body v3-theme-work">
        <div className="v3-theme-preview">
          <span style={{ background: theme.outerBg }} aria-hidden="true">
            <i style={{ width: `${preview.swatchWidth}px`, background: theme.contentBg, fontFamily: theme.fontFamily, fontSize: `${preview.sampleFontSize}px` }}>Aa</i>
          </span>
          <div><b>{preview.widthLabel}</b><small>{preview.summary}</small></div>
        </div>
        <div className="v3-theme-grid">
          <V3Group title="Khung email">
            <V3Field label="Chiều rộng nội dung">
              <V3Segment
                label="Chiều rộng nội dung"
                values={THEME_WIDTHS.map(String)}
                value={String(theme.width)}
                set={(next) => { if (!readOnly) onPatch('width', Number(next)); }}
              />
            </V3Field>
            <V3Field label="Nền bên ngoài"><V3Color label="Nền bên ngoài" value={theme.outerBg} set={(next) => { if (!readOnly) onPatch('outerBg', next); }} /></V3Field>
            <V3Field label="Nền nội dung"><V3Color label="Nền nội dung" value={theme.contentBg} set={(next) => { if (!readOnly) onPatch('contentBg', next); }} /></V3Field>
          </V3Group>
          <V3Group title="Chữ mặc định">
            <V3Field label="Họ phông chữ">
              <select value={theme.fontFamily} disabled={readOnly} onChange={(event) => onPatch('fontFamily', event.target.value)}>
                {THEME_FONT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                {/* A stored family from before the select existed still has to be selectable, or opening the sheet would silently rewrite it to Arial. */}
                {!THEME_FONT_OPTIONS.some((option) => option.value === theme.fontFamily) && <option value={theme.fontFamily}>{theme.fontFamily}</option>}
              </select>
            </V3Field>
            <V3Field label={`Cỡ chữ cơ sở · ${clampBaseFontSize(theme.baseFontSize)}px`}>
              <input
                type="range" min={THEME_FONT_SIZE_RANGE.min} max={THEME_FONT_SIZE_RANGE.max}
                value={clampBaseFontSize(theme.baseFontSize)} disabled={readOnly}
                onChange={(event) => onPatch('baseFontSize', Number(event.target.value))}
              />
            </V3Field>
            <p>Khối có thiết lập riêng vẫn được ưu tiên hơn chủ đề.</p>
            {/* `v3-toggle`, with one correction to the prototype's own markup.
                studio.tsx wraps this in a <label>, and a <label> cannot name a
                <button> -- buttons are not labelable. Its button holds only an
                empty <i>, so a screen reader announced "button, pressed" and
                nothing about what it toggles. Found by the SV-4 e2e checkpoint.
                Same category as the three places ADR-044 already records the
                repo doing better than the prototype (role="tree", keyboard
                navigation, the sandboxed preview iframe): the class and the
                look are ported, the accessibility defect is not. */}
            <span className="v3-toggle">
              <button
                type="button"
                className={theme.stackColumns === false ? '' : 'on'}
                aria-pressed={theme.stackColumns !== false}
                aria-labelledby="mc-theme-stack-columns-label"
                disabled={readOnly}
                onClick={() => onPatch('stackColumns', theme.stackColumns === false)}
              ><i /></button>
              <span id="mc-theme-stack-columns-label">Xếp chồng cột trên màn hình hẹp</span>
            </span>
          </V3Group>
        </div>
      </div>
    </aside>
  </div>;
}

type FieldValue = string | number | boolean | undefined;

/** One inspector control, generic across every `InspectorField` (Task 18) -- BuilderScreen never switches on node kind itself, only on `field.type`. */
/**
 * ADR-046 decision 4 -- the inline formatting toolbar.
 *
 * It sits in the INSPECTOR, directly above the `content` textarea, and reads
 * that textarea's own `selectionStart`/`selectionEnd`. That placement is not a
 * preference: `ARCH-MAILCRAFT-DOM` rejects the prototype's floating
 * `v3-parameter` button precisely because "EOW's canvas is a click-to-select
 * structure (Task 17) and text is edited in the inspector, not in place --
 * there is no canvas selection for the button to read". That reason is still
 * true after this ADR, because this decision does not make the canvas
 * contenteditable and creates no canvas selection. Re-read and confirmed while
 * building, which is the thing this repo has twice failed to do.
 *
 * The class is `v3-segment` -- the prototype's own row-of-buttons control, the
 * one its Inspector uses for `Segment values={["H1","H2","H3","H4"]}`. The
 * prototype has NO formatting toolbar to port (measured: its text/heading
 * content field is a bare textarea with one "insert variable" button under it),
 * so inventing a new `v3-*` name here would be fabricating a visual source of
 * truth rather than following one. Borrowing the existing vocabulary keeps
 * ADR-044 honest and leaves ARCH-MAILCRAFT-DOM untouched.
 *
 * `onMouseDown`+`preventDefault` is load-bearing: without it the button takes
 * focus, the textarea's selection collapses, and every command would act on an
 * empty range.
 */
const INLINE_TOOLBAR: ReadonlyArray<{ kind: InlineMarkKind; label: string; title: string }> = [
  { kind: 'strong', label: 'B', title: 'In đậm phần đang chọn' },
  { kind: 'em', label: 'I', title: 'In nghiêng phần đang chọn' },
  { kind: 'underline', label: 'U', title: 'Gạch chân phần đang chọn' },
  { kind: 'link', label: '🔗', title: 'Chèn liên kết vào phần đang chọn' },
];

function InlineFormatToolbar({ node, selection, disabled, onToggle }: {
  node: Node;
  selection: { start: number; end: number } | null;
  disabled: boolean;
  onToggle: (kind: InlineMarkKind) => void;
}) {
  const length = (node.content ?? '').length;
  const hasRange = Boolean(selection && selection.end > selection.start);
  return <div className="v3-segment builder-inline-toolbar" role="group" aria-label="Định dạng nội dung">
    {INLINE_TOOLBAR.map((item) => {
      const active = hasRange && inlineMarkCovers(node.inline, length, selection!.start, selection!.end, item.kind);
      return <button
        key={item.kind}
        type="button"
        className={active ? 'active' : ''}
        aria-pressed={active}
        disabled={disabled || !hasRange}
        title={hasRange ? item.title : 'Bôi đen một đoạn chữ trước'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onToggle(item.kind)}
      >{item.label}</button>;
    })}
  </div>;
}

function InspectorFieldInput({ field, value, onChange, onFocusField, onSelectionChange }: {
  field: InspectorField;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  onFocusField?: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => void;
  /** ADR-046: the inline toolbar has to know what is selected to say whether its buttons are on or off. `onSelect` fires for drag, double-click and shift-arrow alike, which is every way a range gets made in a textarea. */
  onSelectionChange?: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => void;
}) {
  const stringValue = value === undefined ? '' : String(value);
  // The unwritten state comes from the field, not from this renderer: see
  // `InspectorField.defaultOn`. Hardcoding `true` here shipped `ordered`
  // inverted, because the justification for that default belonged to a
  // different field that does not use this component.
  if (field.type === 'checkbox') {
    return <input type="checkbox" checked={value === undefined ? (field.defaultOn ?? false) : Boolean(value)} onChange={(event) => onChange(event.target.checked)} />;
  }
  if (field.type === 'textarea') {
    return <textarea value={stringValue} onFocus={onFocusField} onSelect={onSelectionChange} onKeyUp={onSelectionChange} onChange={(event) => onChange(event.target.value)} />;
  }
  if (field.type === 'number') {
    return <input type="number" value={stringValue} onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />;
  }
  if (field.type === 'color') {
    const safe = /^#[0-9a-f]{6}$/i.test(stringValue) ? stringValue : '#ffffff';
    return <input type="color" value={safe} onChange={(event) => onChange(event.target.value)} />;
  }
  if (field.type === 'select' || field.type === 'align') {
    return <select value={stringValue} onChange={(event) => onChange(field.numeric ? Number(event.target.value) : event.target.value)}>
      <option value="" disabled>— Chọn —</option>
      {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>;
  }
  return <input type={field.type === 'url' ? 'url' : 'text'} value={stringValue} onFocus={onFocusField} onChange={(event) => onChange(event.target.value)} />;
}

/**
 * The Social node's link list (Task 18) -- bespoke because `InspectorField`
 * has no shape for "array of objects" (spec §2.1: any non-pure logic here
 * would be untestable, so `inspector-fields.ts` keeps to scalar keys and this
 * one array lives entirely as a small component instead). A link with no
 * `enabled` toggle would be equivalent to an empty URL (`emitSocial` filters
 * on both), so the checkbox is a real "temporarily hide" control, not
 * decoration.
 */
/**
 * ADR-044. Bespoke for the same reason `SocialLinksEditor` is: `InspectorField`
 * keeps to scalar keys on the node itself, and `contact` is a nested object
 * (the prototype's `ContactData`). Flattening it into five top-level node
 * fields would have fit the generic renderer, but it would also have put five
 * single-purpose keys on every node in the document.
 *
 * The email and phone inputs carry their real types so a phone keypad appears
 * on mobile and the browser's own validation applies -- both fields become
 * links in the emitted HTML, so a typo here reaches the inbox as a dead tap.
 */
function ContactEditor({ contact, readOnly, onChange }: { contact: ContactBlock; readOnly: boolean; onChange: (next: ContactBlock) => void }) {
  const fields: ReadonlyArray<{ key: keyof ContactBlock; label: string; type: 'text' | 'email' | 'tel'; help?: string }> = [
    { key: 'name', label: 'Tên', type: 'text' },
    { key: 'role', label: 'Vai trò hoặc bộ phận', type: 'text' },
    { key: 'email', label: 'Email', type: 'email', help: 'Trở thành liên kết mailto: trong email gửi đi.' },
    { key: 'phone', label: 'Điện thoại', type: 'tel', help: 'Trở thành liên kết tel:. Khoảng trắng giữ nguyên khi hiển thị, chỉ chữ số và dấu + đi vào liên kết.' },
    { key: 'address', label: 'Địa chỉ', type: 'text' },
  ];
  return <div className="builder-contact-editor">
    {fields.map((field) => <label key={field.key} className="modal-field builder-inspector-field">
      <span>{field.label}</span>
      <input
        type={field.type} value={contact[field.key]} disabled={readOnly}
        onChange={(event) => onChange({ ...contact, [field.key]: event.target.value })}
      />
      {field.help && <small className="field-help">{field.help}</small>}
    </label>)}
  </div>;
}

/**
 * ADR-050. Bespoke for the same reason `ContactEditor` is: `footer` is a
 * nested object (`FooterBlock`), and `InspectorField` has no shape for that.
 *
 * `address` is a textarea, not a single-line input like `ContactEditor`'s --
 * `emitFooter` splits it on `\n` into one line per segment (street / city,
 * region, postal code / country), the same convention ADR-048 gave `list`'s
 * `content`, so the field that convention applies to has to be one an author
 * can actually put line breaks into.
 */
function FooterEditor({ footer, readOnly, onChange }: { footer: FooterBlock; readOnly: boolean; onChange: (next: FooterBlock) => void }) {
  return <div className="builder-footer-editor">
    <label className="modal-field builder-inspector-field">
      <span>Tên công ty</span>
      <input
        type="text" value={footer.companyName} disabled={readOnly}
        onChange={(event) => onChange({ ...footer, companyName: event.target.value })}
      />
    </label>
    <label className="modal-field builder-inspector-field">
      <span>Địa chỉ bưu chính</span>
      <textarea
        rows={3} value={footer.address} disabled={readOnly}
        onChange={(event) => onChange({ ...footer, address: event.target.value })}
      />
      <small className="field-help">Mỗi dòng là một phần của địa chỉ (số nhà/đường, phường/quận, thành phố). CAN-SPAM đòi email thương mại phải có địa chỉ vật lý thật — thiếu địa chỉ sẽ chặn xuất bản.</small>
    </label>
  </div>;
}

/**
 * ADR-044 Task SV-5. `v3-social-edit`/`v3-social-row` were filed under
 * MC-UI-008; measured against studio.tsx they belong to `Inspector`. Ported
 * here with the accessible-label input the prototype's own copy insists on
 * ("Mỗi kênh cần URL thật và nhãn truy cập rõ ràng") and S4 left out, so a
 * link can carry a name a screen reader can read.
 *
 * ADR-052 restores the two controls the comment above USED to say had
 * "nothing to do here" -- a platform `<select>` and a per-row delete button.
 * That was true only while `SOCIAL_PLATFORMS` was exactly five and the
 * catalog seeded all five: a row could not be added or retyped because there
 * was nowhere left to add it TO. Opening the platform list to nine values
 * (and seeding only three by default -- `blocks.ts`'s `DEFAULT_SOCIAL_PLATFORMS`)
 * makes "one row per platform, fixed forever" untenable, so both controls
 * come back -- which is also, measured against `globals.css`, restoring
 * wiring that was already sitting there unused: `.v3-social-edit>div` is a
 * 4-column grid (toggle · select · fields · remove) and `.v3-social-edit
 * select`/`.v3-social-edit button` both have rules, none of them ever
 * addressed by a row with only two children.
 */
function SocialLinksEditor({ links, readOnly, onChange }: { links: SocialLink[]; readOnly: boolean; onChange: (next: SocialLink[]) => void }) {
  const updateLink = (id: string, patch: Partial<SocialLink>) => onChange(links.map((link) => (link.id === id ? { ...link, ...patch } : link)));
  const removeLink = (id: string) => onChange(links.filter((link) => link.id !== id));
  const addLink = () => {
    const used = new Set(links.map((link) => link.platform));
    const platform = SOCIAL_PLATFORMS.find((candidate) => candidate !== 'other' && !used.has(candidate)) ?? 'other';
    onChange([...links, { id: crypto.randomUUID(), platform, url: '', label: '', enabled: true }]);
  };
  return <div className="builder-social-editor v3-social-edit">
    {links.map((link) => <div key={link.id} className="builder-social-row v3-social-row">
      <label className="builder-social-toggle">
        <input type="checkbox" checked={link.enabled} disabled={readOnly} aria-label={`Bật/tắt ${SOCIAL_PLATFORM_LABEL[link.platform]}`} onChange={(event) => updateLink(link.id, { enabled: event.target.checked })} />
      </label>
      <select value={link.platform} disabled={readOnly} aria-label="Nền tảng" onChange={(event) => updateLink(link.id, { platform: event.target.value as SocialLink['platform'] })}>
        {SOCIAL_PLATFORMS.map((platform) => <option key={platform} value={platform}>{SOCIAL_PLATFORM_LABEL[platform]}</option>)}
      </select>
      <span>
        <input type="url" placeholder="https://…" aria-label={`Địa chỉ ${SOCIAL_PLATFORM_LABEL[link.platform]}`} value={link.url} disabled={readOnly} onChange={(event) => updateLink(link.id, { url: event.target.value })} />
        <input
          type="text"
          placeholder={link.platform === 'other' ? 'Tên nền tảng (hiện trên huy hiệu)' : 'Nhãn truy cập'}
          aria-label={link.platform === 'other' ? 'Tên nền tảng' : `Nhãn truy cập ${SOCIAL_PLATFORM_LABEL[link.platform]}`}
          value={link.label ?? ''} disabled={readOnly}
          onChange={(event) => updateLink(link.id, { label: event.target.value })}
        />
      </span>
      <button type="button" disabled={readOnly} aria-label={`Xoá ${SOCIAL_PLATFORM_LABEL[link.platform]}`} onClick={() => removeLink(link.id)}>×</button>
    </div>)}
    <button type="button" className="wide" disabled={readOnly} onClick={addLink}>＋ Thêm mạng xã hội</button>
  </div>;
}

/**
 * The Table node's whole surface (Task 18) -- settings plus the cell grid,
 * both on the nested `node.table` object the generic key-on-node field
 * renderer cannot address, so this is bespoke the same way the social list
 * is. `onChange` receives a partial `TableBlock` patch; the caller merges it
 * onto the existing table and writes the whole object back as one field.
 */
function TableEditor({ table, readOnly, onChange }: { table: TableBlock; readOnly: boolean; onChange: (patch: Partial<TableBlock>) => void }) {
  const columnCount = table.cells[0]?.length ?? 0;
  const setCell = (rowIndex: number, columnIndex: number, value: string) =>
    onChange({ cells: table.cells.map((row, r) => (r === rowIndex ? row.map((cell, c) => (c === columnIndex ? value : cell)) : row)) });
  const addRow = () => onChange({ cells: [...table.cells, Array.from({ length: columnCount }, () => '')] });
  const removeRow = () => { if (table.cells.length > 1) onChange({ cells: table.cells.slice(0, -1) }); };
  const addColumn = () => onChange({ cells: table.cells.map((row) => [...row, '']) });
  const removeColumn = () => { if (columnCount > 1) onChange({ cells: table.cells.map((row) => row.slice(0, -1)) }); };
  return <>
    <label className="modal-field builder-inspector-field"><span>Tiêu đề bảng</span><input value={table.caption} disabled={readOnly} onChange={(event) => onChange({ caption: event.target.value })} /></label>
    <label className="modal-field builder-inspector-field builder-checkbox-field"><input type="checkbox" checked={table.header} disabled={readOnly} onChange={(event) => onChange({ header: event.target.checked })} /><span>Hàng đầu là tiêu đề</span></label>
    <label className="modal-field builder-inspector-field builder-checkbox-field"><input type="checkbox" checked={table.zebra} disabled={readOnly} onChange={(event) => onChange({ zebra: event.target.checked })} /><span>Xen kẽ màu hàng (zebra)</span></label>
    <label className="modal-field builder-inspector-field"><span>Màu nền tiêu đề</span><input type="color" value={table.headerBg} disabled={readOnly} onChange={(event) => onChange({ headerBg: event.target.value })} /></label>
    <label className="modal-field builder-inspector-field"><span>Màu chữ tiêu đề</span><input type="color" value={table.headerColor} disabled={readOnly} onChange={(event) => onChange({ headerColor: event.target.value })} /></label>
    <label className="modal-field builder-inspector-field"><span>Màu nền hàng</span><input type="color" value={table.rowBg} disabled={readOnly} onChange={(event) => onChange({ rowBg: event.target.value })} /></label>
    <label className="modal-field builder-inspector-field"><span>Màu nền hàng xen kẽ</span><input type="color" value={table.altBg} disabled={readOnly} onChange={(event) => onChange({ altBg: event.target.value })} /></label>
    <label className="modal-field builder-inspector-field"><span>Màu viền</span><input type="color" value={table.borderColor} disabled={readOnly} onChange={(event) => onChange({ borderColor: event.target.value })} /></label>
    <label className="modal-field builder-inspector-field"><span>Đệm ô (px)</span><input type="number" value={table.cellPadding} disabled={readOnly} onChange={(event) => onChange({ cellPadding: Number(event.target.value) })} /></label>
    {/* ADR-044 Task SV-2, `v3-cells`: the prototype's own cell grid. */}
    <div className="builder-table-grid v3-cells">
      {table.cells.map((row, rowIndex) => <div key={rowIndex} className="builder-table-row">
        {row.map((cell, columnIndex) => <input key={columnIndex} value={cell} disabled={readOnly} onChange={(event) => setCell(rowIndex, columnIndex, event.target.value)} />)}
      </div>)}
    </div>
    <div className="builder-inspector-actions">
      <button type="button" disabled={readOnly} onClick={addRow}>+ Hàng</button>
      <button type="button" disabled={readOnly} onClick={removeRow}>− Hàng</button>
      <button type="button" disabled={readOnly} onClick={addColumn}>+ Cột</button>
      <button type="button" disabled={readOnly} onClick={removeColumn}>− Cột</button>
    </div>
  </>;
}

/**
 * ADR-044 (Task SV-3, `v3-row-layouts`). `row` has no generic inspector fields
 * (`inspectorFieldsForNode` returns none for it -- nothing set on a row itself
 * reaches the HTML, `emitRow` only reads `children`), so before this the
 * Inspector showed an empty panel for a selected row. Restores the
 * prototype's ratio-preset picker: switching "50/50" to "35/65" resizes the
 * existing columns in place rather than replacing them, so whatever content
 * is already in each column survives the switch. Only presets whose column
 * count matches the row's current children are offered, for the same reason.
 */
function RowLayoutPicker({ node, readOnly, onChange, onAddColumn }: { node: Node; readOnly: boolean; onChange: (children: Node[]) => void; onAddColumn: () => void }) {
  const children = node.children ?? [];
  const presets = matchingRowLayouts(children.length);
  const widths = children.map((child) => child.width);
  // ADR-052: each column's own `width` field (inspector "Thiết kế" tab) now
  // lets an author retype a single column's share after picking a preset --
  // e.g. a preset 65/35, then typed to 70/30, or a preset 33/34/33 retyped to
  // 20/60/20. Nothing enforces the total is 100 (`columnPixelWidth` computes
  // every column independently -- ADR-052 Context), so this is a live hint,
  // not a gate: presets always leave it true, only a manual retype can move it.
  const total = widths.reduce((sum: number, width) => sum + (width ?? 100), 0);
  return <div className="v3-group">
    <h3>Tỷ lệ bố cục</h3>
    <p>Đổi tỷ lệ mà không làm mất nội dung đang có trong các cột. Cần một tỉ lệ khác 6 mẫu dưới đây? Chọn từng cột và gõ số trực tiếp ở tab "Thiết kế".</p>
    <div className="v3-row-layouts">
      {presets.map((preset) => <button
        key={preset.id} type="button" disabled={readOnly}
        className={isActiveRowLayout(preset, widths) ? 'active' : ''}
        onClick={() => onChange(children.map((child, index) => ({ ...child, width: preset.widths[index] })))}
      >
        <i>{preset.widths.map((width, index) => <span key={index} style={{ minWidth: `${width}%` }} />)}</i>
        <b>{preset.label}</b>
        <small>{preset.widths.join(' / ')}</small>
      </button>)}
    </div>
    {children.length > 0 && total !== 100 && <p className="builder-field-warning">Tổng tỉ lệ các cột đang là {total}%, không phải 100% -- các cột có thể tràn hoặc để trống khoảng trên một số hộp thư.</p>}
    {/* studio.tsx's own `addColumn`: `append(active.id, newColumn())`. It adds a
        column at width 100 and touches no sibling, so a 50/50 row becomes
        50/50/100 and the author re-divides it from the tiles above if they want
        to. An earlier pass here rebalanced instead; that was not the handoff's
        behaviour and is gone. */}
    <button type="button" className="wide" disabled={readOnly} onClick={onAddColumn}>＋ Thêm một cột</button>
  </div>;
}

/**
 * The other two composition buttons `studio.tsx` carries, and the reason its
 * Insert panel needs no "Hàng (Row)" or "Cột (Column)" button at all: a Section
 * grows rows from its own Inspector, and a Column nests a layout inside itself.
 *
 * Both insert `layout2` -- `newRow(2)` in the prototype, which is a Row with two
 * 50/50 columns.
 */
function StructureComposer({ kind, readOnly, onAddLayout }: { kind: 'section' | 'column'; readOnly: boolean; onAddLayout: () => void }) {
  return <div className="v3-group">
    <h3>{kind === 'section' ? 'Cấu trúc Section' : 'Bố cục lồng'}</h3>
    {kind === 'section' && <p>Section chỉ chứa hàng để HTML email ổn định.</p>}
    <button type="button" className="wide" disabled={readOnly} onClick={onAddLayout}>
      ＋ {kind === 'section' ? 'Thêm hàng 2 cột' : 'Thêm layout 2 cột bên trong'}
    </button>
  </div>;
}

const BUTTON_VARIANTS: ReadonlyArray<{ value: NonNullable<Node['buttonVariant']>; label: string }> = [
  { value: 'solid', label: 'Đặc' }, { value: 'outline', label: 'Viền' }, { value: 'soft', label: 'Nhạt' }, { value: 'link', label: 'Liên kết' },
];
const BUTTON_SHAPES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Vuông' }, { value: 6, label: '6px' }, { value: 12, label: '12px' }, { value: 999, label: 'Viên thuốc' },
];

/** ADR-044 (Task SV-3, `v3-presets`/`v3-shapes`). A button's variant and corner radius were plain select/number fields (inspector-fields.ts); the prototype's Inspector (studio.tsx) shows them as tile pickers instead -- the same two fields, ported UI. */
function ButtonStylePicker({ node, readOnly, onChange }: { node: Node; readOnly: boolean; onChange: (patch: Partial<Node>) => void }) {
  return <>
    <div className="v3-group">
      <h3>Kiểu nút</h3>
      <div className="v3-presets">
        {BUTTON_VARIANTS.map((variant) => <button key={variant.value} type="button" disabled={readOnly} className={node.buttonVariant === variant.value ? 'active' : ''} onClick={() => onChange({ buttonVariant: variant.value })}>
          <i className={variant.value} />{variant.label}
        </button>)}
      </div>
    </div>
    <div className="v3-group">
      <h3>Hình dạng</h3>
      <div className="v3-shapes">
        {BUTTON_SHAPES.map((shape) => <button key={shape.value} type="button" disabled={readOnly} className={(node.radius ?? 0) === shape.value ? 'active' : ''} onClick={() => onChange({ radius: shape.value })}>
          <i style={{ borderRadius: shape.value }} /><span>{shape.label}</span>
        </button>)}
      </div>
    </div>
  </>;
}

const SURFACE_ELEVATIONS: ReadonlyArray<{ value: NonNullable<Node['elevation']>; label: string }> = [
  { value: 'flat', label: 'Phẳng' }, { value: 'soft', label: 'Nổi nhẹ' }, { value: 'strong', label: 'Nổi rõ' },
];

/**
 * ADR-042, built 2026-09-10 -- the prototype's "Bề mặt nâng cao" group
 * (`studio.tsx`'s `SurfaceExtras`, classes `v3-surface-presets` and
 * `v3-email-fallback`).
 *
 * `ARCH-MAILCRAFT-DOM` had both classes REJECTED, on two grounds: the model
 * carried no fields, and "the properties it sets are stripped by the
 * sanitizer". The second stopped being true the day ADR-042 was accepted, and
 * `document.ts` now settles the first -- so the register row is split rather
 * than left asserting a reason that expired.
 *
 * Three elevations, not the prototype's four: `inset` is excluded with an
 * address, because ADR-042 §Consequences says `box-shadow:inset` is out of
 * scope and adding it is a NEW decision, not a detail of this one.
 *
 * The caption is not decoration. It is the one place the product tells an
 * author that these two effects degrade -- and after ADR-045 that statement is
 * finally precise: Outlook desktop drops the gradient and the shadow and keeps
 * the flat colour and border, which `surfaceCss` guarantees by declaring them
 * after `background-color` rather than instead of it.
 */
function SurfacePicker({ node, readOnly, onChange }: { node: Node; readOnly: boolean; onChange: (patch: Partial<Node>) => void }) {
  const gradient = node.backgroundMode === 'gradient';
  const elevation = node.elevation ?? 'flat';
  return <div className="v3-group">
    <h3>Bề mặt nâng cao</h3>
    <label className="modal-field builder-inspector-field">
      <span>Kiểu nền</span>
      <select value={node.backgroundMode ?? 'solid'} disabled={readOnly} onChange={(event) => onChange({ backgroundMode: event.target.value as Node['backgroundMode'] })}>
        <option value="solid">Màu phẳng</option>
        <option value="gradient">Chuyển màu</option>
      </select>
    </label>
    {gradient && <>
      <label className="modal-field builder-inspector-field">
        <span>Màu kết thúc gradient</span>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(node.gradientTo ?? '') ? node.gradientTo! : '#e9f3ee'} disabled={readOnly} onChange={(event) => onChange({ gradientTo: event.target.value })} />
      </label>
      <label className="modal-field builder-inspector-field">
        <span>{`Góc chuyển màu · ${node.gradientAngle ?? 135}°`}</span>
        <input type="range" min={0} max={360} step={15} value={node.gradientAngle ?? 135} disabled={readOnly} onChange={(event) => onChange({ gradientAngle: Number(event.target.value) })} />
      </label>
    </>}
    <div className="v3-surface-presets">
      {SURFACE_ELEVATIONS.map((option) => <button key={option.value} type="button" disabled={readOnly} className={elevation === option.value ? 'active' : ''} onClick={() => onChange({ elevation: option.value })}>
        <i className={option.value} /><span>{option.label}</span>
      </button>)}
    </div>
    {elevation !== 'flat' && <label className="modal-field builder-inspector-field">
      <span>Màu bóng</span>
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(node.shadowColor ?? '') ? node.shadowColor! : '#c4d0ca'} disabled={readOnly} onChange={(event) => onChange({ shadowColor: event.target.value })} />
    </label>}
    <p className="v3-email-fallback">Email-safe: màu nền phẳng và viền luôn được xuất kèm làm dự phòng. Gmail và Apple Mail hiển thị gradient và bóng đổ; Outlook desktop bỏ qua hiệu ứng nhưng nội dung giữ nguyên.</p>
  </div>;
}

/**
 * The customHtml node's whole surface (Task 20, MC-UI-011): `edit_sanitized_html` reuses
 * `TemplateCodeView` -- the same lazily-loaded CodeMirror instance `TemplateEditorScreen`
 * already mounts for `origin: 'imported'` templates, not a second editor. `validate` calls the
 * existing `POST /templates/analyze` with just this fragment (no `templateId`) rather than a
 * new endpoint -- the same sanitizer every other block's output already goes through, run
 * standalone. `preview` is deliberately not a third mechanism here: the header's existing "Xem
 * trước" toggle already renders the full document (this node emitted verbatim inside it), so a
 * second, node-scoped preview would just be a worse copy of the same render.
 */
function CustomHtmlEditor({ html, css, readOnly, onChange }: { html: string; css: string; readOnly: boolean; onChange: (patch: { html?: string; css?: string }) => void }) {
  const [tab, setTab] = useState<CodeTab>('html');
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [report, setReport] = useState<{ warnings: string[]; changes: string[]; strippedChars: number; source: string } | null>(null);

  const screen = screenCustomCode({ html, css });
  // A report belongs to the exact text it was produced from. Comparing the two
  // is what re-opens the Validate step after an edit -- a strip still reading
  // "done" would be reporting on content that no longer exists.
  const source = `${html}\u0000${css}`;
  const validated = report?.source === source;

  const validate = async () => {
    setValidating(true); setValidationError(null);
    try {
      // Sent the way the emitter will write it, so the verdict is about the
      // real output rather than the HTML tab alone: a `<style>` block is
      // exactly the kind of thing the sanitizer rewrites, and validating
      // without it would report on something that never ships.
      const submitted = css.trim() ? `<style>${css.trim()}</style>${html}` : html;
      const result = await analyzeTemplate({ html: submitted });
      setReport({ warnings: result.validation.warnings, changes: result.validation.changes, strippedChars: submitted.length - result.sanitizedHtml.length, source });
    } catch (cause) {
      setValidationError(cause instanceof ApiError ? cause.message : 'Không thể kiểm tra HTML.');
    } finally {
      setValidating(false);
    }
  };

  const result = codeResult(screen);
  return <div className="builder-custom-html-editor v3-code-work" data-mc-action="MC-UI-011.edit_sanitized_html">
    {/* ADR-044 Task SV-5: the prototype's own four stages. `custom-code.ts`
        records why the states behind them differ from `studio.tsx` -- EOW has
        a real server validation to report on, the prototype has none. */}
    <div className="v3-pipeline">
      {codePipeline(screen, validated).map((step, index) => <div key={step.label} className={step.status === 'pending' ? '' : step.status}>
        <span>{step.status === 'done' ? '✓' : index + 1}</span><b>{step.label}</b>
      </div>)}
    </div>
    <div className="v3-code-tabs">
      <button type="button" className={tab === 'html' ? 'active' : ''} aria-pressed={tab === 'html'} onClick={() => setTab('html')}>HTML</button>
      <button type="button" className={tab === 'css' ? 'active' : ''} aria-pressed={tab === 'css'} onClick={() => setTab('css')}>CSS</button>
      <span>{'{{ten_bien}}'}</span>
    </div>
    {tab === 'html'
      ? <TemplateCodeView value={html} ranges={[]} disabled={readOnly} onChange={(next) => onChange({ html: next })} onCaretChange={() => {}} />
      : <textarea className="builder-custom-css-input" spellCheck={false} rows={8} value={css} readOnly={readOnly} aria-label="CSS tuỳ chỉnh" placeholder=".lead{color:#173f33}" onChange={(event) => onChange({ css: event.target.value })} />}
    <div className={`v3-code-result ${result.level}`} role="status" data-mc-state={result.level === 'error' ? 'MC-UI-011.error' : result.level === 'ok' ? 'MC-UI-011.clean' : 'MC-UI-011.dirty'}>{result.message}</div>
    <div className="builder-inspector-actions">
      <button type="button" className="v3-apply-code" data-mc-action="MC-UI-011.validate" disabled={readOnly || validating || screen.blocked} onClick={() => void validate()}>{validating ? 'Đang kiểm tra…' : 'Xác thực với máy chủ'}</button>
    </div>
    {validationError && <p className="login-error" data-mc-state="MC-UI-011.error" role="alert">{validationError}</p>}
    {report && validated && <div className="builder-custom-html-report" role="status">
      {report.warnings.length === 0 && report.changes.length === 0 && report.strippedChars <= 0
        ? <p>Không có cảnh báo — HTML sống sót nguyên vẹn qua bước làm sạch.</p>
        : <>
            {report.warnings.map((warning, index) => <p key={`w${index}`} className="builder-field-warning">{warning}</p>)}
            {report.changes.map((change, index) => <p key={`c${index}`} className="builder-field-warning">{change}</p>)}
            {report.strippedChars > 0 && <p className="builder-field-warning">Khoảng {report.strippedChars} ký tự sẽ bị loại khi lưu (thẻ/thuộc tính/CSS không nằm trong danh sách cho phép — §2.12). Dùng “Xem trước” ở đầu trang để xem kết quả thật.</p>}
          </>}
    </div>}
  </div>;
}

/**
 * S3 built the route, focus-mode shell, and read-only/narrow-viewport
 * handling around `EmailEditorEngine` (ADR-041). S4 adds the actual
 * authoring surface on top: block library (Task 16), canvas + selection +
 * breadcrumb (Task 17), the field-driven inspector (Task 18), the variable
 * panel (Task 19), and drag-as-an-additive-layer (Task 20) -- all of it
 * calling `engine`, never `document.ts`/`emitter.ts`/`tree-ops.ts` directly
 * from outside `./builder/` (spec §2.13).
 */

/**
 * MC-UI-004, the whole workspace. Blocks belong to the tenant (plan §S5
 * Task 26), so this is one list with no "mine" section, every row shows who
 * saved it, and `content:manage` acts on all of them -- including other
 * people's, which the delete confirmation names out loud rather than letting
 * someone discover it afterwards.
 *
 * All four catalog states are reachable here: `loading` while the first fetch
 * runs, `error` when it fails (with a retry, not a dead panel), `empty` when
 * the tenant has saved nothing yet, and `success` for the list itself.
 */
function ReusableBlocksPanel({ readOnly, canSaveSelection, onSaveSelection, onInsert, onDragStartBlock, onDragEndBlock, saveError, onDismissSaveError }: {
  readOnly: boolean;
  canSaveSelection: boolean;
  onSaveSelection: (name: string) => Promise<boolean>;
  onInsert: (blockId: string) => Promise<void>;
  /** A2: the prototype's saved blocks are drag sources too (`studio.tsx:762`, `mc/saved`); the port offered click-to-insert only, so a library block could never be aimed anywhere. */
  onDragStartBlock: (blockId: string, event: ReactDragEvent) => void;
  onDragEndBlock: () => void;
  saveError: string | null;
  onDismissSaveError: () => void;
}) {
  const [blocks, setBlocks] = useState<ReusableBlockSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [saveName, setSaveName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ReusableBlockSummary | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = () => {
    setLoadError(null);
    return listReusableBlocks()
      .then((result) => setBlocks(result.items))
      .catch((cause) => { setBlocks(null); setLoadError(cause instanceof ApiError ? cause.message : 'Không tải được thư viện khối.'); });
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const visible = filterReusableBlocks(blocks ?? [], search);

  const save = async () => {
    onDismissSaveError();
    const saved = await onSaveSelection(saveName);
    if (saved) { setSaveName(''); await reload(); }
  };

  const rename = async () => {
    if (!renaming) return;
    setActionError(null); setBusyId(renaming.id);
    try {
      await renameReusableBlock(renaming.id, renaming.name);
      setRenaming(null);
      await reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không đổi được tên khối.');
    } finally { setBusyId(null); }
  };

  const remove = async (block: ReusableBlockSummary) => {
    setActionError(null); setBusyId(block.id);
    try {
      await deleteReusableBlock(block.id);
      setConfirmDelete(null);
      await reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không xoá được khối.');
    } finally { setBusyId(null); }
  };

  return <>
    {/* ADR-044 Task SV-4, `v3-reusable-guide`: the prototype says out loud that
        this library ships empty on purpose -- there are no opinionated preset
        blocks, only what people here build. Without it an empty panel reads as
        a feature that failed to load. Worded for where the save control
        actually is: EOW names a block inline here rather than through the
        `prompt()` the prototype opens from the inspector. */}
    <div className="v3-reusable-guide">
      <span aria-hidden="true">▣</span>
      <div>
        <b>Không có khối dựng sẵn</b>
        <small>Thư viện này chỉ chứa cấu trúc do người trong tổ chức tự dựng. Chọn một Khối hoặc Cột trên canvas, đặt tên rồi lưu ở dưới.</small>
      </div>
    </div>

    {/* MC-UI-004 save_current_tree */}
    <div className="builder-reusable-save" data-mc-action="MC-UI-004.save_current_tree">
      <label className="modal-field">
        <span>Lưu khối đang chọn</span>
        <input
          value={saveName} maxLength={120} disabled={readOnly || !canSaveSelection}
          placeholder={canSaveSelection ? 'Tên khối, ví dụ: Chân trang công ty' : 'Chọn một khối trên canvas trước'}
          onChange={(event) => { setSaveName(event.target.value); onDismissSaveError(); }}
        />
        <small className="field-help">Khối lưu ở đây dùng chung cho cả tổ chức — ai có quyền sửa nội dung đều đổi tên hoặc xoá được.</small>
      </label>
      {/* `v3-save-reusable`. studio.tsx puts this button in the inspector and
          opens a `prompt()` for the name; EOW keeps it beside the field that
          names the block, because a modal `prompt` is not something this repo
          ships. The class rides with the action, not with the location. */}
      <button type="button" className="secondary-button v3-save-reusable" disabled={readOnly || !canSaveSelection || saveName.trim().length === 0} onClick={() => void save()}>Lưu vào thư viện</button>
      {saveError && <p className="login-error" role="alert">{saveError}</p>}
    </div>

    {/* MC-UI-004 search -- local, over the already-loaded list. */}
    <label className="modal-field v3-search" data-mc-action="MC-UI-004.search">
      <span>Tìm khối</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Gõ để lọc, không cần dấu" />
    </label>

    {actionError && <p className="login-error" role="alert">{actionError}</p>}

    {loadError
      ? <div className="builder-reusable-error" data-mc-state="MC-UI-004.error" role="alert">
          <p className="login-error">{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => void reload()}>Thử lại</button>
        </div>
      : blocks === null
        ? <p className="builder-library-hint" data-mc-state="MC-UI-004.loading" role="status">Đang tải thư viện khối…</p>
        : blocks.length === 0
          ? <div className="v3-reusable-empty" data-mc-state="MC-UI-004.empty" role="status">
              {/* ADR-044 §Context #2 restoration: the prototype's three-step
                  guide. The old empty state said what was missing; this one
                  says what to do about it, in the order it has to be done. */}
              <span aria-hidden="true">▣</span>
              <b>Chưa có khối nào được lưu</b>
              <p>Tự dựng nội dung bằng element và bố cục, chọn Khối hoặc Cột chứa nó, rồi lưu vào đây để dùng lại.</p>
              <ol>
                <li>Dựng cấu trúc</li>
                <li>Chọn Khối/Cột</li>
                <li>Lưu vào thư viện</li>
              </ol>
            </div>
          // `<ul>/<li>` rather than the prototype's `<article>`: three e2e specs
          // count `li` inside this list, and ADR-044 ports class names, not
          // element names (SV-3 lesson 3). Task SV-6 revisits the selectors.
          : <ul className="builder-reusable-list v3-reusable-scroll" data-mc-state="MC-UI-004.success">
              {visible.length === 0 && <li className="builder-library-hint">Không có khối nào khớp “{search}”.</li>}
              {visible.map((block) => <li key={block.id}>
                {renaming?.id === block.id
                  ? <div className="builder-reusable-rename">
                      <input autoFocus value={renaming.name} maxLength={120} onChange={(event) => setRenaming({ id: block.id, name: event.target.value })} />
                      <button type="button" className="secondary-button" disabled={busyId === block.id || renaming.name.trim().length === 0} onClick={() => void rename()}>Lưu tên</button>
                      <button type="button" className="secondary-button" onClick={() => { setRenaming(null); setActionError(null); }}>Huỷ</button>
                    </div>
                  : <>
                      <div className="builder-reusable-row">
                        {/* MC-UI-004 insert */}
                        {/* ADR-044 §Context #2 restoration: `v3-reusable-preview`,
                            one bar per column. The counts are derived server-side
                            from the stored tree (`blockShape`), so the panel draws
                            the block's real shape instead of a generic row. */}
                        <button
                          type="button" className="builder-reusable-insert v3-reusable-main" data-mc-action="MC-UI-004.insert"
                          disabled={readOnly || busyId === block.id}
                          draggable={!readOnly}
                          onDragStart={(event) => onDragStartBlock(block.id, event)}
                          onDragEnd={onDragEndBlock}
                          onClick={() => { setBusyId(block.id); void onInsert(block.id).finally(() => setBusyId(null)); }}
                        >
                          <span className="v3-reusable-preview" aria-hidden="true">
                            {Array.from({ length: block.columns }, (_, index) => <i key={index} />)}
                          </span>
                          <span>
                            <b>{block.name}</b>
                            <small>{block.elements} element · {reusableBlockAuthorLabel(block)}</small>
                            <em>Chèn vào email →</em>
                          </span>
                        </button>
                        <div className="builder-inspector-actions">
                          {/* MC-UI-004 rename */}
                          <button type="button" data-mc-action="MC-UI-004.rename" disabled={readOnly} onClick={() => { setActionError(null); setRenaming({ id: block.id, name: block.name }); }}>Đổi tên</button>
                          {/* MC-UI-004 delete */}
                          <button type="button" data-mc-action="MC-UI-004.delete" disabled={readOnly} onClick={() => { setActionError(null); setConfirmDelete(block); }}>Xoá</button>
                        </div>
                      </div>
                    </>}
              </li>)}
            </ul>}

    {confirmDelete && <ModalFrame
      titleId="reusable-block-delete-title"
      title={`Xoá khối “${confirmDelete.name}”?`}
      description="Khối thuộc về cả tổ chức, nên thao tác này ảnh hưởng tới mọi người."
      size="small"
      onClose={() => setConfirmDelete(null)}
      footer={<>
        <button className="secondary-button" onClick={() => setConfirmDelete(null)}>Huỷ</button>
        <button className="danger-button" disabled={busyId === confirmDelete.id} onClick={() => void remove(confirmDelete)}>{busyId === confirmDelete.id ? 'Đang xoá…' : 'Xoá khối'}</button>
      </>}
    >
      <div className="confirmation-copy">
        <b>{confirmDelete.name}</b>
        <p>
          Khối này do <b>{reusableBlockAuthorLabel(confirmDelete)}</b> lưu. Xoá xong, không ai trong tổ chức chèn được nó nữa.
          Các template đã dùng khối này <b>không bị ảnh hưởng</b> — khi chèn, nội dung được chép sang template, nên chúng giữ bản sao của riêng mình.
        </p>
      </div>
    </ModalFrame>}
  </>;
}

/**
 * MC-UI-005 (ADR-043). The rail's Assets destination, replacing the explained
 * empty notice S4 left there while the object store did not exist.
 *
 * Two things this copy is required to say out loud rather than bury in a doc,
 * because getting either wrong costs a user something real:
 *
 * 1. A served asset URL is a bearer capability. It carries no session -- it
 *    cannot, because the fetch comes from a recipient's mail client -- so
 *    anyone holding the link can download the file. That is a requirement of
 *    email images, not an oversight, and it makes this the wrong place for
 *    anything sensitive.
 * 2. Archiving hides an asset from this library and keeps serving it. A
 *    published version still points at the URL and cannot be edited, so
 *    withdrawing the bytes would break mail that has already gone out. Someone
 *    who reads "Xoá" as "recall" would be wrong in a way they would only
 *    discover from a recipient.
 *
 * Five states, all reachable: `loading` on the first fetch, `error` with a
 * retry rather than a dead panel, `empty` before anything is uploaded,
 * `success` for the list, and `missing_assets` for images in THIS document that
 * will not survive to the inbox -- computed from the document, not from the
 * library, so it is independent of the four above and shows alongside any of
 * them.
 */
/**
 * ADR-044 Task SV-4. `v3-asset-filterbar`'s three tabs. The prototype labels
 * them "Tất cả / Hình ảnh phù hợp / Logo phù hợp" because it filters against
 * what the *target block* accepts; EOW's panel is the library itself, not a
 * picker for one node, so the labels say what they filter rather than what
 * would fit.
 */
const ASSET_FILTERS: ReadonlyArray<{ id: 'all' | AssetKind; label: string }> = [
  { id: 'all', label: 'Tất cả' },
  { id: 'image', label: 'Hình ảnh' },
  { id: 'logo', label: 'Logo' },
];

function AssetsPanel({ readOnly, provider, missing, onSelectNode, boundTargetLabel, onBind }: {
  readOnly: boolean;
  provider: AssetProvider;
  missing: readonly MissingAsset[];
  onSelectNode: (id: string) => void;
  /** The selected node's label when it can carry an image, `null` otherwise -- what `bind` needs a target for, and what the disabled hint names. */
  boundTargetLabel: string | null;
  /** Returns false when the document refused the source. The panel has to say so -- a button that quietly does nothing is exactly the silent failure ADR-043 keeps warning about. */
  onBind: (src: string) => boolean;
}) {
  const [items, setItems] = useState<readonly Asset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<Asset | null>(null);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  /** ADR-044 Task SV-4: `v3-asset-filterbar`, and the kind a new upload is filed under. */
  const [filter, setFilter] = useState<'all' | AssetKind>('all');
  const [uploadKind, setUploadKind] = useState<AssetKind>('image');

  const reload = () => {
    setLoadError(null);
    return provider.list()
      .then(setItems)
      .catch((cause) => { setItems(null); setLoadError(cause instanceof ApiError ? cause.message : 'Không tải được thư viện ảnh.'); });
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const upload = async (file: File) => {
    setActionError(null); setUploading(true);
    try {
      await provider.upload(file, uploadKind);
      await reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không tải được ảnh lên.');
    } finally { setUploading(false); }
  };

  const replace = async (assetId: string, file: File) => {
    setActionError(null); setBusyId(assetId);
    try {
      await provider.replace(assetId, file);
      await reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không thay được ảnh.');
    } finally { setBusyId(null); setReplacingId(null); }
  };

  /** MC-UI-005 through ADR-044 Task SV-4: change a file's classification without touching its bytes or its URL. */
  const reclassify = async (asset: Asset, kind: AssetKind) => {
    setActionError(null); setBusyId(asset.id);
    try {
      await provider.setKind(asset.id, kind);
      await reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không đổi được phân loại.');
    } finally { setBusyId(null); }
  };

  // Derived, not stored: `shown` is what the filter bar is filtering and what
  // its count reports, so the two cannot disagree.
  const shown = (items ?? []).filter((asset) => filter === 'all' || asset.kind === filter);
  const logoCount = (items ?? []).filter((asset) => asset.kind === 'logo').length;

  const archive = async (asset: Asset) => {
    setActionError(null); setBusyId(asset.id);
    try {
      await provider.archive(asset.id);
      setConfirmArchive(null);
      await reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không ẩn được ảnh khỏi thư viện.');
    } finally { setBusyId(null); }
  };

  return <>
    {/* MC-UI-005 upload. The accept list is the four types the API's magic-byte
        check allows; it is a convenience for the file picker, never the check
        itself, which happens on the bytes server-side (ADR-043 §4). */}
    <div className="builder-reusable-save" data-mc-action="MC-UI-005.upload">
      {/* ADR-044 Task SV-4, `v3-upload`: the prototype's own upload control.
          The kind is chosen BEFORE the picker opens, because the file dialog is
          modal -- asking afterwards would mean a second dialog over a file the
          user already committed to. */}
      <div className="v3-segment" role="group" aria-label="Phân loại tệp sắp tải lên">
        {ASSET_FILTERS.filter((entry) => entry.id !== 'all').map((entry) => (
          <button
            key={entry.id} type="button" disabled={readOnly || uploading}
            className={uploadKind === entry.id ? 'active' : ''} aria-pressed={uploadKind === entry.id}
            onClick={() => setUploadKind(entry.id as AssetKind)}
          >{entry.label}</button>
        ))}
      </div>
      <label className="modal-field v3-upload">
        <span>Tải ảnh lên</span>
        <input
          type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={readOnly || uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
        <small className="field-help">
          PNG, JPEG, GIF hoặc WebP, tối đa 5 MB. <b>Không nhận SVG</b> — tệp SVG chạy được mã, mà ảnh ở đây phục vụ từ chính tên miền của hệ thống.
        </small>
        <small className="field-help">
          <b>Ai có đường dẫn ảnh đều tải được, không cần đăng nhập.</b> Bắt buộc phải vậy thì ảnh mới hiện được trong hộp thư người nhận —
          nên đừng để tệp nhạy cảm ở đây.
        </small>
        {/* Task 41 (ADR-043 §6): the trade-off that comes with serving images over https: instead of attaching them. */}
        <small className="field-help">
          Ảnh gửi kèm email <b>không hiện ngay trên Outlook desktop</b> và vài ứng dụng khác — người nhận phải bấm “hiển thị ảnh”.
          Đó là đánh đổi của cách phục vụ ảnh hiện nay, không phải lỗi cấu hình.
        </small>
      </label>
      {uploading && <p className="builder-library-hint" role="status">Đang tải lên…</p>}
    </div>

    {actionError && <p className="login-error" role="alert">{actionError}</p>}

    {/* MC-UI-005 missing_assets -- about this document, not about the library,
        so it stands beside the list rather than replacing it. Listed only,
        never repaired automatically: the same rule S7 applies to the import
        report, and guessing which image someone meant is not a repair. */}
    {missing.length > 0 && <div className="builder-asset-missing" data-mc-state="MC-UI-005.missing_assets" role="status">
      <b>{missing.length} ảnh sẽ không tới được hộp thư</b>
      <p>Bấm để chọn khối trên canvas rồi gán lại ảnh.</p>
      <ul>
        {missing.map((entry) => <li key={entry.id}>
          <button type="button" onClick={() => onSelectNode(entry.id)}>
            <b>{NODE_LABEL[entry.kind]}</b>
            <small>{entry.reason === 'unbound'
              ? 'Chưa gán ảnh — khối này biến mất khỏi email gửi đi'
              : `Đường dẫn không dùng được (${entry.src}) — hệ thống lọc bỏ, người nhận thấy ảnh vỡ`}</small>
          </button>
        </li>)}
      </ul>
    </div>}

    {/* ADR-044 §Context #2 restoration: the image/logo filter bar the rebuild
        lost. It could not be built before SV decision 3 put `kind` on the
        contract -- content type is sniffed from bytes and cannot tell a logo
        from a photograph. */}
    {items !== null && items.length > 0 && <div className="v3-asset-filterbar">
      <div>
        {ASSET_FILTERS.map((entry) => (
          <button
            key={entry.id} type="button" className={filter === entry.id ? 'active' : ''} aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >{entry.label}</button>
        ))}
      </div>
      <span>{shown.length} tài nguyên</span>
    </div>}

    {/* `v3-brand-kit`. The prototype hard-codes one company's kit; here it is
        simply this tenant's logos, and it only appears when there are some --
        a brand kit shortcut leading to an empty list would be worse than none. */}
    {logoCount > 0 && filter !== 'logo' && <button type="button" className="v3-brand-kit" onClick={() => setFilter('logo')}>
      {/* The prototype hard-codes "A" here -- the initial of the one sample
          company its brand kit belonged to. In this app the chip opens THIS
          tenant's logos, so that letter names nothing. It carries the Mailcraft
          mark instead, white because the chip's own background is
          --mc-primary. Deviation registered in ARCH-MAILCRAFT-DOM. */}
      <span aria-hidden="true"><img src="/mailcraft-mark-white.svg" alt="" /></span>
      <div><b>Bộ nhận diện</b><small>{logoCount} logo đã tải lên, dùng chung cho mọi template</small></div>
      <em aria-hidden="true">Chỉ xem logo →</em>
    </button>}

    {loadError
      ? <div className="builder-reusable-error" data-mc-state="MC-UI-005.error" role="alert">
          <p className="login-error">{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => void reload()}>Thử lại</button>
        </div>
      : items === null
        ? <p className="builder-library-hint" data-mc-state="MC-UI-005.loading" role="status">Đang tải thư viện ảnh…</p>
        : items.length === 0
          ? <div className="mc-workspace-empty" data-mc-state="MC-UI-005.empty" role="status">
              <b>Chưa có ảnh nào</b>
              <p>Tải logo hoặc ảnh lên ở trên. Ảnh dùng chung cho mọi template của tổ chức.</p>
            </div>
          : <ul className="builder-asset-list v3-assets" data-mc-state="MC-UI-005.success">
              {shown.length === 0 && <li className="builder-library-hint">Không có tài nguyên nào thuộc nhóm này.</li>}
              {shown.map((asset) => <li key={asset.id}>
                <div className="builder-asset-row">
                  <img src={asset.url} alt="" className="builder-asset-thumb" />
                  <div className="builder-asset-meta">
                    <b title={asset.filename}>{asset.filename}</b>
                    <small>{assetSizeLabel(asset.byteSize)} · {assetUploaderLabel(asset)}</small>
                    {/* The classification, and the way to correct it. Shown on
                        the row rather than behind a menu because the whole
                        point of the field is that people get it wrong at upload
                        and need to see that they did. */}
                    <em>
                      {asset.kind === 'logo' ? 'LOGO' : 'HÌNH ẢNH'}
                      <button
                        type="button" disabled={readOnly || busyId === asset.id}
                        onClick={() => void reclassify(asset, asset.kind === 'logo' ? 'image' : 'logo')}
                      >{asset.kind === 'logo' ? 'Đổi thành hình ảnh' : 'Đổi thành logo'}</button>
                    </em>
                  </div>
                </div>
                {/* MC-UI-005 bind. The URL goes to the engine, which routes it
                    through `tree-ops.bindAsset` -- the panel never touches the
                    document itself (ADR-043 §7, spec §2.13). */}
                <button
                  type="button" className="builder-asset-bind" data-mc-action="MC-UI-005.bind"
                  disabled={readOnly || boundTargetLabel === null}
                  onClick={() => {
                    setActionError(null);
                    if (onBind(asset.url)) return;
                    // The only way a library URL is refused is a deployment
                    // whose own public origin is not https, which makes every
                    // asset URL one the sanitizer strips. Silence here would
                    // leave someone clicking a dead button (ADR-043's own note:
                    // a wrong ASSET_PUBLIC_ORIGIN "does not fail loudly").
                    setActionError(asset.url.startsWith('https:')
                      ? 'Không gán được ảnh vào khối đang chọn.'
                      : `Hệ thống đang phát địa chỉ ảnh không phải https (${asset.url}), nên bộ lọc sẽ xoá ảnh khỏi email đã xuất bản. Ảnh vẫn tải lên được, nhưng chưa gán vào email được — báo quản trị viên kiểm tra cấu hình ASSET_PUBLIC_ORIGIN.`);
                  }}
                >{boundTargetLabel ? `Gán vào ${boundTargetLabel.toLowerCase()} đang chọn` : 'Chọn một khối ảnh trên canvas để gán'}</button>
                <div className="builder-inspector-actions">
                  {/* MC-UI-005 replace -- a new asset the document is then rebound to, never an overwrite of the old bytes (ADR-043 §7). */}
                  <button
                    type="button" data-mc-action="MC-UI-005.replace" disabled={readOnly || busyId === asset.id}
                    onClick={() => { setActionError(null); setReplacingId(asset.id); replaceInput.current?.click(); }}
                  >{busyId === asset.id ? 'Đang xử lý…' : 'Thay ảnh'}</button>
                  <button type="button" disabled={readOnly || busyId === asset.id} onClick={() => { setActionError(null); setConfirmArchive(asset); }}>Ẩn khỏi thư viện</button>
                </div>
              </li>)}
            </ul>}

    {/* One input serves every row; the row that opened it is held in `replacingId`. */}
    <input
      ref={replaceInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        const target = replacingId;
        event.target.value = '';
        if (file && target) void replace(target, file);
      }}
    />

    {confirmArchive && <ModalFrame
      titleId="asset-archive-title"
      title={`Ẩn “${confirmArchive.filename}” khỏi thư viện?`}
      description="Ảnh biến mất khỏi thư viện, nhưng email đã gửi vẫn hiển thị được nó."
      size="small"
      onClose={() => setConfirmArchive(null)}
      footer={<>
        <button className="secondary-button" onClick={() => setConfirmArchive(null)}>Huỷ</button>
        <button className="danger-button" disabled={busyId === confirmArchive.id} onClick={() => void archive(confirmArchive)}>{busyId === confirmArchive.id ? 'Đang ẩn…' : 'Ẩn khỏi thư viện'}</button>
      </>}
    >
      <div className="confirmation-copy">
        <b>{confirmArchive.filename}</b>
        <p>
          Đây <b>không phải thu hồi</b>. Ảnh vẫn được phục vụ ở đường dẫn cũ, vì các phiên bản đã xuất bản còn trỏ tới nó và không sửa lại
          được — xoá hẳn sẽ làm hỏng email đã duyệt. Cái thay đổi là nó không còn xuất hiện trong thư viện để chọn nữa.
        </p>
      </div>
    </ModalFrame>}
  </>;
}

export function BuilderScreen() {
  const { templateId } = useParams<{ templateId: string }>();
  const id = templateId ?? '';
  const navigate = useNavigate();
  const session = useSession();
  const setFocusHeader = useSetFocusHeader();
  const readOnly = templateContentIsReadOnly(session.data?.permissions);

  const [state, dispatch] = useReducer(builderReducer, null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorStatus, setLoadErrorStatus] = useState<number | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  // MC-UI-001 revision_conflict (spec §2.7). The server's copy is fetched for
  // the comparison and held here; it is NOT applied until the user picks a side.
  const [conflictServer, setConflictServer] = useState<EmailTemplate | null>(null);
  const [conflictLoadError, setConflictLoadError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // MC-UI-008 switch_device (S4 Task 21): same desktop/mobile toggle
  // TemplateEditorScreen already has for the imported-origin preview --
  // reused as `mail-preview-stage ${device}`, not a second device model.
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  // MC-UI-008 run_content_review: the spec's own coverage table (§5.2) calls
  // this "lint 6 mã; S4 nối vào canvas builder" -- the mechanism
  // (analyzeTemplate + the 6 codes) already existed for the imported-origin
  // editor; this wires the same call into the builder canvas.
  const [analysis, setAnalysis] = useState<TemplateAnalysis | null>(null);
  const [analysisStale, setAnalysisStale] = useState(false);
  // ADR-044 Task SV-5: the prototype's review sheet filters by level
  // (`v3-review-filters`), and its preview sheet previews for a chosen person
  // (`v3-preview-work`). Both are view state -- neither changes the document.
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [variableScope, setVariableScope] = useState<VariableScope>('all');
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [previewRecipientId, setPreviewRecipientId] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // S4: the canvas's own model, mirrored from the engine on every change so
  // BuilderScreen can render it (Task 17) -- the engine stays the single
  // owner of the document; this is read-only state derived from its 'change'
  // events, never written to directly.
  const [doc, setDoc] = useState<Doc | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // S4 Task 20: the single node currently under the drag (decision 2 -- an
  // additive layer; insert-by-drag only, since move/delete already have the
  // keyboard-equivalent buttons Task 17 added).
  // Where the drop will land -- which block, and which side of it. Replaces a
  // bare `dragOverId`, which could only say "this block is under the cursor"
  // and was being drawn as though it meant "the block goes here".
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  // The kind being dragged, kept in state because `dataTransfer.getData()` is
  // deliberately unreadable during `dragover` (only on `drop`) -- so the ghost
  // could not be built from the event even though the payload is right there.
  const [draggingKind, setDraggingKind] = useState<string | null>(null);
  /** Set instead of `draggingKind` when the drag started on the canvas: this drop moves a node rather than creating one. */
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  /**
   * B7. The bare canvas accepts drops -- it builds a Section, a Row and a
   * Column around whatever lands there -- and showed nothing at all on the way
   * in, so the one drop target with the largest consequence was the only one
   * with no feedback.
   */
  const [overBackground, setOverBackground] = useState(false);
  /** The library block being dragged, fetched on `dragstart` so the indicator and the drop both have the real tree. */
  const [draggingReusable, setDraggingReusable] = useState<Node | null>(null);
  const [catalogue, setCatalogue] = useState<TemplateVariableCatalogueItem[] | null>(null);
  // S4 Task 17: which of the four rail destinations is open, and the shared
  // compact/expanded state for the workspace panel and inspector (UI-HANDOFF
  // §2 -- one shell, one toggle shape, reused by every panel).
  const [railPanel, setRailPanel] = useState<RailPanelId>('insert');
  /**
   * The two rail destinations that open the prototype's overlay instead of
   * the left panel (`v3-sheet`), plus `'publish'` (S9 Task 52) which is NOT a
   * rail destination -- it opens from the header's "Xuất bản" button.
   */
  const [sheet, setSheet] = useState<'theme' | 'history' | 'publish' | null>(null);
  /**
   * S9 Task 53's four states for the publish sheet. `'idle'` covers both the
   * pre-analysis moment (`publishReadiness` reports `ANALYSIS_PENDING`, shown
   * as `MC-UI-010.publish_validating`) and the resting "ready to confirm"
   * moment once analysis has arrived -- the plan names four touch points, and
   * "waiting to click" is not one of them, so it gets no state of its own.
   */
  const [publishFlow, setPublishFlow] = useState<'idle' | 'publishing' | 'published' | 'failed'>('idle');
  const [publishedVersion, setPublishedVersion] = useState<TemplateVersion | null>(null);
  const [publishFlowError, setPublishFlowError] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('content');
  /** `v3-stage`'s scale, 60..120 as the prototype bounds it. Canvas-only: the emitted HTML never sees it. */
  const [zoom, setZoom] = useState(90);
  const [libraryItems, setLibraryItems] = useState<EmailTemplateSummary[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryFilter, setLibraryFilter] = useState<TemplateLibraryFilter>('all');
  const [librarySearch, setLibrarySearch] = useState('');
  const [versions, setVersions] = useState<TemplateVersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<TemplateVersionSummary | null>(null);
  const [workspacePanelSize, setWorkspacePanelSize] = useState<PanelSize>('compact');
  const [inspectorSize, setInspectorSize] = useState<PanelSize>('compact');
  // conventions spec §2.2's middle tier (1024-1279px): only one side panel at
  // a time, as an overlay. A state toggle, not width detection -- the CSS
  // media query decides when it matters at all, so this stays inert (and its
  // buttons hidden) at every other width.
  const [activeSidePanel, setActiveSidePanel] = useState<'workspace' | 'inspector'>('workspace');
  // S4 Task 19 (MC-UI-003): which containers the Structure tree currently
  // shows the children of. Selection itself reuses `selectedId` above --
  // arrow-key focus and selection move together (WAI-ARIA's simpler
  // "focus follows selection" single-select tree pattern), matching how a
  // canvas click already selects and shows the inspector in one action.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());

  const engine = useRef(createEmailEditorEngine(blankDoc())).current;
  const loadedProjectData = useRef(false);
  // Mirrors draft.textBody so a doc-change autosave patch can carry it every
  // time (spec §2.8: BR-TPL-007 -- textBody must always be sent alongside a
  // regenerated html, or the server falls back to auto-extracting it and no
  // TEXT_BODY_EMPTY warning is possible).
  const textBodyRef = useRef('');
  // The inspector text/textarea/url field last focused, so the variable
  // panel (Task 19) knows where to insert -- same caret-tracking shape
  // TemplateEditorScreen already uses for subject/text.
  const focusedFieldRef = useRef<{ nodeId: string; key: string; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  /** ADR-046: what is selected inside the `content` textarea right now, so the inline toolbar can report its own state rather than guessing. */
  const [contentSelection, setContentSelection] = useState<{ nodeId: string; start: number; end: number } | null>(null);
  const analysisSequence = useRef(createSequenceGuard());

  const variables = useMemo<VariableProvider>(() => ({ list: () => analyzeTemplate({ templateId: id }).then((result) => result.catalogue) }), [id]);

  /**
   * The sixth port (ADR-043 §7), built here for the same reason the other five
   * are: the panel talks to a seam, not to `api/assets.ts`. `bind` and
   * `mark_decorative` are deliberately not on it -- they change the document,
   * so they go through the engine like every other edit (spec §2.13).
   */
  const assets = useMemo<AssetProvider>(() => ({
    list: () => listAssets().then((result) => result.items),
    upload: uploadAsset,
    replace: replaceAsset,
    archive: archiveAsset,
    setKind: updateAssetKind,
  }), []);

  /** MC-UI-005 `missing_assets`: images in THIS document that will not reach an inbox. Recomputed from the document, so it follows every edit without a fetch. */
  const missingAssets = useMemo<MissingAsset[]>(() => (doc ? missingAssetNodes(doc) : []), [doc]);

  const load = () => {
    setLoadError(null);
    setLoadErrorStatus(undefined);
    return getTemplate(id)
      .then((draft) => dispatch({ type: 'saved', draft }))
      .catch((cause) => {
        setLoadErrorStatus(cause instanceof ApiError ? cause.status : undefined);
        setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải template.');
      });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [id]);

  const draft = state?.draft;
  // The engine owns its own document once mounted; a freshly loaded draft
  // seeds it exactly once. Reloading (e.g. after publish) must not clobber
  // in-progress canvas edits with the server's (identical) copy.
  useEffect(() => {
    if (!draft || loadedProjectData.current) return;
    loadedProjectData.current = true;
    if (draft.projectData) void engine.loadProjectData(draft.projectData);
    void engine.getProjectData().then((data) => setDoc(data as Doc));
  }, [draft, engine]);

  const savePending = Boolean(state?.pending || state?.inFlight);
  const change = (patch: TemplatePatch) => { if (readOnly) return; dispatch({ type: 'change', patch }); };

  const resolveConflict = (keepLocal: boolean) => {
    if (!conflictServer) return;
    dispatch({ type: 'resolveConflict', serverDraft: conflictServer, keepLocal });
    if (!keepLocal) {
      // Taking the server's draft means taking its canvas too. The engine owns
      // the document and the seeding effect only runs once, so this reseeds it
      // explicitly -- otherwise "dùng bản trên máy chủ" would keep the local
      // component tree under the server's fields.
      if (conflictServer.projectData) void engine.loadProjectData(conflictServer.projectData);
      else void engine.loadProjectData(blankDoc());
      void engine.getProjectData().then((data) => setDoc(data as Doc));
      setSelectedId(null);
    }
    setConflictServer(null);
    setConflictLoadError(null);
  };

  useEffect(() => { textBodyRef.current = draft?.textBody ?? ''; }, [draft?.textBody]);

  // The engine is the only owner of the document (spec §2.13); this mirrors
  // its state into render-able local state and, in the same tick, folds the
  // regenerated html/projectData (plus textBody, always -- BR-TPL-007) into
  // the autosave patch so canvas edits reach the server the same way the
  // name field already does.
  useEffect(() => {
    const unsubscribe = engine.on('change', (payload) => {
      const nextDoc = payload as Doc;
      setDoc(nextDoc);
      if (readOnly) return;
      void engine.getHtml().then((html) => change({ html, projectData: nextDoc, textBody: textBodyRef.current }));
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, readOnly]);

  useEffect(() => {
    if (!id) return;
    variables.list().then((items) => setCatalogue([...items])).catch(() => setCatalogue([]));
  }, [id, variables]);

  useEffect(() => {
    if (readOnly || !state?.pending || state.inFlight || state.status === 'conflict' || state.status === 'error') return;
    const timer = window.setTimeout(() => dispatch({ type: 'start' }), 500);
    return () => window.clearTimeout(timer);
  }, [readOnly, state?.pending, state?.inFlight, state?.status]);

  useEffect(() => {
    if (!state?.inFlight) return;
    const patch = state.inFlight;
    void updateTemplate(id, state.draft.draftRevision, patch)
      .then((saved) => dispatch({ type: 'saved', draft: saved }))
      .catch((cause) => {
        const conflict = cause instanceof ApiError && cause.status === 412;
        dispatch({ type: 'failed', conflict });
        if (conflict) {
          // S4 Task 23. The S3 version called `load()` here and announced it
          // in a toast, on the reasoning that only the name was editable
          // "until S4". What that actually did, measured against the built
          // stack before this change:
          //
          //   1. 'failed' put the rejected patch back in `pending`.
          //   2. `load()` dispatched 'saved', and the reducer re-applies
          //      `pending` over the loaded draft -- so status went straight
          //      back to 'idle', leaving the conflict state in the same tick.
          //   3. The autosave effect no longer saw 'conflict', re-sent the
          //      same patch against the fresh draftRevision, and succeeded.
          //
          // So nothing of the user's was lost -- the other session's was. With
          // both sessions editing one field, the server ended up holding this
          // tab's value, the other tab's write gone, and the header reading
          // "Đã lưu". That is exactly spec §2.7's "Không được lặng lẽ ghi đè":
          // a conflict resolved for the user, in their favour, without asking.
          //
          // So: hold at status 'conflict' (the autosave effect above already
          // refuses to fire while it is), fetch the server copy for comparison
          // only, and let the user pick a side.
          setConflictLoadError(null);
          void getTemplate(id)
            .then(setConflictServer)
            .catch((latest) => setConflictLoadError(latest instanceof ApiError ? latest.message : 'Không thể tải phiên bản mới nhất.'));
          return;
        }
        setActionError(cause instanceof ApiError ? cause.message : 'Không thể lưu thay đổi.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, state?.inFlight, state?.draft.draftRevision]);

  useEffect(() => {
    if (!previewOpen || !draft) return;
    let cancelled = false;
    setPreviewError(null);
    void previewTemplateDraft(id, previewMergeData)
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((cause) => { if (!cancelled) setPreviewError(cause instanceof ApiError ? cause.message : 'Không thể tạo bản xem trước.'); });
    return () => { cancelled = true; };
    // `previewMergeData` is derived from the selected recipient below, so
    // choosing a different person re-renders the preview against their data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, previewOpen, draft?.draftRevision, previewRecipientId, recipients]);

  /**
   * ADR-044 Task SV-5. The prototype's preview sheet is called "Xem trước bằng
   * người nhận thật" but backs its recipient column with three hard-coded
   * names. EOW has the real list, so it lists real people -- and only once the
   * preview is actually open, because an author who never opens it should not
   * pay for a recipients query. A failure here is not fatal: the preview falls
   * back to the sample data and says so.
   */
  useEffect(() => {
    if (!previewOpen || recipients !== null) return;
    let cancelled = false;
    void listRecipients({ status: ['active'], limit: 10 })
      .then((page) => { if (!cancelled) { setRecipients(page.items); setRecipientsError(null); } })
      .catch((cause) => { if (!cancelled) { setRecipients([]); setRecipientsError(cause instanceof ApiError ? cause.message : 'Không tải được danh sách người nhận.'); } });
    return () => { cancelled = true; };
  }, [previewOpen, recipients]);

  // MC-UI-008 run_content_review, debounced the same 450ms as
  // TemplateEditorScreen's own lint check -- a sequence guard discards a
  // slow, now-stale response instead of letting it clobber a newer one.
  useEffect(() => {
    if (!draft) return;
    const timeout = window.setTimeout(() => {
      const token = analysisSequence.current.issue();
      void analyzeTemplate({ templateId: id, subject: draft.subject, html: draft.html, textBody: draft.textBody })
        .then((result) => { if (analysisSequence.current.isCurrent(token)) { setAnalysis(result); setAnalysisStale(false); } })
        .catch(() => { if (analysisSequence.current.isCurrent(token)) setAnalysisStale(true); });
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [id, draft?.subject, draft?.html, draft?.textBody]);

  /**
   * S9 Task 52: the header's "Xuất bản" button used to call `publishTemplate`
   * straight away (git blame on this function, pre-Task-52). Now it only
   * opens the summary sheet -- `confirmPublish` below is what actually posts.
   * Resets the three publish-flow state slots so a stale success/failure from
   * a previous open never bleeds into this one.
   */
  const openPublishSheet = () => {
    setPublishFlow('idle');
    setPublishedVersion(null);
    setPublishFlowError(null);
    setSheet('publish');
  };

  /**
   * S9 Task 53's `MC-UI-010.publish` action. No client-side field check here
   * on purpose -- `publishReadiness` already decides `canPublish`, and the
   * confirm button is `disabled` off that same verdict (§2.9's rule lives in
   * one place, not two). `savePending` is checked here too, not only on the
   * button: the button's `disabled` can go stale for one render between an
   * autosave starting and this component re-rendering, and publishing over a
   * PATCH still in flight would let the server freeze a version older than
   * what the author is looking at (the same guard the old direct-publish
   * `publish()` had).
   */
  const confirmPublish = async () => {
    if (!draft || publishFlow === 'publishing' || savePending) return;
    setPublishFlow('publishing'); setBusy(true); setPublishFlowError(null);
    try {
      const version = await publishTemplate(id);
      await load();
      setPublishedVersion(version);
      setPublishFlow('published');
      setToast(`Đã xuất bản phiên bản ${version.version}.`);
      window.setTimeout(() => setToast(null), 3000);
    } catch (cause) {
      setPublishFlowError(cause instanceof ApiError ? cause.message : 'Không thể xuất bản template.');
      setPublishFlow('failed');
    } finally { setBusy(false); }
  };

  /**
   * Where a leave lands. This used to carry a `{ overlay: 'import' }` payload
   * so the "Nhập HTML" rail entry could eject to the library and have the
   * import overlay open on arrival. That entry is gone (workspace-shell.ts),
   * and it was the only writer, so the payload and the ref that held it went
   * with it rather than staying as a channel nothing sends down.
   */
  const leaveToList = () => navigate('/templates');

  /**
   * The confirm dialog's "Lưu nháp" choice. This has to actually await the
   * save before leaving -- dispatching 'start' and navigating in the same
   * tick would unmount the screen before the effect that performs the save
   * ever runs, silently dropping the patch instead of saving it.
   */
  const saveDraftAndLeave = async () => {
    if (!draft || !state?.pending) { leaveToList(); return; }
    setBusy(true);
    try {
      const saved = await updateTemplate(id, draft.draftRevision, state.pending);
      dispatch({ type: 'saved', draft: saved });
      leaveToList();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không thể lưu thay đổi.');
      setConfirmLeave(false);
    } finally { setBusy(false); }
  };

  const runBack = () => {
    // Layer 1 of conventions spec §2.11 ("close an open modal or expanded tool
    // panel") had no caller until Task SV-2: nothing in the builder opened one.
    // The theme and history sheets are that layer, so Back closes the sheet
    // before it considers leaving.
    const action = backNavigationAction({ modalOpen: sheet !== null, previewOpen, dirty: savePending });
    if (action === 'close-modal') { setSheet(null); return; }
    if (action === 'exit-preview') { setPreviewOpen(false); return; }
    if (action === 'confirm-dirty') { setConfirmLeave(true); return; }
    leaveToList();
  };

  /**
   * MC-UI-001 through the "Kho mẫu" rail destination: start this draft from
   * another template's document. `replaceDocument` rather than
   * `loadProjectData` so it lands on the undo stack -- a button that says
   * "Dùng mẫu" must not be a one-way door over someone's canvas.
   */
  const applyLibraryTemplate = async (summary: EmailTemplateSummary) => {
    if (readOnly) return;
    setActionError(null);
    try {
      const full = await getTemplate(summary.id);
      if (!full.projectData) {
        // ADR-037 §3: an imported template has HTML and no component tree, and
        // the builder never reconstructs one. Saying so is the honest answer;
        // silently doing nothing would look like a broken button.
        setActionError(`“${summary.name}” là template nhập từ HTML nên không có cấu trúc khối để áp dụng.`);
        return;
      }
      engine.replaceDocument(full.projectData);
      setSelectedId(null);
      setToast(`Đã áp dụng mẫu “${summary.name}” — bấm Hoàn tác nếu bạn đổi ý.`);
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không thể mở mẫu này.');
    }
  };

  /** The prototype's "Email trắng" card. Undoable for the same reason. */
  const startBlankDocument = () => {
    if (readOnly) return;
    engine.replaceDocument(blankDoc());
    setSelectedId(null);
    setToast('Đã bắt đầu lại từ email trắng — bấm Hoàn tác nếu bạn đổi ý.');
  };

  /**
   * MC-UI-009 create_draft, reached from the "Lịch sử" rail destination. Same
   * call and the same 412 rule as `TemplateEditorScreen.restore`: restore
   * rewrites the draft server-side, so the reply has to be dispatched as the
   * new draft or the next autosave sends a revision the server has moved past.
   */
  const restoreVersion = async (version: TemplateVersionSummary) => {
    if (!draft) return;
    setBusy(true); setActionError(null);
    try {
      const restored = await restoreTemplateVersion(id, version.id, draft.draftRevision);
      dispatch({ type: 'saved', draft: restored });
      if (restored.projectData) engine.loadProjectData(restored.projectData);
      setConfirmRestore(null); setSheet(null); setSelectedId(null);
      setToast(`Đã khôi phục nội dung phiên bản ${version.version} vào bản nháp.`);
    } catch (cause) {
      setActionError(cause instanceof ApiError && cause.status === 412
        ? 'Bản nháp vừa thay đổi ở nơi khác. Tải lại trang rồi thử khôi phục lại.'
        : cause instanceof ApiError ? cause.message : 'Không thể khôi phục phiên bản.');
      setConfirmRestore(null);
    } finally { setBusy(false); }
  };

  /**
   * ADR-044 Task SV-2. `kind` on the rail entry decides what a button does,
   * rather than the JSX knowing ten special cases (see `workspace-shell.ts`).
   */
  const openRailDestination = (destination: RailEntry) => {
    if (destination.kind === 'panel') { setRailPanel(destination.id as RailPanelId); setActiveSidePanel('workspace'); setSheet(null); return; }
    // 'publish' is not a rail destination's `id` -- it only ever arrives via
    // `openPublishSheet` -- so the cast here stays narrower than `sheet`'s own type.
    setSheet(destination.id as 'theme' | 'history');
  };

  // "Kho mẫu" lists the tenant's own templates (decision 1), loaded the first
  // time the panel is opened rather than on mount -- the builder's first paint
  // already waits on the draft, its analysis and the asset list.
  useEffect(() => {
    if (railPanel !== 'templates' || libraryItems !== null) return;
    setLibraryError(null);
    void listTemplates({ limit: 50 })
      .then((page) => setLibraryItems(page.items.filter((item) => item.id !== id)))
      .catch((cause) => setLibraryError(cause instanceof ApiError ? cause.message : 'Không thể tải kho mẫu.'));
  }, [railPanel, libraryItems, id]);

  /**
   * Escape closes an open sheet, through `runBack` so that conventions spec
   * §2.11's layer 1 is the code that actually runs.
   *
   * Found by SV-4's e2e checkpoint, and it corrects a claim SV-2 made: the
   * sheet backdrop is `inset:0` above the focus header, so the header's Back
   * button cannot be clicked while a sheet is open -- a click there lands on
   * the backdrop, which dismisses the sheet by its own path. The observable
   * result looked the same, which is exactly why it was misread. Without this,
   * layer 1 had no reachable caller at all, and this was the only overlay in
   * the app that ignored Escape (`ModalFrame` has handled it since it existed).
   */
  useEffect(() => {
    if (!sheet) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A ModalFrame can sit above a sheet (restore-version confirms over the
      // history sheet). It runs its own Escape handler, and the topmost overlay
      // is the one that should answer.
      if (event.key !== 'Escape' || confirmRestore) return;
      event.preventDefault();
      runBack();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  // S9 Task 52 also needs this list: `freezeSummary`'s `currentVersion` is the
  // newest published version number, and `listTemplateVersions` is already the
  // one place that number comes from (server sorts `version DESC`, so
  // `versions[0]` is it -- see TemplateVersionHistory.tsx).
  useEffect(() => {
    if (sheet !== 'history' && sheet !== 'publish') return;
    setVersions(null); setVersionsError(null);
    void listTemplateVersions(id)
      .then((page) => setVersions(page.items))
      .catch((cause) => setVersionsError(cause instanceof ApiError ? cause.message : 'Không thể tải lịch sử phiên bản.'));
  }, [sheet, id]);

  // --- S4 Task 16-19: block library, canvas selection, inspector, variables ---
  const theme = doc?.theme ?? defaultTheme;
  const selectedNode = doc && selectedId ? findNode(doc, selectedId) : undefined;
  const breadcrumb = doc && selectedNode ? [...ancestorsOf(doc, selectedNode.id), selectedNode] : [];

  /**
   * Whether the open inspector tab renders nothing at all for this node. It
   * has to name the same conditions the JSX does -- a drift here would show
   * "no settings on this tab" over a tab that has some, or a blank panel over
   * one that has none.
   */
  const inspectorTabIsEmpty = useMemo(() => {
    if (!selectedNode) return false;
    if (inspectorFieldsForNode(selectedNode).some((field) => field.tab === inspectorTab)) return false;
    const kind = selectedNode.kind;
    if (inspectorTab === 'content') {
      return !((kind === 'row' && matchingRowLayouts((selectedNode.children ?? []).length).length > 0)
        || kind === 'social' || kind === 'contact' || kind === 'footer' || (kind === 'table' && Boolean(selectedNode.table)));
    }
    if (inspectorTab === 'design') return kind !== 'button';
    return !(kind === 'customHtml' || kind === 'preheader' || (IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(kind));
  }, [selectedNode, inspectorTab]);

  // ADR-044 (Task SV-3): a locked node behaves like a read-only draft for its
  // own edit paths -- the structure tree's lock toggle itself is exempt (it
  // has to keep working to unlock the node again).
  const isSelectedLocked = Boolean(selectedNode?.locked);
  const [blockSearch, setBlockSearch] = useState('');

  /**
   * D10. With nothing selected this used to pass `null`, and `insertNode`'s
   * wrap-and-recurse path built a fresh Section, Row and Column for every
   * click -- two clicks, two one-block sections. `defaultInsertTarget` resolves
   * the last container that can hold the kind, so consecutive blocks land
   * together; it returns null only on a canvas with nowhere to put them, which
   * is where building a Section is the right answer.
   */
  /**
   * A panel id is not always a kind. The six layout presets all insert a `row`,
   * so `requiredParentKind('layout2left')` would fall through to its default and
   * try to put a Row inside a Column. Everything that reasons about PLACEMENT
   * takes the resolved kind; only `engine.addBlock` takes the id, because only
   * it needs to know which of the six shapes was asked for.
   */
  const panelItem = (id: string) => INSERT_PANEL.find((entry) => entry.id === id);
  const kindOfPanelItem = (id: string): Node['kind'] => (panelItem(id)?.kind ?? id) as Node['kind'];

  const insertBlock = (id: string) => insertBlockAt(id, selectedId ?? (doc ? defaultInsertTarget(doc, kindOfPanelItem(id)) : null));

  // MC-UI-004 save_current_tree. Saves the SELECTED node together with its
  // children -- refusing when nothing is selected, rather than silently saving
  // the whole document, which is the only other thing "current tree" could mean
  // and is never what the user pointed at. Duplicate names come back as 409 and
  // are surfaced here instead of being swallowed (BR-TPL-010's precedent).
  const [reusableSaveError, setReusableSaveError] = useState<string | null>(null);
  const saveSelectionAsBlock = async (name: string): Promise<boolean> => {
    if (readOnly || !selectedNode) return false;
    try {
      await createReusableBlock({ name: name.trim(), node: selectedNode as unknown as Record<string, unknown> });
      setReusableSaveError(null);
      return true;
    } catch (cause) {
      setReusableSaveError(cause instanceof ApiError ? cause.message : 'Không lưu được khối.');
      return false;
    }
  };

  // MC-UI-004 insert. The tree arrives only now, not with the list (ADR-035
  // projection), and goes onto the canvas through the engine port -- no
  // component touches the document model directly (spec §2.13).
  const insertReusableBlock = async (blockId: string): Promise<void> => {
    if (readOnly || !doc) return;
    try {
      const block = await getReusableBlock(blockId);
      const node = block.node as unknown as Node;
      // Same treatment the palette's click path gets: an unaimed click reuses
      // the last container rather than minting a Section (D10), and the result
      // is selected and announced.
      const targetId = selectedId ?? defaultInsertTarget(doc, node.kind);
      afterInsert(engine.insertSubtree(node, targetId), node.kind, describeInsert(doc, targetId, node.kind), `khối “${block.name}”`);
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không chèn được khối đã lưu.');
    }
  };
  /**
   * A toast that clears itself, and cancels the previous one's timer first.
   *
   * Without the cancel, a second insert within three seconds is wiped by the
   * FIRST message's timeout: measured at 250ms intervals, the second toast
   * lived 1.0s instead of 3.0s, and two inserts close together left the second
   * one showing nothing at all. Inserting several blocks in a row is the normal
   * way to use this panel, so that is the common case, not the edge one.
   */
  const toastTimer = useRef<number | null>(null);
  const notify = (message: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => { setToast(null); toastTimer.current = null; }, 3000);
  };
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);

  /**
   * Where a block just went, in a sentence. A4/A5: the insert never refused and
   * never explained, so it always succeeded somewhere and the author was told
   * nothing -- and `insertNode` will build a Section, a Row and a Column to
   * hold one text block. Refusing instead (as the prototype does when it cannot
   * resolve a column) would mean a click on an empty canvas does nothing, which
   * is worse. So it still always succeeds, and now it says where.
   */
  const destinationPhrase = (destination: InsertDestination): string => {
    const container = destination.containerKind ? NODE_LABEL[destination.containerKind] : null;
    if (destination.wraps) return container ? `vào ${container}, trong một Cột mới` : 'vào một Khối mới ở cuối email';
    return container ? `vào ${container}` : 'vào cuối email';
  };

  /**
   * The port's `insertBlock` ended at `engine.addBlock` and stopped. The
   * prototype's `finishAdd` (studio.tsx:510) selects the new node, opens the
   * content tab, and for image kinds opens the asset picker on it -- so the
   * block you asked for is the block in front of you. Measured before this:
   * inserting left `selectedId` null and the inspector on its empty state,
   * and inserting an image opened nothing.
   */
  const afterInsert = (nodeId: string, kind: string, destination: InsertDestination, displayName?: string) => {
    setSelectedId(nodeId);
    setInspectorTab('content');
    // A library block is known by its NAME, not by the kind of its root node --
    // "Đã thêm Hàng (Row)" tells the author nothing about which saved block
    // just arrived. The prototype says `Đã chèn khối "…"` for the same reason.
    const label = displayName ?? BLOCK_CATALOG.find((entry) => entry.kind === kind)?.label ?? NODE_LABEL[kind as Node['kind']] ?? kind;
    // An image block is useless until it has a source, so the message says
    // where to get one. It does NOT open that panel: the prototype's asset
    // picker is an overlay above the canvas (`setPanel("assets")`), while this
    // rail destination REPLACES the tool panel -- so opening it takes the block
    // palette away mid-flow. Measured: two acceptance specs that insert an
    // image and then reach for another block timed out on a palette button
    // that was no longer on screen, and a person doing the same thing would
    // have watched their tools vanish.
    const needsSource = (IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(kind as Node['kind']);
    notify(`Đã thêm ${label} ${destinationPhrase(destination)}.${needsSource ? ' Chọn ảnh ở Thư viện ảnh.' : ''}`);
  };

  const dropReusableBlock = async (blockId: string, targetId: string | null, edge?: DropEdge): Promise<void> => {
    if (readOnly || !doc) return;
    try {
      const block = await getReusableBlock(blockId);
      const node = (draggingReusable ?? block.node) as unknown as Node;
      const destination = describeInsert(doc, targetId, node.kind);
      afterInsert(engine.insertSubtree(node, targetId, edge), node.kind, destination, `khối “${block.name}”`);
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : 'Không chèn được khối đã lưu.');
    }
  };

  const insertBlockAt = (id: string, targetId: string | null, edge?: DropEdge) => {
    if (readOnly || !doc) return;
    const kind = kindOfPanelItem(id);
    const destination = describeInsert(doc, targetId, kind);
    // The toast names the SHAPE for a preset -- "Đã thêm Hai cột đều", not "Đã
    // thêm Hàng (Row)", which is the same complaint the reusable blocks had.
    afterInsert(engine.addBlock(id, targetId, edge), kind, destination, panelItem(id)?.widths ? panelItem(id)!.label : undefined);
  };
  const endDrag = () => { setDropAt(null); setDraggingKind(null); setDraggingNodeId(null); setOverBackground(false); setDraggingReusable(null); };
  /**
   * The library panel hands over an id; the tree it stands for is fetched here
   * so the ghost is the block itself. A drag that outruns the request simply
   * shows no indicator until it lands -- better than drawing a placeholder that
   * misrepresents what is about to arrive.
   */
  const onReusableDragStart = (blockId: string, event: ReactDragEvent) => {
    if (readOnly) { event.preventDefault(); return; }
    event.dataTransfer.setData(DRAG_REUSABLE_ID_TYPE, blockId);
    setDraggingReusable(null);
    void getReusableBlock(blockId).then((block) => setDraggingReusable(block.node as unknown as Node)).catch(() => setDraggingReusable(null));
  };
  const onNodeDragStart = (id: string, event: ReactDragEvent) => {
    if (readOnly) { event.preventDefault(); return; }
    event.dataTransfer.setData(DRAG_NODE_ID_TYPE, id);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingNodeId(id);
  };
  const onNodeDragOver = (id: string, event: ReactDragEvent) => {
    // `currentTarget` is the node's own element, so the midpoint compared
    // against is the block being positioned around -- not whatever container
    // happens to be under it.
    const edge = dropEdge(event.clientY, event.currentTarget.getBoundingClientRect());
    setDropAt((current) => (current && current.id === id && current.edge === edge ? current : { id, edge }));
  };
  const onNodeDrop = (id: string, event: ReactDragEvent) => {
    const edge = dropAt?.id === id ? dropAt.edge : dropEdge(event.clientY, event.currentTarget.getBoundingClientRect());
    endDrag();
    if (readOnly) return;
    // A moved node first: a drag started on the canvas carries both types in
    // some browsers, and relocating is what the author asked for.
    const movedId = event.dataTransfer.getData(DRAG_NODE_ID_TYPE);
    if (movedId) { engine.moveBlockTo(movedId, id, edge); return; }
    const reusableId = event.dataTransfer.getData(DRAG_REUSABLE_ID_TYPE);
    if (reusableId) { void dropReusableBlock(reusableId, id, edge); return; }
    const kind = event.dataTransfer.getData(DRAG_BLOCK_KIND_TYPE);
    if (kind) insertBlockAt(kind, id, edge);
  };
  // The canvas background itself (dropping with no node under the cursor --
  // node handlers above stop propagation, so this only fires there).
  const onCanvasDragOver = (event: ReactDragEvent) => { if (carriesBlock(event.dataTransfer)) { event.preventDefault(); setDropAt(null); setOverBackground(true); } };
  const onCanvasDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    endDrag();
    if (readOnly) return;
    // Dropping a node on the bare canvas would have to invent a destination for
    // it, and every guess is wrong half the time. Nothing happens, and the node
    // stays where it was.
    if (event.dataTransfer.getData(DRAG_NODE_ID_TYPE)) return;
    const kind = event.dataTransfer.getData(DRAG_BLOCK_KIND_TYPE);
    if (kind) insertBlockAt(kind, null);
  };
  /**
   * The block the indicator draws, built once per drag rather than per
   * `dragover`: `createNode()` mints an id, and rebuilding it on every pointer
   * move would remount the ghost dozens of times a second.
   */
  /**
   * The single resolution of "where will this land", shared with the insert
   * itself. Recomputed as the cursor moves; `planInsert` is a tree walk over a
   * document that is already in memory, so this is cheap next to the repaint
   * it drives.
   */
  const movingNode = useMemo(() => (doc && draggingNodeId ? findNode(doc, draggingNodeId) ?? null : null), [doc, draggingNodeId]);
  const dropPlan = useMemo(() => {
    if (!doc) return null;
    // Over the bare canvas: a new Section at the end, which is what
    // `onCanvasDrop` does. Moving an existing node is refused there, so it gets
    // no indicator either.
    if (overBackground) return draggingNodeId ? null : ({ at: 'end', containerId: null } as InsertPlan);
    if (!dropAt) return null;
    if (draggingReusable) return planInsert(doc, dropAt.id, draggingReusable.kind, dropAt.edge);
    if (movingNode) {
      // Nothing to show for a drop the model will refuse: onto itself, or
      // anywhere inside the subtree being moved. `moveNodeTo` returns the
      // document untouched in both cases, so an indicator would promise a move
      // that never happens.
      if (dropAt.id === movingNode.id) return null;
      if (ancestorsOf(doc, dropAt.id).some((ancestor) => ancestor.id === movingNode.id)) return null;
      return planInsert(doc, dropAt.id, movingNode.kind, dropAt.edge);
    }
    return draggingKind ? planInsert(doc, dropAt.id, draggingKind as Node['kind'], dropAt.edge) : null;
  }, [doc, dropAt, draggingKind, movingNode, overBackground, draggingNodeId, draggingReusable]);
  const dragGhost = useMemo(
    () => draggingReusable ?? movingNode ?? (draggingKind ? BLOCK_CATALOG.find((entry) => entry.kind === draggingKind)?.createNode() ?? null : null),
    [draggingKind, movingNode, draggingReusable],
  );
  /**
   * MC-UI-008, ADR-044 Task SV-5 (and S8 Task 49's remaining half). The server
   * owns the verdict -- `analysis.lint` and `analysis.unknownVariables`; this
   * only adds the address each row jumps to. See `content-review.ts`.
   */
  const reviewIssueList = useMemo(() => (doc ? reviewIssues(doc, analysis) : []), [doc, analysis]);
  const reviewIssueCounts = useMemo(() => reviewCounts(reviewIssueList), [reviewIssueList]);
  /**
   * "Đi tới khối và sửa →". Selecting the node is not enough on its own: the
   * canvas is hidden while the preview is open, so a jump from a review row
   * read while previewing would select a block nobody can see. Closing the
   * preview is part of the jump, not a side effect of it.
   */
  const selectIssueNode = (nodeId: string | null) => {
    if (!nodeId) return;
    setPreviewOpen(false);
    setSelectedId(nodeId);
    setActiveSidePanel('inspector');
  };

  /**
   * The person the preview renders for. Falls back to the fixed sample when no
   * recipient is chosen or the tenant has none -- BR-TPL-005's `missingKeys`
   * then reports against whichever of the two is actually in use, never
   * against data that was not sent.
   */
  const previewRecipient = recipients?.find((recipient) => recipient.id === previewRecipientId) ?? null;
  // MC-UI-008 render_variables (S4 Task 21 fidelity gate touch point): the merge
  // data `previewTemplateDraft` renders `{{key}}` against -- a real recipient
  // when one is picked, the shared sample otherwise.
  const previewMergeData = previewRecipient ? recipientMergeData(previewRecipient) : TEMPLATE_PREVIEW_SAMPLE;

  const removeSelected = () => { if (readOnly || isSelectedLocked || !selectedId) return; engine.removeBlock(selectedId); setSelectedId(null); };
  const moveSelected = (direction: 'up' | 'down') => { if (!readOnly && !isSelectedLocked && selectedId) engine.moveBlock(selectedId, direction); };
  const updateSelectedField = (key: string, value: unknown) => {
    if (readOnly || isSelectedLocked || !selectedId) return;
    // ADR-046 §Consequences names this the fragile part, so the remap happens
    // on the ONE write path rather than in the textarea's handler: edit
    // `content` from anywhere -- typing, a variable insertion, a paste -- and
    // the marks travel with the words instead of sliding onto different ones.
    if (key === 'content' && doc) {
      const node = findNode(doc, selectedId);
      if (node?.inline?.length) {
        const before = node.content ?? '';
        const after = String(value ?? '');
        const edit = diffEdit(before, after);
        engine.updateNode(selectedId, { content: after, inline: shiftInlineMarks(node.inline, edit.start, edit.end, edit.inserted, after.length) });
        return;
      }
    }
    engine.updateNode(selectedId, { [key]: value });
  };

  /**
   * Duplicate, copy and paste. All three are `engine.insertSubtree`, which
   * already clones through `withFreshIds` and already refuses a placement
   * `tree-ops` disallows -- so this adds no new way to change the document, it
   * reaches the existing one from three more places.
   *
   * The clipboard is a ref rather than state: nothing renders from it, and
   * making it state would re-render the whole builder on every copy.
   * Deliberately NOT the system clipboard -- reading that needs a permission
   * prompt, and writing a whole subtree to it as text would invite pasting a
   * block into an email body somewhere else and getting JSON.
   *
   * `locked` blocks a duplicate for the same reason it blocks a move: the lock
   * is on the node, and a copy of it is a new node the author did not place by
   * hand. Copy is allowed on a locked node -- reading is not changing.
   */
  const clipboardRef = useRef<Node | null>(null);
  const duplicateSelected = () => {
    if (readOnly || isSelectedLocked || !selectedId || !selectedNode) return;
    const id = engine.insertSubtree(selectedNode, selectedId, 'after');
    if (id) setSelectedId(id);
  };
  const copySelected = () => { if (selectedNode) clipboardRef.current = selectedNode; };
  const pasteClipboard = () => {
    const node = clipboardRef.current;
    if (readOnly || !node || !doc) return;
    // With nothing selected the paste still has to land somewhere sensible, so
    // it reuses the same resolver the Insert panel uses for a bare click.
    const target = selectedId ?? defaultInsertTarget(doc, node.kind);
    const id = engine.insertSubtree(node, target, selectedId ? 'after' : undefined);
    if (id) setSelectedId(id);
  };

  /**
   * The builder's editing shortcuts. Until now the whole screen had exactly one
   * key binding -- Escape, to close a sheet -- so building a five-section email
   * meant clicking the Insert panel five times and re-styling each block by
   * hand.
   *
   * Every branch routes to a handler that already exists and already carries
   * the `readOnly`/`locked` rules, so a shortcut can do nothing a button could
   * not. Three guards decide whether a key is ours at all:
   *
   * - **A form field has focus.** Ctrl+Z inside the title input must be the
   *   input's own undo, not the document's, or an author loses a word and gets
   *   back a block they deleted a minute ago.
   * - **A sheet or modal is open.** Escape already belongs to it, and the
   *   overlay owns the interaction underneath.
   * - **Text is selected.** Ctrl+C over a highlighted paragraph is a request to
   *   copy those words; only a collapsed selection means "copy this block".
   *
   * Backspace is bound alongside Delete because Apple keyboards send Backspace
   * from the key printed "delete" -- the first guard is what makes that safe.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (sheet || confirmRestore) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

      const accel = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const run = (action: () => void) => { event.preventDefault(); action(); };

      if (accel && key === 'z') return run(() => (event.shiftKey ? engine.redo() : engine.undo()));
      if (accel && key === 'y') return run(() => engine.redo());
      if (accel && key === 'd') return run(duplicateSelected);
      if (accel && (key === 'c' || key === 'v')) {
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        return run(key === 'c' ? copySelected : pasteClipboard);
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) return run(removeSelected);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  /** MC-UI-005 `bind` / `mark_decorative` (Task 39). Both go through the engine, the one route a component has into the model (spec §2.13); the rules that can refuse them live in `tree-ops.ts`. */
  const bindAssetToSelected = (src: string): boolean => (!readOnly && !isSelectedLocked && selectedId ? engine.bindAsset(selectedId, src) : false);
  const setSelectedDecorative = (decorative: boolean) => { if (!readOnly && !isSelectedLocked && selectedId) engine.markDecorative(selectedId, decorative); };
  const updateThemeField = (key: string, value: unknown) => { if (!readOnly) engine.updateTheme({ [key]: value }); };

  const rememberFocusedField = (nodeId: string, key: string) => (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    focusedFieldRef.current = { nodeId, key, el: event.currentTarget };
  };

  // --- S4 Task 19: Structure workspace (MC-UI-003) ---
  const treeRows = doc ? visibleTreeRows(doc, expandedIds) : [];
  const toggleNodeExpanded = (nodeId: string) => setExpandedIds((current) => toggleExpanded(current, nodeId));
  const expandAllNodes = () => { if (doc) setExpandedIds(expandAllIds(doc)); };
  // ADR-044 restoration (Task SV-3): `studio.tsx`'s `LayerNodes` row buttons
  // (`patch(id, {visible: n.visible === false})` / `patch(id, {locked: !n.locked})`),
  // exempt from the lock guard above -- unlocking has to work on a locked row.
  const toggleNodeVisible = (nodeId: string) => { if (!readOnly && doc) { const target = findNode(doc, nodeId); if (target) engine.updateNode(nodeId, { visible: target.visible === false }); } };
  const toggleNodeLocked = (nodeId: string) => { if (!readOnly && doc) { const target = findNode(doc, nodeId); if (target) engine.updateNode(nodeId, { locked: !target.locked }); } };
  /**
   * `Node.name` finally has a writer. Blank clears it, so the row falls back to
   * its kind label rather than keeping an empty string that reads as a nameless
   * name. Trimmed and capped at 60 to match the input's own `maxLength` -- the
   * tree row is one line and a novel in it helps nobody.
   */
  const renameNode = (nodeId: string, name: string) => {
    if (readOnly || !doc) return;
    const trimmed = name.trim().slice(0, 60);
    const target = findNode(doc, nodeId);
    if (!target || (target.name ?? '') === trimmed) return;
    engine.updateNode(nodeId, { name: trimmed || undefined });
  };
  /** "+ Section" (`v3-layer-toolbar`'s primary button, studio.tsx's `Layers`) -- always appends at the document root, independent of whatever is selected, matching the prototype's `addSection`. */
  const addSectionAtRoot = () => insertBlockAt('section', null);
  const collapseAllNodes = () => setExpandedIds(collapseAllIds());
  const onTreeRowKeyDown = (event: { key: string; preventDefault: () => void }, rowId: string) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); const next = moveFocus(treeRows, rowId, 'down'); if (next) setSelectedId(next); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); const next = moveFocus(treeRows, rowId, 'up'); if (next) setSelectedId(next); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); const result = rightKeyResult(treeRows, rowId, expandedIds); setExpandedIds(result.expandedIds); setSelectedId(result.focusId); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); const result = leftKeyResult(treeRows, rowId, expandedIds); setExpandedIds(result.expandedIds); setSelectedId(result.focusId); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(rowId); }
  };

  /** Inserts `{{key}}` at the caret of the last-focused inspector text field (decision 5: the panel is the only way in, no `/`/`{` shortcut yet). */
  const insertVariable = (variable: TemplateVariableCatalogueItem) => {
    const target = focusedFieldRef.current;
    if (!target || !doc) return;
    const node = findNode(doc, target.nodeId);
    if (!node) return;
    const current = String((node as unknown as Record<string, unknown>)[target.key] ?? '');
    const inserted = insertTemplateVariable(current, target.el.selectionStart, target.el.selectionEnd, variable.key);
    engine.updateNode(target.nodeId, { [target.key]: inserted.value });
    window.requestAnimationFrame(() => {
      target.el.focus();
      target.el.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  /**
   * ADR-046: apply or remove one mark over the textarea's current selection.
   *
   * The destination for a link is asked for with `window.prompt`, which is what
   * the prototype does for its two other authoring prompts (template title,
   * new variable key) -- a modal of our own would be a screen this ADR did not
   * decide to build. An empty answer removes the link, which is the only way
   * back out of one.
   */
  const toggleSelectedInlineMark = (kind: InlineMarkKind) => {
    const target = focusedFieldRef.current;
    if (readOnly || isSelectedLocked || !doc || !selectedId) return;
    if (!target || target.key !== 'content' || target.nodeId !== selectedId) return;
    const node = findNode(doc, selectedId);
    if (!node || (node.kind !== 'text' && node.kind !== 'heading')) return;

    const content = node.content ?? '';
    const start = target.el.selectionStart ?? 0;
    const end = target.el.selectionEnd ?? 0;
    if (!(end > start)) return;

    let href: string | undefined;
    if (kind === 'link') {
      const existing = (node.inline ?? []).find((mark) => mark.kind === 'link' && mark.start <= start && mark.end >= end);
      // Already linked -> the button is an "unlink". Otherwise ask, and treat
      // Cancel as "changed my mind" rather than as "remove the link".
      if (!existing) {
        const typed = window.prompt('Địa chỉ liên kết (https://…, mailto:…, tel:… hoặc {{ten_bien}})', '');
        if (typed === null) return;
        href = typed.trim();
        if (!href) return;
      }
    }

    engine.updateNode(selectedId, { inline: toggleInlineMark(node.inline, content.length, start, end, kind, href) });
    // The selection is what the author is looking at; putting it back is what
    // makes a second command (bold, then italic) land on the same words.
    window.requestAnimationFrame(() => { target.el.focus(); target.el.setSelectionRange(start, end); });
  };

  // Five states, not four (spec §2.7). Before Task 23 there was no 'conflict'
  // branch, so a rejected save fell through to "Đã lưu" -- reporting success at
  // the exact moment the server refused the write.
  const saveStatusText = !draft ? '' : readOnly ? 'Chế độ chỉ đọc · không lưu thay đổi'
    : state?.status === 'conflict' ? 'Bản nháp đã bị thay đổi ở nơi khác'
    : state?.status === 'saving' ? 'Đang lưu…'
    : state?.status === 'error' ? 'Lỗi tự động lưu'
    : savePending ? 'Đang chờ lưu…'
    : 'Đã lưu';

  useEffect(() => {
    setFocusHeader(draft ? {
      title: draft.name.trim() || 'Template chưa đặt tên',
      // The raw value, not the display fallback: binding an input to
      // "Template chưa đặt tên" would put words in the author's document that
      // the author never typed, and the first keystroke would edit them.
      titleValue: draft.name,
      onTitleChange: (value: string) => change({ name: value }),
      titleReadOnly: readOnly,
      saveStatusText,
      previewOpen,
      onBack: runBack,
      // The prototype's brand button opens the template library; the builder is
      // the only focus-mode screen that has one, so it is the only one that
      // supplies this.
      onBrand: () => { setRailPanel('templates'); setActiveSidePanel('workspace'); setSheet(null); },
      onPreviewToggle: () => setPreviewOpen((open) => !open),
      onPublish: openPublishSheet,
      publishDisabled: busy || savePending || readOnly,
      publishBusy: busy,
      onUndo: () => engine.undo(),
      onRedo: () => engine.redo(),
      undoDisabled: readOnly || !engine.canUndo(),
      redoDisabled: readOnly || !engine.canRedo(),
    } : null);
    return () => setFocusHeader(null);
    // `doc` is in the dependency list only so undo/redo re-evaluate their
    // disabled state: `canUndo()` reads engine history, which changes on every
    // commit and would otherwise leave both buttons greyed out for the whole
    // session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, doc, saveStatusText, previewOpen, busy, savePending, readOnly]);

  if (loadError && !state && templateLoadFailure(loadErrorStatus) === 'permissionDenied') return <div className="module-card permission-denied-card" role="alert">
    <i aria-hidden="true"><UiIcon name="lock" size={22} /></i>
    <span className="status danger">Không đủ quyền truy cập</span>
    <h2>Bạn không có quyền xem template này</h2>
    <p>Vai trò hiện tại của bạn không cho phép xem nội dung template. Quyền có thể vừa được thay đổi — hãy đăng nhập lại, hoặc liên hệ quản trị viên nếu bạn cần được cấp quyền.</p>
    <button type="button" className="secondary-button" onClick={leaveToList}>Quay lại thư viện</button>
  </div>;
  if (loadError && !state) return <div className="module-card permission-denied-card" role="alert">
    <i aria-hidden="true"><UiIcon name="warning" size={22} /></i>
    <span className="status danger">Không thể tải dữ liệu</span>
    <h2>Không thể mở template</h2>
    <p>{loadError}</p>
    <button type="button" className="secondary-button" onClick={() => void load()}><UiIcon name="refresh" size={16} /> Thử lại</button>
    <button type="button" className="secondary-button" onClick={leaveToList}>Quay lại thư viện</button>
  </div>;
  if (!draft) return <div className="compose-card" role="status">Đang tải template…</div>;

  /**
   * S9 Task 52's verdict, recomputed on every render from the same `draft`
   * and `analysis` the rest of the screen already reads -- `publishReadiness`
   * is cheap and pure, so there is nothing to memoize. `analysis === null`
   * (the 450ms debounce in flight, or the very first paint) is what
   * `MC-UI-010.publish_validating` renders: `publishReadiness` already
   * reports that moment as the `ANALYSIS_PENDING` blocking item, so the sheet
   * does not need a second "is it still loading" flag of its own.
   */
  // ADR-050: `publishReadiness` now reads the tree (`hasPostalAddress`), not
  // just the rendered draft fields. `doc` starts null until `getProjectData()`
  // resolves (see the effects above); an empty tree in that brief window
  // blocks on MISSING_POSTAL_ADDRESS the same way `ANALYSIS_PENDING` already
  // blocks before the first analysis arrives -- both clear once the real data
  // lands, neither is a false "ready to publish".
  const publishSummary = publishReadiness({ ...draft, doc: doc ?? { title: '', nodes: [], variables: [] } }, analysis);
  /**
   * `versions[0]` is the newest published version (server sorts `version
   * DESC`; see the `listTemplateVersions` effect above and
   * TemplateVersionHistory.tsx's own comment on the same fact). `versions`
   * stays `null` for the instant between opening the publish sheet and that
   * fetch resolving, and also before the sheet has ever been opened -- both
   * read as "no version yet", which is only wrong for the few hundred ms the
   * fetch is in flight and never shown as a wrong number, only a blank strip.
   */
  const currentVersion = versions?.[0]?.version ?? 0;
  /**
   * The freeze strip only needs `doc` (for `blockCount`) and the version list
   * (for `nextVersion`) -- both load asynchronously, so this stays `null`
   * until both are in, and the sheet shows a loading row instead of a
   * strip built on a doc that is not there yet.
   */
  const freeze = doc && versions !== null
    ? freezeSummary({
        currentVersion,
        doc,
        html: draft.html,
        // Distinct KEYS referenced in this draft's content right now, not
        // `doc.variables` (the builder's declared-variable list) -- matching
        // `publishReadiness`'s own `unknownVariables` dedup just above, this
        // counts what the about-to-be-frozen HTML/subject/text actually use.
        variableKeys: (analysis?.variables ?? []).map((occurrence) => occurrence.key),
      })
    : null;

  // ADR-044 Task SV-2: `v3-app` and `v3-work` are the prototype's page and
  // editor grids. EOW re-states their geometry (globals.css, "Task SV-2
  // ADDITIONS") because the header is AppShell's under ADR-041 and conventions
  // spec §2.2 needs three responsive tiers studio.css has none of -- the
  // classes are here so everything nested inside them is styled by studio.css
  // as written.
  return <div className="builder-shell v3-app">
    {readOnly && <div className="template-readonly-notice" data-mc-state="MC-UI-001.permission_denied" role="status">
      <span aria-hidden="true"><UiIcon name="lock" size={16} /></span>
      <div>
        <b>Bạn đang xem template ở chế độ chỉ đọc</b>
        <p>Vai trò hiện tại của bạn cho phép xem nội dung template nhưng không cho phép chỉnh sửa, xuất bản hay lưu trữ. Liên hệ quản trị viên nếu bạn cần quyền chỉnh sửa nội dung.</p>
      </div>
    </div>}
    <div className="builder-body">
      {state?.status === 'conflict' && <div className="compose-conflict" data-mc-state="MC-UI-001.revision_conflict" role="alert">
        <div><b>Bản nháp đã bị thay đổi ở nơi khác</b><p>Thay đổi của bạn vẫn được giữ nguyên và chưa có gì bị ghi đè. Chọn bản trên máy chủ, hoặc áp lại thay đổi của bạn lên bản mới nhất.</p></div>
        {conflictServer && <div className="compose-conflict-diff">
          {Object.entries(state.pending ?? {}).map(([field, localValue]) => <div key={field}>
            <span>{TEMPLATE_CONFLICT_FIELD_LABEL[field] ?? field}</span>
            <small>Máy chủ: {templateConflictExcerpt(conflictServer[field as keyof EmailTemplate])}</small>
            <b>Cục bộ: {templateConflictExcerpt(localValue)}</b>
          </div>)}
        </div>}
        {conflictLoadError && <p className="login-error">{conflictLoadError}</p>}
        <div className="compose-conflict-actions">
          <button type="button" className="secondary-button" disabled={!conflictServer} onClick={() => resolveConflict(false)}>Dùng bản trên máy chủ</button>
          <button type="button" className="primary-button" disabled={!conflictServer} onClick={() => resolveConflict(true)}>Giữ thay đổi của tôi</button>
          {!conflictServer && <button type="button" className="secondary-button" onClick={() => {
            setConflictLoadError(null);
            void getTemplate(id).then(setConflictServer).catch((cause) => setConflictLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải phiên bản mới nhất.'));
          }}>Tải lại so sánh</button>}
        </div>
      </div>}
      {actionError && <p className="login-error" role="alert">{actionError}</p>}
      {previewOpen
        ? <div className="compose-preview">
            {/* MC-UI-008 switch_device */}
            <div className="compose-preview-toolbar">
              <div className="device-switch" data-mc-action="MC-UI-008.switch_device">
                <button type="button" className={device === 'desktop' ? 'active' : ''} onClick={() => setDevice('desktop')}>▱ Desktop</button>
                <button type="button" className={device === 'mobile' ? 'active' : ''} onClick={() => setDevice('mobile')}>▯ Mobile</button>
              </div>
            </div>
            {/* ADR-044 Task SV-5: the prototype's two-column preview -- people
                on the left, a framed inbox on the right. The prototype paints
                the mail with `dangerouslySetInnerHTML`; the `<iframe sandbox="">`
                stays, which ADR-044 records as a place this repo is ahead of
                the source and not a deviation to repair. */}
            <div className="v3-preview-work">
              <aside>
                <h3>Người nhận</h3>
                {/* Rendering for a real person is what makes `missingKeys`
                    below mean anything: with one fixed sample every template
                    missed the same keys, so the line was noise. */}
                <button type="button" className={previewRecipient ? '' : 'active'} aria-pressed={!previewRecipient} onClick={() => setPreviewRecipientId(null)}>
                  <span>M</span><div><b>Dữ liệu mẫu</b><small>Không gắn với người nhận nào</small></div>
                </button>
                {(recipients ?? []).map((recipient) => <button
                  key={recipient.id}
                  type="button"
                  className={recipient.id === previewRecipientId ? 'active' : ''}
                  aria-pressed={recipient.id === previewRecipientId}
                  onClick={() => setPreviewRecipientId(recipient.id)}
                >
                  <span>{recipientInitial(recipient)}</span>
                  <div><b>{recipientLabel(recipient)}</b><small>{recipientCaption(recipient)}</small></div>
                  {recipientCaption(recipient) === '—' && <em>!</em>}
                </button>)}
                {recipients === null && <p className="builder-library-hint" role="status">Đang tải người nhận…</p>}
                {recipientsError && <p className="field-help" role="status">{recipientsError} Đang dùng dữ liệu mẫu.</p>}
                {recipients !== null && recipients.length === 0 && !recipientsError && <p className="builder-library-hint" role="status">Chưa có người nhận nào đang hoạt động.</p>}
              </aside>
              <div className="v3-inbox">
                <header>
                  <span>● ● ●</span>
                  <b>Hộp thư doanh nghiệp</b>
                  <small>{previewRecipient ? recipientLabel(previewRecipient) : 'Dữ liệu mẫu'}</small>
                </header>
                <div className={`mail-preview-stage ${device}`}>
                  {previewError && <p className="login-error" data-mc-state="MC-UI-008.error" role="alert">{previewError}</p>}
                  {!previewError && !preview && <div className="template-preview-loading" data-mc-state="MC-UI-008.loading" role="status">Đang tạo bản xem trước…</div>}
                  {preview && <iframe className="template-preview-frame" data-mc-state="MC-UI-008.success" data-mc-action="MC-UI-008.render_variables" title="Bản xem trước email" sandbox="" srcDoc={preview.html} />}
                </div>
                {/* BR-TPL-005: the server decides what is missing. Hiding
                    `missingKeys` would turn a preview that cannot be rendered
                    for this person into one that looks complete. */}
                {preview && <p className={preview.missingKeys.length > 0 ? 'template-warning' : 'template-preview-ready'} role="status">
                  {preview.missingKeys.length > 0
                    ? `Thiếu dữ liệu cho: ${preview.missingKeys.join(', ')}.${previewRecipient ? ' Người nhận này chưa có các giá trị đó.' : ' Người nhận thật sẽ nhận giá trị của chính họ.'}`
                    : '✓ Mọi biến đều có giá trị cho người nhận này.'}
                </p>}
              </div>
            </div>
          </div>
        : <>
            {/* 1024-1279px only (conventions spec §2.2) -- hidden outside that band by CSS, so this toggle is a no-op everywhere else. */}
            <div className="builder-panel-toggle" aria-label="Chọn panel bên">
              <button type="button" aria-pressed={activeSidePanel === 'workspace'} onClick={() => setActiveSidePanel('workspace')}>Công cụ</button>
              <button type="button" aria-pressed={activeSidePanel === 'inspector'} onClick={() => setActiveSidePanel('inspector')}>Thuộc tính</button>
            </div>
            <div
              className="builder-workspace v3-work"
              data-active-panel={activeSidePanel}
              style={{ '--mc-workspace-w': `${WORKSPACE_PANEL_WIDTH[workspacePanelSize]}px`, '--mc-inspector-w': `${INSPECTOR_PANEL_WIDTH[inspectorSize]}px` } as CSSProperties}
            >
              {/* Task 17 built this rail with UI-HANDOFF §2's four destinations. ADR-044
                  Task SV-2 (decision 1) widens it to the prototype's ten, in the prototype's
                  own `v3-rail` shape: two <nav> groups with History alone in the second, and
                  a `v3-rail-separator` under the template library. Every destination renders
                  regardless of whether it has content yet -- an unbuilt one shows an
                  explained empty state instead of disappearing. `mc-tool-rail` stays
                  alongside `v3-rail`: six e2e specs select rail buttons through it and Task
                  SV-6 is where they migrate. */}
              <aside className="mc-tool-rail v3-rail" aria-label="Công cụ Mailcraft">
                {(['nav', 'foot'] as const).map((group) => (
                  <nav key={group}>
                    {RAIL_DESTINATIONS.filter((destination) => destination.group === group).map((destination) => <Fragment key={destination.id}>
                      <button
                        type="button"
                        className={(destination.kind === 'panel' ? destination.id === railPanel : destination.id === sheet) ? 'active' : ''}
                        aria-pressed={destination.kind === 'panel' ? destination.id === railPanel : destination.id === sheet}
                        title={destination.label}
                        onClick={() => openRailDestination(destination)}
                      >
                        {/* `v3-icon` is the prototype's own icon wrapper (studio.tsx's `I`).
                            aria-hidden matters as much as the class: without it the glyph
                            joins the button's accessible name and every e2e
                            `getByRole('button', { name, exact: true })` on this rail breaks. */}
                        <span className="v3-icon" aria-hidden="true"><UiIcon name={RAIL_ICON[destination.id]} size={18} /></span>
                        <span>{destination.label}</span>
                        {/* The prototype badges Review with its open-issue count. It is the
                            reason moving the lint list into a panel is not a loss of
                            visibility: the count is on the rail whether the panel is open or not. */}
                        {destination.id === 'review' && analysis && analysis.lint.length > 0 && <em>{analysis.lint.length}</em>}
                      </button>
                      {destination.separatorAfter && <i className="v3-rail-separator" />}
                    </Fragment>)}
                  </nav>
                ))}
              </aside>

              {/* One workspace shell shared by every rail destination (UI-HANDOFF §2): same header, scroll region, compact/expanded toggle -- Insert/Structure/Reusable/Assets never open at unrelated sizes. */}
              <aside className="mc-workspace-panel v3-left" aria-label={railEntryFor(railPanel)?.label}>
                <header className="mc-workspace-panel-header v3-panel-head">
                  <b>{railEntryFor(railPanel)?.label}</b>
                  <button
                    type="button" className="mc-panel-expand-toggle"
                    aria-pressed={workspacePanelSize === 'expanded'}
                    aria-label={workspacePanelSize === 'expanded' ? 'Thu gọn panel' : 'Mở rộng panel'}
                    onClick={() => setWorkspacePanelSize(otherPanelSize(workspacePanelSize))}
                  ><UiIcon name="expand" size={14} /></button>
                </header>
                <div className="mc-workspace-panel-body">
                  {/* ADR-044 Task SV-2, decision 1: "Kho mẫu" lists the tenant's own
                      templates through `listTemplates` rather than the prototype's
                      hard-coded presets, and its footer leads to the screen that manages
                      them. The DOM is the prototype's (`v3-template-*`, `v3-library-*`);
                      only the data behind the filter bar is EOW's, because
                      `EmailTemplateSummary` has status and no hr/internal/event category. */}
                  {railPanel === 'templates' && <div className="v3-template-library">
                    <button type="button" className="v3-blank-template" disabled={readOnly} onClick={startBlankDocument}>
                      <span aria-hidden="true">＋</span>
                      <div><b>Email trắng</b><small>Bắt đầu lại với một Section và Cột rỗng hợp lệ</small></div>
                      <em aria-hidden="true">→</em>
                    </button>
                    <div className="v3-sheet-toolbar">
                      <label className="v3-search">⌕<input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="Tìm trong kho mẫu" /></label>
                      {/* ADR-044 Task SV-5. The register filed `v3-view-note`
                          under the PREVIEW sheet; measured against studio.tsx
                          it is on line 944, in the TEMPLATES branch -- the
                          "N mẫu sẵn sàng" count beside that sheet's search box.
                          Fourth mis-attribution in this slice, same fix: grep
                          the component, do not read the comment. */}
                      <div className="v3-view-note">{libraryItems === null ? 'Đang tải…' : `${libraryItems.length} mẫu sẵn sàng`}</div>
                    </div>
                    <div className="v3-library-filters">
                      {TEMPLATE_LIBRARY_FILTERS.map((filter) => (
                        <button key={filter.id} type="button" className={filter.id === libraryFilter ? 'active' : ''} aria-pressed={filter.id === libraryFilter} onClick={() => setLibraryFilter(filter.id)}>{filter.label}</button>
                      ))}
                    </div>
                    {libraryError && <p className="login-error" role="alert">{libraryError}</p>}
                    {!libraryError && libraryItems === null && <p className="builder-library-hint" role="status">Đang tải kho mẫu…</p>}
                    {libraryItems !== null && (() => {
                      const shown = filterLibraryTemplates(libraryItems, libraryFilter, librarySearch);
                      return <div className="v3-template-scroll">
                        <header><b>MẪU CÓ SẴN</b><span>{shown.length}</span></header>
                        <div className="v3-template-grid">
                          {shown.map((item) => <button key={item.id} type="button" disabled={readOnly} onClick={() => void applyLibraryTemplate(item)}>
                            <span className={`v3-template-thumb ${templateThumbTone(item.id)}`} aria-hidden="true"><i /><b /><em /><small /></span>
                            <span className="v3-template-copy">
                              <b>{item.name}</b>
                              <small>{item.subject || 'Chưa có tiêu đề'}</small>
                              <em>{item.status === 'published' ? 'Đã xuất bản' : 'Nháp'}</em>
                            </span>
                            <strong>Dùng mẫu</strong>
                          </button>)}
                        </div>
                        {shown.length === 0 && <p className="v3-template-empty">Không tìm thấy mẫu phù hợp.</p>}
                      </div>;
                    })()}
                    <footer className="v3-library-footer">
                      <button type="button" onClick={runBack}>
                        <span><b>Quản lý toàn bộ kho mẫu</b><small>Mẫu nháp, mẫu đã xuất bản và mẫu đã lưu trữ</small></span>
                        <em aria-hidden="true">→</em>
                      </button>
                    </footer>
                  </div>}
                  {railPanel === 'insert' && <>
                    {/* ADR-044 restoration (Task SV-3, `v3-atomic-note`): studio.tsx's `Library` compose-freely hint, in place of the old plain paragraph. */}
                    <div className="v3-atomic-note">
                      <span>＋</span>
                      <div>
                        <b>Chèn đúng vị trí đang chọn</b>
                        <small>Bấm để chèn vào khối đang chọn (không chọn gì thì chèn vào cuối tài liệu), hoặc kéo thả vào canvas.</small>
                      </div>
                    </div>
                    <label className="v3-search">⌕<input value={blockSearch} onChange={(event) => setBlockSearch(event.target.value)} placeholder="Tìm element hoặc bố cục" /></label>
                    <div className="v3-block-scroll" data-mc-state="MC-UI-002.success">
                      {(() => {
                        const needle = foldVietnamese(blockSearch);
                        const shown = INSERT_PANEL.filter((entry) => needle.length === 0 || foldVietnamese(entry.label).includes(needle));
                        if (shown.length === 0) return <p className="builder-library-hint">Không có khối nào khớp “{blockSearch}”.</p>;
                        return BLOCK_GROUP_ORDER.map((group) => {
                          const items = shown.filter((entry) => entry.group === group);
                          if (items.length === 0) return null;
                          // `layout-section` + `layout-option`: studio.tsx puts the
                          // layout group in a two-column grid of 63px tiles, so the six
                          // shapes read as shapes rather than as another list of names.
                          // Both rules have been in `globals.css` verbatim since the port
                          // and neither class was ever written onto an element.
                          return <section key={group} className={group === 'layout' ? 'layout-section' : ''}>
                            <h3>{BLOCK_GROUP_LABEL[group]}<span>{items.length}</span></h3>
                            {items.map((entry) => (
                              <button
                                key={entry.id} type="button" disabled={readOnly}
                                className={entry.kind === 'section' || entry.widths ? 'layout-option' : ''}
                                // The hint is a DESCRIPTION, not part of the name. Text
                                // inside a button joins its accessible name from content,
                                // and adding `<small>` made every palette button answer to
                                // "Khối (Section) Lớp ngoài cùng của email" -- which broke
                                // `getByRole('button', { name, exact: true })` in four
                                // specs. `aria-hidden` keeps it out of the name while
                                // `aria-describedby` still resolves it, so a screen reader
                                // announces the placement rule rather than losing it. Same
                                // lesson the rail icons carry two hundred lines up.
                                aria-describedby={`block-hint-${entry.id}`}
                                onClick={() => insertBlock(entry.id)}
                                // Task 20: drag is additive -- the click above already inserts the same block.
                                draggable={!readOnly}
                                onDragStart={(event) => { event.dataTransfer.setData(DRAG_BLOCK_KIND_TYPE, entry.id); setDraggingKind(entry.kind); }}
                                // Without this the indicator survives a drag
                                // that ends outside the canvas -- the stale
                                // dashed outline the old `dragOverId` left
                                // behind, which had no clearing path at all.
                                onDragEnd={endDrag}
                              >
                                <i aria-hidden="true">{entry.icon}</i>
                                <span>
                                  <b>{entry.label}</b>
                                  {/* C9. `globals.css` has carried
                                      `.v3-block-scroll section>button small` and
                                      `... > button em` since the port -- two rules with no
                                      element to style, because the markup only ever rendered
                                      the icon and the label. The `em` is the prototype's grip
                                      glyph and it is the ONLY thing on screen that says these
                                      can be dragged; without it an author has no reason to
                                      try, which is half of "kéo thả không dùng được".

                                      The hint comes from `requiredParentKind` -- the same
                                      function the insert itself uses -- so the panel cannot
                                      end up teaching a rule the model does not follow. */}
                                  {/* A layout preset says its ratio, exactly as
                                      studio.tsx does (`spec.widths.join(" / ")`) -- "35 / 65"
                                      is the whole reason to pick that button over the one
                                      beside it, and no placement rule could say it. */}
                                  <small id={`block-hint-${entry.id}`} aria-hidden="true">{entry.widths
                                    ? entry.widths.join(' / ')
                                    : (() => { const parent = requiredParentKind(entry.kind); return parent ? `Nằm trong ${NODE_LABEL[parent]}` : 'Lớp ngoài cùng của email'; })()}</small>
                                </span>
                                <em aria-hidden="true">⠿</em>
                              </button>
                            ))}
                          </section>;
                        });
                      })()}
                    </div>
                  </>}
                  {railPanel === 'structure' && <>
                    {/* ADR-044 restoration (Task SV-3, `v3-layer-toolbar`): studio.tsx's `Layers` toolbar adds "+ Section" alongside expand/collapse -- lost when the tree became a flat DOM port. */}
                    <div className="builder-inspector-actions v3-layer-toolbar">
                      <button type="button" disabled={!doc || doc.nodes.length === 0} onClick={expandAllNodes}>Mở rộng tất cả</button>
                      <button type="button" disabled={expandedIds.size === 0} onClick={collapseAllNodes}>Thu gọn tất cả</button>
                      <button type="button" className="primary" disabled={readOnly} onClick={addSectionAtRoot}>＋ Section</button>
                    </div>
                    <StructureTreeView rows={treeRows} selectedId={selectedId} expandedIds={expandedIds} readOnly={readOnly} onSelect={setSelectedId} onToggleExpand={toggleNodeExpanded} onToggleVisible={toggleNodeVisible} onToggleLocked={toggleNodeLocked} onRename={renameNode} onKeyDown={onTreeRowKeyDown} />
                  </>}
                  {railPanel === 'reusable' && <ReusableBlocksPanel
                    readOnly={readOnly}
                    canSaveSelection={Boolean(selectedNode)}
                    onSaveSelection={saveSelectionAsBlock}
                    onInsert={insertReusableBlock}
                    onDragStartBlock={onReusableDragStart}
                    onDragEndBlock={endDrag}
                    saveError={reusableSaveError}
                    onDismissSaveError={() => setReusableSaveError(null)}
                  />}
                  {railPanel === 'assets' && <AssetsPanel
                    readOnly={readOnly}
                    provider={assets}
                    missing={missingAssets}
                    onSelectNode={setSelectedId}
                    boundTargetLabel={selectedNode && (IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(selectedNode.kind) ? NODE_LABEL[selectedNode.kind] : null}
                    onBind={bindAssetToSelected}
                  />}
                  {/* Decision 1 again: "Biến" and "Soát lỗi" are the variable catalogue and
                      the lint list that already existed at the foot of the inspector and the
                      foot of the screen. They MOVED here -- they are not rendered in both
                      places, which would be the second copy the decision forbids. The rail
                      badges the review count so the warnings stay discoverable with the
                      panel closed. */}
                  {/* ADR-044 Task SV-5. These three classes were filed under
                      MC-UI-008/011; measured against studio.tsx they are on
                      line 945, the VARIABLES branch of `Sheet` -- a different
                      screen. SV-2 decision 4 had already MOVED the variable
                      list here from the inspector, so the destination existed
                      and only the prototype's chrome was missing: a scope
                      switcher, per-group counts, and the card naming whose data
                      the preview is currently rendering with. */}
                  {railPanel === 'variables' && <div className="builder-variables">
                    <p className="builder-library-hint">Bấm vào ô nội dung/URL cần chèn rồi chọn một biến bên dưới.</p>
                    <div className="v3-scope-tabs" role="group" aria-label="Lọc theo phạm vi biến">
                      {VARIABLE_SCOPES.map((scope) => <button
                        key={scope.id}
                        type="button"
                        className={variableScope === scope.id ? 'active' : ''}
                        aria-pressed={variableScope === scope.id}
                        onClick={() => setVariableScope(scope.id)}
                      >{scope.label}</button>)}
                    </div>
                    {/* The prototype hard-codes one name here. This says which
                        data the preview beside it is actually merging, so the
                        two panels cannot disagree about who is being previewed. */}
                    <div className="v3-context-card">
                      <span aria-hidden="true">◎</span>
                      <div>
                        <small>DỮ LIỆU XEM TRƯỚC</small>
                        <b>{previewRecipient ? `${recipientLabel(previewRecipient)} · ${recipientCaption(previewRecipient)}` : 'Dữ liệu mẫu'}</b>
                      </div>
                      <button type="button" onClick={() => setPreviewOpen(true)}>Đổi người</button>
                    </div>
                    {groupTemplateCatalogue(catalogue ?? []).map((group) => (variableScope === 'all' || variableScope === group.source) && group.items.length > 0 && <section key={group.source} className="v3-var-group builder-variable-group">
                      <h3>{{ system: 'Mặc định hệ thống', global: 'Dùng chung hiện có', recipient: 'Dữ liệu người nhận', template: 'Riêng template này' }[group.source]}<span>{group.items.length}</span></h3>
                      <div className="builder-library-grid">
                        {group.items.map((variable) => <button key={variable.key} type="button" title={variable.required ? 'Bắt buộc' : (variable.example ?? undefined)} onClick={() => insertVariable(variable)}>{variable.label}</button>)}
                      </div>
                    </section>)}
                    {groupTemplateCatalogue(catalogue ?? []).every((group) => variableScope !== 'all' && variableScope !== group.source || group.items.length === 0) && <p className="builder-library-hint" role="status">Không có biến nào ở phạm vi này.</p>}
                  </div>}
                  {/* ADR-044 Task SV-5, which also closes S8 Task 49's second
                      half. S4 rendered the six lint codes as flat <p> rows; the
                      prototype's review sheet makes every row a button reading
                      "Đi tới khối và sửa →", and §2.8 asks for exactly that.
                      `content-review.ts` owns which node a row points at -- and
                      owns the rule that the SERVER decides what is wrong while
                      this only decides where to jump. A row it cannot place
                      still renders, without the jump, rather than being
                      hidden. */}
                  {railPanel === 'review' && <>
                    {analysisStale && analysis && <p className="field-help" role="status">Không kiểm tra được nội dung mới nhất. Cảnh báo bên dưới là từ lần kiểm gần nhất.</p>}
                    {!analysis && <p className="builder-library-hint" role="status">Đang kiểm tra nội dung…</p>}
                    {analysis && <div data-mc-action="MC-UI-008.run_content_review">
                      <div className={`v3-review-summary ${reviewIssueList.length ? 'bad' : 'clean'}`}>
                        <span>{reviewIssueList.length || '✓'}</span>
                        <div>
                          <small>MỨC SẴN SÀNG</small>
                          <b>{reviewIssueList.length ? `${reviewIssueList.length} mục cần xử lý trước khi gửi` : 'Nội dung đã sẵn sàng'}</b>
                          <p>Soát theo tác động thực tế: liên kết, hình ảnh, dữ liệu và khả năng đọc.</p>
                          <i><em style={{ width: `${readinessPercent(reviewIssueList.length)}%` }} /></i>
                        </div>
                      </div>
                      <div className="v3-review-filters" role="group" aria-label="Lọc theo mức độ">
                        {(['all', 'error', 'warn'] as const).map((filter) => <button
                          key={filter}
                          type="button"
                          className={reviewFilter === filter ? 'active' : ''}
                          aria-pressed={reviewFilter === filter}
                          onClick={() => setReviewFilter(filter)}
                        >{filter === 'all' ? 'Tất cả' : filter === 'error' ? 'Cần sửa' : 'Nên xem'}<span>{reviewIssueCounts[filter]}</span></button>)}
                      </div>
                      <div className="v3-issues" role="status">
                        {filterReviewIssues(reviewIssueList, reviewFilter).map((issue) => <button
                          key={issue.id}
                          type="button"
                          data-mc-action="MC-UI-008.run_content_review"
                          disabled={!issue.nodeId}
                          onClick={() => selectIssueNode(issue.nodeId)}
                        >
                          <span className={issue.level === 'error' ? 'error' : 'warn'}>!</span>
                          <div>
                            <small>{issue.level === 'error' ? 'CẦN SỬA' : 'NÊN XEM'}</small>
                            <b>{issue.title}</b>
                            <p>{issue.detail}</p>
                            {/* No jump offered rather than a jump to the wrong
                                block: the server lints emitted HTML, and not
                                every finding has a node behind it. */}
                            <em>{issue.nodeId ? 'Đi tới khối và sửa →' : 'Không gắn với một khối cụ thể'}</em>
                          </div>
                        </button>)}
                        {filterReviewIssues(reviewIssueList, reviewFilter).length === 0 && <p className="no-issues" role="status">✓ {reviewIssueList.length === 0 ? 'Không tìm thấy lỗi cần xử lý' : 'Không có mục nào ở mức này'}</p>}
                      </div>
                      {reviewIssueList.length > 0 && <div className="v3-sheet-actionbar review-action">
                        <span>Ưu tiên lỗi có thể làm email bị trống</span>
                        <button type="button" onClick={() => selectIssueNode((reviewIssueList.find((issue) => issue.level === 'error' && issue.nodeId) ?? reviewIssueList.find((issue) => issue.nodeId))?.nodeId ?? null)}>Sửa mục tiếp theo →</button>
                      </div>}
                    </div>}
                  </>}
                </div>
              </aside>

              {/* ADR-044 Task SV-2: the prototype's canvas column --
                  `v3-canvas-area` wraps a `v3-canvas-tools` bar over the scrolling
                  `v3-canvas`, which centres a fixed-width `v3-stage` holding the
                  `v3-email` surface. The device toggle is MC-UI-008's own
                  `switch_device`, the same state the preview toolbar drives; the two
                  are never on screen at once, so this is one control rendered per view
                  rather than a second one. `.email-canvas` stays (spec §2.3: the
                  surface must stay light in dark mode -- it is a real email, not app
                  chrome) and so does `.builder-canvas`, which six e2e specs select. */}
              <section className="v3-canvas-area">
                <div className="v3-canvas-tools">
                  <span data-mc-action="MC-UI-008.switch_device">
                    <button type="button" className={device === 'desktop' ? 'active' : ''} aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>▱ Desktop</button>
                    <button type="button" className={device === 'mobile' ? 'active' : ''} aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')}>▯ Mobile</button>
                  </span>
                  <span>
                    <button type="button" aria-label="Thu nhỏ canvas" onClick={() => setZoom((value) => Math.max(60, value - 10))}>−</button>
                    <b>{zoom}%</b>
                    <button type="button" aria-label="Phóng to canvas" onClick={() => setZoom((value) => Math.min(120, value + 10))}>＋</button>
                  </span>
                </div>
                <div
                  className={`email-canvas builder-canvas v3-canvas ${device}`}
                  onClick={() => setSelectedId(null)} onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) { setDropAt(null); setOverBackground(false); } }}
                  style={{ '--mc-outer-bg': theme.outerBg } as CSSProperties}
                >
                  <div className="v3-stage" style={{ transform: `scale(${zoom / 100})`, '--mc-email-width': `${theme.width}px` } as CSSProperties}>
                    <div className="v3-email" style={{ background: theme.contentBg, fontFamily: theme.fontFamily, fontSize: `${theme.baseFontSize}px` }}>
                      {doc && doc.nodes.length > 0
                        ? <>{doc.nodes.map((node) => <CanvasNodeView key={node.id} node={node} selectedId={selectedId} onSelect={setSelectedId} dropPlan={dropPlan} ghost={dragGhost} movingId={draggingNodeId} onNodeDragStart={onNodeDragStart} onNodeDragOver={onNodeDragOver} onNodeDrop={onNodeDrop} onDragFinished={endDrag} />)}{dropPlan?.at === 'end' && dropPlan.containerId === null && <DropIndicator ghost={dragGhost} />}</>
                        : <p className="builder-node-empty">Canvas trống — chèn khối từ thư viện bên trái để bắt đầu.</p>}
                    </div>
                  </div>
                </div>
              </section>

              {/* ADR-044 Task SV-2: the prototype's inspector -- `v3-inspect-head` naming
                  what is selected and what it is for, `v3-tabs` splitting its controls three
                  ways, `v3-inspect-scroll` holding them, `v3-inspect-actions` at the foot.
                  Which tab a field belongs to is data on the field (`inspector-fields.ts`),
                  not a guess made here. `builder-inspector` stays for the e2e specs SV-6
                  migrates, and so does `builder-inspector-field` on every label. */}
              <aside className={`builder-inspector v3-inspector${selectedNode ? '' : ' empty'}`} aria-label="Thuộc tính">
                <div className="mc-workspace-panel-header v3-inspect-head">
                  <span aria-hidden="true">{selectedNode ? BLOCK_ICON[selectedNode.kind] : '◐'}</span>
                  <div>
                    <b>{selectedNode ? NODE_LABEL[selectedNode.kind] : 'Thuộc tính'}</b>
                    <small>{selectedNode ? 'Chỉ ảnh hưởng tới khối đang chọn' : 'Chọn một thành phần trên canvas'}</small>
                  </div>
                  <button
                    type="button" className="mc-panel-expand-toggle"
                    aria-pressed={inspectorSize === 'expanded'}
                    aria-label={inspectorSize === 'expanded' ? 'Thu gọn khung thuộc tính' : 'Mở rộng khung thuộc tính'}
                    onClick={() => setInspectorSize(otherPanelSize(inspectorSize))}
                  ><UiIcon name="expand" size={14} /></button>
                </div>
                {breadcrumb.length > 0 && <nav className="builder-breadcrumb" aria-label="Vị trí trong tài liệu">
                  {breadcrumb.map((crumb, index) => <span key={crumb.id}>
                    {index > 0 && <span aria-hidden="true"> › </span>}
                    <button type="button" className={crumb.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(crumb.id)}>{NODE_LABEL[crumb.kind]}</button>
                  </span>)}
                </nav>}
                {selectedNode && <div className="v3-tabs">
                  {INSPECTOR_TABS.map((tab) => (
                    <button key={tab.id} type="button" className={tab.id === inspectorTab ? 'active' : ''} aria-pressed={tab.id === inspectorTab} onClick={() => setInspectorTab(tab.id)}>{tab.label}</button>
                  ))}
                </div>}

                <div className="v3-inspect-scroll">
                {selectedNode ? <>
                  {/* ADR-044 restoration (Task SV-3): the structure tree's lock toggle now has a real effect on the selected node's own edit paths -- unlock it there to resume editing. */}
                  {isSelectedLocked && <p className="builder-field-warning">Khối đang khoá — mở khoá trong cây cấu trúc để tiếp tục chỉnh sửa.</p>}
                  {inspectorTab === 'content' && selectedNode.kind === 'row' && <RowLayoutPicker node={selectedNode} readOnly={readOnly || isSelectedLocked} onChange={(children) => updateSelectedField('children', children)} onAddColumn={() => insertBlockAt('column', selectedNode.id)} />}
                  {inspectorTab === 'content' && (selectedNode.kind === 'section' || selectedNode.kind === 'column') && <StructureComposer kind={selectedNode.kind} readOnly={readOnly || isSelectedLocked} onAddLayout={() => insertBlockAt('layout2', selectedNode.id)} />}
                  {inspectorTab === 'design' && selectedNode.kind === 'button' && <ButtonStylePicker node={selectedNode} readOnly={readOnly || isSelectedLocked} onChange={(patch) => { for (const [key, value] of Object.entries(patch)) updateSelectedField(key, value); }} />}
                  {inspectorTab === 'design' && (selectedNode.kind === 'section' || selectedNode.kind === 'column') && <SurfacePicker node={selectedNode} readOnly={readOnly || isSelectedLocked} onChange={(patch) => { for (const [key, value] of Object.entries(patch)) updateSelectedField(key, value); }} />}
                  {inspectorFieldsForNode(selectedNode).filter((field) => field.tab === inspectorTab).map((field) => <label key={field.key} className="modal-field builder-inspector-field">
                    <span>{field.label}</span>
                    {/* ADR-046: above the field it acts on, so the author reads "format this" rather than hunting for what a detached toolbar applies to. */}
                    {field.key === 'content' && (selectedNode.kind === 'text' || selectedNode.kind === 'heading') && <InlineFormatToolbar
                      node={selectedNode}
                      selection={contentSelection && contentSelection.nodeId === selectedNode.id ? contentSelection : null}
                      disabled={readOnly || isSelectedLocked}
                      onToggle={toggleSelectedInlineMark}
                    />}
                    <InspectorFieldInput
                      field={field}
                      value={(selectedNode as unknown as Record<string, FieldValue>)[field.key]}
                      onChange={(value) => updateSelectedField(field.key, value)}
                      onFocusField={field.type === 'text' || field.type === 'textarea' || field.type === 'url' ? rememberFocusedField(selectedNode.id, field.key) : undefined}
                      onSelectionChange={field.key === 'content' ? (event) => setContentSelection({ nodeId: selectedNode.id, start: event.currentTarget.selectionStart ?? 0, end: event.currentTarget.selectionEnd ?? 0 }) : undefined}
                    />
                    {field.key === 'alt' && imageAltMissing(selectedNode) && <small className="builder-field-warning">Thiếu mô tả ảnh (IMAGE_ALT_MISSING).</small>}
                    {/* ADR-051: surfaced at the point of picking the colour, not just at publish -- the ADR-042 lesson this file's own top comment records (a check built only into the publish sheet is a check an author meets too late). Background is the nearest ancestor's, the same chain `content-contrast.ts` walks for the publish-time count. */}
                    {field.key === 'textColor' && doc && nodeLowContrast(selectedNode, selectedNode.background ?? [...ancestorsOf(doc, selectedNode.id)].reverse().find((ancestor) => ancestor.background)?.background ?? theme.contentBg) && <small className="builder-field-warning">Tương phản với nền thấp — khó đọc (dưới chuẩn WCAG AA).</small>}
                    {/* ADR-048 §Consequences makes saying this part of the build: "one line per item" is a convention, and a convention nobody states is a trap -- an author who pastes a paragraph here gets one very long item. */}
                    {field.key === 'content' && selectedNode.kind === 'list' && <small className="field-help">
                      Mỗi <b>dòng</b> là một mục. Dòng trống được bỏ qua. Có thể chèn <code>{'{{ten_bien}}'}</code> trong từng mục.
                    </small>}
                    {/* ADR-044 Task SV-2, `v3-length`: the prototype's preheader budget
                        meter. 110 characters is where most inbox previews stop showing it,
                        so the bar turns amber there rather than at some hard limit -- there
                        is no hard limit, which is exactly why a number alone said nothing. */}
                    {field.key === 'content' && selectedNode.kind === 'preheader' && (() => {
                      const used = (selectedNode.content ?? '').length;
                      return <span className={`v3-length ${used > 110 ? 'warn' : ''}`} role="img" aria-label={`Đã dùng ${used} trên khoảng 110 ký tự hiển thị`}>
                        <i style={{ width: `${Math.min(100, (used / 110) * 100)}%` }} />
                      </span>;
                    })()}
                  </label>)}
                  {/* MC-UI-005 mark_decorative (ADR-043 §8). Sits with the image's own fields rather than in the asset panel: it describes THIS placement, not the file, and the same file can be meaningful in one email and decorative in another. On the Nâng cao tab because it is not a style and not the image's content -- it changes what a screen reader is told. */}
                  {inspectorTab === 'advanced' && (IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(selectedNode.kind) && <label className="modal-field builder-inspector-field" data-mc-action="MC-UI-005.mark_decorative">
                    <span>Ảnh trang trí</span>
                    <input
                      type="checkbox" disabled={readOnly} checked={Boolean(selectedNode.decorative)}
                      onChange={(event) => setSelectedDecorative(event.target.checked)}
                    />
                    <small className="field-help">Đánh dấu khi ảnh không mang thông tin. Trình đọc màn hình sẽ bỏ qua nó (<code>alt=""</code> kèm <code>role="presentation"</code>) thay vì đọc một mô tả thừa. Mô tả đã nhập vẫn được giữ, bỏ đánh dấu là có lại.</small>
                  </label>}
                  {/* Task 18: preheader can hide from the body (ADR-040) but not from Outlook desktop specifically -- mso-hide:all stays stripped, so the block must say so rather than implying it is hidden everywhere. */}
                  {inspectorTab === 'advanced' && selectedNode.kind === 'preheader' && <p className="builder-field-warning">Ẩn được ở hầu hết ứng dụng đọc email, nhưng <b>không ẩn được trong Outlook desktop</b> (mso-hide:all bị loại khỏi HTML đầu ra).</p>}
                  {/* Task 41 (ADR-043 §6). The cost of choosing https: over cid:
                      is that many clients block external images until the reader
                      asks for them. Said here, beside the image, the same way
                      ADR-040's preheader limit is said beside the preheader --
                      the alternative is someone discovering it from a recipient. */}
                  {inspectorTab === 'advanced' && (IMAGE_BEARING_KINDS as readonly Node['kind'][]).includes(selectedNode.kind) && <p className="builder-field-warning">
                    Ảnh tải từ máy chủ, nên <b>Outlook desktop và một số ứng dụng khác chặn sẵn</b> cho tới khi người nhận bấm “hiển thị ảnh”.
                    Đừng đặt thông tin quan trọng chỉ trong ảnh — hãy viết cả bằng chữ.
                  </p>}
                  {inspectorTab === 'content' && selectedNode.kind === 'social' && <SocialLinksEditor links={selectedNode.social ?? []} readOnly={readOnly} onChange={(next) => updateSelectedField('social', next)} />}
                  {inspectorTab === 'content' && selectedNode.kind === 'contact' && <ContactEditor contact={selectedNode.contact ?? { name: '', role: '', email: '', phone: '', address: '' }} readOnly={readOnly} onChange={(next) => updateSelectedField('contact', next)} />}
                  {inspectorTab === 'content' && selectedNode.kind === 'footer' && <FooterEditor footer={selectedNode.footer ?? { companyName: '', address: '' }} readOnly={readOnly} onChange={(next) => updateSelectedField('footer', next)} />}
                  {inspectorTab === 'content' && selectedNode.kind === 'table' && selectedNode.table && <TableEditor table={selectedNode.table} readOnly={readOnly} onChange={(patch) => updateSelectedField('table', { ...selectedNode.table, ...patch })} />}
                  {/* The HTML source is on Nâng cao, where the prototype puts its own code editor: it is neither the block's text nor its appearance. */}
                  {inspectorTab === 'advanced' && selectedNode.kind === 'customHtml' && <CustomHtmlEditor html={selectedNode.html ?? ''} css={selectedNode.css ?? ''} readOnly={readOnly} onChange={(patch) => { if (patch.html !== undefined) updateSelectedField('html', patch.html); if (patch.css !== undefined) updateSelectedField('css', patch.css); }} />}
                  {/* A tab with nothing on it says so rather than showing a blank
                      panel -- the same rule Task 17 set for an unbuilt rail
                      destination. `inspectorTabIsEmpty` is computed above so this
                      condition cannot drift from what actually rendered. */}
                  {inspectorTabIsEmpty && <p className="builder-node-empty">{NODE_LABEL[selectedNode.kind]} không có thiết lập nào ở tab {INSPECTOR_TABS.find((tab) => tab.id === inspectorTab)?.label} — thử tab khác, hoặc chọn khối bên trong.</p>}
                </> : <p className="builder-node-empty">
                  Chọn một thành phần trên canvas để chỉnh thuộc tính của nó.
                  {/* Decision 2: the document-level theme moved out of this panel into the
                      `v3-sheet` the "Chủ đề" rail destination opens. Saying where it went
                      is the difference between a move and a disappearance. */}
                  {' '}Thiết lập chung của cả email nằm ở <b>Chủ đề</b> trên thanh công cụ bên trái.
                </p>}
                {/* Half of a full-width band that used to sit above the workspace and
                    cost 179px of every viewport -- 20% of a 900px screen -- to show two
                    inputs capped at 360px wide. The name went to the focus header, which
                    was already displaying it read-only; the plain-text body has no
                    duplicate anywhere, so it lands here with the other properties.

                    Rendered unconditionally, outside the `selectedNode` branch above:
                    it describes the document, not the selection, so hiding it behind a
                    deselect would make it findable only by accident.

                    Below 1024px `.builder-workspace` is display:none, so this field is
                    unreachable there. That is a real cost and it was taken knowingly --
                    the same breakpoint already replaces the whole editor with
                    `.builder-narrow-notice` telling the author this width cannot author.
                    The NAME stays editable at every width because the header does. */}
                <div className="builder-doc-fields">
                  <h3>Tài liệu</h3>
                  <label className="modal-field builder-title-field">
                    <span>Văn bản thuần (không định dạng)</span>
                    <textarea rows={3} value={draft.textBody} readOnly={readOnly} onChange={(event) => change({ textBody: event.target.value })} />
                  </label>
                </div>
                </div>
                {selectedNode && <div className="builder-inspector-actions v3-inspect-actions">
                  <button type="button" disabled={readOnly || isSelectedLocked} onClick={() => moveSelected('up')} aria-label="Di chuyển lên">↑ Lên</button>
                  <button type="button" disabled={readOnly || isSelectedLocked} onClick={() => moveSelected('down')} aria-label="Di chuyển xuống">↓ Xuống</button>
                  {/* The shortcut exists whether or not this button does; the button is how anyone finds out the shortcut exists. */}
                  <button type="button" disabled={readOnly || isSelectedLocked} onClick={duplicateSelected} title="Nhân đôi khối (Ctrl+D)" aria-label="Nhân đôi khối">⧉ Nhân đôi</button>
                  <button type="button" className="danger-button" disabled={readOnly || isSelectedLocked} onClick={removeSelected} title="Xoá khối (Delete)"><UiIcon name="trash" size={14} /> Xoá</button>
                </div>}
              </aside>
            </div>
            {/* <1024px: kéo-thả không dùng được ở khổ này (conventions spec §2.2). CSS-driven swap, not JS width detection. */}
            <div className="builder-narrow-notice" role="status">
              Không hỗ trợ kéo-thả ở khổ màn hình này. Dùng “Xem trước” để xem nội dung, hoặc mở trên máy tính để chỉnh sửa.
            </div>
          </>}
    </div>
    {/* ADR-044 Task SV-2: the two rail destinations that open the prototype's
        overlay rather than the left panel. Back closes them first (conventions
        spec §2.11 layer 1), which had no caller in the builder until now. */}
    {sheet === 'theme' && <ThemeSheet
      theme={theme}
      readOnly={readOnly}
      expanded={workspacePanelSize === 'expanded'}
      onToggleExpanded={() => setWorkspacePanelSize(otherPanelSize(workspacePanelSize))}
      onPatch={updateThemeField}
      onClose={() => setSheet(null)}
    />}
    {sheet === 'history' && <div
      className="v3-sheet-bg sheet-history"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setSheet(null); }}
    >
      <aside className="v3-sheet" role="dialog" aria-modal="true" aria-label="Lịch sử phiên bản">
        <header>
          <span className="v3-sheet-icon" aria-hidden="true">↶</span>
          {/* The immutability sentence now lives in the ported `v3-immutable`
              banner inside the body (S8, MC-UI-009 history chrome) -- this stays short
              so the sheet does not say the same thing twice. */}
          <div><b>Lịch sử phiên bản</b><small>Xem và khôi phục các phiên bản đã xuất bản.</small></div>
          <button type="button" aria-label="Đóng" onClick={() => setSheet(null)}>×</button>
        </header>
        <div className="v3-sheet-body">
          {/* The same list TemplateEditorScreen shows -- decision 1: reach the
              feature that exists, do not grow a second version history.
              `TemplateVersionHistory` now renders its own sticky
              `v3-sheet-actionbar history-action` (S8, MC-UI-009 chrome) -- a second one
              here would stack two sticky bars in the same scroll container.
              The header's `×` button above is this shell's close affordance
              (it already carries `aria-label="Đóng"`), so nothing is lost by
              not repeating a text "Đóng" button underneath. */}
          <TemplateVersionHistory versions={versions} error={versionsError} busy={busy} readOnly={readOnly} onRestore={setConfirmRestore} />
        </div>
      </aside>
    </div>}
    {/*
      S9 Task 52+53 (MC-UI-010). Ported chrome: `v3-publish-ready` (the
      banner), `v3-resource` (the four-box strip) and `v3-publish-confirm`
      (the button) all come from studio.tsx line 951's `type === "publish"`
      branch. NOT ported: `v3-flow` ("Mailcraft → HTML + metadata → EOW
      Provider API") -- that band draws a second system EOW does not have;
      Task 55 owns the matching gate exclusion, this screen just never emits
      the class.
    */}
    {sheet === 'publish' && <div
      className="v3-sheet-bg sheet-publish"
      onMouseDown={(event) => { if (event.target === event.currentTarget) setSheet(null); }}
    >
      <aside className="v3-sheet" role="dialog" aria-modal="true" aria-label="Xuất bản">
        <header>
          <span className="v3-sheet-icon" aria-hidden="true">↑</span>
          <div><b>Xuất bản phiên bản mới</b><small>Xem lại trước khi tạo một phiên bản bất biến, không thể sửa lại.</small></div>
          <button type="button" aria-label="Đóng" onClick={() => setSheet(null)}>×</button>
        </header>
        <div className="v3-sheet-body">
          {publishFlow === 'publishing' && <div className="v3-publish-ready" data-mc-state="MC-UI-010.publishing" role="status">
            <span aria-hidden="true">↑</span>
            <div>
              <b>Đang xuất bản…</b>
              <p>Đang đóng gói bản nháp hiện tại thành một phiên bản bất biến.</p>
            </div>
          </div>}

          {publishFlow === 'published' && publishedVersion && <>
            <div className="v3-publish-ready" data-mc-state="MC-UI-010.published" role="status">
              <span aria-hidden="true">✓</span>
              <div>
                <b>{`Đã xuất bản phiên bản ${publishedVersion.version}`}</b>
                <p>Phiên bản này đã bất biến. Chọn một chiến dịch để gửi đúng phiên bản vừa xuất bản.</p>
              </div>
            </div>
            <div className="v3-sheet-actionbar">
              <span>Bước tiếp theo</span>
              <button type="button" onClick={() => navigate('/campaigns/new')}>Chọn chiến dịch →</button>
            </div>
          </>}

          {publishFlow === 'failed' && <>
            <div className="v3-publish-ready bad" data-mc-state="MC-UI-010.publish_failed" role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <b>Không thể xuất bản</b>
                <p>{publishFlowError}</p>
              </div>
            </div>
            <div className="v3-sheet-actionbar">
              <span>Bản nháp vẫn nguyên vẹn, chưa có gì bị mất.</span>
              <button type="button" onClick={() => void confirmPublish()}>Thử lại</button>
            </div>
          </>}

          {publishFlow === 'idle' && <>
            {/* `!analysis` is exactly `publishReadiness`'s own `ANALYSIS_PENDING`
                condition -- see `publish-readiness.ts` §3. This is
                `MC-UI-010.publish_validating`: the sheet is open, but the
                round trip the verdict depends on has not come back yet. Two
                literal branches rather than one element with a conditional
                `data-mc-state` value -- the fidelity gate's `attributePresent`
                greps the file for the literal `data-mc-state="..."` text, so
                a computed attribute value would never be found. */}
            {!analysis
              ? <div className="v3-publish-ready bad" data-mc-state="MC-UI-010.publish_validating" role="status">
                  {/* Not "!": nothing is wrong yet, the verdict simply has not
                      arrived. `.bad` is amber here, only to withhold the green
                      tick until the analysis says it is earned. */}
                  <span aria-hidden="true">…</span>
                  <div>
                    <b>Đang phân tích nội dung…</b>
                    <p>Nội dung, biến và metadata sẽ được đóng gói thành một phiên bản bất biến.</p>
                  </div>
                </div>
              : <div className={`v3-publish-ready ${publishSummary.canPublish ? '' : 'bad'}`} role="status">
                  <span aria-hidden="true">{publishSummary.canPublish ? '✓' : '!'}</span>
                  <div>
                    <b>{publishSummary.canPublish ? 'Sẵn sàng xuất bản' : 'Cần xử lý trước khi xuất bản'}</b>
                    <p>Nội dung, biến và metadata sẽ được đóng gói thành một phiên bản bất biến.</p>
                  </div>
                </div>}

            {/* DEVIATION from studio.tsx, settled with the user 2026-09-06:
                `v3-resource` keeps its four-box layout and loses its contents.
                The prototype fills it with "Provider: mailcraft / Resource:
                email_template / Version: v5 / Variables: N" -- the
                Mailcraft-is-a-separate-service-with-a-provider-registry model
                that EOW does not have, the same model Task 55 rejects
                `retry_registration` for. Drawing those four labels would tell
                the reader about an integration that does not exist. The four
                here come from `freezeSummary` and are all checkable against
                the `doc`/`draft`/`analysis` on screen. Do NOT "restore" the
                prototype's labels: there is nothing behind Provider/Resource
                to restore them to. */}
            {freeze ? <div className="v3-resource">
              <div><span>Phiên bản sắp tạo</span><b>{`v${freeze.nextVersion}`}</b></div>
              <div><span>Số biến</span><b>{freeze.variableCount}</b></div>
              <div><span>Kích thước HTML</span><b>{freeze.htmlSizeLabel}</b></div>
              <div><span>Số khối</span><b>{freeze.blockCount}</b></div>
            </div> : <p className="builder-library-hint" role="status">Đang tính toán…</p>}

            {publishSummary.items.length > 0 && <div className="v3-publish-items" role="status" aria-label="Danh sách cần xem trước khi xuất bản">
              {publishSummary.items.map((item) => <div key={item.id}>
                <span className={item.level === 'blocking' ? 'blocking' : undefined} aria-hidden="true">!</span>
                <div>
                  <small className={item.level === 'blocking' ? 'blocking' : undefined}>{item.level === 'blocking' ? 'CẦN SỬA' : 'NÊN XEM'}</small>
                  <p>{item.message}</p>
                </div>
              </div>)}
            </div>}

            <div className="v3-sheet-actionbar">
              {/* `savePending` (not part of `publishReadiness` -- that module
                  only reasons about `draft`/`analysis`, never save status) is
                  the same guard the old direct-publish `publish()` had:
                  publishing while an autosave PATCH is still in flight would
                  let the server freeze a version older than what the author
                  is looking at. */}
              <span>{savePending ? 'Thay đổi đang được lưu tự động. Thử lại sau giây lát.' : publishSummary.canPublish ? 'Phiên bản đã xuất bản không thể sửa lại.' : `${publishSummary.blocking.length} mục cần sửa trước khi xuất bản.`}</span>
              <button
                type="button"
                className="v3-publish-confirm"
                data-mc-action="MC-UI-010.publish"
                disabled={!publishSummary.canPublish || readOnly || savePending}
                onClick={() => void confirmPublish()}
              >Xuất bản</button>
            </div>
          </>}
        </div>
      </aside>
    </div>}
    {confirmRestore && <ModalFrame titleId="builder-restore-version-title" title={`Khôi phục phiên bản ${confirmRestore.version}?`} description="Phiên bản đã xuất bản không thay đổi — chỉ bản nháp được ghi đè." size="small" onClose={() => setConfirmRestore(null)} footer={<>
      <button className="secondary-button" disabled={busy} onClick={() => setConfirmRestore(null)}>Hủy</button>
      <button className="danger-button" data-mc-action="MC-UI-009.create_draft" disabled={busy} onClick={() => void restoreVersion(confirmRestore)}>{busy ? 'Đang khôi phục…' : 'Ghi đè bản nháp'}</button>
    </>}>
      <div className="confirmation-copy">
        <b>{draft.name}</b>
        <p>Nội dung bản nháp hiện tại sẽ bị thay bằng nội dung của phiên bản {confirmRestore.version}. Phần đang sửa dở sẽ mất.</p>
      </div>
    </ModalFrame>}
    {toast && <div className="toast v3-toast" role="status"><span>✓</span>{toast}</div>}
    {confirmLeave && <ModalFrame
      titleId="builder-leave-title"
      title="Bỏ thay đổi chưa lưu?"
      description="Một vài thay đổi vừa nhập chưa kịp lưu tự động."
      size="small"
      onClose={() => setConfirmLeave(false)}
      footer={<>
        <button className="secondary-button" onClick={() => setConfirmLeave(false)}>Ở lại</button>
        <button className="secondary-button" disabled={busy} onClick={() => void saveDraftAndLeave()}>{busy ? 'Đang lưu…' : 'Lưu nháp'}</button>
        <button className="danger-button" onClick={() => { setConfirmLeave(false); leaveToList(); }}>Bỏ thay đổi</button>
      </>}
    >
      <div className="confirmation-copy"><b>{draft.name}</b><p>Bạn có thể lưu bản nháp trước khi rời đi, bỏ thay đổi vừa nhập, hoặc ở lại để tiếp tục chỉnh sửa. Back không bao giờ tự ý xoá nháp.</p></div>
    </ModalFrame>}
  </div>;
}

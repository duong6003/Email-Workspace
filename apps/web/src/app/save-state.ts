export type ShellSaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';
export type SetShellSaveState = (state: ShellSaveState) => void;

/**
 * ADR-041: the compact focus-mode header is rendered by AppShell (it
 * replaces the sidebar/utility-bar/page-header/footer, so only the shell can
 * own its DOM), but its content -- document title, Back, Preview, Publish --
 * belongs to the routed screen. This is that channel, additive and separate
 * from `SetShellSaveState` so existing consumers of the outlet context
 * (TemplateEditorScreen, ComposeDraftScreen) are untouched.
 */
export type FocusHeaderState = {
  title: string;
  /**
   * When `onTitleChange` is present the header renders the document title as an
   * editable field bound to `titleValue` instead of static text. `title` stays
   * the DISPLAY form -- it carries the "Template chưa đặt tên" fallback, which
   * must never be typed into an input as if the author had written it.
   *
   * This exists because the builder's name field used to sit in a full-width
   * band above the workspace that cost 179px of every viewport to show one
   * 360px input, while the header three centimetres above already displayed
   * the same name read-only. One of the two had to go, and the duplicate is
   * the one that was costing screen height.
   */
  titleValue?: string;
  onTitleChange?: (value: string) => void;
  titleReadOnly?: boolean;
  saveStatusText: string;
  previewOpen: boolean;
  onBack: () => void;
  /**
   * The prototype's `v3-brand` is a button that opens the template library;
   * the port had turned it into an `aria-hidden` span, so the product name was
   * unreadable to a screen reader and the destination was gone. Optional
   * because only the builder has a library to open -- the other focus-mode
   * screens leave it a plain label rather than inventing a destination.
   */
  onBrand?: () => void;
  onPreviewToggle: () => void;
  onPublish: () => void;
  publishDisabled: boolean;
  publishBusy: boolean;
  /**
   * ADR-044 Task SV-2: the prototype's `v3-history` undo/redo pair, which sits
   * in the header beside Preview and Publish. The engine has had `undo`/`redo`
   * with tests since S2 (`engine.ts`) and nothing on screen ever called them --
   * this is the port giving the existing capability its control, not a new
   * feature.
   */
  onUndo: () => void;
  onRedo: () => void;
  undoDisabled: boolean;
  redoDisabled: boolean;
} | null;
export type SetFocusHeaderState = (state: FocusHeaderState) => void;

/**
 * Back, per conventions spec §2.11 -- stops at the first layer that applies:
 * 1. close an open modal or expanded tool panel;
 * 2. exit preview;
 * 3. leave the focus editor for the template management screen;
 * (a fourth layer, returning to the EOW route open before the editor, is
 * spec'd but has no caller in this slice -- /templates is the only entry
 * point into focus mode (Task 13), so leaving always targets the list; kept
 * in the return type rather than dropped, so a later entry point does not
 * force a redesign of this function's contract).
 *
 * "Back never silently discards": layer 3 is gated by whether the draft is
 * dirty. A pure function rather than a component method because web has no
 * component-render tests (spec §2.1) -- this is the whole of layer 3's logic,
 * unit-testable on its own.
 */
export type BackNavigationAction = 'close-modal' | 'exit-preview' | 'confirm-dirty' | 'to-list' | 'to-previous-route';

export function backNavigationAction({ modalOpen, previewOpen, dirty }: { modalOpen: boolean; previewOpen: boolean; dirty: boolean }): BackNavigationAction {
  if (modalOpen) return 'close-modal';
  if (previewOpen) return 'exit-preview';
  if (dirty) return 'confirm-dirty';
  return 'to-list';
}

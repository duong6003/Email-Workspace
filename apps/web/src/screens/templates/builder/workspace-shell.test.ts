import { describe, expect, it } from 'vitest';
import { INSPECTOR_PANEL_WIDTH, otherPanelSize, RAIL_DESTINATIONS, RAIL_PANEL_IDS, railDestination, WORKSPACE_PANEL_WIDTH } from './workspace-shell.js';

describe('workspace-shell (S4 Task 17, rail widened by ADR-044 Task SV-2)', () => {
  it('lists all ten rail destinations in the prototype order, none hidden', () => {
    // studio.tsx's own rail, read top to bottom: templates, then the separator,
    // then blocks/reusable/layers, the four sheets, and history alone at the
    // foot. SV decision 1 chose 10 over UI-HANDOFF §2's 4, so this list is the
    // prototype's, not the written spec's.
    expect(RAIL_DESTINATIONS.map((d) => d.id)).toEqual([
      'templates', 'insert', 'reusable', 'structure', 'theme', 'variables', 'assets', 'review', 'history',
    ]);
  });

  it('keeps the four original labels byte-identical -- six e2e specs select rail buttons by text', () => {
    // ADR-044 ports DOM and class names, not wording (SV-3 lesson 3). Renaming
    // these to the prototype's own Vietnamese would break
    // `templates-builder-s4/-s5/-s6` without porting anything.
    const label = (id: string): string | undefined => RAIL_DESTINATIONS.find((d) => d.id === id)?.label;
    expect(label('insert')).toBe('Chèn khối');
    expect(label('structure')).toBe('Cấu trúc');
    expect(label('reusable')).toBe('Khối dùng lại');
    expect(label('assets')).toBe('Thư viện ảnh');
  });

  it('separates the template library from the editing tools, like `v3-rail-separator` does', () => {
    expect(RAIL_DESTINATIONS.filter((d) => d.separatorAfter).map((d) => d.id)).toEqual(['templates']);
  });

  it('puts history alone in the rail foot -- the prototype gives it its own <nav>', () => {
    expect(RAIL_DESTINATIONS.filter((d) => d.group === 'foot').map((d) => d.id)).toEqual(['history']);
  });

  it('says of every destination whether it opens a panel or a sheet, and never anything else', () => {
    // Decision 1: the new destinations must reach what EOW already has rather
    // than grow a second copy. There used to be a third kind, `navigate`, for
    // the one entry that left the builder -- "Nhập HTML". That entry is gone
    // (2026-09-10 spec §3) and the kind went with it, so this now asserts the
    // rail cannot grow another door out.
    const kind = (id: string): string | undefined => RAIL_DESTINATIONS.find((d) => d.id === id)?.kind;
    expect(kind('templates')).toBe('panel');
    expect(kind('variables')).toBe('panel');
    expect(kind('review')).toBe('panel');
    expect(kind('theme')).toBe('sheet');
    expect(kind('history')).toBe('sheet');
    expect(kind('import')).toBeUndefined();
    expect(RAIL_DESTINATIONS.every((d) => ['panel', 'sheet'].includes(d.kind))).toBe(true);
  });

  it('exposes the panel ids as their own union, so the left panel can never be asked to render a sheet', () => {
    expect([...RAIL_PANEL_IDS]).toEqual(['templates', 'insert', 'reusable', 'structure', 'variables', 'assets', 'review']);
  });

  it('reads a destination back by id, and refuses one that is not on the rail', () => {
    expect(railDestination('theme')?.label).toBe('Chủ đề');
    expect(railDestination('nope')).toBeUndefined();
  });

  it('sizes the workspace panel to 320 compact / 480 expanded', () => {
    expect(WORKSPACE_PANEL_WIDTH.compact).toBe(320);
    expect(WORKSPACE_PANEL_WIDTH.expanded).toBe(480);
  });

  it('sizes the inspector to 336 compact / 480 expanded -- a different compact width than the workspace panel', () => {
    expect(INSPECTOR_PANEL_WIDTH.compact).toBe(336);
    expect(INSPECTOR_PANEL_WIDTH.expanded).toBe(480);
  });

  it('toggles panel size', () => {
    expect(otherPanelSize('compact')).toBe('expanded');
    expect(otherPanelSize('expanded')).toBe('compact');
  });
});

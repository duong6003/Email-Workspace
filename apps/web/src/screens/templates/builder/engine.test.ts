import { describe, expect, it } from 'vitest';
import type { Doc } from './document.js';
import { createEmailEditorEngine } from './engine.js';
import { findNode } from './tree-ops.js';

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    title: 'Chào mừng',
    variables: [],
    nodes: [{ id: 'button-1', kind: 'button', content: 'Nút hành động', href: 'https://example.test', accent: '#173f33', textColor: '#fff', visible: true }],
    ...overrides,
  };
}

describe('createEmailEditorEngine (S2 Task 7)', () => {
  it('derives getHtml() from the current model, not a cached string', async () => {
    const engine = createEmailEditorEngine(doc());
    const html = await engine.getHtml();
    expect(html).toContain('Nút hành động');
    expect(html).toContain('background-color:#173f33');
  });

  it('round-trips loadProjectData/getProjectData without losing data', async () => {
    const engine = createEmailEditorEngine(doc());
    const tree = doc({ title: 'Bản nháp khác', nodes: [{ id: 'text-1', kind: 'text', content: 'Nội dung mới', visible: true }] });

    await engine.loadProjectData(tree);
    const roundTripped = await engine.getProjectData();

    expect(roundTripped).toEqual(tree);
  });

  it('reflects loadProjectData in getHtml(), proving getHtml never reads projectData raw -- it re-emits the model', async () => {
    const engine = createEmailEditorEngine(doc());
    await engine.loadProjectData(doc({ nodes: [{ id: 'text-1', kind: 'text', content: 'Nội dung thay thế', visible: true }] }));

    const html = await engine.getHtml();
    expect(html).toContain('Nội dung thay thế');
    expect(html).not.toContain('Nút hành động');
  });

  it('does not mutate the caller-supplied projectData object on load', async () => {
    const engine = createEmailEditorEngine(doc());
    const tree = doc();
    await engine.loadProjectData(tree);
    engine.addBlock('spacer');
    expect(tree.nodes).toHaveLength(1);
  });

  it('starts with nothing to undo or redo', () => {
    const engine = createEmailEditorEngine(doc());
    expect(engine.canUndo()).toBe(false);
    expect(engine.canRedo()).toBe(false);
  });

  it('keeps undo/redo as past/present/future history, matching the ported prototype', async () => {
    const engine = createEmailEditorEngine(doc());
    engine.addBlock('spacer');
    expect(engine.canUndo()).toBe(true);
    expect(engine.canRedo()).toBe(false);

    const beforeUndo = await engine.getProjectData();
    engine.undo();
    expect(engine.canUndo()).toBe(false);
    expect(engine.canRedo()).toBe(true);

    const afterUndo = await engine.getProjectData();
    expect(afterUndo).toEqual(doc());
    expect(afterUndo).not.toEqual(beforeUndo);

    engine.redo();
    expect(engine.canRedo()).toBe(false);
    expect(await engine.getProjectData()).toEqual(beforeUndo);
  });

  it('notifies change subscribers, and stops once unsubscribed', () => {
    const engine = createEmailEditorEngine(doc());
    let calls = 0;
    const unsubscribe = engine.on('change', () => { calls += 1; });

    engine.addBlock('spacer');
    expect(calls).toBe(1);

    unsubscribe();
    engine.addBlock('spacer');
    expect(calls).toBe(1);
  });

  it('accepts device switches without throwing', () => {
    const engine = createEmailEditorEngine(doc());
    expect(() => engine.setDevice('mobile')).not.toThrow();
    expect(() => engine.setDevice('desktop')).not.toThrow();
  });

  it('inserts a block into the targeted node, not just at the document root (S4 Task 16)', async () => {
    const engine = createEmailEditorEngine(doc({ nodes: [{ id: 'section-1', kind: 'section', visible: true, children: [] }] }));
    engine.addBlock('button', 'section-1');
    const projectData = (await engine.getProjectData()) as Doc;
    // Landed inside the section's row/column wrap, not as a second top-level node.
    expect(projectData.nodes).toHaveLength(1);
    const html = await engine.getHtml();
    expect(html).toContain('Nút hành động');
  });

  it('uses the block catalog default node, not a bare placeholder (S4 Task 16)', async () => {
    const engine = createEmailEditorEngine(doc({ nodes: [] }));
    engine.addBlock('text');
    const html = await engine.getHtml();
    // The catalog default (blocks.ts) seeds real copy; the old ad hoc blankNode() left content empty.
    expect(html).toContain('Nhập nội dung của bạn tại đây.');
  });

  it('removeBlock deletes the node and commits it as an undoable step (S4 Task 17)', async () => {
    const engine = createEmailEditorEngine(doc());
    engine.removeBlock('button-1');
    expect((await engine.getProjectData() as Doc).nodes).toHaveLength(0);
    expect(engine.canUndo()).toBe(true);
  });

  it('moveBlock reorders siblings (S4 Task 17)', async () => {
    const engine = createEmailEditorEngine(doc({ nodes: [
      { id: 'a', kind: 'text', visible: true, content: 'A' },
      { id: 'b', kind: 'text', visible: true, content: 'B' },
    ] }));
    engine.moveBlock('b', 'up');
    const projectData = (await engine.getProjectData()) as Doc;
    expect(projectData.nodes.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('updateNode merges a field patch into one node (S4 Task 18)', async () => {
    const engine = createEmailEditorEngine(doc());
    engine.updateNode('button-1', { content: 'Đăng ký ngay' });
    const html = await engine.getHtml();
    expect(html).toContain('Đăng ký ngay');
  });

  it('updateTheme merges into the document theme (S4 Task 18)', async () => {
    const engine = createEmailEditorEngine(doc());
    engine.updateTheme({ contentBg: '#f0f0f0' });
    const html = await engine.getHtml();
    expect(html).toContain('background-color:#f0f0f0');
  });

  /**
   * S6 Task 39. These are the only route the UI has to `bind` and
   * `mark_decorative` -- ADR-043 §7 keeps them off the AssetProvider port, and
   * spec §2.13 keeps components out of the model, so the engine is the seam.
   */
  it('bindAsset points an image at an asset URL and the emitted HTML carries it', async () => {
    const engine = createEmailEditorEngine(doc({ nodes: [{ id: 'img-1', kind: 'image', visible: true }] }));
    engine.bindAsset('img-1', 'https://app.example.test/api/v1/assets/a1/logo.png');
    expect(await engine.getHtml()).toContain('src="https://app.example.test/api/v1/assets/a1/logo.png"');
  });

  it('bindAsset reports the refusal and pushes no undo step, so the caller can say why nothing happened', async () => {
    const engine = createEmailEditorEngine(doc({ nodes: [{ id: 'img-1', kind: 'image', visible: true }] }));
    expect(engine.bindAsset('img-1', 'http://cdn.test/logo.png')).toBe(false);
    expect(engine.canUndo()).toBe(false);
    expect(engine.bindAsset('img-1', 'https://app.example.test/api/v1/assets/a1/logo.png')).toBe(true);
  });

  it('markDecorative reaches the emitter as alt="" plus role="presentation"', async () => {
    const engine = createEmailEditorEngine(doc({ nodes: [{ id: 'img-1', kind: 'image', visible: true, src: 'https://cdn.test/a.png', alt: 'Ảnh' }] }));
    engine.markDecorative('img-1', true);
    const html = await engine.getHtml();
    expect(html).toContain('alt=""');
    expect(html).toContain('role="presentation"');
  });

  it('markDecorative is undoable, like every other document edit', async () => {
    const engine = createEmailEditorEngine(doc({ nodes: [{ id: 'img-1', kind: 'image', visible: true, src: 'https://cdn.test/a.png', alt: 'Ảnh' }] }));
    engine.markDecorative('img-1', true);
    engine.undo();
    expect(await engine.getHtml()).toContain('alt="Ảnh"');
  });
});

/**
 * ADR-044 Task SV-2, decision 1. "Kho mẫu" starts a draft from an existing
 * template. `loadProjectData` cannot be that path: it resets history, so the
 * work someone had on the canvas would be gone with no way back -- on a button
 * whose whole promise is "try this template".
 */
describe('replaceDocument (ADR-044 Task SV-2)', () => {
  it('replaces the whole document and leaves it undoable', async () => {
    const engine = createEmailEditorEngine(doc());
    const before = await engine.getProjectData();
    engine.replaceDocument({ title: 'Từ mẫu', nodes: [], variables: [] });

    expect((await engine.getProjectData() as { title: string }).title).toBe('Từ mẫu');
    expect(engine.canUndo()).toBe(true);

    engine.undo();
    expect(await engine.getProjectData()).toEqual(before);
  });

  it('clones what it is given, so editing the new document cannot reach back into the caller', async () => {
    const engine = createEmailEditorEngine(doc());
    const incoming = { title: 'Từ mẫu', nodes: [], variables: [] };
    engine.replaceDocument(incoming);
    engine.updateTheme({ width: 720 });
    expect(incoming).toEqual({ title: 'Từ mẫu', nodes: [], variables: [] });
  });

  it('still notifies listeners, so the canvas and autosave both see the swap', async () => {
    const engine = createEmailEditorEngine(doc());
    let seen = 0;
    engine.on('change', () => { seen += 1; });
    engine.replaceDocument({ title: 'Từ mẫu', nodes: [], variables: [] });
    expect(seen).toBe(1);
  });
});

describe('addBlock/insertSubtree carry the drop position', () => {
  const column = (): Doc => ({
    title: 'Chào mừng', variables: [],
    nodes: [{
      id: 'section-1', kind: 'section', visible: true,
      children: [{
        id: 'row-1', kind: 'row', visible: true,
        children: [{
          id: 'col-1', kind: 'column', visible: true,
          children: [
            { id: 'a', kind: 'text', content: 'A', visible: true },
            { id: 'b', kind: 'text', content: 'B', visible: true },
          ],
        }],
      }],
    }],
  });
  const contents = async (engine: ReturnType<typeof createEmailEditorEngine>): Promise<string[]> => {
    const next = (await engine.getProjectData()) as Doc;
    return (next.nodes[0]!.children![0]!.children![0]!.children ?? []).map((n) => (n.content as string) ?? n.kind);
  };

  it('drops a catalog block before the block the cursor was over', async () => {
    const engine = createEmailEditorEngine(column());
    engine.addBlock('heading', 'b', 'before');
    expect(await contents(engine)).toEqual(['A', 'Tiêu đề phần mới', 'B']);
  });

  it('drops a catalog block after it', async () => {
    const engine = createEmailEditorEngine(column());
    engine.addBlock('heading', 'a', 'after');
    expect(await contents(engine)).toEqual(['A', 'Tiêu đề phần mới', 'B']);
  });

  it('still appends when no position is given, which is what click-to-insert wants', async () => {
    const engine = createEmailEditorEngine(column());
    engine.addBlock('heading', 'a');
    expect(await contents(engine)).toEqual(['A', 'B', 'Tiêu đề phần mới']);
  });

  it('places a saved library block by position too, with fresh ids intact', async () => {
    const engine = createEmailEditorEngine(column());
    engine.insertSubtree({ id: 'saved', kind: 'text', content: 'Đã lưu', visible: true }, 'a', 'before');
    expect(await contents(engine)).toEqual(['Đã lưu', 'A', 'B']);
    const next = (await engine.getProjectData()) as Doc;
    const inserted = next.nodes[0]!.children![0]!.children![0]!.children![0]!;
    expect(inserted.id).not.toBe('saved');
  });
});

describe('moveBlockTo -- reordering by drag, as one undoable step', () => {
  const column = (): Doc => ({
    title: 'Chào mừng', variables: [],
    nodes: [{
      id: 'section-1', kind: 'section', visible: true,
      children: [{
        id: 'row-1', kind: 'row', visible: true,
        children: [{
          id: 'col-1', kind: 'column', visible: true,
          children: [
            { id: 'a', kind: 'text', content: 'A', visible: true },
            { id: 'b', kind: 'text', content: 'B', visible: true },
            { id: 'c', kind: 'text', content: 'C', visible: true },
          ],
        }],
      }],
    }],
  });
  const order = async (engine: ReturnType<typeof createEmailEditorEngine>): Promise<string[]> => {
    const next = (await engine.getProjectData()) as Doc;
    return (next.nodes[0]!.children![0]!.children![0]!.children ?? []).map((n) => n.id);
  };

  it('moves a block to the position the drop asked for', async () => {
    const engine = createEmailEditorEngine(column());
    engine.moveBlockTo('c', 'a', 'before');
    expect(await order(engine)).toEqual(['c', 'a', 'b']);
  });

  it('is undoable, because a mis-drop is the most likely thing to want back', async () => {
    const engine = createEmailEditorEngine(column());
    engine.moveBlockTo('c', 'a', 'before');
    engine.undo();
    expect(await order(engine)).toEqual(['a', 'b', 'c']);
  });

  it('a refused move leaves no history entry to undo past', async () => {
    const engine = createEmailEditorEngine(column());
    engine.moveBlockTo('a', 'a', 'before');
    expect(engine.canUndo()).toBe(false);
    expect(await order(engine)).toEqual(['a', 'b', 'c']);
  });
});

describe('addBlock/insertSubtree hand back what they inserted', () => {
  /**
   * A3: the prototype's `finishAdd` selects the new node, opens the content
   * tab, and for image kinds opens the asset picker on it (`studio.tsx:510`).
   * None of that is possible without the id, and the port returned void -- so
   * an insert left nothing selected and the inspector empty.
   */
  const empty = (): Doc => ({ title: 't', variables: [], nodes: [] });

  it('returns the id of the block it created', async () => {
    const engine = createEmailEditorEngine(empty());
    const id = engine.addBlock('heading');
    expect(typeof id).toBe('string');
    const next = (await engine.getProjectData()) as Doc;
    expect(findNode(next, id!)).toBeDefined();
  });

  it('returns the id of the node itself, not of the wrappers built around it', async () => {
    const engine = createEmailEditorEngine(empty());
    const id = engine.addBlock('text');
    const next = (await engine.getProjectData()) as Doc;
    expect(findNode(next, id!)!.kind).toBe('text');
  });

  it('returns the FRESH id of an inserted library block, not the saved one', async () => {
    const engine = createEmailEditorEngine(empty());
    const id = engine.insertSubtree({ id: 'saved-original', kind: 'text', content: 'Đã lưu', visible: true });
    expect(id).not.toBe('saved-original');
    const next = (await engine.getProjectData()) as Doc;
    expect(findNode(next, id!)!.content).toBe('Đã lưu');
  });
});

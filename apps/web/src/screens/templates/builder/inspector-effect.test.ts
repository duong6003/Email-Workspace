import { describe, expect, it } from 'vitest';
import { BLOCK_CATALOG } from './blocks.js';
import { KINDS, type Node } from './document.js';
import { emitNode } from './emitter.js';
import { inspectorFieldsForNode, type InspectorField } from './inspector-fields.js';

/**
 * Every Inspector control has to change the email.
 *
 * `inspector-fields.test.ts` checks that the right KEYS are offered for each
 * kind. It cannot see the failure this file is for: a control that is offered,
 * accepts a value, stores it on the node -- and never reaches the emitted HTML,
 * because `emitter.ts` reads a different key, or reads none. From the author's
 * side that is indistinguishable from a setting that does not work, and they
 * were right to call it that.
 *
 * The check is mechanical rather than a list someone maintains: build the block
 * the catalog builds, emit it, change one field, emit again, and require the
 * two to differ. A field that leaves the HTML byte-for-byte identical is either
 * dead or reading the wrong key.
 *
 * Fields the emitter is not supposed to carry are named in `NOT_EMITTED` with
 * the reason -- and the gate fails if one of those starts mattering, the same
 * way `mailcraft-canvas-fidelity` treats its own exclusions. An exemption that
 * has stopped exempting anything is worse than none.
 */

/**
 * Every value worth trying for `field`, not one.
 *
 * A single probe value produced two false accusations on the first run. "Độ
 * đậm" on a text block offers 400 and 700; the block stores neither, and
 * `emitText` defaults text to 400 -- so probing with 400 emitted byte-identical
 * HTML and the control read as dead when it is not. Trying every option the
 * control actually offers is both more honest and closer to what the author
 * does.
 */
function probeValues(field: InspectorField, current: unknown): unknown[] {
  switch (field.type) {
    case 'color':
      return ['#ff00aa', '#00aaff'];
    case 'number':
      return [typeof current === 'number' ? current + 17 : 17, 0, 42];
    case 'url':
      return ['https://probe.example.test/one', 'https://probe.example.test/two'];
    case 'checkbox':
      return [true, false];
    case 'align':
      return ['left', 'center', 'right'];
    case 'select':
      return (field.options ?? []).map((option) => (field.numeric ? Number(option.value) : option.value));
    default:
      return ['Giá trị dò tìm', 'Giá trị dò tìm khác'];
  }
}

/**
 * Every state of a block worth probing, not one.
 *
 * A single sample produces false positives in both directions. `borderColor` on
 * a Section changes nothing unless a `borderWidth` is set -- `borderCss` emits
 * the token `0` otherwise, and rightly so. A Logo with a `src` is an `<img>`
 * and ignores its wordmark text and colour; without one it is the wordmark and
 * ignores `src`. A field is alive if it changes the HTML in ANY state the block
 * can actually be in, which is also the question the author is asking.
 */
function sampleNodes(kind: Node['kind']): Node[] {
  const filled = sampleNode(kind);
  if (kind === 'section' || kind === 'column') return [filled, { ...filled, borderWidth: 2, borderColor: '#123456' }];
  if (kind === 'logo') return [filled, { ...filled, src: '', content: 'ACME' }];
  if (kind === 'image' || kind === 'banner') return [filled, { ...filled, href: 'https://example.test/go' }];
  // `emitButton` renders an `<a>` only when there is a destination, and a
  // `<span>` otherwise -- so `linkTitle` has nothing to attach to on a button
  // with no URL. The catalog builds one with `href: ''`, which made a live
  // control read as dead the moment it was offered. The button's ordinary state
  // is "is a link"; this is that state.
  if (kind === 'button') return [filled, { ...filled, href: 'https://example.test/go' }];
  return [filled];
}

/**
 * A block filled in enough that the emitter renders it at all. An empty image
 * emits nothing, so every field on it would read as dead for the wrong reason.
 */
function sampleNode(kind: Node['kind']): Node {
  const entry = BLOCK_CATALOG.find((candidate) => candidate.kind === kind);
  const base: Node = entry ? entry.createNode() : { id: 'probe', kind, visible: true };
  if (kind === 'image' || kind === 'banner' || kind === 'logo') return { ...base, src: 'https://cdn.example.test/a.png', alt: 'Ảnh mẫu' };
  if (kind === 'contact') return { ...base, contact: { name: 'Phòng Nhân sự', role: 'Acme', email: 'hr@acme.vn', phone: '02839990000', address: 'Số 1 Lê Lợi' } };
  // ADR-050: the catalog seeds `footer` with both fields empty on purpose (no
  // invented address ships to a real recipient), so a freshly built block emits
  // nothing and every field on it would read as dead for the wrong reason --
  // the same fix `contact` above already needed.
  if (kind === 'footer') return { ...base, footer: { companyName: 'Acme', address: 'Số 1 Lê Lợi' } };
  if (kind === 'customHtml') return { ...base, html: '<p>xin chào</p>' };
  if (kind === 'preheader' || kind === 'text' || kind === 'heading') return { ...base, content: base.content || 'Nội dung mẫu' };
  // `emitSocial` drops every link without a real URL, so a freshly built social
  // block emits an empty paragraph and its colour has nothing to colour.
  if (kind === 'social') return { ...base, social: (base.social ?? []).map((link, index) => ({ ...link, url: `https://example.test/${index}` })) };
  if (kind === 'section' || kind === 'row' || kind === 'column') {
    const leaf: Node = { id: 'probe-leaf', kind: 'text', visible: true, content: 'Nội dung mẫu' };
    if (kind === 'column') return { ...base, children: [leaf] };
    if (kind === 'row') return { ...base, children: [{ id: 'probe-col', kind: 'column', visible: true, width: 100, children: [leaf] }] };
    return { ...base, children: [{ id: 'probe-row', kind: 'row', visible: true, children: [{ id: 'probe-col', kind: 'column', visible: true, width: 100, children: [leaf] }] }] };
  }
  return base;
}

/**
 * Controls the emitted HTML is not expected to carry, each with why.
 *
 * Nothing here is "it does not work yet". Either the value is spent before the
 * emitter sees it, or the emitter has a deliberate rule that overrides it.
 */
const NOT_EMITTED: Record<string, string> = {};

describe('every Inspector control reaches the emitted HTML', () => {
  const kinds = KINDS.filter((kind) => inspectorFieldsForNode({ id: 'probe', kind, visible: true }).length > 0);

  it('has something to check for most kinds, so a green result is not an empty loop', () => {
    expect(kinds.length).toBeGreaterThan(8);
  });

  const dead: string[] = [];
  const stale: string[] = [];

  for (const kind of kinds) {
    const fields = inspectorFieldsForNode({ id: 'probe', kind, visible: true });
    for (const field of fields) {
      const id = `${kind}.${field.key}`;
      const changed = sampleNodes(kind).some((before) => probeValues(field, (before as Record<string, unknown>)[field.key])
        .some((value) => emitNode({ ...before, [field.key]: value } as Node) !== emitNode(before)));
      if (!changed && NOT_EMITTED[id] === undefined) dead.push(`${id} (${field.label}, tab ${field.tab})`);
      if (changed && NOT_EMITTED[id] !== undefined) stale.push(id);
    }
  }

  it('changes the HTML for every field it offers', () => {
    expect(dead, 'these controls store a value the emitted email never uses').toEqual([]);
  });

  it('keeps NOT_EMITTED honest', () => {
    expect(stale, 'these are listed as not emitted, but changing them does change the HTML -- delete the entry').toEqual([]);
  });
});

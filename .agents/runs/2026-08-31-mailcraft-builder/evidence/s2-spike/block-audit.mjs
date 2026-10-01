import { sanitizeTemplateHtml } from './dist/templates/template-html-sanitizer.js';

// Each fragment is copied from the prototype's own emitter (studio.tsx
// exportNode / htmlNode), with its template holes filled with realistic values.
const blocks = [
  ['section (gradient)', '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#fff" style="background-color:#fff;background-image:linear-gradient(#fff,#eee);border:0px solid transparent;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.05)"><tr><td>x</td></tr></table>',
    ['background-color', 'background-image', 'border', 'border-radius', 'box-shadow']],

  ['column', '<td class="mc-column" width="100%" valign="top" bgcolor="#fff" style="width:100%;padding:34px 24px;background-color:#fff;border:0px solid transparent;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.05)">x</td>',
    ['padding', 'background-color', 'border', 'border-radius', 'box-shadow']],

  ['heading', '<h1 style="margin:0 0 18px;color:#193c31;text-align:left;font-family:Georgia,serif;font-size:38px;line-height:1.12;font-weight:700;font-style:normal;letter-spacing:0px;text-transform:none">x</h1>',
    ['margin', 'color', 'font-size', 'letter-spacing', 'text-transform']],

  ['button', '<table role="presentation" width="auto" align="left"><tr><td style="padding:24px 0"><a href="https://e.test" style="display:block;padding:12px 20px;border:0;border-radius:8px;background:#173f33;color:#fff;text-align:center;text-decoration:none">x</a></td></tr></table>',
    ['display', 'padding', 'border-radius', 'background', 'color', 'text-decoration']],

  ['image', '<img src="https://e.test/a.png" alt="a" width="100%" style="display:block;width:100%;max-width:100%;height:auto;border-radius:8px">',
    ['display', 'max-width', 'height', 'border-radius']],

  ['table cell', '<td style="padding:8px;border:1px solid #ddd;background:#eef;color:#30463d;text-align:left">x</td>',
    ['padding', 'border', 'background', 'color']],

  ['divider', '<hr style="border:0;border-top:2px solid #173f33;margin:24px 0">',
    ['border', 'border-top', 'margin']],

  ['spacer', '<div style="height:24px">&nbsp;</div>', ['height']],

  ['preheader', '<div style="display:none!important;max-height:0;overflow:hidden;opacity:0;color:transparent">hidden text</div>',
    ['display', 'max-height', 'overflow', 'opacity', 'color']],

  ['logo (text)', '<p style="text-align:left;margin:0px 0"><span style="font:700 36px Georgia;color:#173f33">ALTA</span></p>',
    ['font', 'color', 'text-align']],

  ['social link', '<p style="text-align:center"><a href="https://x.test" aria-label="Facebook" title="Facebook" style="margin:0 6px;color:#173f33">fb</a></p>',
    ['aria-label', 'title', 'margin', 'color']],
];

console.log('BLOCK                 PROPERTY/ATTR      RESULT');
console.log('-'.repeat(62));
let lost = 0;
for (const [name, html, props] of blocks) {
  const out = sanitizeTemplateHtml(html).html;
  for (const p of props) {
    const kept = out.includes(p);
    if (!kept) lost++;
    console.log(`${name.padEnd(21)} ${p.padEnd(18)} ${kept ? 'kept' : 'LOST'}`);
  }
  console.log(`${''.padEnd(21)} -> ${out.slice(0, 150)}`);
  console.log('-'.repeat(62));
}
console.log(`\nTotal properties/attributes lost: ${lost}`);

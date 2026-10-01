import { sanitizeTemplateHtml } from './dist/templates/template-html-sanitizer.js';

const cases = [
  ['padding single', 'padding:24px'],
  ['padding two', 'padding:12px 20px'],
  ['padding four', 'padding:42px 42px 42px 42px'],
  ['margin single', 'margin:0'],
  ['margin two', 'margin:8px 0'],
  ['margin four', 'margin:0 0 18px 0'],
  ['border single-ish', 'border:0'],
  ['border shorthand', 'border:1px solid #ccc'],
  ['border 0px solid transparent', 'border:0px solid transparent'],
  ['border-radius single', 'border-radius:8px'],
  ['border-radius four', 'border-radius:8px 8px 0 0'],
  ['background shorthand color', 'background:#fff'],
  ['background-color', 'background-color:#fff'],
  ['font-family stack', 'font-family:Arial, Helvetica, sans-serif'],
  ['line-height unitless', 'line-height:1.65'],
  ['width percent', 'width:100%'],
  ['display block', 'display:block'],
];

console.log('prop-value                              kept?');
console.log('-'.repeat(56));
for (const [label, decl] of cases) {
  const html = `<td style="${decl}">x</td>`;
  const out = sanitizeTemplateHtml(html).html;
  const prop = decl.split(':')[0];
  const kept = new RegExp(prop.replace('-', '\\-') + '\\s*:').test(out);
  console.log(`${(label + ' — ' + decl).padEnd(46).slice(0, 46)} ${kept ? 'KEPT' : 'DROPPED'}`);
}

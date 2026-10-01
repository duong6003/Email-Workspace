import { parseTemplateVariableTokens, type TemplateVariableInput, type TemplateVariableSchema, type TemplateVariableToken } from './template-variables.js';
import { formatVariableValue, type VariableFormatting } from './variable-value-format.js';

export type { VariableFormatting } from './variable-value-format.js';

export type TemplateVariableRenderResult = TemplateVariableInput | {
  code: 'MISSING_REQUIRED_VARIABLE';
  missingKeys: string[];
};

export type PreviewTemplateVariableRenderResult = TemplateVariableInput & {
  missingKeys: string[];
};

/**
 * ADR-036: presentation is resolved here, so preview
 * (POST /template-versions/:id/preview) and the real send (the campaign
 * snapshot freeze) cannot diverge -- both reach the recipient's value through
 * this one function. `formatting` is optional; without it the renderer behaves
 * exactly as it did before typed variables existed.
 */
export type TemplateVariableRenderOptions = {
  mode?: 'preview';
  formatting?: VariableFormatting;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function renderField(value: string, tokens: TemplateVariableToken[], values: Readonly<Record<string, unknown>>, isHtml: boolean, formatting: VariableFormatting | undefined): string {
  let rendered = value;
  for (const token of [...tokens].reverse()) {
    const replacement = formatVariableValue(values[token.key], formatting?.definitions[token.key], formatting?.tenantTimezone ?? null);
    rendered = `${rendered.slice(0, token.start)}${isHtml ? escapeHtml(replacement) : replacement}${rendered.slice(token.end)}`;
  }
  return rendered;
}

export function renderTemplateVariables(
  template: TemplateVariableInput,
  schema: TemplateVariableSchema,
  context: Readonly<Record<string, unknown>>,
  options: TemplateVariableRenderOptions & { mode: 'preview' },
): PreviewTemplateVariableRenderResult;
export function renderTemplateVariables(
  template: TemplateVariableInput,
  schema: TemplateVariableSchema,
  context: Readonly<Record<string, unknown>>,
  options?: TemplateVariableRenderOptions,
): TemplateVariableRenderResult | PreviewTemplateVariableRenderResult;
export function renderTemplateVariables(
  template: TemplateVariableInput,
  schema: TemplateVariableSchema,
  context: Readonly<Record<string, unknown>>,
  options?: TemplateVariableRenderOptions,
): TemplateVariableRenderResult | PreviewTemplateVariableRenderResult {
  const tokens = parseTemplateVariableTokens(template);
  const missingKeys = schema.required.filter((key) => context[key] === null || context[key] === undefined).sort();
  if (missingKeys.length > 0 && options?.mode !== 'preview') return { code: 'MISSING_REQUIRED_VARIABLE', missingKeys };

  const values: Record<string, unknown> = { ...schema.defaults, ...context };
  const formatting = options?.formatting;
  const rendered = {
    subject: renderField(template.subject, tokens.filter((token) => token.field === 'subject'), values, false, formatting),
    html: renderField(template.html, tokens.filter((token) => token.field === 'html'), values, true, formatting),
    textBody: renderField(template.textBody, tokens.filter((token) => token.field === 'textBody'), values, false, formatting),
  };
  return options?.mode === 'preview' ? { ...rendered, missingKeys } : rendered;
}

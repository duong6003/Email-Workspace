import { renderTemplateVariables } from '../templates/template-variable-renderer.js';
import type { TemplateVariableInput, TemplateVariableSchema } from '../templates/template-variables.js';

export type VariableValidationCandidate = { recipientId: string; email: string; context: Record<string, unknown> };
export type MissingVariableBreakdown = { key: string; label: string; count: number };
export type VariableValidationSample = { recipientId: string; email: string; missingKeys: string[] };
export type VariableValidationResult = {
  totalActionable: number;
  completeCount: number;
  missingCount: number;
  missingByVariable: MissingVariableBreakdown[];
  sample: VariableValidationSample[];
  /**
   * Every affected recipient id, unbounded -- unlike `sample`, this never
   * crosses the public HTTP boundary as-is (see M4-S2's own plan §5 on
   * unbounded response risk). It exists so accept-waiver (BR-CMP-005) can
   * record exactly which recipients a server-computed decision covers,
   * without ever asking the client to submit or round-trip the list itself.
   */
  missingRecipientIds: string[];
};

/**
 * Calls the exact renderer M3-S3's preview/test-send paths already use, in
 * its non-preview (strict) mode -- so "missing" here means precisely what
 * would block a real send, and an optional variable with no default (which
 * the renderer happily fills with '') is never reported as missing
 * (BR-CMP-006). One renderTemplateVariables() call per candidate, not a
 * duplicated missing-key check.
 */
export function validateVariables(
  candidates: readonly VariableValidationCandidate[],
  template: TemplateVariableInput,
  schema: TemplateVariableSchema,
  variableLabels: Readonly<Record<string, string>>,
  options: { sampleLimit: number },
): VariableValidationResult {
  const missingCounts = new Map<string, number>();
  const sample: VariableValidationSample[] = [];
  const missingRecipientIds: string[] = [];
  let completeCount = 0;
  let missingCount = 0;

  for (const candidate of candidates) {
    const rendered = renderTemplateVariables(template, schema, candidate.context);
    if (!('code' in rendered)) {
      completeCount += 1;
      continue;
    }
    missingCount += 1;
    missingRecipientIds.push(candidate.recipientId);
    for (const key of rendered.missingKeys) missingCounts.set(key, (missingCounts.get(key) ?? 0) + 1);
    if (sample.length < options.sampleLimit) {
      sample.push({ recipientId: candidate.recipientId, email: candidate.email, missingKeys: rendered.missingKeys });
    }
  }

  const missingByVariable = [...missingCounts.entries()]
    .map(([key, count]): MissingVariableBreakdown => ({ key, label: variableLabels[key] ?? key, count }))
    .sort((a, b) => b.count - a.count);

  return { totalActionable: candidates.length, completeCount, missingCount, missingByVariable, sample, missingRecipientIds };
}

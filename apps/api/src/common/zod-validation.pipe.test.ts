import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mapErrorToProblem } from './problem.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  it('emits structured field errors for the standard problem contract', () => {
    const pipe = new ZodValidationPipe(z.object({ email: z.string().email(), count: z.number().int().min(1) }));

    let thrown: unknown;
    try { pipe.transform({ email: 'bad', count: 0 }); } catch (error) { thrown = error; }

    expect(mapErrorToProblem(thrown, 'trace-zod')).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [
        { field: 'email', code: 'INVALID_FORMAT' },
        { field: 'count', code: 'TOO_SMALL' },
      ],
    });
  });
});

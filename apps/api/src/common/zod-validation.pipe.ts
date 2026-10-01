import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates a request body against a zod schema, returning the parsed (typed) value. */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const message = result.error.issues.map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`);
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message,
        fieldErrors: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(body)',
          code: issue.code.toUpperCase(),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}

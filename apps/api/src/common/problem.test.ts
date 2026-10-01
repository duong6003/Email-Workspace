import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { mapErrorToProblem } from './problem.js';

describe('mapErrorToProblem', () => {
  it('maps a NotFoundException to a 404 problem with its message as detail', () => {
    const problem = mapErrorToProblem(new NotFoundException('Recipient not found'), 'trace-1');

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Recipient not found',
      code: 'RESOURCE_NOT_FOUND',
      category: 'not_found',
      messageKey: 'error.resourceNotFound',
      retryable: false,
      traceId: 'trace-1',
    });
  });

  it('joins an array validation message from BadRequestException', () => {
    const problem = mapErrorToProblem(
      new BadRequestException({ message: ['email must be an email', 'email should not be empty'] }),
      'trace-2',
    );

    expect(problem.status).toBe(400);
    expect(problem.detail).toBe('email must be an email; email should not be empty');
    expect(problem).toMatchObject({
      code: 'VALIDATION_FAILED',
      category: 'validation',
      messageKey: 'error.validationFailed',
      retryable: false,
      fieldErrors: [
        { field: 'email', code: 'INVALID_VALUE', message: 'must be an email' },
        { field: 'email', code: 'INVALID_VALUE', message: 'should not be empty' },
      ],
    });
  });

  // M2-S3 / BR-CF-003: a structured exception body beyond `message` (e.g.
  // reservedKeys) must reach the real HTTP Problem response, not be
  // silently dropped -- the rule's literal acceptance text requires the
  // 422 body to list the valid/reserved keys.
  it('propagates extra structured fields (e.g. reservedKeys) from the exception body onto the Problem response', () => {
    const problem = mapErrorToProblem(
      new UnprocessableEntityException({ code: 'CUSTOM_FIELD_RESERVED_KEY', message: '"email" is reserved.', reservedKeys: ['email', 'first_name', 'last_name', 'unsubscribe_url'] }),
      'trace-4',
    );

    expect(problem.status).toBe(422);
    expect(problem.detail).toBe('"email" is reserved.');
    expect(problem).toMatchObject({
      code: 'CUSTOM_FIELD_RESERVED_KEY',
      category: 'validation',
      messageKey: 'error.customFieldReservedKey',
      retryable: false,
    });
    expect(problem.reservedKeys).toEqual(['email', 'first_name', 'last_name', 'unsubscribe_url']);
  });

  it('does not duplicate message/statusCode/error as extension fields', () => {
    const problem = mapErrorToProblem(new BadRequestException('bad input'), 'trace-5');
    expect(problem).not.toHaveProperty('message');
    expect(problem).not.toHaveProperty('statusCode');
    expect(problem).not.toHaveProperty('error');
  });

  it('maps an unknown error to a 500 problem without leaking its message', () => {
    const problem = mapErrorToProblem(new Error('database password is hunter2'), 'trace-3');

    expect(problem.status).toBe(500);
    expect(problem.title).toBe('Internal Server Error');
    expect(problem.detail).not.toContain('hunter2');
    expect(problem.traceId).toBe('trace-3');
    expect(problem).toMatchObject({ code: 'INTERNAL_ERROR', category: 'server', messageKey: 'error.internal', retryable: true });
  });

  it('preserves explicit domain guidance while deriving trusted category metadata', () => {
    const problem = mapErrorToProblem(new UnprocessableEntityException({
      code: 'TEMPLATE_UNKNOWN_VARIABLE',
      message: 'Template contains an unknown variable.',
      category: 'unsafe-client-value',
      messageKey: 'template.unknownVariable',
      retryable: false,
      nextAction: 'OPEN_CUSTOM_FIELDS',
      fieldErrors: [{ field: 'html', code: 'UNKNOWN_VARIABLE', value: 'customer_tier' }],
    }), 'trace-6');

    expect(problem).toMatchObject({
      code: 'TEMPLATE_UNKNOWN_VARIABLE',
      category: 'validation',
      messageKey: 'template.unknownVariable',
      retryable: false,
      nextAction: 'OPEN_CUSTOM_FIELDS',
      fieldErrors: [{ field: 'html', code: 'UNKNOWN_VARIABLE', value: 'customer_tier' }],
      traceId: 'trace-6',
    });
  });
});

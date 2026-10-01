import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 with a Retry-After the exception filter turns into a response header (BR-AUTH-005). */
export class TooManyRequestsException extends HttpException {
  constructor(response: string | Record<string, unknown>, public readonly retryAfterSeconds: number) {
    super(response, HttpStatus.TOO_MANY_REQUESTS);
  }
}

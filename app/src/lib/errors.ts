/** Every error the API returns has this shape: `{"error": {"code", "message", "retryAfter"?}}`. */

export type ErrorCode =
  | 'invalid-request'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'over-budget'
  | 'throttled'
  | 'unavailable'
  | 'internal';

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 429 | 500 | 503,
    readonly code: ErrorCode,
    message: string,
    /** Seconds until a retry can succeed; sent as `Retry-After` too. */
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }

  body() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.retryAfter === undefined ? {} : { retryAfter: this.retryAfter }),
      },
    };
  }
}

export const invalidRequest = (message: string) => new ApiError(400, 'invalid-request', message);

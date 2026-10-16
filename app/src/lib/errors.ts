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

/**
 * An unexpected error, for the logs only: its name and the start of its message, so an operator can see which call
 * failed and why (an AWS error names the action and the resource it refused). Any text given in `remove`, such as
 * the question, is cut out, so a message that echoes it never reaches the logs. Clients never see this.
 */
export const errorDetail = (error: unknown, remove: string[] = []): Record<string, string> => {
  if (!(error instanceof Error)) {
    return { error: 'unknown' };
  }
  // Cut out before shortening: shortening first could leave the start of a long question, which no longer matches.
  let detail = error.message;
  for (const text of remove.filter(Boolean)) {
    detail = detail.split(text).join('[removed]');
  }
  return { error: error.name, detail: detail.slice(0, 500) };
};

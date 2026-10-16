import type { SSMClient } from '@aws-sdk/client-ssm';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { errorDetail } from '../lib/errors';

/** How long a function keeps a parameter's value before reading it again. */
export const PARAMETER_TTL_MS = 5 * 60 * 1000;

/**
 * An SSM parameter, read again at most every `ttlMs`, so a new value reaches a running function without a deploy.
 * While SSM cannot be read, the last value read, or at first `fallback`, is used, and the failure is logged.
 */
export const cachedParameter = (
  client: SSMClient,
  name: string,
  options: {
    readonly fallback: string;
    readonly log: (entry: Record<string, unknown>) => void;
    readonly ttlMs?: number;
    readonly now?: () => number;
  }
): (() => Promise<string>) => {
  const { fallback, log, ttlMs = PARAMETER_TTL_MS, now = Date.now } = options;
  let value = fallback;
  let readAt: number | undefined;
  return async () => {
    if (readAt === undefined || now() - readAt >= ttlMs) {
      readAt = now();
      try {
        const result = await client.send(new GetParameterCommand({ Name: name }));
        value = result.Parameter?.Value || value;
      } catch (error) {
        log({ outcome: 'parameter-error', parameter: name, ...errorDetail(error) });
      }
    }
    return value;
  };
};

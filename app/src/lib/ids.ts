import { randomUUID } from 'node:crypto';

/** `c_…` for conversations, `x_…` for exchanges: a prefix and 32 hex characters. */
export const newId = (prefix: 'c' | 'x'): string => `${prefix}_${randomUUID().replace(/-/g, '')}`;

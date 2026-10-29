import { handle } from '@hono/aws-lambda';
import { createApp } from '../app';
import { awsDeps } from '../aws/deps';
import { loadEnv } from '../config/env';

/** /audit/*: the audit log, for members of the audit group only. Ordinary JSON responses. */
export const handler = handle(createApp(awsDeps(loadEnv())));

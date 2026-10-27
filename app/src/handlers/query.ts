import { handle } from '@hono/aws-lambda';
import { createApp } from '../app';
import { awsDeps } from '../aws/deps';
import { loadEnv } from '../config/env';

/** /search, /documents/{id} and /feedback: ordinary JSON responses. /health is answered by API Gateway. */
export const handler = handle(createApp(awsDeps(loadEnv())));

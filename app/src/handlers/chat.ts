import { streamHandle } from '@hono/aws-lambda';
import { createApp } from '../app';
import { awsDeps } from '../aws/deps';
import { loadEnv } from '../config/env';

/** POST /api/v1/chat, streamed: API Gateway invokes this function with response streaming. */
export const handler = streamHandle(createApp(awsDeps(loadEnv())));

import { z } from 'zod';

/** Settings the stateless stack passes to the functions. */
const schema = z.object({
  STAGE: z.string().min(1).default('local'),
  TABLE_NAME: z.string().min(1),
  RECORDS_BUCKET: z.string().min(1),
  INGEST_BUCKET: z.string().min(1).optional(),
  KNOWLEDGE_BASE_ID: z.string().min(1),
  DATA_SOURCE_ID: z.string().min(1).optional(),
  GUARDRAIL_ID: z.string().min(1).optional(),
  GUARDRAIL_VERSION: z.string().min(1).optional(),
  ANSWER_MODEL_ID: z.string().min(1).optional(),
  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
  CALLER_DAILY_USD: z.coerce.number().positive().default(0.4),
  MIN_SCORE: z.coerce.number().min(0).default(0),
  CORS_ALLOW_ORIGINS: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

export const loadEnv = (env: Record<string, string | undefined> = process.env): Env => {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid environment: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`
    );
  }
  return result.data;
};

export const corsOrigins = (env: Env): string[] =>
  env.CORS_ALLOW_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

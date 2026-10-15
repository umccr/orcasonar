import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROUTES } from './app';
import type { ErrorCode } from './lib/errors';

const spec = parse(readFileSync(join(__dirname, '..', 'schema', 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, { security?: unknown[] }>>;
  components: {
    schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } };
  };
};

/** Answered by API Gateway itself rather than a function: `infrastructure/stage/stateless-stack.ts`. */
const GATEWAY_ROUTES = ['get /health'];

describe('OpenAPI contract', () => {
  test('describes exactly the routes the API serves', () => {
    const documented = Object.entries(spec.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`))
      .sort();
    const served = [...ROUTES.map((route) => `${route.method} ${route.path}`), ...GATEWAY_ROUTES];
    expect(documented).toEqual(served.sort());
  });

  test('marks only /health as open', () => {
    const open = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.values(methods)
        .filter((operation) => Array.isArray(operation.security) && operation.security.length === 0)
        .map(() => path)
    );
    expect(open).toEqual(['/health']);
  });

  test('lists every error code the app can return', () => {
    const codes: ErrorCode[] = [
      'invalid-request',
      'unauthorized',
      'forbidden',
      'not-found',
      'over-budget',
      'throttled',
      'unavailable',
      'internal',
    ];
    expect(spec.components.schemas.Error.properties.error.properties.code.enum).toEqual(codes);
  });
});

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { API_BASE_PATH, APP_ROOT } from './constants';

/** The API's documentation lives beside the API, as the OrcaBus services' does: `/schema/swagger-ui/` and `/schema/openapi.json`. */
export const SCHEMA_PATH = 'schema';
export const OPENAPI_DOCUMENT_PATH = `/${SCHEMA_PATH}/openapi.json`;

/**
 * Swagger UI from jsDelivr, pinned to one version and checked by the browser against these hashes, which are the npm
 * package's own files. To upgrade, change the version and recompute both:
 *
 *   curl -s https://cdn.jsdelivr.net/npm/swagger-ui-dist@<version>/swagger-ui-bundle.js | openssl dgst -sha384 -binary | openssl base64 -A
 */
const SWAGGER_UI = {
  base: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1/',
  // Subresource Integrity hashes, which detect-secrets mistakes for secrets.
  scriptIntegrity: 'sha384-ZPehFMQommnnuaZ4rpxgkgTT2DKFVp4hZC/7pLit+9Lek9T1YGSo23eHFbvNkXkw', // pragma: allowlist secret
  styleIntegrity: 'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW', // pragma: allowlist secret
};

/**
 * The OpenAPI contract, `app/schema/openapi.yaml`, as JSON. Its one server is this stage's API, by path, so Swagger
 * UI's "Try it out" calls the stage that served the page rather than prod.
 */
export const openApiDocument = (): string => {
  const spec = parse(readFileSync(path.join(APP_ROOT, 'schema', 'openapi.yaml'), 'utf8')) as Record<
    string,
    unknown
  >;
  return JSON.stringify({
    ...spec,
    servers: [{ url: `/${API_BASE_PATH}`, description: 'This stage' }],
  });
};

/**
 * Swagger UI for the contract. A Content-Security-Policy allows only the pinned Swagger UI files, the one inline script
 * (by its hash) and requests back to this API. Tokens pasted into "Authorize" stay in the page; they are not saved.
 */
export const swaggerUiPage = (): string => {
  const init =
    `window.ui = SwaggerUIBundle({ url: '${OPENAPI_DOCUMENT_PATH}', dom_id: '#swagger-ui', ` +
    `deepLinking: true, validatorUrl: null });`;
  const initHash = createHash('sha256').update(init).digest('base64');
  const csp = [
    "default-src 'none'",
    `script-src ${SWAGGER_UI.base} 'sha256-${initHash}'`,
    `style-src ${SWAGGER_UI.base}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>OrcaSonar API</title>',
    '<link rel="icon" href="data:,">',
    `<link rel="stylesheet" href="${SWAGGER_UI.base}swagger-ui.css" integrity="${SWAGGER_UI.styleIntegrity}" crossorigin="anonymous">`,
    '</head>',
    '<body>',
    '<div id="swagger-ui"></div>',
    `<script src="${SWAGGER_UI.base}swagger-ui-bundle.js" integrity="${SWAGGER_UI.scriptIntegrity}" crossorigin="anonymous"></script>`,
    `<script>${init}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
};

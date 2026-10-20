/**
 * Document IDs are the docs export's `doc_id`: `<site slug>:<path without .md>`, for example
 * `management-knowledgebase:Projects/orcahouse-internal-ui`. They map to `docs/<slug>/<path>.md` in the ingest
 * bucket, so they are validated strictly before they become an S3 key.
 */

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const parseDocumentId = (id: string): { site: string; path: string } | null => {
  const separator = id.indexOf(':');
  if (separator <= 0 || id.length > 1024) {
    return null;
  }
  const site = id.slice(0, separator);
  const path = id.slice(separator + 1);
  const segments = path.split('/');
  if (
    !SLUG.test(site) ||
    path.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    path.includes('\\') ||
    [...path].some((character) => character.charCodeAt(0) < 0x20)
  ) {
    return null;
  }
  return { site, path };
};

export const documentKey = (site: string, path: string): string => `docs/${site}/${path}.md`;

import { documentKey, parseDocumentId } from './documents';

describe('document IDs', () => {
  test.each([
    ['platform:onboarding', { site: 'platform', path: 'onboarding' }],
    [
      'management-knowledgebase:Projects/orcahouse-internal-ui',
      { site: 'management-knowledgebase', path: 'Projects/orcahouse-internal-ui' },
    ],
    ['vault:Areas/Alpha Beta', { site: 'vault', path: 'Areas/Alpha Beta' }],
  ])('parses %s', (id, expected) => {
    expect(parseDocumentId(id)).toEqual(expected);
  });

  test.each([
    'no-separator',
    ':onboarding',
    'Platform:onboarding',
    'platform:',
    'platform:../secrets',
    'platform:a/../../b',
    'platform:/absolute',
    'platform:a//b',
    'platform:a\\b',
  ])('rejects %s', (id) => {
    expect(parseDocumentId(id)).toBeNull();
  });

  test('maps to the export key in the ingest bucket', () => {
    expect(documentKey('platform', 'onboarding')).toBe('docs/platform/onboarding.md');
  });
});

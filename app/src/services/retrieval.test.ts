import { SAMPLE_PASSAGES } from '../testing/fakes';
import { plainText, snippet, SNIPPET_CHARACTERS, toCitation } from './retrieval';

describe('retrieval', () => {
  test('quotes a passage as plain text, without Markdown marks', () => {
    const passage = [
      '# Platform Services Team',
      '',
      '## Current priorities',
      '',
      'See [Priorities](https://docs.umccr.org/management-knowledgebase/Priorities/) for the **reviewed** list.',
      '',
      '> Run `umccr-docs check` first.',
      '',
      '| Name | lead |',
      '| --- | :---: |',
      '| [data-sharing-2026](https://docs.umccr.org/x/) | ~~Ada~~ Grace |',
    ].join('\n');
    expect(snippet(passage)).toBe(
      'Platform Services Team Current priorities See Priorities for the reviewed list. ' +
        'Run umccr-docs check first. Name lead data-sharing-2026 Ada Grace'
    );
  });

  test('keeps names with single underscores and asterisks', () => {
    expect(plainText('Set doc_id and site_url; match docs/*.md.')).toBe(
      'Set doc_id and site_url; match docs/*.md.'
    );
  });

  test('cuts long passages', () => {
    const quoted = snippet('word '.repeat(200));
    expect(quoted).toHaveLength(SNIPPET_CHARACTERS);
    expect(quoted.endsWith('…')).toBe(true);
  });

  test('gives a citation the number the answer cites it by', () => {
    expect(toCitation(SAMPLE_PASSAGES[1]!, 2)).toMatchObject({
      id: 'platform:publishing',
      title: 'Publishing contract',
      ref: 2,
    });
  });
});

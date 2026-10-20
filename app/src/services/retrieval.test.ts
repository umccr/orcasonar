import { SAMPLE_PASSAGES } from '../testing/fakes';
import {
  MAX_QUESTION_CHARACTERS,
  plainText,
  retrievalQuery,
  snippet,
  SNIPPET_CHARACTERS,
  toCitation,
} from './retrieval';

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

  test('searches for a follow-up with the question before it, within a question’s length', () => {
    const history = [
      { question: 'What is OrcaHouse?', answer: 'A data warehouse [1].' },
      { question: 'How do I add a site?', answer: 'Register it [1].' },
    ];
    expect(retrievalQuery('How do I add a site?', [])).toBe('How do I add a site?');
    expect(retrievalQuery('And in prod?', history)).toBe('How do I add a site?\nAnd in prod?');

    const long = retrievalQuery('And in prod?', [
      { question: 'x'.repeat(MAX_QUESTION_CHARACTERS), answer: '' },
    ]);
    expect(long).toHaveLength(MAX_QUESTION_CHARACTERS);
    expect(long.endsWith('x\nAnd in prod?')).toBe(true);

    // A question as long as the API takes leaves no room, and is searched for alone.
    const longest = 'y'.repeat(MAX_QUESTION_CHARACTERS);
    expect(retrievalQuery(longest, history)).toBe(longest);
  });

  test('gives a citation the number the answer cites it by', () => {
    expect(toCitation(SAMPLE_PASSAGES[1]!, 2)).toMatchObject({
      id: 'platform:publishing',
      title: 'Publishing contract',
      ref: 2,
    });
  });
});

import { SAMPLE_PASSAGES } from '../testing/fakes';
import { buildMessages, citedPassages, formatSources, HISTORY_TURNS } from './prompt';

describe('prompt', () => {
  test('numbers the sources with their titles and links', () => {
    const sources = formatSources(SAMPLE_PASSAGES.slice(0, 2));
    expect(sources).toContain(
      '[1] Onboarding a repository (https://docs.umccr.org/platform/onboarding/)'
    );
    expect(sources).toContain('[2] Publishing contract');
  });

  test('marks the sources and the question for the grounding check', () => {
    const messages = buildMessages('How do I add a site?', SAMPLE_PASSAGES, []);
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    const guarded = last.content.flatMap((block) =>
      'guardContent' in block ? [block.guardContent.text.qualifiers[0]] : []
    );
    expect(guarded).toEqual(['grounding_source', 'query']);
  });

  test('keeps only the last few turns of history', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      question: `q${index}`,
      answer: `a${index}`,
    }));
    const messages = buildMessages('next', SAMPLE_PASSAGES, history);
    expect(messages).toHaveLength(HISTORY_TURNS * 2 + 1);
    expect(messages[0]).toEqual({ role: 'user', content: [{ text: 'q4' }] });
  });

  test('cites the passages the answer refers to, in order of first mention', () => {
    const cited = citedPassages('First [2]. Then [1][2]. Not [9].', SAMPLE_PASSAGES);
    expect(cited.map((passage) => passage.id)).toEqual([
      'platform:publishing',
      'platform:onboarding',
    ]);
  });

  test('lists every passage when the answer cites none', () => {
    expect(citedPassages('No markers here.', SAMPLE_PASSAGES)).toHaveLength(SAMPLE_PASSAGES.length);
  });
});

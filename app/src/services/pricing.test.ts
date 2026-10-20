import { priceExchange, RETRIEVAL_USD, textUnits } from './pricing';

describe('pricing', () => {
  test('prices a typical Sonnet 5 answer at about 1.9 cents', () => {
    const usd = priceExchange({
      modelId: 'au.anthropic.claude-sonnet-5',
      usage: { inputTokens: 5000, outputTokens: 400 },
      guardedCharacters: 22_000,
      retrievals: 1,
    });
    expect(usd).toBeGreaterThan(0.017);
    expect(usd).toBeLessThan(0.025);
  });

  test('prices a search at one retrieval', () => {
    expect(priceExchange({ retrievals: 1 })).toBe(RETRIEVAL_USD);
  });

  test('prices an unknown model as the most expensive one', () => {
    const known = priceExchange({
      modelId: 'au.anthropic.claude-sonnet-5',
      usage: { inputTokens: 1000, outputTokens: 1000 },
      retrievals: 0,
    });
    const unknown = priceExchange({
      modelId: 'something-new',
      usage: { inputTokens: 1000, outputTokens: 1000 },
      retrievals: 0,
    });
    expect(unknown).toBe(known);
  });

  test('counts guardrail text units of up to 1,000 characters', () => {
    expect(textUnits(1)).toBe(1);
    expect(textUnits(1000)).toBe(1);
    expect(textUnits(1001)).toBe(2);
  });
});

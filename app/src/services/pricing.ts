/**
 * What an exchange costs, from the token counts Bedrock returns with every answer. The budget counts dollars rather
 * than questions, so a long answer costs more of the allowance than a short one.
 */

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** US dollars per million tokens, through the Australian cross-Region inference profiles. */
export const MODEL_PRICES: Record<string, { readonly input: number; readonly output: number }> = {
  'au.anthropic.claude-sonnet-5': { input: 2.2, output: 11 },
  'au.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.1, output: 5.5 },
};

/** One knowledge base retrieval. */
export const RETRIEVAL_USD = 0.001;

/**
 * Guardrail checks, per text unit of up to 1,000 characters: denied topics ($0.15 per 1,000 units), personal-data
 * masking ($0.10) and the grounding check ($0.10).
 */
export const GUARDRAIL_USD_PER_TEXT_UNIT = (0.15 + 0.1 + 0.1) / 1000;

export const textUnits = (characters: number): number => Math.ceil(characters / 1000);

export interface ExchangeCost {
  readonly modelId?: string;
  readonly usage?: Usage;
  /** Characters the guardrail checked: the sources and question going in, the answer coming out. */
  readonly guardedCharacters?: number;
  readonly retrievals: number;
}

/** The exchange's cost in US dollars. An unknown model is priced as the most expensive known one. */
export const priceExchange = (exchange: ExchangeCost): number => {
  let usd = exchange.retrievals * RETRIEVAL_USD;
  if (exchange.usage) {
    const prices = (exchange.modelId && MODEL_PRICES[exchange.modelId]) || mostExpensiveModel();
    usd +=
      (exchange.usage.inputTokens * prices.input + exchange.usage.outputTokens * prices.output) /
      1_000_000;
  }
  if (exchange.guardedCharacters) {
    usd += textUnits(exchange.guardedCharacters) * GUARDRAIL_USD_PER_TEXT_UNIT;
  }
  return Math.round(usd * 1_000_000) / 1_000_000;
};

const mostExpensiveModel = () =>
  Object.values(MODEL_PRICES).reduce((most, prices) =>
    prices.output > most.output ? prices : most
  );

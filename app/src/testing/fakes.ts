import type { AppDeps } from '../app';
import { ApiError } from '../lib/errors';
import type { AnswerEvent, AnswerRequest, Answerer } from '../services/answer';
import type { BudgetLimits, Spend, SpendKeys, SpendStore } from '../services/budget';
import { Budget } from '../services/budget';
import type { Turn } from '../services/prompt';
import type { Passage, RetrieveOptions, Retriever } from '../services/retrieval';
import type {
  ConversationStore,
  DocumentStore,
  DocumentView,
  ExchangeRecord,
  FeedbackRecord,
  RecordStore,
} from '../services/stores';

/** In-memory stand-ins for the AWS services, for tests and `pnpm dev`. */

export class MemorySpendStore implements SpendStore {
  readonly values = new Map<string, number>();

  async spent(keys: SpendKeys): Promise<Spend> {
    return {
      month: this.values.get(`month#${keys.month}`) ?? 0,
      day: this.values.get(`day#${keys.day}`) ?? 0,
      caller: this.values.get(`caller#${keys.caller}`) ?? 0,
    };
  }

  async add(keys: SpendKeys, usd: number): Promise<void> {
    for (const key of [`month#${keys.month}`, `day#${keys.day}`, `caller#${keys.caller}`]) {
      this.values.set(key, (this.values.get(key) ?? 0) + usd);
    }
  }
}

export class MemoryConversationStore implements ConversationStore {
  readonly turns = new Map<string, { owner: string; turns: Turn[] }>();

  async load(conversationId: string, ownerId: string): Promise<Turn[]> {
    const conversation = this.turns.get(conversationId);
    if (conversation && conversation.owner !== ownerId) {
      throw new ApiError(403, 'forbidden', 'That conversation belongs to someone else.');
    }
    return conversation?.turns.slice(-6) ?? [];
  }

  async append(conversationId: string, ownerId: string, turn: Turn): Promise<void> {
    const conversation = this.turns.get(conversationId) ?? { owner: ownerId, turns: [] };
    conversation.turns.push(turn);
    this.turns.set(conversationId, conversation);
  }
}

export class MemoryRecordStore implements RecordStore {
  readonly exchanges: ExchangeRecord[] = [];
  readonly feedback: FeedbackRecord[] = [];

  async putExchange(record: ExchangeRecord): Promise<void> {
    this.exchanges.push(record);
  }

  async putFeedback(record: FeedbackRecord): Promise<void> {
    this.feedback.push(record);
  }
}

export class MemoryDocumentStore implements DocumentStore {
  constructor(readonly documents: DocumentView[] = []) {}

  async get(site: string, path: string): Promise<DocumentView | null> {
    return this.documents.find((document) => document.id === `${site}:${path}`) ?? null;
  }
}

/** Returns the given passages, filtered by site, as the knowledge base would. */
export class StaticRetriever implements Retriever {
  readonly calls: Array<{ query: string; options: RetrieveOptions }> = [];

  constructor(readonly passages: Passage[]) {}

  async retrieve(query: string, options: RetrieveOptions): Promise<Passage[]> {
    this.calls.push({ query, options });
    return this.passages
      .filter((passage) => !options.sites || options.sites.includes(passage.site))
      .slice(0, options.topK);
  }
}

/** Streams a fixed answer in a few pieces, then reports usage. */
export class ScriptedAnswerer implements Answerer {
  readonly modelId = 'au.anthropic.claude-sonnet-5';
  readonly requests: AnswerRequest[] = [];

  constructor(
    private readonly answer = 'Add one entry to the site registry [1], then push your docs [2].',
    private readonly usage = { inputTokens: 4920, outputTokens: 388 },
    private readonly guardrail = false
  ) {}

  async *stream(request: AnswerRequest): AsyncIterable<AnswerEvent> {
    this.requests.push(request);
    for (const piece of this.answer.match(/.{1,16}/g) ?? []) {
      yield { type: 'delta', text: piece };
    }
    if (this.guardrail) {
      yield { type: 'guardrail' };
    }
    yield { type: 'usage', usage: this.usage };
  }
}

export const SAMPLE_PASSAGES: Passage[] = [
  {
    id: 'platform:onboarding',
    title: 'Onboarding a repository',
    url: 'https://docs.umccr.org/platform/onboarding/',
    site: 'platform',
    text: 'Register the site in infrastructure/sites.ts with its repository, branch and docs paths.',
    score: 0.82,
  },
  {
    id: 'platform:publishing',
    title: 'Publishing contract',
    url: 'https://docs.umccr.org/platform/publishing/',
    site: 'platform',
    text: 'A push to the site branch that changes its docs paths publishes it to dev, then prod.',
    score: 0.71,
  },
  {
    id: 'management-knowledgebase:Projects/orcahouse-internal-ui',
    title: 'OrcaHouse internal UI',
    url: 'https://docs.umccr.org/management-knowledgebase/Projects/orcahouse-internal-ui/',
    site: 'management-knowledgebase',
    text: 'An Athena browser for OrcaHouse, for internal users.',
    score: 0.4,
  },
];

export interface FakeDeps extends AppDeps {
  readonly spend: MemorySpendStore;
  readonly conversationStore: MemoryConversationStore;
  readonly recordStore: MemoryRecordStore;
  readonly staticRetriever: StaticRetriever;
  readonly scriptedAnswerer: ScriptedAnswerer;
  readonly logs: Record<string, unknown>[];
}

export const fakeDeps = (
  options: {
    passages?: Passage[];
    answerer?: ScriptedAnswerer;
    limits?: BudgetLimits;
    now?: Date;
    documents?: DocumentView[];
  } = {}
): FakeDeps => {
  const spend = new MemorySpendStore();
  const conversationStore = new MemoryConversationStore();
  const recordStore = new MemoryRecordStore();
  const staticRetriever = new StaticRetriever(options.passages ?? SAMPLE_PASSAGES);
  const scriptedAnswerer = options.answerer ?? new ScriptedAnswerer();
  const clock = () => options.now ?? new Date('2026-10-12T03:00:00Z');
  const logs: Record<string, unknown>[] = [];
  return {
    stage: 'test',
    corsAllowOrigins: ['https://docs.dev.umccr.org'],
    minScore: 0,
    budget: new Budget(spend, options.limits ?? { monthlyUsd: 50, callerDailyUsd: 0.4 }, clock),
    conversations: conversationStore,
    retriever: staticRetriever,
    records: recordStore,
    documents: new MemoryDocumentStore(options.documents),
    answerer: () => scriptedAnswerer,
    clock,
    log: (entry) => logs.push(entry),
    spend,
    conversationStore,
    recordStore,
    staticRetriever,
    scriptedAnswerer,
    logs,
  };
};

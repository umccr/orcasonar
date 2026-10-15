import type { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import type {
  BedrockAgentRuntimeClient,
  RetrievalFilter,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import type {
  BedrockRuntimeClient,
  Message as ConverseMessage,
} from '@aws-sdk/client-bedrock-runtime';
import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { AnswerEvent, AnswerRequest, Answerer } from '../services/answer';
import type { Passage, RetrieveOptions, Retriever } from '../services/retrieval';

/**
 * Retrieval from the managed knowledge base: hybrid search with the managed reranker, as configured by
 * `managedSearchConfiguration` (managed knowledge bases do not take `vectorSearchConfiguration`).
 */
export class KnowledgeBaseRetriever implements Retriever {
  constructor(
    private readonly client: BedrockAgentRuntimeClient,
    private readonly knowledgeBaseId: string
  ) {}

  async retrieve(query: string, options: RetrieveOptions): Promise<Passage[]> {
    const filter: RetrievalFilter | undefined = !options.sites?.length
      ? undefined
      : options.sites.length === 1
        ? { equals: { key: 'site', value: options.sites[0] } }
        : { in: { key: 'site', value: [...options.sites] } };
    const result = await this.client.send(
      new RetrieveCommand({
        knowledgeBaseId: this.knowledgeBaseId,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
          managedSearchConfiguration: { numberOfResults: options.topK, filter },
        },
      })
    );
    return (result.retrievalResults ?? []).flatMap((item) => {
      const text = item.content?.text;
      if (!text) return [];
      const metadata = (item.metadata ?? {}) as Record<string, unknown>;
      const value = (name: string) => (typeof metadata[name] === 'string' ? metadata[name] : '');
      return [
        {
          id: value('doc_id'),
          title: value('title') || value('doc_id'),
          url: value('url'),
          site: value('site'),
          text,
          score: item.score ?? 0,
        },
      ];
    });
  }
}

/** Claude through Bedrock's Converse API, streamed, with the guardrail applied as the answer is written. */
export class BedrockAnswerer implements Answerer {
  constructor(
    private readonly client: BedrockRuntimeClient,
    readonly modelId: string,
    private readonly guardrail?: { id: string; version: string }
  ) {}

  async *stream(request: AnswerRequest): AsyncIterable<AnswerEvent> {
    const response = await this.client.send(
      new ConverseStreamCommand({
        modelId: this.modelId,
        system: [{ text: request.system }],
        messages: request.messages as ConverseMessage[],
        // No sampling parameters: Claude Sonnet 5 rejects `temperature` ("deprecated for this model"), and the
        // grounding check and the prompt keep answers to the passages.
        inferenceConfig: { maxTokens: request.maxTokens },
        guardrailConfig: this.guardrail
          ? {
              guardrailIdentifier: this.guardrail.id,
              guardrailVersion: this.guardrail.version,
              streamProcessingMode: 'sync',
            }
          : undefined,
      })
    );
    for await (const event of response.stream ?? []) {
      const text = event.contentBlockDelta?.delta?.text;
      if (text) {
        yield { type: 'delta', text };
      }
      if (event.messageStop?.stopReason === 'guardrail_intervened') {
        yield { type: 'guardrail' };
      }
      const usage = event.metadata?.usage;
      if (usage) {
        yield {
          type: 'usage',
          usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
        };
      }
    }
  }
}

/** Starting ingestion jobs on the `docs` data source, one at a time. */
export class KnowledgeBaseIngestion {
  constructor(
    private readonly client: BedrockAgentClient,
    private readonly knowledgeBaseId: string,
    private readonly dataSourceId: string
  ) {}

  async running(): Promise<boolean> {
    const result = await this.client.send(
      new ListIngestionJobsCommand({
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
        filters: [{ attribute: 'STATUS', operator: 'EQ', values: ['STARTING', 'IN_PROGRESS'] }],
        maxResults: 1,
      })
    );
    return (result.ingestionJobSummaries ?? []).length > 0;
  }

  async start(): Promise<string> {
    const result = await this.client.send(
      new StartIngestionJobCommand({
        knowledgeBaseId: this.knowledgeBaseId,
        dataSourceId: this.dataSourceId,
        description: 'Documents changed under docs/',
      })
    );
    return result.ingestionJob?.ingestionJobId ?? 'unknown';
  }
}

import type { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import {
  GetIngestionJobCommand,
  ListIngestionJobsCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';
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
import type { Ingestion, JobStatus } from '../services/ingestion';
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

export interface Guardrail {
  readonly id: string;
  readonly version: string;
}

/** Claude through Bedrock's Converse API, streamed, with the guardrail applied as the answer is written. */
export class BedrockAnswerer implements Answerer {
  constructor(
    private readonly client: BedrockRuntimeClient,
    readonly modelId: string,
    /** Asked for each answer: the guardrail's version can change while the function runs. */
    private readonly guardrail?: () => Promise<Guardrail>
  ) {}

  async *stream(request: AnswerRequest): AsyncIterable<AnswerEvent> {
    const guardrail = await this.guardrail?.();
    const response = await this.client.send(
      new ConverseStreamCommand({
        modelId: this.modelId,
        system: [{ text: request.system }],
        messages: request.messages as ConverseMessage[],
        // No sampling parameters: Claude Sonnet 5 rejects `temperature` ("deprecated for this model"), and the
        // grounding check and the prompt keep answers to the passages.
        inferenceConfig: { maxTokens: request.maxTokens },
        guardrailConfig: guardrail
          ? {
              guardrailIdentifier: guardrail.id,
              guardrailVersion: guardrail.version,
              streamProcessingMode: 'sync',
            }
          : undefined,
      })
    );
    // Bedrock refuses a request, for access or throttling, before the response starts; from here it may bill tokens.
    yield { type: 'started' };
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

/** Starting ingestion jobs on the `docs` data source, one at a time, and following them to the end. */
export class KnowledgeBaseIngestion implements Ingestion {
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
    const jobId = result.ingestionJob?.ingestionJobId;
    if (!jobId) {
      throw new Error('StartIngestionJob returned no job ID');
    }
    return jobId;
  }

  async status(jobId: string): Promise<JobStatus> {
    let job;
    try {
      job = (
        await this.client.send(
          new GetIngestionJobCommand({
            knowledgeBaseId: this.knowledgeBaseId,
            dataSourceId: this.dataSourceId,
            ingestionJobId: jobId,
          })
        )
      ).ingestionJob;
    } catch (error) {
      // A job the service no longer knows, as after the knowledge base was replaced, will never finish.
      if ((error as { name?: string }).name === 'ResourceNotFoundException') {
        return { state: 'failed', detail: { status: 'NOT_FOUND' } };
      }
      throw error;
    }
    switch (job?.status) {
      case 'COMPLETE':
        return {
          state: 'complete',
          detail: { documentsFailed: job.statistics?.numberOfDocumentsFailed ?? 0 },
        };
      case 'FAILED':
      case 'STOPPED':
        return {
          state: 'failed',
          detail: { status: job.status, reasons: job.failureReasons ?? [] },
        };
      default:
        return { state: 'running' };
    }
  }
}

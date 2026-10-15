import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockAnswerer, KnowledgeBaseRetriever } from './bedrock';
import { metadataValues, S3DocumentStore } from './s3';

describe('KnowledgeBaseRetriever', () => {
  const bedrock = mockClient(BedrockAgentRuntimeClient);
  beforeEach(() => bedrock.reset());

  test('uses managed search, filtered by site, and maps the export metadata', async () => {
    bedrock.on(RetrieveCommand).resolves({
      retrievalResults: [
        {
          content: { type: 'TEXT', text: 'Register the site.' },
          score: 0.9,
          metadata: {
            doc_id: 'platform:onboarding',
            title: 'Onboarding',
            url: 'https://docs.umccr.org/platform/onboarding/',
            site: 'platform',
          },
        },
        { content: { type: 'IMAGE' }, score: 0.5 },
      ],
    });
    const retriever = new KnowledgeBaseRetriever(new BedrockAgentRuntimeClient({}), 'KB123');

    const passages = await retriever.retrieve('add a site', { sites: ['platform'], topK: 8 });
    expect(passages).toEqual([
      {
        id: 'platform:onboarding',
        title: 'Onboarding',
        url: 'https://docs.umccr.org/platform/onboarding/',
        site: 'platform',
        text: 'Register the site.',
        score: 0.9,
      },
    ]);
    expect(bedrock.commandCalls(RetrieveCommand)[0]!.args[0].input).toEqual({
      knowledgeBaseId: 'KB123',
      retrievalQuery: { text: 'add a site' },
      retrievalConfiguration: {
        managedSearchConfiguration: {
          numberOfResults: 8,
          filter: { equals: { key: 'site', value: 'platform' } },
        },
      },
    });

    await retriever.retrieve('q', { sites: ['a', 'b'], topK: 3 });
    await retriever.retrieve('q', { topK: 3 });
    const filters = bedrock
      .commandCalls(RetrieveCommand)
      .map((call) => call.args[0].input.retrievalConfiguration?.managedSearchConfiguration?.filter);
    expect(filters.slice(1)).toEqual([{ in: { key: 'site', value: ['a', 'b'] } }, undefined]);
  });
});

describe('BedrockAnswerer', () => {
  const bedrock = mockClient(BedrockRuntimeClient);
  beforeEach(() => bedrock.reset());

  test('streams text and usage, with the guardrail on every call', async () => {
    async function* stream() {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello ' } } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'there [1].' } } };
      yield { messageStop: { stopReason: 'end_turn' as const } };
      yield {
        metadata: {
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
          metrics: { latencyMs: 1 },
        },
      };
    }
    bedrock.on(ConverseStreamCommand).resolves({ stream: stream() } as never);
    const answerer = new BedrockAnswerer(
      new BedrockRuntimeClient({}),
      'au.anthropic.claude-sonnet-5',
      {
        id: 'g-1',
        version: '3',
      }
    );

    const events = [];
    for await (const event of answerer.stream({ system: 'sys', messages: [], maxTokens: 1000 })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'there [1].' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } },
    ]);
    const input = bedrock.commandCalls(ConverseStreamCommand)[0]!.args[0].input;
    expect(input.modelId).toBe('au.anthropic.claude-sonnet-5');
    // Sonnet 5 refuses a request with `temperature`, so the config holds the token limit only.
    expect(input.inferenceConfig).toEqual({ maxTokens: 1000 });
    expect(input.guardrailConfig).toEqual({
      guardrailIdentifier: 'g-1',
      guardrailVersion: '3',
      streamProcessingMode: 'sync',
    });
  });

  test('reports a guardrail intervention', async () => {
    async function* stream() {
      yield { messageStop: { stopReason: 'guardrail_intervened' as const } };
    }
    bedrock.on(ConverseStreamCommand).resolves({ stream: stream() } as never);
    const answerer = new BedrockAnswerer(new BedrockRuntimeClient({}), 'm');
    const events = [];
    for await (const event of answerer.stream({ system: 's', messages: [], maxTokens: 10 })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'guardrail' }]);
  });
});

describe('S3DocumentStore', () => {
  const s3 = mockClient(S3Client);
  beforeEach(() => s3.reset());

  const body = (text: string) => ({ transformToString: async () => text }) as never;

  test('reads the document and its typed metadata', async () => {
    s3.on(GetObjectCommand, { Key: 'docs/platform/onboarding.md' }).resolves({
      Body: body('# Onboarding'),
    });
    s3.on(GetObjectCommand, { Key: 'docs/platform/onboarding.md.metadata.json' }).resolves({
      Body: body(
        JSON.stringify({
          metadataAttributes: {
            doc_id: { value: { type: 'STRING', stringValue: 'platform:onboarding' } },
            title: { value: { type: 'STRING', stringValue: 'Onboarding a repository' } },
            url: {
              value: { type: 'STRING', stringValue: 'https://docs.umccr.org/platform/onboarding/' },
            },
            updated: { value: { type: 'STRING', stringValue: '2026-10-12' } },
          },
        })
      ),
    });
    const store = new S3DocumentStore(new S3Client({}), 'ingest');
    expect(await store.get('platform', 'onboarding')).toEqual({
      id: 'platform:onboarding',
      site: 'platform',
      title: 'Onboarding a repository',
      url: 'https://docs.umccr.org/platform/onboarding/',
      updated: '2026-10-12',
      markdown: '# Onboarding',
    });
  });

  test('returns null for a missing document', async () => {
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    const store = new S3DocumentStore(new S3Client({}), 'ingest');
    expect(await store.get('platform', 'nothing')).toBeNull();
  });

  test('reads plain metadata values too', () => {
    expect(metadataValues({ metadataAttributes: { site: 'platform' } })).toEqual({
      site: 'platform',
    });
  });
});

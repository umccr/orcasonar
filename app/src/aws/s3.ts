import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { documentKey } from '../services/documents';
import type {
  DocumentStore,
  DocumentView,
  ExchangeRecord,
  FeedbackRecord,
  RecordStore,
} from '../services/stores';

/** Exchanges and feedback, one JSON object each, partitioned by date for evaluation queries. Deleted after 30 days. */
export class S3RecordStore implements RecordStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string
  ) {}

  private async put(key: string, body: unknown) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
      })
    );
  }

  putExchange(record: ExchangeRecord): Promise<void> {
    return this.put(`records/date=${record.at.slice(0, 10)}/${record.exchangeId}.json`, record);
  }

  putFeedback(record: FeedbackRecord): Promise<void> {
    const stamp = record.at.replace(/[:.]/g, '-');
    return this.put(
      `feedback/date=${record.at.slice(0, 10)}/${record.exchangeId}-${stamp}.json`,
      record
    );
  }
}

const isMissing = (error: unknown) => {
  const name = (error as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
};

/** Metadata attributes in the typed form the docs export writes, as plain strings. */
export const metadataValues = (metadata: unknown): Record<string, string> => {
  const attributes = (metadata as { metadataAttributes?: Record<string, unknown> })
    ?.metadataAttributes;
  const values: Record<string, string> = {};
  for (const [name, attribute] of Object.entries(attributes ?? {})) {
    const value = (attribute as { value?: { stringValue?: unknown } })?.value?.stringValue;
    if (typeof value === 'string') {
      values[name] = value;
    } else if (typeof attribute === 'string') {
      values[name] = attribute;
    }
  }
  return values;
};

/** Documents exported by the docs platform, read straight from the ingest bucket. */
export class S3DocumentStore implements DocumentStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string
  ) {}

  private async text(key: string): Promise<string | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return (await result.Body?.transformToString('utf-8')) ?? null;
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async get(site: string, path: string): Promise<DocumentView | null> {
    const key = documentKey(site, path);
    const [markdown, metadata] = await Promise.all([
      this.text(key),
      this.text(`${key}.metadata.json`),
    ]);
    if (markdown === null) {
      return null;
    }
    const values = metadata ? metadataValues(JSON.parse(metadata)) : {};
    return {
      id: values['doc_id'] ?? `${site}:${path}`,
      site,
      title: values['title'] ?? path.split('/').pop() ?? path,
      url: values['url'] ?? '',
      updated: values['updated'] ?? '',
      markdown,
    };
  }
}

/**
 * Keeping the index current without overlapping ingestion jobs.
 *
 * Every change under `docs/` marks the index stale (the latest change's time). Every 15 minutes, if it is stale and no
 * job is running, one job starts and the mark is cleared, unless a newer change arrived meanwhile, in which case the
 * next run starts another job. Many sites can publish at once, and jobs on one data source cannot overlap, so jobs are
 * never started per change.
 */

export interface IngestFlag {
  mark(at: string): Promise<void>;
  current(): Promise<string | null>;
  clear(at: string): Promise<void>;
}

export interface Ingestion {
  running(): Promise<boolean>;
  start(): Promise<string>;
}

export type IngestOutcome = 'up-to-date' | 'job-running' | 'started';

export const runIngestion = async (
  flag: IngestFlag,
  ingestion: Ingestion,
  log: (entry: Record<string, unknown>) => void
): Promise<IngestOutcome> => {
  const staleSince = await flag.current();
  if (!staleSince) {
    return 'up-to-date';
  }
  if (await ingestion.running()) {
    log({ outcome: 'job-running', staleSince });
    return 'job-running';
  }
  const jobId = await ingestion.start();
  await flag.clear(staleSince);
  log({ outcome: 'started', jobId, staleSince });
  return 'started';
};

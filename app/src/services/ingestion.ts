/**
 * Keeping the index current without overlapping ingestion jobs.
 *
 * Every change under `docs/` marks the index stale, with the change's own revision (its event ID). Every 15 minutes,
 * if it is stale and no job is running, one job starts, and the revision it covers is kept with it. Once that job
 * completes, the mark is cleared, unless a newer change marked it meanwhile, in which case the next run starts another
 * job. A job that fails or is stopped leaves the mark, so the next run starts another, and is logged as `job-failed`,
 * which raises an alarm. Many sites can publish at once, and jobs on one data source cannot overlap, so jobs are never
 * started per change.
 */

/** The index has been stale since `at`. `revision` names the change, so clearing it can never clear a newer one. */
export interface StaleMark {
  readonly at: string;
  readonly revision: string;
}

/** A job started for the mark with this revision. */
export interface StartedJob {
  readonly jobId: string;
  readonly revision: string;
}

export interface IngestState {
  mark(mark: StaleMark): Promise<void>;
  stale(): Promise<StaleMark | null>;
  /** Clears the mark if it is still this revision. */
  clear(revision: string): Promise<void>;
  job(): Promise<StartedJob | null>;
  started(job: StartedJob): Promise<void>;
  /** Forgets the job, once it has finished, if it is still the one kept. */
  finished(jobId: string): Promise<void>;
}

/** Where a job is, with what is worth logging about how it ended. */
export interface JobStatus {
  readonly state: 'running' | 'complete' | 'failed';
  readonly detail?: Record<string, unknown>;
}

export interface Ingestion {
  running(): Promise<boolean>;
  start(): Promise<string>;
  status(jobId: string): Promise<JobStatus>;
}

export type IngestOutcome = 'up-to-date' | 'job-running' | 'started';

export const runIngestion = async (
  state: IngestState,
  ingestion: Ingestion,
  log: (entry: Record<string, unknown>) => void
): Promise<IngestOutcome> => {
  const job = await state.job();
  if (job) {
    const status = await ingestion.status(job.jobId);
    if (status.state === 'running') {
      log({ outcome: 'job-running', jobId: job.jobId });
      return 'job-running';
    }
    if (status.state === 'complete') {
      await state.clear(job.revision);
    }
    log({
      outcome: status.state === 'complete' ? 'job-complete' : 'job-failed',
      jobId: job.jobId,
      ...status.detail,
    });
    await state.finished(job.jobId);
  }

  const stale = await state.stale();
  if (!stale) {
    return 'up-to-date';
  }
  // A job this function did not start, such as one an operator started by hand.
  if (await ingestion.running()) {
    log({ outcome: 'job-running', staleSince: stale.at });
    return 'job-running';
  }
  const jobId = await ingestion.start();
  await state.started({ jobId, revision: stale.revision });
  log({ outcome: 'started', jobId, staleSince: stale.at });
  return 'started';
};

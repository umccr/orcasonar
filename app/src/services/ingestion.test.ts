import type { IngestState, Ingestion, JobStatus, StaleMark, StartedJob } from './ingestion';
import { runIngestion } from './ingestion';

/** The ingestion state in memory, with the same conditional clears as DynamoDB's. */
const memoryState = (
  mark: StaleMark | null = null
): IngestState & { staleMark: StaleMark | null; startedJob: StartedJob | null } => ({
  staleMark: mark,
  startedJob: null,
  async mark(value) {
    this.staleMark = value;
  },
  async stale() {
    return this.staleMark;
  },
  async clear(revision) {
    if (this.staleMark?.revision === revision) this.staleMark = null;
  },
  async job() {
    return this.startedJob;
  },
  async started(job) {
    this.startedJob = job;
  },
  async finished(jobId) {
    if (this.startedJob?.jobId === jobId) this.startedJob = null;
  },
});

/** Jobs that end as `statuses` says, by job ID; `running` is what ListIngestionJobs reports. */
const jobs = (statuses: Record<string, JobStatus> = {}, running = false) => ({
  started: [] as string[],
  statuses,
  async running() {
    return running;
  },
  async start() {
    const jobId = `job-${this.started.length + 1}`;
    this.started.push(jobId);
    return jobId;
  },
  async status(jobId: string): Promise<JobStatus> {
    return this.statuses[jobId] ?? { state: 'running' };
  },
});

const CHANGE = { at: '2026-10-12T00:00:00Z', revision: 'event-1' };
const NEWER = { at: '2026-10-12T00:00:00Z', revision: 'event-2' };

describe('runIngestion', () => {
  test('does nothing while the index is up to date', async () => {
    const ingestion = jobs();
    expect(await runIngestion(memoryState(), ingestion, () => undefined)).toBe('up-to-date');
    expect(ingestion.started).toEqual([]);
  });

  test('starts one job for the change, and keeps the mark until it completes', async () => {
    const state = memoryState(CHANGE);
    const ingestion = jobs();
    expect(await runIngestion(state, ingestion, () => undefined)).toBe('started');
    expect(state.startedJob).toEqual({ jobId: 'job-1', revision: 'event-1' });
    expect(state.staleMark).toEqual(CHANGE);

    expect(await runIngestion(state, ingestion, () => undefined)).toBe('job-running');
    expect(ingestion.started).toEqual(['job-1']);
  });

  test('clears the mark once the job completes', async () => {
    const state = memoryState(CHANGE);
    const ingestion = jobs();
    await runIngestion(state, ingestion, () => undefined);
    ingestion.statuses['job-1'] = { state: 'complete', detail: { documentsFailed: 0 } };
    const logs: Record<string, unknown>[] = [];
    expect(await runIngestion(state, ingestion, (entry) => logs.push(entry))).toBe('up-to-date');
    expect(state.staleMark).toBeNull();
    expect(state.startedJob).toBeNull();
    expect(logs).toContainEqual({ outcome: 'job-complete', jobId: 'job-1', documentsFailed: 0 });
  });

  test('keeps a newer change, even in the same second, and starts a job for it', async () => {
    const state = memoryState(CHANGE);
    const ingestion = jobs();
    await runIngestion(state, ingestion, () => undefined);
    await state.mark(NEWER);
    ingestion.statuses['job-1'] = { state: 'complete' };
    expect(await runIngestion(state, ingestion, () => undefined)).toBe('started');
    expect(state.staleMark).toEqual(NEWER);
    expect(state.startedJob).toEqual({ jobId: 'job-2', revision: 'event-2' });
  });

  test('keeps the mark when a job fails, logs it, and starts another', async () => {
    const state = memoryState(CHANGE);
    const ingestion = jobs();
    await runIngestion(state, ingestion, () => undefined);
    ingestion.statuses['job-1'] = {
      state: 'failed',
      detail: { status: 'FAILED', reasons: ['Access denied'] },
    };
    const logs: Record<string, unknown>[] = [];
    expect(await runIngestion(state, ingestion, (entry) => logs.push(entry))).toBe('started');
    expect(logs).toContainEqual({
      outcome: 'job-failed',
      jobId: 'job-1',
      status: 'FAILED',
      reasons: ['Access denied'],
    });
    expect(state.staleMark).toEqual(CHANGE);
    expect(state.startedJob).toEqual({ jobId: 'job-2', revision: 'event-1' });
  });

  test('waits for a job it did not start, such as one started by hand', async () => {
    const state = memoryState(CHANGE);
    const ingestion: Ingestion & { started: string[] } = jobs({}, true);
    expect(await runIngestion(state, ingestion, () => undefined)).toBe('job-running');
    expect(ingestion.started).toEqual([]);
    expect(state.staleMark).toEqual(CHANGE);
  });
});

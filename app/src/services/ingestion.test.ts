import type { IngestFlag, Ingestion } from './ingestion';
import { runIngestion } from './ingestion';

const flag = (initial: string | null): IngestFlag & { value: string | null } => ({
  value: initial,
  async mark(at) {
    this.value = at;
  },
  async current() {
    return this.value;
  },
  async clear(at) {
    if (this.value === at) this.value = null;
  },
});

const ingestion = (running: boolean): Ingestion & { started: number } => ({
  started: 0,
  async running() {
    return running;
  },
  async start() {
    this.started += 1;
    return `job-${this.started}`;
  },
});

describe('runIngestion', () => {
  test('does nothing while the index is up to date', async () => {
    const jobs = ingestion(false);
    expect(await runIngestion(flag(null), jobs, () => undefined)).toBe('up-to-date');
    expect(jobs.started).toBe(0);
  });

  test('waits while a job is running', async () => {
    const stale = flag('2026-10-12T00:00:00Z');
    const jobs = ingestion(true);
    expect(await runIngestion(stale, jobs, () => undefined)).toBe('job-running');
    expect(jobs.started).toBe(0);
    expect(stale.value).not.toBeNull();
  });

  test('starts one job and clears the flag', async () => {
    const stale = flag('2026-10-12T00:00:00Z');
    const jobs = ingestion(false);
    expect(await runIngestion(stale, jobs, () => undefined)).toBe('started');
    expect(jobs.started).toBe(1);
    expect(stale.value).toBeNull();
  });

  test('keeps the flag when a newer change arrives during the start', async () => {
    const stale = flag('2026-10-12T00:00:00Z');
    const jobs: Ingestion = {
      running: async () => false,
      start: async () => {
        await stale.mark('2026-10-12T00:05:00Z');
        return 'job-1';
      },
    };
    await runIngestion(stale, jobs, () => undefined);
    expect(stale.value).toBe('2026-10-12T00:05:00Z');
  });
});

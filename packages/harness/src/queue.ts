import type { ClipResult } from '@chrona/protocol';
import type { Segment } from './recorder.js';

export type ClipJobStatus = 'queued' | 'rendering' | 'ready' | 'failed';

export interface ClipJob {
  segment: Segment;
  status: ClipJobStatus;
  result?: ClipResult;
  error?: string;
}

/**
 * Single-worker FIFO render queue. One clip at a time on purpose: the video
 * service owns the GPU and v1 never needs concurrency.
 */
export class ClipQueue {
  private readonly items: ClipJob[] = [];
  private draining = false;

  constructor(
    private readonly render: (segment: Segment, previous?: Segment) => Promise<ClipResult>,
    private readonly onUpdate?: (jobs: readonly ClipJob[]) => void,
  ) {}

  get jobs(): readonly ClipJob[] {
    return this.items;
  }

  enqueue(segments: Segment[]): void {
    for (const segment of segments) this.items.push({ segment, status: 'queued' });
    this.notify();
  }

  private notify(): void {
    this.onUpdate?.(this.items);
  }

  /** Render every queued clip in order. Safe to call while already draining. */
  async drain(): Promise<readonly ClipJob[]> {
    if (this.draining) return this.items;
    this.draining = true;
    try {
      for (const job of this.items) {
        if (job.status !== 'queued') continue;
        job.status = 'rendering';
        this.notify();
        try {
          job.result = await this.render(job.segment, this.previousOf(job));
          job.status = job.result.ok ? 'ready' : 'failed';
        } catch (error) {
          job.status = 'failed';
          job.error = (error as Error).message;
        }
        this.notify();
      }
    } finally {
      this.draining = false;
    }
    return this.items;
  }

  private previousOf(job: ClipJob): Segment | undefined {
    const index = this.items.indexOf(job);
    return index > 0 ? this.items[index - 1].segment : undefined;
  }
}

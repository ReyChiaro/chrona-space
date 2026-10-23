import type { ClipEvent, ClipEventKind, ClipSpec, FramePacket } from '@chrona/protocol';
import type { World } from '@chrona/world';

export interface RecordedSession {
  frames: FramePacket[];
  events: ClipEvent[];
  startedAtMs: number;
  endedAtMs: number;
}

export interface Segment {
  index: number;
  clipId: string;
  frames: FramePacket[];
  events: ClipEvent[];
  startMs: number;
}

const FRAME_MS = 1000 / 24;

/**
 * Records the game camera at 24 fps. This is the only place frames are sampled
 * for rendering — UI overlays never reach it.
 */
export class Recorder {
  private frames: FramePacket[] = [];
  private events: ClipEvent[] = [];
  private startedAtMs = 0;
  private lastTickMs = 0;
  private accumulator = 0;
  private recording = false;

  constructor(private readonly world: World) {}

  get isRecording(): boolean {
    return this.recording;
  }

  get durationMs(): number {
    return this.recording ? this.world.simTimeMs - this.startedAtMs : 0;
  }

  start(): void {
    this.frames = [];
    this.events = [];
    this.startedAtMs = this.world.simTimeMs;
    this.lastTickMs = this.startedAtMs;
    this.accumulator = 0;
    this.recording = true;
  }

  /** Call once per rendered frame; samples internally at 24 fps. */
  tick(): void {
    if (!this.recording) return;
    const now = this.world.simTimeMs;
    this.accumulator += now - this.lastTickMs;
    this.lastTickMs = now;
    // Fixed-step sampling: 60 Hz simulation must still yield 24 fps of frames.
    while (this.accumulator >= FRAME_MS) {
      this.frames.push(this.world.frame());
      this.accumulator -= FRAME_MS;
    }
  }

  event(kind: ClipEventKind, summary: string, chunkId?: string): void {
    this.events.push({
      tMs: this.world.simTimeMs - this.startedAtMs,
      kind,
      summary,
      chunkId,
      sceneVersionAfter: this.world.chunks.currentChunkId
        ? (this.world.chunks.find(this.world.chunks.currentChunkId)?.sceneVersion ?? 0)
        : 0,
    });
  }

  stop(): RecordedSession {
    this.recording = false;
    return {
      frames: this.frames,
      events: this.events,
      startedAtMs: this.startedAtMs,
      endedAtMs: this.world.simTimeMs,
    };
  }
}

/**
 * Split a session into ClipSpec-sized segments with a fixed overlap.
 * N = 1 when the session fits, otherwise 1 + ceil((total - frames) / (frames - overlap)).
 */
export function segmentSession(
  session: RecordedSession,
  spec: ClipSpec,
  overlapFrames: number,
  clipIdPrefix = 'clip',
): Segment[] {
  const total = session.frames.length;
  if (total === 0) return [];
  const stride = Math.max(1, spec.frames - overlapFrames);
  const segments: Segment[] = [];
  let start = 0;
  let index = 0;
  while (start < total) {
    const end = Math.min(total, start + spec.frames);
    const frames = session.frames.slice(start, end);
    const startMs = frames[0]?.simTimeMs ?? 0;
    const endMs = frames.at(-1)?.simTimeMs ?? startMs;
    segments.push({
      index,
      clipId: `${clipIdPrefix}_${String(index).padStart(4, '0')}`,
      frames,
      events: session.events
        .filter((event) => event.tMs + session.startedAtMs >= startMs && event.tMs + session.startedAtMs <= endMs)
        .map((event) => ({ ...event, tMs: Math.max(0, event.tMs + session.startedAtMs - startMs) })),
      startMs,
    });
    index += 1;
    if (end >= total) break;
    start += stride;
  }
  return segments;
}

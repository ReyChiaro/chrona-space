import type { ClipRequest, ClipResult, ModelProfile } from '@chrona/protocol';

export interface VideoGenerator {
  readonly name: string;
  probe(): Promise<boolean>;
  profiles(): Promise<ModelProfile[]>;
  generate(request: ClipRequest): Promise<ClipResult>;
  /** Upload the blockout recording used as <Video 1>. Optional for offline. */
  uploadSource?(uploadId: string, blob: Blob): Promise<void>;
}

const DEFAULT_PROFILE: ModelProfile = {
  profileId: 'stub-profile',
  displayName: 'Stub (no model)',
  workflow: 'stub',
  capabilities: {
    fps: [24],
    durationSec: { min: 5, max: 15 },
    canvasPresets: [{ width: 1344, height: 768 }],
    stepsRange: { min: 1, max: 60 },
    maxRefs: { image: 9, video: 3, audio: 3 },
    supports: { depth: false, idMask: false, normal: false, cameraPose: false },
    deterministic: true,
  },
  loras: [],
};

/** Talks to services/video-generator over HTTP. Never embeds prompt logic. */
export class HttpVideoGenerator implements VideoGenerator {
  readonly name = 'http-video-generator';

  constructor(private readonly baseUrl: string) {}

  async probe(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(800) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async profiles(): Promise<ModelProfile[]> {
    const response = await fetch(`${this.baseUrl}/profiles`);
    if (!response.ok) throw new Error(`profiles failed: ${response.status}`);
    return (await response.json()) as ModelProfile[];
  }

  async generate(request: ClipRequest): Promise<ClipResult> {
    const response = await fetch(`${this.baseUrl}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`generate failed: ${response.status}`);
    const { jobId } = (await response.json()) as { jobId: string };
    return this.waitForJob(jobId);
  }

  /** Long-running generation: the service owns the GPU, we poll. */
  private async waitForJob(jobId: string): Promise<ClipResult> {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const response = await fetch(`${this.baseUrl}/jobs/${jobId}`);
      if (!response.ok) throw new Error(`job ${jobId} not found`);
      const job = (await response.json()) as {
        status: string;
        result?: ClipResult;
        error?: string;
      };
      if (job.status === 'done' && job.result) return job.result;
      if (job.status === 'failed') throw new Error(job.error ?? 'generation failed');
    }
    throw new Error(`job ${jobId} timed out`);
  }

  async uploadSource(uploadId: string, blob: Blob): Promise<void> {
    const response = await fetch(`${this.baseUrl}/clips/${uploadId}/source`, {
      method: 'PUT',
      headers: { 'content-type': blob.type || 'video/webm' },
      body: blob,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`upload failed: ${response.status}`);
  }

  async config(): Promise<{ agentEnabled: boolean; loras: { id: string; label: string }[] }> {
    const response = await fetch(`${this.baseUrl}/config`);
    if (!response.ok) throw new Error(`config failed: ${response.status}`);
    return (await response.json()) as { agentEnabled: boolean; loras: { id: string; label: string }[] };
  }
}

/** Used when the service is not running: the clip is queued and marked degraded. */
export class OfflineVideoGenerator implements VideoGenerator {
  readonly name = 'offline';

  constructor(private readonly reason = 'video-generator offline') {}

  async probe(): Promise<boolean> {
    return false;
  }

  async profiles(): Promise<ModelProfile[]> {
    return [DEFAULT_PROFILE];
  }

  async generate(request: ClipRequest): Promise<ClipResult> {
    return {
      clipId: request.clipId,
      ok: false,
      posterFrames: [],
      frameIndex: request.frames.map((frame) => ({
        frameIdx: frame.frameId,
        camera: frame.camera,
        tick: frame.tick,
        sceneVersion: 0,
      })),
      meta: {
        profileId: request.profileId,
        adapterVersion: '0',
        workflow: 'stub',
        promptHash: '',
        refsHash: '',
        seed: request.params.seed,
        steps: request.params.steps,
        loras: request.params.loras,
        costMs: 0,
        gpuIds: [],
        degraded: this.reason,
      },
    };
  }
}

/** Chooses HTTP when the service answers, otherwise the offline stub. */
export async function createVideoGenerator(baseUrl: string): Promise<VideoGenerator> {
  const http = new HttpVideoGenerator(baseUrl);
  return (await http.probe()) ? http : new OfflineVideoGenerator();
}

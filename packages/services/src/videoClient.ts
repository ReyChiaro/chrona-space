import type { ClipRequest, ClipResult, ModelProfile } from '@chrona/protocol';

export interface VideoGenerator {
  readonly name: string;
  probe(): Promise<boolean>;
  profiles(): Promise<ModelProfile[]>;
  generate(request: ClipRequest): Promise<ClipResult>;
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
    return (await response.json()) as ClipResult;
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

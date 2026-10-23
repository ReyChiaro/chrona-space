import type {
  AssetBundle,
  AssetRequest,
  ClipRequest,
  ClipResult,
  ClipSpec,
  RenderParams,
  SceneSnapshot,
  TerrainEdit,
  TerrainEditDraft,
  Vec3,
} from '@chrona/protocol';
import type { Archive, ViewpointMemory, WorldStore } from '@chrona/storage';
import { TerrainField, type World } from '@chrona/world';
import { assembleClipRequest, DEFAULT_CLIP_SPEC, DEFAULT_RENDER_PARAMS } from './clip.js';
import { Recorder, segmentSession, type Segment } from './recorder.js';
import { validateBundle, type ValidationResult } from './validation.js';
import type { CodeAgent } from '@chrona/services';
import type { VideoGenerator } from '@chrona/services';

export interface HarnessOptions {
  worldId: string;
  world: World;
  archive: Archive;
  agent: CodeAgent;
  video: VideoGenerator;
  memory: ViewpointMemory;
  store?: WorldStore;
  profileId?: string;
  spec?: ClipSpec;
  params?: RenderParams;
  overlapFrames?: number;
  /** Renderer hook: returns a captured game-camera frame, or undefined headless. */
  captureFrame?: () => Promise<import('@chrona/protocol').ImageRef | undefined>;
}

export interface AssetOutcome {
  nodeId: string;
  bundle: AssetBundle;
  validation: ValidationResult;
}

export interface TerrainPreview {
  draft: TerrainEditDraft;
  affectedChunks: string[];
}

/**
 * Orchestrates creation, terrain editing and the record → render pipeline.
 * Stateless apart from the queue; all world truth lives in `World`.
 */
export class Harness {
  readonly world: World;
  readonly archive: Archive;
  readonly agent: CodeAgent;
  readonly video: VideoGenerator;
  readonly memory: ViewpointMemory;
  readonly recorder: Recorder;

  private readonly worldId: string;
  private readonly store?: WorldStore;
  private readonly profileId: string;
  private readonly spec: ClipSpec;
  private paramsValue: RenderParams;
  private overlapValue: number;
  private sampleStrideValue = 8;
  private readonly captureFrame?: HarnessOptions['captureFrame'];

  private editSeq = 0;
  private clipCounter = 0;
  private lastOutcome?: AssetOutcome;

  constructor(options: HarnessOptions) {
    this.worldId = options.worldId;
    this.world = options.world;
    this.archive = options.archive;
    this.agent = options.agent;
    this.video = options.video;
    this.memory = options.memory;
    this.store = options.store;
    this.profileId = options.profileId ?? 'stub-profile';
    this.spec = options.spec ?? DEFAULT_CLIP_SPEC;
    this.paramsValue = { ...(options.params ?? DEFAULT_RENDER_PARAMS) };
    this.overlapValue = options.overlapFrames ?? 48;
    this.captureFrame = options.captureFrame;
    this.recorder = new Recorder(options.world);
  }

  get clipSpec(): ClipSpec {
    return this.spec;
  }

  get renderParams(): RenderParams {
    return this.paramsValue;
  }

  get overlapFrames(): number {
    return this.overlapValue;
  }

  get sampleStride(): number {
    return this.sampleStrideValue;
  }

  /** Live-updated from the parameter panel; affects the next clip only. */
  setParams(patch: Partial<RenderParams>): void {
    this.paramsValue = { ...this.paramsValue, ...patch };
  }

  setOverlapFrames(frames: number): void {
    this.overlapValue = Math.max(0, Math.min(this.spec.frames - 1, Math.round(frames)));
  }

  setSampleStride(stride: number): void {
    this.sampleStrideValue = Math.max(1, Math.round(stride));
  }

  /** Create (or modify) one asset from natural language. */
  async createAsset(
    text: string,
    position?: Vec3,
    rotationY = 0,
  ): Promise<AssetOutcome> {
    const snapshot = this.world.snapshot();
    const target = position
      ? { kind: 'point' as const, pos: position, footprintRadiusM: 1 }
      : this.resolveTarget();

    const request: AssetRequest = {
      requestId: `req_${this.clipCounter++}_${Date.now().toString(36)}`,
      worldId: this.worldId,
      chunkId: this.world.chunks.currentChunkId ?? undefined,
      op: position ? 'create' : 'create',
      target,
      intent: { text, refImages: [] },
      scene: snapshot,
      budget: { maxTriangles: 64_000, maxAssets: 24, maxScriptBytes: 512 * 1024 },
      constraints: { alignToGround: true },
    };

    const bundle = await this.agent.createAsset(request);
    const validation = validateBundle(bundle);
    if (!validation.ok && !bundle.degraded) {
      throw new Error(`asset rejected: ${validation.errors.join('; ')}`);
    }
    await this.archive.put(bundle);

    const spawn = position ?? this.spawnPointFor(target);
    const nodeId = this.world.bindAsset(bundle, spawn, rotationY);
    this.lastOutcome = { nodeId, bundle, validation };
    return this.lastOutcome;
  }

  get lastAsset(): AssetOutcome | undefined {
    return this.lastOutcome;
  }

  /** Seed the test room from the offline agent catalogue. */
  async seedRoom(items: { semantic: string; position: [number, number, number]; rotationY: number }[]): Promise<AssetOutcome[]> {
    const outcomes: AssetOutcome[] = [];
    for (const item of items) {
      outcomes.push(
        await this.createAsset(item.semantic, {
          x: item.position[0],
          y: item.position[1],
          z: item.position[2],
        }, item.rotationY),
      );
    }
    return outcomes;
  }

  /** Resolve where an edit should land (D-26). */
  resolveTarget(): AssetRequest['target'] {
    const hit = this.world.pick(120);
    if (hit) return { kind: 'point', pos: hit.point, footprintRadiusM: 2.5 };
    const camera = this.world.camera;
    const forward = new Vec3Like(camera.quat).forward();
    const fallback = {
      x: camera.pos.x + forward.x * 16,
      y: 0,
      z: camera.pos.z + forward.z * 16,
    };
    return { kind: 'point', pos: fallback, footprintRadiusM: 3 };
  }

  /** Draft a terrain edit. Nothing is written until `commitTerrain`. */
  async previewTerrain(text: string): Promise<TerrainPreview> {
    const target = this.resolveTarget();
    const draft = await this.agent.createTerrainEdit({
      requestId: `terrain_${this.editSeq}`,
      worldId: this.worldId,
      intent: { text },
      target,
      scene: this.world.snapshot(),
      constraints: { maxRadiusM: 6, allowWater: false },
    });
    return { draft, affectedChunks: TerrainField.affectedChunks(draft, this.world.chunks.size) };
  }

  /** Commit a previewed edit. Bumps scene versions so memory goes stale. */
  async commitTerrain(preview: TerrainPreview): Promise<TerrainEdit> {
    this.editSeq += 1;
    const edit: TerrainEdit = {
      editId: `edit_${String(this.editSeq).padStart(4, '0')}`,
      seq: this.editSeq,
      op: preview.draft.op,
      shape: preview.draft.shape,
      strength: preview.draft.strength,
      material: preview.draft.material,
      targetChunkIds: preview.affectedChunks,
      createdAt: new Date().toISOString(),
      author: 'user',
    };
    this.world.terrain.addEdit(edit);
    for (const chunkId of preview.affectedChunks) this.world.chunks.markDirty(chunkId);
    this.recorder.event('terrain', preview.draft.reason ?? `terrain ${edit.op}`);
    await this.persistTerrain();
    return edit;
  }

  private async persistTerrain(): Promise<void> {
    if (!this.store) return;
    await this.store.save({
      worldId: this.worldId,
      seed: this.world.terrain.config.seed,
      createdAt: new Date().toISOString(),
      terrainEdits: [...this.world.terrain.listEdits()],
    });
  }

  startRecording(): void {
    this.recorder.start();
  }

  /** Call once per rendered frame while recording. */
  tickRecording(): void {
    this.recorder.tick();
  }

  stopRecording(): Segment[] {
    const session = this.recorder.stop();
    return segmentSession(session, this.spec, this.overlapValue, `clip_${this.worldId}`);
  }

  /** Build the structured request for a segment (no prompt text, no model). */
  buildRequest(segment: Segment, previous?: Segment): ClipRequest {
    return assembleClipRequest(segment, this.world, this.memory, {
      worldId: this.worldId,
      profileId: this.profileId,
      spec: this.spec,
      params: this.paramsValue,
      previous,
    });
  }

  /** Send one segment to the video generator and return the result. */
  async renderSegment(segment: Segment, previous?: Segment): Promise<ClipResult> {
    const result = await this.video.generate(this.buildRequest(segment, previous));
    if (result.ok) this.rememberSegment(segment, result);
    return result;
  }

  /** Record the clip's frames into viewpoint memory (D-08). */
  private rememberSegment(segment: Segment, result: ClipResult): void {
    const stride = this.sampleStrideValue;
    for (let i = 0; i < segment.frames.length; i += stride) {
      const frame = segment.frames[i];
      const index = result.frameIndex.find((entry) => entry.frameIdx === frame.frameId) ?? result.frameIndex[0];
      if (!frame.rgb) continue;
      this.memory.record({
        camera: frame.camera,
        frame: frame.rgb,
        clipId: segment.clipId,
        tick: frame.tick,
        sceneVersion: index?.sceneVersion ?? 0,
      });
    }
  }

  /** Whole pipeline for a test path: returns every request that was sent. */
  async renderAll(segments: Segment[]): Promise<{ requests: ClipRequest[]; results: ClipResult[] }> {
    const requests: ClipRequest[] = [];
    const results: ClipResult[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const request = this.buildRequest(segment, segments[i - 1]);
      requests.push(request);
      results.push(await this.video.generate(request));
    }
    return { requests, results };
  }

  private spawnPointFor(target: AssetRequest['target']): Vec3 {
    if (target.kind === 'point') return target.pos;
    const camera = this.world.camera;
    return { x: camera.pos.x, y: 0, z: camera.pos.z };
  }
}

/** Tiny helper so the harness does not need three.js for one rotation. */
class Vec3Like {
  constructor(private readonly q: { x: number; y: number; z: number; w: number }) {}

  forward(): Vec3 {
    // Rotate (0,0,-1) by the quaternion.
    const { x, y, z, w } = this.q;
    const vx = 0;
    const vy = 0;
    const vz = -1;
    const ix = w * vx + y * vz - z * vy;
    const iy = w * vy + z * vx - x * vz;
    const iz = w * vz + x * vy - y * vx;
    const iw = -x * vx - y * vy - z * vz;
    return {
      x: ix * w + iw * -x + iy * -z - iz * -y,
      y: iy * w + iw * -y + iz * -x - ix * -z,
      z: iz * w + iw * -z + ix * -y - iy * -x,
    };
  }
}

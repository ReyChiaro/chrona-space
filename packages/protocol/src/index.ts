/**
 * Chrona protocol — the single source of truth for cross-module data shapes.
 *
 * Rules (see docs/v1/PROTOCOL.md):
 * - No module may import another module's implementation; only these types.
 * - No model names, canvas constants or profile-specific numbers belong here.
 */

export type WorldId = string;
export type ChunkId = string;
/** `${cx}_${cz}` for the 64 m grid, `${cx}_${cz}_${sx}_${sz}` for indoor sub-chunks. */
export type NodeId = string;
export type AssetId = string;
export type ClipId = string;
export type SemVer = string;
export type SurfaceClass = 'road' | 'sidewalk' | 'soil' | 'grass' | 'water' | 'floor';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface ImageRef {
  /** File path or data/object URL. */
  path: string;
  width: number;
  height: number;
  hash?: string;
}

export interface VideoRef extends ImageRef {
  fps: number;
  frames: number;
  durationMs: number;
}

export interface AudioRef {
  path: string;
  sampleRate: number;
  durationMs: number;
}

/** The only camera. Its frames are the only thing allowed into the render pipeline. */
export interface GameCamera {
  pos: Vec3;
  quat: Quat;
  fovDeg: number;
  near: number;
  far: number;
  aspect: number;
  eyeHeightM: number;
}

export type RenderLayer = 'world' | 'preview' | 'ui';

export interface FramePacket {
  frameId: number;
  tick: number;
  simTimeMs: number;
  camera: GameCamera;
  rgb?: ImageRef;
  passes?: { depth?: ImageRef; idMask?: ImageRef; normal?: ImageRef };
}

export interface AppearanceSpec {
  /** The only prose field allowed on an asset. */
  promptFragment: string;
  refImages: ImageRef[];
  palette: string[];
  roughness: number;
  scaleHint: 'small' | 'human' | 'large' | 'huge';
  styleTags: string[];
}

export interface ColliderSpec {
  type: 'cuboid' | 'ball' | 'cylinder';
  halfExtents?: Vec3;
  radius?: number;
  halfHeight?: number;
  offset?: Vec3;
}

export interface AssetBundle {
  assetId: AssetId;
  version: SemVer;
  /** Short human label, e.g. "工作台". Goes into prompts; never a whole sentence. */
  semantic: string;
  /** JS source, evaluated by the asset runtime as `new Function('THREE','RAPIER', src)`. */
  script: { source: string; hash: string };
  appearance: AppearanceSpec;
  physics: {
    mass: number;
    friction: number;
    restitution: number;
    kind: 'static' | 'dynamic' | 'kinematic';
  };
  colliders: ColliderSpec[];
  bounds: { min: Vec3; max: Vec3 };
  triCount: number;
  /** True for assets that only look right when fitted to a specific slope (stairs, ramps, bridges). */
  fitDependent: boolean;
  provenance: { worldId: WorldId; chunkId?: ChunkId; requestId: string; createdAt: string };
  degraded?: boolean;
}

export interface FocusObject {
  nodeId: NodeId;
  assetId: AssetId;
  semantic: string;
  appearance: AppearanceSpec;
  transform: { pos: Vec3; quat: Quat; scale: Vec3 };
  physics?: { massKg: number; velocity: Vec3; materialTag: string };
  distanceM: number;
  screenCoverage: number;
}

export interface NodeSummary {
  nodeId: NodeId;
  semantic: string;
  pos: Vec3;
  distanceM: number;
}

export interface SceneSnapshot {
  tick: number;
  camera: GameCamera;
  focus: FocusObject[];
  nearby: NodeSummary[];
  lod: 'near' | 'mid' | 'far';
}

export type Target =
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'point'; pos: Vec3; footprintRadiusM: number }
  | { kind: 'chunk'; chunkId: ChunkId; explicit: boolean }
  | { kind: 'front'; chunkId: ChunkId };

export interface AssetRequest {
  requestId: string;
  worldId: WorldId;
  chunkId?: ChunkId;
  op: 'create' | 'modify' | 'delete';
  target: Target;
  intent: { text: string; refImages: ImageRef[] };
  scene: SceneSnapshot;
  neighborDigest?: string;
  budget: { maxTriangles: number; maxAssets: number; maxScriptBytes: number };
  constraints: { keepClearRadiusM?: number; alignToGround?: boolean };
}

export type TerrainOp = 'raise' | 'lower' | 'flatten' | 'carve' | 'paint' | 'water';

export interface TerrainShape {
  kind: 'disc' | 'capsule' | 'box';
  center: Vec3;
  radius: number;
  halfLength?: number;
  rotationY?: number;
}

export interface TerrainEditDraft {
  op: TerrainOp;
  shape: TerrainShape;
  strength: number;
  material?: SurfaceClass;
  reason?: string;
}

export interface TerrainEditRequest {
  requestId: string;
  worldId: WorldId;
  intent: { text: string };
  target: Target;
  scene: SceneSnapshot;
  constraints: { maxRadiusM: number; allowWater: boolean };
}

export interface TerrainEdit {
  editId: string;
  seq: number;
  op: TerrainOp;
  shape: TerrainShape;
  strength: number;
  material?: SurfaceClass;
  targetChunkIds: ChunkId[];
  createdAt: string;
  author: 'user' | 'agent';
}

export type ClipEventKind = 'terrain' | 'asset.add' | 'asset.remove' | 'asset.modify' | 'teleport';

export interface ClipEvent {
  tMs: number;
  kind: ClipEventKind;
  summary: string;
  nodeId?: NodeId;
  chunkId?: ChunkId;
  sceneVersionAfter: number;
}

export interface ClipSpec {
  presetId: string;
  fps: number;
  frames: number;
}

export interface LoraSpec {
  id: string;
  weight: number;
}

export interface RenderParams {
  canvas: { width: number; height: number };
  steps: number;
  loras: LoraSpec[];
  seed: number;
  candidates: number;
  upscale: boolean;
  grain: number;
  lutId: string | null;
  audioLoudnessNorm: boolean;
}

export interface ObjectRef {
  nodeId: NodeId;
  assetId: AssetId;
  images: ImageRef[];
}

export interface ViewpointCell {
  x: number;
  y: number;
  z: number;
}

export interface ViewpointRecord {
  cell: ViewpointCell;
  visitCount: number;
  first: {
    frame: ImageRef;
    camera: GameCamera;
    clipId: ClipId;
    tick: number;
    sceneVersion: number;
  };
  latest: {
    frame: ImageRef;
    camera: GameCamera;
    clipId: ClipId;
    tick: number;
    sceneVersion: number;
  };
  stale?: boolean;
}

export interface ViewpointQuery {
  camera: GameCamera;
  radiusCells?: number;
  maxAngularDiffDeg?: number;
}

export interface ClipRequest {
  clipId: ClipId;
  worldId: WorldId;
  spec: ClipSpec;
  frames: FramePacket[];
  snapshot: SceneSnapshot;
  events: ClipEvent[];
  objectRefs: ObjectRef[];
  viewpointHistory: { cell: ViewpointCell; images: ImageRef[]; kinds: ('first' | 'latest')[] }[];
  prevClip?: { clipId: ClipId; tailFrames: ImageRef[]; tailSeconds: number };
  style: { stylePresetId: string };
  profileId: string;
  params: RenderParams;
}

export interface ClipResult {
  clipId: ClipId;
  ok: boolean;
  video?: VideoRef;
  audio?: AudioRef;
  posterFrames: ImageRef[];
  frameIndex: { frameIdx: number; camera: GameCamera; tick: number; sceneVersion: number }[];
  meta: {
    profileId: string;
    adapterVersion: string;
    workflow: string;
    promptHash: string;
    refsHash: string;
    seed: number;
    steps: number;
    loras: LoraSpec[];
    appliedAdjustments?: string[];
    costMs: number;
    gpuIds: number[];
    degraded?: string;
  };
}

export interface ModelProfile {
  profileId: string;
  displayName: string;
  workflow: string;
  capabilities: {
    fps: number[];
    durationSec: { min: number; max: number };
    canvasPresets: { width: number; height: number }[];
    stepsRange: { min: number; max: number };
    maxRefs: { image: number; video: number; audio: number };
    supports: { depth: boolean; idMask: boolean; normal: boolean; cameraPose: boolean };
    deterministic: boolean;
  };
  loras: { id: string; label: string; recommendedSteps?: number }[];
}

export type ChunkState =
  | 'unexplored'
  | 'prefetching'
  | 'generating'
  | 'validating'
  | 'committed'
  | 'active'
  | 'evicted';

export interface WorldNode {
  id: NodeId;
  parentId: NodeId | null;
  kind: 'root' | 'group' | 'asset' | 'light';
  transform: { pos: Vec3; quat: Quat; scale: Vec3 };
  assetRef?: { assetId: AssetId; version: SemVer };
  semantic?: string;
  chunkId?: ChunkId;
}

export type WorldEvent =
  | { type: 'node.added' | 'node.removed'; nodeId: NodeId; chunkId?: ChunkId }
  | { type: 'chunk.committed' | 'chunk.evicted'; chunkId: ChunkId }
  | { type: 'terrain.changed'; editId: string; chunkIds: ChunkId[]; sceneVersion: number }
  | { type: 'asset.needsReseat' | 'asset.needsRefit'; nodeId: NodeId; deltaY?: number }
  | { type: 'clip.ready' | 'clip.failed'; clipId: ClipId };

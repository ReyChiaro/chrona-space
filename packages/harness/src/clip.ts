import type {
  ClipRequest,
  ClipSpec,
  ImageRef,
  RenderParams,
  SceneSnapshot,
} from '@chrona/protocol';
import type { Segment } from './recorder.js';
import type { ViewpointMemory } from '@chrona/storage';
import type { World } from '@chrona/world';

export const DEFAULT_CLIP_SPEC: ClipSpec = { presetId: 'std-16x9-124f', fps: 24, frames: 124 };

export const DEFAULT_RENDER_PARAMS: RenderParams = {
  canvas: { width: 1344, height: 768 },
  steps: 32,
  loras: [],
  seed: 42,
  candidates: 1,
  upscale: false,
  grain: 0.35,
  lutId: 'film-neutral',
  audioLoudnessNorm: true,
};

export interface AssembleOptions {
  worldId: string;
  profileId: string;
  spec: ClipSpec;
  params: RenderParams;
  previous?: Segment;
  /** Frames of the previous segment's tail, if the renderer captured images. */
  previousTail?: ImageRef[];
  blockout?: ClipRequest['blockout'];
}

/**
 * Turn one recorded segment into the structured request the video generator
 * consumes. No prompt text is produced here (D-14).
 */
export function assembleClipRequest(
  segment: Segment,
  world: World,
  memory: ViewpointMemory,
  options: AssembleOptions,
): ClipRequest {
  const snapshot: SceneSnapshot = world.snapshot();
  const firstFrame = segment.frames[0];

  const history = firstFrame
    ? memory.query({ camera: firstFrame.camera, radiusCells: 1, maxAngularDiffDeg: 45 }).slice(0, 1)
    : [];

  return {
    clipId: segment.clipId,
    worldId: options.worldId,
    spec: options.spec,
    frames: segment.frames,
    snapshot,
    events: segment.events,
    objectRefs: snapshot.focus.slice(0, 2).map((focus) => ({
      nodeId: focus.nodeId,
      assetId: focus.assetId,
      images: focus.appearance.refImages,
    })),
    viewpointHistory: history.map((record) => {
      const images = [record.first.frame, record.latest.frame].filter(
        (image, index, all) => all.findIndex((other) => other.path === image.path) === index,
      );
      return { cell: record.cell, images, kinds: images.length > 1 ? ['first', 'latest'] : ['first'] };
    }),
    prevClip:
      options.previous && options.previousTail?.length
        ? {
            clipId: options.previous.clipId,
            tailFrames: options.previousTail,
            tailSeconds: options.previousTail.length / options.spec.fps,
          }
        : undefined,
    blockout: options.blockout,
    style: { stylePresetId: 'film-neutral' },
    profileId: options.profileId,
    params: options.params,
  };
}

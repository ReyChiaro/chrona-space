import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { AssetBundle, ColliderSpec, Vec3 } from '@chrona/protocol';

export interface RuntimeAsset {
  object3d: THREE.Object3D;
  colliders: ColliderSpec[];
  bounds: { min: Vec3; max: Vec3 };
  triCount: number;
}

export interface AssetContext {
  nodeId: string;
  assetId: string;
  position: Vec3;
  rotationY: number;
}

/**
 * Asset scripts are plain function bodies with a fixed signature:
 *
 *   (THREE, RAPIER, ctx) => ({ object3d, colliders, bounds, triCount })
 *
 * Executing author-supplied code in-process is a deliberate v1 shortcut.
 * The worker-based sandbox from SPEC §6.4 lands with the real Code Agent.
 */
export function instantiateAsset(bundle: AssetBundle, ctx: AssetContext): RuntimeAsset {
  const factory = new Function('THREE', 'RAPIER', 'ctx', bundle.script.source) as (
    three: typeof THREE,
    rapier: typeof RAPIER,
    context: AssetContext,
  ) => RuntimeAsset;

  const asset = factory(THREE, RAPIER, ctx);
  if (!asset || !(asset.object3d instanceof THREE.Object3D)) {
    throw new Error(`asset ${bundle.assetId} did not return an Object3D`);
  }
  if (!Array.isArray(asset.colliders)) {
    throw new Error(`asset ${bundle.assetId} did not return colliders[]`);
  }

  asset.object3d.position.set(ctx.position.x, ctx.position.y, ctx.position.z);
  asset.object3d.rotation.y = ctx.rotationY;
  return asset;
}

/** Total triangle count of a subtree, ignoring non-mesh nodes. */
export function countTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    if (index) total += index.count / 3;
    else if (position) total += position.count / 3;
  });
  return Math.round(total);
}

/** World-space bounds of a subtree. */
export function computeBounds(root: THREE.Object3D): { min: Vec3; max: Vec3 } {
  const box = new THREE.Box3().setFromObject(root);
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };
}

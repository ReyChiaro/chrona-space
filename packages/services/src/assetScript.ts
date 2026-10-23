import type { Vec3 } from '@chrona/protocol';

export interface AssetPart {
  size: [number, number, number];
  offset: [number, number, number];
  color: string;
  roughness: number;
}

export interface AssetSpec {
  assetId: string;
  semantic: string;
  promptFragment: string;
  parts: AssetPart[];
  palette: string[];
  scaleHint: 'small' | 'human' | 'large' | 'huge';
  styleTags: string[];
  fitDependent?: boolean;
  roughness?: number;
}

import type { ColliderSpec } from '@chrona/protocol';

export interface CompiledScript {
  source: string;
  bounds: { min: Vec3; max: Vec3 };
  triCount: number;
  colliders: ColliderSpec[];
}

/**
 * Compile a primitive spec into a three.js script body.
 * The runtime evaluates it as `new Function('THREE','RAPIER','ctx', source)`.
 */
export function compileAssetScript(spec: AssetSpec): CompiledScript {
  const parts = spec.parts.map((part) => ({
    s: part.size,
    o: part.offset,
    c: part.color,
    r: part.roughness,
  }));

  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const part of spec.parts) {
    for (let axis = 0; axis < 3; axis += 1) {
      const centre = part.offset[axis];
      const half = part.size[axis] / 2;
      const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
      min[key] = Math.min(min[key], centre - half);
      max[key] = Math.max(max[key], centre + half);
    }
  }

  const source = `const PARTS = ${JSON.stringify(parts)};
const group = new THREE.Group();
const colliders = [];
const materials = new Map();
for (const part of PARTS) {
  let material = materials.get(part.c);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color: part.c, roughness: part.r, metalness: 0.04 });
    materials.set(part.c, material);
  }
  const geometry = new THREE.BoxGeometry(part.s[0], part.s[1], part.s[2]);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(part.o[0], part.o[1], part.o[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  colliders.push({
    type: 'cuboid',
    halfExtents: { x: part.s[0] / 2, y: part.s[1] / 2, z: part.s[2] / 2 },
    offset: { x: part.o[0], y: part.o[1], z: part.o[2] },
  });
}
return {
  object3d: group,
  colliders,
  bounds: ${JSON.stringify({ min, max })},
  triCount: ${spec.parts.length * 12},
};
`;

  const colliders: ColliderSpec[] = spec.parts.map((part) => ({
    type: 'cuboid',
    halfExtents: { x: part.size[0] / 2, y: part.size[1] / 2, z: part.size[2] / 2 },
    offset: { x: part.offset[0], y: part.offset[1], z: part.offset[2] },
  }));

  return { source, bounds: { min, max }, triCount: spec.parts.length * 12, colliders };
}

/** Convenience: one box centred on `base` (y is the bottom of the box). */
export function box(
  size: [number, number, number],
  at: [number, number, number],
  color: string,
  roughness = 0.75,
): AssetPart {
  return { size, offset: at, color, roughness };
}

/** Place a box so that its bottom sits at `y`. */
export function boxOnGround(
  size: [number, number, number],
  at: [number, number, number],
  color: string,
  roughness = 0.75,
): AssetPart {
  return { size, offset: [at[0], at[1] + size[1] / 2, at[2]], color, roughness };
}

import * as THREE from 'three';
import type { SurfaceClass, TerrainEditDraft } from '@chrona/protocol';
import type { TerrainField } from '@chrona/world';

const SURFACE_COLOURS: Record<SurfaceClass, number> = {
  floor: 0x6b5a44,
  soil: 0x5b4634,
  grass: 0x4f6b43,
  water: 0x2b4a63,
  road: 0x4a4a4a,
  sidewalk: 0x6a6a66,
};

export interface Bounds {
  min: { x: number; z: number };
  max: { x: number; z: number };
}

/** Flat-shaded terrain patch used as the room floor. Rebuilt after every commit. */
export function buildTerrainMesh(terrain: TerrainField, bounds: Bounds, resolution = 48): THREE.Mesh {
  const width = bounds.max.x - bounds.min.x;
  const depth = bounds.max.z - bounds.min.z;
  const geometry = new THREE.PlaneGeometry(width, depth, resolution, resolution);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colours = new Float32Array(position.count * 3);
  const colour = new THREE.Color();

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i) + (bounds.min.x + width / 2);
    const z = position.getZ(i) + (bounds.min.z + depth / 2);
    position.setX(i, x);
    position.setZ(i, z);
    position.setY(i, terrain.heightAt(x, z) - 0.002);
    colour.setHex(SURFACE_COLOURS[terrain.surfaceAt(x, z)]);
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Preview surface for a draft edit. Rendered with the real surface colour at
 * partial opacity — never with UI accent colours (D-34).
 */
export function buildPreviewMesh(terrain: TerrainField, draft: TerrainEditDraft, segments = 40): THREE.Mesh {
  const radius = draft.shape.radius;
  const centre = draft.shape.center;
  const geometry = new THREE.CircleGeometry(radius, segments, 0, Math.PI * 2);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i) + centre.x;
    const z = position.getZ(i) + centre.z;
    position.setX(i, x);
    position.setZ(i, z);
    position.setY(i, terrain.previewHeightAt(x, z, draft));
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: SURFACE_COLOURS[draft.material ?? 'soil'],
    transparent: true,
    opacity: 0.5,
    roughness: 0.9,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  return mesh;
}

import type { SurfaceClass, TerrainEdit, TerrainEditDraft, Vec3 } from '@chrona/protocol';
import { fbm2D, hashString, ridged2D } from './noise.js';

/**
 * Terrain is a pure function of (x, z) plus an ordered list of edits.
 * Heights are never stored (see docs/v1/TERRAIN.md §1).
 */

export interface TerrainConfig {
  /** World seed; every noise layer derives its own sub-seed from it. */
  seed: number;
  /** Flat base elevation. Indoor worlds use 0 with amplitude 0. */
  baseHeight: number;
  /** Global relief scale. 0 produces a perfectly flat floor. */
  amplitude: number;
  waterLevel: number;
  /** Indoor rooms disable noise layers and report `floor` as the surface. */
  profile: 'outdoor' | 'indoor';
}

export const DEFAULT_TERRAIN: TerrainConfig = {
  seed: 1,
  baseHeight: 0,
  amplitude: 0,
  waterLevel: -10,
  profile: 'indoor',
};

/** Smootherstep falloff: 1 at the centre of a shape, 0 at its edge. */
export function falloff(distance: number, radius: number): number {
  if (radius <= 0) return 0;
  const t = Math.min(1, Math.max(0, 1 - distance / radius));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function distanceToShape(x: number, z: number, edit: TerrainEdit | TerrainEditDraft): number {
  const { kind, center, radius, halfLength = 0, rotationY = 0 } = edit.shape;
  if (kind === 'disc') return Math.hypot(x - center.x, z - center.z);
  if (kind === 'capsule') {
    const dx = x - center.x;
    const dz = z - center.z;
    const cos = Math.cos(-rotationY);
    const sin = Math.sin(-rotationY);
    const along = dx * cos - dz * sin;
    const across = dx * sin + dz * cos;
    const clamped = Math.max(-halfLength, Math.min(halfLength, along));
    return Math.hypot(across, along - clamped);
  }
  const dx = Math.abs(x - center.x);
  const dz = Math.abs(z - center.z);
  return Math.hypot(Math.max(0, dx - radius), Math.max(0, dz - radius));
}

export class TerrainField {
  readonly config: TerrainConfig;
  private edits: TerrainEdit[] = [];

  constructor(config: Partial<TerrainConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN, ...config };
  }

  /** Content version, bumped whenever an edit lands. */
  get version(): string {
    return hashString(JSON.stringify([this.config, this.edits.map((e) => e.editId)]));
  }

  get editCount(): number {
    return this.edits.length;
  }

  listEdits(): readonly TerrainEdit[] {
    return this.edits;
  }

  /** Height of the natural (noise-only) surface. */
  baseHeightAt(x: number, z: number): number {
    const { seed, baseHeight, amplitude, profile } = this.config;
    if (profile === 'indoor' || amplitude === 0) return baseHeight;
    const broad = fbm2D(seed, x, z, { octaves: 4, frequency: 1 / 512 });
    const ridge = ridged2D(seed + 17, x, z, { octaves: 3, frequency: 1 / 256 });
    const detail = fbm2D(seed + 31, x, z, { octaves: 2, frequency: 1 / 16 });
    return baseHeight + amplitude * (broad * 0.6 + ridge * 0.4) + detail * 0.4;
  }

  /** Final height including every committed edit, applied in `seq` order. */
  heightAt(x: number, z: number): number {
    let h = this.baseHeightAt(x, z);
    for (const edit of this.edits) h = applyHeightEdit(h, x, z, edit);
    return h;
  }

  /** Surface material at a point: natural field first, then `paint` edits in order. */
  surfaceAt(x: number, z: number): SurfaceClass {
    let surface: SurfaceClass =
      this.config.profile === 'indoor'
        ? 'floor'
        : fbm2D(this.config.seed + 73, x, z, { octaves: 2, frequency: 1 / 128 }) > 0.15
          ? 'grass'
          : 'soil';
    for (const edit of this.edits) {
      if (edit.op !== 'paint' || !edit.material) continue;
      const weight = falloff(distanceToShape(x, z, edit), edit.shape.radius) * edit.strength;
      if (weight > 0.5) surface = edit.material;
    }
    return surface;
  }

  /** Normal by central differences; used for asset seating and camera pitch. */
  normalAt(x: number, z: number, eps = 0.5): Vec3 {
    const hL = this.heightAt(x - eps, z);
    const hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps);
    const hU = this.heightAt(x, z + eps);
    const nx = hL - hR;
    const nz = hD - hU;
    const ny = 2 * eps;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** Height with a draft edit appended — used for preview, never committed. */
  previewHeightAt(x: number, z: number, draft: TerrainEditDraft): number {
    return applyHeightEdit(this.heightAt(x, z), x, z, {
      editId: 'preview',
      seq: Number.MAX_SAFE_INTEGER,
      targetChunkIds: [],
      createdAt: '',
      author: 'user',
      ...draft,
    });
  }

  addEdit(edit: TerrainEdit): void {
    if (this.edits.some((e) => e.editId === edit.editId)) return; // idempotent
    this.edits.push(edit);
    this.edits.sort((a, b) => a.seq - b.seq);
  }

  removeLastEdit(): TerrainEdit | undefined {
    return this.edits.pop();
  }

  /** Chunk ids touched by an edit, using the effective radius (R_eff = radius + 8 m). */
  static affectedChunks(edit: TerrainEditDraft, chunkSize = 64): string[] {
    const r = edit.shape.radius + 8;
    const { x, z } = edit.shape.center;
    const minX = Math.floor((x - r) / chunkSize);
    const maxX = Math.floor((x + r) / chunkSize);
    const minZ = Math.floor((z - r) / chunkSize);
    const maxZ = Math.floor((z + r) / chunkSize);
    const ids: string[] = [];
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cz = minZ; cz <= maxZ; cz += 1) ids.push(`${cx}_${cz}`);
    }
    return ids;
  }
}

function applyHeightEdit(h: number, x: number, z: number, edit: TerrainEdit | TerrainEditDraft): number {
  const distance = distanceToShape(x, z, edit);
  if (distance >= edit.shape.radius) return h;
  const w = falloff(distance, edit.shape.radius);
  switch (edit.op) {
    case 'raise':
      return h + edit.strength * w;
    case 'lower':
    case 'carve':
      return h - edit.strength * w;
    case 'flatten': {
      const target = edit.shape.center.y;
      return h + (target - h) * Math.min(1, edit.strength) * w;
    }
    case 'paint':
    case 'water':
      return h;
    default:
      return h;
  }
}

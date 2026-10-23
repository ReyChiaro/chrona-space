/** Deterministic value noise. Purely a function of (seed, x, z) — no global state. */

const HASH_PRIME_X = 0x27d4eb2d;
const HASH_PRIME_Z = 0x165667b1;

/** 32-bit integer hash of a lattice point, mapped to [-1, 1]. */
export function hashLattice(seed: number, ix: number, iz: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ ix, HASH_PRIME_X);
  h = Math.imul(h ^ iz, HASH_PRIME_Z);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth value noise in [-1, 1]. */
export function valueNoise2D(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fz = fade(z - iz);
  const n00 = hashLattice(seed, ix, iz);
  const n10 = hashLattice(seed, ix + 1, iz);
  const n01 = hashLattice(seed, ix, iz + 1);
  const n11 = hashLattice(seed, ix + 1, iz + 1);
  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fz);
}

export interface FbmOptions {
  octaves: number;
  frequency: number;
  lacunarity?: number;
  gain?: number;
}

/** Fractal Brownian motion built from value noise. */
export function fbm2D(seed: number, x: number, z: number, options: FbmOptions): number {
  const { octaves, frequency, lacunarity = 2, gain = 0.5 } = options;
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  let f = frequency;
  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * valueNoise2D(seed + i * 1013, x * f, z * f);
    norm += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
}

/** Ridged multifractal, returns [0, 1] — used for mountain ridges. */
export function ridged2D(seed: number, x: number, z: number, options: FbmOptions): number {
  const { octaves, frequency, lacunarity = 2, gain = 0.5 } = options;
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  let f = frequency;
  for (let i = 0; i < octaves; i += 1) {
    const n = 1 - Math.abs(valueNoise2D(seed + i * 7919, x * f, z * f));
    sum += amplitude * n * n;
    norm += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
}

/** Stable 53-bit hash of a string, for content addressing. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

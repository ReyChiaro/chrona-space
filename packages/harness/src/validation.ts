import type { AssetBundle } from '@chrona/protocol';
import { countTriangles, instantiateAsset } from '@chrona/world';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  triCount: number;
  colliders: number;
}

/**
 * V1–V6 from CHRONA_SPEC §6.3. Runs in the host process; the agent's own
 * self-check is never trusted.
 */
export function validateBundle(bundle: AssetBundle): ValidationResult {
  const errors: string[] = [];

  if (!bundle.assetId || !bundle.version) errors.push('V0 missing assetId/version');
  if (!bundle.script?.source) errors.push('V1 empty script');
  if (!bundle.appearance?.promptFragment) errors.push('V5 missing promptFragment');
  if (!bundle.appearance?.palette?.length) errors.push('V5 empty palette');
  if (bundle.appearance?.refImages?.some((image) => !image.path)) errors.push('V5 broken refImages');

  let triCount = 0;
  let colliders = 0;
  try {
    const runtime = instantiateAsset(bundle, {
      nodeId: 'validate',
      assetId: bundle.assetId,
      position: { x: 0, y: 0, z: 0 },
      rotationY: 0,
    });
    triCount = countTriangles(runtime.object3d);
    colliders = runtime.colliders.length;

    const values = [
      runtime.bounds.min.x,
      runtime.bounds.min.y,
      runtime.bounds.min.z,
      runtime.bounds.max.x,
      runtime.bounds.max.y,
      runtime.bounds.max.z,
    ];
    if (values.some((value) => !Number.isFinite(value))) errors.push('V2 non-finite bounds');
    if (Math.max(...values.map(Math.abs)) > 4096) errors.push('V2 bounds outside chunk space');
    if (triCount > 64_000) errors.push(`V3 triangle budget exceeded: ${triCount}`);
    if (colliders === 0) errors.push('V4 no colliders');
  } catch (error) {
    errors.push(`V1 script failed: ${(error as Error).message}`);
  }

  return { ok: errors.length === 0, errors, triCount, colliders };
}

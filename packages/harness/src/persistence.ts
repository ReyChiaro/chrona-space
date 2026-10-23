import type { TerrainEdit } from '@chrona/protocol';
import type { Archive } from '@chrona/storage';
import type { World } from '@chrona/world';

export interface SavedNode {
  assetId: string;
  version: string;
  pos: [number, number, number];
  rotY: number;
}

export interface SavedWorld {
  seed: number;
  createdAt: string;
  edits: TerrainEdit[];
  nodes: SavedNode[];
}

function yawOf(quat: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (quat.w * quat.y + quat.x * quat.z), 1 - 2 * (quat.y * quat.y + quat.z * quat.z));
}

/** Serialise the parts of the world that must survive a reload. */
export function snapshotWorld(world: World, seed: number): SavedWorld {
  return {
    seed,
    createdAt: new Date().toISOString(),
    edits: [...world.terrain.listEdits()],
    nodes: world
      .listNodes()
      .filter((node) => node.assetRef)
      .map((node) => ({
        assetId: node.assetRef!.assetId,
        version: node.assetRef!.version,
        pos: [node.transform.pos.x, node.transform.pos.y, node.transform.pos.z] as [number, number, number],
        rotY: yawOf(node.transform.quat),
      })),
  };
}

/** Rebuild terrain edits and asset bindings from a snapshot. Returns nodes restored. */
export async function restoreWorld(world: World, archive: Archive, saved: SavedWorld): Promise<number> {
  for (const edit of saved.edits) world.terrain.addEdit(edit);
  let restored = 0;
  for (const node of saved.nodes) {
    const bundle = await archive.get(node.assetId, node.version);
    if (!bundle) continue;
    world.bindAsset(bundle, { x: node.pos[0], y: node.pos[1], z: node.pos[2] }, node.rotY);
    restored += 1;
  }
  return restored;
}

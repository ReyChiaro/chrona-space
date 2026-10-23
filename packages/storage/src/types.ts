import type { AssetBundle, AssetId, ChunkId, TerrainEdit } from '@chrona/protocol';

/** Content-addressed asset store. Versions are immutable; edits create new versions. */
export interface Archive {
  put(bundle: AssetBundle): Promise<void>;
  get(assetId: AssetId, version: string): Promise<AssetBundle | undefined>;
  latest(assetId: AssetId): Promise<AssetBundle | undefined>;
  list(): Promise<AssetBundle[]>;
}

export interface WorldSave {
  worldId: string;
  seed: number;
  createdAt: string;
  terrainEdits: TerrainEdit[];
}

/** Persistence boundary; the CLI uses files, the browser keeps memory. */
export interface WorldStore {
  load(): Promise<WorldSave | undefined>;
  save(save: WorldSave): Promise<void>;
  loadChunk(id: ChunkId): Promise<unknown | undefined>;
  saveChunk(record: unknown): Promise<void>;
}

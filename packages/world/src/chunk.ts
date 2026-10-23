import type { ChunkId, ChunkState, Vec3 } from '@chrona/protocol';

export interface ChunkRecord {
  id: ChunkId;
  cx: number;
  cz: number;
  /** Footprint in metres: 64 for outdoor, 16 for indoor sub-chunks. */
  size: number;
  state: ChunkState;
  /** Bumped whenever terrain or contents change; invalidates viewpoint memory. */
  sceneVersion: number;
  /** Asset bindings owned by this chunk. */
  assets: { nodeId: string; assetId: string; version: string }[];
  /** True when a committed chunk has edits that are not reflected in its mesh yet. */
  dirty?: boolean;
}

export interface ChunkGeneration {
  (record: ChunkRecord): Promise<void>;
}

export interface ChunkHooks {
  /** Build the mesh for an activated chunk (called once per activation). */
  onActivate?(record: ChunkRecord): void;
  /** Drop meshes and colliders for an evicted chunk. */
  onEvict?(record: ChunkRecord): void;
  onCommit?(record: ChunkRecord): void;
}

export interface ChunkGridOptions {
  size?: number;
  loadRadius?: number;
  prefetchRadius?: number;
  maxConcurrent?: number;
}

/** Spatial helpers shared by the world and the maps. */
export function chunkIdOf(x: number, z: number, size = 64): ChunkId {
  return `${Math.floor(x / size)}_${Math.floor(z / size)}`;
}

export function chunkOrigin(cx: number, cz: number, size: number): Vec3 {
  return { x: cx * size, y: 0, z: cz * size };
}

export function parseChunkId(id: ChunkId): { cx: number; cz: number } {
  const [cx, cz] = id.split('_').map(Number);
  return { cx, cz };
}

/**
 * Streams chunks around the player. Generation is injected (the Code Agent),
 * so this class stays independent of how content is authored.
 */
export class ChunkManager {
  readonly size: number;
  readonly loadRadius: number;
  readonly prefetchRadius: number;
  readonly chunks = new Map<ChunkId, ChunkRecord>();

  private readonly hooks: ChunkHooks;
  private readonly generate: ChunkGeneration;
  private readonly maxConcurrent: number;
  private readonly inFlight = new Map<ChunkId, Promise<void>>();
  private current: ChunkId | null = null;

  constructor(options: ChunkGridOptions, generate: ChunkGeneration, hooks: ChunkHooks = {}) {
    this.size = options.size ?? 64;
    this.loadRadius = options.loadRadius ?? 2;
    this.prefetchRadius = options.prefetchRadius ?? 3;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.generate = generate;
    this.hooks = hooks;
  }

  /** Ensure the chunk record exists in `unexplored` state. */
  private ensure(id: ChunkId, cx: number, cz: number): ChunkRecord {
    let record = this.chunks.get(id);
    if (!record) {
      record = { id, cx, cz, size: this.size, state: 'unexplored', sceneVersion: 0, assets: [] };
      this.chunks.set(id, record);
    }
    return record;
  }

  /**
   * Called every frame with the player position. Schedules generation and
   * activates/evicts chunks; returns the chunks that changed state.
   */
  update(position: Vec3): ChunkRecord[] {
    const { loadRadius, prefetchRadius } = this;
    const pcx = Math.floor(position.x / this.size);
    const pcz = Math.floor(position.z / this.size);
    const changed: ChunkRecord[] = [];

    // Nearest-first so the player's own block and its neighbours are ready first.
    const candidates: { record: ChunkRecord; distance: number }[] = [];
    for (let dz = -prefetchRadius; dz <= prefetchRadius; dz += 1) {
      for (let dx = -prefetchRadius; dx <= prefetchRadius; dx += 1) {
        const record = this.ensure(`${pcx + dx}_${pcz + dz}`, pcx + dx, pcz + dz);
        candidates.push({ record, distance: Math.max(Math.abs(dx), Math.abs(dz)) });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);

    for (const { record, distance } of candidates) {
      if (distance <= loadRadius && record.state === 'committed') {
        record.state = 'active';
        this.hooks.onActivate?.(record);
        changed.push(record);
      }
    }
    for (const { record, distance } of candidates) {
      if (distance <= prefetchRadius && record.state === 'unexplored') {
        if (this.inFlight.size >= this.maxConcurrent) break;
        this.schedule(record.id);
        changed.push(record);
      }
    }

    for (const record of this.chunks.values()) {
      if (record.state !== 'active') continue;
      const distance = Math.max(Math.abs(record.cx - pcx), Math.abs(record.cz - pcz));
      if (distance > loadRadius) {
        record.state = 'evicted';
        this.hooks.onEvict?.(record);
        changed.push(record);
      }
    }

    this.current = `${pcx}_${pcz}`;
    return changed;
  }

  /**
   * Block until every chunk inside the load radius is active (CLI, tests, first
   * frame of the WebUI). Generation is async, so a single update is not enough.
   */
  async warmup(position: Vec3, maxRounds = 64): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      this.update(position);
      await this.settle();
      const pcx = Math.floor(position.x / this.size);
      const pcz = Math.floor(position.z / this.size);
      let ready = true;
      for (let dz = -this.loadRadius; dz <= this.loadRadius; dz += 1) {
        for (let dx = -this.loadRadius; dx <= this.loadRadius; dx += 1) {
          const record = this.chunks.get(`${pcx + dx}_${pcz + dz}`);
          if (!record || (record.state !== 'active' && record.state !== 'committed')) ready = false;
        }
      }
      if (ready) return;
    }
  }

  get currentChunkId(): ChunkId | null {
    return this.current;
  }

  private schedule(id: ChunkId): void {
    const record = this.chunks.get(id);
    if (!record) return;
    if (this.inFlight.size >= this.maxConcurrent) return;
    if (this.inFlight.has(record.id)) return;
    record.state = 'prefetching';
    const task = (async () => {
      try {
        record.state = 'generating';
        await this.generate(record);
        record.state = 'validating';
        record.state = 'committed';
        record.sceneVersion += 1;
        this.hooks.onCommit?.(record);
      } finally {
        this.inFlight.delete(record.id);
      }
    })();
    this.inFlight.set(record.id, task);
  }

  /** Await every in-flight generation (tests, CLI). */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  /** Mark a committed chunk as needing a rebuild (terrain edit landed). */
  markDirty(id: ChunkId): ChunkRecord | undefined {
    const record = this.chunks.get(id);
    if (!record) return undefined;
    record.dirty = true;
    record.sceneVersion += 1;
    if (record.state === 'active') this.hooks.onActivate?.(record);
    return record;
  }

  find(id: ChunkId): ChunkRecord | undefined {
    return this.chunks.get(id);
  }

  list(): ChunkRecord[] {
    return [...this.chunks.values()];
  }

  /** Chunks currently rendering (used by maps). */
  active(): ChunkRecord[] {
    return this.list().filter((c) => c.state === 'active');
  }
}

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkId, TerrainEdit } from '@chrona/protocol';
import type { ChunkRecord } from '@chrona/world';
import type { WorldSave, WorldStore as WorldStoreContract } from './types.js';

export class FsWorldStore implements WorldStoreContract {
  constructor(private readonly worldDir: string) {}

  private get savePath(): string {
    return join(this.worldDir, 'world.json');
  }

  async load(): Promise<WorldSave | undefined> {
    try {
      return JSON.parse(await readFile(this.savePath, 'utf8')) as WorldSave;
    } catch {
      return undefined;
    }
  }

  async save(save: WorldSave): Promise<void> {
    await mkdir(this.worldDir, { recursive: true });
    const tmp = `${this.savePath}.tmp`;
    await writeFile(tmp, JSON.stringify(save, null, 2), 'utf8');
    await rename(tmp, this.savePath);
  }

  async loadChunk(id: ChunkId): Promise<ChunkRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.worldDir, 'chunks', `${id}.json`), 'utf8')) as ChunkRecord;
    } catch {
      return undefined;
    }
  }

  async saveChunk(record: ChunkRecord): Promise<void> {
    const dir = join(this.worldDir, 'chunks');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${record.id}.json`);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, path);
  }
}

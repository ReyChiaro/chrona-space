import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetBundle } from '@chrona/protocol';
import type { Archive } from './types.js';

/**
 * Node-only archive backed by the world directory:
 * worlds/<worldId>/archive/<assetId>/<version>/{script.js, appearance.json, meta.json}
 */
export class FsArchive implements Archive {
  constructor(private readonly worldDir: string) {}

  private assetDir(bundle: Pick<AssetBundle, 'assetId' | 'version'>): string {
    return join(this.worldDir, 'archive', bundle.assetId, bundle.version);
  }

  async put(bundle: AssetBundle): Promise<void> {
    const dir = this.assetDir(bundle);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'script.js'), bundle.script.source, 'utf8');
    await writeFile(join(dir, 'appearance.json'), JSON.stringify(bundle.appearance, null, 2), 'utf8');
    await writeFile(join(dir, 'meta.json'), JSON.stringify(stripSource(bundle), null, 2), 'utf8');
  }

  async get(assetId: string, version: string): Promise<AssetBundle | undefined> {
    try {
      const dir = join(this.worldDir, 'archive', assetId, version);
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as AssetBundle;
      const source = await readFile(join(dir, 'script.js'), 'utf8');
      return { ...meta, script: { ...meta.script, source } };
    } catch {
      return undefined;
    }
  }

  async latest(assetId: string): Promise<AssetBundle | undefined> {
    try {
      const dir = join(this.worldDir, 'archive', assetId);
      const versions = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const version = versions.at(-1);
      return version ? this.get(assetId, version) : undefined;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<AssetBundle[]> {
    const root = join(this.worldDir, 'archive');
    const bundles: AssetBundle[] = [];
    try {
      for (const asset of await readdir(root, { withFileTypes: true })) {
        if (!asset.isDirectory()) continue;
        const bundle = await this.latest(asset.name);
        if (bundle) bundles.push(bundle);
      }
    } catch {
      return [];
    }
    return bundles;
  }
}

function stripSource(bundle: AssetBundle): AssetBundle {
  return { ...bundle, script: { ...bundle.script, source: '' } };
}

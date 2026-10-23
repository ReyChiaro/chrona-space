import type { AssetBundle, AssetId } from '@chrona/protocol';
import type { Archive } from './types.js';

export class MemoryArchive implements Archive {
  private readonly bundles = new Map<string, AssetBundle>();

  async put(bundle: AssetBundle): Promise<void> {
    this.bundles.set(`${bundle.assetId}@${bundle.version}`, bundle);
  }

  async get(assetId: AssetId, version: string): Promise<AssetBundle | undefined> {
    return this.bundles.get(`${assetId}@${version}`);
  }

  async latest(assetId: AssetId): Promise<AssetBundle | undefined> {
    const versions = [...this.bundles.values()]
      .filter((b) => b.assetId === assetId)
      .sort((a, b) => compareVersion(a.version, b.version));
    return versions.at(-1);
  }

  async list(): Promise<AssetBundle[]> {
    return [...this.bundles.values()];
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

import type { AssetBundle } from '@chrona/protocol';
import type { SavedWorld } from '@chrona/harness';
import type { Archive } from '@chrona/storage';

const DB_NAME = 'chrona-v1';

/** Guard against storage being unavailable (private mode, blocked, slow). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('indexeddb timeout')), ms)),
  ]);
}
const STORE = 'kv';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Tiny IndexedDB key-value store; enough for bundles and one world snapshot. */
export class IdbStore {
  private db!: IDBDatabase;

  async open(): Promise<this> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(DB_NAME, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE);
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    return this;
  }

  async put(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction(STORE, 'readonly');
    return request<T | undefined>(tx.objectStore(STORE).get(key));
  }

  async keys(): Promise<string[]> {
    const tx = this.db.transaction(STORE, 'readonly');
    const keys = await request<IDBValidKey[]>(tx.objectStore(STORE).getAllKeys());
    return keys.map(String);
  }

  saveWorld(world: SavedWorld): Promise<void> {
    return this.put('world', world);
  }

  loadWorld(): Promise<SavedWorld | undefined> {
    return this.get<SavedWorld>('world');
  }
}

export class IdbArchive implements Archive {
  constructor(private readonly store: IdbStore) {}

  async put(bundle: AssetBundle): Promise<void> {
    await this.store.put(`bundle:${bundle.assetId}@${bundle.version}`, bundle);
  }

  async get(assetId: string, version: string): Promise<AssetBundle | undefined> {
    return this.store.get<AssetBundle>(`bundle:${assetId}@${version}`);
  }

  async latest(assetId: string): Promise<AssetBundle | undefined> {
    const versions = (await this.store.keys())
      .filter((key) => key.startsWith(`bundle:${assetId}@`))
      .sort();
    const key = versions.at(-1);
    return key ? this.store.get<AssetBundle>(key) : undefined;
  }

  async list(): Promise<AssetBundle[]> {
    const keys = (await this.store.keys()).filter((key) => key.startsWith('bundle:'));
    const latest = new Map<string, string>();
    for (const key of keys) {
      const [assetId] = key.replace('bundle:', '').split('@');
      const current = latest.get(assetId);
      if (!current || current < key) latest.set(assetId, key);
    }
    const bundles: AssetBundle[] = [];
    for (const key of latest.values()) {
      const bundle = await this.store.get<AssetBundle>(key);
      if (bundle) bundles.push(bundle);
    }
    return bundles;
  }
}

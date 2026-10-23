import type { ClipId, GameCamera, ImageRef, ViewpointCell, ViewpointQuery, ViewpointRecord } from '@chrona/protocol';

/**
 * Location-keyed memory of previously generated frames.
 * One record per 1 m cell; only the first and latest visits are kept.
 * See docs/v1/TERRAIN.md and CHRONA_SPEC §6.5.
 */
export class ViewpointMemory {
  private readonly cells = new Map<string, ViewpointRecord>();

  static cellOf(pos: { x: number; y: number; z: number }): ViewpointCell {
    return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
  }

  private static key(cell: ViewpointCell): string {
    return `${cell.x}/${cell.y}/${cell.z}`;
  }

  /** Write one sample. `first` never changes; `latest` always does. */
  record(sample: {
    camera: GameCamera;
    frame: ImageRef;
    clipId: ClipId;
    tick: number;
    sceneVersion: number;
  }): ViewpointRecord {
    const cell = ViewpointMemory.cellOf(sample.camera.pos);
    const key = ViewpointMemory.key(cell);
    const existing = this.cells.get(key);
    if (!existing) {
      const record: ViewpointRecord = {
        cell,
        visitCount: 1,
        first: { ...sample },
        latest: { ...sample },
        stale: false,
      };
      this.cells.set(key, record);
      return record;
    }
    existing.latest = { ...sample };
    existing.visitCount += 1;
    // The world changed where this frame was taken: the old memory is no longer valid.
    if (sample.sceneVersion !== existing.first.sceneVersion) existing.stale = true;
    return existing;
  }

  /** Records whose cells intersect the query camera's trajectory sample. */
  query(query: ViewpointQuery): ViewpointRecord[] {
    const radius = query.radiusCells ?? 1;
    const maxAngle = query.maxAngularDiffDeg ?? 45;
    const centre = ViewpointMemory.cellOf(query.camera.pos);
    const result: ViewpointRecord[] = [];
    for (const record of this.cells.values()) {
      if (record.stale) continue;
      if (
        Math.abs(record.cell.x - centre.x) > radius ||
        Math.abs(record.cell.y - centre.y) > radius ||
        Math.abs(record.cell.z - centre.z) > radius
      ) {
        continue;
      }
      if (angleBetween(record.first.camera, query.camera) > maxAngle) continue;
      result.push(record);
    }
    return result.sort((a, b) => b.visitCount - a.visitCount);
  }

  /** Manual escape hatch: a bad first frame must not own the cell forever. */
  reanchor(predicate: (record: ViewpointRecord) => boolean): void {
    for (const [key, record] of this.cells) {
      if (predicate(record)) this.cells.delete(key);
    }
  }

  get size(): number {
    return this.cells.size;
  }
}

function angleBetween(a: GameCamera, b: GameCamera): number {
  const dot =
    a.quat.x * b.quat.x + a.quat.y * b.quat.y + a.quat.z * b.quat.z + a.quat.w * b.quat.w;
  const clamped = Math.min(1, Math.max(-1, Math.abs(dot)));
  return (2 * Math.acos(clamped) * 180) / Math.PI;
}

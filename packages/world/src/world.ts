import * as THREE from 'three';
import type {
  AssetBundle,
  ChunkId,
  FocusObject,
  FramePacket,
  GameCamera,
  NodeId,
  SceneSnapshot,
  Vec3,
  WorldNode,
} from '@chrona/protocol';
import { instantiateAsset, type RuntimeAsset } from './asset-runtime.js';
import { ChunkManager, chunkIdOf, type ChunkRecord } from './chunk.js';
import { PhysicsWorld, type RayHit } from './physics.js';
import { TerrainField, type TerrainConfig } from './terrain.js';

export interface InputState {
  forward: number;
  right: number;
  sprint: boolean;
  jump: boolean;
  yawDelta: number;
  pitchDelta: number;
}

export const NO_INPUT: InputState = {
  forward: 0,
  right: 0,
  sprint: false,
  jump: false,
  yawDelta: 0,
  pitchDelta: 0,
};

export interface WorldHooks {
  onChunkActivated?(record: ChunkRecord, terrain: TerrainField): void;
  onChunkEvicted?(record: ChunkRecord): void;
}

export interface WorldOptions {
  worldId: string;
  seed: number;
  terrain?: Partial<TerrainConfig>;
  physics?: PhysicsWorld;
  hooks?: WorldHooks;
  chunkSize?: number;
  loadRadius?: number;
  prefetchRadius?: number;
  /** Content generator injected by the harness; defaults to an empty chunk. */
  generateChunk?: (record: import('./chunk.js').ChunkRecord) => Promise<void>;
}

interface BoundNode {
  node: WorldNode;
  object3d: THREE.Object3D;
  bundle: AssetBundle;
  chunkId?: ChunkId;
  bodyHandle?: number;
}

const WALK_SPEED = 2.1;
const SPRINT_SPEED = 3.8;
const EYE_HEIGHT = 1.67;
const GRAVITY = 18;
const JUMP_SPEED = 5.2;
const PITCH_LIMIT = Math.PI / 2 - 0.08;

/** The world owns state: nodes, terrain, camera, chunks. It knows nothing about UI or models. */
export class World {
  readonly id: string;
  readonly terrain: TerrainField;
  readonly physics: PhysicsWorld | null;
  readonly chunks: ChunkManager;
  readonly nodes = new Map<NodeId, BoundNode>();

  tick = 0;
  simTimeMs = 0;

  private readonly sceneRoot = new THREE.Group();
  private readonly hooks: WorldHooks;
  private readonly chunkSize: number;
  private readonly terrainColliders = new Map<string, number>();
  private yaw = 0;
  private pitch = 0;
  private readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  private velocityY = 0;
  private grounded = true;

  constructor(options: WorldOptions) {
    this.id = options.worldId;
    this.terrain = new TerrainField({ seed: options.seed, ...options.terrain });
    this.physics = options.physics ?? null;
    this.hooks = options.hooks ?? {};
    const size = options.chunkSize ?? 64;
    this.chunkSize = size;
    this.chunks = new ChunkManager(
      {
        size,
        loadRadius: options.loadRadius ?? 2,
        prefetchRadius: options.prefetchRadius ?? 3,
      },
      options.generateChunk ?? (async () => {}),
      {
        onActivate: (record) => {
          this.addTerrainCollider(record);
          this.hooks.onChunkActivated?.(record, this.terrain);
        },
        onEvict: (record) => {
          this.removeTerrainCollider(record);
          this.hooks.onChunkEvicted?.(record);
        },
      },
    );
  }

  get scene(): THREE.Group {
    return this.sceneRoot;
  }

  get cameraPosition(): Vec3 {
    return { ...this.position };
  }

  get onGround(): boolean {
    return this.grounded;
  }

  get camera(): GameCamera {
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    const quat = new THREE.Quaternion().setFromEuler(euler);
    return {
      pos: { x: this.position.x, y: this.position.y + EYE_HEIGHT, z: this.position.z },
      quat: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
      fovDeg: 60,
      near: 0.05,
      far: 400,
      aspect: 16 / 9,
      eyeHeightM: EYE_HEIGHT,
    };
  }

  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  }

  get look(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  teleport(x: number, z: number): void {
    this.position.x = x;
    this.position.z = z;
    this.position.y = this.groundHeightAt(x, z);
    this.velocityY = 0;
    this.grounded = true;
  }

  /** Bind an asset into the world and give it a node. */
  bindAsset(bundle: AssetBundle, position: Vec3, rotationY = 0): NodeId {
    const nodeId = `${bundle.assetId}:${this.nodes.size}`;
    const runtime: RuntimeAsset = instantiateAsset(bundle, {
      nodeId,
      assetId: bundle.assetId,
      position,
      rotationY,
    });
    runtime.object3d.name = nodeId;
    this.sceneRoot.add(runtime.object3d);
    const bodyHandle = this.physics?.addAsset(nodeId, runtime.colliders, position, rotationY);

    const node: WorldNode = {
      id: nodeId,
      parentId: 'root',
      kind: 'asset',
      transform: {
        pos: { ...position },
        quat: { x: 0, y: Math.sin(rotationY / 2), z: 0, w: Math.cos(rotationY / 2) },
        scale: { x: 1, y: 1, z: 1 },
      },
      assetRef: { assetId: bundle.assetId, version: bundle.version },
      semantic: bundle.semantic,
      chunkId: chunkIdOf(position.x, position.z, this.chunkSize),
      bounds: runtime.bounds,
    };
    this.nodes.set(nodeId, { node, object3d: runtime.object3d, bundle, chunkId: node.chunkId, bodyHandle });
    return nodeId;
  }

  /** Snapshot of bound nodes, used by maps and debugging panels. */
  listNodes(): WorldNode[] {
    return [...this.nodes.values()].map((bound) => bound.node);
  }

  /** Object3D for a node; the UI needs it for selection outlines. */
  objectOf(nodeId: NodeId): THREE.Object3D | undefined {
    return this.nodes.get(nodeId)?.object3d;
  }

  /** Swap an asset on an existing node without moving it (modify flow). */
  modifyNode(nodeId: NodeId, bundle: AssetBundle): boolean {
    const bound = this.nodes.get(nodeId);
    if (!bound) return false;
    const { pos, quat } = bound.node.transform;
    if (bound.bodyHandle !== undefined) this.physics?.removeBody(bound.bodyHandle);
    const rotationY = Math.atan2(2 * (quat.w * quat.y + quat.x * quat.z), 1 - 2 * (quat.y * quat.y + quat.z * quat.z));

    this.sceneRoot.remove(bound.object3d);
    bound.object3d.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });

    const runtime = instantiateAsset(bundle, {
      nodeId,
      assetId: bundle.assetId,
      position: pos,
      rotationY,
    });
    runtime.object3d.name = nodeId;
    this.sceneRoot.add(runtime.object3d);

    bound.object3d = runtime.object3d;
    bound.bodyHandle = this.physics?.addAsset(nodeId, runtime.colliders, pos, rotationY);
    bound.bundle = bundle;
    bound.node.assetRef = { assetId: bundle.assetId, version: bundle.version };
    bound.node.semantic = bundle.semantic;
    bound.node.bounds = runtime.bounds;
    return true;
  }

  removeNode(nodeId: NodeId): void {
    const bound = this.nodes.get(nodeId);
    if (!bound) return;
    if (bound.bodyHandle !== undefined) this.physics?.removeBody(bound.bodyHandle);
    this.sceneRoot.remove(bound.object3d);
    bound.object3d.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    this.nodes.delete(nodeId);
  }

  update(dt: number, input: InputState): void {
    this.simTimeMs += dt * 1000;
    this.tick = Math.floor(this.simTimeMs / (1000 / 60));

    this.yaw -= input.yawDelta;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - input.pitchDelta));

    const speed = input.sprint ? SPRINT_SPEED : WALK_SPEED;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dx = (-sin * input.forward + cos * input.right) * speed * dt;
    const dz = (-cos * input.forward - sin * input.right) * speed * dt;
    const nextX = this.position.x + dx;
    const nextZ = this.position.z + dz;

    if (this.isFree(nextX, this.position.z)) this.position.x = nextX;
    if (this.isFree(this.position.x, nextZ)) this.position.z = nextZ;

    if (input.jump && this.grounded) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocityY -= GRAVITY * dt;
    this.position.y += this.velocityY * dt;

    const ground = this.groundHeightAt(this.position.x, this.position.z);
    if (this.position.y <= ground) {
      this.position.y = ground;
      this.velocityY = 0;
      this.grounded = true;
    } else if (this.position.y > ground + 0.02) {
      this.grounded = false;
    }

    this.chunks.update(this.position);
    this.physics?.flushQueries();
  }

  /** Frame emitted by the game camera. Pixel payload is attached by the renderer. */
  frame(): FramePacket {
    return {
      frameId: this.tick,
      tick: this.tick,
      simTimeMs: this.simTimeMs,
      camera: this.camera,
    };
  }

  snapshot(): SceneSnapshot {
    const camera = this.camera;
    const focus: FocusObject[] = [];
    const nearby: { nodeId: string; semantic: string; pos: Vec3; distanceM: number }[] = [];
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(camera.quat.x, camera.quat.y, camera.quat.z, camera.quat.w),
    );

    for (const [nodeId, bound] of this.nodes) {
      const pos = bound.node.transform.pos;
      const dx = pos.x - camera.pos.x;
      const dy = pos.y - camera.pos.y;
      const dz = pos.z - camera.pos.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > 60) continue;
      const toNode = new THREE.Vector3(dx, dy, dz).normalize();
      const facing = toNode.dot(forward);
      if (facing < 0.15) continue;

      const radius = bound.bundle.bounds.max.y - bound.bundle.bounds.min.y || 0.5;
      const coverage = Math.min(1, (radius / Math.max(0.5, distance)) / Math.tan((camera.fovDeg * Math.PI) / 360));
      if (distance <= 60) {
        nearby.push({ nodeId, semantic: bound.node.semantic ?? '', pos, distanceM: distance });
      }
      if (coverage > 0.02) {
        focus.push({
          nodeId,
          assetId: bound.bundle.assetId,
          semantic: bound.node.semantic ?? bound.bundle.assetId,
          appearance: bound.bundle.appearance,
          transform: bound.node.transform,
          distanceM: distance,
          screenCoverage: coverage,
        });
      }
    }

    focus.sort((a, b) => b.screenCoverage - a.screenCoverage);
    nearby.sort((a, b) => a.distanceM - b.distanceM);

    return {
      tick: this.tick,
      camera,
      focus: focus.slice(0, 8),
      nearby: nearby.slice(0, 32),
      lod: focus.length > 0 && focus[0].distanceM < 15 ? 'near' : focus.length > 0 ? 'mid' : 'far',
    };
  }

  /** Pick a point under the crosshair: assets first, then terrain. */
  pick(maxDistance = 120): (RayHit & { nodeId?: string }) | null {
    const camera = this.camera;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(camera.quat.x, camera.quat.y, camera.quat.z, camera.quat.w),
    );
    const hit = this.physics?.castRay(camera.pos, forward, maxDistance);
    if (hit) return hit;
    return this.marchTerrain(camera.pos, forward, maxDistance);
  }

  /** Analytic terrain ray march, used because terrain has no collider in v1. */
  private marchTerrain(origin: Vec3, direction: THREE.Vector3, maxDistance: number): RayHit | null {
    const step = 0.25;
    let previous = 0;
    for (let t = step; t <= maxDistance; t += step) {
      const x = origin.x + direction.x * t;
      const y = origin.y + direction.y * t;
      const z = origin.z + direction.z * t;
      const h = this.terrain.heightAt(x, z);
      if (y <= h) {
        let lo = previous;
        let hi = t;
        for (let i = 0; i < 12; i += 1) {
          const mid = (lo + hi) / 2;
          const my = origin.y + direction.y * mid;
          if (my <= this.terrain.heightAt(origin.x + direction.x * mid, origin.z + direction.z * mid)) hi = mid;
          else lo = mid;
        }
        return {
          distance: hi,
          point: {
            x: origin.x + direction.x * hi,
            y: this.terrain.heightAt(origin.x + direction.x * hi, origin.z + direction.z * hi),
            z: origin.z + direction.z * hi,
          },
        };
      }
      previous = t;
    }
    return null;
  }

  /** Heightfield collider per active chunk, so terrain is solid, not just drawn. */
  private addTerrainCollider(record: import('./chunk.js').ChunkRecord): void {
    if (!this.physics || this.terrainColliders.has(record.id)) return;
    const resolution = 16;
    const step = record.size / resolution;
    const heights = new Float32Array((resolution + 1) * (resolution + 1));
    for (let z = 0; z <= resolution; z += 1) {
      for (let x = 0; x <= resolution; x += 1) {
        heights[z * (resolution + 1) + x] = this.terrain.heightAt(
          record.cx * record.size + x * step,
          record.cz * record.size + z * step,
        );
      }
    }
    const handle = this.physics.addHeightfield(
      { x: record.cx * record.size, y: 0, z: record.cz * record.size },
      record.size,
      heights,
      resolution,
    );
    if (handle !== undefined) this.terrainColliders.set(record.id, handle);
    // Make the new surface queryable before the next physics flush.
    this.physics.flushQueries();
  }

  private removeTerrainCollider(record: import('./chunk.js').ChunkRecord): void {
    const handle = this.terrainColliders.get(record.id);
    if (handle === undefined) return;
    this.physics?.removeBody(handle);
    this.terrainColliders.delete(record.id);
  }

  /** Highest surface under the player, from the floor to anything standable. */
  private groundHeightAt(x: number, z: number): number {
    const originY = this.position.y + 1.2;
    const hit = this.physics?.castRay({ x, y: originY, z }, { x: 0, y: -1, z: 0 }, 3);
    if (hit && hit.distance > 0.02) return hit.point.y;
    return this.terrain.heightAt(x, z);
  }

  /**
   * Horizontal body probe. A downward ray would hit the floor the player is
   * standing on — that froze movement and caused the stutter seen in v1.
   */
  private isFree(x: number, z: number): boolean {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return true;
    const direction = { x: dx / distance, y: 0, z: dz / distance };
    const radius = 0.32;
    for (const height of [0.3, 0.75, 1.15]) {
      const hit = this.physics?.castRay(
        { x: this.position.x, y: this.position.y + height, z: this.position.z },
        direction,
        distance + radius,
      );
      if (hit) return false;
    }
    return true;
  }
}

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
  yawDelta: number;
  pitchDelta: number;
}

export const NO_INPUT: InputState = {
  forward: 0,
  right: 0,
  sprint: false,
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
}

const WALK_SPEED = 2.1;
const SPRINT_SPEED = 3.8;
const EYE_HEIGHT = 1.67;
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
  private yaw = 0;
  private pitch = 0;
  private readonly position: Vec3 = { x: 0, y: EYE_HEIGHT, z: 0 };
  private groundedY = 0;

  constructor(options: WorldOptions) {
    this.id = options.worldId;
    this.terrain = new TerrainField({ seed: options.seed, ...options.terrain });
    this.physics = options.physics ?? null;
    this.hooks = options.hooks ?? {};
    const size = options.chunkSize ?? 64;
    this.chunks = new ChunkManager(
      {
        size,
        loadRadius: options.loadRadius ?? 2,
        prefetchRadius: options.prefetchRadius ?? 3,
      },
      options.generateChunk ?? (async () => {}),
      {
        onActivate: (record) => this.hooks.onChunkActivated?.(record, this.terrain),
        onEvict: (record) => this.hooks.onChunkEvicted?.(record),
      },
    );
  }

  get scene(): THREE.Group {
    return this.sceneRoot;
  }

  get cameraPosition(): Vec3 {
    return { ...this.position };
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
    this.physics?.addAsset(nodeId, runtime.colliders, position, rotationY);

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
      chunkId: chunkIdOf(position.x, position.z),
    };
    this.nodes.set(nodeId, { node, object3d: runtime.object3d, bundle, chunkId: node.chunkId });
    return nodeId;
  }

  removeNode(nodeId: NodeId): void {
    const bound = this.nodes.get(nodeId);
    if (!bound) return;
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

    const ground = this.groundHeightAt(this.position.x, this.position.z);
    this.groundedY += (ground - this.groundedY) * Math.min(1, dt * 12);
    this.position.y = this.groundedY;

    this.chunks.update(this.position);
    this.physics?.step(dt);
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

  private groundHeightAt(x: number, z: number): number {
    const down = this.physics?.castRay({ x, y: this.position.y + 2, z }, { x: 0, y: -1, z: 0 }, 4);
    if (down && down.distance < 4) return down.point.y;
    return this.terrain.heightAt(x, z);
  }

  /** Very coarse walkability: blocks only where an asset collider sits above the floor. */
  private isFree(x: number, z: number): boolean {
    const probe = this.physics?.castRay({ x, y: this.position.y + 1.2, z }, { x: 0, y: -1, z: 0 }, 1.2);
    return !probe;
  }
}

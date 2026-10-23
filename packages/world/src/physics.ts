import RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderSpec, Vec3 } from '@chrona/protocol';

export interface RayHit {
  point: Vec3;
  distance: number;
  nodeId?: string;
}

/**
 * Thin wrapper around rapier. Only static colliders are created in v1:
 * the player is kinematic and walks on the analytic terrain surface, while
 * assets get colliders so placement rays and future dynamics work.
 */
export class PhysicsWorld {
  private readonly world: RAPIER.World;
  private readonly nodeByCollider = new Map<number, string>();

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(): Promise<PhysicsWorld> {
    // rapier-compat 0.18 warns about its own internal init() call; keep stdout clean.
    const warn = console.warn;
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      if (typeof message === 'string' && message.includes('deprecated parameters')) return;
      warn(message, ...rest);
    };
    try {
      await RAPIER.init();
    } finally {
      console.warn = warn;
    }
    return new PhysicsWorld(new RAPIER.World({ x: 0, y: -9.81, z: 0 }));
  }

  /** Register a heightfield for a chunk so terrain participates in raycasts. */
  addHeightfield(
    origin: Vec3,
    size: number,
    heights: Float32Array,
    resolution: number,
  ): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(origin.x + size / 2, origin.y, origin.z + size / 2),
    );
    const desc = RAPIER.ColliderDesc.heightfield(resolution, resolution, heights, {
      x: size,
      y: 1,
      z: size,
    });
    this.world.createCollider(desc, body);
  }

  /** Attach colliders for an asset instance. */
  addAsset(nodeId: string, colliders: ColliderSpec[], position: Vec3, rotationY: number): void {
    if (colliders.length === 0) return;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(quatFromYaw(rotationY)),
    );
    for (const collider of colliders) {
      const desc = colliderDesc(collider);
      if (!desc) continue;
      const handle = this.world.createCollider(desc, body).handle;
      this.nodeByCollider.set(handle, nodeId);
    }
  }

  castRay(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const ray = new RAPIER.Ray(origin, {
      x: direction.x / length,
      y: direction.y / length,
      z: direction.z / length,
    });
    const hit = this.world.castRay(ray, maxDistance, true);
    if (!hit) return null;
    const distance = hit.timeOfImpact ?? (hit as unknown as { toi: number }).toi;
    return {
      distance,
      point: {
        x: origin.x + (direction.x / length) * distance,
        y: origin.y + (direction.y / length) * distance,
        z: origin.z + (direction.z / length) * distance,
      },
      nodeId: this.nodeByCollider.get(hit.collider.handle),
    };
  }

  /** Rapier needs a step before queries observe freshly created colliders. */
  step(dt: number): void {
    this.world.timestep = Math.min(dt, 1 / 30);
    this.world.step();
  }

  dispose(): void {
    this.world.free();
  }
}

function colliderDesc(spec: ColliderSpec): RAPIER.ColliderDesc | null {
  const offset = spec.offset ?? { x: 0, y: 0, z: 0 };
  let desc: RAPIER.ColliderDesc;
  if (spec.type === 'cuboid' && spec.halfExtents) {
    desc = RAPIER.ColliderDesc.cuboid(
      spec.halfExtents.x,
      spec.halfExtents.y,
      spec.halfExtents.z,
    );
  } else if (spec.type === 'ball' && spec.radius) {
    desc = RAPIER.ColliderDesc.ball(spec.radius);
  } else if (spec.type === 'cylinder' && spec.radius && spec.halfHeight) {
    desc = RAPIER.ColliderDesc.cylinder(spec.halfHeight, spec.radius);
  } else {
    return null;
  }
  return desc.setTranslation(offset.x, offset.y, offset.z);
}

function quatFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

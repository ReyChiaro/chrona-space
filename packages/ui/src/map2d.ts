import type { SurfaceClass } from '@chrona/protocol';
import type { World } from '@chrona/world';

const SURFACE_FILL: Record<SurfaceClass, string> = {
  floor: '#6b5a44',
  soil: '#5b4634',
  grass: '#4f6b43',
  water: '#2b4a63',
  road: '#4a4a4a',
  sidewalk: '#6a6a66',
};

function yawOf(quat: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (quat.w * quat.y + quat.x * quat.z), 1 - 2 * (quat.y * quat.y + quat.z * quat.z));
}

export interface Map2D {
  draw(): void;
  destroy(): void;
}

/**
 * Top-down map of loaded chunks only. Colours come from the surface material,
 * never from the UI theme (D-34). Click teleports the game camera.
 */
export function createMap2D(canvas: HTMLCanvasElement, world: World, onTeleport: (x: number, z: number) => void): Map2D {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('2d context unavailable');
  const context: CanvasRenderingContext2D = ctx2d;
  let transform = { scale: 1, originX: 0, originY: 0, minX: 0, minZ: 0 };
  let lastDraw = 0;

  const ratio = Math.min(window.devicePixelRatio, 2);
  const resize = (): void => {
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  function draw(): void {
    const now = performance.now();
    if (now - lastDraw < 100) return;
    lastDraw = now;
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    resize();

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0a0810';
    context.fillRect(0, 0, width, height);

    const chunks = world.chunks.active();
    if (chunks.length === 0) {
      context.fillStyle = '#8a8496';
      context.font = '11px ui-monospace, monospace';
      context.fillText('无已加载区块', 14, 22);
      return;
    }

    // Frame the contents (assets) when there are any; an indoor room inside a
    // 64 m chunk would otherwise be a speck.
    const nodes = world.listNodes();
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    if (nodes.length > 0) {
      for (const node of nodes) {
        minX = Math.min(minX, node.transform.pos.x);
        minZ = Math.min(minZ, node.transform.pos.z);
        maxX = Math.max(maxX, node.transform.pos.x);
        maxZ = Math.max(maxZ, node.transform.pos.z);
      }
      const pad = 2;
      minX -= pad;
      minZ -= pad;
      maxX += pad;
      maxZ += pad;
    } else {
      for (const chunk of chunks) {
        minX = Math.min(minX, chunk.cx * chunk.size);
        minZ = Math.min(minZ, chunk.cz * chunk.size);
        maxX = Math.max(maxX, (chunk.cx + 1) * chunk.size);
        maxZ = Math.max(maxZ, (chunk.cz + 1) * chunk.size);
      }
    }

    const scale = Math.min((width - 16) / (maxX - minX), (height - 28) / (maxZ - minZ));
    const originX = 8 + (width - 16 - (maxX - minX) * scale) / 2;
    const originY = 20 + (height - 28 - (maxZ - minZ) * scale) / 2;
    transform = { scale, originX, originY, minX, minZ };

    const toScreen = (x: number, z: number): [number, number] => [
      originX + (x - minX) * scale,
      originY + (z - minZ) * scale,
    ];

    // Surface material sampled across the visible area, independent of chunks.
    const cells = 56;
    const stepX = (maxX - minX) / cells;
    const stepZ = (maxZ - minZ) / cells;
    for (let iz = 0; iz < cells; iz += 1) {
      for (let ix = 0; ix < cells; ix += 1) {
        const wx = minX + (ix + 0.5) * stepX;
        const wz = minZ + (iz + 0.5) * stepZ;
        const [sx, sy] = toScreen(wx - stepX / 2, wz - stepZ / 2);
        context.fillStyle = SURFACE_FILL[world.terrain.surfaceAt(wx, wz)];
        context.fillRect(sx, sy, stepX * scale + 0.5, stepZ * scale + 0.5);
      }
    }

    // Loaded chunk borders that intersect the view.
    context.strokeStyle = 'rgba(255,255,255,0.18)';
    context.lineWidth = 1;
    for (const chunk of chunks) {
      const chunkMinX = chunk.cx * chunk.size;
      const chunkMinZ = chunk.cz * chunk.size;
      if (chunkMinX > maxX || chunkMinZ > maxZ) continue;
      if (chunkMinX + chunk.size < minX || chunkMinZ + chunk.size < minZ) continue;
      const [bx, by] = toScreen(chunkMinX, chunkMinZ);
      context.strokeRect(bx, by, chunk.size * scale, chunk.size * scale);
    }

    for (const node of world.listNodes()) {
      const [sx, sy] = toScreen(node.transform.pos.x, node.transform.pos.z);
      if (node.bounds) {
        const width = (node.bounds.max.x - node.bounds.min.x) * scale;
        const depth = (node.bounds.max.z - node.bounds.min.z) * scale;
        const centreX = toScreen((node.bounds.max.x + node.bounds.min.x) / 2, 0)[0];
        const centreY = toScreen(0, (node.bounds.max.z + node.bounds.min.z) / 2)[1];
        const yaw = yawOf(node.transform.quat);
        context.save();
        context.translate(centreX, centreY);
        context.rotate(yaw);
        context.strokeStyle = 'rgba(232,228,220,0.28)';
        context.lineWidth = 0.8;
        context.strokeRect(-width / 2, -depth / 2, width, depth);
        context.restore();
      }
      context.fillStyle = 'rgba(232,228,220,0.9)';
      context.beginPath();
      context.arc(sx, sy, 1.6, 0, Math.PI * 2);
      context.fill();
    }

    const camera = world.camera;
    const [cx, cy] = toScreen(camera.pos.x, camera.pos.z);
    const yaw = world.look.yaw;
    const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    context.save();
    context.translate(cx, cy);
    context.beginPath();
    context.moveTo(dir.x * 9, dir.z * 9);
    context.lineTo(-dir.z * 5 - dir.x * 4, dir.x * 5 - dir.z * 4);
    context.lineTo(dir.z * 5 - dir.x * 4, -dir.x * 5 - dir.z * 4);
    context.closePath();
    context.fillStyle = '#e07ab8';
    context.fill();
    context.restore();

    context.fillStyle = '#5f6d7c';
    context.font = '10px ui-monospace, monospace';
    context.fillText(`已加载 ${chunks.length} 块 · 视野 ${(maxX - minX).toFixed(0)}m · 点击传送`, 12, 14);
  }

  const onClick = (event: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    const x = (sx - transform.originX) / transform.scale + transform.minX;
    const z = (sy - transform.originY) / transform.scale + transform.minZ;
    if (Number.isFinite(x) && Number.isFinite(z)) onTeleport(x, z);
  };

  canvas.addEventListener('click', onClick);
  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);
  resize();

  return {
    draw,
    destroy() {
      canvas.removeEventListener('click', onClick);
      observer.disconnect();
    },
  };
}

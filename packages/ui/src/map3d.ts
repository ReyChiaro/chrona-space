import * as THREE from 'three';
import type { SurfaceClass } from '@chrona/protocol';
import type { World } from '@chrona/world';

const SURFACE_COLOUR: Record<SurfaceClass, number> = {
  floor: 0x6b5a44,
  soil: 0x5b4634,
  grass: 0x4f6b43,
  water: 0x2b4a63,
  road: 0x4a4a4a,
  sidewalk: 0x6a6a66,
};

export interface Map3D {
  refresh(): void;
  render(): void;
  destroy(): void;
}

/** Orbiting top-down view of loaded chunks. Read-only: teleport happens on the 2D map. */
export function createMap3D(canvas: HTMLCanvasElement, world: World): Map3D {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0a0810, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 500);
  const content = new THREE.Group();
  scene.add(content);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(6, 12, 8);
  scene.add(sun);

  let azimuth = Math.PI / 4;
  let elevation = 0.92;
  let distance = 16;
  let target = new THREE.Vector3(0, 0, 0);

  const resize = (): void => {
    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 200;
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(ratio);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  function clear(): void {
    for (const child of [...content.children]) {
      content.remove(child);
      child.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
          node.geometry.dispose();
          const material = node.material as THREE.Material;
          material.dispose();
        }
      });
    }
  }

  function buildChunk(chunk: { cx: number; cz: number; size: number }): void {
    const resolution = 12;
    const geometry = new THREE.PlaneGeometry(chunk.size, chunk.size, resolution, resolution);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const colours = new Float32Array(position.count * 3);
    const colour = new THREE.Color();
    const originX = chunk.cx * chunk.size + chunk.size / 2;
    const originZ = chunk.cz * chunk.size + chunk.size / 2;

    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i) + originX;
      const z = position.getZ(i) + originZ;
      position.setX(i, x);
      position.setZ(i, z);
      position.setY(i, world.terrain.heightAt(x, z));
      colour.setHex(SURFACE_COLOUR[world.terrain.surfaceAt(x, z)]);
      colours[i * 3] = colour.r;
      colours[i * 3 + 1] = colour.g;
      colours[i * 3 + 2] = colour.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.computeVertexNormals();
    content.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(chunk.size, 0.02, chunk.size));
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x5f6d7c, transparent: true, opacity: 0.6 }));
    line.position.set(originX, world.terrain.heightAt(originX, originZ) + 0.02, originZ);
    content.add(line);
  }

  function refresh(): void {
    clear();
    const chunks = world.chunks.active();
    if (chunks.length === 0) return;

    for (const chunk of chunks) buildChunk(chunk);

    // Frame the contents, not the chunk grid: an indoor room inside a 64 m
    // block would otherwise be a speck.
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
      const pad = 3;
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
    target = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    distance = Math.max(8, Math.max(maxX - minX, maxZ - minZ) * 1.9);

    for (const node of world.listNodes()) {
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.18, 0.18),
        new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.8 }),
      );
      marker.position.set(node.transform.pos.x, node.transform.pos.y + 0.12, node.transform.pos.z);
      content.add(marker);
    }

    const cameraPos = world.camera.pos;
    const player = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.5, 4),
      new THREE.MeshStandardMaterial({ color: 0xe07ab8 }),
    );
    player.position.set(cameraPos.x, cameraPos.y + 0.3, cameraPos.z);
    player.rotation.x = Math.PI;
    content.add(player);
  }

  function render(): void {
    const horizontal = distance * Math.cos(elevation);
    camera.position.set(
      target.x + horizontal * Math.sin(azimuth),
      target.y + distance * Math.sin(elevation),
      target.z + horizontal * Math.cos(azimuth),
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    azimuth -= (event.clientX - lastX) * 0.01;
    elevation = Math.max(0.2, Math.min(1.45, elevation + (event.clientY - lastY) * 0.008));
    lastX = event.clientX;
    lastY = event.clientY;
  });
  canvas.addEventListener('pointerup', () => {
    dragging = false;
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      distance = Math.max(4, Math.min(120, distance * (1 + Math.sign(event.deltaY) * 0.08)));
    },
    { passive: false },
  );

  resize();
  refresh();
  return { refresh, render, destroy: () => observer.disconnect() };
}

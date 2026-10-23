import * as THREE from 'three';
import { PhysicsWorld, World } from '@chrona/world';
import { MemoryArchive, ViewpointMemory } from '@chrona/storage';
import { ClipQueue, Harness } from '@chrona/harness';
import { ROOM_ITEMS, StubCodeAgent, createVideoGenerator } from '@chrona/services';
import { buildPreviewMesh, buildTerrainMesh, type Bounds } from './terrainMesh.js';

const SERVICE_URL = 'http://127.0.0.1:8000';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const recTime = document.querySelector<HTMLElement>('#rec-time')!;
const recSeg = document.querySelector<HTMLElement>('#rec-seg')!;
const renderWin = document.querySelector<HTMLElement>('#renderwin')!;
const clipVideo = document.querySelector<HTMLVideoElement>('#clip')!;
const previewBar = document.querySelector<HTMLElement>('#previewbar')!;
const logEl = document.querySelector<HTMLElement>('#log')!;
const logBody = document.querySelector<HTMLElement>('#log-body')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

/** Clean capture target: the game camera pass that feeds the render pipeline. */
const captureCanvas = document.createElement('canvas');
captureCanvas.width = 1344;
captureCanvas.height = 768;
const captureRenderer = new THREE.WebGLRenderer({ canvas: captureCanvas, antialias: true });
captureRenderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0810);
scene.fog = new THREE.Fog(0x0a0810, 12, 34);

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
const previewGroup = new THREE.Group();
scene.add(previewGroup);

const bounds: Bounds = { min: { x: -3.2, z: -2.6 }, max: { x: 3.2, z: 2.6 } };
let terrainMesh: THREE.Mesh | null = null;
let previewMesh: THREE.Mesh | null = null;
let activePreview: Awaited<ReturnType<Harness['previewTerrain']>> | null = null;

const log = (line: string): void => {
  logBody.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};

function addLights(): void {
  scene.add(new THREE.AmbientLight(0x404050, 1.1));
  const key = new THREE.DirectionalLight(0xcfd6e6, 0.7);
  key.position.set(2, 4, 3);
  scene.add(key);
  const lamp = new THREE.PointLight(0xffc98a, 9, 9, 2);
  lamp.position.set(2.7, 1.6, -1.35);
  scene.add(lamp);
  const tv = new THREE.PointLight(0xff6aa8, 5, 7, 2);
  tv.position.set(-2.9, 1.3, 0.6);
  scene.add(tv);
  const windowGlow = new THREE.PointLight(0x6a7fa8, 4, 9, 2);
  windowGlow.position.set(3.0, 1.5, 0.4);
  scene.add(windowGlow);
}

async function boot(): Promise<void> {
  const physics = await PhysicsWorld.create();
  const world = new World({
    worldId: 'demo',
    seed: 0x8f21c4,
    terrain: { profile: 'indoor', amplitude: 0, baseHeight: 0 },
    physics,
  });

  const harness = new Harness({
    worldId: 'demo',
    world,
    archive: new MemoryArchive(),
    agent: new StubCodeAgent(),
    video: await createVideoGenerator(SERVICE_URL),
    memory: new ViewpointMemory(),
  });

  const outcomes = await harness.seedRoom(ROOM_ITEMS);
  log(`assets ${outcomes.length} bound`);
  scene.add(world.scene);
  addLights();

  terrainMesh = buildTerrainMesh(world.terrain, bounds);
  scene.add(terrainMesh);

  camera.aspect = 16 / 9;
  camera.updateProjectionMatrix();

  world.teleport(0, 0);
  world.setLook(0, (-8 * Math.PI) / 180);
  await world.chunks.warmup(world.cameraPosition);

  const input = { forward: 0, right: 0, sprint: false, yawDelta: 0, pitchDelta: 0 };
  const keys = new Set<string>();
  let recordingBlob: Blob[] = [];
  let mediaRecorder: MediaRecorder | null = null;

  const startCapture = (): void => {
    recordingBlob = [];
    const stream = captureCanvas.captureStream(24);
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    mediaRecorder.ondataavailable = (event) => recordingBlob.push(event.data);
    mediaRecorder.start();
  };

  const stopCapture = (): Promise<string> =>
    new Promise((resolve) => {
      if (!mediaRecorder) {
        resolve('');
        return;
      }
      mediaRecorder.onstop = () => {
        resolve(URL.createObjectURL(new Blob(recordingBlob, { type: 'video/webm' })));
      };
      mediaRecorder.stop();
    });

  const queue = new ClipQueue(
    (segment, previous) => harness.renderSegment(segment, previous),
    (jobs) => {
      const done = jobs.filter((job) => job.status === 'ready' || job.status === 'failed').length;
      log(`queue ${done}/${jobs.length}`);
    },
  );

  const renderSegments = async (segments: ReturnType<Harness['stopRecording']>): Promise<void> => {
    if (segments.length === 0) return;
    log(`recorded ${segments.length} segment(s)`);
    queue.enqueue(segments);
    const jobs = await queue.drain();
    for (const job of jobs) {
      log(`clip ${job.segment.clipId} ${job.status} (${job.result?.meta.degraded ?? job.error ?? ''})`);
    }
  };

  let recordedSegments: ReturnType<Harness['stopRecording']> = [];

  const toggleRecording = async (): Promise<void> => {
    if (!harness.recorder.isRecording) {
      harness.startRecording();
      startCapture();
      hud.classList.add('on');
      log('recording…');
      return;
    }
    recordedSegments = harness.stopRecording();
    hud.classList.remove('on');
    const url = await stopCapture();
    if (url) {
      clipVideo.src = url;
      renderWin.classList.add('has-clip');
      void clipVideo.play();
    }
    await renderSegments(recordedSegments);
  };

  function syncCamera(): void {
    const state = world.camera;
    camera.position.set(state.pos.x, state.pos.y, state.pos.z);
    camera.quaternion.set(state.quat.x, state.quat.y, state.quat.z, state.quat.w);
  }

  function estimateSegments(frames: number): number {
    const spec = harness.clipSpec.frames;
    const overlap = 48;
    return frames <= spec ? 1 : 1 + Math.ceil((frames - spec) / (spec - overlap));
  }

  const resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
    const viewWidth = Math.min(width, (height * 16) / 9);
    renderer.setViewport((width - viewWidth) / 2, 0, viewWidth, height);
  };
  window.addEventListener('resize', resize);
  resize();

  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) {
      void canvas.requestPointerLock();
      return;
    }
    if (activePreview) void confirmPreview();
  });

  document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement !== canvas) return;
    const look = world.look;
    world.setLook(look.yaw - event.movementX * 0.0022, look.pitch - event.movementY * 0.0022);
  });

  window.addEventListener('keydown', (event) => {
    keys.add(event.code);
    if (event.code === 'KeyR') void toggleRecording();
    if (event.code === 'KeyE') void startPreview();
    if (event.code === 'KeyL') logEl.classList.toggle('on');
    if (event.code === 'Escape') cancelPreview();
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));

  async function startPreview(): Promise<void> {
    if (activePreview) return;
    activePreview = await harness.previewTerrain('抬高一米');
    previewMesh = buildPreviewMesh(world.terrain, activePreview.draft);
    previewGroup.add(previewMesh);
    previewBar.classList.add('on');
    log(`preview: ${activePreview.draft.op} r=${activePreview.draft.shape.radius.toFixed(1)}m`);
  }

  async function confirmPreview(): Promise<void> {
    if (!activePreview) return;
    await harness.commitTerrain(activePreview);
    cancelPreview();
    if (terrainMesh) scene.remove(terrainMesh);
    terrainMesh = buildTerrainMesh(world.terrain, bounds);
    scene.add(terrainMesh);
    log('terrain committed');
  }

  function cancelPreview(): void {
    previewBar.classList.remove('on');
    if (previewMesh) {
      previewGroup.remove(previewMesh);
      previewMesh.geometry.dispose();
      previewMesh = null;
    }
    activePreview = null;
  }

  const clock = new THREE.Clock();
  let elapsed = 0;

  function animate(): void {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    input.forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    input.right = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');

    world.update(dt, input);
    harness.tickRecording();

    if (harness.recorder.isRecording) {
      const seconds = harness.recorder.durationMs / 1000;
      recTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
      recSeg.textContent = `· 预计 ${estimateSegments(Math.round(seconds * 24))} 段`;
    }

    syncCamera();

    // Display pass: preview layer visible. Capture pass: world only.
    previewGroup.visible = true;
    renderer.render(scene, camera);
    previewGroup.visible = false;
    captureRenderer.render(scene, camera);
    previewGroup.visible = true;
  }

  animate();
  log(`video service: ${harness.video.name}`);
  document.title = 'Chrona · ready';
}

boot().catch((error: unknown) => {
  console.error(error);
  log(`fatal: ${(error as Error).message}`);
});

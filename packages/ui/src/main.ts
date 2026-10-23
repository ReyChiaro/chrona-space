import * as THREE from 'three';
import { PhysicsWorld, World } from '@chrona/world';
import { MemoryArchive, ViewpointMemory, type Archive } from '@chrona/storage';
import { ClipQueue, Harness, restoreWorld, snapshotWorld, type SavedWorld, type Segment } from '@chrona/harness';
import {
  ApiCodeAgent,
  ProxyTransport,
  ROOM_ITEMS,
  StubCodeAgent,
  createVideoGenerator,
  type CodeAgent,
} from '@chrona/services';
import { hashString } from '@chrona/world';
import { buildPreviewMesh, buildTerrainMesh, type Bounds } from './terrainMesh.js';
import { WindowLayer } from './windows.js';
import { createMap2D } from './map2d.js';
import { createMap3D } from './map3d.js';
import { toast } from './toast.js';
import { IdbArchive, IdbStore, withTimeout } from './persistence.js';

const SERVICE_URL =
  new URLSearchParams(location.search).get('service') ?? 'http://127.0.0.1:8000';
const THUMB_WIDTH = Math.min(1344, Math.max(160, Number(new URLSearchParams(location.search).get('thumb') ?? 512) || 512));
const BOUNDS: Bounds = { min: { x: -3.2, z: -2.6 }, max: { x: 3.2, z: 2.6 } };
const DOCK: { id: string; glyph: string; label: string }[] = [
  { id: 'render', glyph: '▣', label: '渲染' },
  { id: 'map3d', glyph: '◈', label: '3D 地图' },
  { id: 'map2d', glyph: '▦', label: '2D 地图' },
  { id: 'params', glyph: '⚙', label: '参数' },
  { id: 'log', glyph: '≡', label: '日志' },
  { id: 'help', glyph: '?', label: '键位' },
  { id: 'create', glyph: '＋', label: '创作' },
  { id: 'library', glyph: '▤', label: '素材库' },
  { id: 'stats', glyph: '◔', label: '状态' },
];

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const recTime = document.querySelector<HTMLElement>('#rec-time')!;
const recSeg = document.querySelector<HTMLElement>('#rec-seg')!;
const hint = document.querySelector<HTMLElement>('#hint')!;
const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
const windowHost = document.querySelector<HTMLElement>('#windows')!;
const dock = document.querySelector<HTMLElement>('#dock')!;
const previewBar = document.querySelector<HTMLElement>('#previewbar')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

/** Clean capture target: the game-camera pass that feeds the render pipeline. */
const captureCanvas = document.createElement('canvas');
captureCanvas.width = 1344;
captureCanvas.height = 768;
const captureRenderer = new THREE.WebGLRenderer({ canvas: captureCanvas, antialias: true });
captureRenderer.outputColorSpace = THREE.SRGBColorSpace;

/** In-memory reference frame for memory / tail handoff. Resolution is configurable. */
const thumbCanvas = document.createElement('canvas');
const thumbContext = thumbCanvas.getContext('2d')!;
let thumbWidth = THUMB_WIDTH;
function applyThumbWidth(width: number): void {
  thumbWidth = Math.min(1344, Math.max(160, Math.round(width)));
  thumbCanvas.width = thumbWidth;
  thumbCanvas.height = Math.round((thumbWidth * 9) / 16);
}
applyThumbWidth(THUMB_WIDTH);
function captureThumbnail(): { path: string; width: number; height: number } {
  thumbContext.drawImage(captureCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  return {
    path: thumbCanvas.toDataURL('image/webp', 0.72),
    width: thumbCanvas.width,
    height: thumbCanvas.height,
  };
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0810);
scene.fog = new THREE.Fog(0x0a0810, 12, 34);
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
const previewLayer = new THREE.Group();
scene.add(previewLayer);

async function boot(): Promise<void> {
  const physics = await PhysicsWorld.create();
  let chunkGenerator: ((record: import('@chrona/world').ChunkRecord) => Promise<void>) | null = null;
  const world = new World({
    worldId: 'demo',
    seed: 0x8f21c4,
    terrain: { profile: 'indoor', amplitude: 0, baseHeight: 0 },
    physics,
    chunkSize: 16,
    loadRadius: 1,
    prefetchRadius: 2,
    generateChunk: async (record) => {
      if (chunkGenerator) await chunkGenerator(record);
    },
  });
  let store: IdbStore | null = null;
  let archive: Archive = new MemoryArchive();
  try {
    store = await withTimeout(new IdbStore().open(), 12000);
    archive = new IdbArchive(store);
  } catch {
    archive = new MemoryArchive();
  }
  const generator = await createVideoGenerator(SERVICE_URL);
  let agentRef: CodeAgent = new StubCodeAgent();
  let loras: { id: string; label: string }[] = [];
  let apiAgentEnabled = false;
  if ('config' in generator && typeof generator.config === 'function') {
    try {
      const config = await generator.config();
      apiAgentEnabled = config.agentEnabled;
      loras = config.loras ?? [];
    } catch {
      apiAgentEnabled = false;
    }
  }

  const harness = new Harness({
    worldId: 'demo',
    world,
    archive,
    agent: {
      get name() {
        return agentRef.name;
      },
      createAsset: (request) => agentRef.createAsset(request),
      createTerrainEdit: (request) => agentRef.createTerrainEdit(request),
    },
    video: generator,
    memory: new ViewpointMemory(),
  });

  if (apiAgentEnabled) {
    agentRef = new ApiCodeAgent(new ProxyTransport(SERVICE_URL), harness.createToolHost());
  }

  addLights();
  scene.add(world.scene);

  /** Snapshot of the parts of the world worth keeping across reloads. */
  async function saveWorldState(): Promise<void> {
    if (!store) return;
    const saved: SavedWorld = snapshotWorld(world, 0x8f21c4);
    await store.saveWorld(saved);
  }

  const bootMessages: string[] = [];
  chunkGenerator = async (record) => {
    const centreX = (record.cx + 0.5) * record.size;
    const centreZ = (record.cz + 0.5) * record.size;
    if (Math.hypot(centreX, centreZ) < 14) return; // keep the authored room clean
    if (world.listNodes().some((node) => node.chunkId === record.id)) return; // restored content

    const seed = parseInt(hashString(record.id), 16) || 1;
    let state = seed;
    const rand = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const picks = ['木箱', '小桌', '落地灯', '盆栽', '矮柜'];
    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i += 1) {
      const angle = rand() * Math.PI * 2;
      const radius = 2 + rand() * Math.max(1, record.size / 2 - 3);
      await harness.createAsset(
        picks[Math.floor(rand() * picks.length)]!,
        { x: centreX + Math.cos(angle) * radius, y: 0, z: centreZ + Math.sin(angle) * radius },
        rand() * Math.PI * 2,
      );
    }
    await saveWorldState();
    bootMessages.push(`区块 ${record.id}：${count} 件环境资产`);
  };

  const restored = store ? await store.loadWorld() : undefined;
  let bootNote = '';
  if (restored) {
    const count = await restoreWorld(world, archive, restored);
    bootNote = `恢复 ${count} 资产 · ${restored.edits.length} 地形编辑`;
  } else {
    await harness.seedRoom(ROOM_ITEMS);
    await saveWorldState();
    bootNote = store ? '新建世界（已写入 IndexedDB）' : '新建世界（存储不可用，本次不持久化）';
  }

  let terrainMesh = buildTerrainMesh(world.terrain, BOUNDS);
  scene.add(terrainMesh);

  world.teleport(0, 0);
  world.setLook(0, (-8 * Math.PI) / 180);
  await world.chunks.warmup(world.cameraPosition);

  const windows = new WindowLayer(windowHost);

  // ------------------------------------------------------------------ log
  const logBody = document.createElement('pre');
  logBody.className = 'log-body';
  windows.create({ id: 'log', title: '日志', body: logBody, width: 460, height: 240, x: 24, y: 420 });

  const log = (line: string): void => {
    const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    logBody.textContent += `${stamp}  ${line}\n`;
    logBody.scrollTop = logBody.scrollHeight;
  };

  // ----------------------------------------------------------------- help
  const helpBody = document.createElement('div');
  helpBody.className = 'keys';
  helpBody.innerHTML = [
    ['WASD / Shift', '移动 / 快走'],
    ['空格', '跳跃'],
    ['鼠标', '视角（点击画面锁定指针）'],
    ['R', '开始 / 结束录制'],
    ['E', '地形预览（左键确认）'],
    ['Q / 右键', '取消预览'],
    ['V', '渲染窗口：小窗 → 并排 → 全屏 → 隐藏'],
    ['H', '键位'],
    ['L', '日志'],
    ['P', '参数'],
    ['M / N', '3D 地图 / 2D 地图'],
    ['C', '创作'],
    ['B', '素材库'],
    ['O', '状态'],
    ['Esc / Backspace', '关闭最近打开的窗口（指针锁定时先按 Esc 解锁）'],
    ['右键', '选中物体（再点空白取消）'],
  ]
    .map(([key, text]) => `<div><kbd>${key}</kbd><span>${text}</span></div>`)
    .join('');
  windows.create({ id: 'help', title: '键位', body: helpBody, width: 430, height: 430, x: 140, y: 110 });

  // --------------------------------------------------------------- render
  const renderBody = document.createElement('div');
  renderBody.className = 'render-body';
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  const empty = document.createElement('div');
  empty.className = 'render-empty';
  empty.textContent = '尚未生成';
  const badge = document.createElement('div');
  badge.className = 'render-badge';
  badge.textContent = 'STUB · 未接模型';
  const queueLabel = document.createElement('div');
  queueLabel.className = 'render-queue';
  queueLabel.textContent = '队列 0/0';
  renderBody.append(video, empty, badge, queueLabel);
  const renderWindow = windows.create({
    id: 'render',
    title: '渲染',
    body: renderBody,
    width: 360,
    height: 240,
    x: innerWidth - 384,
    y: 20,
  });

  // ----------------------------------------------------------------- maps
  const map3dCanvas = document.createElement('canvas');
  map3dCanvas.className = 'map-canvas';
  windows.create({
    id: 'map3d',
    title: '3D 地图',
    body: map3dCanvas,
    width: 380,
    height: 300,
    x: 24,
    y: 64,
  });

  const map2dCanvas = document.createElement('canvas');
  map2dCanvas.className = 'map-canvas';
  windows.create({
    id: 'map2d',
    title: '2D 地图',
    body: map2dCanvas,
    width: 380,
    height: 300,
    x: 430,
    y: 64,
  });

  const map2d = createMap2D(map2dCanvas, world, (x, z) => {
    world.teleport(x, z);
    log(`传送 → ${x.toFixed(1)}, ${z.toFixed(1)}`);
    toast('已传送', 'info');
    map3dView.refresh();
  });
  const map3dView = createMap3D(map3dCanvas, world);

  // ---------------------------------------------------------------- stats
  const statsBody = document.createElement('div');
  statsBody.className = 'stats';
  windows.create({ id: 'stats', title: '状态', body: statsBody, width: 260, height: 150, x: innerWidth - 300, y: 280 });

  // --------------------------------------------------------------- create
  const createBody = document.createElement('div');
  createBody.className = 'create';
  const createInput = document.createElement('input');
  createInput.placeholder = '描述要添加的物体，回车提交';
  const createStatus = document.createElement('div');
  createStatus.className = 'create-status';
  createBody.append(createInput, createStatus);
  windows.create({ id: 'create', title: '创作', body: createBody, width: 330, height: 160, x: innerWidth - 350, y: 470 });

  // -------------------------------------------------------------- library
  const libraryBody = document.createElement('div');
  libraryBody.className = 'library';
  const libraryWindow = windows.create({
    id: 'library',
    title: '素材库',
    body: libraryBody,
    width: 280,
    height: 360,
    x: 24,
    y: 64,
  });

  const refreshLibrary = (): void => {
    libraryBody.innerHTML = '';
    const nodes = world.listNodes();
    for (const node of nodes) {
      const row = document.createElement('button');
      row.className = 'lib-row';
      row.innerHTML = `<span>${node.semantic ?? node.id}</span><em>${node.assetRef?.version ?? ''}</em>`;
      row.title = node.id;
      row.addEventListener('click', () => {
        world.teleport(node.transform.pos.x + 1.2, node.transform.pos.z + 1.2);
        log(`定位 ${node.semantic ?? node.id}`);
      });
      libraryBody.append(row);
    }
    if (nodes.length === 0) libraryBody.textContent = '空';
  };
  void libraryWindow;

  // --------------------------------------------------------------- params
  const paramsBody = document.createElement('div');
  paramsBody.className = 'params';
  windows.create({ id: 'params', title: '参数', body: paramsBody, width: 330, height: 430, x: innerWidth - 380, y: 300 });
  buildParams(paramsBody, harness, { onThumbWidth: applyThumbWidth, loras });

  // -------------------------------------------------------------- preview
  let previewMesh: THREE.Mesh | null = null;
  let draft: Awaited<ReturnType<Harness['previewTerrain']>> | null = null;

  const preview = {
    isActive: (): boolean => draft !== null,
    async start(): Promise<void> {
      if (draft) return;
      draft = await harness.previewTerrain('抬高一米');
      previewMesh = buildPreviewMesh(world.terrain, draft.draft);
      previewLayer.add(previewMesh);
      previewBar.classList.add('on');
      log(`预览 ${draft.draft.op} · r=${draft.draft.shape.radius.toFixed(1)}m`);
    },
    confirm(): void {
      if (!draft) return;
      const pending = draft;
      preview.cancel();
      void harness.commitTerrain(pending).then(async () => {
        scene.remove(terrainMesh);
        terrainMesh = buildTerrainMesh(world.terrain, BOUNDS);
        scene.add(terrainMesh);
        map3dView.refresh();
        await saveWorldState();
        log('地形已提交');
        toast('地形已提交', 'success');
      });
    },
    cancel(): void {
      previewBar.classList.remove('on');
      if (previewMesh) {
        previewLayer.remove(previewMesh);
        previewMesh.geometry.dispose();
        previewMesh = null;
      }
      draft = null;
    },
  };

  // ----------------------------------------------------------------- dock
  const syncDock = (): void => {
    windows.setActiveDock(
      new Set(
        [...dock.querySelectorAll<HTMLButtonElement>('button')]
          .filter((button) => windows.isOpen(button.dataset.win ?? ''))
          .map((button) => button.dataset.win ?? ''),
      ),
    );
  };

  for (const entry of DOCK) {
    const button = document.createElement('button');
    button.dataset.win = entry.id;
    button.textContent = entry.glyph;
    button.title = entry.label;
    button.addEventListener('click', () => {
      windows.toggle(entry.id);
      syncDock();
      if (entry.id === 'map3d' && windows.isOpen('map3d')) map3dView.refresh();
      if (entry.id === 'library' && windows.isOpen('library')) refreshLibrary();
      if (entry.id === 'create') createInput.focus();
    });
    dock.append(button);
  }

  async function deleteSelected(): Promise<void> {
    if (!selected) return;
    const { nodeId, semantic } = selected;
    harness.removeAsset(nodeId);
    clearOutline();
    selected = null;
    updateCreateMode();
    await saveWorldState();
    map3dView.refresh();
    refreshLibrary();
    log(`删除 ${semantic}`);
    toast(`已删除 ${semantic}`, 'success');
  }

  async function submitCreate(): Promise<void> {
    const text = createInput.value.trim();
    if (!text) return;
    createStatus.textContent = '处理中…';
    try {
      if (selected) {
        const outcome = await harness.modifyAsset(selected.nodeId, text);
        createStatus.textContent = `${outcome.bundle.semantic} · v${outcome.bundle.version}`;
        log(`修改 ${outcome.bundle.semantic} → v${outcome.bundle.version}：${text}`);
        toast(`已修改 ${outcome.bundle.semantic} → v${outcome.bundle.version}`, 'success');
        selectNode(selected.nodeId);
      } else {
        const outcome = await harness.createAsset(text);
        createStatus.textContent = `${outcome.bundle.semantic} · ${outcome.validation.ok ? '通过' : '降级'}`;
        log(`新增 ${outcome.bundle.semantic} (${outcome.bundle.assetId})`);
        toast(`已添加 ${outcome.bundle.semantic}`, 'success');
      }
      createInput.value = '';
      await saveWorldState();
      map3dView.refresh();
      refreshLibrary();
    } catch (error) {
      createStatus.textContent = `失败：${(error as Error).message}`;
      toast(`失败：${(error as Error).message}`, 'error');
    }
  }
  createInput.addEventListener('keydown', (event) => {
    if (event.code === 'Enter') void submitCreate();
  });

  // ------------------------------------------------------------- selection
  let selected: { nodeId: string; semantic: string } | null = null;
  let outline: THREE.BoxHelper | null = null;

  function clearOutline(): void {
    if (!outline) return;
    scene.remove(outline);
    outline.geometry.dispose();
    (outline.material as THREE.Material).dispose();
    outline = null;
  }

  function updateCreateMode(): void {
    const title = document.querySelector<HTMLElement>('.win[data-window="create"] .win-title');
    if (title) title.textContent = selected ? `修改 · ${selected.semantic}` : '创作';
    createInput.placeholder = selected ? '描述要怎么改，回车提交' : '描述要添加的物体，回车提交';
  }

  function selectNode(nodeId: string | null): void {
    clearOutline();
    if (!nodeId) {
      selected = null;
      updateCreateMode();
      return;
    }
    const node = world.listNodes().find((candidate) => candidate.id === nodeId);
    const object = world.objectOf(nodeId);
    if (!node || !object) {
      selected = null;
      updateCreateMode();
      return;
    }
    selected = { nodeId, semantic: node.semantic ?? nodeId };
    outline = new THREE.BoxHelper(object, 0x9fd0ff);
    outline.renderOrder = 6;
    const material = outline.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.9;
    scene.add(outline);
    updateCreateMode();
    toast(`已选中 ${selected.semantic}`, 'info');
  }

  window.addEventListener('pointerdown', (event) => {
    if (event.button !== 2) return;
    if (preview.isActive()) {
      preview.cancel();
      return;
    }
    const hit = world.pick(60);
    selectNode(hit?.nodeId ?? null);
  });

  // ------------------------------------------------------------- recording
  let recorderChunks: Blob[] = [];
  let mediaRecorder: MediaRecorder | null = null;

  const startCapture = (): void => {
    recorderChunks = [];
    const stream = captureCanvas.captureStream(24);
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    mediaRecorder.ondataavailable = (event) => recorderChunks.push(event.data);
    mediaRecorder.start();
  };

  const stopCapture = (): Promise<string> =>
    new Promise((resolve) => {
      if (!mediaRecorder) {
        resolve('');
        return;
      }
      mediaRecorder.onstop = () => resolve(URL.createObjectURL(new Blob(recorderChunks, { type: 'video/webm' })));
      mediaRecorder.stop();
    });

  const queue = new ClipQueue(
    (segment, previous) => harness.renderSegment(segment, previous),
    (jobs) => {
      const done = jobs.filter((job) => job.status === 'ready' || job.status === 'failed').length;
      queueLabel.textContent = `队列 ${done}/${jobs.length}`;
    },
  );

  async function toggleRecording(): Promise<void> {
    if (!harness.recorder.isRecording) {
      harness.startRecording();
      startCapture();
      hud.classList.add('on');
      log('录制开始');
      toast('录制中…', 'info');
      return;
    }
    const recordedMs = harness.recorder.durationMs;
    const segments: Segment[] = harness.stopRecording();
    hud.classList.remove('on');
    const url = await stopCapture();
    if (url) {
      video.src = url;
      renderBody.classList.add('has-clip');
      void video.play();
      renderWindow.show();
    }

    // Upload the blockout recording so the model gets a real <Video 1>.
    const blob = new Blob(recorderChunks, { type: 'video/webm' });
    if (blob.size > 0 && harness.video.uploadSource) {
      const uploadId = `src_${Date.now().toString(36)}`;
      try {
        await harness.video.uploadSource(uploadId, blob);
        harness.setBlockout({ uploadId, fps: 24, durationMs: Math.round(recordedMs) });
        log(`blockout 已上传 ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      } catch (error) {
        log(`blockout 上传失败：${(error as Error).message}`);
      }
    }

    log(`录制结束 · ${segments.length} 段`);
    toast(`录制结束 · ${segments.length} 段`, 'success');
    queue.enqueue(segments);
    const jobs = await queue.drain();
    harness.setBlockout(undefined);
    for (const job of jobs) {
      log(`clip ${job.segment.clipId} ${job.status}${job.result?.meta.degraded ? ` · ${job.result.meta.degraded}` : ''}`);
      if (job.result?.video) {
        video.src = `${SERVICE_URL}/clips/${job.segment.clipId}/video`;
        renderBody.classList.add('has-clip');
        renderWindow.show();
        void video.play().catch(() => undefined);
      }
    }
    syncDock();
  }

  function estimateSegments(frames: number): number {
    const total = harness.clipSpec.frames;
    const overlap = harness.overlapFrames;
    return frames <= total ? 1 : 1 + Math.ceil((frames - total) / (total - overlap));
  }

  // ------------------------------------------------------------ render mode
  let renderMode: 'window' | 'side' | 'full' | 'hidden' = 'window';
  let savedRect = { x: innerWidth - 384, y: 20, width: 360, height: 240 };

  function applyRenderMode(): void {
    if (renderMode === 'hidden') {
      renderWindow.hide();
      return;
    }
    renderWindow.show();
    if (renderMode === 'window') renderWindow.setRect(savedRect);
    if (renderMode === 'side') {
      renderWindow.setRect({
        x: Math.round(innerWidth * 0.52),
        y: 24,
        width: Math.round(innerWidth * 0.46),
        height: innerHeight - 48,
      });
    }
    if (renderMode === 'full') {
      renderWindow.setRect({ x: 24, y: 24, width: innerWidth - 48, height: innerHeight - 48 });
    }
    layoutViewport();
  }

  function cycleRenderMode(): void {
    const order: typeof renderMode[] = ['window', 'side', 'full', 'hidden'];
    if (renderMode === 'window') {
      savedRect = {
        x: renderWindow.element.offsetLeft,
        y: renderWindow.element.offsetTop,
        width: renderWindow.element.offsetWidth,
        height: renderWindow.element.offsetHeight,
      };
    }
    renderMode = order[(order.indexOf(renderMode) + 1) % order.length];
    applyRenderMode();
    syncDock();
  }

  // ---------------------------------------------------------------- input
  const input = { forward: 0, right: 0, sprint: false, jump: false, yawDelta: 0, pitchDelta: 0 };
  const keys = new Set<string>();
  let jumpRequested = false;

  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) {
      void canvas.requestPointerLock();
      return;
    }
    if (preview.isActive()) preview.confirm();
  });

  document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement !== canvas) return;
    const look = world.look;
    world.setLook(look.yaw - event.movementX * 0.0022, look.pitch - event.movementY * 0.0022);
  });

  window.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('pointerdown', (event) => {
    if (event.button === 2 && preview.isActive()) preview.cancel();
  });

  window.addEventListener('keydown', (event) => {
    keys.add(event.code);
    switch (event.code) {
      case 'KeyR':
        void toggleRecording();
        break;
      case 'KeyE':
        void preview.start();
        break;
      case 'KeyQ':
        preview.cancel();
        break;
      case 'KeyV':
        cycleRenderMode();
        break;
      case 'Space':
        event.preventDefault();
        if (!event.repeat) jumpRequested = true;
        break;
      case 'KeyH':
        windows.toggle('help');
        break;
      case 'KeyL':
        windows.toggle('log');
        break;
      case 'KeyP':
        windows.toggle('params');
        break;
      case 'KeyM':
        windows.toggle('map3d');
        if (windows.isOpen('map3d')) map3dView.refresh();
        break;
      case 'KeyN':
        windows.toggle('map2d');
        break;
      case 'KeyC':
        windows.toggle('create');
        if (windows.isOpen('create')) createInput.focus();
        break;
      case 'KeyB':
        windows.toggle('library');
        if (windows.isOpen('library')) refreshLibrary();
        break;
      case 'Delete':
        if (selected) void deleteSelected();
        break;
      case 'KeyO':
        windows.toggle('stats');
        break;
      case 'Escape':
        if (document.pointerLockElement === canvas) {
          toast('已解锁；再按 Esc 或 Backspace 关闭窗口', 'info');
          break;
        }
        if (!windows.closeLast()) windows.closeAll();
        break;
      case 'Backspace':
        event.preventDefault();
        if (!windows.closeLast()) windows.closeAll();
        break;
      default:
        break;
    }
    if (event.code.startsWith('Key') || event.code === 'Escape' || event.code === 'Backspace') syncDock();
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    crosshair.classList.toggle('dim', !locked);
    hint.textContent = locked
      ? 'WASD 移动 · R 录制 · E 地形预览 · Q 取消 · H 键位 · M/N 地图'
      : '点击画面进入 · H 查看键位';
  });

  // --------------------------------------------------------------- resize
  function layoutViewport(): void {
    const side = renderMode === 'side';
    const width = Math.max(320, side ? Math.floor(window.innerWidth / 2) : window.innerWidth);
    const height = window.innerHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.display = renderMode === 'full' ? 'none' : 'block';
    renderer.setSize(width, height, false);
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
    const viewWidth = Math.min(width, (height * 16) / 9);
    renderer.setViewport((width - viewWidth) / 2, 0, viewWidth, height);
  }
  window.addEventListener('resize', layoutViewport);
  layoutViewport();

  // ----------------------------------------------------------------- loop
  const clock = new THREE.Clock();
  let lastStats = 0;
  let thumbTick = 0;

  function animate(): void {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    input.forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    input.right = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    input.jump = jumpRequested;
    jumpRequested = false;

    world.update(dt, input);
    harness.tickRecording();

    if (harness.recorder.isRecording) {
      const seconds = harness.recorder.durationMs / 1000;
      recTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
      recSeg.textContent = `· 预计 ${estimateSegments(Math.round(seconds * 24))} 段`;
    }

    const state = world.camera;
    camera.position.set(state.pos.x, state.pos.y, state.pos.z);
    camera.quaternion.set(state.quat.x, state.quat.y, state.quat.z, state.quat.w);

    // Display pass includes the preview layer.
    previewLayer.visible = true;
    renderer.render(scene, camera);

    // Capture pass only runs while recording: it is a second full-resolution
    // render and was one of the main causes of frame drops.
    if (harness.recorder.isRecording) {
      previewLayer.visible = false;
      captureRenderer.render(scene, camera);
      previewLayer.visible = true;
      thumbTick += 1;
      // 4 fps of reference frames: enough for memory and tail handoff.
      if (thumbTick % 6 === 0) harness.recorder.annotateLast(captureThumbnail());
    }

    if (outline) outline.update();
    if (windows.isOpen('map2d')) map2d.draw();
    if (windows.isOpen('map3d')) map3dView.render();

    const now = performance.now();
    if (now - lastStats > 250 && windows.isOpen('stats')) {
      lastStats = now;
      statsBody.innerHTML = [
        `<div><b>${(world.simTimeMs / 1000).toFixed(1)}s</b> 世界时间</div>`,
        `<div>${state.pos.x.toFixed(2)}, ${state.pos.y.toFixed(2)}, ${state.pos.z.toFixed(2)}</div>`,
        `<div>区块 ${world.chunks.active().length} · 资产 ${world.listNodes().length}</div>`,
        `<div>${harness.video.name} · ${harness.recorder.isRecording ? '录制中' : '待机'}</div>`,
      ].join('');
    }
  }

  refreshLibrary();
  applyRenderMode();
  syncDock();

  // Debug/deep-link: /?w=map3d,map2d opens windows on boot.
  const requested = new URLSearchParams(location.search).get('w');
  if (requested) {
    for (const id of requested.split(',')) {
      const win = windows.get(id.trim());
      if (win) win.show();
    }
    syncDock();
    if (windows.isOpen('map3d')) map3dView.refresh();
  }

  animate();
  log(`${bootNote} · chunks ${world.chunks.active().length} · ${harness.video.name}`);
  for (const message of bootMessages) log(message);
  const query = new URLSearchParams(location.search);
  const selectParam = query.get('select');
  if (selectParam) {
    const nodes = world.listNodes();
    const node = selectParam === 'first' ? nodes[0] : nodes.find((n) => n.assetRef?.assetId === selectParam);
    if (node) selectNode(node.id);
  }
  const modeParam = query.get('mode');
  if (modeParam === 'side' || modeParam === 'full' || modeParam === 'hidden' || modeParam === 'window') {
    renderMode = modeParam;
    applyRenderMode();
  }
  document.title = 'Chrona · ready';
}

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

function buildParams(
  root: HTMLElement,
  harness: Harness,
  options: { onThumbWidth: (width: number) => void; loras: { id: string; label: string }[] },
): void {
  const params = harness.renderParams;

  const row = (label: string, control: HTMLElement, value?: HTMLElement): void => {
    const div = document.createElement('div');
    div.className = 'row';
    const name = document.createElement('label');
    name.textContent = label;
    const right = document.createElement('div');
    right.className = 'row-right';
    right.append(control);
    if (value) right.append(value);
    div.append(name, right);
    root.append(div);
  };

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (next: number) => void,
  ): void => {
    const display = document.createElement('span');
    display.className = 'v';
    display.textContent = String(value);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      display.textContent = input.value;
      onChange(Number(input.value));
    });
    row(label, input, display);
  };

  slider('步数', params.steps, 4, 60, 1, (value) => harness.setParams({ steps: value }));
  slider('选片数', params.candidates, 1, 4, 1, (value) => harness.setParams({ candidates: value }));
  slider('颗粒', params.grain, 0, 1, 0.05, (value) => harness.setParams({ grain: value }));

  const seed = document.createElement('input');
  seed.type = 'number';
  seed.className = 'num';
  seed.value = String(params.seed);
  seed.addEventListener('change', () => harness.setParams({ seed: Number(seed.value) }));
  row('seed', seed);

  const toggle = (label: string, initial: boolean, onChange: (on: boolean) => void): void => {
    const button = document.createElement('button');
    button.className = 'switch';
    button.textContent = initial ? '开' : '关';
    button.classList.toggle('on', initial);
    button.addEventListener('click', () => {
      const next = !button.classList.contains('on');
      button.classList.toggle('on', next);
      button.textContent = next ? '开' : '关';
      onChange(next);
    });
    row(label, button);
  };

  toggle('超分 1080p', params.upscale, (on) => harness.setParams({ upscale: on }));

  // LoRA list comes from the video service (/config); empty means "none installed".
  const enabledLoras = new Set<string>();
  if (options.loras.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML = '<label>LoRA</label><span class="v">未安装</span>';
    root.append(empty);
  } else {
    for (const lora of options.loras) {
      toggle(`LoRA · ${lora.label}`, false, (on) => {
        if (on) enabledLoras.add(lora.id);
        else enabledLoras.delete(lora.id);
        harness.setParams({ loras: [...enabledLoras].map((id) => ({ id, weight: 1 })) });
      });
    }
  }

  slider('缩略图宽', 512, 160, 1024, 32, (value) => options.onThumbWidth(value));

  slider('切段重叠', harness.overlapFrames, 0, 96, 1, (value) => harness.setOverlapFrames(value));
  slider('记忆采样', harness.sampleStride, 1, 24, 1, (value) => harness.setSampleStride(value));

  const canvasValue = document.createElement('span');
  canvasValue.className = 'v';
  canvasValue.textContent = `${params.canvas.width}×${params.canvas.height}`;
  row('画布', document.createElement('span'), canvasValue);
}

boot().catch((error: unknown) => {
  console.error(error);
  windowHost.textContent = `启动失败：${(error as Error).message}`;
  toast(`启动失败：${(error as Error).message}`, 'error');
});

#!/usr/bin/env node
/**
 * Headless Chrona runner.
 *
 *   chrona run --world demo --path tests/paths/room_orbit.json --offline
 *
 * No renderer: frames carry camera poses only, so the video generator receives
 * a structurally complete request without pixels. The WebUI produces pixels.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FsArchive, FsWorldStore } from '@chrona/storage/fs';
import { ViewpointMemory } from '@chrona/storage';
import { PhysicsWorld, World } from '@chrona/world';
import { ClipQueue, Harness } from '@chrona/harness';
import { ROOM_ITEMS, StubCodeAgent, createVideoGenerator, OfflineVideoGenerator } from '@chrona/services';

interface PathFile {
  name: string;
  fps: number;
  durationSec: number;
  camera: { position: [number, number, number]; pitchDeg: number };
  motion: { kind: 'orbit' | 'static'; yawStartDeg: number; yawEndDeg: number };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      world: { type: 'string', default: 'demo' },
      path: { type: 'string', default: 'tests/paths/room_orbit.json' },
      out: { type: 'string', default: 'tests/output' },
      offline: { type: 'boolean', default: false },
      service: { type: 'string', default: 'http://127.0.0.1:8000' },
      quiet: { type: 'boolean', default: false },
    },
  });

  const worldId = values.world as string;
  const root = process.cwd();
  const worldDir = join(root, 'worlds', worldId);
  await mkdir(worldDir, { recursive: true });

  const physics = await PhysicsWorld.create();
  const world = new World({
    worldId,
    seed: 0x8f21c4,
    terrain: { profile: 'indoor', amplitude: 0, baseHeight: 0 },
    physics,
  });

  const archive = new FsArchive(worldDir);
  const store = new FsWorldStore(worldDir);
  const memory = new ViewpointMemory();

  const video = values.offline
    ? new OfflineVideoGenerator('--offline')
    : await createVideoGenerator(values.service as string);

  const harness = new Harness({
    worldId,
    world,
    archive,
    agent: new StubCodeAgent(),
    video,
    memory,
    store,
  });

  const log = (message: string) => {
    if (!values.quiet) console.log(message);
  };

  log(`world      ${worldId}  seed=${world.terrain.config.seed}`);
  log(`video      ${video.name}`);

  const outcomes = await harness.seedRoom(ROOM_ITEMS);
  log(`assets     ${outcomes.length} bound, ${outcomes.filter((o) => o.validation.ok).length} valid`);

  const path = JSON.parse(await readFile(resolve(root, values.path as string), 'utf8')) as PathFile;
  log(`path       ${path.name}  ${path.durationSec}s @ ${path.fps}fps`);

  const startX = path.camera.position[0];
  const startZ = path.camera.position[2];
  world.teleport(startX, startZ);
  world.setLook(degToRad(path.motion.yawStartDeg), degToRad(path.camera.pitchDeg));

  await world.chunks.warmup(world.cameraPosition);

  harness.startRecording();
  const step = 1 / 60;
  const totalSteps = Math.ceil(path.durationSec / step);
  let yaw = degToRad(path.motion.yawStartDeg);
  const yawSpan = degToRad(path.motion.yawEndDeg - path.motion.yawStartDeg);

  for (let i = 0; i < totalSteps; i += 1) {
    const t = i / totalSteps;
    yaw = degToRad(path.motion.yawStartDeg) + yawSpan * t;
    world.setLook(yaw, degToRad(path.camera.pitchDeg));
    world.update(step, {
      forward: 0,
      right: 0,
      sprint: false,
      jump: false,
      yawDelta: 0,
      pitchDelta: 0,
    });
    harness.tickRecording();
  }

  const segments = harness.stopRecording();
  const sessionMs = world.simTimeMs;
  log(`recorded   ${(sessionMs / 1000).toFixed(1)}s -> ${segments.length} segment(s)`);

  const requests: import('@chrona/protocol').ClipRequest[] = [];
  const queue = new ClipQueue(async (segment, previous) => {
    const request = harness.buildRequest(segment, previous);
    requests.push(request);
    return harness.video.generate(request);
  });
  queue.enqueue(segments);
  const jobs = await queue.drain();
  const results = jobs.map((job) => job.result!).filter(Boolean);
  for (const job of jobs) {
    log(
      `clip ${job.segment.clipId}  ${job.segment.frames.length} frames  ${job.status}` +
        (job.result?.meta.degraded ? `  (${job.result.meta.degraded})` : ''),
    );
  }

  const outDir = resolve(root, values.out as string, worldId);
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    worldId,
    path: path.name,
    video: video.name,
    segments: segments.length,
    requests,
    results,
  };
  const outFile = join(outDir, `${stamp}.json`);
  await writeFile(outFile, JSON.stringify(payload, null, 2), 'utf8');
  log(`output     ${outFile}`);

  physics.dispose();
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

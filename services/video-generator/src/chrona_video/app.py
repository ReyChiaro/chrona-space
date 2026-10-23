"""HTTP surface for the video generator.

Two interactive curls that matter:
  POST /generate            → {jobId}            (long-running, poll below)
  GET  /jobs/{jobId}        → {status, result}
The browser polls; the CLI may pass `?wait=true` to block.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .adapters import build_adapter
from .config import Settings
from .prompt import compose_prompt, enhance_prompt
from .schemas import ClipRequest, ComposeResponse, Profile

settings = Settings.from_env()
adapter = build_adapter(settings)
jobs: dict[str, dict[str, Any]] = {}

app = FastAPI(title="Chrona video generator", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "adapter": settings.adapter,
        "profile": adapter.profile.profileId,
        "modelLoaded": settings.adapter != "stub",
        "agentEnabled": settings.agent_enabled,
    }


@app.get("/config")
def config() -> dict[str, object]:
    return {
        "adapter": settings.adapter,
        "profileId": adapter.profile.profileId,
        "modelPathConfigured": bool(settings.model_path),
        "loraDir": settings.lora_dir,
        "loras": adapter.profile.loras,
        "agentEnabled": settings.agent_enabled,
        "agentModel": settings.agent_model,
        "promptEnhance": settings.prompt_enhance_enabled,
        "dataDir": str(Path(settings.data_dir).resolve()),
    }


@app.get("/profiles", response_model=list[Profile])
def profiles() -> list[Profile]:
    return [adapter.profile]


@app.post("/compose", response_model=ComposeResponse)
async def compose(request: ClipRequest) -> ComposeResponse:
    prompt, motion = compose_prompt(request)
    prompt = await enhance_prompt(prompt, settings)
    return ComposeResponse(prompt=prompt, references=[], motion=motion)


@app.put("/clips/{upload_id}/source")
async def upload_source(upload_id: str, http_request: Request) -> dict[str, object]:
    """Store the blockout recording used as <Video 1>."""
    body = await http_request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > 256 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="source clip too large")
    directory = Path(settings.data_dir) / "uploads"
    directory.mkdir(parents=True, exist_ok=True)
    suffix = ".webm" if body[:4] == b"\x1aE\xdf\xa3" else ".mp4"
    path = directory / f"{upload_id}{suffix}"
    path.write_bytes(body)
    return {"ok": True, "path": str(path), "bytes": len(body)}


def _blockout_path(request: ClipRequest) -> Path | None:
    upload = getattr(request, "blockout", None)
    if not upload:
        return None
    upload_id = upload.get("uploadId") if isinstance(upload, dict) else upload.uploadId
    directory = Path(settings.data_dir) / "uploads"
    for suffix in (".webm", ".mp4"):
        candidate = directory / f"{upload_id}{suffix}"
        if candidate.exists():
            return candidate
    return None


def _run(job_id: str, request: ClipRequest) -> None:
    try:
        prompt, _ = compose_prompt(request)
        if settings.prompt_enhance_enabled:
            prompt = asyncio.run(enhance_prompt(prompt, settings))
        result = adapter.generate(request, prompt, _blockout_path(request))
        jobs[job_id].update(status="done", result=result, finishedAt=time.time())
    except Exception as error:  # noqa: BLE001 - surface the reason to the client
        jobs[job_id].update(status="failed", error=str(error), finishedAt=time.time())


@app.post("/generate")
async def generate(request: ClipRequest, wait: bool = False) -> dict[str, object]:
    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {
        "jobId": job_id,
        "clipId": request.clipId,
        "status": "running",
        "createdAt": time.time(),
    }
    if wait:
        await asyncio.to_thread(_run, job_id, request)
        return jobs[job_id]
    asyncio.create_task(asyncio.to_thread(_run, job_id, request))
    return {"jobId": job_id, "clipId": request.clipId, "status": "running"}


@app.get("/jobs/{job_id}")
def job(job_id: str) -> dict[str, object]:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="unknown job")
    return jobs[job_id]


@app.get("/clips/{clip_id}/video")
def clip_video(clip_id: str) -> FileResponse:
    for name, media in ((f"{clip_id}.mp4", "video/mp4"), (f"{clip_id}.webm", "video/webm")):
        path = Path(settings.data_dir) / "clips" / name
        if path.exists():
            return FileResponse(path, media_type=media)
    raise HTTPException(status_code=404, detail="clip not generated yet")


@app.post("/agent/chat")
async def agent_chat(payload: dict[str, Any]) -> dict[str, object]:
    """Proxy to an OpenAI-compatible endpoint so the API key stays server-side."""
    if not settings.agent_enabled:
        raise HTTPException(status_code=503, detail="agent not configured")
    body = {
        "model": settings.agent_model,
        "messages": payload.get("messages", []),
        "temperature": 0.2,
    }
    if payload.get("tools"):
        body["tools"] = payload["tools"]
        body["tool_choice"] = "auto"
    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            f"{settings.agent_base_url.rstrip('/')}/chat/completions",
            headers={"authorization": f"Bearer {settings.agent_api_key}"},
            json=body,
        )
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=response.text[:400])
    message = response.json()["choices"][0]["message"]
    return {"message": message}

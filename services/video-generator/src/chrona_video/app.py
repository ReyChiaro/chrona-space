"""FastAPI surface for the video generator."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .adapters import STUB_PROFILE, StubAdapter
from .prompt import compose_prompt
from .schemas import ClipRequest, ComposeResponse, Profile

app = FastAPI(title="Chrona video generator", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

adapter = StubAdapter()


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "profile": adapter.profile.profileId, "modelLoaded": False}


@app.get("/profiles", response_model=list[Profile])
def profiles() -> list[Profile]:
    return [STUB_PROFILE]


@app.post("/compose", response_model=ComposeResponse)
def compose(request: ClipRequest) -> ComposeResponse:
    prompt, motion = compose_prompt(request)
    references = [f"frame:{i}" for i in range(len(request.frames))]
    return ComposeResponse(prompt=prompt, references=references, motion=motion)


@app.post("/generate")
def generate(request: ClipRequest) -> dict[str, object]:
    prompt, _ = compose_prompt(request)
    result = adapter.generate(request, prompt)
    result["meta"]["prompt"] = prompt
    return result

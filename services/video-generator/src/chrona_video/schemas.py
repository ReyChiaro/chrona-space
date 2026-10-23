"""Wire types accepted from the harness. Kept permissive on purpose: the
TypeScript protocol is the source of truth, this mirrors the fields the prompt
composer actually reads."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Vec3(BaseModel):
    x: float
    y: float
    z: float


class Quat(BaseModel):
    x: float
    y: float
    z: float
    w: float


class Camera(BaseModel):
    model_config = ConfigDict(extra="allow")

    pos: Vec3
    quat: Quat
    fovDeg: float = 60


class Appearance(BaseModel):
    model_config = ConfigDict(extra="allow")

    promptFragment: str = ""
    palette: list[str] = Field(default_factory=list)
    roughness: float = 0.8
    scaleHint: str = "human"


class FocusObject(BaseModel):
    model_config = ConfigDict(extra="allow")

    nodeId: str
    assetId: str
    semantic: str = ""
    appearance: Appearance = Field(default_factory=Appearance)
    distanceM: float = 0
    screenCoverage: float = 0


class ClipEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    tMs: float
    kind: str
    summary: str = ""


class ViewpointHistory(BaseModel):
    model_config = ConfigDict(extra="allow")

    images: list[dict[str, Any]] = Field(default_factory=list)
    kinds: list[str] = Field(default_factory=list)


class Spec(BaseModel):
    model_config = ConfigDict(extra="allow")

    presetId: str = "std-16x9-124f"
    fps: int = 24
    frames: int = 124


class Params(BaseModel):
    model_config = ConfigDict(extra="allow")

    canvas: dict[str, int] = Field(default_factory=lambda: {"width": 1344, "height": 768})
    steps: int = 32
    seed: int = 42
    grain: float = 0.35
    lutId: str | None = None


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="allow")

    focus: list[FocusObject] = Field(default_factory=list)
    camera: Camera | None = None


class Frame(BaseModel):
    model_config = ConfigDict(extra="allow")

    camera: Camera


class ObjectRef(BaseModel):
    model_config = ConfigDict(extra="allow")

    nodeId: str
    images: list[dict[str, Any]] = Field(default_factory=list)


class ClipRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    clipId: str
    worldId: str = "demo"
    spec: Spec = Field(default_factory=Spec)
    frames: list[Frame] = Field(default_factory=list)
    snapshot: Snapshot = Field(default_factory=Snapshot)
    events: list[ClipEvent] = Field(default_factory=list)
    objectRefs: list[ObjectRef] = Field(default_factory=list)
    viewpointHistory: list[ViewpointHistory] = Field(default_factory=list)
    prevClip: dict[str, Any] | None = None
    style: dict[str, Any] = Field(default_factory=dict)
    profileId: str = "stub-profile"
    params: Params = Field(default_factory=Params)


class ComposeResponse(BaseModel):
    prompt: str
    references: list[str]
    motion: str


class GenerateResponse(BaseModel):
    clipId: str
    ok: bool
    posterFrames: list[dict[str, Any]]
    frameIndex: list[dict[str, Any]]
    meta: dict[str, Any]


class Profile(BaseModel):
    profileId: str
    displayName: str
    workflow: str
    capabilities: dict[str, Any]
    loras: list[dict[str, Any]] = Field(default_factory=list)


Workflow = Literal["ref2va", "stub"]

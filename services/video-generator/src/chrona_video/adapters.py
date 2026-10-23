"""Model adapters.

An adapter owns one profile and all model-specific code. The v1 stub loads
nothing; the H3 adapter is imported lazily so the service runs on machines
without torch until `CHRONA_VIDEO_ADAPTER=h3` is set.
"""

from __future__ import annotations

import base64
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .config import Settings
from .schemas import ClipRequest, Profile


class Adapter(Protocol):
    profile: Profile

    def generate(
        self, request: ClipRequest, prompt: str, blockout: Path | None
    ) -> dict[str, Any]: ...


STUB_PROFILE = Profile(
    profileId="stub-profile",
    displayName="Stub (no model loaded)",
    workflow="stub",
    capabilities={
        "fps": [24],
        "durationSec": {"min": 5, "max": 15},
        "canvasPresets": [{"width": 1344, "height": 768}],
        "stepsRange": {"min": 1, "max": 60},
        "maxRefs": {"image": 9, "video": 3, "audio": 3},
        "supports": {"depth": False, "idMask": False, "normal": False, "cameraPose": False},
        "deterministic": True,
    },
    loras=[],
)

H3_PROFILE = Profile(
    profileId="h3-ref2va",
    displayName="MiniMax-H3 ref2va",
    workflow="ref2va",
    capabilities={
        "fps": [24],
        "durationSec": {"min": 5, "max": 15},
        "canvasPresets": [{"width": 1344, "height": 768}, {"width": 960, "height": 544}],
        "stepsRange": {"min": 8, "max": 60},
        "maxRefs": {"image": 9, "video": 3, "audio": 3},
        "supports": {"depth": False, "idMask": False, "normal": False, "cameraPose": False},
        "deterministic": True,
    },
    loras=[],
)


class StubAdapter:
    profile = STUB_PROFILE

    def generate(self, request: ClipRequest, prompt: str, blockout: Path | None) -> dict[str, Any]:
        started = time.monotonic()
        frame_index = [
            {"frameIdx": index, "camera": frame.camera.model_dump(), "tick": 0, "sceneVersion": 0}
            for index, frame in enumerate(request.frames)
        ]
        return {
            "clipId": request.clipId,
            "ok": True,
            "posterFrames": [],
            "frameIndex": frame_index,
            "meta": {
                "profileId": self.profile.profileId,
                "adapterVersion": "0.1.0",
                "workflow": self.profile.workflow,
                "promptHash": str(abs(hash(prompt)) % (10**12)),
                "refsHash": "",
                "seed": request.params.seed,
                "steps": request.params.steps,
                "loras": [],
                "costMs": int((time.monotonic() - started) * 1000),
                "gpuIds": [],
                "degraded": "no-model: prompt composed, inference skipped",
                "prompt": prompt,
                "blockoutUsed": bool(blockout),
            },
        }


@dataclass
class LoraSpec:
    id: str
    path: Path
    weight: float = 1.0


class H3Adapter:
    """MiniMax-H3 (`ref2va`) via diffusers. Loads lazily on first generation."""

    profile = H3_PROFILE

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._pipe: Any = None
        self._lock = threading.Lock()
        self._loaded_loras: set[str] = set()
        self.profile = H3_PROFILE.model_copy(
            update={"loras": self._discover_loras()},
        )

    def _discover_loras(self) -> list[dict[str, Any]]:
        if not self.settings.lora_dir:
            return []
        directory = Path(self.settings.lora_dir)
        if not directory.is_dir():
            return []
        return [
            {"id": path.stem, "label": path.stem, "path": str(path)}
            for path in sorted(directory.glob("*.safetensors"))
        ]

    def _load(self) -> Any:
        with self._lock:
            if self._pipe is not None:
                return self._pipe
            if not self.settings.model_path:
                raise RuntimeError("CHRONA_MODEL_PATH is not set")
            import torch  # noqa: PLC0415
            from diffusers import ModularPipeline  # noqa: PLC0415

            pipe = ModularPipeline.from_pretrained(self.settings.model_path, workflow="ref2va")
            pipe.load_components(dtype=torch.bfloat16)
            self._pipe = pipe
            return pipe

    def _apply_loras(self, pipe: Any, request: ClipRequest) -> list[dict[str, Any]]:
        applied: list[dict[str, Any]] = []
        available = {item["id"]: item for item in self.profile.loras}
        for spec in request.params.loras:
            entry = available.get(spec.id)
            if not entry:
                continue
            if spec.id not in self._loaded_loras:
                pipe.load_lora_weights(entry["path"], adapter_name=spec.id)
                self._loaded_loras.add(spec.id)
            applied.append({"id": spec.id, "weight": spec.weight})
        if applied:
            pipe.set_adapters(
                [item["id"] for item in applied],
                adapter_weights=[item["weight"] for item in applied],
            )
        return applied

    def _write_references(self, request: ClipRequest) -> list[Any]:
        """Decode data URLs to temp files; ordering is the prompt contract."""
        from diffusers.modular_pipelines.minimax_h3 import (  # noqa: PLC0415
            MiniMaxH3ImageReference,
        )

        references: list[Any] = []
        for ref in request.objectRefs:
            for image in ref.images:
                references.append(MiniMaxH3ImageReference.from_file(_materialise(image)))
        for history in request.viewpointHistory:
            for image in history.images:
                references.append(MiniMaxH3ImageReference.from_file(_materialise(image)))
        return references

    def generate(self, request: ClipRequest, prompt: str, blockout: Path | None) -> dict[str, Any]:
        started = time.monotonic()
        pipe = self._load()
        applied = self._apply_loras(pipe, request)
        references = self._write_references(request)

        from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3VideoReference  # noqa: PLC0415

        if blockout and blockout.exists():
            references.insert(0, MiniMaxH3VideoReference.from_file(str(blockout)))

        output_dir = Path(self.settings.data_dir) / "clips"
        output_dir.mkdir(parents=True, exist_ok=True)
        video_path = output_dir / f"{request.clipId}.mp4"

        results = pipe(
            prompt=prompt,
            references=references,
            num_frames=request.spec.frames,
            output=["videos", "audio", "sampling_rate"],
        )
        from diffusers.utils.export_utils import encode_video  # noqa: PLC0415

        encode_video(
            results["videos"][0],
            fps=24,
            output_path=str(video_path),
            audio=results.get("audio", [None])[0],
            audio_sample_rate=results.get("sampling_rate"),
        )

        frame_index = [
            {"frameIdx": index, "camera": frame.camera.model_dump(), "tick": 0, "sceneVersion": 0}
            for index, frame in enumerate(request.frames)
        ]
        return {
            "clipId": request.clipId,
            "ok": True,
            "video": {
                "path": str(video_path),
                "width": request.params.canvas["width"],
                "height": request.params.canvas["height"],
                "fps": 24,
                "frames": request.spec.frames,
                "durationMs": int(request.spec.frames / 24 * 1000),
            },
            "posterFrames": [],
            "frameIndex": frame_index,
            "meta": {
                "profileId": self.profile.profileId,
                "adapterVersion": "0.1.0",
                "workflow": "ref2va",
                "promptHash": str(abs(hash(prompt)) % (10**12)),
                "refsHash": "",
                "seed": request.params.seed,
                "steps": request.params.steps,
                "loras": applied,
                "costMs": int((time.monotonic() - started) * 1000),
                "gpuIds": [],
                "prompt": prompt,
            },
        }


def _materialise(image: Any) -> str:
    """Accept both file paths and `data:` URLs, return a path on disk."""
    path = getattr(image, "path", None)
    if isinstance(image, dict):
        path = image.get("path")
    if not path:
        raise ValueError("image reference without path")
    if not str(path).startswith("data:"):
        return str(path)
    header, _, payload = str(path).partition(",")
    suffix = ".png"
    if "webp" in header:
        suffix = ".webp"
    elif "jpeg" in header or "jpg" in header:
        suffix = ".jpg"
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    with handle:
        handle.write(base64.b64decode(payload))
    return handle.name


def build_adapter(settings: Settings) -> Adapter:
    if settings.adapter == "h3":
        return H3Adapter(settings)
    return StubAdapter()

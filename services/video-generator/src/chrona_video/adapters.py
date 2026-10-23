"""Model adapters.

An adapter owns one `ModelProfile`; everything model-specific stays here.
The v1 adapter is a stub: it validates and echoes, but loads no weights.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .schemas import ClipRequest, Profile


@dataclass(frozen=True)
class Capabilities:
    profile: Profile


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
    loras=[
        {"id": "h3-distill-8step", "label": "8-step distillation", "recommendedSteps": 8},
    ],
)


class StubAdapter:
    """Returns a degraded ClipResult; wire a real adapter here later."""

    profile = STUB_PROFILE

    def generate(self, request: ClipRequest, prompt: str) -> dict[str, Any]:
        started = time.monotonic()
        frame_index = [
            {
                "frameIdx": index,
                "camera": frame.camera.model_dump(),
                "tick": 0,
                "sceneVersion": 0,
            }
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
            },
        }

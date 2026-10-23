"""Environment-driven settings. Everything server-side lives here."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    adapter: str
    model_path: str | None
    lora_dir: str | None
    data_dir: str
    agent_base_url: str | None
    agent_api_key: str | None
    agent_model: str
    prompt_base_url: str | None
    prompt_api_key: str | None
    prompt_model: str

    @property
    def agent_enabled(self) -> bool:
        return bool(self.agent_base_url and self.agent_api_key and self.agent_model)

    @property
    def prompt_enhance_enabled(self) -> bool:
        return bool(self.prompt_base_url and self.prompt_api_key and self.prompt_model)

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            adapter=os.getenv("CHRONA_VIDEO_ADAPTER", "stub").strip().lower(),
            model_path=os.getenv("CHRONA_MODEL_PATH") or None,
            lora_dir=os.getenv("CHRONA_LORA_DIR") or None,
            data_dir=os.getenv("CHRONA_DATA_DIR", "./data"),
            agent_base_url=os.getenv("CHRONA_AGENT_BASE_URL") or None,
            agent_api_key=os.getenv("CHRONA_AGENT_API_KEY") or None,
            agent_model=os.getenv("CHRONA_AGENT_MODEL") or "",
            prompt_base_url=os.getenv("CHRONA_PROMPT_BASE_URL") or None,
            prompt_api_key=os.getenv("CHRONA_PROMPT_API_KEY") or None,
            prompt_model=os.getenv("CHRONA_PROMPT_MODEL") or "",
        )

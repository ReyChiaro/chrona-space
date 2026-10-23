"""Entry point: `uv run python -m chrona_video`."""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("chrona_video.app:app", host="127.0.0.1", port=8000, reload=False)

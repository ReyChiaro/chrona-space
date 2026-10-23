"""Prompt composition.

Per D-14 the harness only sends structured context; every natural-language
sentence the video model sees is produced here.
"""

from __future__ import annotations

import math

from .schemas import ClipRequest, Frame

MOTION_LABELS = {
    "still": "静止",
    "forward": "缓慢前进",
    "backward": "缓慢后退",
    "orbit": "原地环视",
    "turn": "转身回望",
}


def _yaw(frame: Frame) -> float:
    q = frame.camera.quat
    return math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z))


def classify_motion(frames: list[Frame]) -> str:
    if len(frames) < 2:
        return "still"
    first, last = frames[0].camera.pos, frames[-1].camera.pos
    travelled = math.dist((first.x, first.y, first.z), (last.x, last.y, last.z))
    turned = abs(_yaw(frames[-1]) - _yaw(frames[0]))
    turned = min(turned, 2 * math.pi - turned)
    if turned > math.radians(120):
        return "orbit"
    if turned > math.radians(45):
        return "turn"
    if travelled > 1.5:
        return "forward" if last.z < first.z else "backward"
    return "still"


def _relative_position(request: ClipRequest, index: int) -> str:
    focus = request.snapshot.focus
    if not focus:
        return "画面中央"
    if len(focus) == 1:
        return "画面一侧"
    if index == 0:
        return "画面左侧偏近处" if focus[0].distanceM < (focus[1].distanceM) else "画面右侧偏近处"
    return "画面另一侧"


def _event_line(event) -> str:
    seconds = round(event.tMs / 1000, 1)
    return f"{seconds}s 处 {event.summary}，该变化在 <Video 1> 中可见，请如实呈现变化过程。"


def _reference_labels(request: ClipRequest) -> list[str]:
    labels: list[str] = []
    picture = 1
    for ref in request.objectRefs:
        for _ in ref.images:
            labels.append(f"<Picture {picture}>")
            picture += 1
    for history in request.viewpointHistory:
        for _ in history.images:
            labels.append(f"<Picture {picture}>")
            picture += 1
    if request.frames:
        labels.append("<Video 1>")
    if request.prevClip:
        labels.append("<Video 2>")
    return labels


def compose_prompt(request: ClipRequest) -> tuple[str, str]:
    motion = classify_motion(request.frames)
    focus = request.snapshot.focus[:3]
    lines: list[str] = []

    lines.append(f"【镜头】第一人称手持行走镜头，{MOTION_LABELS[motion]}，浅景深，自然光。")
    lines.append(f"【场景】{request.style.get('stylePresetId', 'film-neutral')}，住宅室内，夜间。")

    if focus:
        layout = []
        for index, obj in enumerate(focus):
            layout.append(f"{obj.semantic or obj.assetId} 位于{_relative_position(request, index)}")
        lines.append("【布局】画面中：" + "；".join(layout) + "。")

    for index, obj in enumerate(focus, start=1):
        appearance = obj.appearance
        palette = "、".join(appearance.palette[:3]) or "保持原有"
        lines.append(
            f"【主体】<Picture {index}> 是 {obj.semantic or obj.assetId}，"
            f"{appearance.promptFragment}，主色 {palette}。"
        )

    if request.frames:
        lines.append("【运动】运镜与 <Video 1> 一致，保持参考视频中的视角与遮挡关系。")

    if request.objectRefs and any(ref.images for ref in request.objectRefs):
        lines.append("【一致·物体】实拍参考图中的物体必须尽量保持其形状、材质与颜色。")

    if any(history.images for history in request.viewpointHistory):
        lines.append("【一致·机位】附带的历史画面来自同一机位，保持其空间陈设与材质一致。")

    for event in request.events:
        lines.append("【事件】" + _event_line(event))

    if request.prevClip:
        lines.append("【连续】<Video 2> 为上一镜头的结尾，保持连续。")

    lines.append("【禁止】不要改变物体位置、数量和尺度；不要添加画面中不存在的主要物体。")
    return "\n".join(lines), motion

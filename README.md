# Chrona

镜头制的生成式沙盒：在 three.js + rapier 的粗模世界里漫游与创作，录制一段镜头后交给视频模型生成写实成片。
设计文档在 `docs/v1/`（内部，未入库）。

当前实现到 **M2**：世界、创作、地形编辑、录制切段、片段请求装配全部可用；**不加载任何模型**，视频服务返回结构化提示词与降级结果。

## 目录

```
packages/protocol   跨模块类型（唯一事实源）
packages/world      地形、区块、节点、物理、相机
packages/storage    素材仓库、机位记忆（/fs 子入口是 Node 专用）
packages/services   Code Agent 适配器、视频服务客户端、测试房间
packages/harness    创作会话、录制切段、片段装配
packages/cli        无头运行器
packages/ui         WebUI（Vite + three.js）
services/video-generator   Python 服务：提示词合成 + 模型适配（当前为 stub）
skills/             Code Agent 的提示词片段
tests/              测试与测试资产（未入库）
```

## 启动

```bash
# 0) 依赖
pnpm install

# 1) 视频服务（可选，不启动则自动降级为 offline）
cd services/video-generator
uv sync
uv run python -m chrona_video          # http://127.0.0.1:8000

# 2) 浏览器
cd ../..
pnpm dev                               # http://localhost:5173

# 3) 无头跑一条测试轨迹
pnpm cli --offline
```

## 常用命令

```bash
pnpm typecheck      # TypeScript
pnpm test           # 核心逻辑（node:test）
pnpm test:py        # 提示词与服务（unittest）
pnpm lint:py        # ruff
pnpm build          # 构建 WebUI
```

## 操作

| 键 | 作用 |
|---|---|
| `WASD` / `Shift` | 移动 / 快走 |
| `空格` | 跳跃 |
| 鼠标 | 视角（点击画面进入指针锁定） |
| `R` | 开始 / 结束录制（结束即切段入队） |
| `右键` | 选中准星下的物体（再点空白取消）；选中后 `C` 打开的是**修改** |
| `E` | 在当前落点预览地形编辑；**左键确认，`Q` 或右键取消** |
| `V` | 渲染窗口：小窗 → 并排 → 全屏 → 隐藏 |
| `H` / `L` / `P` | 键位 / 日志 / 参数 |
| `M` / `N` | 3D 地图 / 2D 地图（2D 地图点击传送） |
| `C` / `B` / `O` | 创作 / 素材库 / 状态 |
| `Esc` | 关闭最近打开的窗口 |

窗口都可以拖动标题栏移动、右下角拖拽缩放；右上角 `✕` 或再按一次快捷键关闭。
位置/大小/开关状态存在 `localStorage`，刷新后恢复。

## 数据与持久化

- 素材与地形编辑写入 **IndexedDB**（`chrona-v1`），刷新页面后自动恢复；存储不可用时自动退回内存模式并在日志里提示。
- 窗口布局存 `localStorage`（`chrona.layout`）。
- CLI 仍使用文件存储（`worlds/<id>/`）。

## 配置

复制 `.env.example` 为 `.env`。v1 不读取它：真实接入时把 Code Agent 换成 `ApiCodeAgent`，
视频服务换成真实 adapter 即可。权重不下载到本地，服务器上按部署路径挂载。

## 已知边界

- 无渲染器时（CLI）帧只有位姿，没有像素；片段请求结构完整，但模型输入需要 WebUI 采集。
- 地形碰撞在 v1 用解析高度 + rapier 射线，没有逐块 heightfield。
- 资产脚本在宿主进程执行，工作线程沙箱随真实 Code Agent 一起落地。

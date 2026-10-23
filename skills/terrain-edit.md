# 地形编辑

- 输出 `TerrainEditDraft`：`op` + `shape` + `strength`，不要输出网格或顶点。
- `op`：`raise` / `lower` / `flatten` / `carve` / `paint` / `water`。
- 形状只有三种：`disc`（半径）、`capsule`（半径 + 半长 + 朝向）、`box`。
- `strength`：抬升/压低是米，`flatten` 是 0–1 的混合权重，`paint` 忽略。
- 可以修改**未探索**区块：编辑会先于生成写入世界级列表。
- 你只能提交草案；Harness 负责预览、校验与 WAL 提交。

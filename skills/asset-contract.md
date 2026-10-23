# 资产契约

脚本是一段**函数体**，由运行时执行：

```js
(THREE, RAPIER, ctx) => ({ object3d, colliders, bounds, triCount })
```

- `object3d`：`THREE.Object3D`（通常是一个 Group）。
- `colliders`：`{ type: 'cuboid'|'ball'|'cylinder', halfExtents|radius|halfHeight, offset }[]`，坐标是**资产本地坐标**。
- `bounds`：`{ min, max }`，世界坐标近似包围盒。
- `ctx`：`{ nodeId, assetId, position, rotationY }`。
- 单位：米 / 千克 / 秒，Y 轴向上。
- 禁止网络、文件读写、`import`。

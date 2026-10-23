# 外观规格

每个资产必须给出六个字段：

| 字段 | 要求 |
|---|---|
| `promptFragment` | 一句话描述材质与表面，≤ 80 字，不要写相机或光线 |
| `refImages` | 0–3 张，仅用于用户提供的真实参考图，不得伪造 |
| `palette` | 至少 2 个十六进制主色 |
| `roughness` | 0–1，用于生成"哑光 / 釉面"这类词 |
| `scaleHint` | `small` / `human` / `large` / `huge` |
| `styleTags` | 2–4 个英文标签，例如 `weathered`、`neon-lit` |

同时给出 `semantic`：**短名词**（"工作台"），不要写整句。

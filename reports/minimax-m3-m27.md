# MiniMax M3 vs M2.7 离线困难负样本评估

生成时间：2026-11-14T13:29:40.088Z

## 数据量

| 模型 | 可用观测 | 排除 | 会话 |
|---|---:|---:|---:|
| minimax-cn/MiniMax-M3 | 1189 | 0 | 19 |
| minimax-cn/MiniMax-M2.7 | 105 | 1 | 5 |

## 协议形态

- M3：{"fingerprints":[{"id":"fp_8e17c9bd6670","count":1189}],"families":[{"id":"tf_c174f6b98cd4","count":1189}],"variants":[{"id":"tv_b90db42afd41","count":1189}],"apis":[{"id":"anthropic-messages","count":1189}]}
- M2.7：{"fingerprints":[{"id":"fp_8e17c9bd6670","count":105}],"families":[{"id":"tf_c174f6b98cd4","count":105}],"variants":[{"id":"tv_b90db42afd41","count":103},{"id":"tv_ee201d4d1fd9","count":1},{"id":"tv_d6578c603319","count":1}],"apis":[{"id":"anthropic-messages","count":105}]}
- M2.7 原始指纹（含排除样本）：[{"id":"fp_8e17c9bd6670","count":105},{"id":"fp_bb2f3030e807","count":1}]
- transport family 相同：true；主 variant 相同：true（M2.7 主 variant 占 0.981）

## 行为特征（中位数 / MAD / 覆盖率）

| 特征 | M3 | M2.7 |
|---|---:|---:|
| tokensPerChar | 0.361 / 0.059 / 1 | 0.295 / 0.034 / 1 |
| jsonSpacing | 0 / 0 / 0.186 | 0 / 0 / 0.048 |
| reasoningRatio | 0 / 0 / 1 | 0.809 / 0.119 / 1 |
| charsPerChunk | 36.85 / 22.96 / 1 | 49.38 / 7.5 / 1 |
| escapedUnicode | 0 / 0 / 0.958 | 0 / 0 / 0.895 |
| asciiRatio | 1 / 0 / 0.543 | 0.23 / 0.23 / 0.114 |
| cjkRatio | 0 / 0 / 0.543 | 0.65 / 0.185 / 0.114 |
| punctuationRatio | 0.032 / 0.011 / 0.543 | 0.085 / 0.02 / 0.114 |
| markdownPerK | 0 / 0 / 0.543 | 0 / 0 / 0.114 |
| newlineRatio | 0 / 0 / 0.543 | 0.024 / 0.006 / 0.114 |

## 会话留一法

- 单位：session（非 observation）
- 折数：24
- 正确：20 / 24
- 误判：4
- 不确定：0
- AUC：0.724（session bootstrap 95% CI 0.606–0.852，2000 次）

## 固定 FPR

| 目标 FPR | 阈值 | 实际 FPR | 召回 |
|---:|---:|---:|---:|
| 0.01 | 0.518 | 0.011 | 0.375 |
| 0.05 | 0.721 | 0.053 | 0.458 |

## 距离分布

- 全量行为距离：1.688（相对自身波动 {"MiniMax-M3":3.185,"MiniMax-M2.7":2.263}）
- 同模型跨 session：{"MiniMax-M3":{"samples":171,"min":0.065,"p25":0.568,"median":1.583,"p75":3.492,"max":4.463,"mean":2.002},"MiniMax-M2.7":{"samples":10,"min":1.719,"p25":2.492,"median":3.752,"p75":5.383,"max":5.857,"mean":3.813}}
- 跨模型：{"models":["MiniMax-M3","MiniMax-M2.7"],"samples":95,"min":0.518,"p25":2.109,"median":3.75,"p75":4.417,"max":5.85,"mean":3.432}

## 时间留出

| 窗口 | 测试会话 | M3 自身 | M2.7 自身 | M3→M2.7 | M2.7→M3 |
|---:|---:|---:|---:|---:|---:|
| 0 | 5 | 0.265 | — | 1.757 | — |
| 1 | 6 | 1.401 | — | 2.59 | — |
| 2 | 6 | 0.249 | 2.388 | 0.68 | 2.873 |
| 3 | 6 | 2.627 | 2.388 | 5.804 | 0.514 |

## 特征消融

| 移除特征 | AUC | 相对全特征 |
|---|---:|---:|
| tokensPerChar | 0.823 | 0.099 |
| jsonSpacing | 0.762 | 0.038 |
| reasoningRatio | 0.628 | -0.096 |
| charsPerChunk | 0.722 | -0.002 |
| escapedUnicode | 0.731 | 0.007 |
| asciiRatio | 0.731 | 0.007 |
| cjkRatio | 0.726 | 0.002 |
| punctuationRatio | 0.724 | 0 |
| markdownPerK | 0.726 | 0.002 |
| newlineRatio | 0.724 | 0 |

## 异常样本

- `752a7d48-574b-44cb-a572-60ade02fa907:784` session=752a7d48-574b-44cb-a572-60ade02fa907 turn=2 step=54 time=2026-10-29T11:06:40.138Z fp=fp_bb2f3030e807；排除原因：protocol-fields-missing, behavior-fields-missing, usage-missing, replay-missing, reasoning-only-no-response；判断：incomplete-reasoning-only-response-or-missing-replay；routeSwitchObserved=false；原始数据保留
- 该样本所在 session 前后 step 的模型均为 MiniMax-M2.7，未观察到路由切换；该 step 只有 reasoning，没有 protocol/usage/replay，按不完整响应或缺失 replay 处理，原始数据未删除。

## 限制

- MiniMax-M2.7 only has 5 sessions; bootstrap CIs and FPR estimates are unstable.
- Session-held-out bootstrap resamples sessions; it does not make individual observations independent.
- Passive natural-chat behavior cannot establish model identity without fixed repeated probes.

> 当前只能称为行为模式/潜在路由变体，不能声称识别出 MoE 专家。

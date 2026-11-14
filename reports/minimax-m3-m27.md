# MiniMax M3 vs M2.7 离线困难负样本评估

生成时间：2026-11-14T14:09:00.613Z

## 数据量

| 模型 | 可用观测 | 排除 | 会话 |
|---|---:|---:|---:|
| minimax-cn/MiniMax-M3 | 1189 | 0 | 19 |
| minimax-cn/MiniMax-M2.7 | 105 | 1 | 5 |

## 数据质量与排除

- MiniMax-M3：total=1189，behavior-baseline-usable=1189，protocol-identity-usable=1189，excluded=0，identityExcluded=0
- baseline classes：[{"baselineClass":"canonical","count":1189}]
- identity exclusion reasons：[]
- missing protocol fields：[]
- MiniMax-M2.7：total=106，behavior-baseline-usable=105，protocol-identity-usable=105，excluded=1，identityExcluded=1
- baseline classes：[{"baselineClass":"canonical","count":105}]
- identity exclusion reasons：[{"reason":"protocol-fields-missing","count":1},{"reason":"behavior-fields-missing","count":1},{"reason":"usage-missing","count":1},{"reason":"replay-missing","count":1},{"reason":"reasoning-only-no-response","count":1},{"reason":"protocol-identity-ineligible","count":1}]
- missing protocol fields：[{"field":"api","count":1},{"field":"adapter","count":1},{"field":"wireProvider","count":1},{"field":"responseId","count":1},{"field":"replay","count":1}]

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
- 模型-会话记录：24（唯一 session ID：23）
- 正确：20 / 24
- 误判：4
- 不确定：0
- session-paired verification AUC：0.724（双向 session cluster bootstrap 95% CI 0.656–0.814，2000 次，seed 17）
- 这是同一测试会话的 same/other 距离配对验证，不是独立观测分类 AUC。

## Nested session-level FPR / Recall

阈值在每折只由外层训练 session 确定；测试 session 不参与阈值、特征选择、标准化或中位数/MAD 计算。

| 目标 FPR | 阈值范围 | 点估计 FPR | 点估计召回 | false accepts / negatives | true accepts / positives | FPR upper95 | 最小可观测非零 FPR | 分辨率 | 状态 |
|---:|---|---:|---:|---:|---:|---:|---:|---|---|
| 0.01 | {"min":0.576,"median":1.69,"max":2.995} | 0.083（不可验证） | 0.667 | 2 / 24 | 16 / 24 | —（分辨率不足） | 0.042 | true | resolution-insufficient |
| 0.05 | {"min":0.576,"median":1.69,"max":2.995} | 0.083 | 0.667 | 2 / 24 | 16 / 24 | 0.167 | 0.042 | false | not-verified |
- 依赖说明：外层测试 session 的 same/other 决策成对；bootstrap 对 M3 与 M2.7 的 session 分别重采样（双向 cluster bootstrap），不会拆散同一 session 的配对。
- 1% 目标：负例数不足，无法验证，不能称为达到 1% FPR。

## 距离分布

- 全量行为距离：1.688（相对自身波动 {"MiniMax-M3":3.185,"MiniMax-M2.7":2.263}）
- 同模型跨 session：{"MiniMax-M3":{"samples":171,"min":0.065,"p25":0.568,"median":1.583,"p75":3.492,"max":4.463,"mean":2.002},"MiniMax-M2.7":{"samples":10,"min":1.719,"p25":2.492,"median":3.752,"p75":5.383,"max":5.857,"mean":3.813}}
- 跨模型：{"models":["MiniMax-M3","MiniMax-M2.7"],"samples":95,"min":0.518,"p25":2.109,"median":3.75,"p75":4.417,"max":5.85,"mean":3.432}

## 严格前向时间验证（rolling-origin）

- method：rolling-origin-forward-chaining
- 有效折：1；跳过：4
- 每折训练只使用 testStart 之前开始的 session；未来 session 数量单独记录。

| 窗口 | 状态 | 训练会话 M3/M2.7 | 测试会话 M3/M2.7 | 测试起点 | 测试终点 | 距离 |
|---:|---|---:|---:|---|---|---|
| 0 | insufficient-training-history（need at least 2 sessions per model before testStart） | 0/0 | 4/0 | 2026-08-27T09:23:45.379Z | 2026-10-23T14:37:26.273Z | — |
| 1 | insufficient-training-history（need at least 2 sessions per model before testStart） | 4/0 | 5/0 | 2026-10-23T14:44:03.945Z | 2026-10-23T15:46:16.827Z | — |
| 2 | insufficient-training-history（need at least 2 sessions per model before testStart） | 9/0 | 4/0 | 2026-10-23T18:23:10.489Z | 2026-10-24T05:43:36.699Z | — |
| 3 | insufficient-training-history（need at least 2 sessions per model before testStart） | 13/0 | 3/2 | 2026-10-24T08:04:16.303Z | 2026-10-29T11:11:13.800Z | — |
| 4 | ok | 16/2 | 3/2 | 2026-10-29T11:14:47.505Z | 2026-11-05T11:23:32.669Z | {"MiniMax-M3ToOwn":2.627,"MiniMax-M2.7ToOwn":2.423,"MiniMax-M3ToOther":5.488,"MiniMax-M2.7ToOther":0.581} |

- 无法验证的窗口不输出距离或 AUC；只有满足两个模型至少各 2 个历史 session 的窗口才可评估。
- 有效窗口 4：训练 M3/M2.7=16/2，测试 M3/M2.7=3/2；距离={"MiniMax-M3ToOwn":2.627,"MiniMax-M2.7ToOwn":2.423,"MiniMax-M3ToOther":5.488,"MiniMax-M2.7ToOther":0.581}。

## 特征消融（exploratory-only）

- mode：exploratory-only
- selectionUsedTest：false
- productionWeightsChanged：false
- missingValuesTreatedAsZero：false
- 结论仅用于探索；没有根据这 5 个 M2.7 会话删除或调整生产特征权重。

| 移除特征 | AUC | 相对全特征 | 平均覆盖率 | 低覆盖 |
|---|---:|---:|---:|---|
| tokensPerChar | 0.823 | 0.099 | 1.000 | false |
| jsonSpacing | 0.762 | 0.038 | 0.121 | true |
| reasoningRatio | 0.628 | -0.096 | 1.000 | false |
| charsPerChunk | 0.722 | -0.002 | 1.000 | false |
| escapedUnicode | 0.731 | 0.007 | 0.687 | false |
| asciiRatio | 0.731 | 0.007 | 0.750 | false |
| cjkRatio | 0.726 | 0.002 | 0.750 | false |
| punctuationRatio | 0.724 | 0 | 0.750 | false |
| markdownPerK | 0.726 | 0.002 | 0.750 | false |
| newlineRatio | 0.724 | 0 | 0.750 | false |

## 异常样本

- `752a7d48-574b-44cb-a572-60ade02fa907:784` session=752a7d48-574b-44cb-a572-60ade02fa907 turn=2 step=54 time=2026-10-29T11:06:40.138Z fp=fp_bb2f3030e807；排除原因：protocol-fields-missing, behavior-fields-missing, usage-missing, replay-missing, reasoning-only-no-response；判断：incomplete-reasoning-only-response-or-missing-replay；routeSwitchObserved=false；原始数据保留
- 该样本所在 session 前后 step 的模型均为 MiniMax-M2.7，未观察到路由切换；该 step 只有 reasoning，没有 protocol/usage/replay，按不完整响应或缺失 replay 处理，原始数据未删除。

## 结论分层

- 协议一致：同一 `fp_...`、同一 transport family、M2.7 98.1% 使用同一主 variant。
- 行为相似：不是“相同”；全量距离与 session-held-out 结果仅支持较弱的行为差异信号。
- 可能的路由变体：当前最合适的表述是行为模式差异或潜在路由变体。
- 模型身份确认：证据不足；passive-only 不能确认身份。
- MoE 专家识别：未执行固定重复探针，不能识别 MoE 专家。
- 生产上线条件：未达到。当前结果是离线研究/探索结论，不是生产身份判定器。

## 旧方法失效说明

- 旧时间留出把测试窗口之后的 session 放入训练集，属于未来数据泄漏；旧 time-held-out 数值不再有效。
- 旧 FPR 在全部 95 个笛卡尔积 session pair 上同时选阈值和评估，且把相关 pair 当成独立样本；旧 1%/5% FPR、召回和实际 FPR 不再有效。
- 旧 AUC 名称被写成普通 ROC AUC；现在只保留 session-paired verification AUC。
- 旧消融使用全量数据计算；现在仅作 exploratory-only，生产权重未改变。

## 限制

- MiniMax-M2.7 only has 5 sessions; bootstrap CIs and FPR estimates are unstable.
- Session-held-out bootstrap resamples sessions; it does not make individual observations independent.
- Passive natural-chat behavior cannot establish model identity without fixed repeated probes.

> 当前只能称为行为模式/潜在路由变体，不能声称识别出 MoE 专家。

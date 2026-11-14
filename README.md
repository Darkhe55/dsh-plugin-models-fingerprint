# DSH 模型指纹监控

在 DSH 里观察每个模型路由的**协议形状**和**行为特征**，回答：

- 这个声称模型，和它过去的表现一致吗？
- 同一个名称后面有没有换过协议、adapter 或网关？
- 两个不同路由是不是行为相近？
- 某个第三方模型与官方基线的行为相似度是多少？
- 最近的行为是否出现了持续漂移？

> 指纹是证据，不是模型身份证明。黑盒 API 无法被“证明”为某个具体模型；请结合账单、接口文档、人工抽检和人工标签使用。

---

## 快速开始

### 方式 A：从 npm 安装

包发布后：

```powershell
dsh plugin --profile desktop add dsh-plugin-model-fingerprint
```

如果 `dsh` 不在 PATH，请使用 DSH 安装目录里的 CLI。

### 方式 B：从本地目录安装

```powershell
git clone https://github.com/Darkhe55/dsh-plugin-models-fingerprint.git
dsh plugin --profile desktop add "C:\path\to\dsh-plugin-models-fingerprint"
```

也可以使用 DSH 的 **Plugins → Add plugin**，或 `plugin_manager install_bundle`，目标指向这个目录。

### 方式 C：开发调试

```powershell
npm install
npm run build
npm test
npm run check
```

然后按方式 B 安装本地目录。

安装或更新后：

1. 完全退出并重开 DSH；
2. 刷新 Web 页面；
3. 插件会出现在输入框上方的 dock。

---

## 30 秒上手

1. 打开输入框上方的 **在会话消息旁显示指纹情况**；
2. 左侧会出现每轮对话的卡片；
3. 点击卡片，或点击 dock 的 **面板**；
4. 在面板里查看逐轮检测、指纹族、模型等价性和官方相似度；
5. 需要官方基线时，到 **官方相似度** 页配置 provider/model。

开关打开或关闭时，会触发一次历史补算并存盘。

---

## 界面说明

### 输入框上方 dock

- **在会话消息旁显示指纹情况**：控制左侧逐轮卡片，不打开面板；
- **面板**：打开完整逐轮检测浮层。

### 左侧逐轮卡片

每轮一张卡片，显示：

```text
第 N 轮
FP-xxxx
一致 / 变化 / 多指纹 / 代际 / 基线
主要声称模型
```

- 中间卡片跟随消息的可见区域；
- 顶部/底部卡片使用固定槽位；
- 窄窗口退化为紧凑标记；
- 点击卡片打开面板。

### 面板页签

| 页签 | 用途 |
|---|---|
| 逐轮检测 | 每轮指纹、协议、行为变化和步骤明细 |
| 指纹族 | 每个协议指纹的样本、名称、标签 |
| 模型等价性 | 不同路由的行为距离和同名模型对比 |
| 官方相似度 | 第三方路由与官方基线的行为相似度 |
| 声称模型 | 一个名称下出现过哪些指纹 |
| 历史会话 | 每个会话的模型、指纹和样本数 |
| 方法与边界 | 能推断什么、不能推断什么 |

---

## 官方相似度

用于回答：

> 这个第三方路由的输出行为，与指定官方模型的行为基线有多接近？

### 配置官方基线

打开 **官方相似度**：

1. 填写官方 `provider`；
2. 填写官方 `model`；
3. 可选标签和最少样本数；
4. 点击 **保存官方基线**。

基线需要足够历史样本才会进入 `ready`。每个官方 API 应建立自己的基线，不要把两个网关当成同一个基线。

### 读取结果

面板显示：

- **行为相似度**；
- 是否已校准；
- 判定：`likely-same-behavior` / `ambiguous` / `likely-different-behavior`；
- 距离；
- 质量代理：`stable` / `watch` / `degrading` / `insufficient`；
- AUC、分离度、正负样本数；
- 主要特征贡献。

解释：

- 高分只表示**行为分布更接近官方基线**；
- 低分表示行为分布不同，不等于模型被替换；
- 未校准时只显示分数，不显示可比较的百分比；
- 内容特征（CJK、Markdown、换行等）权重很低，避免把任务差异误判成模型差异；
- 质量代理不是语义质量评分。

---

## 自动补算与存盘

插件会从 DSH 会话日志补回状态中缺失的轮次观测。

触发时机：

- DSH 启动并完成初次扫描后；
- 打开或关闭左侧指纹开关时；
- 手动调用 API 或工具时。

补算流程：

```text
发现会话目录
→ 只选最高版本日志（v4 > v3 > v2 > 无版本；损坏才回退）
→ 重新解析规范日志
→ 按语义键去重（session/turn/step/time/model/fingerprint/protocol）
→ 重建该会话 Turn Index
→ 写入 state.json.zst
```

旧版状态升级为 v2 时，会先保留 `state.json.zst.pre-semantic-v2`，再从规范日志重建观测和轮次索引；标签、探针、官方基线不重建。

手动触发：

```text
POST /model-fingerprint/api/backfill
```

需要 token；也可以通过模型工具：

```text
model_fingerprint action=backfill
```

已删除的日志文件无法从磁盘补回；状态中已有的历史观测会保留。

---

## 固定探针（可选，会产生 token）

被动历史会受任务结构影响。需要更强证据时，在 **模型等价性** 页底部运行固定探针。

- 6 个固定 prompt：baseline、英文、中文、代码、emoji、工具调用；
- 可选重复 1–3 次；
- 每次输出 token 很小；
- 运行前需要确认；
- 探针会真实调用供应商模型，产生费用；
- 固定探针结果优先于跨任务被动历史。

---

## 模型工具

工具名：`model_fingerprint`

| action | 作用 |
|---|---|
| `status` | 最近响应、统计、证据提示 |
| `session` | 指定会话的指纹摘要 |
| `fingerprints` | 按样本数列出指纹族 |
| `equivalence` | 跨路由行为距离 |
| `probe` | 运行固定探针，必须 `confirm: true`，消耗 token |
| `label` | 写入/删除人工标签 |
| `scan` | 重新发现会话文件 |
| `backfill` | 补算缺失轮次并落盘 |

示例：

```text
帮我看看最近一次实际调用和声称名称是否一致
→ model_fingerprint { action: "status" }

这个会话里出现过哪些指纹？
→ model_fingerprint { action: "session", sessionId: "session-..." }

把缺失的历史轮次补回来
→ model_fingerprint { action: "backfill" }
```

---

## 判定与边界

常见判定：

| 判定 | 含义 |
|---|---|
| `consistent` | 指纹与历史一致 |
| `unverified` | 样本太少 |
| `changed` | 同 API/adapter 下响应 ID 形状变化 |
| `generation` | adapter 或 wire API 变化 |
| `mixed` | 同一路由存在多个指纹 |
| `alias` | 同一指纹出现多个名称 |
| `label-mismatch` | 名称与人工标签不一致 |
| `behavior-drift` | 行为指标偏离历史基线 |
| `behavior-change-point` | 时间序列出现持续变化点 |

置信度是证据强度，最高 90%，不是模型身份概率。

---

## 数据与隐私

- 状态文件：`%USERPROFILE%\.dsh\model-fingerprint\state.json.zst`，或 `$DSH_HOME/model-fingerprint/state.json.zst`；
- 只保存协议形状、指标、哈希、会话 ID、时间；
- 不保存提示词或回复正文；
- 固定探针只保存内置 prompt 的结果指标；
- 历史日志只读，不修改 `~/.dsh/sessions`；
- 面板与 API 仅绑定本机 DSH Web 服务；
- 修改状态、运行探针、补算需要 token；
- 重置：停止 DSH 后删除 `model-fingerprint` 目录。

---

## 性能

- 启动后台扫描，按文件大小/修改时间增量处理；
- 追加日志只解析新帧；
- 补算单独串行执行，不并发重扫；
- 客户端窗口上限 2000 轮；活动/退出/占位卡片按可见轮次生成，单帧只做一次快照和一次写入；
- 100,000 轮 turn index 分页约 20ms；
- 100,000 条观测构造单会话轮次约 168ms；
- 报告按 scanner 版本、标签和 limit 缓存；
- 可见轮次通过 `/api/turn-window` 一次批量取得，单批最多 32 轮；
- 旧 generation、旧 session、旧 revision 响应丢弃；相同可见窗口请求去重。

---

## 官方扩展点与轨道适配器

当前运行版本为 DSH `0.2.2-rc.3`。可用的正式扩展点：

- `conversation.chat.turnTail`：已完成轮次的 list Slot，owner 提供 `TurnLocation` 和 closing `seq`；
- `conversation.chat.node`：按 Node kind 替换/扩展 Chat 行渲染，但不能直接装饰已存在的每个轮次；
- `data-chat-turn`、`data-chat-flow-kind`、`data-chat-group-part`、`data-chat-node-key`：Chat 暴露的稳定 DOM 属性；
- `data-slot="conversation.chat.flow"`：Chat flow 容器。

没有公开的 visible-turn、scroll、history-pagination 或 per-turn decoration hook。因此：

1. 用 `conversation.chat.turnTail` 注册零布局 probe，获得已完成轮次的官方挂载/卸载生命周期与轮次号；
2. 用 `VisibleTurnAdapter` 封装 DOM 兼容读取；轨道组件不直接 querySelector 官方 Chat 子树；
3. 每轮只选择一个 canonical anchor（最终 assistant/message，其次最后一个非工具 assistant-step，最后才回退轮次容器）；
4. 只读取当前帧的 anchor rect，不跨帧保存节点。

---

## 轨道 API

`GET /model-fingerprint/api/turn-window?id=<sessionId>&turns=80,81,82`

返回：

```js
{
  sessionId,
  revision,
  generation,
  turns: [
    { turn: 80, status: 'observed', data: Turn },
    { turn: 81, status: 'no-data', data: null, index: TurnIndexRow },
    { turn: 82, status: 'missing', data: null }
  ]
}
```

`observed` 显示正常指纹卡；`no-data` 显示“无模型指纹数据”；`missing`/请求中显示“指纹数据加载中”。负缓存按 session + generation + turn + revision 生效。

---

## 兼容性

已在：

```text
@deepseek-ai/dsh 0.2.2-rc.3
Windows Desktop / Web
```

验证：

- Host：`webServer`、`tools`、`sessions`、`llm`；
- Client：`shell.overlay`、`conversation.composer.dock`；
- `ctx.webServer.getOrigin()`；
- 逐轮卡片、官方相似度面板、固定探针、查询 API。

`0.2.2-rc.1` → `0.2.2-rc.3` 的升级指南中与本插件相关的是 macOS overlay 的窗口拖拽区域；Windows/Web 不受影响。

`engines.dsh`：

```text
>=0.2.2-rc.1 <0.3.0
```

---

## 发布到 npm

本仓库使用 **tag 触发发布**，普通 `git push` 不会发布，也不会自动升版本。

### 工作流

文件：

```text
.github/workflows/publish.yml
```

触发条件：

- 推送 `v*` 标签；
- 手动运行 `workflow_dispatch`，但仍要求从版本标签运行。

工作流会：

1. 检查 tag 与 `package.json.version` 完全一致；
2. 查询 npm 上该版本是否已存在，存在则跳过；
3. `npm run build && npm test && npm run check`；
4. `npm publish --access public --provenance`。

### 一次性配置：Trusted Publisher

在 npm 包设置页配置 **Trusted Publisher → GitHub Actions**：

```text
Organization/user: Darkhe55
Repository:        dsh-plugin-models-fingerprint
Workflow filename: publish.yml
Environment:       （留空）
```

工作流使用 GitHub OIDC：

```yaml
permissions:
  id-token: write
```

因此发布不再需要长期 `NPM_TOKEN` secret。GitHub Actions 会用 OIDC 换取一次性的 npm 发布凭证。

要求：

- 仓库为 public；
- workflow 文件名必须是 `publish.yml`；
- npm 包已存在于 registry；
- runner 使用支持 Trusted Publishing 的 npm 版本。

### 首次 OIDC 发布

`0.1.0` 已通过 token 完成首次发布；Trusted Publisher 从下一个版本开始使用。

```powershell
npm version patch
git push --follow-tags
```

例如当前是 `0.1.0`，会创建 `v0.1.1`。推送标签后 GitHub Actions 会自动构建、测试并通过 OIDC 发布。

如果 OIDC 发布失败，检查：

1. npm Trusted Publisher 的仓库名和 workflow 文件名是否完全一致；
2. workflow 是否包含 `id-token: write`；
3. 是否仍错误配置了 `NODE_AUTH_TOKEN`；
4. npm 上该版本是否已经存在。

旧的 `NPM_TOKEN` 可以继续保留作应急，但 Trusted Publisher 工作流不会读取它；确认 OIDC 稳定后建议在 GitHub Secrets 中删除。

### 发布新版本

### 发布新版本

只在准备发版时执行：

```powershell
npm version patch
git push --follow-tags
```

或者手动指定标签：

```powershell
npm version 0.2.0
git push --follow-tags
```

`npm version` 会：

- 更新 `package.json` 版本；
- 创建 `v0.2.0` 提交和 tag；
- 推送 tag 后触发发布。

如果只是普通代码提交：

```powershell
git add .
git commit -m "..."
git push
```

不会触发 npm 发布。

### 验证

```powershell
npm view dsh-plugin-model-fingerprint version
```

### 用户安装

```powershell
dsh plugin --profile desktop add dsh-plugin-model-fingerprint
```

发布前需确认包名未被占用。若使用 scoped 包名，命令相应改为 `@scope/name`。

### 本地手动检查

```powershell
npm pack --dry-run
npm publish --dry-run
```

`npm publish --dry-run` 会执行 `prepublishOnly` 的构建与测试，但不会真正上传。

---

## 开发

```powershell
npm test
npm run check
npm run build
```

测试覆盖：

- 指纹与声称名称解耦；
- wire API 变化产生新指纹；
- zstd 追加帧增量扫描；
- 同一会话多版本日志只扫描最高版本，损坏时回退；
- 语义去重、替换/删除后的 Turn Index 重建；
- 状态文件 v2 迁移与备份；
- 轮次数值降序、唯一性断言与分页无重复；
- live 事件去重；
- 状态文件读写与标签/探针持久化；
- 路由变化、别名、标签提示；
- 行为变化点；
- 行为距离和同名模型分组；
- 固定探针；
- 插件路由、工具、标签、探针、补算端到端；
- 客户端几何与用户气泡排除；
- 单轮 canonical anchor 选择和多段范围移除；
- 可见轮次批量接口 observed/no-data/missing；
- 虚拟 DOM 节点复用、786/785/784/783 故障序列、跳转恢复；
- 防碰撞布局与折叠 ID；
- 官方 turnTail 生命周期登记；
- 1,000 次节点复用、500 次历史 prepend、乱序延迟响应；
- FLIP 起点与最短动画时长。

---

## 文件结构

```text
index.js                 Host 入口：路由、工具、live 订阅、探针、补算
client.js                构建后的 Client 入口
client/                  Client 源码模块
client/rail-state.js     每帧目标推导、canonical anchor、防碰撞布局、跳转稳定性
client/visible-turn-adapter.js 官方 Chat DOM 快照与 flow/生命周期适配
client/turn-registry.js  官方 turnTail probe 的挂载/卸载登记
client/scroll-scheduler.js 滚动 follow / settle 调度
client/rebind-scheduler.js 大跨度跳转后的有界 DOM 重绑
client/turn-requests.js  单轮补取、代际与 revision 防护
client/turn-window-requests.js 可见轮次批量请求、去重、AbortController
scripts/build-client.mjs Client 构建脚本
lib/core.mjs             观测提取、指纹哈希、行为统计
lib/scan.mjs             文件发现、增量扫描、live、补算
lib/summary.mjs          指纹族/路由/会话/逐轮/提示
lib/equivalence.mjs      行为画像与距离
lib/similarity.mjs      官方基线、校准、行为相似度、漂移代理
lib/probe.mjs            固定探针
lib/store.mjs            zstd 状态读写
public/dashboard.html    面板
public/widget.js         兜底开关
test/                    单元与端到端测试
```

---

## 已知限制

- 会话日志格式变化可能导致字段缺失；
- DSH/适配器/网关升级会改变协议指纹，可能标记为 `generation`；
- 同一 API 外壳下不同模型可能共享指纹；
- 被动行为受任务影响，跨供应商结论优先使用固定探针；
- 行为相似度不是模型身份概率；
- 质量代理不是语义质量评分；
- 只监控本机 DSH sessions 目录；
- 远程 Web 模式读取的是运行 DSH 的机器上的日志。

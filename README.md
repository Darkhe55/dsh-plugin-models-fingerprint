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
发现会话文件
→ 重新解析当前文件
→ 去重后补回缺失观测
→ 更新 Turn Index
→ 写入 state.json.zst
```

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
- 客户端窗口上限 2000 轮，卡片 DOM 上限 9；
- 100,000 轮 turn index 分页约 20ms；
- 100,000 条观测构造单会话轮次约 168ms；
- 报告按 scanner 版本、标签和 limit 缓存。

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

> 当前仓库尚未登录 npm；下面是要执行的发布流程。

### 1. 检查包内容

```powershell
npm pack --dry-run
```

确认包含：

```text
index.js
client.js
lib/
public/
cordis.patch.yml
README.md
package.json
```

### 2. 登录

```powershell
npm login
npm whoami
```

### 3. 版本

首次发布：

```text
0.1.0
```

后续修复：

```powershell
npm version patch
```

### 4. 发布

```powershell
npm publish --access public
```

### 5. 验证

```powershell
npm view dsh-plugin-model-fingerprint version
```

### 6. 用户安装

```powershell
dsh plugin --profile desktop add dsh-plugin-model-fingerprint
```

发布前需确认包名未被占用。若使用 scoped 包名，命令相应改为 `@scope/name`。

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
- live 事件去重；
- 状态文件读写与标签/探针持久化；
- 路由变化、别名、标签提示；
- 行为变化点；
- 行为距离和同名模型分组；
- 固定探针；
- 插件路由、工具、标签、探针、补算端到端；
- 客户端几何与用户气泡排除。

---

## 文件结构

```text
index.js                 Host 入口：路由、工具、live 订阅、探针、补算
client.js                构建后的 Client 入口
client/                  Client 源码模块
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

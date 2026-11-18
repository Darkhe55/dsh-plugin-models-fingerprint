# 模型指纹识别器

面向 DeepSeek Harness 的本地模型路由可观测插件。它对比会话中的协议形态与行为统计，展示逐轮证据，并提示路由漂移。

![模型指纹面板示意图](docs/preview.svg)

指纹是**证据**，不是模型身份证明。插件不会仅凭文本声称识别出某个黑盒模型。

## 功能

- 按 wire protocol、adapter、响应 ID 形状、usage 字段和行为统计归纳模型指纹。
- 在对话左侧显示逐轮指纹卡片和判定。
- 比较不同路由的行为等价性，并与显式配置的官方基线比较。
- 检测会话级行为变化、路由跳变和指纹跳变。
- 本地状态不保存 prompt 或回复正文。

## 安装

从 npm 安装：

```powershell
dsh plugin --profile desktop add dsh-plugin-model-fingerprint@0.2.3
```

或安装本地目录：

```powershell
git clone https://github.com/Darkhe55/dsh-plugin-models-fingerprint.git
dsh plugin --profile desktop add "C:\path\to\dsh-plugin-models-fingerprint"
```

安装或升级后重启 DSH。

## 快速开始

1. 打开一个至少包含一次完整模型回复的会话。
2. 打开输入框上方的 **在会话消息旁显示指纹情况**。
3. 点击 **面板** 查看逐轮检测、指纹族、模型等价性和官方相似度。
4. 只有在有明确 provider/model 证据时才配置官方基线。
5. 在 **漂移诊断** 中查看会话级变化；这些只是探索性信号。

## 功能概览

| 模块 | 内容 |
|---|---|
| 逐轮 rail | 指纹、协议状态、声称模型和判定 |
| 指纹族 | 协议形状、响应 ID、工具与 usage 字段 |
| 路由等价性 | 路由和会话之间的行为距离 |
| 官方基线 | 显式证据等级、失效与校准 |
| 漂移诊断 | 会话级变化点与路由/指纹跳变 |
| 本地持久化 | 追加 journal、崩溃恢复、离线 compaction |
| 隐私 | 不在插件状态中保存正文 |

## 边界

- `fp_...` 表示传输/协议指纹，不代表模型权重身份。
- 官方身份需要显式证据；即使有官方基线，它仍是归因，不是密码学证明。
- 被动行为不能识别 MoE 专家，也不能保证供应商实际路由。
- FPR/置信区间可能显示“证据不足”，插件不得把它包装成肯定结论。
- 除非显式运行探针，否则不调用任何供应商 API。

## 数据与隐私

状态目录：

```text
%USERPROFILE%\.dsh\model-fingerprint
```

保存协议形状、行为摘要、哈希、会话 ID、时间、标签、基线和校准元数据；**不保存** prompt 或回复正文。

重大升级前请复制整个状态目录。排查持久化问题时不要删除 `state.json.zst` 或 `journal-v3`。

## 兼容性

- DSH `>=0.2.2-rc.1 <0.3.0`
- 当前 DSH 桌面版使用的 Node.js 24 运行时
- Web 客户端和本地 dashboard

## 开发

```powershell
npm install
npm run build
npm test
npm run check
```

离线检查：

```powershell
npm pack --dry-run
npm run bench:persistence
npm run benchmark:minimax
npm run benchmark:official
```

## 文档

- [完整中文参考](docs/REFERENCE.zh.md)
- [English README](README.md)
- [插件详情页](docs/DETAIL.zh.md)
- [持久化与运维](docs/REFERENCE.zh.md#补算与存盘)

## License

MIT

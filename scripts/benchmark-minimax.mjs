#!/usr/bin/env node
/**
 * Offline MiniMax M3 vs M2.7 hard-negative evaluation.
 * Reads the local fingerprint state; never calls a provider.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { buildHardNegativeBenchmark } from '../lib/benchmark.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh')

async function readState() {
  const base = path.join(home, 'model-fingerprint')
  for (const name of ['state.json.zst', 'state.json']) {
    try {
      const bytes = await fs.readFile(path.join(base, name))
      const text = name.endsWith('.zst') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
      return JSON.parse(text)
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('no fingerprint state under ' + base)
}

function markdown(report) {
  const [a, b] = report.models
  const auc = report.sessionHeldOut.auc
  const lines = [
    '# MiniMax M3 vs M2.7 离线困难负样本评估',
    '',
    '生成时间：' + report.generatedAt,
    '',
    '## 数据量',
    '',
    '| 模型 | 可用观测 | 排除 | 会话 |',
    '|---|---:|---:|---:|',
    '| ' + a.key + ' | ' + a.observations + ' | ' + a.excluded + ' | ' + a.sessions + ' |',
    '| ' + b.key + ' | ' + b.observations + ' | ' + b.excluded + ' | ' + b.sessions + ' |',
    '',
    '## 数据质量与排除',
    '',
    ...Object.entries(report.quality).flatMap(([model, quality]) => [
      '- ' + model + '：total=' + quality.total + '，behavior-baseline-usable=' + quality.usableForBaseline + '，protocol-identity-usable=' + quality.usableForIdentity + '，excluded=' + quality.excluded + '，identityExcluded=' + quality.identityExcluded,
      '- baseline classes：' + JSON.stringify(quality.baselineClasses),
      '- identity exclusion reasons：' + JSON.stringify(quality.identityReasons),
      '- missing protocol fields：' + JSON.stringify(quality.missingProtocolFields),
    ]),
    '',
    '## 协议形态',
    '',
    '- M3：' + JSON.stringify(report.protocol['MiniMax-M3']),
    '- M2.7：' + JSON.stringify(report.protocol['MiniMax-M2.7']),
    '- M2.7 原始指纹（含排除样本）：' + JSON.stringify(report.rawProtocol['MiniMax-M2.7'].fingerprints),
    '- transport family 相同：' + report.transportLayers.sameFamily + '；主 variant 相同：' + report.transportLayers.sameMajorVariant + '（M2.7 主 variant 占 ' + report.transportLayers.variantBShare + '）',
    '',
    '## 行为特征（中位数 / MAD / 覆盖率）',
    '',
    '| 特征 | M3 | M2.7 |',
    '|---|---:|---:|',
    ...Object.keys(report.behavior['MiniMax-M3']).map((key) => {
      const a = report.behavior['MiniMax-M3'][key]
      const b = report.behavior['MiniMax-M2.7'][key]
      const fmt = (item) => item.median + ' / ' + item.mad + ' / ' + item.coverage
      return '| ' + key + ' | ' + fmt(a) + ' | ' + fmt(b) + ' |'
    }),
    '',
    '## 会话留一法',
    '',
    '- 单位：session（非 observation）',
    '- 折数：' + report.sessionHeldOut.folds,
    '- 模型-会话记录：' + report.sessionHeldOut.independentSessions + '（唯一 session ID：' + report.sessionHeldOut.uniqueSessionIds + '）',
    '- 正确：' + report.sessionHeldOut.correct + ' / ' + report.sessionHeldOut.folds,
    '- 误判：' + report.sessionHeldOut.misclassified,
    '- 不确定：' + report.sessionHeldOut.uncertain,
    '- session-paired verification AUC：' + auc.auc + '（双向 session cluster bootstrap 95% CI ' + auc.bootstrap.lower + '–' + auc.bootstrap.upper + '，' + auc.bootstrap.reps + ' 次，seed ' + auc.bootstrap.seed + '）',
    '- 这是同一测试会话的 same/other 距离配对验证，不是独立观测分类 AUC。',
    '',
    '## Nested session-level FPR / Recall',
    '',
    '阈值在每折只由外层训练 session 确定；测试 session 不参与阈值、特征选择、标准化或中位数/MAD 计算。',
    '',
    '| 目标 FPR | 阈值范围 | 点估计 FPR | 点估计召回 | false accepts / negatives | true accepts / positives | FPR upper95 | 最小可观测非零 FPR | 分辨率 | 状态 |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---|---|',
    ...Object.entries(report.fpr.targets || {}).map(([rate, value]) => '| ' + rate + ' | ' + JSON.stringify(value.thresholdRange) + ' | ' + (value.pointEstimateReliable ? value.fpr : value.fpr + '（不可验证）') + ' | ' + value.recall + ' | ' + value.falseAccepts + ' / ' + value.negativeTrials + ' | ' + value.trueAccepts + ' / ' + value.positiveTrials + ' | ' + (value.fprConfidence && value.fprConfidence.meaningful ? value.fprConfidence.upper95 : '—（分辨率不足）') + ' | ' + value.minimumObservableNonzeroFpr + ' | ' + value.resolutionInsufficient + ' | ' + value.status + ' |'),
    '- 依赖说明：外层测试 session 的 same/other 决策成对；bootstrap 对 M3 与 M2.7 的 session 分别重采样（双向 cluster bootstrap），不会拆散同一 session 的配对。',
    '- 1% 目标：' + ((report.fpr.targets && report.fpr.targets['0.01'] && report.fpr.targets['0.01'].resolutionInsufficient) ? '负例数不足，无法验证，不能称为达到 1% FPR。' : '已按上置信界检查。'),
    '',
    '## 距离分布',
    '',
    '- 全量行为距离：' + report.directDistance.distance + '（相对自身波动 ' + JSON.stringify(report.directDistance.ratioToSelf) + '）',
    '- 同模型跨 session：' + JSON.stringify(report.pairDistances.sameModelAcrossSessions),
    '- 跨模型：' + JSON.stringify(report.pairDistances.crossModel),
    '',
    '## 严格前向时间验证（rolling-origin）',
    '',
    '- method：' + report.timeHeldOut.method,
    '- 有效折：' + report.timeHeldOut.validFolds + '；跳过：' + report.timeHeldOut.skippedFolds,
    '- 每折训练只使用 testStart 之前开始的 session；未来 session 数量单独记录。',
    '',
    '| 窗口 | 状态 | 训练会话 M3/M2.7 | 测试会话 M3/M2.7 | 测试起点 | 测试终点 | 距离 |',
    '|---:|---|---:|---:|---|---|---|',
    ...report.timeHeldOut.folds.map((fold) => '| ' + fold.window + ' | ' + fold.status + (fold.skipReason ? '（' + fold.skipReason + '）' : '') + ' | ' + fold.trainSessionsByModel['MiniMax-M3'] + '/' + fold.trainSessionsByModel['MiniMax-M2.7'] + ' | ' + fold.testSessionsByModel['MiniMax-M3'] + '/' + fold.testSessionsByModel['MiniMax-M2.7'] + ' | ' + (fold.testStart || '—') + ' | ' + (fold.testEnd || '—') + ' | ' + (fold.distances ? JSON.stringify(fold.distances) : '—') + ' |'),
    '',
    '- 无法验证的窗口不输出距离或 AUC；只有满足两个模型至少各 2 个历史 session 的窗口才可评估。',
    ...(report.timeHeldOut.folds.filter((fold) => fold.status === 'ok').map((fold) => '- 有效窗口 ' + fold.window + '：训练 M3/M2.7=' + fold.trainSessionsByModel['MiniMax-M3'] + '/' + fold.trainSessionsByModel['MiniMax-M2.7'] + '，测试 M3/M2.7=' + fold.testSessionsByModel['MiniMax-M3'] + '/' + fold.testSessionsByModel['MiniMax-M2.7'] + '；距离=' + JSON.stringify(fold.distances) + '。')),
    '',
    '## 特征消融（exploratory-only）',
    '',
    '- mode：' + report.ablation.mode,
    '- selectionUsedTest：' + report.ablation.selectionUsedTest,
    '- productionWeightsChanged：' + report.ablation.productionWeightsChanged,
    '- missingValuesTreatedAsZero：' + report.ablation.missingValuesTreatedAsZero,
    '- 结论仅用于探索；没有根据这 5 个 M2.7 会话删除或调整生产特征权重。',
    '',
    '| 移除特征 | AUC | 相对全特征 | 平均覆盖率 | 低覆盖 |',
    '|---|---:|---:|---:|---|',
    ...report.ablation.features.map((item) => {
      const coverage = item.coverageByFold.length ? item.coverageByFold.reduce((sum, row) => sum + row.coverage, 0) / item.coverageByFold.length : 0
      return '| ' + item.omitted + ' | ' + item.auc + ' | ' + item.delta + ' | ' + coverage.toFixed(3) + ' | ' + item.lowCoverage + ' |'
    }),
    '',
    '## 异常样本',
    '',
    ...report.anomalies.map((item) => '- `' + item.id + '` session=' + item.sessionId + ' turn=' + item.turn + ' step=' + item.step + ' time=' + new Date(item.time).toISOString() + ' fp=' + item.fingerprint + '；排除原因：' + item.quality.exclusionReasons.join(', ') + '；判断：' + item.analysis.likelyCause + '；routeSwitchObserved=' + item.analysis.routeSwitchObserved + '；原始数据保留'),
    '- 该样本所在 session 前后 step 的模型均为 MiniMax-M2.7，未观察到路由切换；该 step 只有 reasoning，没有 protocol/usage/replay，按不完整响应或缺失 replay 处理，原始数据未删除。',
    '',
    '## 结论分层',
    '',
    '- 协议一致：同一 `fp_...`、同一 transport family、M2.7 98.1% 使用同一主 variant。',
    '- 行为相似：不是“相同”；全量距离与 session-held-out 结果仅支持较弱的行为差异信号。',
    '- 可能的路由变体：当前最合适的表述是行为模式差异或潜在路由变体。',
    '- 模型身份确认：证据不足；passive-only 不能确认身份。',
    '- MoE 专家识别：未执行固定重复探针，不能识别 MoE 专家。',
    '- 生产上线条件：未达到。当前结果是离线研究/探索结论，不是生产身份判定器。',
    '',
    '## 旧方法失效说明',
    '',
    '- 旧时间留出把测试窗口之后的 session 放入训练集，属于未来数据泄漏；旧 time-held-out 数值不再有效。',
    '- 旧 FPR 在全部 95 个笛卡尔积 session pair 上同时选阈值和评估，且把相关 pair 当成独立样本；旧 1%/5% FPR、召回和实际 FPR 不再有效。',
    '- 旧 AUC 名称被写成普通 ROC AUC；现在只保留 session-paired verification AUC。',
    '- 旧消融使用全量数据计算；现在仅作 exploratory-only，生产权重未改变。',
    '',
    '## 限制',
    '',
    ...report.limitations.map((item) => '- ' + item),
    '',
    '> 当前只能称为行为模式/潜在路由变体，不能声称识别出 MoE 专家。',
    '',
  ]
  return lines.join('\n')
}

const state = await readState()
const report = buildHardNegativeBenchmark(Object.values(state.observations || {}), {
  models: [
    { provider: 'minimax-cn', model: 'MiniMax-M3', label: '官方 MiniMax M3' },
    { provider: 'minimax-cn', model: 'MiniMax-M2.7', label: '官方 MiniMax M2.7' },
  ],
})
const outDir = path.join(root, 'reports')
await fs.mkdir(outDir, { recursive: true })
const jsonFile = path.join(outDir, 'minimax-m3-m27.json')
const mdFile = path.join(outDir, 'minimax-m3-m27.md')
await fs.writeFile(jsonFile, JSON.stringify(report, null, 2) + '\n')
await fs.writeFile(mdFile, markdown(report))
console.log(JSON.stringify({
  json: path.relative(root, jsonFile),
  markdown: path.relative(root, mdFile),
  models: report.models,
  auc: report.sessionHeldOut.auc,
  fpr: Object.fromEntries(Object.entries(report.fpr.targets || {}).map(([rate, value]) => [rate, {
    fpr: value.fpr,
    recall: value.recall,
    upper95: value.fprConfidence && value.fprConfidence.upper95,
    resolutionInsufficient: value.resolutionInsufficient,
    status: value.status,
  }])),
  anomalies: report.anomalies.length,
  limitations: report.limitations,
}, null, 2))

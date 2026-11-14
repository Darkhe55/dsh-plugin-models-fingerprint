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
    '- 正确：' + report.sessionHeldOut.correct + ' / ' + report.sessionHeldOut.folds,
    '- 误判：' + report.sessionHeldOut.misclassified,
    '- 不确定：' + report.sessionHeldOut.uncertain,
    '- AUC：' + auc.auc + '（session bootstrap 95% CI ' + auc.bootstrap.lower + '–' + auc.bootstrap.upper + '，' + auc.bootstrap.reps + ' 次）',
    '',
    '## 固定 FPR',
    '',
    '| 目标 FPR | 阈值 | 实际 FPR | 召回 |',
    '|---:|---:|---:|---:|',
    ...Object.entries(report.fpr).map(([rate, value]) => '| ' + rate + ' | ' + value.threshold + ' | ' + value.actualFpr + ' | ' + value.recall + ' |'),
    '',
    '## 距离分布',
    '',
    '- 全量行为距离：' + report.directDistance.distance + '（相对自身波动 ' + JSON.stringify(report.directDistance.ratioToSelf) + '）',
    '- 同模型跨 session：' + JSON.stringify(report.pairDistances.sameModelAcrossSessions),
    '- 跨模型：' + JSON.stringify(report.pairDistances.crossModel),
    '',
    '## 时间留出',
    '',
    '| 窗口 | 测试会话 | M3 自身 | M2.7 自身 | M3→M2.7 | M2.7→M3 |',
    '|---:|---:|---:|---:|---:|---:|',
    ...report.timeHeldOut.folds.map((fold) => '| ' + fold.window + ' | ' + fold.testSessions + ' | ' + (fold.m3 ?? '—') + ' | ' + (fold.m27 ?? '—') + ' | ' + (fold.m3ToM27 ?? '—') + ' | ' + (fold.m27ToM3 ?? '—') + ' |'),
    '',
    '## 特征消融',
    '',
    '| 移除特征 | AUC | 相对全特征 |',
    '|---|---:|---:|',
    ...report.ablation.features.map((item) => '| ' + item.omitted + ' | ' + item.auc + ' | ' + item.delta + ' |'),
    '',
    '## 异常样本',
    '',
    ...report.anomalies.map((item) => '- `' + item.id + '` session=' + item.sessionId + ' turn=' + item.turn + ' step=' + item.step + ' time=' + new Date(item.time).toISOString() + ' fp=' + item.fingerprint + '；排除原因：' + item.quality.exclusionReasons.join(', ') + '；判断：' + item.analysis.likelyCause + '；routeSwitchObserved=' + item.analysis.routeSwitchObserved + '；原始数据保留'),
    '- 该样本所在 session 前后 step 的模型均为 MiniMax-M2.7，未观察到路由切换；该 step 只有 reasoning，没有 protocol/usage/replay，按不完整响应或缺失 replay 处理，原始数据未删除。',
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
  fpr: report.fpr,
  anomalies: report.anomalies.length,
  limitations: report.limitations,
}, null, 2))

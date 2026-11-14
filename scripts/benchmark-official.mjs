#!/usr/bin/env node
/**
 * Offline official-source audit. No provider calls.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { mergeOfficialSeeds, FEATURE_SCHEMA_VERSION, QUALITY_VERSION } from '../lib/official.mjs'
import { buildOfficialProfile } from '../lib/similarity.mjs'
import { qualityForRows } from '../lib/quality.mjs'
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

const state = await readState()
const observations = Object.values(state.observations || {})
const models = mergeOfficialSeeds(state.officialModels || [], state.officialEvidenceVersion || 0).models
const context = {
  dataVersion: Number(state.dataVersion) || 0,
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
  qualityVersion: QUALITY_VERSION,
  scannerGeneration: state.generation || null,
  observationRevision: Number(state.version) || 0,
}
const baseline = models.map((model) => {
  const built = buildOfficialProfile(observations, model, context)
  return {
    key: model.key,
    evidenceLevel: model.evidenceLevel,
    evidenceSource: model.evidenceSource,
    confirmedAt: model.confirmedAt,
    samples: built.samples,
    sessions: built.sessions,
    excludedSamples: built.excludedSamples,
    baselineClasses: built.baselineClasses,
    legacySamples: built.legacySamples,
    protocolIdentitySamples: built.protocolIdentitySamples,
    ready: built.ready,
    dataVersion: built.dataVersion,
    featureSchemaVersion: built.featureSchemaVersion,
    sourceDigest: built.sourceDigest,
    fingerprints: built.fingerprints,
    quality: qualityForRows(observations.filter((row) => row.provider === model.provider && row.model === model.model)),
  }
})
const minimax = models.filter((model) => model.provider === 'minimax-cn' && (model.model === 'MiniMax-M3' || model.model === 'MiniMax-M2.7'))
const hardNegative = minimax.length === 2 ? buildHardNegativeBenchmark(observations, { models: minimax }) : null
const report = { generatedAt: new Date().toISOString(), dataVersion: context.dataVersion, models: baseline, hardNegative }
const outDir = path.join(root, 'reports')
await fs.mkdir(outDir, { recursive: true })
const file = path.join(outDir, 'official-audit.json')
await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({
  report: path.relative(root, file),
  models: baseline.map((item) => ({
    key: item.key,
    evidenceLevel: item.evidenceLevel,
    samples: item.samples,
    sessions: item.sessions,
    excludedSamples: item.excludedSamples,
    ready: item.ready,
    sourceDigest: item.sourceDigest,
  })),
  hardNegative: hardNegative ? {
    auc: hardNegative.sessionHeldOut.auc.auc,
    fpr: Object.fromEntries(Object.entries(hardNegative.fpr.targets || {}).map(([rate, value]) => [rate, {
      fpr: value.fpr,
      recall: value.recall,
      upper95: value.fprConfidence && value.fprConfidence.upper95,
      resolutionInsufficient: value.resolutionInsufficient,
      status: value.status,
    }])),
    anomalies: hardNegative.anomalies.length,
  } : null,
}, null, 2))

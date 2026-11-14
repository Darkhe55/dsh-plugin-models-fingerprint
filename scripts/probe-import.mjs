#!/usr/bin/env node
/**
 * Validate an offline probe result export. This is an import gate only; it
 * never calls a provider.
 *
 * Usage: npm run probe:import -- path/to/probe-results.json
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildProbePlan, validateProbeResults } from '../lib/probe-plan.mjs'

const input = process.argv[2]
if (!input) {
  console.error('usage: npm run probe:import -- path/to/probe-results.json')
  process.exit(1)
}
const plan = buildProbePlan({
  models: [
    { provider: 'minimax-cn', model: 'MiniMax-M3', label: '官方 MiniMax M3' },
    { provider: 'minimax-cn', model: 'MiniMax-M2.7', label: '官方 MiniMax M2.7' },
  ],
  repeats: 10,
  windows: ['w1', 'w2'],
})
const payload = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
const rows = Array.isArray(payload) ? payload : payload.results
const result = validateProbeResults(plan, rows)
const out = {
  schema: 'model-fingerprint-probe-import-audit/v1',
  input: path.basename(input),
  accepted: result.acceptedCount,
  rejected: result.rejectedCount,
  rejections: result.rejected.slice(0, 50),
  expectedPerModel: plan.totals.perModel,
  automaticProviderCalls: false,
}
const outFile = path.resolve('reports/probe-import-audit.json')
await fs.mkdir(path.dirname(outFile), { recursive: true })
await fs.writeFile(outFile, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify({ report: path.relative(process.cwd(), outFile), accepted: out.accepted, rejected: out.rejected, rejections: out.rejections.length }, null, 2))
if (result.rejectedCount) process.exitCode = 2

#!/usr/bin/env node
/**
 * Generate the offline fixed-probe plan. Never calls a provider.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProbePlan } from '../lib/probe-plan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const plan = buildProbePlan({
  models: [
    { provider: 'minimax-cn', model: 'MiniMax-M3', label: '官方 MiniMax M3' },
    { provider: 'minimax-cn', model: 'MiniMax-M2.7', label: '官方 MiniMax M2.7' },
  ],
  repeats: 10,
  windows: ['w1', 'w2'],
})
const outDir = path.join(root, 'reports')
await fs.mkdir(outDir, { recursive: true })
const file = path.join(outDir, 'minimax-probe-plan.json')
await fs.writeFile(file, JSON.stringify(plan, null, 2) + '\n')
console.log(JSON.stringify({ file: path.relative(root, file), totals: plan.totals, callPolicy: plan.callPolicy, confirmRequired: plan.confirmRequired }, null, 2))

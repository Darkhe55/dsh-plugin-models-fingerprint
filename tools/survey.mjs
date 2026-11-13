import { homedir } from 'node:os'
import path from 'node:path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SessionScanner, defaultSessionRoots, discoverProfileRoots } from '../lib/scan.mjs'
import { buildReport, fingerprintLabel, protocolLabel } from '../lib/summary.mjs'

const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const roots = process.env.DSH_SESSIONS_DIR
  ? [process.env.DSH_SESSIONS_DIR]
  : [...defaultSessionRoots(home), ...(await discoverProfileRoots(home))]
const statePath = process.env.MF_STATE || path.join(process.env.TEMP || home, 'dsh-model-fingerprint-survey.json')
let state
try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch { state = undefined }
const scanner = new SessionScanner({ roots, state })
scanner.start()
await scanner.waitIdle(600000)
scanner.stop()
mkdirSync(dirname(statePath), { recursive: true })
writeFileSync(statePath, JSON.stringify(scanner.serialize()))
const report = buildReport(scanner, {}, { limit: 200 })
console.log(JSON.stringify(report.scan, null, 2))
console.log(JSON.stringify(report.stats, null, 2))
console.log('\nLATEST')
console.log(JSON.stringify(report.latest, null, 2))
console.log('\nFINGERPRINTS')
for (const fp of report.fingerprints.slice(0, 30)) {
  console.log(`${fingerprintLabel(fp.id)} obs=${fp.observations} sessions=${fp.sessions} names=${fp.names.map((n) => n.name).join(',')} | ${protocolLabel(fp.protocol)}`)
}
console.log('\nROUTES')
for (const route of report.routes.slice(0, 30)) {
  console.log(`${route.routeKey} obs=${route.observations} fps=${route.fingerprints.map((f) => f.short).join(',')} status=${route.status}`)
}
console.log('\nALERTS')
for (const alert of report.alerts.slice(0, 20)) console.log(`${alert.severity} ${alert.title} :: ${alert.detail}`)

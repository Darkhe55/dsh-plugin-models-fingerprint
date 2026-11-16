import { FingerprintStore } from '../../lib/store.mjs'
import { SessionScanner } from '../../lib/scan.mjs'

const const home = process.argv[2]
const count = Number(process.argv[3]) || 10000
const scanner = new SessionScanner({ roots: [] })
for (let index = 0; index < count; index += 1) {
  const sessionId = 'crash-' + Math.floor(index / 100)
  scanner.addObservation({
    id: sessionId + ':' + index,
    sessionId,
    seq: index,
    time: index + 1,
    turn: index % 100,
    step: 1,
    fingerprint: 'fp_aaaaaaaaaaaa',
    protocol: { api: 'crash-test', adapter: 'crash-test' },
  })
}
const store = new FingerprintStore({ home })
await store.load()
await store.save(scanner, 'crash-writer')
process.exit(0)

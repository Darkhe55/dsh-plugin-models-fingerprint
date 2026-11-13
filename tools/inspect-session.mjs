import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block at ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

export function readSessionEvents(path) {
  const buffer = readFileSync(path)
  const { frames, tornStart } = scanFrames(buffer)
  const text = frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')).join('')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* torn tail */ }
  }
  return { events, frameCount: frames.length, tornStart }
}

if (process.argv[1]) {
  const path = process.argv[2]
  if (!path) { console.error('usage: node inspect-session.mjs <session.v4.jsonl.zstd>'); process.exit(1) }
  const { events, frameCount, tornStart } = readSessionEvents(path)
  console.log(JSON.stringify({ path, frameCount, tornStart, events: events.length }, null, 2))
  const counts = new Map()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  console.log('types', [...counts.entries()].sort((a, b) => b[1] - a[1]))
  for (const type of ['session', 'request/context', 'request/header', 'assistant/message', 'assistant/attempt']) {
    const event = events.find((candidate) => candidate.type === type)
    if (!event) continue
    console.log(`\n=== ${type} ===`)
    console.log(JSON.stringify(event, null, 2).slice(0, 12000))
  }
}

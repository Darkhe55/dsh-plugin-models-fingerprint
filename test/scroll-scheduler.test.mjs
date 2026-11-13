import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadScheduler() {
  const source = await fs.readFile(new URL('../client/scroll-scheduler.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn ScrollScheduler')()
}

function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    setTimer(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id },
    clearTimer(id) { pending.delete(id) },
    flush() { const jobs = [...pending.entries()]; pending.clear(); for (const [, job] of jobs) job.fn(); return jobs.length },
    pending,
  }
}

test('continuous wheel input resets one settle timer and settles once', async () => {
  const ScrollScheduler = await loadScheduler()
  const timers = fakeTimers()
  let settled = 0
  const scheduler = new ScrollScheduler({ settleMs: 110, setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers), onSettle: () => { settled += 1 } })
  scheduler.noteScroll()
  scheduler.noteScroll()
  scheduler.noteScroll()
  assert.equal(timers.pending.size, 1)
  assert.equal(scheduler.scrolling, true)
  timers.flush()
  assert.equal(settled, 1)
  assert.equal(scheduler.scrolling, false)
})

test('disposing the scheduler clears the pending settle', async () => {
  const ScrollScheduler = await loadScheduler()
  const timers = fakeTimers()
  let settled = 0
  const scheduler = new ScrollScheduler({ settleMs: 110, setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers), onSettle: () => { settled += 1 } })
  scheduler.noteScroll()
  scheduler.dispose()
  assert.equal(timers.pending.size, 0)
  assert.equal(settled, 0)
  assert.equal(scheduler.scrolling, false)
})

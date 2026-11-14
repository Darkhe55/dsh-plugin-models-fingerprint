import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadScheduler() {
  const source = await fs.readFile(new URL('../client/rebind-scheduler.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn RebindScheduler')()
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

test('jump rebind schedules one immediate retry plus bounded delayed retries', async () => {
  const RebindScheduler = await loadScheduler()
  const timers = fakeTimers()
  let count = 0
  const scheduler = new RebindScheduler({ setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers), onRebind: () => { count += 1 } })
  scheduler.kick()
  assert.equal(count, 1)
  assert.equal(scheduler.pending, 2)
  timers.flush()
  assert.equal(count, 3)
})

test('a new jump cancels previous delayed retries', async () => {
  const RebindScheduler = await loadScheduler()
  const timers = fakeTimers()
  let count = 0
  const scheduler = new RebindScheduler({ setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers), onRebind: () => { count += 1 } })
  scheduler.kick()
  scheduler.kick()
  assert.equal(scheduler.pending, 2)
  timers.flush()
  assert.equal(count, 4)
})

test('dispose cancels pending retries', async () => {
  const RebindScheduler = await loadScheduler()
  const timers = fakeTimers()
  let count = 0
  const scheduler = new RebindScheduler({ setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers), onRebind: () => { count += 1 } })
  scheduler.kick()
  scheduler.dispose()
  assert.equal(scheduler.pending, 0)
  timers.flush()
  assert.equal(count, 1)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'

async function loadAnimator() {
  const source = await fs.readFile(new URL('../client/animator.js', import.meta.url), 'utf8')
  return new Function(source + '\nreturn SlotAnimator')()
}

function fakeNode() {
  const animations = []
  const node = {
    animations,
    style: {},
    animate(frames, options) {
      const animation = {
        id: options.id,
        frames,
        options,
        playState: 'running',
        committed: false,
        cancelled: false,
        cancel() { this.cancelled = true; this.playState = 'idle' },
        commitStyles() { this.committed = true },
        onfinish: null,
      }
      animations.push(animation)
      return animation
    },
  }
  return node
}

test('animator does not restart an identical enter animation', async () => {
  const SlotAnimator = await loadAnimator()
  const animator = new SlotAnimator({ eased: 'linear', reduced: false, cardWidth: 176 })
  const node = fakeNode()
  const args = { left: 10, fromTop: 20, fromScale: 0.9, toTop: 30, toScale: 1, toOpacity: 1, delay: 0, motionScale: 1 }
  const first = animator.enter(node, args)
  const second = animator.enter(node, args)
  assert.equal(first, second)
  assert.equal(node.animations.length, 1)
  assert.equal(first.cancelled, false)
})

test('animator replaces a changed role once and commits the old visual state', async () => {
  const SlotAnimator = await loadAnimator()
  const animator = new SlotAnimator({ eased: 'linear', reduced: false, cardWidth: 176 })
  const node = fakeNode()
  animator.enter(node, { left: 10, fromTop: 20, fromScale: 0.9, toTop: 30, toScale: 1 })
  const enter = animator.animation(node, 'mf-enter')
  const shift = animator.shift(node, { left: 10, fromTop: 25, fromScale: 1, toTop: 80, toScale: 0.88, role: 'squeeze', motionScale: 1 })
  assert.equal(enter.cancelled, true)
  assert.equal(enter.committed, true)
  assert.equal(shift.id, 'mf-shift')
  assert.equal(node.animations.length, 2)
  const same = animator.shift(node, { left: 10, fromTop: 25, fromScale: 1, toTop: 80, toScale: 0.88, role: 'squeeze', motionScale: 1 })
  assert.equal(same, shift)
  assert.equal(node.animations.length, 2)
})

test('eject followed by enter commits eject and starts a fresh enter', async () => {
  const SlotAnimator = await loadAnimator()
  const animator = new SlotAnimator({ eased: 'linear', reduced: false, cardWidth: 176 })
  const node = fakeNode()
  animator.eject(node, { fromTransform: 'translate3d(0,0,0)', fromOpacity: 1, toTransform: 'translate3d(0,100px,0)', motionScale: 1 })
  const eject = animator.animation(node, 'mf-eject')
  const enter = animator.enter(node, { left: 0, fromTop: 40, fromScale: 1, toTop: 40, toScale: 1 })
  assert.equal(eject.cancelled, true)
  assert.equal(eject.committed, true)
  assert.equal(enter.id, 'mf-enter')
  assert.equal(animator.animation(node, 'mf-enter'), enter)
})

test('FLIP starts from the current on-screen rectangle and keeps a minimum duration', async () => {
  const SlotAnimator = await loadAnimator()
  const animator = new SlotAnimator({ eased: 'linear', reduced: false, cardWidth: 176 })
  const node = fakeNode()
  node.offsetWidth = 176
  node.getBoundingClientRect = () => ({ top: 240, left: 0, width: 176, height: 58 })
  const animation = animator.flip(node, { fromRect: node.getBoundingClientRect(), toTop: 40, toScale: 0.88, toOpacity: 0.5, role: 'pushed', motionScale: 0.42 })
  assert.match(animation.frames[0].transform, /240px/)
  assert.equal(animation.options.duration >= 120, true)
  assert.equal(animation.frames[1].transform, 'translate3d(0,40px,0) scale(0.88)')
})

test('retarget starts from the current visual rect instead of the old logical target', async () => {
  const SlotAnimator = await loadAnimator()
  const animator = new SlotAnimator({ eased: 'linear', reduced: false, cardWidth: 176 })
  const node = fakeNode()
  node.offsetWidth = 176
  node.getBoundingClientRect = () => ({ top: 41, left: 0, width: 176, height: 58 })
  const first = animator.shift(node, { left: 0, fromTop: 10, fromScale: 1, toTop: 100, toScale: 1, role: 'pushed', motionScale: 1 })
  const retarget = animator.flip(node, { fromRect: node.getBoundingClientRect(), toTop: 220, toScale: 0.88, role: 'squeeze', motionScale: 1 })
  assert.equal(first.cancelled, true)
  assert.equal(first.committed, true)
  assert.match(retarget.frames[0].transform, /41px/)
  assert.equal(retarget.frames[1].transform, 'translate3d(0,220px,0) scale(0.88)')
  assert.ok(retarget.options.duration >= 220)
})

test('reduced motion may complete immediately', async () => {
  const SlotAnimator = await loadAnimator()
  const animator = new SlotAnimator({ eased: 'linear', reduced: true, cardWidth: 176 })
  assert.equal(animator.duration('pushed', 0.4), 0)
})

test('finished animations clear their state without cancelling the next role', async () => {
  const SlotAnimator = await loadAnimator()
  const animator = new SlotAnimator({ eased: 'linear', reduced: false, cardWidth: 176 })
  const node = fakeNode()
  const enter = animator.enter(node, { left: 0, fromTop: 0, fromScale: 1, toTop: 0, toScale: 1 })
  enter.playState = 'finished'
  enter.onfinish()
  assert.equal(animator.animation(node, 'mf-enter'), null)
  const shift = animator.shift(node, { left: 0, fromTop: 0, fromScale: 1, toTop: 20, toScale: 1, role: 'pushed', motionScale: 1 })
  assert.equal(shift.id, 'mf-shift')
  assert.equal(enter.cancelled, false)
})

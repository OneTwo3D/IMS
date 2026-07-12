import assert from 'node:assert/strict'
import test from 'node:test'

import { createInboxDrainer } from '@/lib/jobs/shopping/drain-inbox'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('single-flight: concurrent triggers collapse into one re-run, never overlapping', async () => {
  let calls = 0
  let active = 0
  let maxActive = 0
  const release: Array<() => void> = []
  const drainer = createInboxDrainer(() => {
    calls += 1
    active += 1
    maxActive = Math.max(maxActive, active)
    return new Promise<void>((resolve) => {
      release.push(() => {
        active -= 1
        resolve()
      })
    })
  })

  drainer.schedule({ immediate: true }) // starts pass 1
  drainer.schedule({ immediate: true }) // in-flight -> mark rerun
  drainer.schedule({ immediate: true }) // still just one rerun queued
  assert.equal(calls, 1)

  release.shift()!() // finish pass 1 -> triggers the single rerun
  await tick()
  assert.equal(calls, 2, 'exactly one re-run, not one per trigger')
  assert.equal(maxActive, 1, 'never runs two drains concurrently')

  release.shift()!() // finish pass 2
  await drainer.whenIdle()
  assert.equal(calls, 2)
})

test('debounce: a burst of schedules collapses into a single drain', async () => {
  let calls = 0
  const drainer = createInboxDrainer(async () => { calls += 1 }, { debounceMs: 20 })

  drainer.schedule()
  drainer.schedule()
  drainer.schedule()
  assert.equal(calls, 0, 'debounced — nothing runs synchronously')

  await tick(40)
  assert.equal(calls, 1, 'the burst produced exactly one drain pass')
})

test('debounce: a later event reschedules after the previous drain completed', async () => {
  let calls = 0
  const drainer = createInboxDrainer(async () => { calls += 1 }, { debounceMs: 10 })

  drainer.schedule()
  await tick(25)
  assert.equal(calls, 1)

  drainer.schedule()
  await tick(25)
  assert.equal(calls, 2)
})

test('a failing drain is isolated and does not block later drains', async () => {
  let calls = 0
  const errors: unknown[] = []
  const drainer = createInboxDrainer(
    async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
    },
    { debounceMs: 5, onError: (error) => errors.push(error) },
  )

  drainer.schedule()
  await tick(15)
  assert.equal(calls, 1)
  assert.equal(errors.length, 1, 'error routed to onError, not thrown')

  drainer.schedule()
  await tick(15)
  assert.equal(calls, 2, 'drainer recovered after a failure')
})

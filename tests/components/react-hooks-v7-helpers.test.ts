import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useRenderSync, useResyncedState } from '../../lib/react/use-render-sync.ts'
import { minuteFloor, minutesSince, receivedWithin, useNow } from '../../lib/react/use-now.ts'

/**
 * The helpers that replaced the prop-sync / Date.now()-in-render effects flagged by react-hooks v7
 * (set-state-in-effect, purity). Rendered to markup, no browser.
 */

test('useResyncedState starts from the source value', () => {
  function Probe({ source }: { source: string }) {
    const [value] = useResyncedState(source)
    return createElement('span', null, value)
  }
  assert.equal(renderToStaticMarkup(createElement(Probe, { source: 'a' })), '<span>a</span>')
})

test('useRenderSync applies in the render pass when a dep differs from the first render, and not otherwise', () => {
  // The server renderer replays render-phase updates, so a dep that differs on the SECOND pass of one
  // component instance is observable: drive it with a counter that changes between the two passes.
  let applied = 0
  let pass = 0
  function Probe() {
    const [x, setX] = useState(0)
    pass += 1
    if (x === 0 && pass === 1) setX(2) // a render-phase update makes the server renderer replay the component, as a prop change would on the client
    useRenderSync([pass === 1 ? 'first' : 'second'], () => { applied += 1; setX(1) })
    return createElement('span', null, 'ok')
  }
  renderToStaticMarkup(createElement(Probe))
  assert.equal(applied, 1, 'the changed dep ran apply once, and the replayed render (dep now equal) did not run it again')

  applied = 0
  function Stable() {
    useRenderSync(['same'], () => { applied += 1 })
    return createElement('span', null, 'ok')
  }
  renderToStaticMarkup(createElement(Stable))
  assert.equal(applied, 0, 'an unchanged dep never runs apply')
})

test('minuteFloor is stable inside a minute and steps at the boundary', () => {
  const t = Date.UTC(2026, 10, 19, 12, 30, 5)
  assert.equal(minuteFloor(t), Date.UTC(2026, 10, 19, 12, 30, 0))
  assert.equal(minuteFloor(t + 54_000), minuteFloor(t))
  assert.equal(minuteFloor(t + 55_000), Date.UTC(2026, 10, 19, 12, 31, 0))
})

test('minutesSince and receivedWithin do the arithmetic against the supplied clock, not the real one', () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0)
  assert.equal(minutesSince('2026-11-19T11:15:00.000Z', now), 45)
  assert.equal(receivedWithin('2026-11-18T12:00:00.000Z', now, 24 * 3_600_000), true, 'exactly 24h old is still inside the window')
  assert.equal(receivedWithin('2026-11-18T11:59:59.000Z', now, 24 * 3_600_000), false)
  assert.equal(receivedWithin(null, now, 1000), false)
  assert.equal(receivedWithin('not a date', now, 1000), false)
})

test('useNow renders a minute-resolution clock', () => {
  function Probe() { return createElement('span', null, String(useNow() % 60_000)) }
  assert.equal(renderToStaticMarkup(createElement(Probe)), '<span>0</span>')
})

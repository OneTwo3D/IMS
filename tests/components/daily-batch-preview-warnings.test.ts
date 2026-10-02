import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DailyBatchPreviewWarnings } from '@/app/(dashboard)/sync/daily-batch-preview-warnings'

/**
 * o3d-3la07 (Codex round 1, medium): the daily-batch preview builds per-order `warnings` (D3, M6) and the Xero
 * preview panel must DISPLAY them. Two halves, because each hides the other's failure: the component shows
 * what it is given, and the panel actually mounts it with `preview.warnings`.
 */

const WARNING_A = 'Order SO-1: the deferred-revenue true-up netted UNEARNED_REV_REVERSAL rows it cannot vouch for - sync log(s) rev-1 were settled as posted by an OPERATOR'
const WARNING_B = 'Order SO-2: the deferred-revenue true-up netted UNEARNED_REV_REVERSAL rows it cannot vouch for - sync log(s) rev-9 are cancelled but may have reached the ledger'

test('every warning is rendered, one list item per order, in an alert', () => {
  const html = renderToStaticMarkup(React.createElement(DailyBatchPreviewWarnings, { warnings: [WARNING_A, WARNING_B] }))
  assert.match(html, /role="alert"/)
  assert.match(html, /2 orders netted against a reversal the IMS cannot vouch for/)
  assert.equal((html.match(/<li>/g) ?? []).length, 2, 'PRECONDITION: two items rendered')
  assert.ok(html.includes('Order SO-1'), 'first order named')
  assert.ok(html.includes('Order SO-2'), 'second order named')
  assert.ok(html.includes('rev-1') && html.includes('rev-9'))
  console.log('warnings rendered: 2 items')
})

test('one warning is singular, none (or undefined) renders nothing at all', () => {
  assert.match(renderToStaticMarkup(React.createElement(DailyBatchPreviewWarnings, { warnings: [WARNING_A] })), /1 order netted/)
  assert.equal(renderToStaticMarkup(React.createElement(DailyBatchPreviewWarnings, { warnings: [] })), '')
  assert.equal(renderToStaticMarkup(React.createElement(DailyBatchPreviewWarnings, {})), '')
})

test('the Xero daily-batch panel mounts the component with preview.warnings', () => {
  const source = readFileSync('app/(dashboard)/sync/xero-client.tsx', 'utf8')
  const matches = source.match(/<DailyBatchPreviewWarnings warnings=\{preview\.warnings\} \/>/g) ?? []
  assert.equal(matches.length, 1, 'mounted exactly once, from the panel that holds `preview`')
  const panelStart = source.indexOf('function DailyBatchPanel(')
  assert.ok(panelStart > 0 && source.indexOf('<DailyBatchPreviewWarnings', panelStart) > panelStart, 'inside DailyBatchPanel')
  assert.ok(source.includes("from './daily-batch-preview-warnings'"))
})

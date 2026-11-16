import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Phone layout of the PO receive dialog and the New Stock Transfer dialog. No browser runs here (the
 * dialogs sit in a portal behind server actions), so this pins the responsive classes that make them
 * usable at 360-414 px; the visual check is a manual / e2e one.
 */
const po = readFileSync('app/(dashboard)/purchase-orders/[id]/po-detail-client.tsx', 'utf8')
const transfer = readFileSync('app/(dashboard)/stock-control/transfers/transfer-form.tsx', 'utf8')

const receiveStart = po.indexOf('function ReceiveDialog(')
const receive = po.slice(receiveStart, po.indexOf('\nfunction ', receiveStart + 10))

test('receive dialog is full-screen on a phone and keeps the desktop width', () => {
  for (const c of ['max-sm:h-dvh', 'max-sm:max-w-none', 'max-sm:rounded-none', 'sm:max-w-4xl']) assert.ok(receive.includes(c), c)
})

test('receive table becomes stacked cards below sm and keeps the table above', () => {
  for (const c of ['max-sm:block', 'max-sm:hidden', 'max-sm:grid', 'max-sm:grid-cols-3']) assert.ok(receive.includes(c), c)
  for (const label of ['Ordered', 'Received', 'Remaining', 'Receive now', 'Warehouse']) {
    assert.ok(receive.includes(`data-label="${label}"`), `label ${label}`)
  }
  assert.ok(receive.includes('table-fixed'), 'desktop table-fixed layout untouched')
  assert.ok(receive.includes('max-sm:h-11'), 'tap-sized controls')
  assert.ok(receive.includes('max-sm:text-base'), '16px text so iOS does not zoom on focus')
})

test('transfer dialog is full-screen on a phone and lines stack without the 500px minimum', () => {
  for (const c of ['max-sm:h-dvh', 'max-sm:max-w-none', 'max-sm:grid-cols-2', 'max-sm:hidden', 'max-sm:h-11']) assert.ok(transfer.includes(c), c)
  assert.ok(transfer.includes('sm:min-w-[500px]'))
  assert.ok(!transfer.includes('"min-w-[500px]"'), 'no unconditional min width')
  assert.ok(transfer.includes('grid-cols-[2fr_1fr_1fr_auto_auto]'), 'desktop grid untouched')
})

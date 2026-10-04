import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyWcCompletionEligibility, type WcCompletionEligibility } from '@/lib/connectors/woocommerce/sync/completion-eligibility'
import type { WcOrderStatusReading } from '@/lib/connectors/woocommerce/sync/status-mapping'
import { WC_PARTIAL_SHIPPED_STATUS } from '@/lib/connectors/woocommerce/sync/partial-shipment'

/**
 * o3d-zvec.15 (HIGH 1) — "may IMS complete this WooCommerce order?" is decided from the IMPORTER'S OWN
 * reading of the status plus the order state machine, not from the literal `processing`.
 *
 * Each row is the `reading` the importer would produce (slug, imsStatus, handledBy), so the table asserts
 * the rule over a stated input rather than over whatever a lookup returned. The `refunded` row is the
 * isolating one: its reading is PROCESSING (the built-in map), so ONLY the handledBy check can refuse it.
 */

const WITHDRAWAL = { submitted: 'pending-wdraw', approved: 'withdrawn' }

type Row = {
  name: string
  reading: Pick<WcOrderStatusReading, 'slug' | 'imsStatus' | 'handledBy'>
  expected: WcCompletionEligibility
}

const ROWS: Row[] = [
  { name: 'processing', reading: { slug: 'processing', imsStatus: 'PROCESSING', handledBy: null }, expected: 'eligible' },
  { name: 'custom ready-to-ship mapped to PROCESSING', reading: { slug: 'ready-to-ship', imsStatus: 'PROCESSING', handledBy: null }, expected: 'eligible' },
  { name: 'custom packed mapped to PACKING', reading: { slug: 'packed-custom', imsStatus: 'PACKING', handledBy: null }, expected: 'eligible' },
  { name: 'custom picking mapped to PICKING', reading: { slug: 'picking-custom', imsStatus: 'PICKING', handledBy: null }, expected: 'eligible' },
  { name: 'partial-shipped (our plugin) has no mapping row', reading: { slug: WC_PARTIAL_SHIPPED_STATUS, imsStatus: null, handledBy: null }, expected: 'eligible' },
  { name: 'completed is already at the target', reading: { slug: 'completed', imsStatus: 'COMPLETED', handledBy: 'completion-flow' }, expected: 'already-at-target' },
  { name: 'refunded with NO mapping row (built-in reading is PROCESSING)', reading: { slug: 'refunded', imsStatus: 'PROCESSING', handledBy: 'refund-sync' }, expected: 'ineligible-finalised' },
  { name: 'cancelled', reading: { slug: 'cancelled', imsStatus: 'CANCELLED', handledBy: null }, expected: 'ineligible-finalised' },
  { name: 'custom delivered mapped to DELIVERED', reading: { slug: 'delivered', imsStatus: 'DELIVERED', handledBy: null }, expected: 'ineligible-finalised' },
  { name: 'pending-wdraw WITH a mapping row to PROCESSING', reading: { slug: 'pending-wdraw', imsStatus: 'PROCESSING', handledBy: null }, expected: 'ineligible-not-ready' },
  { name: 'withdrawn WITH a mapping row to PROCESSING', reading: { slug: 'withdrawn', imsStatus: 'PROCESSING', handledBy: null }, expected: 'ineligible-not-ready' },
  { name: 'on-hold', reading: { slug: 'on-hold', imsStatus: 'ON_HOLD', handledBy: null }, expected: 'ineligible-not-ready' },
  { name: 'pending', reading: { slug: 'pending', imsStatus: 'PENDING_PAYMENT', handledBy: null }, expected: 'ineligible-not-ready' },
  { name: 'failed', reading: { slug: 'failed', imsStatus: 'PENDING_PAYMENT', handledBy: null }, expected: 'ineligible-not-ready' },
  // HIGH 1 of the second review: the status-mapping action lets an operator map ANY slug to PROCESSING. The
  // canonical WooCommerce slugs are refused BEFORE the configurable mapping is consulted.
  { name: 'cancelled MAPPED to PROCESSING', reading: { slug: 'cancelled', imsStatus: 'PROCESSING', handledBy: null }, expected: 'ineligible-finalised' },
  { name: 'on-hold MAPPED to PROCESSING', reading: { slug: 'on-hold', imsStatus: 'PROCESSING', handledBy: null }, expected: 'ineligible-not-ready' },
  { name: 'pending MAPPED to PROCESSING', reading: { slug: 'pending', imsStatus: 'PROCESSING', handledBy: null }, expected: 'ineligible-not-ready' },
  { name: 'failed MAPPED to PICKING', reading: { slug: 'failed', imsStatus: 'PICKING', handledBy: null }, expected: 'ineligible-not-ready' },
  { name: 'refunded MAPPED to PACKING', reading: { slug: 'refunded', imsStatus: 'PACKING', handledBy: 'refund-sync' }, expected: 'ineligible-finalised' },
  // o3d-6ldlj sweep: `processing` is WooCommerce's own in-flight status whatever the mapping says.
  { name: 'processing MAPPED to CANCELLED', reading: { slug: 'processing', imsStatus: 'CANCELLED', handledBy: null }, expected: 'eligible' },
  { name: 'processing MAPPED to ON_HOLD', reading: { slug: 'processing', imsStatus: 'ON_HOLD', handledBy: null }, expected: 'eligible' },
  { name: 'processing MAPPED to DELIVERED', reading: { slug: 'processing', imsStatus: 'DELIVERED', handledBy: null }, expected: 'eligible' },
  { name: 'unmapped custom status', reading: { slug: 'foo', imsStatus: null, handledBy: null }, expected: 'ineligible-unknown' },
  { name: 'empty status', reading: { slug: '', imsStatus: null, handledBy: null }, expected: 'ineligible-unknown' },
]

test('o3d-zvec.15 (arm 1): the completion eligibility table', () => {
  let evaluated = 0
  for (const row of ROWS) {
    assert.ok(row.reading.slug !== undefined, `${row.name}: precondition, the reading was supplied`)
    assert.equal(classifyWcCompletionEligibility({ reading: row.reading, withdrawal: WITHDRAWAL }), row.expected, row.name)
    evaluated++
  }
  assert.equal(evaluated, ROWS.length)
  assert.ok(evaluated >= 24, `the table must have been walked in full, evaluated ${evaluated}`)
})

test('o3d-zvec.15 (arm 1): the target is a parameter — a non-default target is judged against it', () => {
  // processing is in flight for a `completed` push, but a push whose target IS the current slug is a no-op.
  assert.equal(
    classifyWcCompletionEligibility({ reading: { slug: 'delivered', imsStatus: 'PROCESSING', handledBy: null }, withdrawal: WITHDRAWAL, target: 'delivered' }),
    'already-at-target',
  )
  assert.equal(
    classifyWcCompletionEligibility({ reading: { slug: 'processing', imsStatus: 'PROCESSING', handledBy: null }, withdrawal: WITHDRAWAL, target: 'delivered' }),
    'eligible',
  )
})

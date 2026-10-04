import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyWcStatusPushEligibility,
  type WcStatusPushEligibility,
  type WcStatusPushTarget,
} from '@/lib/connectors/woocommerce/sync/completion-eligibility'
import type { WcOrderStatusReading } from '@/lib/connectors/woocommerce/sync/status-mapping'
import { WC_PARTIAL_SHIPPED_STATUS } from '@/lib/connectors/woocommerce/sync/partial-shipment'

/**
 * o3d-6ldlj — "may IMS push `cancelled` / `on-hold` onto this WooCommerce order?" decided from the importer's own
 * reading of the status plus the order state machine, not from a list of slugs held here.
 *
 * Each row is the `reading` the importer would produce (slug, imsStatus, handledBy), so the table asserts the
 * rule over a stated input. The adversarial rows are the point of the canonical rule: the status-mapping action
 * lets an operator map ANY slug to ANY IMS status, so a row sending `cancelled` to PROCESSING must not make an
 * on-hold push eligible over a cancelled order (the #719 round-2 lesson, here for the demotion direction).
 */

const WITHDRAWAL = { submitted: 'pending-wdraw', approved: 'withdrawn' }
const CANCEL: WcStatusPushTarget = { wc: 'cancelled', ims: 'CANCELLED' }
const HOLD: WcStatusPushTarget = { wc: 'on-hold', ims: 'ON_HOLD' }

type Reading = Pick<WcOrderStatusReading, 'slug' | 'imsStatus' | 'handledBy'>
type Row = { name: string; reading: Reading; expected: WcStatusPushEligibility }
const r = (slug: string, imsStatus: Reading['imsStatus'], handledBy: Reading['handledBy'] = null): Reading => ({ slug, imsStatus, handledBy })

const CANCEL_ROWS: Row[] = [
  { name: 'processing', reading: r('processing', 'PROCESSING'), expected: 'eligible' },
  { name: 'custom ready-to-ship mapped to PROCESSING', reading: r('ready-to-ship', 'PROCESSING'), expected: 'eligible' },
  { name: 'custom packed mapped to PACKING', reading: r('packed-custom', 'PACKING'), expected: 'eligible' },
  { name: 'custom picking mapped to PICKING', reading: r('picking-custom', 'PICKING'), expected: 'eligible' },
  { name: 'on-hold (an IMS cancel supersedes a storefront hold)', reading: r('on-hold', 'ON_HOLD'), expected: 'eligible' },
  { name: 'pending', reading: r('pending', 'PENDING_PAYMENT'), expected: 'eligible' },
  { name: 'failed', reading: r('failed', 'PENDING_PAYMENT'), expected: 'eligible' },
  { name: 'cancelled is already at the target', reading: r('cancelled', 'CANCELLED'), expected: 'already-at-target' },
  { name: 'a CUSTOM status mapped to CANCELLED is NEVER auto-succeeded: the owner configured it, an operator decides', reading: r('voided', 'CANCELLED'), expected: 'ineligible-needs-operator' },
  { name: 'completed is never overwritten', reading: r('completed', 'COMPLETED', 'completion-flow'), expected: 'ineligible-finalised' },
  { name: 'refunded with NO mapping row (built-in reading is PROCESSING)', reading: r('refunded', 'PROCESSING', 'refund-sync'), expected: 'ineligible-finalised' },
  { name: 'custom delivered mapped to DELIVERED', reading: r('delivered', 'DELIVERED'), expected: 'ineligible-finalised' },
  { name: 'custom dispatched mapped to SHIPPED', reading: r('dispatched', 'SHIPPED'), expected: 'ineligible-finalised' },
  { name: 'partial-shipped (our plugin) has no mapping row', reading: r(WC_PARTIAL_SHIPPED_STATUS, null), expected: 'ineligible-needs-operator' },
  { name: 'partial-shipped even WITH a mapping row to PROCESSING', reading: r(WC_PARTIAL_SHIPPED_STATUS, 'PROCESSING'), expected: 'ineligible-needs-operator' },
  { name: 'pending-wdraw WITH a mapping row to PROCESSING', reading: r('pending-wdraw', 'PROCESSING'), expected: 'ineligible-needs-operator' },
  { name: 'withdrawn WITH a mapping row to PROCESSING', reading: r('withdrawn', 'PROCESSING'), expected: 'ineligible-needs-operator' },
  { name: 'unmapped custom status', reading: r('foo', null), expected: 'ineligible-unknown' },
  { name: 'empty status', reading: r('', null), expected: 'ineligible-unknown' },
  { name: 'custom status mapped elsewhere (PACKING) is cancellable', reading: r('packed-custom2', 'PACKING'), expected: 'eligible' },
  { name: 'custom status mapped to ON_HOLD can be cancelled', reading: r('awaiting-stock', 'ON_HOLD'), expected: 'eligible' },
  // Adversarial mappings: WooCommerce's own slugs ignore the mapping table.
  { name: 'completed MAPPED to PROCESSING', reading: r('completed', 'PROCESSING', 'completion-flow'), expected: 'ineligible-finalised' },
  { name: 'refunded MAPPED to PACKING', reading: r('refunded', 'PACKING', 'refund-sync'), expected: 'ineligible-finalised' },
  { name: 'cancelled MAPPED to PROCESSING', reading: r('cancelled', 'PROCESSING'), expected: 'already-at-target' },
  { name: 'processing MAPPED to CANCELLED is still the in-flight order it is (must be PUT, not auto-succeeded)', reading: r('processing', 'CANCELLED'), expected: 'eligible' },
  { name: 'processing MAPPED to ON_HOLD', reading: r('processing', 'ON_HOLD'), expected: 'eligible' },
  { name: 'processing MAPPED to DELIVERED', reading: r('processing', 'DELIVERED'), expected: 'eligible' },
  { name: 'on-hold MAPPED to DELIVERED still reads as the pre-fulfilment hold it is', reading: r('on-hold', 'DELIVERED'), expected: 'eligible' },
  { name: 'pending MAPPED to SHIPPED still reads as the unpaid order it is', reading: r('pending', 'SHIPPED'), expected: 'eligible' },
  { name: 'failed MAPPED to COMPLETED still reads as the failed payment it is', reading: r('failed', 'COMPLETED'), expected: 'eligible' },
]

const HOLD_ROWS: Row[] = [
  { name: 'processing', reading: r('processing', 'PROCESSING'), expected: 'eligible' },
  { name: 'custom ready-to-ship mapped to PROCESSING', reading: r('ready-to-ship', 'PROCESSING'), expected: 'eligible' },
  { name: 'custom picking mapped to PICKING', reading: r('picking-custom', 'PICKING'), expected: 'eligible' },
  { name: 'pending', reading: r('pending', 'PENDING_PAYMENT'), expected: 'eligible' },
  { name: 'failed', reading: r('failed', 'PENDING_PAYMENT'), expected: 'eligible' },
  { name: 'on-hold is already at the target', reading: r('on-hold', 'ON_HOLD'), expected: 'already-at-target' },
  { name: 'a CUSTOM status mapped to ON_HOLD is NEVER auto-succeeded: an operator decides', reading: r('awaiting-stock', 'ON_HOLD'), expected: 'ineligible-needs-operator' },
  { name: 'cancelled is never held over', reading: r('cancelled', 'CANCELLED'), expected: 'ineligible-finalised' },
  { name: 'a custom status the importer reads as CANCELLED', reading: r('voided', 'CANCELLED'), expected: 'ineligible-finalised' },
  { name: 'completed is never overwritten', reading: r('completed', 'COMPLETED', 'completion-flow'), expected: 'ineligible-finalised' },
  { name: 'refunded with NO mapping row (built-in reading is PROCESSING)', reading: r('refunded', 'PROCESSING', 'refund-sync'), expected: 'ineligible-finalised' },
  { name: 'custom delivered mapped to DELIVERED', reading: r('delivered', 'DELIVERED'), expected: 'ineligible-finalised' },
  { name: 'partial-shipped (our plugin)', reading: r(WC_PARTIAL_SHIPPED_STATUS, null), expected: 'ineligible-needs-operator' },
  { name: 'pending-wdraw WITH a mapping row to PROCESSING', reading: r('pending-wdraw', 'PROCESSING'), expected: 'ineligible-needs-operator' },
  { name: 'withdrawn WITH a mapping row to PROCESSING', reading: r('withdrawn', 'PROCESSING'), expected: 'ineligible-needs-operator' },
  { name: 'unmapped custom status', reading: r('foo', null), expected: 'ineligible-unknown' },
  // Adversarial mappings.
  { name: 'cancelled MAPPED to PROCESSING must NOT be held over', reading: r('cancelled', 'PROCESSING'), expected: 'ineligible-finalised' },
  { name: 'cancelled MAPPED to PICKING must NOT be held over', reading: r('cancelled', 'PICKING'), expected: 'ineligible-finalised' },
  { name: 'completed MAPPED to PROCESSING', reading: r('completed', 'PROCESSING', 'completion-flow'), expected: 'ineligible-finalised' },
  { name: 'refunded MAPPED to PACKING', reading: r('refunded', 'PACKING', 'refund-sync'), expected: 'ineligible-finalised' },
  { name: 'pending MAPPED to DELIVERED still reads as the unpaid order it is', reading: r('pending', 'DELIVERED'), expected: 'eligible' },
  { name: 'on-hold MAPPED to PROCESSING is still at the target', reading: r('on-hold', 'PROCESSING'), expected: 'already-at-target' },
  { name: 'processing MAPPED to ON_HOLD is still the in-flight order it is (must be PUT, not auto-succeeded)', reading: r('processing', 'ON_HOLD'), expected: 'eligible' },
  { name: 'processing MAPPED to CANCELLED', reading: r('processing', 'CANCELLED'), expected: 'eligible' },
  { name: 'processing MAPPED to COMPLETED', reading: r('processing', 'COMPLETED'), expected: 'eligible' },
  { name: 'a CUSTOM status mapped to CANCELLED is left alone as settled', reading: r('voided', 'CANCELLED'), expected: 'ineligible-finalised' },
  { name: 'custom status mapped elsewhere (PACKING) can be held', reading: r('packed-custom2', 'PACKING'), expected: 'eligible' },
  { name: 'custom status mapped to SHIPPED is left alone', reading: r('dispatched', 'SHIPPED'), expected: 'ineligible-finalised' },
]

function walk(label: string, target: WcStatusPushTarget, rows: Row[], minimum: number) {
  let evaluated = 0
  for (const row of rows) {
    assert.ok(row.reading.slug !== undefined, `${label}/${row.name}: precondition, the reading was supplied`)
    assert.equal(classifyWcStatusPushEligibility({ reading: row.reading, withdrawal: WITHDRAWAL, target }), row.expected, `${label}/${row.name}`)
    evaluated++
  }
  assert.equal(evaluated, rows.length)
  assert.ok(evaluated >= minimum, `${label}: the table must have been walked in full, evaluated ${evaluated}`)
  console.log(`${label}: ${evaluated} classifier rows evaluated`)
}

test('o3d-6ldlj (arm 1a): the CANCEL eligibility table', () => {
  walk('cancel', CANCEL, CANCEL_ROWS, 28)
})

test('o3d-6ldlj (arm 1b): the HOLD eligibility table', () => {
  walk('hold', HOLD, HOLD_ROWS, 28)
})

test('o3d-6ldlj (arm 1c): WooCommerce\'s own finalised statuses are never overwritten for ANY target, however they are mapped', () => {
  let evaluated = 0
  for (const target of [CANCEL, HOLD]) {
    for (const mapped of ['PROCESSING', 'PACKING', 'PICKING', 'ON_HOLD', 'PENDING_PAYMENT', 'DRAFT', 'ALLOCATED', 'CANCELLED', null] as const) {
      for (const [slug, handledBy] of [['completed', 'completion-flow'], ['refunded', 'refund-sync']] as const) {
        assert.equal(
          classifyWcStatusPushEligibility({ reading: r(slug, mapped, handledBy), withdrawal: WITHDRAWAL, target }),
          'ineligible-finalised',
          `${slug} mapped to ${mapped} for ${target.wc}`,
        )
        evaluated++
      }
    }
  }
  assert.equal(evaluated, 2 * 9 * 2)
  console.log(`finalised-for-every-mapping: ${evaluated} cases evaluated`)
})

test('o3d-6ldlj (arm 1d): EVERY canonical slug x EVERY mapping x BOTH targets keeps its BUILT-IN meaning; the mapping is never consulted', () => {
  const MAPPINGS = ['PROCESSING', 'PACKING', 'PICKING', 'ON_HOLD', 'PENDING_PAYMENT', 'DRAFT', 'ALLOCATED', 'CANCELLED', 'SHIPPED', 'COMPLETED', 'DELIVERED', null] as const
  type Expect = Record<string, WcStatusPushEligibility>
  // Written out from WooCommerce's own meaning of each slug, NOT derived from the classifier.
  const EXPECTED: Record<'cancel' | 'hold', Expect> = {
    cancel: { processing: 'eligible', completed: 'ineligible-finalised', refunded: 'ineligible-finalised', cancelled: 'already-at-target', 'on-hold': 'eligible', pending: 'eligible', failed: 'eligible' },
    hold: { processing: 'eligible', completed: 'ineligible-finalised', refunded: 'ineligible-finalised', cancelled: 'ineligible-finalised', 'on-hold': 'already-at-target', pending: 'eligible', failed: 'eligible' },
  }
  const HANDLED = { completed: 'completion-flow', refunded: 'refund-sync' } as const
  let evaluated = 0
  for (const [name, target] of [['cancel', CANCEL], ['hold', HOLD]] as const) {
    for (const [slug, expected] of Object.entries(EXPECTED[name])) {
      for (const mapped of MAPPINGS) {
        const handledBy = (HANDLED as Record<string, Reading['handledBy']>)[slug] ?? null
        assert.equal(
          classifyWcStatusPushEligibility({ reading: r(slug, mapped, handledBy), withdrawal: WITHDRAWAL, target }),
          expected,
          `${name}/${slug} mapped to ${mapped}`,
        )
        evaluated++
      }
    }
  }
  assert.equal(evaluated, 2 * 7 * MAPPINGS.length)
  console.log(`canonical-slug x mapping x target: ${evaluated} cases evaluated`)
})

test('o3d-6ldlj (arm 1e): a NON-canonical custom slug mapped to the target state needs an operator for a cancel/hold, whatever the target; never already-at-target', () => {
  let evaluated = 0
  for (const [target, mapped, expected] of [
    [CANCEL, 'CANCELLED', 'ineligible-needs-operator'],
    [HOLD, 'ON_HOLD', 'ineligible-needs-operator'],
    [CANCEL, 'ON_HOLD', 'eligible'],
    [HOLD, 'CANCELLED', 'ineligible-finalised'],
  ] as const) {
    for (const slug of ['voided', 'awaiting-stock', 'x-custom']) {
      const got = classifyWcStatusPushEligibility({ reading: r(slug, mapped), withdrawal: WITHDRAWAL, target })
      assert.notEqual(got, 'already-at-target', `${slug}->${mapped} for ${target.wc} must never be auto-succeeded`)
      assert.equal(got, expected, `${slug}->${mapped} for ${target.wc}`)
      evaluated++
    }
  }
  assert.equal(evaluated, 12)
})

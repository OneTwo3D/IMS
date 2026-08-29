import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'
import {
  compactableShoppingWebhookEventWhere,
  preservedWcOrderEvidenceWhere,
} from '@/lib/connectors/shopping-webhook-retention'

// o3d-ahk: purgeExpiredData COMPACTS succeeded shopping-webhook-inbox rows past the cutoff — it clears
// the bulky payloadJson but KEEPS the row (the connector/resource/payloadHash idempotency tombstone).
// DEAD_LETTER (unresolved) and PENDING/FAILED (undelivered) are left fully intact.

type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> }

type SettingRow = { key: string; value: string }
type CreateManyArgs = { data: SettingRow[]; skipDuplicates?: boolean }

const capture: {
  settingRows: SettingRow[]
  /** Every settings INSERT the purge attempted — the evidence cutoff is written insert-only. */
  settingWrites: CreateManyArgs[]
  last?: UpdateArgs
  count: number
} = {
  settingRows: [],
  settingWrites: [],
  last: undefined,
  count: 0,
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      // THE PURGE MUST NOT WRITE SETTINGS AT ALL (o3d-j7y4 r19). Round 18 had it record an evidence
      // cutoff here, insert-only; r19 withdrew the cutoff, and a harness that still tolerated the
      // write would let a half-removed version of it back in unnoticed.
      setting: {
        findMany: async () => capture.settingRows,
        findUnique: async ({ where }: { where: { key: string } }) =>
          capture.settingRows.find((r) => r.key === where.key) ?? null,
        createMany: async (args: CreateManyArgs) => {
          capture.settingWrites.push(args)
          throw new Error('the retention pass must not write any setting')
        },
        update: async () => { throw new Error('the retention pass must not write any setting') },
        updateMany: async () => { throw new Error('the retention pass must not write any setting') },
        upsert: async () => { throw new Error('the retention pass must not write any setting') },
      },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: noopDelegate(),
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      // q66in.7.4: the WMS retention passes added to purgeExpiredData run unconditionally on
      // their own defaults, so this harness has to answer for their delegates too. Inert here —
      // their behaviour is asserted in tests/data-retention-wms-events.test.ts.
      wmsInboundReceiptEvent: noopDelegate(),
      wmsWebhookEvent: noopDelegate(),
      wmsSyncJob: noopDelegate(),
      externalWmsBinding: noopDelegate(),
      shoppingWebhookEvent: {
        deleteMany: async () => {
          throw new Error('inbox rows must be COMPACTED, never deleted (dedup + audit)')
        },
        updateMany: async (args: UpdateArgs) => {
          capture.last = args
          return { count: capture.count }
        },
      },
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

test('compacts ONLY PROCESSED rows past the cutoff, clearing payloadJson but keeping the row (o3d-ahk)', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 7

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 7)
  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  // Only succeeded rows — never DEAD_LETTER (audit) or PENDING/FAILED (undelivered).
  assert.equal(args.where.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.notEqual(args.where.status, WC_WEBHOOK_EVENT_STATUS.deadLetter)
  assert.ok((args.where.updatedAt as { lt?: Date })?.lt instanceof Date, 'bounded by an updatedAt cutoff')
  // Already-compacted rows are permanently excluded so each run only touches the newly-eligible set.
  assert.deepEqual((args.where.NOT as { payloadJson?: { equals?: unknown } })?.payloadJson?.equals, {})
  // Clears the bulky payload, keeps the row (dedup key + status untouched).
  assert.deepEqual(args.data.payloadJson, {})
  assert.equal(args.data.lastError, null)
  assert.equal(args.data.status, undefined, 'status is preserved, not changed')
})

test('a 0-month webhook retention setting disables compaction', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '0' }]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 99

  const result = await purgeExpiredData()

  assert.equal(result.webhookEventsCompacted, 0)
  assert.equal(capture.last, undefined, 'updateMany must not be called when retention is 0')
})

/**
 * THE HOLD, AND WHERE ITS BOUNDARY ACTUALLY IS (o3d-j7y4, Codex r17 HIGH; r18 bounded it, r19 removed
 * the bound again).
 *
 * The archived WooCommerce ORDER deliveries are the only positive evidence that an order was created on
 * a currency the store never stated, and this compaction was emptying them three months in while the
 * work that needs them is still deferred. So EVERY WooCommerce order delivery is held, at any age.
 *
 * Round 18 bounded that to deliveries received before a recorded per-installation instant. r19 withdrew
 * it: the bound saved nothing for a whole retention window, and it could be made to say the wrong thing
 * — by a rollback, on a fresh install, or by anyone able to write the settings row — in the one
 * direction that destroys evidence irreversibly. The reasoning is in
 * lib/connectors/shopping-webhook-retention.ts.
 *
 * WHAT THESE PIN. The boundary is now a two-column one, so the tests state it as such: which columns
 * name the held set, that nothing else names it (no time bound, no status bound), that the purge issues
 * the SHARED predicate rather than a copy, and that the removal is complete — the pass writes no
 * setting at all.
 */

test('the compaction holds back EVERY WooCommerce ORDER delivery while o3d-j7y4 is open', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 3

  await purgeExpiredData()

  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  const cutoff = (args.where.updatedAt as { lt: Date }).lt
  // The purge must issue exactly the shared predicate — not a copy of it that can drift.
  assert.deepEqual(args.where, compactableShoppingWebhookEventWhere(cutoff))
  // And that predicate must currently carry the hold.
  assert.deepEqual(args.where.AND, [{ NOT: { connector: 'woocommerce', resource: 'orders' } }])
})

test('the hold has NO time bound — an order delivery is held however old it is (o3d-j7y4 r19)', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 1

  await purgeExpiredData()

  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  const exemption = (args.where.AND as Array<{ NOT: Record<string, unknown> }>)[0].NOT
  // THE BOUNDARY, STATED. connector and resource, and NOTHING else. A `receivedAt` conjunct here —
  // r18's cutoff, or any successor to it — would release every order delivery on the far side of some
  // instant, which is exactly what r19 decided against; a `status` conjunct would release the
  // dead-letter and pending rows the hold is also meant to cover.
  assert.deepEqual(exemption, { connector: 'woocommerce', resource: 'orders' })
  assert.equal(Object.keys(exemption).length, 2, 'connector + resource, nothing else')
  assert.equal('receivedAt' in exemption, false, 'no time bound')
  assert.equal('status' in exemption, false, 'no status bound')
  // The AGE bound that does remain applies to the compaction, never to the exemption: a row's age
  // decides whether it is eligible, and the exemption then removes it whatever that decided.
  assert.ok((args.where.updatedAt as { lt?: Date })?.lt instanceof Date)
})

test('the retention pass records NOTHING in settings (o3d-j7y4 r19 — the cutoff removal is complete)', async () => {
  // Round 18's pass stamped `legacy_wc_order_evidence_cutoff_at` before the compaction, unconditionally
  // and outside the `webhookMonths > 0` test. Both of those runs are exercised here; the harness's
  // settings delegate throws on any write, so a surviving stamp fails loudly rather than being
  // tolerated as an implementation detail.
  const purgeExpiredData = await loadPurge()

  for (const months of ['3', '0']) {
    capture.settingRows = [{ key: 'retention_webhook_events_months', value: months }]
    capture.settingWrites = []
    capture.last = undefined
    capture.count = 2

    await purgeExpiredData()

    assert.deepEqual(capture.settingWrites, [], `retention=${months}: no settings write was even attempted`)
    assert.deepEqual(
      capture.settingRows.map((r) => r.key),
      ['retention_webhook_events_months'],
      `retention=${months}: the settings table is left exactly as it was found`,
    )
  }
})

test('the held-back set is named on NOT NULL columns, so the negation cannot go three-valued (o3d-j7y4)', () => {
  // `resource` and `connector` are NOT NULL and IMS writes both itself. `topic` is a nullable header
  // value the store supplies: Postgres evaluates `NOT (... AND topic IN (...))` to NULL for a row whose
  // topic is NULL, which silently drops that row from the compaction set as well. Naming the set on
  // `topic` would therefore hold back rows nobody decided to hold back.
  const held = preservedWcOrderEvidenceWhere()
  assert.deepEqual(held, { connector: 'woocommerce', resource: 'orders' })
  assert.equal('topic' in held, false)
})

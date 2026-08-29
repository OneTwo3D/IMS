import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'
import {
  LEGACY_IMPORTER_DRAIN_GRACE_MS,
  LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING,
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

/** The stored value of a setting after the run, or undefined. */
function settingValue(key: string): string | undefined {
  return capture.settingRows.find((r) => r.key === key)?.value
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
      setting: {
        findMany: async () => capture.settingRows,
        findUnique: async ({ where }: { where: { key: string } }) =>
          capture.settingRows.find((r) => r.key === where.key) ?? null,
        // Insert-only, exactly like Postgres under `skipDuplicates`: an existing key is left alone.
        createMany: async (args: CreateManyArgs) => {
          capture.settingWrites.push(args)
          let created = 0
          for (const row of args.data) {
            if (capture.settingRows.some((r) => r.key === row.key)) {
              if (!args.skipDuplicates) throw new Error(`duplicate key ${row.key}`)
              continue
            }
            capture.settingRows.push({ ...row })
            created += 1
          }
          return { count: created }
        },
        // o3d-j7y4: a recorded evidence cutoff is a historical fact about this installation. Any
        // write that could MOVE it is a bug, so the harness refuses to model one.
        update: async () => {
          throw new Error('a recorded setting must never be moved by the retention pass')
        },
        updateMany: async () => {
          throw new Error('a recorded setting must never be moved by the retention pass')
        },
        upsert: async () => {
          throw new Error('a recorded setting must never be moved by the retention pass')
        },
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
  // o3d-j7y4 r18: the evidence cutoff is recorded ANYWAY. It marks when this installation stopped
  // running the old importer, which has nothing to do with whether the operator has this compaction
  // switched on — and an installation that turns the compaction on a year from now must not then
  // record a year-late cutoff and hold its whole history under the exemption.
  assert.ok(
    settingValue(LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING),
    'the evidence cutoff must be recorded even when webhook compaction is disabled',
  )
})

/**
 * o3d-j7y4 (Codex r17 HIGH, bounded in r18): the archived WooCommerce ORDER deliveries are the only
 * positive evidence that an order was created on a currency the store never stated, and this compaction
 * was emptying them three months in while the work that needs them is still deferred. The ones that
 * could be that evidence — the ones received before this installation stopped running the old importer
 * — are held back until it closes. The ones received after it are not, because by then no order this
 * installation imported could be affected.
 *
 * What these pin is that the purge asks the SHARED predicate — the one
 * tests/db/shopping-webhook-retention-evidence.test.ts then proves against a real Postgres — that the
 * exemption is BOUNDED by the recorded cutoff, and that the held-back set is named on columns that
 * cannot make the negation ambiguous.
 */
const RECORDED_CUTOFF = '2026-08-30T06:48:00.000Z'

test('the compaction holds back PRE-CUTOFF WooCommerce ORDER deliveries while o3d-j7y4 is open', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [
    { key: 'retention_webhook_events_months', value: '3' },
    { key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING, value: RECORDED_CUTOFF },
  ]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 3

  await purgeExpiredData()

  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  const cutoff = (args.where.updatedAt as { lt: Date }).lt
  // The purge must issue exactly the shared predicate — not a copy of it that can drift.
  assert.deepEqual(args.where, compactableShoppingWebhookEventWhere(cutoff, new Date(RECORDED_CUTOFF)))
  // And that predicate must currently carry the hold, bounded by THIS installation's cutoff.
  assert.deepEqual(args.where.AND, [
    {
      NOT: {
        connector: 'woocommerce',
        resource: 'orders',
        receivedAt: { lt: new Date(RECORDED_CUTOFF) },
      },
    },
  ])
})

test('an ORDER delivery received AFTER the cutoff is outside the hold, so it compacts normally (o3d-j7y4)', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [
    { key: 'retention_webhook_events_months', value: '3' },
    { key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING, value: RECORDED_CUTOFF },
  ]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 1

  await purgeExpiredData()

  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  const exemption = (args.where.AND as Array<{ NOT: Record<string, unknown> }>)[0].NOT
  // The exemption must NAME an upper bound on receipt. Without this conjunct the hold covers every
  // order delivery this installation will ever receive, which is the finding this round is about.
  const receivedAt = exemption.receivedAt as { lt?: Date } | undefined
  assert.ok(receivedAt?.lt instanceof Date, 'the hold must be bounded by the delivery receipt instant')
  assert.deepEqual(receivedAt.lt, new Date(RECORDED_CUTOFF))
  // A delivery received AFTER that instant does not satisfy the exemption, so the negation does not
  // exclude it: it is compacted on the operator's schedule like a product delivery.
  // (What the predicate then does to real rows is proven against Postgres in
  //  tests/db/shopping-webhook-retention-evidence.test.ts.)
  assert.equal(Object.keys(exemption).length, 3, 'connector + resource + receivedAt, nothing else')
})

test('a run that finds NO recorded cutoff records one, insert-only, and holds everything meanwhile (o3d-j7y4)', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [{ key: 'retention_webhook_events_months', value: '3' }]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 2
  const before = Date.now()

  await purgeExpiredData()

  // ONE insert, and it must be an insert: moving a recorded cutoff would drag the boundary forward
  // every night. `skipDuplicates` is what makes two concurrent passes produce one cutoff.
  assert.equal(capture.settingWrites.length, 1, 'exactly one settings write')
  assert.equal(capture.settingWrites[0].skipDuplicates, true, 'insert-only')
  assert.deepEqual(
    capture.settingWrites[0].data.map((r) => r.key),
    [LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING],
  )

  // What was recorded: the moment the guarded build was observed running, plus the drain margin.
  const recorded = settingValue(LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING)
  assert.ok(recorded, 'a cutoff must be recorded')
  const recordedAt = new Date(recorded).getTime()
  assert.ok(Number.isFinite(recordedAt), 'the recorded cutoff must be a readable instant')
  assert.ok(recordedAt >= before + LEGACY_IMPORTER_DRAIN_GRACE_MS, 'observation + the drain margin')
  assert.ok(recordedAt <= Date.now() + LEGACY_IMPORTER_DRAIN_GRACE_MS)

  // AND, in the run that recorded it, the cutoff is in the FUTURE — so every order delivery this
  // installation already holds is on the held side of it. An installation with no cutoff yet retains
  // all of them; it never destroys evidence it cannot date.
  assert.ok(recordedAt > Date.now(), 'the freshly recorded cutoff is ahead of every existing delivery')
  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  assert.deepEqual(args.where, compactableShoppingWebhookEventWhere(
    (args.where.updatedAt as { lt: Date }).lt,
    new Date(recorded),
  ))
})

test('a recorded cutoff is never moved by a later run (o3d-j7y4)', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [
    { key: 'retention_webhook_events_months', value: '3' },
    { key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING, value: RECORDED_CUTOFF },
  ]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 4

  await purgeExpiredData()

  // No write at all — not an insert that the database would discard, and (the harness throws on
  // update/updateMany/upsert) certainly not a restamp.
  assert.deepEqual(capture.settingWrites, [])
  assert.equal(settingValue(LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING), RECORDED_CUTOFF)
})

test('an UNREADABLE recorded cutoff holds everything and is never overwritten (o3d-j7y4)', async () => {
  const purgeExpiredData = await loadPurge()
  capture.settingRows = [
    { key: 'retention_webhook_events_months', value: '3' },
    { key: LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING, value: 'not-an-instant' },
  ]
  capture.last = undefined
  capture.settingWrites = []
  capture.count = 5

  await purgeExpiredData()

  if (!capture.last) throw new Error('updateMany was not called')
  const args: UpdateArgs = capture.last
  // A cutoff nobody can read is not a licence to destroy: the hold falls back to every order
  // delivery, at any age, and the stored value is left exactly as it was found.
  assert.deepEqual(args.where.AND, [{ NOT: { connector: 'woocommerce', resource: 'orders' } }])
  assert.deepEqual(capture.settingWrites, [])
  assert.equal(settingValue(LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING), 'not-an-instant')
})

test('the held-back set is named on NOT NULL columns, so the negation cannot go three-valued (o3d-j7y4)', () => {
  // `resource` and `connector` are NOT NULL and IMS writes both itself, and `receivedAt` is NOT NULL
  // with a `now()` default. `topic` is a nullable header value the store supplies: Postgres evaluates
  // `NOT (... AND topic IN (...))` to NULL for a row whose topic is NULL, which silently drops that row
  // from the compaction set as well. Naming the set on `topic` would therefore hold back rows nobody
  // decided to hold back.
  const bounded = preservedWcOrderEvidenceWhere(new Date(RECORDED_CUTOFF))
  assert.deepEqual(bounded, {
    connector: 'woocommerce',
    resource: 'orders',
    receivedAt: { lt: new Date(RECORDED_CUTOFF) },
  })
  assert.equal('topic' in bounded, false)
  // With no cutoff recorded the same set is unbounded in time, and only in time.
  assert.deepEqual(preservedWcOrderEvidenceWhere(null), { connector: 'woocommerce', resource: 'orders' })
})

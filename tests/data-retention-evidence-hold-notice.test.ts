import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'

// ---------------------------------------------------------------------------
// o3d-j7y4, Codex r19 MEDIUM — THE NUMBER THE OPERATOR NOTICE SHOWS WAS NOT THE NUMBER IT CLAIMED.
//
// The retention screen says the WooCommerce order hold is overriding the Webhook Events window and
// states how many deliveries "are being retained by it today". Round 18 computed that as the whole
// HELD SET carrying a payload: every WooCommerce order delivery, at any age, in any status. Most of
// those are not retained by the override at all —
//
//   • a row younger than the configured window would still be here without it;
//   • PENDING, FAILED and DEAD_LETTER rows are never compacted at any age;
//   • an already-compacted row is retaining nothing.
//
// …so the figure an operator would read as compliance impact could be several times the truth.
//
// The corrected figure is the INTERSECTION: held AND otherwise compactable. Take the hold away and
// exactly these rows would be `{}` after tonight's run.
//
// THE DOUBLE. `db.shoppingWebhookEvent.count` here EVALUATES the predicate against in-memory rows
// rather than recording it. A harness that only captured the `where` could not tell a correct count
// from a wrong one — which is the entire finding — so it has to actually select.
// ---------------------------------------------------------------------------

type Row = {
  id: string
  connector: string
  resource: string
  status: string
  updatedAt: Date
  payloadJson: Record<string, unknown>
}

type Where = Record<string, unknown>

const store = { rows: [] as Row[], settings: [] as Array<{ key: string; value: string }>, counts: [] as Where[] }

/** Enough of Prisma's `where` grammar for the shapes this predicate uses. */
function matches(row: Row, where: Where): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'NOT') {
      if (matches(row, condition as Where)) return false
      continue
    }
    if (field === 'AND') {
      for (const clause of condition as Where[]) if (!matches(row, clause)) return false
      continue
    }
    const value = (row as unknown as Record<string, unknown>)[field]
    if (condition && typeof condition === 'object') {
      const c = condition as { lt?: Date; equals?: unknown }
      if (c.lt !== undefined) {
        if (!((value as Date) < c.lt)) return false
        continue
      }
      if ('equals' in c) {
        if (JSON.stringify(value) !== JSON.stringify(c.equals)) return false
        continue
      }
      throw new Error(`unmodelled condition on ${field}: ${JSON.stringify(condition)}`)
    }
    if (value !== condition) return false
  }
  return true
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => store.settings },
      shoppingWebhookEvent: {
        count: async ({ where }: { where: Where }) => {
          store.counts.push(where)
          return store.rows.filter((row) => matches(row, where)).length
        },
      },
    },
  },
})

async function describe() {
  const mod = await import('@/lib/connectors/shopping-webhook-evidence-hold')
  return mod.describeLegacyWcOrderEvidenceHold()
}

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
/** Comfortably past a 3-month window, and comfortably inside it. */
const OLD = new Date(NOW - 200 * DAY)
const YOUNG = new Date(NOW - 2 * DAY)

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    connector: 'woocommerce',
    resource: 'orders',
    status: WC_WEBHOOK_EVENT_STATUS.processed,
    updatedAt: OLD,
    payloadJson: { currency: 'GBP' },
    ...over,
  }
}

/**
 * ONE population, containing every kind of row the finding named. The counts are asserted against it
 * as a whole, so a predicate that drops or admits a category is caught by the total rather than by a
 * test written for that category alone.
 */
function seed() {
  store.rows = [
    // Retained BY the override: held, processed, past the window, still carrying a payload.
    row('overdue-1'),
    row('overdue-2'),
    // Held, but NOT retained by the override — each for a different reason.
    row('young', { updatedAt: YOUNG }),
    row('pending', { status: WC_WEBHOOK_EVENT_STATUS.pending }),
    row('failed', { status: WC_WEBHOOK_EVENT_STATUS.failed }),
    row('dead', { status: WC_WEBHOOK_EVENT_STATUS.deadLetter }),
    row('already-compacted', { payloadJson: {} }),
    // Not held at all: the compaction's ordinary population.
    row('wc-product', { resource: 'products' }),
    row('shopify-order', { connector: 'shopify' }),
  ]
  store.settings = [{ key: 'retention_webhook_events_months', value: '3' }]
  store.counts = []
}

test.beforeEach(seed)

test('the override figure counts ONLY the payloads the hold is actually keeping alive', async () => {
  const hold = await describe()
  if (!hold) throw new Error('the hold must be in force for this suite to assert anything')

  // overdue-1 and overdue-2, and nothing else. Not `young` (inside the window), not the three
  // non-PROCESSED rows (never compacted at any age), not `already-compacted` (retaining nothing),
  // and not the two rows outside the held set.
  assert.equal(hold.retainedByOverride, 2)
  assert.equal(hold.retentionMonths, 3)
  assert.equal(hold.issue, 'o3d-j7y4')
})

test('the total evidence population is reported separately, and it is a DIFFERENT number', async () => {
  const hold = await describe()
  if (!hold) throw new Error('the hold must be in force')

  // Every held row still carrying a payload: the two overdue ones plus young/pending/failed/dead.
  // `already-compacted` has no payload; the product and Shopify rows are not held.
  assert.equal(hold.evidenceRowsWithPayload, 6)
  assert.notEqual(
    hold.evidenceRowsWithPayload,
    hold.retainedByOverride,
    'the two must not collapse — showing one and labelling it the other IS the finding',
  )
})

test('with the window set to 0 the override is retaining nothing, and says so', async () => {
  // The compaction is switched off entirely, so no row is being spared by the hold — every one of
  // them would still be here without it. A count that ignored the setting would report the same
  // figure as an installation on a 3-month window and overstate the exemption completely.
  store.settings = [{ key: 'retention_webhook_events_months', value: '0' }]

  const hold = await describe()
  if (!hold) throw new Error('the hold must be in force')

  assert.equal(hold.retentionMonths, 0)
  assert.equal(hold.retainedByOverride, 0)
  assert.equal(hold.evidenceRowsWithPayload, 6, 'the evidence population is unaffected by the window')
})

test('the override figure follows the operator\'s window rather than a hardcoded one', async () => {
  // `young` is 2 days old. Widen the window past it and it is still not overdue; the figure must not
  // move. Then set a window of 1 month, under which `young` is still inside and `overdue-*` are not.
  store.settings = [{ key: 'retention_webhook_events_months', value: '12' }]
  const wide = await describe()
  if (!wide) throw new Error('the hold must be in force')
  assert.equal(wide.retainedByOverride, 0, 'a 12-month window has not yet expired the 200-day rows')

  seed()
  store.settings = [{ key: 'retention_webhook_events_months', value: '1' }]
  const narrow = await describe()
  if (!narrow) throw new Error('the hold must be in force')
  assert.equal(narrow.retainedByOverride, 2, 'a 1-month window expires them, and the hold keeps them')
})

test('the override figure asks the COMPACTION for its predicate rather than restating it', async () => {
  await describe()

  // Two counts: the evidence population, then the intersection. The second must carry the
  // compaction's own conjuncts — status, the age bound, the already-compacted exclusion — because a
  // conjunct added to the compaction and not to this read is how the number went wrong the first time.
  assert.equal(store.counts.length, 2, 'exactly two reads')
  const intersection = store.counts[1]
  assert.equal(intersection.connector, 'woocommerce')
  assert.equal(intersection.resource, 'orders')
  assert.equal(intersection.status, WC_WEBHOOK_EVENT_STATUS.processed)
  assert.ok((intersection.updatedAt as { lt?: Date })?.lt instanceof Date, 'bounded by the window')
  assert.deepEqual((intersection.NOT as { payloadJson?: { equals?: unknown } })?.payloadJson?.equals, {})
  // And it must NOT carry the exemption itself — that is what it is measuring, not a filter on it.
  assert.equal(intersection.AND, undefined, 'the hold is removed from the predicate being measured')
})

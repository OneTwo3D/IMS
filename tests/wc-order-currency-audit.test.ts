import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-batch-ret r14 (Codex HIGH): WHAT CAN AND CANNOT BE SAID ABOUT AN ORDER CREATED UNDER THE
 * OLD `wcOrder.currency || 'GBP'` FALLBACK.
 *
 * The baseline these tests exist to hold is a NEGATIVE one, and it is the easiest thing in the
 * change to quietly lose: an invented GBP and a genuine GBP are the same value in the same column,
 * and `SalesOrder.currency` defaults to `"GBP"` besides, so no query over the order table can
 * separate them. The audit therefore reports OUTSIDE evidence, and where there is none it must say
 * `no_evidence` — not `agrees`, which would report an unexamined order as cleared.
 *
 * `judgeWcOrderCurrency` is pure, so the RULE ORDERING is tested directly rather than through a
 * store: the strongest available evidence decides, and a weaker source never overturns it.
 */

type Row = Record<string, unknown>

const store = {
  links: [] as Row[],
  events: [] as Row[],
  /** Every write attempted through the db double. An audit that reads must leave this empty. */
  writes: [] as string[],
}

const writeThrows = (name: string) => async () => {
  store.writes.push(name)
  throw new Error(`the audit is READ-ONLY, but it called ${name}`)
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingOrderLink: {
        findMany: async ({ take }: { take?: number }) => (take ? store.links.slice(0, take) : store.links),
        create: writeThrows('shoppingOrderLink.create'),
        update: writeThrows('shoppingOrderLink.update'),
        updateMany: writeThrows('shoppingOrderLink.updateMany'),
      },
      shoppingWebhookEvent: {
        findMany: async ({ take, cursor, skip }: { take: number; cursor?: { id: string }; skip?: number }) => {
          const start = cursor
            ? store.events.findIndex((row) => row.id === cursor.id) + (skip ?? 0)
            : 0
          return store.events.slice(start, start + take)
        },
        create: writeThrows('shoppingWebhookEvent.create'),
        update: writeThrows('shoppingWebhookEvent.update'),
      },
      salesOrder: {
        update: writeThrows('salesOrder.update'),
        updateMany: writeThrows('salesOrder.updateMany'),
      },
      setting: { upsert: writeThrows('setting.upsert'), update: writeThrows('setting.update') },
      shoppingSyncLog: { create: writeThrows('shoppingSyncLog.create') },
      $transaction: writeThrows('$transaction'),
    },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: writeThrows('logActivity') },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: null, error: 'no live read in this test', totalPages: 0, totalItems: 0 }),
    wcPut: writeThrows('wcPut'),
    wcPost: writeThrows('wcPost'),
  },
})

function reset() {
  store.links.length = 0
  store.events.length = 0
  store.writes.length = 0
}

function orderLink(externalOrderId: string, currency: string, money: Row = {}) {
  return {
    externalOrderId,
    order: {
      id: `so-${externalOrderId}`,
      orderNumber: `WC-${externalOrderId}`,
      currency,
      invoicedAt: null,
      accountingInvoiceId: null,
      paidAt: null,
      _count: { payments: 0, refunds: 0 },
      ...money,
    },
  }
}

function event(id: string, orderId: number, payload: Row) {
  return { id, payloadJson: { id: orderId, ...payload } }
}

// --- the rule ordering ------------------------------------------------------------------------

test('a stored code current code COULD NOT HAVE WRITTEN outranks a live read that agrees', async () => {
  // `gbp` is what the old path persisted verbatim; r13 persists a trimmed, upper-cased AAA. A live
  // read that normalises to the same currency does not make the stored value acceptable — the FX
  // lookup and the accounting payload are what read this column, and they read it as written.
  const { judgeWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  assert.equal(
    judgeWcOrderCurrency({ storedCurrency: 'gbp', liveCurrency: 'GBP' }),
    'non_canonical_stored_code',
  )
  assert.equal(judgeWcOrderCurrency({ storedCurrency: ' EUR', liveCurrency: 'EUR' }), 'non_canonical_stored_code')
  assert.equal(judgeWcOrderCurrency({ storedCurrency: '', liveCurrency: 'GBP' }), 'non_canonical_stored_code')
})

test('an archived delivery that stated NO currency identifies the fallback, even when the store agrees today', async () => {
  // This is the only evidence that positively names an invented currency. The order was created as
  // GBP because WooCommerce said nothing; the store saying GBP now does not change what happened,
  // and the FX basis and ledger routing were decided then.
  const { judgeWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  assert.equal(
    judgeWcOrderCurrency({
      storedCurrency: 'GBP',
      archived: { payloads: 3, noCurrency: 3, codes: [] },
      liveCurrency: 'GBP',
    }),
    'fallback_invented',
  )
})

test('an archived delivery that stated a DIFFERENT currency is reported against the archive, not the store', async () => {
  const { judgeWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  assert.equal(
    judgeWcOrderCurrency({
      storedCurrency: 'GBP',
      archived: { payloads: 2, noCurrency: 0, codes: ['EUR'] },
      liveCurrency: 'EUR',
    }),
    'disagrees_with_archived_payload',
  )
})

test('with NO archived delivery and NO live read the verdict is `no_evidence`, never `agrees`', async () => {
  // THE LOAD-BEARING NEGATIVE. An invented GBP and a real GBP are identical in the order row, so an
  // order nothing was read for has not been cleared — reporting it as `agrees` would turn "we
  // cannot tell" into "we checked", which is the whole exposure question answered wrongly.
  const { judgeWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  assert.equal(judgeWcOrderCurrency({ storedCurrency: 'GBP' }), 'no_evidence')
  assert.equal(judgeWcOrderCurrency({ storedCurrency: 'GBP', archived: null }), 'no_evidence')
  assert.equal(
    judgeWcOrderCurrency({ storedCurrency: 'GBP', archived: { payloads: 0, noCurrency: 0, codes: [] } }),
    'no_evidence',
  )
})

test('the live read discriminates — agreeing, disagreeing, silent and unreadable are four answers', async () => {
  // Asserted as a set: "a mismatch is flagged" passes with the comparison hard-wired to flag
  // everything, and "a match is clean" passes with it hard-wired to clear everything.
  const { judgeWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  assert.equal(judgeWcOrderCurrency({ storedCurrency: 'GBP', liveCurrency: 'GBP' }), 'agrees')
  assert.equal(judgeWcOrderCurrency({ storedCurrency: 'GBP', liveCurrency: 'EUR' }), 'disagrees_with_live')
  // Read, and the store STILL states nothing usable — the fallback's own precondition, today.
  assert.equal(judgeWcOrderCurrency({ storedCurrency: 'GBP', liveCurrency: null }), 'live_states_nothing')
  // Not read at all. Judging it either way would be inventing the evidence.
  assert.equal(
    judgeWcOrderCurrency({ storedCurrency: 'GBP', liveCurrency: null, liveReadFailed: true }),
    'live_unreadable',
  )
})

// --- the archive pass -------------------------------------------------------------------------

test('the archived deliveries are reduced per WooCommerce order id, counting the silent ones', async () => {
  reset()
  store.events.push(
    event('e1', 501, { currency: 'EUR' }),
    event('e2', 501, {}),
    event('e3', 502, { currency: ' usd ' }),
    event('e4', 503, { currency: '' }),
    event('e5', 503, { currency: 'not-a-code' }),
  )
  const { readArchivedWcOrderCurrencies } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const { byExternalOrderId, scanned } = await readArchivedWcOrderCurrencies(2)

  assert.equal(scanned, 5, 'every archived order delivery is read, in pages')
  assert.deepEqual(byExternalOrderId.get('501'), { payloads: 2, noCurrency: 1, codes: new Set(['EUR']) })
  // Normalised the same way the importer normalises, so a padded lower-case payload is not counted
  // as "stated nothing" — it stated USD badly.
  assert.deepEqual(byExternalOrderId.get('502'), { payloads: 1, noCurrency: 0, codes: new Set(['USD']) })
  assert.deepEqual(byExternalOrderId.get('503'), { payloads: 2, noCurrency: 2, codes: new Set() })
})

// --- the audit as a whole ---------------------------------------------------------------------

test('the audit WRITES NOTHING — every write delegate throws, and the run completes', async () => {
  // An audit over money-bearing rows earns its keep by being safe to run unattended. The doubles
  // above make every create/update/upsert/transaction and every activity-log write throw, so a run
  // that touched one could not finish.
  reset()
  store.links.push(orderLink('601', 'gbp'), orderLink('602', 'GBP'))
  store.events.push(event('e1', 602, { currency: 'EUR' }))
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()

  assert.deepEqual(store.writes, [], 'the audit attempted a write')
  assert.equal(report.scanned, 2)
  assert.equal(report.liveRead, false)
  assert.deepEqual(
    report.findings.map((finding) => [finding.externalOrderId, finding.verdict]),
    [['601', 'non_canonical_stored_code'], ['602', 'disagrees_with_archived_payload']],
  )
})

test('the report separates orders that can be corrected quietly from ones already charged for', async () => {
  // `uncommitted` is the field the follow-up correction is allowed to key on. A code-only rewrite of
  // an invoiced or paid order puts IMS at odds with a document in the ledger that this cannot amend.
  reset()
  store.links.push(
    orderLink('701', 'gbp'),
    orderLink('702', 'gbp', { invoicedAt: new Date('2026-01-02T00:00:00Z'), accountingInvoiceId: 'INV-1' }),
    orderLink('703', 'gbp', { _count: { payments: 1, refunds: 0 } }),
  )
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()

  const byOrder = new Map(report.findings.map((finding) => [finding.externalOrderId, finding.monetary]))
  assert.equal(byOrder.get('701')?.uncommitted, true, 'nothing invoiced, nothing paid, no payments')
  assert.equal(byOrder.get('702')?.uncommitted, false, 'an invoice was raised for this one')
  assert.equal(byOrder.get('702')?.accountingInvoiceId, 'INV-1')
  assert.equal(byOrder.get('703')?.uncommitted, false, 'a payment was recorded against this one')
})

test('a clean order is NOT reported as a finding, so the report is a worklist and not a census', async () => {
  reset()
  store.links.push(orderLink('801', 'GBP'))
  store.events.push(event('e1', 801, { currency: 'GBP' }))
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()

  assert.equal(report.scanned, 1, 'it was examined')
  assert.deepEqual(report.findings, [], 'and it is not a finding')
  assert.equal(report.summary.agrees, 1, 'the count still says so')
})

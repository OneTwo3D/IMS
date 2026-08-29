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
  /** AccountingSyncLog rows — the SALES_INVOICE work `uncommitted` must fail closed on (r15). */
  accountingSyncLogs: [] as Row[],
  /** ShoppingSyncLog rows — the invoice-number hold queue, read through its own `where` (r15). */
  shoppingSyncLogs: [] as Row[],
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
      accountingSyncLog: {
        // Filters on exactly the fields the audit's queries constrain, so a query that dropped one
        // of them would over-match and the fail-closed tests would notice.
        findMany: async ({ where }: { where: Row }) => store.accountingSyncLogs.filter((row) => {
          const ids = (where.referenceId as { in?: string[] } | undefined)?.in ?? []
          if (!ids.includes(row.referenceId as string)) return false
          if (where.referenceType !== undefined && row.referenceType !== where.referenceType) return false
          const types = (where.type as { in?: string[] } | undefined)?.in
          if (types && !types.includes(row.type as string)) return false
          const statuses = (where.status as { in?: string[] } | undefined)?.in
          if (statuses && !statuses.includes(row.status as string)) return false
          if (where.externalTransactionId !== undefined && !row.externalTransactionId) return false
          return true
        }),
        create: writeThrows('accountingSyncLog.create'),
        update: writeThrows('accountingSyncLog.update'),
      },
      shoppingSyncLog: {
        findMany: async ({ where }: { where: Row }) => store.shoppingSyncLogs.filter((row) => {
          const ids = (where.entityId as { in?: string[] } | undefined)?.in ?? []
          if (!ids.includes(row.entityId as string)) return false
          for (const key of ['connector', 'direction', 'status', 'entityType'] as const) {
            if (where[key] !== undefined && row[key] !== where[key]) return false
          }
          const payloadPath = where.payload as { path?: string[]; equals?: unknown } | undefined
          if (payloadPath?.path?.length) {
            const payload = row.payload as Record<string, unknown> | undefined
            if (payload?.[payloadPath.path[0]] !== payloadPath.equals) return false
          }
          return true
        }),
        create: writeThrows('shoppingSyncLog.create'),
      },
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
  store.accountingSyncLogs.length = 0
  store.shoppingSyncLogs.length = 0
  store.writes.length = 0
}

/** `createdAt` is the LINK's, and it is the provenance anchor the archive rule compares against. */
function orderLink(externalOrderId: string, currency: string, money: Row = {}, createdAt = new Date('2026-01-01T00:00:00Z')) {
  return {
    externalOrderId,
    createdAt,
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

/**
 * An archived delivery. The default is a delivery with NO provenance at all — no topic, no
 * terminal status, no processing window — because that is what most rows in a real archive look
 * like and it must never be enough to claim an order was created by it.
 */
function event(id: string, orderId: number, payload: Row, provenance: Row = {}) {
  return {
    id,
    payloadJson: { id: orderId, ...payload },
    topic: null,
    status: 'PROCESSED',
    receivedAt: null,
    processedAt: null,
    ...provenance,
  }
}

/** A delivery that ran the importer to completion, between the two times given. */
function processedDelivery(receivedAt: string, processedAt: string, topic = 'order.created') {
  return { topic, status: 'PROCESSED', receivedAt: new Date(receivedAt), processedAt: new Date(processedAt) }
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

test('a silent delivery names the fallback ONLY when it is proven to be the one that created the order', async () => {
  // This is the only verdict in the module that names a CAUSE, so it is the only one that needs
  // provenance. The order was created as GBP because the delivery that created it said nothing;
  // the store saying GBP now does not change what happened, and the FX basis and ledger routing
  // were decided then.
  //
  // The two assertions differ in ONE field. Round 14 had no such field: every silent archive was
  // called invented, so an EUR order imported by the backfill and later touched by a single
  // degraded `order.updated` was reported as an invention the fallback never made.
  const { judgeWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  assert.equal(
    judgeWcOrderCurrency({
      storedCurrency: 'GBP',
      archived: { payloads: 3, noCurrency: 3, codes: [], silentDeliveryCreatedTheOrder: true },
      liveCurrency: 'GBP',
    }),
    'fallback_invented',
  )
  assert.equal(
    judgeWcOrderCurrency({
      storedCurrency: 'GBP',
      archived: { payloads: 3, noCurrency: 3, codes: [], silentDeliveryCreatedTheOrder: false },
      liveCurrency: 'GBP',
    }),
    'archived_states_nothing',
  )
  // Absent is not "assume yes". An older caller that does not supply the field gets the weaker
  // verdict, which is the direction an audit is allowed to be wrong in.
  assert.equal(
    judgeWcOrderCurrency({
      storedCurrency: 'GBP',
      archived: { payloads: 3, noCurrency: 3, codes: [] },
      liveCurrency: 'GBP',
    }),
    'archived_states_nothing',
  )
})

test('an unproven silent archive never displaces a stronger CURRENT finding, and never reads as agrees', async () => {
  // The weak flag has two jobs and they pull in opposite directions: it must not clear the order,
  // and it must not shout over a live disagreement that is actionable today. Asserted as a set —
  // "it always returns archived_states_nothing" would pass the first and fail the store.
  const { judgeWcOrderCurrency } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')
  const silent = { payloads: 2, noCurrency: 2, codes: [] as string[], silentDeliveryCreatedTheOrder: false }

  assert.equal(
    judgeWcOrderCurrency({ storedCurrency: 'GBP', archived: silent, liveCurrency: 'EUR' }),
    'disagrees_with_live',
  )
  assert.equal(
    judgeWcOrderCurrency({ storedCurrency: 'GBP', archived: silent, liveCurrency: null }),
    'live_states_nothing',
  )
  assert.equal(
    judgeWcOrderCurrency({ storedCurrency: 'gbp', archived: silent }),
    'non_canonical_stored_code',
  )
  // No live read, and the archive said nothing usable. NOT `agrees` — there really is a delivery
  // for this order that stated nothing.
  assert.equal(judgeWcOrderCurrency({ storedCurrency: 'GBP', archived: silent }), 'archived_states_nothing')
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
  assert.deepEqual(byExternalOrderId.get('501'), {
    payloads: 2, noCurrency: 1, codes: new Set(['EUR']), creatingCandidate: null,
  })
  // Normalised the same way the importer normalises, so a padded lower-case payload is not counted
  // as "stated nothing" — it stated USD badly.
  assert.deepEqual(byExternalOrderId.get('502'), {
    payloads: 1, noCurrency: 0, codes: new Set(['USD']), creatingCandidate: null,
  })
  assert.deepEqual(byExternalOrderId.get('503'), {
    payloads: 2, noCurrency: 2, codes: new Set(), creatingCandidate: null,
  })
})

test('the creating candidate is the EARLIEST processed order-import delivery, and nothing else qualifies', async () => {
  reset()
  store.events.push(
    // Later in id order but EARLIER in time — picked by receivedAt, because paging by cuid is not
    // a chronological scan.
    event('e2', 601, {}, processedDelivery('2026-03-01T10:00:00Z', '2026-03-01T10:00:05Z', 'order.updated')),
    event('e1', 601, {}, processedDelivery('2026-03-02T10:00:00Z', '2026-03-02T10:00:05Z')),
    // Never processed: it created nothing, whenever it arrived.
    event('e3', 602, {}, { ...processedDelivery('2026-03-01T10:00:00Z', '2026-03-01T10:00:05Z'), status: 'FAILED' }),
    // A topic that does not run the importer.
    event('e4', 603, {}, processedDelivery('2026-03-01T10:00:00Z', '2026-03-01T10:00:05Z', 'order.deleted')),
  )
  const { readArchivedWcOrderCurrencies } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const { byExternalOrderId } = await readArchivedWcOrderCurrencies(10)

  assert.deepEqual(byExternalOrderId.get('601')?.creatingCandidate, {
    receivedAt: new Date('2026-03-01T10:00:00Z'),
    processedAt: new Date('2026-03-01T10:00:05Z'),
    statedCurrency: null,
  })
  assert.equal(byExternalOrderId.get('602')?.creatingCandidate, null, 'a delivery that did not run created nothing')
  assert.equal(byExternalOrderId.get('603')?.creatingCandidate, null, 'another topic did not run the importer')
})

test('the provenance predicate answers only when the link was written inside the delivery window', async () => {
  const { archivedSilentDeliveryCreatedOrder } = await import(
    '@/lib/connectors/woocommerce/sync/order-currency-audit'
  )
  const candidate = {
    receivedAt: new Date('2026-03-01T10:00:00Z'),
    processedAt: new Date('2026-03-01T10:00:10Z'),
    statedCurrency: null,
  }

  assert.equal(
    archivedSilentDeliveryCreatedOrder({
      creatingCandidate: candidate,
      linkCreatedAt: new Date('2026-03-01T10:00:04Z'),
    }),
    true,
  )
  // Created BEFORE the delivery arrived: something else created it. This is the pull-import case.
  assert.equal(
    archivedSilentDeliveryCreatedOrder({
      creatingCandidate: candidate,
      linkCreatedAt: new Date('2026-03-01T09:59:59Z'),
    }),
    false,
  )
  // Created AFTER the delivery finished: it was not this one either.
  assert.equal(
    archivedSilentDeliveryCreatedOrder({
      creatingCandidate: candidate,
      linkCreatedAt: new Date('2026-03-01T10:00:11Z'),
    }),
    false,
  )
  assert.equal(
    archivedSilentDeliveryCreatedOrder({ creatingCandidate: null, linkCreatedAt: new Date() }),
    false,
    'no processed delivery at all — the backfill and the pull sweeps leave none',
  )
  assert.equal(
    archivedSilentDeliveryCreatedOrder({ creatingCandidate: candidate, linkCreatedAt: null }),
    false,
    'an unknown link time proves nothing',
  )
  assert.equal(
    archivedSilentDeliveryCreatedOrder({
      creatingCandidate: { ...candidate, statedCurrency: 'EUR' },
      linkCreatedAt: new Date('2026-03-01T10:00:04Z'),
    }),
    false,
    'the creating delivery stated a currency, so nothing was invented',
  )
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

// --- the archive counterexamples, end to end ---------------------------------------------------

test('a pull-imported order later touched by a silent update webhook is NOT called invented', async () => {
  // CODEX'S COUNTEREXAMPLE, driven through the whole audit rather than the pure rule, because the
  // rule cannot be wrong on its own — the loss was in what the archive reduction threw away.
  //
  // Order 901 was created by the initial import at 09:00. It never touched the inbox. At 11:00 a
  // degraded `order.updated` arrives stating no currency, and becomes the ONLY archived payload
  // this order has. Round 14 read that as "every archived delivery for this order states nothing"
  // and reported an invention the fallback never made.
  reset()
  store.links.push(orderLink('901', 'GBP', {}, new Date('2026-03-01T09:00:00Z')))
  store.events.push(
    event('e1', 901, {}, processedDelivery('2026-03-01T11:00:00Z', '2026-03-01T11:00:02Z', 'order.updated')),
  )
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()

  assert.equal(report.summary.fallback_invented, 0, 'nothing here proves the fallback wrote this code')
  assert.equal(report.summary.archived_states_nothing, 1)
  assert.deepEqual(
    report.findings.map((finding) => [finding.externalOrderId, finding.verdict]),
    [['901', 'archived_states_nothing']],
    'still reported — a delivery really did state nothing — but as what it is',
  )
})

test('an order whose CREATING delivery stated nothing is still called invented, so the rule is not just "never"', async () => {
  // The other half. Order 902 arrived by webhook at 11:00:00, the importer ran for two seconds and
  // wrote the link inside that window, and the delivery stated no currency. That is the fallback,
  // and the audit must still say so — a provenance rule that could never be satisfied would turn
  // the one positive identification in the module into dead code.
  reset()
  store.links.push(orderLink('902', 'GBP', {}, new Date('2026-03-01T11:00:01Z')))
  store.events.push(
    event('e1', 902, {}, processedDelivery('2026-03-01T11:00:00Z', '2026-03-01T11:00:02Z')),
  )
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()

  assert.deepEqual(
    report.findings.map((finding) => [finding.externalOrderId, finding.verdict]),
    [['902', 'fallback_invented']],
  )
})

// --- the accounting evidence -------------------------------------------------------------------

test('an order with a QUEUED sales invoice is not offered as uncommitted', async () => {
  // The importer queues the SALES_INVOICE from the value it just wrote, and the worker has not
  // claimed it yet. `invoicedAt`, `accountingInvoiceId`, `paidAt`, payments and refunds are ALL
  // empty — round 14 read exactly those five and called the order safe to correct, while a payload
  // snapshot built at the invented currency sat in the queue waiting to post.
  reset()
  store.links.push(orderLink('1001', 'gbp'))
  store.accountingSyncLogs.push({
    referenceType: 'SalesOrder',
    referenceId: 'so-1001',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    externalTransactionId: null,
  })
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()
  const finding = report.findings.find((row) => row.externalOrderId === '1001')

  assert.equal(finding?.monetary.postableInvoiceJobs, 1)
  assert.equal(finding?.monetary.invoicedAt, null, 'the order columns really are all empty')
  assert.equal(finding?.monetary.accountingInvoiceId, null)
  assert.equal(finding?.monetary.uncommitted, false)
})

test('an invoice that POSTED but failed to write its id back is not offered as uncommitted', async () => {
  // o3d-9kek: a SYNCED row with an `externalTransactionId` and a NULL `accountingInvoiceId` on the
  // order. There is a real document in the ledger and the order column says there is not, so an
  // "is it posted?" question answered from the column alone answers no about an invoice that
  // exists — which is precisely why every other reader in this connector reads both.
  reset()
  store.links.push(orderLink('1002', 'gbp'))
  store.accountingSyncLogs.push({
    referenceType: 'SalesOrder',
    referenceId: 'so-1002',
    type: 'SALES_INVOICE',
    status: 'SYNCED',
    externalTransactionId: 'xero-inv-77',
  })
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()
  const finding = report.findings.find((row) => row.externalOrderId === '1002')

  assert.deepEqual(finding?.monetary.postedInvoiceExternalIds, ['xero-inv-77'])
  assert.equal(finding?.monetary.accountingInvoiceId, null, 'the back-reference write is the one that failed')
  assert.equal(finding?.monetary.uncommitted, false)
})

test('an invoice PARKED for a WooCommerce invoice number is not offered as uncommitted', async () => {
  // held-sales-invoice.ts: the payload is built and stored, and enqueued unchanged as soon as the
  // number arrives. Nothing about the order row says so.
  reset()
  store.links.push(orderLink('1003', 'gbp'))
  store.shoppingSyncLogs.push({
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    status: 'PENDING',
    entityType: 'SalesOrder',
    entityId: 'so-1003',
    payload: { reason: 'missing_wc_invoice_number' },
  })
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()
  const finding = report.findings.find((row) => row.externalOrderId === '1003')

  assert.equal(finding?.monetary.heldInvoiceJobs, 1)
  assert.equal(finding?.monetary.uncommitted, false)
})

test('ledger evidence for ANOTHER order does not commit this one, and terminal rows do not either', async () => {
  // The control. Every assertion above is "uncommitted === false", which a rule hard-wired to
  // false passes perfectly. This one must still be TRUE: an order with no ledger evidence of its
  // own, alongside a neighbour that has plenty, and next to rows that are terminal — CANCELLED
  // cannot be claimed by any worker, and a SYNCED row with no external id is not a document.
  reset()
  store.links.push(orderLink('1004', 'gbp'), orderLink('1005', 'gbp'))
  store.accountingSyncLogs.push(
    { referenceType: 'SalesOrder', referenceId: 'so-1005', type: 'SALES_INVOICE', status: 'PENDING', externalTransactionId: null },
    { referenceType: 'SalesOrder', referenceId: 'so-1004', type: 'SALES_INVOICE', status: 'CANCELLED', externalTransactionId: null },
    { referenceType: 'SalesOrder', referenceId: 'so-1004', type: 'SALES_INVOICE', status: 'SYNCED', externalTransactionId: null },
  )
  store.shoppingSyncLogs.push({
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    status: 'PENDING',
    entityType: 'SalesOrder',
    entityId: 'so-1005',
    payload: { reason: 'missing_wc_invoice_number' },
  })
  const { runWcOrderCurrencyAudit } = await import('@/lib/connectors/woocommerce/sync/order-currency-audit')

  const report = await runWcOrderCurrencyAudit()
  const byOrder = new Map(report.findings.map((finding) => [finding.externalOrderId, finding.monetary]))

  assert.equal(byOrder.get('1004')?.postableInvoiceJobs, 0)
  assert.deepEqual(byOrder.get('1004')?.postedInvoiceExternalIds, [])
  assert.equal(byOrder.get('1004')?.heldInvoiceJobs, 0)
  assert.equal(byOrder.get('1004')?.uncommitted, true, 'this one really is correctable')
  assert.equal(byOrder.get('1005')?.uncommitted, false, 'its neighbour is not')
})

test('the accounting-evidence rule refuses on every signal it holds, one at a time', async () => {
  // The pure rule, so a future field cannot be added to the type and left out of the decision.
  const { isWcOrderCurrencyUncommitted } = await import(
    '@/lib/connectors/woocommerce/sync/order-currency-audit'
  )
  const clean = {
    invoicedAt: null,
    accountingInvoiceId: null,
    paidAt: null,
    payments: 0,
    refunds: 0,
    postableInvoiceJobs: 0,
    postedInvoiceExternalIds: [] as string[],
    heldInvoiceJobs: 0,
  }

  assert.equal(isWcOrderCurrencyUncommitted(clean), true)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, invoicedAt: '2026-01-01T00:00:00Z' }), false)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, accountingInvoiceId: 'INV-1' }), false)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, paidAt: '2026-01-01T00:00:00Z' }), false)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, payments: 1 }), false)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, refunds: 1 }), false)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, postableInvoiceJobs: 1 }), false)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, postedInvoiceExternalIds: ['x'] }), false)
  assert.equal(isWcOrderCurrencyUncommitted({ ...clean, heldInvoiceJobs: 1 }), false)
})

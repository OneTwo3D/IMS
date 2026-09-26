import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { balancedFrom, blankNonCode, ownProperty, productionSources, topLevelProperty } from './paid-provenance-scan'
import { accountingPostingKey } from '@/lib/accounting/posting-key'

/**
 * o3d-j625 r4 — A REFUSED POSTING IS OUTSTANDING WORK IN THE EXCEPTION INBOX, NOT AN ACTIVITY LINE.
 *
 * Rounds 2-4 made the enqueues refuse rather than write a row into books that cannot describe it, and
 * reported every refusal to the Activity log. The owner's decision: that is the wrong surface. The
 * refusals that matter are the ones nobody is looking for — a WooCommerce held-invoice release refuses
 * days later, on a sweep — so each one must read as OUTSTANDING, with a remedy, where the operator
 * already looks for work IMS owes.
 *
 * THIS FILE PINS THE SHARED SEAM: `reportPostingNotQueued`, which the thirteen sites that keep their
 * local change and write an ERROR all go through. It drives ONE of those sites for real
 * (`maybeQueueTaxRateSync`, the lightest of them) rather than calling the seam directly, so what is
 * asserted is a site producing a row — and then asserts, by census, that every one of the fourteen call
 * sites passes the posting identity the row is keyed on, since a site that omitted it would type-error
 * but a site ADDED later without it is what the census is for.
 *
 * The other two halves of the decision are pinned where they happen: the held-invoice release in
 * tests/connectors/wc-held-release-sweep.test.ts, and the record-and-clear cycle against the real facade
 * in tests/accounting/document-id-provenance-routing.test.ts.
 */

const rows: Array<Record<string, unknown>> = []
/** The UPDATE branch of each upsert — what a second write would do to an existing row (review M-5). */
const updates: Array<Record<string, unknown>> = []
const activity: Array<{ action: string; level?: string }> = []
/** o3d-j625 r6: every enqueue's params. */
const asked: Array<Record<string, unknown>> = []
let enqueueAnswer: { queued: boolean; reason?: string; connector: string | null; activeConnector?: string | null; refusalRecorded?: boolean } = { queued: true, connector: 'xero' }
let activeConnector: string | null = 'quickbooks'

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingPostingRefusal: {
        upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          rows.push({ ...create, resolvedAt: null })
          updates.push(update)
          return create
        },
        updateMany: async () => ({ count: 0 }),
      },
    },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string }) => { activity.push(entry) },
    logActivityPersisted: async () => true,
  },
})
mock.module('@/lib/accounting', {
  namedExports: {
    getActiveAccountingConnectorInfo: async () => (activeConnector ? { id: activeConnector, name: activeConnector } : null),
    isAccountingSyncTypeEnabledFor: async () => true,
    // o3d-j625 r5: the facade reports the POSTING KEY it derived, and the report keys its row on that. The
    // REAL key function is used here — the contract under test is that the site forwards it, not that a
    // fixture can invent one.
    queueAccountingSync: async (params: { type: string; referenceType: string; referenceId: string; idempotencyKey?: string; payload?: Record<string, unknown> }) => {
      asked.push(params)
      return { ...enqueueAnswer, posting: accountingPostingKey(params) }
    },
  },
})

const TAX_RATE = {
  id: 'rate-1',
  name: 'Standard 20%',
  rate: 0.2,
  components: [{ name: 'VAT', rate: 0.2, compoundOnPrevious: false, accountingTaxType: 'OUTPUT2', active: true }],
}

async function pushTaxRate() {
  const { maybeQueueTaxRateSync } = await import('@/lib/accounting/tax-rate-sync-trigger')
  await maybeQueueTaxRateSync(TAX_RATE as never)
}

test.beforeEach(() => {
  rows.length = 0
  updates.length = 0
  activity.length = 0
  enqueueAnswer = { queued: true, connector: 'xero' }
  activeConnector = 'xero'
})

test('[o3d-j625 r4] a site that keeps its local change and reports an ERROR also records OUTSTANDING work', async () => {
  // review M-4: the columns can only pass by carrying their own facts. The chart the payload was built from
  // is xero (the site resolves it — the active connector at its top, which this double answers 'xero'); the
  // connector active when the enqueue REFUSED is quickbooks, which the facade reports. A report-time read
  // would say 'xero' again. r4 had every value equal to 'xero', so writing the chart into
  // `activeConnector` passed.
  enqueueAnswer = { queued: false, reason: 'refused', connector: 'xero', activeConnector: 'quickbooks' }

  await pushTaxRate()

  assert.ok(activity.some((entry) => entry.action === 'tax_rate_sync_not_queued' && entry.level === 'ERROR'),
    'PRECONDITION: this is the ERROR-log path the decision is about')
  assert.equal(rows.length, 1, `and the same facts are durable. Rows: ${JSON.stringify(rows)}`)
  assert.equal(rows[0].type, 'TAX_RATE_SYNC')
  assert.equal(rows[0].referenceType, 'TaxRate')
  assert.equal(rows[0].referenceId, 'rate-1')
  assert.equal(rows[0].activeConnector, 'quickbooks',
    'the ACTIVE connector is on the row — round 2 omitted it — and it is the one the REFUSAL saw (review L-7), '
    + 'not the chart\'s and not a report-time read (both of which are xero here)')
  assert.equal(rows[0].chartConnector, 'xero', 'and the chart the payload was built from, as its own column')
  assert.equal(rows[0].reason, 'refused')
  assert.ok(String(rows[0].committed).length > 0, 'what stands in IMS')
  assert.ok(String(rows[0].remedy).length > 0, 'and what the operator must do')
})

test('[o3d-j625 r4] CONTROL: a queued posting records nothing outstanding, and a not-configured one owes nothing', async () => {
  await pushTaxRate()
  assert.deepEqual(rows, [], 'a posting that queued owes nothing')

  enqueueAnswer = { queued: false, reason: 'not-configured', connector: null }
  await pushTaxRate()
  assert.deepEqual(rows, [], 'and a connector that does not post this type owes nothing either')
  assert.deepEqual(activity.filter((entry) => entry.level === 'ERROR'), [], 'nor is it reported as a failure')
})

// ---------------------------------------------------------------------------------------------------
// EVERY reporting site names the posting the row is keyed on
// ---------------------------------------------------------------------------------------------------

test('[o3d-j625 r5] no reporting site invents an outcome — every one forwards what an enqueue answered', () => {
  // r4 asserted that each site NAMED its posting; r5 took that property away from the sites (it is the
  // enqueue's answer now), so the thing to assert is that no site hands this function an outcome it made up.
  // An invented outcome is exactly how a hand-written key would come back.
  const NEEDLE = 'reportPostingNotQueued('
  const sites: Array<{ file: string; line: number; outcome: string }> = []
  for (const [file, source] of productionSources()) {
    const code = blankNonCode(source)
    let from = 0
    for (;;) {
      const at = code.indexOf(NEEDLE, from)
      if (at === -1) break
      from = at + NEEDLE.length
      if (/(?:^|[^\w$])function\s+$/.test(code.slice(0, at))) continue
      const argument = balancedFrom(code, at + NEEDLE.length - 1)
      const objectAt = argument.indexOf('{')
      const request = objectAt === -1 ? null : balancedFrom(argument, objectAt)
      const outcome = request === null ? '<unreadable>' : (ownPropertyText(request, 'outcome') ?? '<missing>')
      sites.push({ file, line: source.slice(0, at).split('\n').length, outcome })
    }
  }
  console.log(`[o3d-j625 r5] reportPostingNotQueued call sites examined: ${sites.length}`)
  assert.ok(sites.length >= 14, `expected the fourteen reporting sites, found ${sites.length}`)
  const invented = sites.filter((site) => site.outcome.startsWith('{') || site.outcome === '<missing>' || site.outcome === '<unreadable>')
  assert.deepEqual(
    invented.map((site) => `${site.file}:${site.line} ${site.outcome.slice(0, 40)}`),
    [],
    'these sites report an outcome they built themselves. It must be the answer an enqueue gave, because the '
    + 'inbox row is keyed on the posting THAT enqueue reported — see the r5 review, HIGH 1/2/3.',
  )
})

/** The text of an own top-level property of an object literal, or null. */
function ownPropertyText(objectText: string, key: string): string | null {
  const re = new RegExp(`(?:^|[^\\w$.])${key}\\s*:`)
  const m = re.exec(objectText)
  if (!m) return null
  let i = m.index + m[0].length
  while (i < objectText.length && /\s/.test(objectText[i]!)) i++
  if ('({['.includes(objectText[i]!)) return balancedFrom(objectText, i)
  let k = i
  let depth = 0
  while (k < objectText.length) {
    const c = objectText[k]!
    if ('({['.includes(c)) depth++
    else if (')}]'.includes(c)) { if (depth === 0) break; depth-- }
    else if (c === ',' && depth === 0) break
    k++
  }
  return objectText.slice(i, k).trim()
}

test('[o3d-j625 r5 M-5] a refusal the enqueue already recorded is MERGED, not counted again or re-reasoned', async () => {
  // Every facade-path refusal is written twice: by the enqueue, which knows the specific reason, and by the
  // site reporting it, which knows what stands in IMS and the remedy. r4 let the second write increment the
  // attempt count and overwrite `retired_chart` with a generic `refused`.
  enqueueAnswer = { queued: false, reason: 'refused', connector: 'xero', refusalRecorded: true } as typeof enqueueAnswer
  await pushTaxRate()

  assert.equal(updates.length, 1, 'PRECONDITION: a row was upserted')
  assert.equal('refusedCount' in updates[0]!, false, 'the second write must not count the refusal again')
  assert.equal('reason' in updates[0]!, false, 'nor replace the enqueue’s specific reason with a generic one')
  assert.ok('remedy' in updates[0]! && 'committed' in updates[0]!, 'it adds what only the site knows')
})

test('[o3d-j625 r5 M-5] CONTROL: a refusal nobody else recorded is a full write, counted', async () => {
  enqueueAnswer = { queued: false, reason: 'refused', connector: 'xero' }
  await pushTaxRate()
  assert.equal(updates.length, 1)
  assert.ok('refusedCount' in updates[0]!, 'a site-only refusal counts its attempts')
  assert.ok('reason' in updates[0]!)
})

// o3d-j625 r5 (review L-1) — THE ONE CASE WHERE THE INBOX ROW IS MISSING MUST NOT ALSO BE THE CASE NOBODY
// IS TOLD ABOUT. r4 swallowed a failed write silently.
test('[o3d-j625 r5 L-1] a refusal that cannot be recorded is itself reported, and never thrown at the caller', async () => {
  activity.length = 0
  const { recordAccountingPostingRefusal, clearAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  const broken = {
    accountingPostingRefusal: {
      upsert: async () => { throw new Error('relation "AccountingPostingRefusal" does not exist') },
      updateMany: async () => { throw new Error('relation "AccountingPostingRefusal" does not exist') },
    },
  }
  const key = accountingPostingKey({ type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-9' })

  await recordAccountingPostingRefusal(broken, key, {
    kind: 'sales_invoice_order', chartConnector: 'xero', activeConnector: 'quickbooks', reason: 'retired_chart', committed: 'x', remedy: 'y',
  })
  await clearAccountingPostingRefusal(broken, key)

  const reported = activity.filter((a) => a.action === 'accounting_posting_refusal_not_recorded')
  assert.equal(reported.length, 2, 'both the failed record and the failed clear are reported')
  assert.ok(reported.every((a) => a.level === 'ERROR'))
})

// o3d-j625 r10 — AND IT SAYS SO IN ITS RETURN VALUE, not only in the activity log.
//
// The record REPORTS a write that threw and does not rethrow it, which is what keeps M-14 true. From the
// outside that is indistinguishable from "nothing was owed" — and since r10 there is a caller that has to
// tell those apart: `reconcileProvisionalPostingRefusals` completes a claim on the answer. An optimistic
// answer here marks a claim SUCCEEDED over a debt that was never written, which is round 9's loss again.
test('[o3d-j625 r10] a record whose write threw answers `failed`, so a caller that can retry knows to', async () => {
  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  const broken = {
    accountingPostingRefusal: {
      upsert: async () => { throw new Error('relation "AccountingPostingRefusal" does not exist') },
      updateMany: async () => { throw new Error('relation "AccountingPostingRefusal" does not exist') },
    },
  }
  const outcome = await recordAccountingPostingRefusal(broken, accountingPostingKey({
    type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-10',
  }), {
    kind: 'sales_invoice_order', chartConnector: 'xero', activeConnector: 'quickbooks', reason: 'retired_chart', committed: 'x', remedy: 'y',
  })
  assert.deepEqual(outcome, { recorded: false, because: 'failed' })

  // CONTROL: the same call against a client that CAN write answers `recorded`, so the assertion above is
  // about the failure and not about this function always saying `failed`.
  const working = {
    accountingPostingRefusal: { upsert: async () => ({}), updateMany: async () => ({ count: 1 }) },
  }
  assert.deepEqual(
    await recordAccountingPostingRefusal(working, accountingPostingKey({ type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-11' }), {
      kind: 'sales_invoice_order', chartConnector: 'xero', activeConnector: 'quickbooks', reason: 'retired_chart', committed: 'x', remedy: 'y',
    }),
    { recorded: true },
  )
})

// o3d-j625 r5 (review M-2) — THE CHART IS AN INPUT THE REPORTER CANNOT INFER.
//
// `reportPostingNotQueued` reads the chart's connector out of `metadata.chartConnector`, and three of r4's
// sites passed no metadata although the chart was in scope, so the inbox rendered "none → xero": an
// inference from an absence, and the schema says NULL means "nothing was switched on". Every reporting
// site must name it — `null` is allowed, but only when written, so an absence is a decision someone made.
test('[o3d-j625 r5 M-2] every reporting site names the chart it reports about', () => {
  const NEEDLE = 'reportPostingNotQueued('
  const sites: Array<{ at: string; named: boolean }> = []
  for (const [file, source] of productionSources()) {
    if (file === 'lib/domain/accounting/enqueue-outcome.ts') continue // the declaration
    const code = blankNonCode(source)
    for (let at = code.indexOf(NEEDLE); at !== -1; at = code.indexOf(NEEDLE, at + NEEDLE.length)) {
      if (/(?:^|[^\w$])function\s+$/.test(code.slice(0, at))) continue
      const argument = balancedFrom(code, at + NEEDLE.length - 1)
      const objectAt = argument.indexOf('{')
      const request = objectAt === -1 ? '' : balancedFrom(argument, objectAt)
      const metadata = request === '' ? null : topLevelProperty(request, 'metadata')
      const named = metadata !== null && metadata.startsWith('{') && ownProperty(metadata, 'chartConnector') !== null
      sites.push({ at: `${file}:${source.slice(0, at).split('\n').length}`, named })
    }
  }
  console.log(`[o3d-j625 r5] reporting sites examined: ${sites.length}`)
  assert.ok(sites.length >= 14, `PRECONDITION: the reporting sites were found (found ${sites.length})`)
  assert.deepEqual(sites.filter((site) => !site.named).map((site) => site.at), [],
    'these report a refused posting without naming its chart, and the inbox would show "none"')
})

// o3d-j625 r6 (review M3) — A SITE REPORTING FROM INSIDE A TRANSACTION WRITES THE ROW THROUGH IT, so a batch
// that later throws takes the row with it. applyStockAdjustment runs inside the bulk adjustment and the
// stock-count post; through the pool, a rolled-back batch left an outstanding posting for a movement that
// never existed.
test('[o3d-j625 r6 M3] reportPostingNotQueued writes through the caller\'s transaction when given one', async () => {
  rows.length = 0
  const { reportPostingNotQueued } = await import('@/lib/domain/accounting/enqueue-outcome')
  const txRows: Array<Record<string, unknown>> = []
  let savepoints = 0
  await reportPostingNotQueued({
    entityType: 'STOCK_ADJUSTMENT',
    action: 'inventory_adjustment_journal_not_queued',
    kind: 'stock_adjustment_journal',
    posting: 'the inventory adjustment journal',
    committed: 'the stock movement is written',
    remedy: 'Post the journal by hand.',
    outcome: { queued: false, reason: 'refused', connector: 'xero', posting: accountingPostingKey({ type: 'INVENTORY_ADJUSTMENT', referenceType: 'StockMovement', referenceId: 'mv-1' }) },
    metadata: { chartConnector: 'xero' },
    inTransaction: {
      client: {
        accountingPostingRefusal: {
          upsert: async ({ create }) => { txRows.push(create); return create },
          updateMany: async () => ({ count: 0 }),
        },
      },
      withSavepoint: async (fn) => { savepoints++; return fn() },
    },
  })
  assert.equal(txRows.length, 1, 'written through the transaction')
  assert.equal(rows.length, 0, 'and not through the pool')
  assert.ok(savepoints >= 1, 'under a savepoint, so a failed write cannot abort the batch')
})

test('[o3d-j625 r6 M3] applyStockAdjustment enqueues and reports inside the caller\'s transaction', async () => {
  const { readFileSync } = await import('node:fs')
  const code = blankNonCode(readFileSync(`${process.cwd()}/lib/domain/inventory/stock-adjustment-apply.ts`, 'utf8'))
  assert.match(code, /await queueAccountingSyncTxWithOutcome\(tx, \{/, 'the enqueue shares the movement\'s transaction')
  assert.doesNotMatch(code, /\bqueueAccountingSync\(/, 'not the facade, which commits on its own')
  assert.match(code, /recordRefusalAsOutstanding: true,/)
  assert.match(code, /inTransaction: \{\s*client: tx as unknown as PostingRefusalClient,/)
})

// o3d-j625 r6 (review H4) — `tax_rate_sync` IS AN AUTO KIND because saving the rate again raises the SAME
// posting. Driven through the real trigger twice: refused, then queued.
test('[o3d-j625 r6 H4] saving the tax rate again raises the SAME posting', async () => {
  asked.length = 0
  rows.length = 0
  enqueueAnswer = { queued: false, reason: 'refused', connector: 'xero' }
  await pushTaxRate()
  assert.equal(rows.length, 1, 'PRECONDITION: refused and recorded')
  enqueueAnswer = { queued: true, connector: 'xero' }
  await pushTaxRate()
  assert.equal(asked.length, 2)
  assert.deepEqual(accountingPostingKey(asked[1] as never), accountingPostingKey(asked[0] as never))
  assert.equal(rows[0]!.kind, 'tax_rate_sync', 'and the row names its kind')
})

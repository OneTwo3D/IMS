import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { aliasesOf, balancedFrom, blankNonCode, callOpens, ownProperty, productionSources } from './paid-provenance-scan'
import {
  POSTING_REFUSAL_KINDS,
  defaultPostingRefusalKind,
  postingRefusalClearing,
  type PostingRefusalKind,
} from '@/lib/domain/accounting/posting-refusal-kinds'

/**
 * o3d-j625 r6 (review H4; owner decision 2026-09-18, "Mark as handled") — THE CLASSIFICATION IS CLOSED,
 * EVERY REFUSAL SITE IS IN IT, AND EACH SIDE OF IT IS TRUE.
 *
 *   1. Every place that writes a refusal row names a kind from POSTING_REFUSAL_KINDS (the type checker
 *      requires the field; this census requires it to be a LITERAL key, so no site can compute its way
 *      round the classification).
 *   2. Every posting an enqueue can record a refusal for itself (every facade call, and every
 *      in-transaction call that asks) has a kind to record it under.
 *   3. AUTO: each auto kind names the test that DRIVES its re-queue path and shows the same posting (the
 *      same key) is raised again — and that test must exist.
 *   4. MANUAL: each manual kind names the only enqueue sites that raise its posting. A new producer of
 *      that posting fails this test until someone decides whether it makes the kind clear itself.
 */

// ---------------------------------------------------------------------------------------------------
// Enqueue sites, with the (type, referenceType) each raises — read from the call's own argument, or from
// the identity object it spreads.
// ---------------------------------------------------------------------------------------------------
type EnqueueSite = { file: string; line: number; type: string; referenceType: string; recordsRefusal: boolean }

const ENQUEUES = ['queueAccountingSync', 'queueAccountingSyncTx', 'queueAccountingSyncTxWithOutcome']

function literal(value: string | null): string | null {
  const m = value?.trim().match(/^'([^']*)'(?:\s+as\s+const)?$/)
  return m ? m[1]! : null
}

function identityProperty(code: string, source: string, objectText: string, key: string): string | null {
  const own = ownProperty(objectText, key)
  if (own !== null) return own
  for (const spread of objectText.matchAll(/\.\.\.([\w$]+)/g)) {
    const decl = new RegExp(`(?:const|let)\\s+${spread[1]}\\s*=\\s*\\{`).exec(code)
    if (!decl) continue
    const open = decl.index + decl[0].length - 1
    const value = ownProperty(source.slice(open, open + balancedFrom(code, open).length), key)
    if (value !== null) return value
  }
  return null
}

function enqueueSites(): EnqueueSite[] {
  const sites: EnqueueSite[] = []
  for (const [file, source] of productionSources()) {
    const code = blankNonCode(source)
    const names = ENQUEUES.flatMap((name) => [name, ...aliasesOf(code, name)])
    for (const { at, open, name } of callOpens(code, names)) {
      if (/(?:^|[^\w$])function\s+$/.test(code.slice(0, at))) continue
      const args = balancedFrom(code, open)
      const objectAt = args.indexOf('{')
      if (objectAt === -1) continue
      const blanked = balancedFrom(args, objectAt)
      // Read literals from the SOURCE text of the same span (strings are blank in `code`).
      const start = open + objectAt
      const objectText = source.slice(start, start + blanked.length)
      const type = literal(identityProperty(code, source, objectText, 'type'))
      const referenceType = literal(identityProperty(code, source, objectText, 'referenceType'))
      // `options.queueAccountingSync(tx, …)` in lib/cost-layers.ts is the INJECTED in-transaction enqueue
      // (typed `typeof queueAccountingSyncTx`), not the facade — as the chart census treats it.
      const injectedTx = /(?:^|[^\w$])options\.$/.test(code.slice(Math.max(0, at - 20), at))
      const isFacade = !injectedTx && (name === 'queueAccountingSync' || aliasesOf(code, 'queueAccountingSync').includes(name))
      const asks = /recordRefusalAsOutstanding:\s*true/.test(objectText)
      sites.push({
        file,
        line: source.slice(0, at).split('\n').length,
        type: type ?? '(dynamic)',
        referenceType: referenceType ?? '(dynamic)',
        recordsRefusal: isFacade || asks,
      })
    }
  }
  return sites
}

/** The two facade sites whose posting is a runtime value, and what they can raise (read from their producers). */
const DYNAMIC_FACADE_POSTINGS: Record<string, Array<[string, string]>> = {
  // `ledger.account(sync, await queueAccountingSync({ ...sync, chartConnector }))` — the refund's staged
  // syncs (refund-service.ts): its COGS reversal and unearned-revenue reversal.
  'app/actions/sales.ts': [['COGS_REVERSAL', 'SalesOrderRefund'], ['UNEARNED_REV_REVERSAL', 'SalesOrderRefund']],
}

test('[o3d-j625 r6 H4] every posting an enqueue can record a refusal for has a kind to record it under', () => {
  const sites = enqueueSites()
  console.log(`[o3d-j625 r6] enqueue sites read: ${sites.length}; that record refusals: ${sites.filter((s) => s.recordsRefusal).length}`)
  assert.ok(sites.filter((site) => site.recordsRefusal).length >= 14, 'PRECONDITION: the facade and asking in-transaction sites were found')
  const unclassified: string[] = []
  for (const site of sites.filter((s) => s.recordsRefusal)) {
    const postings: Array<[string, string]> = site.type === '(dynamic)' || site.referenceType === '(dynamic)'
      ? DYNAMIC_FACADE_POSTINGS[site.file] ?? [['(dynamic)', '(dynamic)']]
      : [[site.type, site.referenceType]]
    for (const [type, referenceType] of postings) {
      const kinds = Object.values(POSTING_REFUSAL_KINDS).filter((spec) => spec.type === type && spec.referenceType === referenceType)
      if (kinds.length === 0) unclassified.push(`${site.file}:${site.line} ${type}/${referenceType}`)
    }
  }
  assert.deepEqual(unclassified, [],
    'these enqueues can record a refused posting that has no kind — so nobody has decided whether it clears '
    + 'itself or is marked handled. Add it to lib/domain/accounting/posting-refusal-kinds.ts.')
})

test('[o3d-j625 r6 H4] the enqueue\'s own default never makes a row AUTO where a site could be MANUAL', () => {
  for (const [kind, spec] of Object.entries(POSTING_REFUSAL_KINDS) as Array<[PostingRefusalKind, (typeof POSTING_REFUSAL_KINDS)[PostingRefusalKind]]>) {
    const byDefault = defaultPostingRefusalKind(spec.type, spec.referenceType)
    const siblings = Object.values(POSTING_REFUSAL_KINDS).filter((s) => s.type === spec.type && s.referenceType === spec.referenceType)
    if (siblings.some((s) => s.clearing === 'manual') && byDefault !== null) {
      assert.equal(postingRefusalClearing(byDefault), 'manual', `${kind}: a posting with a MANUAL site defaults to a MANUAL kind`)
    }
  }
})

// ---------------------------------------------------------------------------------------------------
// Every refusal WRITE names a literal kind.
// ---------------------------------------------------------------------------------------------------
/** A literal kind, or both arms of `cond ? 'a' : 'b'` — every value the expression can take, or null. */
function literalKinds(value: string | null): string[] | null {
  if (value === null) return null
  const one = literal(value)
  if (one !== null) return [one]
  const ternary = value.trim().match(/^[^?]+\?\s*('[^']*')\s*(?:as const\s*)?:\s*('[^']*')(?:\s*as const)?$/)
  return ternary ? [literal(ternary[1]!)!, literal(ternary[2]!)!] : null
}

function refusalWriteKinds(files: Array<[string, string]>): Array<{ at: string; kind: string | null }> {
  const out: Array<{ at: string; kind: string | null }> = []
  for (const [file, source] of files) {
    if (file === 'lib/domain/accounting/posting-refusal-inbox.ts' || file === 'lib/domain/accounting/enqueue-outcome.ts'
      || file === 'lib/accounting.ts') continue // the writers themselves; lib/accounting.ts derives the default
    const code = blankNonCode(source)
    for (const { open, name } of callOpens(code, ['reportPostingNotQueued', 'recordAccountingPostingRefusal', 'recordPostingRefusal'])) {
      const args = balancedFrom(code, open)
      // The record object: the THIRD argument of `recordAccountingPostingRefusal(client, key, record, options?)`,
      // the FIRST (only) argument of the two object-taking reporters.
      const wanted = name === 'recordAccountingPostingRefusal' ? 2 : 0
      let objectAt = -1
      let depth = 0
      let index = 0
      for (let i = 1; i < args.length - 1; i++) {
        const ch = args[i]!
        if (depth === 0 && ch === ',') { index++; continue }
        if (depth === 0 && ch === '{' && index === wanted && objectAt === -1) objectAt = i
        if ('([{'.includes(ch)) depth++
        else if (')]}'.includes(ch)) depth--
      }
      if (objectAt === -1) continue
      const start = open + objectAt
      const objectText = source.slice(start, start + balancedFrom(args, objectAt).length)
      const kinds = literalKinds(ownProperty(objectText, 'kind'))
      const at = `${file}:${source.slice(0, open).split('\n').length}`
      if (kinds === null) out.push({ at, kind: null })
      else for (const kind of kinds) out.push({ at, kind })
    }
  }
  return out
}

test('[o3d-j625 r6 H4] every refusal write names a LITERAL kind from the closed set', () => {
  const writes = refusalWriteKinds(productionSources())
  console.log(`[o3d-j625 r6] refusal writes naming a kind: ${writes.length}`)
  // 22 sites; the two landed-cost reporters each name two kinds (outbox or direct): 24 kinds read. The count.
  assert.ok(writes.length >= 24, `PRECONDITION: the reporting and recording sites were found (${writes.length})`)
  assert.deepEqual(writes.filter((w) => w.kind === null || !(w.kind in POSTING_REFUSAL_KINDS)).map((w) => w.at), [])
})

test('[o3d-j625 r6 H4] the census FIRES on a computed or unknown kind', () => {
  const writes = refusalWriteKinds([['lib/x.ts', `
    await reportPostingNotQueued({ action: 'a', kind: someKind, posting: 'p' })
    await reportPostingNotQueued({ action: 'a', kind: 'not_a_kind', posting: 'p' })
    await reportPostingNotQueued({ action: 'a', kind: 'stock_receipt_journal', posting: 'p' })
    await reportPostingNotQueued({ action: 'a', kind: retried ? 'landed_cost_cogs_journal' : 'nope', posting: 'p' })
    await recordAccountingPostingRefusal(db, key, { kind: 'tax_rate_sync', reason: 'r' }, { mergeOnly: true })
  `]])
  assert.deepEqual(writes.map((w) => w.kind), [null, 'not_a_kind', 'stock_receipt_journal', 'landed_cost_cogs_journal', 'nope', 'tax_rate_sync'])
  assert.deepEqual(writes.filter((w) => w.kind === null || !(w.kind in POSTING_REFUSAL_KINDS)).length, 3)
})

// ---------------------------------------------------------------------------------------------------
// AUTO: the behavioural proof each kind rests on. The named test drives the re-queue path and shows the
// SAME posting (same key) is raised again; since r6 the row that path creates clears the refusal.
// ---------------------------------------------------------------------------------------------------
const AUTO_PROOFS: Record<string, Array<[string, string]>> = {
  sales_invoice_held_release: [['tests/connectors/wc-held-release-sweep.test.ts', '[o3d-j625 r6 H4] a refused held release is raised again, under the SAME posting key, by the next sweep']],
  sales_invoice_update: [['tests/domain/sales/sales-invoice-update-sync.test.ts', '[o3d-j625 r6 H4] re-saving the order raises the SAME posting']],
  purchase_invoice_update: [['tests/domain/purchasing/purchase-invoice-update-sync.test.ts', '[o3d-j625 r6 H2/H3] bill B']],
  tax_rate_sync: [['tests/accounting/posting-refusal-inbox.test.ts', '[o3d-j625 r6 H4] saving the tax rate again raises the SAME posting']],
  invoice_payment_receipt: [
    ['tests/accounting/invoice-payment-document-provenance.test.ts', '[o3d-j625 r5 HIGH 3]'],
    ['tests/accounting/deferred-receipt-redrive-wiring.test.ts', ''],
  ],
  credit_note_allocation: [['tests/connectors/xero-followup-origin-inheritance.test.ts', 'o3d-j625 r6 H3: a refused allocation leaves the inbox when a later sweep queues it']],
  unrealised_fx_journal: [['tests/accounting/fx-revaluation-refusal-and-connector-scope.test.ts', '[o3d-j625 r6 H4] a refused revaluation is raised again, under the SAME posting key, by re-running the date']],
  landed_cost_cogs_journal: [['tests/domain/purchasing/landed-cost-journal-outbox.test.ts', '[o3d-j625 r6 H4] the outbox retry raises the SAME landed-cost postings']],
  landed_cost_transit_journal: [['tests/domain/purchasing/landed-cost-journal-outbox.test.ts', '[o3d-j625 r6 H4] the outbox retry raises the SAME landed-cost postings']],
  refund_credit_note: [['tests/domain/sales/refund-service.test.ts', '[o3d-j625 r6 H4] Retry refund accounting raises the SAME refund postings']],
  refund_cogs_reversal: [['tests/domain/sales/refund-service.test.ts', '[o3d-j625 r6 H4] Retry refund accounting raises the SAME refund postings']],
  refund_unearned_reversal: [['tests/domain/sales/refund-service.test.ts', '[o3d-j625 r6 H4] Retry refund accounting raises the SAME refund postings']],
}

function testText(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8')
}

test('[o3d-j625 r6 H4] every AUTO kind rests on a test that drives its re-queue path', () => {
  const autoKinds = (Object.keys(POSTING_REFUSAL_KINDS) as PostingRefusalKind[]).filter((k) => POSTING_REFUSAL_KINDS[k].clearing === 'auto')
  assert.deepEqual(autoKinds.filter((k) => !(k in AUTO_PROOFS)), [], 'AUTO kinds with no proof named')
  for (const [kind, proofs] of Object.entries(AUTO_PROOFS)) {
    assert.equal(POSTING_REFUSAL_KINDS[kind as PostingRefusalKind]?.clearing, 'auto', `${kind} is listed as AUTO here and is not`)
    for (const [file, title] of proofs) {
      assert.ok(testText(file).includes(title), `${kind}: the proof "${title}" is not in ${file}`)
    }
  }
})

// ---------------------------------------------------------------------------------------------------
// MANUAL: nothing else raises the posting. Each kind names the files whose enqueues raise its
// (type, referenceType); any other producer fails here until the kind is reconsidered.
// ---------------------------------------------------------------------------------------------------
const MANUAL_PRODUCERS: Record<string, string[]> = {
  sales_invoice_order: ['app/actions/sales.ts', 'lib/connectors/woocommerce/sync/order-import.ts'],
  sales_invoice_import: ['app/actions/sales.ts', 'lib/connectors/woocommerce/sync/order-import.ts'],
  stock_adjustment_journal: ['lib/domain/inventory/stock-adjustment-apply.ts'],
  purchase_order_cancellation_reversal: ['lib/domain/purchasing/cancellation-service.ts'],
  supplier_return_reversal: ['app/actions/purchase-orders.ts'],
  stock_receipt_journal: ['app/actions/purchase-orders.ts'],
  purchase_invoice: ['app/actions/purchase-orders.ts'],
  realised_fx_bill_payment: ['app/actions/purchase-orders.ts'],
  realised_fx_receipt: ['app/actions/sales.ts'],
  manufacturing_journal: ['app/actions/manufacturing.ts'],
  manufacturing_reclass: ['app/actions/manufacturing.ts'],
  allocation_reversal: ['lib/domain/sales/allocation-service.ts'],
  landed_cost_cogs_journal_direct: ['lib/domain/purchasing/landed-cost-service.ts'],
  landed_cost_transit_journal_direct: ['lib/domain/purchasing/landed-cost-service.ts'],
}

test('[o3d-j625 r6 H4] every MANUAL kind\'s posting is raised only by the sites that refused it', () => {
  const sites = enqueueSites()
  const manualKinds = (Object.keys(POSTING_REFUSAL_KINDS) as PostingRefusalKind[]).filter((k) => POSTING_REFUSAL_KINDS[k].clearing === 'manual')
  assert.deepEqual(manualKinds.filter((k) => !(k in MANUAL_PRODUCERS)), [], 'MANUAL kinds with no producer list')
  for (const kind of manualKinds) {
    const spec = POSTING_REFUSAL_KINDS[kind]
    const producers = [...new Set(sites.filter((s) => s.type === spec.type && s.referenceType === spec.referenceType).map((s) => s.file))].sort()
    assert.ok(producers.length > 0, `${kind}: PRECONDITION — its producing enqueue was found`)
    assert.deepEqual(producers, [...MANUAL_PRODUCERS[kind]!].sort(),
      `${kind}: a new enqueue raises ${spec.type}/${spec.referenceType}. If it raises the SAME posting again, this `
      + 'kind now clears itself and must become AUTO (with a proof); if it raises a different one, add its file here.')
  }
})

// The daily batches and follow-ups create rows too, but never record a refusal (they are not refusal
// sites); what they create still clears a matching row through createAccountingSyncLogRow.
function walkTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walkTests(path, out)
    else if (path.endsWith('.test.ts')) out.push(path)
  }
  return out
}
test('[o3d-j625 r6 H4] PRECONDITION: the proofs named above are in files this suite runs', () => {
  const all = walkTests(join(process.cwd(), 'tests')).map((path) => path.slice(process.cwd().length + 1))
  for (const proofs of Object.values(AUTO_PROOFS)) for (const [file] of proofs) assert.ok(all.includes(file), file)
})

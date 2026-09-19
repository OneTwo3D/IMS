import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { aliasesOf, balancedFrom, blankNonCode, callOpens, ownProperty, productionSources } from './paid-provenance-scan'
import { renderPostingRefusalKindsDoc, POSTING_REFUSAL_KINDS_DOC_BEGIN, POSTING_REFUSAL_KINDS_DOC_END } from '@/lib/domain/accounting/posting-refusal-kinds-doc'
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

/**
 * o3d-j625 r7 (review MEDIUM 1): EVERY way a posting is raised, not only the facade and the in-transaction
 * enqueue — the connector queues, the follow-up enqueues and the row-creating primitive too. r6 read only
 * the first three, per FILE, so a second producer of a "manual" posting in a file already listed stayed
 * green (the reviewer's X1).
 */
const OBJECT_ENQUEUES = [
  'queueAccountingSync', 'queueAccountingSyncTx', 'queueAccountingSyncTxWithOutcome',
  'queueXeroSync', 'queueQuickBooksSync', 'createAccountingSyncLogRow',
]
const POSITIONAL_ENQUEUES = ['enqueueFollowUpSyncLog']

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

/** Split a balanced argument list `( … )` at its top-level commas, returning the SOURCE text of each. */
function topLevelArgs(args: string, source: string, open: number): string[] {
  const out: string[] = []
  let depth = 0
  let start = 1
  for (let i = 1; i < args.length - 1; i++) {
    const ch = args[i]!
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === ',' && depth === 0) { out.push(source.slice(open + start, open + i).trim()); start = i + 1 }
  }
  out.push(source.slice(open + start, open + args.length - 1).trim())
  return out.filter((a) => a !== '')
}

function enqueueSitesIn(files: Array<[string, string]>): EnqueueSite[] {
  const sites: EnqueueSite[] = []
  for (const [file, source] of files) {
    if (file === 'lib/domain/accounting/sync-log-row.ts') continue // the primitive's own declaration
    const code = blankNonCode(source)
    const objectNames = OBJECT_ENQUEUES.flatMap((name) => [name, ...aliasesOf(code, name)])
    const positionalNames = POSITIONAL_ENQUEUES.flatMap((name) => [name, ...aliasesOf(code, name)])
    for (const { at, open, name } of callOpens(code, [...objectNames, ...positionalNames])) {
      if (/(?:^|[^\w$])function\s+$/.test(code.slice(0, at))) continue
      const args = balancedFrom(code, open)
      const line = source.slice(0, at).split('\n').length
      if (positionalNames.includes(name)) {
        const [type, referenceType] = topLevelArgs(args, source, open)
        sites.push({ file, line, type: literal(type ?? null) ?? '(dynamic)', referenceType: literal(referenceType ?? null) ?? '(dynamic)', recordsRefusal: false })
        continue
      }
      const objectAt = args.indexOf('{')
      if (objectAt === -1) continue
      const blanked = balancedFrom(args, objectAt)
      const start = open + objectAt
      const objectText = source.slice(start, start + blanked.length)
      const type = literal(identityProperty(code, source, objectText, 'type'))
      const referenceType = literal(identityProperty(code, source, objectText, 'referenceType'))
      // `options.queueAccountingSync(tx, …)` in lib/cost-layers.ts is the INJECTED in-transaction enqueue
      // (typed `typeof queueAccountingSyncTx`), not the facade — as the chart census treats it.
      const injectedTx = /(?:^|[^\w$])options\.$/.test(code.slice(Math.max(0, at - 20), at))
      const isFacade = !injectedTx && (name === 'queueAccountingSync' || aliasesOf(code, 'queueAccountingSync').includes(name))
      const asks = /recordRefusalAsOutstanding:\s*true/.test(objectText)
      sites.push({ file, line, type: type ?? '(dynamic)', referenceType: referenceType ?? '(dynamic)', recordsRefusal: isFacade || asks })
    }
  }
  return sites
}

function enqueueSites(): EnqueueSite[] {
  return enqueueSitesIn(productionSources())
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
  tax_rate_sync: [['tests/accounting/posting-refusal-inbox.test.ts', '[o3d-j625 r6 H4] saving the tax rate again raises the SAME posting']],
}

function testText(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8')
}

/**
 * o3d-j625 r7 (review MEDIUM 1): a proof is a TEST, named by its full title and declared as one. r6 checked
 * `includes(title)`, so an entry with a blank title matched every file and could not fail.
 */
function declaresTest(text: string, title: string): boolean {
  if (title.trim() === '') return false
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "\\\\?'")
  return new RegExp(`(?:^|\\n)\\s*test\\(\\s*['\`]${escaped}`).test(text)
}

test('[o3d-j625 r6/r7 H4] every AUTO kind rests on a test that drives its re-queue path — named in full, declared as a test', () => {
  const autoKinds = (Object.keys(POSTING_REFUSAL_KINDS) as PostingRefusalKind[]).filter((k) => POSTING_REFUSAL_KINDS[k].clearing === 'auto')
  assert.deepEqual(autoKinds.filter((k) => !(k in AUTO_PROOFS)), [], 'AUTO kinds with no proof named')
  for (const [kind, proofs] of Object.entries(AUTO_PROOFS)) {
    assert.equal(POSTING_REFUSAL_KINDS[kind as PostingRefusalKind]?.clearing, 'auto', `${kind} is listed as AUTO here and is not`)
    assert.ok(proofs.length > 0, `${kind}: no proof`)
    for (const [file, title] of proofs) {
      assert.ok(declaresTest(testText(file), title), `${kind}: no test titled "${title}" in ${file}`)
    }
  }
})

test('[o3d-j625 r7] the proof check FIRES on a blank title and on a title that is only mentioned, not declared', () => {
  const text = "test('a real proof', () => {})\n// mentions 'another title' in a comment\n"
  assert.equal(declaresTest(text, ''), false, 'blank')
  assert.equal(declaresTest(text, '   '), false, 'whitespace')
  assert.equal(declaresTest(text, 'another title'), false, 'mentioned, not declared')
  assert.equal(declaresTest(text, 'a real proof'), true)
})

test('[o3d-j625 r7] every kind that is not AUTO is markable, and no AUTO kind is', async () => {
  const { postingRefusalMarkable } = await import('@/lib/domain/accounting/posting-refusal-kinds')
  for (const [kind, spec] of Object.entries(POSTING_REFUSAL_KINDS)) {
    assert.equal(postingRefusalMarkable(kind), spec.clearing !== 'auto', kind)
  }
})

// ---------------------------------------------------------------------------------------------------
// MANUAL: nothing else raises the posting. Each kind names the files whose enqueues raise its
// (type, referenceType); any other producer fails here until the kind is reconsidered.
// ---------------------------------------------------------------------------------------------------
/**
 * Per CALL SITE (o3d-j625 r7, review MEDIUM 1): the number of producing call sites in each file, so a second
 * producer in a file that is already listed changes the count and fails the test.
 */
const MANUAL_PRODUCERS: Record<string, Record<string, number>> = {
  sales_invoice_order: { 'app/actions/sales.ts': 1, 'lib/connectors/woocommerce/sync/order-import.ts': 2, 'lib/domain/accounting/invoice-payment-enqueue.ts': 0 },
  sales_invoice_import: { 'app/actions/sales.ts': 1, 'lib/connectors/woocommerce/sync/order-import.ts': 2 },
  stock_adjustment_journal: { 'lib/domain/inventory/stock-adjustment-apply.ts': 1 },
  purchase_order_cancellation_reversal: { 'lib/domain/purchasing/cancellation-service.ts': 1 },
  supplier_return_reversal: { 'app/actions/purchase-orders.ts': 1 },
  stock_receipt_journal: { 'app/actions/purchase-orders.ts': 1 },
  purchase_invoice: { 'app/actions/purchase-orders.ts': 1 },
  realised_fx_bill_payment: { 'app/actions/purchase-orders.ts': 1 },
  realised_fx_receipt: { 'app/actions/sales.ts': 1 },
  manufacturing_journal: { 'app/actions/manufacturing.ts': 1 },
  manufacturing_reclass: { 'app/actions/manufacturing.ts': 1 },
  allocation_reversal: { 'lib/domain/sales/allocation-service.ts': 1 },
}

function producerCounts(sites: EnqueueSite[], type: string, referenceType: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const site of sites) {
    if (site.type === type && site.referenceType === referenceType) counts[site.file] = (counts[site.file] ?? 0) + 1
  }
  return counts
}

const nonZero = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0).sort())

test('[o3d-j625 r6/r7 H4] every MANUAL kind\'s posting is raised only by the call sites that refused it', () => {
  const sites = enqueueSites()
  console.log(`[o3d-j625 r7] producing call sites read: ${sites.length}; dynamic: ${sites.filter((s) => s.type === '(dynamic)').length}`)
  const manualKinds = (Object.keys(POSTING_REFUSAL_KINDS) as PostingRefusalKind[]).filter((k) => POSTING_REFUSAL_KINDS[k].clearing === 'manual')
  assert.deepEqual(manualKinds.filter((k) => !(k in MANUAL_PRODUCERS)), [], 'MANUAL kinds with no producer list')
  for (const kind of manualKinds) {
    const spec = POSTING_REFUSAL_KINDS[kind]
    const found = producerCounts(sites, spec.type, spec.referenceType)
    assert.ok(Object.keys(found).length > 0, `${kind}: PRECONDITION — its producing call site was found`)
    assert.deepEqual(nonZero(found), nonZero(MANUAL_PRODUCERS[kind]!),
      `${kind}: the call sites raising ${spec.type}/${spec.referenceType} changed. If a new one raises the SAME `
      + 'posting again, this kind is retried by IMS and must become `retried`; otherwise add it here.')
  }
})

test('[o3d-j625 r7] X1: a SECOND producer in a file that is already listed is caught', () => {
  const file = 'app/actions/manufacturing.ts'
  const one = enqueueSitesIn([[file, `
    await queueAccountingSyncTx(tx, { type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', referenceId: id, payload, chartConnector })
  `]])
  const two = enqueueSitesIn([[file, `
    await queueAccountingSyncTx(tx, { type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', referenceId: id, payload, chartConnector })
    await enqueueFollowUpSyncLog('MANUFACTURING_JOURNAL', 'ProductionOrder', id, payload, origin)
    await createAccountingSyncLogRow(tx, { connector: 'xero', type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', referenceId: id })
    await queueXeroSync({ type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', referenceId: id, payload })
  `]])
  assert.deepEqual(producerCounts(one, 'MANUFACTURING_JOURNAL', 'ProductionOrder'), { [file]: 1 })
  assert.deepEqual(producerCounts(two, 'MANUFACTURING_JOURNAL', 'ProductionOrder'), { [file]: 4 },
    'a follow-up, a primitive call and a direct connector queue each count as a producer')
  assert.notDeepEqual(nonZero(producerCounts(two, 'MANUFACTURING_JOURNAL', 'ProductionOrder')), nonZero(MANUAL_PRODUCERS.manufacturing_journal!))
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

test('[o3d-j625 r7] help-docs/xero-sync.md carries exactly the classification the code enforces', () => {
  const doc = readFileSync(join(process.cwd(), 'help-docs/xero-sync.md'), 'utf8')
  const a = doc.indexOf(POSTING_REFUSAL_KINDS_DOC_BEGIN)
  const b = doc.indexOf(POSTING_REFUSAL_KINDS_DOC_END)
  assert.ok(a >= 0 && b > a, 'PRECONDITION: the generated block is in the doc')
  assert.equal(doc.slice(a, b + POSTING_REFUSAL_KINDS_DOC_END.length), renderPostingRefusalKindsDoc(),
    'the operator doc disagrees with posting-refusal-kinds.ts — regenerate it from renderPostingRefusalKindsDoc()')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { balancedFrom, blankNonCode, ownProperty, productionSources } from './paid-provenance-scan'

/**
 * o3d-j625 r3 (Codex HIGH 1, MEDIUM) — NO PRODUCTION ACCOUNTING ENQUEUE MAY DISCARD ITS ANSWER.
 *
 * r2 gave both enqueues a way to REFUSE and then left the answer on the floor: of 26 production call
 * sites, 13 discarded the return value outright. A refusal on such a site is a silent non-posting, and on
 * two of them it was worse — lib/cost-layers.ts recorded a COGS subledger movement for a journal the GL
 * never received, and the FX revaluation counted a refused reversal as done.
 *
 * WHY THIS IS THE ENFORCEMENT AND NOT A COMMENT. TypeScript has no `#[must_use]`: a `Promise<boolean>`
 * awaited as a bare statement compiles, and so does a stored result nobody reads. The two mechanisms the
 * compiler CAN offer were each checked and each found wanting here: switching `queueAccountingSyncTx`'s
 * return from `boolean` to an outcome OBJECT turns every existing `if (!queued)` into a condition that is
 * always false and still compiles — a silent inversion at sixteen sites — and a default-throw on refusal
 * would let a retired chart roll back stock receipts and bill edits, trading a silent non-posting for a
 * denial of service on the core workflow. So the call SHAPE is what is forced, universally: every call
 * must hand its answer to something. That is an ABSENCE check over every call site, not an existential
 * one over a list, so a site added next month is covered without anybody remembering to add it.
 *
 * WHAT COUNTS AS CONSUMED — each is a shape in which the answer demonstrably goes somewhere:
 *   assigned     `const x = await queue…(…)` / `x.outcome = await queue…(…)`, AND `x` is read again
 *                later in the same file (a stored-but-never-read result is the second shape of the defect)
 *   argument     `ledger.account(obligation, await queue…(…))` — handed straight to a consumer
 *   returned     `return queue…(…)` / `() => queue…(…)`
 *   reportOutcome the request carries an own `reportOutcome` callback, whose holder is then read — the
 *                in-transaction enqueue's out-channel for the WHOLE answer
 *
 * WHAT IT DOES NOT PROVE, deliberately stated: that each consumer does the RIGHT thing with a refusal.
 * That is behavioural and is pinned per finding — cost-layer-revaluation-declined-enqueue.test.ts,
 * fx-revaluation-refusal-and-connector-scope.test.ts, invoice-payment-document-provenance.test.ts and
 * purchase-invoice-update-sync.test.ts. Read this as "no answer is thrown away", never as "every answer
 * is handled well".
 */

/**
 * o3d-j625 r4 (Codex HIGH 4) — AND THE CONNECTOR QUEUES THEMSELVES.
 *
 * r3's census recognised only the facade names, and `lib/domain/sales/sales-invoice-update-sync.ts`
 * called `queueXeroSync` directly, discarded the answer and logged "queued" — the exact defect the census
 * existed for, escaping it by using a name it did not know. So the census now covers every function that
 * INSERTS an accounting sync row and can decline:
 *
 *   queueXeroSync / queueQuickBooksSync   the connector queues the facade delegates to
 *   enqueueFollowUpSyncLog                each connector's follow-up enqueuer (payments, PDFs, attachments,
 *                                         credit-note allocations)
 *
 * DELIBERATELY NOT COVERED: the two daily-batch `createPendingSyncLog`s. They cannot decline — they return
 * the new row's id or throw — so there is no refusal for a caller to discard, and "the id was not read"
 * is not this defect. Stated here so their absence is a decision, not an oversight.
 */
const CALLEES = [
  'queueAccountingSyncTxWithOutcome',
  'queueAccountingSyncTx',
  'queueAccountingSync',
  'queueXeroSync',
  'queueQuickBooksSync',
  'enqueueFollowUpSyncLog',
] as const

type Verdict = 'assigned-and-read' | 'argument' | 'returned' | 'reportOutcome' | 'DISCARDED' | 'STORED-UNREAD' | 'UNCLASSIFIED'

type Site = { file: string; line: number; callee: string; verdict: Verdict; detail?: string }

export function enqueueSites(file: string, source: string): Site[] {
  const code = blankNonCode(source)
  const sites: Site[] = []
  const seen = new Set<number>()
  for (const callee of CALLEES) {
    let from = 0
    for (;;) {
      const at = code.indexOf(callee, from)
      if (at === -1) break
      from = at + callee.length
      // Whole identifier only: `queueAccountingSync` must not match inside `queueAccountingSyncTx`.
      if (/[\w$]/.test(code[at + callee.length] ?? '')) continue
      if (at > 0 && /[\w$]/.test(code[at - 1])) continue
      if (seen.has(at)) continue
      let open = at + callee.length
      while (/\s/.test(code[open] ?? '')) open++
      // The parenthesised injected callee: `(options.queueAccountingSync ?? queueAccountingSyncTx)(tx, …)`.
      let calleeStart = at
      if (code[open] === ')') {
        const close = open
        open = close + 1
        while (/\s/.test(code[open] ?? '')) open++
        if (code[open] !== '(') continue
        let depth = 0
        let k = close
        for (; k >= 0; k--) {
          if (code[k] === ')') depth++
          else if (code[k] === '(') { depth--; if (depth === 0) break }
        }
        calleeStart = k
      } else {
        if (code[open] !== '(') continue // an import, a `typeof`, a type, a property declaration
        // `deps.queueAccountingSyncTx(` / `params.deps.queueAccountingSyncTx(` — include the member path.
        while (calleeStart > 0 && /[\w$.]/.test(code[calleeStart - 1])) calleeStart--
      }
      const before = code.slice(0, calleeStart)
      // The declaration of the enqueue itself is not a call.
      if (/(?:^|[^\w$])function\s+$/.test(before)) continue
      seen.add(at)
      const line = source.slice(0, at).split('\n').length
      const argument = balancedFrom(code, open)
      const end = open + argument.length
      const objectAt = argument.indexOf('{')
      const request = objectAt === -1 ? '' : balancedFrom(argument, objectAt)
      const hasReportOutcome = request !== '' && ownProperty(request, 'reportOutcome') !== null
      const prefix = before.replace(/\bawait\s*$/, '').replace(/\s+$/, '')
      // STARTS ITS OWN LINE: this repository writes without semicolons, so a call that is the first
      // token on its line after a line that ends a statement (a string, an identifier, a `)`) is a
      // statement of its own under ASI. Without this a discarded enqueue following `const key = 'k'`
      // read as UNCLASSIFIED — failing closed, but for the wrong reason.
      const startsLine = /\n[ \t]*(?:await[ \t]+)?$/.test(before)
      const verdict = classify(prefix, code.slice(end), hasReportOutcome, startsLine)
      sites.push({ file, line, callee, ...verdict })
    }
  }
  return sites.sort((a, b) => a.line - b.line)
}

function classify(prefix: string, after: string, hasReportOutcome: boolean, startsLine = false): { verdict: Verdict; detail?: string } {
  if (hasReportOutcome) return { verdict: 'reportOutcome' }
  // `return` must be on the SAME line to be returning THIS call: `if (…) return` on the line above is a
  // different statement, and reading it as a return classified a discarded enqueue as consumed.
  if ((!startsLine && /(?:^|[^\w$])return$/.test(prefix)) || /=>$/.test(prefix)) return { verdict: 'returned' }
  // `[` too: `outcomes = [await enqueue(…), …]`; and a SPREAD, `{ ...await queueXeroSync(…), connector }`,
  // which hands the answer's fields onward (the facade's own delegation).
  if (/[(,[]$/.test(prefix) || /\.\.\.$/.test(prefix)) return { verdict: 'argument' }
  // `x = await …` but not `==`, `===`, `!=`, `<=`, `>=`, `=>`.
  const assigned = prefix.match(/([\w$][\w$.]*)\s*=$/)
  if (assigned && !/[=!<>]=$/.test(prefix)) {
    const root = assigned[1].split('.')[0]
    const readLater = new RegExp(`(?:^|[^\\w$.])${root.replace(/\$/g, '\\$')}(?![\\w$])`).test(after)
    return readLater ? { verdict: 'assigned-and-read' } : { verdict: 'STORED-UNREAD', detail: root }
  }
  // A statement position: the answer goes nowhere.
  // …and a line-start after anything that cannot CONTINUE an expression (an operator, `?`, `:`, `.`,
  // `[` would continue it, and are left to fail closed).
  const continues = /[=+\-*/%&|^!<>?:.[]$/.test(prefix)
  if (prefix === '' || /[{};]$/.test(prefix) || /\)$/.test(prefix) || /(?:^|[^\w$])(?:else|do)$/.test(prefix) || (startsLine && !continues)) {
    return { verdict: 'DISCARDED' }
  }
  return { verdict: 'UNCLASSIFIED', detail: prefix.slice(-40) }
}

const CONSUMED: ReadonlySet<Verdict> = new Set(['assigned-and-read', 'argument', 'returned', 'reportOutcome'])

function allSites(): Site[] {
  return productionSources().flatMap(([file, source]) => enqueueSites(file, source))
}

test('[o3d-j625 r3] every production accounting enqueue HANDS ITS ANSWER TO SOMETHING', () => {
  const sites = allSites()
  // The precondition, and the floor is the real census: 26 production call sites were enumerated for
  // round 3 (plus the adapter's own call inside lib/accounting.ts). A floor, so a new site does not fail
  // this for the wrong reason; printed, so a shrinking sweep is visible.
  console.log(`[o3d-j625 r3] enqueue call sites examined: ${sites.length}`)
  // o3d-j625 r4: 46 — the r3 27 facade calls plus the direct connector queue calls (`queueXeroSync`,
  // `queueQuickBooksSync`, both processors' `enqueueFollowUpSyncLog`) the census now also covers.
  assert.ok(sites.length >= 46, `expected at least 46 enqueue call sites, found ${sites.length}: the detector is not seeing its subjects`)

  const bad = sites.filter((site) => !CONSUMED.has(site.verdict))
  assert.deepEqual(
    bad.map((site) => `${site.file}:${site.line} ${site.callee} ${site.verdict}${site.detail ? ` (${site.detail})` : ''}`),
    [],
    'these enqueues throw their answer away. A `refused` answer means the posting is still OWED, and a '
    + 'site that does not read it reports success over a silent non-posting (o3d-j625 r3). Assign it and '
    + 'act on it — see lib/domain/accounting/enqueue-outcome.ts for the shared report — or, in a '
    + 'transaction, capture it with `reportOutcome` and report it after the commit.',
  )
})

test('[o3d-j625 r3] the census covers every file r3 enumerated', () => {
  const files = new Set(allSites().map((site) => site.file))
  for (const expected of [
    'app/actions/manufacturing.ts',
    'app/actions/purchase-orders.ts',
    'app/actions/sales.ts',
    'lib/accounting-fx-revaluation.ts',
    'lib/accounting/tax-rate-sync-trigger.ts',
    'lib/connectors/woocommerce/sync/order-import.ts',
    'lib/cost-layers.ts',
    'lib/domain/accounting/invoice-payment-enqueue.ts',
    'lib/domain/inventory/stock-adjustment-apply.ts',
    'lib/domain/purchasing/cancellation-service.ts',
    'lib/domain/purchasing/landed-cost-service.ts',
    'lib/domain/purchasing/purchase-invoice-update-sync.ts',
    'lib/domain/sales/allocation-service.ts',
    // o3d-j625 r4: the direct connector queue callers.
    'lib/domain/sales/sales-invoice-update-sync.ts',
    'lib/connectors/xero/sync-processor.ts',
    'lib/connectors/quickbooks/sync-processor.ts',
  ]) {
    assert.ok(files.has(expected), `the census no longer examines ${expected}`)
  }
})

// ---------------------------------------------------------------------------------------------------
// THE DETECTOR CAN FIRE — each defect shape, and each accepted shape, on a fixture
// ---------------------------------------------------------------------------------------------------

function verdicts(source: string): Verdict[] {
  return enqueueSites('fixture.ts', source).map((site) => site.verdict)
}

test('[o3d-j625 r3] FIRES on a bare awaited facade enqueue — the fx-revaluation shape', () => {
  assert.deepEqual(verdicts(`
    for (const prior of priors) {
      await queueAccountingSync({ type: 'UNREALISED_FX_JOURNAL', payload, chartConnector })
      reversed += 1
    }
  `), ['DISCARDED'])
})

test('[o3d-j625 r3] FIRES on the parenthesised injected in-transaction enqueue — the cost-layers shape', () => {
  assert.deepEqual(verdicts(`
    const key = 'k'
    await (options.queueAccountingSync ?? queueAccountingSyncTx)(tx, { type: 'COGS_REVERSAL', payload, chartConnector })
    await recordCogsSubledgerMovement(tx, {})
    return true
  `), ['DISCARDED'])
})

test('[o3d-j625 r3] FIRES on an injected member enqueue, and on a stored result nobody reads', () => {
  assert.deepEqual(verdicts(`
    async function f() {
      await deps.queueAccountingSyncTx(tx, { type: 'X', payload, chartConnector })
      const queued = await params.deps.queueAccountingSyncTx(tx, { type: 'Y', payload, chartConnector })
      return 'queued'
    }
  `), ['DISCARDED', 'STORED-UNREAD'])
})

test('[o3d-j625 r3] ACCEPTS an assigned-and-read result, an argument, a return, and a reportOutcome capture', () => {
  assert.deepEqual(verdicts(`
    const enqueued = await queueAccountingSync({ type: 'A', payload, chartConnector })
    if (postingIsOwed(enqueued)) report()
    ledger.account(obligation, await queueAccountingSync({ type: 'B', payload, chartConnector }))
    const run = () => queueAccountingSyncTxWithOutcome(tx, { type: 'C', payload, chartConnector })
    await queueAccountingSyncTx(tx, { type: 'D', payload, chartConnector, reportOutcome: (o) => { holder.outcome = o } })
  `), ['assigned-and-read', 'argument', 'returned', 'reportOutcome'])
})

test('[o3d-j625 r3] a comment or a string that mentions an enqueue is not a site, and neither is a declaration or a type', () => {
  assert.deepEqual(verdicts(`
    // await queueAccountingSync({ type: 'X' })
    const text = 'await queueAccountingSyncTx(tx, {})'
    export async function queueAccountingSync(params: Params) {}
    type P = Parameters<typeof queueAccountingSyncTx>[1]
    import { queueAccountingSync } from '@/lib/accounting'
  `), [])
})

test('[o3d-j625 r3] an unrecognised prefix FAILS CLOSED as UNCLASSIFIED rather than passing', () => {
  assert.deepEqual(verdicts(`
    const x = cond ? await queueAccountingSync({ type: 'X', payload, chartConnector }) : null
  `), ['UNCLASSIFIED'])
})

test('[o3d-j625 r4] FIRES on a discarded DIRECT connector queue call — the sales-invoice-update shape', () => {
  assert.deepEqual(verdicts(`
    if (!(await deps.isAccountingSyncTypeEnabled('SALES_INVOICE_UPDATE'))) return
    await deps.queueXeroSync({ type: 'SALES_INVOICE_UPDATE', payload })
    await deps.logActivity({ action: 'sales_invoice_update_queued' })
  `), ['DISCARDED'])
  assert.deepEqual(verdicts(`
    await queueQuickBooksSync({ type: 'X', payload })
    const outcome = await enqueueFollowUpSyncLog('INVOICE_PDF', ref, id, payload, origin)
  `), ['DISCARDED', 'STORED-UNREAD'])
})

test('[o3d-j625 r4] ACCEPTS the facade’s own spread delegation to a connector queue', () => {
  assert.deepEqual(verdicts(`
    return { ...await queueXeroSync({ ...params, pinnedLedger: params.connector }), connector }
  `), ['argument'])
})

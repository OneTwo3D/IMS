import assert from 'node:assert/strict'
import test from 'node:test'

import { balancedFrom, blankNonCode, productionSources, SHORTHAND } from './paid-provenance-scan'

/**
 * o3d-j625 — EVERY FACADE ACCOUNTING ENQUEUE SAYS WHOSE CHART ITS ACCOUNT CODES CAME FROM.
 *
 * WHY A CENSUS AND NOT A LIST OF THE SITES FIXED. The o3d-j625 triage named three call sites in
 * app/actions/sales.ts. Sweeping `queueAccountingSync` found ELEVEN, in six files — the WooCommerce
 * import, the held-invoice release, the AR/AP FX revaluation loop, the bill-payment FX journal, the
 * inventory-adjustment journal, the tax-rate sync. That ratio is the finding: this is not a defect in
 * three functions, it is the default behaviour of an API, and a list of eleven files passes for ever
 * once written while saying nothing about the enqueue somebody adds next month. This repository has
 * been bitten by exactly that shape before — see the o3d-psrx paid-provenance censuses this file
 * borrows its scanner from, and o3d-d0pd's three independently-drifting copies of the already-present
 * check.
 *
 * THE RULE. Every call to the FACADE enqueue `queueAccountingSync(` in app/ or lib/ names either
 * `chartConnector` (the connector whose chart of accounts the payload's codes came from) or `connector`
 * (the o3d-i0o6 pin, which is strictly stronger — it routes by the named ledger AND holds the check
 * under the plugin-selection lock). Naming neither means the row's connector is resolved independently
 * of the codes in its payload, which is the defect.
 *
 * IT FAILS CLOSED. A call whose argument this cannot read is reported as a hole in the detector, not
 * skipped: a scanner that silently passes what it cannot parse is a scanner that reports a clean
 * invariant over source it never examined. The match count is asserted too — three tests on one branch
 * of this repository once passed while examining nothing.
 *
 * WHAT IT DOES NOT PROVE, and this is deliberate rather than an oversight. It proves that every
 * enqueue is ATTRIBUTED. It cannot prove that the connector named is the RIGHT one — `chartConnector:
 * settings.connector` where `settings` is the wrong settings object satisfies this and is still wrong.
 * That half is established per site by review, and behaviourally for the mechanism itself in
 * tests/accounting/chart-connector-routing.test.ts, which drives the real facade through the real
 * interleaving. Read this as "no facade enqueue is unattributed", never as "every attribution is
 * correct".
 *
 * THE IN-TRANSACTION FAMILY IS SWEPT TOO, AND r1's DECISION NOT TO WAS OVERRULED (r2, Codex HIGH 1).
 *
 * r1 wrote, in this very comment, that `queueAccountingSyncTx`'s other callers "have the same defect
 * through a different seam" and filed them as o3d-jndi — while also writing that "a census that excused
 * most of its subjects would be worse than no census". Both halves cannot be true at once, and the
 * reviewer resolved it the other way: eleven swept sites and sixteen excused ones IS a census that
 * excuses most of its subjects, and "the same defect through a different seam" is the same defect. So
 * the transactional family — `queueAccountingSyncTx`, `queueAccountingSyncTxWithOutcome`, and the
 * injected form in lib/cost-layers.ts — is swept by the same rule below, and o3d-jndi's content is here.
 *
 * AND THE PARAMETER IS REQUIRED ON BOTH DECLARATIONS, which is the guard this census cannot be. A
 * source-text sweep says "every call I can see names it"; it cannot say "a call that does not name it is
 * impossible". A required parameter can, and the declaration test below is what keeps it required —
 * because the moment a `?` goes back on, every site this census reads becomes optional again and the
 * detector's own fixtures are the only thing left proving it could ever have fired.
 */

/**
 * The value of an OWN top-level property `key` of the object literal `objectText`, or null.
 *
 * NOT the shared scanner's `topLevelProperty`, and the difference is a hole this census actually fell
 * into. That helper treats any occurrence of the key at brace depth 1 whose preceding character is not
 * a word character as a property — so in
 *
 *     queueAccountingSync({ type: 'SALES_INVOICE', payload, chartConnector: settings.connector })
 *
 * it reads the `connector` of `settings.connector` as a SHORTHAND `connector` property of the enqueue
 * itself, i.e. as a PIN. Every chartered site therefore also scored as pinned, which means the "or pins
 * the ledger" arm of the rule was satisfiable by an accidental member access — and the mutation that
 * removed `chartConnector: settings.connector` from a site could have gone red for the wrong reason,
 * because it removed the decoy member access in the same stroke. A `.` before the key disqualifies it
 * here, so a member access is never a property, and the M5b mutation below keeps that honest: it leaves
 * the member access in place and removes only the property.
 *
 * Shorthand still counts — `{ ...request, chartConnector }` is the same attribution with the colon left
 * off — reported as the shared scanner's SHORTHAND sentinel so the two agree on that much.
 */
export function ownProperty(objectText: string, key: string): string | null {
  let depth = 0
  for (let i = 0; i < objectText.length; i++) {
    const ch = objectText[i]
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; continue }
    if (depth !== 1) continue
    if (!objectText.startsWith(key, i)) continue
    // `.` as well as the word characters: `settings.connector` is a member access, not a property.
    if (i > 0 && /[\w$.]/.test(objectText[i - 1])) continue
    const rest = objectText.slice(i + key.length)
    // And the key must END here, so `connector` is not matched inside `connectorSomething`.
    if (/^[\w$]/.test(rest)) continue
    if (/^\s*[,}]/.test(rest)) return SHORTHAND
    const colon = rest.match(/^\s*:/)
    if (!colon) continue
    let j = i + key.length + colon[0].length
    while (j < objectText.length && /\s/.test(objectText[j])) j++
    if ('({['.includes(objectText[j])) return balancedFrom(objectText, j)
    let k = j
    let d = 0
    while (k < objectText.length) {
      const c = objectText[k]
      if ('({['.includes(c)) d++
      else if (')}]'.includes(c)) { if (d === 0) break; d-- }
      else if (c === ',' && d === 0) break
      k++
    }
    return objectText.slice(j, k).trim()
  }
  return null
}

const FACADE_CALL = 'queueAccountingSync('

type Site = {
  file: string
  line: number
  /**
   * The argument source with comments and string BODIES blanked, or null when the detector could not
   * read it. Structure is analysed on this: a `{` inside a comment or a string would wreck the brace
   * balance the whole analysis rests on.
   */
  argument: string | null
  /**
   * The SAME span of the untouched source. `blankNonCode` preserves length, so the two are index-for-
   * index aligned and this is the original text of exactly the same characters. Needed to LOCATE a
   * particular enqueue by the idempotency key it carries, which is a string and is therefore blank in
   * `argument`.
   */
  raw: string | null
  namesChart: boolean
  namesPin: boolean
}

function facadeCallSites(file: string, source: string): Site[] {
  const code = blankNonCode(source)
  const sites: Site[] = []
  let from = 0
  for (;;) {
    const at = code.indexOf(FACADE_CALL, from)
    if (at === -1) break
    from = at + FACADE_CALL.length
    // `options.queueAccountingSync(...)` is the INJECTED in-transaction enqueue in lib/cost-layers.ts,
    // not this facade; and `queueAccountingSyncTx(` does not match this needle at all because the
    // needle ends in the open paren.
    if (at > 0 && /[\w$.]/.test(code[at - 1])) continue
    // The facade's own DECLARATION in lib/accounting.ts — `export async function queueAccountingSync(`
    // — is not a call site. Recognised by the `function` keyword before the name rather than by
    // excluding the file, so lib/accounting.ts is still swept for any call it makes itself.
    if (/(?:^|[^\w$])function\s+$/.test(code.slice(0, at))) continue
    const line = source.slice(0, at).split('\n').length
    const open = at + FACADE_CALL.length - 1
    const argument = balancedFrom(code, open)
    // The detector reads an OBJECT LITERAL argument. Anything else — a variable, a spread of a
    // pre-built request — is a hole, and it is reported as one.
    const objectAt = argument.indexOf('{')
    const readable = objectAt === 1 && argument.endsWith(')')
    const objectText = readable ? balancedFrom(argument, objectAt) : null
    sites.push({
      file,
      line,
      argument: objectText,
      raw: objectText === null ? null : source.slice(open + objectAt, open + objectAt + objectText.length),
      namesChart: objectText !== null && ownProperty(objectText, 'chartConnector') !== null,
      namesPin: objectText !== null && ownProperty(objectText, 'connector') !== null,
    })
  }
  return sites
}

function allFacadeCallSites(): Site[] {
  return productionSources().flatMap(([file, source]) => facadeCallSites(file, source))
}

test('[o3d-j625] every facade accounting enqueue in app/ and lib/ names the chart its account codes came from (or pins the ledger)', () => {
  const sites = allFacadeCallSites()

  // THE PRECONDITION, ASSERTED. If the walk or the needle ever stops finding these calls, the
  // invariant below is vacuous — it would pass over an empty list. The floor is the eleven sites the
  // o3d-j625 sweep enumerated; it is a floor and not an equality so that adding an enqueue does not
  // fail this test for the wrong reason.
  assert.ok(
    sites.length >= 11,
    `expected to find at least the 11 facade enqueue call sites the o3d-j625 sweep enumerated, found `
    + `${sites.length}. The detector is not examining the source it claims to.`,
  )

  const unreadable = sites.filter((site) => site.argument === null)
  assert.deepEqual(
    unreadable.map((site) => `${site.file}:${site.line}`),
    [],
    'the detector could not read the argument of these calls. FAIL CLOSED: a call this cannot parse is '
    + 'a hole in the census, not a passing site. Extend the detector rather than relaxing it.',
  )

  const unattributed = sites
    .filter((site) => !site.namesChart && !site.namesPin)
    .map((site) => `${site.file}:${site.line}`)
  assert.deepEqual(
    unattributed,
    [],
    'these enqueues let lib/accounting.ts resolve the active connector a SECOND time, independently of '
    + 'the read that produced the account codes in their payload (o3d-j625). Pass `chartConnector: '
    + '<settings>.connector` — the connector the chart came from — or `connector` where the ledger is '
    + 'proved.',
  )
})

test('[o3d-j625] the census names the sites it examined, so a shrinking sweep is visible', () => {
  const files = [...new Set(allFacadeCallSites().map((site) => site.file))].sort()
  // Not an equality on the whole list: that would fail on an unrelated new enqueue. These six are the
  // files o3d-j625's sweep found, and a sweep that stops covering one of them is a sweep that regressed.
  for (const expected of [
    'app/actions/purchase-orders.ts',
    'app/actions/sales.ts',
    'lib/accounting-fx-revaluation.ts',
    'lib/accounting/tax-rate-sync-trigger.ts',
    'lib/connectors/woocommerce/sync/order-import.ts',
    'lib/domain/inventory/stock-adjustment-apply.ts',
  ]) {
    assert.ok(files.includes(expected), `the census no longer examines ${expected}. Files: ${files.join(', ')}`)
  }
})

// ---------------------------------------------------------------------------------------------
// THE DETECTOR CAN FIRE — the half that stops this being a rule nothing can break
// ---------------------------------------------------------------------------------------------

test('[o3d-j625] the detector FIRES on an unattributed enqueue', () => {
  const fixture = `
    const settings = await getAccountingSettings()
    await queueAccountingSync({
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      referenceId: so.id,
      payload: { lines: [{ accountCode: settings.salesAccount }] },
    })
  `
  const sites = facadeCallSites('fixture.ts', fixture)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].namesChart, false)
  assert.equal(sites[0].namesPin, false)
})

test('[o3d-j625] the detector ACCEPTS a chartered enqueue, and a pinned one', () => {
  const charted = facadeCallSites('fixture.ts', `
    await queueAccountingSync({ type: 'SALES_INVOICE', payload, chartConnector: settings.connector })
  `)
  assert.equal(charted.length, 1)
  assert.equal(charted[0].namesChart, true)

  const pinned = facadeCallSites('fixture.ts', `
    await queueAccountingSync({ type: 'ALLOCATION_REVERSAL', payload, connector: provedOn })
  `)
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0].namesPin, true)
})

test('[o3d-j625] a NESTED chartConnector does not satisfy the rule — the property must be the enqueue’s own', () => {
  // The hole a substring search would have: a `chartConnector` belonging to some inner object says
  // nothing about which connector THIS row is routed by.
  const sites = facadeCallSites('fixture.ts', `
    await queueAccountingSync({
      type: 'SALES_INVOICE',
      payload: { held: { chartConnector: 'xero' } },
    })
  `)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].namesChart, false, 'a nested property must not count as the call naming a chart')
})

test('[o3d-j625] a MEMBER ACCESS is not a property: `settings.connector` alone attributes nothing', () => {
  // The hole the shared scanner has, and the reason this file carries its own property reader. A site
  // that merely MENTIONS `<something>.connector` — which every chartered site does, in the value of its
  // own `chartConnector` — must not thereby count as having pinned the ledger.
  const sites = facadeCallSites('fixture.ts', `
    await queueAccountingSync({
      type: 'SALES_INVOICE',
      payload: { lines: [{ accountCode: settings.salesAccount }] },
      idempotencyKey: keyFor(settings.connector),
    })
  `)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].namesPin, false, 'a member access must not read as a shorthand `connector` property')
  assert.equal(sites[0].namesChart, false)

  // And a key that merely STARTS with the name is not the name.
  const prefixed = facadeCallSites('fixture.ts', `
    await queueAccountingSync({ type: 'SALES_INVOICE', payload, connectorHint: 'xero' })
  `)
  assert.equal(prefixed[0].namesPin, false)
})

test('[o3d-j625] the detector FAILS CLOSED on an argument it cannot read', () => {
  const sites = facadeCallSites('fixture.ts', 'await queueAccountingSync(request)')
  assert.equal(sites.length, 1)
  assert.equal(sites[0].argument, null, 'a non-literal argument is a hole, and must be reported as one')
  assert.equal(sites[0].namesChart, false)
  assert.equal(sites[0].namesPin, false)
})

test('[o3d-j625] the detector ignores the facade’s own declaration, but still sweeps the file it lives in', () => {
  const sites = facadeCallSites('lib/accounting.ts', `
    export async function queueAccountingSync(params: {
      type: AccountingSyncType
    }): Promise<AccountingEnqueueOutcome> {
      return { queued: false, reason: 'not-configured', connector: null }
    }
    async function somethingElse() {
      await queueAccountingSync({ type: 'SALES_INVOICE', payload })
    }
  `)
  assert.equal(sites.length, 1, 'the declaration is not a call; the call below it still is')
  assert.equal(sites[0].namesChart, false)
})

test('[o3d-j625] the detector ignores prose, the Tx enqueue, and the injected in-transaction enqueue', () => {
  const sites = facadeCallSites('fixture.ts', `
    // queueAccountingSync(  in a comment, with an open paren
    /** {@link queueAccountingSync(} */
    const message = 'queueAccountingSync({ type })'
    await queueAccountingSyncTx(tx, { type: 'COGS_JOURNAL' })
    await (options.queueAccountingSync ?? queueAccountingSyncTx)(tx, { type: 'COGS_JOURNAL' })
    await options.queueAccountingSync({ type: 'COGS_JOURNAL' })
  `)
  assert.deepEqual(sites, [], `nothing here is a facade enqueue: ${JSON.stringify(sites)}`)
})

// ---------------------------------------------------------------------------------------------
// THE TWO SITES o3d-j625 CONFIRMED: the chart and the row come from the SAME settings object
// ---------------------------------------------------------------------------------------------

/**
 * `X.connector` where X is an identifier, or null.
 *
 * This is the shape that makes the rule hold: the chart OBJECT names its own connector, so
 * `chartConnector` is not a separate fact a caller can get wrong — it is the same read that produced
 * the account codes. A `chartConnector` computed any other way (a resolver call, a variable set
 * elsewhere) is exactly the second resolution o3d-j625 is about, so it is rejected here rather than
 * accepted as "well, it names something".
 */
function chartObjectOf(value: string | null): string | null {
  if (value === null) return null
  const match = /^([A-Za-z_$][\w$]*)\.connector$/.exec(value.trim())
  return match ? match[1] : null
}

function siteCarrying(sites: Site[], marker: string): Site {
  const found = sites.filter((site) => site.raw !== null && site.raw.includes(marker))
  assert.equal(
    found.length,
    1,
    `expected exactly one facade enqueue carrying ${marker}, found ${found.length}. The locator, not `
    + 'the invariant, is what failed — fix it rather than the assertion.',
  )
  return found[0]
}

test('[o3d-j625 SITE 1: the sales invoice] the row is routed by the SAME settings object the line account codes come from', () => {
  const source = productionSources().find(([file]) => file === 'app/actions/sales.ts')
  assert.ok(source, 'app/actions/sales.ts was not scanned')
  const sites = facadeCallSites(source[0], source[1])

  const site = siteCarrying(sites, 'sales-invoice:')
  const chartObject = chartObjectOf(ownProperty(site.argument!, 'chartConnector'))
  assert.ok(
    chartObject,
    'the SALES_INVOICE enqueue must route by a chart object\u2019s own connector '
    + `(\`<settings>.connector\`), got ${JSON.stringify(ownProperty(site.argument!, 'chartConnector'))}`,
  )

  // AND IT IS THE OBJECT THE ACCOUNT CODES CAME FROM. `queueSalesInvoiceForOrder` reads
  // `settings.salesAccount` onto every line, `settings.shippingAccount` and `settings.discountAccount`
  // onto the shipping and discount lines. Routing by any OTHER object's connector would satisfy the
  // census above and still be the defect.
  const fn = source[1].slice(source[1].indexOf('async function queueSalesInvoiceForOrder'))
  for (const code of ['salesAccount', 'shippingAccount', 'discountAccount']) {
    assert.ok(
      fn.includes(`${chartObject}.${code}`),
      `the payload reads an account code from something other than ${chartObject}: expected `
      + `${chartObject}.${code} in queueSalesInvoiceForOrder`,
    )
  }
})

test('[o3d-j625 SITE 2: the refund credit note] the obligation pin and the credit note come from ONE resolution', () => {
  const source = productionSources().find(([file]) => file === 'app/actions/sales.ts')
  assert.ok(source, 'app/actions/sales.ts was not scanned')
  const code = blankNonCode(source[1])

  const site = siteCarrying(facadeCallSites(source[0], source[1]), ':credit-note')
  const chartObject = chartObjectOf(ownProperty(site.argument!, 'chartConnector'))
  assert.ok(chartObject, 'the CREDIT_NOTE enqueue must route by a chart object\u2019s own connector')

  // THE PIN. `openRefundAccountingObligationLedger` takes the connector every answer in the hand-off is
  // checked against. It used to resolve the active connector for itself, which is what let a flip
  // between the chart read and the pin leave BOTH of them agreeing on the new connector while the
  // credit note carried the old one's account codes — and `settle()` then cleared
  // `accountingRetryRequired` over it.
  const ledgerAt = code.indexOf('openRefundAccountingObligationLedger(')
  assert.ok(ledgerAt > 0, 'the refund obligation ledger is no longer opened in app/actions/sales.ts')
  const ledgerArgs = balancedFrom(code, ledgerAt + 'openRefundAccountingObligationLedger'.length)
  const depsAt = ledgerArgs.indexOf('{')
  assert.ok(depsAt > 0, 'could not read the ledger dependencies object')
  const deps = balancedFrom(ledgerArgs, depsAt)
  const activeConnector = ownProperty(deps, 'activeConnector')
  assert.ok(activeConnector, 'the ledger no longer takes an activeConnector dependency')

  assert.ok(
    !/getActiveAccountingConnector/.test(activeConnector),
    'the obligation pin resolves the active connector a SECOND time (o3d-j625). It must be the chart\u2019s '
    + `own connector \u2014 ${chartObject}.connector \u2014 so the ledger\u2019s connector check compares the row `
    + `against the read that produced the codes. Got: ${activeConnector}`,
  )
  assert.equal(
    chartObjectOf(activeConnector.replace(/^async\s*\(\s*\)\s*=>\s*/, '')),
    chartObject,
    `the pin and the credit note must come from the SAME object. Pin: ${activeConnector}; credit note: `
    + `${chartObject}.connector`,
  )
})

test('[o3d-j625] the SITE detectors can fire: a re-resolved pin and a foreign chart object are both caught', () => {
  // The pre-fix shape of the pin, verbatim.
  const reResolved = 'async () => (await getActiveAccountingConnectorInfo())?.id ?? null'
  assert.ok(/getActiveAccountingConnector/.test(reResolved), 'the pin check would not have fired on the defect')
  assert.equal(chartObjectOf(reResolved.replace(/^async\s*\(\s*\)\s*=>\s*/, '')), null)

  // A chart named from some other object satisfies the census but not the site rule.
  assert.equal(chartObjectOf('someOtherSettings.connector'), 'someOtherSettings')
  assert.notEqual(chartObjectOf('someOtherSettings.connector'), 'settings')
  // And a chartConnector that is not an object\u2019s own connector at all.
  assert.equal(chartObjectOf("'xero'"), null)
  assert.equal(chartObjectOf('await resolveConnector()'), null)
  assert.equal(chartObjectOf(null), null)
})

// ---------------------------------------------------------------------------------------------
// o3d-j625 r2 (Codex HIGH 1) — THE TRANSACTIONAL FAMILY, SWEPT BY THE SAME RULE
//
// `queueAccountingSyncTx` writes the sync row inside a CALLER's transaction; it takes the same
// `chartConnector`, with the same meaning, and its callers had the same defect. Three call shapes
// exist and all three are production shapes, so all three are needles:
//
//   queueAccountingSyncTx(tx, { … })                            direct, and `deps.`/`params.deps.`-
//                                                               qualified (the injected form in
//                                                               cancellation-service and
//                                                               purchase-invoice-update-sync)
//   queueAccountingSyncTxWithOutcome(tx, { … })                 the outcome-reporting adapter
//   (options.queueAccountingSync ?? queueAccountingSyncTx)(tx, …)  lib/cost-layers.ts's injected form
//
// The third one is why the needles are not simply "an identifier followed by (": the callee there is a
// parenthesised expression, so the argument list opens after a `)`. A sweep that missed it would have
// silently excused the site with the WIDEST window in the whole family — a landed-cost recalculation
// that has already taken cost-layer and stock locks and enqueues once per affected shipment.
// ---------------------------------------------------------------------------------------------

const TX_CALLS = [
  'queueAccountingSyncTxWithOutcome(',
  'queueAccountingSyncTx(',
  // The parenthesised-callee form. Listed as its own needle rather than handled by a cleverer parser:
  // one more literal is cheaper to read, and cheaper to be sure of, than a callee-expression grammar.
  'queueAccountingSyncTx)(',
] as const

/**
 * The SECOND argument of an argument list `(a, b, …)`, or null when there is no second argument.
 *
 * Both transactional enqueues take the transaction first and the request second, so unlike the facade
 * the object of interest is not the first thing inside the parens. Top-level commas only — a comma
 * inside the transaction expression or inside the request object is not an argument separator.
 */
export function secondArgument(argumentList: string): string | null {
  let depth = 0
  let firstEnded = -1
  for (let i = 0; i < argumentList.length; i++) {
    const ch = argumentList[i]
    if ('({['.includes(ch)) { depth++; continue }
    if (')}]'.includes(ch)) {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth === 1 && ch === ',') { firstEnded = i; break }
  }
  if (firstEnded === -1) return null
  let j = firstEnded + 1
  while (j < argumentList.length && /\s/.test(argumentList[j])) j++
  if (argumentList[j] !== '{') return null
  return balancedFrom(argumentList, j)
}

function txCallSites(file: string, source: string): Site[] {
  const code = blankNonCode(source)
  const sites: Site[] = []
  for (const needle of TX_CALLS) {
    let from = 0
    for (;;) {
      const at = code.indexOf(needle, from)
      if (at === -1) break
      from = at + needle.length
      // `queueAccountingSyncTxWithOutcome(` starts with neither of the other needles' text followed by
      // `(`, so the three cannot double-count one call. A qualified callee (`deps.`, `params.deps.`) IS
      // counted — that is the real enqueue in production — but the DECLARATIONS in lib/accounting.ts are
      // not calls, and are recognised by the `function` keyword rather than by excluding the file.
      if (/(?:^|[^\w$])function\s+$/.test(code.slice(0, at))) continue
      const line = source.slice(0, at).split('\n').length
      const open = at + needle.length - 1
      const argumentList = balancedFrom(code, open)
      const objectText = secondArgument(argumentList)
      sites.push({
        file,
        line,
        argument: objectText,
        raw: objectText === null
          ? null
          : source.slice(open + argumentList.indexOf(objectText), open + argumentList.indexOf(objectText) + objectText.length),
        namesChart: objectText !== null && ownProperty(objectText, 'chartConnector') !== null,
        namesPin: objectText !== null && ownProperty(objectText, 'connector') !== null,
      })
    }
  }
  return sites
}

function allTxCallSites(): Site[] {
  return productionSources().flatMap(([file, source]) => txCallSites(file, source))
}

test('[o3d-j625 r2] every IN-TRANSACTION accounting enqueue in app/ and lib/ names the chart its account codes came from', () => {
  const sites = allTxCallSites()

  // THE PRECONDITION, ASSERTED, AND THE FLOOR IS THE REAL TOTAL. r1's floor of 11 was the facade alone;
  // the transactional sweep found SIXTEEN more — five in app/actions/purchase-orders.ts, two in
  // app/actions/manufacturing.ts, two in lib/domain/purchasing/landed-cost-service.ts, and one each in
  // app/actions/sales.ts, lib/accounting.ts, lib/cost-layers.ts,
  // lib/domain/accounting/invoice-payment-enqueue.ts, lib/domain/purchasing/cancellation-service.ts,
  // lib/domain/purchasing/purchase-invoice-update-sync.ts and lib/domain/sales/allocation-service.ts.
  // A floor rather than an equality so a new enqueue does not fail this test for the wrong reason.
  assert.ok(
    sites.length >= 16,
    `expected at least the 16 in-transaction enqueue call sites the o3d-j625 r2 sweep enumerated, found `
    + `${sites.length}. The detector is not examining the source it claims to.`,
  )

  const unreadable = sites.filter((site) => site.argument === null)
  assert.deepEqual(
    unreadable.map((site) => `${site.file}:${site.line}`),
    [],
    'the detector could not read the request argument of these calls. FAIL CLOSED: a call this cannot '
    + 'parse is a hole in the census, not a passing site.',
  )

  const unattributed = sites
    .filter((site) => !site.namesChart)
    .map((site) => `${site.file}:${site.line}`)
  assert.deepEqual(
    unattributed,
    [],
    'these in-transaction enqueues do not say whose chart of accounts their payload was built from '
    + '(o3d-j625). Pass `chartConnector: <settings>.connector`. NOTE: unlike the facade rule above, a '
    + '`connector` PIN does not excuse a missing chart here — the pin is a proof about a LEDGER and '
    + 'says nothing about whose account NUMBERS are on the page, and `refuseUnattributableChart` '
    + 'refuses the two when they disagree, so naming both is what makes the agreement checked rather '
    + 'than assumed.',
  )
})

test('[o3d-j625 r2] the whole census — facade plus transactional — is at least 27 sites', () => {
  // The number r1's scoping decision turned into "11 fixed, 16 filed". It is asserted as ONE total so
  // that shrinking either half is visible even if the other half grows.
  const total = allFacadeCallSites().length + allTxCallSites().length
  assert.ok(
    total >= 27,
    `the o3d-j625 sweep covers 27 accounting enqueue call sites (11 facade + 16 in-transaction); the `
    + `census now sees ${total}. A census that stops seeing its subjects proves nothing about them.`,
  )
})

test('[o3d-j625 r2] the transactional census names the files it examined, so a shrinking sweep is visible', () => {
  const files = [...new Set(allTxCallSites().map((site) => site.file))].sort()
  for (const expected of [
    'app/actions/manufacturing.ts',
    'app/actions/purchase-orders.ts',
    'app/actions/sales.ts',
    'lib/accounting.ts',
    'lib/cost-layers.ts',
    'lib/domain/accounting/invoice-payment-enqueue.ts',
    'lib/domain/purchasing/cancellation-service.ts',
    'lib/domain/purchasing/landed-cost-service.ts',
    'lib/domain/purchasing/purchase-invoice-update-sync.ts',
    'lib/domain/sales/allocation-service.ts',
  ]) {
    assert.ok(files.includes(expected), `the census no longer examines ${expected}. Files: ${files.join(', ')}`)
  }
})

// ---------------------------------------------------------------------------------------------
// THE TRANSACTIONAL DETECTOR CAN FIRE
// ---------------------------------------------------------------------------------------------

test('[o3d-j625 r2] the transactional detector FIRES on an unattributed in-transaction enqueue', () => {
  const sites = txCallSites('fixture.ts', `
    const settings = await getAccountingSettings()
    await queueAccountingSyncTx(tx, {
      type: 'COGS_JOURNAL',
      referenceType: 'PurchaseOrder',
      referenceId: po.id,
      payload: { lines: [{ accountCode: settings.cogsAccount }] },
    })
  `)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].namesChart, false)
})

test('[o3d-j625 r2] it reads all three call shapes, including the parenthesised callee', () => {
  const direct = txCallSites('fixture.ts', `
    await queueAccountingSyncTx(tx, { type: 'COGS_JOURNAL', payload, chartConnector: settings.connector })
  `)
  assert.equal(direct.length, 1)
  assert.equal(direct[0].namesChart, true, 'the direct call')

  const adapter = txCallSites('fixture.ts', `
    await queueAccountingSyncTxWithOutcome(tx, { ...sync, chartConnector })
  `)
  assert.equal(adapter.length, 1, 'the adapter is one site, not two — the needles must not double-count')
  assert.equal(adapter[0].namesChart, true, 'and shorthand is still an attribution')

  const injected = txCallSites('fixture.ts', `
    await (options.queueAccountingSync ?? queueAccountingSyncTx)(tx, {
      type: 'COGS_REVERSAL',
      chartConnector: settings.connector,
    })
  `)
  assert.equal(injected.length, 1, 'lib/cost-layers.ts’s parenthesised callee is a call site')
  assert.equal(injected[0].namesChart, true)

  const qualified = txCallSites('fixture.ts', `
    await deps.queueAccountingSyncTx(tx, { type: 'INVENTORY_ADJUSTMENT', chartConnector: s.connector })
    await params.deps.queueAccountingSyncTx(params.tx, { type: 'PURCHASE_INVOICE_UPDATE', chartConnector })
  `)
  assert.equal(qualified.length, 2, 'an injected dependency IS the enqueue in production')
  assert.deepEqual(qualified.map((site) => site.namesChart), [true, true])
})

test('[o3d-j625 r2] the parenthesised-callee needle really is load-bearing', () => {
  // The hole a needle set of only `queueAccountingSyncTx(` would have had: lib/cost-layers.ts's call is
  // `…queueAccountingSyncTx)(tx, {…})`, where the name is followed by `)`, not `(`. Proved by removing
  // the needle from the picture rather than argued.
  const source = "await (options.queueAccountingSync ?? queueAccountingSyncTx)(tx, { type: 'COGS_REVERSAL' })"
  assert.equal(source.includes('queueAccountingSyncTx('), false, 'the plain needle does not occur at all')
  assert.equal(source.includes('queueAccountingSyncTx)('), true, 'only this one does')
  assert.equal(txCallSites('fixture.ts', source).length, 1, 'and the sweep finds it')
})

test('[o3d-j625 r2] the transactional detector ignores declarations, types and prose', () => {
  const sites = txCallSites('lib/accounting.ts', `
    export async function queueAccountingSyncTx(
      tx: Prisma.TransactionClient,
      params: { type: AccountingSyncType },
    ): Promise<boolean> { return false }
    export async function queueAccountingSyncTxWithOutcome(
      tx: Prisma.TransactionClient,
      params: Omit<Parameters<typeof queueAccountingSyncTx>[1], 'reportOutcome'>,
    ): Promise<AccountingEnqueueOutcome> { return { queued: false, reason: 'refused', connector: null } }
    type Deps = {
      queueAccountingSyncTx: typeof queueAccountingSyncTx
      other: (tx: Tx, params: QueueAccountingSyncTxParams) => Promise<boolean>
    }
    const deps = { queueAccountingSyncTx, recordTransitSubledgerMovement }
    // await queueAccountingSyncTx(tx, { type: 'COGS_JOURNAL' }) in a comment
    const prose = 'queueAccountingSyncTx(tx, {})'
  `)
  assert.deepEqual(sites, [], `nothing here is a call: ${JSON.stringify(sites)}`)
})

test('[o3d-j625 r2] the transactional detector FAILS CLOSED where the request is not a literal', () => {
  const sites = txCallSites('fixture.ts', 'await queueAccountingSyncTxWithOutcome(tx, sync)')
  assert.equal(sites.length, 1)
  assert.equal(sites[0].argument, null, 'a non-literal request is a hole, and must be reported as one')
  assert.equal(sites[0].namesChart, false)

  // And a call with no second argument at all is also a hole rather than a pass.
  assert.equal(secondArgument('(tx)'), null)
  assert.equal(secondArgument('(tx, sync)'), null)
  assert.equal(secondArgument('(tx, { a: 1 })'), '{ a: 1 }')
  // A comma inside the FIRST argument is not an argument separator.
  assert.equal(secondArgument('(db.tx(a, b), { a: 1 })'), '{ a: 1 }')
})

// ---------------------------------------------------------------------------------------------
// o3d-j625 r2 — THE PARAMETER IS REQUIRED, WHICH IS THE HALF NO CENSUS CAN ESTABLISH
//
// A census reads the calls that exist. It cannot say that a call omitting the parameter is
// IMPOSSIBLE, and "an optional parameter is not a seam, it is the defect with a default" is the
// reviewer's ruling on why that matters: r1 made the census the whole rule, so any new call site — or
// any site a refactor rewrote — could silently take the old behaviour back and the census would only
// notice if someone remembered to keep it passing. The type system notices without being remembered.
// ---------------------------------------------------------------------------------------------

test('[o3d-j625 r2] `chartConnector` is declared REQUIRED on both enqueues and on the chart itself', () => {
  const source = productionSources().find(([file]) => file === 'lib/accounting.ts')
  assert.ok(source, 'lib/accounting.ts was not scanned')
  const code = blankNonCode(source[1])

  // AN ABSENCE CHECK, DELIBERATELY. An existential "the required form appears" would be satisfied by
  // one required declaration sitting beside an optional one; this cannot be.
  const optional = code.match(/chartConnector\s*\?\s*:/g) ?? []
  assert.deepEqual(
    optional,
    [],
    `chartConnector is declared OPTIONAL ${optional.length} time(s) in lib/accounting.ts. An optional `
    + 'parameter lets a caller silently get the second-resolution behaviour back, which is the defect '
    + 'o3d-j625 closes (Codex r1 HIGH 1). Declare it required; `null` is how a caller says "no '
    + 'connector was switched on when I read the chart".',
  )

  // And it really is declared, three times: the shared guard, the facade, the in-transaction enqueue.
  // Counted so that DELETING a declaration cannot pass the absence check above by vacuity.
  // Matched on the BLANKED code, so a doc comment describing the shape cannot stand in for a
  // declaration — and with a wildcard inside the index, because `blankNonCode` empties string bodies:
  // `AccountingConnectorInfo['id']` reads as `AccountingConnectorInfo['  ']` there.
  const required = code.match(/chartConnector:\s*AccountingConnectorInfo\[[^\]]*\]\s*\|\s*null/g) ?? []
  assert.equal(
    required.length,
    3,
    'expected the required declaration on refuseUnattributableChart, queueAccountingSync and '
    + `queueAccountingSyncTx — found ${required.length}. ${JSON.stringify(required)}`,
  )

  // The chart object's own connector, which is what every site above passes. Required for the same
  // reason: an optional field on `AccountingSettings` would make `settings.connector` an `undefined`
  // that type-checks straight through the required parameter.
  // Scoped to the AccountingSettings declaration itself rather than to the whole file: the PIN
  // (`connector?: AccountingConnectorInfo['id']`) IS legitimately optional on both enqueues, so a
  // file-wide absence check on `connector?:` would be red for the wrong reason — and green only if
  // someone deleted the pin.
  const settingsAt = code.indexOf('export type AccountingSettings = {')
  assert.ok(settingsAt > 0, 'the AccountingSettings declaration was not found')
  const settingsBody = balancedFrom(code, code.indexOf('{', settingsAt))
  assert.ok(
    /\n  connector: AccountingConnectorInfo\[[^\]]*\] \| null\n/.test(settingsBody),
    'AccountingSettings.connector must be a REQUIRED field naming the chart’s own connector',
  )
  assert.equal(
    /connector\s*\?\s*:/.test(settingsBody),
    false,
    'AccountingSettings.connector must not be optional: `settings.connector` would then be an '
    + '`undefined` that type-checks straight through the required enqueue parameter',
  )
})

test('[o3d-j625 r2] the required-declaration check can fire', () => {
  // The pre-r2 text, verbatim from the branch this replaced, and the shape a "fix" would regress to.
  for (const optional of [
    "    chartConnector?: AccountingConnectorInfo['id'] | null",
    '  chartConnector ?: string | null',
  ]) {
    assert.match(optional, /chartConnector\s*\?\s*:/, 'the absence check would not have seen this')
  }
  // ...and the required form is NOT matched by it, so the check is not simply always-red.
  assert.equal(
    /chartConnector\s*\?\s*:/.test("  chartConnector: AccountingConnectorInfo['id'] | null"),
    false,
  )
})

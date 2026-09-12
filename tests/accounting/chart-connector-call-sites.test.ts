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
 * THE IN-TRANSACTION ENQUEUE (`queueAccountingSyncTx`) IS OUT OF SCOPE HERE and is NOT swept: it takes
 * the same parameter (and this branch threads it on the refund's COGS reversal), but its other callers
 * — cost-layers, manufacturing, the purchase-invoice and landed-cost paths — have the same defect
 * through a different seam and their own set of behaviour consequences. Tracked separately rather than
 * half-swept here, because a census that excused most of its subjects would be worse than no census.
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

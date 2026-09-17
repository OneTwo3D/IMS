import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { balancedFrom, blankNonCode, ownProperty, productionSources } from './paid-provenance-scan'

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
const activity: Array<{ action: string; level?: string }> = []
let enqueueAnswer: { queued: boolean; reason?: string; connector: string | null } = { queued: true, connector: 'xero' }
let activeConnector: string | null = 'quickbooks'

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingPostingRefusal: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          rows.push({ ...create, resolvedAt: null })
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
    queueAccountingSync: async () => enqueueAnswer,
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
  activity.length = 0
  enqueueAnswer = { queued: true, connector: 'xero' }
  activeConnector = 'xero'
})

test('[o3d-j625 r4] a site that keeps its local change and reports an ERROR also records OUTSTANDING work', async () => {
  enqueueAnswer = { queued: false, reason: 'refused', connector: 'xero' }

  await pushTaxRate()

  assert.ok(activity.some((entry) => entry.action === 'tax_rate_sync_not_queued' && entry.level === 'ERROR'),
    'PRECONDITION: this is the ERROR-log path the decision is about')
  assert.equal(rows.length, 1, `and the same facts are durable. Rows: ${JSON.stringify(rows)}`)
  assert.equal(rows[0].type, 'TAX_RATE_SYNC')
  assert.equal(rows[0].referenceType, 'TaxRate')
  assert.equal(rows[0].referenceId, 'rate-1')
  assert.equal(rows[0].activeConnector, 'xero', 'the ACTIVE connector is on the row — round 2 omitted it')
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

test('[o3d-j625 r4] every reportPostingNotQueued call site names the posting, so every ERROR is also an inbox row', () => {
  const NEEDLE = 'reportPostingNotQueued('
  const sites: Array<{ file: string; line: number; namesPosting: boolean }> = []
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
      sites.push({
        file,
        line: source.slice(0, at).split('\n').length,
        // FAIL CLOSED on an argument this cannot read: an unparsed call is a hole in the census.
        namesPosting: request !== null && ownProperty(request, 'postingRef') !== null,
      })
    }
  }
  console.log(`[o3d-j625 r4] reportPostingNotQueued call sites examined: ${sites.length}`)
  assert.ok(sites.length >= 14, `expected the fourteen reporting sites, found ${sites.length}`)
  assert.deepEqual(
    sites.filter((site) => !site.namesPosting).map((site) => `${site.file}:${site.line}`),
    [],
    'these sites report an ERROR without naming the posting, so nothing lands in the exception inbox for them',
  )
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * THE CLAIM BOUNDARY OF THE PRODUCER-SIDE HOLD: a row that ALREADY EXISTS is not sent unless the decision is LIVE.
 *
 * The seam at row creation governs rows made after enforcement was switched on. A PENDING row (or an outbox job) that
 * predates it, or one a retry/sweep revived, reaches `processClaimedEntry` through the claim like any other, so the
 * decision is asked there too, before anything can be sent. This drives the REAL `processClaimedEntry` with the Xero
 * transport modules doubled and counts what they are asked to send, and with a lease that fails the test if the
 * processor reaches its pre-write fence.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  gate-removed          the check at the top of processClaimedEntry is deleted: the held arms go red
 *  b  gate-ignores-verdict  the check runs but a shadow still proceeds: the held arms go red
 *  c  gate-always-holds     a LIVE verdict is held too: the granted arm goes red
 */

const sent: string[] = []
const record = (name: string) => async () => { sent.push(name); return { success: true, invoiceId: 'X-1' } }

for (const [module, names] of [
  ['@/lib/connectors/xero/invoices', ['pushSalesInvoice', 'updateSalesInvoice']],
  ['@/lib/connectors/xero/bills', ['pushPurchaseBill', 'updatePurchaseBill']],
  ['@/lib/connectors/xero/credit-notes', ['pushCreditNote', 'pushPurchaseCreditNote', 'allocatePurchaseCreditNote']],
  ['@/lib/connectors/xero/journals', ['pushManualJournal', 'postPreparedManualJournal']],
] as const) {
  mock.module(module, { namedExports: Object.fromEntries(names.map((name) => [name, record(name)])) })
}

const KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM']
const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
let fenced = 0
const lease = {
  fenceBeforeRemoteWrite: async () => { fenced += 1; throw new Error('the processor reached its pre-write fence') },
} as never

async function run(env: Record<string, string>, type: string, payload: Record<string, unknown>) {
  const saved = KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of KEYS) delete process.env[key]
  Object.assign(process.env, env)
  sent.length = 0
  fenced = 0
  try {
    const { processClaimedEntry } = await import('@/lib/connectors/xero/sync-processor')
    try {
      const result = await processClaimedEntry('entry-1', type as never, 'PurchaseOrder', 'po-1', payload, lease, { attemptRevision: 1 } as never)
      return { result, threw: null as string | null }
    } catch (error) {
      return { result: null, threw: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

const BILL = { invoiceNumber: 'B-1', date: '2026-06-01', _postingMode: 'submitted' }
const GRANTED = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: '2020-01-01T00:00:00Z' }

test('PRE-EXISTING ROW, switch ON, no grant: handed back unsent as producer-held with the operator text; nothing is sent', async () => {
  const { result, threw } = await run({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, 'PURCHASE_INVOICE', BILL)
  console.log(`# held (ungranted): result=${JSON.stringify(result)} threw=${threw} sent=${sent.length} fenced=${fenced}`)
  assert.equal(threw, null, 'PRECONDITION: the function returned (it did not run on into other machinery)')
  assert.equal(result!.success, false)
  assert.equal(result!.notPosted?.reason, 'producer-held')
  assert.match(String(result!.error), /^Not sent by IMS: writes to Xero are held on this installation/)
  assert.match(String(result!.error), /handed back unsent and is not sent while the hold stands/)
  assert.doesNotMatch(String(result!.error), /shadow record/, 'no shadow is recorded here, so none is claimed')
  assert.deepEqual(sent, [])
  assert.equal(fenced, 0)
})

test('PRE-EXISTING ROW that Xeroom owns, switch ON and FULLY GRANTED: still held (the grant does not make IMS the owner)', async () => {
  const { result, threw } = await run(GRANTED, 'SALES_INVOICE', { invoiceNumber: 'S-1', date: '2026-06-01' })
  assert.equal(threw, null)
  assert.equal(result!.notPosted?.reason, 'producer-held')
  assert.match(String(result!.error), /another writer owns this operation/)
  assert.deepEqual(sent, [])
})

test('PRE-EXISTING ROW dated BEFORE the live-from instant: held', async () => {
  const { result } = await run({ ...GRANTED, XERO_WRITES_LIVE_FROM: '2026-07-01T00:00:00Z' }, 'PURCHASE_INVOICE', BILL)
  assert.equal(result?.notPosted?.reason, 'producer-held')
  assert.match(String(result!.error), /happened before the live-from instant/)
})

test('CONTROL, switch OFF: the processor goes PAST the gate (it is not held), so the held arms above are not passing because nothing can pass', async () => {
  const { result, threw } = await run({}, 'PURCHASE_INVOICE', BILL)
  console.log(`# switch off: result=${JSON.stringify(result)?.slice(0, 120)} threw=${threw}`)
  assert.notEqual(result?.notPosted?.reason, 'producer-held')
})

test('CONTROL, FULLY GRANTED, IMS-owned, dated after the cut-off: proceeds past the gate (granted => proceeds)', async () => {
  const { result, threw } = await run(GRANTED, 'PURCHASE_INVOICE', BILL)
  console.log(`# granted: result=${JSON.stringify(result)?.slice(0, 120)} threw=${threw}`)
  assert.notEqual(result?.notPosted?.reason, 'producer-held')
})

test('STRUCTURAL: the manual retry asks the decision before it plans the revival and refuses a held row with the operator text (the daily-batch reset is driven in daily-batch-producer-seam.test.ts)', () => {
  const source = readFileSync('app/actions/xero-sync.ts', 'utf8')
  const ask = source.indexOf("xeroProducerSeamVerdict({ connector: 'xero', type: String(candidate.type)")
  const refuse = source.indexOf('refused.push({ id: candidate.id, reason: hold.notice', ask)
  const plan = source.indexOf('const plan = planManualRetry({', ask)
  console.log(`# retry offsets: ask=${ask} refuse=${refuse} plan=${plan}`)
  assert.ok(ask > 0 && refuse > ask && plan > refuse, 'ask, then refuse, then plan the revival')
})

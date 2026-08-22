import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * o3d-xl63 ROUND 4 — A CLAIM THAT IS GONE BEFORE THE POST BEGINS.
 *
 * Round 3 anchored the PERSIST's deadline to the row's claim, so the record of a completed post can
 * never still be running when another worker may reclaim the row. It said nothing about the other end
 * of the same window: the claim can be gone before the post ever starts.
 *
 * `processEntry` is not a POST. It reads the granted scopes, resolves or creates the Xero contact,
 * looks items up — and every one of those goes through the rate-limited client, whose own header puts
 * the worst case between the first HTTP call and the last at three 90-second Retry-After sleeps plus
 * three 60-second minute-limit waits. Put a few of those in front of the document post and the
 * fifteen-minute claim is spent before anything is sent. The next sweep tick then finds the row past
 * the stale cutoff, re-claims it, and posts the document — and this worker posts it too.
 *
 * The fix re-TAKES the claim at the instant the remote write begins, fenced on the exact
 * `processingStartedAt` this worker wrote. Matched: the runway restarts from here. Not matched:
 * nothing is posted at all, which is the cheapest possible outcome for a lost claim.
 */

type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> }

const state = {
  updateMany: [] as UpdateManyArgs[],
  /** Counts returned by successive updateMany calls: [claim, re-take, ...]. */
  updateManyCounts: [] as number[],
  updateManyCount: 1,
  transactionAttempts: 0,
  pending: [] as Array<Record<string, unknown>>,
  pendingServed: false,
  posted: [] as string[],
  activity: [] as Array<{ action?: string; description?: string }>,
}

/**
 * A permissive database double: the sweep touches far more than this test cares about, and the only
 * calls that carry meaning here are the two `accountingSyncLog.updateMany`s — the claim and the
 * re-take — and whether any transaction ran at all.
 */
function makeDbDouble(): Record<string, unknown> {
  const model = new Proxy({}, {
    get: (_target, method: string) => async (args: UpdateManyArgs) => {
      switch (method) {
        case 'updateMany': {
          state.updateMany.push(args)
          const next = state.updateManyCounts.shift()
          return { count: next ?? state.updateManyCount }
        }
        case 'count': return 0
        case 'findMany': {
          if (state.pendingServed) return []
          state.pendingServed = true
          return state.pending
        }
        // The sales order the invoice belongs to: readable and not cancelled, so the
        // cancelled-order guard lets the post through and the claim guard is the only thing
        // that can stop it.
        case 'findUnique': return { id: 'so-1', customerId: 'cust-1', status: 'PROCESSING' }
        case 'findFirst': return null
        default: return {}
      }
    },
  })
  const db: Record<string, unknown> = new Proxy({}, {
    get: (_target, key: string) => {
      if (key === '$transaction') {
        return async (arg: unknown) => {
          state.transactionAttempts += 1
          return typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : []
        }
      }
      if (key === 'then') return undefined
      // Raw-SQL delegates must be FUNCTIONS. The generic `model` proxy below answers method access,
      // so returning it for these made them objects and the caller died on "is not a function".
      //  • `$queryRaw`  — o3d-7o0's `SELECT ... FOR UPDATE` row lock, merged into development as part
      //    of #639. Un-taught, the cancelled-order guard failed with "could not read sales order",
      //    which this file reported as "nothing was posted" — i.e. as a claim failure, which it isn't.
      //  • `$executeRaw` — o3d-clxw r4's database-clock stamp on the SYNCED transition.
      if (key === '$queryRaw' || key === '$queryRawUnsafe') return async () => []
      if (key === '$executeRaw' || key === '$executeRawUnsafe') return async () => 1
      return model
    },
  })
  return db
}

mock.module('@/lib/db', {
  namedExports: {
    db: makeDbDouble(),
    POST_REMOTE_PERSIST_TX_OPTIONS: { maxWait: 11_000, timeout: 15_000 },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action?: string; description?: string }) => { state.activity.push(entry) },
    logActivityPersisted: async (entry: { action?: string; description?: string }) => { state.activity.push(entry); return true },
  },
})
mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getGrantedScopes: async () => null,
    // o3d-k26m.5 (merged into development after this double was written): the sales-invoice CREATE
    // asks the LEDGER who holds the invoice number before it sends anything, and that lookup resolves
    // the connection itself. Without this the lookup throws, the fence FAILS CLOSED, and the control
    // case never posts — so the test reads as a claim failure when nothing about claims went wrong.
    getAccessToken: async () => ({ accessToken: 'access-1', tenantId: 'tenant-A' }),
  },
})
// NOBODY holds this number, said by the organisation this worker is connected to. Mocked rather than
// driven through HTTP because this file is about the claim taken before a remote write; number
// ownership is pinned in tests/connectors/xero-invoice-number-post-slot.
mock.module('@/lib/connectors/xero/invoice-number-claim', {
  namedExports: {
    lookupXeroInvoiceNumberClaim: async () => ({ ok: true, claims: [], tenantId: 'tenant-A' }),
  },
})
mock.module('@/lib/connectors/xero/invoices', {
  namedExports: {
    pushSalesInvoice: async (data: { invoiceNumber: string }) => {
      state.posted.push(data.invoiceNumber)
      return { success: true, invoiceId: 'XERO-INV-1', invoiceNumber: data.invoiceNumber }
    },
    updateSalesInvoice: async () => ({ success: true, invoiceId: 'XERO-INV-1' }),
  },
})

const processor = () => import('@/lib/connectors/xero/sync-processor')

function reset(): void {
  state.updateMany = []
  state.updateManyCounts = []
  state.updateManyCount = 1
  state.transactionAttempts = 0
  state.pending = []
  state.pendingServed = false
  state.posted = []
  state.activity = []
}

function pendingSalesInvoice(): Record<string, unknown> {
  return {
    id: 'log-1',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    externalTransactionId: null,
    retryCount: 0,
    errorMessage: null,
    processingStartedAt: null,
    payload: { invoiceNumber: 'INV-1', contactName: 'A Customer', date: '2026-08-20', currency: 'GBP', lines: [] },
  }
}

test('the claim is RE-TAKEN at the instant the remote write begins, fenced on this worker\'s own timestamp', async () => {
  reset()
  const { renewClaimForRemoteWrite, claimHeldFrom } = await processor()
  const heldFrom = new Date('2026-08-20T10:00:00.000Z')

  // A fixed claim says so explicitly (r6): the fence takes a claim, and a bare `Date` no longer compiles.
  const renewed = await renewClaimForRemoteWrite('log-1', claimHeldFrom(heldFrom))

  assert.ok(renewed instanceof Date)
  assert.ok(renewed.getTime() > heldFrom.getTime(),
    'the runway restarts HERE, so the post and the persist that follows get the whole claim, not the remainder')
  assert.equal(state.updateMany.length, 1)
  const [{ where, data }] = state.updateMany
  assert.equal(where.id, 'log-1')
  assert.equal(where.connector, 'xero')
  assert.equal(where.status, 'PROCESSING')
  assert.deepEqual(where.processingStartedAt, heldFrom,
    'fenced on the EXACT claim this worker wrote — anything looser would re-take a claim someone else holds')
  assert.deepEqual(data.processingStartedAt, renewed)
})

test('a claim taken by another worker returns null, and nothing else is written', async () => {
  reset()
  state.updateManyCount = 0
  const { renewClaimForRemoteWrite, claimHeldFrom } = await processor()

  const renewed = await renewClaimForRemoteWrite('log-1', claimHeldFrom(new Date('2026-08-20T10:00:00.000Z')))

  assert.equal(renewed, null, 'null is what stops the post — a check that only logged would still send the document')
  assert.equal(state.transactionAttempts, 0)
})

test('r4 #2: a persist reached on a LAPSED claim runs no transaction at all, and still records the id', async () => {
  reset()
  const { persistPostedXeroDocument, claimHeldFrom } = await processor()
  const staleAfterMs = 15 * 60 * 1000

  const recorded = await persistPostedXeroDocument({
    entry: { id: 'log-77', type: 'INVOICE_PAYMENT', referenceType: 'SalesInvoice', referenceId: 'inv-77' },
    payload: {},
    externalId: 'PAY-77',
    // Claimed a full stale-window ago: there is nothing left of it.
    claim: claimHeldFrom(new Date(Date.now() - staleAfterMs - 1_000)),
  })

  // `{ persisted: false, reason: 'pool-exhausted' }` rather than a bare `false`: the persist now names
  // which failure it hit, so the outbox runner can bury a refused document permanently and leave a
  // pool-exhausted job alone. The property asserted here is unchanged.
  assert.deepEqual(recorded, { persisted: false, reason: 'pool-exhausted' },
    'the caller is told the row was not recorded normally')
  assert.equal(state.transactionAttempts, 0,
    'the ordinary persist updates the row BY ID with no claim fence — under a lapsed claim it must not run at all')

  // What DOES run is the give-up path's single statement, which is claim-fenced and therefore safe.
  assert.equal(state.updateMany.length, 1)
  const [{ where, data }] = state.updateMany
  assert.equal(where.id, 'log-77')
  assert.ok(where.processingStartedAt, 'the terminal write is fenced on the claim; the persist it replaced was not')
  assert.equal(data.externalTransactionId, 'PAY-77', 'and the id of the document Xero holds is still recovered')
})

test('both sweep paths open the lease before posting and anchor the persist to the claim it currently holds', () => {
  // Structural, in the style of the round-3 test one file over: the guard's whole value is that it sits
  // between the claim and the post, and nothing about a passing behavioural test would notice it being
  // moved or dropped.
  //
  // r5 #1 restates round 4's property against the lease that replaced the bare re-take: the re-take now
  // happens INSIDE `openRemoteWriteLease`, and the persist anchors to `lease.heldFrom()` — the claim as
  // it stands after the last fence — rather than to a timestamp captured before processEntry ran.
  const source = readFileSync(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  const lines = source.split('\n')
  const postSites = lines.flatMap((line, index) => (line.includes('await processEntry(entry.id,') ? [index] : []))
  assert.equal(postSites.length, 2, 'the direct path and the outbox path — if this changed, so did the fix')

  for (const index of postSites) {
    const before = lines.slice(Math.max(0, index - 26), index).join('\n')
    assert.match(before, /openRemoteWriteLease\(entry\.id, claimedAt/,
      `the remote write at line ${index + 1} must open the lease (which re-takes the claim) first`)
    assert.match(before, /if \(!lease\)/,
      `and must post NOTHING when the claim is already gone (line ${index + 1})`)
    // o3d-e2mz: the call now carries the ATTEMPT as well as the lease — two fences answering two
    // different questions (do I still own this row / is this still the attempt I claimed). The lease
    // must still be there, and must still be the LEASE rather than a snapshot of it.
    assert.match(lines[index], /payload, lease, attempt\)/,
      `and everything downstream must fence on the lease, not on the claim taken before the deferral checks`)
  }

  const persistSites = lines.flatMap((line, index) => (line.includes('await persistPostedXeroDocument({') ? [index] : []))
  assert.equal(persistSites.length, 2)
  for (const index of persistSites) {
    assert.match(lines.slice(index, index + 16).join('\n'), /claim: lease,/,
      `the persist at line ${index + 1} must be handed the LEASE, so every statement it makes reads the `
        + `claim the row currently carries; a \`lease.heldFrom()\` snapshot here is the r6 finding`)
    assert.doesNotMatch(lines.slice(index, index + 16).join('\n'), /claimedAt: lease\.heldFrom\(\)/,
      `and must NOT snapshot it (line ${index + 1})`)
  }

  // And the outbox path must pass its job in, or the queue-side lock is never renewed.
  const outboxLease = lines.findIndex((line) => line.includes('openRemoteWriteLease(entry.id, claimedAt, job)'))
  assert.ok(outboxLease > 0,
    'the outbox path must hand its job to the lease so every fence renews the OUTBOX lock as well as the row claim')
})

test('r5 #1: EVERY remote mutation in processEntry is fenced immediately before it, and the fence is the last statement', () => {
  // Round 4 fenced once, in front of the whole entry, and said so in its own commit message: "time
  // burnt inside the processor between the re-take and each individual push call is still unfenced".
  // This is the test for the part that was left. It is structural because that is the only way to
  // catch the failure that matters — a NEW case added to the switch with no fence in front of it,
  // which no behavioural test of the existing cases would ever notice.
  const source = readFileSync(new URL('../../lib/connectors/xero/sync-processor.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function processEntry('), source.indexOf('async function updateBackReference('))
  const lines = body.split('\n')

  // Every call in processEntry that MUTATES something outside this database.
  const mutations = [
    'await pushSalesInvoice(',
    'await updateSalesInvoice(',
    'await pushPurchaseBill(',
    'await updatePurchaseBill(',
    'await xeroUploadAttachment(',
    'await sendAccountingInvoiceEmailInternal(',
    'await pushInvoiceNoteToWc(',
    'return pushCreditNote(',
    'return pushPurchaseCreditNote(',
    'await allocatePurchaseCreditNote(',
    'return pushManualJournal(',
    'await putXeroTaxRate(',
  ]
  // The two `xeroPost('Payments'` sites are matched separately: the same text appears twice.
  const paymentSites = lines.flatMap((line, index) => (line.includes("xeroPost<{ Payments?: Array<{ PaymentID: string }> }>('Payments'") ? [index] : []))
  assert.equal(paymentSites.length, 2, 'INVOICE_PAYMENT and BILL_PAYMENT — a payment has no natural key Xero dedupes on')

  const sites = [...paymentSites]
  for (const needle of mutations) {
    const found = lines.flatMap((line, index) => (line.includes(needle) ? [index] : []))
    assert.equal(found.length, 1, `expected exactly one call site for ${needle} — the list above has drifted from the code`)
    sites.push(found[0])
  }

  for (const index of sites) {
    // IMMEDIATELY before: the fence's value is that nothing awaitable happens between proving the
    // claim and using it. One line of leeway, for the comment the fence carries.
    const preceding = lines.slice(Math.max(0, index - 2), index)
    assert.ok(
      preceding.some((line) => line.includes('if (!fence.ok) return fence.result')),
      `the remote mutation at processEntry line ${index + 1} (${lines[index].trim().slice(0, 60)}) is NOT fenced `
        + `immediately before it — a claim proven earlier in the entry has had every preparation call since to lapse`,
    )
  }

  assert.equal(
    lines.filter((line) => line.includes('await lease.fenceBeforeRemoteWrite(')).length,
    sites.length,
    'every fence must belong to a mutation and every mutation to a fence — a spare one is a renewal protecting nothing',
  )
})

test('the sweep POSTS NOTHING when the claim was taken between claiming and posting', async () => {
  reset()
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
  state.pending = [pendingSalesInvoice()]
  // The claim succeeds; the re-take at the instant of the post finds the row already gone — which is
  // what a sweep tick that spent its claim on Retry-After sleeps inside processEntry comes back to.
  state.updateManyCounts = [1, 0]

  const { processPendingXeroSync } = await processor()
  const result = await processPendingXeroSync()

  assert.deepEqual(state.posted, [],
    'the document must NOT be sent: another worker holds this row and is posting it, so this would be the second one')
  assert.equal(result.skipped, 1)
  assert.equal(result.succeeded, 0)
  assert.equal(state.transactionAttempts, 0, 'and nothing was persisted for a post that never happened')
  const warning = state.activity.find((a) => a.action === 'xero_sync_claim_lost_before_post')
  assert.ok(warning, 'the lost claim is recorded, not swallowed')
  assert.match(warning.description ?? '', /posting would have created a second document/)
})

test('control: with the claim still held, the sweep posts exactly once', async () => {
  reset()
  process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'
  state.pending = [pendingSalesInvoice()]
  state.updateManyCounts = [1, 1]

  const { processPendingXeroSync } = await processor()
  const result = await processPendingXeroSync()

  assert.deepEqual(state.posted, ['INV-1'], 'the ordinary path must be untouched by the guard')
  assert.equal(result.skipped, 0)
  assert.equal(state.activity.some((a) => a.action === 'xero_sync_claim_lost_before_post'), false)
})

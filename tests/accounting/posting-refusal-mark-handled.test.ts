import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r6/r7 — "MARK AS HANDLED", AND (r7, owner decision 2026-09-19 "Handled + stop retry") IMS NEVER
 * POSTS A POSTING SOMEONE MARKED HANDLED.
 *
 * Driven through the real server action and the real domain function, over table doubles that APPLY the
 * where-clauses they are given (id, still outstanding, a markable kind; the sync rows' status, claim
 * revision and external id), so what is asserted is which rows each write can reach.
 */
type Refusal = {
  id: string; type: string; referenceType: string; referenceId: string; scope: string; kind: string | null
  resolvedAt: Date | null; resolution: string | null; resolvedBy: string | null; resolutionNote: string | null
  suppressedAt: Date | null; firstRefusedAt: Date; refusedCount: number; detail: unknown; reason?: string
  /** o3d-j625 r16: the hand-posting claim's two columns, NULL as the migration leaves every existing row. */
  handPostClaimedAt: Date | null; handPostClaimedBy: string | null
}
type SyncRow = {
  id: string; connector: string; type: string; referenceType: string; referenceId: string; status: string
  attemptRevision: number; externalTransactionId: string | null; payload: unknown; errorMessage?: string | null
}
const refusals: Refusal[] = []
const syncRows: SyncRow[] = []
const permissionsAsked: string[] = []
const activity: Array<{ action: string; metadata?: Record<string, unknown> }> = []
const locks: string[] = []
const mirrorWrites: Array<{ syncLogId?: string; status: string; voidBasis?: string }> = []
let denyFresh = false

/**
 * o3d-j625 r20 (Codex round 19, HIGH) — THE DOUBLE EVALUATES `AND`, `OR`, `gt` AND `contains` TOO.
 *
 * The claims WALK is a keyset predicate (`handPostClaimedAt gt X OR (= X AND id gt Y)`, nested under an
 * `AND` with the active-claim filter) and the LOOKUP is an `OR` of `contains`. A double that ignored any of
 * them would return every row whatever the query asked — which is exactly the rig fault r18 disclosed on the
 * inbox-surface double, where an unevaluated `handPostClaimedBy` made a viewer-scoped query look correct.
 * These clauses are the subject here, so they are executed rather than skipped.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'AND') {
      const clauses = (Array.isArray(condition) ? condition : [condition]) as Array<Record<string, unknown>>
      if (!clauses.every((clause) => matches(row, clause))) return false
      continue
    }
    if (key === 'OR') {
      const clauses = (Array.isArray(condition) ? condition : [condition]) as Array<Record<string, unknown>>
      if (!clauses.some((clause) => matches(row, clause))) return false
      continue
    }
    const value = row[key]
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in (condition as object) && !(condition as { in: unknown[] }).in.includes(value)) return false
      if ('not' in (condition as object) && value === (condition as { not: unknown }).not) return false
      if ('gt' in (condition as object)) {
        const bound = (condition as { gt: unknown }).gt
        const left = value instanceof Date ? value.getTime() : value
        const right = bound instanceof Date ? bound.getTime() : bound
        if (!(left !== undefined && left !== null && right !== undefined && right !== null && (left as number | string) > (right as number | string))) return false
      }
      if ('contains' in (condition as object)) {
        const needle = String((condition as { contains: unknown }).contains)
        const insensitive = (condition as { mode?: string }).mode === 'insensitive'
        const haystack = String(value ?? '')
        const hit = insensitive
          ? haystack.toLowerCase().includes(needle.toLowerCase())
          : haystack.includes(needle)
        if (!hit) return false
      }
    } else if (condition instanceof Date) {
      // o3d-j625 r20: the keyset's equality leg compares a DATE (`handPostClaimedAt: after.at`). Two Date
      // objects are never `===`, so without this the tie-break leg matched nothing and a page boundary
      // falling inside a group of same-instant claims dropped every one of them.
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false
    } else if (value !== condition) return false
  }
  return true
}

/** `orderBy` as Prisma takes it: one object, or several applied in order. Dates and strings both compare. */
function sortRefusals(rows: Refusal[], orderBy: unknown): Refusal[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, 'asc' | 'desc'>>
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [field, direction] = Object.entries(key)[0]!
      const left = (a as unknown as Record<string, unknown>)[field]
      const right = (b as unknown as Record<string, unknown>)[field]
      const l = left instanceof Date ? left.getTime() : left
      const r = right instanceof Date ? right.getTime() : right
      if (l === r) continue
      const cmp = (l as number | string) < (r as number | string) ? -1 : 1
      return direction === 'desc' ? -cmp : cmp
    }
    return 0
  })
}

const refusalTable = {
  // o3d-j625 r20: the claims WALK and the LOOKUP read through these two, so the double has to page and
  // count the way the database does — `take` is honoured, or a page boundary is not a page boundary.
  findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
    const hits = sortRefusals(refusals.filter((row) => matches(row as unknown as Record<string, unknown>, where)), orderBy)
    return typeof take === 'number' ? hits.slice(0, take) : hits
  },
  count: async ({ where }: { where: Record<string, unknown> }) =>
    refusals.filter((row) => matches(row as unknown as Record<string, unknown>, where)).length,
  /**
   * A COPY, as a real client returns (o3d-j625 r20). The double used to hand back the LIVE object, so a
   * later `updateMany` in the same call mutated the snapshot the caller was still reading — and
   * `releasePostingHandPostClaim`, which reports `heldSince` from the row it loaded, read back the `null`
   * its own write had just set. That is an artefact of the rig, not of the code, and it is fixed here
   * rather than worked around in the assertion.
   */
  findUnique: async ({ where }: { where: { id?: string; type_referenceType_referenceId_scope?: Record<string, unknown> } }) => {
    const hit = where.id !== undefined
      ? refusals.find((row) => row.id === where.id)
      : refusals.find((row) => matches(row as unknown as Record<string, unknown>, where.type_referenceType_referenceId_scope!))
    return hit ? { ...hit } : null
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hits = refusals.filter((row) => matches(row as unknown as Record<string, unknown>, where))
    // o3d-j625 r9: Prisma's atomic increment, modelled — the refusal record now writes an EXISTING row
    // through updateMany (so the write itself can carry `suppressedAt: null`), and a double that stored
    // the operator object would make every attempt-count assertion meaningless.
    for (const hit of hits) {
      const row = hit as unknown as Record<string, unknown>
      for (const [field, value] of Object.entries(data)) {
        row[field] = value && typeof value === 'object' && 'increment' in (value as object)
          ? Number(row[field] ?? 0) + Number((value as { increment: number }).increment)
          : value
      }
    }
    return { count: hits.length }
  },
  upsert: async ({ where, create, update }: { where: { type_referenceType_referenceId_scope: Record<string, unknown> }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
    const hit = refusals.find((row) => matches(row as unknown as Record<string, unknown>, where.type_referenceType_referenceId_scope))
    if (hit) {
      for (const [key, value] of Object.entries(update)) {
        (hit as unknown as Record<string, unknown>)[key] = value && typeof value === 'object' && 'increment' in (value as object)
          ? Number((hit as unknown as Record<string, unknown>)[key] ?? 0) + (value as { increment: number }).increment
          : value
      }
      return hit
    }
    refusals.push({ refusedCount: 1, resolvedAt: null, resolution: null, resolvedBy: null, resolutionNote: null, suppressedAt: null, ...create } as unknown as Refusal)
    return create
  },
}
/**
 * o3d-j625 r16: fired when the posting's sync rows are READ, which is AFTER the refusal row has been
 * re-read under the lock and found markable and BEFORE the resolve. That is the only moment at which the
 * resolve's own `kind` predicate is the thing being tested: `loadRefusalUnderItsKey` now re-reads under the
 * lock, so a kind that changes at lock time is caught there instead, and a test that injected at lock time
 * would leave the resolve's restatement unexamined.
 */
let onSyncRead: (() => void) | null = null
const syncTable = {
  findMany: async ({ where }: { where: Record<string, unknown> }) => {
    onSyncRead?.()
    return syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, where))
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hits = syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, where))
    for (const hit of hits) Object.assign(hit, data)
    return { count: hits.length }
  },
}
/** o3d-j625 r7: fired when the per-key lock is taken — the moment another transaction's commit becomes visible. */
let onLock: (() => void) | null = null
const tx = {
  accountingPostingRefusal: refusalTable,
  accountingSyncLog: syncTable,
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    locks.push(`${strings.join('?')}:${values.join(',')}`)
    onLock?.()
    return 1
  },
}
/** o3d-j625 r20: the claims page resolves holder NAMES; a user id in an instruction is not actionable. */
const users: Array<{ id: string; name: string | null }> = [
  { id: 'user-1', name: 'Viewer One' },
  { id: 'user-2', name: 'Holder Two' },
]
mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...tx,
      user: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => users.filter((u) => where.id.in.includes(u.id)) },
      $transaction: async <T>(fn: (client: unknown) => Promise<T>) => fn(tx),
    },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async (_client: unknown, params: { syncLogId?: string; status: string; voidBasis?: string }) => {
      mirrorWrites.push({ syncLogId: params.syncLogId, status: params.status, voidBasis: params.voidBasis })
      return 'not_found'
    },
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => { permissionsAsked.push(permission); return { user: { id: 'user-1' } } },
    requireFreshPermission: async (permission: string) => {
      permissionsAsked.push(`fresh:${permission}`)
      if (denyFresh) throw Object.assign(new Error('fresh auth required'), { freshAuth: true })
      return { user: { id: 'user-1' } }
    },
    freshAuthFailureResult: (error: unknown) => ((error as { freshAuth?: boolean })?.freshAuth ? { success: false, freshAuthRequired: true } : null),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
    logActivityInTransaction: async () => {},
    logActivityPersisted: async () => true,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

function refusal(id: string, kind: string | null, overrides: Partial<Refusal> = {}): Refusal {
  return {
    id, type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: `po-${id}`, scope: `k-${id}`, kind,
    resolvedAt: null, resolution: null, resolvedBy: null, resolutionNote: null, suppressedAt: null,
    handPostClaimedAt: null, handPostClaimedBy: null,
    firstRefusedAt: new Date('2026-09-01T00:00:00Z'), refusedCount: 1, detail: null, ...overrides,
  }
}
function sync(id: string, of: Refusal, overrides: Partial<SyncRow> = {}): SyncRow {
  return {
    id, connector: 'xero', type: of.type, referenceType: of.referenceType, referenceId: of.referenceId, status: 'PENDING',
    attemptRevision: 0, externalTransactionId: null, payload: of.scope ? { _idempotencyKey: of.scope } : {}, ...overrides,
  }
}

test.beforeEach(() => {
  refusals.length = 0
  syncRows.length = 0
  permissionsAsked.length = 0
  activity.length = 0
  locks.length = 0
  mirrorWrites.length = 0
  denyFresh = false
  onLock = null
  onSyncRead = null
})

/**
 * o3d-j625 r16 (Codex round 15, HIGH 1) — SETTLING A POSTING BY HAND IS *TAKE*, THEN CONFIRM, AND THE
 * HELPER DOES BOTH BECAUSE THAT IS WHAT THE INBOX OFFERS.
 *
 * The mark refuses without the claim: the claim is the only thing that establishes IMS was standing back
 * while the operator wrote to the ledger, and until r16 the ordering was an instruction they could read
 * late or not at all. Every refusal these tests assert is now raised by whichever of the two steps reaches
 * it first — and the wording is the same, because both call the same refusal helpers in
 * posting-mark-handled.ts. The FIRST failure is returned, so a test that expected "the mark refused with X"
 * still reads X.
 */
async function mark(id: string, note = '') {
  const { claimAccountingPostingRefusalForHandPostingAction, markAccountingPostingRefusalHandledAction } =
    await import('@/app/actions/sync-exceptions')
  const taken = await claimAccountingPostingRefusalForHandPostingAction(id)
  if (!(taken as { success: boolean }).success) return taken
  return markAccountingPostingRefusalHandledAction(id, note)
}

/** The CONFIRM step alone, for the tests that are about what the mark itself does with a claim held. */
async function markOnly(id: string, note = '') {
  const { markAccountingPostingRefusalHandledAction } = await import('@/app/actions/sync-exceptions')
  return markAccountingPostingRefusalHandledAction(id, note)
}
const ok = (result: unknown) => (result as { success: boolean }).success
const errorOf = (result: unknown) => String((result as { error?: string }).error)

test('[o3d-j625 r6 H4] a MANUAL row is marked handled — who, when, how, the note, and the suppression', async () => {
  refusals.push(refusal('r1', 'stock_receipt_journal'))
  assert.deepEqual(await mark('r1', '  Xero MJ-0042  '), { success: true })
  assert.ok(refusals[0]!.resolvedAt instanceof Date)
  assert.equal(refusals[0]!.resolution, 'handled_manually')
  assert.equal(refusals[0]!.resolvedBy, 'user-1')
  assert.equal(refusals[0]!.resolutionNote, 'Xero MJ-0042', 'trimmed, stored as text')
  assert.ok(refusals[0]!.suppressedAt instanceof Date, 'r7: the posting key is suppressed from then on')
  assert.ok(permissionsAsked.includes('fresh:sync'), 'behind a FRESH sign-in with the inbox\'s own permission')
  assert.ok(activity.some((entry) => entry.action === 'accounting_posting_refusal_marked_handled'))
  assert.equal(locks.length, 2,
    'under the per-posting-key lock the row-creating primitive takes — TWICE now (o3d-j625 r16): taking the '
    + 'posting for hand posting and confirming it are two transactions, and each has to hold the key, '
    + 'because between them the operator is in the ledger and nothing else may queue this posting')
})

test('[o3d-j625 r7 H-A] a row IMS RETRIES (but can get stuck) is markable, and its unsent queued row is CANCELLED', async () => {
  const row = refusal('r2', 'landed_cost_cogs_journal', { type: 'COGS_JOURNAL' })
  refusals.push(row)
  syncRows.push(sync('s-pending', row), sync('s-other-scope', row, { payload: { _idempotencyKey: 'a-different-adjustment' } }))
  assert.deepEqual(await mark('r2'), { success: true })
  assert.equal(syncRows.find((s) => s.id === 's-pending')!.status, 'CANCELLED', 'IMS\'s own attempt is cancelled')
  assert.equal(syncRows.find((s) => s.id === 's-other-scope')!.status, 'PENDING', 'a DIFFERENT posting on the same PO is untouched')
  assert.deepEqual(mirrorWrites, [{ syncLogId: 's-pending', status: 'VOID', voidBasis: 'source_cancelled' }])
})

for (const [label, overrides] of [
  ['PROCESSING (being posted now)', { status: 'PROCESSING', attemptRevision: 3 }],
  ['SYNCED (already posted)', { status: 'SYNCED', externalTransactionId: 'XJ-1', attemptRevision: 1 }],
  ['FAILED (sent or not is unknown)', { status: 'FAILED', attemptRevision: 2 }],
  ['PENDING but claimed before (put back for a retry)', { status: 'PENDING', attemptRevision: 1 }],
] as const) {
  test(`[o3d-j625 r7] the mark is REFUSED when IMS may already have posted it — a sync row ${label}`, async () => {
    const row = refusal('r3', 'landed_cost_cogs_journal', { type: 'COGS_JOURNAL' })
    refusals.push(row)
    syncRows.push(sync('s-1', row, overrides))
    const result = await mark('r3')
    assert.equal(ok(result), false)
    assert.match(errorOf(result), /may already have posted this/)
    assert.equal(refusals[0]!.resolvedAt, null, 'nothing is resolved')
    assert.equal(refusals[0]!.suppressedAt, null, 'nothing is suppressed')
    assert.equal(syncRows[0]!.status, overrides.status, 'and the sync row is untouched')
  })
}

test('[o3d-j625 r7] a processor claiming the row between the read and the cancel makes the mark fail, not cancel a row in flight', async () => {
  const row = refusal('r4', 'landed_cost_cogs_journal', { type: 'COGS_JOURNAL' })
  refusals.push(row)
  syncRows.push(sync('s-1', row))
  const original = syncTable.findMany
  syncTable.findMany = async (args) => {
    const found = await original(args)
    const snapshot = found.map((r) => ({ ...r }))
    syncRows[0]!.attemptRevision = 1 // claimed now
    syncRows[0]!.status = 'PROCESSING'
    return snapshot
  }
  try {
    const result = await mark('r4')
    assert.equal(ok(result), false)
    assert.match(errorOf(result), /changed while it was being marked/)
    assert.equal(syncRows[0]!.status, 'PROCESSING', 'the in-flight row was not cancelled')
  } finally {
    syncTable.findMany = original
  }
})

test('[o3d-j625 r6 H4] an AUTO row is REFUSED server-side, whatever the page showed', async () => {
  refusals.push(refusal('r5', 'tax_rate_sync', { type: 'TAX_RATE_SYNC', referenceType: 'TaxRate' }))
  const result = await mark('r5')
  assert.equal(ok(result), false)
  assert.match(errorOf(result), /clears this row itself/)
  assert.equal(refusals[0]!.resolvedAt, null)
})

test('[o3d-j625 r6 H4] a row with NO kind (written before the column) is refused — fail closed', async () => {
  refusals.push(refusal('r6', null))
  assert.equal(ok(await mark('r6')), false)
  assert.equal(refusals[0]!.resolvedAt, null)
})

test('[o3d-j625 r6 H4] an already-resolved row is refused, and a double submit resolves it ONCE', async () => {
  refusals.push(refusal('r7', 'purchase_invoice', { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice' }))
  const original = refusalTable.findUnique
  let arrived = 0
  let release: () => void = () => {}
  const bothRead = new Promise<void>((resolve) => { release = resolve })
  refusalTable.findUnique = async (args) => {
    const found = await original(args)
    const snapshot = found ? { ...found } : null
    if (args.where.id !== undefined) {
      arrived++
      if (arrived === 2) release()
      await bothRead
    }
    return snapshot
  }
  let results: unknown[]
  try {
    results = await Promise.all([mark('r7', 'first'), mark('r7', 'second')])
  } finally {
    refusalTable.findUnique = original
  }
  const successes = results.filter(ok)
  assert.equal(successes.length, 1, 'one of the two concurrent submits resolves it')
  assert.equal(refusals[0]!.resolutionNote, successes[0] === results[0] ? 'first' : 'second')
  const third = await mark('r7', 'third')
  assert.equal(ok(third), false)
  assert.match(errorOf(third), /already resolved/)
})

test('[o3d-j625 r6 H4] the note is length-limited', async () => {
  const { POSTING_REFUSAL_NOTE_MAX_LENGTH } = await import('@/lib/domain/accounting/posting-refusal-kinds')
  refusals.push(refusal('r8', 'stock_receipt_journal'))
  assert.equal(ok(await mark('r8', 'x'.repeat(POSTING_REFUSAL_NOTE_MAX_LENGTH + 1))), false)
  assert.equal(refusals[0]!.resolvedAt, null)
})

test('[o3d-j625 r6 H4] a missing fresh sign-in returns the fresh-auth answer and writes nothing', async () => {
  refusals.push(refusal('r9', 'stock_receipt_journal'))
  denyFresh = true
  const result = await mark('r9')
  assert.equal((result as { freshAuthRequired?: boolean }).freshAuthRequired, true)
  assert.equal(refusals[0]!.resolvedAt, null)
})

test('[o3d-j625 r7] a posting marked handled STAYS handled: refusing it again records nothing and reopens nothing', async () => {
  refusals.push(refusal('r10', 'stock_receipt_journal', { refusedCount: 3 }))
  await mark('r10', 'posted as MJ-9')
  const handled = { ...refusals[0]! }

  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  await recordAccountingPostingRefusal(
    { accountingPostingRefusal: refusalTable },
    { type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: 'po-r10', scope: 'k-r10' },
    { kind: 'stock_receipt_journal', chartConnector: 'xero', activeConnector: 'quickbooks', reason: 'retired_chart', committed: 'c', remedy: 'r' },
  )
  assert.deepEqual(refusals[0], handled, 'the row is exactly as the mark left it')
  assert.ok(activity.some((entry) => entry.action === 'accounting_posting_refused_after_handled_by_hand'), 'and the refusal is logged')
})

test('[o3d-j625 r6 H4] a row IMS clears by queueing the posting records HOW it was resolved', async () => {
  refusals.push(refusal('r11', 'tax_rate_sync', { type: 'TAX_RATE_SYNC', referenceType: 'TaxRate', scope: '' }))
  const { clearAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  await clearAccountingPostingRefusal({ accountingPostingRefusal: refusalTable }, { type: 'TAX_RATE_SYNC', referenceType: 'TaxRate', referenceId: 'po-r11', scope: '' })
  assert.ok(refusals[0]!.resolvedAt)
  assert.equal(refusals[0]!.resolution, 'queued')
  assert.equal(refusals[0]!.resolvedBy, null)
  assert.equal(refusals[0]!.suppressedAt, null, 'an automatic clear suppresses nothing')
})

// o3d-j625 r7 (review H-A): the kinds r6 called AUTO although their retry can stick for ever. Each is now
// closable — and closing it suppresses IMS's own retry of the same posting.
for (const [kind, type, referenceType, why] of [
  ['unrealised_fx_journal', 'UNREALISED_FX_JOURNAL', 'FxRevaluation', 'the daily run only values today, so a refused journal for an earlier date is never raised again'],
  ['sales_invoice_held_release', 'SALES_INVOICE', 'SalesOrder', 'the sweep replays the frozen chart, so after a permanent switch it refuses on every run'],
  ['refund_cogs_reversal', 'COGS_REVERSAL', 'SalesOrderRefund', 'the refund retry replays the staged connector'],
  ['credit_note_allocation', 'PURCHASE_CREDIT_NOTE_ALLOCATION', 'SupplierCreditNote', 'the sweep refuses every run until both documents are the active connector\'s'],
  ['invoice_payment_receipt', 'INVOICE_PAYMENT', 'SalesOrder', 'nothing re-drives a refused receipt on an invoice with no pending follow-up'],
] as const) {
  test(`[o3d-j625 r7 H-A] a stuck ${kind} row can be closed — ${why}`, async () => {
    refusals.push(refusal('stuck', kind, { type, referenceType }))
    assert.deepEqual(await mark('stuck', 'posted by hand'), { success: true })
    assert.equal(refusals[0]!.resolution, 'handled_manually')
    assert.ok(refusals[0]!.suppressedAt, 'and IMS will not post it')
  })
}

/**
 * o3d-j625 r7 (mutation survivors H4-2 and H4-4) — the two conditions that no test reached.
 *
 * The mark reads the row BEFORE it takes the per-key lock, so everything it decided from that read is a
 * live check, not a held one; the resolving write restates BOTH conditions (still outstanding, still a
 * markable kind) so a row that moved under the lock is refused instead of resolved. `resolvedAt` was
 * covered; the kind was not, because against the real map the earlier check already caught it.
 */
test('[o3d-j625 r7] the resolve restates the KIND too: a row that stops being markable under the lock is refused, not resolved', async () => {
  /**
   * o3d-j625 r16: driven through the CONFIRM step alone, with the claim already held. The assertion is about
   * the resolve's own `kind` predicate — that it restates under the lock what the read decided before it —
   * and routing through the claim first would move the kind before the claim's own check and refuse there
   * instead, which is a different (also correct) refusal and would leave this predicate unexamined.
   */
  refusals.push(refusal('r12', 'stock_receipt_journal', {
    handPostClaimedAt: new Date('2026-09-26T09:00:00Z'), handPostClaimedBy: 'user-1',
  }))
  onSyncRead = () => { refusals[0]!.kind = 'tax_rate_sync'; onSyncRead = null }

  const result = await markOnly('r12', 'posted by hand as MJ-12')

  assert.equal(locks.length > 0, true, 'PRECONDITION: the lock was taken, so the row moved at the only moment it could')
  assert.equal(onSyncRead, null, 'PRECONDITION: the injection point was REACHED — the kind really did move')
  assert.equal(refusals[0]!.kind, 'tax_rate_sync', 'PRECONDITION: the row is no longer of a markable kind')
  assert.equal(ok(result), false, `it must not resolve: ${JSON.stringify(result)}`)
  assert.match(errorOf(result), /changed while it was being marked/)
  assert.equal(refusals[0]!.resolvedAt, null, 'nothing was resolved')
  assert.equal(refusals[0]!.suppressedAt, null, 'and nothing was suppressed, so IMS still posts it')
})

test('[o3d-j625 r6 H4/r7] a row IMS cleared by QUEUEING the posting, refused again, reopens with the old resolution wiped', async () => {
  refusals.push(refusal('r13', 'stock_receipt_journal', {
    resolvedAt: new Date('2026-09-10T00:00:00Z'), resolution: 'queued', resolvedBy: 'user-9', resolutionNote: 'the old note',
  }))
  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')

  await recordAccountingPostingRefusal(
    { accountingPostingRefusal: refusalTable },
    { type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: 'po-r13', scope: 'k-r13' },
    { kind: 'stock_receipt_journal', chartConnector: 'xero', activeConnector: 'quickbooks', reason: 'retired_chart', committed: 'c', remedy: 'r' },
  )

  assert.equal(refusals[0]!.suppressedAt, null, 'PRECONDITION: this row was never marked handled, so it DOES reopen')
  assert.equal(refusals[0]!.resolvedAt, null, 'PRECONDITION: it reopened')
  assert.equal(refusals[0]!.resolution, null, 'and it no longer claims to have been resolved by queueing')
  assert.equal(refusals[0]!.resolvedBy, null)
  assert.equal(refusals[0]!.resolutionNote, null)
  assert.equal(refusals[0]!.refusedCount, 1, 'and the count is this episode\'s')
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// o3d-j625 r20 (Codex round 19, HIGH) — EVERY ACTIVE CLAIM IS REACHABLE AND RELEASABLE, WHATEVER THE COUNT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
//
// r18 gave the claims their own section with a cap of 500 and argued a number far above the refusal list's
// 50 could not hide one. Round 19 reproduced the same defect at 500: with 500 older claims AND enough older
// refusals a newer claim is in NEITHER list, its holder can leave, the claim never expires, and the
// aggregate count gives nobody a way to act on it. A cap of any size is a reachability limit, so the answer
// is not a bigger number — it is that nothing is unreachable.
//
// These tests use a page of 50 (the shipped HAND_POST_CLAIM_PAGE) and put the target BEYOND it, which is
// the boundary round 19 said was untested. Every one of them ends in a RELEASE through the real action, not
// in "the row came back": reachable and releasable is the property, and r18's own disclosure was that its
// HIGH-2 test asserted `refusalId` was present rather than that anything could be done with it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const CLAIM_PAGE = 50

/** An OUTSTANDING refusal held by `holder` since `at` — one active hand-post claim. */
function claimed(id: string, at: string, holder = 'user-2', overrides: Partial<Refusal> = {}): Refusal {
  return refusal(id, 'stock_receipt_journal', {
    handPostClaimedAt: new Date(at),
    handPostClaimedBy: holder,
    ...overrides,
  })
}

/** Seed `count` active claims, oldest first, plus one TARGET taken last so it sorts to the very end. */
function seedClaimsPast(count: number, target: { id: string; referenceId: string }): void {
  for (let index = 0; index < count; index += 1) {
    const minute = String(index).padStart(3, '0')
    refusals.push(claimed(`older-${minute}`, `2026-09-01T00:00:${'00'}.${minute}Z`))
  }
  refusals.push(claimed(target.id, '2026-09-20T12:00:00.000Z', 'user-2', { referenceId: target.referenceId }))
}

async function listClaims(params?: { cursor?: string | null; search?: string | null }) {
  const { listAccountingHandPostClaimsAction } = await import('@/app/actions/sync-exceptions')
  return listAccountingHandPostClaimsAction(params)
}

async function releaseClaim(id: string) {
  const { releaseAccountingPostingRefusalHandPostClaimAction } = await import('@/app/actions/sync-exceptions')
  return releaseAccountingPostingRefusalHandPostClaimAction(id)
}

test('[o3d-j625 r20 HIGH] a claim BEYOND the first page is reached by walking the cursor — and released from there', async () => {
  seedClaimsPast(CLAIM_PAGE + 10, { id: 'target', referenceId: 'po-target-walk' })

  const first = await listClaims()
  // PRECONDITIONS — the boundary is really crossed. Printed, so a fixture that stopped exercising it is
  // visible rather than inferred: this is the exact shape round 19 said was never tested.
  console.log(`[r20 walk] page1=${first.claims.length} total=${first.total} cursor=${first.nextCursor} `
    + `targetOnPage1=${first.claims.some((claim) => claim.refusalId === 'target')}`)
  assert.equal(first.claims.length, CLAIM_PAGE, 'PRECONDITION: the first page is full, so the page boundary bites')
  assert.equal(first.total, CLAIM_PAGE + 11, 'PRECONDITION: and there are more active claims than one page')
  assert.equal(first.claims.some((claim) => claim.refusalId === 'target'), false,
    'PRECONDITION (and round 19\'s finding): the target is NOT on the first page')

  // THE WALK. Every page carries the cursor to the next, so the far end is reachable by following them.
  let cursor = first.nextCursor
  let found = null as null | { refusalId: string; by: string | null; byName: string | null }
  let pages = 1
  while (cursor && pages < 20) {
    const page = await listClaims({ cursor })
    pages += 1
    found = page.claims.find((claim) => claim.refusalId === 'target') ?? found
    cursor = page.nextCursor
  }
  console.log(`[r20 walk] pages walked=${pages} found=${JSON.stringify(found)}`)
  assert.ok(found, 'THE FINDING: a claim past the page boundary must be REACHABLE — r18 stopped at the cap '
    + 'and the claim behind it could never be acted on, with no expiry to end it')
  assert.equal(found.by, 'user-2')
  assert.equal(found.byName, 'Holder Two', 'with the holder NAMED — a user id is not something to act on')
  assert.equal(cursor, null, 'and the walk ENDS: the last page says so rather than looping')

  // AND RELEASABLE FROM THERE. This is the whole point of reaching it, and r18 asserted only the field.
  const released = await releaseClaim('target')
  console.log(`[r20 walk] release=${JSON.stringify(released)}`)
  assert.equal(ok(released), true)
  const row = refusals.find((r) => r.id === 'target')!
  assert.equal(row.handPostClaimedAt, null, 'the claim is given back')
  assert.equal(row.handPostClaimedBy, null)
  assert.equal(row.resolvedAt, null, 'and the refusal stays outstanding, as a release always leaves it')
})

test('[o3d-j625 r20 HIGH] a claim beyond the first page is reached by LOOKUP — and released from there', async () => {
  seedClaimsPast(CLAIM_PAGE + 10, { id: 'target', referenceId: 'po-target-lookup' })
  const first = await listClaims()
  assert.equal(first.claims.some((claim) => claim.refusalId === 'target'), false, 'PRECONDITION: off page 1')

  const hit = await listClaims({ search: 'PO-TARGET-LOOKUP' })
  console.log(`[r20 lookup] matched=${hit.matched} total=${hit.total} ids=${JSON.stringify(hit.claims.map((c) => c.refusalId))}`)
  assert.equal(hit.matched, 1, 'the lookup says how many matched, not how many exist')
  assert.equal(hit.total, CLAIM_PAGE + 11, 'and still reports the true total, so a search cannot hide the rest')
  assert.deepEqual(hit.claims.map((claim) => claim.refusalId), ['target'],
    'THE SECOND ROUTE: an operator who knows the DOCUMENT goes straight to it — case-insensitively, because '
    + 'a reference typed in the other case is not a different document')

  assert.equal(ok(await releaseClaim(hit.claims[0]!.refusalId)), true)
  assert.equal(refusals.find((r) => r.id === 'target')!.handPostClaimedAt, null)
})

test('[o3d-j625 r20] the lookup matches exactly what the page says it matches — and nothing else', async () => {
  refusals.push(claimed('by-ref', '2026-09-01T00:00:00Z', 'user-2', { referenceId: 'so-9001' }))
  refusals.push(claimed('by-type', '2026-09-01T00:00:01Z', 'user-2', { type: 'CREDIT_NOTE', referenceId: 'so-9002' }))
  refusals.push(claimed('by-reftype', '2026-09-01T00:00:02Z', 'user-2', { referenceType: 'SupplierCreditNote', referenceId: 'so-9003' }))
  refusals.push(claimed('other', '2026-09-01T00:00:03Z', 'user-2', { referenceId: 'so-9004' }))

  assert.deepEqual((await listClaims({ search: 'so-9001' })).claims.map((c) => c.refusalId), ['by-ref'], 'reference id')
  assert.deepEqual((await listClaims({ search: 'CREDIT_NOTE' })).claims.map((c) => c.refusalId), ['by-type'], 'posting type')
  assert.deepEqual((await listClaims({ search: 'SupplierCreditNote' })).claims.map((c) => c.refusalId), ['by-reftype'], 'reference type')
  assert.deepEqual((await listClaims({ search: 'by-reftype' })).claims.map((c) => c.refusalId), ['by-reftype'], 'the refusal id')
  // THE ABSENCE HALF, which is the one that makes the hint honest: the page says NOT the holder's name, and
  // it means it. Without this the hint could promise less than the code does and nobody would notice.
  assert.deepEqual((await listClaims({ search: 'Holder Two' })).claims.map((c) => c.refusalId), [],
    'the holder NAME is not searched, and the hint on the page says so')
  assert.equal((await listClaims({ search: '   ' })).claims.length, 4, 'a blank search is no search, not "match nothing"')
  assert.equal((await listClaims({ search: '   ' })).matched, null, 'and it is reported as no search at all')
})

test('[o3d-j625 r20] the walk does not skip a claim when one is RELEASED under it — the reason the cursor is a keyset', async () => {
  for (let index = 0; index < CLAIM_PAGE + 3; index += 1) {
    refusals.push(claimed(`c-${String(index).padStart(3, '0')}`, `2026-09-01T00:00:00.${String(index).padStart(3, '0')}Z`))
  }
  const first = await listClaims()
  assert.equal(first.claims.length, CLAIM_PAGE, 'PRECONDITION: a full first page')
  const cursorRow = first.claims[CLAIM_PAGE - 1]!.refusalId

  // The operator does exactly what this section is for: they release a claim they just read. With an OFFSET
  // every later row would move up one and the first row of page 2 would never be returned; with PRISMA's
  // positional `cursor` the row the cursor NAMES has just stopped matching, so page 2 would come back empty
  // and every claim after it would be unreachable. A keyset over (handPostClaimedAt, id) names a POSITION.
  assert.equal(ok(await releaseClaim(cursorRow)), true, 'PRECONDITION: the cursor row itself is released')
  assert.equal(ok(await releaseClaim(first.claims[0]!.refusalId)), true, 'PRECONDITION: and one before it')

  const second = await listClaims({ cursor: first.nextCursor })
  console.log(`[r20 keyset] page2=${JSON.stringify(second.claims.map((c) => c.refusalId))}`)
  assert.deepEqual(second.claims.map((claim) => claim.refusalId), ['c-050', 'c-051', 'c-052'],
    'the three claims after the cursor are all still returned — none skipped by a shifted offset, and the '
    + 'walk not ended by a cursor row that no longer exists')
  assert.equal(second.nextCursor, null)
  assert.equal(ok(await releaseClaim('c-052')), true, 'and the last one is releasable from there')
})

test('[o3d-j625 r20] two claims taken in the SAME millisecond are both reached — the id is in the sort key', async () => {
  // Fill a page with claims that all share one instant, so the page boundary falls INSIDE the tie. Without
  // `id` in the order the tie is broken arbitrarily by the database and one of them can sit on neither page.
  for (let index = 0; index < CLAIM_PAGE + 2; index += 1) {
    refusals.push(claimed(`tie-${String(index).padStart(3, '0')}`, '2026-09-01T00:00:00.000Z'))
  }
  const first = await listClaims()
  const second = await listClaims({ cursor: first.nextCursor })
  const seen = [...first.claims, ...second.claims].map((claim) => claim.refusalId)
  console.log(`[r20 tie] page1=${first.claims.length} page2=${second.claims.length} distinct=${new Set(seen).size}`)
  assert.equal(seen.length, CLAIM_PAGE + 2, 'every claim appears')
  assert.equal(new Set(seen).size, CLAIM_PAGE + 2, 'exactly once — no row on two pages and none on neither')
  assert.equal(ok(await releaseClaim('tie-051')), true, 'and the one past the boundary is releasable')
})

/**
 * o3d-j625 r20 (round 19's open next step) — A NON-HOLDER RELEASES ANOTHER OPERATOR'S CLAIM.
 *
 * r18 STATED that anybody with `sync` may do this and gave the reason (a claim taken by someone who has left
 * would otherwise suppress that posting for ever). Round 19 listed verifying it as unproven, so it was a
 * claim about the code rather than a property of it. Driven end to end here: the viewer is `user-1`, the
 * holder is `user-2`, and what is asserted is the WRITE and the RECORD, not the wording.
 */
test('[o3d-j625 r20] a NON-HOLDER with sync releases another operator\'s claim, and the WARNING names who released whose', async () => {
  refusals.push(claimed('held-by-two', '2026-09-20T08:00:00.000Z', 'user-2'))
  const before = refusals[0]!
  assert.equal(before.handPostClaimedBy, 'user-2', 'PRECONDITION: the holder is NOT the viewer')

  const result = await releaseClaim('held-by-two')
  console.log(`[r20 non-holder] result=${JSON.stringify(result)} permissions=${JSON.stringify(permissionsAsked)}`)

  assert.equal(ok(result), true, 'THE PROPERTY: a non-holder is not refused — otherwise a departed holder\'s '
    + 'claim is a permanent suppression, which is what this whole section exists to end')
  assert.equal(permissionsAsked.includes('fresh:sync'), true,
    'and it is still gated: the release is a WRITE, fresh-authenticated like every other one here')
  assert.equal(before.handPostClaimedAt, null, 'the claim is cleared')
  assert.equal(before.handPostClaimedBy, null)
  assert.equal(before.resolvedAt, null, 'the refusal stays OUTSTANDING — releasing settles nothing')

  const entry = activity.find((item) => item.action === 'accounting_posting_refusal_hand_post_claim_released')
  console.log(`[r20 non-holder] activity=${JSON.stringify(entry)}`)
  assert.ok(entry, 'the release is recorded')
  assert.equal((entry as { level?: string }).level, 'WARNING',
    'at WARNING: taking a posting back from somebody who may have posted it by hand is the one act that can '
    + 'let the ledger get it twice, and it has to be findable afterwards')
  assert.equal(entry.metadata?.heldBy, 'user-2', 'naming WHOSE claim it was')
  assert.equal(entry.metadata?.releasedBy, 'user-1', 'and WHO took it back — two different people, recorded as such')
  assert.equal(typeof entry.metadata?.heldSince, 'string', 'and since when they had held it')
})

test('[o3d-j625 r20 CONTROL] releasing a posting NOBODY holds is still refused', async () => {
  refusals.push(refusal('unheld', 'stock_receipt_journal'))
  const result = await releaseClaim('unheld')
  assert.equal(ok(result), false,
    'CONTROL: the release above succeeded because the claim EXISTED and a non-holder may end it — not '
    + 'because this action succeeds unconditionally')
  assert.match(errorOf(result), /Nobody is settling this posting by hand/)
})

/**
 * o3d-j625 r20 — A CURSOR THAT CANNOT BE READ RESTARTS THE WALK; IT DOES NOT END IT.
 *
 * Found by the mutation harness, not by the tests above: making `decodeHandPostClaimCursor` answer a
 * far-future position instead of `null` left every one of them green, because none ever handed back
 * anything but a cursor the server had just issued. A browser that has been open across a deploy, a copied
 * URL, a truncated string — any of those and the walk would return an empty page for ever, which is this
 * round's finding arriving through its own remedy. So the degrade is asserted rather than assumed.
 */
test('[o3d-j625 r20] an unreadable cursor RESTARTS the walk rather than returning nothing', async () => {
  for (let index = 0; index < 5; index += 1) {
    refusals.push(claimed(`m-${index}`, `2026-09-01T00:00:0${index}.000Z`))
  }
  /**
   * o3d-j625 r22 — RE-STATED FOR AN IDENTITY CURSOR, because the set of unreadable forms shrank with the key.
   *
   * r20's cursor was `<ISO time>|<id>` and could be malformed five ways. A cursor is now the bare row id, so
   * the only forms that carry no position are the empty and blank ones — and those still restart the walk
   * rather than returning nothing. An id that no longer EXISTS is not unreadable and is deliberately not
   * treated as such: the keyset compares values, so a released row's id still names the position it had.
   */
  for (const blank of ['', '   ', '\t']) {
    const page = await listClaims({ cursor: blank })
    console.log(`[r20 bad cursor] ${JSON.stringify(blank)} -> ${page.claims.length} claims`)
    assert.equal(page.claims.length, 5,
      `a cursor carrying no position (${JSON.stringify(blank)}) must return the FIRST page, not an empty one — `
      + 'an empty one makes every claim after it unreachable, which is round 19\'s defect')
  }
  // CONTROL: a cursor that names a position still advances, so "restart" is the degrade and not the behaviour.
  const after = await listClaims({ cursor: 'm-2' })
  assert.deepEqual(after.claims.map((claim) => claim.refusalId), ['m-3', 'm-4'],
    'CONTROL: a cursor naming a position advances past it')
  // AND A POSITION WHOSE ROW IS GONE still advances rather than restarting or ending: that is the whole point
  // of comparing values instead of using Prisma's positional cursor (o3d-j625 r20).
  assert.equal(ok(await releaseClaim('m-2')), true)
  assert.deepEqual((await listClaims({ cursor: 'm-2' })).claims.map((claim) => claim.refusalId), ['m-3', 'm-4'],
    'a cursor whose row has been released still names its position — the walk neither ends nor restarts')
  /**
   * AND A CURSOR NOBODY ISSUED CANNOT SILENTLY END THE WALK EARLY. An identity cursor is a bare string, so a
   * mangled one can sort past every row and return nothing — which is why the completeness sentence is a
   * MEASUREMENT (`totalAtEnd`) and not an inference from an empty page. Asserted, because "it cannot happen"
   * was the shape of r20's cap argument.
   */
  const past = await listClaims({ cursor: 'zzzzzzzz' })
  console.log(`[r20 bad cursor] beyond-every-id -> ${past.claims.length} claims, totalAtEnd=${past.totalAtEnd}`)
  assert.equal(past.claims.length, 0, 'it returns nothing, as any position past the end would')
  assert.ok((past.totalAtEnd ?? 0) > 0,
    'but it reports the true total AS OF THEN, so the page says "showing 0 of N" rather than "that is every '
    + 'active claim" — the sentence is earned even when the cursor was never ours')
  assert.equal(ok(await releaseClaim('m-4')), true, 'and what the walk reaches is releasable')
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// o3d-j625 r22 (Codex round 21, HIGH) — A RE-TAKEN CLAIM CANNOT BE SKIPPED, OR SEEN TWICE, BY THE WALK
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
//
// r20's cursor was a keyset over `(handPostClaimedAt, id)` and r20 called the pagination "the completeness
// guarantee" — "no claim is unreachable" was meant to be a property of the ordering. Round 21 found that the
// FIRST component of that key is REWRITTEN on every re-take, from the application process's own clock, and
// this module already knows those clocks disagree: it is exactly why r18 counted deferrals with a causal
// counter instead of comparing `lastRefusedAt` with `handPostClaimedAt`. So:
//
//   · RE-TAKEN ON A SLOWER PROCESS, new stamp BEFORE page one's cursor → no later page returns the claim.
//     The walk ends, the page says it has shown every active claim, and that one is still held. Round 19's
//     defect arriving through the remedy for round 19's defect.
//   · RE-TAKEN with a LATER stamp → the claim is returned again on a later page. Shown twice.
//
// THE FIX IS A KEY THAT CANNOT MOVE: the cursor is the row's `id`, assigned at creation and rewritten by
// nothing in this module. The tests below therefore assert a property of the ORDERING rather than of a
// timing, and they SIMULATE the disagreeing clocks explicitly — the re-take is driven through the real
// `claimPostingForHandPosting` with an injected `now`, which is precisely what a process whose clock is
// behind (or ahead) would write. Nothing here depends on how fast the test runs.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

async function reclaim(id: string, at: string, userId = 'user-3') {
  const { claimPostingForHandPosting } = await import('@/lib/domain/accounting/posting-mark-handled')
  return claimPostingForHandPosting(tx as never, { id, userId, now: new Date(at) })
}

/**
 * Walk from page one to the end, returning every claim id the walk yielded — WITH duplicates, because
 * "returned twice" is one of the two failures and a Set would hide it.
 */
async function walkAllClaimIds(): Promise<string[]> {
  const seen: string[] = []
  let page = await listClaims()
  let guard = 0
  for (;;) {
    seen.push(...page.claims.map((claim) => claim.refusalId))
    if (!page.nextCursor || guard > 20) break
    guard += 1
    page = await listClaims({ cursor: page.nextCursor })
  }
  return seen
}

/** The state round 21 describes: a full first page, and one claim beyond it that nobody has seen yet. */
function seedUnseenTarget(): { firstPageLastAt: Date } {
  for (let index = 0; index < CLAIM_PAGE; index += 1) {
    // Ids ascend with the claim times here, so page one is the same set under either ordering — the
    // reproduction is about the RE-TAKE, not about which rows page one happens to contain.
    refusals.push(claimed(`page1-${String(index).padStart(3, '0')}`, `2026-09-10T00:00:${String(index % 60).padStart(2, '0')}.000Z`))
  }
  // Beyond page one under both orderings: later claim time AND a later id.
  refusals.push(claimed('zz-target', '2026-09-11T00:00:00.000Z', 'user-2', { referenceId: 'po-retake' }))
  return { firstPageLastAt: new Date(`2026-09-10T00:00:${String((CLAIM_PAGE - 1) % 60).padStart(2, '0')}.000Z`) }
}

test('[o3d-j625 r22 HIGH] an UNSEEN claim re-taken with an EARLIER stamp (a slower clock) is still returned, exactly once', async () => {
  const { firstPageLastAt } = seedUnseenTarget()

  const first = await listClaims()
  assert.equal(first.claims.length, CLAIM_PAGE, 'PRECONDITION: page one is full, so there is a boundary')
  assert.equal(first.claims.some((claim) => claim.refusalId === 'zz-target'), false,
    'PRECONDITION: and the target is BEYOND it — unseen, which is round 21\'s case')
  assert.ok(first.nextCursor, 'PRECONDITION: the walk continues')

  // ── THE CONCURRENT ACT, entirely legitimate: somebody gives the claim back and somebody takes it again.
  //    The re-take runs on a process whose clock is BEHIND, so the stamp it writes lands before the one page
  //    one was built from. Simulated by injecting `now`, not by racing the test runner.
  assert.equal(ok(await releaseClaim('zz-target')), true, 'released')
  const skewed = '2026-09-09T00:00:00.000Z'
  const retaken = await reclaim('zz-target', skewed)
  assert.equal(retaken.ok, true, `re-taken (${JSON.stringify(retaken)})`)
  const target = refusals.find((row) => row.id === 'zz-target')!
  console.log(`[r22 earlier] page1 last claim time=${firstPageLastAt.toISOString()} `
    + `re-taken at=${target.handPostClaimedAt?.toISOString()} holder=${target.handPostClaimedBy}`)
  assert.ok(target.handPostClaimedAt && target.handPostClaimedAt < firstPageLastAt,
    'PRECONDITION — AND THE MECHANISM: the re-take wrote a stamp EARLIER than the last row of page one, which '
    + 'is what a keyset over `handPostClaimedAt` puts on the far side of its own cursor. Two application '
    + 'clocks disagreeing is all it takes, and this module already knows they do (o3d-j625 r12, r18).')
  assert.equal(target.handPostClaimedBy, 'user-3', 'and it really is held again, by somebody else')

  // ── THE PROPERTY. Continue the SAME walk from the cursor page one issued.
  const rest: string[] = []
  let cursor: string | null = first.nextCursor
  let guard = 0
  while (cursor && guard < 20) {
    const page = await listClaims({ cursor })
    rest.push(...page.claims.map((claim) => claim.refusalId))
    cursor = page.nextCursor
    guard += 1
  }
  console.log(`[r22 earlier] rest of the walk=${JSON.stringify(rest)}`)
  assert.deepEqual(rest, ['zz-target'],
    'THE FINDING: with a cursor over a REWRITABLE key the re-taken claim falls before the saved position and '
    + 'no later page returns it — the walk ends, the page says it has shown every active claim, and this one '
    + 'is still held by user-3. The cursor is the row IDENTITY now, which a re-take cannot rewrite, so the '
    + 'claim is on exactly one page whatever any clock says.')

  // AND IT IS RELEASABLE FROM THERE, which is the whole point of reaching it.
  assert.equal(ok(await releaseClaim('zz-target')), true)
  assert.equal(refusals.find((row) => row.id === 'zz-target')!.handPostClaimedAt, null)
})

test('[o3d-j625 r22 HIGH] an UNSEEN claim re-taken with a LATER stamp is returned ONCE, not twice', async () => {
  seedUnseenTarget()
  const first = await listClaims()
  assert.equal(first.claims.some((claim) => claim.refusalId === 'zz-target'), false, 'PRECONDITION: unseen')

  assert.equal(ok(await releaseClaim('zz-target')), true)
  // A clock that is AHEAD. Under r20's keyset this is the mirror defect: the row sorts later than before, so
  // it is returned on a later page as well as being counted as a fresh position — shown twice.
  assert.equal((await reclaim('zz-target', '2026-09-30T00:00:00.000Z')).ok, true)

  const everything = await walkAllClaimIds()
  const occurrences = everything.filter((id) => id === 'zz-target').length
  console.log(`[r22 later] walk length=${everything.length} distinct=${new Set(everything).size} target occurrences=${occurrences}`)
  assert.equal(occurrences, 1,
    'THE MIRROR FINDING: a re-take with a LATER stamp moves the row to a position the walk has not passed, so '
    + 'a timestamp keyset hands it to the operator a second time. Identity does not move, so it appears once.')
  assert.equal(everything.length, CLAIM_PAGE + 1, 'and the walk as a whole is exactly the claim set')
  assert.equal(new Set(everything).size, everything.length, 'with no row on two pages')
})

test('[o3d-j625 r22] the walk visits every claim exactly once while claims are re-taken THROUGHOUT it', async () => {
  // Not one boundary but every page: after each page, release and re-take a claim the walk has NOT reached,
  // alternating a clock that is behind and one that is ahead. If the ordering key can move, one of these
  // lands on the wrong side of the cursor.
  for (let index = 0; index < CLAIM_PAGE * 2 + 5; index += 1) {
    refusals.push(claimed(`c-${String(index).padStart(3, '0')}`, `2026-09-15T00:00:${String(index % 60).padStart(2, '0')}.000Z`))
  }
  const active = refusals.length
  const seen: string[] = []
  let page = await listClaims()
  let flip = 0
  let guard = 0
  for (;;) {
    seen.push(...page.claims.map((claim) => claim.refusalId))
    if (!page.nextCursor || guard > 20) break
    // A row the walk has not reached yet: the LAST one by id, which is also the last one it would reach.
    const unseen = `c-${String(active - 1).padStart(3, '0')}`
    if (!seen.includes(unseen)) {
      assert.equal(ok(await releaseClaim(unseen)), true)
      assert.equal((await reclaim(unseen, flip % 2 === 0 ? '2026-09-01T00:00:00.000Z' : '2026-10-01T00:00:00.000Z')).ok, true)
      flip += 1
    }
    guard += 1
    page = await listClaims({ cursor: page.nextCursor })
  }
  console.log(`[r22 throughout] re-takes=${flip} seen=${seen.length} distinct=${new Set(seen).size} of ${active}`)
  assert.ok(flip >= 2, 'PRECONDITION: the re-take really happened between pages, more than once')
  assert.equal(seen.length, active, 'every claim was returned')
  assert.equal(new Set(seen).size, active, 'exactly once each — none skipped and none repeated')
})

/**
 * o3d-j625 r22 — AND THE COMPLETENESS SENTENCE IS A MEASUREMENT.
 *
 * Identity ordering stops a RE-TAKE moving a row across an issued cursor. It cannot make a claim TAKEN during
 * the walk appear after the cursor — no non-snapshot pagination can — so "that is every active claim" must be
 * checked rather than assumed. The server sends the total as of the LAST page and the page compares it with
 * what it actually showed. Asserted here because a sentence nobody checks is how r20's cap read as complete.
 */
test('[o3d-j625 r22] the last page carries the total AS OF THEN, and only the last page', async () => {
  for (let index = 0; index < CLAIM_PAGE + 3; index += 1) {
    refusals.push(claimed(`t-${String(index).padStart(3, '0')}`, `2026-09-16T00:00:${String(index % 60).padStart(2, '0')}.000Z`))
  }
  const first = await listClaims()
  assert.equal(first.totalAtEnd, null, 'a mid-walk total says nothing about the end of the walk, so it is withheld')
  assert.ok(first.nextCursor)

  // A claim TAKEN while the operator is walking, on a row whose id sorts BEFORE the cursor page one issued —
  // the case identity ordering cannot and does not cover, and no non-snapshot pagination can.
  refusals.push(claimed('a-late-arrival', '2026-09-16T12:00:00.000Z'))
  const last = await listClaims({ cursor: first.nextCursor })
  console.log(`[r22 earned] page1=${first.claims.length} page2=${last.claims.length} totalAtEnd=${last.totalAtEnd}`)
  assert.equal(last.nextCursor, null, 'PRECONDITION: this is the last page')
  assert.equal(last.totalAtEnd, CLAIM_PAGE + 4,
    'and it reports the total AS OF THEN — including the claim taken mid-walk, which is what lets the page say '
    + '"showing N of M" instead of claiming completeness it cannot have')
  assert.equal(last.claims.some((claim) => claim.refusalId === 'a-late-arrival'), false,
    'PRECONDITION: the mid-walk arrival sorts BEFORE the cursor, so this walk never sees it — which is the '
    + 'residual identity ordering does not close and must therefore not be called complete')
  assert.ok(first.claims.length + last.claims.length < (last.totalAtEnd ?? 0),
    `the walk showed ${first.claims.length + last.claims.length} of ${last.totalAtEnd}: FEWER than the total, `
    + 'which is exactly the state the page must report as "showing N of M" rather than as complete')
})

test('[o3d-j625 r22] the LONGEST-HELD head is age-ordered, bounded, and only on the first unfiltered page', async () => {
  refusals.push(claimed('young', '2026-09-20T00:00:00.000Z', 'user-2', { referenceId: 'po-young' }))
  refusals.push(claimed('ancient', '2026-01-01T00:00:00.000Z', 'user-2', { referenceId: 'po-ancient' }))
  refusals.push(claimed('middling', '2026-06-01T00:00:00.000Z', 'user-2', { referenceId: 'po-middling' }))

  const first = await listClaims()
  console.log(`[r22 head] walk=${JSON.stringify(first.claims.map((c) => c.refusalId))} `
    + `longestHeld=${JSON.stringify(first.longestHeld.map((c) => c.refusalId))}`)
  // THE PROPERTY THE WALK GAVE UP. Identity ordering puts 'ancient' in the middle of the walk ('ancient' <
  // 'middling' < 'young' is a coincidence of these names, so the walk is asserted only to CONTAIN them);
  // the head is what makes the longest-held one impossible to miss.
  assert.deepEqual(first.longestHeld.map((claim) => claim.refusalId), ['ancient', 'middling', 'young'],
    'HELD LONGEST FIRST — the surfacing oldest-claim-first bought, kept as a display aid now that the walk is '
    + 'ordered by a key a re-take cannot rewrite')
  assert.equal(first.longestHeld[0]!.stale, true, 'and the longest-held one is flagged')
  assert.ok(first.longestHeld.length <= 10, 'bounded: it is a look, not a route — the complete walk is below it')

  // NOT re-stated on a later page or under a lookup: it is about the whole set, and repeating it there would
  // make a filtered view look like it had extra rows.
  for (let index = 0; index < CLAIM_PAGE; index += 1) {
    refusals.push(claimed(`pad-${String(index).padStart(3, '0')}`, `2026-09-21T00:00:${String(index % 60).padStart(2, '0')}.000Z`))
  }
  const paged = await listClaims()
  assert.ok(paged.nextCursor, 'PRECONDITION: there is a second page now')
  assert.deepEqual((await listClaims({ cursor: paged.nextCursor })).longestHeld, [], 'not on a later page')
  assert.deepEqual((await listClaims({ search: 'po-ancient' })).longestHeld, [], 'nor under a lookup')
  // CONTROL: it IS non-empty on the first unfiltered page, so the two assertions above are about the
  // condition and not about a field that is always empty.
  assert.ok(paged.longestHeld.length > 0, 'CONTROL: the first unfiltered page does carry it')
})

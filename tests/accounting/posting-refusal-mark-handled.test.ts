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

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key]
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('in' in (condition as object) && !(condition as { in: unknown[] }).in.includes(value)) return false
      if ('not' in (condition as object) && value === (condition as { not: unknown }).not) return false
    } else if (value !== condition) return false
  }
  return true
}

const refusalTable = {
  findUnique: async ({ where }: { where: { id?: string; type_referenceType_referenceId_scope?: Record<string, unknown> } }) =>
    (where.id !== undefined
      ? refusals.find((row) => row.id === where.id)
      : refusals.find((row) => matches(row as unknown as Record<string, unknown>, where.type_referenceType_referenceId_scope!))) ?? null,
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hits = refusals.filter((row) => matches(row as unknown as Record<string, unknown>, where))
    for (const hit of hits) Object.assign(hit, data)
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
const syncTable = {
  findMany: async ({ where }: { where: Record<string, unknown> }) => syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, where)),
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hits = syncRows.filter((row) => matches(row as unknown as Record<string, unknown>, where))
    for (const hit of hits) Object.assign(hit, data)
    return { count: hits.length }
  },
}
const tx = {
  accountingPostingRefusal: refusalTable,
  accountingSyncLog: syncTable,
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { locks.push(`${strings.join('?')}:${values.join(',')}`); return 1 },
}
mock.module('@/lib/db', {
  namedExports: {
    db: { ...tx, $transaction: async <T>(fn: (client: unknown) => Promise<T>) => fn(tx) },
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
})

async function mark(id: string, note = '') {
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
  assert.equal(locks.length, 1, 'under the per-posting-key lock the row-creating primitive takes')
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

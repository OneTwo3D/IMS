import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r6 (review H4; owner decision 2026-09-18) — "MARK AS HANDLED", ON MANUAL-ONLY ROWS AND NO OTHERS.
 *
 * Driven through the real server action over a table double that APPLIES the action's where-clause (id,
 * still outstanding, a manual kind), so what is asserted is which rows the write can reach — the property
 * that decides whether a row IMS would have cleared can be dismissed by hand.
 */
type Row = {
  id: string; type: string; referenceType: string; referenceId: string; scope: string; kind: string | null
  resolvedAt: Date | null; resolution: string | null; resolvedBy: string | null; resolutionNote: string | null
  firstRefusedAt: Date; refusedCount: number; detail: unknown
}
const rows: Row[] = []
const permissionsAsked: string[] = []
const activity: Array<{ action: string; metadata?: Record<string, unknown> }> = []
let denyFresh = false

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = (row as unknown as Record<string, unknown>)[key]
    if (condition && typeof condition === 'object' && 'in' in (condition as object)) {
      if (!(condition as { in: unknown[] }).in.includes(value)) return false
    } else if (condition && typeof condition === 'object' && 'not' in (condition as object)) {
      if (value === (condition as { not: unknown }).not) return false
    } else if (value !== condition) return false
  }
  return true
}

const table = {
  findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hits = rows.filter((row) => matches(row, where))
    for (const hit of hits) Object.assign(hit, data)
    return { count: hits.length }
  },
  upsert: async ({ where, create, update }: { where: { type_referenceType_referenceId_scope: Record<string, unknown> }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
    const hit = rows.find((row) => matches(row, where.type_referenceType_referenceId_scope))
    if (hit) {
      for (const [key, value] of Object.entries(update)) {
        (hit as unknown as Record<string, unknown>)[key] = value && typeof value === 'object' && 'increment' in (value as object)
          ? Number((hit as unknown as Record<string, unknown>)[key] ?? 0) + (value as { increment: number }).increment
          : value
      }
      return hit
    }
    rows.push({ refusedCount: 1, resolvedAt: null, resolution: null, resolvedBy: null, resolutionNote: null, ...create } as unknown as Row)
    return create
  },
}

mock.module('@/lib/db', { namedExports: { db: { accountingPostingRefusal: table } } })
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

function row(id: string, kind: string | null, overrides: Partial<Row> = {}): Row {
  return {
    id, type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: `po-${id}`, scope: `k-${id}`, kind,
    resolvedAt: null, resolution: null, resolvedBy: null, resolutionNote: null,
    firstRefusedAt: new Date('2026-09-01T00:00:00Z'), refusedCount: 1, detail: null, ...overrides,
  }
}

test.beforeEach(() => {
  rows.length = 0
  permissionsAsked.length = 0
  activity.length = 0
  denyFresh = false
})

async function mark(id: string, note = '') {
  const { markAccountingPostingRefusalHandledAction } = await import('@/app/actions/sync-exceptions')
  return markAccountingPostingRefusalHandledAction(id, note)
}

test('[o3d-j625 r6 H4] a MANUAL-ONLY row is marked handled — who, when, how, and the note', async () => {
  rows.push(row('r1', 'stock_receipt_journal'))
  const result = await mark('r1', '  Xero MJ-0042  ')
  assert.deepEqual(result, { success: true })
  assert.ok(rows[0]!.resolvedAt instanceof Date)
  assert.equal(rows[0]!.resolution, 'handled_manually')
  assert.equal(rows[0]!.resolvedBy, 'user-1')
  assert.equal(rows[0]!.resolutionNote, 'Xero MJ-0042', 'trimmed, stored as text')
  assert.ok(permissionsAsked.includes('fresh:sync'), 'behind a FRESH sign-in with the inbox\'s own permission')
  assert.ok(activity.some((entry) => entry.action === 'accounting_posting_refusal_marked_handled'), 'and it is logged')
})

test('[o3d-j625 r6 H4] an AUTO-CLEARING row is REFUSED server-side, whatever the page showed', async () => {
  rows.push(row('r2', 'sales_invoice_held_release', { type: 'SALES_INVOICE', referenceType: 'SalesOrder' }))
  const result = await mark('r2')
  assert.equal((result as { success: boolean }).success, false)
  assert.match(String((result as { error?: string }).error), /clears this row itself/)
  assert.equal(rows[0]!.resolvedAt, null, 'still outstanding: IMS will clear it when the posting is queued')
})

test('[o3d-j625 r6 H4] a row with NO kind (written before the column) is refused — fail closed', async () => {
  rows.push(row('r3', null))
  const result = await mark('r3')
  assert.equal((result as { success: boolean }).success, false)
  assert.equal(rows[0]!.resolvedAt, null)
})

test('[o3d-j625 r6 H4] the WRITE itself excludes AUTO rows — a race past the read cannot close one', async () => {
  // The read says manual; the row is re-refused as an AUTO kind before the write lands. The conditional
  // update names the manual kinds, so it matches nothing.
  rows.push(row('r4', 'stock_receipt_journal'))
  const original = table.findUnique
  table.findUnique = async (args) => {
    const found = await original(args)
    rows[0]!.kind = 'tax_rate_sync'
    return found ? { ...found, kind: 'stock_receipt_journal' } : null
  }
  try {
    const result = await mark('r4')
    assert.equal((result as { success: boolean }).success, false)
    assert.equal(rows[0]!.resolvedAt, null)
  } finally {
    table.findUnique = original
  }
})

test('[o3d-j625 r6 H4] an already-resolved row is refused, and a double submit resolves it ONCE', async () => {
  rows.push(row('r5', 'purchase_invoice', { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice' }))
  // A REAL race: both submits READ the row as outstanding before either WRITES. Without the barrier the
  // two calls could run one after the other and the read alone would refuse the second, proving nothing
  // about the write's own condition.
  const original = table.findUnique
  let arrived = 0
  let release: () => void = () => {}
  const bothRead = new Promise<void>((resolve) => { release = resolve })
  table.findUnique = async (args) => {
    const found = await original(args)
    const snapshot = found ? { ...found } : null
    arrived++
    if (arrived === 2) release()
    await bothRead
    return snapshot
  }
  let results: unknown[]
  try {
    results = await Promise.all([mark('r5', 'first'), mark('r5', 'second')])
  } finally {
    table.findUnique = original
  }
  const [first, second] = results
  const successes = [first, second].filter((r) => (r as { success: boolean }).success)
  assert.equal(successes.length, 1, 'one of the two concurrent submits resolves it')
  assert.equal(rows[0]!.resolutionNote, successes[0] === first ? 'first' : 'second', 'and its note is the one kept')
  const third = await mark('r5', 'third')
  assert.equal((third as { success: boolean }).success, false)
  assert.match(String((third as { error?: string }).error), /already resolved/)
})

test('[o3d-j625 r6 H4] the note is length-limited', async () => {
  const { POSTING_REFUSAL_NOTE_MAX_LENGTH } = await import('@/lib/domain/accounting/posting-refusal-kinds')
  rows.push(row('r6', 'stock_receipt_journal'))
  const result = await mark('r6', 'x'.repeat(POSTING_REFUSAL_NOTE_MAX_LENGTH + 1))
  assert.equal((result as { success: boolean }).success, false)
  assert.equal(rows[0]!.resolvedAt, null)
})

test('[o3d-j625 r6 H4] a missing fresh sign-in returns the fresh-auth answer and writes nothing', async () => {
  rows.push(row('r7', 'stock_receipt_journal'))
  denyFresh = true
  const result = await mark('r7')
  assert.equal((result as { freshAuthRequired?: boolean }).freshAuthRequired, true)
  assert.equal(rows[0]!.resolvedAt, null)
})

test('[o3d-j625 r6 H4] the same posting refused AGAIN after being marked handled reopens as a new episode', async () => {
  rows.push(row('r8', 'stock_receipt_journal', { refusedCount: 3 }))
  await mark('r8', 'posted as MJ-9')
  assert.ok(rows[0]!.resolvedAt, 'PRECONDITION: handled')

  const { recordAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  await recordAccountingPostingRefusal(
    { accountingPostingRefusal: table },
    { type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', referenceId: 'po-r8', scope: 'k-r8' },
    { kind: 'stock_receipt_journal', chartConnector: 'xero', activeConnector: 'quickbooks', reason: 'retired_chart', committed: 'c', remedy: 'r' },
  )
  assert.equal(rows[0]!.resolvedAt, null, 'outstanding again')
  assert.equal(rows[0]!.resolution, null)
  assert.equal(rows[0]!.resolvedBy, null)
  assert.equal(rows[0]!.resolutionNote, null, 'the previous episode\'s note does not describe this one')
  assert.equal(rows[0]!.refusedCount, 1, 'counted from the new episode (M-13)')
})

test('[o3d-j625 r6 H4] a row IMS clears by queueing the posting records HOW it was resolved', async () => {
  rows.push(row('r9', 'tax_rate_sync', { type: 'TAX_RATE_SYNC', referenceType: 'TaxRate', scope: '' }))
  const { clearAccountingPostingRefusal } = await import('@/lib/domain/accounting/posting-refusal-inbox')
  await clearAccountingPostingRefusal({ accountingPostingRefusal: table }, { type: 'TAX_RATE_SYNC', referenceType: 'TaxRate', referenceId: 'po-r9', scope: '' })
  assert.ok(rows[0]!.resolvedAt)
  assert.equal(rows[0]!.resolution, 'queued')
  assert.equal(rows[0]!.resolvedBy, null, 'nobody — IMS did it')
})

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------------------------
// o3d-hl8l r4 (Codex r3 finding 1) — A REFUSED CALLBACK MUST RECOVER WITHOUT ANYONE NOTICING IT.
//
// The maintenance fence refuses booked-in callbacks with a 503 and writes no row (it runs before
// signature verification, and rows written into the window are replayed over). Rounds 1-3 said the
// loss was bounded by a sender retry, an operator "Re-check" button and the watchdog's alert. All
// three are conditional, and on a default installation none of them held: the button existed on the
// purchase-order ASN table only, and the watchdog was registered `defaultEnabled: false`. A
// stock-transfer ASN plus a non-retrying sender therefore stayed IN_TRANSIT with its destination
// stock never applied, and nothing anywhere ever said so.
//
// These pin the automatic recovery: the end of a maintenance window is stamped, and the Mintsoft
// webhook sweeper (`defaultEnabled: true`, every five minutes) drains that stamp by re-checking
// every open ASN of BOTH source types.
// ---------------------------------------------------------------------------------------------

type AsnRow = {
  externalAsnId: string
  connector: string
  closedAt: Date | null
  status: string
  sourceType: string
  createdAt: Date
}

const state = {
  settings: new Map<string, string>(),
  asns: [] as AsnRow[],
  logs: [] as Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }>,
  rechecked: [] as Array<{ externalAsnId: string; reason: string }>,
  recheckThrowsFor: null as string | null,
  deletedKeys: [] as string[],
}

// The `where` is APPLIED, not ignored. A double that hands back every ASN it holds cannot observe
// the closed/CREATE_PENDING exclusions at all, so it would pass whether or not the query has them.
function matchesAsnWhere(row: AsnRow, where: {
  connector: string
  closedAt: null
  status: { notIn: string[] }
  sourceType?: string
}): boolean {
  if (row.connector !== where.connector) return false
  if (where.closedAt === null && row.closedAt !== null) return false
  if (where.status.notIn.includes(row.status)) return false
  // Applied so a query that narrows to one ASN kind is VISIBLE here. Silently ignoring an
  // unexpected clause is how a double stops being able to observe the thing under test.
  if (where.sourceType !== undefined && row.sourceType !== where.sourceType) return false
  return true
}

const db = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) =>
      (state.settings.has(where.key) ? { key: where.key, value: state.settings.get(where.key) } : null),
    deleteMany: async ({ where }: { where: { key: string } }) => {
      state.deletedKeys.push(where.key)
      return { count: state.settings.delete(where.key) ? 1 : 0 }
    },
  },
  wmsAsnMap: {
    findMany: async (args: {
      where: { connector: string; closedAt: null; status: { notIn: string[] }; sourceType?: string }
      orderBy: { createdAt: 'asc' }
      take: number
    }) => {
      const rows = state.asns
        .filter((row) => matchesAsnWhere(row, args.where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, args.take)
      return rows.map((row) => ({ externalAsnId: row.externalAsnId }))
    },
  },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      state.logs.push(entry)
    },
  },
})

function loadSweep() {
  return import('../lib/domain/wms/post-maintenance-recheck.ts')
}

// Stated literally here and pinned against the export below, so a rename of the key cannot silently
// turn every test in this file into one that arranges a marker nothing ever reads.
const WMS_BOOKED_IN_RECHECK_DUE_KEY = 'wms_booked_in_recheck_due_since'

const deps = {
  recheckAsn: async (externalAsnId: string, options: { reason: string }) => {
    if (state.recheckThrowsFor === externalAsnId) throw new Error(`WMS unreachable for ${externalAsnId}`)
    state.rechecked.push({ externalAsnId, reason: options.reason })
  },
}

function asn(overrides: Partial<AsnRow> & { externalAsnId: string }): AsnRow {
  return {
    connector: 'mintsoft',
    closedAt: null,
    status: 'CREATED',
    sourceType: 'PURCHASE_ORDER',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  }
}

function reset() {
  state.settings.clear()
  state.asns = []
  state.logs = []
  state.rechecked = []
  state.recheckThrowsFor = null
  state.deletedKeys = []
}

test('o3d-hl8l r4: with no marker the pass does nothing — a re-check is not a routine sweep', async () => {
  reset()
  state.asns = [asn({ externalAsnId: 'ASN-1' })]

  const { runPostMaintenanceBookedInRecheck } = await loadSweep()
  const result = await runPostMaintenanceBookedInRecheck('mintsoft', deps)

  assert.equal(result.skipped, true)
  assert.deepEqual(state.rechecked, [], 'no maintenance window closed, so no ASN is re-read from the WMS')
})

test('o3d-hl8l r4: a closed window re-checks open ASNs of BOTH source types, not just purchase orders', async () => {
  reset()
  state.settings.set(WMS_BOOKED_IN_RECHECK_DUE_KEY, '2026-07-20T10:00:00.000Z')
  state.asns = [
    asn({ externalAsnId: 'ASN-PO', sourceType: 'PURCHASE_ORDER', createdAt: new Date('2026-07-01T00:00:00Z') }),
    asn({ externalAsnId: 'ASN-TRANSFER', sourceType: 'STOCK_TRANSFER', createdAt: new Date('2026-07-02T00:00:00Z') }),
  ]

  const { runPostMaintenanceBookedInRecheck } = await loadSweep()
  const result = await runPostMaintenanceBookedInRecheck('mintsoft', deps)

  assert.equal(result.skipped, false)
  assert.deepEqual(
    state.rechecked.map((r) => r.externalAsnId),
    ['ASN-PO', 'ASN-TRANSFER'],
    'the stock-transfer ASN is the half that had NO recovery control at all — it must be covered by '
      + 'the same pass, because the candidates come from the ASN table and not from whichever screens have a button',
  )
  assert.match(
    state.rechecked[0].reason,
    /automatic re-check after maintenance window ended 2026-07-20T10:00:00\.000Z/,
    'the reconstructed trigger records WHY it exists, so the row is not mistaken for a delivered callback',
  )
  assert.equal(result.drained, true)
  assert.deepEqual(state.deletedKeys, [WMS_BOOKED_IN_RECHECK_DUE_KEY], 'a fully attempted pass clears the stamp')
})

test('o3d-hl8l r4: a closed ASN and one never created in the WMS are excluded from the re-check', async () => {
  reset()
  state.settings.set(WMS_BOOKED_IN_RECHECK_DUE_KEY, '2026-07-20T10:00:00.000Z')
  state.asns = [
    asn({ externalAsnId: 'ASN-OPEN' }),
    asn({ externalAsnId: 'ASN-CLOSED', closedAt: new Date('2026-07-05T00:00:00Z') }),
    asn({ externalAsnId: 'ASN-PENDING', status: 'CREATE_PENDING' }),
    asn({ externalAsnId: 'ASN-IN-FLIGHT', status: 'CREATE_IN_FLIGHT' }),
    asn({ externalAsnId: 'ASN-OTHER-CONNECTOR', connector: 'other' }),
  ]

  const { runPostMaintenanceBookedInRecheck } = await loadSweep()
  await runPostMaintenanceBookedInRecheck('mintsoft', deps)

  assert.deepEqual(
    state.rechecked.map((r) => r.externalAsnId),
    ['ASN-OPEN'],
    'a reservation with a synthetic external id has no shipment to re-read, and a closed ASN owes nothing',
  )
})

test('o3d-hl8l r4: the stamp is KEPT when a re-check throws, so the next tick retries it', async () => {
  reset()
  state.settings.set(WMS_BOOKED_IN_RECHECK_DUE_KEY, '2026-07-20T10:00:00.000Z')
  state.asns = [
    asn({ externalAsnId: 'ASN-OK', createdAt: new Date('2026-07-01T00:00:00Z') }),
    asn({ externalAsnId: 'ASN-BAD', createdAt: new Date('2026-07-02T00:00:00Z') }),
  ]
  state.recheckThrowsFor = 'ASN-BAD'

  const { runPostMaintenanceBookedInRecheck } = await loadSweep()
  const result = await runPostMaintenanceBookedInRecheck('mintsoft', deps)

  assert.equal(result.failed, 1)
  assert.deepEqual(state.deletedKeys, [], 'clearing the stamp here would abandon the ASN that failed')
  assert.equal(
    state.settings.get(WMS_BOOKED_IN_RECHECK_DUE_KEY),
    '2026-07-20T10:00:00.000Z',
    'the marker survives so the whole pass repeats — re-checking a recovered ASN books nothing in',
  )
  assert.equal(result.drained, false, 'and the caller is told the pass did not finish')
  assert.deepEqual(
    state.rechecked.map((r) => r.externalAsnId),
    ['ASN-OK'],
    'and one failure does not abort the ASNs after it',
  )
  const entry = state.logs.find((log) => log.action === 'wms_post_maintenance_recheck')
  if (!entry) throw new Error('the pass must leave a record that it ran')
  assert.equal(entry.level, 'WARNING')
  assert.match(entry.description, /1 could not be re-checked and will be retried/)
})

test('o3d-hl8l r4: a page-truncated pass keeps the stamp rather than dropping the remainder', async () => {
  reset()
  state.settings.set(WMS_BOOKED_IN_RECHECK_DUE_KEY, '2026-07-20T10:00:00.000Z')
  state.asns = [
    asn({ externalAsnId: 'ASN-OLD', createdAt: new Date('2026-07-01T00:00:00Z') }),
    asn({ externalAsnId: 'ASN-NEW', createdAt: new Date('2026-07-09T00:00:00Z') }),
  ]

  const { runPostMaintenanceBookedInRecheck } = await loadSweep()
  const result = await runPostMaintenanceBookedInRecheck('mintsoft', deps, { pageSize: 1 })

  assert.equal(result.attempted, 1)
  assert.deepEqual(state.deletedKeys, [], 'the ASNs beyond the page have not been re-checked yet')
  assert.equal(result.drained, false, 'a truncated page has not finished the pass')
  assert.deepEqual(
    state.rechecked.map((r) => r.externalAsnId),
    ['ASN-OLD'],
    'oldest first: a truncated page must take the ASNs that have been waiting longest',
  )
  const entry = state.logs.find((log) => log.action === 'wms_post_maintenance_recheck')
  assert.match(entry?.description ?? '', /more remain and will be re-checked next tick/)
})

test('o3d-hl8l r4: the page size is bounded so a backlog cannot stall the five-minute sweeper', async () => {
  const { POST_MAINTENANCE_RECHECK_PAGE_SIZE } = await loadSweep()
  assert.ok(POST_MAINTENANCE_RECHECK_PAGE_SIZE > 0 && POST_MAINTENANCE_RECHECK_PAGE_SIZE <= 500)
})

test('o3d-hl8l r4: the marker key the sweep drains is the one disableMaintenanceMode stamps', async () => {
  const maintenance = await import('../lib/maintenance-mode.ts')
  assert.equal(
    maintenance.WMS_BOOKED_IN_RECHECK_DUE_KEY,
    WMS_BOOKED_IN_RECHECK_DUE_KEY,
    'the writer and the reader must name the same Setting key, or the recovery never fires',
  )
})

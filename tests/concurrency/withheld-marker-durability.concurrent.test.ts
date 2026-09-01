import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-psrx r5 (Codex HIGH 2) — AN UNRESOLVED REVERSAL IS STILL WORKED AFTER THE RETENTION WINDOW.
 *
 * The withheld-reversal marker IS the work item: round 4 built the queue out of activity rows on
 * purpose, so that an entry can only exist if an operator was actually told. Two things then quietly
 * threw the queue away.
 *
 *   THE SCAN'S OWN HORIZON. `openWithheldDocuments` ignored anything older than thirty days, on the
 *   reasoning that an open marker is rewritten every time it is reconsidered. True, and it is the
 *   poll NOT RUNNING that produces an old marker — a disabled connector, an expired credential, a
 *   maintenance window, a poller erroring every cycle — and a failed recheck deliberately leaves the
 *   marker untouched. The watermark had already advanced, so nothing else ever brings the document
 *   back.
 *
 *   ACTIVITY-LOG RETENTION. The open markers are WARNING rows in a table this repository prunes on a
 *   configurable schedule. Sixty days by default, oldest first — which is exactly the documents
 *   nobody has resolved.
 *
 * Both are the stranding the watermark fix existed to prevent, on a slower clock: `paidAt` left
 * standing against a ledger that disagrees, and nothing left to say so.
 *
 * THE FIXTURES ARE FOUR HUNDRED DAYS OLD, well past any horizon and any plausible retention setting,
 * and the test ASSERTS that before it asserts anything else — a fixture inside the window would pass
 * both halves of this file while proving neither.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-psrx r5 concurrency test requires a Postgres DATABASE_URL')
  }
}

async function loadDb() {
  loadEnv()
  const { db } = await import('@/lib/db')
  return db
}

type Db = Awaited<ReturnType<typeof loadDb>>

const DAY_MS = 24 * 60 * 60 * 1000
const AGED_DAYS = 400

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS)

async function writeMarker(
  db: Db,
  row: { id: string; entityId: string; action: string; level: 'INFO' | 'WARNING'; connector: string | null; createdAt: Date },
): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "activity_logs" (id, "entityType", "entityId", action, tag, level, description, metadata, "createdAt")
     VALUES ($1, 'SALES_ORDER'::"ActivityEntityType", $2, $3, 'sync', $4::"ActivityLogLevel", 'o3d-psrx r5 probe',
             $5::jsonb, $6::timestamptz AT TIME ZONE 'UTC')`,
    row.id,
    row.entityId,
    row.action,
    row.level,
    row.connector === null ? JSON.stringify({}) : JSON.stringify({ connector: row.connector }),
    row.createdAt.toISOString(),
  )
}

async function survivingIds(db: Db, ids: string[]): Promise<Set<string>> {
  const rows = await db.activityLog.findMany({ where: { id: { in: ids } }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

test(
  '[o3d-psrx r5] a marker older than every horizon is still in the recheck queue',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { openWithheldDocuments, dueWithheldMarkers, withheldEntityKey } =
      await import('@/lib/domain/accounting/withheld-reversal-markers')

    const run = `${process.pid}-${randomUUID()}`
    const stranded = `PSRX5-STRANDED-${run}`
    const settled = `PSRX5-SETTLED-${run}`
    const reconsidered = `PSRX5-RECONSIDERED-${run}`
    const ids: string[] = []
    const marker = async (row: Parameters<typeof writeMarker>[1]) => { ids.push(row.id); await writeMarker(db, row) }
    t.after(async () => { await db.activityLog.deleteMany({ where: { id: { in: ids } } }) })

    // The document a poll outage stranded: withheld once, never reconsidered since.
    await marker({ id: `al-str-${run}`, entityId: stranded, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
    // The CONTROL that keeps "return everything old" from passing: this one was settled.
    await marker({ id: `al-set-o-${run}`, entityId: settled, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
    await marker({ id: `al-set-c-${run}`, entityId: settled, action: 'payment_reversal_withheld_cleared', level: 'INFO', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 1) })
    // And one that HAS been reconsidered, so its history must not be what the scan reads its timer from.
    await marker({ id: `al-rec-o1-${run}`, entityId: reconsidered, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
    await marker({ id: `al-rec-o2-${run}`, entityId: reconsidered, action: 'payment_reversal_recheck_deferred', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 50) })

    // THE PRECONDITION. Round 4's horizon was thirty days; if these rows were inside it the
    // assertions below would hold for the wrong reason.
    assert.ok(AGED_DAYS - 50 > 30, 'every fixture must be older than the horizon this finding removed')

    const { open, closed } = await openWithheldDocuments({ connector: 'xero', legacyOwner: true })
    const openByKey = new Map(open.map((m) => [withheldEntityKey(m.entityType, m.entityId), m]))

    assert.ok(openByKey.has(withheldEntityKey('SALES_ORDER', stranded)),
      'a withheld reversal nobody reconsidered for over a year is still open work')
    assert.ok(!openByKey.has(withheldEntityKey('SALES_ORDER', settled)),
      'and a settled one has left the candidate set for good')

    const reconsideredMarker = openByKey.get(withheldEntityKey('SALES_ORDER', reconsidered))
    assert.ok(reconsideredMarker, 'a reconsidered document is still open')
    assert.equal(
      Math.round((Date.now() - reconsideredMarker.createdAt.getTime()) / DAY_MS), AGED_DAYS - 50,
      'and the timer is read from its LAST reconsideration, not from its history',
    )

    const due = dueWithheldMarkers(open, closed, Date.now())
    const dueKeys = new Set(due.map((m) => withheldEntityKey(m.entityType, m.entityId)))
    assert.ok(dueKeys.has(withheldEntityKey('SALES_ORDER', stranded)),
      'the stranded document is DUE — the whole point is that it goes back in front of the poller')
    assert.ok(!dueKeys.has(withheldEntityKey('SALES_ORDER', settled)))
  },
)

test(
  '[o3d-psrx r5] activity retention keeps the open marker and releases everything else',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const db = await loadDb()
    const { purgeExpiredActivityLogs } = await import('@/lib/activity-log-cleanup')

    const run = `${process.pid}-${randomUUID()}`
    const open = `PSRX5-R-OPEN-${run}`
    const settled = `PSRX5-R-SETTLED-${run}`
    const twoConnectors = `PSRX5-R-BOTH-${run}`
    const ids: string[] = []
    const marker = async (row: Parameters<typeof writeMarker>[1]) => { ids.push(row.id); await writeMarker(db, row) }
    t.after(async () => { await db.activityLog.deleteMany({ where: { id: { in: ids } } }) })

    // Still open: one current marker, and one history row from an earlier reconsideration.
    await marker({ id: `al-ro-old-${run}`, entityId: open, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
    await marker({ id: `al-ro-new-${run}`, entityId: open, action: 'payment_reversal_recheck_deferred', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 100) })
    // Settled: the closure must outlive the marker it settles, then go.
    await marker({ id: `al-rs-open-${run}`, entityId: settled, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })
    await marker({ id: `al-rs-close-${run}`, entityId: settled, action: 'payment_reversal_withheld_cleared', level: 'INFO', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 1) })
    // One document, two connectors. The newer XERO marker must not license deleting the QuickBooks
    // one — a marker scoped to a poller that is not running is not a marker that has been answered.
    await marker({ id: `al-rb-qbo-${run}`, entityId: twoConnectors, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'quickbooks', createdAt: daysAgo(AGED_DAYS) })
    await marker({ id: `al-rb-xero-${run}`, entityId: twoConnectors, action: 'payment_reversal_withheld', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS - 100) })
    // THE CONTROL THAT PROVES THE SWEEP REACHED THESE ROWS AT ALL. An ordinary aged `sync` WARNING,
    // same table, same age, no exemption: if this survives, the test has proved nothing.
    await marker({ id: `al-ctl-${run}`, entityId: open, action: 'payment_reversal_probe_control', level: 'WARNING', connector: 'xero', createdAt: daysAgo(AGED_DAYS) })

    const swept = await purgeExpiredActivityLogs()
    // THE PRECONDITION, TAKEN FROM THE SWEEP ITSELF RATHER THAN FROM THE SETTINGS TABLE. Retention is
    // configurable and defaults when unset, so reading the rows would be vacuous on a database that
    // has none. This is the window the sweep ACTUALLY used, and every fixture has to be outside it or
    // "the marker survived" is true of every row in the table.
    assert.ok(swept.retention.WARNING > 0 && swept.retention.WARNING < AGED_DAYS - 100,
      `WARNING retention ${swept.retention.WARNING}d leaves the fixtures inside the window`)
    assert.ok(swept.retention.INFO > 0 && swept.retention.INFO < AGED_DAYS - 1,
      `INFO retention ${swept.retention.INFO}d leaves the closure inside the window`)

    let alive = await survivingIds(db, ids)

    assert.ok(!alive.has(`al-ctl-${run}`), 'the sweep must actually have deleted an unexempt aged row')
    assert.ok(alive.has(`al-ro-new-${run}`), 'the open document keeps its CURRENT marker')
    assert.ok(!alive.has(`al-ro-old-${run}`), 'and lets its superseded history expire — the exemption is one row, not a log')
    assert.ok(alive.has(`al-rb-qbo-${run}`), "the other connector's open marker is not answered by this one's")
    assert.ok(alive.has(`al-rb-xero-${run}`))
    assert.ok(!alive.has(`al-rs-open-${run}`), 'a settled document releases its marker')
    assert.ok(alive.has(`al-rs-close-${run}`),
      'but its closure outlives it — INFO expires a month before WARNING, and a lone survivor would read as open again')

    // AND IT TERMINATES. With no open row left to protect it, the closure goes on the next sweep.
    await purgeExpiredActivityLogs()
    alive = await survivingIds(db, ids)
    assert.ok(!alive.has(`al-rs-close-${run}`), 'the settled document leaves nothing behind at all')
    assert.ok(alive.has(`al-ro-new-${run}`), 'and the open one is still open')
    assert.ok(alive.has(`al-rb-qbo-${run}`))
  },
)

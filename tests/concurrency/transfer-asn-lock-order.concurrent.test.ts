import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * 6oyu.19 / Codex round-9 MEDIUM-1 — THE TRANSFER/ASN DEADLOCK CYCLE.
 *
 * THE DEFECT. `receiveTransfer` locks `stock_transfers` and then — since round 6 of
 * this branch, via `absorbWmsSnapshotCreditIntoQtyReceived` — WRITES the line's
 * `wms_asn_line_maps` rows. The WMS webhook book-in locked those same ASN rows first
 * and reached `stock_transfers` only inside its receipt loop. Two transactions over
 * one transfer in opposite orders is a deadlock, which PostgreSQL breaks by aborting
 * one of them: a manual receipt or a webhook book-in is simply lost.
 *
 * Round 8 examined `receiveTransfer`, saw only reads of the ASN rows, and concluded
 * the branch was safe. That was true of the code the branch INHERITED and false of
 * the code it shipped — the round-6 write is what made `receiveTransfer` a
 * transfer→ASN path.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE ABOUT: LOCK ACQUISITION, NOT SOURCE TEXT.
 *
 * Three previous rounds argued the ordering from comments, and the comments were
 * wrong in both directions — round 7 asserted ASN-then-transfer was safe, round 8
 * asserted no lock could be taken at all. A source scanner would have agreed with
 * whichever comment was current. So nothing here reads the source.
 *
 * THE TRIPWIRE. To decide whether a path takes `stock_transfers` before
 * `wms_asn_line_maps`, hold the transfer row from another session and start the
 * path. It blocks. Then ask, from a THIRD session, whether the ASN row is still
 * lockable — `FOR UPDATE NOWAIT`, which raises 55P03 rather than waiting:
 *
 *   · lockable        → the path had not touched the ASN row before blocking on the
 *                       transfer, i.e. it takes the transfer FIRST. Conforms.
 *   · 55P03 refused   → the path is sitting on the ASN row while it waits for the
 *                       transfer, i.e. ASN FIRST. That is the cycle.
 *
 * This is a property of the locks the path actually took, observed from outside it.
 * A refactor that reorders the statements changes the answer; a refactor that only
 * rewrites the comments cannot.
 *
 * Needs a real PostgreSQL: row-lock ordering, NOWAIT and deadlock detection are all
 * properties of the database.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/domain/wms/mutation-audit', {
  namedExports: { recordWmsMutationEvent: async () => {} },
})
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: { allocateBackordersForProducts: async () => ({}) },
})
mock.module('@/lib/fulfillment/overallocation-rebalancer', {
  namedExports: { releaseOverallocations: async () => ({}) },
})

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  }
  return process.env.DATABASE_URL
}

const LINE_QTY = 10
const UNIT_COST = 5
/** Long enough to survive a loaded box, short enough to fail rather than hang. */
const BLOCK_WAIT_MS = 15000

type RawClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  release?: () => void
  end: () => Promise<void>
}

/** A dedicated connection, so a lock this session takes is genuinely its own. */
async function rawSession(databaseUrl: string): Promise<RawClient> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  return client as unknown as RawClient
}

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * THE WAIT, AND WHY IT IS WRITTEN THIS WAY (6oyu.19, Codex round-10 HIGH-3)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Every tripwire in this file works by holding a row, starting the path, waiting for
 * the path to BLOCK on that row, and then asking a third session what else the path
 * is holding. The wait is therefore load-bearing: probe too early and the path has
 * not reached its first lock, the row under the NOWAIT probe is free for the wrong
 * reason, and the tripwire reports "conforms" about a path it never observed.
 *
 * ROUND 9's WAIT COUNTED LOCK-BLOCKED BACKENDS in the database and returned when the
 * count rose above a baseline. That is an adjacent property, not the property: `npm
 * run test:concurrency` runs every file in `tests/concurrency/` as its own process
 * against ONE database, so any other file that parks a session on a row raises the
 * count and releases this file's probe early. The proof of the false positive is a
 * test in this file — `the wait is tied to THIS blocker` below — which stands up an
 * unrelated blocked pair and shows the round-9 predicate satisfied by it while
 * nothing at all is running against the fixture under test.
 *
 * THE WAIT BELOW NAMES BOTH ENDS instead of counting:
 *
 *   · WHICH BACKEND — `pg_blocking_pids(pid)` must contain the pid of the session
 *     THIS test parked. That session holds one row of one fixture, whose ids are
 *     unique to this test, so no other file's backend can be blocked by it.
 *   · ON WHAT — the blocked backend's current statement must name the table the
 *     tripwire is holding. A path blocked somewhere else entirely is not the
 *     observation the tripwire needs, and this is what says so.
 *
 * It returns the pid it identified, so a caller that needs the NEXT link — "and now
 * the backend blocked by THAT one" — walks the chain rather than counting again.
 */

type BlockedBackend = { pid: number; query: string }

/** This session's own backend pid: the identity a wait is tied to. */
async function backendPid(session: RawClient): Promise<number> {
  const { rows } = await session.query('SELECT pg_backend_pid()::int AS pid')
  return Number(rows[0]!.pid)
}

/**
 * Every backend this database currently reports as blocked by one of `blockerPids`.
 *
 * `pg_stat_activity.query` is only readable for backends belonging to the SAME role
 * (or to a superuser / pg_read_all_stats member). Every session in this file connects
 * with the one DATABASE_URL, so the statement text is visible. If that ever stops
 * being true the `waitingOn` filter matches nothing and the wait fails loudly on its
 * budget — the one direction a broken probe is allowed to fail in.
 */
async function backendsBlockedBy(probe: RawClient, blockerPids: number[]): Promise<BlockedBackend[]> {
  const { rows } = await probe.query(
    `SELECT a.pid::int AS pid, coalesce(a.query, '') AS query
       FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND NOT (a.pid = ANY($1::int[]))
        AND a.wait_event_type = 'Lock'
        AND pg_blocking_pids(a.pid) && $1::int[]
      ORDER BY a.pid`,
    [blockerPids],
  )
  return rows.map((row) => ({ pid: Number(row.pid), query: String(row.query) }))
}

/**
 * Block until a backend blocked BY one of `blockedBy` is waiting on a statement that
 * mentions `waitingOn`, and return it. Never a sleep, and never a population count.
 */
async function waitForBlockedBackend(probe: RawClient, params: {
  blockedBy: number[]
  waitingOn: RegExp
  /** Backends already identified in this chain, which must not be re-reported. */
  exclude?: number[]
  budgetMs?: number
  describe: string
}): Promise<BlockedBackend> {
  const exclude = params.exclude ?? []
  const deadline = Date.now() + (params.budgetMs ?? BLOCK_WAIT_MS)
  for (;;) {
    const blocked = (await backendsBlockedBy(probe, params.blockedBy))
      .filter((backend) => !exclude.includes(backend.pid) && params.waitingOn.test(backend.query))
    if (blocked.length > 0) return blocked[0]!
    if (Date.now() > deadline) {
      throw new Error(
        `${params.describe}: no backend blocked by ${params.blockedBy.join('/')} was waiting on `
        + `${params.waitingOn} within the wait budget. The path under test never reached that row lock, so `
        + 'this tripwire would prove nothing about acquisition order.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * THE ROUND-9 PREDICATE, kept only as the negative control.
 *
 * Nothing waits on this any more. It survives because the test that proves the new
 * wait is specific has to be able to show the old one firing on a backend that has
 * nothing to do with the path under test, and the only honest way to show that is to
 * evaluate the round-9 predicate itself.
 */
async function lockBlockedBackendPids(probe: RawClient): Promise<number[]> {
  const { rows } = await probe.query(
    `SELECT pid::int AS pid
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()`,
  )
  return rows.map((row) => Number(row.pid))
}

/**
 * A dispatched (IN_TRANSIT) transfer with a frozen snapshot and an OPEN ASN — the
 * state a WMS-fulfilled transfer sits in between dispatch and book-in.
 */
async function seedDispatchedTransferWithOpenAsn(
  label: string,
  options: { sourceStockLevel?: boolean; destinationStockLevel?: boolean } = {},
) {
  const { db } = await import('@/lib/db')

  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `R9LO-${label}-${process.pid}-${uid}`
  const product = await db.product.create({
    data: { sku: tag, name: `r9 lock order ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: `R9${uid}S`, name: `${tag} source`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })
  const destination = await db.warehouse.create({
    data: { code: `R9${uid}D`, name: `${tag} dest`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })

  const sourceLayer = await db.costLayer.create({
    data: {
      productId: product.id,
      warehouseId: source.id,
      receivedQty: `${LINE_QTY}.000000`,
      remainingQty: '0.000000',
      unitCostBase: UNIT_COST,
    },
    select: { id: true },
  })
  const snapshot = [{ costLayerId: sourceLayer.id, qty: `${LINE_QTY}.000000`, unitCostBase: `${UNIT_COST}.000000` }]

  const transfer = await db.stockTransfer.create({
    data: {
      reference: tag,
      fromWarehouseId: source.id,
      toWarehouseId: destination.id,
      status: 'IN_TRANSIT',
      dispatchedAt: new Date(),
      lines: {
        create: [{
          productId: product.id,
          sku: tag,
          productName: `r9 lock order ${label}`,
          qty: `${LINE_QTY}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: snapshot,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const transferLineId = transfer.lines[0]!.id

  // Materialised so another session can hold it FOR UPDATE. The cancellation path
  // locks the SOURCE stock level after its transfer and ASN locks, which is the only
  // place a test can park it while it still holds those two.
  if (options.sourceStockLevel) {
    await db.stockLevel.create({
      data: { productId: product.id, warehouseId: source.id, quantity: '0' },
      select: { productId: true },
    })
  }
  if (options.destinationStockLevel) {
    await db.stockLevel.create({
      data: { productId: product.id, warehouseId: destination.id, quantity: '0' },
      select: { productId: true },
    })
  }

  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
      externalAsnId: tag,
      sourceType: 'STOCK_TRANSFER',
      sourceId: transfer.id,
      warehouseId: destination.id,
      status: 'OPEN',
      lines: {
        create: [{
          externalAsnLineId: `${tag}-1`,
          sourceType: 'STOCK_TRANSFER_LINE',
          sourceLineId: transferLineId,
          productId: product.id,
          sku: tag,
          expectedQty: `${LINE_QTY}.0000`,
        }],
      },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
  })

  const binding = {
    id: `binding-${tag}`,
    connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture value, not a core flow branch
    active: true,
    externalWarehouseId: '1',
    stockSyncMode: 'ALIGN_TO_WMS' as const,
    syncFrequencyMinutes: 60,
    discrepancyThresholds: null,
    reportRecipients: [],
    alignmentConfirmedAt: new Date(),
    alignDownReasonId: null,
    warehouseId: destination.id,
    lastStockSyncAt: null,
    connection: { active: true },
    warehouse: destination,
  }

  return {
    db,
    tag,
    product,
    source,
    destination,
    transfer,
    transferLineId,
    asn,
    asnLineMapId: asn.lines[0]!.id,
    externalAsnLineId: asn.lines[0]!.externalAsnLineId,
    binding,
  }
}

/** Drive the real webhook book-in for the whole seeded line. */
async function runBookedIn(seeded: Awaited<ReturnType<typeof seedDispatchedTransferWithOpenAsn>>) {
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await seeded.db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
      externalEventId: `${seeded.tag}-evt-${Math.random().toString(36).slice(2, 8)}`,
      externalAsnId: seeded.tag,
      payload: { asnId: seeded.tag },
    },
    select: { id: true },
  })
  return processBookedInEvent(event.id, {
    fetchRemoteAsn: async () => ({
      externalAsnId: seeded.tag,
      status: 'RECEIVED',
      lines: [{
        externalLineId: seeded.externalAsnLineId,
        sourceLineId: seeded.transferLineId,
        externalProductId: null,
        sku: seeded.tag,
        quantity: LINE_QTY,
        raw: null,
      }],
      raw: null,
    }),
  })
}

/**
 * THE TRIPWIRE. Returns whether `run` acquired `stock_transfers` before
 * `wms_asn_line_maps`.
 *
 * The blocker holds the transfer row for the whole measurement, so `run` cannot get
 * past its transfer lock; the question is only whether it had already taken the ASN
 * row on the way there.
 */
async function acquiresTransferBeforeAsnLine(params: {
  databaseUrl: string
  transferId: string
  asnLineMapId: string
  run: () => Promise<unknown>
}): Promise<{ transferFirst: boolean; runOutcome: unknown; runError: unknown }> {
  const blocker = await rawSession(params.databaseUrl)
  const probe = await rawSession(params.databaseUrl)
  try {
    const blockerPid = await backendPid(blocker)
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [params.transferId])

    let runOutcome: unknown = null
    let runError: unknown = null
    const running = params.run().then(
      (value) => { runOutcome = value },
      (error) => { runError = error },
    )

    // THE path is now genuinely waiting on THE transfer row THIS blocker holds —
    // both halves named, so no other file's parked session can release the probe
    // (Codex round-10 HIGH-3).
    await waitForBlockedBackend(probe, {
      blockedBy: [blockerPid],
      waitingOn: /stock_transfers/i,
      describe: 'transfer-before-ASN tripwire',
    })

    let transferFirst: boolean
    await probe.query('BEGIN')
    try {
      await probe.query(
        'SELECT id FROM wms_asn_line_maps WHERE id = $1 FOR UPDATE NOWAIT',
        [params.asnLineMapId],
      )
      // Free: the path never touched it before blocking on the transfer.
      transferFirst = true
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== '55P03') throw error
      // Held by the path while it waits for the transfer: ASN row first.
      transferFirst = false
    }
    await probe.query('ROLLBACK')

    await blocker.query('ROLLBACK')
    await running
    return { transferFirst, runOutcome, runError }
  } finally {
    await blocker.end().catch(() => {})
    await probe.end().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// THE CYCLE ITSELF, with real code on one side
// ---------------------------------------------------------------------------

test(
  'the webhook book-in does not deadlock against a transfer-then-ASN writer (Codex r9 MEDIUM-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE TWO STATEMENTS THE BLOCKER ISSUES ARE `receiveTransfer`'S OWN, in its
    // order: lock `stock_transfers`, then take the line's `wms_asn_line_maps` rows
    // (which it does by UPDATEing them through
    // `absorbWmsSnapshotCreditIntoQtyReceived`). The real webhook book-in runs on the
    // other side.
    //
    // BEFORE THE FIX this is a true cycle and PostgreSQL breaks it: the book-in holds
    // the ASN rows and waits for the transfer, the blocker holds the transfer and
    // waits for the ASN rows, and one of the two dies with SQLSTATE 40P01.
    //
    // AFTER THE FIX the book-in takes the transfer FIRST, so it is blocked holding
    // nothing and the blocker's second statement is uncontended.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('cycle')

    const blocker = await rawSession(databaseUrl)
    const probe = await rawSession(databaseUrl)
    let bookedInOutcome: unknown = null
    let bookedInError: unknown = null
    let blockerError: unknown = null

    try {
      const blockerPid = await backendPid(blocker)
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [seeded.transfer.id])

      const running = runBookedIn(seeded).then(
        (value) => { bookedInOutcome = value },
        (error) => { bookedInError = error },
      )
      await waitForBlockedBackend(probe, {
        blockedBy: [blockerPid],
        waitingOn: /stock_transfers/i,
        describe: 'deadlock-cycle probe',
      })

      // The second half of the cycle. On the old order this is where Postgres has to
      // choose a victim.
      try {
        await blocker.query(
          `SELECT id FROM wms_asn_line_maps WHERE id = $1 FOR UPDATE`,
          [seeded.asnLineMapId],
        )
      } catch (error) {
        blockerError = error
      }
      await blocker.query('ROLLBACK').catch(() => {})
      await running
    } finally {
      await blocker.end().catch(() => {})
      await probe.end().catch(() => {})
    }

    const blockerCode = (blockerError as { code?: string } | null)?.code ?? null
    const bookedInMessage = bookedInError instanceof Error ? bookedInError.message : String(bookedInError ?? '')

    assert.notEqual(
      blockerCode,
      '40P01',
      'the transfer-then-ASN writer was chosen as the deadlock victim — the cycle is still open',
    )
    assert.ok(
      !/deadlock detected/i.test(bookedInMessage),
      `the webhook book-in died of a deadlock instead: ${bookedInMessage}`,
    )
    assert.equal(blockerError, null, `the ASN lock must be uncontended, got ${String(blockerError)}`)

    // And the book-in itself must have completed rather than merely not deadlocked —
    // otherwise this test would pass on a path that failed for some other reason
    // before ever taking a lock.
    assert.equal(
      (bookedInOutcome as { status?: string } | null)?.status,
      'processed',
      `the book-in must still succeed: ${JSON.stringify(bookedInOutcome)} / ${bookedInMessage}`,
    )
  },
)

test(
  'and the OPPOSITE orders really do deadlock — the test above is not vacuous (Codex r9)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // If PostgreSQL did not abort a transaction over these two rows taken in
    // opposite orders, the test above would pass no matter what the book-in did, and
    // the whole lock order would be ceremony. Two raw sessions, one row each, then
    // each reaches for the other's.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('cyclereal')

    const first = await rawSession(databaseUrl)
    const second = await rawSession(databaseUrl)
    let firstError: unknown = null
    let secondError: unknown = null
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      // TRANSFER → ASN (the receipt paths' order)
      await first.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [seeded.transfer.id])
      // ASN → TRANSFER (the order booked-in reconciliation used to take)
      await second.query('SELECT id FROM wms_asn_line_maps WHERE id = $1 FOR UPDATE', [seeded.asnLineMapId])

      const firstWaits = first.query(
        'SELECT id FROM wms_asn_line_maps WHERE id = $1 FOR UPDATE',
        [seeded.asnLineMapId],
      ).catch((error: unknown) => { firstError = error })
      const secondWaits = second.query(
        'SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE',
        [seeded.transfer.id],
      ).catch((error: unknown) => { secondError = error })

      await Promise.all([firstWaits, secondWaits])
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
    } finally {
      await first.end().catch(() => {})
      await second.end().catch(() => {})
    }

    const codes = [
      (firstError as { code?: string } | null)?.code,
      (secondError as { code?: string } | null)?.code,
    ]
    assert.ok(
      codes.includes('40P01'),
      `PostgreSQL must abort one of the two with 40P01; got ${JSON.stringify(codes)}`,
    )
  },
)

// ---------------------------------------------------------------------------
// THE ORDER, PATH BY PATH
// ---------------------------------------------------------------------------

test(
  'BOOK-IN takes stock_transfers before wms_asn_line_maps (Codex r9 MEDIUM-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The path that was the violator. This is the assertion that goes red on the
    // pre-fix code: the book-in used to hold the ASN rows from its very first lock
    // and reach `stock_transfers` only hundreds of lines later.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('bookin')
    const observed = await acquiresTransferBeforeAsnLine({
      databaseUrl,
      transferId: seeded.transfer.id,
      asnLineMapId: seeded.asnLineMapId,
      run: () => runBookedIn(seeded),
    })
    assert.equal(
      observed.transferFirst,
      true,
      'the book-in held wms_asn_line_maps while waiting for stock_transfers — that is the cycle',
    )
  },
)

test(
  'RECEIVE takes stock_transfers before wms_asn_line_maps (Codex r9 MEDIUM-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('receive')
    const { receiveTransfer } = await import('@/app/actions/transfers')
    const observed = await acquiresTransferBeforeAsnLine({
      databaseUrl,
      transferId: seeded.transfer.id,
      asnLineMapId: seeded.asnLineMapId,
      run: () => receiveTransfer(seeded.transfer.id),
    })
    assert.equal(observed.transferFirst, true)
  },
)

test(
  'CANCELLATION takes stock_transfers before wms_asn_line_maps (Codex r9 MEDIUM-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('cancel')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')
    const observed = await acquiresTransferBeforeAsnLine({
      databaseUrl,
      transferId: seeded.transfer.id,
      asnLineMapId: seeded.asnLineMapId,
      run: () => cancelDispatchedTransfer(seeded.transfer.id),
    })
    assert.equal(observed.transferFirst, true)
  },
)

test(
  'ALIGNMENT takes stock_transfers before wms_asn_line_maps (Codex r9 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // Alignment took NO locks at all before this round, so this assertion is also
    // what says the round-9 locks are really being acquired — a version that only
    // re-read without locking would report `transferFirst: true` for the wrong
    // reason, which is why the alignment race below is asserted on posted amounts
    // rather than on this.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('align')
    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')
    const observed = await acquiresTransferBeforeAsnLine({
      databaseUrl,
      transferId: seeded.transfer.id,
      asnLineMapId: seeded.asnLineMapId,
      run: () => applyMintsoftAlignmentForProduct({
        binding: seeded.binding as never,
        jobId: `r9-align-${Date.now()}`,
        productId: seeded.product.id,
        sku: seeded.tag,
        delta: LINE_QTY,
        dryRun: false,
      }),
    })
    assert.equal(observed.transferFirst, true)
  },
)

/**
 * THE SECOND PAIR: `wms_asn_line_maps` before `stock_levels`.
 *
 * WHY IT NEEDS ITS OWN TRIPWIRE. The one above holds the transfer row, so a path
 * that locks the transfer first blocks at its very first statement and never reaches
 * either of these two — which makes the transfer/ASN tripwire pass whether the ASN
 * lock is hoisted or not. (Proved: deleting the hoist from `receiveTransfer` left
 * all four of those tests green.) The pair the hoist actually orders is this one.
 *
 * It matters because `receiveTransfer` locks `stock_levels` and only then writes the
 * ASN rows, while booked-in reconciliation reaches `stock_levels` inside its receipt
 * loop, long after the ASN rows. Ordering only the transfer/ASN pair would have left
 * {stock_levels, wms_asn_line_maps} crossed in exactly the same way, one table over —
 * a fixed cycle replaced by an unfixed one.
 *
 * Same technique, one table down: hold the stock level, and ask whether the ASN row
 * is still free. Here the CONFORMING answer is 55P03 — the path should already be
 * holding the ASN row when it blocks on the stock level.
 */
async function acquiresAsnLineBeforeStockLevel(params: {
  databaseUrl: string
  productId: string
  warehouseId: string
  asnLineMapId: string
  run: () => Promise<unknown>
}): Promise<boolean> {
  const blocker = await rawSession(params.databaseUrl)
  const probe = await rawSession(params.databaseUrl)
  try {
    const blockerPid = await backendPid(blocker)
    await blocker.query('BEGIN')
    await blocker.query(
      'SELECT id FROM stock_levels WHERE "productId" = $1 AND "warehouseId" = $2 FOR UPDATE',
      [params.productId, params.warehouseId],
    )

    const running = params.run().then(() => {}, () => {})
    await waitForBlockedBackend(probe, {
      blockedBy: [blockerPid],
      waitingOn: /stock_levels/i,
      describe: 'ASN-before-stock tripwire',
    })

    let asnLineFirst: boolean
    await probe.query('BEGIN')
    try {
      await probe.query(
        'SELECT id FROM wms_asn_line_maps WHERE id = $1 FOR UPDATE NOWAIT',
        [params.asnLineMapId],
      )
      asnLineFirst = false
    } catch (error) {
      if ((error as { code?: string }).code !== '55P03') throw error
      asnLineFirst = true
    }
    await probe.query('ROLLBACK')

    await blocker.query('ROLLBACK')
    await running
    return asnLineFirst
  } finally {
    await blocker.end().catch(() => {})
    await probe.end().catch(() => {})
  }
}

test(
  'RECEIVE takes wms_asn_line_maps before stock_levels (Codex r9 MEDIUM-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('recvsl', { destinationStockLevel: true })
    const { receiveTransfer } = await import('@/app/actions/transfers')
    assert.equal(
      await acquiresAsnLineBeforeStockLevel({
        databaseUrl,
        productId: seeded.product.id,
        warehouseId: seeded.destination.id,
        asnLineMapId: seeded.asnLineMapId,
        run: () => receiveTransfer(seeded.transfer.id),
      }),
      true,
      'receiveTransfer blocked on stock_levels without holding the ASN rows it goes on to write — '
      + 'that is stock_levels-then-ASN, and the webhook book-in is ASN-then-stock_levels',
    )
  },
)

test(
  'CANCELLATION takes wms_asn_line_maps before stock_levels (Codex r9 MEDIUM-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('cancelsl', { sourceStockLevel: true })
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')
    assert.equal(
      await acquiresAsnLineBeforeStockLevel({
        databaseUrl,
        productId: seeded.product.id,
        warehouseId: seeded.source.id,
        asnLineMapId: seeded.asnLineMapId,
        run: () => cancelDispatchedTransfer(seeded.transfer.id),
      }),
      true,
    )
  },
)

test(
  'PARTIAL RECEIPT takes wms_asn_line_maps before stock_levels (Codex r9 MEDIUM-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The fourth transfer path. It does not WRITE the ASN rows, but it sizes the
    // receipt from them, so an alignment crediting them between the read and the
    // write offers up quantity that has already landed and been layered.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('partsl', { destinationStockLevel: true })
    const { receiveTransferPartial } = await import('@/app/actions/transfers')
    assert.equal(
      await acquiresAsnLineBeforeStockLevel({
        databaseUrl,
        productId: seeded.product.id,
        warehouseId: seeded.destination.id,
        asnLineMapId: seeded.asnLineMapId,
        run: () => receiveTransferPartial(
          seeded.transfer.id,
          [{ lineId: seeded.transferLineId, qty: 4 }],
          `r9-partsl-${Date.now()}`,
        ),
      }),
      true,
    )
  },
)

test(
  'BOOK-IN takes wms_asn_line_maps before stock_levels (Codex r9 — the other side of the pair)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The path the two above have to agree WITH. If this ever flipped, hoisting the
    // receipt paths' ASN locks would be the thing creating the cycle rather than
    // closing it, so it is asserted rather than assumed.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('bookinsl', { destinationStockLevel: true })
    assert.equal(
      await acquiresAsnLineBeforeStockLevel({
        databaseUrl,
        productId: seeded.product.id,
        warehouseId: seeded.destination.id,
        asnLineMapId: seeded.asnLineMapId,
        run: () => runBookedIn(seeded),
      }),
      true,
    )
  },
)

test(
  'ALIGNMENT takes wms_asn_line_maps before stock_levels (Codex r10 HIGH-2)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE HOLE ROUND 9 LEFT. Round 9 added this family precisely because the
    // transfer/ASN tripwire cannot see the ASN lock — a path that takes the transfer
    // first blocks at its first statement and never reaches either row, so deleting
    // the hoist left all four of those tests green. Round 9 then wrote the family
    // for receipt, cancellation, partial receipt and book-in and left ALIGNMENT out,
    // which put alignment back in exactly the blind spot the family exists to cover:
    // its `lockWmsAsnLineMaps` was asserted by nothing, and deleting it regressed
    // alignment to stock-before-ASN against a book-in that goes ASN-before-stock —
    // the same crossing, on the pair one table down (Codex round-10 HIGH-2).
    //
    // Same tripwire as the four above, and the conforming answer is the same 55P03:
    // when alignment blocks on the destination stock level it must ALREADY be
    // holding the ASN rows it planned from.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('alignsl', { destinationStockLevel: true })
    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')
    assert.equal(
      await acquiresAsnLineBeforeStockLevel({
        databaseUrl,
        productId: seeded.product.id,
        warehouseId: seeded.destination.id,
        asnLineMapId: seeded.asnLineMapId,
        run: () => applyMintsoftAlignmentForProduct({
          binding: seeded.binding as never,
          jobId: `r10-alignsl-${Date.now()}`,
          productId: seeded.product.id,
          sku: seeded.tag,
          delta: LINE_QTY,
          dryRun: false,
        }),
      }),
      true,
      'alignment blocked on stock_levels without holding the ASN rows its plan was built from — '
      + 'that is stock_levels-then-ASN, and the webhook book-in is ASN-then-stock_levels',
    )
  },
)

// ---------------------------------------------------------------------------
// THE WAIT ITSELF (Codex round-10 HIGH-3)
// ---------------------------------------------------------------------------

test(
  'the lock wait is tied to THIS blocker — the round-9 count was not (Codex r10 HIGH-3)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // Every tripwire in this file is only as good as the moment it probes at, and
    // round 9 chose that moment by counting lock-blocked backends in the database.
    // This test is the demonstration that the count is not about the path under
    // test: it stands up a lock-blocked pair on a DIFFERENT fixture — which is what
    // another file of `npm run test:concurrency` looks like, since the runner gives
    // every file its own process against ONE database — and shows the round-9
    // predicate satisfied by it while nothing whatsoever is running against this
    // test's own fixture. Then it shows the replacement refusing that same backend
    // and accepting only the one genuinely blocked by this test's blocker.
    const databaseUrl = loadEnv()
    const mine = await seedDispatchedTransferWithOpenAsn('waitmine')
    const other = await seedDispatchedTransferWithOpenAsn('waitother')

    const myBlocker = await rawSession(databaseUrl)
    const unrelatedHolder = await rawSession(databaseUrl)
    const unrelatedWaiter = await rawSession(databaseUrl)
    const probe = await rawSession(databaseUrl)
    try {
      const myBlockerPid = await backendPid(myBlocker)
      const unrelatedHolderPid = await backendPid(unrelatedHolder)
      const unrelatedWaiterPid = await backendPid(unrelatedWaiter)

      // This test's own blocker, holding this test's own transfer row. NOTHING is
      // running against it — no path has been started at all.
      await myBlocker.query('BEGIN')
      await myBlocker.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [mine.transfer.id])

      // The round-9 baseline, taken exactly where round 9 took it.
      const baselinePids = await lockBlockedBackendPids(probe)

      // An unrelated pair on an unrelated fixture, blocked on each other.
      await unrelatedHolder.query('BEGIN')
      await unrelatedHolder.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [other.transfer.id])
      await unrelatedWaiter.query('BEGIN')
      const unrelatedWaiting = unrelatedWaiter
        .query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [other.transfer.id])
        .then(() => {}, () => {})
      await waitForBlockedBackend(probe, {
        blockedBy: [unrelatedHolderPid],
        waitingOn: /stock_transfers/i,
        describe: 'the unrelated pair must really be blocked',
      })

      // (a) THE FALSE POSITIVE, SHOWN RATHER THAN ARGUED. The round-9 population has
      //     gained a backend since its baseline, so `count > sinceCount` is now true
      //     and its wait would return here — and the backend that made it true is
      //     the unrelated waiter, which cannot tell anyone anything about the path
      //     this test would have been probing.
      const arrivals = (await lockBlockedBackendPids(probe)).filter((pid) => !baselinePids.includes(pid))
      assert.ok(
        arrivals.includes(unrelatedWaiterPid),
        'expected the unrelated backend to enter the round-9 blocked population and satisfy its count',
      )

      // (b) THE REPLACEMENT IS NOT SATISFIED BY IT. Same database, same instant, same
      //     blocked backend — and the wait times out, because that backend is not
      //     blocked by THIS test's blocker.
      await assert.rejects(
        waitForBlockedBackend(probe, {
          blockedBy: [myBlockerPid],
          waitingOn: /stock_transfers/i,
          budgetMs: 750,
          describe: 'specificity check',
        }),
        /never reached that row lock/,
        'the new wait accepted an unrelated blocked backend — it is the round-9 predicate again',
      )

      // (c) AND IT IS SATISFIED BY THE REAL THING, while the unrelated pair is still
      //     blocked: a path that genuinely waits on the row this test's blocker holds
      //     is identified, by pid, and it is neither of the unrelated sessions.
      const { receiveTransfer } = await import('@/app/actions/transfers')
      const running = receiveTransfer(mine.transfer.id).then(() => {}, () => {})
      const observed = await waitForBlockedBackend(probe, {
        blockedBy: [myBlockerPid],
        waitingOn: /stock_transfers/i,
        describe: 'the real path',
      })
      assert.notEqual(observed.pid, unrelatedWaiterPid)
      assert.notEqual(observed.pid, unrelatedHolderPid)
      assert.notEqual(observed.pid, myBlockerPid)

      await myBlocker.query('ROLLBACK')
      await running
      await unrelatedHolder.query('ROLLBACK')
      await unrelatedWaiting
      await unrelatedWaiter.query('ROLLBACK')
    } finally {
      await myBlocker.end().catch(() => {})
      await unrelatedHolder.end().catch(() => {})
      await unrelatedWaiter.end().catch(() => {})
      await probe.end().catch(() => {})
    }
  },
)

// ---------------------------------------------------------------------------
// THE CONCURRENT CANCELLATION RACE (Codex round-9 HIGH-1, o3d-2y5u)
// ---------------------------------------------------------------------------

test(
  'ALIGNMENT creates nothing when a cancellation commits mid-flight (Codex r9 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE ROUTE. Alignment reads the transfer as IN_TRANSIT, and a
    // `cancelDispatchedTransfer` then restores the full quantity and a second set of
    // replacement layers at the SOURCE and commits before alignment writes. Both
    // copies stay live and a later landed-cost revaluation posts the inventory
    // reclassification twice — the branch's own defect, one route over.
    //
    // FORCED, NOT HOPED FOR. The cancellation is run to COMPLETION first while
    // alignment is held at its very first lock, so the interleaving is a fact of the
    // sequence rather than of the scheduler. Round 7's attempt used `Promise.all`,
    // which forces no overlap at all, and its own lock-removal mutation survived one
    // run in five.
    //
    // The hold is on the transfer row, which is the row alignment must now take
    // FIRST. That is what makes this test also a proof that the lock is real: if
    // alignment took no transfer lock, it would sail past the blocker, read
    // IN_TRANSIT and write — which is exactly the pre-fix failure.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('race', { sourceStockLevel: true })
    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')
    const { cancelDispatchedTransfer } = await import('@/app/actions/transfers')

    const blocker = await rawSession(databaseUrl)
    const probe = await rawSession(databaseUrl)
    let alignResult: { applied?: boolean; correctedQty?: number; reason?: string } | null = null
    let alignError: unknown = null
    let cancelResult: { success?: boolean; message?: string } | null = null
    let alignmentBlocked = false

    try {
      const blockerPid = await backendPid(blocker)

      // (1) Park the CANCELLATION mid-transaction, at the source stock level — after
      // it has taken the transfer row and the ASN rows, before it has committed.
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM stock_levels WHERE "productId" = $1 AND "warehouseId" = $2 FOR UPDATE',
        [seeded.product.id, seeded.source.id],
      )
      const cancelling = cancelDispatchedTransfer(seeded.transfer.id)
        .then((value) => { cancelResult = value })
      // Identified, not counted: the backend blocked by THIS blocker, on stock_levels.
      // Its pid is the next link in the chain — it is the cancellation, and it is
      // what alignment must be seen to block on below (Codex round-10 HIGH-3).
      const cancellingBackend = await waitForBlockedBackend(probe, {
        blockedBy: [blockerPid],
        waitingOn: /stock_levels/i,
        describe: 'parking the cancellation',
      })

      // (2) Start the alignment into that window. This is the moment the finding is
      // about: the transfer is still IN_TRANSIT on disk, and a cancellation that
      // will restore every unit is already in flight.
      const aligning = applyMintsoftAlignmentForProduct({
        binding: seeded.binding as never,
        jobId: `r9-race-${Date.now()}`,
        productId: seeded.product.id,
        sku: seeded.tag,
        delta: LINE_QTY,
        dryRun: false,
      }).then(
        (value) => { alignResult = value },
        (error) => { alignError = error },
      )

      // (3) Wait for whichever is true of the code under test, with no fixed pause:
      //
      //   · WITH the transfer lock, alignment blocks on `stock_transfers` — and
      //     specifically on the row THE CANCELLATION holds, which is why the wait
      //     names the cancellation's pid rather than counting blocked backends.
      //   · WITHOUT it (the pre-fix code, and `development`), alignment never blocks
      //     at all: it reads IN_TRANSIT, books the destination stock and lays the
      //     second layer, and SETTLES here.
      //
      // Both outcomes are observable facts, so the release below happens at the right
      // moment in either case and the assertions can tell the two apart.
      alignmentBlocked = await Promise.race([
        waitForBlockedBackend(probe, {
          blockedBy: [cancellingBackend.pid],
          waitingOn: /stock_transfers/i,
          exclude: [cancellingBackend.pid],
          describe: 'alignment parked behind the cancellation',
        }).then(() => true),
        aligning.then(() => false),
      ])

      // (4) Let the cancellation COMMIT.
      await blocker.query('ROLLBACK')
      await cancelling
      await aligning
    } finally {
      await blocker.end().catch(() => {})
      await probe.end().catch(() => {})
    }

    assert.equal(cancelResult!.success, true, `the cancellation must commit: ${JSON.stringify(cancelResult)}`)
    assert.equal(
      alignmentBlocked,
      true,
      'alignment ran straight through a transfer another transaction was cancelling — it took no transfer lock',
    )

    assert.equal(alignError, null, `alignment must fail cleanly, not throw: ${String(alignError)}`)
    assert.equal(
      alignResult!.applied,
      false,
      `alignment must refuse a transfer cancelled under it: ${JSON.stringify(alignResult)}`,
    )
    assert.equal(alignResult!.correctedQty, 0)

    // THE POSTED AMOUNTS, which are what the finding is actually about.
    const { db } = seeded
    const destinationStock = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: seeded.product.id, warehouseId: seeded.destination.id } },
      select: { quantity: true },
    })
    assert.equal(
      Number(destinationStock?.quantity ?? 0),
      0,
      'no stock may exist at the DESTINATION for units the cancellation restored to source',
    )
    const destinationLayers = await db.costLayer.findMany({
      where: { productId: seeded.product.id, warehouseId: seeded.destination.id },
      select: { receivedQty: true },
    })
    assert.equal(
      destinationLayers.length,
      0,
      'and no second replacement cost layer — that layer is what makes a later revaluation post twice',
    )

    // The source holds the restored units exactly once.
    const sourceStock = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: seeded.product.id, warehouseId: seeded.source.id } },
      select: { quantity: true },
    })
    assert.equal(Number(sourceStock?.quantity ?? 0), LINE_QTY, 'the cancellation restored the line to source')

    const status = await db.stockTransfer.findUnique({
      where: { id: seeded.transfer.id },
      select: { status: true },
    })
    assert.equal(status?.status, 'CANCELLED')

    // And the transfer line's ASN row must not have been credited: a credit with no
    // stock behind it would strand the line as over-landed for ever.
    const asnLine = await db.wmsAsnLineMap.findUnique({
      where: { id: seeded.asnLineMapId },
      select: { qtyAccountedViaSnapshot: true },
    })
    assert.equal(Number(asnLine?.qtyAccountedViaSnapshot ?? 0), 0)
  },
)

test(
  'ALIGNMENT still applies when NO cancellation intervenes — the refusal is not blanket (Codex r9)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The same shape with the cancellation removed. Without this, an alignment that
    // simply refused everything would satisfy the race test and the whole path would
    // be dead.
    const databaseUrl = loadEnv()
    const seeded = await seedDispatchedTransferWithOpenAsn('racefree')
    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')

    const blocker = await rawSession(databaseUrl)
    const probe = await rawSession(databaseUrl)
    let alignResult: { applied?: boolean; correctedQty?: number } | null = null
    try {
      const blockerPid = await backendPid(blocker)
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [seeded.transfer.id])
      const aligning = applyMintsoftAlignmentForProduct({
        binding: seeded.binding as never,
        jobId: `r9-racefree-${Date.now()}`,
        productId: seeded.product.id,
        sku: seeded.tag,
        delta: LINE_QTY,
        dryRun: false,
      }).then((value) => { alignResult = value })
      await waitForBlockedBackend(probe, {
        blockedBy: [blockerPid],
        waitingOn: /stock_transfers/i,
        describe: 'alignment parked on its own transfer lock',
      })
      await blocker.query('ROLLBACK')
      await aligning
    } finally {
      await blocker.end().catch(() => {})
      await probe.end().catch(() => {})
    }

    assert.equal(alignResult!.applied, true, `alignment must still apply: ${JSON.stringify(alignResult)}`)
    assert.equal(alignResult!.correctedQty, LINE_QTY)
    const { db } = seeded
    const destinationStock = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: seeded.product.id, warehouseId: seeded.destination.id } },
      select: { quantity: true },
    })
    assert.equal(Number(destinationStock?.quantity ?? 0), LINE_QTY)
  },
)

// ---------------------------------------------------------------------------
// THE RE-READ THAT WAS NOT RESTRICTED TO THE LOCKED ROWS
// (Codex round-10 HIGH-1 — which is round-8 HIGH-2, returned)
// ---------------------------------------------------------------------------

/**
 * A purchase-order world: ONE product in ONE warehouse, and as many PO-backed open
 * ASNs on it as a test wants.
 *
 * PURCHASE ORDERS, NOT TRANSFERS, because the PO side is where the gap was, and the
 * asymmetry is the point. A transfer-backed row that appears between alignment's two
 * reads is already refused — its parent transfer cannot be in the locked set, and
 * the round-9 check tests exactly that — and a transfer-backed row whose parent IS
 * locked cannot be moved underneath alignment, because every writer of those rows
 * takes the transfer first and would block. A PO-backed row has neither guard:
 * alignment locks no `purchase_orders` row, so there is no parent set for a raced PO
 * line to fail, and the book-in that credits it takes no lock alignment holds.
 */
async function seedPurchaseAsnWorld(label: string) {
  const { db } = await import('@/lib/db')

  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `R10PO-${label}-${process.pid}-${uid}`
  const product = await db.product.create({
    data: { sku: tag, name: `r10 raced PO line ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  const warehouse = await db.warehouse.create({
    data: { code: `RX${uid}`, name: `${tag} wh`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })
  // Materialised, so a test can park a transaction on the row alignment must take
  // last — and so the stock it holds is a number the assertions can read.
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: warehouse.id, quantity: '0', reservedQty: '0' },
    select: { productId: true },
  })
  const supplier = await db.supplier.create({
    data: { name: `${tag} supplier`, currency: 'GBP' },
    select: { id: true },
  })

  /**
   * One PO with one line, and one OPEN ASN mapped to that line.
   *
   * `alreadyReceived` seeds the line as HAVING BEEN RECEIVED already — stock on the
   * shelf, a cost layer behind it, `qtyReceived` set — with the ASN row still
   * showing nothing processed. That is an ordinary state: goods booked in by hand,
   * with the WMS callback still to arrive.
   */
  async function addPurchaseOrderAsn(
    suffix: string,
    qty: number,
    options: { alreadyReceived?: boolean } = {},
  ) {
    const reference = `${tag}-${suffix}`
    const total = qty * UNIT_COST
    const po = await db.purchaseOrder.create({
      data: {
        reference,
        supplierId: supplier.id,
        status: options.alreadyReceived ? 'PARTIALLY_RECEIVED' : 'PO_SENT',
        currency: 'GBP',
        fxRateToBase: '1',
        subtotalForeign: total,
        subtotalBase: total,
        totalForeign: total,
        totalBase: total,
        destinationWarehouseId: warehouse.id,
        lines: {
          create: [{
            productId: product.id,
            qty: `${qty}.0000`,
            qtyReceived: options.alreadyReceived ? `${qty}.0000` : '0.0000',
            unitCostForeign: `${UNIT_COST}.000000`,
            unitCostBase: `${UNIT_COST}.000000`,
            // Explicit, because every receipt path reads `landedUnitCostBase ??
            // unitCostBase` and the column defaults to 0 rather than NULL. Left
            // unset, every layer this fixture produced would be a £0 layer and the
            // money assertion below would pass on nothing.
            landedUnitCostBase: `${UNIT_COST}.000000`,
            totalForeign: total,
            totalBase: total,
          }],
        },
      },
      select: { id: true, lines: { select: { id: true } } },
    })

    if (options.alreadyReceived) {
      await db.costLayer.create({
        data: {
          productId: product.id,
          warehouseId: warehouse.id,
          receivedQty: `${qty}.000000`,
          remainingQty: `${qty}.000000`,
          unitCostBase: UNIT_COST,
          poLineId: po.lines[0]!.id,
        },
        select: { id: true },
      })
      await db.stockLevel.update({
        where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
        data: { quantity: { increment: qty } },
        select: { productId: true },
      })
    }

    const asn = await db.wmsAsnMap.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
        externalAsnId: reference,
        sourceType: 'PURCHASE_ORDER',
        sourceId: po.id,
        warehouseId: warehouse.id,
        status: 'OPEN',
        lines: {
          create: [{
            externalAsnLineId: `${reference}-1`,
            sourceType: 'PURCHASE_ORDER_LINE',
            sourceLineId: po.lines[0]!.id,
            productId: product.id,
            sku: tag,
            expectedQty: `${qty}.0000`,
          }],
        },
      },
      select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
    })

    return {
      reference,
      qty,
      poId: po.id,
      poLineId: po.lines[0]!.id,
      asnId: asn.id,
      asnLineMapId: asn.lines[0]!.id,
      externalAsnLineId: asn.lines[0]!.externalAsnLineId,
    }
  }

  /** The real webhook book-in for one of those ASNs, for its whole quantity. */
  async function runBookedInFor(asn: Awaited<ReturnType<typeof addPurchaseOrderAsn>>) {
    const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
    const event = await db.wmsInboundReceiptEvent.create({
      data: {
        connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture row, not a core flow branch
        externalEventId: `${asn.reference}-evt-${Math.random().toString(36).slice(2, 8)}`,
        externalAsnId: asn.reference,
        payload: { asnId: asn.reference },
      },
      select: { id: true },
    })
    return processBookedInEvent(event.id, {
      fetchRemoteAsn: async () => ({
        externalAsnId: asn.reference,
        status: 'RECEIVED',
        lines: [{
          externalLineId: asn.externalAsnLineId,
          sourceLineId: asn.poLineId,
          externalProductId: null,
          sku: tag,
          quantity: asn.qty,
          raw: null,
        }],
        raw: null,
      }),
    })
  }

  const binding = {
    id: `binding-${tag}`,
    connector: 'mintsoft', // wms-connector-boundary-ok: 6oyu.19: a test fixture value, not a core flow branch
    active: true,
    externalWarehouseId: '1',
    stockSyncMode: 'ALIGN_TO_WMS' as const,
    syncFrequencyMinutes: 60,
    discrepancyThresholds: null,
    reportRecipients: [],
    alignmentConfirmedAt: new Date(),
    alignDownReasonId: null,
    warehouseId: warehouse.id,
    lastStockSyncAt: null,
    connection: { active: true },
    warehouse,
  }

  return { db, tag, product, warehouse, binding, addPurchaseOrderAsn, runBookedInFor }
}

test(
  'ALIGNMENT refuses a PO ASN line created after its locks, and books no unit twice (Codex r10 HIGH-1)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // THE ROUTE, forced step by step rather than hoped for:
    //
    //  (1) Alignment discovers ASN-A alone and takes its `wms_asn_line_maps` lock on
    //      A alone — parked there by a session already holding that row.
    //  (2) ASN-B, a SECOND purchase order for the same product and warehouse, is
    //      created and committed. Its ten units are already on the shelf: received by
    //      hand, layered, with the WMS callback still outstanding. Alignment holds
    //      nothing that covers row B and never will — it locks no `purchase_orders`
    //      row, so there is no parent lock for a raced PO line to fail.
    //  (3) The real webhook book-in for ASN-B starts and is parked at ASN-B's HEADER
    //      row, before it has credited row B.
    //  (4) Alignment is released. It locks A, re-reads — and this is the moment the
    //      finding is about: at READ COMMITTED the re-read returns row B, whose
    //      counters still say ten units unaccounted, because the book-in has not
    //      committed. Alignment plans 4 from A and 6 from B and reaches for the stock
    //      level, which is held.
    //  (5) The book-in is released and commits, crediting row B for all ten. Every
    //      counter alignment planned from is now stale.
    //  (6) The stock level is released and alignment writes.
    //
    // BEFORE THE FIX alignment books ten units — six of them against a row a
    // committed book-in has just accounted in full — so twenty units of stock and
    // £100 of layers stand for the fourteen that were ordered and the ten that
    // arrived.
    //
    // AFTER THE FIX row B is not in the locked set, so the re-read refuses it. What
    // is left covers 4 of the 10-unit delta, alignment applies nothing rather than
    // part of a plan, and the ten units on the shelf stay ten.
    const databaseUrl = loadEnv()
    const world = await seedPurchaseAsnWorld('raced')
    const first = await world.addPurchaseOrderAsn('a', 4)
    const { applyMintsoftAlignmentForProduct } =
      await import('@/lib/connectors/mintsoft/sync/stock-sync')

    const holdAsnA = await rawSession(databaseUrl)
    const holdAsnBHeader = await rawSession(databaseUrl)
    const holdStock = await rawSession(databaseUrl)
    const probe = await rawSession(databaseUrl)
    let alignResult: { applied?: boolean; correctedQty?: number; reason?: string } | null = null
    let alignError: unknown = null
    let bookedInOutcome: unknown = null
    let bookedInError: unknown = null
    let alignmentReachedStock = false
    let second: Awaited<ReturnType<typeof world.addPurchaseOrderAsn>> | null = null

    try {
      const holdAsnAPid = await backendPid(holdAsnA)
      const holdAsnBHeaderPid = await backendPid(holdAsnBHeader)
      const holdStockPid = await backendPid(holdStock)

      // (1)
      await holdAsnA.query('BEGIN')
      await holdAsnA.query('SELECT id FROM wms_asn_line_maps WHERE id = $1 FOR UPDATE', [first.asnLineMapId])

      const aligning = applyMintsoftAlignmentForProduct({
        binding: world.binding as never,
        jobId: `r10-raced-${Date.now()}`,
        productId: world.product.id,
        sku: world.tag,
        delta: 10,
        dryRun: false,
      }).then(
        (value) => { alignResult = value },
        (error) => { alignError = error },
      )
      await waitForBlockedBackend(probe, {
        blockedBy: [holdAsnAPid],
        waitingOn: /wms_asn_line_maps/i,
        describe: 'alignment parked at its ASN row lock, discovery done',
      })

      // (2) — AFTER the lock set was chosen, which is the whole point.
      second = await world.addPurchaseOrderAsn('b', 10, { alreadyReceived: true })

      // (3)
      await holdAsnBHeader.query('BEGIN')
      await holdAsnBHeader.query('SELECT id FROM wms_asn_maps WHERE id = $1 FOR UPDATE', [second.asnId])
      const bookingIn = world.runBookedInFor(second).then(
        (value) => { bookedInOutcome = value },
        (error) => { bookedInError = error },
      )
      await waitForBlockedBackend(probe, {
        blockedBy: [holdAsnBHeaderPid],
        waitingOn: /wms_asn_maps/i,
        describe: 'parking the book-in of the raced ASN at its header',
      })

      // The last lock alignment takes, held so that alignment stops between its
      // re-read and its writes rather than racing through them.
      await holdStock.query('BEGIN')
      await holdStock.query(
        'SELECT id FROM stock_levels WHERE "productId" = $1 AND "warehouseId" = $2 FOR UPDATE',
        [world.product.id, world.warehouse.id],
      )

      // (4) Release A. Alignment re-reads under its locks and then either refuses row
      //     B — settling without ever reaching for stock — or parks on the stock row
      //     with row B in its plan. Both are observable facts, so the releases below
      //     are correctly timed either way and the assertions tell the two apart.
      await holdAsnA.query('ROLLBACK')
      alignmentReachedStock = await Promise.race([
        waitForBlockedBackend(probe, {
          blockedBy: [holdStockPid],
          waitingOn: /stock_levels/i,
          describe: 'alignment parked at the stock level with its plan already made',
        }).then(() => true),
        aligning.then(() => false),
      ])

      // (5) The book-in commits while alignment cannot write. This is what makes
      //     alignment's plan stale rather than merely concurrent.
      await holdAsnBHeader.query('ROLLBACK')
      await bookingIn

      // (6)
      await holdStock.query('ROLLBACK')
      await aligning
    } finally {
      await holdAsnA.end().catch(() => {})
      await holdAsnBHeader.end().catch(() => {})
      await holdStock.end().catch(() => {})
      await probe.end().catch(() => {})
    }

    assert.equal(alignError, null, `alignment must refuse cleanly, not throw: ${String(alignError)}`)
    assert.equal(bookedInError, null, `the book-in must succeed: ${String(bookedInError)}`)
    assert.equal(
      (bookedInOutcome as { status?: string } | null)?.status,
      'processed',
      `the book-in must process the raced ASN: ${JSON.stringify(bookedInOutcome)}`,
    )

    const { db } = world
    // THE PRECONDITION, asserted rather than assumed: the book-in really did move the
    // counters alignment had already read. Without this the test could pass because
    // nothing raced at all.
    const racedRow = await db.wmsAsnLineMap.findUnique({
      where: { id: second!.asnLineMapId },
      select: { qtyAccountedViaSnapshot: true, lastProcessedReceivedQty: true, qtyAccountedViaReceipt: true },
    })
    assert.equal(
      Number(racedRow?.lastProcessedReceivedQty ?? 0),
      10,
      'the book-in did not credit the raced row, so nothing made alignment’s read stale',
    )

    // THE POSTED AMOUNTS, which is what "no unit twice" means.
    const stock = await db.stockLevel.findUnique({
      where: { productId_warehouseId: { productId: world.product.id, warehouseId: world.warehouse.id } },
      select: { quantity: true },
    })
    assert.equal(
      Number(stock?.quantity ?? 0),
      10,
      'stock was booked for units that had already landed — alignment planned against an ASN row it '
      + `never locked and a book-in credited it in between (alignment reached the stock lock: ${alignmentReachedStock})`,
    )

    const layers = await db.costLayer.findMany({
      where: { productId: world.product.id, warehouseId: world.warehouse.id },
      select: { receivedQty: true, unitCostBase: true },
    })
    assert.equal(
      layers.reduce((sum, layer) => sum + Number(layer.receivedQty), 0),
      10,
      'and the cost layers must cover those ten units once',
    )
    assert.equal(
      layers.reduce((sum, layer) => sum + Number(layer.receivedQty) * Number(layer.unitCostBase), 0),
      10 * UNIT_COST,
      'the money: £50 of inventory for the ten units at £5 that arrived, not £100 for twenty',
    )

    assert.equal(
      Number(racedRow?.qtyAccountedViaSnapshot ?? 0),
      0,
      'alignment credited an ASN row it never locked',
    )

    // And the row it DID lock is untouched, because a plan that cannot cover the
    // delta is not applied in part.
    const lockedRow = await db.wmsAsnLineMap.findUnique({
      where: { id: first.asnLineMapId },
      select: { qtyAccountedViaSnapshot: true },
    })
    assert.equal(Number(lockedRow?.qtyAccountedViaSnapshot ?? 0), 0)

    assert.equal(alignResult!.applied, false, `alignment must not apply: ${JSON.stringify(alignResult)}`)
    assert.equal(alignResult!.correctedQty, 0)
    // NOT VACUOUS: alignment must refuse for THIS reason, naming the raced ASN, and
    // not because the fixture failed to give it anything to do.
    assert.match(alignResult!.reason ?? '', new RegExp(second!.reference))
    assert.match(alignResult!.reason ?? '', /created after this run took its row locks/)
  },
)

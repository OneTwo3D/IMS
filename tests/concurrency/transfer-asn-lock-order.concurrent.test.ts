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
 * Wait until some OTHER backend on this database is blocked on a lock.
 *
 * Polls `pg_stat_activity`, which reports the wait as a fact the SERVER observed —
 * not a timer this test hoped was long enough. Scoped to `current_database()`, which
 * is the scratch database, so nothing another session on this box is doing can
 * satisfy it. Deliberately NOT a sleep: a fixed pause would make the whole file
 * timing-dependent, and a fixed pause that was too short would make every tripwire
 * pass vacuously (the path would not have reached its first lock yet, so the ASN row
 * would be free for the wrong reason).
 */
async function waitForABlockedBackend(probe: RawClient, sinceCount: number): Promise<void> {
  const deadline = Date.now() + BLOCK_WAIT_MS
  for (;;) {
    const { rows } = await probe.query(
      `SELECT count(*)::int AS blocked
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()`,
    )
    if (Number(rows[0]!.blocked) > sinceCount) return
    if (Date.now() > deadline) {
      throw new Error(
        'no backend became lock-blocked within the wait budget. The path under test never reached the ' +
        'row lock the tripwire holds, so this tripwire would prove nothing about acquisition order.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function blockedBackendCount(probe: RawClient): Promise<number> {
  const { rows } = await probe.query(
    `SELECT count(*)::int AS blocked
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()`,
  )
  return Number(rows[0]!.blocked)
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
    const baseline = await blockedBackendCount(probe)
    await blocker.query('BEGIN')
    await blocker.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [params.transferId])

    let runOutcome: unknown = null
    let runError: unknown = null
    const running = params.run().then(
      (value) => { runOutcome = value },
      (error) => { runError = error },
    )

    // The path is now genuinely waiting on the transfer row the blocker holds.
    await waitForABlockedBackend(probe, baseline)

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
      const baseline = await blockedBackendCount(probe)
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM stock_transfers WHERE id = $1 FOR UPDATE', [seeded.transfer.id])

      const running = runBookedIn(seeded).then(
        (value) => { bookedInOutcome = value },
        (error) => { bookedInError = error },
      )
      await waitForABlockedBackend(probe, baseline)

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
    const baseline = await blockedBackendCount(probe)
    await blocker.query('BEGIN')
    await blocker.query(
      'SELECT id FROM stock_levels WHERE "productId" = $1 AND "warehouseId" = $2 FOR UPDATE',
      [params.productId, params.warehouseId],
    )

    const running = params.run().then(() => {}, () => {})
    await waitForABlockedBackend(probe, baseline)

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
      const baseline = await blockedBackendCount(probe)

      // (1) Park the CANCELLATION mid-transaction, at the source stock level — after
      // it has taken the transfer row and the ASN rows, before it has committed.
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM stock_levels WHERE "productId" = $1 AND "warehouseId" = $2 FOR UPDATE',
        [seeded.product.id, seeded.source.id],
      )
      const cancelling = cancelDispatchedTransfer(seeded.transfer.id)
        .then((value) => { cancelResult = value })
      await waitForABlockedBackend(probe, baseline)

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
      //   · WITH the transfer lock, alignment becomes the SECOND lock-blocked
      //     backend — parked behind the cancellation, having read nothing.
      //   · WITHOUT it (the pre-fix code, and `development`), alignment never blocks
      //     at all: it reads IN_TRANSIT, books the destination stock and lays the
      //     second layer, and SETTLES here.
      //
      // Both outcomes are observable facts, so the release below happens at the right
      // moment in either case and the assertions can tell the two apart.
      alignmentBlocked = await Promise.race([
        waitForABlockedBackend(probe, baseline + 1).then(() => true),
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
      const baseline = await blockedBackendCount(probe)
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
      await waitForABlockedBackend(probe, baseline)
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

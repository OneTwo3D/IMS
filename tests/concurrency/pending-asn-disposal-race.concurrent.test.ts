import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'

import { assertScratchDatabaseBeforeAnyWrite } from './scratch-database-guard'

/**
 * o3d-zzgp round 3 — Codex HIGH: A LIVE CHECK IS NOT A HELD CHECK.
 *
 * THE DEFECT (round-2 head 820baab1). When the transfer-ASN create's revalidation finds
 * the outstanding quantities moved, `discardPendingReservation` disposes of the pending
 * reservation. Round 2 made it read the line maps, decide "no credit, so delete", and
 * then delete the header — three separate autocommit statements. An alignment that
 * commits between the read and the delete credits `qtyAccountedViaSnapshot` on one of
 * those lines, and the delete then cascades the newly credited line away. That row is
 * the ONLY record that the alignment brought those units in (it never writes
 * `qtyReceived`), so the landed quantity drops back and the units read as still to come.
 *
 * THE FIX. Read, decide and dispose in ONE transaction, under the established order
 * (lib/domain/wms/transfer-asn-lock-order.ts): `stock_transfers` → `wms_asn_maps` →
 * `wms_asn_line_maps`. The alignment takes the same order before it credits, so it waits.
 *
 * ═════════════════════════════════════════════════════════════════════════════════
 * HOW THE INTERLEAVING IS FORCED — AND WHY THE PARK IS INSIDE THE DELETE STATEMENT
 * ═════════════════════════════════════════════════════════════════════════════════
 *
 * A statement-level `BEFORE DELETE` trigger on `wms_asn_maps` waits on an advisory lock
 * this test holds. It is conditioned on a random per-run GUC, `o3d.zzgp_park_token`, which
 * this process sets on its application pool's startup options and on nothing else, so a
 * parallel file's deletes — and a later run's — are never parked. A statement-level trigger fires before the statement locks any row, so the park
 * adds NO row lock of its own: whatever blocks the alignment while the delete is parked
 * is a lock the code under test took earlier in its transaction, or nothing.
 *
 * The park is deliberately INSIDE the delete rather than before it. By then the DELETE
 * already has its statement snapshot, so a credit committed during the park is invisible
 * to the zero-credit condition in the delete's own WHERE — and still reached by the
 * `ON DELETE CASCADE`, which reads a newer snapshot. That is what lets this one rig show
 * that the WHERE guard is a BACKSTOP and not the fix: take the lock statements out of the
 * disposal (the only difference between subject and control) and the guard, still
 * present, does not save the credit.
 *
 * WHAT IS ASSERTED, IN THIS ORDER, and why the order matters:
 *
 *   1. the precondition — the disposal really was parked inside its delete while this
 *      test ran the alignment, so the window was reached;
 *   2. THE MONEY, re-read after the fact through the production loader: the landed
 *      quantity must equal `qtyReceived` plus every unit the alignment actually put into
 *      stock. Asserted on the quantity, not on whether a delete happened — round 1's
 *      test asserted the deletion and pinned the defect as correct;
 *   3. the serialisation, and what produced it: the alignment must have been observed
 *      BLOCKED by the disposal's backend, waiting on `stock_transfers`, on a lock that is
 *      not advisory. Checked after the money so the control reports its data loss first.
 *
 * Needs a real PostgreSQL. It seeds rows and installs a trigger, so it refuses to start
 * unless tests/concurrency/scratch-database-guard.ts positively identifies the database as
 * a scratch database the operator named (o3d-zzgp r4).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const APP_NAME = `o3d-zzgp-r3-${process.pid}`
/**
 * ONE FIXED NAME, and a trigger that holds nothing for anyone but this run (o3d-zzgp r4,
 * Codex HIGH-2). Round 3 named the trigger per pid, so a run that crashed before its
 * `finally` left a trigger no later run would ever drop. Now every run first sweeps any
 * `zzgp_%park%` trigger and function off `wms_asn_maps`, and the function parks a delete
 * only when the deleting session carries THIS run's random `o3d.zzgp_park_token` GUC —
 * set on the application pool's startup options and on nothing else. A leftover from a
 * crashed run therefore matches no session that will ever exist, and parks nothing even
 * before the next run sweeps it.
 */
const TRIGGER = 'zzgp_park_asn_map_delete'
const PARK_TOKEN = randomUUID()
const CONNECTOR = 'mintsoft' // wms-connector-boundary-ok: o3d-zzgp: a test fixture value, not a core flow branch
const LINE_QTY = 10
const UNIT_COST = 5
const RECEIVED_BEFORE_DISCARD = 1
const ALIGN_DELTA = 5
const WAIT_BUDGET_MS = 15000

// ---------------------------------------------------------------------------
// Nothing in this process may reach a WMS. The two calls this path would make are
// replaced below, and the HTTP primitive every Mintsoft call goes through throws.
// ---------------------------------------------------------------------------
const LIVE_WMS = 'o3d-zzgp r3 test: a WMS call was attempted. Mintsoft is LIVE; nothing here may reach it.'
globalThis.fetch = (async () => { throw new Error(LIVE_WMS) }) as typeof fetch

mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { throw new Error(LIVE_WMS) },
    DEFAULT_CONNECTOR_FETCH_TIMEOUT_MS: 30_000,
    DEFAULT_CONNECTOR_FETCH_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
    isAllAddressesLookup: () => false,
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    freshAuthFailureResult: () => null,
    requireApiFreshAdmin: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    logActivityInTransaction: async () => {},
    logActivityPersisted: async () => true,
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', {
  namedExports: { allocateBackordersForProducts: async () => ({}) },
})
mock.module('@/lib/fulfillment/overallocation-rebalancer', {
  namedExports: { releaseOverallocations: async () => ({}) },
})
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async () => true,
    getIntegrationPluginState: async () => ({ enabled: true }),
  },
})
mock.module('@/lib/public-app-url', { namedExports: { getPublicAppUrl: async () => 'https://ims.example.invalid' } })
mock.module('@/lib/jobs/wms/process-mintsoft-booked-in-event', {
  namedExports: {
    replayMintsoftBookedInEventsForAsn: async () => {},
    enqueueMintsoftBookedInRecheckForAsn: async () => {},
  },
})

type RawClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

async function rawSession(databaseUrl: string): Promise<RawClient> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl, application_name: `${APP_NAME}-raw` })
  await client.connect()
  return client as unknown as RawClient
}

async function backendPid(session: RawClient): Promise<number> {
  const { rows } = await session.query('SELECT pg_backend_pid()::int AS pid')
  return Number(rows[0]!.pid)
}

/**
 * The environment, pointed at the scratch database with THIS process's application_name
 * on every pooled connection. Must run before anything imports `@/lib/db`.
 */
let preparedEnv: Promise<{ rawUrl: string }> | null = null

async function prepareEnv(): Promise<{ rawUrl: string }> {
  preparedEnv ??= (async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    // FIRST, before any connection this file makes can write: refuse anything that is
    // not positively a scratch database the operator named (o3d-zzgp r4, Codex HIGH-2).
    await assertScratchDatabaseBeforeAnyWrite()
    const exported = process.env.DATABASE_URL!
    const url = new URL(exported)
    url.searchParams.set('application_name', APP_NAME)
    url.searchParams.set('options', `-c o3d.zzgp_park_token=${PARK_TOKEN}`)
    process.env.DATABASE_URL = url.toString()
    const raw = new URL(exported)
    raw.searchParams.delete('application_name')
    raw.searchParams.delete('options')
    return { rawUrl: raw.toString() }
  })()
  return preparedEnv
}

type Gate = {
  /** Resolves once the action has reached the WMS listing call. */
  reached: Promise<void>
  /** Called by the mocked listing call: report arrival, then wait for `release`. */
  arrive: () => Promise<void>
  release: () => void
}

/** The pause between the reservation and its revalidation: the WMS listing call. */
const listingGate: { current: Gate | null } = { current: null }

function armListingGate(): Gate {
  let markReached!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => { markReached = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  const gate: Gate = {
    reached,
    arrive: async () => { markReached(); await released },
    release: () => release(),
  }
  listingGate.current = gate
  return gate
}

let modulesReady: Promise<{
  createMintsoftTransferAsn: typeof import('@/app/actions/mintsoft-sync').createMintsoftTransferAsn
}> | null = null

function loadModules() {
  modulesReady ??= (async () => {
    const realMintsoft = await import('@/lib/connectors/mintsoft')
    mock.module('@/lib/connectors/mintsoft', {
      namedExports: {
        ...(realMintsoft as unknown as Record<string, unknown>),
        getMintsoftSettings: async () => ({ mintsoft_webhook_secret: '' }),
        // o3d-bhvu: the creators' duplicate-recovery listing is fetchMintsoftAsnsForDuplicateRecovery.
        // The gate stays AT the listing step (between reservation and revalidation), and the old name
        // throws, so a creator that ever lists through it again fails here instead of skipping the gate.
        fetchMintsoftAsnsForDuplicateRecovery: async () => {
          if (listingGate.current) await listingGate.current.arrive()
          return []
        },
        fetchMintsoftAsns: async () => { throw new Error(LIVE_WMS) },
      },
    })
    const realRegistry = await import('@/lib/connectors/wms/registry')
    mock.module('@/lib/connectors/wms/registry', {
      namedExports: {
        ...(realRegistry as unknown as Record<string, unknown>),
        isWmsConnectorConfigured: async () => true,
        getWmsConnector: () => ({
          id: CONNECTOR,
          name: 'test',
          createAsn: async () => { throw new Error(LIVE_WMS) },
        }),
      },
    })
    const actions = await import('@/app/actions/mintsoft-sync')
    return { createMintsoftTransferAsn: actions.createMintsoftTransferAsn }
  })()
  return modulesReady
}

async function seedWorld(label: string) {
  const { db } = await import('@/lib/db')
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  const tag = `ZZR3-${label}-${process.pid}-${uid}`

  const product = await db.product.create({
    data: { sku: tag, name: `zzgp r3 ${label}`, type: 'SIMPLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  await db.wmsProductLink.create({
    data: { productId: product.id, connector: CONNECTOR, externalProductId: `ext-${tag}` },
    select: { id: true },
  })
  const source = await db.warehouse.create({
    data: { code: `Z3${uid}S`, name: `${tag} source`, type: 'STANDARD' },
    select: { id: true, code: true, name: true },
  })
  const destination = await db.warehouse.create({
    data: { code: `Z3${uid}D`, name: `${tag} dest`, type: 'STANDARD' },
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
          productName: `zzgp r3 ${label}`,
          qty: `${LINE_QTY}.0000`,
          qtyReceived: '0.0000',
          costLayerSnapshot: [{ costLayerId: sourceLayer.id, qty: `${LINE_QTY}.000000`, unitCostBase: `${UNIT_COST}.000000` }],
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  await db.stockLevel.create({
    data: { productId: product.id, warehouseId: destination.id, quantity: '0' },
    select: { productId: true },
  })
  const connection = await db.wmsConnection.create({
    data: { connector: CONNECTOR, label: tag, active: true },
    select: { id: true },
  })
  const bindingRow = await db.externalWmsBinding.create({
    data: {
      connectionId: connection.id,
      warehouseId: destination.id,
      connector: CONNECTOR,
      externalWarehouseId: `wh-${tag}`,
      active: true,
      stockSyncMode: 'ALIGN_TO_WMS',
      alignmentConfirmedAt: new Date(),
    },
    select: { id: true, externalWarehouseId: true },
  })

  const binding = {
    id: bindingRow.id,
    connector: CONNECTOR,
    active: true,
    externalWarehouseId: bindingRow.externalWarehouseId,
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

  return { db, tag, product, destination, transfer, transferLineId: transfer.lines[0]!.id, binding }
}

/** Drop every park trigger and function a previous — possibly crashed — run left behind. */
async function sweepParkTriggers(session: RawClient) {
  const { rows: triggers } = await session.query(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'wms_asn_maps'::regclass AND tgname LIKE 'zzgp\\_%park%'`,
  )
  for (const row of triggers) await session.query(`DROP TRIGGER IF EXISTS "${String(row.tgname)}" ON wms_asn_maps`)
  const { rows: functions } = await session.query(
    `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema() AND p.proname LIKE 'zzgp\\_%park%'`,
  )
  for (const row of functions) await session.query(`DROP FUNCTION IF EXISTS ${String(row.signature)}`)
  return { triggers: triggers.length, functions: functions.length }
}

async function installParkTrigger(session: RawClient) {
  const swept = await sweepParkTriggers(session)
  if (swept.triggers + swept.functions > 0) {
    console.log(`[zzgp-r4] swept ${swept.triggers} leftover park trigger(s) and ${swept.functions} function(s)`)
  }
  // The token and the advisory key are literals in the function body, so this run's
  // function can match only sessions carrying this run's token.
  await session.query(`
    CREATE FUNCTION ${TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_setting('o3d.zzgp_park_token', true) = '${PARK_TOKEN}' THEN
        PERFORM pg_advisory_xact_lock(hashtext('${PARK_TOKEN}'));
      END IF;
      RETURN NULL;
    END
    $fn$`)
  await session.query(
    `CREATE TRIGGER ${TRIGGER} BEFORE DELETE ON wms_asn_maps FOR EACH STATEMENT EXECUTE FUNCTION ${TRIGGER}()`,
  )
}

async function dropParkTrigger(session: RawClient) {
  await session.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON wms_asn_maps`)
  await session.query(`DROP FUNCTION IF EXISTS ${TRIGGER}()`)
}

/** A backend from THIS process's application pool parked in the trigger by `holderPid`. */
async function waitForParkedDelete(probe: RawClient, holderPid: number, describe: string): Promise<number> {
  const deadline = Date.now() + WAIT_BUDGET_MS
  for (;;) {
    const { rows } = await probe.query(
      `SELECT pid::int AS pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND wait_event_type = 'Lock' AND wait_event = 'advisory'
          AND pg_blocking_pids(pid) @> ARRAY[$2::int]`,
      [APP_NAME, holderPid],
    )
    if (rows.length === 1) return Number(rows[0]!.pid)
    if (rows.length > 1) throw new Error(`${describe}: ${rows.length} backends parked; expected exactly one`)
    if (Date.now() > deadline) {
      throw new Error(`${describe}: no delete from ${APP_NAME} parked within the budget — the window was never reached`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

type AlignmentObservation =
  | { kind: 'blocked'; pid: number; query: string; ungrantedLockTypes: string[] }
  | { kind: 'completed' }

/**
 * Either the alignment finishes while the disposal is still parked (nothing serialised
 * them), or a backend of this pool other than the parked one is observed waiting on a
 * lock held by the parked backend. Never a sleep, never a population count.
 */
async function observeAlignment(
  probe: RawClient,
  parkedPid: number,
  settled: { done: boolean },
): Promise<AlignmentObservation> {
  const deadline = Date.now() + WAIT_BUDGET_MS
  for (;;) {
    if (settled.done) return { kind: 'completed' }
    const { rows } = await probe.query(
      `SELECT a.pid::int AS pid, coalesce(a.query, '') AS query,
              coalesce(array_agg(l.locktype) FILTER (WHERE NOT l.granted), '{}') AS types
         FROM pg_stat_activity a
         LEFT JOIN pg_locks l ON l.pid = a.pid
        WHERE a.datname = current_database()
          AND a.application_name = $1
          AND a.pid <> $2
          AND a.wait_event_type = 'Lock'
          AND pg_blocking_pids(a.pid) @> ARRAY[$2::int]
        GROUP BY a.pid, a.query`,
      [APP_NAME, parkedPid],
    )
    if (rows.length > 0) {
      return {
        kind: 'blocked',
        pid: Number(rows[0]!.pid),
        query: String(rows[0]!.query),
        ungrantedLockTypes: (rows[0]!.types as string[]) ?? [],
      }
    }
    if (Date.now() > deadline) {
      throw new Error('the alignment neither completed nor was observed blocked by the parked disposal within the budget')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test(
  'rig: the park trigger holds a delete from THIS pool before it locks its row, and ignores other sessions',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const { rawUrl } = await prepareEnv()
    const { db } = await import('@/lib/db')
    const holder = await rawSession(rawUrl)
    const probe = await rawSession(rawUrl)
    const outsider = await rawSession(rawUrl)
    let holderHasLock = false
    try {

      // Real rows, so "holds no row lock" is a claim about a row that exists.
      const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36)}`.toUpperCase()
      const warehouse = await db.warehouse.create({
        data: { code: `Z3R${uid}`, name: `zzgp r3 rig ${uid}`, type: 'STANDARD' },
        select: { id: true },
      })
      const makeMap = (suffix: string) => db.wmsAsnMap.create({
        data: {
          connector: CONNECTOR,
          externalAsnId: `zzgp-r3-rig-${uid}-${suffix}`,
          sourceType: 'STOCK_TRANSFER',
          sourceId: `zzgp-r3-rig-${uid}`,
          warehouseId: warehouse.id,
          status: 'CREATE_PENDING',
        },
        select: { id: true },
      })
      const parkedTarget = await makeMap('parked')
      const outsiderTarget = await makeMap('outsider')

      await installParkTrigger(holder)
      const holderPid = await backendPid(holder)
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [PARK_TOKEN])
      holderHasLock = true

      // THE RIG CAN FIND SOMETHING: a delete from the application pool parks.
      let settled = false
      const parkedDelete = db.wmsAsnMap.deleteMany({ where: { id: parkedTarget.id } })
        .finally(() => { settled = true })
      const parkedPid = await waitForParkedDelete(probe, holderPid, 'rig')
      console.log(`[zzgp-r3 rig] parked backend pid=${parkedPid}, holder pid=${holderPid}`)

      // THE PARK ADDS NO ROW LOCK: while the delete is parked, its target row is still
      // lockable by anyone. If it were not, the rig itself would serialise the race and
      // the main test could pass for the rig's reason instead of the code's.
      await outsider.query('BEGIN')
      const { rows: lockable } = await outsider.query(
        'SELECT id FROM wms_asn_maps WHERE id = $1 FOR UPDATE NOWAIT',
        [parkedTarget.id],
      )
      assert.equal(lockable.length, 1, 'the parked delete\'s target must still be lockable')
      await outsider.query('ROLLBACK')

      // AND IT IS SPECIFIC TO THE TOKEN: a session with the SAME application_name but
      // without this run's token is not parked. A statement timeout turns "parked" into a
      // loud failure rather than a hang.
      await outsider.query(`SET application_name = '${APP_NAME}'`)
      await outsider.query(`SET statement_timeout = 3000`)
      const { rowCount } = await (outsider as unknown as {
        query: (sql: string, values: unknown[]) => Promise<{ rowCount: number }>
      }).query('DELETE FROM wms_asn_maps WHERE id = $1', [outsiderTarget.id])
      assert.equal(rowCount, 1, 'an unrelated session\'s delete must run straight through')

      assert.equal(settled, false, 'still parked while the advisory lock is held')
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [PARK_TOKEN])
      holderHasLock = false
      const deleted = await parkedDelete
      assert.equal(deleted.count, 1, 'released, the parked delete completes')
    } finally {
      if (holderHasLock) await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [PARK_TOKEN]).catch(() => {})
      await dropParkTrigger(holder).catch(() => {})
      await holder.end().catch(() => {})
      await probe.end().catch(() => {})
      await outsider.end().catch(() => {})
    }
  },
)

test(
  'a discarded reservation cannot lose alignment credit that commits between its credit read and its delete (Codex r3 HIGH)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    // The guard runs inside prepareEnv, BEFORE the modules load and before the seed below.
    const { rawUrl } = await prepareEnv()
    const { createMintsoftTransferAsn } = await loadModules()
    const { loadTransferLineLandedQty, requireLandedQty } = await import('@/lib/domain/inventory/transfer-landed-quantity')
    const { applyMintsoftAlignmentForProduct } = await import('@/lib/connectors/mintsoft/sync/stock-sync')
    const world = await seedWorld('discard')
    const { db } = world

    const holder = await rawSession(rawUrl)
    const probe = await rawSession(rawUrl)
    let holderHasLock = false
    try {
      await installParkTrigger(holder)
      const holderPid = await backendPid(holder)

      // (1) Reserve, and pause at the WMS listing call between reservation and revalidation.
      const gate = armListingGate()
      const createPromise = createMintsoftTransferAsn(world.transfer.id, { autoCallback: false })
      // o3d-bhvu round 2: the gate being reached is ASSERTED, not assumed. If the action finished without
      // ever calling the gated listing (a rename, a stub on the wrong name), the race below would be run
      // against no window at all; this fails first instead of hanging or passing vacuously.
      await Promise.race([
        gate.reached,
        createPromise.then((result) => {
          throw new Error(`the ASN action finished without reaching the gated listing step: ${JSON.stringify(result)}`)
        }),
      ])

      const reserved = await db.wmsAsnMap.findMany({
        where: { sourceType: 'STOCK_TRANSFER', sourceId: world.transfer.id },
        select: { id: true, closedAt: true, lines: { select: { id: true, expectedQty: true, qtyAccountedViaSnapshot: true } } },
      })
      assert.equal(reserved.length, 1, 'precondition: exactly one pending reservation was made')
      assert.equal(reserved[0]!.lines.length, 1)
      assert.equal(Number(reserved[0]!.lines[0]!.expectedQty), LINE_QTY)
      assert.equal(Number(reserved[0]!.lines[0]!.qtyAccountedViaSnapshot), 0, 'precondition: nothing is credited yet')

      // (2) Make the revalidation disagree, so the action goes on to DISCARD the
      // reservation. What moves the figure is irrelevant to the race; a received unit
      // is the simplest thing that does, and it carries no ASN credit of its own.
      await holder.query(`UPDATE stock_transfer_lines SET "qtyReceived" = $1 WHERE id = $2`, [RECEIVED_BEFORE_DISCARD, world.transferLineId])

      // (3) Park every wms_asn_maps delete from this pool, then let the action continue.
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [PARK_TOKEN])
      holderHasLock = true
      gate.release()
      const parkedPid = await waitForParkedDelete(probe, holderPid, 'discard')

      // (4) The disposal is inside its delete. Now run a real alignment against the same line.
      const alignmentSettled = { done: false }
      const alignmentPromise = applyMintsoftAlignmentForProduct({
        binding: world.binding as never,
        jobId: `zzgp-r3-${Date.now()}`,
        productId: world.product.id,
        sku: world.tag,
        delta: ALIGN_DELTA,
        imsQty: 0,
        dryRun: false,
      }).finally(() => { alignmentSettled.done = true })

      const observation = await observeAlignment(probe, parkedPid, alignmentSettled)

      // (5) Release the disposal and let both finish.
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [PARK_TOKEN])
      holderHasLock = false
      const createResult = await createPromise
      const alignment = await alignmentPromise

      // ── RE-READ, after the fact ───────────────────────────────────────────────
      const line = await db.stockTransferLine.findUniqueOrThrow({
        where: { id: world.transferLineId },
        select: { id: true, qtyReceived: true },
      })
      const landed = requireLandedQty(await loadTransferLineLandedQty(db, [line]), line.id)
      const destinationStock = await db.stockLevel.findUniqueOrThrow({
        where: { productId_warehouseId: { productId: world.product.id, warehouseId: world.destination.id } },
        select: { quantity: true },
      })
      const creditRows = await db.wmsAsnLineMap.findMany({
        where: { sourceType: 'STOCK_TRANSFER_LINE', sourceLineId: world.transferLineId },
        select: { qtyAccountedViaSnapshot: true, asn: { select: { closedAt: true } } },
      })
      const diagnosis = JSON.stringify({
        observation,
        alignment,
        createResult,
        landed: landed.qtyNumber,
        fromQtyReceived: Number(landed.fromQtyReceived),
        fromWmsCredit: Number(landed.fromUnabsorbedWmsSnapshot),
        destinationStock: Number(destinationStock.quantity),
        creditRows: creditRows.map((row) => ({ credit: Number(row.qtyAccountedViaSnapshot), closed: row.asn.closedAt !== null })),
      })
      console.log(`[zzgp-r3] ${diagnosis}`)

      // 1 — the window was reached (asserted via waitForParkedDelete above, which throws
      //     if the delete never parked), and the action really went down the discard path.
      assert.equal(createResult.success, false, `the create must have been refused for the moved quantities: ${diagnosis}`)
      assert.match(String(createResult.error), /Outstanding quantities changed after reservation/)

      // 2 — THE MONEY. Every unit in destination stock that the alignment put there must
      //     still be recorded as landed. WAS (round-2 head): the alignment added its units
      //     and credited the line while the delete was parked, then the delete cascaded
      //     the credited line; landed read back as the one received unit alone.
      assert.equal(
        landed.qtyNumber,
        RECEIVED_BEFORE_DISCARD + Number(destinationStock.quantity),
        `landed must equal qtyReceived plus the units the alignment brought into stock — anything less means `
        + `the only record of aligned units was deleted: ${diagnosis}`,
      )

      // 3 — AND IT WAS THE LOCK. The alignment must have waited on the disposal's backend,
      //     at the transfer row, on a row lock and not on the rig's advisory lock.
      assert.equal(observation.kind, 'blocked', `nothing serialised the alignment against the disposal: ${diagnosis}`)
      if (observation.kind === 'blocked') {
        assert.match(observation.query, /stock_transfers/, `the alignment was blocked somewhere other than the transfer lock: ${diagnosis}`)
        assert.equal(observation.ungrantedLockTypes.includes('advisory'), false, 'the alignment must not be waiting on the rig\'s advisory lock')
      }
      // And the consequence on this ordering: the reservation was deleted while
      // uncredited, so the alignment found nothing to credit and put nothing into stock.
      assert.equal(alignment.applied, false)
      assert.equal(Number(destinationStock.quantity), 0)
      assert.equal(creditRows.length, 0)
    } finally {
      if (holderHasLock) await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [PARK_TOKEN]).catch(() => {})
      listingGate.current?.release()
      await dropParkTrigger(holder).catch(() => {})
      await holder.end().catch(() => {})
      await probe.end().catch(() => {})
    }
  },
)

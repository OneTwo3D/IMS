import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { RUNNER_APPLICATION_NAME } from '../../lib/first-load/apply/constants'
import { runLoad, type ApplyOptions, type ApplyPorts, type StepResult, type VerificationItem } from '../../lib/first-load/apply/orchestrate'
import type { PreparedRun } from '../../lib/first-load/apply/prepared'
import { VERIFICATION_IDS } from '../../lib/first-load/apply/verify-core'
import { REHEARSAL_RECORD_FORMAT_VERSION } from '../../lib/first-load/apply/constants'
import { tablesOfKind } from '../../lib/first-load/apply/table-classes'
import { checkoutMigrationNames } from '../../lib/first-load/apply/db/migrations'
import { loadOk, prepareSynthetic, preparedFiles, SENTINEL } from './apply-helpers'
import { resetLoadedData, startScratch, type Scratch } from './apply-scratch'
import { precondition } from './helpers'

/**
 * THE POST-RUN VERIFICATION AND THE CENSUS, on a real throwaway PostgreSQL cluster with the migrations applied.
 *
 * Controls first: a clean load verifies green on every item, so an arm that goes red is red because of the tamper and for no other reason. Each tamper is then made AFTER a good
 * load, the verifier is run on its own (the step results of the good load are passed in unchanged, so only the database differs), the one item that must catch it is asserted red,
 * and the tamper is undone. Each arm names, in a comment, the change to the subject that makes it green again (the mutation); the change was made, the arm went red and it was reverted.
 */

process.env.PGAPPNAME = RUNNER_APPLICATION_NAME

const REPO = process.cwd()
const SYSTEM_ID = 'verify-system'
let s: Scratch
let prepared: PreparedRun
let m: {
  ports: typeof import('../../lib/first-load/apply/db/ports')
  verify: typeof import('../../lib/first-load/apply/db/verify')
  journal: typeof import('../../lib/first-load/apply/db/journal')
}

const okRehearsal = (digest: string) => ({ formatVersion: REHEARSAL_RECORD_FORMAT_VERSION, manifestDigest: digest, verdict: 'OK', systemId: SYSTEM_ID, finishedAt: new Date().toISOString() })
const apply = (p: PreparedRun, extra: Partial<ApplyOptions> = {}): ApplyOptions => ({ mode: 'apply', resume: false, rehearsal: okRehearsal(p.manifestDigest), systemId: SYSTEM_ID, now: new Date(), maxRehearsalAgeHours: 24, ...extra })

function deps(over: Partial<import('../../lib/first-load/apply/db/verify').VerifyDeps> = {}): import('../../lib/first-load/apply/db/verify').VerifyDeps {
  return { outboundEnv: {}, expectedMigrations: checkoutMigrationNames(REPO), ...over }
}
const ports = (over: Partial<import('../../lib/first-load/apply/db/verify').VerifyDeps> = {}, extra: Partial<Parameters<typeof m.ports.createDbPorts>[1]> = {}): ApplyPorts =>
  m.ports.createDbPorts(prepared, { operator: 'Verify Test', verification: deps(over), ...extra })

const byId = (items: VerificationItem[]) => Object.fromEntries(items.map((i) => [i.id, i]))
const failing = (items: VerificationItem[]) => items.filter((i) => i.result === 'fail').map((i) => i.id).sort()

describe('the first-load post-run verification, database side', { timeout: 30 * 60 * 1000 }, () => {
  let steps: StepResult[] = []

  before(async () => {
    s = await startScratch('ims-apply-verify')
    m = {
      ports: await import('../../lib/first-load/apply/db/ports'),
      verify: await import('../../lib/first-load/apply/db/verify'),
      journal: await import('../../lib/first-load/apply/db/journal'),
    }
    prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  })
  after(async () => { await s?.stop() })

  /** Run one clean verified load into an empty database and return its result. */
  async function cleanLoad() {
    await resetLoadedData(s)
    const result = await runLoad(prepared, ports(), apply(prepared))
    steps = result.steps
    return result
  }

  /** Make a change, run the verifier alone on the database as it now is, undo the change. */
  async function withTamper(tamper: () => Promise<void>, undo: () => Promise<void>, over: Partial<import('../../lib/first-load/apply/db/verify').VerifyDeps> = {}): Promise<VerificationItem[]> {
    await tamper()
    try {
      return await m.verify.createVerifier(deps(over))(prepared, steps)
    } finally {
      await undo()
    }
  }

  it('CONTROL: a clean load ends OK and VERIFIED, every item passes, and the ids are exactly the closed list', async (t) => {
    const result = await cleanLoad()
    assert.deepEqual(result.problems, [])
    assert.equal(result.exit, 'OK')
    assert.equal((await m.journal.createJournal().load())!.status, 'VERIFIED')
    assert.deepEqual(failing(result.verification), [])
    assert.deepEqual(result.verification.map((i) => i.id).sort(), [...VERIFICATION_IDS].sort(), 'exactly the closed list: nothing missing, nothing extra')
    precondition(t, 'verification items', result.verification.length)
    // Text that reaches logs carries counts and closed words, never a key or value of the prepared files (every fixture value carries the sentinel).
    for (const i of result.verification) assert.doesNotMatch(`${i.expected} ${i.actual}`, SENTINEL, i.id)
  })

  it('the census baseline is recorded once, before the first write, with every table of the schema counted', async (t) => {
    await cleanLoad()
    const facts = await m.journal.loadFacts()
    const baseline = facts[m.verify.BASELINE_FACT] as { tables: Record<string, number>; digests: Record<string, string>; heldIds: string[] | null }
    const tables = (await s.sql<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).map((r) => r.table_name)
    assert.deepEqual(Object.keys(baseline.tables).sort(), tables.sort(), 'every base table, from information_schema')
    precondition(t, 'tables in the baseline', tables.length)
    // Taken before the importers ran: the runner-written tables were empty then (the run record itself existed).
    assert.equal(baseline.tables.products, 0)
    assert.equal(baseline.tables.cost_layers, 0)
    assert.equal(baseline.tables.first_load_apply_runs, 1)
    // Every table the runner does not write has a content digest; the runner's own tables have none (they are compared record by record).
    const written = new Set(tablesOfKind('RUNNER_WRITES'))
    assert.deepEqual(Object.keys(baseline.digests).sort(), tables.filter((n) => !written.has(n)).sort())
    assert.deepEqual(baseline.heldIds, [])
    // Once: a second attempt to record it changes nothing.
    assert.equal(await m.journal.setFactOnce(m.verify.BASELINE_FACT, { tables: { products: 99 }, digests: {}, heldIds: [] }), false)
  })

  describe('arms: each tamper after a good load is caught by the item that owns it', () => {
    before(async () => { await cleanLoad() })

    it('CONTROL: the verifier alone on the untouched database passes every item', async () => {
      const items = await m.verify.createVerifier(deps())(prepared, steps)
      assert.deepEqual(failing(items), [])
    })

    it('a run that selects no opening-stock step expects NO opening layer: the stock the first run loaded is foreign to it (not "empty, so skipped")', async () => {
      // Mutation: skip the stock checks when the step is not selected and this is green.
      const suppliersAndProducts = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore', steps: ['suppliers', 'products'], expectWarehouses: undefined, acceptZeroCost: undefined, fxRates: undefined })
      const items = await m.verify.createVerifier(deps())(suppliersAndProducts, steps.filter((x) => x.step === 'suppliers' || x.step === 'products'))
      assert.ok(failing(items).includes('stock-totals'), JSON.stringify(failing(items)))
      assert.ok(failing(items).includes('opening-movements'), JSON.stringify(failing(items)))
    })

    it('a stock quantity off by 0.000001 is caught by the exact totals (and not rounded away)', async () => {
      // Mutation: compare the totals with a tolerance or through 2 decimal places, and this is green.
      const items = await withTamper(
        () => s.sql(`update cost_layers set "receivedQty" = "receivedQty" + 0.000001 where id = (select id from cost_layers where "isOpeningStock" order by id limit 1)`).then(() => undefined),
        () => s.sql(`update cost_layers set "receivedQty" = "receivedQty" - 0.000001 where id = (select id from cost_layers where "isOpeningStock" order by id limit 1)`).then(() => undefined),
      )
      assert.ok(failing(items).includes('stock-totals'), JSON.stringify(failing(items)))
    })

    it('a unit cost off by 0.000001 is caught', async () => {
      const items = await withTamper(
        () => s.sql(`update cost_layers set "unitCostBase" = "unitCostBase" + 0.000001 where id = (select id from cost_layers where "isOpeningStock" order by id limit 1)`).then(() => undefined),
        () => s.sql(`update cost_layers set "unitCostBase" = "unitCostBase" - 0.000001 where id = (select id from cost_layers where "isOpeningStock" order by id limit 1)`).then(() => undefined),
      )
      assert.ok(failing(items).includes('stock-totals'), JSON.stringify(failing(items)))
    })

    it('a stock level that differs from its layers, or holds a reservation, is caught', async () => {
      const level = `(select id from stock_levels order by id limit 1)`
      // Mutation: drop the full join (read only levels that have layers) or the reserved clause, and the arm that exercises it is green.
      const items = await withTamper(() => s.sql(`update stock_levels set quantity = quantity + 1 where id = ${level}`).then(() => undefined), () => s.sql(`update stock_levels set quantity = quantity - 1 where id = ${level}`).then(() => undefined))
      assert.ok(failing(items).includes('stock-levels-equal-layers'))
      const reserved = await withTamper(() => s.sql(`update stock_levels set "reservedQty" = 1 where id = ${level}`).then(() => undefined), () => s.sql(`update stock_levels set "reservedQty" = 0 where id = ${level}`).then(() => undefined))
      assert.ok(failing(reserved).includes('stock-levels-equal-layers'))
    })

    it('the importer-says-created reproduction: a KIT whose recipe is missing reads back as not matching, whatever the step results said', async () => {
      // The step results of the good load still say created, 0 failed. Mutation: trust them (skip the read-back) and 'final-readback' is green.
      const items = await withTamper(
        () => s.sql(`delete from product_components where "productId" = (select id from products where sku = 'ZQSENT-GIFT-SET')`).then(() => undefined),
        async () => {
          const parent = (await s.sql<{ id: string }>(`select id from products where sku = 'ZQSENT-GIFT-SET'`))[0]!.id
          const part = async (sku: string) => (await s.sql<{ id: string }>(`select id from products where sku = $1`, [sku]))[0]!.id
          await s.sql(`insert into product_components (id, "productId", "componentId", qty) values ('zq-1', $1, $2, 1), ('zq-2', $1, $3, 2)`, [parent, await part('ZQSENT-TSHIRT-S'), await part('ZQSENT-OAK-BOARD')])
        },
      )
      assert.ok(failing(items).includes('final-readback'), JSON.stringify(failing(items)))
      assert.deepEqual(steps.map((x) => x.failed), steps.map(() => 0), 'the step results were not touched')
    })

    it('BOM drift between the two recipe representations is caught', async () => {
      const bom = `(select id from boms limit 1)`
      const saved = (await s.sql<Record<string, unknown>>(`select * from bom_items where "bomId" = ${bom}`))
      assert.ok(saved.length > 0, 'precondition: the fixture has a manufacturing BOM with items')
      const items = await withTamper(
        () => s.sql(`delete from bom_items where "bomId" = ${bom}`).then(() => undefined),
        async () => {
          for (const row of saved) {
            const cols = Object.keys(row)
            await s.sql(`insert into bom_items (${cols.map((c) => `"${c}"`).join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => row[c]))
          }
        },
      )
      assert.ok(failing(items).includes('bom-recipe-drift'), JSON.stringify(failing(items)))
    })

    it('a row in the outbound queue, the accounting log, the warehouse jobs or the email queue is caught, by name', async (t) => {
      let arms = 0
      for (const table of ['integration_outbox', 'accounting_sync_logs', 'email_outbox', 'wms_sync_jobs']) {
        // Mutation: drop the queue comparison from censusItems (or compare against 0 instead of the baseline), and this is green for the queue tables the census does not name.
        const before = await s.count(table)
        const probe = await queueProbe(table)
        const items = await withTamper(() => s.sql(probe.insert).then(() => undefined), () => s.sql(probe.remove).then(() => undefined))
        assert.ok(failing(items).includes('no-queue-growth'), `${table}: ${JSON.stringify(failing(items))}`)
        assert.match(byId(items)['no-queue-growth'].actual, new RegExp(table))
        assert.equal(await s.count(table), before, `${table} was restored`)
        arms++
      }
      precondition(t, 'queue arms', arms)
    })

    it('a refused outbound write recorded during the load is caught by count, not by a time window', async () => {
      // Mutation: compare "any refusal in the last 24h" instead of the baseline count, and a refusal that PRE-DATES the load fails the clean arm below instead.
      const items = await withTamper(
        () => s.sql(`insert into activity_logs (id, action, "entityType", "entityId", tag, description, "createdAt") values ('zq-held', 'OUTBOUND_WRITE_HELD', 'IMPORT', 'x', 'system', 'x', now())`).then(() => undefined),
        () => s.sql(`delete from activity_logs where id = 'zq-held'`).then(() => undefined),
      )
      assert.ok(failing(items).includes('no-held-writes'), JSON.stringify(failing(items)))
    })

    it('a write to a table the runner never writes is caught by the census, whatever its class, and a table that did not exist at the start is too', async () => {
      // Mutation: count a fixed list of tables (or only the baseline's tables), and the second half is green.
      const settings = await withTamper(
        () => s.sql(`insert into settings (key, value, "updatedAt") values ('zq_stray', 'x', now())`).then(() => undefined),
        () => s.sql(`delete from settings where key = 'zq_stray'`).then(() => undefined),
      )
      assert.ok(failing(settings).includes('write-census'))
      assert.match(byId(settings)['write-census'].actual, /settings/)
      const created = await withTamper(
        () => s.sql(`create table zq_stray_table (id int)`).then(() => undefined),
        () => s.sql(`drop table zq_stray_table`).then(() => undefined),
      )
      assert.ok(failing(created).includes('write-census'))
      assert.match(byId(created)['write-census'].actual, /zq_stray_table/)
    })

    it('a grant in the installation environment fails the held check, and an unreadable one does too', async () => {
      // Mutation: evaluate the status against an empty environment, and both are green.
      const granted = await withTamper(async () => undefined, async () => undefined, { outboundEnv: { MINTSOFT_WRITE_ALLOWED: 'https://api.example.test|89' } })
      assert.ok(failing(granted).includes('outbound-held'), JSON.stringify(failing(granted)))
      const unreadable = await withTamper(async () => undefined, async () => undefined, { outboundEnv: { MINTSOFT_WRITE_ALLOWED: 'not a grant' } })
      assert.ok(failing(unreadable).includes('outbound-held'), JSON.stringify(failing(unreadable)))
    })

    it('a purchase order that is not a draft is caught', async () => {
      // The synthetic run loads two orders. Mutation: drop the status clause.
      const items = await withTamper(
        () => s.sql(`update purchase_orders set status = 'PO_SENT' where id = (select id from purchase_orders order by id limit 1)`).then(() => undefined),
        () => s.sql(`update purchase_orders set status = 'DRAFT'`).then(() => undefined),
      )
      assert.ok(failing(items).includes('purchase-orders-draft'), JSON.stringify(failing(items)))
    })

    it('the order the checkout expects IS the order a fresh deploy applied the migrations in (the rule is measured, not assumed)', async () => {
      const rows = await s.sql<{ migration_name: string }>('select migration_name from _prisma_migrations order by started_at, migration_name')
      assert.deepEqual(rows.map((r) => r.migration_name), checkoutMigrationNames(REPO))
      assert.ok(rows.length > 100)
    })

    it('migrations: the same COUNT with one different name, one missing, an unfinished one and one out of order are each caught, by closed code', async () => {
      // Mutation: compare the row count only (the old item) and the renamed arm is green.
      const first = `(select migration_name from _prisma_migrations order by migration_name limit 1)`
      const renamed = await withTamper(
        () => s.sql(`update _prisma_migrations set migration_name = migration_name || '_other' where migration_name = ${first}`).then(() => undefined),
        () => s.sql(`update _prisma_migrations set migration_name = replace(migration_name, '_other', '') where migration_name like '%\\_other'`).then(() => undefined),
      )
      assert.ok(failing(renamed).includes('migrations-applied'))
      assert.match(byId(renamed)['migrations-applied'].actual, /MIGRATIONS_MISSING x1, MIGRATIONS_EXTRA x1/)
      const unfinished = await withTamper(
        () => s.sql(`update _prisma_migrations set finished_at = null where migration_name = ${first}`).then(() => undefined),
        () => s.sql(`update _prisma_migrations set finished_at = now() where finished_at is null`).then(() => undefined),
      )
      assert.match(byId(unfinished)['migrations-applied'].actual, /MIGRATIONS_UNFINISHED x1/)
      const wrongList = await m.verify.createVerifier(deps({ expectedMigrations: [...checkoutMigrationNames(REPO).slice(1), '29990101000000_not_there'] }))(prepared, steps)
      assert.ok(failing(wrongList).includes('migrations-applied'))
      const original = (await s.sql<{ name: string; started: string }>(`select migration_name as name, started_at::text as started from _prisma_migrations order by migration_name limit 1`))[0]!
      const reordered = await withTamper(
        () => s.sql(`update _prisma_migrations set started_at = now() + interval '1 day' where migration_name = $1`, [original.name]).then(() => undefined),
        () => s.sql(`update _prisma_migrations set started_at = $2::timestamptz where migration_name = $1`, [original.name, original.started]).then(() => undefined),
      )
      assert.match(byId(reordered)['migrations-applied'].actual, /MIGRATIONS_OUT_OF_ORDER/)
    })

    // ---- records exchanged while every count and total stays equal ----------------------------------------------------------------------------

    const twoLayers = `select cl.id, cl."receivedQty", cl."remainingQty", cl."unitCostBase", cl.adjustment_movement_id from cost_layers cl join warehouses w on w.id = cl."warehouseId" where cl."isOpeningStock" and w.code = 'ZQSENT-MAIN' order by cl.id limit 2`

    it('stock-totals: two layers of the SAME warehouse exchange their quantities (every sum equal) and are caught', async () => {
      // Mutation: compare per-warehouse sums (the old item) and this is green.
      const [a, b] = await s.sql<{ id: string; receivedQty: string; remainingQty: string }>(twoLayers)
      assert.notEqual(a!.receivedQty, b!.receivedQty, 'precondition: the two layers differ')
      const swap = (x: typeof a, y: typeof b) => s.sql(`update cost_layers set "receivedQty" = $2, "remainingQty" = $3 where id = $1`, [x!.id, y!.receivedQty, y!.remainingQty])
      const items = await withTamper(async () => { await swap(a, b); await s.sql(`update cost_layers set "receivedQty" = $2, "remainingQty" = $3 where id = $1`, [b!.id, a!.receivedQty, a!.remainingQty]) },
        async () => { await s.sql(`update cost_layers set "receivedQty" = $2, "remainingQty" = $3 where id = $1`, [a!.id, a!.receivedQty, a!.remainingQty]); await s.sql(`update cost_layers set "receivedQty" = $2, "remainingQty" = $3 where id = $1`, [b!.id, b!.receivedQty, b!.remainingQty]) })
      assert.ok(failing(items).includes('stock-totals'), JSON.stringify(failing(items)))
    })

    it('opening-movements: two movements exchange their quantities, or their layer links (count and total equal), and are caught', async () => {
      // Mutation: compare the movement count and the total quantity (the old item) and both are green.
      const mv = await s.sql<{ id: string; qty: string; unitCostBase: string; totalValueBase: string }>(`select m.id, m.qty, m."unitCostBase", m."totalValueBase" from stock_movements m join products p on p.id = m."productId" where m.type = 'OPENING_STOCK' order by m."qty", m.id limit 2`)
      const [a, b] = mv
      assert.notEqual(a!.qty, b!.qty, 'precondition: the two movements differ')
      const set = (id: string, v: { qty: string; unitCostBase: string; totalValueBase: string }) => s.sql(`update stock_movements set qty = $2, "unitCostBase" = $3, "totalValueBase" = $4 where id = $1`, [id, v.qty, v.unitCostBase, v.totalValueBase])
      const swapped = await withTamper(async () => { await set(a!.id, b!); await set(b!.id, a!) }, async () => { await set(a!.id, a!); await set(b!.id, b!) })
      assert.ok(failing(swapped).includes('opening-movements'), JSON.stringify(failing(swapped)))
      const [la, lb] = await s.sql<{ id: string; adjustment_movement_id: string }>(`select id, adjustment_movement_id from cost_layers where "isOpeningStock" order by id limit 2`)
      const linkSwap = (x: string, y: string) => s.sql(`update cost_layers set adjustment_movement_id = case id when $1 then $4 when $2 then $3 end where id in ($1, $2)`, [la!.id, lb!.id, x, y])
      const crossed = await withTamper(() => linkSwap(la!.adjustment_movement_id, lb!.adjustment_movement_id).then(() => undefined), () => linkSwap(lb!.adjustment_movement_id, la!.adjustment_movement_id).then(() => undefined))
      assert.ok(failing(crossed).includes('opening-movements'), JSON.stringify(failing(crossed)))
    })

    it('stock-levels-equal-layers: two levels exchange their quantities (the sum equal) and are caught', async () => {
      // Mutation: compare the total of the levels with the total of the layers and this is green.
      const [a, b] = await s.sql<{ id: string; quantity: string }>(`select id, quantity from stock_levels order by quantity, id limit 2`)
      assert.notEqual(a!.quantity, b!.quantity)
      const set = (id: string, q: string) => s.sql(`update stock_levels set quantity = $2 where id = $1`, [id, q])
      const items = await withTamper(async () => { await set(a!.id, b!.quantity); await set(b!.id, a!.quantity) }, async () => { await set(a!.id, a!.quantity); await set(b!.id, b!.quantity) })
      assert.ok(failing(items).includes('stock-levels-equal-layers'), JSON.stringify(failing(items)))
    })

    it('purchase-orders-draft: an order renamed to another reference (count and statuses equal) is caught', async () => {
      // Mutation: compare the count and the non-draft count (the old item) and this is green.
      const items = await withTamper(
        () => s.sql(`update purchase_orders set reference = reference || '-X' where id = (select id from purchase_orders order by id limit 1)`).then(() => undefined),
        () => s.sql(`update purchase_orders set reference = replace(reference, '-X', '') where reference like '%-X'`).then(() => undefined),
      )
      assert.ok(failing(items).includes('purchase-orders-draft'), JSON.stringify(failing(items)))
    })

    it('final-readback: two suppliers exchange their names (counts equal, every fingerprint changed) and are caught', async () => {
      const [a, b] = await s.sql<{ id: string; name: string }>(`select id, name from suppliers order by name limit 2`)
      const set = (id: string, name: string) => s.sql(`update suppliers set name = $2 where id = $1`, [id, name])
      const items = await withTamper(async () => { await set(a!.id, 'tmp-swap'); await set(b!.id, a!.name); await set(a!.id, b!.name) }, async () => { await set(a!.id, a!.name); await set(b!.id, b!.name) })
      // Same names exist, so the file's keys are all present, but each now carries the OTHER's fields.
      assert.ok(failing(items).includes('final-readback'), JSON.stringify(failing(items)))
    })

    // ---- the census against a baseline that held rows ----------------------------------------------------------------------------------------

    async function withBaselineNow<T>(fn: () => Promise<T>): Promise<T> {
      const original = (await s.sql<{ facts: Record<string, unknown> }>('select facts from first_load_apply_runs'))[0]!.facts
      const reading = await m.verify.readNow()
      await s.sql(`update first_load_apply_runs set facts = facts || jsonb_build_object('baseline', $1::jsonb)`, [JSON.stringify(reading)])
      try { return await fn() } finally { await s.sql(`update first_load_apply_runs set facts = $1::jsonb`, [JSON.stringify(original)]) }
    }

    it('no-held-writes: the same number of refused writes with ANOTHER row is caught (by id, not count)', async () => {
      // Mutation: compare the lengths of the id lists and this is green.
      const ins = (id: string) => s.sql(`insert into activity_logs (id, action, "entityType", "entityId", tag, description, "createdAt") values ($1, 'OUTBOUND_WRITE_HELD', 'IMPORT', 'x', 'system', 'x', now())`, [id])
      await ins('zq-held-a')
      try {
        const items = await withBaselineNow(async () => {
          await s.sql(`delete from activity_logs where id = 'zq-held-a'`); await ins('zq-held-b')
          return m.verify.createVerifier(deps())(prepared, steps)
        })
        assert.ok(failing(items).includes('no-held-writes'), JSON.stringify(failing(items)))
        assert.match(byId(items)['no-held-writes'].actual, /1 new, 1 gone/)
      } finally { await s.sql(`delete from activity_logs where id in ('zq-held-a', 'zq-held-b')`) }
    })

    it('no-queue-growth: a queue row replaced by another (same count) is caught by content', async () => {
      // Mutation: compare the queue counts only and this is green.
      const probe = await queueProbe('integration_outbox')
      await s.sql(probe.insert)
      try {
        const items = await withBaselineNow(async () => {
          await s.sql(probe.remove); await s.sql(probe.insert)
          return m.verify.createVerifier(deps())(prepared, steps)
        })
        assert.ok(failing(items).includes('no-queue-growth'), JSON.stringify(failing(items)))
      } finally { await s.sql(probe.remove) }
    })

    it('write-census: a configuration row changed IN PLACE (the count equal) is caught by content', async () => {
      // Mutation: compare the table counts only and this is green.
      const key = (await s.sql<{ key: string }>(`select key from settings order by key limit 1`))[0]!.key
      const original = (await s.sql<{ value: string }>(`select value from settings where key = $1`, [key]))[0]!.value
      try {
        const items = await withBaselineNow(async () => {
          await s.sql(`update settings set value = value || 'x' where key = $1`, [key])
          return m.verify.createVerifier(deps())(prepared, steps)
        })
        assert.ok(failing(items).includes('write-census'), JSON.stringify(failing(items)))
        assert.match(byId(items)['write-census'].actual, /settings/)
      } finally { await s.sql(`update settings set value = $2 where key = $1`, [key, original]) }
    })

    it('a critical invariant finding fails the load', async () => {
      const items = await m.verify.createVerifier(deps({ runInvariants: async () => ({ ok: false, critical: 1 }) }))(prepared, steps)
      assert.ok(failing(items).includes('invariants'))
    })

    it('a reading that cannot be taken is a FAILED item, never a skipped one and never a throw (fail closed)', async (t) => {
      // Mutation: let the error escape, or drop the item on error, and this goes red.
      const items = await withTamper(
        () => s.sql(`alter table purchase_orders rename to zq_hidden_orders`).then(() => undefined),
        () => s.sql(`alter table zq_hidden_orders rename to purchase_orders`).then(() => undefined),
      )
      const unreadable = items.filter((i) => i.actual === 'could not be read')
      precondition(t, 'unreadable items', unreadable.length)
      assert.ok(unreadable.every((i) => i.result === 'fail'))
      assert.deepEqual(items.map((i) => i.id).sort(), [...VERIFICATION_IDS].sort(), 'no item went missing')
    })

    it('a record without a baseline cannot be census-verified: all four census items fail', async () => {
      const facts = await s.sql<{ facts: Record<string, unknown> }>(`select facts from first_load_apply_runs`)
      const stripped = { ...facts[0]!.facts }
      delete stripped[m.verify.BASELINE_FACT]
      const items = await withTamper(
        () => s.sql(`update first_load_apply_runs set facts = $1::jsonb`, [JSON.stringify(stripped)]).then(() => undefined),
        () => s.sql(`update first_load_apply_runs set facts = $1::jsonb`, [JSON.stringify(facts[0]!.facts)]).then(() => undefined),
      )
      assert.deepEqual(failing(items).filter((id) => ['census-baseline', 'no-held-writes', 'no-queue-growth', 'write-census'].includes(id)), ['census-baseline', 'no-held-writes', 'no-queue-growth', 'write-census'])
    })

    it('a write by someone else that is the right shape for the runner\'s tables is caught by the rails, not waved through as expected', async () => {
      // The census allows the runner's tables to change; a foreign supplier is only caught because the final read-back and the rails look at WHO the rows belong to.
      const items = await withTamper(
        () => s.sql(`insert into suppliers (id, name, currency, "updatedAt") values ('zq-foreign', 'Somebody Else', 'GBP', now())`).then(() => undefined),
        () => s.sql(`delete from suppliers where id = 'zq-foreign'`).then(() => undefined),
      )
      assert.ok(failing(items).includes('final-readback'), JSON.stringify(failing(items)))
      assert.ok(failing(items).includes('rails-after-load'), JSON.stringify(failing(items)))
    })
  })

  describe('the run record follows the verdict', () => {
    it('a load that selects no opening-stock step verifies OK when the database holds no stock (the absence of the step is not a failure either)', async () => {
      // Mutation: expect the prepared report's stock total even when the step is not selected, and this fails.
      await resetLoadedData(s)
      const subset = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore', steps: ['suppliers', 'products'], expectWarehouses: undefined, acceptZeroCost: undefined, fxRates: undefined })
      const result = await runLoad(subset, m.ports.createDbPorts(subset, { operator: 'Verify Test', verification: deps() }), apply(subset))
      assert.equal(result.exit, 'OK', result.problems.join('; '))
      assert.deepEqual(failing(result.verification), [])
    })

    it('a crash mid-load and a resume: the baseline is the first attempt\'s, and the resumed load verifies clean across both attempts', async () => {
      await resetLoadedData(s)
      let crashed = false
      const crashing = ports({}, { maxRowsPerCall: 1, afterCall: async (step, call) => { if (step === 'opening-stock' && call === 1) { crashed = true; throw new Error('simulated crash') } } })
      const first = await runLoad(prepared, crashing, apply(prepared))
      assert.ok(crashed)
      assert.equal(first.exit, 'STEP_FAILED')
      const baselineAfterCrash = (await m.journal.loadFacts())[m.verify.BASELINE_FACT]
      assert.ok(baselineAfterCrash, 'the baseline was recorded before the crash')
      const resumed = await runLoad(prepared, ports(), apply(prepared, { resume: true }))
      assert.equal(resumed.exit, 'OK', resumed.problems.join('; '))
      assert.deepEqual((await m.journal.loadFacts())[m.verify.BASELINE_FACT], baselineAfterCrash, 'the resume did not take a new starting point')
      assert.deepEqual(failing(resumed.verification), [])
    })

    it('a failed verification ends VERIFY_FAILED with the failing items named by id, leaves the record VERIFY_FAILED and is resumable', async () => {
      await cleanLoad()
      // A refused outbound write that appeared after the baseline: the data still matches the files exactly (so the plan finds no conflict), and only the verification can see it.
      await s.sql(`insert into activity_logs (id, action, "entityType", "entityId", tag, description, "createdAt") values ('zq-held-2', 'OUTBOUND_WRITE_HELD', 'IMPORT', 'x', 'system', 'x', now())`)
      // The record is APPLIED -> verify-only resume. (The clean load recorded VERIFIED; put it back to APPLIED as a crash after the last step would have left it.)
      await s.sql(`update first_load_apply_runs set status = 'APPLIED', version = version + 1`)
      const result = await runLoad(prepared, ports(), apply(prepared, { resume: true }))
      assert.equal(result.exit, 'VERIFY_FAILED')
      assert.match(result.problems.join(' '), /no-held-writes/)
      assert.doesNotMatch(result.problems.join(' '), SENTINEL)
      assert.equal((await m.journal.createJournal().load())!.status, 'VERIFY_FAILED')
      // Undo the tamper: a verify-only resume of the VERIFY_FAILED record now verifies and records VERIFIED.
      await s.sql(`delete from activity_logs where id = 'zq-held-2'`)
      const again = await runLoad(prepared, ports(), apply(prepared, { resume: true }))
      assert.equal(again.exit, 'OK', again.problems.join('; '))
      assert.equal((await m.journal.createJournal().load())!.status, 'VERIFIED')
    })
  })

  /** An insert and its removal for each queue table, with just the columns the table requires. */
  async function queueProbe(table: string): Promise<{ insert: string; remove: string }> {
    const required = await s.sql<{ column_name: string; data_type: string; udt_name: string }>(
      `select column_name, data_type, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1 and is_nullable = 'NO' and column_default is null order by ordinal_position`, [table],
    )
    const enums = new Map<string, string>()
    const values: string[] = []
    for (const c of required) {
      if (c.data_type === 'USER-DEFINED') {
        const label = (await s.sql<{ enumlabel: string }>(`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`, [c.udt_name]))[0]!.enumlabel
        enums.set(c.column_name, label)
        values.push(`'${label}'::"${c.udt_name}"`)
      } else if (c.data_type === 'jsonb' || c.data_type === 'json') values.push(`'{}'::${c.data_type}`)
      else if (c.data_type.startsWith('timestamp')) values.push('now()')
      else if (c.data_type === 'integer' || c.data_type === 'bigint' || c.data_type === 'numeric') values.push('0')
      else if (c.data_type === 'boolean') values.push('false')
      else values.push(`'zq-probe-' || ${c.column_name === 'id' ? 'gen_random_uuid()::text' : "'x'"}`)
    }
    const idIndex = required.findIndex((c) => c.column_name === 'id')
    assert.ok(idIndex >= 0 || required.length > 0, `${table}: columns found`)
    const cols = required.map((c) => `"${c.column_name}"`).join(', ')
    return {
      insert: `insert into ${table} (${cols}) values (${values.join(', ')})`,
      remove: idIndex >= 0 ? `delete from ${table} where id like 'zq-probe-%'` : `delete from ${table}`,
    }
  }
})

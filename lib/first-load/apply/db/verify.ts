/**
 * POST-RUN VERIFICATION, THE DATABASE PART: reads the database after the steps and hands the readings to the pure rules in verify-core.ts.
 *
 * FAIL CLOSED. A reading that cannot be taken is a FAILED item ("could not be read"), never a missing item and never a pass: a verification that skips what it cannot read would
 * report VERIFIED for exactly the loads it knows least about. The driver's text is dropped (it can carry a connection string or a value).
 *
 * THE BASELINE. The census compares the database with itself, so the starting counts must be taken before the first importer call and kept where a resume can find them: the run
 * record's `facts` (written once, never rewritten). `captureBaseline` is called by the ports at the start of every step (the first call wins; the rails have just passed, nothing
 * of this run has been written except the run record itself, which the census expects to change). A load whose record has no baseline cannot be census-verified and fails.
 *
 * WHAT IS COUNTED. Every base table of the `public` schema from `information_schema`, by an exact `count(*)`. Not a fixed list (a table someone forgot would be a blind spot), not
 * `pg_stat` (its counters are flushed asynchronously, so a fresh write can be absent from them).
 *
 * "NOTHING WAS HELD" IS A COUNT, NOT A WINDOW. The refused-outbound-write rows are compared by number with the baseline. A time window would infer "new" from two clocks (the
 * database's and the application's) and from the order of timestamps; a count needs neither. What a count cannot see is a row deleted and another inserted in the same load, which
 * needs the application running and writing during it; the application is stopped for a load (docs/first-load-apply.md), and the quiesce rail checks nobody else is connected.
 */
import { db } from '@/lib/db'
import { getBaseCurrencyCode, isBaseCurrencyLocked } from '@/lib/base-currency'
import { findBomRecipeDrift } from '@/lib/products/bom-recipe'
import { buildOutboundStatusReport, outboundStatusExitCode } from '@/lib/ops/outbound-status'
import { OUTBOUND_HELD_ACTION } from '@/lib/security/outbound-write-hold-constants'
import { D } from '../../money'
import { SUPPORTED_BASE_CURRENCY } from '../constants'
import type { ApplyPorts, VerificationItem } from '../orchestrate'
import type { PreparedRun } from '../prepared'
import { classifyStep } from '../residual'
import {
  HELD_IDS_CAP, accountingItem, censusItems, chainItem, compareMigrations, expectedWrittenTables, fileStockPairs, item, openingMovementsItem, parseBaseline, purchaseOrdersItem, stockTotalsItem,
  type Baseline, type Reading, type StoredLayer, type StoredMovement, type VerificationId,
} from '../verify-core'
import { loadFacts, setFactOnce } from './journal'
import { observeStep } from './observe'
import { evaluateRails } from './rails'

export const BASELINE_FACT = 'baseline'
const UNREADABLE = 'could not be read'
const TABLE_NAME = /^[A-Za-z0-9_]{1,63}$/

export interface VerifyDeps {
  /** The environment the outbound-write status is evaluated against: the installation's own variables, merged with this process's. A grant in it fails the verification. */
  outboundEnv: Record<string, string | undefined>
  /** The checkout's migration names in applied order: the migration table must hold EXACTLY these (compareMigrations). */
  expectedMigrations: readonly string[]
  /** Test seam: the scheduled invariant check. Default: the application's own, in process, writing nothing. */
  runInvariants?: () => Promise<{ ok: boolean; critical: number }>
}

async function tableNames(): Promise<string[]> {
  const names = (await db.$queryRaw<Array<{ table_name: string }>>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`).map((r) => r.table_name)
  if (names.length === 0 || names.some((n) => !TABLE_NAME.test(n))) throw new Error('the table list is empty or holds a name this reader does not trust')
  return names
}

/** Exact row count of every base table of the schema. */
export async function countAllTables(names: readonly string[]): Promise<Record<string, number>> {
  const rows = await db.$queryRawUnsafe<Array<{ t: string; n: string }>>(names.map((n) => `select '${n}' as t, count(*)::text as n from "${n}"`).join(' union all '))
  const out: Record<string, number> = {}
  for (const row of rows) out[row.t] = Number(row.n)
  if (Object.keys(out).length !== names.length) throw new Error('a table was not counted')
  return out
}

/** A digest of the CONTENT of each table (md5 over its rows' text, sorted): the identity of what is in it, which a count cannot give. */
export async function digestTables(names: readonly string[]): Promise<Record<string, string>> {
  if (names.length === 0) return {}
  const rows = await db.$queryRawUnsafe<Array<{ t: string; d: string }>>(names.map((n) => `select '${n}' as t, md5(coalesce(string_agg(x, E'\\n' order by x), '')) as d from (select r::text as x from "${n}" r) s`).join(' union all '))
  const out: Record<string, string> = {}
  for (const row of rows) out[row.t] = row.d
  if (Object.keys(out).length !== names.length) throw new Error('a table was not digested')
  return out
}

export async function readNow(): Promise<Reading> {
  const names = await tableNames()
  const written = expectedWrittenTables()
  const held = await db.activityLog.findMany({ where: { action: OUTBOUND_HELD_ACTION }, select: { id: true }, take: HELD_IDS_CAP + 1 })
  return {
    tables: await countAllTables(names),
    // Every table the runner does NOT write is compared by content; the runner's own tables are compared record by record by the other items.
    digests: await digestTables(names.filter((n) => !written.has(n))),
    heldIds: held.length > HELD_IDS_CAP ? null : held.map((h) => h.id).sort(),
  }
}

/** Record the starting state once. Returns true when this call recorded it. The ports call it at the start of every step, after the rails passed. */
export async function captureBaseline(): Promise<boolean> {
  const now = await readNow()
  return setFactOnce(BASELINE_FACT, now satisfies Baseline)
}

async function guarded(id: VerificationId, expected: string, read: () => Promise<VerificationItem>): Promise<VerificationItem> {
  try {
    return await read()
  } catch {
    return item(id, false, expected, UNREADABLE)
  }
}

const num = (text: string | null | undefined): string => text ?? '0'

export function createVerifier(deps: VerifyDeps): NonNullable<ApplyPorts['verify']> {
  return async (prepared: PreparedRun, steps): Promise<VerificationItem[]> => {
    const items: VerificationItem[] = []
    items.push(accountingItem(prepared, steps))
    items.push(chainItem(prepared, steps))

    // The database against the files, from scratch: every unit of every selected step is present and matching, and nothing foreign is there. The step results are not trusted.
    items.push(await guarded('final-readback', 'every unit present and matching, no foreign row', async () => {
      let notMatching = 0
      let foreign = 0
      for (const step of prepared.steps) {
        const c = classifyStep(step.step, step.units, await observeStep(prepared, step.step))
        notMatching += c.counts.absent + c.counts.presentConflicting
        foreign += c.counts.foreign
      }
      return item('final-readback', notMatching === 0 && foreign === 0, 'every unit present and matching, no foreign row', notMatching === 0 && foreign === 0 ? `${prepared.steps.length} step(s) read back clean` : `${notMatching} unit(s) not matching, ${foreign} foreign row(s)`)
    }))

    // The rails, once more over the finished load: nobody else connected, no data class holding a row it must not, the warehouses and base currency as declared, every row attributable to the files.
    items.push(await guarded('rails-after-load', 'every rail still holds', async () => {
      const problems = await evaluateRails(prepared, { phase: 'recheck', resuming: true, step: null })
      return item('rails-after-load', problems.length === 0, 'every rail still holds', problems.length === 0 ? 'every rail holds' : `${problems.length} rail problem(s)`)
    }))

    // Stock, record by record: every opening layer against its file record (SKU and warehouse), exactly.
    const selectedStock = prepared.steps.some((st) => st.step === 'opening-stock')
    items.push(await guarded('stock-totals', 'each layer equals its file record', async () => {
      const rows = await db.$queryRaw<Array<{ sku: string; code: string; received: string; remaining: string; cost: string }>>`
        select upper(p.sku) as sku, upper(w.code) as code, cl."receivedQty"::text as received, cl."remainingQty"::text as remaining, cl."unitCostBase"::text as cost
          from cost_layers cl join products p on p.id = cl."productId" join warehouses w on w.id = cl."warehouseId" where cl."isOpeningStock"`
      const other = await db.$queryRaw<Array<{ n: string }>>`select count(*)::text as n from cost_layers where not "isOpeningStock"`
      const layers: StoredLayer[] = rows.map((r) => ({ key: `${r.sku}|${r.code}`, received: new D(r.received), remaining: new D(r.remaining), cost: new D(r.cost) }))
      const totals = (prepared.report as unknown as { stock?: { totals?: { openingQty?: string; openingValueBase?: string } } }).stock?.totals
      // No opening-stock step selected: the prepared report's totals do not apply to this load, and the database must hold no opening layer at all.
      const report = !selectedStock ? { qty: '0', value: '0' } : totals?.openingQty !== undefined && totals.openingValueBase !== undefined ? { qty: totals.openingQty, value: totals.openingValueBase } : null
      return stockTotalsItem({ file: fileStockPairs(prepared), layers, report, nonOpeningLayers: Number(num(other[0]?.n)) })
    }))

    items.push(await guarded('opening-movements', 'each movement paired with its layer and the file', async () => {
      const rows = await db.$queryRaw<Array<{ id: string; sku: string; code: string | null; qty: string; cost: string | null; total: string | null; fromw: boolean; lsku: string | null; lcode: string | null; lreceived: string | null; lcost: string | null }>>`
        select m.id, upper(p.sku) as sku, upper(w.code) as code, m.qty::text as qty, m."unitCostBase"::text as cost, m."totalValueBase"::text as total, (m."fromWarehouseId" is not null) as fromw,
               upper(lp.sku) as lsku, upper(lw.code) as lcode, cl."receivedQty"::text as lreceived, cl."unitCostBase"::text as lcost
          from stock_movements m
          join products p on p.id = m."productId"
          left join warehouses w on w.id = m."toWarehouseId"
          left join cost_layers cl on cl.adjustment_movement_id = m.id
          left join products lp on lp.id = cl."productId"
          left join warehouses lw on lw.id = cl."warehouseId"
         where m.type = 'OPENING_STOCK'`
      const byId = new Map<string, StoredMovement>()
      for (const r of rows) {
        const m = byId.get(r.id) ?? { id: r.id, key: `${r.sku}|${r.code ?? ''}`, qty: new D(r.qty), cost: r.cost === null ? null : new D(r.cost), total: r.total === null ? null : new D(r.total), fromWarehouse: r.fromw, layers: [] }
        if (r.lreceived !== null && r.lcost !== null) m.layers.push({ key: `${r.lsku}|${r.lcode}`, received: new D(r.lreceived), cost: new D(r.lcost) })
        byId.set(r.id, m)
      }
      const others = (await db.$queryRaw<Array<{ n: string }>>`select count(*)::text as n from stock_movements where type <> 'OPENING_STOCK'`)[0]
      return openingMovementsItem({ file: fileStockPairs(prepared), movements: [...byId.values()], otherTypes: Number(num(others?.n)) })
    }))

    items.push(await guarded('stock-levels-equal-layers', 'every stock level equals the sum of its layers, nothing reserved', async () => {
      const bad = (await db.$queryRaw<Array<{ n: string }>>`
        select count(*)::text as n from (
          select coalesce(l."productId", c."productId") as p, coalesce(l."warehouseId", c."warehouseId") as w, coalesce(l.quantity, 0) as q, coalesce(l."reservedQty", 0) as r, coalesce(c.s, 0) as s
            from stock_levels l
            full join (select "productId", "warehouseId", sum("remainingQty") as s from cost_layers group by "productId", "warehouseId") c
              on c."productId" = l."productId" and c."warehouseId" = l."warehouseId") x
         where x.q <> x.s or x.r <> 0`)[0]
      const n = Number(num(bad?.n))
      return item('stock-levels-equal-layers', n === 0, 'every stock level equals the sum of its layers, nothing reserved', n === 0 ? 'equal everywhere' : `${n} pair(s) differ`)
    }))

    items.push(await guarded('invariants', 'no critical finding', async () => {
      const run = deps.runInvariants ?? (async () => {
        const { runInvariantCheckPreflight } = await import('@/lib/cron/invariant-check-preflight')
        const result = await runInvariantCheckPreflight()
        return { ok: result.ok, critical: result.result.summary.total.critical }
      })
      const result = await run()
      return item('invariants', result.ok && result.critical === 0, 'no critical finding', result.ok ? `${result.critical} critical finding(s)` : 'the check failed or reported critical findings')
    }))

    items.push(await guarded('bom-recipe-drift', 'no drift between the two recipe representations', async () => {
      const drift = await findBomRecipeDrift(db)
      return item('bom-recipe-drift', drift.length === 0, 'no drift between the two recipe representations', `${drift.length} drifting product(s)`)
    }))

    items.push(await guarded('purchase-orders-draft', 'the stored orders are exactly the file\'s, each a draft', async () => {
      const stored = await db.$queryRaw<Array<{ reference: string; status: string }>>`select reference, status::text as status from purchase_orders`
      const references = (prepared.steps.find((st) => st.step === 'purchase-orders')?.units ?? []).map((u) => u.key)
      return purchaseOrdersItem({ references, stored })
    }))

    items.push(await guarded('base-currency', `locked, ${SUPPORTED_BASE_CURRENCY}`, async () => {
      const locked = await isBaseCurrencyLocked()
      const code = await getBaseCurrencyCode()
      return item('base-currency', locked && code === SUPPORTED_BASE_CURRENCY && code === prepared.manifest.baseCurrency, `locked, ${SUPPORTED_BASE_CURRENCY}`, `${locked ? 'locked' : 'not locked'}, ${code === SUPPORTED_BASE_CURRENCY ? 'as declared' : 'a different currency'}`)
    }))

    items.push(await guarded('migrations-applied', 'the migration table is exactly the checkout\'s ordered list, all finished', async () => {
      const rows = (await db.$queryRaw<Array<{ name: string; finished: boolean; rolledback: boolean }>>`select migration_name as name, finished_at is not null as finished, rolled_back_at is not null as rolledback from _prisma_migrations order by started_at, migration_name`)
        .map((r) => ({ name: r.name, finished: r.finished, rolledBack: r.rolledback }))
      const problems = compareMigrations(deps.expectedMigrations, rows)
      return item('migrations-applied', problems.length === 0, `exactly ${deps.expectedMigrations.length} migration(s), by name, in order, all finished`, problems.length === 0 ? `${rows.length} migration(s), identical` : problems.join(', '))
    }))

    // No write may leave: the grant states in the installation's environment, and the producer-side counts, with exit 0 under --expect-held.
    items.push(await guarded('outbound-held', 'outbound status exits 0 with every destination held', async () => {
      const report = await buildOutboundStatusReport({ env: deps.outboundEnv })
      const code = outboundStatusExitCode(report, { expectHeld: true })
      return item('outbound-held', code === 0, 'outbound status exits 0 with every destination held', `exit ${code}`)
    }))

    // The census and the queue/held-write counts, against the baseline.
    let baseline: Baseline | null = null
    try {
      baseline = parseBaseline((await loadFacts())[BASELINE_FACT])
    } catch {
      baseline = null
    }
    try {
      items.push(...censusItems(baseline, await readNow()))
    } catch {
      items.push(...(['census-baseline', 'no-held-writes', 'no-queue-growth', 'write-census'] as const).map((id) => item(id, false, 'compared with the baseline', UNREADABLE)))
    }
    return items
  }
}

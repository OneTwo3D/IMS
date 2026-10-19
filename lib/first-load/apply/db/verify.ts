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
  accountingItem, censusItems, chainItem, fileStockTotals, item, parseBaseline, stockTotalsItem, type Baseline, type Reading, type StockTotals, type VerificationId,
} from '../verify-core'
import { loadFacts, setFactOnce } from './journal'
import { countMigrationDirectories } from './migrations'
import { observeStep } from './observe'
import { evaluateRails } from './rails'

export const BASELINE_FACT = 'baseline'
export { countMigrationDirectories }
const UNREADABLE = 'could not be read'
const TABLE_NAME = /^[A-Za-z0-9_]{1,63}$/

export interface VerifyDeps {
  /** The environment the outbound-write status is evaluated against: the installation's own variables, merged with this process's. A grant in it fails the verification. */
  outboundEnv: Record<string, string | undefined>
  /** What `_prisma_migrations` must hold (see countMigrationDirectories). */
  expectedMigrationCount: number
  /** Test seam: the scheduled invariant check. Default: the application's own, in process, writing nothing. */
  runInvariants?: () => Promise<{ ok: boolean; critical: number }>
}

/** Exact row count of every base table of the schema. */
export async function countAllTables(): Promise<Record<string, number>> {
  const names = (await db.$queryRaw<Array<{ table_name: string }>>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`).map((r) => r.table_name)
  if (names.length === 0 || names.some((n) => !TABLE_NAME.test(n))) throw new Error('the table list is empty or holds a name this reader does not trust')
  const rows = await db.$queryRawUnsafe<Array<{ t: string; n: string }>>(names.map((n) => `select '${n}' as t, count(*)::text as n from "${n}"`).join(' union all '))
  const out: Record<string, number> = {}
  for (const row of rows) out[row.t] = Number(row.n)
  if (Object.keys(out).length !== names.length) throw new Error('a table was not counted')
  return out
}

async function readNow(): Promise<Reading> {
  return { tables: await countAllTables(), heldWrites: await db.activityLog.count({ where: { action: OUTBOUND_HELD_ACTION } }) }
}

/** Record the starting counts once. Returns true when this call recorded them. The ports call it at the start of every step, after the rails passed. */
export async function captureBaseline(): Promise<boolean> {
  const now = await readNow()
  return setFactOnce(BASELINE_FACT, { tables: now.tables, heldWrites: now.heldWrites } satisfies Baseline)
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
    items.push(accountingItem(steps))
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

    // Stock: exact totals per warehouse and in total, against the file and the prepared report.
    items.push(await guarded('stock-totals', 'exact', async () => {
      const layers = await db.$queryRaw<Array<{ code: string; qty: string; value: string }>>`
        select upper(w.code) as code, sum(cl."receivedQty")::text as qty, sum(cl."receivedQty" * cl."unitCostBase")::text as value
          from cost_layers cl join warehouses w on w.id = cl."warehouseId" where cl."isOpeningStock" group by upper(w.code)`
      const other = await db.$queryRaw<Array<{ n: string }>>`select count(*)::text as n from cost_layers where not "isOpeningStock"`
      const database = new Map<string, StockTotals>(layers.map((l) => [l.code, { qty: new D(l.qty), value: new D(l.value) }]))
      const totals = (prepared.report as unknown as { stock?: { totals?: { openingQty?: string; openingValueBase?: string } } }).stock?.totals
      // No opening-stock step selected: the prepared report's totals do not apply to this load, and the database must hold no opening layer at all.
      const selected = prepared.steps.some((s) => s.step === 'opening-stock')
      const report = !selected ? { qty: '0', value: '0' } : totals?.openingQty !== undefined && totals.openingValueBase !== undefined ? { qty: totals.openingQty, value: totals.openingValueBase } : null
      return stockTotalsItem({ file: fileStockTotals(prepared), database, report, nonOpeningLayers: Number(num(other[0]?.n)) })
    }))

    items.push(await guarded('opening-movements', 'one movement per opening layer, nothing else', async () => {
      const file = fileStockTotals(prepared)
      const pairs = prepared.steps.find((s) => s.step === 'opening-stock')?.units.length ?? 0
      const fileQty = [...file.values()].reduce((t, v) => t.add(v.qty), new D(0))
      const opening = (await db.$queryRaw<Array<{ n: string; qty: string }>>`select count(*)::text as n, coalesce(sum(qty), 0)::text as qty from stock_movements where type = 'OPENING_STOCK'`)[0]
      const others = (await db.$queryRaw<Array<{ n: string }>>`select count(*)::text as n from stock_movements where type <> 'OPENING_STOCK'`)[0]
      const ok = Number(num(opening?.n)) === pairs && new D(num(opening?.qty)).eq(fileQty) && Number(num(others?.n)) === 0
      return item('opening-movements', ok, 'one movement per opening layer, nothing else', ok ? `${pairs} movement(s), all opening` : 'the movements differ from the opening layers')
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

    items.push(await guarded('purchase-orders-draft', 'every loaded order is a draft', async () => {
      const row = (await db.$queryRaw<Array<{ total: string; notDraft: string }>>`select count(*)::text as total, count(*) filter (where status <> 'DRAFT')::text as "notDraft" from purchase_orders`)[0]
      const orders = prepared.steps.find((s) => s.step === 'purchase-orders')?.units.length ?? 0
      const ok = Number(num(row?.notDraft)) === 0 && Number(num(row?.total)) === orders
      return item('purchase-orders-draft', ok, 'every loaded order is a draft, and there are as many as the file has', ok ? `${orders} draft order(s)` : 'the orders differ from the file or one is not a draft')
    }))

    items.push(await guarded('base-currency', `locked, ${SUPPORTED_BASE_CURRENCY}`, async () => {
      const locked = await isBaseCurrencyLocked()
      const code = await getBaseCurrencyCode()
      return item('base-currency', locked && code === SUPPORTED_BASE_CURRENCY && code === prepared.manifest.baseCurrency, `locked, ${SUPPORTED_BASE_CURRENCY}`, `${locked ? 'locked' : 'not locked'}, ${code === SUPPORTED_BASE_CURRENCY ? 'as declared' : 'a different currency'}`)
    }))

    items.push(await guarded('migrations-applied', 'every migration of this checkout finished', async () => {
      const row = (await db.$queryRaw<Array<{ total: string; open: string }>>`select count(*)::text as total, count(*) filter (where finished_at is null or rolled_back_at is not null)::text as open from _prisma_migrations`)[0]
      const total = Number(num(row?.total))
      const open = Number(num(row?.open))
      const ok = open === 0 && total === deps.expectedMigrationCount
      return item('migrations-applied', ok, `${deps.expectedMigrationCount} finished migration(s)`, `${total} recorded, ${open} unfinished or rolled back`)
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

import { db } from '@/lib/db'
import { readMintsoftProductParityEnabled, MINTSOFT_PRODUCT_PARITY_SETTING } from '../settings/product-parity'
import {
  parseCooCsv,
  parseTradeCsv,
  planBulkChange,
  renderBulkPlan,
  summariseBulkPlan,
  type BulkChange,
  type BulkKind,
  type BulkPlanRow,
  type BulkProductState,
  type BulkRejected,
} from './bulk-product-data'

/**
 * RUNS THE BULK TRADE-DATA / COUNTRY-OF-ORIGIN TOOLS (o3d-zvec.20): parse, plan, and only then, if asked AND allowed, apply.
 *
 *   dry run (default)   reads the products and their stored Mintsoft records, prints the comparison. WRITES NOTHING, and makes no
 *                       call to Mintsoft.
 *   apply               needs BOTH the explicit `apply: true` AND `mintsoft_product_parity_enabled`. Without the setting it refuses
 *                       before the first write. Each product is a compare-and-set on the values the plan was built from, so a
 *                       product edited since is skipped (and reported), never overwritten.
 *
 * Never run against a live database by an agent; the owner runs `apply`.
 */

export type BulkDeps = {
  parityEnabled: () => Promise<boolean>
  loadStates: (skus: string[]) => Promise<Map<string, BulkProductState>>
  /** Compare-and-set one product. Returns false when the product no longer holds the values the plan saw. */
  applyOne: (row: BulkPlanRow, changes: BulkChange[], expected: BulkProductState) => Promise<boolean>
}

export type BulkRunResult = {
  kind: BulkKind
  mode: 'dry-run' | 'apply'
  plan: BulkPlanRow[]
  rejected: BulkRejected[]
  applied: number
  skippedChanged: string[]
  report: string
}

export class BulkApplyRefusedError extends Error {}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStored(metadata: unknown): BulkProductState['stored'] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const raw = metadata as Record<string, unknown>
  const code = (value: unknown) => (value && typeof value === 'object' ? optionalString((value as Record<string, unknown>).Code) : optionalString(value))
  return {
    commodityCode: code(raw.CommodityCode),
    customsDescription: optionalString(raw.CustomsDescription),
    countryOfManufacture: code(raw.CountryOfManufacture),
  }
}

export const defaultBulkDeps: BulkDeps = {
  parityEnabled: () => readMintsoftProductParityEnabled(),
  async loadStates(skus) {
    const rows = await db.product.findMany({
      where: { sku: { in: skus } },
      select: {
        id: true, sku: true, hsCode: true, customsDescription: true, countryOfOrigin: true,
        wmsProductLinks: { where: { connector: 'mintsoft' }, select: { metadata: true }, take: 1 },
      },
    })
    return new Map(rows.map((row) => [row.sku, {
      id: row.id, sku: row.sku, hsCode: row.hsCode, customsDescription: row.customsDescription, countryOfOrigin: row.countryOfOrigin,
      stored: readStored(row.wmsProductLinks[0]?.metadata),
    } satisfies BulkProductState]))
  },
  async applyOne(row, changes, expected) {
    const data: Record<string, string> = {}
    for (const change of changes) data[change.field] = change.to
    const result = await db.product.updateMany({
      where: { id: row.productId!, hsCode: expected.hsCode, customsDescription: expected.customsDescription, countryOfOrigin: expected.countryOfOrigin },
      data,
    })
    return result.count === 1
  },
}

export async function runBulkProductData(
  input: { kind: BulkKind; csvText: string; apply: boolean; limit?: number },
  deps: BulkDeps = defaultBulkDeps,
): Promise<BulkRunResult> {
  // The refusal comes first: an apply that is not allowed must not even read the products.
  if (input.apply && !(await deps.parityEnabled())) {
    throw new BulkApplyRefusedError(`Refusing to apply: the setting ${MINTSOFT_PRODUCT_PARITY_SETTING} is not 'true'. Nothing was read or written.`)
  }
  const parsed = input.kind === 'trade' ? parseTradeCsv(input.csvText) : parseCooCsv(input.csvText)
  const rows = input.limit && input.limit > 0 ? parsed.rows.slice(0, input.limit) : parsed.rows
  const states = rows.length > 0 ? await deps.loadStates(rows.map((row) => row.sku)) : new Map<string, BulkProductState>()
  const plan = planBulkChange(input.kind, rows, states)

  let applied = 0
  const skippedChanged: string[] = []
  if (input.apply) {
    for (const row of plan) {
      if (row.action !== 'would_update') continue
      const ok = await deps.applyOne(row, row.changes, states.get(row.sku)!)
      if (ok) applied += 1
      else skippedChanged.push(row.sku)
    }
  }
  const mode = input.apply ? 'apply' : 'dry-run'
  let report = renderBulkPlan(input.kind, plan, parsed.rejected, mode)
  if (input.apply) {
    report += `\napplied: ${applied}  skipped (changed since the plan): ${skippedChanged.length}${skippedChanged.length ? ` [${skippedChanged.join(', ')}]` : ''}`
    report += '\nValues are on the IMS products; the next Mintsoft product sync sends them through its guarded writer.'
  } else {
    report += `\nNothing was written (${summariseBulkPlan(plan, parsed.rejected).would_update} product(s) would change). Re-run with --apply, with ${MINTSOFT_PRODUCT_PARITY_SETTING}=true, to write them onto the IMS products.`
  }
  return { kind: input.kind, mode, plan, rejected: parsed.rejected, applied, skippedChanged, report }
}

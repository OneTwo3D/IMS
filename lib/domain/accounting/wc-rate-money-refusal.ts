/**
 * A TAX RATE THAT MOVED MONEY MUST BE ONE IMS KNOWS AND HAS SWITCHED ON.
 *
 * Two ways the importer used to carry on past a rate it should have stopped at:
 *
 *   - UNMAPPED. WooCommerce named a rate id IMS has no mapping for, and `resolveWcTaxRateById` substituted the
 *     default rate (logging a warning). A substitution is only acceptable where it changes nothing; the
 *     reconciliation catches a substitute that charges a DIFFERENT percentage, but a substitute at the same
 *     percentage posts under the wrong accounting tax type without a murmur, and a 0% fallback passes
 *     `shouldBlockWcTaxRateFallback` outright.
 *   - INACTIVE. The mapping points at an IMS rate that has been switched off, and the resolver returned it
 *     as an ordinary `mapped` rate because it never looked at `active`. A rate someone retired - or one that
 *     was never meant to post - was posting.
 *
 * "MOVED MONEY" is: a line (item, shipping or fee) that names the rate carries a non-zero net amount or a
 * non-zero tax on it, or the order's own `tax_lines` records non-zero tax under the rate. A rate named only
 * on a zero-value line moved nothing and is not refused. The refusal is stamped on the document exactly as a
 * non-reconciling document is (`_taxUnreconciled`), so it is refused at the poster with a failed sync row on
 * /sync, not dropped.
 *
 * Pure: no database, no network. Money arrives as the strings WooCommerce sends.
 */

import type { WcFullOrder } from '@/lib/connectors/woocommerce/sync/types'

/** What the resolver reported for one WooCommerce rate id, reduced to what this decision needs. */
export type WcRateResolution = {
  source?: 'mapped' | 'default'
  taxRateName?: string | null
  /** The IMS rate's `active` flag. Only an explicit `false` counts as inactive. */
  active?: boolean
}

export type WcRateMoneyUse = {
  wcRateId: number
  /** Where the rate was named, for the message: `line item "Widget"`, `shipping`, `fee "Duty"`, `tax_lines`. */
  where: string[]
}

function nonZero(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  const n = Number(value)
  return Number.isFinite(n) && n !== 0
}

/** Every rate id the order named on something that carried money, with where. Deterministic order: by id. */
export function wcRatesThatMovedMoney(order: Pick<WcFullOrder, 'line_items' | 'shipping_lines' | 'fee_lines' | 'tax_lines'>): WcRateMoneyUse[] {
  const uses = new Map<number, Set<string>>()
  const note = (id: unknown, where: string) => {
    if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return
    if (!uses.has(id)) uses.set(id, new Set())
    uses.get(id)!.add(where)
  }
  for (const item of order.line_items ?? []) {
    for (const tax of item.taxes ?? []) {
      if (nonZero(item.total) || nonZero(item.subtotal) || nonZero(tax.total) || nonZero(tax.subtotal)) note(tax.id, `line item "${item.name}"`)
    }
  }
  for (const ship of order.shipping_lines ?? []) {
    for (const tax of ship.taxes ?? []) {
      if (nonZero(ship.total) || nonZero(tax.total)) note(tax.id, 'shipping')
    }
  }
  for (const fee of order.fee_lines ?? []) {
    for (const tax of fee.taxes ?? []) {
      if (nonZero(fee.total) || nonZero(tax.total)) note(tax.id, `fee "${fee.name}"`)
    }
  }
  for (const line of order.tax_lines ?? []) {
    if (nonZero(line.tax_total) || nonZero(line.shipping_tax_total)) note(line.rate_id, 'tax_lines')
  }
  return [...uses.entries()].sort((a, b) => a[0] - b[0]).map(([wcRateId, where]) => ({ wcRateId, where: [...where] }))
}

export type WcRateMoneyProblem = {
  wcRateId: number
  kind: 'unmapped' | 'inactive'
  where: string[]
  /** The IMS rate name, for an inactive mapping. */
  taxRateName: string | null
}

/**
 * The rates the order moved money on that IMS cannot post under: no mapping, or a mapping to an inactive rate.
 * `resolved` is keyed by WooCommerce rate id. An id the importer never resolved is treated as unmapped.
 */
export function findWcRateMoneyProblems(
  order: Pick<WcFullOrder, 'line_items' | 'shipping_lines' | 'fee_lines' | 'tax_lines'>,
  resolved: ReadonlyMap<number, WcRateResolution>,
): WcRateMoneyProblem[] {
  const problems: WcRateMoneyProblem[] = []
  for (const use of wcRatesThatMovedMoney(order)) {
    const r = resolved.get(use.wcRateId)
    if (!r || r.source !== 'mapped') {
      problems.push({ wcRateId: use.wcRateId, kind: 'unmapped', where: use.where, taxRateName: null })
    } else if (r.active === false) {
      problems.push({ wcRateId: use.wcRateId, kind: 'inactive', where: use.where, taxRateName: r.taxRateName ?? null })
    }
  }
  return problems
}

/** The operator-facing sentence for a set of problems, or `null` for none. */
export function describeWcRateMoneyRefusal(orderNumber: string, problems: ReadonlyArray<WcRateMoneyProblem>): string | null {
  if (problems.length === 0) return null
  const parts = problems.map((p) =>
    p.kind === 'unmapped'
      ? `WooCommerce tax rate ${p.wcRateId} (on ${p.where.join(', ')}) has no mapping to an IMS tax rate`
      : `WooCommerce tax rate ${p.wcRateId} (on ${p.where.join(', ')}) is mapped to the IMS tax rate "${p.taxRateName ?? 'unnamed'}", which is INACTIVE`,
  )
  return (
    `Order ${orderNumber} moved money on a tax rate IMS cannot post under: ${parts.join('; ')}. `
    + `IMS will not guess a tax type for it or substitute the default. Map the rate to an ACTIVE IMS tax rate that carries a real accounting tax type, then re-import the order.`
  )
}

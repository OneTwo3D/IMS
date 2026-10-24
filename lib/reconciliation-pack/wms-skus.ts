/**
 * R14's LEG FOR THE 3PL'S WAREHOUSE SYSTEM: the SKU list of the proven product census (wms-source.ts), as a coverage-items `SkuListPort`.
 *
 * There is no second reader. The census is the one R1 reads (double scan, clamped page limit, short last page proven by the empty page after
 * it, no repeated id or SKU, and containment against the stock lists of the bound warehouses), through the same read-only reader behind
 * --vendor-reads-only, and it is read AT MOST ONCE per run: the run's `WmsReadSession` hands R14 the very result R1 got (a success, or the
 * same closed reason), so R14 adds no request to what R1 makes. The warehouses are the ones R1 reads (the in-population bindings,
 * classified by R1's own rule); when there are none, no stock was read, and the census alone is read once (without containment, as
 * wms-source.ts says).
 *
 * BUNDLES. The census says whether a product is a bundle. R14 treats kits and bundles like every other product on every other leg (a KIT or
 * BOM is a product its system must hold, and the storefront and Qoblex lists carry them), so a warehouse-system bundle is KEPT in the list: its
 * SKU counts as present, and its absence is a finding unless a written exclusion covers that SKU in that system.
 *
 * A failure of the source (an auth mode the reader refuses, an unstable list, a cap, a login it will not make) is the leg's own closed reason
 * (R14 then reports LEG_UNAVAILABLE beside it and cannot pass); nothing is retried.
 */

import { classifyWmsBindings } from '@/lib/reconciliation-pack/wms-items'
import type { SkuListPort } from '@/lib/reconciliation-pack/coverage-items'
import type { ImsRead, ImsReadOptions, WmsBindingRow } from '@/lib/reconciliation-pack/ims-readers'
import type { WmsReadSession } from '@/lib/reconciliation-pack/wms-source'

export function wmsSkuListPort(deps: { session: WmsReadSession; ims: (options: ImsReadOptions) => Promise<ImsRead> }): SkuListPort {
  return async () => {
    const read = await deps.ims({ sections: ['wmsBindings'] })
    if (!read.ok) return { ok: false, reason: read.reason }
    const section = read.sections.wmsBindings
    if (section === undefined) return { ok: false, reason: 'SOURCE_UNREADABLE' }
    if (!section.ok) return { ok: false, reason: section.reason }
    const classified = classifyWmsBindings(section.value as WmsBindingRow[])
    if (classified === null) return { ok: false, reason: 'SOURCE_UNREADABLE' }
    const ids = classified.inPopulation.map((binding) => binding.externalWarehouseId)
    const census = ids.length > 0
      ? await deps.session.read(ids).then((result) => (result.ok ? { ok: true as const, value: result.value.census } : result))
      : await deps.session.census()
    if (!census.ok) return { ok: false, reason: census.reason }
    return { ok: true, skus: census.value.map((row) => row.sku) }
  }
}

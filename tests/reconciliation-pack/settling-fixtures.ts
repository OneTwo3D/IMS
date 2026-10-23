import { differenceSignature, type CarriedDifference, type DifferenceKind } from '../../lib/reconciliation-pack/compare.ts'
import type { ItemInput } from '../../lib/reconciliation-pack/report.ts'
import type { ImsRead } from '../../lib/reconciliation-pack/ims-readers.ts'
import { runVendorItem, type VendorItemContext } from '../../lib/reconciliation-pack/vendor-items.ts'
import { fakeStore, noSleep, order } from './woo-fixtures.ts'

/** Distinct stream stamps. Their order means nothing to the code under test (it compares them for equality only). */
export const S1 = '2026-10-01T00:00:00.000Z'
export const S2 = '2026-10-02T00:00:00.000Z'
export const S3 = '2026-10-03T00:00:00.000Z'
export const S4 = '2026-10-04T00:00:00.000Z'

type EntryLike = { key: string; ims: string | null; vendor: string | null; imsCurrency?: string | null; vendorCurrency?: string | null; imsPresent?: boolean; vendorPresent?: boolean; settling?: { sequence?: number | null; first: string; later: string[] } }

/** The state a run hands the next one, read off an item result the way the report chain would give it back (kind from the bucket or the presence flags; a difference first seen in this result was first seen in the report it is published as). */
export function carryFrom(item: ItemInput, publishedAs = 1): Map<string, CarriedDifference> {
  const out = new Map<string, CarriedDifference>()
  const entries = item.entries ?? {}
  for (const bucket of ['onlyIms', 'onlyVendor', 'bothDiffer', 'unsettled'] as const) {
    for (const entry of (entries[bucket] ?? []) as readonly EntryLike[]) {
      if (!entry.settling) continue
      const kind: DifferenceKind = bucket === 'unsettled' ? (entry.ims !== null && entry.vendor === null ? 'onlyIms' : entry.ims === null && entry.vendor !== null ? 'onlyVendor' : 'bothDiffer') : bucket
      out.set(entry.key, { kind, signature: differenceSignature(kind, { ims: entry.ims, vendor: entry.vendor, imsCurrency: entry.imsCurrency ?? null, vendorCurrency: entry.vendorCurrency ?? null }), sequence: entry.settling.sequence ?? publishedAs, first: entry.settling.first, later: [...entry.settling.later] })
    }
  }
  return out
}

/** One R9 run under a given carried state and stream stamp. */
export function runR9Once(context: VendorItemContext, carried: ReadonlyMap<string, CarriedDifference>, stamp: string | null, usable = true): Promise<ItemInput> {
  return runVendorItem('R9', { ...context, settling: { carried, usable, stamp } })
}

/** R9 as the older tests read it: runs until nothing is unsettled (at most three runs, on three distinct stamps) and returns the last result. */
export async function runR9(_id: 'R9' | undefined, context: VendorItemContext): Promise<ItemInput> {
  let carried: ReadonlyMap<string, CarriedDifference> = new Map()
  let last: ItemInput | null = null
  for (const stamp of [S1, S2, S3]) {
    last = await runR9Once(context, carried, stamp)
    if ((last.entries?.unsettled ?? []).length === 0) return last
    carried = carryFrom(last)
  }
  return last!
}

// ---- an R9 context over doubles of the IMS read and of the store ------------------------------------------------------------------

const cuid = (n: number) => `c${String(n).padStart(24, '0')}`
const WITHDRAWAL = { submitted: 'pending-wdraw', approved: 'withdrawn' }

export type ImsOrderSpec = { n: number; wooId: string; total?: string }
export type StoreOrderSpec = { id: number; total?: string }

/** IMS holds `ims`; the store holds `store` (all in processing). Both sides GBP. */
export function r9Context(ims: readonly ImsOrderSpec[], store: readonly StoreOrderSpec[]): VendorItemContext {
  const woo = fakeStore({ orders: { processing: store.map((s) => order(s.id, 'processing', s.total ? { total: s.total } : {})) } })
  return {
    asOf: '2026-10-19',
    vendorReads: true,
    vendor: { woo },
    wooOptions: { sleep: noSleep },
    ims: async (options): Promise<ImsRead> => {
      const values: Record<string, unknown> = {
        orders: ims.map((o) => ({ id: cuid(o.n), status: 'PROCESSING', currency: 'GBP', totalForeign: o.total ?? '12.50', externalCreatedAt: '2026-10-10T09:30:00.000Z', externalUpdatedAt: null, links: [{ connector: 'woocommerce', externalOrderId: o.wooId }] })),
        storefrontStatus: { configured: ['processing'], withdrawal: WITHDRAWAL, mappings: [] },
      }
      const sections: Record<string, unknown> = {}
      for (const name of options.sections) sections[name] = { ok: true, value: values[name] }
      return { ok: true, snapshotId: '1:2:', sections } as ImsRead
    },
  }
}

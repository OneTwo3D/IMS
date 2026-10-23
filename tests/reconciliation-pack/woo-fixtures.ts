import type { WooCollection } from '../../lib/reconciliation-pack/constants.ts'
import type { WooGetPort, WooPage } from '../../lib/reconciliation-pack/woo-source.ts'

export type Call = { collection: WooCollection; params: Record<string, string> }
type Row = Record<string, unknown>
export type StoreData = { orders?: Record<string, Row[]>; products?: Row[]; taxes?: Row[] }
/** Lets a test alter one response (call number counts from 1). Return undefined to keep it. */
export type Tweak = (call: Call, n: number, page: Extract<WooPage, { ok: true }>) => WooPage | Promise<WooPage> | undefined

export const order = (id: number, status = 'processing', over: Row = {}): Row => ({ id, status, currency: 'GBP', total: '12.50', date_created_gmt: '2026-10-10T09:30:00', ...over })

/** A faithful store: pages of per_page rows in the order asked for, X-WP-Total and X-WP-TotalPages as WordPress sends them. */
export function fakeStore(data: StoreData, tweak?: Tweak): WooGetPort & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async get(collection, params): Promise<WooPage> {
      calls.push({ collection, params: { ...params } })
      const all: Row[] = collection === 'orders' ? (data.orders?.[params.status ?? ''] ?? []) : collection === 'products' ? (data.products ?? []) : (data.taxes ?? [])
      const sorted = [...all].sort((a, b) => Number(a.id) - Number(b.id))
      const perPage = Number(params.per_page)
      const page = Number(params.page)
      const slice = sorted.slice((page - 1) * perPage, page * perPage)
      const ok: Extract<WooPage, { ok: true }> = { ok: true, status: 200, total: String(sorted.length), totalPages: String(Math.ceil(sorted.length / perPage)), body: slice.map((r) => ({ ...r })) }
      return (await tweak?.(calls.at(-1)!, calls.length, ok)) ?? ok
    },
  }
}
export const noSleep = async (): Promise<void> => undefined
export const many = (n: number, from = 1, status = 'processing'): Row[] => Array.from({ length: n }, (_, i) => order(from + i, status))

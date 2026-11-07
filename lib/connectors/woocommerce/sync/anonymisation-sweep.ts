/**
 * THE ERASURE BACKSTOP: find WooCommerce orders that carry the anonymisation marker and that IMS already HOLDS, and mirror them.
 *
 * WHY IT EXISTS. The webhook is the primary channel and never filters an order IMS holds by status. The pull sweeps, though, ask WooCommerce
 * for `?status=<the operator's selection>`, and WooCommerce cannot filter on order meta, so a held order that sits in an unticked status
 * (cancelled, refunded, a custom archive status) is invisible to them. If its webhook was missed, nothing else would ever hear about the
 * anonymisation. This pass reads `status=any` instead.
 *
 * WHAT IT IS NOT. It creates nothing and imports nothing: an order that is not marked, not held, or already erased is discarded unprocessed
 * (no queue row, no refusal record), and a marked held order is only ERASED (mirrorWcAnonymisation). That is why it runs even when the
 * operator's status selection is EMPTY: the empty-selection rule ("import nothing") exists so an empty list can never create orders, and
 * this pass cannot. It is GET-only, goes through the same `wcFetch` (the one request limiter and retry policy), runs inside the existing
 * reconcile cadence (reconcile and manual_reconcile; never the frequent poll), is paged, and persists its own cursor only after a page has
 * been fully processed, so a failure resumes on the same page.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch, MAX_WC_PAGE_WALK_PAGES } from '../api'
import type { WcFullOrder } from './types'
import { isWcOrderAnonymised } from './anonymisation'
import { mirrorWcAnonymisation } from './anonymisation-mirror'
import { retireWcErasureObligation } from './erasure-obligation'

export const WC_ERASURE_SWEEP_CURSOR_KEY = 'wc_erasure_sweep_cursor'
/** The cursor is re-read from one second earlier so orders sharing the page boundary's modified second are not missed (mirroring is idempotent). */
const OVERLAP_MS = 1000

export type WcErasureSweepResult = { pages: number; scanned: number; markedHeld: number; mirrored: number; alreadyErased: number; errors: string[] }

function parseGmt(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`)
  return Number.isFinite(ms) ? ms : null
}

export async function sweepWcAnonymisedOrders(): Promise<WcErasureSweepResult> {
  const result: WcErasureSweepResult = { pages: 0, scanned: 0, markedHeld: 0, mirrored: 0, alreadyErased: 0, errors: [] }
  const initial = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initial?.value !== 'true') return result // nothing is held before the initial import
  const cursorSetting = await db.setting.findUnique({ where: { key: WC_ERASURE_SWEEP_CURSOR_KEY } })
  const cursorMs = cursorSetting?.value ? Date.parse(cursorSetting.value) : NaN
  const startMs = Number.isFinite(cursorMs) ? cursorMs : null

  for (let page = 1; page <= MAX_WC_PAGE_WALK_PAGES; page += 1) {
    const params: Record<string, string> = { status: 'any', per_page: '100', page: String(page), orderby: 'modified', order: 'asc' }
    if (startMs !== null) params.modified_after = new Date(startMs - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, '')
    const { data, error } = await wcFetch('/orders', params)
    if (error) { result.errors.push(`erasure sweep page ${page}: ${error}`); break }
    const orders = (Array.isArray(data) ? data : []) as WcFullOrder[]
    if (orders.length === 0) break
    result.pages += 1
    let pageMaxMs = startMs ?? 0
    for (const order of orders) {
      result.scanned += 1
      const modified = parseGmt(order.date_modified_gmt)
      if (modified !== null && modified > pageMaxMs) pageMaxMs = modified
      if (!isWcOrderAnonymised(order)) continue
      const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(order.id) }, select: { orderId: true } })
      if (!link) continue
      result.markedHeld += 1
      try {
        const mirrored = await mirrorWcAnonymisation(link.orderId)
        await retireWcErasureObligation(order.id)
        if (mirrored.erasedNow) result.mirrored += 1
        else result.alreadyErased += 1
      } catch {
        // Fixed text: the underlying error can echo the values being written. The page is NOT complete, so the cursor stays and the next run re-reads it.
        result.errors.push(`erasure sweep: could not mirror the anonymisation of storefront order ${order.id}`)
      }
    }
    // The cursor moves only after EVERY order on the page was processed.
    if (result.errors.length > 0) break
    if (pageMaxMs > 0) {
      await db.setting.upsert({ where: { key: WC_ERASURE_SWEEP_CURSOR_KEY }, create: { key: WC_ERASURE_SWEEP_CURSOR_KEY, value: new Date(pageMaxMs).toISOString() }, update: { value: new Date(pageMaxMs).toISOString() } })
    }
  }

  await logActivity({
    entityType: 'SYNC',
    action: 'wc_anonymisation_sweep',
    tag: 'sync',
    level: result.errors.length > 0 ? 'WARNING' : 'INFO',
    description: `WooCommerce anonymisation sweep: ${result.scanned} orders read in ${result.pages} pages, ${result.markedHeld} anonymised and held, ${result.mirrored} erased now, ${result.alreadyErased} already erased, ${result.errors.length} errors`,
    metadata: { ...result, errors: result.errors.length },
    resolveUser: false,
  })
  return result
}

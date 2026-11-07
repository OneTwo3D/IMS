/**
 * THE ERASURE BACKSTOP: find WooCommerce orders that carry the anonymisation marker and make IMS agree, whatever status they sit in.
 *
 * WHY IT EXISTS. The webhook is the primary channel and never filters an order IMS holds by status. The pull sweeps, though, ask WooCommerce
 * for `?status=<the operator's selection>`, and WooCommerce cannot filter on order meta, so a held order that sits in an unticked status
 * (cancelled, refunded, a custom archive status) is invisible to them. If its webhook was missed, nothing else would ever hear about the
 * anonymisation. This pass reads `status=any` instead.
 *
 * WHAT IT DOES TO A MARKED ORDER, always UNDER THE FIRST-IMPORT LOCK (never on an unlocked "is there an order?" read):
 *   held     -> the order-first erase, and the open erasure obligation (if any) retired;
 *   not held -> the durable erasure obligation is recorded, so an older identifiable read of that order that an import still holds is created
 *               ALREADY ERASED (the same helper the webhook routes use).
 * It creates and imports nothing, so it runs whatever the operator's status selection is, empty included: the empty-selection rule ("import
 * nothing") exists so an empty list can never create orders, and this pass cannot. Everything else it reads (unmarked orders) is discarded.
 *
 * REQUESTS. GET only, through the same `wcFetch` (the one limiter and retry policy), inside the reconcile cadence (reconcile and
 * manual_reconcile; never the frequent poll), run AFTER the reconcile's own order, product and stock steps, with a small per-run BUDGET (pages
 * and wall time). Progress is persisted, so a budget stop or an error resumes where it left off.
 *
 * PAGING IS BY TIMESTAMP (keyset), NOT BY OFFSET. Offset pages over orders sorted by a time that is itself rewritten by every edit can skip an
 * order that shifts between page reads (Codex R1). So every request is `page=1` of `modified_after = <cursor minus an overlap>` ordered by
 * modified ascending, and the cursor moves to the last order's modified time minus the overlap after each fully processed page. An order
 * modified mid-run moves to a LATER modified time, beyond the cursor, and is seen later; the overlap re-reads the boundary, and processing is
 * idempotent (an erased order is a no-op, the obligation is an upsert), so a re-read costs nothing but a request.
 *   A page that makes no progress by timestamp (a block of orders larger than a page sharing one modified second) is read by offset INSIDE
 *   that one window (modified_after = ts - overlap, modified_before = ts + overlap), page 2, 3, ..., TWICE through (a second pass catches an
 *   order that shifted during the first), and only then does the cursor move past the window.
 *
 * TIME. Every request sets `dates_are_gmt=true`, so WooCommerce compares `modified_after` / `modified_before` against the GMT modified time
 * (post_modified_gmt); without it the comparison is against the SITE-LOCAL time and a site east of UTC would be read an hour wrong. The values
 * are sent as GMT without a zone suffix, and every timestamp read back is `date_modified_gmt` (parsed as UTC), so the cursor, the request and the
 * comparison all speak GMT.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import type { WcFullOrder } from './types'
import { isWcOrderAnonymised } from './anonymisation'
import { mirrorWcAnonymisationIfHeld } from './anonymisation-mirror'

export const WC_ERASURE_SWEEP_CURSOR_KEY = 'wc_erasure_sweep_cursor'
export const WC_ERASURE_SWEEP_LAST_RUN_KEY = 'wc_erasure_sweep_last_run_at'
export const WC_ERASURE_SWEEP_BACKLOG_KEY = 'wc_erasure_sweep_backlog'
/** Once a day when caught up (the order reconcile's own cadence); every cron tick while a budget stop left work to resume. */
export const WC_ERASURE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** The overlap between one request's lower bound and the last order read, so orders sharing a boundary second are re-read, not missed. */
export const WC_ERASURE_SWEEP_OVERLAP_MS = 2000
export const WC_ERASURE_SWEEP_PER_PAGE = 100
/** The per-run budget. A run that reaches either stops cleanly and resumes from the persisted cursor on the next reconcile. */
export const WC_ERASURE_SWEEP_MAX_PAGES = 5
export const WC_ERASURE_SWEEP_MAX_MS = 60_000

export type WcErasureSweepResult = {
  pages: number
  scanned: number
  /** Marked orders IMS held: the order-first erase ran (or was already done). */
  markedHeld: number
  mirrored: number
  alreadyErased: number
  /** Marked orders IMS did not hold: the erasure obligation was recorded. */
  obligationsRecorded: number
  /** True when the run stopped on its budget with more to read. */
  budgetStop: boolean
  errors: string[]
}

type State = { after: string | null; window?: { ts: string; pass: 1 | 2; page: number } }

function parseGmt(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`)
  return Number.isFinite(ms) ? ms : null
}

/** GMT, second precision, no zone suffix: what WooCommerce reads with dates_are_gmt=true. */
function gmtParam(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '')
}

async function loadState(): Promise<State> {
  const row = await db.setting.findUnique({ where: { key: WC_ERASURE_SWEEP_CURSOR_KEY } })
  if (!row?.value) return { after: null }
  try {
    const parsed = JSON.parse(row.value) as State
    if (parsed && typeof parsed === 'object' && (parsed.after === null || typeof parsed.after === 'string')) return parsed
  } catch { /* a bare ISO timestamp (an earlier shape of this setting) */ }
  const ms = parseGmt(row.value)
  return { after: ms === null ? null : new Date(ms - WC_ERASURE_SWEEP_OVERLAP_MS).toISOString() }
}

async function saveState(state: State): Promise<void> {
  const value = JSON.stringify(state)
  await db.setting.upsert({ where: { key: WC_ERASURE_SWEEP_CURSOR_KEY }, create: { key: WC_ERASURE_SWEEP_CURSOR_KEY, value }, update: { value } })
}

export async function sweepWcAnonymisedOrders(
  options: { maxPages?: number; maxMs?: number; now?: () => number } = {},
): Promise<WcErasureSweepResult> {
  const maxPages = options.maxPages ?? WC_ERASURE_SWEEP_MAX_PAGES
  const maxMs = options.maxMs ?? WC_ERASURE_SWEEP_MAX_MS
  const now = options.now ?? Date.now
  const startedAt = now()
  const result: WcErasureSweepResult = { pages: 0, scanned: 0, markedHeld: 0, mirrored: 0, alreadyErased: 0, obligationsRecorded: 0, budgetStop: false, errors: [] }
  const initial = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (initial?.value !== 'true') return result // nothing is held before the initial import

  let state = await loadState()
  const seen = new Set<number>()
  let caughtUp = false

  while (!caughtUp) {
    if (result.pages >= maxPages || now() - startedAt >= maxMs) { result.budgetStop = true; break }
    const params: Record<string, string> = {
      status: 'any', per_page: String(WC_ERASURE_SWEEP_PER_PAGE), orderby: 'modified', order: 'asc', dates_are_gmt: 'true',
    }
    if (state.window) {
      const ts = Date.parse(state.window.ts)
      params.modified_after = gmtParam(ts - WC_ERASURE_SWEEP_OVERLAP_MS)
      params.modified_before = gmtParam(ts + WC_ERASURE_SWEEP_OVERLAP_MS)
      params.page = String(state.window.page)
    } else {
      if (state.after) params.modified_after = gmtParam(Date.parse(state.after))
      params.page = '1'
    }
    const { data, error } = await wcFetch('/orders', params)
    if (error) { result.errors.push(`erasure sweep: read failed (${error})`); break }
    const orders = (Array.isArray(data) ? data : []) as WcFullOrder[]
    result.pages += 1

    let lastMod: number | null = null
    let failed = false
    for (const order of orders) {
      const modified = parseGmt(order.date_modified_gmt)
      if (modified !== null) lastMod = modified
      if (seen.has(order.id)) continue
      seen.add(order.id)
      result.scanned += 1
      if (!isWcOrderAnonymised(order)) continue
      try {
        // Decided UNDER the first-import lock: held -> erase (and retire the obligation); not held -> record the obligation.
        const mirrored = await mirrorWcAnonymisationIfHeld(order)
        if (mirrored.held) { result.markedHeld += 1; if (mirrored.erasedNow) result.mirrored += 1; else result.alreadyErased += 1 } else result.obligationsRecorded += 1
      } catch {
        // Fixed text: the underlying error can echo the values being written. The page is NOT complete: the persisted state is left where it was.
        result.errors.push(`erasure sweep: could not mirror the anonymisation of storefront order ${order.id}`)
        failed = true
        break
      }
    }
    if (failed) break

    // The state moves only after EVERY order on the page was processed.
    if (state.window) {
      if (orders.length >= WC_ERASURE_SWEEP_PER_PAGE) state = { after: state.after, window: { ...state.window, page: state.window.page + 1 } }
      else if (state.window.pass === 1) state = { after: state.after, window: { ts: state.window.ts, pass: 2, page: 1 } }
      else {
        // Both passes over the window are done: everything inside (ts - overlap, ts + overlap) was read, so resume just inside its upper edge.
        state = { after: new Date(Date.parse(state.window.ts) + WC_ERASURE_SWEEP_OVERLAP_MS - 1000).toISOString() }
      }
    } else if (orders.length === 0) {
      caughtUp = true
    } else if (lastMod === null) {
      result.errors.push('erasure sweep: an order carried no modified time, so the sweep cannot advance; it stopped')
      break
    } else {
      const candidate = lastMod - WC_ERASURE_SWEEP_OVERLAP_MS
      const currentAfter = state.after ? Date.parse(state.after) : Number.NEGATIVE_INFINITY
      if (orders.length < WC_ERASURE_SWEEP_PER_PAGE) {
        // A short page is the end of the data: nothing newer exists yet. Keep a lower bound that still re-reads the newest second.
        if (candidate > currentAfter) state = { after: new Date(candidate).toISOString() }
        caughtUp = true
      } else if (candidate > currentAfter) {
        state = { after: new Date(candidate).toISOString() }
      } else {
        // No progress by timestamp: a block of orders sharing one modified second that fills a page. Read inside that window by offset.
        state = { after: state.after, window: { ts: new Date(lastMod).toISOString(), pass: 1, page: 1 } }
      }
    }
    await saveState(state)
  }

  // Bookkeeping for the cadence (runWcErasureSweepIfDue): when it last ran, and whether a budget stop left work to resume.
  const stamp = new Date().toISOString()
  for (const [key, value] of [[WC_ERASURE_SWEEP_LAST_RUN_KEY, stamp], [WC_ERASURE_SWEEP_BACKLOG_KEY, result.budgetStop ? 'true' : 'false']] as const) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
  await logActivity({
    entityType: 'SYNC',
    action: 'wc_anonymisation_sweep',
    tag: 'sync',
    level: result.errors.length > 0 ? 'WARNING' : 'INFO',
    description: `WooCommerce anonymisation sweep: ${result.scanned} orders read in ${result.pages} pages, ${result.markedHeld} anonymised and held (${result.mirrored} erased now, ${result.alreadyErased} already erased), ${result.obligationsRecorded} anonymised and not held (obligation recorded), ${result.errors.length} errors${result.budgetStop ? ', stopped on its budget and will resume' : ''}`,
    metadata: { ...result, errors: result.errors.length },
    resolveUser: false,
  })
  return result
}

/** The entry the reconcile and the manual sync call: never throws, so it cannot fail the run it rides on. */
export async function runWcErasureSweep(): Promise<WcErasureSweepResult | { errors: string[] }> {
  try {
    return await sweepWcAnonymisedOrders()
  } catch (e) {
    return { errors: [`WooCommerce anonymisation sweep failed: ${e instanceof Error ? e.constructor.name : typeof e}`] }
  }
}

/**
 * The cron entry: runs the sweep when it is due, AFTER the reconcile's own steps (the cron route awaits `runWcReconcile` first), so it cannot delay
 * them and adds no request to a tick that is not due. Due = never run, or older than a day, or a budget stop left a backlog to resume.
 */
export async function runWcErasureSweepIfDue(): Promise<WcErasureSweepResult | { skipped: true; reason: string } | { errors: string[] }> {
  try {
    const [lastRun, backlog] = await Promise.all([
      db.setting.findUnique({ where: { key: WC_ERASURE_SWEEP_LAST_RUN_KEY } }),
      db.setting.findUnique({ where: { key: WC_ERASURE_SWEEP_BACKLOG_KEY } }),
    ])
    const lastMs = lastRun?.value ? Date.parse(lastRun.value) : Number.NaN
    const due = backlog?.value === 'true' || !Number.isFinite(lastMs) || Date.now() - lastMs >= WC_ERASURE_SWEEP_INTERVAL_MS
    if (!due) return { skipped: true, reason: 'not_due' }
    return await sweepWcAnonymisedOrders()
  } catch (e) {
    return { errors: [`WooCommerce anonymisation sweep failed: ${e instanceof Error ? e.constructor.name : typeof e}`] }
  }
}

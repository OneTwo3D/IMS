/**
 * THE WOOCOMMERCE STOCK-DRIFT OBSERVER (switchover step W, evidence STOCK_DRIFT).
 *
 * Qoblex pushes stock to the store until the owner stops it (an owner checklist step, recorded as the `qoblex-stock-push-stopped` attestation). IMS
 * cannot see Qoblex, so it watches the store: it READS every managed-stock product and variation (GET only, no write anywhere) and compares each
 * quantity with the one it saw last time. A change is EXPLAINED when
 *   - IMS pushed that very quantity AFTER the previous look (StockSyncState.lastPushedQty equals it and lastPushedAt is not before the previous snapshot,
 *     less the slack below: an old push of the same number explains nothing), or
 *   - an order that contains the product was created or changed since the previous look (an order or refund moves stock on its own).
 * A change nothing explains is DRIFT: someone is still writing stock. It is recorded as an event, and the writers:check reader counts the events since
 * the owner's confirmation, less those an operator has acknowledged after review (`npm run switchover:stock-drift-ack`, with who and why kept on the
 * event and an activity-log entry): one reviewed manual edit does not fail the check for good. The first sighting of a product only sets its baseline.
 *
 * A run is `ok` only when the WHOLE catalogue was read (every page, with the store stating its page count) and every snapshot was saved; any other run is
 * recorded as not ok and leaves the snapshots untouched, so a failed read can neither hide drift nor invent it. The reader asks for 24 hours of ok runs
 * after the confirmation, the latest of them recent, before it reports the window quiet.
 *
 * Run by `npm run switchover:stock-drift` (read-only against WooCommerce; it writes only the three observer tables), hourly from the host's scheduler.
 */
import { db } from '@/lib/db'
import { wcFetch } from './api'

export type StockReading = { id: string; sku: string | null; quantity: number }

const PER_PAGE = 100
const MAX_PAGES = 500
/** An order changed this long before the previous look still counts as explaining a change (clock and webhook slip). */
const EXPLAIN_SLACK_MS = 10 * 60_000
/** The pause before every storefront read after the first: the catalogue read shares the store's PHP pool with customer traffic. */
export const CATALOGUE_READ_PAUSE_MS = 300

type CatalogueFetch = (path: string, params: Record<string, string>) => Promise<{ data: unknown; totalPages: number; error?: string }>

const quantityOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null)

async function readPages(get: CatalogueFetch, path: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let totalPages = 1
  for (let page = 1; page <= totalPages; page += 1) {
    if (page > MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages of ${path}`)
    const result = await get(path, { per_page: String(PER_PAGE), page: String(page), _fields: 'id,sku,type,manage_stock,stock_quantity' })
    if (result.error || !Array.isArray(result.data)) throw new Error(result.error ?? `unexpected answer for ${path}`)
    // The store must state how many pages there are: an unstated count is never read as "one page".
    if (typeof result.totalPages !== 'number' || result.totalPages < 0) throw new Error(`the store did not say how many pages of ${path} there are`)
    totalPages = Math.max(result.totalPages, 1)
    for (const row of result.data) if (row !== null && typeof row === 'object') rows.push(row as Record<string, unknown>)
  }
  return rows
}

/** Every product and variation of the store that manages stock, with its quantity. Throws when any page cannot be read to a verified end. Reads are paced (`pauseMs` between requests). */
export async function readWcCatalogueStock(rawGet: CatalogueFetch = (path, params) => wcFetch(path, params), pauseMs: number = CATALOGUE_READ_PAUSE_MS): Promise<StockReading[]> {
  let reads = 0
  const get: CatalogueFetch = async (path, params) => {
    if (reads > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
    reads += 1
    return rawGet(path, params)
  }
  const out = new Map<string, StockReading>()
  const take = (row: Record<string, unknown>): void => {
    const id = typeof row.id === 'number' ? String(row.id) : null
    const quantity = row.manage_stock === true ? quantityOf(row.stock_quantity) : null
    if (id !== null && quantity !== null) out.set(id, { id, sku: typeof row.sku === 'string' && row.sku !== '' ? row.sku : null, quantity })
  }
  const products = await readPages(get, '/products')
  for (const product of products) {
    take(product)
    if (product.type === 'variable' && typeof product.id === 'number') {
      for (const variation of await readPages(get, `/products/${product.id}/variations`)) take(variation)
    }
  }
  return [...out.values()]
}

export type StockDriftObservation = { runId: string; ok: boolean; productsSeen: number; driftFound: number; error?: string }

export type StockDriftDeps = {
  /** Test seam: the catalogue read. Absent = the live store. */
  readCatalogue?: () => Promise<StockReading[]>
  now?: () => Date
}

const CHUNK = 5000

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK))
  return out
}

export async function observeWcStockDrift(deps: StockDriftDeps = {}): Promise<StockDriftObservation> {
  const now = (deps.now ?? (() => new Date()))()
  const run = await db.wcStockDriftRun.create({ data: { startedAt: now } })
  try {
    const readings = await (deps.readCatalogue ?? readWcCatalogueStock)()
    // Every snapshot is loaded (a catalogue can hold tens of thousands of rows; a bind list that long is not safe).
    const snapshots = new Map((await db.wcStockSnapshot.findMany()).map((row) => [row.externalProductId, row]))
    const changed = readings.filter((reading) => {
      const previous = snapshots.get(reading.id)
      return previous !== undefined && previous.quantity !== reading.quantity
    })

    // What explains a change: IMS's own push of that quantity, or an order touching the product since the previous look.
    const explained = new Set<string>()
    if (changed.length > 0) {
      const byExternal = new Map<string, { id: string; pushed: Array<{ qty: number; at: Date | null }> }>()
      for (const part of chunks(changed)) {
        const products = await db.product.findMany({
          where: { externalProductId: { in: part.map((reading) => BigInt(reading.id)) } },
          select: { id: true, externalProductId: true, stockSyncStates: { where: { connector: 'woocommerce' }, select: { lastPushedQty: true, lastPushedAt: true } } },
        })
        for (const product of products) byExternal.set(String(product.externalProductId), { id: product.id, pushed: product.stockSyncStates.flatMap((state) => (state.lastPushedQty === null ? [] : [{ qty: state.lastPushedQty, at: state.lastPushedAt }])) })
      }
      const needOrders: Array<{ readingId: string; productId: string; since: Date }> = []
      for (const reading of changed) {
        const product = byExternal.get(reading.id)
        if (!product) continue
        const since = new Date(snapshots.get(reading.id)!.observedAt.getTime() - EXPLAIN_SLACK_MS)
        // A push counts only when it was made after the previous look (an unknown push time explains nothing).
        if (product.pushed.some((push) => push.qty === reading.quantity && push.at !== null && push.at.getTime() >= since.getTime())) { explained.add(reading.id); continue }
        needOrders.push({ readingId: reading.id, productId: product.id, since })
      }
      for (const part of chunks(needOrders)) {
        const earliest = new Date(Math.min(...part.map((entry) => entry.since.getTime())))
        const lines = await db.salesOrderLine.findMany({
          where: { productId: { in: part.map((entry) => entry.productId) }, order: { updatedAt: { gte: earliest } } },
          select: { productId: true, order: { select: { updatedAt: true } } },
        })
        const latest = new Map<string, number>()
        for (const line of lines) if (line.productId) latest.set(line.productId, Math.max(latest.get(line.productId) ?? 0, line.order.updatedAt.getTime()))
        for (const entry of part) if ((latest.get(entry.productId) ?? 0) >= entry.since.getTime()) explained.add(entry.readingId)
      }
    }
    const drifted = changed.filter((reading) => !explained.has(reading.id))

    await db.$transaction(async (tx) => {
      if (drifted.length > 0) {
        await tx.wcStockDriftEvent.createMany({
          data: drifted.map((reading) => ({
            externalProductId: reading.id, sku: reading.sku, fromQuantity: snapshots.get(reading.id)!.quantity, toQuantity: reading.quantity,
            previousObservedAt: snapshots.get(reading.id)!.observedAt, observedAt: now,
          })),
        })
      }
      for (const part of chunks(readings)) {
        // One statement per chunk: a row-by-row upsert of a whole catalogue would outlast the transaction's time limit.
        await tx.$executeRaw`
          INSERT INTO wc_stock_snapshots (external_product_id, sku, quantity, observed_at)
          SELECT * FROM unnest(${part.map((r) => r.id)}::text[], ${part.map((r) => r.sku)}::text[], ${part.map((r) => r.quantity)}::int[], ${part.map(() => now.toISOString())}::timestamp[])
          ON CONFLICT (external_product_id) DO UPDATE SET sku = EXCLUDED.sku, quantity = EXCLUDED.quantity, observed_at = EXCLUDED.observed_at`
      }
      await tx.wcStockDriftRun.update({ where: { id: run.id }, data: { ok: true, finishedAt: new Date(), productsSeen: readings.length, driftFound: drifted.length } })
    }, { timeout: 120_000, maxWait: 30_000 })
    return { runId: run.id, ok: true, productsSeen: readings.length, driftFound: drifted.length }
  } catch (error) {
    await db.wcStockDriftRun.update({ where: { id: run.id }, data: { ok: false, finishedAt: new Date() } }).catch(() => undefined)
    return { runId: run.id, ok: false, productsSeen: 0, driftFound: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * WooCommerce order backfill — background job.
 *
 * Imports the orders the operator selected under Settings -> Sync -> WooCommerce
 * -> "Import order statuses" as SalesOrders via importWcOrder. Historical demand
 * data import is handled separately by the forecast module.
 *
 * The status list used to be hardcoded here as `processing,pending,on-hold`
 * while the same setting governed every other pull route (o3d-tj6v follow-up).
 * That made the checkboxes a lie on the ONE import that runs on every new
 * installation: unticking `on-hold` still backfilled on-hold orders, and the
 * only place that said otherwise was the sentence on this card. The list now
 * comes from `getWcPullStatuses('initial')` like every other pull route, and the
 * Sync page prints the resolved list before the button is pressed.
 */

import { after } from 'next/server'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { notify } from '@/lib/notifications'
import { wcFetch, MAX_WC_PAGE_WALK_PAGES, describeUnendedWcPageWalk } from '../api'
import { getWcPullStatuses, importWcOrder } from './order-import'
import { WC_NO_STATUSES_SELECTED_MESSAGE } from '../order-status-filter'
import type { WcFullOrder } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitialImportProgress = {
  status: 'idle' | 'running' | 'done' | 'error'
  message: string
  activeOrdersImported: number
  activeOrdersSkipped: number
  totalOrders: number
  currentPage: number
  totalPages: number
  errors: string[]
}

const JOB_KEY = 'initial_order_import_job'

/**
 * Decide whether an initial-import pass counts as COMPLETE (which unlocks ongoing
 * live order sync) or FAILED. A pass that errored on every order and imported
 * nothing must NOT count as complete — otherwise the UI shows a dead-end
 * "completed" with no orders, live sync stays silently gated off, and there's no
 * way to retry. A pass that imported/reconciled at least one order, or had no
 * active orders to import, is complete (per-order errors are surfaced but don't
 * block, since live sync of new orders can still proceed).
 *
 * A TRUNCATED READ IS THE ONE PER-PASS FAILURE THAT PROGRESS CANNOT OUTVOTE (o3d-xnwu). Every
 * other input here is per-ORDER: some orders failed, the rest are in, and live sync can carry the
 * rest. A walk that never reached an empty page is a statement about the COLLECTION — IMS does not
 * know how much of the store it has seen — and "imported at least one" is exactly the condition
 * that would be satisfied by a backfill truncated to its first page. Unlocking live sync on that
 * leaves every order beyond the truncation permanently unimported: the live sweeps are cursor-based
 * and the backfill is the only thing that ever reads the history. So it is passed in separately and
 * it fails the pass outright, which is what makes the retry happen.
 */
export function decideInitialImportOutcome(input: {
  imported: number
  skipped: number
  errorCount: number
  /** The order walk never reached an empty page, so how much of the store was read is unknown. */
  truncatedRead?: boolean
}): 'complete' | 'failed' {
  if (input.truncatedRead) return 'failed'
  const madeProgress = input.imported > 0 || input.skipped > 0
  return input.errorCount > 0 && !madeProgress ? 'failed' : 'complete'
}

const INITIAL_PROGRESS: InitialImportProgress = {
  status: 'idle',
  message: '',
  activeOrdersImported: 0,
  activeOrdersSkipped: 0,
  totalOrders: 0,
  currentPage: 0,
  totalPages: 0,
  errors: [],
}

// ---------------------------------------------------------------------------
// Progress persistence — stored in the settings table
// ---------------------------------------------------------------------------

async function saveProgress(progress: InitialImportProgress) {
  await db.setting.upsert({
    where: { key: JOB_KEY },
    create: { key: JOB_KEY, value: JSON.stringify(progress) },
    update: { value: JSON.stringify(progress) },
  })
}

export async function getInitialImportProgress(): Promise<InitialImportProgress> {
  const row = await db.setting.findUnique({ where: { key: JOB_KEY } })
  if (!row?.value) return INITIAL_PROGRESS
  try { return JSON.parse(row.value) } catch { return INITIAL_PROGRESS }
}

// ---------------------------------------------------------------------------
// Start the import as a background job
// ---------------------------------------------------------------------------

export async function startInitialImport(): Promise<void> {
  const current = await getInitialImportProgress()
  if (current.status === 'running') return

  // Check if already completed
  const completedSetting = await db.setting.findUnique({ where: { key: 'wc_initial_import_completed' } })
  if (completedSetting?.value === 'true') return

  const progress: InitialImportProgress = {
    ...INITIAL_PROGRESS,
    status: 'running',
    message: 'Preparing active order import\u2026',
  }
  await saveProgress(progress)

  after(() => runInitialImport(progress).catch(async (e) => {
    progress.status = 'error'
    progress.message = String(e)
    progress.errors.push(String(e))
    await saveProgress(progress)
  }))
}

// ---------------------------------------------------------------------------
// The actual import logic
// ---------------------------------------------------------------------------

async function runInitialImport(progress: InitialImportProgress) {
  try {
    const statuses = await getWcPullStatuses('initial')

    // No statuses selected is an instruction, not an unset setting. Marking the
    // import COMPLETE here would unlock live order sync on a configuration that
    // imports nothing, so surface it as an error the Sync page offers a retry
    // for \u2014 the operator ticks a status and presses the button again.
    if (statuses.length === 0) {
      progress.status = 'error'
      progress.message = WC_NO_STATUSES_SELECTED_MESSAGE
      progress.errors.push(WC_NO_STATUSES_SELECTED_MESSAGE)
      await saveProgress(progress)
      await logActivity({
        entityType: 'IMPORT',
        tag: 'import',
        action: 'failed',
        level: 'WARNING',
        description: `Active WC order import did not run: ${WC_NO_STATUSES_SELECTED_MESSAGE}`,
        resolveUser: false,
      })
      notify({
        type: 'error',
        title: 'Active Order Import Failed',
        message: WC_NO_STATUSES_SELECTED_MESSAGE,
        actionUrl: '/sync',
      })
      return
    }

    progress.message = `Importing orders (${statuses.join(', ')})\u2026`
    await saveProgress(progress)

    // Deduplication: pre-load existing WooCommerce order links.
    const existingOrders = await db.shoppingOrderLink.findMany({
      where: { connector: 'woocommerce' },
      select: { externalOrderId: true },
    })
    const importedOrderIds = new Set(existingOrders.map((o) => Number(o.externalOrderId)))

    let page = 1
    let totalPages = 1
    // o3d-xnwu: the walk ends on an EMPTY PAGE, not on `x-wp-totalpages`. This is the run that
    // GATES live order sync — an initial import truncated to 100 orders by a store that sends no
    // readable page count would unlock live sync over a store IMS has mostly never seen.
    let endedOnEmptyPage = false

    while (page <= MAX_WC_PAGE_WALK_PAGES) {
      progress.currentPage = page
      progress.message = `Fetching orders (${statuses.join(', ')})\u2026 page ${page}${totalPages > 1 ? ` / ${totalPages}` : ''}`
      await saveProgress(progress)

      let result: Awaited<ReturnType<typeof wcFetch>> | null = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await wcFetch('/orders', {
            status: statuses.join(','),
            per_page: '100',
            page: String(page),
            orderby: 'date',
            order: 'asc',
          })
          if (!result.error) break
        } catch (fetchErr) {
          result = { data: null, totalPages: 0, totalItems: 0, error: String(fetchErr) }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000))
      }

      if (!result || result.error) {
        progress.errors.push(`Page ${page}: ${result?.error ?? 'unknown error'}`)
        page++
        continue
      }

      totalPages = result.totalPages
      progress.totalPages = totalPages
      if (result.totalItems > 0) progress.totalOrders = result.totalItems
      const orders = result.data as WcFullOrder[]

      // THE ONLY PROOF OF AN ENDING (o3d-xnwu).
      if (orders.length === 0) {
        endedOnEmptyPage = true
        break
      }

      for (const order of orders) {
        if (importedOrderIds.has(order.id)) {
          progress.activeOrdersSkipped++
          continue
        }

        // Guarded (o3d-d82p): this loop works from a PAGE SNAPSHOT, and an
        // order can move to a withdrawal status between the page fetch and its
        // turn here. Ordinary webhooks are acknowledged as
        // initial_import_pending during this mode, so nothing else would catch
        // it — the order would land as paid PROCESSING with no marker and stay
        // warehouse-eligible until the next reconciliation.
        const { importWcOrderGuarded } = await import('./withdrawal')
        const guarded = await importWcOrderGuarded(
          order,
          // PREAUTHORISED (o3d-tj6v r5): the backfill fetched these with `?status=<selection>`
          // via `getWcPullStatuses('initial')`, so WooCommerce has already applied the operator's
          // choice. Gating them a second time here would judge the same orders twice.
          () => importWcOrder(order, {
            useWcDateAsCreatedAt: true,
            createAdmission: 'preauthorised-by-status-query',
          }),
        )
        if (guarded.outcome !== 'imported') {
          progress.activeOrdersSkipped++
          continue
        }
        const importResult = guarded.result
        if (guarded.compensationFailed) {
          progress.errors.push(
            `WooCommerce order #${order.number}: imported, but applying the customer's withdrawal FAILED — the order is live and withdrawn`,
          )
        }
        if (importResult.success && importResult.orderId) {
          progress.activeOrdersImported++
        } else if (importResult.success) {
          progress.activeOrdersSkipped++
        } else {
          progress.errors.push(`Order #${order.number}: ${importResult.error}`)
        }

        importedOrderIds.add(order.id)
      }

      page++
    }

    // A TRUNCATED READ IS RECORDED AND THEN CARRIED INTO THE OUTCOME (o3d-xnwu). Recording it as an
    // error alone would NOT have been enough: `decideInitialImportOutcome` treats any progress as
    // outvoting any error count, and a backfill truncated to its first page has made progress. It
    // is therefore passed in as its own input, which fails the pass and keeps live order sync
    // gated until a complete read succeeds.
    if (!endedOnEmptyPage) {
      progress.errors.push(describeUnendedWcPageWalk('initial order import', page - 1))
    }

    // -----------------------------------------------------------------------
    // Completion
    // -----------------------------------------------------------------------
    const outcome = decideInitialImportOutcome({
      imported: progress.activeOrdersImported,
      skipped: progress.activeOrdersSkipped,
      errorCount: progress.errors.length,
      truncatedRead: !endedOnEmptyPage,
    })

    if (outcome === 'failed') {
      // Every order errored and nothing was imported \u2014 a systemic failure (e.g.
      // no storefront-synced warehouse). Do NOT mark the import complete: that
      // would falsely unlock live sync and leave a dead-end "done" state with no
      // retry. Surface it as an error so the UI shows Retry and live order sync
      // stays gated off until a real import succeeds.
      progress.status = 'error'
      // TWO REASONS REACH HERE AND THEY NEED DIFFERENT SENTENCES (o3d-xnwu). "0 of N imported" is
      // false for a truncated read, which imported everything it managed to see \u2014 the problem is
      // that nobody knows what it did not see, and saying "0 imported" would send an operator
      // looking for a systemic import failure that is not there.
      progress.message = !endedOnEmptyPage
        ? `Import incomplete \u2014 ${progress.activeOrdersImported} order${progress.activeOrdersImported === 1 ? '' : 's'} imported, but WooCommerce never returned an empty page, so how much of the store was read is unknown. Retry; live order sync stays off until a complete read succeeds.`
        : `Import failed \u2014 0 of ${progress.totalOrders} order${progress.totalOrders === 1 ? '' : 's'} imported (${progress.errors.length} error${progress.errors.length === 1 ? '' : 's'}). Resolve the cause and retry; live order sync stays off until the initial import succeeds.`
      await saveProgress(progress)

      await logActivity({
        entityType: 'IMPORT',
        tag: 'import',
        action: 'failed',
        description: `Active WC order import failed: ${progress.message}`,
        resolveUser: false,
      })
      notify({
        type: 'error',
        title: 'Active Order Import Failed',
        message: progress.message,
        actionUrl: '/sync',
      })
      return
    }

    await db.setting.upsert({
      where: { key: 'wc_initial_import_completed' },
      create: { key: 'wc_initial_import_completed', value: 'true' },
      update: { value: 'true' },
    })
    await db.setting.upsert({
      where: { key: 'last_wc_order_sync_at' },
      create: { key: 'last_wc_order_sync_at', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })

    progress.status = 'done'
    const parts: string[] = []
    if (progress.activeOrdersImported > 0) parts.push(`${progress.activeOrdersImported} active orders imported`)
    if (progress.activeOrdersSkipped > 0) parts.push(`${progress.activeOrdersSkipped} already imported`)
    if (progress.errors.length > 0) parts.push(`${progress.errors.length} errors`)
    if (parts.length === 0) parts.push('No active orders found')
    progress.message = parts.join(' \u00b7 ')
    await saveProgress(progress)

    await logActivity({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      description: `Active WC order import complete: ${progress.message}`,
      resolveUser: false,
    })

    notify({
      type: 'success',
      title: 'Active Order Import Complete',
      message: progress.message,
      actionUrl: '/sync',
    })
  } catch (e) {
    progress.status = 'error'
    progress.message = String(e)
    progress.errors.push(String(e))
    await saveProgress(progress)

    await logActivity({
      entityType: 'IMPORT',
      tag: 'import',
      action: 'imported',
      level: 'ERROR',
      description: `Active WC order import failed: ${String(e)}`,
      resolveUser: false,
    })

    notify({
      type: 'error',
      title: 'Active Order Import Failed',
      message: String(e),
      actionUrl: '/sync',
    })
  }
}

// ---------------------------------------------------------------------------
// Purge expired demand history (called from activity-cleanup cron)
// ---------------------------------------------------------------------------

export async function purgeExpiredDemandHistory(): Promise<number> {
  // Read retention from forecast settings, fall back to legacy key
  const forecastSetting = await db.setting.findUnique({ where: { key: 'forecast_retention_months' } })
  const legacySetting = !forecastSetting?.value
    ? await db.setting.findUnique({ where: { key: 'wc_initial_import_retention_months' } })
    : null
  const retentionMonths = Math.max(1, parseInt(forecastSetting?.value || legacySetting?.value || '24') || 24)
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - retentionMonths)

  const deleted = await db.stockMovement.deleteMany({
    where: {
      referenceType: { in: ['WcHistorical', 'WcInitialImport', 'CsvHistorical'] },
      createdAt: { lt: cutoff },
    },
  })

  if (deleted.count > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Purged ${deleted.count} expired demand history records (older than ${retentionMonths} months)`,
      metadata: { deletedCount: deleted.count },
      resolveUser: false,
    })
  }

  return deleted.count
}

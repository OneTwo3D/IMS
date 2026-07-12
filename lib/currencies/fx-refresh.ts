import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { notify } from '@/lib/notifications'

// ---------------------------------------------------------------------------
// Core FX-rate refresh logic.
//
// This lives in a plain (non-'use server') module ON PURPOSE: it is invoked by
// the authed server action `fetchAllFxRates` and by the CRON_SECRET-gated cron
// route, but it must NOT itself be exposed as a callable server action. Placing
// it here keeps it out of the server-action manifest so an unauthenticated
// client cannot POST it directly to trigger FX writes / connector pushes.
// ---------------------------------------------------------------------------

/** Core FX rate fetching logic (no auth — used by cron and the server action). */
export async function fetchAllFxRatesInternal(): Promise<{
  success: boolean
  updated: string[]
  failed: string[]
  error?: string
  retryCount?: number
  skippedManualOverrides?: string[]
  pendingWcOrderRetry?: { attempted: number; imported: number; stillPending: number; failed: number } | null
}> {
  try {
    const baseCurrency = await getBaseCurrencyCode()
    const currencies = await db.currency.findMany({
      where: { active: true, code: { not: baseCurrency } },
      select: { code: true },
    })

    if (!currencies.length) return { success: true, updated: [], failed: [] }

    // Skip currencies whose latest rate is a manual override — the admin has
    // pinned that rate and doesn't want frankfurter to overwrite it. The
    // override stays in effect until they explicitly insert a fresh non-
    // override row via clearManualFxRate().
    const allCodes = currencies.map((c) => c.code)
    const overrideCodes = await getActiveOverrideCurrencies(allCodes)
    const codes = allCodes.filter((c) => !overrideCodes.has(c))

    if (!codes.length) {
      await recordFxFetchAttempt({
        status: 'skipped_manual_override',
        retryCount: 0,
        skippedManualOverrides: allCodes,
      })
      await logActivity({
        entityType: 'SYNC',
        tag: 'sync',
        action: 'fx_rates_fetched',
        description: `FX fetch skipped — all ${allCodes.length} currencies have manual overrides`,
      })
      return { success: true, updated: [], failed: [], retryCount: 0, skippedManualOverrides: allCodes }
    }
    const symbols = encodeURIComponent(codes.join(','))

    let res: Response | null = null
    let retryCount = 0
    for (let attempt = 1; attempt <= 3; attempt++) {
      retryCount = attempt
      res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(baseCurrency)}&symbols=${symbols}`, {
        signal: AbortSignal.timeout(15000),
      }).catch(() => null)
      if (res?.ok) break
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500))
    }

    if (!res?.ok) {
      const error = `API returned ${res?.status ?? 'no response'}`
      await recordFxFetchAttempt({
        status: 'failed',
        retryCount,
        failed: codes,
        error,
      })
      await logActivity({
        entityType: 'SYNC',
        tag: 'sync',
        action: 'fx_rates_fetched',
        level: 'ERROR',
        description: `FX rate refresh failed; existing rates remain in use for ${codes.length} currencies`,
        metadata: { failed: codes, status: res?.status ?? null, retryCount },
      })
      await notifyActiveAdmins({
        type: 'error',
        title: 'FX rate refresh failed',
        message: `Frankfurter FX refresh failed after ${retryCount} attempts. Existing rates remain in use for ${codes.join(', ')}.`,
        actionUrl: '/settings/accounting?tab=fx-rates',
      })
      return { success: false, updated: [], failed: codes, error, retryCount }
    }

    const data = await res.json()
    const rates = data?.rates ?? {}
    const updated: string[] = []
    const failed: string[] = []

    for (const code of codes) {
      const rate = rates[code]
      if (typeof rate === 'number' && rate > 0) {
        await db.fxRate.create({
          data: { fromCurrency: baseCurrency, toCurrency: code, rate, source: 'frankfurter' },
        })
        updated.push(code)
      } else {
        failed.push(code)
      }
    }

    await recordFxFetchAttempt({
      status: failed.length ? 'partial' : 'success',
      retryCount,
      failed,
      skippedManualOverrides: Array.from(overrideCodes),
    })

    // Record last fetched timestamp
    await db.setting.upsert({
      where: { key: 'fx_last_fetched' },
      create: { key: 'fx_last_fetched', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', description: `Fetched FX rates for ${updated.length} currencies` })

    let pendingWcOrderRetry: { attempted: number; imported: number; stillPending: number; failed: number } | null = null
    if (updated.length > 0) {
      try {
        const { retryPendingWcOrdersWaitingForFx } = await import('@/lib/connectors/woocommerce/sync/order-import')
        pendingWcOrderRetry = await retryPendingWcOrdersWaitingForFx()
      } catch (e) {
        await logActivity({
          entityType: 'SYNC',
          tag: 'sync',
          action: 'wc_order_fx_pending_retry',
          level: 'WARNING',
          description: `Failed to retry WooCommerce orders waiting for FX rates: ${String(e).slice(0, 240)}`,
        })
      }
    }

    // b8i6.2: fan the new rates out to every configured shopping connector via
    // the facade (each owns its own push + telemetry; Shopify is skipped until it
    // gains an FX push). Failure here must never roll back the inbound fetch.
    if (updated.length) {
      try {
        const { pushFxRatesToConnectors } = await import('@/lib/shopping')
        await pushFxRatesToConnectors()
      } catch (e) {
        await logActivity({
          entityType: 'SYNC',
          tag: 'sync',
          action: 'fx_rates_pushed',
          level: 'ERROR',
          description: `FX rate push threw: ${String(e).slice(0, 240)}`,
        })
      }
    }

    revalidatePath('/settings', 'layout')
    revalidatePath('/purchase-orders')
    return { success: true, updated, failed, retryCount, skippedManualOverrides: Array.from(overrideCodes), pendingWcOrderRetry }
  } catch (e) {
    const error = String(e)
    await recordFxFetchAttempt({
      status: 'failed',
      retryCount: 0,
      error,
    })
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', level: 'ERROR', description: `Failed to fetch FX rates: ${error}` })
    await notifyActiveAdmins({
      type: 'error',
      title: 'FX rate refresh failed',
      message: `FX refresh failed before contacting Frankfurter: ${error.slice(0, 200)}`,
      actionUrl: '/settings/accounting?tab=fx-rates',
    })
    return { success: false, updated: [], failed: [], error, retryCount: 0 }
  }
}

/**
 * Of the given currency codes, return the set whose latest FxRate row is a
 * manual override. The fetch loop calls this so it can skip those currencies
 * without overwriting the admin-pinned rate.
 */
async function getActiveOverrideCurrencies(codes: string[]): Promise<Set<string>> {
  if (!codes.length) return new Set()
  // For each currency, take the latest row and check `manualOverride`. Done
  // in SQL to avoid loading every historical row.
  const rows = await db.$queryRaw<Array<{ toCurrency: string; manualOverride: boolean }>>`
    SELECT DISTINCT ON ("toCurrency") "toCurrency", "manualOverride"
    FROM "fx_rates"
    WHERE "toCurrency" = ANY(${codes}::text[])
    ORDER BY "toCurrency", "fetchedAt" DESC
  `
  return new Set(rows.filter((r) => r.manualOverride).map((r) => r.toCurrency))
}

type FxFetchAttemptStatus = 'success' | 'partial' | 'failed' | 'skipped_manual_override'

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

async function recordFxFetchAttempt(input: {
  status: FxFetchAttemptStatus
  retryCount: number
  failed?: string[]
  skippedManualOverrides?: string[]
  error?: string
}): Promise<void> {
  const now = new Date().toISOString()
  await Promise.all([
    setSetting('fx_last_fetch_attempt_at', now),
    setSetting('fx_last_fetch_attempt_status', input.status),
    setSetting('fx_last_fetch_retry_count', String(input.retryCount)),
    setSetting('fx_last_fetch_failed_currencies', (input.failed ?? []).join(',')),
    setSetting('fx_last_fetch_skipped_manual_overrides', (input.skippedManualOverrides ?? []).join(',')),
    setSetting('fx_last_fetch_error', input.error ?? ''),
  ])
}

async function notifyActiveAdmins(params: Omit<Parameters<typeof notify>[0], 'userId'>): Promise<void> {
  const admins = await db.user.findMany({
    where: { role: 'ADMIN', active: true },
    select: { id: true },
  })
  await Promise.all(admins.map((admin) => notify({ ...params, userId: admin.id })))
}

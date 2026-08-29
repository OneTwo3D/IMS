'use server'

import { requireFreshPermission, requirePermission } from '@/lib/auth/server'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import {
  deferredRevivalReason,
  effectiveTokenFor,
  isMoneyMovingSyncType,
  planManualRetry,
  selectRevivableCandidates,
  type RetryCandidateRow,
} from '@/lib/domain/accounting/followup-retry-guard'
import type { LedgerSettlementProbe } from '@/lib/domain/accounting/ledger-settlement-evidence'
import { probeLedgerSettlement, settlementProbeKey } from '@/lib/connectors/accounting-settlement-probe'
import { lockFollowUpScope } from '@/lib/domain/accounting/followup-scope-lock'
import {
  getAuthorizationUrl,
  disconnect,
  isConnected,
  syncChartOfAccounts,
  getQuickBooksTaxCodes,
  processPendingQuickBooksSync,
} from '@/lib/connectors/quickbooks'
import { getQuickBooksSettings, QUICKBOOKS_SETTING_KEYS, type QuickBooksSettings } from '@/lib/connectors/quickbooks/settings'
import { buildAccountingCallbackUri } from '@/lib/accounting/callback-url'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { getSettingValue, serializeSettingValue } from '@/lib/settings-store'
import { isMaskedSecret, maskSecret, shouldFreshGateSecretWrite } from '@/lib/security/secret-mask'

export type { QuickBooksSettings } from '@/lib/connectors/quickbooks/settings'

/**
 * `sync` for every guarded export here - ADMIN and MANAGER both hold it. Renamed from
 * `requireAdmin`, which shadowed the ADMIN-only helper of that name in @/lib/auth/server.
 * See the fuller note in app/actions/xero-sync.ts.
 */
async function requireSyncPermission() {
  return requirePermission('sync')
}

async function requireFreshAdmin() {
  return requireFreshPermission('sync')
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getQuickBooksSettingsMasked(): Promise<QuickBooksSettings & { secretMasked: boolean }> {
  const settings = await getQuickBooksSettings()
  const masked = maskSecret(settings.quickbooks_client_secret)
  return { ...settings, quickbooks_client_secret: masked, secretMasked: !!settings.quickbooks_client_secret }
}

export async function saveQuickBooksSettings(data: Partial<QuickBooksSettings>): Promise<{ success: boolean; error?: string }> {
  try {
    await requireSyncPermission()
    if (shouldFreshGateSecretWrite(data, 'quickbooks_client_secret')) {
      await requireFreshAdmin()
    }

    if (data.quickbooks_sync_enabled === 'true') {
      const currentEnabled = await getSettingValue('quickbooks_sync_enabled')
      const isTransitioningOn = currentEnabled !== 'true'
      if (isTransitioningOn) {
        const readiness = await getQuickBooksSyncReadiness()
        if (!readiness.ready) {
          const reasons: string[] = []
          if (readiness.notConnected) reasons.push('not connected to QuickBooks')
          if (readiness.missingAccounts.length > 0) {
            reasons.push(`missing account mappings (${readiness.missingAccounts.map(a => a.label).join(', ')})`)
          }
          if (readiness.missingTaxTypes.length > 0) {
            reasons.push(`missing accounting tax type on IMS VAT rates (${readiness.missingTaxTypes.map(t => t.name).join(', ')})`)
          }
          return { success: false, error: `Cannot enable QuickBooks sync — ${reasons.join('; ')}.` }
        }
      }
    }

    // Don't overwrite secret with masked value
    const entries = Object.entries(data).filter(([k, v]) => {
      if (!(QUICKBOOKS_SETTING_KEYS as readonly string[]).includes(k)) return false
      if (k === 'quickbooks_client_secret' && isMaskedSecret(v)) return false
      return true
    })

    const ops = entries.map(([k, v]) =>
      db.setting.upsert({
        where: { key: k },
        create: { key: k, value: serializeSettingValue(k, v ?? '') },
        update: { value: serializeSettingValue(k, v ?? '') },
      }),
    )
    await db.$transaction(ops)

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_settings_updated',
      tag: 'sync',
      description: 'Updated QuickBooks sync settings',
      metadata: { keys: entries.map(([k]) => k) },
    })
    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function saveQuickBooksConnectionSettings(
  clientId: string,
  clientSecret: string,
): Promise<{ success: boolean; error?: string; message?: string }> {
  try {
    await requireFreshAdmin()

    const nextClientId = clientId.trim()
    const nextClientSecretInput = clientSecret.trim()
    const nextClientSecret = isMaskedSecret(nextClientSecretInput) ? '' : nextClientSecretInput
    const existingSettings = await getQuickBooksSettings()
    const resolvedSecret = nextClientSecret || existingSettings.quickbooks_client_secret.trim()

    if (!nextClientId) {
      return { success: false, error: 'QuickBooks Client ID is required.' }
    }

    if (!resolvedSecret) {
      return { success: false, error: 'QuickBooks Client Secret is required.' }
    }

    const publicAppUrl = await getPublicAppUrl()
    if (!publicAppUrl) {
      return { success: false, error: 'Public app URL is not configured.' }
    }

    const redirectUri = buildAccountingCallbackUri(publicAppUrl)
    if (!redirectUri) {
      return { success: false, error: 'QuickBooks redirect URL is invalid.' }
    }

    const ops = [
      db.setting.upsert({
        where: { key: 'quickbooks_client_id' },
        create: { key: 'quickbooks_client_id', value: serializeSettingValue('quickbooks_client_id', nextClientId) },
        update: { value: serializeSettingValue('quickbooks_client_id', nextClientId) },
      }),
    ]

    if (nextClientSecret) {
      ops.push(
        db.setting.upsert({
          where: { key: 'quickbooks_client_secret' },
          create: { key: 'quickbooks_client_secret', value: serializeSettingValue('quickbooks_client_secret', nextClientSecret) },
          update: { value: serializeSettingValue('quickbooks_client_secret', nextClientSecret) },
        }),
      )
    }

    await db.$transaction(ops)

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_connection_settings_updated',
      tag: 'sync',
      description: 'Updated QuickBooks connection settings',
    })

    revalidatePath('/sync')
    revalidatePath('/onboarding')
    return { success: true, message: 'Connection settings saved. OAuth redirect is ready.' }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getQuickBooksConnectionStatus(): Promise<{
  connected: boolean
  tenantName?: string
}> {
  return isConnected()
}

export async function connectQuickBooks(
  clientId: string,
  clientSecret: string,
  origin: string,
  returnPath?: string,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  try {
    void origin
    const session = await requireFreshAdmin()

    // Save credentials
    const ops = [
      db.setting.upsert({ where: { key: 'quickbooks_client_id' }, create: { key: 'quickbooks_client_id', value: serializeSettingValue('quickbooks_client_id', clientId) }, update: { value: serializeSettingValue('quickbooks_client_id', clientId) } }),
    ]
    if (clientSecret && !isMaskedSecret(clientSecret)) {
      ops.push(db.setting.upsert({ where: { key: 'quickbooks_client_secret' }, create: { key: 'quickbooks_client_secret', value: serializeSettingValue('quickbooks_client_secret', clientSecret) }, update: { value: serializeSettingValue('quickbooks_client_secret', clientSecret) } }))
    }
    await db.$transaction(ops)

    const publicAppUrl = await getPublicAppUrl()
    if (!publicAppUrl) {
      return { success: false, error: 'Public app URL is not configured.' }
    }
    // Shared builder so the redirect_uri is byte-identical to the one the
    // callback sends at token exchange (qye3/Codex: OAuth requires exact match;
    // origin normalization strips case/port/path/query/fragment/user-info
    // consistently on both sides).
    const redirectUri = buildAccountingCallbackUri(publicAppUrl)
    if (!redirectUri) {
      return { success: false, error: 'Public app URL is not a valid http(s) URL.' }
    }
    const authUrl = await getAuthorizationUrl(clientId, redirectUri, session.user.id, returnPath)

    return { success: true, redirectUrl: authUrl }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function disconnectQuickBooks(): Promise<{ success: boolean; error?: string }> {
  try {
    // Fresh-at-start is the security boundary; connector revocation may outlive
    // the freshness window after the operator has already confirmed intent.
    await requireFreshAdmin()
    await disconnect()

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_disconnected',
      tag: 'sync',
      description: 'Disconnected from QuickBooks',
    })

    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export async function syncQuickBooksAccounts(): Promise<{ synced: number; errors: string[] }> {
  await requireSyncPermission()
  const result = await syncChartOfAccounts()

  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_accounts_synced',
    tag: 'sync',
    description: `Synced ${result.synced} accounts from QuickBooks`,
    metadata: result,
  })

  revalidatePath('/sync')
  return result
}

export async function getQuickBooksAccounts(): Promise<Array<{ id: string; externalAccountId: string; code: string | null; name: string; type: string }>> {
  return db.accountingAccount.findMany({
    where: { connector: 'quickbooks', active: true },
    select: { id: true, externalAccountId: true, code: true, name: true, type: true },
    orderBy: [{ code: 'asc' }],
  })
}

export async function fetchQuickBooksTaxCodes(): Promise<Array<{ taxType: string; name: string; rate: number }>> {
  const result = await getQuickBooksTaxCodes()
  return result.map((tc) => ({ taxType: tc.id, name: tc.name, rate: 0 }))
}

// ---------------------------------------------------------------------------
// Sync Logs
// ---------------------------------------------------------------------------

export type QuickBooksSyncLogRow = {
  id: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  /**
   * o3d-anu8. Carried here for ONE reason: the shared `AccountingSyncLogRow` requires it, and the
   * sync page renders through that. The per-row settlement action is connector-agnostic — it writes
   * this column on whichever row an operator settles — so the display must be able to mark a
   * QuickBooks row as asserted too, or the marker would silently mean "Xero only". No
   * QuickBooks-specific behaviour is changed by it.
   */
  settlementBasis: string | null
  syncedAt: string | null
  createdAt: string
}

export async function getQuickBooksSyncLogs(limit = 50): Promise<QuickBooksSyncLogRow[]> {
  const rows = await db.accountingSyncLog.findMany({
    where: { connector: 'quickbooks' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    status: r.status,
    referenceType: r.referenceType,
    referenceId: r.referenceId,
    externalTransactionId: r.externalTransactionId,
    errorMessage: r.errorMessage,
    retryCount: r.retryCount,
    settlementBasis: r.settlementBasis,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Manual Sync
// ---------------------------------------------------------------------------

export async function triggerQuickBooksSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    await requireSyncPermission()

    const enabled = await db.setting.findUnique({ where: { key: 'quickbooks_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return { success: false, error: 'QuickBooks sync is not enabled' }
    }

    const result = await processPendingQuickBooksSync()
    // NO back-reference repair sweep here, deliberately (o3d-9kek r6). The manual sync is where an
    // operator would most want one — it is the button they press after linking a bill by hand — but
    // the connector-agnostic sweep is scoped by connector alone, and a QuickBooks external id only
    // means anything inside one realm, so it could stamp a previous company's id onto a live
    // document. The ambiguity warnings this connector writes say plainly that the link must be made
    // by hand rather than pointing at a sweep.
    //
    // THE PRECONDITION THIS LINE USED TO NAME IS THE WRONG ONE (o3d-0bfh r6, Codex MEDIUM). It said
    // o3d-s36z; that has CLOSED, and a maintainer checking it would have found it satisfied and
    // bound the sweep here in one line. The real prerequisites are POST-TIME AUTHORIZATION (o3d-8prh)
    // and ORIGIN PROPAGATION on the follow-up rows a sweep would create. See the note at the end of
    // lib/connectors/quickbooks/sync-processor.ts.
    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_manual_sync',
      tag: 'sync',
      description: `Manual QuickBooks sync: ${result.succeeded} synced, ${result.failed} failed`,
      metadata: { ...result },
    })

    revalidatePath('/sync')
    return { success: true, result }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function retryFailedQuickBooksSync(entryId?: string): Promise<{ success: boolean; reset: number; refused?: number; error?: string }> {
  try {
    await requireSyncPermission()

    // o3d-0m56: refuse what the automatic enqueue refuses, and then some. Several FAILED rows
    // for one reference under DIFFERENT idempotency tokens mean any of them may have committed
    // remotely, so re-posting picks a token the ledger may never have seen and a second payment
    // lands. But an UNAMBIGUOUS money row is not safe either: by the time anyone clicks retry the
    // remote's deduplication window has closed, so the ledger itself has to say the attempt is
    // not already in it. The bulk path is the worst one — without this it re-queues every
    // ambiguous scope at once, each row under its own token.
    const candidates = await db.accountingSyncLog.findMany({
      where: entryId
        ? { id: entryId, connector: 'quickbooks', status: 'FAILED' as const }
        : { connector: 'quickbooks', status: 'FAILED' as const },
      select: { id: true, type: true, referenceType: true, referenceId: true, payload: true, createdAt: true },
      // OLDEST FIRST, and load-bearing: when only one row of a scope may be revived,
      // selectRevivableCandidates keeps the oldest postable one — the request a shared token
      // would return from the remote.
      orderBy: { createdAt: 'asc' },
    })
    if (candidates.length === 0) return { success: true, reset: 0 }

    const scopeKey = (row: { type: string; referenceType: string; referenceId: string }) =>
      `${row.type}\u0000${row.referenceType}\u0000${row.referenceId}`
    // Deduplicated by key but carrying the ORIGINAL typed row, so the Prisma filter keeps its
    // enum types rather than being rebuilt from split strings.
    const scopes = new Map<string, (typeof candidates)[number]>()
    for (const row of candidates) if (!scopes.has(scopeKey(row))) scopes.set(scopeKey(row), row)

    // SETTLEMENT EVIDENCE FIRST, and deliberately OUTSIDE every transaction below: this is a
    // network read of the connector's ledger, and holding a lock across it would let one
    // unreachable remote block the accounting queue for as long as its timeout. One probe per
    // target DOCUMENT, shared by every row that names it.
    const probes = new Map<string, LedgerSettlementProbe>()
    const ledgerByCandidate = new Map<string, LedgerSettlementProbe>()
    for (const candidate of candidates) {
      // Only money moves twice. A duplicate PDF or email is not a financial error, and probing
      // for one would put an API call behind every routine retry.
      if (!isMoneyMovingSyncType(candidate.type)) continue
      const key = settlementProbeKey(candidate)
      let probe = probes.get(key)
      if (!probe) {
        probe = await probeLedgerSettlement('quickbooks', candidate)
        probes.set(key, probe)
      }
      ledgerByCandidate.set(candidate.id, probe)
    }

    let reset = 0
    const refusedIds = new Set<string>()
    const refusals: string[] = []
    const refusedByScope = new Map<string, { reason: string; tokenCount: number; ids: string[]; siblingIds: string[] }>()

    // ONE TRANSACTION PER SCOPE, holding that scope's advisory lock across the sibling read, the
    // plan and the reset. Read-then-write is not enough on its own: a row queued for the same
    // document after the read — the receipt-registration path does exactly that — can reach
    // FAILED before the reset, and FAILED rows are outside the live-row unique index, so nothing
    // would object to reviving beside it under a second token (Codex review). Every enqueue
    // writer takes the same lock, so nothing can appear inside this window.
    //
    // Per scope rather than one transaction for all of them: a "Retry All" over many scopes would
    // otherwise hold every lock at once, and one bad scope would roll back the rest.
    for (const [key, scope] of [...scopes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const scopeCandidates = candidates.filter((row) => scopeKey(row) === key)
      const outcome = await db.$transaction(async (tx) => {
        await lockFollowUpScope(tx, { connector: 'quickbooks', ...scope })

        // Every row in this scope, at ANY status — not just FAILED, and not just the ones
        // selected. A single-row retry is only ambiguous relative to its SIBLINGS, which the id
        // filter above excludes; and restricting the snapshot to FAILED made the guard blind in
        // both directions (Codex review):
        //
        //   - a PENDING or PROCESSING sibling under a different token has not failed YET. An
        //     in-flight attempt is if anything MORE dangerous than a failed one, since it may
        //     still be mid-flight, and it also owns the scope's single live slot.
        //   - a SYNCED or CANCELLED sibling can also represent money already in the ledger.
        //     SYNCED obviously so; CANCELLED less obviously -- a row whose call COMMITTED but
        //     whose response was lost goes back to PENDING, and deleting the local receipt then
        //     cancels it. Neither is safe to drop; see followup-retry-guard.ts.
        const siblingRows = await tx.accountingSyncLog.findMany({
          where: {
            connector: 'quickbooks',
            type: scope.type,
            referenceType: scope.referenceType,
            referenceId: scope.referenceId,
          },
          select: { id: true, type: true, referenceType: true, referenceId: true, payload: true, status: true },
        })
        // Mapped ONCE per row rather than once per candidate: a scope with hundreds of rows made
        // the per-candidate loop quadratic in token derivation (Codex review).
        const siblings: RetryCandidateRow[] = siblingRows.map((row) => {
          const planned: RetryCandidateRow = {
            id: row.id,
            payload: row.payload,
            effectiveToken: effectiveTokenFor('quickbooks', row),
            // Carried for the live-sibling rule and the refusal message. It does NOT exclude a
            // row from the token set -- no status is safe to drop.
            status: row.status,
          }
          return planned
        })
        const siblingIds = siblingRows.map((row) => row.id)

        // Planned PER CANDIDATE, against that candidate's own siblings. An earlier revision
        // planned once per SCOPE from an arbitrary rows[0] and then refused every sibling id: with
        // one safe row targeting a replacement invoice and two ambiguous rows targeting the old
        // one, array order decided whether the ambiguous pair was allowed through or the safe row
        // was refused along with them (Codex review). A per-candidate decision cannot depend on
        // ordering, and refuses exactly the row it judged.
        const allowed: typeof scopeCandidates = []
        const refused: Array<{ id: string; reason: string; tokenCount: number }> = []
        for (const candidate of scopeCandidates) {
          const plan = planManualRetry({
            type: candidate.type,
            reference: `${candidate.referenceType} ${candidate.referenceId}`,
            target: {
              id: candidate.id,
              payload: candidate.payload,
              effectiveToken: effectiveTokenFor('quickbooks', candidate),
              status: 'FAILED', // the candidate query selects only FAILED rows
            },
            siblings,
            // Never an empty ledger by default. Unreachable today — the loop above probes for
            // exactly the types the guard reads a ledger for, both through isMoneyMovingSyncType
            // — so no mutation can make this branch fire, and it is deliberate defence rather
            // than tested behaviour: a money row with no reading means the probe did not run,
            // and that is not permission.
            ledger: ledgerByCandidate.get(candidate.id)
              ?? { ok: false, reason: 'no settlement check was made for this row' },
          })
          if (plan.action === 'refuse') refused.push({ id: candidate.id, reason: plan.reason, tokenCount: plan.tokenCount })
          else allowed.push(candidate)
        }

        // At most ONE row per scope may go live. Two same-token FAILED payments are both allowed
        // — they are not ambiguous — but reviving both makes two live rows, which the partial
        // unique index rejects: the whole updateMany rolls back and unrelated scopes in the same
        // click are reset too (Codex review). The others are deferred, not refused as unsafe.
        const { revive, deferred } = selectRevivableCandidates(scope.type, allowed)
        const allowedIds = revive.map((row) => row.id)
        for (const row of deferred) {
          refused.push({
            id: row.id,
            reason: deferredRevivalReason(`${row.referenceType} ${row.referenceId}`, allowedIds[0] ?? ''),
            tokenCount: 1,
          })
        }

        const result = allowedIds.length > 0
          ? await tx.accountingSyncLog.updateMany({
            where: { id: { in: allowedIds }, connector: 'quickbooks', status: 'FAILED' },
            data: { status: 'PENDING', retryCount: 0, errorMessage: null, processingStartedAt: null },
          })
          : { count: 0 }
        return { count: result.count, refused, siblingIds }
      })

      reset += outcome.count
      for (const entry of outcome.refused) {
        refusedIds.add(entry.id)
        if (!refusals.includes(entry.reason)) refusals.push(entry.reason)
        // Collected, then logged ONCE PER SCOPE below. One sequential write per refused
        // candidate produced N near-duplicate warnings before any allowed row was reset.
        const previous = refusedByScope.get(key)
        refusedByScope.set(key, {
          reason: previous?.reason ?? entry.reason,
          tokenCount: previous?.tokenCount ?? entry.tokenCount,
          ids: [...(previous?.ids ?? []), entry.id],
          siblingIds: outcome.siblingIds,
        })
      }
    }

    for (const [, entry] of refusedByScope) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'quickbooks_manual_retry_refused',
        tag: 'sync',
        level: 'WARNING',
        description: entry.reason,
        metadata: {
          syncLogIds: entry.ids,
          siblingIds: entry.siblingIds,
          tokenCount: entry.tokenCount,
        },
      })
    }

    if (reset === 0 && refusedIds.size > 0) {
      // Nothing to do and a reason worth showing: the single-row path returns it as the error
      // so the existing surfaces render it inline.
      // Sorted so the surfaced reason does not depend on candidate order — the decision never
      // did, but the MESSAGE did when several scopes were all refused (Codex review).
      return {
        success: false,
        reset: 0,
        refused: refusedIds.size,
        error: [...refusals].sort()[0] ?? 'Nothing to retry',
      }
    }

    await logActivity({
      entityType: 'SYSTEM',
      action: 'quickbooks_retry_failed',
      tag: 'sync',
      description: `Reset ${reset} failed QuickBooks sync entry/entries for retry`
        + (refusedIds.size > 0 ? `; left ${refusedIds.size} failed, each with a recorded reason` : ''),
    })
    revalidatePath('/sync')
    return { success: true, reset, ...(refusedIds.size > 0 ? { refused: refusedIds.size } : {}) }
  } catch (e) {
    return { success: false, reset: 0, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type QuickBooksSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
  /** Always empty: QuickBooks does not record its granted scopes (o3d-g2i is Xero-only). */
  missingScopes: string[]
}

const REQUIRED_ACCOUNTS: Array<{ key: keyof QuickBooksSettings; label: string }> = [
  { key: 'quickbooks_sales_account', label: 'Sales Revenue' },
  { key: 'quickbooks_shipping_account', label: 'Shipping Income' },
  { key: 'quickbooks_discount_account', label: 'Discounts Given' },
  { key: 'quickbooks_transit_account', label: 'Stock in Transit' },
  { key: 'quickbooks_inventory_account', label: 'Inventory Asset' },
  { key: 'quickbooks_allocated_inventory_account', label: 'Allocated Inventory' },
  { key: 'quickbooks_cogs_account', label: 'Cost of Goods Sold' },
  { key: 'quickbooks_unearned_revenue_account', label: 'Unearned Revenue' },
  { key: 'quickbooks_accounts_receivable_account', label: 'Accounts Receivable' },
  { key: 'quickbooks_accounts_payable_account', label: 'Accounts Payable' },
  { key: 'quickbooks_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss' },
  { key: 'quickbooks_unrealised_fx_gain_loss_account', label: 'Unrealised FX Gain/Loss' },
]

export async function getQuickBooksSyncReadiness(): Promise<QuickBooksSyncReadiness> {
  const [settings, connStatus, taxRates] = await Promise.all([
    getQuickBooksSettings(),
    isConnected(),
    db.taxRate.findMany({
      where: { active: true },
      select: { id: true, name: true, accountingTaxType: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const missingAccounts = REQUIRED_ACCOUNTS
    .filter(a => !settings[a.key])
    .map(a => ({ key: a.key as string, label: a.label }))

  const missingTaxTypes = taxRates
    .filter(r => !r.accountingTaxType)
    .map(r => ({ id: r.id, name: r.name }))

  return {
    ready: connStatus.connected && missingAccounts.length === 0 && missingTaxTypes.length === 0,
    notConnected: !connStatus.connected,
    missingAccounts,
    missingTaxTypes,
    // QuickBooks does not record its granted scopes (o3d-g2i covers Xero only). Empty means "nothing to
    // report", never "we checked and found none" — see AccountingSyncReadiness.
    missingScopes: [],
  }
}

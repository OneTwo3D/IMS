'use server'

import { freshAuthFailureResult, requireFreshPermission, requirePermission, requireRole } from '@/lib/auth/server'

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
import { getAuthorizationUrl, disconnect, isConnected, getGrantedScopes, missingScopes } from '@/lib/connectors/xero'
import { syncChartOfAccounts, getXeroTaxRates } from '@/lib/connectors/xero'
import { syncXeroAccountBalanceSnapshots } from '@/lib/connectors/xero/account-balances'
import { processPendingXeroSync } from '@/lib/connectors/xero'
import { getXeroSettings, XERO_SETTING_KEYS, type XeroSettings } from '@/lib/connectors/xero/settings'
import { buildAccountingCallbackUri } from '@/lib/accounting/callback-url'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { getSettingValue, maskSettingSecret, serializeSettingValue } from '@/lib/settings-store'
import { applyFencedAttemptDecision } from '@/lib/domain/accounting/sync-log-attempt'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { xeroGet } from '@/lib/connectors/xero/api'
import { isMaskedSecret, shouldFreshGateSecretWrite } from '@/lib/security/secret-mask'
import {
  assertIntegrationConnectionTestPassed,
  buildIntegrationConnectionFingerprint,
  getIntegrationConnectionTestState,
  integrationConnectionFingerprintSecret,
  recordIntegrationConnectionTest,
  type IntegrationConnectionTestState,
} from '@/lib/integration-connection-test-gate'

// Type re-export (allowed in 'use server' files)
export type { XeroSettings } from '@/lib/connectors/xero/settings'

/**
 * TWO GATES IN THIS FILE, AND THEY ANSWER TWO DIFFERENT QUESTIONS (o3d-512h round 3 + o3d-m3gy).
 *
 * WHAT ROUND 3 FIXED. The dispatcher note in app/actions/accounting-sync.ts justifies gating each
 * dispatcher on the LOOSEST of its two branches' gates by saying "the stricter branch keeps enforcing
 * its own on top", and names that stricter branch as the Xero one: "The Xero delegates use
 * requireRole('ADMIN')". They did not. This module's local helper was `requirePermission('sync')`
 * verbatim — identical to the dispatcher's own gate and to QuickBooks' — so a MANAGER passed the
 * dispatcher and then passed the delegate too, and the "reach change per principal" table's claim
 * that MANAGER "is still refused by the Xero delegate" was false for every export in this file. Round
 * 3 fixed that by making the code true rather than the sentence smaller.
 *
 * WHAT THE MERGE FOUND, AND WHY THE FIX IS NOW SCOPED (o3d-m3gy). Round 3 applied the ADMIN role to
 * EVERY export here, and stated the consequence as "MANAGER loses this tenant's Xero connection,
 * settings, sync logs and readiness — it keeps the whole QuickBooks branch". On current
 * `development` that second half is FALSE, and it is false for a reason that landed after round 3:
 * app/(dashboard)/sync/page.tsx now treats a denial from ANY of its reads as FATAL (o3d-osl8), on the
 * deliberate principle that a partial page is a dishonest answer to a denial. Seven of the page's
 * reads route through this module, so an ADMIN-only read surface does not narrow MANAGER's reach —
 * it replaces the whole /sync page with the generic error boundary, QuickBooks half included, and
 * gives an operator "Go to Login" / "Try Again" for a refusal no retry can clear. That is
 * tests/accounting/dashboard-read-gates.test.ts, and it is measuring a real user-visible outcome
 * rather than restating a policy.
 *
 * So the strictness goes where the claim actually lives. The dispatcher note's own words are
 * "saveXeroSettings → requireRole('ADMIN'), which still applies on its own path" and round 3's is
 * "connector OAuth credentials are ADMIN business" — both about the CREDENTIAL surface, not about
 * reading the connector's state:
 *
 *   requireSyncPermission        'sync'. The connector's STATE: settings (secret masked), connection
 *                                status, connection-test state, account list, tax rates, sync logs,
 *                                readiness, and running a sync. This is what the Integrations page
 *                                renders, and MANAGER holds 'sync'.
 *   requireXeroCredentialAdmin   'sync' AND the ADMIN role. Anything that WRITES the OAuth
 *                                credentials or exercises them to establish a connection. This is the
 *                                stricter frame the dispatcher note names, and it really does exist
 *                                now: tests/security/accounting-dispatcher-authorization.test.ts
 *                                asserts MANAGER through the dispatcher and refused by the delegate,
 *                                on a WRITE dispatcher.
 *
 * These are not two answers to one question — that is the defect this merge exists to remove. They
 * are the answers to "may this principal SEE the connector?" and "may it CHANGE the credentials?",
 * and conflating them is what made the note false in the first place.
 *
 * ON THE NAME. `development` had renamed the local `requireAdmin` to `requireSyncPermission`, because
 * `requireAdmin` SHADOWED `requireAdmin` from @/lib/auth/server and misled two separate review passes
 * into reporting that MANAGER crashes on the Integrations page — the reader saw `requireAdmin()` and
 * reasonably concluded ADMIN-only. That name is kept for the 'sync' gate, and the ADMIN one is named
 * for what it guards rather than for a role, so neither name can mislead the next reader the same way.
 */
async function requireSyncPermission() {
  return requirePermission('sync')
}

/**
 * The credential surface: 'sync' first, so a principal without it gets the NAMED permission denial
 * the refusal tests assert on (WAREHOUSE / READONLY / FINANCE / SUPPLIER), then the ADMIN role check,
 * which is the stricter claim and is what refuses MANAGER — MANAGER does hold 'sync'.
 */
async function requireXeroCredentialAdmin() {
  await requirePermission('sync')
  return requireRole('ADMIN')
}

/**
 * The credential surface, with a step-up re-auth on top. Every caller of this writes or revokes the
 * connection itself.
 *
 * Order matters: refuse on the STABLE facts (permission, then role) before asking for a step-up
 * re-auth. Prompting a MANAGER to re-authenticate for something no amount of re-authentication will
 * grant is a worse answer than "no".
 */
async function requireFreshXeroCredentialAdmin() {
  await requireXeroCredentialAdmin()
  return requireFreshPermission('sync')
}

// ---------------------------------------------------------------------------
// Settings (UI-facing server actions)
// ---------------------------------------------------------------------------

export async function getXeroSettingsMasked(): Promise<XeroSettings & { secretMasked: boolean }> {
  // o3d-1fel: returns xero_client_id in clear plus every account-mapping code.
  // Only xero_client_secret is masked, so masking is not the access control.
  await requireSyncPermission()
  const settings = await getXeroSettings()
  const masked = maskSettingSecret('xero_client_secret', settings.xero_client_secret)
  return { ...settings, xero_client_secret: masked, secretMasked: !!settings.xero_client_secret }
}

async function buildXeroConnectionFingerprint(): Promise<string> {
  const [clientId, clientSecret, expectedTenantId, token] = await Promise.all([
    getSettingValue('xero_client_id'),
    getSettingValue('xero_client_secret'),
    getSettingValue('xero_expected_tenant_id'),
    db.accountingToken.findUnique({
      where: { connector: 'xero' },
      select: { tenantId: true, tenantName: true },
    }),
  ])
  return buildIntegrationConnectionFingerprint({
    clientId: clientId ?? '',
    clientSecret: integrationConnectionFingerprintSecret(clientSecret ?? ''),
    expectedTenantId: expectedTenantId ?? '',
    tenantId: token?.tenantId ?? '',
    tenantName: token?.tenantName ?? '',
  })
}

export async function saveXeroSettings(data: Partial<XeroSettings>): Promise<{ success: boolean; error?: string }> {
  try {
    await requireXeroCredentialAdmin()
    if (shouldFreshGateSecretWrite(data, 'xero_client_secret')) {
      await requireFreshXeroCredentialAdmin()
    }

    // Only run the readiness gate when the user is *transitioning* sync from
    // OFF → ON. If sync is already enabled, allow any save to go through so the
    // user can edit (or fix) their account mappings without being blocked.
    if (data.xero_sync_enabled === 'true') {
      const currentEnabled = await getSettingValue('xero_sync_enabled')
      const isTransitioningOn = currentEnabled !== 'true'
      if (isTransitioningOn) {
        const testGate = await assertIntegrationConnectionTestPassed('xero', await buildXeroConnectionFingerprint(), 'Xero')
        if (!testGate.ok) return { success: false, error: testGate.error }

        const [imsBaseCurrency, orgRes] = await Promise.all([
          getBaseCurrencyCode(),
          xeroGet<{ Organisations?: Array<{ BaseCurrency?: string }>; Organisation?: Array<{ BaseCurrency?: string }> }>('Organisation'),
        ])
        const organisations = orgRes.data?.Organisations ?? orgRes.data?.Organisation ?? []
        const xeroBaseCurrency = organisations[0]?.BaseCurrency?.toUpperCase() ?? null
        if (!orgRes.ok || !xeroBaseCurrency) {
          return { success: false, error: 'Cannot enable Xero sync because the connected organisation base currency could not be determined.' }
        }
        if (xeroBaseCurrency !== imsBaseCurrency) {
          return { success: false, error: `Cannot enable Xero sync because the Xero organisation base currency (${xeroBaseCurrency}) does not match the IMS base currency (${imsBaseCurrency}).` }
        }
        const readiness = await getXeroSyncReadiness()
        if (!readiness.ready) {
          const reasons: string[] = []
          if (readiness.notConnected) reasons.push('not connected to Xero')
          if (readiness.missingAccounts.length > 0) {
            reasons.push(`missing account mappings (${readiness.missingAccounts.map(a => a.label).join(', ')})`)
          }
          if (readiness.missingTaxTypes.length > 0) {
            reasons.push(`missing Xero tax type on IMS VAT rates (${readiness.missingTaxTypes.map(t => t.name).join(', ')})`)
          }
          return { success: false, error: `Cannot enable Xero sync — ${reasons.join('; ')}.` }
        }
      }
    }

    // Don't overwrite secret with masked value
    const entries = Object.entries(data).filter(([k, v]) => {
      if (!XERO_SETTING_KEYS.includes(k)) return false
      if (k === 'xero_client_secret' && isMaskedSecret(v)) return false
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
      action: 'xero_settings_updated',
      tag: 'sync',
      description: 'Updated Xero sync settings',
      metadata: { keys: entries.map(([k]) => k) },
    })
    revalidatePath('/sync')
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

export async function getXeroConnectionTestState(): Promise<IntegrationConnectionTestState> {
  await requireSyncPermission()
  return getIntegrationConnectionTestState('xero')
}

export async function testXeroConnection(): Promise<{ success: boolean; error?: string; message?: string }> {
  await requireXeroCredentialAdmin()

  const fingerprint = await buildXeroConnectionFingerprint()
  const [imsBaseCurrency, orgRes] = await Promise.all([
    getBaseCurrencyCode(),
    xeroGet<{ Organisations?: Array<{ Name?: string; BaseCurrency?: string }>; Organisation?: Array<{ Name?: string; BaseCurrency?: string }> }>('Organisation'),
  ])
  const organisations = orgRes.data?.Organisations ?? orgRes.data?.Organisation ?? []
  const organisation = organisations[0]
  const xeroBaseCurrency = organisation?.BaseCurrency?.toUpperCase() ?? null
  let message: string
  let success = false

  if (!orgRes.ok || !xeroBaseCurrency) {
    message = 'Cannot verify Xero because the connected organisation base currency could not be determined.'
  } else if (xeroBaseCurrency !== imsBaseCurrency) {
    message = `Xero organisation base currency (${xeroBaseCurrency}) does not match the IMS base currency (${imsBaseCurrency}).`
  } else {
    success = true
    message = `Connection verified against Xero${organisation?.Name ? ` (${organisation.Name})` : ''}.`
  }

  await recordIntegrationConnectionTest('xero', { success, fingerprint, message })
  revalidatePath('/sync')
  return success ? { success, message } : { success, error: message }
}

export async function saveXeroConnectionSettings(
  clientId: string,
  clientSecret: string,
): Promise<{ success: boolean; error?: string; message?: string }> {
  try {
    await requireFreshXeroCredentialAdmin()

    const nextClientId = clientId.trim()
    const nextClientSecretInput = clientSecret.trim()
    const nextClientSecret = isMaskedSecret(nextClientSecretInput) ? '' : nextClientSecretInput
    const existingSettings = await getXeroSettings()
    const resolvedSecret = nextClientSecret || existingSettings.xero_client_secret.trim()

    if (!nextClientId) {
      return { success: false, error: 'Xero Client ID is required.' }
    }

    if (!resolvedSecret) {
      return { success: false, error: 'Xero Client Secret is required.' }
    }

    const publicAppUrl = await getPublicAppUrl()
    if (!publicAppUrl) {
      return { success: false, error: 'Public app URL is not configured.' }
    }

    const redirectUri = buildAccountingCallbackUri(publicAppUrl)
    if (!redirectUri) {
      return { success: false, error: 'Xero redirect URL is invalid.' }
    }

    const ops = [
      db.setting.upsert({
        where: { key: 'xero_client_id' },
        create: { key: 'xero_client_id', value: serializeSettingValue('xero_client_id', nextClientId) },
        update: { value: serializeSettingValue('xero_client_id', nextClientId) },
      }),
    ]

    if (nextClientSecret) {
      ops.push(
        db.setting.upsert({
          where: { key: 'xero_client_secret' },
          create: { key: 'xero_client_secret', value: serializeSettingValue('xero_client_secret', nextClientSecret) },
          update: { value: serializeSettingValue('xero_client_secret', nextClientSecret) },
        }),
      )
    }

    await db.$transaction(ops)

    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_connection_settings_updated',
      tag: 'sync',
      description: 'Updated Xero connection settings',
    })

    revalidatePath('/sync')
    revalidatePath('/onboarding')
    return { success: true, message: 'Connection settings saved. OAuth redirect is ready.' }
  } catch (error) {
    // audit-ohou: surface the fresh-auth gate as a structured failure so the
    // accounting delegator + client can step-up re-auth and retry.
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    return { success: false, error: String(error) }
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getXeroConnectionStatus(): Promise<{
  connected: boolean
  tenantName?: string
  blockedReason?: string
  hasStoredToken?: boolean
}> {
  // o3d-1fel: leaks the connected tenant NAME, not just a boolean.
  await requireSyncPermission()
  return isConnected()
}

export async function connectXero(
  clientId: string,
  clientSecret: string,
  origin: string,
  returnPath?: string,
): Promise<{ success: boolean; redirectUrl?: string; error?: string }> {
  try {
    void origin
    const session = await requireFreshXeroCredentialAdmin()

    // Save credentials (never overwrite secret with masked value)
    const ops = [
      db.setting.upsert({ where: { key: 'xero_client_id' }, create: { key: 'xero_client_id', value: serializeSettingValue('xero_client_id', clientId) }, update: { value: serializeSettingValue('xero_client_id', clientId) } }),
    ]
    if (clientSecret && !isMaskedSecret(clientSecret)) {
      ops.push(db.setting.upsert({ where: { key: 'xero_client_secret' }, create: { key: 'xero_client_secret', value: serializeSettingValue('xero_client_secret', clientSecret) }, update: { value: serializeSettingValue('xero_client_secret', clientSecret) } }))
    }
    await db.$transaction(ops)

    // Build Xero authorization URL — user's browser will redirect here.
    // `state` is persisted server-side bound to the initiating user and
    // validated in the callback (CSRF / mix-up protection).
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
    const freshAuthFailure = freshAuthFailureResult(e)
    if (freshAuthFailure) return freshAuthFailure
    return { success: false, error: String(e) }
  }
}

export async function disconnectXero(): Promise<{ success: boolean; error?: string }> {
  try {
    await requireFreshXeroCredentialAdmin()
    await disconnect()

    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_disconnected',
      tag: 'sync',
      description: 'Disconnected from Xero',
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

export async function syncAccountingAccounts(): Promise<{ synced: number; errors: string[] }> {
  await requireSyncPermission()
  const result = await syncChartOfAccounts()

  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_accounts_synced',
    tag: 'sync',
    description: `Synced ${result.synced} accounts from Xero`,
    metadata: result,
  })

  revalidatePath('/sync')
  return result
}

export async function syncAccountingAccountBalanceSnapshots(balanceDate?: string): Promise<{ fetched: number; persisted: number; skipped: number; errors: string[] }> {
  await requireRole('ADMIN', 'FINANCE')
  const result = await syncXeroAccountBalanceSnapshots({ balanceDate })
  const hasErrors = result.errors.length > 0
  const hasSkipped = result.skipped > 0

  await logActivity({
    entityType: 'SYSTEM',
    action: 'accounting_account_balance_snapshots_synced',
    tag: 'sync',
    level: hasErrors ? 'ERROR' : hasSkipped ? 'WARNING' : 'INFO',
    description: hasErrors
      ? `Synced ${result.persisted} account balance snapshots from Xero with ${result.errors.length} error(s)`
      : `Synced ${result.persisted} account balance snapshots from Xero`,
    metadata: { balanceDate: balanceDate ?? null, ...result },
  })

  revalidatePath('/sync')
  revalidatePath('/analytics/inventory-valuation')
  revalidatePath('/analytics/cogs')
  return result
}

export async function getAccountingAccounts(): Promise<Array<{ id: string; externalAccountId: string; code: string | null; name: string; type: string }>> {
  // o3d-1fel: this reads the chart of accounts straight out of the database. A
  // single-statement `return db.<model>.findMany(...)` is NOT a delegating
  // facade — there is no downstream guard to inherit.
  await requireSyncPermission()
  return db.accountingAccount.findMany({
    where: { connector: 'xero', active: true },
    select: { id: true, externalAccountId: true, code: true, name: true, type: true },
    orderBy: [{ code: 'asc' }],
  })
}

export async function fetchXeroTaxRates(
  opts?: { allowCache?: boolean },
): Promise<Array<{ taxType: string; name: string; rate: number }>> {
  // o3d-1fel: makes a LIVE outbound call to the tenant's Xero org, so leaving
  // it open is request amplification as well as a data leak.
  await requireSyncPermission()
  const result = await getXeroTaxRates(opts)
  return result?.taxRates ?? []
}

// ---------------------------------------------------------------------------
// Sync Logs
// ---------------------------------------------------------------------------

export type XeroSyncLogRow = {
  id: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  retryCount: number
  /**
   * o3d-e2mz: which attempt this row is currently on. Any operator decision taken about what this
   * row shows must carry this value back, so the decision can be refused when the row has moved on
   * to a different attempt since it was read. 0 means no fence-aware processor has ever claimed it.
   */
  attemptRevision: number
  syncedAt: string | null
  createdAt: string
}

export async function getXeroSyncLogs(limit = 50): Promise<XeroSyncLogRow[]> {
  // o3d-1fel: sync-log rows carry referenceId / externalTransactionId / errorMessage.
  await requireSyncPermission()
  const rows = await db.accountingSyncLog.findMany({
    where: { connector: 'xero' },
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
    attemptRevision: r.attemptRevision,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Manual Sync
// ---------------------------------------------------------------------------

export async function triggerXeroSync(): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    await requireSyncPermission()

    const enabled = await db.setting.findUnique({ where: { key: 'xero_sync_enabled' } })
    if (enabled?.value !== 'true') {
      return { success: false, error: 'Xero sync is not enabled' }
    }

    const result = await processPendingXeroSync()
    // audit-H3: also repair any documents missing their back-reference.
    // audit-w77e: and enqueue allocations for credit notes whose bill synced late.
    let backReferenceRepair: unknown
    let creditNoteAllocationReenqueue: unknown
    try {
      const { repairXeroBackReferences, reenqueueMissingCreditNoteAllocations } = await import('@/lib/connectors/xero/sync-processor')
      backReferenceRepair = await repairXeroBackReferences()
      // Codex review (w77e): surface the sweep result so per-item failures aren't
      // silently swallowed by the manual path (the cron already returns it).
      creditNoteAllocationReenqueue = await reenqueueMissingCreditNoteAllocations()
    } catch (repairError) {
      console.error('Manual Xero sync: back-reference repair / allocation re-enqueue failed', repairError)
    }

    await logActivity({
      entityType: 'SYSTEM',
      action: 'xero_manual_sync',
      tag: 'sync',
      description: `Manual Xero sync: ${result.succeeded} synced, ${result.failed} failed`,
      metadata: { ...result, backReferenceRepair, creditNoteAllocationReenqueue },
    })

    revalidatePath('/sync')
    return { success: true, result }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * o3d-e2mz: what to TELL an operator whose per-row retry lost the attempt fence.
 *
 * Only the unfenced case needs anything added: a row at revision 0 can never be retried per-row, so a
 * bare "cannot be tied to an attempt" reads as a dead end. Naming the bulk path is the difference
 * between a refusal they can act on and one they cannot.
 */
function attemptFenceRefusalMessage(outcome: { reason: string; message: string }): string {
  return outcome.reason === 'UNFENCED_ATTEMPT'
    ? `${outcome.message} "Retry All" is deliberately unfenced and still re-queues it.`
    : outcome.message
}

/**
 * Recorded under its own action, NOT under `xero_manual_retry_refused` (o3d-0m56's name).
 *
 * The two refusals ask an operator for different things — "this decision is about an attempt that no
 * longer exists, reload and look" versus "this money may already be in the ledger, reconcile it" — and
 * filing them together would make every stale click look like a payment hazard.
 */
async function logAttemptFenceRefusal(
  entryId: string,
  expectedAttemptRevision: number | undefined,
  reason: string,
  message: string,
): Promise<void> {
  await logActivity({
    entityType: 'SYSTEM',
    action: 'xero_retry_failed_refused',
    tag: 'sync',
    level: 'WARNING',
    description: `Refused a Xero sync retry for ${entryId}: ${message}`,
    metadata: { syncLogId: entryId, reason, expectedAttemptRevision },
  })
}

/**
 * Reset failed Xero sync rows so the processor picks them up again.
 *
 * TWO FENCES, ASKING DIFFERENT QUESTIONS, AND A ROW MUST PASS BOTH (o3d-0m56 + o3d-e2mz).
 *
 *   o3d-0m56 asks MAY THIS BE RE-POSTED AT ALL. Several FAILED rows for one reference under
 *   DIFFERENT idempotency tokens mean any of them may have committed remotely, so re-posting picks a
 *   token the ledger may never have seen and a second payment lands. And an UNAMBIGUOUS money row is
 *   not safe either: by the time anyone clicks retry the remote deduplication window has closed, so
 *   the ledger itself has to say the attempt is not already in it.
 *
 *   o3d-e2mz asks WHICH ATTEMPT THIS DECISION IS ABOUT. Without it the CAS was `(id, FAILED)`, and
 *   status is not an identity: the reset can land on a LATER failure than the one the operator
 *   judged, or on a failure of an attempt that posted a document they never saw.
 *
 * Neither implies the other. The first can clear a row whose attempt has since moved on; the second
 * can be perfectly current about an attempt that must not be re-sent. So the per-row path runs the
 * o3d-0m56 plan and then lands its reset through `applyFencedAttemptDecision` rather than a bare
 * updateMany — one write, both preconditions.
 *
 * A per-row request that names no attempt is REFUSED rather than run unfenced, which is the rule
 * applyFencedAttemptDecision applies to revision 0 for the same reason: a decision that cannot be
 * tied to an attempt cannot be shown to be about the row it will hit.
 *
 * BULK ("Retry All", no entryId) takes the o3d-0m56 guard — it is the path that most needs it, since
 * unguarded it re-queues every ambiguous scope at once, each row under its own token — and is
 * deliberately NOT attempt-fenced: it is not a judgement about any particular attempt, only
 * "re-queue whatever is failed now", and every row it touches goes FAILED -> PENDING, a status change
 * a later fenced decision already detects (STATUS_MOVED). Getting back to FAILED requires a claim,
 * which mints a new revision, so a stale decision cannot survive the round trip either.
 */
export async function retryFailedXeroSync(
  entryId?: string,
  expectedAttemptRevision?: number,
): Promise<{ success: boolean; reset: number; refused?: number; error?: string }> {
  try {
    await requireSyncPermission()

    // o3d-e2mz PREFLIGHT, before the o3d-0m56 machinery: both are cheap point reads, and a request
    // that cannot name its attempt is refused without probing a ledger on its behalf.
    if (entryId) {
      if (expectedAttemptRevision === undefined) {
        return {
          success: false,
          reset: 0,
          error: `Retrying Xero sync row ${entryId} needs the attempt it was requested about, and none was `
            + 'supplied, so it was NOT retried. Reload the sync log and retry from what it shows.',
        }
      }
      // The fence CAS cannot also carry `connector`, and a connector never changes, so check it here.
      // Without it an id belonging to another connector would be re-queued as if it were Xero's — and
      // the candidate query below would simply return nothing, reporting a foreign id as "0 reset,
      // success", which is the silent outcome this whole action exists to stop producing.
      const row = await db.accountingSyncLog.findUnique({
        where: { id: entryId },
        select: { connector: true },
      })
      if (!row) {
        return { success: false, reset: 0, error: `Accounting sync row ${entryId} no longer exists, so it was NOT retried.` }
      }
      if (row.connector !== 'xero') {
        return {
          success: false,
          reset: 0,
          error: `Accounting sync row ${entryId} belongs to the ${row.connector} connector, not Xero, so it was NOT retried.`,
        }
      }
    }

    // o3d-0m56: refuse what the automatic enqueue refuses, and then some. Several FAILED rows
    // for one reference under DIFFERENT idempotency tokens mean any of them may have committed
    // remotely, so re-posting picks a token the ledger may never have seen and a second payment
    // lands. But an UNAMBIGUOUS money row is not safe either: by the time anyone clicks retry the
    // remote's deduplication window has closed, so the ledger itself has to say the attempt is
    // not already in it. The bulk path is the worst one — without this it re-queues every
    // ambiguous scope at once, each row under its own token.
    const candidates = await db.accountingSyncLog.findMany({
      where: entryId
        ? { id: entryId, connector: 'xero', status: 'FAILED' as const }
        : { connector: 'xero', status: 'FAILED' as const },
      select: { id: true, type: true, referenceType: true, referenceId: true, payload: true, createdAt: true },
      // OLDEST FIRST, and load-bearing: when only one row of a scope may be revived,
      // selectRevivableCandidates keeps the oldest postable one — the request a shared token
      // would return from the remote.
      orderBy: { createdAt: 'asc' },
    })
    if (candidates.length === 0) {
      // A BULK sweep with nothing failed is a genuine no-op. A PER-ROW request is not: the operator
      // asked about a specific row, and the candidate query is filtered to `status: FAILED`, so
      // "no candidates" means the row exists (the preflight just read it) but has moved off FAILED.
      // Returning success/0 here would report a refusal as a no-op — the o3d-e2mz defect wearing the
      // o3d-0m56 filter. The fence is run precisely to produce the reason: its CAS cannot match, and
      // it reads the row to say whether the STATUS or the ATTEMPT moved.
      if (entryId === undefined || expectedAttemptRevision === undefined) return { success: true, reset: 0 }
      const outcome = await applyFencedAttemptDecision(db, {
        id: entryId,
        expectedAttemptRevision,
        expectedStatus: 'FAILED',
        data: { status: 'PENDING', retryCount: 0, errorMessage: null, processingStartedAt: null },
      })
      if (outcome.ok) return { success: true, reset: 1 }
      const message = attemptFenceRefusalMessage(outcome)
      await logAttemptFenceRefusal(entryId, expectedAttemptRevision, outcome.reason, message)
      return { success: false, reset: 0, error: message }
    }

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
        probe = await probeLedgerSettlement('xero', candidate)
        probes.set(key, probe)
      }
      ledgerByCandidate.set(candidate.id, probe)
    }

    let reset = 0
    /**
     * o3d-e2mz: the attempt-fence refusal, if the per-row write hit one. Logged after the loop.
     *
     * A REF CELL rather than a bare `let`, because the assignment happens inside the transaction
     * callback below and TypeScript's control-flow analysis does not follow a closure write — it
     * narrows the outer binding to `null` at the read site and the refusal becomes unreachable code
     * that still compiles. A property on an object is not narrowed that way.
     */
    const attemptFence: { refusal: { reason: string; message: string } | null } = { refusal: null }
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
        await lockFollowUpScope(tx, { connector: 'xero', ...scope })

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
            connector: 'xero',
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
            effectiveToken: effectiveTokenFor('xero', row),
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
              effectiveToken: effectiveTokenFor('xero', candidate),
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

        // THE WRITE CARRIES BOTH FENCES (o3d-0m56 + o3d-e2mz).
        //
        // Everything above decided WHETHER these rows may be re-posted. The per-row path must also
        // land on the attempt the operator judged, so its reset goes through the attempt fence rather
        // than the `(id, FAILED)` compare-and-set — status is not an identity, and a row that failed
        // again between the operator reading it and clicking retry is a different attempt wearing the
        // same status. `allowedIds` holds at most one id here: the candidate query is filtered to
        // `entryId`.
        //
        // The bulk path keeps the plain updateMany, deliberately (see the header): it makes no claim
        // about any particular attempt, and fencing it would refuse every row that has never been
        // fence-claimed while giving nothing back.
        let result: { count: number }
        if (allowedIds.length === 0) {
          result = { count: 0 }
        } else if (entryId !== undefined && expectedAttemptRevision !== undefined) {
          const fenced = await applyFencedAttemptDecision(tx, {
            id: allowedIds[0],
            expectedAttemptRevision,
            expectedStatus: 'FAILED',
            data: { status: 'PENDING', retryCount: 0, errorMessage: null, processingStartedAt: null },
          })
          result = { count: fenced.ok ? 1 : 0 }
          if (!fenced.ok) {
            // Counted through the SAME `refused` channel as the o3d-0m56 verdicts, so the caller is
            // never told "0 reset" with no reason — but recorded under its OWN activity action
            // (below), because the two refusals need different things from an operator and one name
            // covering both would make an attempt that moved read as a money hazard.
            attemptFence.refusal = {
              reason: fenced.reason,
              message: attemptFenceRefusalMessage(fenced),
            }
            refused.push({ id: allowedIds[0], reason: attemptFence.refusal.message, tokenCount: 1 })
          }
        } else {
          result = await tx.accountingSyncLog.updateMany({
            where: { id: { in: allowedIds }, connector: 'xero', status: 'FAILED' },
            data: { status: 'PENDING', retryCount: 0, errorMessage: null, processingStartedAt: null },
          })
        }
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

    if (attemptFence.refusal && entryId !== undefined) {
      await logAttemptFenceRefusal(entryId, expectedAttemptRevision, attemptFence.refusal.reason, attemptFence.refusal.message)
    }

    for (const [, entry] of refusedByScope) {
      await logActivity({
        entityType: 'SYSTEM',
        action: 'xero_manual_retry_refused',
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
      action: 'xero_retry_failed',
      tag: 'sync',
      description: `Reset ${reset} failed Xero sync entry/entries for retry`
        + (refusedIds.size > 0 ? `; left ${refusedIds.size} failed, each with a recorded reason` : ''),
    })
    revalidatePath('/sync')
    return { success: true, reset, ...(refusedIds.size > 0 ? { refused: refusedIds.size } : {}) }
  } catch (e) {
    return { success: false, reset: 0, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// Readiness check — validate before allowing Xero sync to be enabled
// ---------------------------------------------------------------------------

export type XeroSyncReadiness = {
  ready: boolean
  notConnected: boolean
  missingAccounts: Array<{ key: string; label: string }>
  missingTaxTypes: Array<{ id: string; name: string }>
  /**
   * Scopes this connection was asked for but NOT granted (o3d-g2i). Empty when the grant is complete —
   * and also when it was never recorded, because unknown must never be reported as missing.
   */
  missingScopes: string[]
}

const REQUIRED_ACCOUNTS: Array<{ key: keyof XeroSettings; label: string }> = [
  { key: 'xero_sales_account', label: 'Sales Revenue' },
  { key: 'xero_shipping_account', label: 'Shipping Income' },
  { key: 'xero_discount_account', label: 'Discounts Given' },
  { key: 'xero_transit_account', label: 'Stock in Transit' },
  { key: 'xero_inventory_account', label: 'Inventory Asset' },
  { key: 'xero_allocated_inventory_account', label: 'Allocated Inventory' },
  { key: 'xero_cogs_account', label: 'Cost of Goods Sold' },
  { key: 'xero_unearned_revenue_account', label: 'Unearned Revenue' },
  { key: 'xero_accounts_receivable_account', label: 'Accounts Receivable' },
  { key: 'xero_accounts_payable_account', label: 'Accounts Payable' },
  { key: 'xero_realised_fx_gain_loss_account', label: 'Realised FX Gain/Loss' },
  { key: 'xero_unrealised_fx_gain_loss_account', label: 'Unrealised FX Gain/Loss' },
]

export async function getXeroSyncReadiness(): Promise<XeroSyncReadiness> {
  // o3d-1fel: reads settings + tax rates + the granted OAuth scopes.
  await requireSyncPermission()
  const [settings, connStatus, taxRates, granted] = await Promise.all([
    getXeroSettings(),
    isConnected(),
    db.taxRate.findMany({
      where: { active: true },
      select: { id: true, name: true, accountingTaxType: true },
      orderBy: { name: 'asc' },
    }),
    getGrantedScopes(),
  ])

  const missingAccounts = REQUIRED_ACCOUNTS
    .filter(a => !settings[a.key])
    .map(a => ({ key: a.key as string, label: a.label }))

  const missingTaxTypes = taxRates
    .filter(r => !r.accountingTaxType)
    .map(r => ({ id: r.id, name: r.name }))

  // Deliberately NOT part of `ready`: an incomplete grant does not stop invoices or bills posting, it
  // stops the specific syncs that need the missing scope. Blocking the whole connector over it would be a
  // worse outage than the fault. It is surfaced as its own warning with the one action that fixes it.
  const missing = missingScopes(granted)

  return {
    ready: connStatus.connected && missingAccounts.length === 0 && missingTaxTypes.length === 0,
    notConnected: !connStatus.connected,
    missingAccounts,
    missingTaxTypes,
    missingScopes: missing,
  }
}

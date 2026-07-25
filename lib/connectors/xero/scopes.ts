/**
 * What Xero was ASKED for, what it actually GRANTED, and which syncs need which (o3d-g2i).
 *
 * Adding a scope to the authorization URL only affects FUTURE consents. An existing refresh token keeps
 * the grant it was minted with, so an installation that never reconnects goes on 401ing
 * `AuthorizationUnsuccessful` on exactly the calls the new scope covers — while every other sync looks
 * perfectly healthy. That is how the payment scope shipped and stayed broken: invoices and bills posted,
 * were marked paid locally, and were never settled in Xero (PR #530, o3d-lgo.11).
 *
 * So the granted scopes are recorded at token exchange and checked before a scope-dependent sync runs.
 * The check FAILS OPEN when the grant is unknown — a token stored before this existed has no record, and
 * refusing to sync on that basis would break every installation on upgrade. Unknown means "carry on and
 * let Xero answer"; only a grant we have positively read and found wanting stops anything.
 */

/** Every scope the consent screen asks for. The single source of truth for the authorization URL. */
export const XERO_REQUESTED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.settings',
  'accounting.contacts',
  'accounting.invoices',
  // REQUIRED to POST /Payments — registering a customer payment against a sales invoice
  // (INVOICE_PAYMENT) or a supplier payment against a bill (BILL_PAYMENT). accounting.invoices covers
  // invoices and credit notes but NOT payments.
  'accounting.payments',
  'accounting.manualjournals',
  'accounting.attachments',
] as const

export const XERO_SCOPE_STRING = XERO_REQUESTED_SCOPES.join(' ')

/**
 * The Xero scope each sync type needs beyond the baseline.
 *
 * Only the types whose failure mode is a scope 401 are listed; anything absent needs nothing special.
 * Keep this keyed on the sync type rather than on the HTTP call, because the sync type is what a FAILED
 * row records — which is what makes "these failed for a missing scope, retry them after reconnecting"
 * answerable.
 */
const PAYMENTS = 'accounting.payments'
const JOURNALS = 'accounting.manualjournals'
const ATTACHMENTS = 'accounting.attachments'

const SCOPE_BY_SYNC_TYPE: Record<string, string> = {
  // POST /Payments
  INVOICE_PAYMENT: PAYMENTS,
  BILL_PAYMENT: PAYMENTS,
  // POST /Attachments
  BILL_ATTACHMENT: ATTACHMENTS,
  // Every type routed to pushManualJournal by the processor's journal case — kept in step with it.
  COGS_JOURNAL: JOURNALS,
  INVENTORY_ADJUSTMENT: JOURNALS,
  STOCK_IN_TRANSIT: JOURNALS,
  STOCK_RECEIPT: JOURNALS,
  COGS_REVERSAL: JOURNALS,
  STOCK_ALLOCATION: JOURNALS,
  DAILY_BATCH_REVENUE_DEFERRAL: JOURNALS,
  DAILY_BATCH_INVENTORY_ALLOC: JOURNALS,
  DAILY_BATCH_GROUP_B: JOURNALS,
  DAILY_BATCH_INVENTORY_RECONCILIATION: JOURNALS,
  DAILY_BATCH_COGS_RECONCILIATION: JOURNALS,
  DAILY_BATCH_TRANSIT_RECONCILIATION: JOURNALS,
  UNEARNED_REV_REVERSAL: JOURNALS,
  REALISED_FX_JOURNAL: JOURNALS,
  UNREALISED_FX_JOURNAL: JOURNALS,
  MANUFACTURING_JOURNAL: JOURNALS,
  MANUFACTURING_RECLASS: JOURNALS,
}

/** The scope this sync type needs, or null when it rides on the baseline grant. */
export function requiredScopeForSyncType(type: string): string | null {
  return SCOPE_BY_SYNC_TYPE[type] ?? null
}

/**
 * Scopes that ENTAIL others.
 *
 * Xero's broad legacy scopes are still valid — `accounting.transactions` remains accepted through
 * September 2027 and authorises the granular transactional endpoints. A connection holding it would
 * otherwise be judged as missing `accounting.payments` and have every payment row blocked, even though
 * Xero would happily accept them: a compatibility outage manufactured by our own check.
 *
 * Entailment only ever ADDS. An incomplete map can therefore under-warn (we let a call through and Xero
 * answers, which is exactly the old behaviour) but can never wrongly block — the safe direction, and the
 * reason this is a permissive override rather than an authoritative model of Xero's scope tree.
 */
const SCOPE_ENTAILMENT: Record<string, readonly string[]> = {
  'accounting.transactions': ['accounting.invoices', 'accounting.payments', 'accounting.manualjournals'],
  'accounting.transactions.read': ['accounting.invoices'],
}

/** Expand a grant through the entailments above, so a broad scope satisfies the granular ones. */
function expand(granted: readonly string[]): Set<string> {
  const out = new Set(granted)
  for (const s of granted) for (const implied of SCOPE_ENTAILMENT[s] ?? []) out.add(implied)
  return out
}

/**
 * The scopes a token response actually reports, as a canonical space-separated string.
 *
 * Xero's auth-code response does not GUARANTEE a top-level `scope` field, and where it appears it may be
 * a string or an array. The authoritative list is the `scope` claim inside the access-token JWT. Reading
 * only the top-level field meant a perfectly good reconnect could persist null — and null fails open, so
 * validation would stay switched off precisely on the connection someone had just fixed.
 *
 * Returns null only when neither source yields anything, which is a genuine "unknown".
 */
export function scopesFromTokenResponse(
  data: { scope?: string | string[]; access_token?: string } | null | undefined,
): string | null {
  const fromField = normalizeScopeValue(data?.scope)
  if (fromField) return fromField

  const jwt = data?.access_token
  if (!jwt) return null
  try {
    const [, payload] = jwt.split('.')
    if (!payload) return null
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { scope?: string | string[] }
    return normalizeScopeValue(json.scope)
  } catch {
    // An opaque or malformed token is not a reason to fail a connection that Xero just accepted.
    return null
  }
}

function normalizeScopeValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const joined = value.filter((s) => typeof s === 'string' && s.trim()).join(' ')
    return joined || null
  }
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

/** Parse a stored grant. `null` (never recorded) stays null — it is not the same as "granted nothing". */
export function parseGrantedScopes(raw: string | null | undefined): string[] | null {
  if (raw == null) return null
  const scopes = raw.split(/\s+/).filter(Boolean)
  return scopes.length ? scopes : []
}

/**
 * Which of the requested scopes this connection does NOT have.
 *
 * `granted === null` means the grant was never recorded, and returns [] — see the header: unknown must
 * never block. An empty ARRAY is different: it is a positively-read grant of nothing, and everything is
 * missing.
 */
export function missingScopes(granted: string[] | null, required: readonly string[] = XERO_REQUESTED_SCOPES): string[] {
  if (granted === null) return []
  const have = expand(granted)
  return required.filter((s) => !have.has(s))
}

/**
 * Can this sync type run on this grant? Returns the missing scope, or null if it can.
 *
 * Used to fail a queued row with something an operator can act on — "reconnect Xero to grant
 * accounting.payments" — instead of the bare `401 AuthorizationUnsuccessful` that says nothing about
 * which of the dozen possible causes it is.
 */
export function blockingScopeFor(type: string, granted: string[] | null): string | null {
  const required = requiredScopeForSyncType(type)
  if (!required || granted === null) return null
  return expand(granted).has(required) ? null : required
}

/** The message a scope-blocked sync row carries. Recognisable, so the retry path can find these rows. */
export const SCOPE_RECONSENT_PREFIX = 'REQUIRES RECONNECT'

export function scopeBlockedError(type: string, scope: string): string {
  return (
    `${SCOPE_RECONSENT_PREFIX}: this Xero connection was authorised without the "${scope}" scope, which ` +
    `${type} needs. The scope was added to the app after this connection was made, and a refreshed token ` +
    `keeps its original grant — so reconnect Xero (Settings → Sync → Xero → Reconnect) to re-consent. ` +
    `Nothing was sent; retry this row after reconnecting.`
  )
}

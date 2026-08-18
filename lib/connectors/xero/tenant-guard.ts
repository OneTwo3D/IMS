/**
 * Which Xero organisation this instance is allowed to connect to, and how a refusal is worded (o3d-9tbz).
 *
 * THE INCIDENT (o3d-t74p). `selectTenantConnection` used to be:
 *
 *   if (!expectedTenantId) return connections[0] ?? null
 *
 * `xero_expected_tenant_id` is a database setting, so a FRESH database — a new e2e rig, a reset, a
 * restored dump — has no pin, and the very first connection therefore took whatever organisation the
 * consent happened to list first. An operator with access to both the production org and Demo consented
 * on the e2e rig, production sorted first, and the rig invoiced into the LIVE ledger: 553 objects, 150
 * invoices, 111 contacts, 217 items, 14 payments, cleaned up by hand.
 *
 * TWO LAYERS, because either alone leaves a hole:
 *
 *  1. An env allow-list (XERO_ALLOWED_TENANT_IDS / XERO_ALLOWED_TENANT_NAMES). Env is the ONLY control
 *     that survives a database reset, which is precisely the state that made the incident possible. It
 *     is enforced at the callback (nothing is stored) AND every time the stored token is used — because
 *     in the incident the callback ran once and the damage was done by the days of syncs afterwards,
 *     which never touch the callback at all. A restored production dump on the e2e rig arrives with a
 *     live token already in the database and no callback in sight; only the read-time check sees it.
 *  2. No silent `connections[0]`. With no pin and MORE THAN ONE organisation offered, IMS refuses and
 *     makes the operator choose. A single-organisation consent still proceeds untouched, so ordinary
 *     first-time setup — the overwhelmingly common case, and one this must not break — is unaffected.
 *
 * Both refusals name every organisation they saw, with ids, and say what to do next: an operator who
 * cannot act on the message is no better off than one who was never told.
 *
 * THE PHANTOM CONTROL. `XERO_TENANT_ID` shipped in `.env.example`, `scripts/install.sh` and `CLAUDE.md`
 * from long before any of this, and NOTHING ever read it. An operator who set it to their live org had
 * every reason to believe the tenant was pinned and was in fact completely unprotected — strictly worse
 * than no setting at all, because a control that does not exist still buys confidence. It is now wired
 * up here as a deprecated single-tenant spelling of XERO_ALLOWED_TENANT_IDS and enforced on exactly the
 * same paths, so an operator who has only ever set that one variable is genuinely protected today. Set
 * alongside XERO_ALLOWED_TENANT_* it must agree exactly; any real disagreement refuses everything
 * rather than silently preferring one of two deliberate instructions.
 */

export type XeroConnectionSummary = {
  tenantId: string
  tenantName?: string | null
}

export type XeroTenantAllowList = {
  /** Normalised (trimmed, lower-cased) tenant ids from XERO_ALLOWED_TENANT_IDS (or the legacy alias). */
  ids: string[]
  /** Normalised (trimmed, lower-cased, whitespace-collapsed) names from XERO_ALLOWED_TENANT_NAMES. */
  names: string[]
  /** Raw values as configured, for echoing back in a refusal. */
  rawIds: string[]
  rawNames: string[]
  /** True when at least one id or name is configured. An empty/whitespace value is NOT configured. */
  configured: boolean
  /**
   * The DEPRECATED `XERO_TENANT_ID`, when set to a non-blank value — otherwise null (o3d-9tbz).
   *
   * It shipped in `.env.example`, `scripts/install.sh` and `CLAUDE.md` describing itself as the Xero
   * tenant/organisation id, and NOTHING read it. An operator who set it to their live org believed they
   * had pinned the tenant and was completely unprotected, which is worse than having no control at all
   * because it manufactures confidence. It is now a single-tenant form of XERO_ALLOWED_TENANT_IDS and
   * enforced identically, everywhere.
   */
  legacyTenantId: string | null
  /**
   * Non-null when the tenant configuration CONTRADICTS ITSELF, in which case NOTHING is allowed.
   *
   * Two settings that disagree about which ledger this instance may write to cannot be resolved by
   * preferring one — either choice silently discards an instruction the operator gave deliberately, on
   * a money path. So the disagreement is refused, loudly, naming both values and the one-line fix.
   */
  conflict: string | null
}

export type XeroTenantRefusalReason =
  /** XERO_TENANT_ID and XERO_ALLOWED_TENANT_* disagree. Nothing is allowed until an operator resolves it. */
  | 'config-conflict'
  /** Xero returned an empty connection list — which is also what a REVOKED authorisation returns (200, []). */
  | 'no-connections'
  /** An allow-list is configured and none of the offered organisations is on it. */
  | 'none-allowed'
  /** This instance is pinned to an organisation that the allow-list forbids. */
  | 'pinned-not-allowed'
  /** This instance is pinned to an organisation this consent did not offer. */
  | 'pinned-not-offered'
  /** No pin, and more than one organisation is on the table. Never guess on a money path. */
  | 'ambiguous'

export type XeroTenantChoice<T extends XeroConnectionSummary = XeroConnectionSummary> =
  | { ok: true; connection: T }
  | { ok: false; reason: XeroTenantRefusalReason; error: string }

const MAX_LISTED_ORGANISATIONS = 12

function splitEnvList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function normaliseId(value: string): string {
  return value.trim().toLowerCase()
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Read the allow-list from the environment.
 *
 * Read at CALL time, never at module load, so a process that is reconfigured (or a test that sets the
 * variable) is not stuck with whatever was in the environment when the module first happened to load.
 *
 * An empty or whitespace-only value counts as UNSET, not as "allow nothing". `.env.example` ships the
 * keys, and a blank line in a config file must not silently disable every Xero connection on the box.
 */
export function readXeroTenantAllowList(env: Record<string, string | undefined> = process.env): XeroTenantAllowList {
  const rawIds = splitEnvList(env.XERO_ALLOWED_TENANT_IDS)
  const rawNames = splitEnvList(env.XERO_ALLOWED_TENANT_NAMES)
  const legacyTenantId = (env.XERO_TENANT_ID ?? '').trim() || null
  const modernConfigured = rawIds.length > 0 || rawNames.length > 0

  // XERO_TENANT_ID is the deprecated spelling of a one-entry XERO_ALLOWED_TENANT_IDS. It is honoured
  // ONLY when it is the sole tenant setting; where both are present they must agree exactly, and any
  // other combination is a conflict rather than a union. A union would silently WIDEN what an operator
  // who wrote `XERO_TENANT_ID=<one org>` believes they restricted this instance to — which is the exact
  // class of silent widening this whole guard exists to stop.
  let conflict: string | null = null
  if (legacyTenantId && modernConfigured) {
    const equivalent =
      rawNames.length === 0 && rawIds.length === 1 && normaliseId(rawIds[0]) === normaliseId(legacyTenantId)
    if (!equivalent) {
      conflict =
        `Refused: this server's Xero tenant settings contradict each other. XERO_TENANT_ID=${legacyTenantId} `
        + `names one organisation, while ${describeModernAllowList(rawIds, rawNames)} names `
        + 'a different set, and IMS will not pick a ledger by guessing which of the two you meant. No Xero '
        + 'request was made and nothing was stored. XERO_TENANT_ID is DEPRECATED: delete that line from the '
        + 'server .env, make sure XERO_ALLOWED_TENANT_IDS lists exactly the organisation(s) this instance '
        + 'may use, and restart IMS.'
    }
  }

  const effectiveRawIds = modernConfigured ? rawIds : (legacyTenantId ? [legacyTenantId] : [])

  return {
    ids: effectiveRawIds.map(normaliseId),
    names: rawNames.map(normaliseName),
    rawIds: effectiveRawIds,
    rawNames,
    configured: effectiveRawIds.length > 0 || rawNames.length > 0,
    legacyTenantId,
    conflict,
  }
}

/**
 * An unconfigured allow-list allows everything — it is opt-in, and production may legitimately not set it.
 * A CONTRADICTORY one allows nothing: an instruction we cannot read unambiguously is not permission.
 */
export function isXeroTenantAllowed(connection: XeroConnectionSummary, allowList: XeroTenantAllowList): boolean {
  if (allowList.conflict) return false
  if (!allowList.configured) return true
  if (allowList.ids.includes(normaliseId(connection.tenantId ?? ''))) return true
  const name = connection.tenantName == null ? '' : normaliseName(connection.tenantName)
  return name.length > 0 && allowList.names.includes(name)
}

/** `Demo Company (UK) [tenantId e7fb4378-…]` — the name to recognise it by, the id to configure it with. */
export function describeXeroConnections(connections: XeroConnectionSummary[]): string {
  const shown = connections.slice(0, MAX_LISTED_ORGANISATIONS)
  const described = shown
    .map((conn) => `${conn.tenantName?.trim() || '(unnamed organisation)'} [tenantId ${conn.tenantId}]`)
    .join(', ')
  const hidden = connections.length - shown.length
  return hidden > 0 ? `${described} (+${hidden} more)` : described
}

/** Echoes the modern keys as configured, for the conflict message that has to quote both sides. */
function describeModernAllowList(rawIds: string[], rawNames: string[]): string {
  const parts: string[] = []
  if (rawIds.length) parts.push(`XERO_ALLOWED_TENANT_IDS=${rawIds.join(',')}`)
  if (rawNames.length) parts.push(`XERO_ALLOWED_TENANT_NAMES=${rawNames.join(',')}`)
  return parts.join(' and ')
}

/**
 * Name the setting the operator has to EDIT, which is not always the one we read.
 *
 * An operator running on the deprecated `XERO_TENANT_ID` must be told to look for `XERO_TENANT_ID` in
 * their .env — telling them to fix `XERO_ALLOWED_TENANT_IDS` sends them hunting for a line that is not
 * there, which is a remedy they cannot perform.
 */
function describeAllowList(allowList: XeroTenantAllowList): string {
  const usingLegacyOnly = allowList.legacyTenantId !== null && allowList.rawNames.length === 0
    && allowList.rawIds.length === 1 && normaliseId(allowList.rawIds[0]) === normaliseId(allowList.legacyTenantId)
  if (usingLegacyOnly) {
    return `XERO_TENANT_ID=${allowList.legacyTenantId} (deprecated — rename it to XERO_ALLOWED_TENANT_IDS)`
  }
  return describeModernAllowList(allowList.rawIds, allowList.rawNames)
}

/** True when this instance is running purely off the deprecated XERO_TENANT_ID. */
function usesLegacyKeyOnly(allowList: XeroTenantAllowList): boolean {
  return allowList.legacyTenantId !== null && allowList.rawNames.length === 0 && allowList.rawIds.length === 1
    && normaliseId(allowList.rawIds[0]) === normaliseId(allowList.legacyTenantId)
}

/**
 * How to PERMIT an organisation, phrased for the key this operator actually has.
 *
 * An operator on the deprecated XERO_TENANT_ID who is told to "add its tenantId to
 * XERO_ALLOWED_TENANT_IDS" and does exactly that ends up with both keys set and disagreeing — i.e. the
 * conflict refusal. A remedy whose faithful execution produces a new refusal is not a remedy, so the
 * legacy case is told to REPLACE the line rather than add one.
 */
function howToPermit(tenantId: string, allowList: XeroTenantAllowList): string {
  if (usesLegacyKeyOnly(allowList)) {
    return `replace the XERO_TENANT_ID line in the server .env with XERO_ALLOWED_TENANT_IDS=${tenantId} `
      + '(XERO_TENANT_ID is deprecated and must not be left alongside it)'
  }
  return `set XERO_ALLOWED_TENANT_IDS=${tenantId} in the server .env`
}

/**
 * Choose the organisation to connect to, or refuse with a message the operator can act on.
 *
 * Order matters: the allow-list is applied FIRST, so a pin that points somewhere the environment
 * forbids (a restored dump, a copied database) cannot smuggle an organisation past it.
 */
export function selectXeroTenant<T extends XeroConnectionSummary>(params: {
  connections: T[]
  expectedTenantId: string | null
  allowList: XeroTenantAllowList
}): XeroTenantChoice<T> {
  const { connections, expectedTenantId, allowList } = params

  // Before the connection list, before the pin: a configuration we cannot read unambiguously is not a
  // basis for choosing a ledger, whatever Xero offered.
  if (allowList.conflict) {
    return { ok: false, reason: 'config-conflict', error: allowList.conflict }
  }

  if (connections.length === 0) {
    return {
      ok: false,
      reason: 'no-connections',
      error:
        'Xero returned no organisations for this app. Xero answers an authorisation that has been '
        + 'REVOKED the same way — 200 with an empty list — so check My Xero → Connected apps: if IMS is '
        + 'not listed there, re-authorise it for the organisation you want, then connect again.',
    }
  }

  const allowed = allowList.configured
    ? connections.filter((conn) => isXeroTenantAllowed(conn, allowList))
    : connections

  if (allowed.length === 0) {
    return {
      ok: false,
      reason: 'none-allowed',
      error:
        `Refused: none of the Xero organisations on this consent is on this server's allow-list. `
        + `Offered: ${describeXeroConnections(connections)}. Allowed: ${describeAllowList(allowList)}. `
        + 'Nothing was stored and no Xero data was read or written. Either reconnect choosing an allowed '
        + 'organisation, or — if one of the organisations above really is the one this instance should '
        + `use — ${howToPermit('<its tenantId above>', allowList)}, restart IMS, and connect again.`,
    }
  }

  if (expectedTenantId) {
    const pinned = allowed.find((conn) => conn.tenantId === expectedTenantId)
    if (pinned) return { ok: true, connection: pinned }

    const forbidden = connections.find((conn) => conn.tenantId === expectedTenantId)
    if (forbidden) {
      return {
        ok: false,
        reason: 'pinned-not-allowed',
        error:
          `Refused: this instance is pinned to Xero organisation ${describeXeroConnections([forbidden])}, `
          + `which this server's allow-list forbids. Allowed: ${describeAllowList(allowList)}. Nothing was `
          + `stored. Either ${howToPermit(forbidden.tenantId, allowList)} and restart IMS, or disconnect `
          + 'Xero on /sync (which clears the pin) and reconnect to an allowed organisation.',
      }
    }

    return {
      ok: false,
      reason: 'pinned-not-offered',
      error:
        `Refused: this instance is pinned to Xero tenantId ${expectedTenantId}, which this consent did not `
        + `include. Offered: ${describeXeroConnections(connections)}. Nothing was stored. Reconnect and pick `
        + 'the pinned organisation, or — if you are deliberately moving to a different organisation — '
        + 'disconnect Xero on /sync first, which clears the pin along with every id it resolved.',
    }
  }

  if (allowed.length === 1) return { ok: true, connection: allowed[0] }

  return {
    ok: false,
    reason: 'ambiguous',
    error:
      `Refused: this instance has no pinned Xero organisation and the consent returned ${allowed.length} `
      + 'organisations, so IMS will not guess which ledger to invoice into. Offered: '
      + `${describeXeroConnections(allowed)}. Nothing was stored. Choose explicitly: set `
      + 'XERO_ALLOWED_TENANT_IDS to exactly one of the tenantIds above in the server .env, restart IMS and '
      + "connect again — or remove IMS's access to the other organisations in Xero (My Xero → Connected "
      + 'apps) so that a single organisation is offered.',
  }
}

/**
 * The message shown when the STORED connection is outside the allow-list — the restored-dump / copied-
 * database case, where no callback ever runs and only this check stands between the instance and a live
 * ledger.
 */
export function storedTenantRefusalMessage(stored: XeroConnectionSummary, allowList: XeroTenantAllowList): string {
  // "add its tenantId to XERO_ALLOWED_TENANT_IDS" is the WRONG instruction when the block is caused by
  // two settings disagreeing — following it would leave the contradiction in place and the sync still
  // halted. Hand back the conflict's own remedy instead.
  if (allowList.conflict) {
    return (
      `Xero sync is halted: the stored connection is to ${describeXeroConnections([stored])}, but this `
      + `server's tenant settings contradict each other, so no organisation is permitted. `
      + `${allowList.conflict}`
    )
  }
  return (
    `Xero sync is halted: the stored connection is to ${describeXeroConnections([stored])}, which this `
    + `server's allow-list forbids. Allowed: ${describeAllowList(allowList)}. No Xero request was made. `
    + `Either ${howToPermit(stored.tenantId, allowList)} and restart IMS, or disconnect Xero on /sync and `
    + 'reconnect to an allowed organisation. This usually means a database from another environment was '
    + 'restored here with its Xero token still in it.'
  )
}

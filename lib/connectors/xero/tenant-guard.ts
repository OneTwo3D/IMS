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
 *  1. An env allow-list. Env is the ONLY control that survives a database reset, which is precisely the
 *     state that made the incident possible. It is enforced at the callback (nothing is stored) AND every
 *     time the stored token is used — because in the incident the callback ran once and the damage was
 *     done by the days of syncs afterwards, which never touch the callback at all. A restored production
 *     dump on the e2e rig arrives with a live token already in the database and no callback in sight;
 *     only the read-time check sees it.
 *  2. No silent `connections[0]`. With no pin and MORE THAN ONE organisation offered, IMS refuses and
 *     makes the operator choose. A single-organisation consent still proceeds untouched, so ordinary
 *     first-time setup — the overwhelmingly common case, and one this must not break — is unaffected.
 *
 * WHAT COUNTS AS IDENTITY, and what does not (the r2 finding). The first cut of this file treated
 * `XERO_ALLOWED_TENANT_NAMES` as interchangeable with `XERO_ALLOWED_TENANT_IDS` — a union, either kind of
 * entry admitting an organisation. But a Xero organisation NAME is mutable, non-unique and controlled by
 * whoever administers the organisation: "Demo Company (UK)" is what Xero calls EVERY demo company, and
 * any org can be renamed to anything at any time from Xero's own settings screen. An identity check that
 * a rename satisfies is not an identity check, and this branch exists because a rig wrote 150 invoices
 * into a live ledger. So the three controls are deliberately NOT equals:
 *
 *   XERO_ALLOWED_TENANT_IDS  (and the deprecated XERO_TENANT_ID)  IDENTITY. The only key that can ALLOW.
 *   XERO_BLOCKED_TENANT_IDS                                       IDENTITY. Denial, applied first.
 *   XERO_ALLOWED_TENANT_NAMES                                     NOT identity. It only ever NARROWS.
 *
 * They compose as a chain of FILTERS over the organisations on the consent — every configured key can
 * REMOVE candidates and none can add one. That is the whole substance of the change: a name can no
 * longer widen an id list (the old union let an organisation renamed to an allow-listed name in past an
 * id list that excluded it), and a name that matches two organisations on one consent has demonstrated
 * in that very consent that it does not identify anything, so it is refused outright rather than used to
 * pick one of them — that is `connections[0]` wearing a different hat.
 *
 * THE ROTATING DEMO TENANT, which is why names cannot simply be deleted. The full-chain e2e rig binds to
 * Xero's Demo Company, and Xero RE-CREATES that organisation with a NEW tenantId at every ~28-day reset.
 * An id allow-list therefore has to be re-edited every cycle, and a control that is annoying enough gets
 * switched off — which protects nothing. The rig's answer is `XERO_BLOCKED_TENANT_IDS=<the live org's
 * id>`: the LIVE organisation's id is the stable one, blocking it is identity-strength, it survives every
 * Demo rotation untouched, and it refuses a restored production dump on the read path as well as a
 * consent that offers the live org on the connect path. `XERO_ALLOWED_TENANT_NAMES=Demo Company (UK)` is
 * still useful ALONGSIDE it to narrow the consent to Demo, and is documented as exactly that: a
 * convenience, not an identity. A name-only configuration is the one combination with no identity anchor
 * at all, so it is not left silent — `nameOnlyGuardWarning` says so, once, on the record.
 *
 * THE PHANTOM CONTROL. `XERO_TENANT_ID` shipped in `.env.example`, `scripts/install.sh` and `CLAUDE.md`
 * from long before any of this, and NOTHING ever read it. An operator who set it to their live org had
 * every reason to believe the tenant was pinned and was in fact completely unprotected — strictly worse
 * than no setting at all, because a control that does not exist still buys confidence. It is now wired
 * up here as a deprecated single-tenant spelling of XERO_ALLOWED_TENANT_IDS and enforced on exactly the
 * same paths. Set alongside XERO_ALLOWED_TENANT_IDS it must agree exactly; a real disagreement between
 * two IDENTITY claims refuses everything rather than silently preferring one of two deliberate
 * instructions. It does NOT conflict with XERO_ALLOWED_TENANT_NAMES merely by coexisting with it: a name
 * narrows what the id already chose, so `XERO_TENANT_ID=<id>` plus that same organisation's name are two
 * spellings of one instruction, not two instructions. Only an empty intersection — each key selecting a
 * DIFFERENT organisation out of the same consent — is a genuine disagreement, and that can only be
 * decided against the connection list, so it is decided there.
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
  /** Normalised tenant ids from XERO_BLOCKED_TENANT_IDS. Denial, applied before everything else. */
  blockedIds: string[]
  /** Raw values as configured, for echoing back in a refusal. */
  rawIds: string[]
  rawNames: string[]
  rawBlockedIds: string[]
  /** True when at least one id, name or blocked id is configured. An empty/whitespace value is NOT configured. */
  configured: boolean
  /**
   * True when NAMES are the only tenant control set — no allowed ids, no blocked ids (o3d-9tbz r2).
   *
   * An organisation name is not an identity: it is mutable, it is not unique, and "Demo Company (UK)" is
   * what Xero calls every demo company there is. A name-only configuration therefore has no anchor that
   * a rename cannot move, and IMS says so rather than letting it read as equivalent protection.
   */
  nameOnlyGuard: boolean
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
   * Non-null when the tenant configuration CONTRADICTS ITSELF on the env alone, in which case NOTHING is
   * allowed. A contradiction that can only be seen against a connection list is diagnosed in
   * `selectXeroTenant` instead, because that is the first place there is enough information to tell a
   * genuine disagreement from two spellings of one organisation.
   *
   * Two settings that disagree about which ledger this instance may write to cannot be resolved by
   * preferring one — either choice silently discards an instruction the operator gave deliberately, on
   * a money path. So the disagreement is refused, loudly, naming both values and the one-line fix.
   */
  conflict: string | null
}

export type XeroTenantRefusalReason =
  /** Two identity settings disagree. Nothing is allowed until an operator resolves it. */
  | 'config-conflict'
  /** Xero returned an empty connection list — which is also what a REVOKED authorisation returns (200, []). */
  | 'no-connections'
  /** Every organisation on this consent is on XERO_BLOCKED_TENANT_IDS. */
  | 'blocked'
  /** An allow-list is configured and none of the offered organisations survives it. */
  | 'none-allowed'
  /** One XERO_ALLOWED_TENANT_NAMES entry matches SEVERAL offered organisations, so it identifies none. */
  | 'ambiguous-name'
  /** This instance is pinned to an organisation that the allow-list forbids. */
  | 'pinned-not-allowed'
  /** This instance is pinned to an organisation this consent did not offer. */
  | 'pinned-not-offered'
  /** No pin, and more than one organisation is on the table. Never guess on a money path. */
  | 'ambiguous'

export type XeroTenantChoice<T extends XeroConnectionSummary = XeroConnectionSummary> =
  | { ok: true; connection: T }
  | { ok: false; reason: XeroTenantRefusalReason; error: string }

/**
 * Why one organisation did not survive the filter chain — `allowed`, or the key that removed it.
 *
 * The distinction is not cosmetic. "The allow-list forbids it" is the right sentence for an id that is
 * not on the list; for a name it would be a lie about what was checked, and the operator needs to know
 * that what failed was a NAME comparison against a mutable label, because the likely cause is that
 * somebody renamed the organisation in Xero rather than that the wrong database was restored.
 */
export type XeroTenantVerdict =
  | 'allowed'
  | 'config-conflict'
  | 'blocked'
  | 'id-not-allowed'
  | 'name-not-allowed'

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

function connectionName(connection: XeroConnectionSummary): string {
  return connection.tenantName == null ? '' : normaliseName(connection.tenantName)
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
  const rawBlockedIds = splitEnvList(env.XERO_BLOCKED_TENANT_IDS)
  const legacyTenantId = (env.XERO_TENANT_ID ?? '').trim() || null

  // XERO_TENANT_ID is the deprecated spelling of a one-entry XERO_ALLOWED_TENANT_IDS. It is honoured
  // ONLY when it is the sole IDENTITY setting; where both are present they must agree exactly, and any
  // other combination is a conflict rather than a union. A union would silently WIDEN what an operator
  // who wrote `XERO_TENANT_ID=<one org>` believes they restricted this instance to — which is the exact
  // class of silent widening this whole guard exists to stop.
  //
  // XERO_ALLOWED_TENANT_NAMES is deliberately NOT part of this test. A name does not claim identity; it
  // narrows whatever the ids already chose. `XERO_TENANT_ID=<id>` plus that organisation's own name are
  // two spellings of one instruction, and refusing them was the r2 finding-2 bug. Whether a name and an
  // id name the same organisation is only answerable against a real connection list, so it is answered
  // in selectXeroTenant instead of guessed here.
  let conflict: string | null = null
  if (legacyTenantId && rawIds.length > 0) {
    const equivalent = rawIds.length === 1 && normaliseId(rawIds[0]) === normaliseId(legacyTenantId)
    if (!equivalent) {
      conflict =
        `Refused: this server's Xero tenant settings contradict each other. XERO_TENANT_ID=${legacyTenantId} `
        + `names one organisation, while XERO_ALLOWED_TENANT_IDS=${rawIds.join(',')} names `
        + 'a different set, and IMS will not pick a ledger by guessing which of the two you meant. No Xero '
        + 'request was made and nothing was stored. XERO_TENANT_ID is DEPRECATED: delete that line from the '
        + 'server .env, make sure XERO_ALLOWED_TENANT_IDS lists exactly the organisation(s) this instance '
        + 'may use, and restart IMS.'
    }
  }

  const effectiveRawIds = rawIds.length > 0 ? rawIds : (legacyTenantId ? [legacyTenantId] : [])
  const blockedIds = rawBlockedIds.map(normaliseId)

  // Allowing and blocking the same organisation is two deliberate instructions that cannot both be
  // obeyed. "Deny wins" would be a defensible rule and is still the wrong one here: it silently discards
  // the allow, and this file's whole position is that a discarded instruction on a money path is how
  // people end up believing in protection they do not have.
  if (!conflict) {
    const alsoBlocked = effectiveRawIds.filter((id) => blockedIds.includes(normaliseId(id)))
    if (alsoBlocked.length > 0) {
      const allowKey = rawIds.length > 0 ? 'XERO_ALLOWED_TENANT_IDS' : 'XERO_TENANT_ID'
      conflict =
        `Refused: this server's Xero tenant settings contradict each other. ${alsoBlocked.join(',')} is `
        + `listed on BOTH ${allowKey} and XERO_BLOCKED_TENANT_IDS, so the same organisation is both `
        + 'permitted and forbidden and IMS will not decide which you meant. No Xero request was made and '
        + `nothing was stored. Delete that id from ONE of the two lines — from XERO_BLOCKED_TENANT_IDS if `
        + `this instance may use that organisation, or from ${allowKey} if it may not — and restart IMS.`
    }
  }

  return {
    ids: effectiveRawIds.map(normaliseId),
    names: rawNames.map(normaliseName),
    blockedIds,
    rawIds: effectiveRawIds,
    rawNames,
    rawBlockedIds,
    configured: effectiveRawIds.length > 0 || rawNames.length > 0 || blockedIds.length > 0,
    nameOnlyGuard: rawNames.length > 0 && effectiveRawIds.length === 0 && blockedIds.length === 0,
    legacyTenantId,
    conflict,
  }
}

/**
 * Run one organisation through the filter chain — the SAME chain on the callback and on the stored token.
 *
 * Order is deliberate: a deny-list entry is an identity and outranks everything, an allowed-id list is an
 * identity and admits only what is on it, and a name list can only narrow further. No step can admit an
 * organisation that an earlier step removed, so no name can ever widen an id list.
 */
export function xeroTenantVerdict(connection: XeroConnectionSummary, allowList: XeroTenantAllowList): XeroTenantVerdict {
  if (allowList.conflict) return 'config-conflict'
  const id = normaliseId(connection.tenantId ?? '')
  if (allowList.blockedIds.includes(id)) return 'blocked'
  if (allowList.ids.length > 0 && !allowList.ids.includes(id)) return 'id-not-allowed'
  if (allowList.names.length > 0) {
    const name = connectionName(connection)
    if (name.length === 0 || !allowList.names.includes(name)) return 'name-not-allowed'
  }
  return 'allowed'
}

/**
 * An unconfigured allow-list allows everything — it is opt-in, and production may legitimately not set it.
 * A CONTRADICTORY one allows nothing: an instruction we cannot read unambiguously is not permission.
 */
export function isXeroTenantAllowed(connection: XeroConnectionSummary, allowList: XeroTenantAllowList): boolean {
  return xeroTenantVerdict(connection, allowList) === 'allowed'
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

/**
 * Echo every tenant key this server actually has set, phrased for the keys the operator will find.
 *
 * An operator running on the deprecated `XERO_TENANT_ID` must be told to look for `XERO_TENANT_ID` in
 * their .env — telling them to fix `XERO_ALLOWED_TENANT_IDS` sends them hunting for a line that is not
 * there, which is a remedy they cannot perform.
 */
function describeAllowList(allowList: XeroTenantAllowList): string {
  const parts: string[] = []
  if (allowList.rawIds.length) {
    parts.push(usesLegacyKey(allowList)
      ? `XERO_TENANT_ID=${allowList.legacyTenantId} (deprecated — rename it to XERO_ALLOWED_TENANT_IDS)`
      : `XERO_ALLOWED_TENANT_IDS=${allowList.rawIds.join(',')}`)
  }
  if (allowList.rawNames.length) parts.push(`XERO_ALLOWED_TENANT_NAMES=${allowList.rawNames.join(',')}`)
  if (allowList.rawBlockedIds.length) parts.push(`XERO_BLOCKED_TENANT_IDS=${allowList.rawBlockedIds.join(',')}`)
  return parts.length ? parts.join(' and ') : '(nothing)'
}

/** True when the id side of the allow-list is being carried by the deprecated XERO_TENANT_ID alone. */
function usesLegacyKey(allowList: XeroTenantAllowList): boolean {
  return allowList.legacyTenantId !== null && allowList.rawIds.length === 1
    && normaliseId(allowList.rawIds[0]) === normaliseId(allowList.legacyTenantId)
}

/**
 * How to PERMIT an organisation, phrased so that performing it FAITHFULLY leaves the operator working.
 *
 * This is the remedy trap, and it has two shapes. An operator on the deprecated XERO_TENANT_ID who is
 * told to "add its tenantId to XERO_ALLOWED_TENANT_IDS" and does exactly that ends up with both keys set
 * and disagreeing — i.e. the conflict refusal. An operator with XERO_ALLOWED_TENANT_NAMES set who adds
 * an id whose organisation is not on the name list lands in the empty-intersection refusal, because the
 * two filters compose rather than union. So every key that names the organisation a DIFFERENT way is
 * listed for removal in the same breath as the id is set: a remedy whose faithful execution produces a
 * new refusal is not a remedy.
 */
function howToPermit(tenantId: string, allowList: XeroTenantAllowList): string {
  const stale: string[] = []
  if (usesLegacyKey(allowList)) stale.push('XERO_TENANT_ID')
  if (allowList.rawNames.length > 0) stale.push('XERO_ALLOWED_TENANT_NAMES')
  if (stale.length === 0) return `set XERO_ALLOWED_TENANT_IDS=${tenantId} in the server .env`
  const lines = stale.length > 1 ? 'lines' : 'line'
  const them = stale.length > 1 ? 'them' : 'it'
  return `replace the ${stale.join(' and ')} ${lines} in the server .env with `
    + `XERO_ALLOWED_TENANT_IDS=${tenantId} (${stale.join(' and ')} ${stale.length > 1 ? 'name' : 'names'} the `
    + `organisation a different way, and leaving ${them} alongside the id would contradict it)`
}

/** The clause that says WHICH key refused this organisation, in the words of the key that did it. */
function whyRefused(connection: XeroConnectionSummary, allowList: XeroTenantAllowList): string {
  switch (xeroTenantVerdict(connection, allowList)) {
    case 'blocked':
      return `its tenantId is on XERO_BLOCKED_TENANT_IDS=${allowList.rawBlockedIds.join(',')}`
    case 'name-not-allowed':
      return `its name is not on XERO_ALLOWED_TENANT_NAMES=${allowList.rawNames.join(',')} `
        + '(a Xero organisation can be renamed at any time, so check the name in Xero before assuming the '
        + 'wrong organisation is connected)'
    case 'id-not-allowed':
    default:
      return `its tenantId is not on ${describeAllowList(allowList)}`
  }
}

/**
 * A name-only configuration has no identity anchor, and is told so — once, on the record (r2 finding 1).
 *
 * Returned rather than thrown or refused: refusing would switch off the only tenant control the e2e rig
 * has today, and an operator who reads "your guard is weaker than you think" and does nothing is still
 * better off than one who was never told. `XERO_BLOCKED_TENANT_IDS` is the fix and is named here, because
 * it is the one that survives the Demo company's ~28-day tenantId rotation without any maintenance.
 */
export function nameOnlyGuardWarning(allowList: XeroTenantAllowList): string {
  return (
    `This server restricts Xero by organisation NAME only (XERO_ALLOWED_TENANT_NAMES=`
    + `${allowList.rawNames.join(',')}). A Xero organisation name is not an identity — it is not unique, `
    + `and anyone administering an organisation can rename it, so a different organisation that shares or `
    + `adopts that name would pass this check. Add an id-based control: XERO_ALLOWED_TENANT_IDS=<the `
    + `tenantId this instance may use>, or — on a test rig bound to Xero's Demo company, whose tenantId is `
    + `re-issued at every ~28-day reset — XERO_BLOCKED_TENANT_IDS=<the live organisation's tenantId>, `
    + `which never needs updating.`
  )
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

  // The deny-list runs first, and its effect is visible to every later step: blocking the live
  // organisation can be what makes an otherwise-ambiguous name unique on this consent.
  const survivors = connections.filter((conn) => xeroTenantVerdict(conn, allowList) !== 'blocked')
  if (survivors.length === 0) {
    return {
      ok: false,
      reason: 'blocked',
      error:
        `Refused: every Xero organisation on this consent is on this server's deny-list `
        + `(XERO_BLOCKED_TENANT_IDS=${allowList.rawBlockedIds.join(',')}). Offered: `
        + `${describeXeroConnections(connections)}. Nothing was stored and no Xero data was read or `
        + 'written. Re-authorise IMS for an organisation this instance is allowed to use, or — if one of '
        + 'the organisations above really is the right one — remove its tenantId from '
        + 'XERO_BLOCKED_TENANT_IDS in the server .env and restart IMS.',
    }
  }

  // A NAME that matches two organisations on one consent has just proved, in that consent, that it
  // identifies neither. Using it to pick one of them would be `connections[0]` with extra steps, so it
  // refuses instead — even when a pin or an id list would happen to resolve the choice, because a
  // control that is meaningless in this environment must not be left looking like it is doing work.
  for (const name of allowList.names) {
    const shared = survivors.filter((conn) => connectionName(conn) === name)
    if (shared.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous-name',
        error:
          `Refused: XERO_ALLOWED_TENANT_NAMES entry "${name}" matches ${shared.length} of the `
          + `organisations on this consent (${describeXeroConnections(shared)}), so it does not identify `
          + 'any of them. A Xero organisation name is not unique and can be changed at any time, which is '
          + 'why IMS will not use one to choose between organisations. Nothing was stored and no Xero data '
          + `was read or written. ${howToChooseByIdInstead(allowList)}`,
      }
    }
  }

  const byId = allowList.ids.length > 0
    ? survivors.filter((conn) => allowList.ids.includes(normaliseId(conn.tenantId ?? '')))
    : null
  const byName = allowList.names.length > 0
    ? survivors.filter((conn) => allowList.names.includes(connectionName(conn)))
    : null
  const allowed = survivors.filter((conn) => xeroTenantVerdict(conn, allowList) === 'allowed')

  if (allowed.length === 0) {
    // Each key selected an organisation on this consent, and they selected DIFFERENT ones. THAT is a
    // genuine disagreement between an id and a name, as opposed to two spellings of one organisation —
    // and it is only visible here, with the connection list in hand.
    if (byId && byName && byId.length > 0 && byName.length > 0) {
      return {
        ok: false,
        reason: 'config-conflict',
        error:
          `Refused: this server's Xero tenant settings contradict each other on this consent. `
          + `${usesLegacyKey(allowList) ? 'XERO_TENANT_ID' : 'XERO_ALLOWED_TENANT_IDS'}=`
          + `${allowList.rawIds.join(',')} selects ${describeXeroConnections(byId)}, while `
          + `XERO_ALLOWED_TENANT_NAMES=${allowList.rawNames.join(',')} selects `
          + `${describeXeroConnections(byName)}, and no organisation satisfies both. IMS will not pick a `
          + 'ledger by guessing which of the two you meant. Nothing was stored and no Xero data was read '
          + 'or written. Names only ever NARROW the ids — they cannot add an organisation — so delete the '
          + 'XERO_ALLOWED_TENANT_NAMES line from the server .env, make sure the id list names exactly the '
          + 'organisation this instance may use, and restart IMS.',
      }
    }
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
          + `which this server's configuration forbids — ${whyRefused(forbidden, allowList)}. Nothing was `
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
 * The way out of an ambiguous NAME, phrased for the keys this operator has.
 *
 * With an id control already present the name is redundant and must be DELETED, not replaced — replacing
 * it would mean writing a second id key alongside the first and landing in the conflict refusal.
 */
function howToChooseByIdInstead(allowList: XeroTenantAllowList): string {
  if (allowList.rawIds.length > 0) {
    return `Delete the XERO_ALLOWED_TENANT_NAMES line from the server .env — ${describeAllowList(allowList)} `
      + 'already identifies this instance\'s organisation by id — and restart IMS.'
  }
  return 'Replace the XERO_ALLOWED_TENANT_NAMES line in the server .env with '
    + 'XERO_ALLOWED_TENANT_IDS=<exactly one of the tenantIds above>, and restart IMS.'
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
    + `server's allow-list forbids — ${whyRefused(stored, allowList)}. Allowed: `
    + `${describeAllowList(allowList)}. No Xero request was made. `
    + `Either ${howToPermit(stored.tenantId, allowList)} and restart IMS, or disconnect Xero on /sync and `
    + 'reconnect to an allowed organisation. This usually means a database from another environment was '
    + 'restored here with its Xero token still in it.'
  )
}

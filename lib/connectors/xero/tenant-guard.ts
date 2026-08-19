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
 *
 * WHAT A DENY-LIST DOES NOT DO (the r3 finding). `XERO_BLOCKED_TENANT_IDS=<the live org>` was prescribed
 * as the rig's whole answer to the rotating Demo tenantId, and it is not: it refuses ONE organisation.
 * A THIRD organisation — a bookkeeper's sandbox, a second live company, an org an operator happens to
 * also administer — is neither blocked nor named by any id, so it passes, and `XERO_ALLOWED_TENANT_NAMES`
 * cannot close that because a name is not an identity. Blocking the live id constrains the rig AWAY FROM
 * ONE LEDGER; it never constrained it TO a Demo organisation, and describing it as if it did was the same
 * manufactured confidence as the phantom XERO_TENANT_ID.
 *
 * So `XERO_REQUIRE_DEMO_ORG=true` exists. Xero's own GET /Organisation reports `IsDemoCompany` (and
 * `Class: DEMO`) for the organisation behind a token. That is identity-strength WITHOUT AN ID: it is
 * asserted by Xero about how the organisation was created, not by the organisation's administrator, so
 * unlike a name it cannot be adopted by renaming, and unlike an id it survives every ~28-day Demo
 * rotation with no edit. It costs no extra API call on the connect path — the callback already reads
 * GET /Organisation to compare base currencies — and it is enforced on the stored token too, from
 * `AccountingToken.tenantIsDemo` recorded at that same callback. A stored connection whose demo status
 * was never proven (a restored production dump, a token predating this key) is UNVERIFIED, and under
 * this key unverified is refused: an unproven demo organisation is not a demo organisation.
 *
 * It is a NARROWING filter like the names, never a widening one — it can only remove candidates — but
 * unlike the names it is an anchor, so a server that sets it is not warned about a name-only guard.
 *
 * THE BINDING IS ESTABLISHED IN THE DATABASE, NOT IN THIS FILE (the r3 finding on the callback). Every
 * refusal above is computed from a snapshot — the pin as it was read moments ago — and two OAuth
 * callbacks in flight at once both read "no pin", both pass, and the second one's write lands on top of
 * the first. The pin is what makes a re-consent to a different organisation refuse, so a race that
 * rewrites it defeats the guard rather than tripping it. `xeroTenantBindingRaceMessage` is the refusal
 * for the loser of that race; the atomicity itself is a PRIMARY KEY on `settings.key` and lives in
 * auth.ts, because no amount of checking in this file can make a check-then-write atomic.
 *
 * AND A BINDING THAT IS ALREADY SPLIT (the r5 finding). Closing the door that creates a mismatch does
 * nothing for an instance that came through it before the door existed, or that arrived with one inside
 * a restored database. `xeroBindingMismatchRefusal` is the read-time half: a pin and a token that name
 * different organisations mean the binding is UNKNOWN — not that one of them is right — so the sync
 * stops, both organisations are named, and the remedy is the one action that clears both halves at once.
 *
 * AND DELETING THE PIN IS NOT A WAY OUT OF THAT REFUSAL (the r6 finding). Round 5 exempted an ABSENT
 * pin, deliberately, because that is what every pre-pin connection looks like and what the documented
 * `--clear-tenant-pin` recovery produces. But an exemption reachable by DELETING something is a switch:
 * one `DELETE FROM settings` turns a halted instance into an unconstrained one, and restoring `settings`
 * and `accounting_tokens` from different backups arrives at the same place — which is the very scenario
 * the refusal was written for, so the refusal was one restore away from being absent exactly when it
 * mattered. `xeroMissingPinRefusal` closes it by asking what the TOKEN ROW says about its own history:
 *
 *   connectionGeneration PRESENT — the row was written by `bindXeroTenant`, which writes the pin in the
 *                                  same transaction, and `disconnect()` deletes both together. So a pin
 *                                  that is gone while this marker is here went away on its own: REFUSE.
 *   pinReleasedAt PRESENT        — the documented recovery cleared the pin and stamped the token row in
 *                                  one transaction. A deliberate, recorded release: ALLOW.
 *   neither                      — a row written before any of this existed. It is evidence of nothing,
 *                                  and every pre-pin installation is in it: ALLOW, exactly as in r5.
 *
 * The asymmetry is the point. Both legitimate states are things IMS's own code WROTE onto the token row;
 * the bypass is a DELETION from a different table, and a deletion cannot forge a value it never touches.
 */

export type XeroConnectionSummary = {
  tenantId: string
  tenantName?: string | null
  /**
   * Xero's own `IsDemoCompany` for this organisation, when it has been read from GET /Organisation.
   *
   * `undefined`/`null` means NOT KNOWN, and the two callers that legitimately do not know are different:
   * GET /connections never reports it (so the whole filter chain over a consent runs without it), and a
   * token row stored before `XERO_REQUIRE_DEMO_ORG` existed never recorded it. Under that key both are
   * treated as unverified and refused, which is why this is deliberately not defaulted to `false`: the
   * refusal for "Xero says this is not a demo org" and the refusal for "we never asked" have different
   * remedies and must not be collapsed.
   */
  isDemoCompany?: boolean | null
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
  /**
   * True when XERO_REQUIRE_DEMO_ORG is switched on: only a Xero DEMO organisation may be used (r3).
   *
   * The one control that constrains this instance to a KIND of organisation rather than to a list of
   * ids, which is what a rig bound to Xero's Demo company actually needs — Demo's tenantId is re-issued
   * at every ~28-day reset, and blocking the live org's id leaves every OTHER organisation admissible.
   * Proven from Xero's own GET /Organisation, so it is not defeated by a rename the way a name is.
   */
  requireDemoOrg: boolean
  /** True when at least one id, name, blocked id or the demo requirement is configured. An empty/whitespace value is NOT configured. */
  configured: boolean
  /**
   * True when NAMES are the only tenant control set — no allowed ids, no blocked ids (o3d-9tbz r2).
   *
   * An organisation name is not an identity: it is mutable, it is not unique, and "Demo Company (UK)" is
   * what Xero calls every demo company there is. A name-only configuration therefore has no anchor that
   * a rename cannot move, and IMS says so rather than letting it read as equivalent protection.
   *
   * XERO_REQUIRE_DEMO_ORG clears it as surely as an id does: it is an anchor Xero asserts, not one the
   * organisation's administrator controls, so a server that sets it is not guarding by name alone.
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
  /** XERO_REQUIRE_DEMO_ORG is set and the chosen organisation is not a Xero demo company. */
  | 'not-demo-org'
  /** XERO_REQUIRE_DEMO_ORG is set and Xero did not tell us whether the organisation is a demo one. */
  | 'demo-unverified'
  /** A concurrent OAuth callback bound this instance first. The binding is decided by the database. */
  | 'binding-race'

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

/**
 * A switch that is either ON, OFF, or a value we refuse to guess at.
 *
 * Returning `false` for an unrecognised value is how XERO_TENANT_ID happened: a line in the .env that
 * reads like a guard, and no guard. `XERO_REQUIRE_DEMO_ORG=demo` or `=Demo Company (UK)` is somebody
 * reaching for this control and missing, so it is a conflict — the one outcome that cannot be mistaken
 * for protection — rather than a silent off.
 */
function readEnvSwitch(raw: string | undefined): { value: boolean; malformed: string | null } {
  const text = (raw ?? '').trim()
  if (text.length === 0) return { value: false, malformed: null }
  const lowered = text.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return { value: true, malformed: null }
  if (['0', 'false', 'no', 'off'].includes(lowered)) return { value: false, malformed: null }
  return { value: false, malformed: text }
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
  const demoSwitch = readEnvSwitch(env.XERO_REQUIRE_DEMO_ORG)

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
  if (demoSwitch.malformed !== null) {
    conflict =
      `Refused: this server's Xero tenant settings cannot be read. XERO_REQUIRE_DEMO_ORG=`
      + `${demoSwitch.malformed} is not a yes/no value, and IMS will not decide for itself whether a `
      + 'switch it cannot read was meant to be on. No Xero request was made and nothing was stored. Set '
      + 'XERO_REQUIRE_DEMO_ORG=true to restrict this instance to a Xero DEMO organisation, or delete the '
      + 'line entirely to place no such restriction, and restart IMS.'
  }
  if (!conflict && legacyTenantId && rawIds.length > 0) {
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
    requireDemoOrg: demoSwitch.value,
    configured: effectiveRawIds.length > 0 || rawNames.length > 0 || blockedIds.length > 0 || demoSwitch.value,
    nameOnlyGuard: rawNames.length > 0 && effectiveRawIds.length === 0 && blockedIds.length === 0
      && !demoSwitch.value,
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
  if (allowList.requireDemoOrg) parts.push('XERO_REQUIRE_DEMO_ORG=true (a Xero DEMO organisation only)')
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
    + `re-issued at every ~28-day reset — XERO_REQUIRE_DEMO_ORG=true, which pins this instance to a Xero `
    + `DEMO organisation by Xero's own IsDemoCompany flag rather than by an id, so it needs no updating `
    + `at all. XERO_BLOCKED_TENANT_IDS=<the live organisation's tenantId> is worth adding alongside it, `
    + `but on its own it only fences out that ONE organisation — any third organisation would still pass.`
  )
}


/**
 * Whether the organisation behind a token satisfies XERO_REQUIRE_DEMO_ORG (o3d-9tbz r3).
 *
 * Kept OUT of `xeroTenantVerdict` on purpose. That function runs over GET /connections, which does not
 * report `IsDemoCompany` at all, so folding this in would make every organisation on every consent
 * "unverified" and refuse first-time setup outright. Demo-ness is a fact about the ORGANISATION, read
 * from GET /Organisation once the tenant has been chosen, and it is checked there.
 */
export type XeroDemoOrgVerdict = 'not-required' | 'demo' | 'not-demo' | 'unverified'

export function xeroDemoOrgVerdict(
  allowList: XeroTenantAllowList,
  isDemoCompany: boolean | null | undefined,
): XeroDemoOrgVerdict {
  if (!allowList.requireDemoOrg) return 'not-required'
  if (isDemoCompany === true) return 'demo'
  if (isDemoCompany === false) return 'not-demo'
  return 'unverified'
}

/** The shared tail: how to stop requiring a demo organisation, for an operator who meant a real one. */
const DEMO_REQUIREMENT_OPT_OUT =
  'or — if this server is genuinely meant to use a real organisation — delete the XERO_REQUIRE_DEMO_ORG '
  + 'line from the server .env and restart IMS.'

/**
 * Refuse a CONSENT whose chosen organisation is not (provably) a Xero demo company.
 *
 * `unverified` gets its own sentence because it has a different remedy from `not-demo`: nothing is wrong
 * with the operator's choice, IMS simply could not read the evidence, and telling them to "choose the
 * Demo company" when they already did would send them round the same loop.
 */
export function demoOrgConnectRefusal(
  connection: XeroConnectionSummary,
  verdict: XeroDemoOrgVerdict,
): string {
  const who = describeXeroConnections([connection])
  if (verdict === 'not-demo') {
    return (
      `Refused: this server is restricted to a Xero DEMO organisation (XERO_REQUIRE_DEMO_ORG=true), and `
      + `${who} is not one — Xero's own GET /Organisation reports IsDemoCompany=false for it. Nothing was `
      + 'stored and no Xero data was written. Re-authorise IMS (My Xero → Connected apps, then connect '
      + `again on /sync) choosing your Demo Company, ${DEMO_REQUIREMENT_OPT_OUT}`
    )
  }
  return (
    `Refused: this server is restricted to a Xero DEMO organisation (XERO_REQUIRE_DEMO_ORG=true), and IMS `
    + `could not read whether ${who} is one — Xero's GET /Organisation returned no IsDemoCompany flag for `
    + 'it. An organisation whose demo status is unproven is not treated as proven, so nothing was stored '
    + `and no Xero data was written. Try connecting again; if it keeps failing, ${DEMO_REQUIREMENT_OPT_OUT}`
  )
}

/**
 * Refuse a STORED token under the same requirement — the restored-dump half, where no callback runs.
 *
 * A production dump restored onto the rig arrives with a live token whose `tenantIsDemo` is either false
 * (recorded elsewhere) or absent (never recorded), and both must stop the sync. The remedy is a
 * reconnect, because the callback is the only place the claim can be checked against Xero.
 */
export function demoOrgStoredRefusal(
  stored: XeroConnectionSummary,
  verdict: XeroDemoOrgVerdict,
): string {
  const who = describeXeroConnections([stored])
  const why = verdict === 'not-demo'
    ? `${who}, which Xero reports is NOT a demo organisation`
    : `${who}, and this instance has never verified with Xero that it is a demo organisation — a token `
      + 'stored by another environment, or before this restriction was switched on, carries no such proof'
  return (
    `Xero sync is halted: this server is restricted to a Xero DEMO organisation `
    + `(XERO_REQUIRE_DEMO_ORG=true) but the stored connection is to ${why}. No Xero request was made. `
    + 'Disconnect Xero on /sync and connect again — the demo status is re-read from Xero at the consent — '
    + `${DEMO_REQUIREMENT_OPT_OUT} This usually means a database from another environment was restored `
    + 'here with its Xero token still in it.'
  )
}

/**
 * Every reason a STORED connection is unusable, in one place — or null when it is fine.
 *
 * The stored token is read from three call sites (the sync path, /sync's connection status, and the
 * reason the api layer substitutes for "Not connected to Xero"). They had already drifted once; adding a
 * second refusal condition to each of them independently is how they drift again, so the whole question
 * is answered here and the call sites ask it once.
 */
export function storedXeroConnectionRefusal(
  stored: XeroConnectionSummary,
  allowList: XeroTenantAllowList,
  pinnedTenantId: string | null | undefined,
  binding: XeroStoredBinding,
): string | null {
  // A configuration that contradicts itself permits NOTHING, so it is answered before every other
  // refusal: no remedy below can be carried out while it stands, and offering one would send the
  // operator to do work that cannot take effect.
  if (allowList.conflict) return storedTenantRefusalMessage(stored, allowList)

  // Then the binding itself, BEFORE the allow-list, because a broken binding invalidates the
  // allow-list's own remedy. `storedTenantRefusalMessage` offers "permit the stored organisation in the
  // .env"; an operator who does exactly that on a mismatched instance permits an organisation their pin
  // denies and lands straight in this refusal instead. A remedy whose faithful execution produces a new
  // refusal is not a remedy, so the ambiguity is reported first and the allow-list question waits until
  // there is a single organisation to ask it about.
  //
  // `binding` is a REQUIRED argument rather than an optional one with a permissive default, for the
  // reason this round exists: the r5 hole was an absent value read as permission. A call site that
  // forgets it does not compile, which is the only version of this check that cannot be switched off by
  // omission.
  const broken = xeroBindingRefusal(stored, pinnedTenantId, binding)
  if (broken !== null) return broken

  if (!isXeroTenantAllowed(stored, allowList)) return storedTenantRefusalMessage(stored, allowList)
  const demoVerdict = xeroDemoOrgVerdict(allowList, stored.isDemoCompany)
  if (demoVerdict === 'not-demo' || demoVerdict === 'unverified') {
    return demoOrgStoredRefusal(stored, demoVerdict)
  }
  return null
}

/**
 * What the TOKEN ROW itself says about the binding it belongs to (o3d-9tbz r6).
 *
 * Both fields are written by IMS onto `accounting_tokens`, and neither is derived from anything an
 * operator, a backup or a Xero response supplies. That is what makes them usable as evidence about a
 * row in a DIFFERENT table having gone missing.
 */
export type XeroStoredBinding = {
  /**
   * The generation minted by the binding transaction — the one that also writes the pin.
   *
   * Non-null is therefore proof that a pin was written beside this token row, by this code, and that
   * `disconnect()` (which deletes the two together) has not run since. Null means the row predates the
   * marker, which is evidence of nothing at all.
   */
  connectionGeneration: string | null
  /**
   * When the pin was DELIBERATELY released by the documented Demo-reset recovery — or null.
   *
   * Stamped by `provision-xero-demo.ts --clear-tenant-pin` in the same transaction that deletes the pin,
   * and cleared by the next binding, which writes a pin again. It is the release's receipt: it says the
   * pin's absence was intended, and when — which is the one thing a missing settings row cannot say
   * about itself.
   */
  pinReleasedAt: Date | null
}

/** Why this instance has no pin — which decides whether that is a supported state or a halt. */
export type XeroPinAbsenceVerdict =
  /** Deliberately released by the documented recovery. Supported: a re-consent is expected next. */
  | 'released'
  /** A token row that predates the binding marker. No evidence a pin was ever written. Supported. */
  | 'never-established'
  /** A binding wrote a pin beside this token, and the pin is gone. The binding is unverifiable. */
  | 'lost'

export function xeroPinAbsenceVerdict(binding: XeroStoredBinding): XeroPinAbsenceVerdict {
  // The release is checked FIRST and beats the generation, because a released connection has both: it
  // was bound (so it has a generation) and then deliberately unpinned (so it has a receipt). Reading
  // them the other way round would halt the recovery this branch is required to keep working.
  if (binding.pinReleasedAt != null) return 'released'
  if ((binding.connectionGeneration ?? '').trim().length > 0) return 'lost'
  return 'never-established'
}

/**
 * A token that has outlived its pin, or null when the pin's absence is accounted for (o3d-9tbz r6).
 *
 * WHY AN ABSENT PIN CANNOT SIMPLY BE EXEMPT. Round 5 refuses a pin and a token that name different
 * organisations. Every refusal has to survive the question "what does someone who wants it gone do?",
 * and the answer here was one statement: delete the pin. Worse, nobody has to want it gone — restoring
 * `settings` and `accounting_tokens` from different backups is the scenario the refusal exists for, and
 * a `settings` dump from before the pin was written restores no pin at all. The guard was therefore
 * absent in precisely the case it was written for.
 *
 * WHAT IT IS KEYED ON, and why that is not forgeable. `connectionGeneration` is minted by
 * `bindXeroTenant` with `crypto.randomUUID()` INSIDE the transaction that writes the pin, and
 * `disconnect()` deletes the token row and the pin row together. Those are the only two writers, so in
 * every state IMS can produce, a token row carrying a generation has a pin beside it. If the generation
 * is here and the pin is not, something outside IMS removed the pin. Nothing an operator can type, and
 * nothing a restore of the SETTINGS table can do, puts a generation on a token row — a deletion cannot
 * forge a value in a table it does not touch. To make a pin-deleted instance look never-bound you have
 * to write to `accounting_tokens` itself, at which point you could equally have written a token and a
 * pin of your own choosing: it is not an escalation, it is the same authority the binding already has.
 *
 * AND WHY IT IS NOT ACCIDENTALLY TRIPPED. The two legitimate states are exempt by their own evidence
 * rather than by luck. A genuine FIRST connection has no token row at all, so this is never asked. A
 * connection made before the generation column existed carries null and stays exempt exactly as it was
 * in r5 — this deploy takes no working installation offline. And the documented recovery is exempt
 * because it now leaves a receipt: `--clear-tenant-pin` deletes the pin and stamps `pinReleasedAt` in
 * one transaction. Every other route to an absent pin is the one being refused.
 */
export function xeroMissingPinRefusal(
  stored: XeroConnectionSummary,
  binding: XeroStoredBinding,
): string | null {
  if (xeroPinAbsenceVerdict(binding) !== 'lost') return null
  const who = describeXeroConnections([stored])
  return (
    `Xero sync is halted: this instance's Xero binding has lost its pin. The stored token belongs to `
    + `${who}, and it was written by a consent that pinned this instance to that organisation in the `
    + `same database transaction — the token row still carries that consent's connection marker — but `
    + `the xero_expected_tenant_id setting is no longer there. IMS never removes one without the other: `
    + `Disconnect deletes the token and the pin together. So the pin was removed separately, and with it `
    + `went the only record of which organisation this instance was bound to; what is left is a token `
    + `that nothing checks, and an unverifiable binding is not permission to post into a ledger. `
    + `No Xero request was made. `
    + `To fix it: on /sync press Disconnect — that clears the token and the pin together, leaving neither `
    + `half to contradict the next one — then connect again and choose the organisation this instance is `
    + `meant to use. That is the whole remedy: nothing in the server .env needs editing. Writing the `
    + `setting back by hand is NOT one — a pin typed in beside a token that came from somewhere else `
    + `only makes the two agree, which is not the same as the binding being right. `
    + `If you cleared the pin deliberately in order to re-consent after a Xero Demo reset, clear it with `
    + `scripts/provision-xero-demo.ts --clear-tenant-pin, which deletes the pin and records the release `
    + `on the token row in one transaction; a connection released that way is not halted, and the `
    + `release ends by itself at the next connect. A pin removed any other way cannot be told apart from `
    + `one that was lost. `
    + `If you are auditing what this instance has already posted, look in ${who}: everything it wrote `
    + `went to the token's organisation. The usual causes are a settings table and an accounting_tokens `
    + `table restored from different backups, a database copied here from another environment, or a `
    + `hand-run delete of the xero_expected_tenant_id row.`
  )
}

/**
 * The one question the sync path asks about the binding: is it whole?
 *
 * Two refusals, one per state of the pin, and they cannot both apply — a pin either exists and is
 * compared, or does not and is accounted for. They are asked together so no caller can add the second
 * check to one call site and forget the other two, which is what `storedXeroConnectionRefusal` already
 * exists to prevent for the allow-list and the demo requirement.
 */
export function xeroBindingRefusal(
  stored: XeroConnectionSummary,
  pinnedTenantId: string | null | undefined,
  binding: XeroStoredBinding,
): string | null {
  if ((pinnedTenantId ?? '').trim().length > 0) return xeroBindingMismatchRefusal(stored, pinnedTenantId)
  return xeroMissingPinRefusal(stored, binding)
}

/**
 * The two halves of one binding — the PIN and the stored TOKEN — naming different organisations, or
 * null when they agree or there is nothing to compare (o3d-9tbz r5 finding 1).
 *
 * WHY THIS EXISTS AT ALL. Rounds 3 and 4 stopped a mismatch being CREATED: the binding is written in one
 * transaction the database arbitrates, and a refresh names its organisation in the WHERE clause of its
 * own UPDATE. Neither does anything for an instance that ALREADY has one. That state is reachable — by
 * every instance that ran a version of this code from before those rounds, by a database restored from
 * another environment, by a settings table and an accounting_tokens table restored from different
 * dumps, and by the documented Demo-reset runbook if the pin is re-written by hand against a token that
 * was not re-consented. Nothing on deploy notices it, and this branch exists because exactly this class
 * of unnoticed misbinding invoiced 150 documents into a live ledger.
 *
 * WHICH SIDE IS RIGHT: NEITHER, and that is the point. It is tempting to prefer the pin (it is the
 * operator's declared intent) or the token (it is what the syncs actually use). Both are guesses. The
 * pin is an id somebody or something wrote into `settings`; the token is credentials somebody or
 * something wrote into `accounting_tokens`; when they disagree the only certain fact is that this
 * instance's binding is UNKNOWN. Choosing the pin would leave live credentials in place and go on
 * posting with them anyway — the token, not the pin, is what every Xero call presents. Choosing the
 * token would silently ratify whatever arrived in the database. So neither is trusted: the sync stops.
 *
 * AN ABSENT PIN IS NOT A MISMATCH — there is nothing to compare, and this function says so by returning
 * null. It is NOT thereby permitted: an absent pin is its own question, with its own evidence and its
 * own refusal, and it is asked by `xeroMissingPinRefusal` immediately below. Splitting the two keeps
 * each message about the state it describes; collapsing them would put "bound to two organisations at
 * once" on the screen of an instance that is bound to one and has lost the record of it.
 */
export function xeroBindingMismatchRefusal(
  stored: XeroConnectionSummary,
  pinnedTenantId: string | null | undefined,
): string | null {
  const pinned = (pinnedTenantId ?? '').trim()
  if (pinned.length === 0) return null
  const storedId = (stored.tenantId ?? '').trim()
  if (storedId.length === 0) return null
  // Compared the way every other id in this file is compared: a tenantId that differs only in case or
  // surrounding whitespace is the same organisation, and halting an instance over that would be a false
  // alarm on the sync path.
  if (normaliseId(storedId) === normaliseId(pinned)) return null

  return (
    `Xero sync is halted: this instance is bound to two different Xero organisations at once. Its pin `
    + `(the xero_expected_tenant_id setting, which every reconnect is checked against) names tenantId `
    + `${pinned}, while the stored token — which is what every sync actually presents to Xero, and so `
    + `what decides which ledger is written to — belongs to ${describeXeroConnections([stored])}. `
    + 'IMS will not guess which of the two this instance is meant to use, and will not treat either as '
    + 'evidence for the other: while they disagree the binding is simply unknown, and an unknown binding '
    + 'is not permission to post into a ledger. No Xero request was made. '
    + `To fix it: on /sync press Disconnect — that clears the token and the pin together, so neither `
    + `half survives to contradict the next one — then connect again and choose the organisation this `
    + `instance is meant to use. Nothing else needs editing. `
    + `If you are auditing what this instance has already posted, look in `
    + `${describeXeroConnections([stored])} and not in ${pinned}: everything it wrote went to the token's `
    + 'organisation. The usual causes are a database restored here from another environment with its '
    + 'Xero token still in it, a settings table and an accounting_tokens table restored from different '
    + 'backups, or the pin having been cleared or edited by hand while an older token was left in place.'
  )
}

/**
 * The loser of a concurrent-callback race, told what happened and what is actually connected now.
 *
 * Two OAuth callbacks in flight at once both read "no pin" and both pass every check in this file,
 * because every check in this file is computed from a snapshot. The database decides which one binds —
 * `settings.key` is a primary key, so exactly one INSERT of the pin can succeed — and this is what the
 * other one is told. The remedy is a DISCONNECT rather than "try again": trying again would find the
 * winner's pin and be refused as pinned-not-offered, which is a true message about the wrong problem.
 */
export function xeroTenantBindingRaceMessage(params: {
  attempted: XeroConnectionSummary
  boundTo: XeroConnectionSummary
}): string {
  const { attempted, boundTo } = params
  return (
    `Refused: another Xero connection finished first and bound this instance to `
    + `${describeXeroConnections([boundTo])}. Your consent selected `
    + `${describeXeroConnections([attempted])}, and nothing from it was stored — no token, no pin, and no `
    + 'Xero data was read or written. IMS binds to ONE organisation and will not move that binding '
    + 'underneath a connection that is already established. If the organisation you chose is the one '
    + 'this instance should use, disconnect Xero on /sync — which clears the binding — and connect '
    + 'again, with only one connection in flight at a time.'
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

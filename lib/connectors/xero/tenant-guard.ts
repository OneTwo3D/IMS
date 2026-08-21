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
 *
 * AND THE RELEASE IS A RECEIPT FOR A STATE, NOT A PERMANENT PASS (the r7 finding). `pinReleasedAt` alone
 * says only that a release happened once, which nothing later can contradict — so it outlives what it
 * released, and a token row restored from a dump taken mid-recovery carries the exemption onto a binding
 * it has nothing to do with. The receipt therefore records WHICH state it released: the connection
 * generation the row carried and the organisation the deleted pin named. Both are checked against the
 * row the receipt is on, every time, so the exemption expires when the state does rather than on a
 * clock, and a receipt that no longer fits its row is `stale-release` — refused on its own terms.
 *
 * AND A RECEIPT CANNOT BE ITS OWN WITNESS (the r8 finding). r7 left the argument circular in two ways.
 * A receipt written before r7 carries no qualifiers, and the migration that added them could only have
 * filled them in from the row itself — which would have qualified, in the same deploy, exactly the
 * receipts the old recovery stamped for pins it never deleted. Nothing is backfilled: an unqualified
 * receipt exempts nothing (`unqualified-release`), and an instance mid-recovery when this deploys
 * finishes it with Disconnect-then-connect. And every r7 qualifier is a column on the same row as the
 * receipt, so a wholesale-restored `accounting_tokens` row carries its own proof and validates itself;
 * the release is therefore also witnessed in `settings`, by the transaction that deletes the pin, and a
 * receipt with no witness beside it is `unwitnessed-release`. What that still cannot see is a copy of
 * the WHOLE database, which reproduces both halves — there is no in-database answer to that, and the
 * env allow-list of layer 1 is the only control that survives it. Which is why layer 1 is first.
 *
 * AND THE RECEIPT IS CONSUMED BY THE PIN, NOT BY THE WRITER THAT HAPPENS TO WRITE IT (the r9 finding).
 * r7's whole argument for a receipt with no expiry is that the next binding consumes it, and r8 added
 * the witness on the same understanding. Both were true of `bindXeroTenant` and false of the system:
 * the pin has other writers, and `provision-xero-demo.ts` re-pins on every ordinary run by writing the
 * settings row directly. A completed re-provision therefore left an instance PINNED and still carrying
 * an outstanding release — harmless while the pin is there, and exactly one `DELETE FROM settings` from
 * the bypass r6 closed, because the receipt still names this connection and this token's organisation
 * and the witness is still beside it. So the rule is attached to the pin instead of to a code path:
 * the trigger in `20260819210000_xero_pin_write_consumes_release` clears both halves on ANY write of
 * the `xero_expected_tenant_id` row, and `xeroPinEstablishmentStatements` is the same rule spelled for
 * the raw-SQL writer that must not depend on the trigger being installed yet.
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
  /**
   * True when this instance has declared itself NON-PRODUCTION (o3d-iaqy).
   *
   * Two signals, because neither covers the other. `E2E_TEST_MODE=1` is the repo's existing e2e flag and
   * the ONLY one that works on the full-chain rig, which serves a PRODUCTION build and therefore reports
   * `NODE_ENV=production` (the same reason `applyE2eMaxOverride` cannot gate on NODE_ENV). `NODE_ENV`
   * catches the ordinary dev box and the restored-dump-on-a-laptop case, where E2E_TEST_MODE is unset.
   *
   * An ABSENT NODE_ENV counts as non-production. "We cannot tell" is not "this is production", and the
   * whole subject of this file is that a missing signal must not read as permission — production sets
   * `NODE_ENV=production` explicitly (`.env.example`), so the absent case is never the production one.
   */
  instanceIsNonProduction: boolean
  /**
   * True when a NON-PRODUCTION instance has no IDENTITY-strength Xero tenant control at all (o3d-iaqy).
   *
   * This is the state that produced o3d-t74p: the e2e rig, with nothing configured, connected to the
   * LIVE organisation and posted 553 objects into it over eleven days. `configured` being false read as
   * "anything is allowed", which is exactly the reading o3d-iaqy exists to remove — but only on an
   * instance that has said it is not production. Production may legitimately run with no allow-list (it
   * IS the organisation everything else is being kept away from), so nothing changes there.
   *
   * NAMES DO NOT SATISFY IT. `XERO_ALLOWED_TENANT_NAMES` is not an identity — see `nameOnlyGuard` and
   * the header — so a name-only rig is exactly as unguarded as one with nothing set, and treating it as
   * guarded would be the manufactured confidence this file already refuses to sell. Any ONE of an
   * allowed id, a blocked id or `XERO_REQUIRE_DEMO_ORG=true` clears it; a blocked id counts because
   * blocking the live organisation's id is precisely "this instance may not talk to the live ledger",
   * which is this issue's whole sentence.
   */
  unguardedInstance: boolean
}

export type XeroTenantRefusalReason =
  /** Two identity settings disagree. Nothing is allowed until an operator resolves it. */
  | 'config-conflict'
  /** A non-production instance with no identity-strength tenant control at all (o3d-iaqy). */
  | 'unguarded-instance'
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

  // o3d-iaqy. An IDENTITY anchor is an id list, a deny list, or the demo requirement — the three
  // controls this file already calls identity-strength. Names are excluded for the same reason they can
  // never widen an id list: a rename satisfies them.
  const hasIdentityAnchor = effectiveRawIds.length > 0 || blockedIds.length > 0 || demoSwitch.value
  const instanceIsNonProduction = readInstanceIsNonProduction(env)

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
    instanceIsNonProduction,
    unguardedInstance: instanceIsNonProduction && !hasIdentityAnchor,
  }
}

/**
 * Has this instance declared itself NON-PRODUCTION? (o3d-iaqy)
 *
 * See `XeroTenantAllowList.instanceIsNonProduction` for why it takes two signals and why an absent
 * NODE_ENV is counted as non-production. Deliberately reads the injected `env` rather than
 * `process.env` directly, so the question is testable — the o3d-t74p rig is precisely an instance whose
 * environment nobody could interrogate after the fact.
 *
 * KNOWN HOLE, DELIBERATELY NOT PATCHED HERE (o3d-l89a; Codex r1 finding 4). Both signals below are set
 * by the BUILD, so an instance that serves a production build, sets NODE_ENV=production and does not set
 * E2E_TEST_MODE is indistinguishable from production to this function — which is what stage is, what a
 * second production-shaped copy is, and what the o3d-t74p rig became on the day E2E_TEST_MODE fell out
 * of its .env. Such an instance is therefore still exempt from the o3d-iaqy requirement.
 *
 * THE ANSWER ALREADY EXISTS AND IS NOT THIS FUNCTION'S TO WRITE AGAIN. `lib/ops/instance-identity.ts`
 * (branch o3d-batch-exceptions, unmerged as of this commit) answers it from an `IMS_INSTANCE_ROLE`
 * declaration, returns the verdict PLUS ITS BASIS, and lands in two steps because absence must read as
 * non-production and production is absent today. The remaining edit is a one-line delegation — replace
 * this body with `instanceIsNonProduction(env, { requireDeclaration: true })` — and it is filed as
 * o3d-c413, gated on IMS_INSTANCE_ROLE=production actually being on the live server first (verified by
 * the production preflight) so the flip cannot take production's connector offline. Writing a second
 * IMS_INSTANCE_ROLE reader on this branch would BE the defect being removed: two answers to one
 * question, diverging the moment either is edited. This function is kept module-private with a single
 * call site precisely so that delegation stays a one-line change.
 *
 * Note that o3d-c413 also owns the consequent wording fix in `xeroUnguardedInstanceRefusal`, whose
 * remedy sentence still names NODE_ENV.
 */
function readInstanceIsNonProduction(env: Record<string, string | undefined>): boolean {
  if ((env.E2E_TEST_MODE ?? '').trim() === '1') return true
  return (env.NODE_ENV ?? '').trim() !== 'production'
}

/**
 * The refusal for a non-production instance with no identity-strength tenant control (o3d-iaqy).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ALLOW-LIST REFUSAL. `isXeroTenantAllowed` answers "may THIS
 * organisation be used", and with nothing configured its answer is yes — deliberately, because an
 * unconfigured allow-list is opt-in and production may legitimately have none. o3d-iaqy is the other
 * question: may this instance connect to ANY organisation it is offered, given what it has said about
 * itself? A dev or e2e instance that has named no organisation has not been told which ledger is
 * off-limits, and in o3d-t74p the answer it gave itself was the live one.
 *
 * THE REMEDY IS TO STATE AN INTENTION, NOT TO SWITCH THE GUARD OFF. There is deliberately no
 * "XERO_SKIP_TENANT_GUARD": every way out names an organisation or a kind of organisation, so
 * performing the remedy leaves a record of which ledger this instance was pointed at. A guard whose
 * documented escape hatch is a boolean is a guard that is off on every instance that ever hit it.
 */
export function xeroUnguardedInstanceRefusal(allowList: XeroTenantAllowList): string {
  const nameNote = allowList.rawNames.length > 0
    ? `XERO_ALLOWED_TENANT_NAMES=${allowList.rawNames.join(',')} is set, and it does NOT count: a Xero `
      + 'organisation name is not unique and can be changed at any time by whoever administers it, so a '
      + 'name check is satisfied by a rename. '
    : ''
  return (
    'Refused: this IMS instance is not marked as production and has no Xero tenant control set, so it '
    + 'has not been told which organisations it may write to. '
    + nameNote
    + 'That is the exact state that let the e2e rig invoice into the LIVE organisation — 553 objects, '
    + '150 invoices, 14 payments, over eleven days (o3d-t74p). Nothing was stored and no Xero data was '
    + 'read or written. Set ONE of these in the server .env and restart IMS: '
    + 'XERO_ALLOWED_TENANT_IDS=<the tenantId this instance may use>; or XERO_REQUIRE_DEMO_ORG=true, '
    + "which restricts this instance to a Xero DEMO organisation by Xero's own IsDemoCompany flag and so "
    + "needs no editing when Demo's tenantId is re-issued at every ~28-day reset; or "
    + 'XERO_BLOCKED_TENANT_IDS=<the live organisation\'s tenantId>, which fences out that one ledger. '
    + 'If this IS the production instance, set NODE_ENV=production (and leave E2E_TEST_MODE unset) — '
    + 'production is exempt because it is the organisation everything else is being kept away from.'
  )
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
  // o3d-iaqy is deliberately NOT here. This chain answers a question about ONE ORGANISATION — "does
  // this org survive the configured filters" — and every refusal it produces names the key that removed
  // that org. "This instance was never entitled to pick any organisation" is a fact about the INSTANCE:
  // it removes no candidate in particular, it removes the whole question. Folding it in would make
  // `whyRefused` describe a per-org filter that did not run, and would make `isXeroTenantAllowed` — a
  // pure predicate over an org and a list — depend on the process environment. It is enforced instead
  // at the two places that actually admit a connection: `selectXeroTenant` and
  // `storedXeroConnectionRefusal`, which between them are the only ways a Xero token is established or
  // used.
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
  releaseWitness: XeroReleaseWitness | null,
): string | null {
  // A configuration that contradicts itself permits NOTHING, so it is answered before every other
  // refusal: no remedy below can be carried out while it stands, and offering one would send the
  // operator to do work that cannot take effect.
  if (allowList.conflict) return storedTenantRefusalMessage(stored, allowList)

  // o3d-iaqy, answered on the STORED token as well as at the callback, and for the same two reasons the
  // allow-list is: in o3d-t74p the callback ran once and eleven days of syncs did the damage, and a
  // production database restored onto a dev box arrives with a live token already in it and no callback
  // in sight. It is second only to `conflict` because it is likewise a fact about the configuration —
  // no binding remedy below can be carried out usefully while this instance still has not said which
  // ledger it may write to.
  if (allowList.unguardedInstance) return xeroUnguardedInstanceRefusal(allowList)

  // Then the binding itself, BEFORE the allow-list, because a broken binding invalidates the
  // allow-list's own remedy. `storedTenantRefusalMessage` offers "permit the stored organisation in the
  // .env"; an operator who does exactly that on a mismatched instance permits an organisation their pin
  // denies and lands straight in this refusal instead. A remedy whose faithful execution produces a new
  // refusal is not a remedy, so the ambiguity is reported first and the allow-list question waits until
  // there is a single organisation to ask it about.
  //
  // `binding` and `releaseWitness` are REQUIRED arguments rather than optional ones with a permissive
  // default, for the reason these rounds exist: the r5 hole was an absent value read as permission, and
  // a witness that defaulted to "present" would be the same hole in the r8 shape. A call site that
  // forgets either does not compile, which is the only version of this check that cannot be switched
  // off by omission.
  const broken = xeroBindingRefusal(stored, pinnedTenantId, binding, releaseWitness)
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
  /**
   * The connection generation this row carried AT THE RELEASE, and the organisation the DELETED pin
   * named — the two facts that make the receipt describe a state rather than merely a moment (r7).
   *
   * A bare `pinReleasedAt` is exempt-by-presence: it says a release happened once and nothing that
   * happens to the row afterwards can contradict it, so it outlives the connection it released. These
   * are compared against the row the receipt is sitting on, so the exemption ends by construction the
   * moment the row stops being the one that was released — a rebinding, a restored token row, a
   * different organisation. Null on both while `pinReleasedAt` is null: nothing was released.
   */
  pinReleasedGeneration: string | null
  pinReleasedTenantId: string | null
}

/** Why this instance has no pin — which decides whether that is a supported state or a halt. */
export type XeroPinAbsenceVerdict =
  /**
   * Deliberately released by the documented recovery: the receipt describes THIS row, and the half of
   * it that stayed behind in `settings` describes the same release.
   */
  | 'released'
  /** A token row that predates the binding marker. No evidence a pin was ever written. Supported. */
  | 'never-established'
  /** A binding wrote a pin beside this token, and the pin is gone. The binding is unverifiable. */
  | 'lost'
  /**
   * A release receipt that does NOT describe the row it is on: it names another connection, or another
   * organisation's pin (r7). It is evidence about a state this row is no longer in, so it exempts
   * nothing — and it is its own refusal rather than being folded into `lost`, because the operator is
   * looking at a different thing and the two have different histories.
   */
  | 'stale-release'
  /**
   * A receipt that records only THAT a release happened — no generation, no released pin (r8).
   *
   * Every receipt written before r7 is in this state, and so is every hand-inserted `pinReleasedAt`.
   * It cannot be qualified after the fact: the pre-r7 `--clear-tenant-pin` stamped a receipt even when
   * it deleted no pin, which is how a halted instance was laundered into an exempt one by following
   * the runbook, and such a receipt is indistinguishable from a legitimate outstanding release BY THE
   * ROW IT SITS ON. Any rule that qualifies one qualifies the other, so neither is qualified: an
   * unqualified receipt says nothing about what it released and therefore exempts nothing.
   *
   * Its own verdict rather than `stale-release`, because `stale-release` asserts the receipt came apart
   * from its row and so did not get here through IMS — untrue of a receipt written by a version of IMS
   * that had nothing to qualify it with, and it would send the operator to look for a restore that
   * never happened.
   */
  | 'unqualified-release'
  /**
   * A qualified receipt on the token row with no matching half in `settings` (r8 finding 2).
   *
   * The r7 qualifiers live on the same row as the receipt, so a wholesale-restored `accounting_tokens`
   * row arrives carrying all of them at once and validates itself: generation matches generation and
   * released pin matches tenant because every one of those values came out of the same dump. A release
   * is therefore also witnessed OUTSIDE the token row — in the `settings` table the recovery is already
   * deleting the pin from, in the same transaction — and a token row that brought its own paperwork
   * with it cannot bring that too.
   */
  | 'unwitnessed-release'

/**
 * The half of the release receipt that does NOT live on the token row (o3d-9tbz r8 finding 2).
 *
 * WHY A SECOND HALF EXISTS. Every qualifier r7 added — the generation released, the pin released, and
 * the row's own generation and tenant they are compared against — is a column on `accounting_tokens`.
 * That is exactly right for the case r6 and r7 were about, where something DELETED the pin: a deletion
 * in `settings` cannot forge a value in a table it never touches. It is worth nothing at all for the
 * other half of the same scenario. Restore an `accounting_tokens` dump taken while a release was
 * outstanding and the whole row arrives together — receipt, qualifiers, generation, tenant — so the
 * receipt is compared against the row it came with and agrees with itself by construction. A
 * self-validating receipt is not evidence; it is a copy of the thing it is meant to prove.
 *
 * So the recovery writes the release in TWO places, in the one transaction it already had: the receipt
 * on the token row, and this witness in `settings` — the table it is deleting the pin from. Neither
 * half is believed alone. A token row that arrives from somewhere else brings its receipt with it and
 * cannot bring this, because this stays with the instance; and this alone exempts nothing, because the
 * exemption still requires the receipt (which is what kept the r6 bypass — a bare `DELETE FROM
 * settings` — closed, and it stays closed: deleting the pin and writing a witness is still a token row
 * with no receipt on it).
 *
 * WHAT IT STILL CANNOT SEE, said plainly rather than left to be discovered. A restore of the WHOLE
 * database — or a file-level copy of one instance onto another — reproduces every fact in it, both
 * halves included, and no evidence stored in that database can distinguish a faithful copy of an
 * instance from the instance. There is no in-database answer to that case and this does not pretend to
 * be one. What survives a restore is the ENV: `XERO_ALLOWED_TENANT_IDS`, `XERO_BLOCKED_TENANT_IDS` and
 * `XERO_REQUIRE_DEMO_ORG` are read from the server's own configuration, they are enforced on the
 * STORED token on every use, and they are the only reason a production dump restored onto the e2e rig
 * is refused rather than used. That is the whole point of layer 1 at the top of this file, and it is
 * why a server with no tenant control in its env has no defence against a copied database — which
 * `nameOnlyGuardWarning` and the demo requirement exist to keep saying out loud.
 */
export type XeroReleaseWitness = {
  /** The connection generation the released token row carried — null on a row that predates it. */
  generation: string | null
  /** The organisation the DELETED pin named. Never blank: no pin deleted, no witness written. */
  tenantId: string
}

/**
 * Read the witness back, refusing anything that is not one.
 *
 * A value that cannot be parsed, or that names no organisation, is NOT a witness and is treated as an
 * absent one. Failing open on a malformed value would make "write junk into that settings row" a way
 * to satisfy the check, which is the shape of every finding this file is made of.
 */
export function parseXeroReleaseWitness(raw: string | null | undefined): XeroReleaseWitness | null {
  const text = (raw ?? '').trim()
  if (text.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const tenantId = typeof record.tenantId === 'string' ? record.tenantId.trim() : ''
  if (tenantId.length === 0) return null
  const generation = typeof record.generation === 'string' ? record.generation : null
  return { generation, tenantId }
}

/** The witness as it is stored — one JSON object, written by the transaction that deletes the pin. */
export function serializeXeroReleaseWitness(witness: XeroReleaseWitness): string {
  return JSON.stringify({ generation: witness.generation, tenantId: witness.tenantId })
}

/**
 * The two settings rows a Xero binding is made of, named once (o3d-9tbz r9).
 *
 * They were spelled as literals in four places — `auth.ts`, the recovery script, the e2e preflight and
 * the migration — and the rule below is a statement ABOUT those two keys, so it cannot be expressed
 * against a string that each writer spells for itself.
 */
export const XERO_TENANT_PIN_SETTING_KEY = 'xero_expected_tenant_id'
export const XERO_PIN_RELEASE_WITNESS_SETTING_KEY = 'xero_pin_release_witness'

/** One parameterised statement, in the shape both `pg` and a test double take it. */
export type XeroPinSqlStatement = { text: string; values: unknown[] }

/**
 * ESTABLISHING A PIN ENDS ANY OUTSTANDING RELEASE — as one operation, not as a habit (o3d-9tbz r9).
 *
 * THE FINDING. r7 gave the receipt no expiry on the explicit ground that it is CONSUMED BY THE NEXT
 * BINDING, and r8 added the witness alongside it on the same understanding. Both statements were true
 * of `bindXeroTenant`, which clears the receipt and deletes the witness in the transaction that writes
 * the pin — and false of the system, because the pin has more than one writer. `provision-xero-demo.ts`
 * re-pins from the live connection on every ordinary run, by writing the settings row directly rather
 * than going through the binding, so a completed re-provision left the instance PINNED and still
 * carrying an outstanding release. Nothing was wrong while the pin was there: the receipt is only ever
 * read to answer "why is there no pin". But the halt r6 built is what stands between this instance and
 * one `DELETE FROM settings`, and on such a row that deletion is not refused — the receipt is qualified
 * (r7: it names this connection and this token's organisation, neither of which a re-pin changes) and
 * the witness is still beside it (r8), so the verdict is `released` and the bypass r6 closed is open
 * again, on an instance that reached the state by running the documented provisioner.
 *
 * WHY IT IS FIXED HERE RATHER THAN THERE. Three writers have now been found doing this by hand, and
 * r8's own lesson was that evidence maintained per-writer is fragile. So the consumption follows the
 * PIN: it is enforced by the database, in the trigger installed by
 * `20260819210000_xero_pin_write_consumes_release`, which fires on any INSERT or UPDATE of the
 * `xero_expected_tenant_id` row and clears both halves of the release. That rule covers writers this
 * file has never heard of — a migration, a seed, `setSettings()` with the wrong key in it, an operator
 * at a SQL prompt —
 * because it is attached to the row rather than to a code path, and it cannot be forgotten by the next
 * writer for the same reason.
 *
 * THIS FUNCTION IS THE SAME RULE, SPELLED FOR A RAW-SQL WRITER, and it is not redundant: the script is
 * run by hand against whatever instance is in front of the operator, including one whose migrations
 * predate the trigger, and a reader of the script has to be able to SEE that re-pinning ends a release
 * rather than take it on trust from a file they are not reading. The statements are idempotent against
 * each other — with the trigger installed, the two clears find nothing left to do.
 *
 * ORDER IS PART OF IT. The pin is written FIRST, so that on a database that has the trigger the whole
 * consumption is already committed by the time the clears run, and on one that does not the clears
 * follow a pin that is definitely there. Run them in ONE transaction: a pin written without the
 * clears is precisely the state being removed.
 */
export function xeroPinEstablishmentStatements(tenantId: string): XeroPinSqlStatement[] {
  return [
    {
      text:
        `insert into settings (key, value, "updatedAt") values ($1, $2, now())\n` +
        `   on conflict (key) do update set value = excluded.value, "updatedAt" = now()`,
      values: [XERO_TENANT_PIN_SETTING_KEY, tenantId],
    },
    {
      // The receipt, all three columns together. They are written together and cleared together
      // everywhere else (r7), and a half-cleared receipt is `stale-release` — a refusal that would send
      // the operator looking for a restore that never happened.
      text:
        `update accounting_tokens\n` +
        `      set "pinReleasedAt" = null,\n` +
        `          "pinReleasedGeneration" = null,\n` +
        `          "pinReleasedTenantId" = null,\n` +
        `          "updatedAt" = now()\n` +
        `    where connector = 'xero'\n` +
        `      and ("pinReleasedAt" is not null or "pinReleasedGeneration" is not null or "pinReleasedTenantId" is not null)`,
      values: [],
    },
    {
      // ...and the half that stayed in `settings`. A witness left behind is a half-record waiting for a
      // token row to corroborate, which is the shape of every finding in this file.
      text: `delete from settings where key = $1`,
      values: [XERO_PIN_RELEASE_WITNESS_SETTING_KEY],
    },
  ]
}

/**
 * Does the receipt say WHAT it released at all (o3d-9tbz r8 finding 1)?
 *
 * A receipt with neither qualifier records only that a release happened once. That is the r7 finding
 * itself — exempt-by-presence — and it is also every receipt stamped before r7, including the ones the
 * old `--clear-tenant-pin` wrote for a pin it had not deleted. Those cannot be told apart from a
 * legitimate outstanding release by anything on the row, so nothing on the row may qualify them.
 *
 * ONE qualifier is enough to be "qualified" here, because a legitimate release on a token row that
 * predates `connectionGeneration` records a null generation quite properly — the released pin is the
 * qualifier that is always written. It then has to survive `releaseDescribesRow` like any other.
 */
function releaseIsQualified(binding: XeroStoredBinding): boolean {
  return (binding.pinReleasedGeneration ?? '').trim().length > 0
    || (binding.pinReleasedTenantId ?? '').trim().length > 0
}

/**
 * Does the receipt describe the row it is sitting on?
 *
 * Both halves are compared, and neither is redundant. The GENERATION catches a row that has been
 * rebound or replaced since the release — and any future writer that mints a generation without
 * clearing the receipt. The released PIN'S ORGANISATION catches the case the generation cannot see: a
 * release performed on an instance whose pin and token already named DIFFERENT organisations, where
 * deleting the pin does not resolve the split and must not be allowed to end the refusal for it. The
 * legitimate recovery satisfies both by construction — the Demo reset re-creates the organisation with
 * a new tenantId, but the pin being deleted is still the one this token was bound with, and the release
 * does not rebind anything.
 *
 * It does NOT, on its own, catch a wholesale-restored row: every value it compares came out of the same
 * dump. That is what the witness is for.
 */
function releaseDescribesRow(binding: XeroStoredBinding, storedTenantId: string | null | undefined): boolean {
  const sameGeneration = (binding.pinReleasedGeneration ?? '').trim() === (binding.connectionGeneration ?? '').trim()
  const releasedPin = normaliseId(binding.pinReleasedTenantId ?? '')
  const tokenTenant = normaliseId(storedTenantId ?? '')
  return sameGeneration && releasedPin.length > 0 && releasedPin === tokenTenant
}

/**
 * Does the half that stayed behind describe the same release as the half that travels?
 *
 * Compared against the RECEIPT rather than against the row, deliberately. The receipt has already been
 * checked against the row by the time this is asked, so comparing here would only repeat that; what is
 * being asked now is whether this instance is the one that performed this release, and the answer is
 * whether the release it remembers performing is this one.
 */
function witnessDescribesRelease(binding: XeroStoredBinding, witness: XeroReleaseWitness | null): boolean {
  if (!witness) return false
  const sameGeneration = (witness.generation ?? '').trim() === (binding.pinReleasedGeneration ?? '').trim()
  return sameGeneration && normaliseId(witness.tenantId) === normaliseId(binding.pinReleasedTenantId ?? '')
}

/**
 * @param storedTenantId the organisation the TOKEN ROW names, which is what the receipt is checked
 *   against. It is a required argument for the same reason `binding` is one in
 *   `storedXeroConnectionRefusal`: a receipt that is validated against nothing is a receipt that is
 *   simply believed, and that was the r7 finding.
 * @param witness the release witness from `settings`, or null when there is none. Required for the
 *   same reason again (r8): a receipt validated only against the row it arrived on is a receipt
 *   validated against a copy of itself.
 */
export function xeroPinAbsenceVerdict(
  binding: XeroStoredBinding,
  storedTenantId: string | null | undefined,
  witness: XeroReleaseWitness | null,
): XeroPinAbsenceVerdict {
  // The release is checked FIRST and beats the generation, because a released connection has both: it
  // was bound (so it has a generation) and then deliberately unpinned (so it has a receipt). Reading
  // them the other way round would halt the recovery this branch is required to keep working.
  //
  // But it is only checked first — never simply believed. Three questions, in the order that gives the
  // operator the message about the situation they are actually in: does the receipt say what it
  // released, does what it says still describe this row, and did THIS instance perform that release.
  if (binding.pinReleasedAt != null) {
    if (!releaseIsQualified(binding)) return 'unqualified-release'
    if (!releaseDescribesRow(binding, storedTenantId)) return 'stale-release'
    if (!witnessDescribesRelease(binding, witness)) return 'unwitnessed-release'
    return 'released'
  }
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
 *
 * AND THE RECEIPT IS NOT A PASS OF ITS OWN (o3d-9tbz r7). A receipt that only records that a release
 * HAPPENED is exempt-by-presence, and therefore survives the state it was written for: a dump of
 * accounting_tokens taken while a release was outstanding restores the exemption onto whatever binding
 * is here now — the same cross-backup restore this whole refusal exists for, arriving through the
 * escape hatch instead of round it. So the receipt names the generation it released and the
 * organisation the deleted pin named, both are checked against the row they are sitting on, and one
 * that no longer describes it is `stale-release`: refused, with its own message, because the operator
 * is looking at a different situation from a pin that simply vanished.
 *
 * AND A RECEIPT IS NOT EVIDENCE ABOUT ITSELF (o3d-9tbz r8). Two things were wrong with reading the r7
 * receipt off the token row alone, and they are one thing seen from two directions:
 *
 *   UNQUALIFIED. A receipt from before r7 records only that a release happened. It cannot be qualified
 *   retrospectively — the pre-r7 recovery stamped one even when it deleted no pin, so ON THE ROW ALONE
 *   a laundered receipt and a genuine outstanding release are the same bytes. Neither is qualified.
 *   UNWITNESSED. Every r7 qualifier is a column on the same row as the receipt, so a wholesale-restored
 *   `accounting_tokens` row agrees with itself. The release is therefore witnessed in `settings` too,
 *   by the same transaction, and a row that travelled here on its own cannot have brought that with it.
 *
 * Four refusals now, each about the state it describes: a pin that was lost, a receipt that describes
 * another state, a receipt that describes no state, and a receipt this instance never wrote. They share
 * one remedy — Disconnect, which clears both halves — because there is only one action that cannot
 * leave a fresh contradiction behind. They do not share a message, because they send the operator to
 * look at four different things.
 */
export function xeroMissingPinRefusal(
  stored: XeroConnectionSummary,
  binding: XeroStoredBinding,
  witness: XeroReleaseWitness | null,
): string | null {
  const verdict = xeroPinAbsenceVerdict(binding, stored.tenantId, witness)
  if (verdict === 'unqualified-release') return xeroUnqualifiedReleaseRefusal(stored, binding)
  if (verdict === 'stale-release') return xeroStaleReleaseRefusal(stored, binding)
  if (verdict === 'unwitnessed-release') return xeroUnwitnessedReleaseRefusal(stored, binding)
  if (verdict !== 'lost') return null
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
    + `release ends by itself at the next connect. Running it NOW will not lift this halt and is not `
    + `meant to: it records a release only when it is the statement that removes the pin, and the pin `
    + `is already gone. A pin removed any other way cannot be told apart from one that was lost. `
    + `If you are auditing what this instance has already posted, look in ${who}: everything it wrote `
    + `went to the token's organisation. The usual causes are a settings table and an accounting_tokens `
    + `table restored from different backups, a database copied here from another environment, or a `
    + `hand-run delete of the xero_expected_tenant_id row.`
  )
}

/**
 * A release receipt that belongs to a DIFFERENT state than the row it is on (o3d-9tbz r7).
 *
 * Its own refusal rather than a variant of the lost-pin one, because the operator is looking at
 * something else and would be sent to check the wrong history. A lost pin says "a pin was written
 * beside this token and something removed it". This says "this token row is carrying paperwork for a
 * connection it is not" — and the ONLY way to get here is a write to `accounting_tokens` that was not
 * made by a binding: a restored dump, a copied database, a hand-edited row. Every writer in IMS keeps
 * the receipt and the row it describes together in one transaction, and the binding clears the receipt
 * outright.
 *
 * The remedy is the same as every other broken-binding remedy, and deliberately so: Disconnect clears
 * both halves at once, which is the one action that cannot leave a new contradiction behind.
 */
function xeroStaleReleaseRefusal(stored: XeroConnectionSummary, binding: XeroStoredBinding): string {
  const who = describeXeroConnections([stored])
  const releasedPin = (binding.pinReleasedTenantId ?? '').trim()
  const when = binding.pinReleasedAt ? binding.pinReleasedAt.toISOString() : 'an unrecorded time'
  const mismatch = releasedPin.length === 0
    ? `it does not record which pin it released at all`
    : normaliseId(releasedPin) === normaliseId(stored.tenantId ?? '')
      ? `it released the pin for connection ${binding.pinReleasedGeneration ?? '(none)'}, and this token `
        + `belongs to connection ${binding.connectionGeneration ?? '(none)'}`
      : `it released a pin naming organisation ${releasedPin}, and this token belongs to ${who}`
  return (
    `Xero sync is halted: this instance's Xero token row carries a pin-release receipt that does not `
    + `describe it. The stored token belongs to ${who} and has no xero_expected_tenant_id setting beside `
    + `it, which would normally be either a deliberate release or a lost pin — but the release recorded `
    + `here (at ${when}) is for another state: ${mismatch}. `
    + `A release says "this exact connection is waiting to be told which organisation it belongs to", `
    + `so it stops meaning anything the moment the connection changes; IMS writes the receipt and the `
    + `row it describes in one transaction, and a new consent clears it. A receipt that has come apart `
    + `from its row therefore did not get here through IMS — the usual causes are an accounting_tokens `
    + `table restored from a backup taken while a release was outstanding, a database copied here from `
    + `another environment, or a hand-edited token row. `
    + `No Xero request was made. `
    + `To fix it: on /sync press Disconnect — that clears the token and the pin together — then connect `
    + `again and choose the organisation this instance is meant to use. Nothing in the server .env needs `
    + `editing, and re-running scripts/provision-xero-demo.ts --clear-tenant-pin will not clear this: it `
    + `records a release only when it is the statement that deletes the pin, and there is no pin here to `
    + `delete. `
    + `If you are auditing what this instance has already posted, look in ${who}: everything it wrote `
    + `went to the token's organisation.`
  )
}

/**
 * A release receipt that records only that a release HAPPENED (o3d-9tbz r8 finding 1).
 *
 * WHY THESE ARE NOT SIMPLY BACKFILLED. The migration that added the qualifiers could have stamped every
 * outstanding release with the values on its own row — the generation it carries and the tenant it
 * names — and that is what the first cut did, so that no rig mid-recovery was halted by the columns
 * arriving. It is the wrong trade, and not by a small margin. r7 established that the OLD recovery path
 * stamped a receipt even when it deleted no pin, which converted a halted (tamper-evident) instance
 * into an exempt one by running the documented runbook. Such a receipt is indistinguishable from a
 * legitimate outstanding one BY THE ROW IT SITS ON — that is precisely what made it laundering rather
 * than a mistake — so a backfill computed from the row qualifies both or neither. Qualifying both would
 * have re-legitimised the exact bypass r7 closed, in the migration that closed it.
 *
 * So neither is qualified, and the honest default is the one r7 already chose for a pin whose history
 * cannot be established: halt, and let a human say what this instance is bound to. The cost is real and
 * is bounded — an instance that was mid-recovery when this deployed is halted rather than exempt, and
 * its remedy is Disconnect-then-connect, which is the step the release was waiting for anyway.
 */
function xeroUnqualifiedReleaseRefusal(stored: XeroConnectionSummary, binding: XeroStoredBinding): string {
  const who = describeXeroConnections([stored])
  const when = binding.pinReleasedAt ? binding.pinReleasedAt.toISOString() : 'an unrecorded time'
  return (
    `Xero sync is halted: this instance's Xero token row records that its pin was released (at ${when}), `
    + `but not WHAT was released — no connection and no organisation. The stored token belongs to ${who} `
    + `and there is no xero_expected_tenant_id setting beside it. `
    + `A release means "this exact connection is waiting to be told which organisation it belongs to", `
    + `and a receipt that names no connection makes that claim about everything and nothing: it cannot `
    + `be checked, so it stops being evidence and becomes a permanent exemption from the check. IMS `
    + `will not treat it as one. `
    + `This is what every release recorded by an older version of IMS looks like, and those versions `
    + `also stamped a release when they deleted no pin at all — so a receipt in this shape cannot be `
    + `told apart from one left behind by a pin that was removed some other way. `
    + `No Xero request was made. `
    + `To fix it: on /sync press Disconnect — that clears the token and the pin together — then connect `
    + `again and choose the organisation this instance is meant to use. Nothing in the server .env needs `
    + `editing. If you had cleared the pin deliberately and were waiting to re-consent (a Xero Demo `
    + `reset), that is the same step you were about to take and nothing is lost: the token was already `
    + `unusable until the re-consent. Re-running scripts/provision-xero-demo.ts --clear-tenant-pin will `
    + `not clear this — it records a release only when it is the statement that deletes the pin, and `
    + `there is no pin here to delete. `
    + `If you are auditing what this instance has already posted, look in ${who}: everything it wrote `
    + `went to the token's organisation.`
  )
}

/**
 * A release the TOKEN ROW remembers and this INSTANCE does not (o3d-9tbz r8 finding 2).
 *
 * The r7 receipt and everything it is compared against are columns on one row, so a restored
 * `accounting_tokens` row carries the whole argument with it and wins it. The witness in `settings` is
 * the half that does not travel: written by the same transaction that deletes the pin, deleted by the
 * binding that ends the release, and left behind by any copy of the token row alone.
 *
 * The message says which half is missing rather than "your database was restored", because the other
 * way to reach this is a token row edited by hand, and because the operator's next question is where to
 * look.
 */
function xeroUnwitnessedReleaseRefusal(stored: XeroConnectionSummary, binding: XeroStoredBinding): string {
  const who = describeXeroConnections([stored])
  const when = binding.pinReleasedAt ? binding.pinReleasedAt.toISOString() : 'an unrecorded time'
  return (
    `Xero sync is halted: this instance's Xero token row carries a pin-release receipt (from ${when}) `
    + `that this instance has no record of writing. The stored token belongs to ${who} and has no `
    + `xero_expected_tenant_id setting beside it. `
    + `IMS records a release in two places in one transaction — on the token row, and beside the pin it `
    + `deletes — precisely so that the receipt cannot be the only witness to itself. A token row copied `
    + `from somewhere else brings its receipt and its own connection marker with it, and they agree with `
    + `each other because they came from the same place; what it cannot bring is the half that stays `
    + `behind with the instance that performed the release. That half is not here, so this release was `
    + `not performed here. `
    + `No Xero request was made. `
    + `The usual causes are an accounting_tokens table restored from a backup taken while a release was `
    + `outstanding, a token row copied from another environment, or a hand-edited row. `
    + `To fix it: on /sync press Disconnect — that clears the token and the pin together — then connect `
    + `again and choose the organisation this instance is meant to use. Nothing in the server .env needs `
    + `editing to clear this halt. Note that a copy of the WHOLE database brings both halves and cannot `
    + `be detected here at all: on a server that must never reach a live ledger, `
    + `XERO_BLOCKED_TENANT_IDS / XERO_REQUIRE_DEMO_ORG are what refuse a restored token, and this halt `
    + `does not stand in for them. `
    + `If you are auditing what this instance has already posted, look in ${who}: everything it wrote `
    + `went to the token's organisation.`
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
  witness: XeroReleaseWitness | null,
): string | null {
  if ((pinnedTenantId ?? '').trim().length > 0) return xeroBindingMismatchRefusal(stored, pinnedTenantId)
  return xeroMissingPinRefusal(stored, binding, witness)
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

  // o3d-iaqy. Before the connection list too: the point is that this instance may not pick from a list
  // it was never entitled to be offered, so refusing here means no organisation is even named back to a
  // rig that should not have been consenting at all.
  if (allowList.unguardedInstance) {
    return { ok: false, reason: 'unguarded-instance', error: xeroUnguardedInstanceRefusal(allowList) }
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

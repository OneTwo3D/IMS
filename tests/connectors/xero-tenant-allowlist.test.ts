import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  demoOrgConnectRefusal, demoOrgStoredRefusal, describeXeroConnections, isXeroTenantAllowed,
  nameOnlyGuardWarning, readXeroTenantAllowList, selectXeroTenant, storedTenantRefusalMessage,
  parseXeroReleaseWitness, serializeXeroReleaseWitness,
  storedXeroConnectionRefusal, xeroDemoOrgVerdict, xeroMissingPinRefusal, xeroPinAbsenceVerdict,
  xeroPinEstablishmentStatements, xeroTenantBindingRaceMessage, xeroTenantVerdict,
  xeroUnguardedInstanceRefusal,
  XERO_PIN_RELEASE_WITNESS_SETTING_KEY, XERO_TENANT_PIN_SETTING_KEY,
  type XeroConnectionSummary, type XeroPinSqlStatement, type XeroReleaseWitness, type XeroStoredBinding,
} from '@/lib/connectors/xero/tenant-guard'

/**
 * What the TOKEN ROW says about its own binding (o3d-9tbz r6, r7) — the states an absent pin can be in.
 *
 * These are not decoration. `storedXeroConnectionRefusal` now takes them as a required argument, because
 * the hole r6 closed was an absent value being read as permission: BOUND with no pin beside it is the
 * bypass, and the other two are the states that must keep working.
 *
 * r7 adds the one the receipt itself can be wrong in. A release is exempt because of what it says about
 * THIS row, so the same timestamp on a row it does not describe is not a smaller version of the same
 * evidence — it is evidence about something else, and STALE_RELEASE_* are what tell them apart.
 */
/** Written by a binding: the transaction that minted this marker wrote the pin in the same breath. */
const BOUND: XeroStoredBinding = {
  connectionGeneration: 'gen-a1b2', pinReleasedAt: null,
  pinReleasedGeneration: null, pinReleasedTenantId: null,
}
/** A row from before the marker existed. Evidence of nothing — every pre-pin installation is here. */
const PRE_MARKER: XeroStoredBinding = {
  connectionGeneration: null, pinReleasedAt: null,
  pinReleasedGeneration: null, pinReleasedTenantId: null,
}
/**
 * The documented recovery's receipt: --clear-tenant-pin deleted the pin and stamped all three columns
 * in one transaction. The receipt names the connection it released and the pin it deleted — which, on a
 * whole binding, is this row's generation and this row's organisation.
 */
const RELEASED: XeroStoredBinding = {
  connectionGeneration: 'gen-a1b2', pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
  pinReleasedGeneration: 'gen-a1b2', pinReleasedTenantId: 'e7fb4378-live-org',
}
/**
 * A receipt that has OUTLIVED the connection it was written for: released under gen-a1b2, and the row
 * has since been rebound. Nothing in IMS produces this — a binding clears the receipt and a refresh
 * carries it with the row it belongs to — which is the point: it is what a restored accounting_tokens
 * dump, taken while a release was outstanding, looks like on top of a connection made afterwards.
 */
const STALE_RELEASE_OTHER_CONNECTION: XeroStoredBinding = {
  connectionGeneration: 'gen-c3d4', pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
  pinReleasedGeneration: 'gen-a1b2', pinReleasedTenantId: 'e7fb4378-live-org',
}
/**
 * A receipt for a pin that named a DIFFERENT organisation from the token it is sitting beside — what
 * releasing one half of an already-SPLIT binding leaves behind. Deleting one side of a contradiction
 * does not resolve it, so this must not end the refusal.
 */
const STALE_RELEASE_OTHER_ORG: XeroStoredBinding = {
  connectionGeneration: 'gen-a1b2', pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
  pinReleasedGeneration: 'gen-a1b2', pinReleasedTenantId: '5c949ed5-demo-org',
}
/**
 * A release stamped with no record of WHICH pin it released: every receipt written before r7, and
 * anything inserted by hand. Exempt-by-presence was the r7 finding, so an unqualified receipt cannot
 * be honoured — and, per r8, cannot be qualified after the fact either.
 */
const UNQUALIFIED_RELEASE: XeroStoredBinding = {
  connectionGeneration: 'gen-a1b2', pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
  pinReleasedGeneration: null, pinReleasedTenantId: null,
}
/**
 * THE TWO DOUBLES THE r8 BACKFILL WOULD HAVE HAD TO TELL APART (finding 1).
 *
 * A release that was genuinely outstanding when the receipt columns arrived — an operator mid-recovery,
 * waiting to re-consent after a Demo reset — and a receipt the OLD `--clear-tenant-pin` stamped for a
 * pin it had never deleted, which is how r7 found that a halted instance could be laundered into an
 * exempt one by following the runbook. They are declared separately and are identical field for field,
 * which is not a coincidence to be tidied up: it is the finding. A backfill computed from the row can
 * only qualify both or neither.
 */
const RELEASE_OUTSTANDING_AT_DEPLOY: XeroStoredBinding = {
  connectionGeneration: 'gen-a1b2', pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
  pinReleasedGeneration: null, pinReleasedTenantId: null,
}
const LAUNDERED_PRE_R7_RECEIPT: XeroStoredBinding = {
  connectionGeneration: 'gen-a1b2', pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
  pinReleasedGeneration: null, pinReleasedTenantId: null,
}
/**
 * A token row restored WHOLESALE from a dump taken while a release was outstanding (r8 finding 2).
 *
 * Receipt, qualifiers, generation and tenant all came out of the same dump, so every r7 check compares
 * the dump against itself and passes. It is field-for-field identical to RELEASED — that is the point:
 * nothing ON THE ROW distinguishes them, so the distinguishing evidence has to be somewhere else.
 */
const RESTORED_MID_RELEASE_ROW: XeroStoredBinding = {
  connectionGeneration: 'gen-a1b2', pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
  pinReleasedGeneration: 'gen-a1b2', pinReleasedTenantId: 'e7fb4378-live-org',
}
/**
 * The half of the receipt that stays with the instance: what `--clear-tenant-pin` writes into
 * `settings` beside the pin it is deleting, in the same transaction that stamps the token row.
 */
const RELEASE_WITNESS: XeroReleaseWitness = { generation: 'gen-a1b2', tenantId: 'e7fb4378-live-org' }
/** A witness for a DIFFERENT release: this instance released something once, but not this. */
const WITNESS_FOR_ANOTHER_RELEASE: XeroReleaseWitness = { generation: 'gen-c3d4', tenantId: 'e7fb4378-live-org' }

/**
 * o3d-9tbz. `selectTenantConnection` used to return `connections[0]` whenever no tenant was pinned, and
 * a pin only exists in the DATABASE — so a fresh e2e rig, a reset or a restored dump had none, and the
 * first consent silently bound whichever organisation Xero happened to list first. That is how the e2e
 * rig invoiced into the LIVE ledger (o3d-t74p): 150 invoices, 111 contacts, 217 items, 14 payments.
 *
 * The double here is the (connections, expectedTenantId, allowList) triple, which can express every
 * state that matters: zero organisations, exactly one, several, a pinned instance and an unpinned fresh
 * database — including the combinations that pull in opposite directions.
 */

const LIVE: XeroConnectionSummary = { tenantId: 'e7fb4378-live-org', tenantName: 'OneTwo3D Ltd' }
const DEMO: XeroConnectionSummary = { tenantId: '5c949ed5-demo-org', tenantName: 'Demo Company (UK)' }
const THIRD: XeroConnectionSummary = { tenantId: '9aa10000-third-org', tenantName: 'Bookkeeper Sandbox' }

const NO_ALLOW_LIST = readXeroTenantAllowList({ NODE_ENV: 'production' })
const DEMO_BY_ID = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_IDS: DEMO.tenantId })
const DEMO_BY_NAME = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' })


// --- the bug itself ----------------------------------------------------------

test('a fresh database offered SEVERAL organisations refuses instead of taking the first', () => {
  // The incident, exactly: no pin, live org sorted first, and the old code returned it without a word.
  const choice = selectXeroTenant({
    connections: [LIVE, DEMO],
    expectedTenantId: null,
    allowList: NO_ALLOW_LIST,
  })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'ambiguous')
})

test('the ambiguous refusal names every organisation, with ids, and says how to choose', () => {
  // An unperformable remedy is worse than none: the operator has to be able to act on this text alone.
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList: NO_ALLOW_LIST })
  assert.equal(choice.ok, false)
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /OneTwo3D Ltd/)
  assert.match(error, new RegExp(LIVE.tenantId))
  assert.match(error, /Demo Company \(UK\)/)
  assert.match(error, new RegExp(DEMO.tenantId))
  assert.match(error, /XERO_ALLOWED_TENANT_IDS/)
  assert.match(error, /Nothing was stored/)
  assert.match(error, /Connected apps/)
})

test('ordinary first-time setup — ONE organisation, fresh database — still connects', () => {
  // The constraint that outranks the bug: a change that makes first-time setup impossible is worse.
  const choice = selectXeroTenant({ connections: [DEMO], expectedTenantId: null, allowList: NO_ALLOW_LIST })
  assert.equal(choice.ok, true)
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
})

test('a pinned instance is unaffected — it takes the pin, not the first entry', () => {
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: DEMO.tenantId, allowList: NO_ALLOW_LIST })
  assert.equal(choice.ok, true)
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
})

test('a pin the consent did not include is refused, and the refusal lists what WAS offered', () => {
  const choice = selectXeroTenant({ connections: [LIVE], expectedTenantId: DEMO.tenantId, allowList: NO_ALLOW_LIST })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'pinned-not-offered')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, new RegExp(DEMO.tenantId), 'names the pin it was looking for')
  assert.match(error, /OneTwo3D Ltd/, 'names what the consent actually offered')
  assert.match(error, /disconnect Xero on \/sync/i)
})


// --- an empty list is not an error ------------------------------------------

test('zero organisations is reported as a possible REVOCATION, not a generic failure', () => {
  // Xero answers a revoked authorisation with 200 and an empty array. Reporting that as "no
  // organisations found" sends the operator looking for the wrong problem.
  const choice = selectXeroTenant({ connections: [], expectedTenantId: null, allowList: NO_ALLOW_LIST })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'no-connections')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /REVOKED/)
  assert.match(error, /Connected apps/)
})

test('zero organisations is refused the same way when a pin exists', () => {
  const choice = selectXeroTenant({ connections: [], expectedTenantId: DEMO.tenantId, allowList: DEMO_BY_ID })
  assert.equal(choice.ok === false && choice.reason, 'no-connections')
})


// --- the env allow-list ------------------------------------------------------

test('the allow-list picks its organisation out of several, with no pin at all', () => {
  // This is the control that survives a database reset — the state the incident happened in.
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList: DEMO_BY_ID })
  assert.equal(choice.ok, true)
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
})

test('an allow-list by NAME works the same way, case- and whitespace-insensitively', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_NAMES: '  demo   company (uk) ' })
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
})

test('an allow-listed organisation that the consent does not offer is refused, naming both sides', () => {
  const choice = selectXeroTenant({ connections: [LIVE], expectedTenantId: null, allowList: DEMO_BY_ID })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'none-allowed')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /OneTwo3D Ltd/, 'what was offered')
  assert.match(error, new RegExp(DEMO.tenantId), 'what is allowed')
  assert.match(error, /XERO_ALLOWED_TENANT_IDS/)
  assert.match(error, /no Xero data was read or written/)
})

test('the allow-list overrides a DATABASE pin — a restored dump cannot smuggle its org through', () => {
  // A production dump restored onto the rig arrives with xero_expected_tenant_id already set to the live
  // org. Applying the pin first would hand it straight back.
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: LIVE.tenantId, allowList: DEMO_BY_ID })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'pinned-not-allowed')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /OneTwo3D Ltd/)
  assert.match(error, new RegExp(DEMO.tenantId))
})

test('an allow-list matching SEVERAL of the offered organisations is still ambiguous', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_IDS: `${DEMO.tenantId}, ${THIRD.tenantId}` })
  const choice = selectXeroTenant({ connections: [LIVE, DEMO, THIRD], expectedTenantId: null, allowList })
  assert.equal(choice.ok === false && choice.reason, 'ambiguous')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /Demo Company \(UK\)/)
  assert.match(error, /Bookkeeper Sandbox/)
  assert.doesNotMatch(error, /OneTwo3D Ltd/, 'the forbidden org is not offered as a choice')
})

test('the allow-list narrowing several organisations down to ONE is enough to proceed unpinned', () => {
  const choice = selectXeroTenant({ connections: [LIVE, DEMO, THIRD], expectedTenantId: null, allowList: DEMO_BY_NAME })
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
})


// --- reading the env ---------------------------------------------------------

test('an unset allow-list allows everything — it is opt-in, production may not set it', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production' })
  assert.equal(allowList.configured, false)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
})

test('a BLANK allow-list is unset, not "allow nothing"', () => {
  // .env.example ships the keys. A blank line in a config file must not disable every Xero connection.
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_IDS: '   ', XERO_ALLOWED_TENANT_NAMES: ' , ,' })
  assert.equal(allowList.configured, false)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true)
})

test('ids are matched case-insensitively and tolerate spaces around the commas', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_IDS: ` ${DEMO.tenantId.toUpperCase()} , ` })
  assert.deepEqual(allowList.rawIds, [DEMO.tenantId.toUpperCase()])
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('ids and names INTERSECT — a name cannot admit an organisation the id list excludes', () => {
  // This was a union, and the union was the bug (r2 finding 1): a name is not an identity, so letting one
  // ADD an organisation meant an org renamed to an allow-listed name walked past the id list.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: THIRD.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(isXeroTenantAllowed(DEMO, allowList), false, 'the name does not admit an id that is not listed')
  assert.equal(isXeroTenantAllowed(THIRD, allowList), false, 'and the id does not survive a name it fails')
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('a name NARROWS an id list, and both together admit the organisation they agree on', () => {
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: `${DEMO.tenantId},${THIRD.tenantId}`,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
  assert.equal(isXeroTenantAllowed(THIRD, allowList), false, 'on the id list, but not on the name list')
})

test('an organisation RENAMED to an allow-listed name is still refused by the id list', () => {
  // A Xero organisation name is mutable and operator-controlled. Under the old union this passed.
  const renamedLive = { tenantId: LIVE.tenantId, tenantName: 'Demo Company (UK)' }
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(isXeroTenantAllowed(renamedLive, allowList), false, 'a rename does not confer identity')
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
})

test('a nameless organisation is not admitted by an empty name entry', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' })
  assert.equal(isXeroTenantAllowed({ tenantId: 'x', tenantName: null }, allowList), false)
  assert.equal(isXeroTenantAllowed({ tenantId: 'x' }, allowList), false)
})


// --- how organisations are described ----------------------------------------

test('every organisation is listed with the id needed to configure it', () => {
  assert.equal(
    describeXeroConnections([DEMO, LIVE]),
    'Demo Company (UK) [tenantId 5c949ed5-demo-org], OneTwo3D Ltd [tenantId e7fb4378-live-org]',
  )
})

test('a very long consent is truncated but says so, and an unnamed org still shows its id', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ tenantId: `id-${i}`, tenantName: `Org ${i}` }))
  const described = describeXeroConnections(many)
  assert.match(described, /\(\+3 more\)$/)
  assert.match(describeXeroConnections([{ tenantId: 'id-only', tenantName: '  ' }]), /\(unnamed organisation\) \[tenantId id-only\]/)
})


// --- the stored-token refusal ------------------------------------------------

test('the stored-token refusal names the org, the allow-list, and both ways out', () => {
  // The restored-dump case: no callback ever runs, so this message is the only thing the operator sees.
  const message = storedTenantRefusalMessage(LIVE, DEMO_BY_ID)
  assert.match(message, /OneTwo3D Ltd/)
  assert.match(message, new RegExp(LIVE.tenantId))
  assert.match(message, new RegExp(DEMO.tenantId))
  assert.match(message, /No Xero request was made/)
  assert.match(message, /disconnect Xero on \/sync/i)
  assert.match(message, /restored here with its Xero token/)
})


// --- XERO_TENANT_ID: the phantom control -------------------------------------
//
// `XERO_TENANT_ID` shipped in .env.example, scripts/install.sh and CLAUDE.md and NOTHING read it. An
// operator who set it to their live org believed the tenant was pinned and had no protection at all —
// strictly worse than an absent setting, because the name buys confidence the code never honoured. It
// is now a deprecated single-tenant spelling of XERO_ALLOWED_TENANT_IDS, enforced on the same paths.

const LEGACY_DEMO = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_TENANT_ID: DEMO.tenantId })

test('XERO_TENANT_ID set ALONE is a configured allow-list, not an ignored decoration', () => {
  // The whole finding in one assertion: this used to be `configured: false` and admit every org.
  assert.equal(LEGACY_DEMO.configured, true)
  assert.equal(LEGACY_DEMO.legacyTenantId, DEMO.tenantId)
  assert.equal(isXeroTenantAllowed(DEMO, LEGACY_DEMO), true)
  assert.equal(isXeroTenantAllowed(LIVE, LEGACY_DEMO), false, 'the live org is refused by XERO_TENANT_ID alone')
})

test('XERO_TENANT_ID alone protects the incident case — several orgs, no pin, live org first', () => {
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList: LEGACY_DEMO })
  assert.equal(choice.ok, true)
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId, 'not connections[0]')
})

test('XERO_TENANT_ID alone overrides a DATABASE pin, exactly as the modern key does', () => {
  // The restored-dump shape: the dump brings a pin to the live org, the env says otherwise, env wins.
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: LIVE.tenantId, allowList: LEGACY_DEMO })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'pinned-not-allowed')
})

test('a BLANK XERO_TENANT_ID is unset — .env.example and install.sh both ship it empty', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_TENANT_ID: '   ' })
  assert.equal(allowList.configured, false)
  assert.equal(allowList.legacyTenantId, null)
  assert.equal(allowList.conflict, null)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true, 'a blank line must not disable Xero on every box')
})

test('XERO_TENANT_ID is matched case-insensitively, like every other id here', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_TENANT_ID: ` ${DEMO.tenantId.toUpperCase()} ` })
  assert.equal(allowList.configured, true)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
  // Without the refusal half this passes vacuously: an unread variable leaves the list unconfigured,
  // and an unconfigured list says yes to everything.
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})


// --- the two keys disagreeing -------------------------------------------------

test('XERO_TENANT_ID disagreeing with XERO_ALLOWED_TENANT_IDS refuses BOTH orgs, not one of them', () => {
  // Preferring either value silently discards an instruction the operator gave on purpose, on a money
  // path. A union would WIDEN what `XERO_TENANT_ID=<one org>` was written to restrict.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_TENANT_ID: DEMO.tenantId,
    XERO_ALLOWED_TENANT_IDS: LIVE.tenantId,
  })
  assert.notEqual(allowList.conflict, null)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), false, 'not even the one both could be read to allow')
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('the conflict refusal quotes both settings and gives a one-line fix', () => {
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_TENANT_ID: DEMO.tenantId,
    XERO_ALLOWED_TENANT_IDS: LIVE.tenantId,
  })
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'config-conflict')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, new RegExp(`XERO_TENANT_ID=${DEMO.tenantId}`), 'quotes the deprecated value')
  assert.match(error, new RegExp(`XERO_ALLOWED_TENANT_IDS=${LIVE.tenantId}`), 'quotes the modern value')
  assert.match(error, /DEPRECATED/)
  assert.match(error, /delete that line/)
  assert.match(error, /nothing was stored/i)
})

test('a conflict is refused BEFORE the connection list — even a single-org consent is not waved through', () => {
  // Ordinary first-time setup is the one case allowed to proceed on its own, but not while the server's
  // own configuration contradicts itself: we would have no basis for saying this org is the right one.
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_TENANT_ID: DEMO.tenantId, XERO_ALLOWED_TENANT_IDS: LIVE.tenantId })
  const choice = selectXeroTenant({ connections: [DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'config-conflict')
})

test('the two keys set to the SAME single organisation is not a conflict', () => {
  // Belt and braces during a migration off the deprecated name must not be an outage.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_TENANT_ID: DEMO.tenantId,
    XERO_ALLOWED_TENANT_IDS: ` ${DEMO.tenantId.toUpperCase()} `,
  })
  assert.equal(allowList.conflict, null)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('the stored-token refusal under a conflict does NOT give the allow-list remedy', () => {
  // "add its tenantId to XERO_ALLOWED_TENANT_IDS" leaves the contradiction in place and the sync still
  // halted — a remedy whose faithful execution changes nothing.
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_TENANT_ID: DEMO.tenantId, XERO_ALLOWED_TENANT_IDS: LIVE.tenantId })
  const message = storedTenantRefusalMessage(LIVE, allowList)
  assert.match(message, /contradict each other/)
  assert.match(message, /delete that line/)
  assert.match(message, new RegExp(LIVE.tenantId))
})


// --- remedies that can actually be performed ----------------------------------

test('a legacy-key operator is told to REPLACE the line, never to add a second one', () => {
  // Told to "add its tenantId to XERO_ALLOWED_TENANT_IDS", an operator running on XERO_TENANT_ID who
  // does exactly that ends up with both keys set and disagreeing — i.e. the conflict refusal. The
  // remedy has to leave them working, not one step further from it.
  const message = storedTenantRefusalMessage(LIVE, LEGACY_DEMO)
  assert.match(message, /XERO_TENANT_ID/, 'names the key that is actually in their .env')
  assert.match(message, /deprecated/i)
  assert.match(message, new RegExp(`replace the XERO_TENANT_ID line[\\s\\S]*XERO_ALLOWED_TENANT_IDS=${LIVE.tenantId}`))
  assert.doesNotMatch(message, /add its\s*tenantId/, 'never the additive instruction that creates a conflict')
})

test('the none-allowed refusal under a legacy key is also phrased as a replacement', () => {
  const choice = selectXeroTenant({ connections: [LIVE], expectedTenantId: null, allowList: LEGACY_DEMO })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'none-allowed')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /replace the XERO_TENANT_ID line/)
})

test('a modern-key operator is still told to SET the modern key, with no deprecation noise', () => {
  const message = storedTenantRefusalMessage(LIVE, DEMO_BY_ID)
  assert.match(message, new RegExp(`set XERO_ALLOWED_TENANT_IDS=${LIVE.tenantId}`))
  assert.doesNotMatch(message, /XERO_TENANT_ID/, 'a deprecated key they do not use is not their business')
})


// --- a NAME is not an identity (r2 finding 1) ---------------------------------
//
// A Xero organisation name is mutable, non-unique and controlled by whoever administers the
// organisation — "Demo Company (UK)" is what Xero calls EVERY demo company. The first cut of this file
// treated XERO_ALLOWED_TENANT_NAMES as interchangeable with XERO_ALLOWED_TENANT_IDS, unioned, so a name
// could ADMIT an organisation the id list excluded. The four states that matter are a renamed
// organisation, two organisations sharing a name, an id and a name naming the SAME organisation, and an
// id and a name genuinely disagreeing. All four are below.

/** The live org after somebody renames it in Xero to the string the rig allow-lists. */
const LIVE_RENAMED: XeroConnectionSummary = { tenantId: LIVE.tenantId, tenantName: 'Demo Company (UK)' }
/** A second, different organisation that happens to carry the same name. */
const OTHER_DEMO: XeroConnectionSummary = { tenantId: 'aa000000-other-demo', tenantName: 'Demo Company (UK)' }

test('two organisations sharing a name refuse the consent instead of picking one of them', () => {
  // A name that matches two organisations on one consent has proved, in that consent, that it identifies
  // neither. Using it to choose is connections[0] with extra steps.
  const choice = selectXeroTenant({ connections: [DEMO, OTHER_DEMO], expectedTenantId: null, allowList: DEMO_BY_NAME })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'ambiguous-name')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, new RegExp(DEMO.tenantId), 'names both organisations it could not choose between')
  assert.match(error, new RegExp(OTHER_DEMO.tenantId))
  assert.match(error, /not unique and can be changed/)
  assert.match(error, /XERO_ALLOWED_TENANT_IDS/)
  assert.match(error, /no Xero data\s+was read or written/)
})

test('a DATABASE pin does not rescue a name that matches two organisations', () => {
  // The pin would resolve the choice, but leaving the name in place would leave a control that does no
  // work looking like it does — and the next fresh database has no pin at all.
  const choice = selectXeroTenant({ connections: [DEMO, OTHER_DEMO], expectedTenantId: DEMO.tenantId, allowList: DEMO_BY_NAME })
  assert.equal(choice.ok === false && choice.reason, 'ambiguous-name')
})

test('an ambiguous name alongside an id list is told to DELETE the name line', () => {
  // Telling this operator to "set XERO_ALLOWED_TENANT_IDS=..." would put a second id key beside the one
  // they already have — the conflict refusal. The id already identifies the org; the name is the surplus.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  const choice = selectXeroTenant({ connections: [DEMO, OTHER_DEMO], expectedTenantId: null, allowList })
  const error = choice.ok === false ? choice.error : ''
  assert.equal(choice.ok === false && choice.reason, 'ambiguous-name')
  assert.match(error, /Delete the XERO_ALLOWED_TENANT_NAMES line/)
  assert.doesNotMatch(error, /Replace the XERO_ALLOWED_TENANT_NAMES/, 'no second id key beside the first')
})

test('an ambiguous name with no id anywhere is told to REPLACE it with an id', () => {
  const choice = selectXeroTenant({ connections: [DEMO, OTHER_DEMO], expectedTenantId: null, allowList: DEMO_BY_NAME })
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /Replace the XERO_ALLOWED_TENANT_NAMES line/)
  assert.match(error, /XERO_ALLOWED_TENANT_IDS=<exactly one of the tenantIds above>/)
})

test('the stored-token refusal says a NAME failed, so a rename is not misread as a restored database', () => {
  // "the allow-list forbids it" sends the operator looking for the wrong problem. What actually failed
  // here is a string comparison against a label somebody can change from Xero's settings screen.
  const message = storedTenantRefusalMessage(LIVE, DEMO_BY_NAME)
  assert.match(message, /its name is not on XERO_ALLOWED_TENANT_NAMES=Demo Company \(UK\)/)
  assert.match(message, /can be renamed at any time/)
})

test('an operator holding only a name list is told to REPLACE it, never to add an id beside it', () => {
  // Names and ids compose as filters, so adding an id whose organisation is not on the name list lands
  // in the empty-intersection refusal. A remedy whose faithful execution refuses again is not a remedy.
  const message = storedTenantRefusalMessage(LIVE, DEMO_BY_NAME)
  assert.match(message, new RegExp(`replace the XERO_ALLOWED_TENANT_NAMES line[\\s\\S]*XERO_ALLOWED_TENANT_IDS=${LIVE.tenantId}`))
  assert.match(message, /would contradict it/)
})

test('a name-only configuration is flagged as having no identity anchor', () => {
  assert.equal(DEMO_BY_NAME.nameOnlyGuard, true)
  assert.equal(DEMO_BY_ID.nameOnlyGuard, false, 'an id is an identity')
  assert.equal(
    readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)', XERO_BLOCKED_TENANT_IDS: LIVE.tenantId }).nameOnlyGuard,
    false,
    'and so is a deny-listed id',
  )
  assert.equal(readXeroTenantAllowList({ NODE_ENV: 'production' }).nameOnlyGuard, false, 'no guard at all is not a name-only guard')
})

test('the name-only warning names the remedy that survives a rotating tenantId', () => {
  const warning = nameOnlyGuardWarning(DEMO_BY_NAME)
  assert.match(warning, /not an identity/)
  assert.match(warning, /rename it/)
  assert.match(warning, /XERO_ALLOWED_TENANT_IDS=/)
  assert.match(warning, /XERO_BLOCKED_TENANT_IDS=/, 'the maintenance-free one, for the Demo rig')
})


// --- XERO_BLOCKED_TENANT_IDS: identity-strength denial ------------------------
//
// The e2e rig binds to Xero's Demo company, whose tenantId is RE-ISSUED at every ~28-day reset, so an
// id allow-list has to be re-edited every cycle and a control that annoying gets switched off. The LIVE
// organisation's id is the stable one. Blocking it is identity-strength, needs no maintenance, and
// covers the connect path and the stored-token path alike.

const BLOCK_LIVE = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_BLOCKED_TENANT_IDS: LIVE.tenantId })

test('the deny-list refuses the live org and lets the demo org through, with no pin and no allow-list', () => {
  // The incident's exact state — fresh database, live org first — closed by an id, not by a name.
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList: BLOCK_LIVE })
  assert.equal(choice.ok, true)
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
})

test('the deny-list survives the Demo rotation: a brand-new tenantId needs no .env edit', () => {
  // The whole reason the rig was told to use names. Two consecutive resets, same .env line.
  for (const rotated of ['5c949ed5-demo-cycle-2', '5c949ed5-demo-cycle-3']) {
    const choice = selectXeroTenant({
      connections: [LIVE, { tenantId: rotated, tenantName: 'Demo Company (UK)' }],
      expectedTenantId: null,
      allowList: BLOCK_LIVE,
    })
    assert.equal(choice.ok === true && choice.connection.tenantId, rotated)
  }
})

test('after a rotation the stale DATABASE pin is refused, and the refusal says to disconnect first', () => {
  // The operational step the runbook has to carry: the pin still names the retired demo tenantId.
  const choice = selectXeroTenant({
    connections: [LIVE, { tenantId: '5c949ed5-demo-cycle-2', tenantName: 'Demo Company (UK)' }],
    expectedTenantId: DEMO.tenantId,
    allowList: BLOCK_LIVE,
  })
  assert.equal(choice.ok === false && choice.reason, 'pinned-not-offered')
  assert.match(choice.ok === false ? choice.error : '', /disconnect Xero on \/sync first/)
})

test('blocking the live org disambiguates a name that a rename made shared', () => {
  // Order is load-bearing: the deny-list runs before the name check, so removing the live org is what
  // leaves exactly one "Demo Company (UK)" on the consent.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
    XERO_BLOCKED_TENANT_IDS: LIVE.tenantId,
  })
  const choice = selectXeroTenant({ connections: [LIVE_RENAMED, DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)

  // Without the deny-list the same consent is exactly the ambiguity the name cannot resolve.
  const unblocked = selectXeroTenant({ connections: [LIVE_RENAMED, DEMO], expectedTenantId: null, allowList: DEMO_BY_NAME })
  assert.equal(unblocked.ok === false && unblocked.reason, 'ambiguous-name')
})

test('a consent offering nothing but blocked organisations is refused as blocked, naming the key', () => {
  const choice = selectXeroTenant({ connections: [LIVE], expectedTenantId: null, allowList: BLOCK_LIVE })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'blocked')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /XERO_BLOCKED_TENANT_IDS=e7fb4378-live-org/)
  assert.match(error, /OneTwo3D Ltd/)
  assert.match(error, /Nothing was stored/)
})

test('the deny-list overrides a DATABASE pin to the blocked organisation', () => {
  // A restored production dump brings its own pin. Env is the only thing that does not come with it.
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: LIVE.tenantId, allowList: BLOCK_LIVE })
  assert.equal(choice.ok === false && choice.reason, 'pinned-not-allowed')
  assert.match(choice.ok === false ? choice.error : '', /on XERO_BLOCKED_TENANT_IDS/)
})

test('a STORED token for a blocked organisation is refused, which is the restored-dump case', () => {
  assert.equal(xeroTenantVerdict(LIVE, BLOCK_LIVE), 'blocked')
  assert.equal(isXeroTenantAllowed(LIVE, BLOCK_LIVE), false)
  assert.equal(isXeroTenantAllowed(DEMO, BLOCK_LIVE), true, 'and everything else is untouched')
  assert.match(storedTenantRefusalMessage(LIVE, BLOCK_LIVE), /on XERO_BLOCKED_TENANT_IDS=e7fb4378-live-org/)
})

test('allowing and blocking the same organisation is a conflict, not a silent deny-wins', () => {
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_BLOCKED_TENANT_IDS: `${LIVE.tenantId},${DEMO.tenantId.toUpperCase()}`,
  })
  assert.notEqual(allowList.conflict, null)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), false)
  const error = selectXeroTenant({ connections: [DEMO], expectedTenantId: null, allowList })
  assert.equal(error.ok === false && error.reason, 'config-conflict')
  assert.match(allowList.conflict ?? '', /ONE of the two lines/)
  assert.match(allowList.conflict ?? '', /XERO_ALLOWED_TENANT_IDS/)
  assert.match(allowList.conflict ?? '', /XERO_BLOCKED_TENANT_IDS/)
})

test('the same clash through the DEPRECATED key names XERO_TENANT_ID, the line they can find', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_TENANT_ID: DEMO.tenantId, XERO_BLOCKED_TENANT_IDS: DEMO.tenantId })
  assert.match(allowList.conflict ?? '', /XERO_TENANT_ID/)
  assert.doesNotMatch(allowList.conflict ?? '', /XERO_ALLOWED_TENANT_IDS/, 'not a key that is not in their .env')
})

test('a blank deny-list is unset, not "block nothing in a way that changes something"', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_BLOCKED_TENANT_IDS: ' , ' })
  assert.equal(allowList.configured, false)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true)
})


// --- an id and a name naming ONE organisation (r2 finding 2) -------------------

test('XERO_TENANT_ID and that same organisation NAME are one instruction, not a conflict', () => {
  // These two spellings name a single organisation. Refusing them was the r2 finding-2 bug: the conflict
  // refusal has to fire on genuine disagreement, not on two ways of saying the same thing.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_TENANT_ID: DEMO.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'demo company (uk)',
  })
  assert.equal(allowList.conflict, null)
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok, true)
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false, 'and the live org is still refused')
})

test('XERO_ALLOWED_TENANT_IDS and that same organisation NAME are likewise not a conflict', () => {
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(allowList.conflict, null)
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
})

test('an id and a name selecting DIFFERENT organisations on one consent IS a disagreement', () => {
  // Equivalence is decided against the organisations, so disagreement has to be too: each key picks a
  // real organisation out of this consent, and they are not the same one.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'OneTwo3D Ltd',
  })
  assert.equal(allowList.conflict, null, 'not decidable from the env alone')
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'config-conflict')
  const error = choice.ok === false ? choice.error : ''
  assert.match(error, /Demo Company \(UK\)/, 'what the id side selected')
  assert.match(error, /OneTwo3D Ltd/, 'what the name side selected')
  assert.match(error, /no organisation satisfies both/)
  assert.match(error, /delete the\s+XERO_ALLOWED_TENANT_NAMES line/)
  assert.match(error, /nothing was stored/i)
})

test('the same disagreement through the deprecated key quotes XERO_TENANT_ID', () => {
  const allowList = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_TENANT_ID: DEMO.tenantId, XERO_ALLOWED_TENANT_NAMES: 'OneTwo3D Ltd' })
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.match(choice.ok === false ? choice.error : '', new RegExp(`XERO_TENANT_ID=${DEMO.tenantId} selects`))
})

test('a name that matches NOTHING offered is none-allowed, not a contradiction', () => {
  // Only one side selected anything, so there is no disagreement to report — just nothing permitted.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'A Company That Is Not On This Consent',
  })
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok === false && choice.reason, 'none-allowed')
})


// --- XERO_REQUIRE_DEMO_ORG (r3 finding 2) ------------------------------------
//
// The finding: `XERO_BLOCKED_TENANT_IDS=<the live org>` was prescribed as the rig's whole answer to the
// rotating Demo tenantId, and it refuses exactly ONE organisation. It never constrained the rig TO a
// demo organisation — and `XERO_ALLOWED_TENANT_NAMES` cannot, because a name is not an identity.

const DEMO_REQUIRED = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_REQUIRE_DEMO_ORG: 'true' })

test('a deny-list on the live org does NOT stop a third organisation — the gap being closed', () => {
  const blockLive = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_BLOCKED_TENANT_IDS: LIVE.tenantId })
  const choice = selectXeroTenant({ connections: [THIRD], expectedTenantId: null, allowList: blockLive })
  assert.equal(choice.ok, true, 'a bookkeeper sandbox is neither blocked nor allow-listed')
  assert.equal(choice.ok === true && choice.connection.tenantId, THIRD.tenantId)
})

test('a name alongside the deny-list does not close it either — the org can be renamed', () => {
  const guarded = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_BLOCKED_TENANT_IDS: LIVE.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  const renamed: XeroConnectionSummary = { ...THIRD, tenantName: 'Demo Company (UK)' }
  const choice = selectXeroTenant({ connections: [renamed], expectedTenantId: null, allowList: guarded })
  assert.equal(choice.ok, true, 'which is exactly why a name cannot be the anchor')
})

test('the demo requirement is answered by Xero, not by an id list or a name', () => {
  assert.equal(xeroDemoOrgVerdict(DEMO_REQUIRED, true), 'demo')
  assert.equal(xeroDemoOrgVerdict(DEMO_REQUIRED, false), 'not-demo')
  assert.equal(xeroDemoOrgVerdict(DEMO_REQUIRED, null), 'unverified', 'never read is not "yes"')
  assert.equal(xeroDemoOrgVerdict(DEMO_REQUIRED, undefined), 'unverified')
  assert.equal(xeroDemoOrgVerdict(NO_ALLOW_LIST, false), 'not-required', 'opt-in, like every other key')
})

test('the requirement needs no maintenance when the Demo company is re-created', () => {
  // The whole reason names were reached for. A rotated tenantId changes nothing here.
  const rotated: XeroConnectionSummary = { tenantId: '5c949ed5-demo-cycle-9', tenantName: 'Demo Company (UK)' }
  assert.equal(xeroDemoOrgVerdict(DEMO_REQUIRED, true), 'demo')
  const choice = selectXeroTenant({ connections: [rotated], expectedTenantId: null, allowList: DEMO_REQUIRED })
  assert.equal(choice.ok, true, 'and the id-based chain is untouched by it')
})

test('yes/no spellings are read, and anything else is a refusal rather than a silent "off"', () => {
  for (const on of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
    assert.equal(readXeroTenantAllowList({ NODE_ENV: 'production', XERO_REQUIRE_DEMO_ORG: on }).requireDemoOrg, true, on)
  }
  for (const off of ['false', '0', 'no', 'off', '', '   ', undefined]) {
    const list = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_REQUIRE_DEMO_ORG: off })
    assert.equal(list.requireDemoOrg, false, String(off))
    assert.equal(list.conflict, null, String(off))
  }
  // The XERO_TENANT_ID mistake in a new place: a line that reads like a guard, and no guard.
  const malformed = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_REQUIRE_DEMO_ORG: 'Demo Company (UK)' })
  assert.equal(malformed.requireDemoOrg, false)
  assert.match(malformed.conflict ?? '', /is not a yes\/no value/)
  assert.match(malformed.conflict ?? '', /XERO_REQUIRE_DEMO_ORG=true/, 'and says the value that works')
  assert.equal(
    selectXeroTenant({ connections: [DEMO], expectedTenantId: null, allowList: malformed }).ok, false,
    'a configuration we cannot read is not permission',
  )
})

test('the requirement counts as configured, and as an ANCHOR that clears the name-only warning', () => {
  assert.equal(DEMO_REQUIRED.configured, true)
  assert.equal(DEMO_REQUIRED.nameOnlyGuard, false)
  const nameOnly = readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' })
  assert.equal(nameOnly.nameOnlyGuard, true)
  const anchored = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
    XERO_REQUIRE_DEMO_ORG: 'true',
  })
  assert.equal(anchored.nameOnlyGuard, false, 'Xero asserts it; the organisation’s admin cannot')
})

test('the name-only warning offers the maintenance-free anchor first, and says what a deny-list misses', () => {
  const warning = nameOnlyGuardWarning(readXeroTenantAllowList({ NODE_ENV: 'production', XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' }))
  assert.match(warning, /XERO_REQUIRE_DEMO_ORG=true/)
  assert.match(warning, /any third organisation would still pass/)
})

test('the connect refusal distinguishes "Xero says no" from "we could not ask"', () => {
  const saidNo = demoOrgConnectRefusal(THIRD, 'not-demo')
  assert.match(saidNo, /Bookkeeper Sandbox/)
  assert.match(saidNo, new RegExp(THIRD.tenantId))
  assert.match(saidNo, /IsDemoCompany=false/)
  assert.match(saidNo, /Nothing was stored/)
  assert.match(saidNo, /choosing your Demo Company/)
  assert.match(saidNo, /delete the XERO_REQUIRE_DEMO_ORG line/, 'the way out for a real organisation')

  const couldNotAsk = demoOrgConnectRefusal(DEMO, 'unverified')
  assert.match(couldNotAsk, /could not read whether/)
  assert.match(couldNotAsk, /Try connecting again/)
  assert.doesNotMatch(
    couldNotAsk, /choosing your Demo Company/,
    'telling an operator who already chose Demo to choose Demo sends them round the same loop',
  )
})

test('the stored refusal names the reconnect, because only a consent can re-read the flag', () => {
  const unverified = demoOrgStoredRefusal(LIVE, 'unverified')
  assert.match(unverified, /never verified with Xero/)
  assert.match(unverified, /Disconnect Xero on \/sync/)
  assert.match(unverified, /restored here with its Xero token still in it/)
  assert.match(demoOrgStoredRefusal(LIVE, 'not-demo'), /Xero reports is NOT a demo organisation/)
})

test('the stored check applies the allow-list FIRST, so the message names the binding reason', () => {
  // Both would refuse this token. The allow-list is the more specific instruction and its remedy is the
  // one that works, so it must not be shadowed by the demo requirement. The pin AGREES with the token
  // throughout, which is the ordinary connected state and the one these verdicts are about.
  const allowList = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_REQUIRE_DEMO_ORG: 'true',
  })
  const refusal = storedXeroConnectionRefusal({ ...LIVE, isDemoCompany: false }, allowList, LIVE.tenantId, BOUND, null)
  assert.match(refusal ?? '', /allow-list forbids/)

  assert.equal(
    storedXeroConnectionRefusal({ ...DEMO, isDemoCompany: true }, allowList, DEMO.tenantId, BOUND, null), null,
    'an allowed demo organisation passes both',
  )
  assert.match(
    storedXeroConnectionRefusal({ ...DEMO, isDemoCompany: null }, allowList, DEMO.tenantId, BOUND, null) ?? '',
    /XERO_REQUIRE_DEMO_ORG/,
    'and an allow-listed organisation with no proof is still refused',
  )
})

test('with the requirement off, an unverified stored token is untouched', () => {
  // Every installation that predates the column is in this state. It must not become an outage. Those
  // installations predate the PIN too, so the honest value for it here is "there is not one".
  assert.equal(
    storedXeroConnectionRefusal({ ...LIVE, isDemoCompany: null }, NO_ALLOW_LIST, null, PRE_MARKER, null), null,
  )
})


// --- a binding that is already split (r5 finding 1) ---------------------------

test('a pin and a token naming different organisations halt the sync, naming both', () => {
  // The state rounds 3 and 4 stopped being CREATED, on an instance that already has one. Nothing runs
  // on deploy, so unless the read path asks, such an instance syncs into the token's ledger forever.
  const message = storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, DEMO.tenantId, BOUND, null)

  assert.match(message ?? '', /bound to two different Xero organisations at once/)
  assert.match(message ?? '', new RegExp(DEMO.tenantId), 'the pin is named')
  assert.match(message ?? '', /OneTwo3D Ltd/, 'and the token\'s organisation by name')
  assert.match(message ?? '', new RegExp(LIVE.tenantId), 'and by id, which is what configures anything')
  assert.match(message ?? '', /No Xero request was made/)
})

test('the split-binding refusal trusts NEITHER side, and says which one did the posting', () => {
  // Preferring the pin would leave the token in place and go on posting with it; preferring the token
  // would ratify whatever arrived in the database. The operator needs to know that the damage, if any,
  // is in the TOKEN'S organisation — that is where an audit has to look.
  const message = storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, DEMO.tenantId, BOUND, null) ?? ''

  assert.match(message, /will not guess which of the two/)
  assert.match(message, /the binding is simply unknown/)
  assert.match(message, /everything it wrote went to the token's organisation/)
  assert.match(message, /press Disconnect/, 'the one action that clears both halves')
  assert.match(message, /connect again and choose the organisation this instance is meant to use/)
  assert.doesNotMatch(message, /XERO_ALLOWED_TENANT_IDS/, 'an env edit cannot repair a split binding')
})

test('the split binding is reported BEFORE the allow-list, whose remedy it would invalidate', () => {
  // storedTenantRefusalMessage offers "permit the stored organisation in the .env". An operator who does
  // exactly that on a mismatched instance permits an organisation their own pin denies and lands in the
  // mismatch refusal instead — a remedy whose faithful execution produces a new refusal.
  const message = storedXeroConnectionRefusal(LIVE, DEMO_BY_ID, DEMO.tenantId, BOUND, null) ?? ''

  assert.match(message, /bound to two different Xero organisations at once/)
  assert.doesNotMatch(message, /allow-list forbids/)
})

test('a self-contradictory .env is still reported first — no other remedy can take effect', () => {
  const conflicted = readXeroTenantAllowList({
    NODE_ENV: 'production',
    XERO_TENANT_ID: LIVE.tenantId,
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
  })
  assert.notEqual(conflicted.conflict, null)

  const message = storedXeroConnectionRefusal(LIVE, conflicted, DEMO.tenantId, BOUND, null) ?? ''
  assert.match(message, /contradict each other/)
})

test('NO pin beside a token is not a MISMATCH — there is nothing to compare', () => {
  // Whether it is permitted is a different question, asked below. What must not happen is the
  // two-organisations message being shown to an instance that names one organisation and has mislaid
  // the record of it.
  const absent = storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, null, PRE_MARKER, null)
  assert.equal(absent, null)
  assert.equal(storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, undefined, PRE_MARKER, null), null)
  assert.equal(storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, '   ', PRE_MARKER, null), null, 'nor a blank one')
})


// --- an absent pin is not a licence (r6) --------------------------------------
//
// r5 exempted an absent pin outright, so the refusal above was one `DELETE FROM settings` away from
// being switched off — and a settings table restored from a different backup than accounting_tokens
// arrives there without anybody deleting anything, which is the very scenario r5 was written for.

test('a pin that was DELETED is refused: the token row still carries its binding marker', () => {
  const message = xeroMissingPinRefusal(LIVE, BOUND, null) ?? ''

  assert.equal(xeroPinAbsenceVerdict(BOUND, LIVE.tenantId, null), 'lost')
  assert.match(message, /has lost its pin/)
  assert.match(message, /OneTwo3D Ltd/, 'the organisation the token belongs to, by name')
  assert.match(message, new RegExp(LIVE.tenantId), 'and by id')
  assert.match(message, /never removes one without the other/, 'why an absent pin is evidence at all')
  assert.match(message, /No Xero request was made/)
})

test('the deleted-pin refusal is performable, and does not send the operator round a loop', () => {
  const message = xeroMissingPinRefusal(LIVE, BOUND, null) ?? ''

  assert.match(message, /press Disconnect/, 'the one action that clears both halves')
  assert.match(message, /nothing in the server .env needs editing/)
  assert.match(message, /Writing the setting back by hand is NOT one/,
    'the obvious repair is the one that ratifies a token from somewhere else')
  assert.match(message, /--clear-tenant-pin/, 'and the supported way to be unpinned on purpose')
  assert.match(message, /everything it wrote went to the token's organisation/, 'where an audit looks')
  assert.doesNotMatch(message, /XERO_ALLOWED_TENANT_IDS/, 'an env edit cannot repair a lost pin')
})

test('a RELEASED connection is not refused — the documented recovery must still work', () => {
  // scripts/provision-xero-demo.ts --clear-tenant-pin deletes the pin and stamps the token row in one
  // transaction. That receipt is the whole difference between a deliberate release and a deletion.
  assert.equal(xeroPinAbsenceVerdict(RELEASED, LIVE.tenantId, RELEASE_WITNESS), 'released')
  assert.equal(xeroMissingPinRefusal(LIVE, RELEASED, RELEASE_WITNESS), null)
  assert.equal(storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, null, RELEASED, RELEASE_WITNESS), null)
})

test('a token row from before the marker existed is exempt, exactly as it was in r5', () => {
  // Every installation connected before this column shipped is in this state, and none of them may go
  // offline on the deploy that adds it. The row is evidence of nothing, so it is not read as evidence.
  assert.equal(xeroPinAbsenceVerdict(PRE_MARKER, LIVE.tenantId, null), 'never-established')
  assert.equal(xeroMissingPinRefusal(LIVE, PRE_MARKER, null), null)
})

test('a blank generation is not a marker — an empty string proves nothing', () => {
  assert.equal(
    xeroPinAbsenceVerdict(
      { connectionGeneration: '  ', pinReleasedAt: null, pinReleasedGeneration: null, pinReleasedTenantId: null },
      LIVE.tenantId,
      null,
    ),
    'never-established',
  )
})

test('a release outranks the generation, or the recovery would halt the instance it recovers', () => {
  // A released connection has BOTH markers: it was bound (generation) and then deliberately unpinned
  // (receipt). Reading them the other way round refuses every rig that follows the runbook.
  assert.equal(
    xeroPinAbsenceVerdict(
      { ...BOUND, pinReleasedAt: new Date(), pinReleasedGeneration: BOUND.connectionGeneration, pinReleasedTenantId: LIVE.tenantId },
      LIVE.tenantId,
      RELEASE_WITNESS,
    ),
    'released',
  )
})

// --- a release receipt cannot outlive what it released (r7) --------------------
//
// r6's receipt recorded only THAT a release happened. Nothing that happened to the row afterwards
// could contradict it, so it was exempt-by-presence: restore an accounting_tokens dump taken while a
// release was outstanding, and the exemption lands on whatever binding is there now — the cross-backup
// restore this refusal exists for, arriving through the escape hatch instead of round it.

test('a receipt for ANOTHER connection is stale, and does not exempt the row it is sitting on', () => {
  // The restored-dump case: released under gen-a1b2, and this row has been bound since (gen-c3d4).
  assert.equal(xeroPinAbsenceVerdict(STALE_RELEASE_OTHER_CONNECTION, LIVE.tenantId, null), 'stale-release')
  assert.notEqual(xeroMissingPinRefusal(LIVE, STALE_RELEASE_OTHER_CONNECTION, null), null)
})

test('the stale-release refusal is its own message, not the lost-pin one', () => {
  // Different history, different thing to go and look at: "a pin was written beside this token and
  // something removed it" would send the operator to check the settings table, and the settings table
  // is not where this went wrong.
  const message = xeroMissingPinRefusal(LIVE, STALE_RELEASE_OTHER_CONNECTION, null) ?? ''

  assert.match(message, /release receipt that does not describe it/)
  assert.doesNotMatch(message, /has lost its pin/)
  assert.match(message, /gen-a1b2/, 'the connection the receipt released')
  assert.match(message, /gen-c3d4/, 'and the connection this token actually belongs to')
  assert.match(message, /No Xero request was made/)
})

test('the stale-release refusal is performable, and says why re-running the recovery will not help', () => {
  const message = xeroMissingPinRefusal(LIVE, STALE_RELEASE_OTHER_CONNECTION, null) ?? ''

  assert.match(message, /press Disconnect/, 'the one action that clears both halves')
  assert.match(message, /nothing in the server .env needs editing/i)
  assert.match(message, /--clear-tenant-pin will not clear this/,
    'the obvious next thing to try, refused before it is tried')
  assert.match(message, /OneTwo3D Ltd/, 'and where the posting went, for the audit')
})

test('releasing one half of a SPLIT binding does not end the refusal', () => {
  // --clear-tenant-pin on an instance whose pin named one organisation and whose token names another.
  // The pin is gone, but the contradiction is not resolved — the receipt records the organisation the
  // deleted pin named, and it is not this token's.
  assert.equal(xeroPinAbsenceVerdict(STALE_RELEASE_OTHER_ORG, LIVE.tenantId, null), 'stale-release')
  const message = xeroMissingPinRefusal(LIVE, STALE_RELEASE_OTHER_ORG, null) ?? ''
  assert.match(message, /released a pin naming organisation 5c949ed5-demo-org/)
  assert.match(message, /OneTwo3D Ltd/)
})

test('a receipt that does not say WHAT it released is not honoured', () => {
  // Exempt-by-presence was the finding, so the absence of the qualifying half cannot be read as
  // "qualified for everything". This is also the shape a hand-inserted row arrives in.
  assert.equal(xeroPinAbsenceVerdict(UNQUALIFIED_RELEASE, LIVE.tenantId, null), 'unqualified-release')
  assert.match(xeroMissingPinRefusal(LIVE, UNQUALIFIED_RELEASE, null) ?? '', /but not WHAT was released/)
})

test('a receipt with a generation and no pin is stale, not merely unqualified', () => {
  // Half-written paperwork is not the pre-r7 shape — that one has NEITHER half — so it keeps the
  // stale-release message, which is the one that says the receipt came apart from its row.
  const halfWritten: XeroStoredBinding = { ...RELEASED, pinReleasedTenantId: null }
  assert.equal(xeroPinAbsenceVerdict(halfWritten, LIVE.tenantId, RELEASE_WITNESS), 'stale-release')
  assert.match(xeroMissingPinRefusal(LIVE, halfWritten, RELEASE_WITNESS) ?? '', /does not record which pin it released/)
})

test('a valid release is compared the way every other id here is — case and space are not a change', () => {
  assert.equal(
    xeroPinAbsenceVerdict(
      { ...RELEASED, pinReleasedTenantId: ` ${LIVE.tenantId.toUpperCase()} ` },
      LIVE.tenantId,
      { ...RELEASE_WITNESS, tenantId: LIVE.tenantId.toUpperCase() },
    ),
    'released',
  )
})

test('a stale release is refused BEFORE the allow-list, exactly as a lost pin is', () => {
  // Same reason: "permit the stored organisation in the .env" is not a remedy for a token row whose
  // binding record belongs to something else, and performing it faithfully changes nothing.
  const message = storedXeroConnectionRefusal(LIVE, DEMO_BY_ID, null, STALE_RELEASE_OTHER_CONNECTION, null) ?? ''

  assert.match(message, /release receipt that does not describe it/)
  assert.doesNotMatch(message, /allow-list forbids/)
})

test('a PRESENT pin is still compared first, stale receipt or not', () => {
  // The receipt only ever answers the question "why is there no pin". An instance that HAS one gets the
  // mismatch message, which is about the two organisations rather than about the paperwork.
  assert.match(
    storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, DEMO.tenantId, STALE_RELEASE_OTHER_CONNECTION, null) ?? '',
    /bound to two different Xero organisations at once/,
  )
})

test('the lost pin is refused BEFORE the allow-list, whose remedy would not repair it', () => {
  // "Permit the stored organisation in the .env" is the wrong instruction for an instance whose binding
  // record is missing: performing it faithfully leaves the sync halted for a different reason.
  const message = storedXeroConnectionRefusal(LIVE, DEMO_BY_ID, null, BOUND, null) ?? ''

  assert.match(message, /has lost its pin/)
  assert.doesNotMatch(message, /allow-list forbids/)
})

test('a pin that is PRESENT is compared, never treated as an absence', () => {
  // The two refusals are mutually exclusive by construction, and a mismatched instance must get the
  // message about its mismatch — the one that names both organisations.
  assert.match(
    storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, DEMO.tenantId, BOUND, null) ?? '',
    /bound to two different Xero organisations at once/,
  )
})

test('a pin that agrees with the token changes nothing', () => {
  // The overwhelmingly common state, and the one this must not touch.
  assert.equal(storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, LIVE.tenantId, BOUND, null), null)
  assert.equal(
    storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, ` ${LIVE.tenantId.toUpperCase()} `, BOUND, null), null,
    'compared the way every other id here is compared — case and whitespace are not a disagreement',
  )
})


// --- the binding race refusal (r3 finding 1) ----------------------------------

test('the race refusal names both organisations and a remedy that does not loop', () => {
  // "Try again" would be the wrong advice: the retry meets the winner's pin and is refused as
  // pinned-not-offered — a true message about the wrong problem.
  const message = xeroTenantBindingRaceMessage({ attempted: DEMO, boundTo: LIVE })
  assert.match(message, /another Xero connection finished first/)
  assert.match(message, /OneTwo3D Ltd/, 'who won')
  assert.match(message, new RegExp(LIVE.tenantId))
  assert.match(message, /Demo Company \(UK\)/, 'what this consent had chosen')
  assert.match(message, /nothing from it was stored/)
  assert.match(message, /disconnect Xero on \/sync/i)
  assert.doesNotMatch(message, /try again/i)
})

test('a winner with no name still produces a usable refusal', () => {
  // The pin can be committed before the winning token row is readable. An id alone is still actionable.
  const message = xeroTenantBindingRaceMessage({ attempted: DEMO, boundTo: { tenantId: LIVE.tenantId } })
  assert.match(message, /\(unnamed organisation\) \[tenantId e7fb4378-live-org\]/)
})

// --- the receipt cannot be its own witness (r8) --------------------------------
//
// r7 qualified the receipt with the connection it released and the pin it deleted, and both live on the
// same row as the receipt. Two consequences it did not close: every receipt written BEFORE r7 has
// neither qualifier and can only be qualified from the row it sits on, and a row restored wholesale
// carries the qualifiers along with everything they are compared against.

test('the receipt migration adds the columns and BACKFILLS NOTHING', () => {
  // The backfill would have stamped every outstanding release with its own row's generation and tenant,
  // so that a rig mid-recovery stayed exempt across the deploy. It cannot: the pre-r7 recovery stamped a
  // receipt even when it deleted no pin, and on the row alone that is the same state. Qualifying the
  // outstanding release qualifies the laundered one, in the migration that closed the laundering.
  const sql = readFileSync(
    new URL('../../prisma/migrations/20260819180000_accounting_token_pin_release_receipt/migration.sql', import.meta.url),
    'utf8',
  )
  const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

  assert.match(statements, /ADD COLUMN "pinReleasedGeneration"/)
  assert.match(statements, /ADD COLUMN "pinReleasedTenantId"/)
  assert.doesNotMatch(statements, /UPDATE/i, 'no receipt may be qualified by a migration')
  assert.doesNotMatch(statements, /"connectionGeneration"/,
    'the row\'s own values are exactly what must not be copied into its receipt')
})

test('the recovery writes BOTH halves of the receipt, in one transaction', () => {
  // The witness only works if the script that deletes the pin is the thing that writes it, and writes it
  // where a crash cannot separate the two. Read out of the script rather than asserted about a double,
  // because the double is a model of this text and a model cannot notice the text changing.
  const script = readFileSync(new URL('../../scripts/provision-xero-demo.ts', import.meta.url), 'utf8')
  const body = script.slice(script.indexOf('async function clearTenantPin'))
  const transaction = body.slice(body.indexOf("db.query('begin')"), body.indexOf("db.query('commit')"))

  assert.match(transaction, /delete from settings where key = 'xero_expected_tenant_id'/,
    'the pin is deleted...')
  assert.match(transaction, /set "pinReleasedAt" = now\(\)/, '...the receipt is stamped on the token row...')
  assert.match(transaction, /insert into settings \(key, value, "updatedAt"\) values \('xero_pin_release_witness'/,
    '...and the witness is written beside the deleted pin, all before the commit')
  assert.match(transaction, /serializeXeroReleaseWitness/,
    'serialised by the function the guard parses with, so the format has one owner')
  assert.match(transaction, /for \(const row of stamped\.rows\)/,
    'and only when a token row was actually stamped — no receipt, nothing to witness')
})

test('the two receipts a backfill would have had to tell apart are identical', () => {
  // A release genuinely outstanding at the deploy, and one the old recovery stamped for a pin it never
  // deleted. Same columns, same values. Any rule computed from the row qualifies both or neither, which
  // is why the answer is neither.
  assert.deepStrictEqual(RELEASE_OUTSTANDING_AT_DEPLOY, LAUNDERED_PRE_R7_RECEIPT)
  assert.equal(xeroPinAbsenceVerdict(RELEASE_OUTSTANDING_AT_DEPLOY, LIVE.tenantId, RELEASE_WITNESS), 'unqualified-release')
  assert.equal(xeroPinAbsenceVerdict(LAUNDERED_PRE_R7_RECEIPT, LIVE.tenantId, RELEASE_WITNESS), 'unqualified-release')
})

test('the unqualified-release refusal is its own message, not the lost-pin or stale one', () => {
  // Three different histories. "Something removed your pin" sends the operator to the settings table;
  // "this paperwork came apart from its row" sends them to look for a restore that never happened.
  const message = xeroMissingPinRefusal(LIVE, RELEASE_OUTSTANDING_AT_DEPLOY, null) ?? ''

  assert.match(message, /but not WHAT was released/)
  assert.doesNotMatch(message, /has lost its pin/)
  assert.doesNotMatch(message, /does not describe it/)
  assert.match(message, /an older version of IMS/, 'where a receipt in this shape comes from')
  assert.match(message, /No Xero request was made/)
})

test('the unqualified-release refusal tells an operator mid-recovery what to do', () => {
  // The one operator this halt is unfair to is the one who followed the runbook and was waiting to
  // re-consent. The message has to name their step, say nothing is lost by taking it, and refuse the
  // thing they would try first.
  const message = xeroMissingPinRefusal(LIVE, RELEASE_OUTSTANDING_AT_DEPLOY, null) ?? ''

  assert.match(message, /press Disconnect/)
  assert.match(message, /then connect again/)
  assert.match(message, /nothing is lost/, 'the token was unusable until the re-consent anyway')
  assert.match(message, /--clear-tenant-pin will\s+not clear this/,
    'the obvious next thing to try, refused before it is tried')
  assert.match(message, /nothing in the server .env needs\s+editing/i)
})

test('a WHOLESALE-restored token row cannot witness its own release', () => {
  // The r8 finding. Every value r7 compares came out of one dump, so the row agrees with itself: the
  // generation it released is the generation it carries, and the pin it released is the tenant it
  // names. Restored onto an instance that never performed that release, there is no witness beside it.
  assert.equal(xeroPinAbsenceVerdict(RESTORED_MID_RELEASE_ROW, LIVE.tenantId, null), 'unwitnessed-release')
  assert.notEqual(xeroMissingPinRefusal(LIVE, RESTORED_MID_RELEASE_ROW, null), null)

  // ...and it is field-for-field the legitimate release, which is why the row alone cannot decide it.
  assert.deepStrictEqual(RESTORED_MID_RELEASE_ROW, RELEASED)
  assert.equal(xeroPinAbsenceVerdict(RELEASED, LIVE.tenantId, RELEASE_WITNESS), 'released')
})

test('the witness must describe the SAME release, not merely exist', () => {
  // An instance that released a pin once and has since been rebound and released again still holds a
  // witness. It must not corroborate a receipt for a different connection, or "has ever released
  // anything" becomes the exemption — exempt-by-presence in the other table.
  assert.equal(
    xeroPinAbsenceVerdict(RESTORED_MID_RELEASE_ROW, LIVE.tenantId, WITNESS_FOR_ANOTHER_RELEASE),
    'unwitnessed-release',
  )
  assert.equal(
    xeroPinAbsenceVerdict(RELEASED, LIVE.tenantId, { generation: 'gen-a1b2', tenantId: DEMO.tenantId }),
    'unwitnessed-release',
    'the same connection, a different pin: not this release either',
  )
})

test('a witness on its own exempts nothing — the r6 bypass stays closed', () => {
  // Deleting the pin and writing a witness beside it is still a token row with no receipt on it, so it
  // is still a lost pin. The witness NARROWS the exemption; it never grants one.
  assert.equal(xeroPinAbsenceVerdict(BOUND, LIVE.tenantId, RELEASE_WITNESS), 'lost')
  assert.match(xeroMissingPinRefusal(LIVE, BOUND, RELEASE_WITNESS) ?? '', /has lost its pin/)
})

test('a witness cannot rescue a receipt that does not describe its row', () => {
  // Order matters: the stale check runs first, so a restored row arriving on an instance that happens
  // to hold a matching witness is still refused for the reason that is actually wrong with it.
  assert.equal(
    xeroPinAbsenceVerdict(STALE_RELEASE_OTHER_CONNECTION, LIVE.tenantId, { generation: 'gen-a1b2', tenantId: LIVE.tenantId }),
    'stale-release',
  )
})

test('the unwitnessed-release refusal names the half that is missing, and what it cannot see', () => {
  const message = xeroMissingPinRefusal(LIVE, RESTORED_MID_RELEASE_ROW, null) ?? ''

  assert.match(message, /no record of writing/)
  assert.match(message, /in two places in one transaction/, 'why a missing half is evidence at all')
  assert.match(message, /accounting_tokens table restored/, 'the usual cause')
  assert.match(message, /press Disconnect/)
  assert.match(message, /WHOLE database brings both halves/,
    'the residual, said out loud rather than left to be discovered')
  assert.match(message, /XERO_BLOCKED_TENANT_IDS \/ XERO_REQUIRE_DEMO_ORG/,
    'and the control that does survive a restore')
  assert.match(message, /No Xero request was made/)
})

test('an unwitnessed release is refused BEFORE the allow-list, exactly as a lost pin is', () => {
  // Same reason as every other binding refusal: "permit the stored organisation in the .env" is not a
  // remedy for a token row whose release this instance never performed.
  const message = storedXeroConnectionRefusal(LIVE, DEMO_BY_ID, null, RESTORED_MID_RELEASE_ROW, null) ?? ''

  assert.match(message, /no record of writing/)
  assert.doesNotMatch(message, /allow-list forbids/)
})

test('an unqualified release is refused BEFORE the allow-list too', () => {
  const message = storedXeroConnectionRefusal(LIVE, DEMO_BY_ID, null, UNQUALIFIED_RELEASE, null) ?? ''

  assert.match(message, /but not WHAT was released/)
  assert.doesNotMatch(message, /allow-list forbids/)
})

test('a PRESENT pin still wins over both new verdicts', () => {
  // The receipt only ever answers "why is there no pin". An instance that has one gets the message
  // about its two organisations, whatever paperwork the row is carrying.
  for (const binding of [UNQUALIFIED_RELEASE, RESTORED_MID_RELEASE_ROW]) {
    assert.match(
      storedXeroConnectionRefusal(LIVE, NO_ALLOW_LIST, DEMO.tenantId, binding, null) ?? '',
      /bound to two different Xero organisations at once/,
    )
  }
})

test('the witness survives a round trip, and anything else is no witness', () => {
  // The recovery script writes it and the guard reads it, so one function owns the format. Failing OPEN
  // on a malformed value would make "put anything in that settings row" the exemption.
  assert.deepStrictEqual(parseXeroReleaseWitness(serializeXeroReleaseWitness(RELEASE_WITNESS)), RELEASE_WITNESS)
  assert.deepStrictEqual(
    parseXeroReleaseWitness(serializeXeroReleaseWitness({ generation: null, tenantId: LIVE.tenantId })),
    { generation: null, tenantId: LIVE.tenantId },
    'a release on a row that predates the generation column is still a witnessed release',
  )
  for (const raw of [null, undefined, '', '   ', 'not json', '[]', '{}', '{"generation":"gen-a1b2"}', '{"tenantId":"  "}', 'null']) {
    assert.equal(parseXeroReleaseWitness(raw), null, `not a witness: ${String(raw)}`)
  }
})

test('a token row that predates the generation column can still be released and witnessed', () => {
  // The legitimate pre-generation release: no generation on either side, and the pin it deleted is the
  // organisation the token names. It must not be collapsed into "unqualified" — the released pin IS the
  // qualifier here — nor into "unwitnessed" by a null generation failing to compare equal.
  const preGenerationRelease: XeroStoredBinding = {
    connectionGeneration: null, pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
    pinReleasedGeneration: null, pinReleasedTenantId: LIVE.tenantId,
  }
  assert.equal(
    xeroPinAbsenceVerdict(preGenerationRelease, LIVE.tenantId, { generation: null, tenantId: LIVE.tenantId }),
    'released',
  )
  assert.equal(
    xeroPinAbsenceVerdict(preGenerationRelease, LIVE.tenantId, null),
    'unwitnessed-release',
    'and it is the witness, not the generation, doing the work',
  )
})


// --- a release is consumed by the PIN, not by one writer's good manners (r9) ---
//
// r7 gave the receipt no expiry on one explicit ground: the next binding consumes it. r8 added the
// witness on the same ground. Both were true of `bindXeroTenant` and false of the system, because the
// pin has more than one writer — `provision-xero-demo.ts` re-pins from the live connection on every
// ordinary run, by writing the settings row directly. A completed provision therefore left the rig
// PINNED and still carrying an outstanding release: invisible while the pin is there, because the
// receipt is only ever read to answer "why is there no pin", and one `DELETE FROM settings` from being
// read as a deliberate release instead of the halt r6 built.

/**
 * THE DOUBLE: an instance mid-recovery, as the two tables that hold a release.
 *
 * `--clear-tenant-pin` has run — no pin row, a qualified receipt on the token row, the witness beside
 * where the pin was. This is the state a re-provision arrives at, and expressing it as tables rather
 * than as a verdict is the point: the r9 defect is not in what the verdict says about a row, it is in
 * which rows a writer leaves behind.
 */
type ReleasedInstance = {
  settings: Map<string, string>
  token: {
    tenantId: string
    connectionGeneration: string | null
    pinReleasedAt: Date | null
    pinReleasedGeneration: string | null
    pinReleasedTenantId: string | null
  }
}

function instanceMidRelease(): ReleasedInstance {
  return {
    settings: new Map([[XERO_PIN_RELEASE_WITNESS_SETTING_KEY, serializeXeroReleaseWitness(RELEASE_WITNESS)]]),
    token: {
      tenantId: LIVE.tenantId,
      connectionGeneration: 'gen-a1b2',
      pinReleasedAt: new Date('2026-08-19T09:00:00.000Z'),
      pinReleasedGeneration: 'gen-a1b2',
      pinReleasedTenantId: LIVE.tenantId,
    },
  }
}

/** What the guard would decide about this instance, right now, if it were asked. */
function verdictOf(instance: ReleasedInstance) {
  const binding: XeroStoredBinding = {
    connectionGeneration: instance.token.connectionGeneration,
    pinReleasedAt: instance.token.pinReleasedAt,
    pinReleasedGeneration: instance.token.pinReleasedGeneration,
    pinReleasedTenantId: instance.token.pinReleasedTenantId,
  }
  return xeroPinAbsenceVerdict(
    binding,
    instance.token.tenantId,
    parseXeroReleaseWitness(instance.settings.get(XERO_PIN_RELEASE_WITNESS_SETTING_KEY) ?? null),
  )
}

/**
 * Apply the statements to the double.
 *
 * The effect of the UPDATE is read OUT of the statement — which receipt columns it names — rather than
 * assumed, because a model that clears all three whatever the SQL says cannot notice the SQL dropping
 * one, and a half-cleared receipt is `stale-release`: a live refusal with the wrong message on it. An
 * unrecognised statement fails the test rather than being ignored.
 */
function applyStatements(instance: ReleasedInstance, statements: XeroPinSqlStatement[]) {
  for (const { text, values } of statements) {
    if (/^insert into settings/.test(text)) {
      instance.settings.set(String(values[0]), String(values[1]))
    } else if (/^update accounting_tokens/.test(text)) {
      const nulled = [...text.matchAll(/"(pinReleased[A-Za-z]*)" = null/g)].map((m) => m[1])
      for (const column of nulled) {
        instance.token[column as 'pinReleasedGeneration' | 'pinReleasedTenantId'] = null
      }
      if (nulled.includes('pinReleasedAt')) instance.token.pinReleasedAt = null
    } else if (/^delete from settings/.test(text)) {
      instance.settings.delete(String(values[0]))
    } else {
      assert.fail(`the double does not model this statement, so it cannot vouch for it: ${text}`)
    }
  }
}

test('re-pinning consumes the release, so a later hand-run DELETE halts instead of exempting', () => {
  // The finding, end to end. Before: a legitimate outstanding release. After a re-provision the pin is
  // back — and with the receipt still under it, deleting that pin used to read as `released`, which is
  // the bypass r6 closed, reachable by running the documented provisioner.
  const instance = instanceMidRelease()
  assert.equal(verdictOf(instance), 'released', 'the state the recovery legitimately leaves')

  applyStatements(instance, xeroPinEstablishmentStatements(LIVE.tenantId))

  assert.equal(instance.settings.get(XERO_TENANT_PIN_SETTING_KEY), LIVE.tenantId, 'the pin is written')
  assert.equal(instance.settings.has(XERO_PIN_RELEASE_WITNESS_SETTING_KEY), false, 'the witness goes with it')
  assert.deepEqual(
    [instance.token.pinReleasedAt, instance.token.pinReleasedGeneration, instance.token.pinReleasedTenantId],
    [null, null, null],
    'and the receipt on the token row, all three columns together',
  )

  // Now the r6 bypass, run against the re-provisioned instance: one DELETE of the pin row.
  instance.settings.delete(XERO_TENANT_PIN_SETTING_KEY)
  assert.equal(verdictOf(instance), 'lost', 'the halt, not an exemption inherited from a spent release')
})

test('the pin is written FIRST, and the consumption cannot be split off from it', () => {
  // Order is load-bearing: on a database carrying the trigger the pin write has already consumed the
  // release by the time the explicit clears run, and on one that predates it the clears follow a pin
  // that is definitely there. Three statements, one operation — a caller that runs a subset writes the
  // state this removes, which is why they are handed over together rather than as advice.
  const statements = xeroPinEstablishmentStatements(DEMO.tenantId)

  assert.equal(statements.length, 3)
  assert.match(statements[0].text, /^insert into settings/)
  assert.deepEqual(statements[0].values, [XERO_TENANT_PIN_SETTING_KEY, DEMO.tenantId])
  assert.match(statements[1].text, /^update accounting_tokens/)
  assert.match(statements[1].text, /where connector = 'xero'/, 'this connector only')
  assert.match(statements[2].text, /^delete from settings where key = \$1/)
  assert.deepEqual(statements[2].values, [XERO_PIN_RELEASE_WITNESS_SETTING_KEY])
})

test('the two settings keys have ONE owner, and it is the file that reasons about them', () => {
  // They were spelled as literals in auth.ts, the recovery script, the preflight and the migration. The
  // r9 rule is a statement about those two rows, so it cannot be written against a string each writer
  // spells for itself.
  assert.equal(XERO_TENANT_PIN_SETTING_KEY, 'xero_expected_tenant_id')
  assert.equal(XERO_PIN_RELEASE_WITNESS_SETTING_KEY, 'xero_pin_release_witness')

  const auth = readFileSync(new URL('../../lib/connectors/xero/auth.ts', import.meta.url), 'utf8')
  assert.match(auth, /const XERO_EXPECTED_TENANT_KEY = XERO_TENANT_PIN_SETTING_KEY/)
  assert.match(auth, /const XERO_PIN_RELEASE_WITNESS_KEY = XERO_PIN_RELEASE_WITNESS_SETTING_KEY/)
})

test('the provisioner re-pins through that statement set, in one transaction', () => {
  // Read out of the script rather than asserted about a double, for the reason the r8 test says: the
  // double is a model of this text, and a model cannot notice the text changing. What is being checked
  // is that the pin write is no longer a bare INSERT of its own.
  const script = readFileSync(new URL('../../scripts/provision-xero-demo.ts', import.meta.url), 'utf8')
  const body = script.slice(script.indexOf('async function guardTenant'), script.indexOf('async function remapOnly'))
  const transaction = body.slice(body.indexOf("db.query('begin')"), body.indexOf("db.query('commit')"))

  assert.match(transaction, /xeroPinEstablishmentStatements\(tenantId\)/,
    'the pin and the consumption arrive together, from the file that owns the rule')
  assert.doesNotMatch(body, /insert into settings \(key, value, "updatedAt"\) values \('xero_expected_tenant_id'/,
    'and not as a bare INSERT of the pin, which is the r9 defect itself')
  assert.match(body, /db\.query\('rollback'\)/, 'a failure leaves neither the pin nor a spent release')
})

test('the STORE consumes the release on any pin write, not just the ones this repo knows about', () => {
  // Three writers have now been found maintaining this evidence by hand. The rule is therefore attached
  // to the row: a trigger on the pin covers a migration, a seed, setSettings() with the wrong key in it,
  // and psql — none of which can be made to remember anything.
  const sql = readFileSync(
    new URL('../../prisma/migrations/20260819210000_xero_pin_write_consumes_release/migration.sql', import.meta.url),
    'utf8',
  )
  const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

  assert.match(statements, /CREATE TRIGGER xero_pin_write_consumes_release/)
  assert.match(statements, /AFTER INSERT OR UPDATE ON "settings"/, 'both ways a pin can appear')
  assert.match(statements, new RegExp(`WHEN \\(NEW\\."key" = '${XERO_TENANT_PIN_SETTING_KEY}'\\)`),
    'fired by the pin row, and costing every other settings write nothing but a key comparison')
  for (const column of ['pinReleasedAt', 'pinReleasedGeneration', 'pinReleasedTenantId']) {
    assert.match(statements, new RegExp(`"${column}" = NULL`), `${column} is cleared with the rest`)
  }
  assert.match(statements, new RegExp(`DELETE FROM "settings" WHERE "key" = '${XERO_PIN_RELEASE_WITNESS_SETTING_KEY}'`),
    'and the witness with it — both halves are cleared together or neither is')
})

test('the migration repairs the instances already in that state, and ONLY those', () => {
  // Not the backfill r8 refused, and the direction is the difference: that one would have QUALIFIED
  // receipts, granting exemptions to rows that could not be told apart from laundered ones. This one
  // clears them, and only where a pin is already present — a row whose receipt is currently read by
  // nothing, so no instance changes behaviour today and only a future exemption is removed. An instance
  // genuinely mid-recovery has no pin row, so it is not touched.
  const sql = readFileSync(
    new URL('../../prisma/migrations/20260819210000_xero_pin_write_consumes_release/migration.sql', import.meta.url),
    'utf8',
  )
  const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
  const backfill = statements.slice(statements.lastIndexOf('EXECUTE FUNCTION'))

  assert.match(backfill, /UPDATE "accounting_tokens"/)
  assert.match(backfill, new RegExp(`EXISTS \\(SELECT 1 FROM "settings" WHERE "key" = '${XERO_TENANT_PIN_SETTING_KEY}'\\)`),
    'a released instance has no pin row, so its receipt is left exactly where it is')
  assert.doesNotMatch(backfill, /"connectionGeneration"/,
    'the row\'s own values are still exactly what must never be copied into its receipt')
  assert.doesNotMatch(backfill, /= NOW\(\)|pinReleasedAt" = '/i,
    'nothing is written into a receipt by a migration — the only value it may set is NULL')
})


// --- o3d-iaqy: a non-production instance may not connect to whatever it is offered ----------------
//
// o3d-9tbz made the allow-list real and enforced it at the callback AND on every use of the stored
// token, which is two of the three things o3d-iaqy asked for. The third was never done: an
// UNCONFIGURED allow-list still allows everything ("it is opt-in, and production may legitimately not
// set it" — isXeroTenantAllowed). That is the precise state the e2e rig was in when it invoiced into
// the live ledger, so on an instance that is not production it must not be a permitted state.
//
// The doubles below are environments, because that is the whole subject: the guard's input is what the
// instance says about ITSELF, and o3d-t74p's rig said nothing.

const UNGUARDED_DEV = readXeroTenantAllowList({ NODE_ENV: 'development' })
const UNGUARDED_E2E_RIG = readXeroTenantAllowList({ NODE_ENV: 'production', E2E_TEST_MODE: '1' })

test('o3d-iaqy: a non-production instance with NO tenant control at all is unguarded', () => {
  assert.equal(UNGUARDED_DEV.instanceIsNonProduction, true)
  assert.equal(UNGUARDED_DEV.unguardedInstance, true)
  assert.equal(UNGUARDED_DEV.configured, false,
    'and `configured` still reads false — the two questions are different, which is why the old one '
    + 'could answer "nothing is configured" and mean "everything is allowed"')
})

test('o3d-iaqy: the e2e rig is caught by E2E_TEST_MODE, which is the only signal that can catch it', () => {
  // The rig serves a PRODUCTION build, so NODE_ENV is 'production' there and always was. A guard that
  // read NODE_ENV alone would have passed the exact instance that caused o3d-t74p.
  assert.equal(UNGUARDED_E2E_RIG.instanceIsNonProduction, true)
  assert.equal(UNGUARDED_E2E_RIG.unguardedInstance, true)
})

test('o3d-iaqy: production with nothing configured is untouched', () => {
  const production = readXeroTenantAllowList({ NODE_ENV: 'production' })
  assert.equal(production.instanceIsNonProduction, false)
  assert.equal(production.unguardedInstance, false,
    'production IS the organisation everything else is being kept away from — requiring it to allow-list '
    + 'itself would be a refusal aimed at the one instance that is where it should be')
})

test('o3d-iaqy: an ABSENT NODE_ENV is non-production — a missing signal is not a declaration', () => {
  assert.equal(readXeroTenantAllowList({}).instanceIsNonProduction, true)
  assert.equal(readXeroTenantAllowList({ NODE_ENV: '  ' }).instanceIsNonProduction, true)
  assert.equal(readXeroTenantAllowList({ NODE_ENV: ' production ' }).instanceIsNonProduction, false,
    'and the declaration survives the whitespace an .env line routinely carries')
})

test('o3d-iaqy: any one IDENTITY control clears it — an allowed id, a blocked id, or the demo requirement', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['an allowed id', { XERO_ALLOWED_TENANT_IDS: DEMO.tenantId }],
    ['the deprecated single-id spelling', { XERO_TENANT_ID: DEMO.tenantId }],
    // A deny-list does not constrain this instance TO anything (r3), but o3d-iaqy's sentence is
    // "nothing stops it connecting to the LIVE organisation" — and blocking the live id is exactly
    // that sentence, in the one spelling that survives Demo's ~28-day tenantId rotation.
    ['blocking the live org', { XERO_BLOCKED_TENANT_IDS: LIVE.tenantId }],
    ['the demo requirement', { XERO_REQUIRE_DEMO_ORG: 'true' }],
  ]
  for (const [label, env] of cases) {
    const allowList = readXeroTenantAllowList({ NODE_ENV: 'development', ...env })
    assert.equal(allowList.unguardedInstance, false, label)
  }
})

test('o3d-iaqy: a NAME does NOT clear it — a rename is not an identity', () => {
  const nameOnly = readXeroTenantAllowList({
    NODE_ENV: 'development',
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(nameOnly.configured, true, 'something IS configured…')
  assert.equal(nameOnly.unguardedInstance, true, '…and it is still not an identity control')
  assert.match(xeroUnguardedInstanceRefusal(nameOnly), /XERO_ALLOWED_TENANT_NAMES=Demo Company \(UK\) is set, and it does NOT count/,
    'and the refusal says so, because an operator who has set one believes they are protected')
})

test('o3d-iaqy: the CONNECT path refuses before naming a single organisation', () => {
  // Even a single-organisation consent — the case o3d-9tbz deliberately left working — because the
  // question is not "which of these" but "may this instance be choosing at all".
  const choice = selectXeroTenant({
    connections: [LIVE],
    expectedTenantId: null,
    allowList: UNGUARDED_E2E_RIG,
  })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'unguarded-instance')
  assert.match(choice.ok === false ? choice.error : '', /not marked as production and has no Xero tenant control set/)
  assert.doesNotMatch(choice.ok === false ? choice.error : '', new RegExp(LIVE.tenantId),
    'and it does not echo the organisation back: a rig that should not have been consenting is not '
    + 'handed the id of the ledger it was about to be pointed at')
})

test('o3d-iaqy: a DATABASE pin does not rescue it — a pin is learned, not configured', () => {
  // The self-writing latch this replaces: pinTenantId stamped whatever organisation you just connected
  // to, so the e2e rig's pin read LIVE for eleven days and agreed with itself the whole time.
  const choice = selectXeroTenant({
    connections: [LIVE, DEMO],
    expectedTenantId: LIVE.tenantId,
    allowList: UNGUARDED_DEV,
  })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'unguarded-instance')
})

test('o3d-iaqy: the STORED token is refused too — the callback ran once, the damage took eleven days', () => {
  // And this is the arm that catches a production dump restored onto a dev box: it arrives with a live
  // token already in the database and no callback ever runs.
  const refusal = storedXeroConnectionRefusal(LIVE, UNGUARDED_DEV, LIVE.tenantId, BOUND, null)
  assert.notEqual(refusal, null)
  assert.match(refusal ?? '', /not marked as production and has no Xero tenant control set/)
  assert.match(refusal ?? '', /553 objects/, 'named, because the remedy has to be worth performing')
})

test('o3d-iaqy: the remedy is to NAME a ledger, never to switch the guard off', () => {
  const refusal = xeroUnguardedInstanceRefusal(UNGUARDED_DEV)
  assert.match(refusal, /XERO_ALLOWED_TENANT_IDS=/)
  assert.match(refusal, /XERO_REQUIRE_DEMO_ORG=true/)
  assert.match(refusal, /XERO_BLOCKED_TENANT_IDS=/)
  assert.match(refusal, /NODE_ENV=production/, 'and the one legitimate "this is not a test instance" answer')
  assert.doesNotMatch(refusal, /SKIP|DISABLE|_OFF|ignore this/i,
    'no boolean escape hatch: a guard whose documented way out is a switch is off on every instance '
    + 'that ever hit it')
})

test('o3d-iaqy: a CONFIGURED non-production instance behaves exactly as before', () => {
  // The no-regression guard. Everything o3d-9tbz decided still decides; this issue only closes the
  // "nothing configured" hole underneath it.
  const rig = readXeroTenantAllowList({
    NODE_ENV: 'production',
    E2E_TEST_MODE: '1',
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
  })
  assert.equal(rig.unguardedInstance, false)
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList: rig })
  assert.equal(choice.ok, true)
  assert.equal(choice.ok === true && choice.connection.tenantId, DEMO.tenantId)
  assert.equal(storedXeroConnectionRefusal(DEMO, rig, DEMO.tenantId, BOUND, null), null)
  // …and the allow-list still refuses the live org for the reason it always did, not for this one.
  const blocked = selectXeroTenant({ connections: [LIVE], expectedTenantId: null, allowList: rig })
  assert.equal(blocked.ok === false && blocked.reason, 'none-allowed')
})

test('o3d-iaqy: a CONFLICTING configuration is still reported as a conflict, not as unguarded', () => {
  // Ordering. A conflict has a remedy that this refusal's remedy would send an operator straight past:
  // "set XERO_ALLOWED_TENANT_IDS" is unperformable while XERO_TENANT_ID contradicts it.
  const conflicted = readXeroTenantAllowList({
    NODE_ENV: 'development',
    XERO_TENANT_ID: DEMO.tenantId,
    XERO_ALLOWED_TENANT_IDS: LIVE.tenantId,
  })
  assert.equal(conflicted.unguardedInstance, false, 'ids ARE set — this instance is not unguarded, it is contradictory')
  const choice = selectXeroTenant({ connections: [DEMO], expectedTenantId: null, allowList: conflicted })
  assert.equal(choice.ok === false && choice.reason, 'config-conflict')
})

test('o3d-iaqy: the per-organisation filter chain is deliberately NOT changed', () => {
  // xeroTenantVerdict answers "does this org survive the configured filters" and every one of its
  // answers names the key that removed the org. This issue removes no org in particular — it removes
  // the entitlement to be choosing — so folding it in would make a pure predicate over (org, list)
  // depend on the process environment, and make `whyRefused` describe a filter that never ran.
  assert.equal(xeroTenantVerdict(LIVE, UNGUARDED_DEV), 'allowed')
  assert.equal(isXeroTenantAllowed(LIVE, UNGUARDED_DEV), true)
})

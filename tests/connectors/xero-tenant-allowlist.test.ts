import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeXeroConnections, isXeroTenantAllowed, readXeroTenantAllowList, selectXeroTenant,
  storedTenantRefusalMessage, type XeroConnectionSummary,
} from '@/lib/connectors/xero/tenant-guard'

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

const NO_ALLOW_LIST = readXeroTenantAllowList({})
const DEMO_BY_ID = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_IDS: DEMO.tenantId })
const DEMO_BY_NAME = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' })


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
  const allowList = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_NAMES: '  demo   company (uk) ' })
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
  const allowList = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_IDS: `${DEMO.tenantId}, ${THIRD.tenantId}` })
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
  const allowList = readXeroTenantAllowList({})
  assert.equal(allowList.configured, false)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
})

test('a BLANK allow-list is unset, not "allow nothing"', () => {
  // .env.example ships the keys. A blank line in a config file must not disable every Xero connection.
  const allowList = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_IDS: '   ', XERO_ALLOWED_TENANT_NAMES: ' , ,' })
  assert.equal(allowList.configured, false)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true)
})

test('ids are matched case-insensitively and tolerate spaces around the commas', () => {
  const allowList = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_IDS: ` ${DEMO.tenantId.toUpperCase()} , ` })
  assert.deepEqual(allowList.rawIds, [DEMO.tenantId.toUpperCase()])
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('ids and names are a UNION — either kind of entry admits an organisation', () => {
  const allowList = readXeroTenantAllowList({
    XERO_ALLOWED_TENANT_IDS: THIRD.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(isXeroTenantAllowed(THIRD, allowList), true)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('a nameless organisation is not admitted by an empty name entry', () => {
  const allowList = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' })
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

const LEGACY_DEMO = readXeroTenantAllowList({ XERO_TENANT_ID: DEMO.tenantId })

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
  const allowList = readXeroTenantAllowList({ XERO_TENANT_ID: '   ' })
  assert.equal(allowList.configured, false)
  assert.equal(allowList.legacyTenantId, null)
  assert.equal(allowList.conflict, null)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true, 'a blank line must not disable Xero on every box')
})

test('XERO_TENANT_ID is matched case-insensitively, like every other id here', () => {
  const allowList = readXeroTenantAllowList({ XERO_TENANT_ID: ` ${DEMO.tenantId.toUpperCase()} ` })
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
    XERO_TENANT_ID: DEMO.tenantId,
    XERO_ALLOWED_TENANT_IDS: LIVE.tenantId,
  })
  assert.notEqual(allowList.conflict, null)
  assert.equal(isXeroTenantAllowed(DEMO, allowList), false, 'not even the one both could be read to allow')
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('the conflict refusal quotes both settings and gives a one-line fix', () => {
  const allowList = readXeroTenantAllowList({
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
  const allowList = readXeroTenantAllowList({ XERO_TENANT_ID: DEMO.tenantId, XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' })
  const choice = selectXeroTenant({ connections: [DEMO], expectedTenantId: null, allowList })
  assert.equal(choice.ok, false)
  assert.equal(choice.ok === false && choice.reason, 'config-conflict')
})

test('the two keys set to the SAME single organisation is not a conflict', () => {
  // Belt and braces during a migration off the deprecated name must not be an outage.
  const allowList = readXeroTenantAllowList({
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
  const allowList = readXeroTenantAllowList({ XERO_TENANT_ID: DEMO.tenantId, XERO_ALLOWED_TENANT_IDS: LIVE.tenantId })
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

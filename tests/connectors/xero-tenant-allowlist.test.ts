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

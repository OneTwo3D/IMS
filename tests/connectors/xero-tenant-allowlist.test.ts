import assert from 'node:assert/strict'
import test from 'node:test'

import {
  demoOrgConnectRefusal, demoOrgStoredRefusal, describeXeroConnections, isXeroTenantAllowed,
  nameOnlyGuardWarning, readXeroTenantAllowList, selectXeroTenant, storedTenantRefusalMessage,
  storedXeroConnectionRefusal, xeroDemoOrgVerdict, xeroTenantBindingRaceMessage, xeroTenantVerdict,
  type XeroConnectionSummary,
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

test('ids and names INTERSECT — a name cannot admit an organisation the id list excludes', () => {
  // This was a union, and the union was the bug (r2 finding 1): a name is not an identity, so letting one
  // ADD an organisation meant an org renamed to an allow-listed name walked past the id list.
  const allowList = readXeroTenantAllowList({
    XERO_ALLOWED_TENANT_IDS: THIRD.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(isXeroTenantAllowed(DEMO, allowList), false, 'the name does not admit an id that is not listed')
  assert.equal(isXeroTenantAllowed(THIRD, allowList), false, 'and the id does not survive a name it fails')
  assert.equal(isXeroTenantAllowed(LIVE, allowList), false)
})

test('a name NARROWS an id list, and both together admit the organisation they agree on', () => {
  const allowList = readXeroTenantAllowList({
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
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
  })
  assert.equal(isXeroTenantAllowed(renamedLive, allowList), false, 'a rename does not confer identity')
  assert.equal(isXeroTenantAllowed(DEMO, allowList), true)
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
  const allowList = readXeroTenantAllowList({ XERO_TENANT_ID: DEMO.tenantId, XERO_ALLOWED_TENANT_IDS: LIVE.tenantId })
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
    readXeroTenantAllowList({ XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)', XERO_BLOCKED_TENANT_IDS: LIVE.tenantId }).nameOnlyGuard,
    false,
    'and so is a deny-listed id',
  )
  assert.equal(readXeroTenantAllowList({}).nameOnlyGuard, false, 'no guard at all is not a name-only guard')
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

const BLOCK_LIVE = readXeroTenantAllowList({ XERO_BLOCKED_TENANT_IDS: LIVE.tenantId })

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
  const allowList = readXeroTenantAllowList({ XERO_TENANT_ID: DEMO.tenantId, XERO_BLOCKED_TENANT_IDS: DEMO.tenantId })
  assert.match(allowList.conflict ?? '', /XERO_TENANT_ID/)
  assert.doesNotMatch(allowList.conflict ?? '', /XERO_ALLOWED_TENANT_IDS/, 'not a key that is not in their .env')
})

test('a blank deny-list is unset, not "block nothing in a way that changes something"', () => {
  const allowList = readXeroTenantAllowList({ XERO_BLOCKED_TENANT_IDS: ' , ' })
  assert.equal(allowList.configured, false)
  assert.equal(isXeroTenantAllowed(LIVE, allowList), true)
})


// --- an id and a name naming ONE organisation (r2 finding 2) -------------------

test('XERO_TENANT_ID and that same organisation NAME are one instruction, not a conflict', () => {
  // These two spellings name a single organisation. Refusing them was the r2 finding-2 bug: the conflict
  // refusal has to fire on genuine disagreement, not on two ways of saying the same thing.
  const allowList = readXeroTenantAllowList({
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
  const allowList = readXeroTenantAllowList({ XERO_TENANT_ID: DEMO.tenantId, XERO_ALLOWED_TENANT_NAMES: 'OneTwo3D Ltd' })
  const choice = selectXeroTenant({ connections: [LIVE, DEMO], expectedTenantId: null, allowList })
  assert.match(choice.ok === false ? choice.error : '', new RegExp(`XERO_TENANT_ID=${DEMO.tenantId} selects`))
})

test('a name that matches NOTHING offered is none-allowed, not a contradiction', () => {
  // Only one side selected anything, so there is no disagreement to report — just nothing permitted.
  const allowList = readXeroTenantAllowList({
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

const DEMO_REQUIRED = readXeroTenantAllowList({ XERO_REQUIRE_DEMO_ORG: 'true' })

test('a deny-list on the live org does NOT stop a third organisation — the gap being closed', () => {
  const blockLive = readXeroTenantAllowList({ XERO_BLOCKED_TENANT_IDS: LIVE.tenantId })
  const choice = selectXeroTenant({ connections: [THIRD], expectedTenantId: null, allowList: blockLive })
  assert.equal(choice.ok, true, 'a bookkeeper sandbox is neither blocked nor allow-listed')
  assert.equal(choice.ok === true && choice.connection.tenantId, THIRD.tenantId)
})

test('a name alongside the deny-list does not close it either — the org can be renamed', () => {
  const guarded = readXeroTenantAllowList({
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
    assert.equal(readXeroTenantAllowList({ XERO_REQUIRE_DEMO_ORG: on }).requireDemoOrg, true, on)
  }
  for (const off of ['false', '0', 'no', 'off', '', '   ', undefined]) {
    const list = readXeroTenantAllowList({ XERO_REQUIRE_DEMO_ORG: off })
    assert.equal(list.requireDemoOrg, false, String(off))
    assert.equal(list.conflict, null, String(off))
  }
  // The XERO_TENANT_ID mistake in a new place: a line that reads like a guard, and no guard.
  const malformed = readXeroTenantAllowList({ XERO_REQUIRE_DEMO_ORG: 'Demo Company (UK)' })
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
  const nameOnly = readXeroTenantAllowList({ XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' })
  assert.equal(nameOnly.nameOnlyGuard, true)
  const anchored = readXeroTenantAllowList({
    XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)',
    XERO_REQUIRE_DEMO_ORG: 'true',
  })
  assert.equal(anchored.nameOnlyGuard, false, 'Xero asserts it; the organisation’s admin cannot')
})

test('the name-only warning offers the maintenance-free anchor first, and says what a deny-list misses', () => {
  const warning = nameOnlyGuardWarning(readXeroTenantAllowList({ XERO_ALLOWED_TENANT_NAMES: 'Demo Company (UK)' }))
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
  // one that works, so it must not be shadowed by the demo requirement.
  const allowList = readXeroTenantAllowList({
    XERO_ALLOWED_TENANT_IDS: DEMO.tenantId,
    XERO_REQUIRE_DEMO_ORG: 'true',
  })
  const refusal = storedXeroConnectionRefusal({ ...LIVE, isDemoCompany: false }, allowList)
  assert.match(refusal ?? '', /allow-list forbids/)

  assert.equal(
    storedXeroConnectionRefusal({ ...DEMO, isDemoCompany: true }, allowList), null,
    'an allowed demo organisation passes both',
  )
  assert.match(
    storedXeroConnectionRefusal({ ...DEMO, isDemoCompany: null }, allowList) ?? '',
    /XERO_REQUIRE_DEMO_ORG/,
    'and an allow-listed organisation with no proof is still refused',
  )
})

test('with the requirement off, an unverified stored token is untouched', () => {
  // Every installation that predates the column is in this state. It must not become an outage.
  assert.equal(storedXeroConnectionRefusal({ ...LIVE, isDemoCompany: null }, NO_ALLOW_LIST), null)
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

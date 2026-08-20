import assert from 'node:assert/strict'
import test from 'node:test'

import ts from 'typescript'

import { createSourceGraph, type ModuleGraph } from './module-graph'
import {
  isDelegatingFacadeBody,
  scanAuthenticationOnlyActions,
  scanSecretReadingActions,
  scanSource,
} from './server-action-guard-scan'

/**
 * o3d-hic9 / o3d-512h — tests for the DETECTOR itself, not for the app tree.
 *
 * o3d-1fel survived because the detector's `isDelegatingFacade` heuristic was
 * never exercised against anything but the live code, where a false negative is
 * invisible by construction: the test simply passes. These fixtures pin both
 * directions — what must be flagged, and what must not.
 *
 * Round 3: the fixtures build a real MODULE GRAPH rather than handing the scanner
 * a bare string, because the detector no longer matches names — it resolves them.
 * That is the point of the round: a fixture can now make "this delegate is
 * guarded" true or false ON PURPOSE and watch the rule follow, which is exactly
 * what could not be expressed while the rule only saw one file's text.
 */

const F = 'app/actions/fixture.ts'

const AUTH_SERVER = `
export async function requireAuth() {}
export async function getSession() {}
export async function requireFreshAuth() {}
export async function requireRole(...roles: string[]) { void roles }
export async function requirePermission(p: string) { void p }
export async function requireFreshPermission(p: string) { void p }
export async function requireInternalUser() {}
`

const SETTINGS_STORE = `
export async function getSettingValue(k: string) { void k }
export async function getSettingValues(k: string[]) { void k }
`

const GUARD_IMPORTS =
  "import { requireAuth, getSession, requireFreshAuth, requireRole, requirePermission, requireInternalUser } from '@/lib/auth/server'\n"
  + "import { getSettingValue, getSettingValues } from '@/lib/settings-store'\n"

/** A `'use server'` fixture module, plus whatever other modules it needs. */
function build(body: string, extra: Record<string, string> = {}): { graph: ModuleGraph; source: string } {
  const source = `'use server'\n${GUARD_IMPORTS}\n${body}\n`
  const graph = createSourceGraph({
    'lib/auth/server.ts': AUTH_SERVER,
    'lib/settings-store.ts': SETTINGS_STORE,
    [F]: source,
    ...extra,
  })
  return { graph, source }
}

function scan(body: string, allowlist: Record<string, string> = {}, extra: Record<string, string> = {}): string[] {
  const { graph, source } = build(body, extra)
  return scanSource(F, source, allowlist, graph)
}

function scanSecrets(body: string, extra: Record<string, string> = {}): string[] {
  const { graph, source } = build(body, extra)
  return scanSecretReadingActions(F, source, {}, graph)
}

function scanAuthOnly(body: string, extra: Record<string, string> = {}): string[] {
  const { graph, source } = build(body, extra)
  return scanAuthenticationOnlyActions(F, source, {}, graph)
}

// ---------------------------------------------------------------------------
// The o3d-1fel defect itself
// ---------------------------------------------------------------------------

test('flags a one-statement `return db.<model>.findMany()` — a Prisma call is not a delegate', () => {
  // This is verbatim the shape of xero-sync.ts:getAccountingAccounts.
  assert.deepEqual(
    scan(`export async function getAccountingAccounts() {
  return db.accountingAccount.findMany({ where: { connector: 'xero' } })
}`),
    [`${F}:getAccountingAccounts`],
  )
})

test('flags a one-statement `return prisma.<model>.create()` too', () => {
  assert.deepEqual(
    scan(`export async function writeIt() { return prisma.setting.create({ data: {} }) }`),
    [`${F}:writeIt`],
  )
})

test('flags an awaited Prisma one-liner', () => {
  assert.deepEqual(
    scan(`export async function readIt() { return await db.user.findMany() }`),
    [`${F}:readIt`],
  )
})

test('the db-rooted heuristic still says a Prisma call is not a facade', () => {
  // Kept from round 1 and still exported: the resolver would reject a db call
  // anyway, but this is the rule that says WHY, and it is the one a future
  // refactor is most likely to weaken by accident.
  const sf = ts.createSourceFile(
    'x.ts',
    'const a = async () => db.user.findMany(); const b = async () => other();',
    ts.ScriptTarget.Latest,
    true,
  )
  const bodies: ts.ConciseBody[] = []
  ts.forEachChild(sf, (n) => {
    if (!ts.isVariableStatement(n)) return
    const init = n.declarationList.declarations[0].initializer
    if (init && ts.isArrowFunction(init)) bodies.push(init.body)
  })
  assert.equal(bodies.length, 2)
  assert.equal(isDelegatingFacadeBody(bodies[0]), false, 'db-rooted call is never a facade')
  assert.equal(isDelegatingFacadeBody(bodies[1]), true, 'a plain call has facade SHAPE')
})

// ---------------------------------------------------------------------------
// Prose must neither satisfy nor trip the detector
// ---------------------------------------------------------------------------

test('a guard named only in a doc comment does NOT satisfy the detector', () => {
  assert.deepEqual(
    scan(`/**
 * Callers must hold requirePermission('sync') before invoking this.
 * See requireAuth and requireFreshAdmin for the surrounding policy.
 */
export async function looksGuardedInProseOnly() {
  const rows = await db.setting.findMany()
  return rows
}`),
    [`${F}:looksGuardedInProseOnly`],
  )
})

test('a guard named only in a string literal does NOT satisfy the detector', () => {
  assert.deepEqual(
    scan(`export async function stringOnly() {
  const note = 'requireAuth is applied by the caller'
  const rows = await db.setting.findMany()
  return { note, rows }
}`),
    [`${F}:stringOnly`],
  )
})

test('a genuinely guarded export mentioning nothing in prose is NOT flagged', () => {
  assert.deepEqual(
    scan(`export async function guarded() {
  await requirePermission('sync')
  return db.accountingAccount.findMany()
}`),
    [],
  )
})

test('prose in a NON-server module does not produce a violation', () => {
  const src = `
// This helper is only ever called from a 'use server' module.
export async function notAnEndpoint() {
  return db.setting.findMany()
}
`
  assert.deepEqual(scanSource(F, src, {}, createSourceGraph({ [F]: src })), [])
})

// ---------------------------------------------------------------------------
// Round 3, finding 2a — a guard NAME that is never called
//
// Round 2 fixed exactly one instance of this: `async () => requireAuth`, a
// concise body naming the guard without running it. The general case survived,
// because the rule walked IDENTIFIERS. Every fixture below names a real guard,
// resolvable to lib/auth/server.ts, in a position that does not execute it.
// ---------------------------------------------------------------------------

test('a guard assigned to a local but never invoked is still flagged', () => {
  assert.deepEqual(
    scan(`export async function looksGuarded() {
  const guard = requireAuth
  void guard
  return db.setting.findMany()
}`),
    [`${F}:looksGuarded`],
  )
})

test('a guard used only in a TYPE position is still flagged', () => {
  assert.deepEqual(
    scan(`export async function looksGuarded(): Promise<unknown> {
  const deps: { g: typeof requireAuth } = { g: requireAuth }
  void deps
  return db.setting.findMany()
}`),
    [`${F}:looksGuarded`],
  )
})

test('a guard PASSED as a value (never called here) is still flagged', () => {
  // The shape a dependency-injection refactor produces, and the one that reads
  // most convincingly as "there is a guard in this function".
  assert.deepEqual(
    scan(`export async function looksGuarded() {
  const guards = [requireAuth, requirePermission]
  return { count: guards.length, rows: await db.setting.findMany() }
}`),
    [`${F}:looksGuarded`],
  )
})

test('a concise body that NAMES a guard without calling it is still flagged (round 2 case, kept)', () => {
  assert.deepEqual(
    scan(`export const looksGuarded = async () => requireAuth`),
    [`${F}:looksGuarded`],
  )
})

test('a guarded CONCISE-bodied async arrow is not flagged', () => {
  assert.deepEqual(scan(`export const ping = async () => requirePermission('sync')`), [])
})

// ---------------------------------------------------------------------------
// Round 3, finding 2b — an UNVERIFIED delegate
//
// The old rule credited `return someHelper()` on the SHAPE of the body. It never
// looked at someHelper. These fixtures differ only in what the delegate does.
// ---------------------------------------------------------------------------

test('a facade delegating to a GUARDED action is not flagged', () => {
  assert.deepEqual(
    scan(
      `import { getWcSyncSettings } from '@/app/actions/wc-sync'
export async function getShoppingSyncSettings() { return getWcSyncSettings() }`,
      {},
      {
        'app/actions/wc-sync.ts':
          "import { requirePermission } from '@/lib/auth/server'\n"
          + "export async function getWcSyncSettings() { await requirePermission('sync'); return db.setting.findMany() }",
      },
    ),
    [],
  )
})

test('a facade delegating to an UNGUARDED action IS flagged — this is the hole', () => {
  // Byte-identical to the fixture above except for the delegate's body. The old
  // detector could not tell them apart, because it never opened the delegate.
  assert.deepEqual(
    scan(
      `import { getWcSyncSettings } from '@/app/actions/wc-sync'
export async function getShoppingSyncSettings() { return getWcSyncSettings() }`,
      {},
      {
        'app/actions/wc-sync.ts':
          'export async function getWcSyncSettings() { return db.setting.findMany() }',
      },
    ),
    [`${F}:getShoppingSyncSettings`],
  )
})

test('a facade whose delegate CANNOT BE RESOLVED is flagged — not verified is not guarded', () => {
  // `connector.getAccounts()` was explicitly accepted by the old rule. The
  // connector object is chosen at runtime, so no static reader can say what it
  // gates on; the honest answer is to refuse the credit and make the allowlist
  // carry a stated reason instead.
  assert.deepEqual(
    scan(`export async function getAccounts() { return connector.getAccounts() }`),
    [`${F}:getAccounts`],
  )
})

test('a facade delegating into node_modules is flagged rather than credited', () => {
  assert.deepEqual(
    scan(`import { doIt } from 'some-package'
export async function go() { return doIt() }`),
    [`${F}:go`],
  )
})

test('a guard reached through a LOCAL WRAPPER is credited — resolution, not naming', () => {
  assert.deepEqual(
    scan(`async function requireAdmin() { return requirePermission('sync') }
export async function getAccounts() {
  await requireAdmin()
  return db.accountingAccount.findMany()
}`),
    [],
  )
})

test('a LOCAL FUNCTION SHADOWING a guard name is NOT credited — the allocation.ts defect', () => {
  // The module imports the real requireAuth AND declares its own. Every call in
  // the file runs the local one, which guards nothing. A name-matching rule
  // credited this; resolution refuses to.
  assert.deepEqual(
    scan(`async function requireAuth() { return { user: { id: 'x' } } }
export async function getOrderAllocations() {
  await requireAuth()
  return db.orderAllocation.findMany()
}`),
    [`${F}:getOrderAllocations`],
  )
})

test('an ALIASED import of a real guard IS credited — renaming is not evasion either way', () => {
  const source = `'use server'\nimport { requirePermission as mayI } from '@/lib/auth/server'\n`
    + `export async function getAccounts() { await mayI('sync'); return db.accountingAccount.findMany() }\n`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, [F]: source })
  assert.deepEqual(scanSource(F, source, {}, graph), [])
})

test('a guard called through a NAMESPACE import is credited', () => {
  const source = `'use server'\nimport * as guards from '@/lib/auth/server'\n`
    + `export async function getAccounts() { await guards.requirePermission('sync'); return db.x.findMany() }\n`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, [F]: source })
  assert.deepEqual(scanSource(F, source, {}, graph), [])
})

test('with NO graph nothing resolves, so nothing is credited', () => {
  // The failure direction matters: a rule that exists to have no false negatives
  // must go LOUD, not quiet, when it cannot see.
  const source = `'use server'\nimport { requirePermission } from '@/lib/auth/server'\n`
    + `export async function guarded() { await requirePermission('sync'); return db.x.findMany() }\n`
  assert.deepEqual(scanSource(F, source, {}), [`${F}:guarded`])
})

test('a multi-statement dispatcher is flagged unless allowlisted', () => {
  const body = `export async function dispatch() {
  const connector = await getActiveConnector()
  return connector.getAccounts()
}`
  assert.deepEqual(scan(body), [`${F}:dispatch`])
  assert.deepEqual(scan(body, { [`${F}:dispatch`]: 'dispatcher → guarded delegate' }), [])
})

// ---------------------------------------------------------------------------
// Allowlist mechanics
// ---------------------------------------------------------------------------

test('a module wildcard suppresses every export in that file', () => {
  const body = `export async function a() { return db.x.findMany() }
export async function b() { return db.y.findMany() }`
  assert.deepEqual(scan(body), [`${F}:a`, `${F}:b`])
  assert.deepEqual(scan(body, { [`${F}:*`]: 'reason' }), [])
})

test('a non-exported unguarded function is not flagged', () => {
  assert.deepEqual(
    scan(`async function helper() { return db.x.findMany() }
export async function guarded() {
  await requireAuth()
  return helper()
}`),
    [],
  )
})

// ---------------------------------------------------------------------------
// Exported async ARROWS are endpoints too (o3d-512h)
// ---------------------------------------------------------------------------

test('flags an unguarded exported async ARROW', () => {
  assert.deepEqual(
    scan(`export const getAccountingAccounts = async () => { return db.accountingAccount.findMany() }`),
    [`${F}:getAccountingAccounts`],
  )
})

test('flags an unguarded exported async FUNCTION EXPRESSION', () => {
  assert.deepEqual(
    scan(`export const readIt = async function () { const rows = await db.setting.findMany(); return rows }`),
    [`${F}:readIt`],
  )
})

test('flags an unguarded CONCISE-bodied async arrow doing its own Prisma read', () => {
  assert.deepEqual(scan(`export const readIt = async () => db.setting.findMany()`), [`${F}:readIt`])
})

test('a GUARDED exported async arrow is not flagged', () => {
  assert.deepEqual(
    scan(`export const getAccounts = async () => {
  await requirePermission('sync')
  return db.accountingAccount.findMany()
}`),
    [],
  )
})

test('every declarator in one exported statement is its own endpoint', () => {
  assert.deepEqual(
    scan(`export const a = async () => db.x.findMany(), b = async () => db.y.findMany()`),
    [`${F}:a`, `${F}:b`],
  )
})

test('a NON-async exported arrow is not treated as a server action', () => {
  assert.deepEqual(scan(`export const notAnEndpoint = () => db.x.findMany()`), [])
})

test('a non-exported async arrow is not flagged', () => {
  assert.deepEqual(
    scan(`const helper = async () => db.x.findMany()
export async function guarded() {
  await requireAuth()
  return helper()
}`),
    [],
  )
})

test('an allowlist entry suppresses an arrow endpoint by name', () => {
  const body = `export const dispatch = async () => {
  const connector = await getActiveConnector()
  return connector.getAccounts()
}`
  assert.deepEqual(scan(body), [`${F}:dispatch`])
  assert.deepEqual(scan(body, { [`${F}:dispatch`]: 'reason' }), [])
})

// ---------------------------------------------------------------------------
// requireAuth is not an answer to an authorization question (o3d-512h)
// ---------------------------------------------------------------------------

test('flags a secret read behind requireAuth — the shape that hid getEmailSettings', () => {
  const body = `export async function getEmailSettings() {
  await requireAuth()
  const map = await getSettingValues(['email_smtp_pass'])
  return { pass: map.get('email_smtp_pass') }
}`
  assert.deepEqual(scanSecrets(body), [`${F}:getEmailSettings`])
  // The ORIGINAL rule stays silent on it — which is the whole point.
  assert.deepEqual(scan(body), [])
})

test('a secret read behind requirePermission is not flagged', () => {
  assert.deepEqual(
    scanSecrets(`export async function getEmailSettings() {
  await requirePermission('settings.company')
  return getSettingValues(['email_smtp_pass'])
}`),
    [],
  )
})

test('a secret read behind requireRole is not flagged', () => {
  assert.deepEqual(
    scanSecrets(`export async function readSecret() {
  await requireRole('ADMIN', 'FINANCE')
  return getSettingValue('xero_client_secret')
}`),
    [],
  )
})

test('a secret read behind requireInternalUser is not flagged — it is an authorization gate', () => {
  assert.deepEqual(
    scanSecrets(`export async function readSecret() {
  await requireInternalUser()
  return getSettingValue('xero_client_secret')
}`),
    [],
  )
})

test('the secret-read rule reaches exported async arrows too', () => {
  assert.deepEqual(
    scanSecrets(`export const leak = async () => {
  await requireAuth()
  return getSettingValue('wc_consumer_key')
}`),
    [`${F}:leak`],
  )
})

test('a LOCAL function merely NAMED getSettingValue does not trip the secret rule', () => {
  // Resolution cuts both ways: the rule must not fire on a same-named local that
  // reads nothing, or the answer would be an allowlist entry excusing a
  // non-problem — and allowlists are how the real ones hid.
  const source = `'use server'\nimport { requireAuth } from '@/lib/auth/server'\n`
    + `function getSettingValue(k: string) { return k.toUpperCase() }\n`
    + `export async function harmless() { await requireAuth(); return getSettingValue('brand_colour') }\n`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, 'lib/settings-store.ts': SETTINGS_STORE, [F]: source })
  assert.deepEqual(scanSecretReadingActions(F, source, {}, graph), [])
})

test('an action reading db.setting directly under requireAuth is NOT flagged by the secret rule', () => {
  assert.deepEqual(
    scanSecrets(`export async function getBrandingColours() {
  await requireAuth()
  return db.setting.findMany({ where: { key: { startsWith: 'brand_' } } })
}`),
    [],
  )
})

test('the secret-read rule ignores a non-server module', () => {
  const src = `
export async function notAnEndpoint() {
  await requireAuth()
  return getSettingValue('email_smtp_pass')
}
`
  assert.deepEqual(scanSecretReadingActions(F, src, {}, createSourceGraph({ [F]: src })), [])
})

// ---------------------------------------------------------------------------
// The authentication-only INVENTORY rule (o3d-512h)
// ---------------------------------------------------------------------------

test('inventories an export gated on requireAuth alone', () => {
  assert.deepEqual(
    scanAuthOnly(`export async function getOrganisation() {
  await requireAuth()
  return db.organisation.findFirst()
}`),
    [`${F}:getOrganisation`],
  )
})

test('does NOT inventory an export holding a real authorization gate', () => {
  assert.deepEqual(
    scanAuthOnly(`export async function saveIt() {
  await requirePermission('settings.company')
  return db.setting.updateMany({ data: {} })
}`),
    [],
  )
})

test('does NOT inventory an export that calls requireAuth AND an authorization gate', () => {
  assert.deepEqual(
    scanAuthOnly(`export async function mixed() {
  const session = await requireAuth()
  await requirePermission('sync')
  return session.user.id
}`),
    [],
  )
})

test('requireInternalUser takes an endpoint OUT of the inventory — it refuses a principal', () => {
  assert.deepEqual(
    scanAuthOnly(`export async function listThings() {
  await requireInternalUser()
  return db.product.findMany()
}`),
    [],
  )
})

test('a LOCAL function named requirePermission does NOT take an endpoint out of the inventory', () => {
  // The inventory is a list of endpoints someone has to justify. Letting a
  // same-named local remove an entry would let a rename delete the obligation.
  const source = `'use server'\nimport { requireAuth } from '@/lib/auth/server'\n`
    + `async function requirePermission(p: string) { void p }\n`
    + `export async function sneaky() { await requireAuth(); await requirePermission('sync'); return db.user.findMany() }\n`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, [F]: source })
  assert.deepEqual(scanAuthenticationOnlyActions(F, source, {}, graph), [`${F}:sneaky`])
})

test('does NOT inventory an UNGUARDED export — that is the other rule\'s violation', () => {
  const body = `export async function wideOpen() { return db.product.findMany() }`
  assert.deepEqual(scanAuthOnly(body), [])
  assert.deepEqual(scan(body), [`${F}:wideOpen`])
})

test('the inventory rule reaches exported async arrows, including concise bodies', () => {
  assert.deepEqual(
    scanAuthOnly(`export const blockArrow = async () => {
  await requireAuth()
  return db.product.findMany()
}
export const conciseArrow = async () => requireAuth()`).sort(),
    [`${F}:blockArrow`, `${F}:conciseArrow`].sort(),
  )
})

test('the inventory rule ignores a non-server module', () => {
  const src = `
export async function notAnEndpoint() {
  await requireAuth()
  return db.product.findMany()
}
`
  assert.deepEqual(scanAuthenticationOnlyActions(F, src, {}, createSourceGraph({ [F]: src })), [])
})

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

// ---------------------------------------------------------------------------
// Round 4, finding 2 — DOES THE GUARD ACTUALLY RUN?
//
// Round 3 verified WHICH declaration a call resolves to and left WHERE the call
// sits unchecked; its own report said so. A resolved guard in a branch nothing
// takes is credit for work not done, so position is verified the same way
// identity is.
// ---------------------------------------------------------------------------

const BYPASS = { 'lib/bypass.ts': "export const INTERNAL_BYPASS = Symbol('internal-bypass')\nexport const OTHER_BYPASS = Symbol('other-bypass')\n" }
const BYPASS_IMPORT = "import { INTERNAL_BYPASS, OTHER_BYPASS } from '@/lib/bypass'\n"

test('a guard inside an `if` branch is NOT credited — it may not run', () => {
  assert.deepEqual(
    scan(`export async function a(flag: boolean) {
      if (flag) { await requirePermission('sync') }
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard in an `else` branch is NOT credited either', () => {
  assert.deepEqual(
    scan(`export async function a(flag: boolean) {
      if (flag) { void 0 } else { await requirePermission('sync') }
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard whose refusal a `catch` SWALLOWS is not a guard', () => {
  // Worse than no guard: it reads like one, and execution carries straight on
  // into the body with the denial discarded.
  assert.deepEqual(
    scan(`export async function a() {
      try { await requirePermission('sync') } catch {}
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard whose `catch` cannot fall through IS credited — the getUsers shape', () => {
  // app/actions/users.ts:getUsers is exactly this, and it is a real refusal
  // written as a catch. A rule that flagged it would be answered with an
  // allowlist entry instead of a fix.
  assert.deepEqual(
    scan(`export async function a() {
      try { await requirePermission('sync') } catch { return [] }
      return db.thing.findMany()
    }`),
    [],
  )
})

test('a guard in a try whose catch RETHROWS is credited', () => {
  assert.deepEqual(
    scan(`export async function a() {
      try { await requirePermission('sync') } catch (e) { throw e }
      return db.thing.findMany()
    }`),
    [],
  )
})

test('a guard in a try with NO catch is credited', () => {
  assert.deepEqual(
    scan(`export async function a() {
      try { await requirePermission('sync') } finally { void 0 }
      return db.thing.findMany()
    }`),
    [],
  )
})

test('a guard inside a LOOP body is not credited — the loop may run zero times', () => {
  assert.deepEqual(
    scan(`export async function a(ids: string[]) {
      for (const id of ids) { await requirePermission('sync'); void id }
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard after a `return` is not credited — unreachable code is not a gate', () => {
  assert.deepEqual(
    scan(`export async function a() {
      return db.thing.findMany()
      await requirePermission('sync')
    }`),
    [`${F}:a`],
  )
})

test('a guard in a TERNARY arm is not credited', () => {
  assert.deepEqual(
    scan(`export async function a(flag: boolean) {
      const gate = flag ? await requirePermission('sync') : null
      void gate
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard on the SHORT-CIRCUITED side of && is not credited', () => {
  assert.deepEqual(
    scan(`export async function a(flag: boolean) {
      const gate = flag && await requirePermission('sync')
      void gate
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard inside a CALLBACK is not credited — it is deferred, and nothing awaits it', () => {
  assert.deepEqual(
    scan(`export async function a() {
      const runners = [1].map(async () => requirePermission('sync'))
      void runners
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('an OPTIONAL call on a real guard is not credited — it is skipped when the callee is nullish', () => {
  // The callee resolves to lib/auth/server.ts:requirePermission, so identity is
  // not the question here; `?.()` means the call may not happen at all.
  assert.deepEqual(
    scan(`export async function a() {
      await requirePermission?.('sync')
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard evaluated in the CONDITION of an `if` IS credited — it runs to decide the branch', () => {
  assert.deepEqual(
    scan(`export async function a(flag: boolean) {
      if ((await requirePermission('sync')) && flag) { return [] }
      return db.thing.findMany()
    }`),
    [],
  )
})

test('an unconditional guard is still credited — the ordinary shape does not regress', () => {
  assert.deepEqual(
    scan(`export async function a() {
      await requirePermission('sync')
      return db.thing.findMany()
    }`),
    [],
  )
})

// --- the one conditional position that IS verified -------------------------

test('a guard behind an UNFORGEABLE Symbol sentinel is credited', () => {
  // A Server Action's arguments arrive deserialized from the wire, and a symbol
  // cannot be represented there — so no network caller can make this comparison
  // match, and the guarded arm is the only arm they can take. (o3d-43oz)
  assert.deepEqual(
    scan(`${BYPASS_IMPORT}export async function a(options?: { t?: symbol }) {
      if (options?.t !== INTERNAL_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, BYPASS),
    [],
  )
})

test('the same shape with a BOOLEAN flag is flagged — this is the o3d-43oz defect', () => {
  // `skipPermissionCheck?: boolean` is what the symbol replaced: a client could
  // simply send it. The rule tells them apart by RESOLVING the sentinel to a
  // `Symbol()` const, not by recognising the idiom.
  assert.deepEqual(
    scan(`export async function a(options?: { skipPermissionCheck?: boolean }) {
      if (!options?.skipPermissionCheck) { await requirePermission('sync') }
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a sentinel that is a STRING const, not a Symbol, earns nothing', () => {
  assert.deepEqual(
    scan(`import { STRING_BYPASS } from '@/lib/strbypass'
    export async function a(options?: { t?: string }) {
      if (options?.t !== STRING_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, { 'lib/strbypass.ts': "export const STRING_BYPASS = 'internal-bypass'\n" }),
    [`${F}:a`],
  )
})

test('a sentinel test held in a local `const`, negated, is credited — the createRefund shape', () => {
  assert.deepEqual(
    scan(`${BYPASS_IMPORT}export async function a(options?: { t?: symbol }) {
      const isInternal = options?.t === INTERNAL_BYPASS
      if (!isInternal) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, BYPASS),
    [],
  )
})

test('two sentinel tests combined with `!a && !b` are credited — the applySalesOrderStatusTransition shape', () => {
  assert.deepEqual(
    scan(`${BYPASS_IMPORT}export async function a(options?: { t?: symbol }) {
      const bypassPermission = options?.t === INTERNAL_BYPASS
      const authOnly = options?.t === OTHER_BYPASS
      if (!bypassPermission && !authOnly) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, BYPASS),
    [],
  )
})

test('the same test held in a `let` earns nothing — it can be reassigned before the branch', () => {
  assert.deepEqual(
    scan(`${BYPASS_IMPORT}export async function a(options?: { t?: symbol }) {
      let isInternal = options?.t === INTERNAL_BYPASS
      isInternal = true
      if (!isInternal) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, BYPASS),
    [`${F}:a`],
  )
})

test('POLARITY is checked: the MATCHING arm of a sentinel test is not a guard', () => {
  // Here the guard runs only for the internal caller that already proved itself,
  // and the network caller — the one the guard exists for — skips it entirely.
  assert.deepEqual(
    scan(`${BYPASS_IMPORT}export async function a(options?: { t?: symbol }) {
      if (options?.t === INTERNAL_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, BYPASS),
    [`${F}:a`],
  )
})

test('the position rule reaches the SECRET-READ rule too', () => {
  assert.deepEqual(
    scanSecrets(`export async function a(flag: boolean) {
      await requireAuth()
      if (flag) { await requirePermission('settings') }
      return getSettingValue('email_smtp_pass')
    }`),
    [`${F}:a`],
  )
})

test('a conditional requireAuth does not put an endpoint in the authentication-only inventory', () => {
  // It is unguarded, which is the coverage rule's violation — not an
  // authentication-only endpoint to be inventoried and accepted.
  assert.deepEqual(
    scanAuthOnly(`export async function a(flag: boolean) {
      if (flag) { await requireAuth() }
      return db.thing.findMany()
    }`),
    [],
  )
  assert.deepEqual(
    scan(`export async function a(flag: boolean) {
      if (flag) { await requireAuth() }
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

// ---------------------------------------------------------------------------
// Round 4, finding 3 — ALIASED SECRET READERS
//
// The resolver was built so that renaming could not defeat a name match. The
// secret-read rule never adopted it: resolution was only reached for identifiers
// already spelled like a reader, so the name test was still the entry condition.
// ---------------------------------------------------------------------------

const SETTINGS_ALIAS = "import { getSettingValue as readSetting } from '@/lib/settings-store'\n"

test('an ALIASED import of a secret reader behind requireAuth IS flagged', () => {
  assert.deepEqual(
    scanSecrets(`${SETTINGS_ALIAS}export async function a() {
      await requireAuth()
      return readSetting('email_smtp_pass')
    }`),
    [`${F}:a`],
  )
})

test('the same aliased read behind an AUTHORIZATION guard is not flagged', () => {
  assert.deepEqual(
    scanSecrets(`${SETTINGS_ALIAS}export async function a() {
      await requirePermission('settings')
      return readSetting('email_smtp_pass')
    }`),
    [],
  )
})

test('a secret reader reached through a NAMESPACE import is flagged', () => {
  assert.deepEqual(
    scanSecrets(`import * as store from '@/lib/settings-store'
    export async function a() {
      await requireAuth()
      return store.getSettingValue('email_smtp_pass')
    }`),
    [`${F}:a`],
  )
})

test('an aliased reader passed around as a VALUE is flagged too', () => {
  assert.deepEqual(
    scanSecrets(`${SETTINGS_ALIAS}export async function a() {
      await requireAuth()
      const reader = readSetting
      return reader('email_smtp_pass')
    }`),
    [`${F}:a`],
  )
})

test('an import ALIASED TO a reader name that resolves elsewhere is NOT flagged', () => {
  // The other direction of the same question: the local name looks exactly like
  // a reader, and resolution says it is not one.
  assert.deepEqual(
    scanSecrets(`import { unrelated as getSettingValue } from '@/lib/other'
    export async function a() {
      await requireAuth()
      return getSettingValue('email_smtp_pass')
    }`, { 'lib/other.ts': 'export async function unrelated(k: string) { return k }\n' }),
    [],
  )
})

test('a guard whose promise NOTHING AWAITS is not credited', () => {
  // The refusal is started and not waited for: execution continues into the read
  // while the check is still pending, and the rejection surfaces later as an
  // unhandled rejection instead of a denial.
  assert.deepEqual(
    scan(`export async function a() {
      requirePermission('sync')
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a guard stashed in a variable and never awaited is not credited', () => {
  assert.deepEqual(
    scan(`export async function a() {
      const pending = requirePermission('sync')
      void pending
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('`return guard()` IS credited — the caller awaits it', () => {
  assert.deepEqual(
    scan(`export async function a() {
      return requirePermission('sync')
    }`),
    [],
  )
})

test('a guard in a try whose FINALLY returns is not credited — finally swallows the refusal', () => {
  assert.deepEqual(
    scan(`export async function a() {
      try { await requirePermission('sync') } finally { return db.thing.findMany() }
    }`),
    [`${F}:a`],
  )
})

// ---------------------------------------------------------------------------
// o3d-512h round 5 — the verification machinery crediting what it never checked
// ---------------------------------------------------------------------------

test('a guard name SHADOWED inside the function body is not the guard — round 5, finding 1', () => {
  // The resolver was built so aliasing could not defeat a name match, and round 4
  // pinned a MODULE-LEVEL shadow. This is the same defect one scope in: `locals`
  // holds top-level declarations only, so resolution fell through to the import
  // and answered with the real primitive while every call here runs a no-op.
  assert.deepEqual(
    scan(`export async function a() {
      const requirePermission = async (_p: string) => {}
      await requirePermission('sync')
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a PARAMETER shadowing a guard name is not the guard either', () => {
  // The caller supplies it. `a(async () => {})` disarms the endpoint from the wire.
  assert.deepEqual(
    scan(`export async function a(requirePermission: (p: string) => Promise<void>) {
      await requirePermission('sync')
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a DESTRUCTURED parameter shadowing a guard name is not the guard', () => {
  assert.deepEqual(
    scan(`export async function a({ requirePermission }: { requirePermission: (p: string) => Promise<void> }) {
      await requirePermission('sync')
      return db.thing.findMany()
    }`),
    [`${F}:a`],
  )
})

test('a shadow in a SIBLING function does not disarm the real guard elsewhere', () => {
  // The other direction, and the one that keeps the rule usable: shadowing is a
  // property of a position, not of a file.
  assert.deepEqual(
    scan(`async function helper() { const requirePermission = async (_p: string) => {}; await requirePermission('x') }
    export async function a() {
      void helper
      await requirePermission('sync')
      return db.thing.findMany()
    }`),
    [],
  )
})

test('a shadowed SECRET READER still counts as a read — shadowing fails closed both ways', () => {
  // Resolution says "not verified", and the secret-read rule treats an
  // unresolvable name that is spelled like a reader as a read rather than
  // waving it through. Under an authentication-only gate that is a violation.
  assert.deepEqual(
    scanSecrets(`export async function a() {
      await requireAuth()
      const getSettingValue = async (_k: string) => 'x'
      return getSettingValue('smtp_password')
    }`),
    [`${F}:a`],
  )
})

test('a sentinel built from a LOCAL function named Symbol earns nothing — round 5, finding 2', () => {
  // The sentinel argument rests entirely on the BUILT-IN Symbol: its result has
  // no wire representation. A module-level binding of the name produces a value
  // a client can send — here, the string 'internal-bypass'.
  const fake = {
    'lib/fakesym.ts':
      "const Symbol = (s: string) => s\nexport const FAKE_BYPASS = Symbol('internal-bypass')\n",
  }
  assert.deepEqual(
    scan(`import { FAKE_BYPASS } from '@/lib/fakesym'
    export async function a(options?: { t?: unknown }) {
      if (options?.t !== FAKE_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, fake),
    [`${F}:a`],
  )
})

test('a sentinel built from an IMPORTED binding named Symbol earns nothing', () => {
  const fake = {
    'lib/symcompat.ts': "export const Symbol = (s: string) => s\n",
    'lib/fakesym2.ts':
      "import { Symbol } from '@/lib/symcompat'\nexport const FAKE_BYPASS = Symbol('internal-bypass')\n",
  }
  assert.deepEqual(
    scan(`import { FAKE_BYPASS } from '@/lib/fakesym2'
    export async function a(options?: { t?: unknown }) {
      if (options?.t !== FAKE_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, fake),
    [`${F}:a`],
  )
})

test('a sentinel held in a LET, not a const, earns nothing — it can be reassigned', () => {
  const fake = { 'lib/letsym.ts': "export let LET_BYPASS = Symbol('internal-bypass')\n" }
  assert.deepEqual(
    scan(`import { LET_BYPASS } from '@/lib/letsym'
    export async function a(options?: { t?: unknown }) {
      if (options?.t !== LET_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, fake),
    [`${F}:a`],
  )
})

test('the real Symbol sentinel still passes — the round 4 shape does not regress', () => {
  assert.deepEqual(
    scan(`${BYPASS_IMPORT}export async function a(options?: { t?: symbol }) {
      if (options?.t !== INTERNAL_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, BYPASS),
    [],
  )
})

test('a guard AFTER a write is not credited — round 5, finding 3', () => {
  // Position analysis answered "does it run" and never asked "when". The row is
  // gone before the refusal is raised, and the caller receives a denial that
  // reads as proof nothing happened.
  assert.deepEqual(
    scan(`export async function a(id: string) {
      await db.thing.delete({ where: { id } })
      await requirePermission('sync')
      return { ok: true }
    }`),
    [`${F}:a`],
  )
})

test('a guard BEFORE the write is credited — ordering is the whole rule', () => {
  assert.deepEqual(
    scan(`export async function a(id: string) {
      await requirePermission('sync')
      await db.thing.delete({ where: { id } })
      return { ok: true }
    }`),
    [],
  )
})

test('a write inside a $transaction callback still precedes a later guard', () => {
  assert.deepEqual(
    scan(`export async function a(id: string) {
      await db.$transaction(async (tx) => { await tx.thing.update({ where: { id }, data: {} }) })
      await requirePermission('sync')
      return { ok: true }
    }`),
    [`${F}:a`],
  )
})

test('a write in a branch that may not run still disqualifies a later guard', () => {
  // The rule over-reports writes for the same reason the position rule
  // under-credits guards: a write that MIGHT happen first is one the guard did
  // not gate.
  assert.deepEqual(
    scan(`export async function a(id: string, flag: boolean) {
      if (flag) { await db.thing.deleteMany({ where: { id } }) }
      await requirePermission('sync')
      return { ok: true }
    }`),
    [`${F}:a`],
  )
})

test('a READ before the guard is not this rule — reads are left to the other rules', () => {
  // Stated as a limit rather than implied: widening to every db access would be
  // answered with allowlist entries, so the rule claims exactly what it checks.
  assert.deepEqual(
    scan(`export async function a(id: string) {
      const row = await db.thing.findUnique({ where: { id } })
      await requirePermission('sync')
      return row
    }`),
    [],
  )
})

test('a DELEGATE that writes before its own guard does not launder the guard', () => {
  assert.deepEqual(
    scan(`import { doIt } from '@/lib/late'
    export async function a(id: string) { return doIt(id) }`, {}, {
      'lib/late.ts':
        "import { requirePermission } from '@/lib/auth/server'\n"
        + 'export async function doIt(id: string) {\n'
        + '  await db.thing.delete({ where: { id } })\n'
        + "  await requirePermission('sync')\n"
        + '}\n',
    }),
    [`${F}:a`],
  )
})

test('a write LAUNDERED through a helper still disqualifies a later guard', () => {
  // Otherwise the rule is answered by moving one line into a function, which is a
  // shape check — exactly what resolution replaced.
  assert.deepEqual(
    scan(`import { wipe } from '@/lib/wipe'
    export async function a(id: string) {
      await wipe(id)
      await requirePermission('sync')
      return { ok: true }
    }`, {}, {
      'lib/wipe.ts': 'export async function wipe(id: string) { await db.thing.deleteMany({ where: { id } }) }',
    }),
    [`${F}:a`],
  )
})

test('a READING helper before the guard is not a write — the limit holds in both directions', () => {
  assert.deepEqual(
    scan(`import { load } from '@/lib/load'
    export async function a(id: string) {
      const row = await load(id)
      await requirePermission('sync')
      return row
    }`, {}, {
      'lib/load.ts': 'export async function load(id: string) { return db.thing.findUnique({ where: { id } }) }',
    }),
    [],
  )
})

test('a guard that RECORDS its own refusal does not disqualify the guards after it', () => {
  // A denial that writes an activity row is still a denial. If the write question
  // were asked first, this endpoint would lose the AUTHORIZATION check that comes
  // after the logging one and be reported as reading a secret behind
  // authentication alone — a violation manufactured by the checker.
  const GUARD_LOG = {
    'lib/authlog.ts':
      "import { requireAuth } from '@/lib/auth/server'\n"
      + 'export async function authAndLog() {\n'
      + '  await requireAuth()\n'
      + "  await db.activityLog.create({ data: { action: 'seen' } })\n"
      + '}\n',
  }
  assert.deepEqual(
    scanSecrets(`import { authAndLog } from '@/lib/authlog'
    export async function a() {
      await authAndLog()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, GUARD_LOG),
    [],
  )
  // …and the write it performs is still a write when it is NOT a guard.
  assert.deepEqual(
    scanSecrets(`import { justLog } from '@/lib/justlog'
    export async function a() {
      await justLog()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, {
      'lib/justlog.ts': "export async function justLog() { await db.activityLog.create({ data: { action: 'seen' } }) }",
    }),
    [`${F}:a`],
  )
})

test('an UNRESOLVABLE callee before the guard is not treated as a write', () => {
  // The stated limit: counting the unknown as a write would put a red build on
  // every correctly guarded endpoint that calls anything the graph cannot follow.
  assert.deepEqual(
    scan(`import { connector } from 'some-package'
    export async function a(id: string) {
      await connector.doSomething(id)
      await requirePermission('sync')
      return { ok: true }
    }`),
    [],
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import ts from 'typescript'

import { createSourceGraph, type ModuleGraph } from './module-graph'
import {
  isDelegatingFacadeBody,
  scanAuthenticationOnlyActions,
  scanInlineServerActions,
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

test('a NON-async exported arrow is NOT VERIFIED, not waved through — round 7, finding 1', () => {
  // WITHDRAWN CLAIM. This test used to assert `[]`, on the reasoning that Next's
  // action protocol publishes async functions only, so a sync export is not an
  // endpoint. That is a claim about the compiler, made by a scanner that cannot
  // run it — and round 6 established the compiler does NOT always reject one
  // (app/actions/categories.ts re-exports a sync helper and `next build`
  // compiles). "The build would have caught it" was doing the work here, and it
  // does not hold, so the export is reported as not verified.
  assert.deepEqual(scan(`export const notAnEndpoint = () => db.x.findMany()`), [`${F}:notAnEndpoint`])
})

test('an exported CONST that is not a function at all is reported, not dropped', () => {
  // A `'use server'` module may only export async functions. A const that is not
  // one is either a build error this scanner cannot check, or a published name
  // no rule here can judge — and both are things to be told about, rather than
  // the silence the shape-list collector produced.
  assert.deepEqual(scan(`export const LIMIT = 50`), [`${F}:LIMIT`])
})

test('an exported class, enum and namespace are each reported', () => {
  assert.deepEqual(scan(`export class Thing { async go() { return db.x.findMany() } }`), [`${F}:Thing`])
  assert.deepEqual(scan(`export enum Mode { A }`), [`${F}:Mode`])
})

test('a WRAPPED action is reported — the collector saw an initializer it could not read', () => {
  // `export const save = withAudit(async () => …)` publishes `save`. The
  // collector cannot tell what `withAudit` returns, so it cannot claim the guard
  // walk looked at the right body — and round 6's lesson is that the silent
  // answer is the dangerous one.
  assert.deepEqual(
    scan(`import { withAudit } from '@/lib/wrap'
    export const save = withAudit(async () => db.thing.deleteMany({ where: {} }))`, {}, {
      'lib/wrap.ts': 'export function withAudit<T>(f: T) { return f }',
    }),
    [`${F}:save`],
  )
})

test('a DESTRUCTURED export publishes every bound name, and every one is reported', () => {
  assert.deepEqual(
    scan(`import { actions } from '@/lib/actions'
    export const { save, remove } = actions`, {}, {
      'lib/actions.ts': 'export const actions = { save: async () => {}, remove: async () => {} }',
    }),
    [`${F}:save`, `${F}:remove`],
  )
})

// ---------------------------------------------------------------------------
// `export default` — round 7, Codex finding 2
// ---------------------------------------------------------------------------

test('an UNGUARDED default export is flagged — `default` is an export NAME', () => {
  // WITHDRAWN CLAIM, four rounds old: "a default export is not a callable Server
  // Action name in Next.js's action protocol". It was asserted and never
  // established. `import action from './actions'` is how a form action is
  // usually written; the module's default export is registered and addressable
  // exactly as a named one is, and skipping it hid a whole publishing form from
  // every rule in the file.
  assert.deepEqual(
    scan(`export default async function wipe(id: string) { return db.thing.deleteMany({ where: { id } }) }`),
    [`${F}:default`],
  )
})

test('a GUARDED default export is not flagged', () => {
  assert.deepEqual(
    scan(`export default async function wipe(id: string) {
      await requirePermission('sales.delete')
      return db.thing.deleteMany({ where: { id } })
    }`),
    [],
  )
})

test('an anonymous default-exported arrow is an endpoint too', () => {
  assert.deepEqual(
    scan(`export default async () => db.thing.findMany()`),
    [`${F}:default`],
  )
  assert.deepEqual(
    scan(`export default async () => { await requireInternalUser(); return db.thing.findMany() }`),
    [],
  )
})

test('`export default someLocal` resolves to the local and is judged there', () => {
  assert.deepEqual(
    scan(`async function wipe() { return db.thing.deleteMany({ where: {} }) }
    export default wipe`),
    [`${F}:default`],
  )
  assert.deepEqual(
    scan(`async function wipe() { await requirePermission('sales.delete'); return db.thing.deleteMany({ where: {} }) }
    export default wipe`),
    [],
  )
})

test('a SYNC default export is reported, not silently dropped', () => {
  assert.deepEqual(scan(`export default function label() { return 'x' }`), [`${F}:default`])
})

test('the SECRET-READ rule and the AUTH-ONLY inventory both see a default export', () => {
  assert.deepEqual(
    scanSecrets(`export default async function () {
      await requireAuth()
      return getSettingValue('smtp_password')
    }`),
    [`${F}:default`],
  )
  assert.deepEqual(
    scanAuthOnly(`export default async function () {
      await requireAuth()
      return db.thing.findMany()
    }`),
    [`${F}:default`],
  )
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

test('a PINNED guard that records its own refusal does not disqualify the guards after it', () => {
  // A denial that writes an activity row is still a denial. If the write question
  // were asked first, this endpoint would lose the AUTHORIZATION check that comes
  // after it and be reported as reading a secret behind authentication alone — a
  // violation manufactured by the checker.
  //
  // ROUND 6: the exemption is for the PINNED guard itself, so the fixture puts
  // the write where the claim is — inside lib/auth/server.ts:requireAuth, a
  // declaration on BASE_GUARD_DECLARATIONS. Round 5 wrote this case with a
  // wrapper instead, and that is what made the exemption wide enough to launder
  // through (the test below).
  const LOGGING_AUTH_SERVER = {
    'lib/auth/server.ts':
      "export async function requireAuth() { await db.activityLog.create({ data: { action: 'denied' } }) }\n"
      + 'export async function getSession() {}\n'
      + 'export async function requireFreshAuth() {}\n'
      + 'export async function requireRole(...roles: string[]) { void roles }\n'
      + 'export async function requirePermission(p: string) { void p }\n'
      + 'export async function requireInternalUser() {}\n',
  }
  assert.deepEqual(
    scanSecrets(`export async function a() {
      await requireAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, LOGGING_AUTH_SERVER),
    [],
  )
})

test('a WRAPPER around a writing pinned guard does not inherit its write', () => {
  // The other half of the narrowed exemption, and it has to exist or the rule is
  // inconsistent one call deep: if a pinned guard's denial log counted as a write
  // when reached THROUGH a wrapper, every guard wrapper in the tree would start
  // disqualifying the checks after it the day a guard began recording refusals.
  const LOGGING_AUTH_SERVER = {
    'lib/auth/server.ts':
      "export async function requireAuth() { await db.activityLog.create({ data: { action: 'denied' } }) }\n"
      + 'export async function getSession() {}\n'
      + 'export async function requireFreshAuth() {}\n'
      + 'export async function requireRole(...roles: string[]) { void roles }\n'
      + 'export async function requirePermission(p: string) { void p }\n'
      + 'export async function requireInternalUser() {}\n',
    'lib/wrap.ts':
      "import { requireAuth } from '@/lib/auth/server'\n"
      + 'export async function wrapAuth() { await requireAuth() }\n',
  }
  assert.deepEqual(
    scanSecrets(`import { wrapAuth } from '@/lib/wrap'
    export async function a() {
      await wrapAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, LOGGING_AUTH_SERVER),
    [],
  )
  // …and the wrapper's OWN write is still a write.
  assert.deepEqual(
    scanSecrets(`import { wrapAndWrite } from '@/lib/wrap2'
    export async function a() {
      await wrapAndWrite()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, {
      ...LOGGING_AUTH_SERVER,
      'lib/wrap2.ts':
        "import { requireAuth } from '@/lib/auth/server'\n"
        + "export async function wrapAndWrite() { await requireAuth(); await db.thing.deleteMany({ where: {} }) }\n",
    }),
    [`${F}:a`],
  )
})

test('a GUARDED HELPER that writes still launders the write past a later guard — round 6, finding 3', () => {
  // The hole round 5 left: `entry.kinds.size > 0` exempted ANY callee that
  // reaches a guard, so a helper that authenticates and then writes carried the
  // write past the authorization check that follows it. The row is changed under
  // authentication alone and the endpoint is credited with both kinds.
  const AUTH_AND_WIPE = {
    'lib/authwipe.ts':
      "import { requireAuth } from '@/lib/auth/server'\n"
      + 'export async function authAndWipe(id: string) {\n'
      + '  await requireAuth()\n'
      + '  await db.thing.deleteMany({ where: { id } })\n'
      + '}\n',
  }
  assert.deepEqual(
    scan(`import { authAndWipe } from '@/lib/authwipe'
    export async function a(id: string) {
      await authAndWipe(id)
      await requirePermission('sales.delete')
      return { ok: true }
    }`, {}, AUTH_AND_WIPE),
    [],
    'the helper is itself a resolved authentication gate at its own call site, so the endpoint '
    + 'is not UNGUARDED',
  )
  // …but the authorization check after the write earns nothing, which is what
  // the secret-read rule (authorization or nothing) makes visible.
  assert.deepEqual(
    scanSecrets(`import { authAndWipe } from '@/lib/authwipe'
    export async function a(id: string) {
      await authAndWipe(id)
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, AUTH_AND_WIPE),
    [`${F}:a`],
  )
})

test('a write is still a write when the helper performing it is NOT a guard', () => {
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

// ---------------------------------------------------------------------------
// o3d-512h round 6 — the checker must SEE the endpoint, and must not credit a
// name it merely failed to find bound
// ---------------------------------------------------------------------------

test('a sentinel built from a DESTRUCTURED module-scope Symbol earns nothing — round 6, finding 1', () => {
  // Round 5 verified the global as a global by asking `bindsAtModuleScope`,
  // because an unfollowable import resolves to null exactly as an untouched
  // global does. It asked two maps that only index identifier declarations, so a
  // destructured binding took the name without appearing in either — and the
  // value the sentinel then holds is a string a client can send.
  const fake = {
    'lib/destructsym.ts':
      'const { Symbol } = { Symbol: (s: string) => s }\n'
      + "export const FAKE_BYPASS = Symbol('internal-bypass')\n",
  }
  assert.deepEqual(
    scan(`import { FAKE_BYPASS } from '@/lib/destructsym'
    export async function a(options?: { t?: unknown }) {
      if (options?.t !== FAKE_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, fake),
    [`${F}:a`],
  )
})

test('an ARRAY-destructured Symbol earns nothing either', () => {
  const fake = {
    'lib/arrsym.ts':
      'const [Symbol] = [(s: string) => s]\n'
      + "export const FAKE_BYPASS = Symbol('internal-bypass')\n",
  }
  assert.deepEqual(
    scan(`import { FAKE_BYPASS } from '@/lib/arrsym'
    export async function a(options?: { t?: unknown }) {
      if (options?.t !== FAKE_BYPASS) { await requirePermission('sync') }
      return db.thing.findMany()
    }`, {}, fake),
    [`${F}:a`],
  )
})

// --- the endpoint no scanner could see (finding 2) --------------------------

test('an UNGUARDED `export { … }` endpoint is flagged — round 6, finding 2', () => {
  // No export modifier anywhere, so every rule in this file walked past it while
  // Next published it as an HTTP endpoint.
  assert.deepEqual(
    scan(`async function wipeEverything(id: string) {
      return db.thing.deleteMany({ where: { id } })
    }
    export { wipeEverything }`),
    [`${F}:wipeEverything`],
  )
})

test('a RENAMED named export is flagged under the name it is PUBLISHED as', () => {
  // `export { a as b }` publishes `b`; an allowlist or an inventory keyed on `a`
  // would name something the wire cannot call.
  assert.deepEqual(
    scan(`async function wipeEverything(id: string) {
      return db.thing.deleteMany({ where: { id } })
    }
    export { wipeEverything as wipe }`),
    [`${F}:wipe`],
  )
})

test('a GUARDED named export is not flagged', () => {
  assert.deepEqual(
    scan(`async function wipeEverything(id: string) {
      await requirePermission('sales.delete')
      return db.thing.deleteMany({ where: { id } })
    }
    export { wipeEverything }`),
    [],
  )
})

test('a named export of an UNGUARDED arrow is flagged too', () => {
  assert.deepEqual(
    scan(`const readAll = async () => db.thing.findMany()
    export { readAll }`),
    [`${F}:readAll`],
  )
})

test('a named RE-EXPORT is judged in the module that DECLARES it', () => {
  // The body's identifiers resolve in its own module, not in the one that
  // republishes it — so the guard must be looked for there.
  const UNGUARDED = { 'lib/handlers.ts': 'export async function handler(id: string) { return db.thing.deleteMany({ where: { id } }) }' }
  assert.deepEqual(
    scan("export { handler } from '@/lib/handlers'", {}, UNGUARDED),
    [`${F}:handler`],
  )

  const GUARDED = {
    'lib/handlers.ts':
      "import { requirePermission } from '@/lib/auth/server'\n"
      + "export async function handler(id: string) {\n"
      + "  await requirePermission('sales.delete')\n"
      + '  return db.thing.deleteMany({ where: { id } })\n'
      + '}\n',
  }
  assert.deepEqual(scan("export { handler } from '@/lib/handlers'", {}, GUARDED), [])
})

test('a re-export the graph CANNOT follow is flagged — not verified is not guarded', () => {
  assert.deepEqual(
    scan("export { handler } from 'some-package'"),
    [`${F}:handler`],
  )
})

test('`export * from` is FOLLOWED, and each published endpoint judged — round 7, finding 5', () => {
  // Round 6 reported `file:*` and offered a `file:*` allowlist entry as the cure,
  // which exempts every export of the module for ever on a reason written before
  // any of them existed. The graph can enumerate the target instead, so there is
  // nothing left to exempt: the star's endpoints are reported BY NAME.
  assert.deepEqual(
    scan("export * from '@/lib/handlers'", {}, {
      'lib/handlers.ts': 'export async function handler() { return db.thing.findMany() }',
    }),
    [`${F}:handler`],
  )
  // …and a guarded one earns its silence the ordinary way.
  assert.deepEqual(
    scan("export * from '@/lib/handlers'", {}, {
      'lib/handlers.ts':
        "import { requirePermission } from '@/lib/auth/server'\n"
        + "export async function handler() { await requirePermission('sync'); return db.thing.findMany() }",
    }),
    [],
  )
})

test('a star re-export chain is followed all the way through', () => {
  assert.deepEqual(
    scan("export * from '@/lib/mid'", {}, {
      'lib/mid.ts': "export * from '@/lib/deep'",
      'lib/deep.ts': 'export async function deepHandler() { return db.thing.findMany() }',
    }),
    [`${F}:deepHandler`],
  )
})

test('a star into a module the graph CANNOT enumerate is flagged AND is not allowlistable', () => {
  // The only case left, and the one with no name to write an entry against. It
  // must not be clearable by a wildcard, or the documented cure for "nobody has
  // enumerated what this publishes" is "exempt everything it publishes".
  const body = "export * from 'some-uncovered-package'"
  assert.deepEqual(scan(body), [`${F}:*`])
  assert.deepEqual(
    scan(body, { [`${F}:*`]: 'reviewed, honest' }),
    [`${F}:*`],
    'a module wildcard must NOT suppress an unenumerable star re-export',
  )
  assert.deepEqual(
    scan(body, { [`${F}:*from`]: 'named the specifier instead' }),
    [`${F}:*`],
    'nor does any other spelling — there is no allowlist form for this one',
  )
})

test('a SYNC named export is NOT VERIFIED — round 7, finding 1', () => {
  // WITHDRAWN CLAIM. Round 6 asserted "Next's action protocol publishes async
  // functions", so a sync export is not an endpoint, and then noted in the same
  // breath that `next build` accepts app/actions/categories.ts's sync re-export.
  // Those two statements cannot both stand: if the compiler accepts it, "it is
  // not published" is a guess about the protocol, made where being wrong costs an
  // ungated endpoint. It is reported, and the live one is allowlisted BY NAME
  // with what is and is not verified about it stated there.
  assert.deepEqual(
    scan(`function joinPath(parts: string[]) { return parts.join(' > ') }
    export { joinPath }`),
    [`${F}:joinPath`],
  )
  assert.deepEqual(
    scan("export { joinPath } from '@/lib/pure'", {}, {
      'lib/pure.ts': "export function joinPath(parts: string[]) { return parts.join(' > ') }",
    }),
    [`${F}:joinPath`],
  )
})

test('a named export that is NOT callable at all is reported too', () => {
  assert.deepEqual(
    scan(`const LIMIT = 50
    export { LIMIT }`),
    [`${F}:LIMIT`],
  )
})

test('an unverified export is cleared only by NAME, never by a module wildcard', () => {
  // The other half of "no wildcard-shaped hatch". A `file:*` entry is a claim
  // about exports somebody looked at; an unverified export is by definition one
  // nobody could. It takes its own line.
  const body = `const LIMIT = 50
  export { LIMIT }`
  assert.deepEqual(scan(body, { [`${F}:*`]: 'blanket' }), [`${F}:LIMIT`])
  assert.deepEqual(scan(body, { [`${F}:LIMIT`]: 'a pure constant, reviewed' }), [])
})

test('a module wildcard still clears an ordinary UNGUARDED export', () => {
  // The narrowing is about exports the scanner could not read, not about the
  // ones it read and found unguarded — those keep the exemption they always had.
  assert.deepEqual(
    scan(`export async function go() { return db.thing.findMany() }`, { [`${F}:*`]: 'reviewed' }),
    [],
  )
})

test('a type-only export is not an endpoint', () => {
  assert.deepEqual(
    scan(`type Thing = { id: string }
    export type { Thing }`),
    [],
  )
  assert.deepEqual(
    scan(`type Thing = { id: string }
    async function go() { return db.thing.findMany() }
    export { type Thing, go }`),
    [`${F}:go`],
  )
})

test('a named export is NOT flagged when the allowlist names it', () => {
  assert.deepEqual(
    scan(`async function wipe(id: string) { return db.thing.deleteMany({ where: { id } }) }
    export { wipe }`, { [`${F}:wipe`]: 'reviewed' }),
    [],
  )
})

test('the SECRET-READ rule sees a named export too', () => {
  assert.deepEqual(
    scanSecrets(`async function readIt() {
      await requireAuth()
      return getSettingValue('smtp_password')
    }
    export { readIt }`),
    [`${F}:readIt`],
  )
})

test('the AUTHENTICATION-ONLY inventory sees a named export too', () => {
  assert.deepEqual(
    scanAuthOnly(`async function mine() {
      await requireAuth()
      return db.thing.findMany()
    }
    export { mine }`),
    [`${F}:mine`],
  )
})

test('a named export of a non-exported local does not double-report', () => {
  // The local is unguarded and NOT exported by modifier; it becomes an endpoint
  // exactly once, under its published name.
  assert.deepEqual(
    scan(`async function go() { return db.thing.findMany() }
    export { go }`),
    [`${F}:go`],
  )
})

// ---------------------------------------------------------------------------
// o3d-512h round 7 — THE MODULE THE SCANNERS NEVER OPENED, AND THE ENDPOINT
// THAT IS NOT AN EXPORT AT ALL (Codex finding 1)
// ---------------------------------------------------------------------------

/** A `'use server'` fixture whose directive is written some other legal way. */
function scanRaw(source: string, extra: Record<string, string> = {}): string[] {
  const graph = createSourceGraph({
    'lib/auth/server.ts': AUTH_SERVER,
    'lib/settings-store.ts': SETTINGS_STORE,
    [F]: source,
    ...extra,
  })
  return scanSource(F, source, {}, graph)
}

test('a directive behind a COMMENT still makes the module a server module', () => {
  // `isUseServer` required the directive at character zero. A directive prologue
  // does not have to be there — comments precede it — so this whole module was
  // skipped at the door by every rule in the file, unread rather than misjudged.
  assert.deepEqual(
    scanRaw(`// eslint-disable-next-line something\n'use server'\nexport async function wipe() { return db.thing.deleteMany({ where: {} }) }\n`),
    [`${F}:wipe`],
  )
})

test('a directive behind a LICENCE BLOCK comment counts too', () => {
  assert.deepEqual(
    scanRaw(`/* Copyright 2026 */\n"use server"\nexport async function wipe() { return db.thing.deleteMany({ where: {} }) }\n`),
    [`${F}:wipe`],
  )
})

test("a directive after 'use strict' counts — a prologue may hold several", () => {
  assert.deepEqual(
    scanRaw(`'use strict'\n'use server'\nexport async function wipe() { return db.thing.deleteMany({ where: {} }) }\n`),
    [`${F}:wipe`],
  )
})

test('a `use server` string that is NOT in the prologue does not make a server module', () => {
  // The rule has to stay narrow in this direction too, or every module mentioning
  // the directive in prose becomes a set of endpoints.
  assert.deepEqual(
    scanRaw(`export async function wipe() { const note = 'use server'; void note; return db.thing.deleteMany({ where: {} }) }\n`),
    [],
  )
  assert.deepEqual(
    scanRaw(`// This file is NOT 'use server'.\nexport async function wipe() { return db.thing.deleteMany({ where: {} }) }\n`),
    [],
  )
})

test('an INLINE `use server` function is an endpoint — round 7, finding 1', () => {
  // Not an export, in a file with no module directive: outside every scanner's
  // input until now. Next registers it as a server reference, its id ships to the
  // browser, and its parameters come off the wire.
  const source = `export default function Page({ id }: { id: string }) {
  async function save(form: FormData) {
    'use server'
    await db.thing.update({ where: { id }, data: { name: String(form.get('n')) } })
  }
  return save
}
`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, 'app/page.tsx': source })
  assert.deepEqual(scanInlineServerActions('app/page.tsx', source, {}, graph), ['app/page.tsx:save@2'])
})

test('a GUARDED inline action is not flagged — the same guard rule, unchanged', () => {
  const source = `import { requirePermission } from '@/lib/auth/server'
export default function Page({ id }: { id: string }) {
  async function save() {
    'use server'
    await requirePermission('sales.edit')
    await db.thing.update({ where: { id }, data: {} })
  }
  return save
}
`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, 'app/page.tsx': source })
  assert.deepEqual(scanInlineServerActions('app/page.tsx', source, {}, graph), [])
})

test('an inline action whose guard runs AFTER the write is flagged — ordering still applies', () => {
  const source = `import { requirePermission } from '@/lib/auth/server'
export default function Page() {
  const save = async () => {
    'use server'
    await db.thing.deleteMany({ where: {} })
    await requirePermission('sales.delete')
  }
  return save
}
`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, 'app/page.tsx': source })
  assert.deepEqual(scanInlineServerActions('app/page.tsx', source, {}, graph), ['app/page.tsx:save@3'])
})

test('an inline action is found in a `use server` module too, and in a nested arrow', () => {
  const source = `'use server'
export async function outer() {
  await Promise.resolve()
  return async () => {
    'use server'
    return db.thing.findMany()
  }
}
`
  const graph = createSourceGraph({ 'lib/auth/server.ts': AUTH_SERVER, [F]: source })
  assert.deepEqual(scanInlineServerActions(F, source, {}, graph), [`${F}:<anonymous>@4`])
})

test('a function whose body merely MENTIONS the directive is not an inline action', () => {
  const source = `export function helper() {
  const doc = 'use server'
  return doc
}
`
  const graph = createSourceGraph({ 'app/page.tsx': source })
  assert.deepEqual(scanInlineServerActions('app/page.tsx', source, {}, graph), [])
})

// ---------------------------------------------------------------------------
// o3d-512h round 7, Codex finding 3 — A PINNED GUARD THAT WRITES BUSINESS DATA
// ---------------------------------------------------------------------------

/** lib/auth/server.ts with `requireAuth` doing something beyond refusing. */
function authServerWhere(requireAuthBody: string): Record<string, string> {
  return {
    'lib/auth/server.ts':
      `export async function requireAuth() { ${requireAuthBody} }\n`
      + 'export async function getSession() {}\n'
      + 'export async function requireFreshAuth() {}\n'
      + 'export async function requireRole(...roles: string[]) { void roles }\n'
      + 'export async function requirePermission(p: string) { void p }\n'
      + 'export async function requireInternalUser() {}\n',
  }
}

test('a pinned guard that WRITES BUSINESS DATA no longer launders it — round 7, finding 3', () => {
  // Round 6 narrowed the exemption from "any callee reaching a guard" to "a
  // PINNED guard declaration" and then exempted everything that declaration
  // writes. Being on the guard list is an argument about what a function
  // ESTABLISHES, not about what it changes: a guard that deletes rows still
  // carries the deletion past every check after it.
  assert.deepEqual(
    scanSecrets(`export async function a() {
      await requireAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, authServerWhere("await db.salesOrder.deleteMany({ where: { draft: true } })")),
    [`${F}:a`],
    'the deleteMany happened under authentication alone; the authorization check after it earns nothing',
  )
})

test('a pinned guard writing an AUDITED control model is still exempt — round 6 stays', () => {
  assert.deepEqual(
    scanSecrets(`export async function a() {
      await requireAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, authServerWhere("await db.activityLog.create({ data: { action: 'denied' } })")),
    [],
    'a denial that records itself is still a denial',
  )
})

test('a WRAPPER around a guard that writes business data inherits the write', () => {
  // The exemption has to be about the models one call deep too, or the rule is
  // defeated by moving the call into a wrapper — the shape check round 3
  // abolished, reintroduced through the exemption.
  assert.deepEqual(
    scanSecrets(`import { wrapAuth } from '@/lib/wrap'
    export async function a() {
      await wrapAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, {
      ...authServerWhere("await db.salesOrder.deleteMany({ where: { draft: true } })"),
      'lib/wrap.ts': "import { requireAuth } from '@/lib/auth/server'\nexport async function wrapAuth() { await requireAuth() }\n",
    }),
    [`${F}:a`],
  )
  // …and the audited write still does not travel through the wrapper.
  assert.deepEqual(
    scanSecrets(`import { wrapAuth } from '@/lib/wrap'
    export async function a() {
      await wrapAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, {
      ...authServerWhere("await db.activityLog.create({ data: { action: 'denied' } })"),
      'lib/wrap.ts': "import { requireAuth } from '@/lib/auth/server'\nexport async function wrapAuth() { await requireAuth() }\n",
    }),
    [],
  )
})

test('a guard whose write is laundered through a HELPER of its own is not exempt either', () => {
  assert.deepEqual(
    scanSecrets(`export async function a() {
      await requireAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, {
      ...authServerWhere("await wipe()"),
      'lib/auth/server.ts':
        "import { wipe } from '@/lib/wipe'\n"
        + 'export async function requireAuth() { await wipe() }\n'
        + 'export async function getSession() {}\n'
        + 'export async function requireFreshAuth() {}\n'
        + 'export async function requireRole(...roles: string[]) { void roles }\n'
        + 'export async function requirePermission(p: string) { void p }\n'
        + 'export async function requireInternalUser() {}\n',
      'lib/wipe.ts': 'export async function wipe() { await db.salesOrder.deleteMany({ where: {} }) }',
    }),
    [`${F}:a`],
  )
})

test('a raw write in a pinned guard is never audited — $executeRaw names no model', () => {
  assert.deepEqual(
    scanSecrets(`export async function a() {
      await requireAuth()
      await requirePermission('settings.read')
      return getSettingValue('smtp_password')
    }`, authServerWhere('await db.$executeRawUnsafe("delete from thing")')),
    [`${F}:a`],
  )
})

test('the guard itself still keeps its OWN credit — its write is at its own call site', () => {
  // A business-writing guard is not disarmed, it just stops covering what comes
  // after it. The coverage rule must still see the endpoint as guarded, or the
  // narrowing would manufacture "unguarded" out of an endpoint that has a gate.
  assert.deepEqual(
    scan(`export async function a() {
      await requireAuth()
      await requirePermission('settings.read')
      return db.thing.findMany()
    }`, {}, authServerWhere("await db.salesOrder.deleteMany({ where: { draft: true } })")),
    [],
  )
})

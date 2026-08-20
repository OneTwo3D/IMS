import assert from 'node:assert/strict'
import test from 'node:test'

import {
  scanAuthenticationOnlyActions,
  scanSecretReadingActions,
  scanSource,
} from './server-action-guard-scan'

/**
 * o3d-hic9 — tests for the DETECTOR itself, not for the app tree.
 *
 * o3d-1fel survived because the detector's `isDelegatingFacade` heuristic was
 * never exercised against anything but the live code, where a false negative is
 * invisible by construction: the test simply passes. These fixtures pin both
 * directions — what must be flagged, and what must not be.
 */

const F = 'fixture.ts'
const useServer = (body: string) => `'use server'\n\n${body}\n`

// ---------------------------------------------------------------------------
// The o3d-1fel defect itself
// ---------------------------------------------------------------------------

test('flags a one-statement `return db.<model>.findMany()` — a Prisma call is not a delegate', () => {
  // This is verbatim the shape of xero-sync.ts:getAccountingAccounts.
  const src = useServer(`
export async function getAccountingAccounts() {
  return db.accountingAccount.findMany({ where: { connector: 'xero' } })
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:getAccountingAccounts`])
})

test('flags a one-statement `return prisma.<model>.create()` too', () => {
  const src = useServer(`
export async function writeIt() {
  return prisma.setting.create({ data: {} })
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:writeIt`])
})

test('flags an awaited Prisma one-liner', () => {
  const src = useServer(`
export async function readIt() {
  return await db.user.findMany()
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:readIt`])
})

// ---------------------------------------------------------------------------
// Prose must neither satisfy nor trip the detector
// ---------------------------------------------------------------------------

test('a guard named only in a doc comment does NOT satisfy the detector', () => {
  // The failure mode this repo has hit before is a guard that matches words in
  // comments. Here the risk runs the other way: prose must not be accepted AS
  // the guard. `requirePermission` appears only as trivia, so the export is
  // still unguarded and must be flagged.
  const src = useServer(`
/**
 * Callers must hold requirePermission('sync') before invoking this.
 * See requireAuth and requireFreshAdmin for the surrounding policy.
 */
export async function looksGuardedInProseOnly() {
  const rows = await db.setting.findMany()
  return rows
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:looksGuardedInProseOnly`])
})

test('a guard named only in a string literal does NOT satisfy the detector', () => {
  const src = useServer(`
export async function stringOnly() {
  const note = 'requireAuth is applied by the caller'
  const rows = await db.setting.findMany()
  return { note, rows }
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:stringOnly`])
})

test('a genuinely guarded export mentioning nothing in prose is NOT flagged', () => {
  const src = useServer(`
export async function guarded() {
  await requirePermission('sync')
  return db.accountingAccount.findMany()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('prose in a NON-server module does not produce a violation', () => {
  // No 'use server' prologue: nothing here is an RPC endpoint, and the words
  // "use server" appearing in a comment must not make it one.
  const src = `
// This helper is only ever called from a 'use server' module.
export async function notAnEndpoint() {
  return db.setting.findMany()
}
`
  assert.deepEqual(scanSource(F, src), [])
})

// ---------------------------------------------------------------------------
// The facade escape hatch still works for real facades
// ---------------------------------------------------------------------------

test('a real delegating facade is not flagged', () => {
  const src = useServer(`
export async function getShoppingSyncSettings() {
  return getWcSyncSettings()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('a facade delegating through a connector object is not flagged', () => {
  const src = useServer(`
export async function getAccounts() {
  return connector.getAccounts()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('a multi-statement dispatcher is flagged unless allowlisted', () => {
  const src = useServer(`
export async function dispatch() {
  const connector = await getActiveConnector()
  return connector.getAccounts()
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:dispatch`])
  assert.deepEqual(
    scanSource(F, src, { [`${F}:dispatch`]: 'dispatcher → guarded delegate' }),
    [],
  )
})

// ---------------------------------------------------------------------------
// Allowlist mechanics
// ---------------------------------------------------------------------------

test('a module wildcard suppresses every export in that file', () => {
  const src = useServer(`
export async function a() { return db.x.findMany() }
export async function b() { return db.y.findMany() }`)
  assert.deepEqual(scanSource(F, src), [`${F}:a`, `${F}:b`])
  assert.deepEqual(scanSource(F, src, { [`${F}:*`]: 'reason' }), [])
})

test('a non-exported unguarded function is not flagged', () => {
  const src = useServer(`
async function helper() { return db.x.findMany() }
export async function guarded() {
  await requireAuth()
  return helper()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

// ---------------------------------------------------------------------------
// Exported async ARROWS are endpoints too (o3d-512h)
//
// The detector matched FunctionDeclaration only. The branch report logged that
// as a known limitation with "there are none today" — but the guard exists to
// catch what the next sweep misses, and `export const x = async () => {}` is the
// obvious way to add one. "None today" is a fact about the tree, never about the
// detector.
// ---------------------------------------------------------------------------

test('flags an unguarded exported async ARROW', () => {
  const src = useServer(`
export const getAccountingAccounts = async () => {
  return db.accountingAccount.findMany()
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:getAccountingAccounts`])
})

test('flags an unguarded exported async FUNCTION EXPRESSION', () => {
  const src = useServer(`
export const readIt = async function () {
  const rows = await db.setting.findMany()
  return rows
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:readIt`])
})

test('flags an unguarded CONCISE-bodied async arrow doing its own Prisma read', () => {
  // No ReturnStatement exists here at all — the body IS the call. Treating a
  // concise body as "not a single return" would have classified this as
  // not-a-facade AND not-a-guard, or worse, silently skipped it.
  const src = useServer(`
export const readIt = async () => db.setting.findMany()`)
  assert.deepEqual(scanSource(F, src), [`${F}:readIt`])
})

test('a GUARDED exported async arrow is not flagged', () => {
  const src = useServer(`
export const getAccounts = async () => {
  await requirePermission('sync')
  return db.accountingAccount.findMany()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('a concise body that NAMES a guard without calling it is still flagged', () => {
  // `async () => requireAuth` returns the guard; it does not run it. A traversal
  // that starts at the body node itself would see the identifier and call this
  // guarded — a false negative in the one rule whose whole job is to have none.
  const src = useServer(`
export const looksGuarded = async () => requireAuth`)
  assert.deepEqual(scanSource(F, src), [`${F}:looksGuarded`])
})

test('a guarded CONCISE-bodied async arrow is not flagged', () => {
  const src = useServer(`
export const ping = async () => requirePermission('sync')`)
  assert.deepEqual(scanSource(F, src), [])
})

test('a concise-bodied arrow delegating to another action is treated as a facade', () => {
  const src = useServer(`
export const getSettings = async () => getWcSyncSettings()`)
  assert.deepEqual(scanSource(F, src), [])
})

test('every declarator in one exported statement is its own endpoint', () => {
  const src = useServer(`
export const a = async () => db.x.findMany(), b = async () => db.y.findMany()`)
  assert.deepEqual(scanSource(F, src), [`${F}:a`, `${F}:b`])
})

test('a NON-async exported arrow is not treated as a server action', () => {
  // 'use server' requires async exports — a sync one is a build error, not an
  // endpoint, and flagging it would be noise the allowlist would absorb.
  const src = useServer(`
export const notAnEndpoint = () => db.x.findMany()`)
  assert.deepEqual(scanSource(F, src), [])
})

test('a non-exported async arrow is not flagged', () => {
  const src = useServer(`
const helper = async () => db.x.findMany()
export async function guarded() {
  await requireAuth()
  return helper()
}`)
  assert.deepEqual(scanSource(F, src), [])
})

test('an allowlist entry suppresses an arrow endpoint by name', () => {
  const src = useServer(`
export const dispatch = async () => {
  const connector = await getActiveConnector()
  return connector.getAccounts()
}`)
  assert.deepEqual(scanSource(F, src), [`${F}:dispatch`])
  assert.deepEqual(scanSource(F, src, { [`${F}:dispatch`]: 'reason' }), [])
})

// ---------------------------------------------------------------------------
// requireAuth is not an answer to an authorization question (o3d-512h)
// ---------------------------------------------------------------------------

test('flags a secret read behind requireAuth — the shape that hid getEmailSettings', () => {
  // Verbatim the shape of app/actions/company.ts:getEmailSettings before the fix:
  // a guard is present, so the coverage rule was silent, while getSettingValues
  // decrypts every SENSITIVE_SETTING_KEYS entry it is asked for.
  const src = useServer(`
export async function getEmailSettings() {
  await requireAuth()
  const map = await getSettingValues(['email_smtp_pass'])
  return { pass: map.get('email_smtp_pass') }
}`)
  assert.deepEqual(scanSecretReadingActions(F, src), [`${F}:getEmailSettings`])
  // The ORIGINAL rule stays silent on it — which is the whole point.
  assert.deepEqual(scanSource(F, src), [])
})

test('a secret read behind requirePermission is not flagged', () => {
  const src = useServer(`
export async function getEmailSettings() {
  await requirePermission('settings.company')
  const map = await getSettingValues(['email_smtp_pass'])
  return { pass: map.get('email_smtp_pass') }
}`)
  assert.deepEqual(scanSecretReadingActions(F, src), [])
})

test('a secret read behind requireRole is not flagged', () => {
  const src = useServer(`
export async function readSecret() {
  await requireRole('ADMIN', 'FINANCE')
  return getSettingValue('xero_client_secret')
}`)
  assert.deepEqual(scanSecretReadingActions(F, src), [])
})

test('the secret-read rule reaches exported async arrows too', () => {
  const src = useServer(`
export const leak = async () => {
  await requireAuth()
  return getSettingValue('wc_consumer_key')
}`)
  assert.deepEqual(scanSecretReadingActions(F, src), [`${F}:leak`])
})

test('an action reading db.setting directly under requireAuth is NOT flagged by the secret rule', () => {
  // Deliberately out of scope: numbering prefixes, branding colours and FX health
  // are read under requireAuth by design. A rule that flagged them would be
  // answered with an allowlist rather than a fix, and the allowlist is what let
  // the real defects hide in the first place.
  const src = useServer(`
export async function getBrandingColours() {
  await requireAuth()
  return db.setting.findMany({ where: { key: { startsWith: 'brand_' } } })
}`)
  assert.deepEqual(scanSecretReadingActions(F, src), [])
})

test('the secret-read rule ignores a non-server module', () => {
  const src = `
export async function notAnEndpoint() {
  await requireAuth()
  return getSettingValue('email_smtp_pass')
}
`
  assert.deepEqual(scanSecretReadingActions(F, src), [])
})

// ---------------------------------------------------------------------------
// The authentication-only INVENTORY rule (o3d-512h)
//
// This one is not a violation rule — it enumerates the endpoints whose only gate
// is authentication, so the coverage test can pin the set. It gets fixtures for
// the same reason the others do: an inventory that silently under-reports is a
// list of everything except the thing you needed to see.
// ---------------------------------------------------------------------------

test('inventories an export gated on requireAuth alone', () => {
  const src = useServer(`
export async function getOrganisation() {
  await requireAuth()
  return db.organisation.findFirst()
}`)
  assert.deepEqual(scanAuthenticationOnlyActions(F, src), [`${F}:getOrganisation`])
})

test('does NOT inventory an export holding a real authorization gate', () => {
  const src = useServer(`
export async function saveIt() {
  await requirePermission('settings.company')
  return db.setting.updateMany({ data: {} })
}`)
  assert.deepEqual(scanAuthenticationOnlyActions(F, src), [])
})

test('does NOT inventory an export that calls requireAuth AND an authorization gate', () => {
  // requireAuth is frequently called for the session object rather than as the
  // gate. Counting those would bury the endpoints that really are
  // authentication-only under a pile of false entries, and a noisy inventory is
  // one nobody reads.
  const src = useServer(`
export async function mixed() {
  const session = await requireAuth()
  await requirePermission('sync')
  return session.user.id
}`)
  assert.deepEqual(scanAuthenticationOnlyActions(F, src), [])
})

test('inventories getVerifiedSession as authentication-only too', () => {
  const src = useServer(`
export async function readIt() {
  await getVerifiedSession()
  return db.product.findMany()
}`)
  assert.deepEqual(scanAuthenticationOnlyActions(F, src), [`${F}:readIt`])
})

test('does NOT inventory an UNGUARDED export — that is the other rule\'s violation', () => {
  // An endpoint with no gate at all must show up as a scanSource violation, not
  // as a line in an inventory that reads as "reviewed and accepted".
  const src = useServer(`
export async function wideOpen() {
  return db.product.findMany()
}`)
  assert.deepEqual(scanAuthenticationOnlyActions(F, src), [])
  assert.deepEqual(scanSource(F, src), [`${F}:wideOpen`])
})

test('the inventory rule reaches exported async arrows, including concise bodies', () => {
  const src = useServer(`
export const blockArrow = async () => {
  await requireAuth()
  return db.product.findMany()
}
export const conciseArrow = async () => requireAuth()`)
  assert.deepEqual(
    scanAuthenticationOnlyActions(F, src).sort(),
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
  assert.deepEqual(scanAuthenticationOnlyActions(F, src), [])
})

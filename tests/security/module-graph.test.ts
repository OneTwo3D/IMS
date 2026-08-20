import assert from 'node:assert/strict'
import test from 'node:test'

import { createSourceGraph, declarationBody } from './module-graph'

/**
 * o3d-512h round 3 — tests for the RESOLVER, not for the app tree.
 *
 * Every security rule in this directory now asks the graph "what does this name
 * actually refer to". If the graph answers wrongly, every one of those rules goes
 * quiet at once — which is exactly the failure mode that let a shadowed
 * `requireAuth` in app/actions/allocation.ts pass three endpoints for months. So
 * the resolver gets fixtures for both directions: what must resolve, and what
 * must NOT.
 */

const AUTH = `
export async function requireAuth() {}
export async function requirePermission(p: string) { void p }
`

test('resolves a plain named import to its declaration', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/a.ts': `import { requirePermission } from '@/lib/auth/server'\nexport async function go() { await requirePermission('sync') }`,
  })
  assert.deepEqual(
    pick(g.resolve('app/actions/a.ts', 'requirePermission')),
    { file: 'lib/auth/server.ts', name: 'requirePermission' },
  )
})

test('resolves an ALIASED import to the original name — renaming does not hide it', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/a.ts': `import { requirePermission as ok } from '@/lib/auth/server'\nexport async function go() { await ok('sync') }`,
  })
  assert.deepEqual(
    pick(g.resolve('app/actions/a.ts', 'ok')),
    { file: 'lib/auth/server.ts', name: 'requirePermission' },
  )
})

test('resolves a NAMESPACE member', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/a.ts': `import * as guards from '@/lib/auth/server'\nexport async function go() { await guards.requireAuth() }`,
  })
  assert.deepEqual(
    pick(g.resolveMember('app/actions/a.ts', 'guards', 'requireAuth')),
    { file: 'lib/auth/server.ts', name: 'requireAuth' },
  )
  // …and not as a plain identifier, because `guards` is not the guard.
  assert.equal(g.resolve('app/actions/a.ts', 'guards'), null)
})

test('follows an `export … from` re-export chain to the real declaration', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'lib/auth/index.ts': `export { requirePermission } from '@/lib/auth/server'`,
    'app/actions/a.ts': `import { requirePermission } from '@/lib/auth'\nexport async function go() { await requirePermission('sync') }`,
  })
  assert.deepEqual(
    pick(g.resolve('app/actions/a.ts', 'requirePermission')),
    { file: 'lib/auth/server.ts', name: 'requirePermission' },
  )
})

test('follows `export *`', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'lib/auth/index.ts': `export * from '@/lib/auth/server'`,
    'app/actions/a.ts': `import { requireAuth } from '@/lib/auth'\nexport async function go() { await requireAuth() }`,
  })
  assert.deepEqual(
    pick(g.resolve('app/actions/a.ts', 'requireAuth')),
    { file: 'lib/auth/server.ts', name: 'requireAuth' },
  )
})

test('a LOCAL declaration shadows an import of the same name — the allocation.ts defect', () => {
  // Verbatim the shape found in app/actions/allocation.ts: an import of the real
  // guard, and a module-local function with the same name that checks far less.
  // A rule matching on the identifier text credits the import; the truth is that
  // every call in this file runs the local one.
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/allocation.ts': `
import { requireAuth } from '@/lib/auth/server'
async function requireAuth2() {}
async function requireAuth() { const s = await auth(); if (!s) throw new Error('Unauthorized') }
export async function getOrderAllocations() { await requireAuth(); return db.orderAllocation.findMany() }
`,
  })
  const resolved = g.resolve('app/actions/allocation.ts', 'requireAuth')
  assert.equal(resolved?.file, 'app/actions/allocation.ts', 'the LOCAL declaration must win')
  assert.notEqual(resolved?.file, 'lib/auth/server.ts')
  assert.ok(declarationBody(resolved), 'the local declaration must expose a body to inspect')
})

test('resolves a relative import, including a directory index', () => {
  const g = createSourceGraph({
    'lib/x/links.ts': `export async function getLink() {}`,
    'lib/x/index.ts': `export async function fromIndex() {}`,
    'lib/x/products.ts': `import { getLink } from './links'\nimport { fromIndex } from '.'\nexport async function go() { await getLink(); await fromIndex() }`,
  })
  assert.deepEqual(pick(g.resolve('lib/x/products.ts', 'getLink')), { file: 'lib/x/links.ts', name: 'getLink' })
  assert.deepEqual(pick(g.resolve('lib/x/products.ts', 'fromIndex')), { file: 'lib/x/index.ts', name: 'fromIndex' })
})

test('returns null for a package import and for an unknown name', () => {
  const g = createSourceGraph({
    'app/actions/a.ts': `import { z } from 'zod'\nexport async function go() { void z; void somethingGlobal }`,
  })
  assert.equal(g.resolve('app/actions/a.ts', 'z'), null)
  assert.equal(g.resolve('app/actions/a.ts', 'somethingGlobal'), null)
  assert.equal(g.resolve('app/actions/nope.ts', 'anything'), null)
})

test('resolves an exported const arrow, and hands back its body', () => {
  const g = createSourceGraph({
    'lib/h.ts': `export const helper = async () => { await requireAuth() }`,
    'app/actions/a.ts': `import { helper } from '@/lib/h'\nexport async function go() { await helper() }`,
  })
  const decl = g.resolve('app/actions/a.ts', 'helper')
  assert.deepEqual(pick(decl), { file: 'lib/h.ts', name: 'helper' })
  assert.ok(declarationBody(decl))
})

test('a non-exported declaration is not reachable from another module', () => {
  const g = createSourceGraph({
    'lib/h.ts': `async function privateHelper() {}\nexport async function other() {}`,
    'app/actions/a.ts': `import { privateHelper } from '@/lib/h'\nexport async function go() { await privateHelper() }`,
  })
  assert.equal(g.resolve('app/actions/a.ts', 'privateHelper'), null)
})

test('a re-export cycle terminates instead of hanging', () => {
  const g = createSourceGraph({
    'lib/a.ts': `export * from '@/lib/b'`,
    'lib/b.ts': `export * from '@/lib/a'`,
    'app/actions/x.ts': `import { nope } from '@/lib/a'\nexport async function go() { await nope() }`,
  })
  assert.equal(g.resolve('app/actions/x.ts', 'nope'), null)
})

// ---------------------------------------------------------------------------
// referrers(): the mechanism behind the raw-maskSecret pin
//
// Codex round 3, finding 5: the old pin matched ONE import shape — a named
// import whose imported name was literally `maskSecret`. Every other legal way
// to reach the same symbol walked past it.
// ---------------------------------------------------------------------------

const MASK = `export function maskSecret(v: string) { return v }\nexport function other() {}`

test('referrers finds a plain named import', () => {
  const g = createSourceGraph({
    'lib/security/secret-mask.ts': MASK,
    'app/actions/a.ts': `import { maskSecret } from '@/lib/security/secret-mask'\nexport const x = maskSecret('a')`,
  })
  assert.deepEqual(g.referrers('lib/security/secret-mask.ts', 'maskSecret'), ['app/actions/a.ts'])
})

test('referrers finds an ALIASED import — the shape the old pin missed', () => {
  const g = createSourceGraph({
    'lib/security/secret-mask.ts': MASK,
    'app/actions/a.ts': `import { maskSecret as hide } from '@/lib/security/secret-mask'\nexport const x = hide('a')`,
  })
  assert.deepEqual(g.referrers('lib/security/secret-mask.ts', 'maskSecret'), ['app/actions/a.ts'])
})

test('referrers finds a NAMESPACE import used as a member', () => {
  const g = createSourceGraph({
    'lib/security/secret-mask.ts': MASK,
    'app/actions/a.ts': `import * as mask from '@/lib/security/secret-mask'\nexport const x = mask.maskSecret('a')`,
  })
  assert.deepEqual(g.referrers('lib/security/secret-mask.ts', 'maskSecret'), ['app/actions/a.ts'])
})

test('referrers follows a RE-EXPORT, so laundering the symbol through a barrel does not hide it', () => {
  const g = createSourceGraph({
    'lib/security/secret-mask.ts': MASK,
    'lib/security/index.ts': `export { maskSecret } from './secret-mask'`,
    'app/actions/a.ts': `import { maskSecret } from '@/lib/security'\nexport const x = maskSecret('a')`,
  })
  assert.deepEqual(
    g.referrers('lib/security/secret-mask.ts', 'maskSecret'),
    ['app/actions/a.ts', 'lib/security/index.ts'],
  )
})

test('referrers does NOT report a file that imports a different symbol from the same module', () => {
  const g = createSourceGraph({
    'lib/security/secret-mask.ts': MASK,
    'app/actions/a.ts': `import { other } from '@/lib/security/secret-mask'\nexport const x = other()`,
  })
  assert.deepEqual(g.referrers('lib/security/secret-mask.ts', 'maskSecret'), [])
})

test('referrers does NOT report a namespace import that never touches the member', () => {
  const g = createSourceGraph({
    'lib/security/secret-mask.ts': MASK,
    'app/actions/a.ts': `import * as mask from '@/lib/security/secret-mask'\nexport const x = mask.other()`,
  })
  assert.deepEqual(g.referrers('lib/security/secret-mask.ts', 'maskSecret'), [])
})

test('referrers ignores a same-named symbol declared somewhere else', () => {
  const g = createSourceGraph({
    'lib/security/secret-mask.ts': MASK,
    'lib/other/mask.ts': `export function maskSecret(v: string) { return v }`,
    'app/actions/a.ts': `import { maskSecret } from '@/lib/other/mask'\nexport const x = maskSecret('a')`,
  })
  assert.deepEqual(g.referrers('lib/security/secret-mask.ts', 'maskSecret'), [])
})

function pick(decl: { file: string; name: string } | null): { file: string; name: string } | null {
  return decl ? { file: decl.file, name: decl.name } : null
}

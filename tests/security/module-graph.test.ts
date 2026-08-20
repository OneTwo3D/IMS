import assert from 'node:assert/strict'
import test from 'node:test'

import ts from 'typescript'

import { createSourceGraph, declarationBody, hasLexicalShadow } from './module-graph'

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

// ---------------------------------------------------------------------------
// o3d-512h round 5, finding 1 — a shadow one scope in
// ---------------------------------------------------------------------------

/** The identifier `name` at its first CALL site in `file`. */
function calleeAt(g: ReturnType<typeof createSourceGraph>, file: string, name: string): ts.Identifier {
  const sf = g.sourceFile(file)
  assert.ok(sf, `${file} is not in the graph`)
  let found: ts.Identifier | undefined
  const visit = (n: ts.Node) => {
    if (found) return
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      found = n.expression
      return
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  assert.ok(found, `no call to ${name} in ${file}`)
  return found
}

test('a FUNCTION-LOCAL shadow is not the imported primitive — round 4 pinned only the module-level one', () => {
  // `locals` records top-level declarations only, so without a position the graph
  // answers with the import: the exact "credited, not established" failure the
  // resolver exists to stop, sitting inside the resolver.
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/a.ts': `import { requirePermission } from '@/lib/auth/server'
export async function go() {
  const requirePermission = async (_p: string) => {}
  await requirePermission('sync')
}`,
  })
  // The module-scope answer is still the import — that is what it means.
  assert.equal(g.resolve('app/actions/a.ts', 'requirePermission')?.file, 'lib/auth/server.ts')
  // At the call site, it is not.
  assert.equal(g.resolve('app/actions/a.ts', 'requirePermission', calleeAt(g, 'app/actions/a.ts', 'requirePermission')), null)
})

test('a PARAMETER shadows, and so does a destructured one', () => {
  const plain = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/p.ts': `import { requireAuth } from '@/lib/auth/server'
export async function go(requireAuth: () => Promise<void>) { await requireAuth() }`,
  })
  assert.equal(plain.resolve('app/actions/p.ts', 'requireAuth', calleeAt(plain, 'app/actions/p.ts', 'requireAuth')), null)

  const destructured = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/d.ts': `import { requireAuth } from '@/lib/auth/server'
export async function go({ requireAuth }: { requireAuth: () => Promise<void> }) { await requireAuth() }`,
  })
  assert.equal(destructured.resolve('app/actions/d.ts', 'requireAuth', calleeAt(destructured, 'app/actions/d.ts', 'requireAuth')), null)
})

test('a CATCH binding and a `for` initializer shadow too', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/c.ts': `import { requireAuth } from '@/lib/auth/server'
export async function go() { try { void 0 } catch (requireAuth) { await requireAuth() } }`,
  })
  assert.equal(g.resolve('app/actions/c.ts', 'requireAuth', calleeAt(g, 'app/actions/c.ts', 'requireAuth')), null)

  const loop = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/l.ts': `import { requireAuth } from '@/lib/auth/server'
export async function go(xs: Array<() => Promise<void>>) { for (const requireAuth of xs) { await requireAuth() } }`,
  })
  assert.equal(loop.resolve('app/actions/l.ts', 'requireAuth', calleeAt(loop, 'app/actions/l.ts', 'requireAuth')), null)
})

test('a `var` shadow declared in a nested block still shadows — it hoists to the function', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/v.ts': `import { requireAuth } from '@/lib/auth/server'
export async function go(flag: boolean) {
  await requireAuth()
  if (flag) { var requireAuth = async () => {} }
}`,
  })
  assert.equal(g.resolve('app/actions/v.ts', 'requireAuth', calleeAt(g, 'app/actions/v.ts', 'requireAuth')), null)
})

test('a shadow in ONE function does not follow the name into another', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/s.ts': `import { requireAuth } from '@/lib/auth/server'
async function shadowed() { const requireAuth = async () => {}; await requireAuth() }
export async function go() { void shadowed; await requireAuth() }`,
  })
  const sf = g.sourceFile('app/actions/s.ts')
  assert.ok(sf)
  const calls: ts.Identifier[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'requireAuth') calls.push(n.expression)
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  assert.equal(calls.length, 2)
  assert.equal(g.resolve('app/actions/s.ts', 'requireAuth', calls[0]), null, 'the shadowed one')
  assert.equal(g.resolve('app/actions/s.ts', 'requireAuth', calls[1])?.file, 'lib/auth/server.ts', 'the real one')
})

test('resolveCallTarget checks the position itself — a caller cannot forget to ask', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/t.ts': `import { requirePermission } from '@/lib/auth/server'
export async function go() { const requirePermission = async (_p: string) => {}; await requirePermission('sync') }`,
  })
  const callee = calleeAt(g, 'app/actions/t.ts', 'requirePermission')
  assert.equal(g.resolveCallTarget('app/actions/t.ts', callee), null)
})

test('a NAMESPACE shadowed at the call site resolves to nothing', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/n.ts': `import * as guards from '@/lib/auth/server'
export async function go() { const guards = { requireAuth: async () => {} }; await guards.requireAuth() }`,
  })
  const sf = g.sourceFile('app/actions/n.ts')
  assert.ok(sf)
  let ns: ts.Identifier | undefined
  const visit = (n: ts.Node) => {
    if (!ns && ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'guards') ns = n.expression
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  assert.ok(ns)
  assert.equal(g.resolveMember('app/actions/n.ts', 'guards', 'requireAuth', ns), null)
  // Without a position it is still the namespace — the module-scope answer.
  assert.equal(g.resolveMember('app/actions/n.ts', 'guards', 'requireAuth')?.file, 'lib/auth/server.ts')
})

// ---------------------------------------------------------------------------
// o3d-512h round 5, finding 2 — is that global the global?
// ---------------------------------------------------------------------------

test('bindsAtModuleScope sees a binding `resolve` cannot — an unfollowable import', () => {
  // This is the whole reason the question needed its own answer: `resolve`
  // returns null both for an untouched global and for an import into a package
  // the graph does not cover, and "null, therefore built-in" is the defect.
  const g = createSourceGraph({
    'lib/a.ts': "import { Symbol } from 'symbol-compat'\nexport const S = Symbol('x')\n",
    'lib/b.ts': "export const S = Symbol('x')\n",
    'lib/c.ts': "const Symbol = (s: string) => s\nexport const S = Symbol('x')\n",
  })
  assert.equal(g.resolve('lib/a.ts', 'Symbol'), null, 'resolve cannot follow it')
  assert.equal(g.bindsAtModuleScope('lib/a.ts', 'Symbol'), true, 'but the name IS taken')
  assert.equal(g.bindsAtModuleScope('lib/b.ts', 'Symbol'), false)
  assert.equal(g.bindsAtModuleScope('lib/c.ts', 'Symbol'), true)
  // A module nobody can read cannot vouch for a global.
  assert.equal(g.bindsAtModuleScope('lib/missing.ts', 'Symbol'), true)
})

test('bindsAtModuleScope sees a DESTRUCTURED binding — round 6, finding 1', () => {
  // `locals` records a variable declaration only when its name is a plain
  // identifier, so `const { Symbol } = …` bound the name at module scope and was
  // in neither map bindsAtModuleScope used to consult. hasLexicalShadow stops AT
  // the source file, so nothing else looked either: the name was reported
  // untouched, and the sentinel behind it certified as the built-in.
  const g = createSourceGraph({
    'lib/obj.ts': "const { Symbol } = { Symbol: (s: string) => s }\nexport const S = Symbol('x')\n",
    'lib/arr.ts': "const [Symbol] = [(s: string) => s]\nexport const S = Symbol('x')\n",
    'lib/nested.ts': "const { compat: { Symbol } } = { compat: { Symbol: (s: string) => s } }\nexport const S = Symbol('x')\n",
    'lib/renamed.ts': "const { make: Symbol } = { make: (s: string) => s }\nexport const S = Symbol('x')\n",
    'lib/exported.ts': "export const { Symbol } = { Symbol: (s: string) => s }\nexport const S = Symbol('x')\n",
    'lib/clean.ts': "export const S = Symbol('x')\n",
  })
  for (const file of ['lib/obj.ts', 'lib/arr.ts', 'lib/nested.ts', 'lib/renamed.ts', 'lib/exported.ts']) {
    assert.equal(g.resolve(file, 'Symbol'), null, `${file}: still unresolvable — that is the trap`)
    assert.equal(g.bindsAtModuleScope(file, 'Symbol'), true, `${file}: the name IS taken`)
  }
  assert.equal(g.bindsAtModuleScope('lib/clean.ts', 'Symbol'), false)
})

test('bindsAtModuleScope sees the other non-identifier binding forms too', () => {
  const g = createSourceGraph({
    'lib/enum.ts': 'enum Symbol { a }\nexport const S = Symbol\n',
    'lib/ns.ts': "namespace Symbol { export const x = 1 }\nexport const S = Symbol.x\n",
    'lib/eq.ts': "import Symbol = require('symbol-compat')\nexport const S = Symbol\n",
    'lib/fn.ts': "function Symbol(s: string) { return s }\nexport const S = Symbol('x')\n",
  })
  for (const file of ['lib/enum.ts', 'lib/ns.ts', 'lib/eq.ts', 'lib/fn.ts']) {
    assert.equal(g.bindsAtModuleScope(file, 'Symbol'), true, file)
  }
})

test('resolveExportedName follows what the OUTSIDE WORLD gets — round 6, finding 2', () => {
  // `resolve` answers what a name means inside a module. An endpoint is what the
  // module PUBLISHES, and `export { x }` / `export { x as y }` / `export { x }
  // from '…'` publish something `resolve` never had to look at.
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'lib/work.ts': 'export async function work() {}\n',
    'app/actions/e.ts': `import { work } from '@/lib/work'
async function local() {}
export { local, local as alias, work }
export { work as fromThere } from '@/lib/work'`,
  })
  assert.deepEqual(pick(g.resolveExportedName('app/actions/e.ts', 'local')), { file: 'app/actions/e.ts', name: 'local' })
  assert.deepEqual(pick(g.resolveExportedName('app/actions/e.ts', 'alias')), { file: 'app/actions/e.ts', name: 'local' })
  assert.deepEqual(pick(g.resolveExportedName('app/actions/e.ts', 'work')), { file: 'lib/work.ts', name: 'work' })
  assert.deepEqual(pick(g.resolveExportedName('app/actions/e.ts', 'fromThere')), { file: 'lib/work.ts', name: 'work' })
  assert.equal(g.resolveExportedName('app/actions/e.ts', 'neverDeclared'), null)
})

test('hasLexicalShadow is exported and answers about a position, not a file', () => {
  const g = createSourceGraph({
    'lib/auth/server.ts': AUTH,
    'app/actions/h.ts': `import { requireAuth } from '@/lib/auth/server'
export async function go() { const requireAuth = async () => {}; await requireAuth() }
export async function ok() { await requireAuth() }`,
  })
  const sf = g.sourceFile('app/actions/h.ts')
  assert.ok(sf)
  const calls: ts.Identifier[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'requireAuth') calls.push(n.expression)
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  assert.equal(calls.length, 2)
  assert.equal(hasLexicalShadow(calls[0], 'requireAuth'), true)
  assert.equal(hasLexicalShadow(calls[1], 'requireAuth'), false)
})

// ---------------------------------------------------------------------------
// o3d-512h round 7 — ENUMERATING WHAT A MODULE PUBLISHES
// ---------------------------------------------------------------------------

/**
 * `exportedNamesOf` exists so a star re-export can be FOLLOWED rather than
 * excused with a `file:*` allowlist entry (Codex round 7, finding 5). The whole
 * point is that it must be complete or say it is not — a set that quietly omits a
 * name is a set of endpoints nobody judged, wearing the appearance of one that
 * was.
 */
test('enumerates every value export, and no type export', () => {
  const g = createSourceGraph({
    'lib/m.ts': `export async function a() {}
export const b = async () => {}
export class C {}
export type T = { x: string }
export interface I { y: string }
function d() {}
export { d }
export { d as e }
type U = string
export type { U }`,
  })
  assert.deepEqual(g.exportedNamesOf('lib/m.ts'), ['C', 'a', 'b', 'd', 'e'])
})

test('enumerates a re-export chain, and `default` when there is one', () => {
  const g = createSourceGraph({
    'lib/inner.ts': 'export async function inner() {}',
    'lib/m.ts': "export { inner } from '@/lib/inner'\nexport default async function () {}",
  })
  assert.deepEqual(g.exportedNamesOf('lib/m.ts'), ['default', 'inner'])
})

test('follows `export *` into the graph and returns the union', () => {
  const g = createSourceGraph({
    'lib/deep.ts': 'export async function deep() {}\nexport default async function () {}',
    'lib/mid.ts': "export * from '@/lib/deep'\nexport async function mid() {}",
    'lib/m.ts': "export * from '@/lib/mid'\nexport async function own() {}",
  })
  // `export *` never re-exports a default, so `deep`'s default does not surface.
  assert.deepEqual(g.exportedNamesOf('lib/m.ts'), ['deep', 'mid', 'own'])
})

test('returns NULL when a star points outside the graph — the set cannot be closed', () => {
  const g = createSourceGraph({
    'lib/m.ts': "export * from 'some-uncovered-package'\nexport async function own() {}",
  })
  assert.equal(g.exportedNamesOf('lib/m.ts'), null)
  assert.equal(g.exportedNamesOf('lib/not-in-graph.ts'), null)
})

test('a star CYCLE does not hang, and still enumerates both modules', () => {
  const g = createSourceGraph({
    'lib/a.ts': "export * from '@/lib/b'\nexport async function fromA() {}",
    'lib/b.ts': "export * from '@/lib/a'\nexport async function fromB() {}",
  })
  assert.deepEqual(g.exportedNamesOf('lib/a.ts'), ['fromA', 'fromB'])
})

test('resolves the `default` export name — to a function, an arrow, or a local', () => {
  const g = createSourceGraph({
    'lib/fn.ts': 'export default async function named() {}',
    'lib/arrow.ts': 'export default async () => {}',
    'lib/local.ts': 'async function work() {}\nexport default work',
    'lib/none.ts': 'export async function notDefault() {}',
  })
  assert.ok(declarationBody(g.resolveExportedName('lib/fn.ts', 'default')))
  assert.ok(declarationBody(g.resolveExportedName('lib/arrow.ts', 'default')))
  assert.deepEqual(pick(g.resolveExportedName('lib/local.ts', 'default')), { file: 'lib/local.ts', name: 'work' })
  assert.equal(g.resolveExportedName('lib/none.ts', 'default'), null)
})

/**
 * Detector behind tests/security/server-action-guard-coverage.test.ts.
 *
 * Extracted from that test (o3d-hic9) so the detection RULES can be exercised
 * against fixture sources in server-action-guard-detector.test.ts, instead of
 * only against the live app/actions tree. A guard whose own logic is untested
 * is how o3d-1fel survived: the `isDelegatingFacade` heuristic silently
 * classified an unguarded `return db.accountingAccount.findMany(...)` as a
 * guarded delegation, and nothing ever asserted otherwise.
 *
 * ---------------------------------------------------------------------------
 * o3d-512h round 3 — RESOLVE, DON'T NAME-MATCH.
 *
 * Codex round 3 found the rules below crediting things they had not verified,
 * in four places. Two of them were here:
 *
 *   * a `return someHelper()` body was credited as a guarded DELEGATION without
 *     anyone ever looking at someHelper — the escape hatch was the shape of the
 *     body, not any property of the delegate;
 *   * a guard was credited whenever its NAME appeared as an identifier anywhere
 *     in the body, called or not. Round 2 patched the single concise-arrow case
 *     (`async () => requireAuth`); every other way to name without calling —
 *     `const g = requireAuth`, `typeof requireAuth`, `guards.push(requireAuth)`,
 *     a dead `if (false) { requireAuth() }` — still passed.
 *
 * And the tree had already been bitten by the general case: app/actions/
 * allocation.ts declared a module-local `requireAuth` that shadowed the imported
 * one and checked only that a user id existed — no session-invalidation check,
 * no 2FA check, no role check. Three endpoints sat behind it, and a rule that
 * matches names could never have said so.
 *
 * Both are now answered by one mechanism, ./module-graph.ts: a call counts as a
 * guard only when its callee RESOLVES — through imports, aliases, namespaces and
 * re-export chains — to a declaration on the pinned list below, or to a function
 * that itself resolves to one. An unresolvable callee (`connector.getAccounts()`,
 * `db.user.findMany()`) is NOT VERIFIED, and not-verified is treated as
 * not-guarded. That subsumes the delegation hatch: a real facade is credited
 * because its delegate was read and found guarded, not because of its shape.
 *
 * Not named *.test.ts on purpose — `npm run test:unit` globs tests/**\/*.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'

import {
  calleeRootName,
  createRepoGraph,
  declarationBody,
  type Declaration,
  type ModuleGraph,
} from './module-graph'

export { calleeRootName }

/**
 * What a guard actually establishes.
 *
 * 'authentication' answers "is someone signed in"; 'authorization' answers "may
 * THIS principal do this". They are not interchangeable, which is the whole
 * lesson of o3d-512h.
 */
export type GuardKind = 'authentication' | 'authorization'

/**
 * The guards, BY DECLARATION SITE rather than by name.
 *
 * `file:name` identity is what makes a shadowing local (allocation.ts's private
 * `requireAuth`) or an aliased import (`import { requireAuth as ok }`) resolve
 * honestly. A name that resolves anywhere else is not on this list and earns
 * nothing.
 */
export const BASE_GUARD_DECLARATIONS: Record<string, Record<string, GuardKind>> = {
  'lib/auth/server.ts': {
    requireAuth: 'authentication',
    getSession: 'authentication',
    requireFreshAuth: 'authentication',
    requireApiAuth: 'authentication',
    requireRole: 'authorization',
    requireAdmin: 'authorization',
    requireFreshAdmin: 'authorization',
    requirePermission: 'authorization',
    requireFreshPermission: 'authorization',
    requireInternalUser: 'authorization',
    authorizePage: 'authorization',
    requireApiAdmin: 'authorization',
    requireApiFreshAdmin: 'authorization',
  },
  'lib/auth/session-gates.ts': {
    requireApiAuthSession: 'authentication',
    requireFreshAuthSession: 'authentication',
    requireApiFreshAuthSession: 'authentication',
    requireRoleSession: 'authorization',
    requireApiAdminSession: 'authorization',
    requireApiFreshAdminSession: 'authorization',
  },
  'lib/security/supplier-portal-boundary.ts': {
    // Not a gate on WHO is calling — a gate on WHOSE ROW this is. On the supplier
    // surface that is the only control that means anything, because every
    // supplier holds every supplier_portal permission.
    assertSupplierOwnsResource: 'authorization',
  },
}

/**
 * Guards that are declared LOCALLY to one module and cannot resolve to the list
 * above, pinned individually with the reason each is accepted.
 *
 * This list is the deliberate, reviewable residue of "resolve, don't name-match":
 * two entries, each read and justified, instead of a name that anything in the
 * tree could have claimed. Adding to it is adding a guard nobody else can audit,
 * so it needs the same argument an allowlist entry does.
 */
export const LOCAL_GUARD_DECLARATIONS: Record<string, { kind: GuardKind; reason: string }> = {
  'app/actions/supplier-portal.ts:requireSupplier': {
    kind: 'authorization',
    reason:
      'reads the session and returns null unless role === SUPPLIER and a supplierId is bound; '
      + 'every caller null-checks it, and the row-level control is assertSupplierOwnsResource on top',
  },
  'app/actions/passkey.ts:getVerifiedSession': {
    kind: 'authentication',
    reason:
      'getSession plus an explicit TOTP-verified check; deliberately authentication ONLY, since '
      + 'managing your own passkeys is self-scoped by session.user.id',
  },
}

export function guardKindOfDeclaration(decl: Declaration): GuardKind | null {
  const base = BASE_GUARD_DECLARATIONS[decl.file]?.[decl.name]
  if (base) return base
  return LOCAL_GUARD_DECLARATIONS[`${decl.file}:${decl.name}`]?.kind ?? null
}

/**
 * Data clients that are NOT an authorization boundary. A call into one of these
 * is the action doing the work itself, so there is no delegate whose guard it
 * could be inheriting (o3d-1fel). Kept as a hard never-credit rule even though
 * resolution would reject them anyway — a Prisma call must never be mistaken for
 * a hand-off, whatever else changes here.
 */
export const DATA_CLIENT_ROOTS = new Set(['db', 'prisma', 'tx', 'client'])

/**
 * A thin facade whose body just returns a call to another action —
 * e.g. `return getWcSyncSettings()`, with the db-rooted case excluded (o3d-1fel).
 *
 * NOTE (round 3): this shape NO LONGER GRANTS CREDIT on its own. It described a
 * body, and a description of a body says nothing about whether the delegate
 * guards anything. A facade is credited today because `guardKindsOfBody` resolved
 * its delegate and found a guard there. The predicate is kept — exported and
 * tested — because the db-rooted exclusion it encodes is still the rule the
 * resolver enforces, and because deleting a guard's history is how the next
 * reviewer loses the reason it exists.
 */
export function isDelegatingFacadeBody(body: ts.ConciseBody | undefined): boolean {
  if (!body) return false

  // An arrow's CONCISE body (`async () => getWcSyncSettings()`) is the returned
  // expression itself — there is no ReturnStatement to find.
  let expr: ts.Expression | undefined
  if (!ts.isBlock(body)) {
    expr = body
  } else {
    const statements = body.statements
    if (statements.length !== 1) return false
    const only = statements[0]
    if (!ts.isReturnStatement(only) || !only.expression) return false
    expr = only.expression
  }

  if (ts.isAwaitExpression(expr)) expr = expr.expression
  if (!ts.isCallExpression(expr)) return false
  const root = calleeRootName(expr.expression)
  return root === null || !DATA_CLIENT_ROOTS.has(root)
}

export function isUseServer(source: string): boolean {
  return /^\s*['"]use server['"]/.test(source)
}

// ---------------------------------------------------------------------------
// The verified guard walk
// ---------------------------------------------------------------------------

/** How far a guard may hide behind wrappers before we stop believing in it. */
const MAX_GUARD_DEPTH = 3

type Verifier = {
  graph: ModuleGraph
  memo: Map<string, Set<GuardKind>>
  active: Set<string>
}

const verifiers = new WeakMap<ModuleGraph, Verifier>()

function verifierFor(graph: ModuleGraph): Verifier {
  let v = verifiers.get(graph)
  if (!v) {
    v = { graph, memo: new Map(), active: new Set() }
    verifiers.set(graph, v)
  }
  return v
}

function collectCalls(body: ts.ConciseBody): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) calls.push(n)
    ts.forEachChild(n, visit)
  }
  // A concise arrow body IS the expression, so it must be visited itself rather
  // than only its children — `async () => requirePermission('sync')` is a call,
  // and `async () => requireAuth` is NOT one, which is the distinction the whole
  // rule turns on.
  if (ts.isBlock(body)) ts.forEachChild(body, visit)
  else visit(body)
  return calls
}

/**
 * The guard kinds a body PROVABLY establishes: every call whose callee resolves
 * to a pinned guard declaration, or to a function that reaches one within
 * MAX_GUARD_DEPTH wrappers.
 *
 * Without a graph nothing resolves, so nothing is credited. That is the correct
 * failure direction for a rule whose job is to have no false negatives, and it
 * is why the fixtures in server-action-guard-detector.test.ts build a fixture
 * graph rather than passing bare sources.
 */
export function guardKindsOfBody(
  file: string,
  body: ts.ConciseBody | undefined,
  graph: ModuleGraph | undefined,
  depth = 0,
): Set<GuardKind> {
  const kinds = new Set<GuardKind>()
  if (!body || !graph || depth > MAX_GUARD_DEPTH) return kinds
  const v = verifierFor(graph)

  for (const call of collectCalls(body)) {
    const root = calleeRootName(call.expression)
    if (root !== null && DATA_CLIENT_ROOTS.has(root)) continue

    const target = graph.resolveCallTarget(file, call.expression)
    if (!target) continue // NOT VERIFIED — never credited.

    const direct = guardKindOfDeclaration(target)
    if (direct) {
      kinds.add(direct)
      continue
    }
    for (const kind of guardKindsOfDeclaration(target, v, depth + 1)) kinds.add(kind)
  }

  return kinds
}

function guardKindsOfDeclaration(decl: Declaration, v: Verifier, depth: number): Set<GuardKind> {
  if (depth > MAX_GUARD_DEPTH) return new Set()
  const key = `${decl.file}:${decl.name}:${depth}`
  const cached = v.memo.get(key)
  if (cached) return cached
  if (v.active.has(key)) return new Set() // recursion: prove nothing, claim nothing
  v.active.add(key)
  try {
    const kinds = guardKindsOfBody(decl.file, declarationBody(decl), v.graph, depth)
    v.memo.set(key, kinds)
    return kinds
  } finally {
    v.active.delete(key)
  }
}

function isAllowlisted(allowlist: Record<string, string>, file: string, name: string): boolean {
  return allowlist[`${file}:${name}`] !== undefined || allowlist[`${file}:*`] !== undefined
}

const isExportedNode = (n: ts.Node): boolean =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

const isAsyncNode = (n: ts.Node): boolean =>
  !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))

/** One exported, async, callable endpoint in a `'use server'` module. */
export type ExportedServerAction = {
  name: string
  /** Block body, or an arrow's concise expression body. */
  body: ts.ConciseBody | undefined
}

/**
 * Every exported async endpoint in a `'use server'` source.
 *
 * o3d-512h: this used to look at FunctionDeclaration only, so
 * `export const doIt = async () => { … }` — an equally addressable endpoint, and
 * the obvious way to add one — was invisible to every rule below. The branch
 * report justified that with "there are none today", which is exactly the
 * argument a guard exists to stop anyone from having to make: the guard's job is
 * to catch what the next sweep misses, and it cannot do that for a syntax it
 * does not parse.
 *
 * `export default async function …` is deliberately NOT collected: a default
 * export is not a callable Server Action name in Next.js's action protocol.
 */
export function exportedServerActions(sf: ts.SourceFile): ExportedServerAction[] {
  const actions: ExportedServerAction[] = []

  ts.forEachChild(sf, (node) => {
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && node.body
      && isExportedNode(node)
      && isAsyncNode(node)
    ) {
      actions.push({ name: node.name.text, body: node.body })
      return
    }

    // `export const a = async () => {}, b = async function () {}` — every
    // declarator in the statement is its own export, so each is its own endpoint.
    if (ts.isVariableStatement(node) && isExportedNode(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        const init = decl.initializer
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue
        if (!isAsyncNode(init)) continue
        actions.push({ name: decl.name.text, body: init.body })
      }
    }
  })

  return actions
}

/** Unguarded exported server actions in one source, as `file:name`. */
export function scanSource(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  if (!isUseServer(source)) return []
  const violations: string[] = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue
    const kinds = guardKindsOfBody(file, action.body, graph)
    if (kinds.size === 0 && !isAllowlisted(allowlist, file, action.name)) {
      violations.push(`${file}:${action.name}`)
    }
  }
  return violations
}

/**
 * Helpers that hand back a SETTING VALUE, decrypting the keys in
 * SENSITIVE_SETTING_KEYS on the way out (lib/settings-store.ts).
 */
export const SETTINGS_SECRET_READERS = new Set([
  'getSettingValue', 'getSettingValues', 'deserializeSettingValue', 'decryptSettingValue',
])

const SETTINGS_STORE_FILE = 'lib/settings-store.ts'

/**
 * Endpoints that read a stored secret behind AUTHENTICATION ONLY (o3d-512h).
 *
 * The coverage rule above only ever asked "is there a guard at all", which is why
 * the first sweep of this branch walked past app/actions/company.ts:
 * getEmailSettings: it had `requireAuth`, so it was never a violation, while
 * returning the decrypted SMTP configuration to every signed-in role. Reading a
 * credential is an AUTHORIZATION question, so authentication alone is not an
 * answer to it.
 *
 * Deliberately narrow: it triggers on the settings-store readers, which decrypt,
 * and not on `db.setting.*` — plenty of endpoints legitimately read non-secret
 * settings (numbering prefixes, branding colours, FX health) under an
 * authentication gate, and a rule that flagged those would be answered with an
 * allowlist instead of a fix.
 *
 * Round 3: the reader is matched by RESOLUTION when a graph is available, so a
 * local helper called `getSettingValue` that reads nothing does not trip it and,
 * more importantly, an aliased import of the real one does.
 */
export function scanSecretReadingActions(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  if (!isUseServer(source)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: string[] = []

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue

    let readsSecret = false
    const visit = (n: ts.Node) => {
      if (readsSecret) return
      if (ts.isIdentifier(n) && SETTINGS_SECRET_READERS.has(n.text)) {
        if (!graph) {
          readsSecret = true
        } else {
          const decl = graph.resolve(file, n.text)
          // Unresolvable is treated as a read: this rule must not go quiet on a
          // module the graph does not cover.
          if (!decl || (decl.file === SETTINGS_STORE_FILE && SETTINGS_SECRET_READERS.has(decl.name))) {
            readsSecret = true
          }
        }
        if (readsSecret) return
      }
      ts.forEachChild(n, visit)
    }
    if (ts.isBlock(action.body)) ts.forEachChild(action.body, visit)
    else visit(action.body)

    if (!readsSecret) continue
    const kinds = guardKindsOfBody(file, action.body, graph)
    if (!kinds.has('authorization') && !isAllowlisted(allowlist, file, action.name)) {
      violations.push(`${file}:${action.name}`)
    }
  }
  return violations
}

/**
 * A rule: given one file's key + source + allowlist, the violations in it.
 * Both directory walkers take one so every rule sees exactly the same tree —
 * a rule that scanned a narrower tree than the others would be a gap by
 * construction.
 */
export type SourceScanner = (
  file: string,
  source: string,
  allowlist: Record<string, string>,
  graph?: ModuleGraph,
) => string[]

/** Scans every non-test .ts directly in `dir`. Keys violations by BASENAME. */
export function scanActionsDir(
  dir: string,
  allowlist: Record<string, string>,
  scanner: SourceScanner = scanSource,
  graph?: ModuleGraph,
  keyPrefix = '',
): string[] {
  const violations: string[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const full = path.join(dir, entry)
    const source = readFileSync(full, 'utf8')
    // The graph is keyed by repo-relative path; the allowlist and the reported
    // violations are keyed by basename, as they have been since round 1.
    const graphKey = keyPrefix ? `${keyPrefix}/${entry}` : entry
    violations.push(...scanner(entry, source, allowlist, graph ? rekey(graph, entry, graphKey) : undefined))
  }
  return violations
}

/**
 * A view of the graph in which the scanner's short key (`settings.ts`) behaves as
 * the real repo key (`app/actions/settings.ts`).
 *
 * The alternative was to change every allowlist key and every pinned inventory
 * entry from a basename to a path, which would have made this round's diff a
 * rename of 80 lines with the actual change hidden inside it.
 */
function rekey(graph: ModuleGraph, shortKey: string, realKey: string): ModuleGraph {
  const map = (file: string) => (file === shortKey ? realKey : file)
  const view: ModuleGraph = {
    files: () => graph.files(),
    source: (f) => graph.source(map(f)),
    sourceFile: (f) => graph.sourceFile(map(f)),
    resolve: (f, n) => graph.resolve(map(f), n),
    resolveMember: (f, ns, m) => graph.resolveMember(map(f), ns, m),
    resolveCallTarget: (f, c) => graph.resolveCallTarget(map(f), c),
    referrers: (f, n, p) => graph.referrers(map(f), n, p),
  }
  // Share the underlying verifier memo: the view and the graph resolve to the
  // same declarations, so caching twice would only be slower.
  const v = verifierFor(graph)
  verifiers.set(view, v)
  return view
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', '.git'])

/**
 * Every OTHER `'use server'` module in the tree (o3d-hic9).
 *
 * app/actions/ is where server actions are supposed to live, but the directive
 * is what creates the endpoint, not the directory — and scanning only
 * app/actions/ meant a `'use server'` module anywhere else was invisible to the
 * guard. lib/connectors/woocommerce/products.ts was exactly that.
 *
 * Keys violations by repo-relative POSIX path, since basenames are not unique
 * outside app/actions.
 */
export function scanUseServerOutsideActions(
  root: string,
  scanRoots: string[],
  allowlist: Record<string, string>,
  scanner: SourceScanner = scanSource,
  graph?: ModuleGraph,
): string[] {
  const actionsDir = path.join(root, 'app', 'actions')
  const violations: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
      if (path.dirname(full) === actionsDir) continue // covered by scanActionsDir
      const source = readFileSync(full, 'utf8')
      if (!isUseServer(source)) continue
      const rel = path.relative(root, full).split(path.sep).join('/')
      violations.push(...scanner(rel, source, allowlist, graph))
    }
  }

  for (const r of scanRoots) walk(path.join(root, r))
  return violations
}

/**
 * Every exported endpoint whose only gate is AUTHENTICATION (o3d-512h round 2).
 *
 * Not a violation rule — an authentication gate is the right answer for a
 * self-scoped endpoint (your own profile, your own passkeys). It is an INVENTORY,
 * pinned by server-action-guard-coverage.test.ts so the set cannot change
 * silently.
 *
 * Round 3: the classification is now made by resolution, so an endpoint cannot
 * leave this inventory by acquiring a LOCAL function that merely shares a name
 * with an authorization guard.
 */
export function scanAuthenticationOnlyActions(
  file: string,
  source: string,
  _allowlist: Record<string, string> = {},
  graph?: ModuleGraph,
): string[] {
  void _allowlist
  if (!isUseServer(source)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue
    const kinds = guardKindsOfBody(file, action.body, graph)
    if (kinds.has('authentication') && !kinds.has('authorization')) {
      found.push(`${file}:${action.name}`)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// What an endpoint RETURNS — the half the inventory could not see (round 3)
// ---------------------------------------------------------------------------

/**
 * The Prisma models an endpoint reaches, transitively, through every callee the
 * graph can resolve.
 *
 * Codex round 3, finding 3: the inventory pinned WHICH endpoints are
 * authentication-only and said nothing about WHAT they return, so an endpoint
 * could start serving privileged rows without ever leaving the list — which is
 * the exact question the inventory was built to force. It is also the half that
 * defeated every single-file rule: settings.ts:getAccountCodes and
 * purchase-orders.ts:getBillPaymentAccounts reached the stored chart of accounts
 * through a helper two modules away, and nothing in their own source looked like
 * an accounting read.
 *
 * Resolution answers it. `db.<model>` / `tx.<model>` accesses are collected from
 * the endpoint's own body and from every function it can reach, so the pin in the
 * coverage test is a statement about the data surface rather than about the gate.
 * Unresolvable callees are simply not followed — the pin under-reports rather
 * than inventing reach, and the endpoints it covers are the handful whose bodies
 * a reviewer can check by eye.
 */
export function reachedPrismaModels(
  file: string,
  body: ts.ConciseBody | undefined,
  graph: ModuleGraph,
  seen = new Set<string>(),
): string[] {
  const models = new Set<string>()
  if (!body) return []

  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(n)
      && ts.isIdentifier(n.expression)
      && DATA_CLIENT_ROOTS.has(n.expression.text)
      && ts.isIdentifier(n.name)
    ) {
      models.add(n.name.text)
    }
    ts.forEachChild(n, visit)
  }
  if (ts.isBlock(body)) ts.forEachChild(body, visit)
  else visit(body)

  for (const call of collectCalls(body)) {
    const root = calleeRootName(call.expression)
    if (root !== null && DATA_CLIENT_ROOTS.has(root)) continue
    const target = graph.resolveCallTarget(file, call.expression)
    if (!target) continue
    const key = `${target.file}:${target.name}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const m of reachedPrismaModels(target.file, declarationBody(target), graph, seen)) {
      models.add(m)
    }
  }

  return [...models].sort()
}

/** `key -> sorted models reached`, for every endpoint named. */
export function prismaSurfaceOf(
  entries: Array<{ key: string; file: string; name: string }>,
  graph: ModuleGraph,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const { key, file, name } of entries) {
    const source = graph.source(file)
    if (source === undefined) {
      out[key] = ['<file not in graph>']
      continue
    }
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const action = exportedServerActions(sf).find((a) => a.name === name)
    out[key] = action
      ? reachedPrismaModels(file, action.body, graph)
      : ['<export not found>']
  }
  return out
}

export { createRepoGraph }
export type { ModuleGraph, Declaration }

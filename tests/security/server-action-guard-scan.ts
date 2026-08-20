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
 * Not named *.test.ts on purpose — `npm run test:unit` globs tests/**\/*.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'

/** Identifiers that establish an auth/authorization boundary. */
export const GUARD_IDENTIFIERS = new Set([
  'requireAuth', 'requireRole', 'requireAdmin', 'requireFreshAuth', 'requireFreshAdmin',
  'requirePermission', 'requireFreshPermission', 'requireApiAuth', 'requireApiAdmin',
  'requireApiFreshAdmin', 'requireSupplier', 'assertSupplierOwnsResource',
  'requireMintsoftReadAccess', 'requireMintsoftWriteAccess', 'requireFreshMintsoftWriteAccess',
  'requireMintsoftReturnsWriteAccess', 'requireShoppingAdmin', 'requireFreshShoppingAdmin',
  'getVerifiedSession', 'consumeDestructiveActionCode', 'validateImportFile',
])

/**
 * Data clients that are NOT an authorization boundary. A call into one of these
 * is the action doing the work itself, so there is no delegate whose guard it
 * could be inheriting.
 */
const DATA_CLIENT_ROOTS = new Set(['db', 'prisma'])

/** The root identifier of a call target: `db.setting.findMany` -> `db`. */
function calleeRootName(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = cur.expression
  }
  return ts.isIdentifier(cur) ? cur.text : null
}

/**
 * A thin facade whose body just returns a call to another (guarded) action —
 * e.g. `return getWcSyncSettings()`. The guard lives in the delegate.
 *
 * o3d-1fel: a single-statement `return db.<model>.findMany(...)` matched this
 * shape too, so xero-sync.ts:getAccountingAccounts — an unguarded read of the
 * whole chart of accounts — was classified as a guarded delegation and passed.
 * Delegation means handing off to something that can carry a guard; a Prisma
 * call cannot. Those are excluded.
 */
export function isDelegatingFacadeBody(body: ts.ConciseBody | undefined): boolean {
  if (!body) return false

  // An arrow's CONCISE body (`async () => getWcSyncSettings()`) is the returned
  // expression itself — there is no ReturnStatement to find, so the block path
  // below would classify every concise-bodied facade as "not a facade" and flag
  // it. Handle it as the one-expression return it is.
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

export function isDelegatingFacade(fn: ts.FunctionDeclaration): boolean {
  return isDelegatingFacadeBody(fn.body)
}

export function isUseServer(source: string): boolean {
  return /^\s*['"]use server['"]/.test(source)
}

/**
 * Walks IDENTIFIERS, so a guard named only in a doc comment or a string does not
 * count as a guard. Comments are trivia and never become Identifier nodes.
 */
function bodyReferencesGuard(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node) => {
    if (found) return
    if (ts.isIdentifier(n) && GUARD_IDENTIFIERS.has(n.text)) { found = true; return }
    ts.forEachChild(n, visit)
  }
  // Deliberately forEachChild for a concise arrow body too. `async () =>
  // requirePermission('sync')` is a CallExpression whose first child is the
  // callee identifier, so the guard is still found. Visiting the body node
  // ITSELF would differ in exactly one case — a body that is a bare identifier,
  // `async () => requireAuth` — and there the difference is wrong: that returns
  // the guard, it does not call it, so counting it as guarded would be a false
  // negative in the rule that exists to prevent those.
  ts.forEachChild(node, visit)
  return found
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
): string[] {
  if (!isUseServer(source)) return []
  const violations: string[] = []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue
    if (
      !bodyReferencesGuard(action.body)
      && !isDelegatingFacadeBody(action.body)
      && !isAllowlisted(allowlist, file, action.name)
    ) {
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

/**
 * Guards that establish AUTHENTICATION only — they answer "is someone signed
 * in", never "may this principal read a credential".
 */
export const AUTHENTICATION_ONLY_GUARDS = new Set(['requireAuth', 'getVerifiedSession'])

/**
 * Endpoints that read a stored secret behind AUTHENTICATION ONLY (o3d-512h).
 *
 * The rule above only ever asked "is there a guard at all", which is why the
 * first sweep of this branch walked past app/actions/company.ts:getEmailSettings:
 * it had `requireAuth`, so it was never a violation, while returning the
 * decrypted SMTP configuration to every signed-in role. Reading a credential is
 * an AUTHORIZATION question, so authentication alone is not an answer to it.
 *
 * Deliberately narrow: it triggers on the settings-store readers, which decrypt,
 * and not on `db.setting.*` — plenty of endpoints legitimately read non-secret
 * settings (numbering prefixes, branding colours, FX health) under requireAuth,
 * and a rule that flagged those would be answered with an allowlist instead of a
 * fix.
 */
export function scanSecretReadingActions(
  file: string,
  source: string,
  allowlist: Record<string, string> = {},
): string[] {
  if (!isUseServer(source)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: string[] = []

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue
    let readsSecret = false
    let authorized = false
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        if (SETTINGS_SECRET_READERS.has(n.text)) readsSecret = true
        if (GUARD_IDENTIFIERS.has(n.text) && !AUTHENTICATION_ONLY_GUARDS.has(n.text)) authorized = true
      }
      ts.forEachChild(n, visit)
    }
    // A concise arrow body IS the expression, so it must be visited itself
    // rather than only its children.
    if (ts.isBlock(action.body)) ts.forEachChild(action.body, visit)
    else visit(action.body)

    if (readsSecret && !authorized && !isAllowlisted(allowlist, file, action.name)) {
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
) => string[]

/** Scans every non-test .ts directly in `dir`. Keys violations by BASENAME. */
export function scanActionsDir(
  dir: string,
  allowlist: Record<string, string>,
  scanner: SourceScanner = scanSource,
): string[] {
  const violations: string[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const full = path.join(dir, entry)
    violations.push(...scanner(entry, readFileSync(full, 'utf8'), allowlist))
  }
  return violations
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
      violations.push(...scanner(rel, source, allowlist))
    }
  }

  for (const r of scanRoots) walk(path.join(root, r))
  return violations
}


/**
 * Every exported endpoint whose only gate is AUTHENTICATION (o3d-512h round 2).
 *
 * Not a violation rule — `requireAuth` is the right answer for most of the
 * business reads every signed-in role needs. It is an INVENTORY, pinned by
 * server-action-guard-coverage.test.ts so the set cannot change silently.
 *
 * The rule above catches the mechanical half of the getEmailSettings class (an
 * endpoint reading the settings store behind authentication only). It cannot
 * catch the other half: getAccountCodes and getBillPaymentAccounts reached the
 * stored chart of accounts through a helper two modules away, so nothing in
 * their own source looks like a privileged read, and no single-file rule was
 * ever going to see it. What decides those is a human asking "what does this
 * return, and who else guards the same rows".
 *
 * So the answer to "what stops a third instance" is not a cleverer regex: it is
 * that the question now gets ASKED. Adding an endpoint to this set — or removing
 * one — turns the build red, and the reviewer has to say why authentication is
 * sufficient for it. That converts a sweep somebody has to remember to redo into
 * a decision the next author cannot skip.
 */
export function scanAuthenticationOnlyActions(
  file: string,
  source: string,
  _allowlist: Record<string, string> = {},
): string[] {
  void _allowlist
  if (!isUseServer(source)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []

  for (const action of exportedServerActions(sf)) {
    if (!action.body) continue
    let authenticated = false
    let authorized = false
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        if (AUTHENTICATION_ONLY_GUARDS.has(n.text)) authenticated = true
        else if (GUARD_IDENTIFIERS.has(n.text)) authorized = true
      }
      ts.forEachChild(n, visit)
    }
    if (ts.isBlock(action.body)) ts.forEachChild(action.body, visit)
    else visit(action.body)

    if (authenticated && !authorized) found.push(`${file}:${action.name}`)
  }
  return found
}

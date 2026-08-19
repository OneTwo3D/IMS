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
export function isDelegatingFacade(fn: ts.FunctionDeclaration): boolean {
  const statements = fn.body?.statements ?? []
  if (statements.length !== 1) return false
  const only = statements[0]
  if (!ts.isReturnStatement(only) || !only.expression) return false
  let expr: ts.Expression = only.expression
  if (ts.isAwaitExpression(expr)) expr = expr.expression
  if (!ts.isCallExpression(expr)) return false
  const root = calleeRootName(expr.expression)
  return root === null || !DATA_CLIENT_ROOTS.has(root)
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
  ts.forEachChild(node, visit)
  return found
}

function isAllowlisted(allowlist: Record<string, string>, file: string, name: string): boolean {
  return allowlist[`${file}:${name}`] !== undefined || allowlist[`${file}:*`] !== undefined
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

  const isExported = (n: ts.Node): boolean =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

  ts.forEachChild(sf, (node) => {
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && node.body
      && isExported(node)
      && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      const name = node.name.text
      if (!bodyReferencesGuard(node) && !isDelegatingFacade(node) && !isAllowlisted(allowlist, file, name)) {
        violations.push(`${file}:${name}`)
      }
    }
  })
  return violations
}

/** Scans every non-test .ts directly in `dir`. Keys violations by BASENAME. */
export function scanActionsDir(dir: string, allowlist: Record<string, string>): string[] {
  const violations: string[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const full = path.join(dir, entry)
    violations.push(...scanSource(entry, readFileSync(full, 'utf8'), allowlist))
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
      violations.push(...scanSource(rel, source, allowlist))
    }
  }

  for (const r of scanRoots) walk(path.join(root, r))
  return violations
}

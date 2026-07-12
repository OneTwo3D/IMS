import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

// Regression guard for onetwo3d-ims-mgq1: every exported async function in a
// 'use server' module is a callable RPC endpoint, so it must either enforce an
// auth/authorization guard directly, or be explicitly listed here as public or
// as a facade that delegates to another guarded action. A NEW unguarded export
// fails this test until it is fixed or (with justification) allowlisted.

const ACTIONS_DIR = path.join(process.cwd(), 'app', 'actions')

// Identifiers that establish an auth/authorization boundary.
const GUARD_IDENTIFIERS = new Set([
  'requireAuth', 'requireRole', 'requireAdmin', 'requireFreshAuth', 'requireFreshAdmin',
  'requirePermission', 'requireFreshPermission', 'requireApiAuth', 'requireApiAdmin',
  'requireApiFreshAdmin', 'requireSupplier', 'assertSupplierOwnsResource',
  'requireMintsoftReadAccess', 'requireMintsoftWriteAccess', 'requireFreshMintsoftWriteAccess',
  'requireMintsoftReturnsWriteAccess', 'requireShoppingAdmin', 'requireFreshShoppingAdmin',
  'getVerifiedSession', 'consumeDestructiveActionCode', 'validateImportFile',
])

// Exports intentionally without a direct guard. Each entry needs a reason.
const ALLOWLIST: Record<string, string> = {
  // Pre-auth by design (authentication / account recovery entry points).
  'auth.ts:*': 'authentication entry points run before a session exists',
  'password-reset.ts:*': 'password reset is pre-auth; rate-limited + anti-enumeration',
  'passkey.ts:getPasskeyAuthenticationOptions': 'pre-auth passkey login ceremony',
  'passkey.ts:verifyPasskeyAuthentication': 'pre-auth passkey login ceremony (one-time token bound)',
  // Public, static content.
  'help.ts:*': 'static product help content; slug is allowlisted/sanitized',
  // Public, static (non-sensitive) connector catalogue.
  'company.ts:getShoppingConnectors': 'returns static connector id/label/available metadata only',

  // Connector-facade modules: thin routers that resolve the active connector and
  // delegate to a guarded connector action (verified in the 2026-07 security
  // review). A deeper pass to give each facade getter its own guard is tracked in
  // onetwo3d-ims-mgq1. Core business-logic modules are NOT allowlisted.
  'accounting-sync.ts:*': 'connector facade → guarded xero/quickbooks actions',
  'accounting-batch.ts:*': 'connector facade → guarded daily-batch actions',
  'xero-sync.ts:*': 'connector facade → guarded xero actions',
  'quickbooks-sync.ts:*': 'connector facade → guarded quickbooks actions',
  'quickbooks-daily-batch.ts:*': 'connector facade → guarded daily-batch actions',
  'shopping-sync.ts:*': 'connector facade → guarded wc-sync actions',
  'wms-sync.ts:*': 'connector facade → guarded mintsoft/shiphero actions',
  'wms-asn.ts:*': 'connector facade → guarded mintsoft/shiphero ASN actions',
  'wms-onboarding.ts:*': 'connector facade → guarded mintsoft/shiphero onboarding actions',
}

/**
 * A thin facade whose body just returns a call to another (guarded) action —
 * e.g. `return getWcSyncSettings()`. The guard lives in the delegate. Recognised
 * so the many connector facades don't each need an allowlist entry; the delegate
 * itself is still subject to this test (if it lives in app/actions) or is a
 * connector action assumed guarded.
 */
function isDelegatingFacade(fn: ts.FunctionDeclaration): boolean {
  const statements = fn.body?.statements ?? []
  if (statements.length !== 1) return false
  const only = statements[0]
  if (!ts.isReturnStatement(only) || !only.expression) return false
  let expr: ts.Expression = only.expression
  if (ts.isAwaitExpression(expr)) expr = expr.expression
  return ts.isCallExpression(expr)
}

function collectActionFiles(): string[] {
  return readdirSync(ACTIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(ACTIONS_DIR, f))
}

function isUseServer(source: string): boolean {
  return /^\s*['"]use server['"]/.test(source)
}

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

function isAllowlisted(file: string, name: string): boolean {
  return ALLOWLIST[`${file}:${name}`] !== undefined || ALLOWLIST[`${file}:*`] !== undefined
}

test('every exported server action enforces an auth guard or is allowlisted', () => {
  const violations: string[] = []

  for (const filePath of collectActionFiles()) {
    const source = readFileSync(filePath, 'utf8')
    if (!isUseServer(source)) continue
    const file = path.basename(filePath)
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

    ts.forEachChild(sf, (node) => {
      // exported `async function name() {}`
      const isExported = (n: ts.Node): boolean =>
        !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))

      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.body &&
        isExported(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        const name = node.name.text
        if (!bodyReferencesGuard(node) && !isDelegatingFacade(node) && !isAllowlisted(file, name)) {
          violations.push(`${file}:${name}`)
        }
      }
    })
  }

  assert.deepEqual(
    violations,
    [],
    `Unguarded exported server action(s) found — add a guard or allowlist with a reason:\n${violations.join('\n')}`,
  )
})

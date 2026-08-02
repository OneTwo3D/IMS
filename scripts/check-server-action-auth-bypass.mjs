#!/usr/bin/env node

/**
 * Static guard: no Server Action may accept a SERIALIZABLE authorization
 * bypass (o3d-43oz).
 *
 * A `'use server'` directive — module-wide, or on an individual function —
 * makes the affected exports directly POST-callable, and every argument
 * crosses the RPC boundary. So a plain option like
 *
 *     options?: { skipPermissionCheck?: boolean }
 *
 * is something any client can simply send. `applySalesOrderStatusTransition`
 * had exactly that: sending it suppressed `requirePermission('sales.process')`
 * outright, after which a caller with no permission could drive any
 * state-machine-legal transition — including CANCELLED from
 * PROCESSING/ALLOCATED/PICKING/PACKING, which releases reservations and
 * deletes pending shipments. The state machine constrains the SHAPE of a
 * transition; it is not authorization.
 *
 * The supported pattern is an unforgeable capability: a `symbol`, which the
 * Server Action boundary cannot transport from a client, so it can only be
 * supplied by server-side code that imports it. See
 * lib/sales/status-transition-bypass.ts.
 *
 * Implemented on the TypeScript AST rather than line regexes, because a
 * regex version silently missed the shapes that matter: a directive after a
 * long prologue, a per-function directive, an options type declared as an
 * imported or local alias, and a parameter split across lines. A security
 * control that reports success while missing a bypass is worse than none.
 *
 * What it checks: for every exported function reachable over RPC, every
 * parameter's type — following locally-declared type aliases and interfaces —
 * for a property whose NAME reads like an authorization bypass and whose TYPE
 * is serializable. Behaviour flags (`force`, `allowCache`, `skipLog`, …) are
 * deliberately not matched; they do not gate a permission check, and a guard
 * that cries wolf gets waived into uselessness.
 *
 * Waiver: `// server-action-auth-bypass-ok: <ticket>: <reason>` on the
 * property's line or the line above.
 *
 * Run via `npm run check:server-action-auth-bypass`; invoked by
 * `npm run check:all`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

const ROOT = process.cwd()
const SCAN_ROOTS = ['app', 'lib', 'components']
const EXTS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', 'dist', 'build'])

/**
 * Property names that gate AUTHORIZATION rather than behaviour.
 * Matched case-insensitively on the whole name.
 */
const AUTH_BYPASS_NAME = /^(skipPermissionCheck|skipPermissions?|skipAuthz?|skipAuthorization|skipAuthentication|bypassPermissions?|bypassAuthz?|bypassAuthorization|allowUnauthenticated|allowAnonymous|asSystem|asAdmin|isInternal|internalCall|trusted|isTrusted)$/i

/** Types a client can actually send. A `symbol` is what we want instead. */
const SERIALIZABLE_KINDS = new Set([
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.UnknownKeyword,
])

const WAIVER = /server-action-auth-bypass-ok:/

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.has(extname(entry))) out.push(full)
  }
  return out
}

/** A real `'use server'` directive prologue entry — not a string that merely says so. */
function hasUseServerDirective(statements) {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st)) break // prologue ends at the first non-directive
    const e = st.expression
    if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) break
    if (e.text === 'use server') return true
  }
  return false
}

function isSerializableType(node) {
  if (!node) return false
  if (SERIALIZABLE_KINDS.has(node.kind)) return true
  if (ts.isLiteralTypeNode(node)) return SERIALIZABLE_KINDS.has(node.literal.kind)
  // `boolean | undefined`, `true | false`, …: serializable if ANY member is.
  if (ts.isUnionTypeNode(node)) return node.types.some(isSerializableType)
  return false
}

const violations = []

for (const root of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('use server')) continue

    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const moduleWide = hasUseServerDirective(sf.statements)

    // Locally declared option types, so an aliased parameter type still resolves.
    const localTypes = new Map()
    const collectTypes = (node) => {
      if (ts.isTypeAliasDeclaration(node)) localTypes.set(node.name.text, node.type)
      else if (ts.isInterfaceDeclaration(node)) localTypes.set(node.name.text, node)
      ts.forEachChild(node, collectTypes)
    }
    collectTypes(sf)

    const lines = source.split('\n')
    const report = (node, label) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      const text = lines[line] ?? ''
      if (WAIVER.test(text) || (line > 0 && WAIVER.test(lines[line - 1]))) return
      violations.push(`${relative(ROOT, file)}:${line + 1}: ${label}`)
    }

    /** Inspect a type node's members for a serializable auth-bypass property. */
    const inspectType = (typeNode, seen = new Set()) => {
      if (!typeNode) return
      if (ts.isTypeReferenceNode(typeNode)) {
        const name = typeNode.typeName.getText(sf)
        if (seen.has(name)) return
        seen.add(name)
        const resolved = localTypes.get(name)
        if (resolved) inspectType(resolved, seen)
        return
      }
      if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
        typeNode.types.forEach((t) => inspectType(t, seen))
        return
      }
      const members = ts.isTypeLiteralNode(typeNode) || ts.isInterfaceDeclaration(typeNode)
        ? typeNode.members
        : null
      if (!members) return
      for (const m of members) {
        if (!ts.isPropertySignature(m) || !m.name) continue
        const propName = m.name.getText(sf).replace(/['"]/g, '')
        if (!AUTH_BYPASS_NAME.test(propName)) continue
        if (!isSerializableType(m.type)) continue
        report(m, `serializable auth bypass \`${propName}\``)
      }
    }

    const inspectFunction = (fn) => {
      for (const p of fn.parameters) {
        // A destructured parameter still carries its type annotation.
        inspectType(p.type)
        // `{ skipPermissionCheck = false }` with no annotation: flag the name.
        if (!p.type && ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            const n = el.propertyName?.getText(sf) ?? el.name.getText(sf)
            if (AUTH_BYPASS_NAME.test(n)) report(el, `untyped auth-bypass binding \`${n}\``)
          }
        }
      }
    }

    const visit = (node) => {
      const isFn = ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      if (isFn) {
        const perFunction = node.body && ts.isBlock(node.body)
          ? hasUseServerDirective(node.body.statements)
          : false
        if (moduleWide || perFunction) inspectFunction(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

if (violations.length > 0) {
  console.error(
    'Server Action authorization-bypass violation: a serializable option that '
    + 'gates a permission check is directly POST-callable by any client.\n'
    + 'Use an unforgeable capability instead — a `symbol` cannot cross the '
    + 'Server Action boundary. See lib/sales/status-transition-bypass.ts and o3d-43oz.\n'
    + 'If this is genuinely not an auth gate, add a waiver:\n'
    + '// server-action-auth-bypass-ok: <ticket>: <reason>\n',
  )
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}

console.log('Server Action auth-bypass check passed.')

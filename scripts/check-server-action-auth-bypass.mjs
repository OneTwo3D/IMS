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
 * Uses a full `ts.Program` and the TypeChecker, not the syntax tree alone.
 * A syntax-only version could only resolve type references declared in the
 * SAME file, so an imported `TransitionOptions`, a `Pick`/`Omit`, an
 * instantiated generic, or a type inferred from a default value all slipped
 * through silently — each of which can recreate the original bypass while CI
 * reports success. The checker resolves all of them to their effective
 * properties.
 *
 * Scope: for a module-wide directive, only EXPORTED functions are inspected —
 * a private helper is not remotely callable, and failing CI on one would just
 * teach people to add waivers. A function carrying its own `use server`
 * directive is inspected regardless of export, because that directive is what
 * exposes it.
 *
 * Behaviour flags (`force`, `allowCache`, `skipLog`, …) are deliberately not
 * matched; they do not gate a permission check.
 *
 * Waiver: `// server-action-auth-bypass-ok: <ticket>: <reason>` on the
 * property's line or the line above.
 *
 * Fixtures live in tests/fixtures/server-action-auth-bypass/ and are exercised
 * by tests/server-action-auth-bypass-guard.test.ts.
 *
 * Run via `npm run check:server-action-auth-bypass`; invoked by
 * `npm run check:all`.
 */

import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

const DEFAULT_SCAN_ROOTS = ['app', 'lib', 'components']

/**
 * Property names that gate AUTHORIZATION rather than behaviour.
 * Matched whole and case-insensitively.
 */
const AUTH_BYPASS_NAME = /^(skipPermissionChecks?|skipPermissions?|skipAuthz?|skipAuthorization|skipAuthentication|bypassPermissions?|bypassAuthz?|bypassAuthorization|allowUnauthenticated|allowAnonymous|asSystem|asAdmin|isInternal|internalCall|trusted|isTrusted)$/i

const WAIVER = /server-action-auth-bypass-ok:/

/** A real `'use server'` prologue entry — not a string that merely says so. */
function hasUseServerDirective(statements) {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st)) break // the prologue ends here
    const e = st.expression
    if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) break
    if (e.text === 'use server') return true
  }
  return false
}

/** Can a client actually send a value of this type? A `symbol` cannot. */
function isSerializableType(checker, type) {
  const parts = type.isUnion() ? type.types : [type]
  return parts.some((t) => {
    // `undefined`/`null` members of an optional property say nothing either way.
    if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) return false
    if (t.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) return false
    return Boolean(t.flags & (
      ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral
      | ts.TypeFlags.String | ts.TypeFlags.StringLike | ts.TypeFlags.StringLiteral
      | ts.TypeFlags.Number | ts.TypeFlags.NumberLike | ts.TypeFlags.NumberLiteral
      | ts.TypeFlags.Any | ts.TypeFlags.Unknown
    ))
  })
}

function functionLikeOf(decl) {
  if (!decl) return null
  if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) return decl
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init
  }
  return null
}

export function runGuard({ tsconfig = 'tsconfig.json', root = process.cwd(), scanRoots = DEFAULT_SCAN_ROOTS } = {}) {
  const configPath = join(root, tsconfig)
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    root,
  )
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()

  const prefixes = scanRoots.map((r) => join(root, r) + sep)
  const violations = []

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    if (!prefixes.some((p) => sf.fileName.startsWith(p))) continue
    const source = sf.getFullText()
    if (!source.includes('use server')) continue

    const moduleWide = hasUseServerDirective(sf.statements)
    const lines = source.split('\n')

    const report = (node, label) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      const text = lines[line] ?? ''
      if (WAIVER.test(text) || (line > 0 && WAIVER.test(lines[line - 1]))) return
      violations.push(`${relative(root, sf.fileName)}:${line + 1}: ${label}`)
    }

    const inspectFunction = (fn) => {
      for (const p of fn.parameters) {
        // getTypeAtLocation resolves imports, aliases, Pick/Omit, generics and
        // types inferred from a default value — everything a syntax-only walk
        // could not see.
        let type
        try { type = checker.getTypeAtLocation(p) } catch { continue }
        if (!type) continue
        // An OPTIONAL parameter is `T | undefined`, and getPropertiesOfType on
        // a union returns only the properties common to every member — so
        // `undefined` erases them all and the guard silently sees nothing.
        // Strip nullish members and inspect each remaining constituent.
        const constituents = (type.isUnion() ? type.types : [type])
          .filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)))
        for (const constituent of constituents) {
          for (const prop of checker.getPropertiesOfType(constituent)) {
            if (!AUTH_BYPASS_NAME.test(prop.getName())) continue
            const decl = prop.valueDeclaration ?? prop.declarations?.[0]
            let propType
            try { propType = checker.getTypeOfSymbolAtLocation(prop, decl ?? p) } catch { continue }
            if (!propType || !isSerializableType(checker, propType)) continue
            // Report at the declaration when it is in this file, so the waiver
            // comment sits next to the offending property; otherwise at the
            // parameter, which is the thing this file controls.
            const at = decl && decl.getSourceFile() === sf ? decl : p
            report(at, `serializable auth bypass \`${prop.getName()}\``)
          }
        }
      }
    }

    /** Module-wide: only exported functions are reachable over RPC. */
    if (moduleWide) {
      const moduleSymbol = checker.getSymbolAtLocation(sf)
      const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []
      for (const ex of exports) {
        const target = ex.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(ex) : ex
        for (const d of target.declarations ?? []) {
          const fn = functionLikeOf(d)
          if (fn) inspectFunction(fn)
        }
      }
    }

    /** A per-function directive exposes that function whether exported or not. */
    const visit = (node) => {
      const isFn = ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      if (isFn && node.body && ts.isBlock(node.body) && hasUseServerDirective(node.body.statements)) {
        inspectFunction(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }

  return [...new Set(violations)].sort()
}

// Run as a script (not when imported by the fixture test).
if (process.argv[1] && process.argv[1].endsWith('check-server-action-auth-bypass.mjs')) {
  const violations = runGuard()
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
}

export { readFileSync }
